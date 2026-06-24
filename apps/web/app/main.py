from __future__ import annotations

import calendar
import json
import logging
import re
import shutil
import hashlib
import secrets
import smtplib
import tempfile
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import Sequence
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from markupsafe import Markup, escape
import requests
from sqlalchemy import inspect, or_, text
from sqlalchemy.orm import Session
from starlette.middleware.sessions import SessionMiddleware

from .acsi import send_documents_manual_review_email
from .admin import setup_admin
from .config import settings
from .database import Base, SessionLocal, engine, get_session
from .models import (
    DOCUMENT_CATEGORY_HEALTH,
    DOCUMENT_CATEGORY_IDENTITY,
    DOCUMENT_CATEGORY_MEDICAL,
    Event,
    EventRegistration,
    EventWaitlistEntry,
    Member,
    MemberDocument,
    MembershipPayment,
    MerchItem,
    MEMBERSHIP_STATUS_PENDING,
)
from .nexi import NexiPaymentContext, NexiXpayClient
from .ocr import (
    MAX_UPLOAD_BYTES,
    MemberValidationContext,
    document_status_payload,
    schedule_documents_ocr,
    validate_upload_file,
)
from .seed import seed_sample_data

GALLERY_IMAGES: list[dict[str, str]] = [
]

DRIVE_COLLECTIONS: list[dict[str, str | None]] = [
    {
        "title": "Eventi su Drive",
        "description": "Foto degli eventi.",
        "folder_id": settings.drive_events_folder_id,
    },
    {
        "title": "Galleria generale",
        "description": "",
        "folder_id": settings.drive_gallery_folder_id,
    },
]

MEMBERSHIP_TYPES = [
    "Socio ordinario",
    "Giovane under 25",
    "Sostenitore",
]

SPORT_TYPE_FEES = {
    "Solo ciclismo": 50,
    "Ciclismo + Atletica": 60,
    "Solo atletica": 15,
}

SPORT_TYPES = list(SPORT_TYPE_FEES.keys())
MEMBERSHIP_FEE_MIN = min(SPORT_TYPE_FEES.values())
MEMBERSHIP_FEE_MAX = max(SPORT_TYPE_FEES.values())
MEMBERSHIP_FEE_RANGE_LABEL = f"{MEMBERSHIP_FEE_MIN}-{MEMBERSHIP_FEE_MAX}"

WEEKDAY_LABELS = [
    "Lun",
    "Mar",
    "Mer",
    "Gio",
    "Ven",
    "Sab",
    "Dom",
]

ITALIAN_MONTHS = [
    "Gennaio",
    "Febbraio",
    "Marzo",
    "Aprile",
    "Maggio",
    "Giugno",
    "Luglio",
    "Agosto",
    "Settembre",
    "Ottobre",
    "Novembre",
    "Dicembre",
]

SHOW_MERCH_PREVIEW = False


def _event_medical_policy(event: Event) -> str:
    policy = (getattr(event, "medical_certificate_policy", None) or "").strip().lower()
    if policy in ("none", "optional", "required"):
        return policy
    return "required" if event.require_medical_certificate else "optional"


def _event_route_mode(event: Event) -> str:
    mode = (getattr(event, "route_option_mode", None) or "").strip().lower()
    if mode in ("distances", "trail", "corsa"):
        return mode
    return "distances"


def _event_route_is_lungo(event: Event, route_length: str) -> bool:
    return (
        event.enable_route_option
        and _event_route_mode(event) == "distances"
        and route_length == "lungo"
    )


_SLUG_KEY_RE = re.compile(r"^[a-z0-9_-]{1,40}$")
ALLOWED_ROUTE_GPX_KEYS = frozenset({"corto", "medio", "lungo", "trail", "corsa"})
_DEFAULT_GPX_LABELS = {
    "corto": "Corto",
    "medio": "Medio",
    "lungo": "Lungo",
    "trail": "Trail",
    "corsa": "Corsa",
}
_ROUTE_GPX_MAX_BYTES = 12 * 1024 * 1024


def parse_event_activities_config(event: Event) -> list[dict[str, object]] | None:
    """JSON: {\"sports\": [{\"key\",\"label\",\"routes\": [{\"key\",\"label\",\"medical_agonistic\"?}]}]}."""
    raw = getattr(event, "event_activities_config", None)
    if not raw or not str(raw).strip():
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning(
            "event_activities_config JSON non valido (evento id=%s)",
            getattr(event, "id", None),
        )
        return None
    sports_raw = data.get("sports") if isinstance(data, dict) else data
    if not isinstance(sports_raw, list) or not sports_raw:
        return None
    out: list[dict[str, object]] = []
    for item in sports_raw:
        if not isinstance(item, dict):
            continue
        sk = (item.get("key") or "").strip().lower()
        slabel = (item.get("label") or "").strip()
        routes_raw = item.get("routes") or []
        if not sk or not slabel or not _SLUG_KEY_RE.match(sk):
            continue
        if not isinstance(routes_raw, list):
            continue
        routes: list[dict[str, object]] = []
        for r in routes_raw:
            if not isinstance(r, dict):
                continue
            rk = (r.get("key") or "").strip().lower()
            rlab = (r.get("label") or "").strip()
            if not rk or not rlab or not _SLUG_KEY_RE.match(rk):
                continue
            routes.append(
                {
                    "key": rk,
                    "label": rlab,
                    "medical_agonistic": bool(r.get("medical_agonistic", False)),
                }
            )
        if routes:
            out.append({"key": sk, "label": slabel, "routes": routes})
    return out or None


def event_uses_activities_config(event: Event) -> bool:
    return parse_event_activities_config(event) is not None


def _event_route_requires_agonistic_medical(
    event: Event, discipline: str, route_length: str
) -> bool:
    act = parse_event_activities_config(event)
    if act:
        d = (discipline or "").strip().lower()
        rl = (route_length or "").strip().lower()
        for s in act:
            if s["key"] != d:
                continue
            for r in s["routes"]:
                if r["key"] == rl:
                    return bool(r.get("medical_agonistic"))
        return False
    return _event_route_is_lungo(event, route_length)


def _allowed_gpx_route_keys(event: Event) -> frozenset[str]:
    act = parse_event_activities_config(event)
    if act:
        keys: set[str] = set()
        for s in act:
            for r in s["routes"]:
                keys.add(str(r["key"]))
        return frozenset(keys)
    return ALLOWED_ROUTE_GPX_KEYS


def parse_event_route_gpx(event: Event) -> list[dict[str, str]]:
    """Righe: chiave|URL|etichetta opzionale. Chiavi = percorsi configurati per l'evento."""
    allowed = _allowed_gpx_route_keys(event)
    raw = getattr(event, "route_gpx_urls", None) or ""
    out: list[dict[str, str]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|", 2)]
        if len(parts) < 2:
            continue
        key = parts[0].lower()
        url = parts[1]
        label = parts[2] if len(parts) > 2 else ""
        if key not in allowed or not url:
            continue
        if not label:
            label = _DEFAULT_GPX_LABELS.get(key, key.replace("_", " ").title())
        out.append({"key": key, "url": url, "label": label})
    return out


def event_route_gpx_bootstrap(
    request: Request, event: Event
) -> list[dict[str, str]]:
    rows = parse_event_route_gpx(event)
    out: list[dict[str, str]] = []
    for r in rows:
        fetch = str(
            request.url_for("event_route_gpx_proxy", slug=event.slug, route_key=r["key"])
        )
        out.append(
            {
                "key": r["key"],
                "label": r["label"],
                "fetch_url": fetch,
                "download_url": f"{fetch}?dl=1",
            }
        )
    return out


def _event_occupied_registration_count(session: Session, event_id: int) -> int:
    """Iscrizioni che occupano un posto: pagate, in attesa di pagamento, o gratuite."""
    return (
        session.query(EventRegistration)
        .filter(EventRegistration.event_id == event_id)
        .filter(
            or_(
                EventRegistration.payment_status == "paid",
                EventRegistration.payment_status == "pending",
                EventRegistration.total_amount_cents.is_(None),
                EventRegistration.total_amount_cents == 0,
            )
        )
        .count()
    )


def _event_registration_is_full(session: Session, event: Event) -> bool:
    cap = event.registration_capacity
    if cap is None or cap <= 0:
        return False
    return _event_occupied_registration_count(session, event.id) >= cap


def _event_registration_template_extras(
    request: Request, event: Event, session: Session
) -> dict[str, object]:
    activities_config = parse_event_activities_config(event) or []
    use_activities = len(activities_config) > 0
    route_medical: dict[str, bool] = {}
    if use_activities:
        for s in activities_config:
            for r in s["routes"]:
                k = str(r["key"])
                route_medical[k] = route_medical.get(k, False) or bool(
                    r.get("medical_agonistic")
                )
    cap = event.registration_capacity
    occupied = _event_occupied_registration_count(session, event.id)
    is_full = bool(cap and cap > 0 and occupied >= cap)
    return {
        "activities_config": activities_config,
        "use_activities_config": use_activities,
        "route_medical_by_key": route_medical,
        "event_route_gpx": event_route_gpx_bootstrap(request, event),
        "registration_capacity": cap,
        "registration_occupied_count": occupied,
        "registration_is_full": is_full,
    }


def _event_discipline_human_label(event: Event, discipline_key: str) -> str:
    d = (discipline_key or "").strip().lower()
    act = parse_event_activities_config(event)
    if act:
        for s in act:
            if s["key"] == d:
                return str(s["label"])
    if d == "bici":
        return "Bici"
    if d == "corsa":
        return "Corsa"
    return discipline_key or ""


def _event_route_human_label(
    event: Event, discipline_key: str, route_key: str
) -> str:
    rk = (route_key or "").strip().lower()
    act = parse_event_activities_config(event)
    d = (discipline_key or "").strip().lower()
    if act:
        for s in act:
            if s["key"] != d:
                continue
            for r in s["routes"]:
                if r["key"] == rk:
                    return str(r["label"])
            break
        return route_key or ""
    if rk == "trail":
        return "Trail (unico)"
    if rk == "corsa":
        return "Corsa (unico)"
    return route_key or ""


BASE_DIR = Path(__file__).resolve().parent
static_dir = Path(settings.static_path)
if not static_dir.is_absolute():
    static_dir = BASE_DIR / static_dir

templates_dir = BASE_DIR / "templates"

app = FastAPI(title=settings.app_name)
app.mount("/static", StaticFiles(directory=static_dir), name="static")
templates = Jinja2Templates(directory=templates_dir)
templates.env.globals["current_year"] = datetime.utcnow().year
logger = logging.getLogger(__name__)
app.add_middleware(SessionMiddleware, secret_key=settings.session_secret, session_cookie="amaro_session")
setup_admin(app)

UPLOADS_DIR = (BASE_DIR / settings.uploads_path).resolve()
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

try:
    nexi_client = NexiXpayClient.from_settings(settings)
except ValueError as exc:
    logger.warning("Nexi/XPay client unavailable: %s", exc)
    nexi_client = None


@app.on_event("startup")
def on_startup() -> None:
    Base.metadata.create_all(bind=engine)
    ensure_member_schema()
    ensure_member_document_schema()
    ensure_event_schema()
    ensure_event_registration_schema()
    ensure_merch_schema()
    ensure_membership_payment_schema()
    session = SessionLocal()
    try:
        seed_sample_data(session)
    finally:
        session.close()


def format_price(cents: int) -> str:
    return f"{cents / 100:.2f}"


def membership_fee_for_sport(sport_type: str | None) -> int:
    if not sport_type:
        return settings.membership_fee_eur
    return SPORT_TYPE_FEES.get(sport_type, settings.membership_fee_eur)


def build_payment_reference(prefix: str) -> str:
    safe_prefix = "".join(ch for ch in prefix if ch.isalnum()).upper()
    safe_prefix = safe_prefix or "PAY"
    return f"{safe_prefix}{uuid4().hex[:12].upper()}"


def _smtp_send_transactional(to_addr: str, subject: str, body: str) -> bool:
    if not settings.smtp_host or not settings.smtp_from:
        logger.warning("SMTP not configured; skipping email to %s.", to_addr)
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
                settings.smtp_host, settings.smtp_port, timeout=10
            )
        else:
            server = smtplib.SMTP(
                settings.smtp_host, settings.smtp_port, timeout=10
            )
            if settings.smtp_use_tls:
                server.starttls()
        if settings.smtp_user and settings.smtp_password:
            server.login(settings.smtp_user, settings.smtp_password)
        server.send_message(message)
        return True
    except Exception:
        logger.exception("Failed to send transactional email to %s", to_addr)
        return False
    finally:
        if server:
            try:
                server.quit()
            except Exception:
                pass


