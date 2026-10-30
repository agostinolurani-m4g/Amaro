from __future__ import annotations

import re
from pathlib import Path

from .config import settings

WEB_DIR = Path(__file__).resolve().parent.parent


def _resolve_dir(raw: str) -> Path:
    path = Path(raw)
    if not path.is_absolute():
        path = WEB_DIR / path
    return path.resolve()


def _candidate_dirs() -> list[Path]:
    dirs: list[Path] = []
    seen: set[Path] = set()
    for raw in (settings.wattlab_releases_dir, "releases/wattlab"):
        path = _resolve_dir(raw)
        if path in seen:
            continue
        seen.add(path)
        dirs.append(path)
    return dirs


def resolve_wattlab_installer() -> Path | None:
    if settings.wattlab_installer_path:
        configured = Path(settings.wattlab_installer_path)
        if not configured.is_absolute():
            configured = (WEB_DIR / configured).resolve()
        else:
            configured = configured.resolve()
        if configured.is_file():
            return configured

    candidates: list[Path] = []
    for releases in _candidate_dirs():
        if not releases.is_dir():
            continue
        candidates.extend(releases.glob("WattLab_*_x64-setup.exe"))
        candidates.extend(releases.glob("WattLab_*_x64_en-US.msi"))

    if not candidates:
        return None

    # La versione nel nome vince sulla data: dopo un deploy i file del repo sono "nuovi" anche se vecchi.
    candidates.sort(key=lambda path: (installer_version(path), path.stat().st_mtime), reverse=True)
    exe = [path for path in candidates if path.suffix.lower() == ".exe"]
    return (exe or candidates)[0]


def installer_version(path: Path) -> tuple[int, ...]:
    match = re.match(r"WattLab_(\d+(?:\.\d+)*)_", path.name)
    return tuple(int(part) for part in match.group(1).split(".")) if match else ()


def format_bytes(size: int) -> str:
    if size <= 0:
        return "—"
    return f"{size / (1024 * 1024):.1f} MB"


def wattlab_installer_info() -> dict[str, object]:
    installer = resolve_wattlab_installer()
    size = installer.stat().st_size if installer else 0
    filename = installer.name if installer else settings.wattlab_installer_filename
    return {
        "version": ".".join(map(str, installer_version(installer))) if installer and installer_version(installer) else settings.wattlab_version,
        "platform": "windows",
        "filename": filename,
        "sizeBytes": size,
        "sizeLabel": format_bytes(size),
        "available": installer is not None,
    }
