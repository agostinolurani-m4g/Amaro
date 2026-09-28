"""Stato CMS Move for Gaza (media, GPX extra, flag sito pubblico) su disco persistente."""

from __future__ import annotations

import json
import re
import secrets
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from .config import settings
from .m4g_config import M4G_EVENT

BASE_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = (BASE_DIR / settings.uploads_path).resolve()

M4G_CMS_DIR = UPLOADS_DIR / "m4g"
M4G_MEDIA_DIR = M4G_CMS_DIR / "media"
M4G_ROUTES_DIR = M4G_CMS_DIR / "routes"
CMS_STATE_FILE = M4G_CMS_DIR / "m4g_cms.json"

MEDIA_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".gif"})
GPX_NS = {"gpx": "http://www.topografix.com/GPX/1/1"}

_DEFAULT_STATE: dict[str, Any] = {
    "site_public": False,
    "media": [],
    "gpx_routes": [],
}


def _ensure_dirs() -> None:
    M4G_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    M4G_ROUTES_DIR.mkdir(parents=True, exist_ok=True)


def _load_state_raw() -> dict[str, Any]:
    _ensure_dirs()
    if not CMS_STATE_FILE.is_file():
        return dict(_DEFAULT_STATE)
    try:
        data = json.loads(CMS_STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return dict(_DEFAULT_STATE)
    if not isinstance(data, dict):
        return dict(_DEFAULT_STATE)
    out = dict(_DEFAULT_STATE)
    out["site_public"] = bool(data.get("site_public", False))
    out["media"] = [str(x) for x in (data.get("media") or []) if x]
    routes = data.get("gpx_routes") or []
    cleaned: list[dict[str, str]] = []
    if isinstance(routes, list):
        for item in routes:
            if not isinstance(item, dict):
                continue
            key = str(item.get("key") or "").strip()
            label = str(item.get("label") or "").strip()
            filename = str(item.get("filename") or "").strip()
            if key and label and filename:
                cleaned.append({"key": key, "label": label, "filename": filename})
    out["gpx_routes"] = cleaned
    return out


def save_cms_state(state: dict[str, Any]) -> None:
    _ensure_dirs()
    CMS_STATE_FILE.write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def cms_site_public() -> bool:
    return bool(_load_state_raw().get("site_public"))


def set_site_public(enabled: bool) -> None:
    state = _load_state_raw()
    state["site_public"] = enabled
    save_cms_state(state)


def cms_media_url(stored_name: str) -> str:
    return f"/m4g/cms/media/{stored_name}"


def cms_gpx_url(stored_name: str) -> str:
    return f"/m4g/cms/routes/{stored_name}"


def m4g_photos_2025() -> list[str]:
    state = _load_state_raw()
    base = list(M4G_EVENT["photos_2025"])
    for name in state.get("media", []):
        if (M4G_MEDIA_DIR / name).is_file():
            base.append(cms_media_url(name))
    return base


def _gpx_url_for_key(key: str) -> str | None:
    mapping = {
        "112": M4G_EVENT["gpx"]["bike_112"],
        "64": M4G_EVENT["gpx"]["bike_64"],
        "20": M4G_EVENT["gpx"]["bike_20"],
    }
    if key in mapping:
        return mapping[key]
    state = _load_state_raw()
    for route in state.get("gpx_routes", []):
        if route["key"] == key:
            path = M4G_ROUTES_DIR / route["filename"]
            if path.is_file():
                return cms_gpx_url(route["filename"])
    return None


def m4g_bike_distances() -> list[dict[str, str]]:
    distances = list(M4G_EVENT["bike_distances"])
    state = _load_state_raw()
    for route in state.get("gpx_routes", []):
        if (M4G_ROUTES_DIR / route["filename"]).is_file():
            distances.append({"key": route["key"], "label": route["label"]})
    return distances


def m4g_bike_routes_for_map() -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for dist in m4g_bike_distances():
        url = _gpx_url_for_key(dist["key"])
        if url:
            rows.append({"key": dist["key"], "label": dist["label"], "url": url})
    return rows


def _safe_stored_name(original: str, prefix: str, default_ext: str) -> str:
    ext = Path(original).suffix.lower() or default_ext
    token = secrets.token_hex(8)
    return f"{prefix}-{token}{ext}"


def _slug_key(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    slug = slug[:48] or "route"
    return f"cms-{slug}-{secrets.token_hex(4)}"


def _gpx_label_from_bytes(data: bytes) -> str:
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return "Percorso GPX"
    for tag in ("{http://www.topografix.com/GPX/1/1}metadata", "metadata"):
        meta = root.find(tag)
        if meta is not None:
            for name_tag in ("{http://www.topografix.com/GPX/1/1}name", "name"):
                el = meta.find(name_tag)
                if el is not None and (el.text or "").strip():
                    return el.text.strip()
    for trk_tag in ("{http://www.topografix.com/GPX/1/1}trk", "trk"):
        trk = root.find(trk_tag)
        if trk is not None:
            for name_tag in ("{http://www.topografix.com/GPX/1/1}name", "name"):
                el = trk.find(name_tag)
                if el is not None and (el.text or "").strip():
                    return el.text.strip()
    return "Percorso GPX"


def add_media_file(filename: str, data: bytes) -> str:
    ext = Path(filename).suffix.lower()
    if ext not in MEDIA_EXTENSIONS:
        raise ValueError("Formato immagine non supportato")
    if len(data) > 12 * 1024 * 1024:
        raise ValueError("File troppo grande (max 12 MB)")
    stored = _safe_stored_name(filename, "m4g", ext)
    _ensure_dirs()
    (M4G_MEDIA_DIR / stored).write_bytes(data)
    state = _load_state_raw()
    media = list(state.get("media", []))
    media.append(stored)
    state["media"] = media
    save_cms_state(state)
    return stored


def remove_media_file(stored_name: str) -> None:
    safe = Path(stored_name).name
    state = _load_state_raw()
    media = [m for m in state.get("media", []) if m != safe]
    state["media"] = media
    save_cms_state(state)
    path = M4G_MEDIA_DIR / safe
    if path.is_file():
        path.unlink()


def add_gpx_file(filename: str, data: bytes) -> dict[str, str]:
    if not filename.lower().endswith(".gpx"):
        raise ValueError("Serve un file .gpx")
    if len(data) > 15 * 1024 * 1024:
        raise ValueError("GPX troppo grande (max 15 MB)")
    if b"<gpx" not in data[:50000].lower():
        raise ValueError("Il file non sembra un GPX valido")
    label = _gpx_label_from_bytes(data)
    stored = _safe_stored_name(filename, "route", ".gpx")
    key = _slug_key(label)
    _ensure_dirs()
    (M4G_ROUTES_DIR / stored).write_bytes(data)
    entry = {"key": key, "label": label, "filename": stored}
    state = _load_state_raw()
    routes = list(state.get("gpx_routes", []))
    routes.append(entry)
    state["gpx_routes"] = routes
    save_cms_state(state)
    return entry


def remove_gpx_route(route_key: str) -> None:
    state = _load_state_raw()
    kept: list[dict[str, str]] = []
    for route in state.get("gpx_routes", []):
        if route["key"] == route_key:
            path = M4G_ROUTES_DIR / route["filename"]
            if path.is_file():
                path.unlink()
        else:
            kept.append(route)
    state["gpx_routes"] = kept
    save_cms_state(state)


def cms_media_path(stored_name: str) -> Path | None:
    safe = Path(stored_name).name
    path = M4G_MEDIA_DIR / safe
    return path if path.is_file() else None


def cms_gpx_path(stored_name: str) -> Path | None:
    safe = Path(stored_name).name
    path = M4G_ROUTES_DIR / safe
    return path if path.is_file() else None


def list_cms_media() -> list[str]:
    state = _load_state_raw()
    return [m for m in state.get("media", []) if (M4G_MEDIA_DIR / m).is_file()]


def list_cms_gpx_routes() -> list[dict[str, str]]:
    state = _load_state_raw()
    return [
        r
        for r in state.get("gpx_routes", [])
        if (M4G_ROUTES_DIR / r["filename"]).is_file()
    ]
