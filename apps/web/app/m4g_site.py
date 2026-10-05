from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, Form, HTTPException, Request, status
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from sqlalchemy.orm import Session

from .database import get_session
from .m4g_auth import require_m4g_site_access
from .m4g_common import (
    alt_payment_context,
    build_payment_reference,
    compute_fundraising_stats,
    format_price,
    load_consumption_vouchers,
    parse_payload,
    prepare_nexi_payment,
    redeem_consumption_token,
    expire_stale_bar_orders,
    generate_bar_short_code,
    templates,
)
from .m4g_cms import m4g_bike_distances, m4g_bike_routes_for_map, m4g_photos_2025
from .m4g_cms import (
    cms_menu,
    cms_menu_by_id,
    cms_merch_item,
    cms_merch_items,
    cms_run_route,
    cms_show_bar,
    cms_show_merch,
    cms_vendors,
    route_gpx_file_path,
)
from .m4g_config import ACTIVITIES, LAST_EDITION, M4G_EVENT, REALTA_ADERENTI
from .m4g_share import registration_share_context
from .models import BarOrder, M4gRegistration

logger = logging.getLogger(__name__)

router = APIRouter(tags=["m4g"], dependencies=[Depends(require_m4g_site_access)])


def _payment_failed(request: Request) -> bool:
    return request.query_params.get("payment") == "failed"


def _amount_for_activity(activity: str) -> int:
    if activity == "soccer":
        return int(M4G_EVENT["pricing"]["soccer_team_cents"])
    return int(M4G_EVENT["pricing"]["person_cents"])


def _euro_label(cents: int) -> str:
    if cents % 100 == 0:
        return f"{cents // 100} €"
    return f"{format_price(cents)} €"


def _standard_cents(activity: str) -> int:
    if activity == "donation":
        return int(M4G_EVENT["pricing"]["min_donation_cents"])
    return _amount_for_activity(activity)


def _other_amount_floor_cents(activity: str) -> int:
    pricing = M4G_EVENT["pricing"]
    if activity == "soccer":
        return int(pricing["soccer_other_amount_above_cents"])
    return int(pricing["other_amount_above_cents"])


def amount_picker_context(activity: str) -> dict[str, str]:
    floor = _other_amount_floor_cents(activity)
    return {
        "standard_label": _euro_label(_standard_cents(activity)),
        "other_above_label": _euro_label(floor),
        "custom_min": f"{(floor + 1) / 100:.2f}",
    }


def _checkout_amount(activity: str, amount_mode: str, amount_eur: str) -> int:
    if (amount_mode or "standard").strip() != "custom":
        return _standard_cents(activity)
    cents = _parse_euro_amount(amount_eur)
    floor = _other_amount_floor_cents(activity)
    if cents <= floor:
        raise HTTPException(
            status_code=400,
            detail=f"L'importo libero deve essere superiore a {_euro_label(floor)}",
        )
    return cents


def _activity_label(activity: str) -> str:
    labels = {
        "bike": "Ride for Gaza — Bici",
        "soccer": "Play for Gaza — Calcio",
        "run": "Run for Gaza — Corsa",
        "entrance": "Giornata Solidale — Ingresso",
        "donation": "Move for Gaza — Donazione",
        "merch": "Move for Gaza — Merch",
    }
    return labels.get(activity, "Move for Gaza")


def _parse_euro_amount(raw: str) -> int:
    try:
        euro = float(str(raw).replace(",", ".").strip())
    except ValueError:
        raise HTTPException(status_code=400, detail="Importo non valido") from None
    if euro <= 0:
        raise HTTPException(status_code=400, detail="Importo non valido")
    return int(round(euro * 100))


def _soccer_count(session: Session) -> int:
    try:
        return (
            session.query(M4gRegistration)
            .filter(
                M4gRegistration.activity == "soccer",
                M4gRegistration.payment_status.in_(("paid", "pending")),
                M4gRegistration.hidden.isnot(True),
            )
            .count()
        )
    except Exception:
        logger.exception("Failed to count soccer registrations")
        return 0