def _membership_form_link(request: Request, ref: str) -> str:
    base_url = str(request.url_for("membership_form"))
    return f"{base_url}?ref={ref}"


def _send_membership_completion_email(email: str, link: str) -> bool:
    body = (
        "Ciao,\n\n"
        "Abbiamo preso in carico la tua richiesta di tesseramento e ricevuto correttamente "
        "il pagamento.\n\n"
        "Per completare la pratica e inviare i documenti, apri questo link:\n"
        f"{link}\n\n"
        "Se non hai richiesto tu il tesseramento, ignora questa email.\n"
    )
    return _smtp_send_transactional(
        email,
        f"{settings.app_name} - Completa tesseramento",
        body,
    )


def _send_password_reset_email(email: str, link: str) -> bool:
    if not settings.smtp_host or not settings.smtp_from:
        logger.warning("SMTP not configured; skipping password reset email.")
        return False
    message = EmailMessage()
    message["Subject"] = f"{settings.app_name} - Reset password area tesserati"
    message["From"] = settings.smtp_from
    message["To"] = email
    message.set_content(
        "Ciao,\n\nPer reimpostare la password dell'area tesserati apri questo link:\n"
        f"{link}\n\nSe non hai richiesto tu il reset, ignora questa email.\n"
    )
    server = None
    try:
        if settings.smtp_use_ssl:
            server = smtplib.SMTP_SSL(
                settings.smtp_host, settings.smtp_port, timeout=10
            )
        else:
            server = smtplib.SMTP(
                settings.smtp_host, settings.smtp_port, timeout=10
            )
            if settings.smtp_use_tls:
                server.starttls()
        if settings.smtp_user and settings.smtp_password:
            server.login(settings.smtp_user, settings.smtp_password)
        server.send_message(message)
        return True
    except Exception:
        logger.exception("Failed to send password reset email")
        return False
    finally:
        if server:
            try:
                server.quit()
            except Exception:
                pass


def _send_membership_staff_email(subject: str, body: str) -> bool:
    """Notifica interna (es. segreteria) su pagamenti e tesseramento area tesserati."""
    if not settings.membership_notify_email:
        return False
    return _smtp_send_transactional(settings.membership_notify_email, subject, body)


def _send_membership_applicant_payment_ack_email(member: Member) -> bool:
    """Conferma all'iscritto: pagamento ricevuto e richiesta presa in carico (socio gia' anagrafato)."""
    if not member.email:
        return False
    first = (member.first_name or "").strip() or "socio/a"
    body = (
        f"Ciao {first},\n\n"
        "Abbiamo preso in carico la tua richiesta: abbiamo ricevuto il pagamento per "
        "l'accesso all'area tesserati. Ora puoi utilizzare l'area riservata.\n\n"
        f"— {settings.app_name}\n"
    )
    return _smtp_send_transactional(
        member.email,
        f"{settings.app_name} - Richiesta presa in carico",
        body,
    )


def _send_membership_applicant_form_ack_email(member: Member) -> bool:
    """Conferma all'iscritto: modulo e documenti ricevuti e presi in carico."""
    if not member.email:
        return False
    first = (member.first_name or "").strip() or "socio/a"
    body = (
        f"Ciao {first},\n\n"
        "Abbiamo ricevuto il tuo modulo e i documenti caricati e abbiamo preso in carico "
        "la richiesta. La segreteria verificherà la documentazione e ti contatterà se necessario.\n\n"
        "L'accesso all'area tesserati è attivo; la password provvisoria ti è stata mostrata "
        "al termine dell'invio: conservala per i prossimi accessi.\n\n"
        f"— {settings.app_name}\n"
    )
    return _smtp_send_transactional(
        member.email,
        f"{settings.app_name} - Modulo ricevuto",
        body,
    )


def _admin_base_url(request: Request | None) -> str | None:
    if not request:
        return None
    return str(request.base_url).rstrip("/")


def _send_event_payment_emails(
    registration: EventRegistration, event: Event
) -> None:
    if not settings.smtp_host or not settings.smtp_from:
        logger.warning("SMTP not configured; skipping event payment emails.")
        return

    # Email al partecipante
    if registration.email:
        first_name = registration.first_name or "atleta"
        participant_message = EmailMessage()
        participant_message["Subject"] = (
            f"Sei iscrittə a {event.title}!"
        )
        participant_message["From"] = settings.smtp_from
        participant_message["To"] = registration.email
        lines: list[str] = []
        lines.append(f"Ciao {first_name},")
        lines.append("")
        lines.append(f"la tua iscrizione a \"{event.title}\" e' confermata!")
        lines.append("Non vediamo l'ora di vederti alla partenza.")
        lines.append("")
        lines.append("Riepilogo iscrizione:")
        lines.append(f"  Evento: {event.title}")
        if event.date:
            lines.append(f"  Data: {event.date.strftime('%d/%m/%Y')}")
        if event.location:
            lines.append(f"  Luogo: {event.location}")
        if registration.team_name:
            lines.append(f"  Squadra: {registration.team_name}")
        if registration.discipline:
            lines.append(
                f"  Disciplina: {_event_discipline_human_label(event, registration.discipline)}"
            )
        if registration.route_length:
            lines.append(
                "  Percorso: "
                + _event_route_human_label(
                    event,
                    registration.discipline or "",
                    registration.route_length,
                )
            )
        if registration.lunch_option == "con_pranzo":
            pranzo_line = "  Pranzo: incluso"
            if registration.lunch_guests:
                pranzo_line += f" + {registration.lunch_guests} accompagnatorə"
            lines.append(pranzo_line)
        elif registration.lunch_option == "senza_pranzo":
            lines.append("  Pranzo: non incluso")
        if event.enable_jersey and registration.jersey_size and registration.jersey_gender:
            lines.append(
                f"  Maglia evento: {registration.jersey_gender}, taglia {registration.jersey_size}"
            )
        lines.append("")
        lines.append("Nelle prossime settimane ti invieremo tutti i dettagli organizzativi, le tracce GPS e le informazioni logistiche.")
        lines.append("")
        lines.append("Per qualsiasi informazione rispondi pure a questa email.")
        lines.append("")
        lines.append("A presto,")
        lines.append(f"Il team {settings.app_name}")
        if registration.total_amount_cents:
            lines.append("")
            lines.append(
                f"(Pagamento registrato: {registration.total_amount_cents / 100:.2f} €"
                + (f" — rif. {registration.payment_reference}" if registration.payment_reference else "")
                + ")"
            )
        participant_message.set_content("\n".join(lines))

        try:
            server = None
            if settings.smtp_use_ssl:
                server = smtplib.SMTP_SSL(
                    settings.smtp_host, settings.smtp_port, timeout=10
                )
            else:
                server = smtplib.SMTP(
                    settings.smtp_host, settings.smtp_port, timeout=10
                )
                if settings.smtp_use_tls:
                    server.starttls()
            if settings.smtp_user and settings.smtp_password:
                server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(participant_message)
        except Exception:
            logger.exception("Failed to send event payment email to participant")
        finally:
            if server:
                try:
                    server.quit()
                except Exception:
                    pass

    # Email interna con allegato certificato medico (se presente)
    if not settings.events_notify_email:
        return

    internal_message = EmailMessage()
    internal_message["Subject"] = (
        f"{settings.app_name} - Nuovo pagamento evento {event.title}"
    )
    internal_message["From"] = settings.smtp_from
    internal_message["To"] = settings.events_notify_email

    lines: list[str] = []
    lines.append("Nuovo pagamento evento ricevuto.")
    lines.append("")
    lines.append(f"Evento: {event.title}")
    if event.date:
        lines.append(f"Data: {event.date.strftime('%d/%m/%Y')}")
    if registration.first_name or registration.last_name:
        full_name = f"{registration.first_name or ''} {registration.last_name or ''}".strip()
        lines.append(f"Partecipante: {full_name}")
    if registration.email:
        lines.append(f"Email: {registration.email}")
    if registration.phone:
        lines.append(f"Telefono: {registration.phone}")
    if registration.team_name:
        lines.append(f"Squadra: {registration.team_name}")
    if registration.lunch_option == "con_pranzo":
        pranzo_line = "Pranzo: incluso"
        if registration.lunch_guests:
            pranzo_line += f" + {registration.lunch_guests} accompagnatorə"
        lines.append(pranzo_line)
    elif registration.lunch_option == "senza_pranzo":
        lines.append("Pranzo: non incluso")
    if registration.discipline:
        lines.append(
            f"Disciplina: {_event_discipline_human_label(event, registration.discipline)}"
        )
    if registration.route_length:
        rl = registration.route_length
        lines.append(
            "Percorso: "
            + _event_route_human_label(
                event, registration.discipline or "", rl
            )
        )
        if _event_route_requires_agonistic_medical(
            event, registration.discipline or "", rl
        ):
            lines.append(
                "NOTA: percorso con certificato medico agonistico obbligatorio."
            )
    if event.enable_jersey and registration.jersey_size and registration.jersey_gender:
        lines.append(
            f"Maglia evento: {registration.jersey_gender} taglia {registration.jersey_size}"
        )
    if registration.total_amount_cents:
        lines.append(
            f"Importo totale: {registration.total_amount_cents / 100:.2f} €"
        )
    if registration.payment_reference:
        lines.append(f"Riferimento pagamento: {registration.payment_reference}")
    lines.append("")
    lines.append("In allegato, se disponibile, il certificato medico caricato.")

    internal_message.set_content("\n".join(lines))

    # Allegato certificato medico, se presente
    if registration.medical_stored_filename:
        path = UPLOADS_DIR / registration.medical_stored_filename
        if path.exists():
            try:
                data = path.read_bytes()
                content_type = registration.medical_content_type or "application/octet-stream"
                maintype, _, subtype = content_type.partition("/")
                if not maintype or not subtype:
                    maintype, subtype = "application", "octet-stream"
                internal_message.add_attachment(
                    data,
                    maintype=maintype,
                    subtype=subtype,
                    filename=registration.medical_original_name or path.name,
                )
            except Exception:
                logger.exception("Failed to attach medical certificate to internal email")

    try:
        server = None
        if settings.smtp_use_ssl:
            server = smtplib.SMTP_SSL(
                settings.smtp_host, settings.smtp_port, timeout=10
            )
        else:
            server = smtplib.SMTP(
                settings.smtp_host, settings.smtp_port, timeout=10
            )
            if settings.smtp_use_tls:
                server.starttls()
        if settings.smtp_user and settings.smtp_password:
            server.login(settings.smtp_user, settings.smtp_password)
        server.send_message(internal_message)
    except Exception:
        logger.exception("Failed to send internal event payment email")
    finally:
        if server:
            try:
                server.quit()
            except Exception:
                pass

def _require_nexi_client() -> NexiXpayClient:
    if not nexi_client:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Nexi/XPay non configurato",
        )
    return nexi_client


