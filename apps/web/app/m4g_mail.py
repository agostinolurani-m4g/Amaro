"""Email di conferma pagamento Move for Gaza."""

from __future__ import annotations

import asyncio
import logging
import os
import smtplib
from datetime import datetime, timezone
from email.message import EmailMessage

from sqlalchemy.orm import Session

from .config import settings
from .database import SessionLocal
from .m4g_common import format_price, next_italy_evening_utc
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
    body = (
        f"Ciao {first},\n\n"
        f"buone notizie: abbiamo ricevuto il tuo pagamento di {amount} € e la tua "
        f"iscrizione a {activity_label} è confermata. Benvenutə nella squadra!\n\n"
        f"{link_line}"
        f"Ci vediamo il {event_date} presso {event_location}.\n"
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


def send_pending_paid_confirmations(session: Session) -> int:
    pending = (
        session.query(M4gRegistration)
        .filter(M4gRegistration.payment_status == "paid")
        .filter(M4gRegistration.hidden.isnot(True))
        .filter(M4gRegistration.paid_email_sent_at.is_(None))
        .filter(M4gRegistration.email.isnot(None))
        .filter(M4gRegistration.email != "")
        .all()
    )
    sent = 0
    for reg in pending:
        if send_paid_confirmation(reg, session):
            sent += 1
    return sent


def _evening_batch() -> None:
    session = SessionLocal()
    try:
        count = send_pending_paid_confirmations(session)
        if count:
            logger.info("M4G evening batch sent %s paid confirmation email(s).", count)
    finally:
        session.close()


async def run_evening_loop() -> None:
    while True:
        wake_at = next_italy_evening_utc()
        delay = (wake_at - datetime.now(timezone.utc)).total_seconds()
        if delay > 0:
            await asyncio.sleep(delay)
        await asyncio.to_thread(_evening_batch)


def scheduler_enabled() -> bool:
    raw = os.environ.get("M4G_PAID_EMAIL_SCHEDULER", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def start_evening_scheduler() -> None:
    if not scheduler_enabled():
        return
    asyncio.create_task(run_evening_loop())
