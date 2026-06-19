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

from .acsi import maybe_submit_member_to_acsi
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

IDENTITY_TYPE_KEYWORDS: tuple[tuple[str, int], ...] = (
    ("CARTA D'IDENTITA", 3),
    ("CARTA DI IDENTITA", 3),
    ("CARTA IDENTITA", 2),
    ("REPUBBLICA ITALIANA", 2),
    ("MINISTERO DELL'INTERNO", 2),
    ("PASSAPORTO", 3),
    ("PASSPORT", 3),
    ("COMUNE DI", 1),
    ("CITTADINANZA", 1),
    ("DATA DI NASCITA", 1),
    ("LUOGO DI NASCITA", 1),
)
HEALTH_TYPE_KEYWORDS: tuple[tuple[str, int], ...] = (
    ("TESSERA SANITARIA", 4),
    ("SERVIZIO SANITARIO NAZIONALE", 3),
    ("TEAM PER LA SALUTE", 2),
    ("CARTA NAZIONALE DEI SERVIZI", 2),
    ("CARTA REGIONALE", 2),
    ("ASSISTENZA SANITARIA", 2),
    ("ASL", 1),
    ("SSN", 1),
)
MEDICAL_TYPE_KEYWORDS: tuple[tuple[str, int], ...] = (
    ("CERTIFICATO", 2),
    ("AGONISTIC", 3),
    ("IDONEITA SPORTIVA", 3),
    ("IDONEITÀ SPORTIVA", 3),
    ("IDONEITA ALL'ATTIVITA", 2),
    ("IDONEITÀ ALL'ATTIVITÀ", 2),
    ("VISITA MEDICA", 2),
    ("SPORTIVO", 1),
    ("SPORTIVA", 1),
    ("MEDICO", 1),
)
SPORT_KEYWORDS_BY_TYPE: dict[str, tuple[str, ...]] = {
    "Solo ciclismo": (
        "CICLISMO",
        "CYCLING",
        "CICLO",
        "BICICLETTA",
        "BICI",
        "MTB",
        "CICLIST",
        "CICLOSTILE",
    ),
    "Solo atletica": (
        "ATLETICA",
        "PODISMO",
        "CORSA",
        "RUNNING",
        "ATLETIC",
    ),
    "Ciclismo + Atletica": (
        "CICLISMO",
        "CYCLING",
        "CICLO",
        "BICICLETTA",
        "ATLETICA",
        "PODISMO",
        "CORSA",
        "RUNNING",
    ),
}
DOCUMENT_TYPE_LABELS = {
    "identity": "carta d'identita / passaporto",
    "health": "tessera sanitaria",
    "medical": "certificato medico",
}


