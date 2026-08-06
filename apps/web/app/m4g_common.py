from __future__ import annotations

import json
import logging
import secrets
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request, status
from fastapi.templating import Jinja2Templates
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from .config import settings
from .database import engine
from .m4g_config import M4G_EVENT
from .models import BarOrder, M4gRegistration
from .nexi import NexiXpayClient

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
templates.env.globals["m4g"] = M4G_EVENT


def format_price(cents: int) -> str:
    return f"{cents / 100:.2f}"


def build_payment_reference(prefix: str) -> str:
    safe_prefix = "".join(ch for ch in prefix if ch.isalnum()).upper() or "PAY"
    return f"{safe_prefix}{secrets.token_hex(6).upper()}"


def require_nexi_client() -> NexiXpayClient:
    try:
        return NexiXpayClient.from_settings(settings)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Nexi/XPay non configurato",
        ) from exc


def app_base_url(request: Request | None) -> str:
    if request is not None:
        return str(request.base_url).rstrip("/")
    return ""


def prepare_nexi_payment(
    *,
    amount_cents: int,
    reference: str,
    description: str,
    email: str | None = None,
):
    success_url = f"{settings.nexipay_success_url}?ref={reference}"
    failure_url = f"{settings.nexipay_failure_url}?ref={reference}"
    return require_nexi_client().prepare_payment(
        amount_cents=amount_cents,
        order_id=reference,
        description=description,
        email=email,
        success_url=success_url,
        failure_url=failure_url,
    )


def mark_bar_order_paid(order: BarOrder, session: Session) -> str:
    if order.payment_status != "paid":
        order.payment_status = "paid"
        order.paid_at = datetime.utcnow()
    if not order.voucher_token:
        order.voucher_token = secrets.token_urlsafe(24)
    if order.voucher_status in ("none", ""):
        order.voucher_status = "valid"
    session.commit()
    session.refresh(order)
    return order.voucher_token or ""


def mark_bar_order_failed(order: BarOrder, session: Session) -> None:
    if order.payment_status != "paid":
        order.payment_status = "failed"
        session.commit()


def mark_registration_paid(reg: M4gRegistration, session: Session) -> str:
    if reg.payment_status != "paid":
        reg.payment_status = "paid"
        reg.paid_at = datetime.utcnow()
    if not reg.confirmation_token:
        reg.confirmation_token = secrets.token_urlsafe(24)
    session.commit()
    session.refresh(reg)
    return reg.confirmation_token or ""


def mark_registration_failed(reg: M4gRegistration, session: Session) -> None:
    if reg.payment_status != "paid":
        reg.payment_status = "failed"
        session.commit()


def apply_m4g_payment_by_reference(
    ref: str, session: Session, success: bool, request: Request | None = None
) -> dict[str, str] | None:
    base = app_base_url(request)

    order = session.query(BarOrder).filter_by(reference=ref).first()
    if order:
        if success:
            token = mark_bar_order_paid(order, session)
            return {"redirect_url": f"{base}/m4g/voucher/{token}"}
        mark_bar_order_failed(order, session)
        return {"redirect_url": f"{base}/m4g/bar?payment=failed"}

    reg = session.query(M4gRegistration).filter_by(reference=ref).first()
    if reg:
        if success:
            token = mark_registration_paid(reg, session)
            return {"redirect_url": f"{base}/m4g/conferma/{token}"}
        mark_registration_failed(reg, session)
        activity_paths = {
            "bike": "bici",
            "soccer": "calcio",
            "run": "corsa",
            "entrance": "ingresso",
        }
        path = activity_paths.get(reg.activity, "iscrizione")
        return {"redirect_url": f"{base}/m4g/{path}?payment=failed"}

    return None


def parse_payload(payload_json: str) -> dict[str, Any]:
    try:
        data = json.loads(payload_json or "{}")
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def ensure_bar_order_schema() -> None:
    inspector = inspect(engine)
    if "bar_orders" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("bar_orders")}
    required_columns: dict[str, str] = {
        "voucher_token": "TEXT",
        "voucher_status": "TEXT",
        "paid_at": "DATETIME",
        "redeemed_at": "DATETIME",
    }
    with engine.begin() as conn:
        for column, ddl in required_columns.items():
            if column not in columns:
                conn.execute(text(f"ALTER TABLE bar_orders ADD COLUMN {column} {ddl}"))