def _run_count(session: Session) -> int:
    try:
        return (
            session.query(M4gRegistration)
            .filter(
                M4gRegistration.activity == "run",
                M4gRegistration.payment_status.in_(("paid", "pending")),
                M4gRegistration.hidden.isnot(True),
            )
            .count()
        )
    except Exception:
        logger.exception("Failed to count run registrations")
        return 0


def _soccer_full(session: Session) -> bool:
    return _soccer_count(session) >= int(M4G_EVENT["limits"]["soccer_teams_max"])


def _run_full(session: Session) -> bool:
    return _run_count(session) >= int(M4G_EVENT["limits"]["run_max"])


def _form_payload(request_form: dict[str, Any]) -> dict[str, Any]:
    skip = {"first_name", "last_name", "email", "phone", "csrf"}
    return {k: v for k, v in request_form.items() if k not in skip and v not in (None, "")}


def _start_checkout(
    *,
    activity: str,
    session: Session,
    first_name: str,
    last_name: str,
    email: str,
    phone: str | None,
    payload: dict[str, Any],
    amount_cents: int | None = None,
    amount_mode: str = "standard",
) -> tuple[M4gRegistration, Any]:
    reference = build_payment_reference("M4G")
    cents = amount_cents if amount_cents is not None else _amount_for_activity(activity)
    payload = {
        **payload,
        "amount_mode": "custom" if amount_mode == "custom" else "standard",
    }
    reg = M4gRegistration(
        reference=reference,
        activity=activity,
        first_name=first_name.strip(),
        last_name=last_name.strip(),
        email=email.strip(),
        phone=(phone or "").strip() or None,
        payload_json=json.dumps(payload, ensure_ascii=False),
        amount_cents=cents,
        payment_status="pending",
    )
    session.add(reg)
    session.commit()
    session.refresh(reg)
    payment = prepare_nexi_payment(
        amount_cents=cents,
        reference=reference,
        description=_activity_label(activity),
        email=email.strip() or None,
    )
    return reg, payment


def _render_payment(
    request: Request,
    reg: M4gRegistration,
    payment: Any,
    *,
    amount_updated: bool = False,
) -> HTMLResponse:
    payload = parse_payload(reg.payload_json)
    donate = reg.activity not in ("merch",)
    alt = alt_payment_context(
        amount_cents=reg.amount_cents,
        item_name=_activity_label(reg.activity),
        reference=reg.reference,
        request=request,
        donate=donate,
    )
    return templates.TemplateResponse(
        "m4g_payment.html",
        {
            "request": request,
            "registration": reg,
            "payload": payload,
            "activity_label": _activity_label(reg.activity),
            "total": format_price(reg.amount_cents),
            "reference": reg.reference,
            "payment": payment,
            "price_fn": format_price,
            "amount_updated": amount_updated,
            **alt,
        },
    )


