from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
import hashlib


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
        """
        Costruisce i parametri per il flusso Nexi
        \"Pagamento semplice\" verso DispatcherServlet.

        amount_cents: importo in centesimi (5000 = 50,00 EUR).
        order_id: usato come codTrans.
        description, email: accettati per compatibilitA , non usati direttamente.
        """
        if amount_cents <= 0:
            raise ValueError("Amount must be greater than zero")

        # Per il pagamento semplice usiamo un codice transazione
        # nello stesso formato dell'esempio Nexi ufficiale.
        cod_trans = "PS" + datetime.utcnow().strftime("%Y%m%d%H%M%S")
        divisa = self.currency
        importo = amount_cents

        mac_str = f"codTrans={cod_trans}divisa={divisa}importo={importo}{self.api_key}"
        mac = hashlib.sha1(mac_str.encode("utf-8")).hexdigest()

        payload: dict[str, Any] = {
            "alias": self.merchant_id,
            "importo": importo,
            "divisa": divisa,
            "codTrans": cod_trans,
            "url": self.success_url,
            "url_back": self.failure_url,
            "mac": mac,
        }
        if email:
            payload["mail"] = email

        redirect_url = self.endpoint
        return NexiPaymentContext(payload=payload, redirect_url=redirect_url)
