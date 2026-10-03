"""Email di conferma pagamento Move for Gaza."""

from __future__ import annotations

import logging
import smtplib
from datetime import datetime, timezone
from email.message import EmailMessage

from sqlalchemy.orm import Session

from .config import settings
from .m4g_common import format_price, parse_payload
from .m4g_config import M4G_EVENT
from .models import M4gRegistration

logger = logging.getLogger(__name__)

_ACTIVITY_LABELS = {
    "bike": "Ride for Gaza — Bici",
    "soccer": "Play for Gaza — Calcio",
    "run": "Run for Gaza — Corsa",
    "entrance": "Giornata Solidale — Ingresso",
    "donation": "Move for Gaza — Donazione",
    "merch": "Move for Gaza — Merch",
}

_ACTIVITY_HINT = {
    "bike": "Gonfia le gomme e controlla i freni: al resto pensiamo noi.",
    "run": "Allaccia bene le scarpe, la staffetta non aspetta nessunə.",
    "soccer": "Porta la tua squadra e tanta voglia di giocare e soprattutto fair play.",
    "entrance": "Ti aspettiamo per una giornata di talk, buon cibo e buona compagnia.",
}

_SCHEDULE_CONFIRM = "Due giorni prima dell'evento confermeremo gli orari definitivi."


def _bike_distance_key(raw: str) -> str:
    dist = str(raw or "").strip()
    if dist == "25":
        return "20"
    return dist


def _schedule_line(reg: M4gRegistration) -> str:
    orari = M4G_EVENT.get("activity_orari") or {}
    activity = reg.activity or ""
    if activity == "run":
        line = orari.get("run") or ""
        return f"{line}\n" if line else ""
    if activity == "soccer":
        line = orari.get("soccer") or ""
        if not line:
            return ""
        return f"{line} {_SCHEDULE_CONFIRM}\n"
    if activity == "bike":
        bike = orari.get("bike") or {}
        dist = _bike_distance_key(parse_payload(reg.payload_json).get("distance", ""))
        line = bike.get(dist, "")
        if not line:
            return ""
        return f"{line} {_SCHEDULE_CONFIRM}\n"
    return ""


def _public_base_url() -> str:
    raw = (settings.app_public_url or "").strip().rstrip("/")
    return raw


def _confirmation_url(reg: M4gRegistration) -> str:
    token = (reg.confirmation_token or "").strip()
    if not token:
        return ""
    base = _public_base_url()
    path = f"/m4g/conferma/{token}"
    return f"{base}{path}" if base else path


def _smtp_send(to_addr: str, subject: str, body: str) -> bool:
    if not settings.smtp_host or not settings.smtp_from:
        logger.warning("SMTP not configured; skipping M4G email to %s.", to_addr)
        return False
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = settings.smtp_from
    message["To"] = to_addr
    message.set_content(body)
    server = None
    try:
        if settings.smtp_use_ssl:
            server = smtplib.SMTP_SSL(
                settings.smtp_host, settings.smtp_port, timeout=30
            )
        else:
            server = smtplib.SMTP(
                settings.smtp_host, settings.smtp_port, timeout=30
            )
            if settings.smtp_use_tls:
                server.starttls()
        if settings.smtp_user and settings.smtp_password:
            server.login(settings.smtp_user, settings.smtp_password)
        server.send_message(message)
        return True
    except Exception:
        logger.exception("Failed to send M4G paid confirmation to %s", to_addr)
        return False
    finally:
        if server:
            try:
                server.quit()
            except Exception:
                pass


def build_paid_confirmation(reg: M4gRegistration) -> tuple[str, str]:
    first = (reg.first_name or "").strip() or "sportivə"
    amount = format_price(reg.amount_cents or 0)
    activity = reg.activity or ""
    activity_label = _ACTIVITY_LABELS.get(activity, "Move for Gaza")
    event_date = M4G_EVENT.get("date", "")
    event_location = M4G_EVENT.get("location", "")
    confirm_link = _confirmation_url(reg)
    link_line = (
        f"Il riepilogo è sempre qui: {confirm_link}\n\n"
        if confirm_link
        else ""
    )

    if activity == "donation":
        subject = "Move for Gaza — Grazie! Donazione ricevuta"
        body = (
            f"Ciao {first},\n\n"
            f"abbiamo ricevuto la tua donazione di {amount} €. "
            "È arrivata a destinazione: grazie per essere dalla nostra parte.\n\n"
            f"{link_line}"
            "Grazie di cuore per il sostegno concreto a Gaza.\n\n"
            "A presto,\n"
            "lo staff di Move for Gaza\n"
        )
        return subject, body

    if activity == "merch":
        subject = "Move for Gaza — Ordine merch ricevuto"
        body = (
            f"Ciao {first},\n\n"
            f"abbiamo ricevuto il tuo pagamento di {amount} € e il tuo ordine merch "
            "è confermato. Lo ritiri il giorno dell'evento al banchetto.\n\n"
            f"{link_line}"
            f"Ci vediamo il {event_date} presso {event_location}.\n\n"
            "Grazie di cuore.\n\n"
            "A presto,\n"
            "lo staff di Move for Gaza\n"
        )
        return subject, body

    subject = "Move for Gaza — ci sei! Pagamento ricevuto"
    hint = _ACTIVITY_HINT.get(activity, "")
    hint_block = f"{hint}\n\n" if hint else ""
    schedule = _schedule_line(reg)
    schedule_block = f"{schedule}\n" if schedule else ""
    body = (
        f"Ciao {first},\n\n"
        f"buone notizie: abbiamo ricevuto il tuo pagamento di {amount} € e la tua "
        f"iscrizione a {activity_label} è confermata. Benvenutə nella squadra!\n\n"
        f"{link_line}"
        f"Ci vediamo il {event_date} presso {event_location}.\n"
        f"{schedule_block}"
        f"{hint_block}"
        "Grazie di cuore: ogni chilometro, ogni gol e ogni passo sono un pezzo di "
        "sostegno concreto per Gaza.\n\n"
        "A presto,\n"
        "lo staff di Move for Gaza\n"
    )
    return subject, body


def send_paid_confirmation(reg: M4gRegistration, session: Session) -> bool:
    if reg.payment_status != "paid":
        return False
    email = (reg.email or "").strip()
    if not email:
        return False
    if reg.paid_email_sent_at is not None:
        return True

    reg.paid_email_sent_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(reg)

    subject, body = build_paid_confirmation(reg)
    if not _smtp_send(email, subject, body):
        reg.paid_email_sent_at = None
        session.commit()
        return False
    return True
