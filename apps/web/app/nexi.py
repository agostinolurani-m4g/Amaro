from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping
import hashlib
import hmac


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
        self,
        amount_cents: int,
        order_id: str,
        description: str,
        email: str | None = None,
        success_url: str | None = None,
        failure_url: str | None = None,
        notify_url: str | None = None,
    ) -> NexiPaymentContext:
        """
        Costruisce i parametri per il flusso Nexi/XPay verso DispatcherServlet.

        amount_cents: importo in centesimi (5000 = 50,00 EUR).
        order_id: usato come codTrans.
        description, email: accettati per compatibilità, non usati direttamente.
        notify_url: se indicato, Nexi notifica l'esito server-to-server (parametro urlpost).
        """
        if amount_cents <= 0:
            raise ValueError("Amount must be greater than zero")

        # Codice transazione nel formato richiesto da Nexi.
        cod_trans = order_id or ("PS" + datetime.utcnow().strftime("%Y%m%d%H%M%S"))
        divisa = self.currency
        importo = amount_cents

        mac_str = f"codTrans={cod_trans}divisa={divisa}importo={importo}{self.api_key}"
        mac = hashlib.sha1(mac_str.encode("utf-8")).hexdigest()

        payload: dict[str, Any] = {
            "alias": self.merchant_id,
            "importo": importo,
            "divisa": divisa,
            "codTrans": cod_trans,
            "url": success_url or self.success_url,
            "url_back": failure_url or self.failure_url,
            "mac": mac,
        }
        if email:
            payload["mail"] = email
        if notify_url:
            payload["urlpost"] = notify_url

        redirect_url = self.endpoint
        return NexiPaymentContext(payload=payload, redirect_url=redirect_url)

    def result_mac(self, params: Mapping[str, Any]) -> str:
        """MAC dell'esito XPay (ritorno e notifica urlpost)."""
        fields = ("codTrans", "esito", "importo", "divisa", "data", "orario", "codAut")
        mac_str = "".join(f"{name}={params.get(name, '') or ''}" for name in fields)
        return hashlib.sha1(f"{mac_str}{self.api_key}".encode("utf-8")).hexdigest()

    def verify_result(self, params: Mapping[str, Any]) -> bool:
        received = str(params.get("mac") or "").strip().lower()
        if not received:
            return False
        return hmac.compare_digest(received, self.result_mac(params))

