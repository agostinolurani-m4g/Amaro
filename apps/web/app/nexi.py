from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping
import hashlib
import hmac
from uuid import uuid4


@dataclass(frozen=True)
class NexiPaymentContext:
    payload: dict[str, Any]
    redirect_url: str


class NexiXpayClient:
    def __init__(
        self,
        merchant_id: str,
        api_key: str,
        endpoint: str,
        success_url: str,
        failure_url: str,
        currency: str = "EUR",
    ) -> None:
        if not merchant_id or not api_key:
            raise ValueError("Nexi/XPay credentials missing")
        self.merchant_id = merchant_id
        self.api_key = api_key
        self.endpoint = endpoint.rstrip("/")
        self.success_url = success_url
        self.failure_url = failure_url
        self.currency = currency

    @classmethod
    def from_settings(cls, settings: Any) -> "NexiXpayClient":
        return cls(
            merchant_id=settings.nexipay_merchant_id,
            api_key=settings.nexipay_api_key,
            endpoint=settings.nexipay_endpoint,
            success_url=settings.nexipay_success_url,
            failure_url=settings.nexipay_failure_url,
        )

    def prepare_payment(
        self, amount_cents: int, order_id: str, description: str, email: str | None = None
    ) -> NexiPaymentContext:
        if amount_cents <= 0:
            raise ValueError("Amount must be greater than zero")
        timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
        payload = {
            "merchantId": self.merchant_id,
            "amount": f"{amount_cents / 100:.2f}",
            "currency": self.currency,
            "orderId": order_id,
            "description": description,
            "timestamp": timestamp,
            "sessionId": uuid4().hex,
            "returnUrl": self.success_url,
            "failureUrl": self.failure_url,
        }
        if email:
            payload["email"] = email
        payload["signature"] = self._sign_payload(payload)
        redirect_url = (
            f"{self.endpoint}?orderId={payload['orderId']}&signature={payload['signature']}"
        )
        return NexiPaymentContext(payload=payload, redirect_url=redirect_url)

    def _sign_payload(self, payload: Mapping[str, str]) -> str:
        items = sorted(payload.items())
        signature_base = "|".join(f"{key}={value}" for key, value in items)
        return hmac.new(
            self.api_key.encode("utf-8"),
            signature_base.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