def _save_uploaded_documents(
    member_id: int,
    uploads: Sequence[UploadFile] | None,
    category: str | None = None,
) -> list[MemberDocument]:
    saved: list[MemberDocument] = []
    if not uploads:
        return saved
    for upload in uploads:
        if not upload.filename:
            continue
        stored_filename = f"{member_id}_{uuid4().hex}_{Path(upload.filename).name}"
        destination = UPLOADS_DIR / stored_filename
        upload.file.seek(0)
        with destination.open("wb") as out:
            shutil.copyfileobj(upload.file, out)
        upload.file.close()
        saved.append(
            MemberDocument(
                member_id=member_id,
                document_category=category,
                original_name=Path(upload.filename).name,
                stored_filename=stored_filename,
                content_type=upload.content_type,
            )
        )
    return saved


def _save_categorized_documents(
    member_id: int,
    documents_by_category: dict[str, UploadFile | Sequence[UploadFile] | None],
) -> list[MemberDocument]:
    saved: list[MemberDocument] = []
    for category, uploads in documents_by_category.items():
        if not uploads:
            continue
        if isinstance(uploads, UploadFile):
            uploads_list = [uploads]
        else:
            uploads_list = list(uploads)
        saved.extend(_save_uploaded_documents(member_id, uploads_list, category))
    return saved


def _save_event_document(
    registration_id: int, upload: UploadFile
) -> tuple[str, str, str | None]:
    stored_filename = f"event_{registration_id}_{uuid4().hex}_{Path(upload.filename).name}"
    destination = UPLOADS_DIR / stored_filename
    upload.file.seek(0)
    with destination.open("wb") as out:
        shutil.copyfileobj(upload.file, out)
    upload.file.close()
    return stored_filename, Path(upload.filename).name, upload.content_type


def _require_uploads(
    uploads: Sequence[UploadFile] | None, label: str
) -> list[UploadFile]:
    if not uploads:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Documento mancante: {label}.",
        )
    cleaned = [upload for upload in uploads if upload.filename]
    if not cleaned:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Documento mancante: {label}.",
        )
    return cleaned


def _normalize(value: str | None) -> str | None:
    return value.strip() if value else None


def _parse_gallery_urls(value: str | None) -> list[dict[str, str]]:
    if not value:
        return []
    items: list[dict[str, str]] = []
    for raw in value.splitlines():
        line = raw.strip()
        if not line:
            continue
        if "|" in line:
            url, caption = line.split("|", 1)
            items.append({"url": url.strip(), "caption": caption.strip()})
        else:
            items.append({"url": line, "caption": ""})
    return [item for item in items if item["url"]]


_BR_RE = re.compile(r"(?i)<br\\s*/?>")


def format_text(value: str | None) -> Markup:
    if not value:
        return Markup("")
    text = value.replace("\r\n", "\n").replace("\r", "\n")
    text = _BR_RE.sub("\n", text)
    escaped = escape(text)
    return Markup(str(escaped).replace("\n", "<br>"))


templates.env.filters["format_text"] = format_text


def fetch_drive_images(folder_id: str | None, api_key: str | None, limit: int = 18) -> list[dict[str, str]]:
    if not folder_id or not api_key:
        return []

    params = {
        "q": f"'{folder_id}' in parents and trashed=false and mimeType contains 'image/'",
        "orderBy": "createdTime desc",
        "fields": "files(id,name,description,webViewLink)",
        "pageSize": limit,
        "includeItemsFromAllDrives": True,
        "supportsAllDrives": True,
        "key": api_key,
    }
    try:
        response = requests.get(
            "https://www.googleapis.com/drive/v3/files", params=params, timeout=6
        )
        response.raise_for_status()
    except Exception as exc:  # pragma: no cover - best-effort integration
        logger.warning("Google Drive non raggiungibile: %s", exc)
        return []

    payload = response.json()
    images: list[dict[str, str]] = []
    for file in payload.get("files", []):
        file_id = file.get("id")
        if not file_id:
            continue
        images.append(
            {
                "url": f"https://drive.google.com/thumbnail?id={file_id}&sz=w800",
                "caption": file.get("name") or "Foto",
                "web_url": file.get("webViewLink") or "",
            }
        )
        if len(images) >= limit:
            break
    return images


def ensure_member_schema() -> None:
    inspector = inspect(engine)
    columns = {col["name"] for col in inspector.get_columns("members")}
    required_columns: dict[str, str] = {
        "first_name": "TEXT",
        "last_name": "TEXT",
        "phone": "TEXT",
        "birth_date": "DATE",
        "birth_place": "TEXT",
        "residence": "TEXT",
        "codice_fiscale": "TEXT",
        "document_type": "TEXT",
        "document_number": "TEXT",
        "document_id": "TEXT",
        "tessera_sanitaria": "TEXT",
        "medical_certificate": "TEXT",
        "medical_certificate_expiry": "DATE",
        "sport_type": "TEXT",
        "access_code": "TEXT",
        "password_hash": "TEXT",
        "membership_status": "TEXT",
        "password_reset_token_hash": "TEXT",
        "password_reset_expires_at": "DATETIME",
        "acsi_submitted_at": "DATETIME",
        "medical_manual_review_notified_at": "DATETIME",
    }
    added_membership_status = False
    with engine.begin() as conn:
        for column, ddl in required_columns.items():
            if column not in columns:
                conn.execute(text(f"ALTER TABLE members ADD COLUMN {column} {ddl}"))
                if column == "membership_status":
                    added_membership_status = True
    if "membership_status" in columns or added_membership_status:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE members "
                    "SET membership_status = :status "
                    "WHERE membership_status IS NULL"
                ),
                {"status": MEMBERSHIP_STATUS_PENDING},
            )


def ensure_member_document_schema() -> None:
    inspector = inspect(engine)
    if "member_documents" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("member_documents")}
    required_columns: dict[str, str] = {
        "document_category": "TEXT",
        "ocr_status": "TEXT",
        "ocr_valid": "INTEGER",
        "ocr_notes": "TEXT",
        "ocr_text": "TEXT",
    }
    with engine.begin() as conn:
        for column, ddl in required_columns.items():
            if column not in columns:
                conn.execute(
                    text(f"ALTER TABLE member_documents ADD COLUMN {column} {ddl}")
                )


def ensure_event_schema() -> None:
    inspector = inspect(engine)
    columns = {col["name"] for col in inspector.get_columns("events")}
    required_columns: dict[str, str] = {
        "activity": "TEXT",
        "location_map_url": "TEXT",
        "cover_image_url": "TEXT",
        "gallery_urls": "TEXT",
        "is_featured": "INTEGER",
        "is_amaro_event": "INTEGER",
        "require_first_name": "INTEGER",
        "require_last_name": "INTEGER",
        "require_email": "INTEGER",
        "require_phone": "INTEGER",
        "require_residence": "INTEGER",
        "require_intolerances": "INTEGER",
        "require_acsi_fci": "INTEGER",
        "require_medical_certificate": "INTEGER",
        "require_privacy_photo": "INTEGER",
        "require_privacy_other": "INTEGER",
        "registration_notes": "TEXT",
        "documents_urls": "TEXT",
        "instagram_url": "TEXT",
        "enable_lunch_option": "INTEGER",
        "lunch_description": "TEXT",
        "enable_discipline_option": "INTEGER",
        "enable_route_option": "INTEGER",
        "waiver_url": "TEXT",
        "require_waiver_upload": "INTEGER",
        "require_waiver_acceptance": "INTEGER",
        "enable_jersey": "INTEGER",
        "jersey_description": "TEXT",
        "jersey_sizes": "TEXT",
        "jersey_price_cents": "INTEGER",
        "jersey_image_url_male": "TEXT",
        "jersey_image_url_female": "TEXT",
        "jersey_gallery_urls": "TEXT",
        "jersey_gallery_link": "TEXT",
        "event_price_cents": "INTEGER",
        "sponsors_urls": "TEXT",
        "event_lunch_price_cents": "INTEGER",
        "medical_certificate_policy": "TEXT",
        "route_option_mode": "TEXT",
        "route_gpx_urls": "TEXT",
        "event_activities_config": "TEXT",
        "registration_capacity": "INTEGER",
    }
    added_is_featured = False
    added_is_amaro_event = False
    added_require_defaults = False
    with engine.begin() as conn:
        for column, ddl in required_columns.items():
            if column not in columns:
                conn.execute(text(f"ALTER TABLE events ADD COLUMN {column} {ddl}"))
                if column == "is_featured":
                    added_is_featured = True
                if column == "is_amaro_event":
                    added_is_amaro_event = True
                if column.startswith("require_"):
                    added_require_defaults = True
    if "is_featured" in columns or added_is_featured:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE events "
                    "SET is_featured = 0 "
                    "WHERE is_featured IS NULL"
                )
            )
    if "is_amaro_event" in columns or added_is_amaro_event:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE events "
                    "SET is_amaro_event = 0 "
                    "WHERE is_amaro_event IS NULL"
                )
            )
    if any(col.startswith("require_") for col in columns) or added_require_defaults:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE events "
                    "SET require_first_name = 1 "
                    "WHERE require_first_name IS NULL"
                )
            )
            conn.execute(
                text(
                    "UPDATE events "
                    "SET require_last_name = 1 "
                    "WHERE require_last_name IS NULL"
                )
            )
            conn.execute(
                text(
                    "UPDATE events "
                    "SET require_email = 1 "
                    "WHERE require_email IS NULL"
                )
            )
            conn.execute(
                text(
                    "UPDATE events "
                    "SET require_phone = 1 "
                    "WHERE require_phone IS NULL"
                )
            )
            conn.execute(
                text(
                    "UPDATE events "
                    "SET require_residence = 0 "
                    "WHERE require_residence IS NULL"
                )
            )
            conn.execute(
                text(
                    "UPDATE events "
                    "SET require_intolerances = 0 "
                    "WHERE require_intolerances IS NULL"
                )
            )
            conn.execute(
                text(
                    "UPDATE events "
                    "SET require_acsi_fci = 0 "
                    "WHERE require_acsi_fci IS NULL"
                )
            )
            conn.execute(
                text(
                    "UPDATE events "
                    "SET require_medical_certificate = 0 "
                    "WHERE require_medical_certificate IS NULL"
                )
            )
            conn.execute(
                text(
                    "UPDATE events "
                    "SET require_privacy_photo = 1 "
                    "WHERE require_privacy_photo IS NULL"
                )
            )
            conn.execute(
                text(
                    "UPDATE events "
                    "SET require_privacy_other = 1 "
                    "WHERE require_privacy_other IS NULL"
                )
            )

    cols = {c["name"] for c in inspect(engine).get_columns("events")}
    if "medical_certificate_policy" in cols:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE events SET medical_certificate_policy = 'required' "
                    "WHERE (medical_certificate_policy IS NULL "
                    "OR TRIM(medical_certificate_policy) = '') "
                    "AND require_medical_certificate = 1"
                )
            )
            conn.execute(
                text(
                    "UPDATE events SET medical_certificate_policy = 'optional' "
                    "WHERE medical_certificate_policy IS NULL "
                    "OR TRIM(medical_certificate_policy) = ''"
                )
            )
    if "route_option_mode" in cols:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE events SET route_option_mode = 'distances' "
                    "WHERE route_option_mode IS NULL "
                    "OR TRIM(route_option_mode) = ''"
                )
            )


def ensure_event_registration_schema() -> None:
    inspector = inspect(engine)
    columns = {col["name"] for col in inspector.get_columns("event_registrations")}
    required_columns: dict[str, str] = {
        "lunch_option": "TEXT",
        "lunch_guests": "INTEGER",
        "team_name": "TEXT",
        "discipline": "TEXT",
        "route_length": "TEXT",
        "waiver_original_name": "TEXT",
        "waiver_stored_filename": "TEXT",
        "waiver_content_type": "TEXT",
        "waiver_accepted": "INTEGER",
        "jersey_size": "TEXT",
        "jersey_gender": "TEXT",
        "payment_reference": "TEXT",
        "payment_status": "TEXT",
        "total_amount_cents": "INTEGER",
    }
    with engine.begin() as conn:
        for column, ddl in required_columns.items():
            if column not in columns:
                conn.execute(
                    text(
                        f"ALTER TABLE event_registrations ADD COLUMN {column} {ddl}"
                    )
                )


