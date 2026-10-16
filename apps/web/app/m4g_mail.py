"""Email di conferma pagamento Move for Gaza."""

from __future__ import annotations

import logging
import smtplib
from collections import defaultdict
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Any

from sqlalchemy.orm import Session

from .config import settings
from .m4g_common import (
    format_price,
    merch_bar_order_fields,
    order_consumptions_path,
    order_kind,
    order_payment_resume_path,
    parse_payload,
)
from .m4g_config import M4G_EVENT
from .m4g_share import share_email_block
from .models import BarOrder, M4gRegistration

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


def _smtp_connect() -> smtplib.SMTP | smtplib.SMTP_SSL:
    if settings.smtp_use_ssl:
        server = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=30)
    else:
        server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30)
        if settings.smtp_use_tls:
            server.starttls()
    if settings.smtp_user and settings.smtp_password:
        server.login(settings.smtp_user, settings.smtp_password)
    return server


def _build_email_message(
    to_addr: str,
    subject: str,
    body: str,
    attachments: list[tuple[str, bytes]] | None = None,
) -> EmailMessage:
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = settings.smtp_from
    message["To"] = to_addr
    message.set_content(body)
    for filename, data in attachments or []:
        message.add_attachment(
            data,
            maintype="application",
            subtype="gpx+xml",
            filename=filename,
        )
    return message


def _smtp_send(
    to_addr: str,
    subject: str,
    body: str,
    attachments: list[tuple[str, bytes]] | None = None,
) -> bool:
    if not settings.smtp_host or not settings.smtp_from:
        logger.warning("SMTP not configured; skipping M4G email to %s.", to_addr)
        return False
    message = _build_email_message(to_addr, subject, body, attachments)
    server = None
    try:
        server = _smtp_connect()
        server.send_message(message)
        return True
    except Exception:
        logger.exception("Failed to send M4G email to %s", to_addr)
        return False
    finally:
        if server:
            try:
                server.quit()
            except Exception:
                pass


_LOGISTICS_SUBJECT = "Info logistiche M4G 2026"

_LOGISTICS_BODY = """Ciao a tuttə!

Domani è il giorno della Move4Gaza. Grazie mille per la tua donazione!!

Non vediamo l'ora di vedervi, condividere e vivere questa giornata con voi!!

Qui sotto le info logistiche per domani — per chi fa sport e per chi viene per i talk.


🚴 PERCORSI E ORARI
────────────────────

Il percorso lungo cambia per la chiusura del Ponte delle Barche: scaricate la nuova traccia da 112 km (in allegato e sul sito). Per accorciare: taglio ad Abbiategrasso e rientro sul Naviglio (circa 95 km).

Portate con voi il GPX del vostro percorso: meglio scaricarlo prima, così non vi perdete domani.

Orari — partenza alla francese (= scaglionata):

  • Bici lungo:  8:30–9:30  (anticipo dalle 8:00 possibile, allestimento in corso)
  • Bici medio:  8:30–10:00
  • Bici corto:  10:30–11:00
  • Corsa:       ore 11:00
  • Calcio:      9:15–13:00


🍽️ PRANZO SOCIALE — dalle 12:30
────────────────────────────────

Tutto il ricavato del cibo e delle bevande è destinato ai Gaza Sunbirds. Grazie a chi mette il lavoro a disposizione:

  • Piatti caldi: Cucina Franca, Pastamadre, Marco Marini Cuciniere
  • Pizza e focacce (Bakers United 4 Gaza): Forno di Lambrate, Le Polveri, Panificio Davide Longoni, Tondo Forno Radicale
  • Birra e vino: Ape Bar, Pico Brew


🎤 TALK — ore 15:30
───────────────────

Presenta Tommaso Proverbio

Ospiti:
  • Khader Tamimi, presidente della Comunità Palestinesi di Lombardia
  • Un esponente dei Giovani Palestinesi
  • Dalia Ismail, giornalista e divulgatrice

Fine prevista tra le 17:00 e le 18:00


ℹ️ DA SAPERE
────────────

  ⛑️ Casco obbligatorio — manifestazione non competitiva
  🌦️ Controllate il meteo e vestitevi di conseguenza (caldo, freddo o pioggia)
  🎒 Zaini e bici custoditi: potete lasciarli alla partenza
  💳 Pagamenti: online, POS, Satispay e PayPal
  🌐 Altre info: move-4-gaza.com

Per informazioni: +39 366 140 3522

Ci vediamo domani! Grazie mille di esservi iscrittə!!

Move4Gaza
"""

