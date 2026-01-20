from __future__ import annotations

import hashlib
import logging
import secrets
import shutil
from datetime import date as dt_date, datetime as dt_datetime
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI
from sqladmin import Admin, BaseView, ModelView, expose
from sqladmin.authentication import AuthenticationBackend
from starlette.datastructures import UploadFile
from starlette.requests import Request
from starlette.responses import RedirectResponse

from .config import settings
from .database import SessionLocal, engine
from .models import Event, Member, MemberDocument, MembershipPayment, MerchItem

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
    column_list = ["id", "title", "slug", "date", "location"]
    column_searchable_list = ["title", "slug", "location"]
    column_sortable_list = ["id", "date", "title"]


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
            notice = request.session.pop("admin_notice", None)
            password_reset = request.session.pop("admin_password_reset", None)
            if not isinstance(password_reset, dict):
                password_reset = None
            context = {
                "request": request,
                "members": members,
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
