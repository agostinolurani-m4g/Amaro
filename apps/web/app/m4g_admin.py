"""Gestionale Move for Gaza (/m4g/gestione), sempre protetto da password."""

from __future__ import annotations

import csv
import io
from collections import Counter

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from sqlalchemy.orm import Session

from . import m4g_auth
from .database import get_session
from .m4g_cms import (
    add_media_file,
    build_menu_from_form,
    build_vendors_from_form,
    clear_vendor_logo,
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
    set_vendor_logo,
    set_page_visibility,
    set_site_public,
)
from .m4g_common import (
    bar_orders_awaiting_check,
    bar_orders_eligible,
    compute_fundraising_stats,
    format_price,
    format_rome,
    mark_bar_order_paid,
    mark_registration_paid,
    hide_registration_unpaid,
    list_m4g_registrations,
    registration_signup_detail,
    restore_registration,
    reject_bar_order,
    templates,
)
from .models import BarOrder, M4gRegistration

M4G_ADMIN_SESSION_KEY = "m4g_admin_unlocked"

admin_router = APIRouter(tags=["m4g-admin"])

M4G_ACTIVITIES = ("bike", "soccer", "run", "entrance", "donation", "merch")


def _admin_dashboard(session: Session) -> dict:
    stats = compute_fundraising_stats(session)
    awaiting = bar_orders_awaiting_check(session)
    eligible = bar_orders_eligible(session)
    reg_counts: dict[str, dict[str, int]] = {}
    for activity in M4G_ACTIVITIES:
        reg_counts[activity] = {
            "paid": session.query(M4gRegistration)
            .filter_by(activity=activity, payment_status="paid")
            .filter(M4gRegistration.hidden.isnot(True))
            .count(),
            "pending": session.query(M4gRegistration)
            .filter_by(activity=activity, payment_status="pending")
            .filter(M4gRegistration.hidden.isnot(True))
            .count(),
        }
    bar_status = Counter(
        row[0]
        for row in session.query(BarOrder.payment_status).all()
    )
    return {
        "stats": stats,
        "awaiting_count": len(awaiting),
        "eligible_count": len(eligible),
        "reg_counts": reg_counts,
        "bar_status": dict(bar_status),
        "price_fn": format_price,
    }


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
def m4g_gestione_page(
    request: Request,
    session: Session = Depends(get_session),
) -> HTMLResponse:
    if not m4g_admin_unlocked(request):
        return templates.TemplateResponse(
            "m4g_gestione_login.html",
            {
                "request": request,
                "error": request.query_params.get("error"),
            },
        )
    reg_q = request.query_params.get("reg_q", "")
    show_hidden = request.query_params.get("show_hidden") == "1"
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
            "registrations": list_m4g_registrations(
                session, reg_q, hidden=show_hidden
            ),
            "show_hidden": show_hidden,
            "activity_labels": {
                "bike": "Bici",
                "soccer": "Calcio",
                "run": "Corsa",
                "entrance": "Ingresso",
                "donation": "Donazione",
                "merch": "Merch",
            },
            "status_labels": {
                "paid": "Pagato",
                "pending": "In attesa",
                "unpaid": "Non pagata",
            },
            "when_fn": format_rome,
            "detail_fn": registration_signup_detail,
            "reg_q": reg_q,
            **_admin_dashboard(session),
        },
    )


@admin_router.post("/m4g/gestione/login")
def m4g_gestione_login(
    request: Request,
    password: str = Form(""),
) -> RedirectResponse:
    if password.strip() == m4g_auth.M4G_ADMIN_PASSWORD:
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


@admin_router.get("/m4g/gestione/cassa", response_class=HTMLResponse, response_model=None)
def m4g_gestione_cassa(
    request: Request,
    session: Session = Depends(get_session),
) -> RedirectResponse | HTMLResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    awaiting = bar_orders_awaiting_check(session)
    eligible = bar_orders_eligible(session)
    return templates.TemplateResponse(
        "m4g_gestione_cassa.html",
        {
            "request": request,
            "awaiting": awaiting,
            "eligible": eligible,
            "price_fn": format_price,
            "message": request.query_params.get("msg"),
        },
    )


