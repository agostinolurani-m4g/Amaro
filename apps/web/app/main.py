from __future__ import annotations

import calendar
import logging
import shutil
import hashlib
import secrets
import smtplib
from datetime import date, datetime
from email.message import EmailMessage
from pathlib import Path
from typing import Sequence
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import requests
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session
from starlette.middleware.sessions import SessionMiddleware

from .admin import setup_admin
from .config import settings
from .database import Base, SessionLocal, engine, get_session
from .models import Event, Member, MerchItem, MemberDocument, MembershipPayment
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


def _require_nexi_client() -> NexiXpayClient:
    if not nexi_client:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Nexi/XPay non configurato",
        )
    return nexi_client


def _save_uploaded_documents(
    member_id: int, uploads: Sequence[UploadFile] | None
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
                original_name=Path(upload.filename).name,
                stored_filename=stored_filename,
                content_type=upload.content_type,
            )
        )
    return saved


def _normalize(value: str | None) -> str | None:
    return value.strip() if value else None


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
    }
    with engine.begin() as conn:
        for column, ddl in required_columns.items():
            if column not in columns:
                conn.execute(text(f"ALTER TABLE members ADD COLUMN {column} {ddl}"))


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


def _generate_member_password() -> tuple[str, str]:
    password = secrets.token_urlsafe(6)
    return password, _hash_password(password)


def _verify_password(raw: str, hashed: str | None) -> bool:
    return bool(hashed) and _hash_password(raw) == hashed


def _require_admin(request: Request) -> None:
    if not settings.admin_username or not settings.admin_password:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Admin non configurato"
        )
    if not request.session.get("admin_authenticated"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Accesso admin richiesto"
        )


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
                }
            )
    return months


def _build_featured_events(
    session: Session, limit: int = 3
) -> list[dict[str, str]]:
    today = date.today()
    upcoming = (
        session.query(Event)
        .filter(Event.date >= today)
        .order_by(Event.date.asc())
        .limit(limit)
        .all()
    )
    events = upcoming
    if len(events) < limit:
        events = (
            session.query(Event)
            .order_by(Event.date.asc())
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
    return templates.TemplateResponse(
        "event_detail.html",
        {"request": request, "event": event, "settings": settings},
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
    documents: list[UploadFile] = File(...),
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
        access_code=password_plain,
        password_hash=password_hash,
        payment_status="paid",
        payment_reference=payment.reference,
    )
    session.add(member)
    session.flush()
    saved_docs = _save_uploaded_documents(member.id, documents)
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
        },
    )


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


@app.get("/admin-tools", response_class=HTMLResponse)
def admin_tools(request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    _require_admin(request)
    members = (
        session.query(Member)
        .order_by(Member.last_name.asc(), Member.first_name.asc(), Member.id.asc())
        .all()
    )
    notice = request.session.pop("admin_notice", None)
    password_reset = request.session.pop("admin_password_reset", None)
    if not isinstance(password_reset, dict):
        password_reset = None
    return templates.TemplateResponse(
        "admin_tools.html",
        {
            "request": request,
            "members": members,
            "notice": notice,
            "password_reset": password_reset,
            "settings": settings,
        },
    )


@app.post("/admin-tools/documents")
def admin_upload_documents(
    request: Request,
    member_id: int = Form(...),
    documents: list[UploadFile] = File(...),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    _require_admin(request)
    member = session.get(Member, member_id)
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Socio non trovato"
        )
    saved_docs = _save_uploaded_documents(member.id, documents)
    if saved_docs:
        session.add_all(saved_docs)
        session.commit()
        request.session["admin_notice"] = (
            f"Caricati {len(saved_docs)} documenti per {member.first_name} {member.last_name}."
        )
    else:
        request.session["admin_notice"] = "Nessun file caricato."
    return RedirectResponse(url="/admin-tools", status_code=status.HTTP_303_SEE_OTHER)


@app.post("/admin-tools/password")
def admin_reset_member_password(
    request: Request,
    member_id: int = Form(...),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    _require_admin(request)
    member = session.get(Member, member_id)
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Socio non trovato"
        )
    password_plain, password_hash = _generate_member_password()
    member.access_code = password_plain
    member.password_hash = password_hash
    session.commit()
    member_name = f"{member.first_name} {member.last_name}".strip() or member.name
    request.session["admin_password_reset"] = {
        "member_name": member_name or f"Socio #{member.id}",
        "password": password_plain,
    }
    return RedirectResponse(url="/admin-tools", status_code=status.HTTP_303_SEE_OTHER)


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
