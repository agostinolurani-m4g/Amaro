"""Accesso dei tesserati a Lupo Companion (companion.amarobici.it).

Flusso (simile a un OAuth "authorization code"):
1. Il tesserato, già dentro l'area tesserati, apre `/area-tesserati/companion`.
2. Amaro firma un codice a vita breve e lo passa a Companion via redirect.
3. Companion lo scambia, server-to-server, su `POST /api/wattlab/companion/exchange`
   e riceve i dati minimi del tesserato; poi apre la propria sessione.

Nessun segreto condiviso: il codice lo firma e lo verifica solo Amaro.
La chiave è derivata da SESSION_SECRET con un suffisso, così un codice Companion
non vale come token Lupo Ammaro (e viceversa).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .config import settings
from .database import get_session
from .models import Member
from .wattlab_auth import _b64url_decode, _b64url_encode, _member_payload

router = APIRouter(prefix="/api/wattlab/companion", tags=["wattlab-companion"])

COMPANION_CODE_TTL_SECS = 120
_KEY_SUFFIX = ":companion-sso"


def _signing_key() -> bytes:
    return (settings.session_secret + _KEY_SUFFIX).encode("utf-8")


def _sign(payload_b64: str) -> bytes:
    return hmac.new(_signing_key(), payload_b64.encode("utf-8"), hashlib.sha256).digest()


def issue_companion_code(member_id: int) -> str:
    exp = int(time.time()) + COMPANION_CODE_TTL_SECS
    payload = json.dumps(
        {"member_id": member_id, "exp": exp, "aud": "companion"}, separators=(",", ":")
    )
    payload_b64 = _b64url_encode(payload.encode("utf-8"))
    return f"{payload_b64}.{_b64url_encode(_sign(payload_b64))}"


def parse_companion_code(code: str) -> int | None:
    try:
        payload_b64, sig_b64 = code.split(".", 1)
        actual_sig = _b64url_decode(sig_b64)
    except Exception:
        return None
    if not hmac.compare_digest(_sign(payload_b64), actual_sig):
        return None
    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception:
        return None
    if not isinstance(payload, dict) or payload.get("aud") != "companion":
        return None
    exp = payload.get("exp")
    member_id = payload.get("member_id")
    if not isinstance(exp, int) or not isinstance(member_id, int):
        return None
    if exp < int(time.time()):
        return None
    return member_id


def companion_login_url(member_id: int) -> str:
    base = (settings.companion_url or "").strip().rstrip("/")
    return f"{base}/api/auth/amaro?code={issue_companion_code(member_id)}"


class ExchangeRequest(BaseModel):
    code: str


@router.post("/exchange")
def companion_exchange(
    body: ExchangeRequest,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    member_id = parse_companion_code(body.code.strip())
    if member_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Codice scaduto o non valido.",
        )
    member = session.get(Member, member_id)
    if not member:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Utente non trovato.",
        )
    if member.payment_status != "paid":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tessera non attiva: completa il pagamento.",
        )
    return {"member": _member_payload(member)}
