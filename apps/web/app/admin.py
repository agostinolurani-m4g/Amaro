from __future__ import annotations

import csv
import hashlib
import io
import logging
import os
import re
import secrets
import shutil
import tempfile
import zipfile
from datetime import date as dt_date, datetime as dt_datetime
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI
from sqlalchemy import or_
from sqladmin import Admin, BaseView, ModelView, expose
from sqladmin.authentication import AuthenticationBackend
from starlette.background import BackgroundTask
from starlette.datastructures import UploadFile
from starlette.requests import Request
from starlette.responses import FileResponse, RedirectResponse
from sqlalchemy.orm import Session
from wtforms.validators import DataRequired

from .config import settings
from .database import SessionLocal, engine
from .models import (
    Event,
    Member,
    MemberDocument,
    MembershipPayment,
    MerchItem,
    MEMBERSHIP_STATUS_COMPLETED,
)

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
    member_id: int, uploads: list[UploadFile]
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


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
    cleaned = cleaned.strip("_")
    return cleaned or "file"


def _slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "evento"


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


def _members_pending_acsi(session: Session) -> list[Member]:
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


def _build_acsi_export(members: list[Member]) -> str:
    csv_buffer = io.StringIO(newline="")
    writer = csv.writer(csv_buffer, delimiter=";")
    writer.writerow(
        [
            "ID",
            "Cognome",
            "Nome",
            "Email",
            "Telefono",
            "Data di nascita",
            "Luogo di nascita",
            "Residenza",
            "Codice fiscale",
            "Tipo documento",
            "Numero documento",
            "Codice tessera",
            "Tessera sanitaria",
            "Scadenza certificato medico",
            "Tipo tessera",
            "Disciplina",
            "Messaggio",
            "Documenti",
        ]
    )
    for member in members:
        documents = ", ".join(doc.original_name for doc in member.documents)
        writer.writerow(
            [
                member.id,
                member.last_name,
                member.first_name,
                member.email,
                member.phone or "",
                _format_it_date(member.birth_date),
                member.birth_place or "",
                member.residence or "",
                member.codice_fiscale or "",
                member.document_type or "",
                member.document_number or "",
                member.document_id or "",
                member.tessera_sanitaria or "",
                _format_it_date(member.medical_certificate_expiry),
                member.membership_type,
                member.sport_type or "",
                member.message or "",
                documents,
            ]
        )

    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    temp_path = temp_file.name
    temp_file.close()

    with zipfile.ZipFile(temp_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("acsi_tesseramento.csv", csv_buffer.getvalue())
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

    return temp_path


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
    column_list = ["id", "title", "date", "location", "activity", "is_featured", "slug"]
    column_searchable_list = ["title", "location", "activity"]
    column_sortable_list = ["id", "date", "title", "location", "is_featured"]
    column_labels = {
        "title": "Nome evento",
        "description": "Descrizione",
        "date": "Data",
        "location": "Luogo",
        "activity": "Attivita",
        "is_featured": "In evidenza",
        "slug": "Slug",
        "cover_image_url": "Foto copertina (URL)",
        "gallery_urls": "Foto evento",
    }
    form_columns = [
        "title",
        "description",
        "date",
        "location",
        "activity",
        "is_featured",
        "cover_image_url",
        "gallery_urls",
    ]
    form_args = {
        "title": {"validators": [DataRequired()]},
        "description": {"validators": [DataRequired()]},
        "date": {"validators": [DataRequired()]},
        "location": {"validators": [DataRequired()]},
        "activity": {"validators": [DataRequired()]},
    }
    form_widget_args = {
        "activity": {"placeholder": "Ciclismo, Atletica, Trail, ..."},
        "cover_image_url": {"placeholder": "https://..."},
        "description": {"rows": 6},
        "gallery_urls": {
            "placeholder": "Una foto per riga. Opzionale: URL|didascalia",
            "rows": 5,
        },
    }

    async def on_model_change(
        self, data: dict, model: Event, is_created: bool, request: Request
    ) -> None:
        if not model.slug:
            title = data.get("title") or model.title or ""
            if title:
                base_slug = _slugify(title)
                model.slug = _unique_event_slug(base_slug, model.id)


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
        "created_at",
    ]
    column_searchable_list = ["first_name", "last_name", "email", "codice_fiscale"]
    column_sortable_list = ["id", "created_at", "last_name", "payment_status"]
    form_excluded_columns = ["password_hash", "access_code", "documents"]


class MemberDocumentAdmin(AmaroAdmin, model=MemberDocument):
    column_list = ["id", "member", "original_name", "content_type", "uploaded_at"]
    column_labels = {
        "member": "Socio",
        "member.first_name": "Nome",
        "member.last_name": "Cognome",
    }
    column_searchable_list = [
        "original_name",
        "member.first_name",
        "member.last_name",
    ]
    column_sortable_list = ["id", "uploaded_at"]
    form_excluded_columns = ["member"]
    column_formatters = {
        "member": lambda m, a: (
            f"{m.member.first_name} {m.member.last_name}".strip()
            if getattr(m, "member", None)
            else ""
        )
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
                        uploads = form.getlist("documents")
                        saved_docs = _save_uploaded_documents(member.id, uploads)
                        if saved_docs:
                            session.add_all(saved_docs)
                            session.commit()
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
                    elif action == "upload_card":
                        uploads = form.getlist("documents")
                        saved_docs = _save_uploaded_documents(member.id, uploads)
                        if saved_docs:
                            session.add_all(saved_docs)
                            member.membership_status = MEMBERSHIP_STATUS_COMPLETED
                            session.commit()
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
            pending_members = _members_pending_acsi(session)
            notice = request.session.pop("admin_notice", None)
            password_reset = request.session.pop("admin_password_reset", None)
            if not isinstance(password_reset, dict):
                password_reset = None
            context = {
                "request": request,
                "members": members,
                "pending_members_count": len(pending_members),
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
            members = _members_pending_acsi(session)
            if not members:
                request.session["admin_notice"] = "Nessun socio da inviare ad ACSI."
                return RedirectResponse(request.url_for("admin:tools"), status_code=303)
            export_path = _build_acsi_export(members)
        finally:
            session.close()

        filename = f"acsi_tesseramento_{dt_date.today():%Y%m%d}.zip"
        return FileResponse(
            export_path,
            media_type="application/zip",
            filename=filename,
            background=BackgroundTask(os.unlink, export_path),
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
    admin.add_view(MerchItemAdmin)
    admin.add_view(MemberAdmin)
    admin.add_view(MemberDocumentAdmin)
    admin.add_view(MembershipPaymentAdmin)
    admin.add_view(AdminToolsView)