def ensure_merch_schema() -> None:
    inspector = inspect(engine)
    columns = {col["name"] for col in inspector.get_columns("merch_items")}
    if "image_url" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE merch_items ADD COLUMN image_url VARCHAR(255)"))


def ensure_membership_payment_schema() -> None:
    inspector = inspect(engine)
    if "membership_payments" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("membership_payments")}
    required_columns: dict[str, str] = {
        "email": "VARCHAR(140)",
    }
    with engine.begin() as conn:
        for column, ddl in required_columns.items():
            if column not in columns:
                conn.execute(
                    text(
                        f"ALTER TABLE membership_payments ADD COLUMN {column} {ddl}"
                    )
                )


def _hash_password(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _hash_reset_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _generate_member_password() -> tuple[str, str]:
    password = secrets.token_urlsafe(6)
    return password, _hash_password(password)


def _verify_password(raw: str, hashed: str | None) -> bool:
    return bool(hashed) and _hash_password(raw) == hashed


def _month_label(month: int) -> str:
    if 1 <= month <= len(ITALIAN_MONTHS):
        return ITALIAN_MONTHS[month - 1]
    return calendar.month_name[month]


def _build_month_view(session: Session) -> dict[str, object]:
    today = date.today()
    month_name = _month_label(today.month)
    weeks = calendar.Calendar(firstweekday=0).monthdayscalendar(today.year, today.month)
    event_map: dict[int, list[str]] = {}
    month_start = date(today.year, today.month, 1)
    month_end = date(today.year, today.month, calendar.monthrange(today.year, today.month)[1])
    events = (
        session.query(Event)
        .filter(Event.date >= month_start, Event.date <= month_end)
        .order_by(Event.date.asc())
        .all()
    )
    for event in events:
        if not event.date:
            continue
        event_map.setdefault(event.date.day, []).append(event.title)
    return {
        "month_name": month_name,
        "year": today.year,
        "weeks": weeks,
        "events": event_map,
    }


def _build_calendar_months(session: Session) -> list[dict[str, object]]:
    year = date.today().year
    months: list[dict[str, object]] = [
        {"month": name, "events": []} for name in ITALIAN_MONTHS
    ]
    year_start = date(year, 1, 1)
    year_end = date(year, 12, 31)
    events = (
        session.query(Event)
        .filter(Event.date >= year_start, Event.date <= year_end)
        .order_by(Event.date.asc())
        .all()
    )
    for event in events:
        if not event.date:
            continue
        month_index = event.date.month - 1
        if 0 <= month_index < len(months):
            months[month_index]["events"].append(
                {
                    "date": f"{event.date.day:02d}/{event.date.month:02d}",
                    "title": event.title,
                    "slug": event.slug,
                }
            )
    return months


def _build_featured_events(
    session: Session, limit: int = 3
) -> list[dict[str, str]]:
    today = date.today()
    featured_query = session.query(Event).filter(Event.is_featured.is_(True))
    events = (
        featured_query
        .filter(Event.date >= today)
        .order_by(Event.date.is_(None), Event.date.asc())
        .limit(limit)
        .all()
    )
    if len(events) < limit:
        remaining = limit - len(events)
        existing_ids = [event.id for event in events]
        extra_query = featured_query
        if existing_ids:
            extra_query = extra_query.filter(~Event.id.in_(existing_ids))
        extra = (
            extra_query
            .order_by(Event.date.is_(None), Event.date.asc())
            .limit(remaining)
            .all()
        )
        events.extend(extra)
    if not events:
        upcoming = (
            session.query(Event)
            .filter(Event.date >= today)
            .order_by(Event.date.is_(None), Event.date.asc())
            .limit(limit)
            .all()
        )
        events = upcoming
        if len(events) < limit:
            events = (
                session.query(Event)
                .order_by(Event.date.is_(None), Event.date.asc())
                .limit(limit)
                .all()
            )
    featured: list[dict[str, str]] = []
    for event in events:
        if not event.date:
            continue
        featured.append(
            {
                "date": f"{event.date.day:02d}/{event.date.month:02d}",
                "title": event.title,
                "month": _month_label(event.date.month),
                "slug": event.slug,
            }
        )
    return featured


def _member_from_session(request: Request, session: Session) -> Member | None:
    member_id = request.session.get("member_id")
    if not member_id:
        return None
    return session.get(Member, member_id)


def _set_pending_payment(request: Request, payload: dict[str, object]) -> None:
    request.session["pending_payment"] = payload


def _pop_pending_payment(request: Request) -> dict[str, object] | None:
    pending = request.session.pop("pending_payment", None)
    return pending if isinstance(pending, dict) else None


def _build_payment_result_context(
    pending: dict[str, object] | None, session: Session, success: bool
) -> dict[str, object]:
    return_url = "/"
    retry_url: str | None = None
    label: str | None = None
    password_hint: str | None = None

    if isinstance(pending, dict):
        pending_return = pending.get("return_url")
        if isinstance(pending_return, str) and pending_return:
            return_url = pending_return
        pending_retry = pending.get("retry_url")
        if isinstance(pending_retry, str) and pending_retry:
            retry_url = pending_retry
        pending_label = pending.get("label")
        if isinstance(pending_label, str) and pending_label:
            label = pending_label

        if pending.get("kind") == "membership":
            member_id = pending.get("member_id")
            if isinstance(member_id, str) and member_id.isdigit():
                member_id = int(member_id)
            if isinstance(member_id, int):
                member = session.get(Member, member_id)
                if member:
                    if success:
                        member.payment_status = "paid"
                        password_hint = member.access_code
                    elif member.payment_status != "paid":
                        member.payment_status = "failed"
                    reference = pending.get("reference")
                    if isinstance(reference, str) and reference:
                        member.payment_reference = reference
                    session.commit()

        if pending.get("kind") == "event":
            registration_id = pending.get("registration_id")
            if isinstance(registration_id, str) and registration_id.isdigit():
                registration_id = int(registration_id)
            if isinstance(registration_id, int):
                registration = session.get(EventRegistration, registration_id)
                if registration and registration.event:
                    if success:
                        registration.payment_status = "paid"
                        try:
                            _send_event_payment_emails(registration, registration.event)
                        except Exception:
                            logger.exception("Failed to send event payment emails")
                    elif registration.payment_status != "paid":
                        registration.payment_status = "failed"
                    reference = pending.get("reference")
                    if isinstance(reference, str) and reference:
                        registration.payment_reference = reference
                    session.commit()
                    return_url = f"/eventi/{registration.event.slug}?registered=1"
                    return {
                        "return_url": return_url,
                        "retry_url": None if success else f"/eventi/{registration.event.slug}",
                        "label": (
                            f"Iscrizione evento {registration.event.title} - Iscrizione completata"
                            if success
                            else f"Iscrizione evento {registration.event.title}"
                        ),
                    }

    return {
        "return_url": return_url,
        "retry_url": retry_url,
        "label": label,
        "password_hint": password_hint,
    }


def _payment_reference_from_request(request: Request) -> str | None:
    ref = request.query_params.get("ref")
    return ref if isinstance(ref, str) and ref else None


def _apply_reference_payment(
    ref: str | None, session: Session, success: bool, request: Request | None
) -> dict[str, object]:
    if not ref:
        return {}

    payment = session.query(MembershipPayment).filter_by(reference=ref).first()
    if payment:
        if payment.member_id:
            return {
                "return_url": "/area-tesserati",
                "label": "Tesseramento completato",
            }
        completion_url = (
            _membership_form_link(request, payment.reference)
            if request
            else f"/tesseramento/dati?ref={payment.reference}"
        )
        if success:
            was_pending = payment.status != "paid"
            if payment.status != "paid":
                payment.status = "paid"
                payment.paid_at = datetime.utcnow()
                session.commit()
            email_notice = None
            if payment.email and was_pending and request:
                if _send_membership_completion_email(payment.email, completion_url):
                    email_notice = f"Ti abbiamo inviato il link a {payment.email}."
            if was_pending and request:
                staff_lines = [
                    "Ricevuto un pagamento per nuovo tesseramento (area tesserati).",
                    "",
                    f"Email iscritto: {payment.email}",
                    f"Disciplina: {payment.sport_type}",
                    f"Riferimento pagamento: {payment.reference}",
                    f"Importo: {format_price(payment.amount_cents)} €",
                    "",
                    "L'iscritto deve ancora completare il modulo con i documenti.",
                    f"Link al modulo: {completion_url}",
                ]
                admin_base = _admin_base_url(request)
                if admin_base:
                    staff_lines.extend(["", f"Pannello gestione: {admin_base}/admin"])
                _send_membership_staff_email(
                    f"{settings.app_name} - Pagamento tesseramento ricevuto",
                    "\n".join(staff_lines),
                )
            context = {
                "return_url": completion_url,
                "retry_url": None,
                "label": f"Tesseramento {payment.sport_type}",
            }
            if email_notice:
                context["email_notice"] = email_notice
            return context
        if payment.status != "failed":
            payment.status = "failed"
            session.commit()
        return {
            "return_url": "/tesseramento",
            "retry_url": f"/tesseramento/pagamento?ref={payment.reference}",
            "label": f"Tesseramento {payment.sport_type}",
        }

    member = session.query(Member).filter_by(payment_reference=ref).first()
    if not member:
        registration = (
            session.query(EventRegistration)
            .filter(EventRegistration.payment_reference == ref)
            .first()
        )
        if not registration or not registration.event:
            return {}

        if success:
            registration.payment_status = "paid"
            try:
                _send_event_payment_emails(registration, registration.event)
            except Exception:
                logger.exception("Failed to send event payment emails (by ref)")
        elif registration.payment_status != "paid":
            registration.payment_status = "failed"
        session.commit()
        return {
            "return_url": f"/eventi/{registration.event.slug}?registered=1",
            "retry_url": f"/eventi/{registration.event.slug}",
            "label": f"Iscrizione evento {registration.event.title}",
        }

    was_unpaid = member.payment_status != "paid"
    if success:
        member.payment_status = "paid"
    elif member.payment_status != "paid":
        member.payment_status = "failed"
    session.commit()
    if success and was_unpaid:
        name_line = f"{(member.first_name or '').strip()} {(member.last_name or '').strip()}".strip()
        staff_lines = [
            "Pagamento ricevuto per accesso all'area tesserati.",
            "",
            f"Nome: {name_line or (member.name or '').strip()}",
            f"Email: {member.email or ''}",
            f"ID socio: {member.id}",
        ]
        if member.payment_reference:
            staff_lines.append(f"Riferimento pagamento: {member.payment_reference}")
        admin_base = _admin_base_url(request)
        if admin_base:
            staff_lines.extend(["", f"Pannello gestione: {admin_base}/admin"])
        _send_membership_staff_email(
            f"{settings.app_name} - Pagamento area tesserati",
            "\n".join(staff_lines),
        )
        _send_membership_applicant_payment_ack_email(member)
    return {
        "return_url": "/area-tesserati",
        "label": f"Tesseramento {member.first_name} {member.last_name}",
        "password_hint": member.access_code if success else None,
    }


@app.get("/", response_class=HTMLResponse)
def home(request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    merch_preview: list[MerchItem] = []
    if SHOW_MERCH_PREVIEW:
        merch_preview = session.query(MerchItem).order_by(MerchItem.id).limit(3).all()
    calendar_view = _build_month_view(session)
    featured_events = _build_featured_events(session)
    return templates.TemplateResponse(
        "home.html",
        {
            "request": request,
            "featured_events": featured_events,
            "calendar_view": calendar_view,
            "weekday_labels": WEEKDAY_LABELS,
            "merch_preview": merch_preview,
            "show_merch_preview": SHOW_MERCH_PREVIEW,
            "membership_fee": settings.membership_fee_eur,
            "settings": settings,
            "price_fn": format_price,
        },
    )


def _normalize_gpx_source_url(url: str) -> str:
    """Trasforma link «condivisione» (Google Drive /view) in URL che scarica il file."""
    u = (url or "").strip()
    if not u:
        return u
    m = re.search(r"drive\.google\.com/file/d/([a-zA-Z0-9_-]+)", u)
    if m:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}"
    parsed = urlparse(u)
    host = (parsed.netloc or "").lower()
    if "drive.google.com" in host and parsed.path.rstrip("/") == "/open":
        q = parse_qs(parsed.query)
        ids = q.get("id", [])
        if ids:
            return f"https://drive.google.com/uc?export=download&id={ids[0]}"
    return u


def _bytes_look_like_gpx(data: bytes) -> bool:
    if not data or len(data) < 20:
        return False
    head = data[:800].lstrip().lower()
    if head.startswith(b"<!doctype") or head.startswith(b"<html"):
        return False
    if head.startswith(b"<?xml"):
        return b"<gpx" in data[: min(len(data), 50000)].lower()
    if head.startswith(b"<gpx"):
        return True
    return b"<gpx" in data[:8000].lower()


def _fetch_gpx_binary(url: str) -> bytes:
    """Scarica GPX; gestisce Google Drive (HTML anteprima / avviso virus scan)."""
    fetch_url = _normalize_gpx_source_url(url)
    parsed = urlparse(fetch_url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("URL non http(s)")
    sess = requests.Session()
    sess.headers.update(
        {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
            )
        }
    )
    r = sess.get(fetch_url, timeout=60, allow_redirects=True)
    r.raise_for_status()
    content = r.content
    if _bytes_look_like_gpx(content):
        return content
    is_drive = "drive.google.com" in fetch_url
    if is_drive and b"export=download" in fetch_url.encode():
        join = "&" if "?" in fetch_url else "?"
        if "confirm=" not in fetch_url:
            r2 = sess.get(fetch_url + join + "confirm=t", timeout=60, allow_redirects=True)
            r2.raise_for_status()
            content = r2.content
            if _bytes_look_like_gpx(content):
                return content
        text = content.decode("utf-8", errors="ignore")
        for pattern in (
            r'href="(https://drive\.usercontent\.google\.com/download[^"]+)"',
            r'href="(/uc\?export=download[^"]+)"',
            r'href="(https://drive\.google\.com/uc\?[^"]+)"',
        ):
            m = re.search(pattern, text)
            if not m:
                continue
            nxt = m.group(1).replace("&amp;", "&")
            if nxt.startswith("/"):
                nxt = "https://drive.google.com" + nxt
            r3 = sess.get(nxt, timeout=60, allow_redirects=True)
            r3.raise_for_status()
            content = r3.content
            if _bytes_look_like_gpx(content):
                return content
    if not _bytes_look_like_gpx(content):
        logger.warning(
            "Risposta GPX non sembra un file GPX (host=%s): prime 120 char: %r",
            urlparse(fetch_url).netloc,
            content[:120],
        )
    return content


@app.get("/eventi/{slug}/route-gpx/{route_key}", name="event_route_gpx_proxy")
def event_route_gpx_proxy(
    request: Request,
    slug: str,
    route_key: str,
    session: Session = Depends(get_session),
) -> Response:
    event = session.query(Event).filter_by(slug=slug).first()
    if not event:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evento non trovato.")
    route_key = route_key.strip().lower()
    if route_key not in _allowed_gpx_route_keys(event):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Percorso non valido.")
    target_url: str | None = None
    for r in parse_event_route_gpx(event):
        if r["key"] == route_key:
            target_url = r["url"]
            break
    if not target_url:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="GPX non configurato.")
    parsed = urlparse((target_url or "").strip())
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="URL GPX non valido.")
    try:
        content = _fetch_gpx_binary(target_url)
    except requests.RequestException:
        logger.exception("GPX fetch failed for event %s route %s", slug, route_key)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Impossibile scaricare il file GPX.",
        )
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="URL GPX non valido.")
    if not _bytes_look_like_gpx(content):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                "Il file non risulta un GPX valido (link Drive «anteprima» invece del download). "
                "Prova: tasto destro sul file in Drive → Ottieni link → link diretto, "
                "oppure carica il .gpx su hosting che lo serva come file."
            ),
        )
    if len(content) > _ROUTE_GPX_MAX_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
    headers: dict[str, str] = {"Cache-Control": "public, max-age=300"}
    if request.query_params.get("dl") == "1":
        headers["Content-Disposition"] = f'attachment; filename="{route_key}.gpx"'
    return Response(
        content=content,
        media_type="application/gpx+xml",
        headers=headers,
    )


