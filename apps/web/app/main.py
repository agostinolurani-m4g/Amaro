from __future__ import annotations

import calendar
import logging
import re
import shutil
import hashlib
import secrets
import smtplib
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import Sequence
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from markupsafe import Markup, escape
import requests
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session
from starlette.middleware.sessions import SessionMiddleware

from .admin import setup_admin
from .config import settings
from .database import Base, SessionLocal, engine, get_session
from .models import (
    DOCUMENT_CATEGORY_HEALTH,
    DOCUMENT_CATEGORY_IDENTITY,
    DOCUMENT_CATEGORY_MEDICAL,
    Event,
    EventRegistration,
    Member,
    MemberDocument,
    MembershipPayment,
    MerchItem,
    MEMBERSHIP_STATUS_PENDING,
)
from .nexi import NexiPaymentContext, NexiXpayClient
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


def _membership_form_link(request: Request, ref: str) -> str:
    base_url = str(request.url_for("membership_form"))
    return f"{base_url}?ref={ref}"


def _send_membership_completion_email(email: str, link: str) -> bool:
    if not settings.smtp_host or not settings.smtp_from:
        logger.warning("SMTP not configured; skipping membership email.")
        return False
    message = EmailMessage()
    message["Subject"] = f"{settings.app_name} - Completa tesseramento"
    message["From"] = settings.smtp_from
    message["To"] = email
    message.set_content(
        "Ciao,\n\nAbbiamo ricevuto il pagamento. Per completare il tesseramento apri questo link:\n"
        f"{link}\n\nSe non hai richiesto tu, ignora questa email.\n"
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
        logger.exception("Failed to send membership completion email")
        return False
    finally:
        if server:
            try:
                server.quit()
            except Exception:
                pass


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
        return {}

    if success:
        member.payment_status = "paid"
    elif member.payment_status != "paid":
        member.payment_status = "failed"
    session.commit()
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


@app.get("/eventi/{slug}", response_class=HTMLResponse)
def read_event(
    request: Request, slug: str, session: Session = Depends(get_session)
) -> HTMLResponse:
    event = session.query(Event).filter_by(slug=slug).first()
    if not event:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evento non trovato")
    event_gallery = _parse_gallery_urls(event.gallery_urls)
    registration_notice = None
    if request.query_params.get("registered") == "1":
        registration_notice = "Iscrizione ricevuta. Ti contatteremo via email."
    return templates.TemplateResponse(
        "event_detail.html",
        {
            "request": request,
            "event": event,
            "event_gallery": event_gallery,
            "registration_notice": registration_notice,
            "registration_errors": [],
            "form_values": {
                "first_name": "",
                "last_name": "",
                "email": "",
                "phone": "",
                "residence": "",
                "intolerances": "",
                "privacy_photo": False,
                "privacy_other": False,
            },
            "settings": settings,
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
    privacy_photo: str | None = Form(None),
    privacy_other: str | None = Form(None),
    acsi_fci_document: UploadFile | None = File(None),
    medical_certificate: UploadFile | None = File(None),
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

    normalized = {
        "first_name": _normalize(first_name) or "",
        "last_name": _normalize(last_name) or "",
        "email": _normalize(email) or "",
        "phone": _normalize(phone) or "",
        "residence": _normalize(residence) or "",
        "intolerances": _normalize(intolerances) or "",
        "privacy_photo": bool(privacy_photo),
        "privacy_other": bool(privacy_other),
    }
    errors: list[str] = []

    def require(flag: bool, value: str, label: str) -> None:
        if flag and not value:
            errors.append(f"{label} obbligatorio.")

    require(event.require_first_name, normalized["first_name"], "Nome")
    require(event.require_last_name, normalized["last_name"], "Cognome")
    require(event.require_email, normalized["email"], "Email")
    require(event.require_phone, normalized["phone"], "Cellulare")
    require(event.require_residence, normalized["residence"], "Residenza")
    require(event.require_intolerances, normalized["intolerances"], "Intolleranze/Allergie")

    if event.require_privacy_photo and not normalized["privacy_photo"]:
        errors.append("Consenso privacy foto obbligatorio.")
    if event.require_privacy_other and not normalized["privacy_other"]:
        errors.append("Consenso privacy obbligatorio.")

    acsi_fci_upload = acsi_fci_document if acsi_fci_document and acsi_fci_document.filename else None
    medical_upload = medical_certificate if medical_certificate and medical_certificate.filename else None
    if event.require_acsi_fci and not acsi_fci_upload:
        errors.append("Tessera ACSI/FCI obbligatoria.")
    if event.require_medical_certificate and not medical_upload:
        errors.append("Certificato medico obbligatorio.")

    if errors:
        event_gallery = _parse_gallery_urls(event.gallery_urls)
        return templates.TemplateResponse(
            "event_detail.html",
            {
                "request": request,
                "event": event,
                "event_gallery": event_gallery,
                "registration_notice": None,
                "registration_errors": errors,
                "form_values": normalized,
                "settings": settings,
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
    )
    session.add(registration)
    session.flush()

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

    session.commit()
    return RedirectResponse(
        url=f"/eventi/{slug}?registered=1",
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
    if saved_docs:
        session.add_all(saved_docs)
    payment.member_id = member.id
    payment.status = "completed"
    session.commit()
    request.session["member_id"] = member.id
    request.session["member_password_hint"] = password_plain
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
            "password_reset_enabled": password_reset_enabled,
        },
    )


@app.post("/area-tesserati/documenti")
def member_upload_documents(
    request: Request,
    identity_documents: list[UploadFile] | None = File(None),
    health_documents: list[UploadFile] | None = File(None),
    medical_documents: list[UploadFile] | None = File(None),
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
    saved_docs = _save_categorized_documents(
        member.id,
        {
            DOCUMENT_CATEGORY_IDENTITY: identity_documents,
            DOCUMENT_CATEGORY_HEALTH: health_documents,
            DOCUMENT_CATEGORY_MEDICAL: medical_documents,
        },
    )
    if saved_docs:
        session.add_all(saved_docs)
        session.commit()
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


def reqid() -> str:
    from uuid import uuid4

    return uuid4().hex[:12]