@router.get("/m4g", response_class=HTMLResponse)
@router.get("/m4g/", response_class=HTMLResponse)
def m4g_home(request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    stats = compute_fundraising_stats(session)
    return templates.TemplateResponse(
        "m4g_home.html",
        {
            "request": request,
            "activities": ACTIVITIES,
            "event": M4G_EVENT,
            "photos_2025": m4g_photos_2025(),
            "adherents": REALTA_ADERENTI,
            "stats": stats,
            "price_fn": format_price,
        },
    )


@router.get("/m4g/chi-siamo", response_class=HTMLResponse)
@router.get("/m4g/beneficiario", response_class=HTMLResponse)
def m4g_chi_siamo(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "m4g_beneficiary.html",
        {"request": request, "event": M4G_EVENT, "last": LAST_EDITION},
    )


@router.get("/m4g/donazione", response_class=HTMLResponse)
def m4g_donate_form(request: Request) -> HTMLResponse:
    min_cents = int(M4G_EVENT["pricing"]["min_donation_cents"])
    return templates.TemplateResponse(
        "m4g_donate.html",
        {
            "request": request,
            "event": M4G_EVENT,
            "payment_failed": _payment_failed(request),
            "min_donation": format_price(min_cents),
            "min_donation_cents": min_cents,
            **amount_picker_context("donation"),
        },
    )


@router.post("/m4g/donazione", response_class=HTMLResponse)
async def m4g_donate_submit(
    request: Request,
    session: Session = Depends(get_session),
    first_name: str = Form(""),
    last_name: str = Form(""),
    email: str = Form(""),
    phone: str = Form(""),
    amount_mode: str = Form("standard"),
    amount_eur: str = Form(""),
) -> HTMLResponse:
    if not first_name.strip() or not last_name.strip() or not email.strip():
        raise HTTPException(status_code=400, detail="Compila nome, cognome ed email")
    amount_cents = _checkout_amount("donation", amount_mode, amount_eur)
    reg, payment = _start_checkout(
        activity="donation",
        session=session,
        first_name=first_name,
        last_name=last_name,
        email=email,
        phone=phone,
        payload={"type": "free_donation"},
        amount_cents=amount_cents,
        amount_mode=amount_mode,
    )
    return _render_payment(request, reg, payment)


@router.get("/m4g/merch", response_class=HTMLResponse)
def m4g_merch_form(request: Request) -> HTMLResponse:
    if not cms_show_merch():
        raise HTTPException(status_code=404, detail="Pagina non disponibile")
    unit = int(M4G_EVENT["pricing"]["merch_unit_cents"])
    return templates.TemplateResponse(
        "m4g_merch.html",
        {
            "request": request,
            "event": M4G_EVENT,
            "payment_failed": _payment_failed(request),
            "unit_price": format_price(unit),
            "unit_cents": unit,
            "merch_items": cms_merch_items(),
            "price_fn": format_price,
        },
    )


@router.post("/m4g/merch", response_class=HTMLResponse)
async def m4g_merch_submit(
    request: Request,
    session: Session = Depends(get_session),
    item: str = Form(""),
    first_name: str = Form(""),
    last_name: str = Form(""),
    email: str = Form(""),
    phone: str = Form(""),
    quantity: int = Form(1),
    size: str = Form(""),
    model: str = Form(""),
    notes: str = Form(""),
) -> HTMLResponse:
    if not cms_show_merch():
        raise HTTPException(status_code=404, detail="Pagina non disponibile")
    product = cms_merch_item(item.strip())
    if product is None:
        raise HTTPException(status_code=400, detail="Articolo non valido")
    if not first_name.strip() or not last_name.strip() or not email.strip():
        raise HTTPException(status_code=400, detail="Compila nome, cognome ed email")
    qty = max(1, min(20, quantity))
    if product["sizes"] and size.strip() not in product["sizes"]:
        raise HTTPException(status_code=400, detail="Taglia non valida")
    if product["models"] and model.strip() not in product["models"]:
        raise HTTPException(status_code=400, detail="Modello non valido")
    amount_cents = int(product["price_cents"]) * qty
    reg, payment = _start_checkout(
        activity="merch",
        session=session,
        first_name=first_name,
        last_name=last_name,
        email=email,
        phone=phone,
        payload={
            "item": product["slot"],
            "item_title": product["title"],
            "quantity": qty,
            "size": size.strip(),
            "model": model.strip(),
            "notes": notes.strip(),
        },
        amount_cents=amount_cents,
    )
    return _render_payment(request, reg, payment)


@router.get("/m4g/menu", response_class=HTMLResponse)
def m4g_menu_redirect() -> RedirectResponse:
    return RedirectResponse("/m4g/bar", status_code=302)


@router.get("/m4g/giornata", response_class=HTMLResponse)
def m4g_giornata_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "m4g_giornata.html",
        {"request": request, "event": M4G_EVENT, "vendors": cms_vendors()},
    )


@router.get("/m4g/iscrizione", response_class=HTMLResponse)
def m4g_hub(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "m4g_hub.html",
        {
            "request": request,
            "activities": ACTIVITIES,
            "event": M4G_EVENT,
        },
    )