@app.get("/eventi/{slug}", response_class=HTMLResponse)
def read_event(
    request: Request, slug: str, session: Session = Depends(get_session)
) -> HTMLResponse:
    event = session.query(Event).filter_by(slug=slug).first()
    if not event:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evento non trovato")
    event_gallery = _parse_gallery_urls(event.gallery_urls)
    documents_links = _parse_gallery_urls(event.documents_urls)
    registration_notice = None
    if request.query_params.get("registered") == "1":
        registration_notice = "Iscrizione ricevuta. Ti contatteremo via email."
    waitlist_notice = None
    if request.query_params.get("waitlist") == "1":
        waitlist_notice = (
            "Richiesta in lista d'attesa registrata. Ti contatteremo se si libera un posto."
        )
    ctx = _event_registration_template_extras(request, event, session)
    return templates.TemplateResponse(
        "event_detail.html",
        {
            "request": request,
            "event": event,
            "event_gallery": event_gallery,
            "documents_links": documents_links,
            "registration_notice": registration_notice,
            "waitlist_notice": waitlist_notice,
            "registration_errors": [],
            "registration_block_notice": None,
            "waitlist_errors": [],
            "form_values": {
                "first_name": "",
                "last_name": "",
                "email": "",
                "phone": "",
                "residence": "",
                "intolerances": "",
                "privacy_photo": False,
                "privacy_other": False,
                "waiver_accepted": False,
                "lunch_option": "",
                "lunch_guests": 0,
                "team_name": "",
                "discipline": "",
                "route_length": "",
                "jersey_size": "",
                "jersey_gender": "",
            },
            "waitlist_form_values": {
                "first_name": "",
                "last_name": "",
                "phone": "",
                "email": "",
            },
            "settings": settings,
            **ctx,
        },
    )


