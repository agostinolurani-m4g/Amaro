"""Capture mobile viewport screenshots of key M4G pages (local dev server)."""

from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("M4G_SCREEN_BASE", "http://127.0.0.1:8765")
PASSWORD = os.environ.get("M4G_SITE_PASSWORD", "zipangulo")
ADMIN = os.environ.get("M4G_ADMIN_PASSWORD", PASSWORD)
OUT = Path(__file__).resolve().parents[1] / "mobile-screenshots"
OUT.mkdir(exist_ok=True)

PAGES = [
    ("/m4g/", "home"),
    ("/m4g/giornata", "giornata"),
    ("/m4g/iscrizione", "iscrizione"),
    ("/m4g/bici", "bici"),
    ("/m4g/corsa", "corsa"),
    ("/m4g/bar", "bar"),
    ("/m4g/donazione", "donazione"),
    ("/m4g/merch", "merch"),
]

VIEWPORTS = [
    ("iphone", 390, 844),
    ("android", 360, 800),
]


def unlock_site(page) -> None:
    page.goto(f"{BASE}/m4g/", wait_until="networkidle")
    if "/m4g/access" in page.url:
        page.fill('input[name="password"]', PASSWORD)
        page.click('button[type="submit"]')
        page.wait_for_url("**/m4g/**")


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for label, width, height in VIEWPORTS:
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()
            unlock_site(page)
            for path, name in PAGES:
                page.goto(f"{BASE}{path}", wait_until="networkidle")
                page.screenshot(path=str(OUT / f"{name}-{label}.png"), full_page=True)
            page.goto(f"{BASE}/m4g/gestione", wait_until="networkidle")
            if "Area riservata" in page.content() or page.locator('input[name="password"]').count():
                page.fill('input[name="password"]', ADMIN)
                page.click('button[type="submit"]')
                page.wait_for_url("**/m4g/gestione**")
            page.goto(f"{BASE}/m4g/gestione", wait_until="networkidle")
            page.screenshot(path=str(OUT / f"gestione-{label}.png"), full_page=True)
            page.goto(f"{BASE}/m4g/gestione/cassa", wait_until="networkidle")
            page.screenshot(path=str(OUT / f"cassa-{label}.png"), full_page=True)
            context.close()
        browser.close()
    print(f"Screenshots in {OUT}")


if __name__ == "__main__":
    main()
