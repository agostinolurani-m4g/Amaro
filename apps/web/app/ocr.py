from __future__ import annotations

import logging
import re
import threading
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from PIL import Image

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

CODICE_FISCALE_RE = re.compile(r"\b([A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z])\b", re.I)
DATE_RE = re.compile(
    r"\b(\d{1,2})[./\-](\d{1,2})[./\-](\d{2,4})\b"
)
DOCUMENT_NUMBER_RE = re.compile(r"\b([A-Z]{2}\d{5,7}[A-Z0-9]?)\b", re.I)
SUPPORTED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"}
SUPPORTED_PDF_SUFFIXES = {".pdf"}
UNSUPPORTED_SUFFIXES = {".doc", ".docx"}


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

        suffix = path.suffix.lower()
        if suffix in UNSUPPORTED_SUFFIXES:
            document.ocr_status = "failed"
            document.ocr_valid = None
            document.ocr_notes = (
                "Formato Word non supportato per OCR. Carica PDF o immagine."
            )
            session.commit()
            return

        try:
            text = _extract_text(path)
        except Exception as exc:
            logger.exception("OCR failed for document %s", document_id)
            document.ocr_status = "failed"
            document.ocr_valid = None
            document.ocr_notes = f"OCR non disponibile: {exc}"
            session.commit()
            return

        document.ocr_text = text[:8000] if text else ""
        category = document.document_category or ""
        extracted = _extract_fields(category, text)
        is_valid, notes = _validate(category, extracted, member)
        document.ocr_status = "done"
        document.ocr_valid = is_valid
        document.ocr_notes = notes
        session.commit()
    finally:
        session.close()


def _extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in SUPPORTED_PDF_SUFFIXES:
        images = _pdf_to_images(path)
    elif suffix in SUPPORTED_IMAGE_SUFFIXES:
        images = [Image.open(path)]
    else:
        raise ValueError(f"Formato file non supportato: {suffix or 'sconosciuto'}")

    chunks: list[str] = []
    for image in images:
        chunks.append(_run_tesseract(image))
        image.close()
    return "\n".join(chunk for chunk in chunks if chunk).strip()


def _pdf_to_images(path: Path) -> list[Image.Image]:
    from pdf2image import convert_from_path

    return convert_from_path(str(path), first_page=1, last_page=2)


def _run_tesseract(image: Image.Image) -> str:
    import pytesseract

    return pytesseract.image_to_string(image, lang="ita")


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
    member: Member,
) -> tuple[bool | None, str]:
    today = date.today()
    notes: list[str] = []

    if category == DOCUMENT_CATEGORY_IDENTITY:
        numbers = extracted.get("document_numbers", [])
        expiry_dates = extracted.get("expiry_dates", [])
        if numbers:
            notes.append(f"Numero rilevato: {numbers[0]}")
        if member.document_number:
            member_number = member.document_number.replace(" ", "").upper()
            if numbers and member_number not in numbers:
                notes.append(
                    f"Numero modulo ({member.document_number}) diverso da OCR."
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
        member_cf = (member.codice_fiscale or "").replace(" ", "").upper()
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
            if member.medical_certificate_expiry:
                notes.append(
                    "Scadenza modulo: "
                    f"{member.medical_certificate_expiry.isoformat()}"
                )
                if latest != member.medical_certificate_expiry:
                    notes.append("Scadenza OCR diversa da quella indicata nel modulo.")
            if latest < today:
                notes.append("Certificato scaduto.")
                return False, "\n".join(notes)
            if latest <= today + timedelta(days=60):
                notes.append("Attenzione: certificato in scadenza entro 60 giorni.")
            return True, "\n".join(notes)
        if member.medical_certificate_expiry:
            notes.append(
                "Scadenza modulo: "
                f"{member.medical_certificate_expiry.isoformat()}"
            )
            if member.medical_certificate_expiry < today:
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