@app.post("/eventi/{slug}/iscrizione", response_class=HTMLResponse)
def register_event(
    request: Request,
    slug: str,
    first_name: str = Form(""),
    last_name: str = Form(""),
    email: str = Form(""),
    phone: str = Form(""),
    residence: str = Form(""),
    intolerances: str = Form(""),
    lunch_option: str = Form(""),
    lunch_guests: str = Form("0"),
    team_name: str = Form(""),
    discipline: str = Form(""),
    route_length: str = Form(""),
    jersey_size: str = Form(""),
    jersey_gender: str = Form(""),
    privacy_photo: str | None = Form(None),
    privacy_other: str | None = Form(None),
    waiver_accepted: str | None = Form(None),
    acsi_fci_document: UploadFile | None = File(None),
    medical_certificate: UploadFile | None = File(None),
    waiver_document: UploadFile | None = File(None),
    session: Session = Depends(get_session),
) -> HTMLResponse:
    event = session.query(Event).filter_by(slug=slug).first()
    if not event:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evento non trovato")
    if not event.is_amaro_event:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Iscrizione non disponibile per questo evento.",
        )

    if _event_registration_is_full(session, event):
        event_gallery = _parse_gallery_urls(event.gallery_urls)
        ctx = _event_registration_template_extras(request, event, session)
        return templates.TemplateResponse(
            "event_detail.html",
            {
                "request": request,
                "event": event,
                "event_gallery": event_gallery,
                "documents_links": _parse_gallery_urls(event.documents_urls),
                "registration_notice": None,
                "waitlist_notice": None,
                "registration_errors": [],
                "registration_block_notice": (
                    "Iscrizioni chiuse: raggiunto il numero massimo di partecipanti. "
                    "Puoi iscriverti alla lista d'attesa qui sotto."
                ),
                "waitlist_errors": [],
                "form_values": {
                    "first_name": "",
                    "last_name": "",
                    "email": "",
                    "phone": "",
                    "residence": "",
                    "intolerances": "",
                    "privacy_photo": False,
                    "privacy_other": False,
                    "waiver_accepted": False,
                    "lunch_option": "",
                    "lunch_guests": 0,
                    "team_name": "",
                    "discipline": "",
                    "route_length": "",
                    "jersey_size": "",
                    "jersey_gender": "",
                },
                "waitlist_form_values": {
                    "first_name": "",
                    "last_name": "",
                    "phone": "",
                    "email": "",
                },
                "settings": settings,
                **ctx,
            },
        )

    try:
        lunch_guests_int = min(2, max(0, int(lunch_guests or 0)))
    except ValueError:
        lunch_guests_int = 0

    normalized = {
        "first_name": _normalize(first_name) or "",
        "last_name": _normalize(last_name) or "",
        "email": _normalize(email) or "",
        "phone": _normalize(phone) or "",
        "residence": _normalize(residence) or "",
        "intolerances": _normalize(intolerances) or "",
        "lunch_option": _normalize(lunch_option) or "",
        "lunch_guests": lunch_guests_int,
        "team_name": _normalize(team_name) or "",
        "discipline": _normalize(discipline) or "",
        "route_length": _normalize(route_length) or "",
        "jersey_size": _normalize(jersey_size) or "",
        "jersey_gender": _normalize(jersey_gender) or "",
        "privacy_photo": bool(privacy_photo),
        "privacy_other": bool(privacy_other),
        "waiver_accepted": bool(waiver_accepted),
    }
    errors: list[str] = []

    def require(flag: bool, value: str, label: str) -> None:
        if flag and not value:
            errors.append(f"{label} obbligatorio.")

    require(event.require_first_name, normalized["first_name"], "Nome")
    require(event.require_last_name, normalized["last_name"], "Cognome")
    require(event.require_email, normalized["email"], "Email")
    require(event.require_phone, normalized["phone"], "Cellulare")
    # Residenza non più richiesta per le iscrizioni evento
    require(event.require_intolerances, normalized["intolerances"], "Intolleranze/Allergie")

    if event.require_privacy_photo and not normalized["privacy_photo"]:
        errors.append("Consenso privacy foto obbligatorio.")
    if event.require_privacy_other and not normalized["privacy_other"]:
        errors.append("Consenso privacy obbligatorio.")
    if event.require_waiver_acceptance and not normalized["waiver_accepted"]:
        errors.append("Accettazione della liberatoria obbligatoria.")

    if event.enable_lunch_option and not normalized["lunch_option"]:
        errors.append("Scelta pranzo obbligatoria.")
    act_cfg = parse_event_activities_config(event)
    if act_cfg:
        if not normalized["discipline"]:
            errors.append("Scelta disciplina obbligatoria.")
        if not normalized["route_length"]:
            errors.append("Scelta percorso obbligatoria.")
        sport_ok = False
        route_ok = False
        for s in act_cfg:
            if s["key"] != normalized["discipline"]:
                continue
            sport_ok = True
            for r in s["routes"]:
                if r["key"] == normalized["route_length"]:
                    route_ok = True
                    break
            break
        if normalized["discipline"] and not sport_ok:
            errors.append("Disciplina non valida.")
        if sport_ok and normalized["route_length"] and not route_ok:
            errors.append("Percorso non valido per la disciplina scelta.")
    else:
        if event.enable_discipline_option and not normalized["discipline"]:
            errors.append("Scelta disciplina obbligatoria.")
        route_mode = _event_route_mode(event)
        if event.enable_route_option:
            if route_mode == "distances":
                if not normalized["route_length"]:
                    errors.append("Scelta percorso obbligatoria.")
            else:
                normalized["route_length"] = (
                    "trail" if route_mode == "trail" else "corsa"
                )
    if event.enable_jersey and (normalized["jersey_size"] or normalized["jersey_gender"]) and not (
        normalized["jersey_size"] and normalized["jersey_gender"]
    ):
        errors.append("Per ordinare la maglia seleziona sia taglia che genere.")

    acsi_fci_upload = acsi_fci_document if acsi_fci_document and acsi_fci_document.filename else None
    medical_upload = medical_certificate if medical_certificate and medical_certificate.filename else None
    waiver_upload = waiver_document if waiver_document and waiver_document.filename else None
    if event.require_acsi_fci and not acsi_fci_upload:
        errors.append("Tessera ACSI/FCI obbligatoria.")
    med_policy = _event_medical_policy(event)
    needs_agonistic = _event_route_requires_agonistic_medical(
        event, normalized["discipline"], normalized["route_length"]
    )
    if not medical_upload:
        if med_policy == "required":
            errors.append("Certificato medico obbligatorio.")
        elif needs_agonistic:
            errors.append(
                "Per il percorso scelto è obbligatorio il certificato medico agonistico."
            )
    if event.require_waiver_upload and not waiver_upload:
        errors.append("Caricamento della liberatoria firmata obbligatorio.")

    if errors:
        event_gallery = _parse_gallery_urls(event.gallery_urls)
        ctx = _event_registration_template_extras(request, event, session)
        return templates.TemplateResponse(
            "event_detail.html",
            {
                "request": request,
                "event": event,
                "event_gallery": event_gallery,
                "documents_links": _parse_gallery_urls(event.documents_urls),
                "registration_notice": None,
                "waitlist_notice": None,
                "registration_errors": errors,
                "registration_block_notice": None,
                "waitlist_errors": [],
                "form_values": normalized,
                "waitlist_form_values": {
                    "first_name": "",
                    "last_name": "",
                    "phone": "",
                    "email": "",
                },
                "settings": settings,
                **ctx,
            },
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    registration = EventRegistration(
        event_id=event.id,
        first_name=normalized["first_name"],
        last_name=normalized["last_name"],
        email=normalized["email"],
        phone=normalized["phone"],
        residence=normalized["residence"],
        intolerances=normalized["intolerances"],
        privacy_photo=normalized["privacy_photo"],
        privacy_other=normalized["privacy_other"],
        waiver_accepted=normalized["waiver_accepted"],
        lunch_option=normalized["lunch_option"] or None,
        lunch_guests=normalized["lunch_guests"] or None,
        team_name=normalized["team_name"] or None,
        discipline=normalized["discipline"] or None,
        route_length=normalized["route_length"] or None,
        jersey_size=normalized["jersey_size"] or None,
        jersey_gender=normalized["jersey_gender"] or None,
    )
    session.add(registration)
    session.flush()

    base_price = event.event_price_cents or 0
    lunch_price = 0
    if event.enable_lunch_option and normalized["lunch_option"] == "con_pranzo":
        lunch_price = event.event_lunch_price_cents or 0
    jersey_price = 0
    if event.enable_jersey and registration.jersey_size and registration.jersey_gender:
        jersey_price = event.jersey_price_cents or 0
    total_cents = base_price + lunch_price + jersey_price

    registration.total_amount_cents = total_cents or None

    if acsi_fci_upload:
        stored_filename, original_name, content_type = _save_event_document(
            registration.id, acsi_fci_upload
        )
        registration.acsi_fci_stored_filename = stored_filename
        registration.acsi_fci_original_name = original_name
        registration.acsi_fci_content_type = content_type

    if medical_upload:
        stored_filename, original_name, content_type = _save_event_document(
            registration.id, medical_upload
        )
        registration.medical_stored_filename = stored_filename
        registration.medical_original_name = original_name
        registration.medical_content_type = content_type

    if waiver_upload:
        stored_filename, original_name, content_type = _save_event_document(
            registration.id, waiver_upload
        )
        registration.waiver_stored_filename = stored_filename
        registration.waiver_original_name = original_name
        registration.waiver_content_type = content_type

    session.commit()

    if total_cents <= 0:
        return RedirectResponse(
            url=f"/eventi/{slug}?registered=1",
            status_code=status.HTTP_303_SEE_OTHER,
        )

    payment_reference = build_payment_reference("EVT")
    registration.payment_reference = payment_reference
    registration.payment_status = "pending"
    session.commit()

    _set_pending_payment(
        request,
        {
            "kind": "event",
            "registration_id": registration.id,
            "reference": payment_reference,
            "return_url": f"/eventi/{slug}?registered=1",
            "retry_url": f"/eventi/{slug}",
            "label": f"Iscrizione evento {event.title}",
        },
    )
    success_url = f"{settings.nexipay_success_url}?ref={payment_reference}"
    failure_url = f"{settings.nexipay_failure_url}?ref={payment_reference}"
    payment_context: NexiPaymentContext = _require_nexi_client().prepare_payment(
        amount_cents=total_cents,
        order_id=payment_reference,
        description=f"Iscrizione evento {event.title}",
        email=normalized["email"] or None,
        success_url=success_url,
        failure_url=failure_url,
    )

    return templates.TemplateResponse(
        "event_payment.html",
        {
            "request": request,
            "event": event,
            "event_date": event.date.strftime("%d/%m/%Y") if event.date else None,
            "total": format_price(total_cents),
            "payment": payment_context,
            "settings": settings,
        },
    )


@app.post("/eventi/{slug}/lista-attesa", response_class=HTMLResponse)
def register_event_waitlist(
    request: Request,
    slug: str,
    first_name: str = Form(""),
    last_name: str = Form(""),
    phone: str = Form(""),
    email: str = Form(""),
    session: Session = Depends(get_session),
) -> HTMLResponse:
    event = session.query(Event).filter_by(slug=slug).first()
    if not event:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evento non trovato")
    if not event.is_amaro_event:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Lista d'attesa non disponibile per questo evento.",
        )
    if not _event_registration_is_full(session, event):
        return RedirectResponse(
            url=f"/eventi/{slug}",
            status_code=status.HTTP_303_SEE_OTHER,
        )

    normalized = {
        "first_name": _normalize(first_name) or "",
        "last_name": _normalize(last_name) or "",
        "phone": _normalize(phone) or "",
        "email": _normalize(email) or "",
    }
    waitlist_errors: list[str] = []
    if not normalized["first_name"]:
        waitlist_errors.append("Nome obbligatorio.")
    if not normalized["last_name"]:
        waitlist_errors.append("Cognome obbligatorio.")
    if not normalized["phone"]:
        waitlist_errors.append("Cellulare obbligatorio.")
    if not normalized["email"]:
        waitlist_errors.append("Email obbligatoria.")

    if waitlist_errors:
        event_gallery = _parse_gallery_urls(event.gallery_urls)
        ctx = _event_registration_template_extras(request, event, session)
        return templates.TemplateResponse(
            "event_detail.html",
            {
                "request": request,
                "event": event,
                "event_gallery": event_gallery,
                "documents_links": _parse_gallery_urls(event.documents_urls),
                "registration_notice": None,
                "waitlist_notice": None,
                "registration_errors": [],
                "registration_block_notice": (
                    "Iscrizioni chiuse: raggiunto il numero massimo di partecipanti."
                ),
                "waitlist_errors": waitlist_errors,
                "form_values": {
                    "first_name": "",
                    "last_name": "",
                    "email": "",
                    "phone": "",
                    "residence": "",
                    "intolerances": "",
                    "privacy_photo": False,
                    "privacy_other": False,
                    "waiver_accepted": False,
                    "lunch_option": "",
                    "lunch_guests": 0,
                    "team_name": "",
                    "discipline": "",
                    "route_length": "",
                    "jersey_size": "",
                    "jersey_gender": "",
                },
                "waitlist_form_values": normalized,
                "settings": settings,
                **ctx,
            },
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    entry = EventWaitlistEntry(
        event_id=event.id,
        first_name=normalized["first_name"],
        last_name=normalized["last_name"],
        phone=normalized["phone"],
        email=normalized["email"],
    )
    session.add(entry)
    session.commit()
    return RedirectResponse(
        url=f"/eventi/{slug}?waitlist=1",
        status_code=status.HTTP_303_SEE_OTHER,
    )


@app.get("/merch", response_class=HTMLResponse)
def merch_listing(request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    items = session.query(MerchItem).order_by(MerchItem.name.asc()).all()
    return templates.TemplateResponse(
        "merch.html",
        {
            "request": request,
            "merch": items,
            "settings": settings,
            "price_fn": format_price,
        },
    )


@app.get("/merch/{slug}", response_class=HTMLResponse)
def merch_detail(
    request: Request, slug: str, session: Session = Depends(get_session)
) -> HTMLResponse:
    item = session.query(MerchItem).filter_by(slug=slug).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Prodotto non trovato")
    return templates.TemplateResponse(
        "merch_item.html",
        {
            "request": request,
            "item": item,
            "settings": settings,
            "price_fn": format_price,
        },
    )


@app.post("/merch/{slug}/checkout", response_class=HTMLResponse)
def merch_checkout(
    request: Request,
    slug: str,
    quantity: int = Form(1),
    session: Session = Depends(get_session),
) -> HTMLResponse:
    item = session.query(MerchItem).filter_by(slug=slug).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Prodotto non trovato")

    quantity = max(1, min(quantity, item.stock or 1))
    total_cents = item.price_cents * quantity
    payment_reference = build_payment_reference("MER")
    _set_pending_payment(
        request,
        {
            "kind": "merch",
            "reference": payment_reference,
            "return_url": f"/merch/{item.slug}",
            "retry_url": f"/merch/{item.slug}",
            "label": f"Ordine merch: {item.name} x{quantity}",
        },
    )
    success_url = f"{settings.nexipay_success_url}?ref={payment_reference}"
    failure_url = f"{settings.nexipay_failure_url}?ref={payment_reference}"
    payment = _require_nexi_client().prepare_payment(
        amount_cents=total_cents,
        order_id=payment_reference,
        description=f"{item.name} × {quantity}",
        email=None,
        success_url=success_url,
        failure_url=failure_url,
    )

    return templates.TemplateResponse(
        "merch_payment.html",
        {
            "request": request,
            "item": item,
            "quantity": quantity,
            "total": format_price(total_cents),
            "payment": payment,
            "settings": settings,
        },
    )


@app.get("/calendario", response_class=HTMLResponse)
def calendar_view(request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    calendar_months = _build_calendar_months(session)
    return templates.TemplateResponse(
        "calendar.html",
        {
            "request": request,
            "calendar_months": calendar_months,
            "settings": settings,
        },
    )


@app.get("/associazione", response_class=HTMLResponse)
def association(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "associazione.html",
        {
            "request": request,
            "settings": settings,
        },
    )


@app.get("/tesseramento", response_class=HTMLResponse)
def membership_start(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "membership_start.html",
        {
            "request": request,
            "membership_fee_range": MEMBERSHIP_FEE_RANGE_LABEL,
            "sport_types": SPORT_TYPES,
            "sport_type_fees": SPORT_TYPE_FEES,
            "settings": settings,
        },
    )


@app.post("/tesseramento/pagamento", response_class=HTMLResponse)
def membership_payment_start(
    request: Request,
    sport_type: str = Form(...),
    email: str = Form(...),
    session: Session = Depends(get_session),
) -> HTMLResponse:
    sport_type = sport_type.strip()
    email = email.strip()
    if not email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email obbligatoria.",
        )
    if sport_type not in SPORT_TYPE_FEES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Disciplina non valida.",
        )
    membership_fee = membership_fee_for_sport(sport_type)
    payment_reference = build_payment_reference("MEM")
    payment = MembershipPayment(
        reference=payment_reference,
        email=email,
        sport_type=sport_type,
        amount_cents=membership_fee * 100,
        status="pending",
    )
    session.add(payment)
    session.commit()

    success_url = f"{settings.nexipay_success_url}?ref={payment_reference}"
    failure_url = f"{settings.nexipay_failure_url}?ref={payment_reference}"
    payment_context: NexiPaymentContext = _require_nexi_client().prepare_payment(
        amount_cents=membership_fee * 100,
        order_id=payment_reference,
        description=f"Tesseramento {sport_type}",
        email=email,
        success_url=success_url,
        failure_url=failure_url,
    )
    _set_pending_payment(
        request,
        {
            "kind": "membership",
            "reference": payment_reference,
            "return_url": f"/tesseramento/dati?ref={payment_reference}",
            "retry_url": f"/tesseramento/pagamento?ref={payment_reference}",
            "label": f"Tesseramento {sport_type}",
        },
    )
    return templates.TemplateResponse(
        "membership_checkout.html",
        {
            "request": request,
            "sport_type": sport_type,
            "membership_fee": membership_fee,
            "email": email,
            "payment": payment_context,
            "settings": settings,
        },
    )


@app.get("/tesseramento/pagamento", response_class=HTMLResponse)
def membership_payment_retry(
    request: Request, ref: str, session: Session = Depends(get_session)
) -> HTMLResponse:
    payment = session.query(MembershipPayment).filter_by(reference=ref).first()
    if not payment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Pagamento tesseramento non trovato",
        )
    if payment.status == "paid" and not payment.member_id:
        return RedirectResponse(
            url=f"/tesseramento/dati?ref={payment.reference}",
            status_code=status.HTTP_303_SEE_OTHER,
        )
    if payment.member_id:
        return RedirectResponse(
            url="/area-tesserati", status_code=status.HTTP_303_SEE_OTHER
        )
    membership_fee = payment.amount_cents // 100
    success_url = f"{settings.nexipay_success_url}?ref={payment.reference}"
    failure_url = f"{settings.nexipay_failure_url}?ref={payment.reference}"
    payment_context: NexiPaymentContext = _require_nexi_client().prepare_payment(
        amount_cents=payment.amount_cents,
        order_id=payment.reference,
        description=f"Tesseramento {payment.sport_type}",
        email=payment.email,
        success_url=success_url,
        failure_url=failure_url,
    )
    _set_pending_payment(
        request,
        {
            "kind": "membership",
            "reference": payment.reference,
            "return_url": f"/tesseramento/dati?ref={payment.reference}",
            "retry_url": f"/tesseramento/pagamento?ref={payment.reference}",
            "label": f"Tesseramento {payment.sport_type}",
        },
    )
    return templates.TemplateResponse(
        "membership_checkout.html",
        {
            "request": request,
            "sport_type": payment.sport_type,
            "membership_fee": membership_fee,
            "email": payment.email,
            "payment": payment_context,
            "settings": settings,
        },
    )