@router.get("/m4g/bici", response_class=HTMLResponse)
def m4g_bike_form(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "m4g_form_bike.html",
        {
            "request": request,
            "event": M4G_EVENT,
            "payment_failed": _payment_failed(request),
            "price": format_price(_amount_for_activity("bike")),
            **amount_picker_context("bike"),
            "bike_distances": m4g_bike_distances(),
            "bike_routes": m4g_bike_routes_for_map(),
        },
    )


@router.post("/m4g/bici", response_class=HTMLResponse)
async def m4g_bike_submit(
    request: Request,
    session: Session = Depends(get_session),
    first_name: str = Form(""),
    last_name: str = Form(""),
    email: str = Form(""),
    phone: str = Form(""),
    distance: str = Form("112"),
    team_name: str = Form(""),
    level: str = Form(""),
    amount_mode: str = Form("standard"),
    amount_eur: str = Form(""),
) -> HTMLResponse:
    if not first_name.strip() or not last_name.strip() or not email.strip():
        raise HTTPException(status_code=400, detail="Compila nome, cognome ed email")
    reg, payment = _start_checkout(
        activity="bike",
        session=session,
        first_name=first_name,
        last_name=last_name,
        email=email,
        phone=phone,
        payload={
            "distance": distance,
            "team_name": team_name.strip(),
            "level": level.strip(),
        },
        amount_cents=_checkout_amount("bike", amount_mode, amount_eur),
        amount_mode=amount_mode,
    )
    return _render_payment(request, reg, payment)


