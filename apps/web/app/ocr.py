from __future__ import annotations

import base64
import logging
import re
import threading
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

import requests

from .config import settings
from .database import SessionLocal
from .models import (
    DOCUMENT_CATEGORY_HEALTH,
    DOCUMENT_CATEGORY_IDENTITY,
    DOCUMENT_CATEGORY_MEDICAL,
    Member,
    MemberDocument,
)

if TYPE_CHECKING:
    from fastapi import BackgroundTasks

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = (BASE_DIR / settings.uploads_path).resolve()
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
VISION_API_URL = "https://vision.googleapis.com/v1/images:annotate"

CODICE_FISCALE_RE = re.compile(r"\b([A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z])\b", re.I)
DATE_RE = re.compile(
    r"\b(\d{1,2})[./\-](\d{1,2})[./\-](\d{2,4})\b"
)
DOCUMENT_NUMBER_RE = re.compile(r"\b([A-Z]{2}\d{5,7}[A-Z0-9]?)\b", re.I)
SUPPORTED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"}
SUPPORTED_PDF_SUFFIXES = {".pdf"}
UNSUPPORTED_SUFFIXES = {".doc", ".docx"}


@dataclass
class MemberValidationContext:
    codice_fiscale: str | None = None
    document_number: str | None = None
    medical_certificate_expiry: date | None = None

    @classmethod
    def from_member(cls, member: Member) -> MemberValidationContext:
        return cls(
            codice_fiscale=member.codice_fiscale,
            document_number=member.document_number,
            medical_certificate_expiry=member.medical_certificate_expiry,
        )


def validation_label(valid: bool | None) -> str:
    if valid is True:
        return "Valido"
    if valid is False:
        return "Non valido"
    return "Non verificabile"


def validation_badge_class(valid: bool | None) -> str:
    if valid is True:
        return "ok"
    if valid is False:
        return "bad"
    return "warn"


def schedule_documents_ocr(
    document_ids: list[int],
    member_id: int,
    background_tasks: BackgroundTasks | None = None,
) -> None:
    for document_id in document_ids:
        if background_tasks is not None:
            background_tasks.add_task(ocr_document, document_id, member_id)
        else:
            threading.Thread(
                target=ocr_document,
                args=(document_id, member_id),
                daemon=True,
            ).start()


def validate_upload_file(
    path: Path,
    category: str,
    context: MemberValidationContext,
    *,
    file_size: int | None = None,
) -> dict[str, Any]:
    size = file_size if file_size is not None else path.stat().st_size
    if size > MAX_UPLOAD_BYTES:
        return {
            "status": "failed",
            "valid": None,
            "label": validation_label(None),
            "notes": "File troppo grande (max 10 MB).",
            "text": "",
        }

    suffix = path.suffix.lower()
    if suffix in UNSUPPORTED_SUFFIXES:
        return {
            "status": "failed",
            "valid": None,
            "label": validation_label(None),
            "notes": "Formato Word non supportato per OCR. Carica PDF o immagine.",
            "text": "",
        }

    if not settings.google_vision_api_key:
        return {
            "status": "failed",
            "valid": None,
            "label": validation_label(None),
            "notes": "OCR non configurato: imposta GOOGLE_VISION_API_KEY.",
            "text": "",
        }

    try:
        text = _extract_text(path)
    except Exception as exc:
        logger.exception("OCR validation failed for %s", path.name)
        return {
            "status": "failed",
            "valid": None,
            "label": validation_label(None),
            "notes": f"OCR non disponibile: {exc}",
            "text": "",
        }

    extracted = _extract_fields(category, text)
    is_valid, notes = _validate(category, extracted, context)
    return {
        "status": "done",
        "valid": is_valid,
        "label": validation_label(is_valid),
        "notes": notes,
        "text": text[:8000] if text else "",
    }


def ocr_document(document_id: int, member_id: int) -> None:
    session = SessionLocal()
    try:
        document = session.get(MemberDocument, document_id)
        member = session.get(Member, member_id)
        if not document or not member:
            return
        if document.member_id != member.id:
            return

        path = UPLOADS_DIR / document.stored_filename
        if not path.exists():
            document.ocr_status = "failed"
            document.ocr_valid = None
            document.ocr_notes = "File non trovato su disco."
            session.commit()
            return

        context = MemberValidationContext.from_member(member)
        result = validate_upload_file(
            path,
            document.document_category or "",
            context,
        )
        document.ocr_status = result["status"]
        document.ocr_valid = result["valid"]
        document.ocr_notes = result["notes"]
        document.ocr_text = result.get("text") or ""
        session.commit()
    finally:
        session.close()


