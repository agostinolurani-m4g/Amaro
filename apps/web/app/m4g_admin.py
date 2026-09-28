"""Gestionale Move for Gaza (/m4g/gestione), sempre protetto da password."""

from __future__ import annotations

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse

from .m4g_auth import M4G_SITE_PASSWORD
from .m4g_cms import (
    add_gpx_file,
    add_media_file,
    cms_gpx_path,
    cms_media_path,
    cms_site_public,
    list_cms_gpx_routes,
    list_cms_media,
    remove_gpx_route,
    remove_media_file,
    set_site_public,
)
from .m4g_common import templates

M4G_ADMIN_SESSION_KEY = "m4g_admin_unlocked"

admin_router = APIRouter(tags=["m4g-admin"])


def m4g_admin_unlocked(request: Request) -> bool:
    return bool(request.session.get(M4G_ADMIN_SESSION_KEY))


def _require_admin(request: Request) -> RedirectResponse | None:
    if m4g_admin_unlocked(request):
        return None
    return RedirectResponse("/m4g/gestione?error=login", status_code=302)


@admin_router.get("/m4g/cms/media/{filename}")
def m4g_serve_cms_media(filename: str) -> FileResponse:
    path = cms_media_path(filename)
    if path is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=404)
    media_type = "image/jpeg"
    ext = path.suffix.lower()
    if ext == ".png":
        media_type = "image/png"
    elif ext == ".webp":
        media_type = "image/webp"
    elif ext == ".gif":
        media_type = "image/gif"
    return FileResponse(path, media_type=media_type)


@admin_router.get("/m4g/cms/routes/{filename}")
def m4g_serve_cms_gpx(filename: str) -> FileResponse:
    path = cms_gpx_path(filename)
    if path is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=404)
    return FileResponse(
        path,
        media_type="application/gpx+xml",
        filename=path.name,
    )


@admin_router.get("/m4g/gestione", response_class=HTMLResponse)
def m4g_gestione_page(request: Request) -> HTMLResponse | RedirectResponse:
    if not m4g_admin_unlocked(request):
        return templates.TemplateResponse(
            "m4g_gestione_login.html",
            {
                "request": request,
                "error": request.query_params.get("error"),
            },
        )
    return templates.TemplateResponse(
        "m4g_gestione.html",
        {
            "request": request,
            "media_files": list_cms_media(),
            "gpx_routes": list_cms_gpx_routes(),
            "site_public": cms_site_public(),
            "message": request.query_params.get("msg"),
        },
    )


@admin_router.post("/m4g/gestione/login")
def m4g_gestione_login(
    request: Request,
    password: str = Form(""),
) -> RedirectResponse:
    if password.strip() == M4G_SITE_PASSWORD:
        request.session[M4G_ADMIN_SESSION_KEY] = True
        return RedirectResponse("/m4g/gestione", status_code=302)
    return RedirectResponse("/m4g/gestione?error=bad", status_code=302)


@admin_router.post("/m4g/gestione/logout")
def m4g_gestione_logout(request: Request) -> RedirectResponse:
    request.session.pop(M4G_ADMIN_SESSION_KEY, None)
    return RedirectResponse("/m4g/gestione", status_code=302)


@admin_router.post("/m4g/gestione/site-public")
def m4g_gestione_site_public(
    request: Request,
    enabled: str = Form("0"),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    set_site_public(enabled in ("1", "true", "on", "yes"))
    msg = "live" if cms_site_public() else "preview"
    return RedirectResponse(f"/m4g/gestione?msg={msg}", status_code=302)


@admin_router.post("/m4g/gestione/upload-media")
async def m4g_gestione_upload_media(
    request: Request,
    files: list[UploadFile] = File(default=[]),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    uploaded = 0
    for upload in files:
        if not upload.filename:
            continue
        data = await upload.read()
        try:
            add_media_file(upload.filename, data)
            uploaded += 1
        except ValueError:
            continue
    return RedirectResponse(
        f"/m4g/gestione?msg=media-{uploaded}",
        status_code=302,
    )


@admin_router.post("/m4g/gestione/delete-media")
def m4g_gestione_delete_media(
    request: Request,
    stored_name: str = Form(""),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    if stored_name:
        remove_media_file(stored_name)
    return RedirectResponse("/m4g/gestione?msg=deleted-media", status_code=302)


@admin_router.post("/m4g/gestione/upload-gpx")
async def m4g_gestione_upload_gpx(
    request: Request,
    files: list[UploadFile] = File(default=[]),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    uploaded = 0
    for upload in files:
        if not upload.filename:
            continue
        data = await upload.read()
        try:
            add_gpx_file(upload.filename, data)
            uploaded += 1
        except ValueError:
            continue
    return RedirectResponse(
        f"/m4g/gestione?msg=gpx-{uploaded}",
        status_code=302,
    )


@admin_router.post("/m4g/gestione/delete-gpx")
def m4g_gestione_delete_gpx(
    request: Request,
    route_key: str = Form(""),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    if route_key:
        remove_gpx_route(route_key)
    return RedirectResponse("/m4g/gestione?msg=deleted-gpx", status_code=302)
