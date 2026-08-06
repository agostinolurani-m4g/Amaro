from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, Form, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse
from sqlalchemy.orm import Session

from .database import get_session
from .m4g_common import (
    build_payment_reference,
    format_price,
    parse_payload,
    prepare_nexi_payment,
    templates,
)
from .m4g_config import ACTIVITIES, M4G_EVENT
from .m4g_menu import BAR_MENU, MENU_BY_ID
from .models import BarOrder, M4gRegistration

logger = logging.getLogger(__name__)

router = APIRouter(tags=["m4g"])


def _payment_failed(request: Request) -> bool:
    return request.query_params.get("payment") == "failed"


def _amount_for_activity(activity: str) -> int:
    if activity == "soccer":
        return int(M4G_EVENT["pricing"]["soccer_team_cents"])
    return int(M4G_EVENT["pricing"]["person_cents"])


def _activity_label(activity: str) -> str:
    labels = {
        "bike": "Ride4Gaza — Bici",
        "soccer": "Play4Gaza — Calcio",
        "run": "Run4Gaza — Corsa",
        "entrance": "Support4Gaza — Ingresso",
    }
    return labels.get(activity, "Move for Gaza")


def _soccer_count(session: Session) -> int:
    return (
        session.query(M4gRegistration)
        .filter(
            M4gRegistration.activity == "soccer",
            M4gRegistration.payment_status.in_(("paid", "pending")),
        )
        .count()
    )


def _run_count(session: Session) -> int:
    return (
        session.query(M4gRegistration)
        .filter(
            M4gRegistration.activity == "run",
            M4gRegistration.payment_status.in_(("paid", "pending")),
        )
        .count()
    )


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
) -> tuple[M4gRegistration, Any]:
    reference = build_payment_reference("M4G")
    amount_cents = _amount_for_activity(activity)
    reg = M4gRegistration(
        reference=reference,
        activity=activity,
        first_name=first_name.strip(),
        last_name=last_name.strip(),
        email=email.strip(),
        phone=(phone or "").strip() or None,
        payload_json=json.dumps(payload, ensure_ascii=False),
        amount_cents=amount_cents,
        payment_status="pending",
    )
    session.add(reg)
    session.commit()
    session.refresh(reg)
    payment = prepare_nexi_payment(
        amount_cents=amount_cents,
        reference=reference,
        description=_activity_label(activity),
        email=email.strip() or None,
    )
    return reg, payment


def _render_payment(request: Request, reg: M4gRegistration, payment: Any) -> HTMLResponse:
    payload = parse_payload(reg.payload_json)
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
        },
    )


@router.get("/m4g", response_class=HTMLResponse)
@router.get("/m4g/", response_class=HTMLResponse)
def m4g_home(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "m4g_home.html",
        {
            "request": request,
            "activities": ACTIVITIES,
            "event": M4G_EVENT,
        },
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
    )
    return _render_payment(request, reg, payment)


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
        },
    )


# --- Bar (stesso namespace M4G) ---

VOUCHER_STATUS_VALID = "valid"
VOUCHER_STATUS_REDEEMED = "redeemed"


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
        catalog = MENU_BY_ID.get(item_id)
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
    return templates.TemplateResponse(
        "m4g_bar_menu.html",
        {
            "request": request,
            "menu": BAR_MENU,
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
    items = _parse_cart_json(cart_json)
    amount_cents = sum(item["price_cents"] * item["quantity"] for item in items)
    reference = build_payment_reference("BAR")
    order = BarOrder(
        reference=reference,
        items_json=json.dumps(items, ensure_ascii=False),
        amount_cents=amount_cents,
        payment_status="pending",
        voucher_status="none",
    )
    session.add(order)
    session.commit()
    session.refresh(order)
    payment = prepare_nexi_payment(
        amount_cents=amount_cents,
        reference=reference,
        description="Move for Gaza — bar evento",
    )
    return templates.TemplateResponse(
        "m4g_bar_payment.html",
        {
            "request": request,
            "items": items,
            "total": format_price(amount_cents),
            "reference": reference,
            "payment": payment,
            "price_fn": format_price,
        },
    )


@router.get("/m4g/bar/qr", response_class=HTMLResponse)
def bar_qr_page(request: Request) -> HTMLResponse:
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


@router.get("/m4g/voucher/{token}", response_class=HTMLResponse)
def bar_voucher_page(
    request: Request,
    token: str,
    session: Session = Depends(get_session),
) -> HTMLResponse:
    order = session.query(BarOrder).filter_by(voucher_token=token).first()
    if not order or order.payment_status != "paid":
        raise HTTPException(status_code=404, detail="Voucher non trovato")
    items = json.loads(order.items_json)
    voucher = {
        "token": order.voucher_token,
        "reference": order.reference,
        "status": order.voucher_status,
        "items": items,
        "amount_cents": order.amount_cents,
    }
    return templates.TemplateResponse(
        "m4g_bar_voucher.html",
        {"request": request, "voucher": voucher, "price_fn": format_price},
    )


@router.post("/m4g/voucher/{token}/redeem")
def bar_voucher_redeem(
    token: str,
    session: Session = Depends(get_session),
) -> JSONResponse:
    from datetime import datetime

    order = session.query(BarOrder).filter_by(voucher_token=token).first()
    if not order:
        raise HTTPException(status_code=404, detail="Voucher non trovato")
    if order.payment_status != "paid":
        raise HTTPException(status_code=409, detail="Pagamento non confermato")
    if order.voucher_status == VOUCHER_STATUS_REDEEMED:
        return JSONResponse(
            {
                "token": order.voucher_token,
                "reference": order.reference,
                "status": order.voucher_status,
            }
        )
    if order.voucher_status != VOUCHER_STATUS_VALID:
        raise HTTPException(status_code=409, detail="Voucher non valido")
    order.voucher_status = VOUCHER_STATUS_REDEEMED
    order.redeemed_at = datetime.utcnow()
    session.commit()
    return JSONResponse(
        {
            "token": order.voucher_token,
            "reference": order.reference,
            "status": order.voucher_status,
        }
    )