def document_status_payload(document: MemberDocument) -> dict[str, Any]:
    valid = document.ocr_valid
    return {
        "ocr_status": document.ocr_status,
        "valid": valid,
        "label": validation_label(valid) if document.ocr_status == "done" else None,
        "notes": document.ocr_notes,
        "badge_class": validation_badge_class(valid)
        if document.ocr_status == "done"
        else "pending",
    }


def _extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    image_chunks = _file_to_image_bytes(path, suffix)
    texts: list[str] = []
    for image_bytes in image_chunks:
        text = _vision_ocr_image_bytes(image_bytes)
        if text:
            texts.append(text)
    return "\n".join(texts).strip()


def _file_to_image_bytes(path: Path, suffix: str) -> list[bytes]:
    if suffix in SUPPORTED_PDF_SUFFIXES:
        return _pdf_pages_to_png_bytes(path)
    if suffix in SUPPORTED_IMAGE_SUFFIXES:
        return [path.read_bytes()]
    raise ValueError(f"Formato file non supportato: {suffix or 'sconosciuto'}")


def _pdf_pages_to_png_bytes(path: Path, max_pages: int = 2) -> list[bytes]:
    import fitz

    doc = fitz.open(path)
    try:
        pages: list[bytes] = []
        for page_index in range(min(max_pages, doc.page_count)):
            page = doc.load_page(page_index)
            pixmap = page.get_pixmap(dpi=150)
            pages.append(pixmap.tobytes("png"))
        return pages
    finally:
        doc.close()


def _vision_ocr_image_bytes(image_bytes: bytes) -> str:
    api_key = settings.google_vision_api_key
    if not api_key:
        raise ValueError("GOOGLE_VISION_API_KEY non configurata.")

    payload = {
        "requests": [
            {
                "image": {
                    "content": base64.b64encode(image_bytes).decode("ascii"),
                },
                "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
                "imageContext": {"languageHints": ["it"]},
            }
        ]
    }
    response = requests.post(
        VISION_API_URL,
        params={"key": api_key},
        json=payload,
        timeout=60,
    )
    response.raise_for_status()
    data = response.json()
    annotation = (data.get("responses") or [{}])[0]
    if annotation.get("error"):
        message = annotation["error"].get("message", "Errore Vision API")
        raise ValueError(message)
    full_text = (annotation.get("fullTextAnnotation") or {}).get("text", "")
    if full_text:
        return full_text.strip()
    texts = annotation.get("textAnnotations") or []
    if texts:
        return (texts[0].get("description") or "").strip()
    return ""


def _extract_fields(category: str, text: str) -> dict[str, Any]:
    normalized = _normalize_text(text)
    if category == DOCUMENT_CATEGORY_IDENTITY:
        return _extract_identity(normalized)
    if category == DOCUMENT_CATEGORY_HEALTH:
        return _extract_health_card(normalized)
    if category == DOCUMENT_CATEGORY_MEDICAL:
        return _extract_medical_cert(normalized)
    return {}


def _extract_identity(text: str) -> dict[str, Any]:
    document_numbers = [match.upper() for match in DOCUMENT_NUMBER_RE.findall(text)]
    expiry_dates = _extract_dates_near_keywords(
        text,
        ("scadenza", "scade", "valid", "expiry", "expiration"),
    )
    return {
        "document_numbers": document_numbers,
        "expiry_dates": expiry_dates,
    }


def _extract_health_card(text: str) -> dict[str, Any]:
    codici = [match.upper() for match in CODICE_FISCALE_RE.findall(text)]
    return {"codici_fiscali": codici}


def _extract_medical_cert(text: str) -> dict[str, Any]:
    expiry_dates = _extract_dates_near_keywords(
        text,
        (
            "scadenza",
            "scade",
            "valid",
            "validita",
            "validità",
            "fino al",
            "al ",
        ),
    )
    if not expiry_dates:
        expiry_dates = _parse_dates(text)
    return {"expiry_dates": expiry_dates}


