from __future__ import annotations

import logging
import os
import re
import smtplib
import tempfile
import zipfile
from copy import deepcopy
from datetime import date, datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from xml.etree import ElementTree as ET

from sqlalchemy import or_
from sqlalchemy.orm import Session

from .config import settings
from .database import SessionLocal
from .models import (
    DOCUMENT_CATEGORY_HEALTH,
    DOCUMENT_CATEGORY_IDENTITY,
    DOCUMENT_CATEGORY_MEDICAL,
    Member,
    MemberDocument,
    MEMBERSHIP_STATUS_COMPLETED,
)

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = (BASE_DIR / settings.uploads_path).resolve()
STATIC_FILES_DIR = BASE_DIR / "static" / "files"

ACSI_TEMPLATE_FILENAME = "Modello_tesseramento_ACSI_NUOVO.xlsx"
ACSI_TEMPLATE_PATH = STATIC_FILES_DIR / ACSI_TEMPLATE_FILENAME
ACSI_SHEET_PATH = "xl/worksheets/sheet1.xml"
ACSI_DATA_START_ROW = 13
ACSI_COLUMNS = list("ABCDEFGHIJKLMNOPQ")
ACSI_QUALIFICA_DEFAULT = "Socio - 2116"
ACSI_ASSICURAZIONE_DEFAULT = "Base Sport - 102"
ACSI_CONSENSO_DEFAULT = "SI"
ACSI_DISCIPLINE_BY_SPORT: dict[str, dict[str, list[str]]] = {
    "Solo ciclismo": {
        "coni": ["Ciclismo su strada - AX005"],
        "acsi": ["CICLISMO - 184"],
    },
    "Solo atletica": {
        "coni": ["Atletica Leggera - AF001"],
        "acsi": ["ATLETICA - 136"],
    },
    "Ciclismo + Atletica": {
        "coni": ["Ciclismo su strada - AX005", "Atletica Leggera - AF001"],
        "acsi": ["CICLISMO - 184", "ATLETICA - 136"],
    },
}
ACSI_NS = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
ACSI_CELL_REF_RE = re.compile(r"^([A-Z]+)(\d+)$")

REQUIRED_DOCUMENT_CATEGORIES = {
    DOCUMENT_CATEGORY_IDENTITY,
    DOCUMENT_CATEGORY_HEALTH,
    DOCUMENT_CATEGORY_MEDICAL,
}


def medical_document_needs_manual_review(document: MemberDocument) -> bool:
    if document.document_category != DOCUMENT_CATEGORY_MEDICAL:
        return False
    if document.ocr_status in (None, "pending"):
        return False
    if document.ocr_status == "failed":
        return True
    return document.ocr_status == "done" and document.ocr_valid is None


def _member_medical_needs_manual_review(member: Member) -> MemberDocument | None:
    for document in member.documents:
        if medical_document_needs_manual_review(document):
            return document
    return None


def maybe_notify_medical_manual_review(member_id: int, document_id: int) -> None:
    session = SessionLocal()
    try:
        member = session.get(Member, member_id)
        document = session.get(MemberDocument, document_id)
        if not member or not document or document.member_id != member.id:
            return
        if not medical_document_needs_manual_review(document):
            return
        if member.medical_manual_review_notified_at and document.uploaded_at:
            if document.uploaded_at <= member.medical_manual_review_notified_at:
                return
        review_email = settings.medical_manual_review_email
        if not review_email:
            logger.warning(
                "MEDICAL_MANUAL_REVIEW_EMAIL non configurata: reminder saltato "
                "per socio %s.",
                member_id,
            )
            return
        sent = send_medical_manual_review_email(member, document, review_email)
        if not sent:
            return
        member.medical_manual_review_notified_at = datetime.now(timezone.utc)
        session.commit()
        logger.info(
            "Reminder certificato medico inviato per socio %s a %s.",
            member_id,
            review_email,
        )
    except Exception:
        logger.exception(
            "Invio reminder certificato medico fallito per socio %s", member_id
        )
    finally:
        session.close()


