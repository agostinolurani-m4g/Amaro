#!/usr/bin/env python3
"""Generate responsive WebP variants for Move for Gaza static assets."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "apps" / "web" / "app" / "static" / "m4g"
OUT = STATIC / "opt"

# (source relative to STATIC, output slug)
PHOTOS: list[tuple[str, str]] = [
    ("bene_chi.JPG", "bene_chi"),
    ("bene_mission.jpg", "bene_mission"),
    ("bene_dist.png", "bene_dist"),
    ("bene_aid.jpg", "bene_aid"),
    ("calze_m4g.jpeg", "calze_m4g"),
    ("magliette_m4g.png", "magliette_m4g"),
    ("M4G_cibo.png", "m4g_cibo"),
    ("M4G_bere.png", "m4g_bere"),
    ("arci_olmi.jpeg", "arci_olmi"),
]

SIZES = (640, 1280)
WEBP_QUALITY = 82


def resize_max(img: Image.Image, max_edge: int) -> Image.Image:
    w, h = img.size
    if max(w, h) <= max_edge:
        return img.copy()
    if w >= h:
        new_w = max_edge
        new_h = round(h * max_edge / w)
    else:
        new_h = max_edge
        new_w = round(w * max_edge / h)
    return img.resize((new_w, new_h), Image.Resampling.LANCZOS)


def save_webp(img: Image.Image, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    rgb = img.convert("RGBA") if img.mode in ("RGBA", "LA", "P") else img.convert("RGB")
    if rgb.mode == "RGBA":
        rgb.save(dest, format="WEBP", quality=WEBP_QUALITY, method=6)
    else:
        rgb.save(dest, format="WEBP", quality=WEBP_QUALITY, method=6)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for rel, slug in PHOTOS:
        src = STATIC / rel
        if not src.is_file():
            raise SystemExit(f"Missing source: {src}")
        with Image.open(src) as im:
            im.load()
            for size in SIZES:
                out = OUT / f"{slug}-{size}.webp"
                save_webp(resize_max(im, size), out)
                print(f"wrote {out.relative_to(ROOT)}")

    logo_src = STATIC / "sunbirds-logo.png"
    logo_out = OUT / "sunbirds-logo-512.png"
    with Image.open(logo_src) as im:
        im.load()
        resized = resize_max(im, 512)
        logo_out.parent.mkdir(parents=True, exist_ok=True)
        resized.save(logo_out, format="PNG", optimize=True)
        print(f"wrote {logo_out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
