from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .config import settings
from .database import get_session
from .models import Member
from .wattlab_download import resolve_wattlab_installer, wattlab_installer_info

router = APIRouter(prefix="/api/wattlab", tags=["wattlab"])


class LoginRequest(BaseModel):
    email: str
    password: str


class MemberPayload(BaseModel):
    id: int
    email: str
    first_name: str = Field(..., alias="firstName")
    last_name: str = Field(..., alias="lastName")
    membership_status: str = Field(..., alias="membershipStatus")

    class Config:
        allow_population_by_field_name = True


class LoginResponse(BaseModel):
    token: str
    expires_at: str = Field(..., alias="expiresAt")
    member: MemberPayload

    class Config:
        allow_population_by_field_name = True


class MeResponse(BaseModel):
    member: MemberPayload
    expires_at: str | None = Field(None, alias="expiresAt")

    class Config:
        allow_population_by_field_name = True


def _hash_password(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _verify_password(raw: str, hashed: str | None) -> bool:
    return bool(hashed) and _hash_password(raw) == hashed


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def issue_wattlab_token(member_id: int) -> tuple[str, str]:
    ttl_days = settings.wattlab_token_ttl_days
    exp = int(time.time()) + ttl_days * 86400
    payload = json.dumps({"member_id": member_id, "exp": exp}, separators=(",", ":"))
    payload_b64 = _b64url_encode(payload.encode("utf-8"))
    signature = hmac.new(
        settings.session_secret.encode("utf-8"),
        payload_b64.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    token = f"{payload_b64}.{_b64url_encode(signature)}"
    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    return token, expires_at


def parse_wattlab_token(token: str) -> int | None:
    try:
        payload_b64, sig_b64 = token.split(".", 1)
    except ValueError:
        return None

    expected_sig = hmac.new(
        settings.session_secret.encode("utf-8"),
        payload_b64.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    try:
        actual_sig = _b64url_decode(sig_b64)
    except Exception:
        return None
    if not hmac.compare_digest(expected_sig, actual_sig):
        return None

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception:
        return None

    exp = payload.get("exp")
    member_id = payload.get("member_id")
    if not isinstance(exp, int) or not isinstance(member_id, int):
        return None
    if exp < int(time.time()):
        return None
    return member_id


def _wattlab_membership_status(member: Member) -> str:
    if member.payment_status == "paid":
        return "active"
    return "expired"


def _member_payload(member: Member) -> dict[str, object]:
    return {
        "id": member.id,
        "email": member.email,
        "firstName": member.first_name,
        "lastName": member.last_name,
        "membershipStatus": _wattlab_membership_status(member),
    }


def _lookup_member_by_email(session: Session, email: str) -> Member | None:
    return (
        session.query(Member)
        .filter(Member.email == email.strip())
        .order_by(Member.id.desc())
        .first()
    )


def require_wattlab_member(
    authorization: str | None,
    session: Session,
) -> Member:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token mancante o non valido.",
        )
    token = authorization[7:].strip()
    member_id = parse_wattlab_token(token)
    if member_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token scaduto o non valido.",
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
    return member


@router.post("/login")
def wattlab_login(
    body: LoginRequest,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    member = _lookup_member_by_email(session, body.email)
    if not member or not _verify_password(body.password.strip(), member.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenziali non valide.",
        )
    if member.payment_status != "paid":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tessera non attiva: completa il pagamento.",
        )

    token, expires_at = issue_wattlab_token(member.id)
    return {
        "token": token,
        "expiresAt": expires_at,
        "member": _member_payload(member),
    }


@router.get("/me")
def wattlab_me(
    authorization: str | None = Header(None),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    member = require_wattlab_member(authorization, session)
    return {"member": _member_payload(member)}


@router.post("/logout")
def wattlab_logout() -> dict[str, bool]:
    return {"ok": True}


@router.get("/download/info")
def wattlab_download_info(
    authorization: str | None = Header(None),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    require_wattlab_member(authorization, session)
    return wattlab_installer_info()


@router.get("/download/windows", response_model=None)
def wattlab_download_windows(
    authorization: str | None = Header(None),
    session: Session = Depends(get_session),
) -> FileResponse:
    require_wattlab_member(authorization, session)
    installer = resolve_wattlab_installer()
    if installer is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Installer non ancora disponibile. Contatta la segreteria Amaro.",
        )
    return FileResponse(
        installer,
        filename=installer.name,
        media_type="application/octet-stream",
    )