def send_medical_manual_review_email(
    member: Member,
    document: MemberDocument,
    to_email: str,
) -> bool:
    if not settings.smtp_host or not settings.smtp_from:
        return False

    ocr_label = "Non verificabile"
    if document.ocr_status == "failed":
        ocr_label = "Verifica OCR non riuscita"

    body = (
        "Il certificato medico di un socio non e' stato riconosciuto "
        "completamente dall'OCR.\n"
        "La pratica puo' proseguire in automatico, ma serve una verifica manuale.\n\n"
        f"Socio: {member.first_name} {member.last_name}\n"
        f"Email: {member.email}\n"
        f"Telefono: {member.phone or '-'}\n"
        f"Codice fiscale: {member.codice_fiscale or '-'}\n"
        f"Disciplina: {member.sport_type or '-'}\n"
        f"Scadenza indicata nel modulo: "
        f"{member.medical_certificate_expiry.isoformat() if member.medical_certificate_expiry else '-'}\n"
        f"Documento: {document.original_name}\n"
        f"Esito OCR: {ocr_label}\n"
    )
    if document.ocr_notes:
        body += f"\nNote OCR:\n{document.ocr_notes}\n"
    body += (
        f"\nID socio: {member.id}\n"
        "Apri il pannello admin (/admin) > Tools o Member documents per controllare.\n\n"
        f"— {settings.app_name}\n"
    )

    message = EmailMessage()
    message["Subject"] = (
        f"{settings.app_name} - Certificato medico da verificare "
        f"({member.last_name} {member.first_name})"
    )
    message["From"] = settings.smtp_from
    message["To"] = to_email
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
        logger.exception(
            "Invio reminder certificato medico fallito per socio %s verso %s",
            member.id,
            to_email,
        )
        return False
    finally:
        if server:
            try:
                server.quit()
            except Exception:
                pass


def members_pending_acsi(session: Session) -> list[Member]:
    return (
        session.query(Member)
        .filter(Member.payment_status == "paid")
        .filter(
            or_(
                Member.membership_status.is_(None),
                Member.membership_status != MEMBERSHIP_STATUS_COMPLETED,
            )
        )
        .order_by(Member.last_name.asc(), Member.first_name.asc(), Member.id.asc())
        .all()
    )


def member_acsi_ready(member: Member) -> tuple[bool, str]:
    if member.payment_status != "paid":
        return False, "Pagamento non completato."
    if member.acsi_submitted_at is not None:
        return False, "Pratica gia inviata ad ACSI."
    if member.membership_status == MEMBERSHIP_STATUS_COMPLETED:
        return False, "Socio gia tesserato."

    docs_by_category: dict[str, list] = {}
    for document in member.documents:
        category = document.document_category or ""
        docs_by_category.setdefault(category, []).append(document)

    for category in REQUIRED_DOCUMENT_CATEGORIES:
        if not docs_by_category.get(category):
            return False, f"Manca documento: {category}."

    for document in member.documents:
        if document.document_category not in REQUIRED_DOCUMENT_CATEGORIES:
            continue
        if document.document_category == DOCUMENT_CATEGORY_MEDICAL:
            if document.ocr_valid is False:
                return False, f"Certificato medico non valido: {document.original_name}."
            if document.ocr_status in (None, "pending"):
                return False, f"Verifica OCR in corso: {document.original_name}."
            continue
        if document.ocr_status != "done":
            return False, f"Verifica OCR in corso: {document.original_name}."
        if document.ocr_valid is not True:
            label = "non valido" if document.ocr_valid is False else "non verificabile"
            return False, f"Documento {label}: {document.original_name}."

    return True, "Pronto per invio ACSI."


