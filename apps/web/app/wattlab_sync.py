"""Sincronizzazione calendario, profilo e coach per Lupo Ammaro."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Header
from sqlalchemy.orm import Session

from .config import settings
from .database import get_session
from .models import Member
from .wattlab_auth import require_wattlab_member

router = APIRouter(prefix="/api/wattlab", tags=["wattlab"])
WEB_DIR = Path(__file__).resolve().parent.parent


def sync_root(root: Path | None = None) -> Path:
    if root is not None:
        path = root
    else:
        path = Path(settings.uploads_path)
        if not path.is_absolute():
            path = WEB_DIR / path
        path = path / "wattlab-sync"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _member_dir(member_id: int, root: Path | None = None) -> Path:
    folder = sync_root(root) / str(int(member_id))
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _read_json(path: Path, fallback):
    if not path.is_file():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def _write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def _stamp(entry: dict) -> str:
    raw = entry.get("updatedAt") or entry.get("createdAt")
    if raw:
        return str(raw)
    date = entry.get("date")
    return f"{date}T00:00:00.000Z" if date else ""


def merge_by_id(local, remote) -> list:
    found: dict[str, dict] = {}
    for item in [*(local or []), *(remote or [])]:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        prev = found.get(item["id"])
        if prev is None or _stamp(item) >= _stamp(prev):
            found[item["id"]] = item
    return list(found.values())


def merge_chat(left, right) -> list:
    items = [*(left or []), *(right or [])]
    return items[-30:]


def pick_newer_doc(current, incoming):
    if not incoming:
        return current if current else None
    if not current:
        return incoming
    current_stamp = str(current.get("updatedAt") or current.get("generatedAt") or "")
    incoming_stamp = str(incoming.get("updatedAt") or incoming.get("generatedAt") or "")
    return incoming if incoming_stamp >= current_stamp else current


def get_member_sync(member_id: int, root: Path | None = None) -> dict:
    folder = _member_dir(member_id, root)
    return {
        "calendar": _read_json(folder / "calendar.json", []),
        "lifeBlocks": _read_json(folder / "life_blocks.json", []),
        "chat": _read_json(folder / "chat.json", []),
        "checkins": _read_json(folder / "checkins.json", []),
        "athleteSettings": _read_json(folder / "athlete_settings.json", None),
        "profile": _read_json(folder / "profile.json", None),
        "workouts": _read_json(folder / "workouts.json", []),
        "serverTime": datetime.now(timezone.utc).isoformat(),
    }


def merge_member_sync(member_id: int, incoming: dict, root: Path | None = None) -> dict:
    current = get_member_sync(member_id, root)
    body = incoming or {}
    nxt = {
        "calendar": merge_by_id(current["calendar"], body.get("calendar") or []),
        "lifeBlocks": merge_by_id(current["lifeBlocks"], body.get("lifeBlocks") or []),
        "chat": merge_chat(current["chat"], body.get("chat") or []),
        "checkins": merge_by_id(current["checkins"], body.get("checkins") or []),
        "athleteSettings": pick_newer_doc(current["athleteSettings"], body.get("athleteSettings")),
        "profile": pick_newer_doc(current["profile"], body.get("profile")),
        "workouts": merge_by_id(current["workouts"], body.get("workouts") or []),
    }
    folder = _member_dir(member_id, root)
    _write_json(folder / "calendar.json", nxt["calendar"])
    _write_json(folder / "life_blocks.json", nxt["lifeBlocks"])
    _write_json(folder / "chat.json", nxt["chat"])
    _write_json(folder / "checkins.json", nxt["checkins"])
    if nxt["athleteSettings"]:
        _write_json(folder / "athlete_settings.json", nxt["athleteSettings"])
    if nxt["profile"]:
        _write_json(folder / "profile.json", nxt["profile"])
    _write_json(folder / "workouts.json", nxt["workouts"])
    return {**nxt, "serverTime": datetime.now(timezone.utc).isoformat()}


@router.get("/sync")
def wattlab_sync_get(
    authorization: str | None = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    member: Member = require_wattlab_member(authorization, session)
    return get_member_sync(member.id)


@router.put("/sync")
def wattlab_sync_put(
    body: dict,
    authorization: str | None = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    member: Member = require_wattlab_member(authorization, session)
    return merge_member_sync(member.id, body)
