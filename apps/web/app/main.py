from __future__ import annotations

import logging
import shutil
import hashlib
import secrets
from datetime import date, datetime
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

from .config import settings
from .database import Base, SessionLocal, engine, get_session
from .models import Event, Member, MerchItem, MemberDocument
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
    session = SessionLocal()
    try:
        seed_sample_data(session)
    finally:
        session.close()


def format_price(cents: int) -> str:
    return f"{cents / 100:.2f}"


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


def _hash_password(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _generate_member_password() -> tuple[str, str]:
    password = secrets.token_urlsafe(6)
    return password, _hash_password(password)


def _verify_password(raw: str, hashed: str | None) -> bool:
    return bool(hashed) and _hash_password(raw) == hashed


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

        if success and pending.get("kind") == "membership":
            member_id = pending.get("member_id")
            if isinstance(member_id, str) and member_id.isdigit():
                member_id = int(member_id)
            if isinstance(member_id, int):
                member = session.get(Member, member_id)
                if member:
                    member.payment_status = "paid"
                    reference = pending.get("reference")
                    if isinstance(reference, str) and reference:
                        member.payment_reference = reference
                    session.commit()

    return {
        "return_url": return_url,
        "retry_url": retry_url,
        "label": label,
    }


@app.get("/", response_class=HTMLResponse)
def home(request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    events = (
        session.query(Event)
        .order_by(Event.date.asc().nulls_last())
        .limit(6)
        .all()
    )
    merch_preview = session.query(MerchItem).order_by(MerchItem.id).limit(3).all()
    return templates.TemplateResponse(
        "home.html",
        {
            "request": request,
            "events": events,
            "merch_preview": merch_preview,
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
    payment_reference = f"merch-{item.slug}-{reqid()}"
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
    payment = _require_nexi_client().prepare_payment(
        amount_cents=total_cents,
        order_id=payment_reference,
        description=f"{item.name} × {quantity}",
        email=None,
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


@app.get("/galleria", response_class=HTMLResponse)
def gallery(request: Request) -> HTMLResponse:
    drive_albums: list[dict[str, object]] = []
    if settings.google_drive_api_key:
        for collection in DRIVE_COLLECTIONS:
            folder_id = collection.get("folder_id")
            if not folder_id:
                continue
            images = fetch_drive_images(folder_id, settings.google_drive_api_key)
            drive_albums.append(
                {
                    "title": collection.get("title"),
                    "description": collection.get("description"),
                    "folder_id": folder_id,
                    "folder_url": f"https://drive.google.com/drive/folders/{folder_id}",
                    "images": images,
                }
            )
    return templates.TemplateResponse(
        "gallery.html",
        {
            "request": request,
            "images": GALLERY_IMAGES,
            "drive_albums": drive_albums,
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
def membership_form(
    request: Request, success: bool | None = False
) -> HTMLResponse:
    return templates.TemplateResponse(
        "membership.html",
        {
            "request": request,
            "success": success,
            "membership_fee": settings.membership_fee_eur,
            "membership_types": MEMBERSHIP_TYPES,
            "settings": settings,
            "uploads_path": settings.uploads_path,
        },
    )


@app.post("/tesseramento")
def membership_submit(
    request: Request,
    first_name: str = Form(...),
    last_name: str = Form(...),
    email: str = Form(...),
    birth_date: date = Form(...),
    birth_place: str = Form(...),
    residence: str = Form(...),
    codice_fiscale: str = Form(...),
    document_type: str = Form(...),
    document_number: str = Form(...),
    document_id: str | None = Form(None),
    tessera_sanitaria: str = Form(...),
    medical_certificate: str = Form(...),
    medical_certificate_expiry: date = Form(...),
    membership_type: str = Form(...),
    message: str | None = Form(None),
    documents: list[UploadFile] = File(...),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    for field_value in [
        document_type,
        document_number,
        tessera_sanitaria,
        medical_certificate,
    ]:
        if not _normalize(field_value):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Documento obbligatorio mancante (CI, tessera sanitaria o certificato medico).",
            )

    password_plain, password_hash = _generate_member_password()
    member = Member(
        name=f"{first_name.strip()} {last_name.strip()}",
        first_name=first_name.strip(),
        last_name=last_name.strip(),
        email=email.strip(),
        birth_date=birth_date,
        birth_place=_normalize(birth_place),
        residence=_normalize(residence),
        codice_fiscale=_normalize(codice_fiscale),
        document_type=_normalize(document_type),
        document_number=_normalize(document_number),
        document_id=_normalize(document_id),
        tessera_sanitaria=_normalize(tessera_sanitaria),
        medical_certificate=_normalize(medical_certificate),
        medical_certificate_expiry=medical_certificate_expiry,
        membership_type=membership_type,
        message=_normalize(message),
        access_code=password_plain,
        password_hash=password_hash,
    )
    session.add(member)
    session.flush()
    saved_docs = _save_uploaded_documents(member.id, documents)
    if saved_docs:
        session.add_all(saved_docs)
    session.commit()
    request.session["member_id"] = member.id
    request.session["member_password_hint"] = password_plain
    return RedirectResponse(
        url=f"/tesseramento/pagamento/{member.id}", status_code=status.HTTP_303_SEE_OTHER
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
    payment_reference = f"member-{member.id}-{reqid()}"
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
    payment_context: NexiPaymentContext = _require_nexi_client().prepare_payment(
        amount_cents=settings.membership_fee_eur * 100,
        order_id=payment_reference,
        description=f"Tesseramento {(member.name or '').strip() or f'{member.first_name} {member.last_name}'}",
        email=member.email,
    )
    is_owner = request.session.get("member_id") == member.id
    documents = list(member.documents) if is_owner else []
    password_hint = (request.session.get("member_password_hint") or member.access_code) if is_owner else None
    return templates.TemplateResponse(
        "membership_payment.html",
        {
            "request": request,
            "member": member,
            "payment": payment_context,
            "documents": documents,
            "settings": settings,
            "membership_fee": settings.membership_fee_eur,
            "password_hint": password_hint,
            "is_owner": is_owner,
        },
    )


@app.api_route("/nexi/success", methods=["GET", "POST"], response_class=HTMLResponse)
def nexi_success(
    request: Request, session: Session = Depends(get_session)
) -> HTMLResponse:
    pending = _pop_pending_payment(request)
    context = _build_payment_result_context(pending, session, success=True)
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
    documents: list[MemberDocument] = list(member.documents) if member else []
    return templates.TemplateResponse(
        "member_area.html",
        {
            "request": request,
            "member": member,
            "documents": documents,
            "settings": settings,
            "membership_fee": settings.membership_fee_eur,
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