def maybe_submit_member_to_acsi(member_id: int) -> None:
    session = SessionLocal()
    zip_path: str | None = None
    try:
        member = session.get(Member, member_id)
        if not member:
            return
        ready, reason = member_acsi_ready(member)
        if not ready:
            logger.debug("ACSI non inviato per socio %s: %s", member_id, reason)
            return
        review_doc = _member_medical_needs_manual_review(member)
        if review_doc:
            maybe_notify_medical_manual_review(member.id, review_doc.id)
        if not settings.acsi_notify_email:
            logger.warning(
                "ACSI_NOTIFY_EMAIL non configurata: invio automatico saltato "
                "per socio %s.",
                member_id,
            )
            return

        zip_path = build_acsi_export([member])
        sent = send_acsi_submission_email(member, zip_path)
        if not sent:
            return

        member.acsi_submitted_at = datetime.now(timezone.utc)
        session.commit()
        logger.info("Pacchetto ACSI inviato per socio %s.", member_id)
        _notify_staff_acsi_sent(member)
    except Exception:
        logger.exception("Invio automatico ACSI fallito per socio %s", member_id)
    finally:
        if zip_path:
            try:
                os.unlink(zip_path)
            except OSError:
                logger.warning("Impossibile rimuovere zip ACSI temporaneo: %s", zip_path)
        session.close()


def _notify_staff_acsi_sent(member: Member) -> None:
    staff_email = settings.membership_notify_email
    if not staff_email or staff_email == settings.acsi_notify_email:
        return
    body = (
        "Invio automatico ACSI completato.\n\n"
        f"Socio: {member.first_name} {member.last_name}\n"
        f"Email: {member.email}\n"
        f"Disciplina: {member.sport_type or '-'}\n"
        f"ID socio: {member.id}\n"
    )
    message = EmailMessage()
    message["Subject"] = f"{settings.app_name} - Inviato ad ACSI {member.last_name}"
    message["From"] = settings.smtp_from
    message["To"] = staff_email
    message.set_content(body)
    server = None
    try:
        if not settings.smtp_host or not settings.smtp_from:
            return
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
    except Exception:
        logger.exception("Notifica staff post-invio ACSI fallita")
    finally:
        if server:
            try:
                server.quit()
            except Exception:
                pass


def send_acsi_submission_email(member: Member, zip_path: str) -> bool:
    if not settings.smtp_host or not settings.smtp_from or not settings.acsi_notify_email:
        return False

    zip_filename = (
        f"acsi_{_safe_filename(member.last_name)}_{_safe_filename(member.first_name)}"
        f"_{member.id}_{date.today():%Y%m%d}.zip"
    )
    body = (
        "Buongiorno,\n\n"
        "in allegato il pacchetto tesseramento per l'associazione Amaro Sport e Cultura.\n\n"
        f"Socio: {member.first_name} {member.last_name}\n"
        f"Codice fiscale: {member.codice_fiscale or '-'}\n"
        f"Email: {member.email}\n"
        f"Telefono: {member.phone or '-'}\n"
        f"Disciplina: {member.sport_type or '-'}\n"
        f"ID interno: {member.id}\n\n"
        "Il pacchetto include:\n"
        "- foglio Excel ACSI compilato\n"
        "- documenti del socio (CI, tessera sanitaria, certificato medico)\n\n"
        "Documenti verificati automaticamente (OCR) e pagamento registrato.\n\n"
        f"— {settings.app_name}\n"
    )
    message = EmailMessage()
    message["Subject"] = (
        f"{settings.app_name} - Tesseramento ACSI "
        f"{member.last_name} {member.first_name}"
    )
    message["From"] = settings.smtp_from
    message["To"] = settings.acsi_notify_email
    message.set_content(body)
    message.add_attachment(
        Path(zip_path).read_bytes(),
        maintype="application",
        subtype="zip",
        filename=zip_filename,
    )

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
        logger.exception(
            "Invio email ACSI fallito per socio %s verso %s",
            member.id,
            settings.acsi_notify_email,
        )
        return False
    finally:
        if server:
            try:
                server.quit()
            except Exception:
                pass