@app.get("/tesseramento/dati", response_class=HTMLResponse)
def membership_form(request: Request, ref: str, session: Session = Depends(get_session)) -> HTMLResponse:
    payment = session.query(MembershipPayment).filter_by(reference=ref).first()
    if not payment or payment.status != "paid" or payment.member_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Pagamento non valido o gia' completato.",
        )
    return templates.TemplateResponse(
        "membership.html",
        {
            "request": request,
            "payment_reference": payment.reference,
            "membership_fee_range": MEMBERSHIP_FEE_RANGE_LABEL,
            "sport_types": SPORT_TYPES,
            "sport_type_fees": SPORT_TYPE_FEES,
            "selected_sport_type": payment.sport_type,
            "lock_sport_type": True,
            "prefill_email": payment.email,
            "settings": settings,
            "uploads_path": settings.uploads_path,
        },
    )


@app.post("/tesseramento")
@app.post("/tesseramento/dati")
def membership_submit(
    request: Request,
    background_tasks: BackgroundTasks,
    payment_reference: str = Form(...),
    first_name: str = Form(...),
    last_name: str = Form(...),
    email: str = Form(...),
    phone: str = Form(...),
    birth_date: date = Form(...),
    birth_place: str = Form(...),
    residence: str = Form(...),
    codice_fiscale: str = Form(...),
    document_type: str = Form(...),
    document_number: str = Form(...),
    document_id: str | None = Form(None),
    medical_certificate_expiry: date = Form(...),
    membership_type: str | None = Form(None),
    sport_type: str = Form(...),
    message: str | None = Form(None),
    identity_documents: list[UploadFile] = File(...),
    health_documents: list[UploadFile] = File(...),
    medical_documents: list[UploadFile] = File(...),
    request_manual_review: str | None = Form(None),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    payment = (
        session.query(MembershipPayment)
        .filter_by(reference=payment_reference)
        .first()
    )
    if not payment or payment.status != "paid" or payment.member_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Pagamento non valido o gia' completato.",
        )
    if payment.sport_type != sport_type:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Disciplina non valida per il pagamento effettuato.",
        )
    if not membership_type:
        membership_type = MEMBERSHIP_TYPES[0]
    for field_value in [document_type, document_number]:
        if not _normalize(field_value):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Documento obbligatorio mancante (tipo o numero documento).",
            )

    password_plain, password_hash = _generate_member_password()
    member = Member(
        name=f"{first_name.strip()} {last_name.strip()}",
        first_name=first_name.strip(),
        last_name=last_name.strip(),
        email=email.strip(),
        phone=_normalize(phone),
        birth_date=birth_date,
        birth_place=_normalize(birth_place),
        residence=_normalize(residence),
        codice_fiscale=_normalize(codice_fiscale),
        document_type=_normalize(document_type),
        document_number=_normalize(document_number),
        document_id=_normalize(document_id),
        medical_certificate_expiry=medical_certificate_expiry,
        membership_type=membership_type,
        sport_type=payment.sport_type,
        message=_normalize(message),
        membership_status=MEMBERSHIP_STATUS_PENDING,
        access_code=password_plain,
        password_hash=password_hash,
        payment_status="paid",
        payment_reference=payment.reference,
    )
    session.add(member)
    session.flush()
    identity_documents = _require_uploads(
        identity_documents, DOCUMENT_CATEGORY_IDENTITY
    )
    health_documents = _require_uploads(
        health_documents, DOCUMENT_CATEGORY_HEALTH
    )
    medical_documents = _require_uploads(
        medical_documents, DOCUMENT_CATEGORY_MEDICAL
    )
    saved_docs = _save_categorized_documents(
        member.id,
        {
            DOCUMENT_CATEGORY_IDENTITY: identity_documents,
            DOCUMENT_CATEGORY_HEALTH: health_documents,
            DOCUMENT_CATEGORY_MEDICAL: medical_documents,
        },
    )
    saved_doc_ids: list[int] = []
    if saved_docs:
        session.add_all(saved_docs)
        session.flush()
        saved_doc_ids = [doc.id for doc in saved_docs]
    payment.member_id = member.id
    payment.status = "completed"
    session.commit()
    if saved_doc_ids:
        schedule_documents_ocr(saved_doc_ids, member.id, background_tasks)
    manual_review = _normalize(request_manual_review) == "1"
    if manual_review and saved_docs:
        send_documents_manual_review_email(member, saved_docs)
    request.session["member_id"] = member.id
    request.session["member_password_hint"] = password_plain
    if manual_review:
        request.session["member_notice"] = (
            "Modulo inviato per verifica manuale dei documenti. "
            "La pratica non sara automatica e i tempi saranno piu lunghi."
        )
    admin_base = _admin_base_url(request)
    staff_lines = [
        "Nuovo tesseramento: modulo e documenti inviati (area tesserati).",
        "",
        f"Nome: {member.first_name} {member.last_name}",
        f"Email: {member.email}",
        f"Telefono: {member.phone or ''}",
        f"Disciplina: {member.sport_type}",
        f"ID socio: {member.id}",
        "",
    ]
    if manual_review:
        staff_lines.append(
            "Documenti inviati per verifica manuale (OCR non superato)."
        )
    else:
        staff_lines.append(
            "Verifica i documenti e completa l'approvazione socio dal pannello."
        )
    if admin_base:
        staff_lines.append(f"Pannello: {admin_base}/admin")
    _send_membership_staff_email(
        f"{settings.app_name} - Modulo tesseramento completato",
        "\n".join(staff_lines),
    )
    _send_membership_applicant_form_ack_email(member)
    return RedirectResponse(
        url="/area-tesserati", status_code=status.HTTP_303_SEE_OTHER
    )


@app.get("/tesseramento/pagamento/{member_id}", response_class=HTMLResponse)
def membership_payment(
    member_id: int, request: Request, session: Session = Depends(get_session)
) -> HTMLResponse:
    member = session.get(Member, member_id)
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Richiesta di tesseramento non trovata",
        )
    payment_reference = build_payment_reference("MEM")
    member.payment_reference = payment_reference
    session.commit()
    membership_fee = membership_fee_for_sport(member.sport_type)
    _set_pending_payment(
        request,
        {
            "kind": "membership",
            "member_id": member.id,
            "reference": payment_reference,
            "return_url": "/area-tesserati",
            "retry_url": f"/tesseramento/pagamento/{member.id}",
            "label": f"Tesseramento {member.first_name} {member.last_name}",
        },
    )
    success_url = f"{settings.nexipay_success_url}?ref={payment_reference}"
    failure_url = f"{settings.nexipay_failure_url}?ref={payment_reference}"
    payment_context: NexiPaymentContext = _require_nexi_client().prepare_payment(
        amount_cents=membership_fee * 100,
        order_id=payment_reference,
        description=f"Tesseramento {(member.name or '').strip() or f'{member.first_name} {member.last_name}'}",
        email=member.email,
        success_url=success_url,
        failure_url=failure_url,
    )
    is_owner = request.session.get("member_id") == member.id
    documents = list(member.documents) if is_owner else []
    return templates.TemplateResponse(
        "membership_payment.html",
        {
            "request": request,
            "member": member,
            "payment": payment_context,
            "documents": documents,
            "settings": settings,
            "membership_fee": membership_fee,
            "is_owner": is_owner,
        },
    )


@app.api_route("/nexi/success", methods=["GET", "POST"], response_class=HTMLResponse)
def nexi_success(
    request: Request, session: Session = Depends(get_session)
) -> HTMLResponse:
    pending = _pop_pending_payment(request)
    context = _build_payment_result_context(pending, session, success=True)
    ref_context = _apply_reference_payment(
        _payment_reference_from_request(request),
        session,
        success=True,
        request=request,
    )
    for key, value in ref_context.items():
        if value is not None:
            context[key] = value
    return templates.TemplateResponse(
        "payment_result.html",
        {
            "request": request,
            "settings": settings,
            "success": True,
            **context,
        },
    )


@app.api_route("/nexi/failure", methods=["GET", "POST"], response_class=HTMLResponse)
def nexi_failure(
    request: Request, session: Session = Depends(get_session)
) -> HTMLResponse:
    pending = _pop_pending_payment(request)
    context = _build_payment_result_context(pending, session, success=False)
    ref_context = _apply_reference_payment(
        _payment_reference_from_request(request),
        session,
        success=False,
        request=request,
    )
    for key, value in ref_context.items():
        if value is not None:
            context[key] = value
    return templates.TemplateResponse(
        "payment_result.html",
        {
            "request": request,
            "settings": settings,
            "success": False,
            **context,
        },
    )


def _parse_optional_date(value: str | None) -> date | None:
    if not value or not value.strip():
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return None


_VALID_DOCUMENT_CATEGORIES = {
    DOCUMENT_CATEGORY_IDENTITY,
    DOCUMENT_CATEGORY_HEALTH,
    DOCUMENT_CATEGORY_MEDICAL,
}