@router.get("/m4g/calcio", response_class=HTMLResponse)
def m4g_soccer_form(request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    return templates.TemplateResponse(
        "m4g_form_soccer.html",
        {
            "request": request,
            "event": M4G_EVENT,
            "payment_failed": _payment_failed(request),
            "soccer_full": _soccer_full(session),
            "teams_count": _soccer_count(session),
            "price": format_price(_amount_for_activity("soccer")),
            **amount_picker_context("soccer"),
        },
    )


@router.post("/m4g/calcio", response_class=HTMLResponse)
async def m4g_soccer_submit(
    request: Request,
    session: Session = Depends(get_session),
    team_name: str = Form(""),
    captain: str = Form(""),
    email: str = Form(""),
    phone: str = Form(""),
    count: int = Form(6),
    fairplay: str = Form(""),
    amount_mode: str = Form("standard"),
    amount_eur: str = Form(""),
) -> HTMLResponse:
    if _soccer_full(session):
        raise HTTPException(status_code=409, detail="Posti squadre esauriti")
    if not team_name.strip() or not captain.strip() or not email.strip():
        raise HTTPException(status_code=400, detail="Compila squadra, referente ed email")
    if not fairplay:
        raise HTTPException(status_code=400, detail="Accetta il regolamento fair play")
    form = await request.form()
    players = [
        str(form.get(f"player_{i}", "")).strip()
        for i in range(1, 13)
        if str(form.get(f"player_{i}", "")).strip()
    ]
    parts = captain.strip().split(" ", 1)
    reg, payment = _start_checkout(
        activity="soccer",
        session=session,
        first_name=parts[0],
        last_name=parts[1] if len(parts) > 1 else "",
        email=email,
        phone=phone,
        payload={
            "team_name": team_name.strip(),
            "captain": captain.strip(),
            "count": max(5, min(12, count)),
            "players": players,
        },
        amount_cents=_checkout_amount("soccer", amount_mode, amount_eur),
        amount_mode=amount_mode,
    )
    return _render_payment(request, reg, payment)


@router.get("/m4g/corsa", response_class=HTMLResponse)
def m4g_run_form(request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    return templates.TemplateResponse(
        "m4g_form_run.html",
        {
            "request": request,
            "event": M4G_EVENT,
            "payment_failed": _payment_failed(request),
            "run_full": _run_full(session),
            "run_count": _run_count(session),
            "price": format_price(_amount_for_activity("run")),
            **amount_picker_context("run"),
            "run_route": cms_run_route(),
        },
    )


@router.post("/m4g/corsa", response_class=HTMLResponse)
async def m4g_run_submit(
    request: Request,
    session: Session = Depends(get_session),
    name: str = Form(""),
    email: str = Form(""),
    phone: str = Form(""),
    distance: str = Form("7"),
    staffetta: str = Form("no"),
    team_name: str = Form(""),
    waiver: str = Form(""),
    amount_mode: str = Form("standard"),
    amount_eur: str = Form(""),
) -> HTMLResponse:
    if _run_full(session):
        raise HTTPException(status_code=409, detail="Posti corsa esauriti")
    if not name.strip() or not email.strip() or not phone.strip():
        raise HTTPException(status_code=400, detail="Compila nome, email e telefono")
    if not waiver:
        raise HTTPException(status_code=400, detail="Conferma idoneità fisica")
    parts = name.strip().split(" ", 1)
    reg, payment = _start_checkout(
        activity="run",
        session=session,
        first_name=parts[0],
        last_name=parts[1] if len(parts) > 1 else "",
        email=email,
        phone=phone,
        payload={
            "distance": distance,
            "staffetta": staffetta,
            "team_name": team_name.strip(),
        },
        amount_cents=_checkout_amount("run", amount_mode, amount_eur),
        amount_mode=amount_mode,
    )
    return _render_payment(request, reg, payment)


@router.get("/m4g/ingresso", response_class=HTMLResponse)
def m4g_entrance_form(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "m4g_form_entrance.html",
        {
            "request": request,
            "event": M4G_EVENT,
            "payment_failed": _payment_failed(request),
            "price": format_price(_amount_for_activity("entrance")),
            **amount_picker_context("entrance"),
        },
    )


@router.post("/m4g/ingresso", response_class=HTMLResponse)
async def m4g_entrance_submit(
    request: Request,
    session: Session = Depends(get_session),
    first_name: str = Form(""),
    last_name: str = Form(""),
    email: str = Form(""),
    phone: str = Form(""),
    notes: str = Form(""),
    amount_mode: str = Form("standard"),
    amount_eur: str = Form(""),
) -> HTMLResponse:
    if not first_name.strip() or not last_name.strip() or not email.strip():
        raise HTTPException(status_code=400, detail="Compila nome, cognome ed email")
    reg, payment = _start_checkout(
        activity="entrance",
        session=session,
        first_name=first_name,
        last_name=last_name,
        email=email,
        phone=phone,
        payload={"notes": notes.strip()},
        amount_cents=_checkout_amount("entrance", amount_mode, amount_eur),
        amount_mode=amount_mode,
    )
    return _render_payment(request, reg, payment)


@router.post("/m4g/pagamento/{reference}/importo", response_class=HTMLResponse)
def m4g_update_paid_amount(
    request: Request,
    reference: str,
    amount_eur: str = Form(""),
    session: Session = Depends(get_session),
) -> HTMLResponse:
    reg = session.query(M4gRegistration).filter_by(reference=reference).first()
    if not reg or reg.payment_status != "pending" or reg.hidden:
        raise HTTPException(status_code=404, detail="Pagamento non trovato")
    cents = _parse_euro_amount(amount_eur)
    minimum = _standard_cents(reg.activity)
    if cents < minimum:
        raise HTTPException(
            status_code=400,
            detail=f"L'importo versato non può essere inferiore a {_euro_label(minimum)}",
        )
    reg.amount_cents = cents
    session.commit()
    session.refresh(reg)
    payment = prepare_nexi_payment(
        amount_cents=cents,
        reference=reg.reference,
        description=_activity_label(reg.activity),
        email=reg.email,
    )
    return _render_payment(request, reg, payment, amount_updated=True)


@router.get("/m4g/conferma/{token}", response_class=HTMLResponse)
def m4g_confirmation(
    request: Request,
    token: str,
    session: Session = Depends(get_session),
) -> HTMLResponse:
    reg = session.query(M4gRegistration).filter_by(confirmation_token=token).first()
    if not reg or reg.payment_status != "paid":
        raise HTTPException(status_code=404, detail="Conferma non trovata")
    return templates.TemplateResponse(
        "m4g_confirm.html",
        {
            "request": request,
            "registration": reg,
            "payload": parse_payload(reg.payload_json),
            "activity_label": _activity_label(reg.activity),
            "price_fn": format_price,
            **registration_share_context(reg),
        },
    )


# --- Bar e cucina (ordini con carrello) ---


def _parse_cart_json(cart_json: str) -> list[dict[str, Any]]:
    try:
        raw = json.loads(cart_json or "[]")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Carrello non valido") from exc
    if not isinstance(raw, list) or not raw:
        raise HTTPException(status_code=400, detail="Seleziona almeno un articolo")
    normalized: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        item_id = str(entry.get("id", "")).strip()
        catalog = cms_menu_by_id().get(item_id)
        if not catalog:
            raise HTTPException(status_code=400, detail=f"Articolo non valido: {item_id}")
        quantity = int(entry.get("quantity", 0))
        if quantity <= 0:
            continue
        normalized.append(
            {
                "id": item_id,
                "name": str(catalog["name"]),
                "price_cents": int(catalog["price_cents"]),
                "quantity": min(quantity, 50),
            }
        )
    if not normalized:
        raise HTTPException(status_code=400, detail="Seleziona almeno un articolo")
    return normalized


@router.get("/m4g/bar", response_class=HTMLResponse)
def bar_menu_page(request: Request) -> HTMLResponse:
    if not cms_show_bar():
        raise HTTPException(status_code=404, detail="Pagina non disponibile")
    return templates.TemplateResponse(
        "m4g_bar_menu.html",
        {
            "request": request,
            "menu": cms_menu(),
            "event": M4G_EVENT,
            "vendors": cms_vendors(),
            "payment_failed": _payment_failed(request),
            "price_fn": format_price,
        },
    )


@router.post("/m4g/bar/checkout", response_class=HTMLResponse)
def bar_checkout_page(
    request: Request,
    cart_json: str = Form("[]"),
    session: Session = Depends(get_session),
) -> HTMLResponse:
    if not cms_show_bar():
        raise HTTPException(status_code=404, detail="Pagina non disponibile")
    items = _parse_cart_json(cart_json)
    amount_cents = sum(item["price_cents"] * item["quantity"] for item in items)
    reference = build_payment_reference("BAR")
    short_code = generate_bar_short_code(session)
    order = BarOrder(
        reference=reference,
        items_json=json.dumps(items, ensure_ascii=False),
        amount_cents=amount_cents,
        payment_status="pending",
        voucher_status="none",
        short_code=short_code,
    )
    session.add(order)
    session.commit()
    session.refresh(order)
    payment = prepare_nexi_payment(
        amount_cents=amount_cents,
        reference=reference,
        description="Move for Gaza — bar evento",
    )
    alt = alt_payment_context(
        amount_cents=amount_cents,
        item_name="Move for Gaza — Bar & cucina",
        reference=reference,
        request=request,
        donate=False,
    )
    return templates.TemplateResponse(
        "m4g_bar_payment.html",
        {
            "request": request,
            "items": items,
            "total": format_price(amount_cents),
            "reference": reference,
            "short_code": short_code,
            "payment": payment,
            "price_fn": format_price,
            "bar_order_note": True,
            **alt,
        },
    )


@router.get("/m4g/gpx/{route_key}.gpx")
def m4g_download_gpx(route_key: str) -> FileResponse:
    path = route_gpx_file_path(route_key)
    if path is None:
        raise HTTPException(status_code=404, detail="GPX non trovato")
    filename = f"move4gaza-{route_key}.gpx"
    return FileResponse(
        path,
        media_type="application/gpx+xml",
        filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/m4g/bar/{reference}/manual")
def bar_manual_payment_confirm(
    reference: str,
    method: str = Form(""),
    session: Session = Depends(get_session),
) -> RedirectResponse:
    if not cms_show_bar():
        raise HTTPException(status_code=404, detail="Pagina non disponibile")
    order = session.query(BarOrder).filter_by(reference=reference).first()
    if not order or order.payment_status != "pending":
        raise HTTPException(status_code=400, detail="Ordine non valido")
    clean = method.strip().lower()
    if clean not in ("satispay", "paypal"):
        raise HTTPException(status_code=400, detail="Metodo non valido")
    order.payment_method = clean
    order.payment_status = "awaiting_check"
    session.commit()
    return RedirectResponse(
        f"/m4g/ordine/{order.reference}/consumi",
        status_code=302,
    )


@router.get("/m4g/bar/qr", response_class=HTMLResponse)
def bar_qr_page(request: Request) -> HTMLResponse:
    if not cms_show_bar():
        raise HTTPException(status_code=404, detail="Pagina non disponibile")
    base = str(request.base_url).rstrip("/")
    bar_url = f"{base}/m4g/bar"
    qr_url = (
        "https://api.qrserver.com/v1/create-qr-code/?size=320x320&data="
        + quote(bar_url, safe="")
    )
    return templates.TemplateResponse(
        "m4g_bar_qr.html",
        {"request": request, "bar_url": bar_url, "qr_url": qr_url},
    )


@router.get("/m4g/ordine/{reference}/consumi", response_class=HTMLResponse)
def bar_order_consumptions_page(
    request: Request,
    reference: str,
    session: Session = Depends(get_session),
) -> HTMLResponse:
    order = session.query(BarOrder).filter_by(reference=reference).first()
    if not order:
        raise HTTPException(status_code=404, detail="Ordine non trovato")
    if order.payment_status == "awaiting_check":
        try:
            items = json.loads(order.items_json or "[]")
        except json.JSONDecodeError:
            items = []
        return templates.TemplateResponse(
            "m4g_bar_consumptions.html",
            {
                "request": request,
                "order": order,
                "vouchers": [],
                "items": items,
                "pending": True,
                "short_code": order.short_code or "",
                "price_fn": format_price,
            },
        )
    if order.payment_status != "paid":
        raise HTTPException(status_code=404, detail="Ordine non trovato")
    vouchers = load_consumption_vouchers(order)
    if not vouchers:
        raise HTTPException(status_code=404, detail="Nessun banner disponibile")
    return templates.TemplateResponse(
        "m4g_bar_consumptions.html",
        {
            "request": request,
            "order": order,
            "vouchers": vouchers,
            "items": [],
            "pending": False,
            "short_code": order.short_code or "",
            "price_fn": format_price,
        },
    )


@router.get("/m4g/ordine/{reference}/stato")
def bar_order_status(
    reference: str,
    session: Session = Depends(get_session),
) -> JSONResponse:
    order = session.query(BarOrder).filter_by(reference=reference).first()
    if not order:
        raise HTTPException(status_code=404, detail="Ordine non trovato")
    if order.payment_status == "awaiting_check":
        expire_stale_bar_orders(session)
        session.refresh(order)
    payload: dict[str, Any] = {"payment_status": order.payment_status}
    if order.payment_status == "paid":
        payload["consumi_url"] = f"/m4g/ordine/{order.reference}/consumi"
    return JSONResponse(payload)


@router.get("/m4g/voucher/{token}", response_class=HTMLResponse)
def bar_voucher_legacy_redirect(
    token: str,
    session: Session = Depends(get_session),
) -> RedirectResponse:
    order = session.query(BarOrder).filter_by(voucher_token=token).first()
    if not order or order.payment_status != "paid":
        raise HTTPException(status_code=404, detail="Voucher non trovato")
    return RedirectResponse(f"/m4g/ordine/{order.reference}/consumi", status_code=302)


@router.post("/m4g/ordine/{reference}/consumo/{token}/redeem")
def bar_consumption_redeem(
    reference: str,
    token: str,
    session: Session = Depends(get_session),
) -> JSONResponse:
    order = session.query(BarOrder).filter_by(reference=reference).first()
    if not order or order.payment_status != "paid":
        raise HTTPException(status_code=404, detail="Ordine non trovato")
    entry = redeem_consumption_token(order, token, session)
    if not entry:
        raise HTTPException(status_code=404, detail="Banner non trovato")
    return JSONResponse(
        {
            "token": token,
            "reference": reference,
            "status": entry.get("status"),
            "name": entry.get("name"),
        }
    )