def build_acsi_export(members: list[Member]) -> str:
    temp_xlsx = tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx")
    temp_xlsx_path = temp_xlsx.name
    temp_xlsx.close()
    _write_acsi_excel(members, ACSI_TEMPLATE_PATH, temp_xlsx_path)

    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    temp_path = temp_file.name
    temp_file.close()

    with zipfile.ZipFile(temp_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(temp_xlsx_path, arcname="acsi_tesseramento.xlsx")
        for member in members:
            folder = _safe_filename(
                f"{member.last_name}_{member.first_name}_{member.id}"
            )
            for document in member.documents:
                path = UPLOADS_DIR / document.stored_filename
                if not path.exists():
                    continue
                doc_name = _safe_filename(document.original_name)
                archive.write(path, arcname=f"{folder}/{document.id}_{doc_name}")

    try:
        os.unlink(temp_xlsx_path)
    except OSError:
        logger.warning("Impossibile rimuovere il file temporaneo ACSI: %s", temp_xlsx_path)

    return temp_path


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
    cleaned = cleaned.strip("_")
    return cleaned or "file"


def _acsi_disciplines_for_member(member: Member) -> tuple[list[str], list[str]]:
    sport_type = (member.sport_type or "").strip()
    mapping = ACSI_DISCIPLINE_BY_SPORT.get(sport_type)
    if not mapping:
        return [], []
    coni = list(mapping.get("coni", []))
    acsi = list(mapping.get("acsi", []))
    return coni, acsi


def _acsi_row_values(member: Member) -> dict[str, str]:
    coni, acsi = _acsi_disciplines_for_member(member)
    return {
        "A": member.document_id or "",
        "B": member.last_name or "",
        "C": member.first_name or "",
        "D": member.codice_fiscale or "",
        "E": ACSI_QUALIFICA_DEFAULT,
        "F": member.email or "",
        "G": member.phone or "",
        "H": ACSI_ASSICURAZIONE_DEFAULT,
        "I": coni[0] if len(coni) > 0 else "",
        "J": coni[1] if len(coni) > 1 else "",
        "K": coni[2] if len(coni) > 2 else "",
        "L": acsi[0] if len(acsi) > 0 else "",
        "M": acsi[1] if len(acsi) > 1 else "",
        "N": acsi[2] if len(acsi) > 2 else "",
        "O": ACSI_CONSENSO_DEFAULT,
        "P": ACSI_CONSENSO_DEFAULT,
        "Q": ACSI_CONSENSO_DEFAULT,
    }


def _split_cell_ref(cell_ref: str) -> tuple[str, int] | None:
    match = ACSI_CELL_REF_RE.match(cell_ref)
    if not match:
        return None
    return match.group(1), int(match.group(2))


def _set_inline_cell_value(cell: ET.Element, value: str) -> None:
    for child in list(cell):
        cell.remove(child)
    if value == "":
        cell.attrib.pop("t", None)
        return
    cell.attrib["t"] = "inlineStr"
    is_el = ET.SubElement(cell, f"{{{ACSI_NS['main']}}}is")
    t_el = ET.SubElement(is_el, f"{{{ACSI_NS['main']}}}t")
    if value.startswith(" ") or value.endswith(" "):
        t_el.attrib["{http://www.w3.org/XML/1998/namespace}space"] = "preserve"
    t_el.text = value


def _write_acsi_excel(
    members: list[Member],
    template_path: Path,
    output_path: str,
) -> None:
    if not template_path.exists():
        raise FileNotFoundError(f"Template ACSI non trovato: {template_path}")

    ET.register_namespace("", ACSI_NS["main"])

    def tag(name: str) -> str:
        return f"{{{ACSI_NS['main']}}}{name}"

    with zipfile.ZipFile(template_path, "r") as source:
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as dest:
            for item in source.infolist():
                if item.filename != ACSI_SHEET_PATH:
                    dest.writestr(item, source.read(item.filename))
                    continue

                root = ET.fromstring(source.read(item.filename))
                sheet_data = root.find("main:sheetData", ACSI_NS)
                if sheet_data is None:
                    raise ValueError("Sheet ACSI non valido: sheetData mancante")

                rows = sheet_data.findall("main:row", ACSI_NS)
                rows_by_index = {
                    int(row.attrib["r"]): row
                    for row in rows
                    if row.attrib.get("r") and row.attrib["r"].isdigit()
                }
                template_row = rows_by_index.get(ACSI_DATA_START_ROW)
                if template_row is None:
                    raise ValueError("Riga modello ACSI mancante (riga 13)")

                template_cells_by_col: dict[str, ET.Element] = {}
                for cell in template_row.findall("main:c", ACSI_NS):
                    cell_ref = cell.attrib.get("r", "")
                    cell_info = _split_cell_ref(cell_ref)
                    if not cell_info:
                        continue
                    template_cells_by_col[cell_info[0]] = cell

                def clone_row(row_index: int) -> ET.Element:
                    new_row = deepcopy(template_row)
                    new_row.attrib["r"] = str(row_index)
                    for cell in new_row.findall("main:c", ACSI_NS):
                        cell_ref = cell.attrib.get("r", "")
                        cell_info = _split_cell_ref(cell_ref)
                        if cell_info:
                            cell.attrib["r"] = f"{cell_info[0]}{row_index}"
                        for child in list(cell):
                            cell.remove(child)
                        cell.attrib.pop("t", None)
                    return new_row

                def insert_row(row_index: int, row: ET.Element) -> None:
                    inserted = False
                    for idx, existing in enumerate(sheet_data.findall("main:row", ACSI_NS)):
                        existing_ref = existing.attrib.get("r")
                        if existing_ref and existing_ref.isdigit() and int(existing_ref) > row_index:
                            sheet_data.insert(idx, row)
                            inserted = True
                            break
                    if not inserted:
                        sheet_data.append(row)

                for offset, member in enumerate(members):
                    row_index = ACSI_DATA_START_ROW + offset
                    row = rows_by_index.get(row_index)
                    if row is None:
                        row = clone_row(row_index)
                        insert_row(row_index, row)
                        rows_by_index[row_index] = row

                    cells_by_col: dict[str, ET.Element] = {}
                    for cell in row.findall("main:c", ACSI_NS):
                        cell_ref = cell.attrib.get("r", "")
                        cell_info = _split_cell_ref(cell_ref)
                        if not cell_info:
                            continue
                        cells_by_col[cell_info[0]] = cell

                    values = _acsi_row_values(member)
                    for col in ACSI_COLUMNS:
                        cell = cells_by_col.get(col)
                        if cell is None:
                            cell = ET.SubElement(row, tag("c"), {"r": f"{col}{row_index}"})
                            template_cell = template_cells_by_col.get(col)
                            if template_cell is not None and "s" in template_cell.attrib:
                                cell.attrib["s"] = template_cell.attrib["s"]
                            cells_by_col[col] = cell
                        _set_inline_cell_value(cell, str(values.get(col, "")))

                dim = root.find("main:dimension", ACSI_NS)
                if dim is not None:
                    dim_ref = dim.attrib.get("ref", "")
                    dim_end_row = 0
                    match = re.match(r"^([A-Z]+)(\d+):([A-Z]+)(\d+)$", dim_ref)
                    if match:
                        dim_end_row = int(match.group(4))
                    last_row_needed = ACSI_DATA_START_ROW + max(len(members) - 1, 0)
                    new_end = max(dim_end_row, last_row_needed)
                    if new_end:
                        dim.attrib["ref"] = f"A1:Q{new_end}"

                dest.writestr(
                    item,
                    ET.tostring(root, encoding="utf-8", xml_declaration=True),
                )