@app.post("/api/documenti/valida")
async def validate_document_upload(
    file: UploadFile = File(...),
    category: str = Form(...),
    first_name: str | None = Form(None),
    last_name: str | None = Form(None),
    codice_fiscale: str | None = Form(None),
    document_number: str | None = Form(None),
    medical_certificate_expiry: str | None = Form(None),
    sport_type: str | None = Form(None),
) -> JSONResponse:
    if category not in _VALID_DOCUMENT_CATEGORIES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Categoria documento non valida.",
        )
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File mancante.",
        )

    suffix = Path(file.filename).suffix or ".bin"
    total_size = 0
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = Path(tmp.name)
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total_size += len(chunk)
                if total_size > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail="File troppo grande (max 10 MB).",
                    )
                tmp.write(chunk)

        context = MemberValidationContext(
            first_name=first_name,
            last_name=last_name,
            codice_fiscale=codice_fiscale,
            document_number=document_number,
            medical_certificate_expiry=_parse_optional_date(
                medical_certificate_expiry
            ),
            sport_type=sport_type,
        )
        result = validate_upload_file(
            tmp_path,
            category,
            context,
            file_size=total_size,
        )
        return JSONResponse(result)
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        await file.close()


@app.get("/api/documenti/{document_id}/stato")
def document_validation_status(
    document_id: int,
    request: Request,
    session: Session = Depends(get_session),
) -> JSONResponse:
    document = session.get(MemberDocument, document_id)
    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Documento non trovato.",
        )
    member = _member_from_session(request, session)
    if not member or member.id != document.member_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Non autorizzato.",
        )
    return JSONResponse(document_status_payload(document))


@app.get("/area-tesserati", response_class=HTMLResponse)
def member_area(request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    member = _member_from_session(request, session)
    membership_fee = (
        membership_fee_for_sport(member.sport_type) if member else None
    )
    password_hint = request.session.pop("member_password_hint", None)
    upload_notice = request.session.pop("member_notice", None)
    profile_notice = request.session.pop("member_profile_notice", None)
    reset_notice = request.session.pop("member_reset_notice", None)
    pending_doc_ids = request.session.pop("pending_doc_ids", None) or []
    password_reset_enabled = bool(settings.smtp_host and settings.smtp_from)
    documents: list[MemberDocument] = list(member.documents) if member else []
    return templates.TemplateResponse(
        "member_area.html",
        {
            "request": request,
            "member": member,
            "documents": documents,
            "settings": settings,
            "membership_fee": membership_fee,
            "membership_fee_range": MEMBERSHIP_FEE_RANGE_LABEL,
            "password_hint": password_hint,
            "upload_notice": upload_notice,
            "profile_notice": profile_notice,
            "reset_notice": reset_notice,
            "pending_doc_ids": pending_doc_ids,
            "password_reset_enabled": password_reset_enabled,
        },
    )


@app.post("/area-tesserati/documenti")
def member_upload_documents(
    request: Request,
    background_tasks: BackgroundTasks,
    identity_documents: list[UploadFile] | None = File(None),
    health_documents: list[UploadFile] | None = File(None),
    medical_documents: list[UploadFile] | None = File(None),
    request_manual_review: str | None = Form(None),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    if not member:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Devi effettuare il login.",
        )
    if member.payment_status != "paid":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Pagamento obbligatorio.",
        )
    saved_docs = _save_categorized_documents(
        member.id,
        {
            DOCUMENT_CATEGORY_IDENTITY: identity_documents,
            DOCUMENT_CATEGORY_HEALTH: health_documents,
            DOCUMENT_CATEGORY_MEDICAL: medical_documents,
        },
    )
    saved_doc_ids: list[int] = []
    if saved_docs:
        session.add_all(saved_docs)
        session.flush()
        saved_doc_ids = [doc.id for doc in saved_docs]
        session.commit()
        schedule_documents_ocr(saved_doc_ids, member.id, background_tasks)
        request.session["pending_doc_ids"] = saved_doc_ids
        manual_review = _normalize(request_manual_review) == "1"
        if manual_review:
            send_documents_manual_review_email(member, saved_docs)
            notice = (
                f"Caricati {len(saved_docs)} documenti. "
                "Inviati per verifica manuale: la pratica non sara automatica "
                "e i tempi saranno piu lunghi."
            )
        else:
            notice = f"Caricati {len(saved_docs)} documenti."
    else:
        notice = "Nessun documento caricato."
    request.session["member_notice"] = notice
    return RedirectResponse(url="/area-tesserati", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/area-tesserati/profilo")
def member_update_profile(
    request: Request,
    first_name: str = Form(...),
    last_name: str = Form(...),
    email: str = Form(...),
    phone: str = Form(...),
    birth_date: date = Form(...),
    birth_place: str = Form(...),
    residence: str = Form(...),
    codice_fiscale: str = Form(...),
    document_type: str = Form(...),
    document_number: str = Form(...),
    document_id: str | None = Form(None),
    medical_certificate_expiry: date = Form(...),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    member = _member_from_session(request, session)
    if not member:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Devi effettuare il login.",
        )
    if member.payment_status != "paid":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Pagamento obbligatorio.",
        )
    member.first_name = first_name.strip()
    member.last_name = last_name.strip()
    member.name = f"{member.first_name} {member.last_name}".strip()
    member.email = email.strip()
    member.phone = _normalize(phone)
    member.birth_date = birth_date
    member.birth_place = _normalize(birth_place)
    member.residence = _normalize(residence)
    member.codice_fiscale = _normalize(codice_fiscale)
    member.document_type = _normalize(document_type)
    member.document_number = _normalize(document_number)
    member.document_id = _normalize(document_id)
    member.medical_certificate_expiry = medical_certificate_expiry
    session.commit()
    request.session["member_profile_notice"] = "Dati aggiornati."
    return RedirectResponse(url="/area-tesserati", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/area-tesserati/login", response_model=None)
def member_login(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    session: Session = Depends(get_session),
) -> Response:
    member = (
        session.query(Member)
        .filter(Member.email == email.strip())
        .order_by(Member.id.desc())
        .first()
    )
    if not member or not _verify_password(password.strip(), member.password_hash):
        return templates.TemplateResponse(
            "member_area.html",
            {
                "request": request,
                "member": None,
                "login_error": "Credenziali non valide o password errata.",
                "settings": settings,
                "membership_fee": settings.membership_fee_eur,
                "membership_fee_range": MEMBERSHIP_FEE_RANGE_LABEL,
                "password_reset_enabled": bool(
                    settings.smtp_host and settings.smtp_from
                ),
            },
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    request.session["member_id"] = member.id
    return RedirectResponse(url="/area-tesserati", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/area-tesserati/logout")
def member_logout(request: Request) -> RedirectResponse:
    request.session.pop("member_id", None)
    request.session.pop("member_password_hint", None)
    return RedirectResponse(url="/area-tesserati", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/area-tesserati/password-reset/request")
def password_reset_request(
    request: Request,
    email: str = Form(...),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    if not settings.smtp_host or not settings.smtp_from:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Reset password non disponibile.",
        )
    member = (
        session.query(Member)
        .filter(Member.email == email.strip())
        .order_by(Member.id.desc())
        .first()
    )
    if member and member.payment_status == "paid":
        token = secrets.token_urlsafe(24)
        member.password_reset_token_hash = _hash_reset_token(token)
        member.password_reset_expires_at = datetime.utcnow() + timedelta(hours=2)
        session.commit()
        reset_url = str(request.url_for("password_reset_form"))
        reset_link = f"{reset_url}?token={token}"
        _send_password_reset_email(member.email, reset_link)
    request.session["member_reset_notice"] = (
        "Se l'email esiste, riceverai un link per reimpostare la password."
    )
    return RedirectResponse(url="/area-tesserati", status_code=status.HTTP_303_SEE_OTHER)


@app.get("/area-tesserati/password-reset", response_class=HTMLResponse)
def password_reset_form(
    request: Request,
    token: str | None = None,
    session: Session = Depends(get_session),
) -> HTMLResponse:
    reset_error = None
    member = None
    if not token:
        reset_error = "Link di reset non valido."
    else:
        token_hash = _hash_reset_token(token)
        member = (
            session.query(Member)
            .filter(Member.password_reset_token_hash == token_hash)
            .first()
        )
        if not member:
            reset_error = "Link di reset non valido."
        elif member.payment_status != "paid":
            reset_error = "Reset disponibile solo dopo il pagamento."
            member = None
        elif (
            member.password_reset_expires_at
            and member.password_reset_expires_at < datetime.utcnow()
        ):
            reset_error = "Link di reset scaduto."
            member = None
    return templates.TemplateResponse(
        "password_reset.html",
        {
            "request": request,
            "settings": settings,
            "token": token,
            "reset_error": reset_error,
            "token_valid": member is not None,
        },
    )


@app.post("/area-tesserati/password-reset")
def password_reset_confirm(
    request: Request,
    token: str = Form(...),
    password: str = Form(...),
    password_confirm: str = Form(...),
    session: Session = Depends(get_session),
) -> HTMLResponse:
    reset_error = None
    if not password.strip():
        reset_error = "Inserisci una password valida."
    elif password.strip() != password_confirm.strip():
        reset_error = "Le password non coincidono."

    member = None
    if not reset_error:
        token_hash = _hash_reset_token(token)
        member = (
            session.query(Member)
            .filter(Member.password_reset_token_hash == token_hash)
            .first()
        )
        if not member:
            reset_error = "Link di reset non valido."
        elif member.payment_status != "paid":
            reset_error = "Reset disponibile solo dopo il pagamento."
            member = None
        elif (
            member.password_reset_expires_at
            and member.password_reset_expires_at < datetime.utcnow()
        ):
            reset_error = "Link di reset scaduto."
            member = None

    if reset_error or not member:
        return templates.TemplateResponse(
            "password_reset.html",
            {
                "request": request,
                "settings": settings,
                "token": token,
                "reset_error": reset_error,
                "token_valid": False,
            },
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    new_password = password.strip()
    member.password_hash = _hash_password(new_password)
    member.access_code = new_password
    member.password_reset_token_hash = None
    member.password_reset_expires_at = None
    session.commit()
    request.session["member_reset_notice"] = (
        "Password aggiornata. Ora puoi effettuare il login."
    )
    return RedirectResponse(url="/area-tesserati", status_code=status.HTTP_303_SEE_OTHER)


@app.get("/tesseramento/documenti/{document_id}")
def download_document(
    document_id: int, request: Request, session: Session = Depends(get_session)
) -> FileResponse:
    document = session.get(MemberDocument, document_id)
    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Documento non trovato"
        )
    member = _member_from_session(request, session)
    if not member or member.id != document.member_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Non sei autorizzato a questo file"
        )
    if member.payment_status != "paid":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Pagamento obbligatorio"
        )
    path = UPLOADS_DIR / document.stored_filename
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File mancante")
    return FileResponse(
        path,
        media_type=document.content_type or "application/octet-stream",
        filename=document.original_name,
    )


_EVENT_FILE_TYPES = {"medical", "acsi_fci", "waiver"}


@app.get("/dl/event-file/{registration_id}/{file_type}")
def admin_event_file_download(
    registration_id: int,
    file_type: str,
    request: Request,
    session: Session = Depends(get_session),
) -> FileResponse:
    if not request.session.get("admin_authenticated"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Non autorizzato")
    if file_type not in _EVENT_FILE_TYPES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Tipo file non valido")
    reg = session.get(EventRegistration, registration_id)
    if not reg:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Iscrizione non trovata")
    if file_type == "medical":
        stored, original, content_type = reg.medical_stored_filename, reg.medical_original_name, reg.medical_content_type
    elif file_type == "acsi_fci":
        stored, original, content_type = reg.acsi_fci_stored_filename, reg.acsi_fci_original_name, reg.acsi_fci_content_type
    else:
        stored, original, content_type = reg.waiver_stored_filename, reg.waiver_original_name, reg.waiver_content_type
    if not stored:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File non presente per questa iscrizione")
    path = UPLOADS_DIR / stored
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File mancante sul disco")
    return FileResponse(path, media_type=content_type or "application/octet-stream", filename=original or stored)


def reqid() -> str:
    from uuid import uuid4

    return uuid4().hex[:12]
