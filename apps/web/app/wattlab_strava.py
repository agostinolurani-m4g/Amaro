from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from urllib.parse import urlencode

import requests
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Request, UploadFile, status
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from .config import settings
from .database import get_session
from .models import Member
from .wattlab_auth import (
    _b64url_decode,
    _b64url_encode,
    require_wattlab_member,
)

router = APIRouter(prefix="/api/wattlab", tags=["wattlab-strava"])

STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize"
STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
STRAVA_DEAUTHORIZE_URL = "https://www.strava.com/oauth/deauthorize"
STRAVA_UPLOAD_URL = "https://www.strava.com/api/v3/uploads"
OAUTH_SCOPE = "activity:write"
OAUTH_TTL_SECS = 600


def strava_is_configured() -> bool:
    return bool(settings.strava_client_id and settings.strava_client_secret)


def _require_strava_app() -> tuple[str, str]:
    client_id = (settings.strava_client_id or "").strip()
    client_secret = (settings.strava_client_secret or "").strip()
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Strava non è ancora configurato sul server Amaro.",
        )
    return client_id, client_secret


def _public_base_url(request: Request) -> str:
    configured = (settings.app_public_url or "").strip().rstrip("/")
    if configured:
        return configured
    return str(request.base_url).rstrip("/")


def _callback_url(request: Request) -> str:
    return f"{_public_base_url(request)}/api/wattlab/strava/callback"


def issue_strava_oauth_state(member_id: int) -> str:
    exp = int(time.time()) + OAUTH_TTL_SECS
    payload = json.dumps(
        {"member_id": member_id, "exp": exp, "n": secrets.token_hex(8)},
        separators=(",", ":"),
    )
    payload_b64 = _b64url_encode(payload.encode("utf-8"))
    signature = hmac.new(
        settings.session_secret.encode("utf-8"),
        f"strava.{payload_b64}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return f"{payload_b64}.{_b64url_encode(signature)}"


def parse_strava_oauth_state(state: str) -> int | None:
    try:
        payload_b64, sig_b64 = state.split(".", 1)
    except ValueError:
        return None

    expected_sig = hmac.new(
        settings.session_secret.encode("utf-8"),
        f"strava.{payload_b64}".encode("utf-8"),
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


def _strava_status_payload(member: Member) -> dict[str, object]:
    connected = bool(member.strava_access_token and member.strava_refresh_token)
    return {
        "configured": strava_is_configured(),
        "connected": connected,
        "athleteId": member.strava_athlete_id if connected else None,
    }


def _clear_strava(member: Member) -> None:
    member.strava_access_token = None
    member.strava_refresh_token = None
    member.strava_expires_at = None
    member.strava_athlete_id = None


def _exchange_token(form: dict[str, str]) -> dict[str, object]:
    response = requests.post(STRAVA_TOKEN_URL, data=form, timeout=20)
    if response.status_code >= 400:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Autorizzazione Strava fallita: {response.text[:400]}",
        )
    try:
        return response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Risposta Strava non valida.",
        ) from exc


def _apply_token_response(member: Member, payload: dict[str, object]) -> None:
    access = payload.get("access_token")
    refresh = payload.get("refresh_token")
    expires_at = payload.get("expires_at")
    if not isinstance(access, str) or not isinstance(refresh, str):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Token Strava mancanti.",
        )
    member.strava_access_token = access
    member.strava_refresh_token = refresh
    member.strava_expires_at = int(expires_at) if isinstance(expires_at, int) else None
    athlete = payload.get("athlete")
    if isinstance(athlete, dict) and isinstance(athlete.get("id"), int):
        member.strava_athlete_id = athlete["id"]


def ensure_strava_access_token(member: Member, session: Session) -> str:
    client_id, client_secret = _require_strava_app()
    if not member.strava_access_token or not member.strava_refresh_token:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Strava non è collegato.",
        )

    expires_at = member.strava_expires_at or 0
    if int(time.time()) < expires_at - 60:
        return member.strava_access_token

    payload = _exchange_token(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
            "refresh_token": member.strava_refresh_token,
        }
    )
    _apply_token_response(member, payload)
    session.commit()
    if not member.strava_access_token:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ricollega Strava dal profilo WattLab.",
        )
    return member.strava_access_token


def _callback_html(title: str, message: str) -> str:
    return (
        "<html><body style=\"font-family:sans-serif;text-align:center;padding:48px\">"
        f"<h1>{title}</h1><p>{message}</p></body></html>"
    )


