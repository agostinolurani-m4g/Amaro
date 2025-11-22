from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
import logging
import shutil
from typing import Sequence
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from .config import settings
from .database import Base, SessionLocal, engine, get_session
from .models import Event, Member, MerchItem, MemberDocument
from .nexi import NexiPaymentContext, NexiXpayClient
from .seed import seed_sample_data

GALLERY_IMAGES: list[dict[str, str]] = [
    {
        "url": "https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=800&q=60",
        "caption": "Laboratori artigianali e musicisti in residenza",
    },
    {
        "url": "https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=800&q=60",
        "caption": "Volontari al lavoro per installare gli allestimenti",
    },
    {
        "url": "https://images.unsplash.com/photo-1489515217757-5fd1be406fef?auto=format&fit=crop&w=800&q=60",
        "caption": "Momenti di festa condivisa con la comunita",
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
    return templates.TemplateResponse(
        "gallery.html",
        {"request": request, "images": GALLERY_IMAGES, "settings": settings},
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
    first_name: str = Form(...),
    last_name: str = Form(...),
    email: str = Form(...),
    birth_date: date | None = Form(None),
    birth_place: str | None = Form(None),
    residence: str | None = Form(None),
    codice_fiscale: str | None = Form(None),
    document_type: str | None = Form(None),
    document_number: str | None = Form(None),
    document_id: str | None = Form(None),
    tessera_sanitaria: str | None = Form(None),
    medical_certificate: str | None = Form(None),
    medical_certificate_expiry: date | None = Form(None),
    membership_type: str = Form(...),
    message: str | None = Form(None),
    documents: list[UploadFile] | None = File(None),
    session: Session = Depends(get_session),
) -> RedirectResponse:
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
    )
    session.add(member)
    session.flush()
    saved_docs = _save_uploaded_documents(member.id, documents)
    if saved_docs:
        session.add_all(saved_docs)
    session.commit()
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
    payment_context: NexiPaymentContext = _require_nexi_client().prepare_payment(
        amount_cents=settings.membership_fee_eur * 100,
        order_id=f"member-{member.id}-{reqid()}",
        description=f"Tesseramento {member.first_name} {member.last_name}",
        email=member.email,
    )
    documents = list(member.documents)
    return templates.TemplateResponse(
        "membership_payment.html",
        {
            "request": request,
            "member": member,
            "payment": payment_context,
            "documents": documents,
            "settings": settings,
            "membership_fee": settings.membership_fee_eur,
        },
    )


@app.get("/tesseramento/documenti/{document_id}")
def download_document(
    document_id: int, session: Session = Depends(get_session)
) -> FileResponse:
    document = session.get(MemberDocument, document_id)
    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Documento non trovato"
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