_LOGISTICS_GPX_FILES: list[tuple[str, str]] = [
    ("112", "bici-112km.gpx"),
    ("64", "bici-64km.gpx"),
    ("20", "bici-25km.gpx"),
    ("run", "corsa.gpx"),
]


def _logistics_gpx_attachments() -> list[tuple[str, bytes]]:
    from .m4g_cms import route_gpx_file_path

    out: list[tuple[str, bytes]] = []
    for route_key, filename in _LOGISTICS_GPX_FILES:
        path = route_gpx_file_path(route_key)
        if path is None or not path.is_file():
            logger.warning("Missing GPX for logistics mail: %s", route_key)
            continue
        out.append((filename, path.read_bytes()))
    return out


def build_logistics_email() -> tuple[str, str]:
    return _LOGISTICS_SUBJECT, _LOGISTICS_BODY


def _logistics_pending_query(session: Session):
    return session.query(M4gRegistration).filter(
        M4gRegistration.payment_status == "paid",
        M4gRegistration.hidden.isnot(True),
        M4gRegistration.activity != "merch",
        M4gRegistration.logistics_email_sent_at.is_(None),
    )


def logistics_email_pending_summary(session: Session) -> dict[str, int]:
    regs = _logistics_pending_query(session).all()
    by_email: dict[str, list[M4gRegistration]] = defaultdict(list)
    no_email = 0
    for reg in regs:
        email = (reg.email or "").strip()
        if not email:
            no_email += 1
            continue
        by_email[email.lower()].append(reg)
    return {
        "recipients": len(by_email),
        "no_email": no_email,
    }


