"""Da importare in ogni test PRIMA di `app.*`: i test non mandano mai email vere.

Senza questo i test leggono SMTP_* dal .env locale e inviano davvero, da
amaro.bici@gmail.com, mail a indirizzi finti (@example.test) che poi rimbalzano.
I test che verificano un invio usano il loro SMTP finto (mock.patch), che ha
la precedenza su questo blocco.
"""
from __future__ import annotations

import os
import smtplib

# Le variabili d'ambiente vincono sul .env: SMTP spento per tutta la suite.
os.environ["SMTP_HOST"] = ""
os.environ["SMTP_USER"] = ""
os.environ["SMTP_PASSWORD"] = ""


class _BlockedSMTP:
    def __init__(self, host: str = "", *args, **kwargs) -> None:
        raise ConnectionRefusedError(f"Email vera bloccata nei test (host={host!r})")


smtplib.SMTP = _BlockedSMTP  # type: ignore[misc,assignment]
smtplib.SMTP_SSL = _BlockedSMTP  # type: ignore[misc,assignment]