@admin_router.post("/m4g/gestione/bar-paid")
def m4g_gestione_bar_paid(
    request: Request,
    reference: str = Form(""),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    order = session.query(BarOrder).filter_by(reference=reference.strip()).first()
    if order and order.payment_status == "awaiting_check":
        mark_bar_order_paid(order, session)
    return RedirectResponse("/m4g/gestione/cassa?msg=paid", status_code=302)


@admin_router.post("/m4g/gestione/bar-reject")
def m4g_gestione_bar_reject(
    request: Request,
    reference: str = Form(""),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    order = session.query(BarOrder).filter_by(reference=reference.strip()).first()
    if order:
        reject_bar_order(order, session)
    return RedirectResponse("/m4g/gestione/cassa?msg=rejected", status_code=302)


@admin_router.post("/m4g/gestione/registration-paid")
def m4g_gestione_registration_paid(
    request: Request,
    reference: str = Form(""),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    reg = session.query(M4gRegistration).filter_by(reference=reference.strip()).first()
    if reg and reg.payment_status == "pending":
        mark_registration_paid(reg, session)
    return RedirectResponse("/m4g/gestione?msg=reg-paid", status_code=302)


def _parse_admin_euro(raw: str) -> int | None:
    try:
        euro = float(str(raw).replace("€", "").replace(" ", "").replace(",", ".").strip())
    except ValueError:
        return None
    if euro <= 0:
        return None
    return int(round(euro * 100))


def _registration_list_redirect(show_hidden: str, msg: str) -> RedirectResponse:
    hidden = "&show_hidden=1" if show_hidden in ("1", "true", "on") else ""
    return RedirectResponse(
        f"/m4g/gestione?msg={msg}{hidden}#cms-iscrizioni",
        status_code=302,
    )


@admin_router.post("/m4g/gestione/registration-amount")
def m4g_gestione_registration_amount(
    request: Request,
    reference: str = Form(""),
    amount_eur: str = Form(""),
    show_hidden: str = Form(""),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    cents = _parse_admin_euro(amount_eur)
    if cents is None:
        return _registration_list_redirect(show_hidden, "amount")
    reg = session.query(M4gRegistration).filter_by(reference=reference.strip()).first()
    if reg:
        reg.amount_cents = cents
        session.commit()
    return _registration_list_redirect(show_hidden, "amount-ok")


@admin_router.post("/m4g/gestione/registration-hide")
def m4g_gestione_registration_hide(
    request: Request,
    reference: str = Form(""),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    reg = session.query(M4gRegistration).filter_by(reference=reference.strip()).first()
    if reg:
        hide_registration_unpaid(reg, session)
    return RedirectResponse("/m4g/gestione?msg=reg-hidden#cms-iscrizioni", status_code=302)


@admin_router.post("/m4g/gestione/registration-restore")
def m4g_gestione_registration_restore(
    request: Request,
    reference: str = Form(""),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    reg = session.query(M4gRegistration).filter_by(reference=reference.strip()).first()
    if reg:
        restore_registration(reg, session)
    return RedirectResponse("/m4g/gestione?msg=reg-restored#cms-iscrizioni", status_code=302)


@admin_router.post("/m4g/gestione/vendor-logo")
async def m4g_gestione_vendor_logo(
    request: Request,
    vendor_id: str = Form(""),
    logo: UploadFile | None = File(None),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    if logo is None or not logo.filename:
        return RedirectResponse("/m4g/gestione?msg=upload", status_code=302)
    try:
        set_vendor_logo(vendor_id, logo.filename, await logo.read())
    except ValueError:
        return RedirectResponse("/m4g/gestione?msg=upload", status_code=302)
    return RedirectResponse("/m4g/gestione?msg=logo", status_code=302)


@admin_router.post("/m4g/gestione/vendor-logo-reset")
def m4g_gestione_vendor_logo_reset(
    request: Request,
    vendor_id: str = Form(""),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    clear_vendor_logo(vendor_id)
    return RedirectResponse("/m4g/gestione?msg=logo", status_code=302)


@admin_router.get("/m4g/gestione/export/iscrizioni.csv", response_model=None)
def m4g_export_registrations(
    request: Request,
    session: Session = Depends(get_session),
) -> RedirectResponse | StreamingResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "reference",
            "activity",
            "first_name",
            "last_name",
            "email",
            "phone",
            "amount_eur",
            "payment_status",
            "hidden",
            "created_at",
        ]
    )
    for reg in session.query(M4gRegistration).order_by(M4gRegistration.id):
        writer.writerow(
            [
                reg.reference,
                reg.activity,
                reg.first_name or "",
                reg.last_name or "",
                reg.email or "",
                reg.phone or "",
                f"{(reg.amount_cents or 0) / 100:.2f}",
                reg.payment_status,
                "1" if reg.hidden else "0",
                reg.created_at,
            ]
        )
    buffer.seek(0)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="m4g-iscrizioni.csv"'},
    )


@admin_router.get("/m4g/gestione/export/bar.csv", response_model=None)
def m4g_export_bar(
    request: Request,
    session: Session = Depends(get_session),
) -> RedirectResponse | StreamingResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "reference",
            "short_code",
            "amount_eur",
            "payment_method",
            "payment_status",
            "items_json",
            "created_at",
            "paid_at",
        ]
    )
    for order in session.query(BarOrder).order_by(BarOrder.id):
        writer.writerow(
            [
                order.reference,
                order.short_code or "",
                f"{(order.amount_cents or 0) / 100:.2f}",
                order.payment_method or "",
                order.payment_status,
                order.items_json,
                order.created_at,
                order.paid_at,
            ]
        )
    buffer.seek(0)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="m4g-bar.csv"'},
    )
