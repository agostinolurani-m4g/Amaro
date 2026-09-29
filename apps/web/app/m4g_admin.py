"""Gestionale Move for Gaza (/m4g/gestione), sempre protetto da password."""

from __future__ import annotations

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse

from .m4g_auth import M4G_SITE_PASSWORD
from .m4g_cms import (
    add_media_file,
    build_menu_from_form,
    build_vendors_from_form,
    cms_gpx_path,
    cms_media_path,
    clear_merch_image,
    clear_route_gpx,
    cms_menu,
    cms_merch_items,
    cms_show_bar,
    cms_show_merch,
    cms_show_total,
    cms_site_public,
    cms_vendors,
    list_cms_media,
    managed_routes,
    remove_media_file,
    save_menu,
    save_merch_item,
    save_route_fields,
    save_vendors,
    set_merch_image,
    set_route_gpx,
    set_page_visibility,
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
def m4g_gestione_page(request: Request) -> HTMLResponse:
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
            "routes": managed_routes(),
            "merch_items": cms_merch_items(),
            "site_public": cms_site_public(),
            "show_bar": cms_show_bar(),
            "show_merch": cms_show_merch(),
            "show_total": cms_show_total(),
            "vendors": cms_vendors(),
            "menu": cms_menu(),
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


@admin_router.post("/m4g/gestione/pages")
def m4g_gestione_pages(
    request: Request,
    show_bar: str = Form(""),
    show_merch: str = Form(""),
    show_total: str = Form(""),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    set_page_visibility(
        show_bar=show_bar in ("1", "true", "on", "yes"),
        show_merch=show_merch in ("1", "true", "on", "yes"),
        show_total=show_total in ("1", "true", "on", "yes"),
    )
    return RedirectResponse("/m4g/gestione?msg=pages", status_code=302)


@admin_router.post("/m4g/gestione/vendors")
def m4g_gestione_vendors(
    request: Request,
    v_id: list[str] = Form(default=[]),
    v_name: list[str] = Form(default=[]),
    v_blurb: list[str] = Form(default=[]),
    v_status: list[str] = Form(default=[]),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    save_vendors(build_vendors_from_form(v_id, v_name, v_blurb, v_status))
    return RedirectResponse("/m4g/gestione?msg=kitchen", status_code=302)


@admin_router.post("/m4g/gestione/menu")
def m4g_gestione_menu(
    request: Request,
    sec_category: list[str] = Form(default=[]),
    sec_vendor: list[str] = Form(default=[]),
    item_section: list[str] = Form(default=[]),
    item_id: list[str] = Form(default=[]),
    item_name: list[str] = Form(default=[]),
    item_price: list[str] = Form(default=[]),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    try:
        sections = build_menu_from_form(
            sec_category,
            sec_vendor,
            item_section,
            item_id,
            item_name,
            item_price,
        )
    except ValueError:
        return RedirectResponse("/m4g/gestione?msg=price", status_code=302)
    save_menu(sections)
    return RedirectResponse("/m4g/gestione?msg=menu", status_code=302)


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


@admin_router.post("/m4g/gestione/merch")
async def m4g_gestione_merch(
    request: Request,
    slot: str = Form(""),
    title: str = Form(""),
    blurb: str = Form(""),
    photo: UploadFile | None = File(None),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    try:
        save_merch_item(slot, title, blurb)
        if photo is not None and photo.filename:
            set_merch_image(slot, photo.filename, await photo.read())
    except ValueError:
        return RedirectResponse("/m4g/gestione?msg=upload", status_code=302)
    return RedirectResponse("/m4g/gestione?msg=merch", status_code=302)


@admin_router.post("/m4g/gestione/merch-photo-reset")
def m4g_gestione_merch_photo_reset(
    request: Request,
    slot: str = Form(""),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    clear_merch_image(slot)
    return RedirectResponse("/m4g/gestione?msg=merch", status_code=302)


@admin_router.post("/m4g/gestione/route")
async def m4g_gestione_route(
    request: Request,
    route_key: str = Form(""),
    title: str = Form(""),
    copy: str = Form(""),
    gpx: UploadFile | None = File(None),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    try:
        save_route_fields(route_key, title, copy)
        if gpx is not None and gpx.filename:
            set_route_gpx(route_key, gpx.filename, await gpx.read())
    except ValueError:
        return RedirectResponse("/m4g/gestione?msg=upload", status_code=302)
    return RedirectResponse("/m4g/gestione?msg=route", status_code=302)


@admin_router.post("/m4g/gestione/route-gpx-reset")
def m4g_gestione_route_gpx_reset(
    request: Request,
    route_key: str = Form(""),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    clear_route_gpx(route_key)
    return RedirectResponse("/m4g/gestione?msg=route", status_code=302)
