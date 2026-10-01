from __future__ import annotations

import json
import logging
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from urllib.parse import quote, urlencode

from fastapi import Request
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, inspect, text
from sqlalchemy.orm import Session

from .config import settings
from .database import engine
from .m4g_cms import cms_show_bar, cms_show_merch, cms_show_total
from .m4g_config import M4G_EVENT
from .models import BarOrder, M4gRegistration
from .nexi import NexiXpayClient

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
templates.env.globals["m4g"] = M4G_EVENT
templates.env.globals["m4g_show_bar"] = cms_show_bar
templates.env.globals["m4g_show_merch"] = cms_show_merch
templates.env.globals["m4g_show_total"] = cms_show_total


def last_sunday(year: int, month: int) -> datetime:
    day = datetime(year, month, 31, 1, tzinfo=timezone.utc)
    while day.weekday() != 6:
        day -= timedelta(days=1)
    return day


def italy_utc_offset_hours(moment: datetime) -> int:
    """1 = CET, 2 = CEST (ora italiana)."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(timezone.utc)
    summer = last_sunday(moment.year, 3) <= moment < last_sunday(moment.year, 10)
    return 2 if summer else 1


def format_rome(value: datetime | None) -> str:
    """Ora italiana (CET/CEST) senza dipendere dal database dei fusi."""
    if value is None:
        return ""
    moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(timezone.utc)
    offset = italy_utc_offset_hours(moment)
    local = moment.astimezone(timezone(timedelta(hours=offset)))
    return local.strftime("%d/%m/%Y %H:%M")


def format_price(cents: int) -> str:
    return f"{cents / 100:.2f}"


def build_payment_reference(prefix: str) -> str:
    safe_prefix = "".join(ch for ch in prefix if ch.isalnum()).upper() or "PAY"
    return f"{safe_prefix}{secrets.token_hex(6).upper()}"


def nexi_client_or_none() -> NexiXpayClient | None:
    try:
        return NexiXpayClient.from_settings(settings)
    except ValueError:
        return None


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
    client = nexi_client_or_none()
    if client is None:
        return None
    success_url = f"{settings.nexipay_success_url}?ref={reference}"
    failure_url = f"{settings.nexipay_failure_url}?ref={reference}"
    return client.prepare_payment(
        amount_cents=amount_cents,
        order_id=reference,
        description=description,
        email=email,
        success_url=success_url,
        failure_url=failure_url,
    )


def paypal_checkout_url(
    *,
    amount_cents: int,
    item_name: str,
    reference: str,
    request: Request | None = None,
    donate: bool = True,
) -> str:
    payments = M4G_EVENT["payments"]
    pool = (payments.get("paypal_link") or "").strip()
    if not donate:
        merch = (payments.get("paypal_link_merch") or "").strip()
        if merch:
            return merch
    if pool:
        return pool
    euro = f"{amount_cents / 100:.2f}"
    me = (payments.get("paypal_me") or "").strip().strip("/")
    if me:
        handle = me.rsplit("/", 1)[-1]
        return f"https://www.paypal.com/paypalme/{handle}/{euro}EUR"
    params = {
        "cmd": "_donations" if donate else "_xclick",
        "business": payments["paypal_business"],
        "item_name": f"{item_name} [{reference}]",
        "amount": euro,
        "currency_code": "EUR",
        "no_shipping": "1",
        "custom": reference,
        "charset": "utf-8",
    }
    base = app_base_url(request)
    if base:
        params["return"] = f"{base}/tesseramento?success=1&ref={reference}"
        params["cancel_return"] = f"{base}/tesseramento?failed=1&ref={reference}"
    return "https://www.paypal.com/cgi-bin/webscr?" + urlencode(params)


def satispay_checkout_url(*, amount_cents: int) -> str | None:
    payments = M4G_EVENT["payments"]
    link = (payments.get("satispay_link") or "").strip()
    if not link or "satispay.com/" == link.rstrip("/").split("://", 1)[-1]:
        link = ""
    if link in ("", "https://www.satispay.com", "https://www.satispay.com/"):
        tag = (payments.get("satispay_tag") or "").strip()
        if tag:
            euro = f"{amount_cents / 100:.2f}"
            return (
                "https://www.satispay.com/download/?redirect="
                + quote(f"satispay://tag/{tag}")
                + f"&amount={euro}"
            )
        return None
    return link


def alt_payment_context(
    *,
    amount_cents: int,
    item_name: str,
    reference: str,
    request: Request | None = None,
    donate: bool = True,
) -> dict[str, Any]:
    return {
        "paypal_url": paypal_checkout_url(
            amount_cents=amount_cents,
            item_name=item_name,
            reference=reference,
            request=request,
            donate=donate,
        ),
        "satispay_url": satispay_checkout_url(amount_cents=amount_cents),
        "amount_label": format_price(amount_cents),
        "reference": reference,
    }


VOUCHER_STATUS_VALID = "valid"
VOUCHER_STATUS_REDEEMED = "redeemed"

BAR_SHORT_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
AWAITING_CHECK_MAX_HOURS = 3


def generate_bar_short_code(session: Session) -> str:
    for _ in range(40):
        code = "".join(
            secrets.choice(BAR_SHORT_CODE_ALPHABET) for _ in range(5)
        )
        existing = (
            session.query(BarOrder)
            .filter(
                BarOrder.short_code == code,
                BarOrder.payment_status.in_(
                    ("pending", "awaiting_check", "paid")
                ),
            )
            .first()
        )
        if not existing:
            return code
    raise RuntimeError("Impossibile generare codice ordine bar")


def expire_stale_bar_orders(session: Session) -> None:
    cutoff = datetime.utcnow() - timedelta(hours=AWAITING_CHECK_MAX_HOURS)
    changed = False
    for order in session.query(BarOrder).filter(
        BarOrder.payment_status == "awaiting_check"
    ):
        created = order.created_at
        if created is None:
            continue
        created_naive = (
            created.replace(tzinfo=None) if getattr(created, "tzinfo", None) else created
        )
        if created_naive < cutoff:
            order.payment_status = "expired"
            changed = True
    if changed:
        session.commit()


def reject_bar_order(order: BarOrder, session: Session) -> None:
    if order.payment_status == "awaiting_check":
        order.payment_status = "rejected"
        session.commit()


def bar_orders_awaiting_check(session: Session) -> list[BarOrder]:
    expire_stale_bar_orders(session)
    return (
        session.query(BarOrder)
        .filter(BarOrder.payment_status == "awaiting_check")
        .order_by(BarOrder.created_at.desc())
        .all()
    )


def bar_order_valid_voucher_count(order: BarOrder) -> int:
    vouchers = load_consumption_vouchers(order)
    return sum(1 for v in vouchers if v.get("status") == VOUCHER_STATUS_VALID)


def bar_orders_eligible(session: Session) -> list[tuple[BarOrder, int]]:
    rows: list[tuple[BarOrder, int]] = []
    for order in (
        session.query(BarOrder)
        .filter(BarOrder.payment_status == "paid")
        .order_by(BarOrder.paid_at.desc())
    ):
        remaining = bar_order_valid_voucher_count(order)
        if remaining > 0:
            rows.append((order, remaining))
    return rows


def registration_signup_detail(reg: M4gRegistration) -> str:
    data = parse_payload(reg.payload_json)
    bits: list[str] = []
    if reg.activity == "bike":
        if data.get("distance"):
            bits.append(f"{data['distance']} km")
        if data.get("level"):
            bits.append(str(data["level"]))
        if data.get("team_name"):
            bits.append(f"squadra {data['team_name']}")
    elif reg.activity == "soccer":
        if data.get("team_name"):
            bits.append(str(data["team_name"]))
        if data.get("captain"):
            bits.append(f"referente {data['captain']}")
        if data.get("count"):
            bits.append(f"{data['count']} giocatori")
        players = data.get("players") or []
        if isinstance(players, list) and players:
            bits.append(", ".join(str(name) for name in players))
    elif reg.activity == "run":
        if data.get("distance"):
            bits.append(f"{data['distance']} km")
        if str(data.get("staffetta", "")).lower() in ("si", "sì", "yes", "1"):
            bits.append("staffetta")
        if data.get("team_name"):
            bits.append(f"squadra {data['team_name']}")
    elif reg.activity == "entrance":
        if data.get("notes"):
            bits.append(str(data["notes"]))
        else:
            bits.append("Ingresso giornata")
    elif reg.activity == "merch":
        labels = {"socks": "Calze", "tshirt": "Maglietta"}
        item = labels.get(str(data.get("item", "")), str(data.get("item") or ""))
        if item:
            bits.append(item)
        if data.get("quantity"):
            bits.append(f"x{data['quantity']}")
        if data.get("size"):
            bits.append(f"taglia {data['size']}")
        if data.get("model"):
            bits.append(str(data["model"]))
    elif reg.activity == "donation":
        bits.append("Donazione libera")
    return " · ".join(bit for bit in bits if bit)


def list_m4g_registrations(
    session: Session,
    query: str = "",
    limit: int = 2000,
    *,
    hidden: bool = False,
) -> list[M4gRegistration]:
    q = session.query(M4gRegistration)
    if hidden:
        q = q.filter(M4gRegistration.hidden.is_(True))
    else:
        q = q.filter(M4gRegistration.hidden.isnot(True))
    needle = query.strip().lower()
    if needle:
        like = f"%{needle}%"
        q = q.filter(
            (M4gRegistration.reference.ilike(like))
            | (M4gRegistration.first_name.ilike(like))
            | (M4gRegistration.last_name.ilike(like))
            | (M4gRegistration.email.ilike(like))
            | (M4gRegistration.phone.ilike(like))
            | (M4gRegistration.activity.ilike(like))
            | (M4gRegistration.payload_json.ilike(like))
        )
    return q.order_by(M4gRegistration.created_at.desc()).limit(limit).all()


def build_consumption_vouchers(order: BarOrder) -> list[dict[str, Any]]:
    try:
        items = json.loads(order.items_json or "[]")
    except json.JSONDecodeError:
        items = []
    vouchers: list[dict[str, Any]] = []
    for entry in items:
        if not isinstance(entry, dict):
            continue
        quantity = int(entry.get("quantity", 0))
        name = str(entry.get("name", "Articolo"))
        item_id = str(entry.get("id", ""))
        price_cents = int(entry.get("price_cents", 0))
        for _ in range(max(0, min(quantity, 50))):
            vouchers.append(
                {
                    "token": secrets.token_urlsafe(18),
                    "name": name,
                    "item_id": item_id,
                    "price_cents": price_cents,
                    "status": VOUCHER_STATUS_VALID,
                }
            )
    return vouchers


def load_consumption_vouchers(order: BarOrder) -> list[dict[str, Any]]:
    raw = order.consumption_tokens_json
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def save_consumption_vouchers(
    order: BarOrder, vouchers: list[dict[str, Any]], session: Session
) -> None:
    order.consumption_tokens_json = json.dumps(vouchers, ensure_ascii=False)
    session.commit()


def redeem_consumption_token(
    order: BarOrder, token: str, session: Session
) -> dict[str, Any] | None:
    vouchers = load_consumption_vouchers(order)
    for entry in vouchers:
        if entry.get("token") != token:
            continue
        if entry.get("status") == VOUCHER_STATUS_REDEEMED:
            return entry
        if entry.get("status") != VOUCHER_STATUS_VALID:
            return None
        entry["status"] = VOUCHER_STATUS_REDEEMED
        entry["redeemed_at"] = datetime.utcnow().isoformat()
        save_consumption_vouchers(order, vouchers, session)
        remaining = sum(
            1 for v in vouchers if v.get("status") == VOUCHER_STATUS_VALID
        )
        if remaining == 0:
            order.voucher_status = VOUCHER_STATUS_REDEEMED
            order.redeemed_at = datetime.utcnow()
            session.commit()
        return entry
    return None


def mark_bar_order_paid(order: BarOrder, session: Session) -> str:
    if order.payment_status != "paid":
        order.payment_status = "paid"
        order.paid_at = datetime.utcnow()
    if not order.consumption_tokens_json:
        vouchers = build_consumption_vouchers(order)
        order.consumption_tokens_json = json.dumps(vouchers, ensure_ascii=False)
    if not order.voucher_token:
        order.voucher_token = secrets.token_urlsafe(24)
    if order.voucher_status in ("none", ""):
        order.voucher_status = VOUCHER_STATUS_VALID
    session.commit()
    session.refresh(order)
    return order.reference


def mark_bar_order_failed(order: BarOrder, session: Session) -> None:
    if order.payment_status != "paid":
        order.payment_status = "failed"
        session.commit()


def mark_registration_paid(reg: M4gRegistration, session: Session) -> str:
    if reg.payment_status != "paid":
        reg.payment_status = "paid"
        reg.paid_at = datetime.utcnow()
    reg.hidden = False
    if not reg.confirmation_token:
        reg.confirmation_token = secrets.token_urlsafe(24)
    session.commit()
    session.refresh(reg)
    return reg.confirmation_token or ""


def hide_registration_unpaid(reg: M4gRegistration, session: Session) -> None:
    reg.payment_status = "unpaid"
    reg.hidden = True
    reg.paid_at = None
    session.commit()


def restore_registration(reg: M4gRegistration, session: Session) -> None:
    reg.hidden = False
    if reg.payment_status == "unpaid":
        reg.payment_status = "pending"
    session.commit()


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
            mark_bar_order_paid(order, session)
            return {"redirect_url": f"{base}/m4g/ordine/{order.reference}/consumi"}
        mark_bar_order_failed(order, session)
        return {"redirect_url": f"{base}/m4g/bar?payment=failed"}

    reg = session.query(M4gRegistration).filter_by(reference=ref).first()
    if reg:
        if success:
            token = mark_registration_paid(reg, session)
            try:
                from . import m4g_mail

                m4g_mail.send_paid_confirmation(reg, session)
            except Exception:
                logger.exception(
                    "M4G paid confirmation email failed for %s", reg.reference
                )
            return {"redirect_url": f"{base}/m4g/conferma/{token}"}
        mark_registration_failed(reg, session)
        activity_paths = {
            "bike": "bici",
            "soccer": "calcio",
            "run": "corsa",
            "entrance": "ingresso",
            "donation": "donazione",
            "merch": "merch",
        }
        path = activity_paths.get(reg.activity, "iscrizione")
        return {"redirect_url": f"{base}/m4g/{path}?payment=failed"}

    return None


def compute_fundraising_stats(session: Session) -> dict[str, int]:
    empty = {
        "total_cents": 0,
        "registration_cents": 0,
        "bar_cents": 0,
        "paid_registrations": 0,
        "paid_bar_orders": 0,
    }
    try:
        reg_total = (
            session.query(func.coalesce(func.sum(M4gRegistration.amount_cents), 0))
            .filter(M4gRegistration.payment_status == "paid")
            .scalar()
        )
        bar_total = (
            session.query(func.coalesce(func.sum(BarOrder.amount_cents), 0))
            .filter(BarOrder.payment_status == "paid")
            .scalar()
        )
        paid_registrations = (
            session.query(M4gRegistration)
            .filter(M4gRegistration.payment_status == "paid")
            .count()
        )
        paid_bar_orders = (
            session.query(BarOrder).filter(BarOrder.payment_status == "paid").count()
        )
        total_cents = int(reg_total or 0) + int(bar_total or 0)
        return {
            "total_cents": total_cents,
            "registration_cents": int(reg_total or 0),
            "bar_cents": int(bar_total or 0),
            "paid_registrations": paid_registrations,
            "paid_bar_orders": paid_bar_orders,
        }
    except Exception:
        logger.exception("Failed to compute M4G fundraising stats")
        return empty


def parse_payload(payload_json: str) -> dict[str, Any]:
    try:
        data = json.loads(payload_json or "{}")
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def ensure_m4g_registration_schema() -> None:
    inspector = inspect(engine)
    if "m4g_registrations" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("m4g_registrations")}
    with engine.begin() as conn:
        if "hidden" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE m4g_registrations "
                    "ADD COLUMN hidden BOOLEAN NOT NULL DEFAULT 0"
                )
            )
        if "paid_email_sent_at" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE m4g_registrations "
                    "ADD COLUMN paid_email_sent_at DATETIME"
                )
            )


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
        "consumption_tokens_json": "TEXT",
        "payment_method": "TEXT",
        "short_code": "TEXT",
    }
    with engine.begin() as conn:
        for column, ddl in required_columns.items():
            if column not in columns:
                conn.execute(text(f"ALTER TABLE bar_orders ADD COLUMN {column} {ddl}"))
