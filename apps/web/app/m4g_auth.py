"""Accesso al sito Move for Gaza (anteprima protetta da password)."""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

M4G_SITE_PASSWORD = os.environ.get("M4G_SITE_PASSWORD", "zipangulo")
M4G_SESSION_KEY = "m4g_site_unlocked"

BASE_DIR = Path(__file__).resolve().parent
_access_templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

access_router = APIRouter(tags=["m4g-access"])


class M4gLoginRequired(Exception):
    def __init__(self, next_url: str) -> None:
        self.next_url = next_url


def m4g_site_unlocked(request: Request) -> bool:
    return bool(request.session.get(M4G_SESSION_KEY))


def m4g_access_redirect(next_url: str) -> RedirectResponse:
    return RedirectResponse(
        url=f"/m4g/access?next={quote(next_url, safe='/?&=')}",
        status_code=302,
    )


async def require_m4g_site_access(request: Request) -> None:
    if m4g_site_unlocked(request):
        return
    next_url = request.url.path
    if request.url.query:
        next_url = f"{next_url}?{request.url.query}"
    raise M4gLoginRequired(next_url)


@access_router.get("/m4g/access", response_model=None)
def m4g_access_page(request: Request):
    if m4g_site_unlocked(request):
        next_path = request.query_params.get("next") or "/m4g/"
        if not next_path.startswith("/m4g"):
            next_path = "/m4g/"
        return RedirectResponse(next_path, status_code=302)
    return _access_templates.TemplateResponse(
        "m4g_access.html",
        {
            "request": request,
            "error": request.query_params.get("error"),
            "next": request.query_params.get("next") or "/m4g/",
        },
    )


@access_router.post("/m4g/access", response_class=HTMLResponse)
def m4g_access_submit(
    request: Request,
    password: str = Form(""),
    next: str = Form("/m4g/"),
) -> RedirectResponse:
    if password.strip() == M4G_SITE_PASSWORD:
        request.session[M4G_SESSION_KEY] = True
        safe_next = next if next.startswith("/m4g") else "/m4g/"
        return RedirectResponse(safe_next, status_code=302)
    return m4g_access_redirect(next if next.startswith("/m4g") else "/m4g/")