@dataclass
class MemberValidationContext:
    first_name: str | None = None
    last_name: str | None = None
    codice_fiscale: str | None = None
    document_number: str | None = None
    medical_certificate_expiry: date | None = None
    sport_type: str | None = None

    @classmethod
    def from_member(cls, member: Member) -> MemberValidationContext:
        return cls(
            first_name=member.first_name,
            last_name=member.last_name,
            codice_fiscale=member.codice_fiscale,
            document_number=member.document_number,
            medical_certificate_expiry=member.medical_certificate_expiry,
            sport_type=member.sport_type,
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
    extracted["_raw_text"] = text
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
        threading.Thread(
            target=maybe_submit_member_to_acsi,
            args=(member_id,),
            daemon=True,
        ).start()
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
    fields: dict[str, Any] = {
        "document_type_scores": _document_type_scores(normalized),
    }
    if category == DOCUMENT_CATEGORY_IDENTITY:
        fields.update(_extract_identity(normalized))
    elif category == DOCUMENT_CATEGORY_HEALTH:
        fields.update(_extract_health_card(normalized))
    elif category == DOCUMENT_CATEGORY_MEDICAL:
        fields.update(_extract_medical_cert(normalized))
    return fields


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
    checks: list[tuple[bool | None, str]] = [
        _validate_document_type(category, extracted),
        _validate_person_data(extracted, context, category),
    ]

    if category == DOCUMENT_CATEGORY_IDENTITY:
        checks.append(_validate_identity_data(extracted, context))
    elif category == DOCUMENT_CATEGORY_HEALTH:
        checks.append(_validate_health_data(extracted, context))
    elif category == DOCUMENT_CATEGORY_MEDICAL:
        checks.extend(
            [
                _validate_medical_certificate_type(extracted),
                _validate_medical_sport(context, extracted),
                _validate_medical_expiry(extracted, context),
            ]
        )
    else:
        return None, "Categoria documento non gestita per OCR."

    return _combine_checks(checks)


def _combine_checks(checks: list[tuple[bool | None, str]]) -> tuple[bool | None, str]:
    notes = [note for _, note in checks if note]
    if any(valid is False for valid, _ in checks):
        return False, "\n".join(notes)
    if all(valid is True for valid, _ in checks):
        return True, "\n".join(notes)
    if any(valid is True for valid, _ in checks):
        return True, "\n".join(notes)
    return None, "\n".join(notes)


def _category_type_key(category: str) -> str:
    if category == DOCUMENT_CATEGORY_IDENTITY:
        return "identity"
    if category == DOCUMENT_CATEGORY_HEALTH:
        return "health"
    if category == DOCUMENT_CATEGORY_MEDICAL:
        return "medical"
    return ""


def _document_type_scores(text: str) -> dict[str, int]:
    return {
        "identity": _score_keywords(text, IDENTITY_TYPE_KEYWORDS),
        "health": _score_keywords(text, HEALTH_TYPE_KEYWORDS),
        "medical": _score_keywords(text, MEDICAL_TYPE_KEYWORDS),
    }


def _score_keywords(text: str, keywords: tuple[tuple[str, int], ...]) -> int:
    return sum(weight for keyword, weight in keywords if keyword in text)


def _validate_document_type(
    category: str,
    extracted: dict[str, Any],
) -> tuple[bool | None, str]:
    expected = _category_type_key(category)
    if not expected:
        return None, ""

    scores: dict[str, int] = extracted.get("document_type_scores", {})
    expected_score = scores.get(expected, 0)
    expected_label = DOCUMENT_TYPE_LABELS[expected]

    other_scores = {
        key: value for key, value in scores.items() if key != expected and value > 0
    }
    if not expected_score and not other_scores:
        return None, f"Tipo documento non riconosciuto: atteso {expected_label}."

    if other_scores:
        best_other_key = max(other_scores, key=other_scores.get)
        best_other_score = other_scores[best_other_key]
        if best_other_score > expected_score:
            other_label = DOCUMENT_TYPE_LABELS[best_other_key]
            return (
                False,
                f"Documento errato: sembra una {other_label}, non {expected_label}.",
            )
        if best_other_score == expected_score and expected_score > 0:
            return (
                None,
                f"Tipo documento ambiguo: verifica che sia {expected_label}.",
            )

    if expected_score > 0:
        return True, f"Tipo documento riconosciuto: {expected_label}."
    return None, f"Tipo documento non confermato: atteso {expected_label}."


def _normalize_person_token(value: str) -> str:
    cleaned = re.sub(r"[^A-Z]", "", value.upper())
    return cleaned


def _validate_person_data(
    extracted: dict[str, Any],
    context: MemberValidationContext,
    category: str = "",
) -> tuple[bool | None, str]:
    text = extracted.get("_raw_text", "")
    if not text:
        return None, ""

    first = _normalize_person_token(context.first_name or "")
    last = _normalize_person_token(context.last_name or "")
    normalized_text = _normalize_person_token(text)

    notes: list[str] = []
    if not first and not last:
        return None, "Nome e cognome non disponibili per il confronto."

    if first:
        if first in normalized_text:
            notes.append("Nome corrispondente ai dati inseriti.")
        else:
            notes.append("Nome non trovato nel documento.")
    if last:
        if last in normalized_text:
            notes.append("Cognome corrispondente ai dati inseriti.")
        else:
            notes.append("Cognome non trovato nel documento.")

    if first and last:
        if first in normalized_text and last in normalized_text:
            return True, "\n".join(notes)
        if category == DOCUMENT_CATEGORY_MEDICAL:
            return None, "\n".join(notes)
        return False, "\n".join(notes)
    if (first and first in normalized_text) or (last and last in normalized_text):
        return True, "\n".join(notes)
    return None, "\n".join(notes)


def _validate_identity_data(
    extracted: dict[str, Any],
    context: MemberValidationContext,
) -> tuple[bool | None, str]:
    numbers = extracted.get("document_numbers", [])
    notes: list[str] = []
    if numbers:
        notes.append(f"Numero documento rilevato: {numbers[0]}")
    if context.document_number:
        member_number = context.document_number.replace(" ", "").upper()
        if numbers and member_number not in numbers:
            notes.append(
                f"Numero indicato nel modulo ({context.document_number}) "
                "diverso da quello rilevato."
            )
            return False, "\n".join(notes)
        if numbers:
            notes.append("Numero documento coerente con il modulo.")
            return True, "\n".join(notes)
    if numbers:
        return True, "\n".join(notes)
    return None, "Numero documento non rilevato dall'OCR."


def _validate_health_data(
    extracted: dict[str, Any],
    context: MemberValidationContext,
) -> tuple[bool | None, str]:
    codici = extracted.get("codici_fiscali", [])
    member_cf = (context.codice_fiscale or "").replace(" ", "").upper()
    notes: list[str] = []
    if codici:
        notes.append(f"Codice fiscale rilevato: {codici[0]}")
    if not member_cf:
        return None, "Codice fiscale assente nel modulo."
    if not codici:
        return None, "Codice fiscale non rilevato dalla tessera sanitaria."
    if member_cf in codici:
        notes.append("Codice fiscale coerente con il profilo.")
        return True, "\n".join(notes)
    notes.append("Codice fiscale non corrisponde al profilo.")
    return False, "\n".join(notes)


def _validate_medical_certificate_type(
    extracted: dict[str, Any],
) -> tuple[bool | None, str]:
    text = extracted.get("_raw_text", "")
    if not text:
        return None, ""
    normalized = _normalize_text(text)
    agonistic_markers = (
        "AGONISTIC",
        "IDONEITA SPORTIVA",
        "IDONEITÀ SPORTIVA",
        "IDONEITA ALL'ATTIVITA",
        "IDONEITÀ ALL'ATTIVITÀ",
    )
    if any(marker in normalized for marker in agonistic_markers):
        return True, "Certificato medico agonistico riconosciuto."
    if "CERTIFICATO" in normalized and ("SPORTIV" in normalized or "MEDICO" in normalized):
        return None, "Certificato medico rilevato, ma non e' chiaramente agonistico."
    return None, "Tipo certificato non riconosciuto (testo poco leggibile o incompleto)."


def _validate_medical_sport(
    context: MemberValidationContext,
    extracted: dict[str, Any],
) -> tuple[bool | None, str]:
    sport_type = (context.sport_type or "").strip()
    text = extracted.get("_raw_text", "")
    if not sport_type:
        return None, "Disciplina non indicata: impossibile verificare il certificato."
    if not text:
        return None, ""

    keywords = SPORT_KEYWORDS_BY_TYPE.get(sport_type, ())
    if not keywords:
        return None, f"Disciplina '{sport_type}' non gestita per la verifica OCR."

    normalized = _normalize_text(text)
    matched = [keyword for keyword in keywords if keyword in normalized]
    if sport_type == "Solo ciclismo":
        cycling_keywords = SPORT_KEYWORDS_BY_TYPE["Solo ciclismo"]
        if any(keyword in normalized for keyword in cycling_keywords):
            return True, "Disciplina ciclismo presente nel certificato."
        return (
            None,
            "Disciplina ciclismo non rilevata nel certificato "
            f"(scelta: {sport_type}); verifica manuale consigliata.",
        )

    if sport_type == "Solo atletica":
        athletics_keywords = SPORT_KEYWORDS_BY_TYPE["Solo atletica"]
        if any(keyword in normalized for keyword in athletics_keywords):
            return True, "Disciplina atletica presente nel certificato."
        return (
            None,
            "Disciplina atletica non rilevata nel certificato "
            f"(scelta: {sport_type}); verifica manuale consigliata.",
        )

    if matched:
        return (
            True,
            f"Disciplina coerente con '{sport_type}' "
            f"({', '.join(matched[:3]).lower()}).",
        )
    return (
        None,
        f"Disciplina '{sport_type}' non rilevata nel certificato; "
        "verifica manuale consigliata.",
    )


def _validate_medical_expiry(
    extracted: dict[str, Any],
    context: MemberValidationContext,
) -> tuple[bool | None, str]:
    today = date.today()
    expiry_dates = extracted.get("expiry_dates", [])
    notes: list[str] = []

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
        notes.append("Certificato medico valido.")
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

    notes.append("Scadenza certificato medico non rilevata.")
    return None, "\n".join(notes)


def _normalize_text(text: str) -> str:
    import unicodedata

    normalized = unicodedata.normalize("NFD", text)
    without_accents = "".join(
        char for char in normalized if unicodedata.category(char) != "Mn"
    )
    return without_accents.upper()


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
