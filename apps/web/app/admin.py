from __future__ import annotations

import logging

from fastapi import FastAPI
from sqladmin import Admin, ModelView
from sqladmin.authentication import AuthenticationBackend
from starlette.requests import Request

from .config import settings
from .database import engine
from .models import Event, Member, MemberDocument, MerchItem

logger = logging.getLogger(__name__)


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


class EventAdmin(ModelView, model=Event):
    column_list = ["id", "title", "slug", "date", "location"]
    column_searchable_list = ["title", "slug", "location"]
    column_sortable_list = ["id", "date", "title"]


class MerchItemAdmin(ModelView, model=MerchItem):
    column_list = ["id", "name", "slug", "price_cents", "stock", "image_url"]
    column_searchable_list = ["name", "slug"]
    column_sortable_list = ["id", "name", "price_cents", "stock"]


class MemberAdmin(ModelView, model=Member):
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


class MemberDocumentAdmin(ModelView, model=MemberDocument):
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


def setup_admin(app: FastAPI) -> None:
    if not settings.admin_username or not settings.admin_password:
        logger.warning(
            "Admin UI disabled. Set ADMIN_USERNAME and ADMIN_PASSWORD to enable /admin."
        )
        return

    authentication_backend = AdminAuth(secret_key=settings.session_secret)
    admin = Admin(app, engine, authentication_backend=authentication_backend)
    admin.add_view(EventAdmin)
    admin.add_view(MerchItemAdmin)
    admin.add_view(MemberAdmin)
    admin.add_view(MemberDocumentAdmin)
