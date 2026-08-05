from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import secrets
import shutil
import tempfile
import zipfile
import csv
from copy import deepcopy
from datetime import date as dt_date, datetime as dt_datetime, timezone
from pathlib import Path
from uuid import uuid4
from xml.etree import ElementTree as ET

from fastapi import FastAPI
from sqlalchemy import or_
from sqladmin import Admin, BaseView, ModelView, expose
from sqladmin.authentication import AuthenticationBackend
from markupsafe import Markup, escape
from starlette.background import BackgroundTask
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, RedirectResponse, Response
from sqlalchemy.orm import Session
from wtforms import SelectField
from wtforms.validators import DataRequired

from .acsi import (
    build_acsi_export,
    member_acsi_ready_forced,
    members_pending_acsi,
    submit_member_to_acsi,
)
from .config import settings
from .database import SessionLocal, engine
from .event_bibs import backfill_missing_bib_numbers
from .ocr import schedule_documents_ocr
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
    MEMBERSHIP_STATUS_COMPLETED,
)

_EVENT_FILE_TYPES = {"medical", "acsi_fci", "waiver"}

logger = logging.getLogger(__name__)
BASE_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = (BASE_DIR / settings.uploads_path).resolve()
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
def _hash_password(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _generate_member_password() -> tuple[str, str]:
    password = secrets.token_urlsafe(6)
    return password, _hash_password(password)


def _save_uploaded_documents(
    member_id: int,
    uploads: list[UploadFile],
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
    documents_by_category: dict[str, list[UploadFile] | None],
) -> list[MemberDocument]:
    saved: list[MemberDocument] = []
    for category, uploads in documents_by_category.items():
        if not uploads:
            continue
        saved.extend(_save_uploaded_documents(member_id, uploads, category))
    return saved


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
    cleaned = cleaned.strip("_")
    return cleaned or "file"


def _slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "evento"


def _has_merch_booked(reg: EventRegistration) -> bool:
    return bool((reg.jersey_size or "").strip() and (reg.jersey_gender or "").strip())


def _format_race(reg: EventRegistration) -> str:
    parts: list[str] = []
    if reg.discipline:
        parts.append(reg.discipline)
    if reg.route_length:
        parts.append(reg.route_length)
    return " / ".join(parts) if parts else "—"


def _format_lunch(reg: EventRegistration) -> str:
    if not reg.lunch_option:
        return "—"
    label = reg.lunch_option.replace("_", " ")
    if reg.lunch_guests:
        return f"{label} (+{reg.lunch_guests} ospiti)"
    return label


def _format_merch(reg: EventRegistration) -> str:
    if not _has_merch_booked(reg):
        return "Nessun merch"
    return f"{reg.jersey_gender} — {reg.jersey_size}"


def _is_paid(reg: EventRegistration) -> bool:
    return reg.payment_status == "paid"


def _format_amount_cents(cents: int | None) -> str:
    if cents is None:
        return "—"
    return f"{cents / 100:.2f} €"


def _registration_ops_payload(reg: EventRegistration) -> dict:
    return {
        "id": reg.id,
        "first_name": reg.first_name or "",
        "last_name": reg.last_name or "",
        "full_name": f"{reg.last_name or ''} {reg.first_name or ''}".strip(),
        "email": reg.email or "",
        "phone": reg.phone or "",
        "team_name": reg.team_name or "",
        "discipline": reg.discipline or "",
        "route_length": reg.route_length or "",
        "race": _format_race(reg),
        "lunch": _format_lunch(reg),
        "lunch_option": reg.lunch_option or "",
        "lunch_guests": reg.lunch_guests,
        "merch": _format_merch(reg),
        "has_merch": _has_merch_booked(reg),
        "jersey_size": reg.jersey_size or "",
        "jersey_gender": reg.jersey_gender or "",
        "bib_number": reg.bib_number or "",
        "payment_status": reg.payment_status or "pending",
        "paid": _is_paid(reg),
        "total_amount_cents": reg.total_amount_cents,
        "total_amount": _format_amount_cents(reg.total_amount_cents),
        "race_pack_collected": bool(reg.race_pack_collected),
        "arrived": bool(reg.arrived),
        "arrived_at": (
            reg.arrived_at.strftime("%d/%m/%Y %H:%M") if reg.arrived_at else ""
        ),
        "merch_collected": bool(reg.merch_collected),
        "intolerances": (reg.intolerances or "").strip(),
    }


def _unique_event_slug(base_slug: str, event_id: int | None = None) -> str:
    slug = base_slug
    counter = 1
    while True:
        with SessionLocal() as session:
            query = session.query(Event).filter(Event.slug == slug)
            if event_id:
                query = query.filter(Event.id != event_id)
            if not query.first():
                return slug
        counter += 1
        slug = f"{base_slug}-{counter}"


def _membership_status_label(status: str | None) -> str:
    if status == MEMBERSHIP_STATUS_COMPLETED:
        return "Tesserato"
    return "Da tesserare"


class AdminAuth(AuthenticationBackend):
    async def login(self, request: Request) -> bool:
        if not settings.admin_username or not settings.admin_password:
            return False
        form = await request.form()
        username = form.get("username")
        password = form.get("password")
        if username == settings.admin_username and password == settings.admin_password:
            request.session["admin_authenticated"] = True
            return True
        return False

    async def logout(self, request: Request) -> bool:
        request.session.pop("admin_authenticated", None)
        return True

    async def authenticate(self, request: Request) -> bool:
        return bool(request.session.get("admin_authenticated"))


def _format_it_date(value: object) -> str:
    if isinstance(value, (dt_date, dt_datetime)):
        return value.strftime("%d/%m/%Y")
    return ""


class AmaroAdmin(ModelView):
    column_type_formatters = {
        dt_date: _format_it_date,
        dt_datetime: _format_it_date,
    }


class EventAdmin(AmaroAdmin, model=Event):
    form_overrides = {
        "medical_certificate_policy": SelectField,
        "route_option_mode": SelectField,
    }
    column_list = ["id", "title", "date", "location", "activity", "is_featured", "slug"]
    column_searchable_list = ["title", "location", "activity"]
    column_sortable_list = ["id", "date", "title", "location", "is_featured"]
    column_labels = {
        "title": "Nome evento",
        "description": "Descrizione",
        "hero_quote": "Citazione in evidenza (pagina evento)",
        "summary": "Riassunto breve (pagina evento, sotto la citazione)",
        "date": "Data",
        "location": "Luogo",
        "activity": "Attivita",
        "is_featured": "In evidenza",
        "is_amaro_event": "Evento AMARO (iscrizioni)",
        "registration_capacity": "Posti massimi (vuoto = illimitato)",
        "slug": "Slug",
        "cover_image_url": "Foto copertina (URL)",
        "gallery_urls": "Foto evento",
        "registration_notes": "Note per modulo iscrizione",
        "documents_urls": "Documenti evento (uno per riga, URL|etichetta)",
        "location_map_url": "Link Google Maps",
        "instagram_url": "Link Instagram evento",
        "enable_lunch_option": "Mostra scelta pranzo",
        "lunch_description": "Descrizione pranzo",
        "enable_discipline_option": "Mostra scelta disciplina (bici/corsa)",
        "enable_route_option": "Mostra percorso (vedi anche modalità sotto)",
        "route_option_mode": "Modalità percorso",
        "route_gpx_urls": "Link GPX per mappa pubblica (opzionale)",
        "event_activities_config": "Sport e percorsi (JSON modulo iscrizioni)",
        "medical_certificate_policy": "Certificato medico (Corto/Medio/Trail/Corsa)",
        "waiver_url": "Liberatoria (PDF) da scaricare",
        "require_waiver_upload": "Richiedi caricamento liberatoria firmata",
        "require_waiver_acceptance": "Richiedi spunta \"accetto liberatoria\"",
        "enable_jersey": "Abilita acquisto maglia",
        "jersey_description": "Descrizione maglia",
        "jersey_sizes": "Taglie disponibili (es: XS,S,M,L,XL)",
        "jersey_price_cents": "Prezzo maglia (cent)",
        "jersey_image_url_male": "Foto maglia (uomo)",
        "jersey_image_url_female": "Foto maglia (donna)",
        "jersey_gallery_urls": "Foto maglia galleria (una per riga)",
        "jersey_gallery_link": "Link galleria esterna (opzionale)",
        "event_price_cents": "Quota evento (cent)",
        "sponsors_urls": "Sponsor (una riga per sponsor)",
        "event_lunch_price_cents": "Quota pranzo (cent)",
        "require_first_name": "Nome obbligatorio",
        "require_last_name": "Cognome obbligatorio",
        "require_email": "Email obbligatoria",
        "require_phone": "Cellulare obbligatorio",
        "require_residence": "Residenza obbligatoria",
        "require_intolerances": "Intolleranze/Allergie obbligatorie",
        "require_acsi_fci": "Tessera ACSI/FCI obbligatoria",
        "require_medical_certificate": "(Legacy) Flag obbligo cert. — usa politica sotto",
        "require_privacy_photo": "Privacy foto obbligatoria",
        "require_privacy_other": "Privacy obbligatoria",
    }
    form_columns = [
        "title",
        "description",
        "hero_quote",
        "summary",
        "date",
        "location",
        "location_map_url",
        "activity",
        "is_featured",
        "is_amaro_event",
        "registration_capacity",
        "cover_image_url",
        "gallery_urls",
        "registration_notes",
        "documents_urls",
        "instagram_url",
        "enable_lunch_option",
        "lunch_description",
        "enable_discipline_option",
        "enable_route_option",
        "route_option_mode",
        "route_gpx_urls",
        "event_activities_config",
        "waiver_url",
        "require_waiver_upload",
        "require_waiver_acceptance",
        "enable_jersey",
        "jersey_description",
        "jersey_sizes",
        "jersey_price_cents",
        "jersey_image_url_male",
        "jersey_image_url_female",
        "jersey_gallery_urls",
        "jersey_gallery_link",
        "sponsors_urls",
        "event_price_cents",
        "event_lunch_price_cents",
        "require_first_name",
        "require_last_name",
        "require_email",
        "require_phone",
        "require_residence",
        "require_intolerances",
        "require_acsi_fci",
        "medical_certificate_policy",
        "require_medical_certificate",
        "require_privacy_photo",
        "require_privacy_other",
    ]
    form_args = {
        "title": {"validators": [DataRequired()]},
        "description": {"validators": [DataRequired()]},
        "date": {"validators": [DataRequired()]},
        "location": {"validators": [DataRequired()]},
        "activity": {"validators": [DataRequired()]},
        "medical_certificate_policy": {
            "choices": [
                (
                    "none",
                    "No — campo nascosto (obbligo agonistico solo se Lungo con 3 distanze)",
                ),
                (
                    "optional",
                    "Facoltativo — obbligo agonistico solo per Lungo",
                ),
                ("required", "Obbligatorio — tutti i percorsi / trail / corsa"),
            ],
        },
        "route_option_mode": {
            "choices": [
                ("distances", "Corto / Medio / Lungo"),
                ("trail", "Trail — percorso unico"),
                ("corsa", "Corsa — percorso unico"),
            ],
        },
    }
    form_widget_args = {
        "activity": {"placeholder": "Ciclismo, Atletica, Trail, ..."},
        "location_map_url": {"placeholder": "https://maps.app.goo.gl/..."},
        "cover_image_url": {"placeholder": "https://..."},
        "description": {"rows": 6},
        "hero_quote": {
            "placeholder": "Frase breve sopra al riassunto (opzionale, max 240 caratteri).",
            "rows": 2,
        },
        "summary": {
            "placeholder": "Testo introduttivo sulla pagina pubblica (opzionale).",
            "rows": 4,
        },
        "gallery_urls": {
            "placeholder": "Una foto per riga. Opzionale: URL|didascalia",
            "rows": 5,
        },
        "registration_notes": {
            "placeholder": "Testo aggiuntivo sopra al form di iscrizione (facoltativo).",
            "rows": 4,
        },
        "registration_capacity": {
            "placeholder": "Es. 200 — lasciare vuoto per nessun limite",
        },
        "documents_urls": {
            "placeholder": "Un documento per riga. Formato: URL|Titolo mostrato.",
            "rows": 4,
        },
        "lunch_description": {
            "placeholder": "Breve descrizione del pranzo (menù, logistica, ecc.).",
            "rows": 3,
        },
        "jersey_description": {
            "placeholder": "Breve descrizione della maglia evento.",
            "rows": 3,
        },
        "jersey_sizes": {
            "placeholder": "Esempio: XS,S,M,L,XL",
        },
        "jersey_gallery_urls": {
            "placeholder": "Una foto per riga. Sostituisce le foto uomo/donna se compilato.\nhttps://drive.google.com/uc?id=...\nhttps://drive.google.com/uc?id=...",
            "rows": 4,
        },
        "jersey_gallery_link": {
            "placeholder": "Link a galleria esterna (Google Drive, Instagram, ecc.) mostrato come pulsante nel form.",
        },
        "sponsors_urls": {
            "placeholder": "Una riga per sponsor.\nCon logo: URL_LOGO|Nome Sponsor\nSolo testo: Nome Sponsor",
            "rows": 5,
        },
        "route_gpx_urls": {
            "placeholder": "Una riga per percorso. Formato: chiave|URL_GPX|etichetta_opzionale\n"
            "Le chiavi devono coincidere con quelle nei percorsi del JSON sotto.\n"
            "Google Drive: va bene il link «Condividi» (file/d/.../view); il server converte in download.\n"
            "Esempio:\ncorto|https://.../corto.gpx|Corto 40 km",
            "rows": 6,
        },
        "event_activities_config": {
            "placeholder": 'JSON, es.:\n{\n  "sports": [\n    {\n      "key": "mtb",\n      "label": "Mountain bike",\n      "routes": [\n        {"key": "corto", "label": "Corto 35 km"},\n        {"key": "lungo", "label": "Marathon 80 km", "medical_agonistic": true}\n      ]\n    },\n    {\n      "key": "trail",\n      "label": "Trail running",\n      "routes": [\n        {"key": "trail_12", "label": "Trail 12 km"}\n      ]\n    }\n  ]\n}\n'
            "Se compilato, il form usa solo questo (ignora Bici/Corsa e modalità percorso sotto). "
            "Chiavi: solo lettere minuscole, numeri, trattini (max 40).",
            "rows": 14,
        },
    }

    async def on_model_change(
        self, data: dict, model: Event, is_created: bool, request: Request
    ) -> None:
        policy = (getattr(model, "medical_certificate_policy", None) or "").strip()
        model.require_medical_certificate = policy == "required"
        if not model.slug:
            title = data.get("title") or model.title or ""
            if title:
                base_slug = _slugify(title)
                model.slug = _unique_event_slug(base_slug, model.id)


class EventWaitlistEntryAdmin(AmaroAdmin, model=EventWaitlistEntry):
    column_list = ["id", "event", "first_name", "last_name", "phone", "email", "created_at"]
    column_searchable_list = ["first_name", "last_name", "email", "phone"]
    column_sortable_list = ["id", "created_at"]
    column_labels = {
        "event": "Evento",
        "first_name": "Nome",
        "last_name": "Cognome",
        "phone": "Cellulare",
        "email": "Email",
        "created_at": "Richiesta il",
    }


class EventRegistrationAdmin(AmaroAdmin, model=EventRegistration):
    column_list = [
        "id",
        "event",
        "first_name",
        "last_name",
        "email",
        "phone",
        "medical_original_name",
        "acsi_fci_original_name",
        "waiver_original_name",
        "created_at",
        "lunch_option",
        "discipline",
        "route_length",
        "jersey_size",
        "jersey_gender",
        "payment_status",
        "total_amount_cents",
        "bib_number",
        "race_pack_collected",
        "arrived",
        "arrived_at",
        "merch_collected",
    ]
    column_searchable_list = ["first_name", "last_name", "email", "phone"]
    column_sortable_list = ["id", "created_at"]
    column_labels = {
        "event": "Evento",
        "first_name": "Nome",
        "last_name": "Cognome",
        "phone": "Cellulare",
        "privacy_photo": "Privacy foto",
        "privacy_other": "Privacy",
        "acsi_fci_original_name": "Tessera ACSI/FCI",
        "medical_original_name": "Certificato medico",
        "waiver_original_name": "Liberatoria",
        "lunch_option": "Pranzo",
        "discipline": "Disciplina",
        "route_length": "Percorso",
        "jersey_size": "Taglia maglia",
        "jersey_gender": "Genere maglia",
        "payment_status": "Stato pagamento",
        "total_amount_cents": "Importo totale (cent)",
        "bib_number": "Pettorale",
        "race_pack_collected": "Pacco gara",
        "arrived": "Arrivato",
        "arrived_at": "Ora arrivo",
        "merch_collected": "Merch consegnato",
    }
    column_formatters = {
        "medical_original_name": lambda m, a: Markup(
            f'<a href="/dl/event-file/{m.id}/medical" target="_blank">'
            f'⬇ {escape(m.medical_original_name)}</a>'
        ) if m.medical_original_name else "",
        "acsi_fci_original_name": lambda m, a: Markup(
            f'<a href="/dl/event-file/{m.id}/acsi_fci" target="_blank">'
            f'⬇ {escape(m.acsi_fci_original_name)}</a>'
        ) if m.acsi_fci_original_name else "",
        "waiver_original_name": lambda m, a: Markup(
            f'<a href="/dl/event-file/{m.id}/waiver" target="_blank">'
            f'⬇ {escape(m.waiver_original_name)}</a>'
        ) if m.waiver_original_name else "",
    }
    form_excluded_columns = [
        "event",
        "event_id",
        "acsi_fci_stored_filename",
        "acsi_fci_content_type",
        "medical_stored_filename",
        "medical_content_type",
        "created_at",
    ]


class MerchItemAdmin(AmaroAdmin, model=MerchItem):
    column_list = ["id", "name", "slug", "price_cents", "stock", "image_url"]
    column_searchable_list = ["name", "slug"]
    column_sortable_list = ["id", "name", "price_cents", "stock"]


class MemberAdmin(AmaroAdmin, model=Member):
    column_list = [
        "id",
        "first_name",
        "last_name",
        "email",
        "phone",
        "membership_type",
        "membership_status",
        "payment_status",
        "acsi_submitted_at",
        "created_at",
    ]
    column_searchable_list = ["first_name", "last_name", "email", "codice_fiscale"]
    column_sortable_list = ["id", "created_at", "last_name", "payment_status", "acsi_submitted_at"]
    form_excluded_columns = ["password_hash", "access_code", "documents"]


class MemberDocumentAdmin(AmaroAdmin, model=MemberDocument):
    column_list = [
        "id",
        "member",
        "document_category",
        "original_name",
        "ocr_valid",
        "ocr_notes",
        "content_type",
        "uploaded_at",
    ]
    column_labels = {
        "member": "Socio",
        "member.first_name": "Nome",
        "member.last_name": "Cognome",
        "document_category": "Categoria",
        "ocr_valid": "OCR valido",
        "ocr_notes": "Note OCR",
    }
    column_searchable_list = [
        "original_name",
        "member.first_name",
        "member.last_name",
    ]
    column_sortable_list = ["id", "uploaded_at", "ocr_valid"]
    form_excluded_columns = ["member"]
    column_formatters = {
        "member": lambda m, a: (
            f"{m.member.first_name} {m.member.last_name}".strip()
            if getattr(m, "member", None)
            else ""
        ),
        "ocr_valid": lambda m, a: (
            "Si"
            if m.ocr_valid is True
            else "No"
            if m.ocr_valid is False
            else "N/D"
        ),
    }


class AdminToolsView(BaseView):
    name = "Tools"
    icon = "fa-solid fa-toolbox"

    @expose("/tools", methods=["GET", "POST"], identity="tools")
    async def tools(self, request: Request) -> object:
        session = SessionLocal()
        try:
            if request.method == "POST":
                form = await request.form()
                action = form.get("action")
                member_id = form.get("member_id")
                notice = None
                password_reset = None

                if not member_id or not str(member_id).isdigit():
                    notice = "Seleziona un socio valido."
                else:
                    member = session.get(Member, int(member_id))
                    if not member:
                        notice = "Socio non trovato."
                    elif action == "upload_documents":
                        identity_documents = form.getlist("identity_documents")
                        health_documents = form.getlist("health_documents")
                        medical_documents = form.getlist("medical_documents")
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
                            session.flush()
                            saved_doc_ids = [doc.id for doc in saved_docs]
                            session.commit()
                            schedule_documents_ocr(saved_doc_ids, member.id)
                            notice = (
                                f"Caricati {len(saved_docs)} documenti per "
                                f"{member.first_name} {member.last_name}."
                            )
                        else:
                            notice = "Nessun file caricato."
                    elif action == "reset_password":
                        password_plain, password_hash = _generate_member_password()
                        member.access_code = password_plain
                        member.password_hash = password_hash
                        session.commit()
                        member_name = (
                            f"{member.first_name} {member.last_name}".strip()
                            or member.name
                            or f"Socio #{member.id}"
                        )
                        password_reset = {
                            "member_name": member_name,
                            "password": password_plain,
                        }
                        notice = "Password rigenerata."
                    elif action == "submit_acsi":
                        success, message = submit_member_to_acsi(member.id, force=True)
                        notice = (
                            message
                            if success
                            else f"Invio ACSI non riuscito: {message}"
                        )
                    elif action == "upload_card":
                        uploads = form.getlist("documents")
                        saved_docs = _save_uploaded_documents(member.id, uploads)
                        if saved_docs:
                            session.add_all(saved_docs)
                            session.flush()
                            saved_doc_ids = [doc.id for doc in saved_docs]
                            member.membership_status = MEMBERSHIP_STATUS_COMPLETED
                            session.commit()
                            schedule_documents_ocr(saved_doc_ids, member.id)
                            notice = (
                                f"Tessera caricata per {member.first_name} "
                                f"{member.last_name}. Stato: "
                                f"{_membership_status_label(member.membership_status)}."
                            )
                        else:
                            notice = "Nessun file caricato."
                    else:
                        notice = "Azione non valida."

                if notice:
                    request.session["admin_notice"] = notice
                if password_reset:
                    request.session["admin_password_reset"] = password_reset
                return RedirectResponse(
                    request.url_for("admin:tools"), status_code=303
                )

            members = (
                session.query(Member)
                .order_by(
                    Member.last_name.asc(),
                    Member.first_name.asc(),
                    Member.id.asc(),
                )
                .all()
            )
            pending_members = members_pending_acsi(session)
            acsi_submit_candidates = []
            for member in members:
                if member.acsi_submitted_at is not None:
                    continue
                ready, _reason = member_acsi_ready_forced(member)
                if ready:
                    acsi_submit_candidates.append(member)
            notice = request.session.pop("admin_notice", None)
            password_reset = request.session.pop("admin_password_reset", None)
            if not isinstance(password_reset, dict):
                password_reset = None
            context = {
                "request": request,
                "members": members,
                "pending_members_count": len(pending_members),
                "acsi_submit_candidates": acsi_submit_candidates,
                "notice": notice,
                "password_reset": password_reset,
                "title": "Admin tools",
                "subtitle": "Documenti e password soci",
            }
            return await self.templates.TemplateResponse(
                request, "admin_tools.html", context
            )
        finally:
            session.close()

    @expose("/tools/acsi-export", methods=["GET"], identity="acsi_export")
    async def tools_acsi_export(self, request: Request) -> object:
        session = SessionLocal()
        try:
            members = members_pending_acsi(session)
            if not members:
                request.session["admin_notice"] = "Nessun socio da inviare ad ACSI."
                return RedirectResponse(request.url_for("admin:tools"), status_code=303)
            export_path = build_acsi_export(members)
        finally:
            session.close()

        filename = f"acsi_tesseramento_{dt_date.today():%Y%m%d}.zip"
        return FileResponse(
            export_path,
            media_type="application/zip",
            filename=filename,
            background=BackgroundTask(os.unlink, export_path),
        )


class AdminOpsView(BaseView):
    name = "Gestionale eventi"
    icon = "fa-solid fa-clipboard-check"

    @expose("/gestionale", methods=["GET"], identity="ops")
    async def ops(self, request: Request) -> object:
        event_id_raw = request.query_params.get("event_id")
        with SessionLocal() as session:
            events = (
                session.query(Event)
                .filter(Event.is_amaro_event == True)
                .order_by(Event.date.desc())
                .all()
            )
            selected_event = None
            registrations: list[dict] = []
            stats = None
            if event_id_raw and event_id_raw.isdigit():
                selected_event = session.get(Event, int(event_id_raw))
            elif events:
                selected_event = events[0]

            if selected_event:
                backfill_missing_bib_numbers(session, selected_event.id)
                regs = (
                    session.query(EventRegistration)
                    .filter(EventRegistration.event_id == selected_event.id)
                    .order_by(
                        EventRegistration.created_at.asc(),
                        EventRegistration.id.asc(),
                    )
                    .all()
                )
                registrations = [_registration_ops_payload(r) for r in regs]
                stats = {
                    "total": len(regs),
                    "paid": sum(1 for r in regs if _is_paid(r)),
                    "arrived": sum(1 for r in regs if r.arrived),
                    "race_pack": sum(1 for r in regs if r.race_pack_collected),
                }

        context = {
            "request": request,
            "events": events,
            "selected_event": selected_event,
            "registrations": registrations,
            "stats": stats,
            "title": "Gestionale eventi",
            "update_url": str(request.url_for("admin:ops_update")),
        }
        return await self.templates.TemplateResponse(request, "admin_ops.html", context)

    @expose("/gestionale/update", methods=["POST"], identity="ops_update")
    async def ops_update(self, request: Request) -> object:
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"ok": False, "error": "JSON non valido"}, status_code=400)

        registration_id = body.get("registration_id")
        field = body.get("field")
        value = body.get("value")

        if not registration_id or not str(registration_id).isdigit():
            return JSONResponse(
                {"ok": False, "error": "Iscrizione non valida"}, status_code=400
            )
        if not field:
            return JSONResponse(
                {"ok": False, "error": "Campo mancante"}, status_code=400
            )

        with SessionLocal() as session:
            reg = session.get(EventRegistration, int(registration_id))
            if not reg:
                return JSONResponse(
                    {"ok": False, "error": "Iscrizione non trovata"}, status_code=404
                )

            if field == "payment_status":
                if value not in ("paid", "pending"):
                    return JSONResponse(
                        {"ok": False, "error": "Stato pagamento non valido"},
                        status_code=400,
                    )
                reg.payment_status = value
            elif field == "race_pack_collected":
                reg.race_pack_collected = bool(value)
            elif field == "arrived":
                arrived = bool(value)
                reg.arrived = arrived
                if arrived and not reg.arrived_at:
                    reg.arrived_at = dt_datetime.now(timezone.utc)
                elif not arrived:
                    reg.arrived_at = None
            elif field == "merch_collected":
                if bool(value) and not _has_merch_booked(reg):
                    return JSONResponse(
                        {"ok": False, "error": "Nessun merch prenotato"},
                        status_code=400,
                    )
                reg.merch_collected = bool(value)
            elif field == "bib_number":
                reg.bib_number = str(value).strip()[:20] or None
            else:
                return JSONResponse(
                    {"ok": False, "error": "Campo non consentito"}, status_code=400
                )

            session.commit()
            session.refresh(reg)
            payload = _registration_ops_payload(reg)

        return JSONResponse({"ok": True, "registration": payload})