def _validate(
    category: str,
    extracted: dict[str, Any],
    context: MemberValidationContext,
) -> tuple[bool | None, str]:
    today = date.today()
    notes: list[str] = []

    if category == DOCUMENT_CATEGORY_IDENTITY:
        numbers = extracted.get("document_numbers", [])
        expiry_dates = extracted.get("expiry_dates", [])
        if numbers:
            notes.append(f"Numero rilevato: {numbers[0]}")
        if context.document_number:
            member_number = context.document_number.replace(" ", "").upper()
            if numbers and member_number not in numbers:
                notes.append(
                    f"Numero modulo ({context.document_number}) diverso da OCR."
                )
        if expiry_dates:
            latest = max(expiry_dates)
            notes.append(f"Scadenza rilevata: {latest.isoformat()}")
            if latest < today:
                notes.append("Documento scaduto.")
                return False, "\n".join(notes)
            return True, "\n".join(notes)
        notes.append("Scadenza non rilevata dall'OCR.")
        return None, "\n".join(notes)

    if category == DOCUMENT_CATEGORY_HEALTH:
        codici = extracted.get("codici_fiscali", [])
        member_cf = (context.codice_fiscale or "").replace(" ", "").upper()
        if codici:
            notes.append(f"Codice fiscale rilevato: {codici[0]}")
        if not member_cf:
            notes.append("Codice fiscale socio assente nel profilo.")
            return None, "\n".join(notes)
        if not codici:
            notes.append("Codice fiscale non rilevato dall'OCR.")
            return None, "\n".join(notes)
        if member_cf in codici:
            return True, "\n".join(notes)
        notes.append("Codice fiscale OCR non corrisponde al profilo socio.")
        return False, "\n".join(notes)

    if category == DOCUMENT_CATEGORY_MEDICAL:
        expiry_dates = extracted.get("expiry_dates", [])
        if expiry_dates:
            latest = max(expiry_dates)
            notes.append(f"Scadenza rilevata: {latest.isoformat()}")
            if context.medical_certificate_expiry:
                notes.append(
                    "Scadenza modulo: "
                    f"{context.medical_certificate_expiry.isoformat()}"
                )
                if latest != context.medical_certificate_expiry:
                    notes.append("Scadenza OCR diversa da quella indicata nel modulo.")
            if latest < today:
                notes.append("Certificato scaduto.")
                return False, "\n".join(notes)
            if latest <= today + timedelta(days=60):
                notes.append("Attenzione: certificato in scadenza entro 60 giorni.")
            return True, "\n".join(notes)
        if context.medical_certificate_expiry:
            notes.append(
                "Scadenza modulo: "
                f"{context.medical_certificate_expiry.isoformat()}"
            )
            if context.medical_certificate_expiry < today:
                notes.append("Certificato scaduto (dato modulo).")
                return False, "\n".join(notes)
            return None, "\n".join(notes) + "\nScadenza non rilevata dall'OCR."
        notes.append("Scadenza non rilevata dall'OCR.")
        return None, "\n".join(notes)

    return None, "Categoria documento non gestita per OCR."


def _normalize_text(text: str) -> str:
    return text.upper()


def _parse_dates(text: str) -> list[date]:
    dates: list[date] = []
    for day, month, year in DATE_RE.findall(text):
        parsed = _parse_date_parts(day, month, year)
        if parsed:
            dates.append(parsed)
    return dates


def _parse_date_parts(day: str, month: str, year: str) -> date | None:
    try:
        day_i = int(day)
        month_i = int(month)
        year_i = int(year)
        if year_i < 100:
            year_i += 2000 if year_i < 50 else 1900
        return date(year_i, month_i, day_i)
    except ValueError:
        return None


def _extract_dates_near_keywords(text: str, keywords: tuple[str, ...]) -> list[date]:
    lowered = text.lower()
    dates: list[date] = []
    for keyword in keywords:
        start = 0
        while True:
            index = lowered.find(keyword, start)
            if index == -1:
                break
            window = text[index : index + 80]
            dates.extend(_parse_dates(window))
            start = index + len(keyword)
    return dates
