"""Generazione QR ad alta risoluzione per stampa Move for Gaza."""

from __future__ import annotations

import io
from typing import TYPE_CHECKING

import segno
from markupsafe import Markup

if TYPE_CHECKING:
    from segno import QRCode

CM_PER_INCH = 2.54
PRINT_DPI = 900
PRINT_SIZE_CM = 30
PREVIEW_MODULE_SCALE = 6


def print_target_pixels() -> int:
    return round(PRINT_SIZE_CM / CM_PER_INCH * PRINT_DPI)


def make_qr(target_url: str) -> QRCode:
    return segno.make(target_url, error="q")


def svg_inline_markup(target_url: str) -> Markup:
    qr = make_qr(target_url)
    return Markup(qr.svg_inline(scale=PREVIEW_MODULE_SCALE, border=4))


def svg_bytes(target_url: str) -> bytes:
    buff = io.BytesIO()
    qr = make_qr(target_url)
    qr.save(buff, kind="svg", scale=10, border=4)
    return buff.getvalue()


def png_bytes(target_url: str) -> bytes:
    qr = make_qr(target_url)
    modules = qr.symbol_size()[0]
    scale = max(1, print_target_pixels() // modules)
    buff = io.BytesIO()
    qr.save(buff, kind="png", scale=scale, border=4, dark="#000", light="#fff")
    return buff.getvalue()


def png_width_from_bytes(data: bytes) -> int:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return 0
    return int.from_bytes(data[16:20], "big")
