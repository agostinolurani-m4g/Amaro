"""Stato CMS Move for Gaza (media, GPX extra, flag sito pubblico) su disco persistente."""

from __future__ import annotations

import json
import re
import secrets
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from .config import settings
from .m4g_config import FOOD_VENDORS, M4G_EVENT
from .m4g_menu import BAR_MENU

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
    "show_bar": True,
    "show_merch": True,
    "media": [],
    "gpx_routes": [],
    "vendors": None,
    "menu": None,
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
    out["show_bar"] = True if "show_bar" not in data else bool(data.get("show_bar"))
    out["show_merch"] = True if "show_merch" not in data else bool(data.get("show_merch"))
    vendors = data.get("vendors")
    out["vendors"] = vendors if isinstance(vendors, list) else None
    menu = data.get("menu")
    out["menu"] = menu if isinstance(menu, list) else None
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


def cms_show_bar() -> bool:
    return bool(_load_state_raw().get("show_bar", True))


def cms_show_merch() -> bool:
    return bool(_load_state_raw().get("show_merch", True))


def reset_catalog() -> None:
    state = _load_state_raw()
    state["vendors"] = None
    state["menu"] = None
    state["show_bar"] = True
    state["show_merch"] = True
    save_cms_state(state)


def set_page_visibility(*, show_bar: bool, show_merch: bool) -> None:
    state = _load_state_raw()
    state["show_bar"] = show_bar
    state["show_merch"] = show_merch
    save_cms_state(state)


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:40] or "voce"


def _unique_id(base: str, used: set[str]) -> str:
    candidate = _slug(base)
    if candidate not in used:
        used.add(candidate)
        return candidate
    n = 2
    while f"{candidate}-{n}" in used:
        n += 1
    fresh = f"{candidate}-{n}"
    used.add(fresh)
    return fresh


def _default_vendors() -> list[dict[str, Any]]:
    return [
        {
            "id": str(vendor["id"]),
            "name": str(vendor["name"]),
            "blurb": str(vendor.get("blurb") or ""),
            "placeholder": bool(vendor.get("placeholder")),
        }
        for vendor in FOOD_VENDORS
    ]


def cms_vendors() -> list[dict[str, Any]]:
    stored = _load_state_raw().get("vendors")
    if not isinstance(stored, list):
        return _default_vendors()
    cleaned: list[dict[str, Any]] = []
    for item in stored:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        cleaned.append(
            {
                "id": str(item.get("id") or _slug(name)),
                "name": name,
                "blurb": str(item.get("blurb") or "").strip(),
                "placeholder": bool(item.get("placeholder")),
            }
        )
    return cleaned


def save_vendors(vendors: list[dict[str, Any]]) -> None:
    state = _load_state_raw()
    state["vendors"] = vendors
    save_cms_state(state)


def _default_menu() -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    for section in BAR_MENU:
        items = []
        for item in section["items"]:  # type: ignore[index]
            items.append(
                {
                    "id": str(item["id"]),
                    "name": str(item["name"]),
                    "price_cents": int(item["price_cents"]),
                }
            )
        sections.append(
            {
                "category": str(section["category"]),
                "vendor_id": str(section.get("vendor_id") or ""),
                "items": items,
            }
        )
    return sections


def cms_menu() -> list[dict[str, Any]]:
    stored = _load_state_raw().get("menu")
    if not isinstance(stored, list):
        return _default_menu()
    vendor_ids = {vendor["id"] for vendor in cms_vendors()}
    sections: list[dict[str, Any]] = []
    for section in stored:
        if not isinstance(section, dict):
            continue
        category = str(section.get("category") or "").strip()
        raw_items = section.get("items") or []
        items: list[dict[str, Any]] = []
        if isinstance(raw_items, list):
            for item in raw_items:
                if not isinstance(item, dict):
                    continue
                name = str(item.get("name") or "").strip()
                if not name:
                    continue
                try:
                    cents = int(item.get("price_cents"))
                except (TypeError, ValueError):
                    continue
                if cents < 0:
                    continue
                items.append(
                    {
                        "id": str(item.get("id") or _slug(name)),
                        "name": name,
                        "price_cents": cents,
                    }
                )
        if not category or not items:
            continue
        vendor_id = str(section.get("vendor_id") or "")
        if vendor_id not in vendor_ids:
            vendor_id = ""
        sections.append({"category": category, "vendor_id": vendor_id, "items": items})
    return sections


def cms_menu_by_id() -> dict[str, dict[str, Any]]:
    catalog: dict[str, dict[str, Any]] = {}
    for section in cms_menu():
        for item in section["items"]:
            catalog[str(item["id"])] = item
    return catalog


def save_menu(sections: list[dict[str, Any]]) -> None:
    state = _load_state_raw()
    state["menu"] = sections
    save_cms_state(state)


def euro_to_cents(raw: str) -> int:
    text = raw.strip().replace("€", "").replace(" ", "").replace(",", ".")
    if not text:
        raise ValueError("prezzo vuoto")
    cents = int(round(float(text) * 100))
    if cents < 0 or cents > 50_000:
        raise ValueError("prezzo non valido")
    return cents


def build_vendors_from_form(
    ids: list[str],
    names: list[str],
    blurbs: list[str],
    statuses: list[str],
) -> list[dict[str, Any]]:
    used: set[str] = set()
    vendors: list[dict[str, Any]] = []
    for index, name in enumerate(names):
        clean_name = name.strip()
        if not clean_name:
            continue
        wanted = ids[index].strip() if index < len(ids) else ""
        vendor_id = wanted if wanted and wanted not in used else _unique_id(clean_name, used)
        if wanted and wanted not in used:
            used.add(wanted)
        blurb = blurbs[index].strip() if index < len(blurbs) else ""
        status = statuses[index] if index < len(statuses) else "placeholder"
        vendors.append(
            {
                "id": vendor_id,
                "name": clean_name,
                "blurb": blurb,
                "placeholder": status != "confirmed",
            }
        )
    return vendors


def build_menu_from_form(
    categories: list[str],
    vendor_ids: list[str],
    item_sections: list[str],
    item_ids: list[str],
    item_names: list[str],
    item_prices: list[str],
) -> list[dict[str, Any]]:
    known_vendors = {vendor["id"] for vendor in cms_vendors()}
    used: set[str] = set()
    sections: list[dict[str, Any]] = []
    for index, category in enumerate(categories):
        title = category.strip()
        if not title:
            continue
        vendor_id = vendor_ids[index].strip() if index < len(vendor_ids) else ""
        if vendor_id not in known_vendors:
            vendor_id = ""
        sections.append({"category": title, "vendor_id": vendor_id, "items": [], "index": index})
    by_index = {section["index"]: section for section in sections}
    for index, name in enumerate(item_names):
        clean_name = name.strip()
        if not clean_name:
            continue
        try:
            section_index = int(item_sections[index]) if index < len(item_sections) else -1
        except ValueError:
            continue
        section = by_index.get(section_index)
        if section is None:
            continue
        cents = euro_to_cents(item_prices[index] if index < len(item_prices) else "")
        wanted = item_ids[index].strip() if index < len(item_ids) else ""
        item_id = wanted if wanted and wanted not in used else _unique_id(clean_name, used)
        if wanted and wanted not in used:
            used.add(wanted)
        section["items"].append({"id": item_id, "name": clean_name, "price_cents": cents})
    return [
        {"category": section["category"], "vendor_id": section["vendor_id"], "items": section["items"]}
        for section in sections
        if section["items"]
    ]
