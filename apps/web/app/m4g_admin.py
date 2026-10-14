"""Gestionale Move for Gaza (/m4g/gestione), sempre protetto da password."""

from __future__ import annotations

import csv
import io
from collections import Counter
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from sqlalchemy.orm import Session

from . import m4g_auth
from .database import get_session
from .m4g_cms import (
    add_media_file,
    build_adherents_from_form,
    build_menu_from_form,
    build_menu_groups_from_form,
    build_vendors_from_form,
    clear_adherent_logo,
    clear_vendor_logo,
    cms_adherents,
    cms_gpx_path,
    cms_media_path,
    clear_merch_image,
    clear_route_gpx,
    cms_menu,
    cms_menu_groups,
    cms_merch_items,
    cms_show_bar,
    cms_show_merch,
    cms_show_total,
    cms_site_public,
    cms_vendors,
    list_cms_media,
    managed_routes,
    remove_media_file,
    save_adherents,
    save_menu,
    save_menu_groups,
    save_merch_item,
    delete_merch_item,
    save_route_fields,
    save_vendors,
    set_merch_image,
    set_merch_model_image,
    set_route_gpx,
    set_adherent_logo,
    set_vendor_logo,
    set_page_visibility,
    set_site_public,
)
from .m4g_common import (
    bar_orders_awaiting_check,
    bar_orders_awaiting_check_for_kind,
    bar_orders_eligible,
    bar_orders_eligible_for_kind,
    list_food_bar_orders,
    list_merch_bar_orders,
    merch_bar_order_fields,
    order_kind,
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
    return templates.TemplateResponse(
        "m4g_gestione.html",
        {
            "request": request,
            "gestione_page": "resto",
            "media_files": list_cms_media(),
            "routes": managed_routes(),
            "merch_items": cms_merch_items(),
            "site_public": cms_site_public(),
            "show_bar": cms_show_bar(),
            "show_merch": cms_show_merch(),
            "show_total": cms_show_total(),
            "vendors": cms_vendors(),
            "adherents": cms_adherents(),
            "menu": cms_menu(),
            "menu_groups": cms_menu_groups(),
            "message": request.query_params.get("msg"),
            **_admin_dashboard(session),
        },
    )


def _order_status_labels() -> dict[str, str]:
    return {
        "paid": "Pagato",
        "pending": "In attesa",
        "unpaid": "Non pagata",
        "awaiting_check": "Da verificare",
        "rejected": "Rifiutato",
        "expired": "Scaduto",
        "failed": "Fallito",
    }


@admin_router.get("/m4g/gestione/ordini", response_class=HTMLResponse, response_model=None)
def m4g_gestione_ordini(
    request: Request,
    session: Session = Depends(get_session),
) -> RedirectResponse | HTMLResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    reg_q = request.query_params.get("reg_q", "")
    merch_q = request.query_params.get("merch_q", "")
    cibo_q = request.query_params.get("cibo_q", "")
    show_hidden = request.query_params.get("show_hidden") == "1"
    return templates.TemplateResponse(
        "m4g_gestione_ordini.html",
        {
            "request": request,
            "gestione_page": "ordini",
            "message": request.query_params.get("msg"),
            "registrations": list_m4g_registrations(
                session, reg_q, hidden=show_hidden, exclude_activity="merch"
            ),
            "merch_orders": list_merch_bar_orders(session, merch_q),
            "food_orders": list_food_bar_orders(session, cibo_q),
            "show_hidden": show_hidden,
            "activity_labels": {
                "bike": "Bici",
                "soccer": "Calcio",
                "run": "Corsa",
                "entrance": "Ingresso",
                "donation": "Donazione",
                "merch": "Merch",
            },
            "status_labels": _order_status_labels(),
            "when_fn": format_rome,
            "detail_fn": registration_signup_detail,
            "lines_fn": merch_bar_order_fields,
            "price_fn": format_price,
            "reg_q": reg_q,
            "merch_q": merch_q,
            "cibo_q": cibo_q,
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


@admin_router.post("/m4g/gestione/menu-groups")
def m4g_gestione_menu_groups(
    request: Request,
    tab_id: list[str] = Form(default=[]),
    tab_label: list[str] = Form(default=[]),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    save_menu_groups(build_menu_groups_from_form(tab_id, tab_label))
    return RedirectResponse("/m4g/gestione?msg=menu-tabs#cms-menu", status_code=302)


@admin_router.post("/m4g/gestione/menu")
def m4g_gestione_menu(
    request: Request,
    sec_category: list[str] = Form(default=[]),
    sec_vendor: list[str] = Form(default=[]),
    sec_kind: list[str] = Form(default=[]),
    item_section: list[str] = Form(default=[]),
    item_id: list[str] = Form(default=[]),
    item_name: list[str] = Form(default=[]),
    item_price: list[str] = Form(default=[]),
    item_vendor: list[str] = Form(default=[]),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    try:
        sections = build_menu_from_form(
            sec_category,
            sec_vendor,
            sec_kind,
            item_section,
            item_id,
            item_name,
            item_price,
            item_vendor,
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
    price_eur: str = Form(""),
    sizes: str = Form(""),
    models: str = Form(""),
    photo: UploadFile | None = File(None),
    model_photo: list[UploadFile] = File(default=[]),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    price = _parse_admin_euro(price_eur) if price_eur.strip() else None
    if price_eur.strip() and price is None:
        return RedirectResponse("/m4g/gestione?msg=price#cms-merch", status_code=302)
    try:
        item_id = save_merch_item(slot, title, blurb, price, sizes, models)
        if photo is not None and photo.filename:
            set_merch_image(item_id, photo.filename, await photo.read())
        for index, upload in enumerate(model_photo):
            if not upload.filename:
                continue
            set_merch_model_image(item_id, index, upload.filename, await upload.read())
    except ValueError:
        return RedirectResponse("/m4g/gestione?msg=upload#cms-merch", status_code=302)
    return RedirectResponse("/m4g/gestione?msg=merch#cms-merch", status_code=302)


@admin_router.post("/m4g/gestione/merch-delete")
def m4g_gestione_merch_delete(
    request: Request,
    slot: str = Form(""),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    if slot.strip():
        delete_merch_item(slot.strip())
    return RedirectResponse("/m4g/gestione?msg=merch#cms-merch", status_code=302)


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
    kind = (request.query_params.get("kind") or "bar").strip().lower()
    if kind not in ("bar", "merch"):
        kind = "bar"
    awaiting = bar_orders_awaiting_check_for_kind(session, kind)
    eligible = bar_orders_eligible_for_kind(session, kind)
    return templates.TemplateResponse(
        "m4g_gestione_cassa.html",
        {
            "request": request,
            "gestione_page": "cassa",
            "kind": kind,
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
        kind = order_kind(order)
        return RedirectResponse(
            f"/m4g/gestione/cassa?kind={kind}&msg=paid", status_code=302
        )
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
    kind = "bar"
    if order:
        kind = order_kind(order)
        reject_bar_order(order, session)
    return RedirectResponse(
        f"/m4g/gestione/cassa?kind={kind}&msg=rejected", status_code=302
    )


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
    anchor = _registration_section_anchor(reg)
    return RedirectResponse(f"/m4g/gestione/ordini?msg=reg-paid#{anchor}", status_code=302)


@admin_router.post("/m4g/gestione/registration-send-email")
def m4g_gestione_registration_send_email(
    request: Request,
    reference: str = Form(""),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    ref = reference.strip()
    reg = session.query(M4gRegistration).filter_by(reference=ref).first()
    anchor = _registration_section_anchor(reg)
    if not reg or reg.payment_status != "paid" or reg.paid_email_sent_at is not None:
        return RedirectResponse(f"/m4g/gestione/ordini?msg=reg-email-skip#{anchor}", status_code=302)
    if not (reg.email or "").strip():
        return RedirectResponse(f"/m4g/gestione/ordini?msg=reg-email-noaddr#{anchor}", status_code=302)
    from . import m4g_mail

    ok = m4g_mail.send_paid_confirmation(reg, session)
    msg = "reg-email-ok" if ok else "reg-email-fail"
    return RedirectResponse(f"/m4g/gestione/ordini?msg={msg}#{anchor}", status_code=302)


def _parse_admin_euro(raw: str) -> int | None:
    try:
        euro = float(str(raw).replace("€", "").replace(" ", "").replace(",", ".").strip())
    except ValueError:
        return None
    if euro <= 0:
        return None
    return int(round(euro * 100))


def _registration_section_anchor(reg: M4gRegistration | None) -> str:
    if reg is not None and reg.activity == "merch":
        return "cms-ordini"
    return "cms-iscrizioni"


def _registration_list_redirect(
    show_hidden: str,
    msg: str,
    *,
    anchor: str = "cms-iscrizioni",
    reg_q: str = "",
    merch_q: str = "",
) -> RedirectResponse:
    parts = [f"msg={msg}"]
    if show_hidden in ("1", "true", "on"):
        parts.append("show_hidden=1")
    if anchor == "cms-ordini" and merch_q.strip():
        parts.append(f"merch_q={quote(merch_q.strip())}")
    elif reg_q.strip():
        parts.append(f"reg_q={quote(reg_q.strip())}")
    return RedirectResponse(
        f"/m4g/gestione/ordini?{'&'.join(parts)}#{anchor}",
        status_code=302,
    )


@admin_router.post("/m4g/gestione/registration-amount")
def m4g_gestione_registration_amount(
    request: Request,
    reference: str = Form(""),
    amount_eur: str = Form(""),
    show_hidden: str = Form(""),
    reg_q: str = Form(""),
    merch_q: str = Form(""),
    from_merch: str = Form(""),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    reg = session.query(M4gRegistration).filter_by(reference=reference.strip()).first()
    anchor = (
        "cms-ordini"
        if from_merch in ("1", "true", "on")
        else _registration_section_anchor(reg)
    )
    cents = _parse_admin_euro(amount_eur)
    if cents is None:
        return _registration_list_redirect(
            show_hidden, "amount", anchor=anchor, reg_q=reg_q, merch_q=merch_q
        )
    if reg:
        reg.amount_cents = cents
        session.commit()
        anchor = _registration_section_anchor(reg)
    return _registration_list_redirect(
        show_hidden, "amount-ok", anchor=anchor, reg_q=reg_q, merch_q=merch_q
    )


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
    anchor = _registration_section_anchor(reg)
    return RedirectResponse(f"/m4g/gestione/ordini?msg=reg-hidden#{anchor}", status_code=302)


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
    anchor = _registration_section_anchor(reg)
    return RedirectResponse(f"/m4g/gestione/ordini?msg=reg-restored#{anchor}", status_code=302)


@admin_router.post("/m4g/gestione/adherents")
def m4g_gestione_adherents(
    request: Request,
    a_id: list[str] = Form(default=[]),
    a_name: list[str] = Form(default=[]),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    save_adherents(build_adherents_from_form(a_id, a_name))
    return RedirectResponse("/m4g/gestione?msg=adherents#cms-adherenti", status_code=302)


@admin_router.post("/m4g/gestione/adherent-logo")
async def m4g_gestione_adherent_logo(
    request: Request,
    adherent_id: str = Form(""),
    logo: UploadFile | None = File(None),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    if logo is None or not logo.filename:
        return RedirectResponse("/m4g/gestione?msg=upload#cms-adherenti", status_code=302)
    try:
        set_adherent_logo(adherent_id, logo.filename, await logo.read())
    except ValueError:
        return RedirectResponse("/m4g/gestione?msg=upload#cms-adherenti", status_code=302)
    return RedirectResponse("/m4g/gestione?msg=logo#cms-adherenti", status_code=302)


@admin_router.post("/m4g/gestione/adherent-logo-reset")
def m4g_gestione_adherent_logo_reset(
    request: Request,
    adherent_id: str = Form(""),
) -> RedirectResponse:
    denied = _require_admin(request)
    if denied:
        return denied
    clear_adherent_logo(adherent_id)
    return RedirectResponse("/m4g/gestione?msg=logo#cms-adherenti", status_code=302)


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


@admin_router.get("/m4g/gestione/export/merch.csv", response_model=None)
def m4g_export_merch(
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
            "created_at",
            "reference",
            "product",
            "model",
            "size",
            "quantity",
            "notes",
            "first_name",
            "last_name",
            "email",
            "phone",
            "amount_eur",
            "payment_status",
            "short_code",
            "order_email_sent_at",
        ]
    )
    for order in (
        session.query(BarOrder)
        .filter(BarOrder.kind == "merch")
        .order_by(BarOrder.created_at.desc())
    ):
        fields = merch_bar_order_fields(order)
        writer.writerow(
            [
                order.created_at,
                order.reference,
                fields["product"],
                fields["model"],
                fields["size"],
                fields["quantity"],
                fields["notes"],
                "",
                "",
                order.email or "",
                "",
                f"{(order.amount_cents or 0) / 100:.2f}",
                order.payment_status,
                order.short_code or "",
                order.order_email_sent_at or "",
            ]
        )
    buffer.seek(0)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="m4g-merch.csv"'},
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