@router.get("/strava/status")
def strava_status(
    authorization: str | None = Header(None),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    member = require_wattlab_member(authorization, session)
    return _strava_status_payload(member)


@router.post("/strava/connect")
def strava_connect(
    request: Request,
    authorization: str | None = Header(None),
    session: Session = Depends(get_session),
) -> dict[str, str]:
    member = require_wattlab_member(authorization, session)
    client_id, _client_secret = _require_strava_app()
    state = issue_strava_oauth_state(member.id)
    query = urlencode(
        {
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": _callback_url(request),
            "approval_prompt": "auto",
            "scope": OAUTH_SCOPE,
            "state": state,
        }
    )
    return {"authorizeUrl": f"{STRAVA_AUTH_URL}?{query}"}


@router.get("/strava/callback", response_class=HTMLResponse)
def strava_callback(
    request: Request,
    session: Session = Depends(get_session),
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> HTMLResponse:
    if error:
        return HTMLResponse(
            _callback_html(
                "Autorizzazione Strava annullata",
                "Puoi chiudere questa finestra e tornare a WattLab.",
            )
        )

    member_id = parse_strava_oauth_state(state or "")
    if member_id is None:
        return HTMLResponse(
            _callback_html(
                "Collegamento Strava non valido",
                "Lo stato OAuth è scaduto o non valido. Riprova da WattLab.",
            ),
            status_code=400,
        )

    if not code:
        return HTMLResponse(
            _callback_html(
                "Codice Strava mancante",
                "Riprova a collegare Strava da WattLab.",
            ),
            status_code=400,
        )

    member = session.get(Member, member_id)
    if not member or member.payment_status != "paid":
        return HTMLResponse(
            _callback_html(
                "Account non trovato",
                "Accedi di nuovo a WattLab e riprova.",
            ),
            status_code=400,
        )

    client_id, client_secret = _require_strava_app()
    payload = _exchange_token(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": _callback_url(request),
        }
    )
    _apply_token_response(member, payload)
    session.commit()

    return HTMLResponse(
        _callback_html(
            "WattLab collegato a Strava",
            "Puoi chiudere questa finestra e tornare a WattLab.",
        )
    )


@router.post("/strava/disconnect")
def strava_disconnect(
    authorization: str | None = Header(None),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    member = require_wattlab_member(authorization, session)
    token = member.strava_access_token
    if token:
        try:
            requests.post(
                STRAVA_DEAUTHORIZE_URL,
                headers={"Authorization": f"Bearer {token}"},
                timeout=15,
            )
        except requests.RequestException:
            pass
    _clear_strava(member)
    session.commit()
    return _strava_status_payload(member)


@router.post("/strava/upload")
def strava_upload(
    authorization: str | None = Header(None),
    session: Session = Depends(get_session),
    file: UploadFile = File(...),
    name: str = Form("WattLab"),
) -> dict[str, int]:
    member = require_wattlab_member(authorization, session)
    access_token = ensure_strava_access_token(member, session)
    fit_bytes = file.file.read()
    if not fit_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File FIT vuoto.",
        )

    files = {
        "file": ("wattlab.fit", fit_bytes, "application/octet-stream"),
    }
    data = {
        "data_type": "fit",
        "trainer": "1",
        "name": name,
        "sport_type": "VirtualRide",
    }
    response = requests.post(
        STRAVA_UPLOAD_URL,
        headers={"Authorization": f"Bearer {access_token}"},
        files=files,
        data=data,
        timeout=60,
    )
    if response.status_code >= 400:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Upload Strava fallito: {response.text[:400]}",
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Risposta upload Strava non valida.",
        ) from exc

    if payload.get("error"):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Upload Strava: {payload['error']}",
        )

    upload_id = payload.get("id")
    activity_id = payload.get("activity_id")
    if isinstance(activity_id, int) and isinstance(upload_id, int):
        return {"activityId": activity_id, "uploadId": upload_id}

    if not isinstance(upload_id, int):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Upload Strava senza identificativo.",
        )

    for _ in range(20):
        time.sleep(1.5)
        access_token = ensure_strava_access_token(member, session)
        status_response = requests.get(
            f"{STRAVA_UPLOAD_URL}/{upload_id}",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=20,
        )
        if status_response.status_code >= 400:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Stato upload Strava fallito: {status_response.text[:400]}",
            )
        status_payload = status_response.json()
        if status_payload.get("error"):
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Upload Strava: {status_payload['error']}",
            )
        activity_id = status_payload.get("activity_id")
        if isinstance(activity_id, int):
            return {"activityId": activity_id, "uploadId": upload_id}

    raise HTTPException(
        status_code=status.HTTP_504_GATEWAY_TIMEOUT,
        detail="Timeout durante l'upload su Strava.",
    )