def send_bulk_logistics_email(session: Session) -> dict[str, Any]:
    if not settings.smtp_host or not settings.smtp_from:
        return {"sent": 0, "failed": 0, "no_email": 0, "error": "smtp"}

    attachments = _logistics_gpx_attachments()
    if len(attachments) != len(_LOGISTICS_GPX_FILES):
        return {"sent": 0, "failed": 0, "no_email": 0, "error": "gpx"}

    subject, body = build_logistics_email()
    regs = _logistics_pending_query(session).all()
    by_email: dict[str, list[M4gRegistration]] = defaultdict(list)
    no_email = 0
    for reg in regs:
        email = (reg.email or "").strip()
        if not email:
            no_email += 1
            continue
        by_email[email.lower()].append(reg)

    sent = 0
    failed = 0
    now = datetime.now(timezone.utc)
    server = None
    try:
        server = _smtp_connect()
        for email_key, group in by_email.items():
            to_addr = (group[0].email or "").strip()
            message = _build_email_message(to_addr, subject, body, attachments)
            try:
                server.send_message(message)
            except Exception:
                logger.exception("Failed to send logistics email to %s", to_addr)
                failed += 1
                continue
            for reg in group:
                reg.logistics_email_sent_at = now
            session.commit()
            sent += 1
    except Exception:
        logger.exception("Failed to open SMTP for bulk logistics email")
        return {
            "sent": sent,
            "failed": failed + len(by_email) - sent,
            "no_email": no_email,
            "error": "smtp",
        }
    finally:
        if server:
            try:
                server.quit()
            except Exception:
                pass

    return {"sent": sent, "failed": failed, "no_email": no_email, "error": None}


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
        share_block = share_email_block(reg, confirm_link)
        body = (
            f"Ciao {first},\n\n"
            f"abbiamo ricevuto la tua donazione di {amount} €. "
            "È arrivata a destinazione: grazie per essere dalla nostra parte.\n\n"
            f"{link_line}"
            f"{share_block}"
            "Grazie di cuore per il sostegno concreto a Gaza.\n\n"
            "A presto,\n"
            "lo staff di Move for Gaza\n"
        )
        return subject, body

    if activity == "merch":
        subject = "Move for Gaza — Ordine merch ricevuto"
        share_block = share_email_block(reg, confirm_link)
        body = (
            f"Ciao {first},\n\n"
            f"abbiamo ricevuto il tuo pagamento di {amount} € e il tuo ordine merch "
            "è confermato. Lo ritiri il giorno dell'evento al banchetto.\n\n"
            f"{link_line}"
            f"Ci vediamo il {event_date} presso {event_location}.\n"
            f"{share_block}\n"
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
    share_block = share_email_block(reg, confirm_link)
    body = (
        f"Ciao {first},\n\n"
        f"buone notizie: abbiamo ricevuto il tuo pagamento di {amount} € e la tua "
        f"iscrizione a {activity_label} è confermata. Benvenutə nella squadra!\n\n"
        f"{link_line}"
        f"Ci vediamo il {event_date} presso {event_location}.\n"
        f"{schedule_block}"
        f"{hint_block}"
        "Grazie di cuore: ogni chilometro, ogni gol e ogni passo sono un pezzo di "
        "sostegno concreto per Gaza.\n"
        f"{share_block}\n"
        "A presto,\n"
        "lo staff di Move for Gaza\n"
    )
    return subject, body


def _order_vouchers_url(order: BarOrder) -> str:
    path = order_consumptions_path(order)
    base = _public_base_url()
    return f"{base}{path}" if base else path


def build_order_confirmation_email(order: BarOrder) -> tuple[str, str]:
    legal = M4G_EVENT.get("legal") or {}
    amount = format_price(order.amount_cents or 0)
    code = (order.short_code or order.reference or "").strip()
    link = _order_vouchers_url(order)
    pay_link = order_payment_resume_path(order)
    base = _public_base_url()
    pay_url = f"{base}{pay_link}" if base else pay_link
    fields = merch_bar_order_fields(order)
    items_line = fields["product"] or "Ordine Move for Gaza"
    kind = order_kind(order)
    label = "Merch" if kind == "merch" else "Bar & cucina"
    subject = f"Move for Gaza — Il tuo ordine {label}"
    if kind == "merch":
        pickup = (
            f"{legal.get('merch_no_delivery', '')}\n"
            f"{legal.get('merch_proceeds', '')}\n"
            "Ritira allo stand Merch: un banner digitale per ogni pezzo."
        )
        legal_line = legal.get("merch", "")
    else:
        pickup = (
            f"{legal.get('skip_queue', '')}\n"
            f"{legal.get('food_proceeds', '')}\n"
            "Vai direttamente allo stand (Cibo o Bevande): un banner per ogni pezzo."
        )
        legal_line = legal.get("bar", "")
    body = (
        "Ciao,\n\n"
        f"ecco il riepilogo del tuo ordine {label} ({amount} €).\n"
        f"Codice: {code}\n"
        f"Articoli: {items_line}\n\n"
        f"Apri sempre questa pagina per lo stato dell'ordine e i banner:\n{link}\n\n"
        "Se devi ancora pagare (carta, Satispay o PayPal):\n"
        f"{pay_url}\n\n"
        "Con carta Nexi i banner si attivano subito dopo il pagamento. "
        "Con Satispay o PayPal attendi la conferma dello staff (la pagina si aggiorna da sola).\n\n"
        f"{pickup}\n\n"
        f"{legal_line}\n"
        f"{legal.get('all_donations', '')}\n\n"
        "Grazie di cuore,\n"
        "lo staff di Move for Gaza\n"
    )
    return subject, body


def send_order_confirmation_email(order: BarOrder, session: Session) -> bool:
    email = (order.email or "").strip()
    if not email:
        return False
    sent_to = (order.confirmation_email_to or "").strip()
    if order.order_email_sent_at is not None and sent_to == email:
        return True

    prev_sent = order.order_email_sent_at
    prev_to = order.confirmation_email_to
    order.order_email_sent_at = datetime.now(timezone.utc)
    order.confirmation_email_to = email
    session.commit()
    session.refresh(order)

    subject, body = build_order_confirmation_email(order)
    if not _smtp_send(email, subject, body):
        order.order_email_sent_at = prev_sent
        order.confirmation_email_to = prev_to
        session.commit()
        return False
    return True


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