class AdminStatsView(BaseView):
    name = "Statistiche eventi"
    icon = "fa-solid fa-chart-bar"

    @expose("/event-stats", methods=["GET"], identity="event_stats")
    async def event_stats(self, request: Request) -> object:
        event_id_raw = request.query_params.get("event_id")
        with SessionLocal() as session:
            events = (
                session.query(Event)
                .filter(Event.is_amaro_event == True)
                .order_by(Event.date.desc())
                .all()
            )
            selected_event = None
            stats = None
            if event_id_raw and event_id_raw.isdigit():
                selected_event = session.get(Event, int(event_id_raw))
            elif events:
                selected_event = events[0]

            if selected_event:
                regs = (
                    session.query(EventRegistration)
                    .filter(EventRegistration.event_id == selected_event.id)
                    .all()
                )

                def _count(items: list, key: str, val: object) -> int:
                    return sum(1 for r in items if getattr(r, key) == val)

                def _counter(items: list, key: str) -> dict:
                    result: dict[str, int] = {}
                    for r in items:
                        v = getattr(r, key) or "—"
                        result[v] = result.get(v, 0) + 1
                    return dict(sorted(result.items()))

                def _normalize_text(value: object) -> str:
                    if value is None:
                        return ""
                    return str(value).strip()

                total = len(regs)
                paid = _count(regs, "payment_status", "paid")
                registrations_with_intolerances = [
                    r for r in regs if _normalize_text(r.intolerances)
                ]
                stats = {
                    "total": total,
                    "paid": paid,
                    "unpaid": total - paid,
                    "discipline": _counter(regs, "discipline"),
                    "route": _counter(regs, "route_length"),
                    "lunch": _counter(regs, "lunch_option"),
                    "jersey_gender": _counter(regs, "jersey_gender"),
                    "jersey_size": _counter(regs, "jersey_size"),
                    "medical": sum(1 for r in regs if r.medical_stored_filename),
                    "acsi_fci": sum(1 for r in regs if r.acsi_fci_stored_filename),
                    "intolerances_count": len(registrations_with_intolerances),
                    "intolerances": _counter(
                        registrations_with_intolerances, "intolerances"
                    ),
                }

        context = {
            "request": request,
            "events": events,
            "selected_event": selected_event,
            "stats": stats,
            "title": "Statistiche eventi",
        }
        return await self.templates.TemplateResponse(request, "admin_stats.html", context)

    @expose("/event-stats/export", methods=["GET"], identity="event_stats_export")
    async def event_stats_export(self, request: Request) -> object:
        event_id_raw = request.query_params.get("event_id")
        with SessionLocal() as session:
            selected_event = None
            if event_id_raw and event_id_raw.isdigit():
                selected_event = session.get(Event, int(event_id_raw))
            if not selected_event:
                events = (
                    session.query(Event)
                    .filter(Event.is_amaro_event == True)
                    .order_by(Event.date.desc())
                    .all()
                )
                if events:
                    selected_event = events[0]
            if not selected_event:
                return RedirectResponse(
                    request.url_for("admin:event_stats"), status_code=303
                )

            registrations = (
                session.query(EventRegistration)
                .filter(EventRegistration.event_id == selected_event.id)
                .order_by(EventRegistration.created_at.desc(), EventRegistration.id.desc())
                .all()
            )

            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(
                [
                    "evento",
                    "nome",
                    "cognome",
                    "email",
                    "telefono",
                    "riferimento_pagamento",
                    "stato_pagamento",
                    "importo_totale_eur",
                    "disciplina",
                    "percorso",
                    "pranzo",
                    "ospiti_pranzo",
                    "maglia_genere",
                    "maglia_taglia",
                    "pettorale",
                    "pacco_gara",
                    "arrivato",
                    "ora_arrivo",
                    "merch_consegnato",
                    "intolleranze",
                    "data_iscrizione",
                ]
            )
            for reg in registrations:
                writer.writerow(
                    [
                        selected_event.title,
                        reg.first_name or "",
                        reg.last_name or "",
                        reg.email or "",
                        reg.phone or "",
                        reg.payment_reference or "",
                        reg.payment_status or "pending",
                        f"{(reg.total_amount_cents or 0) / 100:.2f}",
                        reg.discipline or "",
                        reg.route_length or "",
                        reg.lunch_option or "",
                        reg.lunch_guests or "",
                        reg.jersey_gender or "",
                        reg.jersey_size or "",
                        reg.bib_number or "",
                        "si" if reg.race_pack_collected else "no",
                        "si" if reg.arrived else "no",
                        (
                            reg.arrived_at.strftime("%Y-%m-%d %H:%M:%S")
                            if reg.arrived_at
                            else ""
                        ),
                        "si" if reg.merch_collected else "no",
                        (reg.intolerances or "").strip(),
                        (
                            reg.created_at.strftime("%Y-%m-%d %H:%M:%S")
                            if reg.created_at
                            else ""
                        ),
                    ]
                )

        slug = _slugify(selected_event.title or "evento")
        filename = f"iscrizioni_evento_{slug}_{dt_date.today():%Y%m%d}.csv"
        return Response(
            content=output.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )


class MembershipPaymentAdmin(AmaroAdmin, model=MembershipPayment):
    column_list = [
        "id",
        "reference",
        "email",
        "sport_type",
        "amount_cents",
        "status",
        "member_id",
        "created_at",
        "paid_at",
    ]
    column_searchable_list = ["reference", "sport_type", "email"]
    column_sortable_list = ["id", "created_at", "paid_at", "status"]


def setup_admin(app: FastAPI) -> None:
    if not settings.admin_username or not settings.admin_password:
        logger.warning(
            "Admin UI disabled. Set ADMIN_USERNAME and ADMIN_PASSWORD to enable /admin."
        )
        return

    authentication_backend = AdminAuth(secret_key=settings.session_secret)
    admin = Admin(
        app,
        engine,
        authentication_backend=authentication_backend,
        templates_dir=str(BASE_DIR / "admin_templates"),
    )
    admin.add_view(EventAdmin)
    admin.add_view(EventRegistrationAdmin)
    admin.add_view(EventWaitlistEntryAdmin)
    admin.add_view(MerchItemAdmin)
    admin.add_view(MemberAdmin)
    admin.add_view(MemberDocumentAdmin)
    admin.add_view(MembershipPaymentAdmin)
    admin.add_view(AdminToolsView)
    admin.add_view(AdminOpsView)
    admin.add_view(AdminStatsView)
