from __future__ import annotations

import os
import unittest

os.environ.setdefault("NEXI_ENDPOINT", "https://example.test/nexi")
os.environ.setdefault("NEXI_SUCCESS_URL", "https://example.test/success")
os.environ.setdefault("NEXI_FAILURE_URL", "https://example.test/failure")
os.environ.setdefault("SESSION_SECRET", "test-m4g-secret")
os.environ.setdefault("M4G_SITE_PASSWORD", "test-m4g-password")
M4G_TEST_PASSWORD = os.environ["M4G_SITE_PASSWORD"]

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


class M4gPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Starlette 0.50 runs the ASGI lifespan, including create_all, only
        # inside the TestClient context manager. CI starts from an empty sqlite
        # file, so checkout writes fail unless startup has run.
        cls._client = TestClient(app)
        cls.client = cls._client.__enter__()
        unlock = cls.client.post(
            "/m4g/access",
            data={"password": M4G_TEST_PASSWORD, "next": "/m4g/"},
            follow_redirects=False,
        )
        if unlock.status_code not in (302, 303):
            raise RuntimeError(
                f"M4G access unlock failed ({unlock.status_code}); check M4G_SITE_PASSWORD"
            )

    @classmethod
    def tearDownClass(cls) -> None:
        client = getattr(cls, "_client", None)
        if client is not None:
            client.__exit__(None, None, None)

    def test_home_contains_pdf_sections(self) -> None:
        response = self.client.get("/m4g/")
        self.assertEqual(response.status_code, 200)
        body = response.text
        self.assertIn("Cos'è Move4Gaza", body)
        self.assertIn("Il programma della giornata", body)
        self.assertIn("DONA QUI", body)
        self.assertIn("17 ottobre 2026", body)
        self.assertIn("Raccolta di questa edizione", body)
        self.assertNotIn("iscrizioni pagate", body)
        self.assertNotIn("bar e cucina", body.lower())
        self.assertIn("Realtà che hanno aderito", body)
        self.assertIn("Amaro", body)
        self.assertIn("Domande frequenti", body)
        self.assertIn("Nexi", body)

    def test_move4gaza_host_redirects_to_amarobici(self) -> None:
        root = self.client.get(
            "/",
            headers={"host": "www.move-4-gaza.com"},
            follow_redirects=False,
        )
        self.assertEqual(root.status_code, 301)
        self.assertEqual(root.headers["location"], "https://www.amarobici.it/m4g/")
        bike = self.client.get(
            "/bici?from=poster",
            headers={"host": "move-4-gaza.com"},
            follow_redirects=False,
        )
        self.assertEqual(bike.status_code, 301)
        self.assertEqual(
            bike.headers["location"],
            "https://www.amarobici.it/m4g/bici?from=poster",
        )

    def test_giornata_page(self) -> None:
        response = self.client.get("/m4g/giornata")
        self.assertEqual(response.status_code, 200)
        body = response.text
        self.assertIn("tre momenti principali", body)
        self.assertIn("15 €", body)

    def test_iscrizione_page(self) -> None:
        response = self.client.get("/m4g/iscrizione")
        self.assertEqual(response.status_code, 200)
        body = response.text
        self.assertIn("Iscrizione all'evento", body)
        self.assertIn("15 €", body)
        self.assertIn("donazione", body.lower())

    def test_bike_page_medio_and_switchable_map(self) -> None:
        response = self.client.get("/m4g/bici")
        self.assertEqual(response.status_code, 200)
        body = response.text
        self.assertIn("64 km", body)
        self.assertIn("rideforgaza64.gpx", body)
        self.assertIn("m4g-bike-routes-bike", body)
        self.assertIn('"key":"64"', body.replace(" ", ""))

    def test_gestione_menu_prices_and_page_flags(self) -> None:
        from app.m4g_cms import reset_catalog

        admin = TestClient(app)
        login = admin.post(
            "/m4g/gestione/login",
            data={"password": M4G_TEST_PASSWORD},
            follow_redirects=False,
        )
        self.assertIn(login.status_code, (302, 303))
        try:
            hidden = admin.post(
                "/m4g/gestione/pages",
                data={},
                follow_redirects=False,
            )
            self.assertIn(hidden.status_code, (302, 303))
            bar = self.client.get("/m4g/bar")
            merch = self.client.get("/m4g/merch")
            self.assertEqual(bar.status_code, 404)
            self.assertEqual(merch.status_code, 404)
            home = self.client.get("/m4g/")
            self.assertNotIn('href="/m4g/bar"', home.text)
            self.assertNotIn('href="/m4g/merch"', home.text)
            self.assertNotIn("Raccolta di questa edizione", home.text)

            shown = admin.post(
                "/m4g/gestione/pages",
                data={"show_bar": "1", "show_merch": "1", "show_total": "1"},
                follow_redirects=False,
            )
            self.assertIn(shown.status_code, (302, 303))
            kitchen = admin.post(
                "/m4g/gestione/vendors",
                data={
                    "v_id": "cucina-test",
                    "v_name": "Cucina Test",
                    "v_blurb": "Primi del giorno",
                    "v_status": "confirmed",
                },
                follow_redirects=False,
            )
            self.assertIn(kitchen.status_code, (302, 303))
            menu = admin.post(
                "/m4g/gestione/menu",
                data={
                    "sec_category": "Pranzo — Cucina Test",
                    "sec_vendor": "cucina-test",
                    "item_section": "0",
                    "item_id": "piatto-test",
                    "item_name": "Lasagna solidale",
                    "item_price": "8,50",
                },
                follow_redirects=False,
            )
            self.assertIn(menu.status_code, (302, 303))
            page = self.client.get("/m4g/bar")
            self.assertEqual(page.status_code, 200)
            self.assertIn("Lasagna solidale", page.text)
            self.assertIn("8.50", page.text)
            self.assertIn("Cucina Test", page.text)
            checkout = self.client.post(
                "/m4g/bar/checkout",
                data={"cart_json": '[{"id":"piatto-test","quantity":2}]'},
            )
            self.assertEqual(checkout.status_code, 200)
            self.assertIn("17.00", checkout.text)
        finally:
            reset_catalog()

    def test_gestione_merch_photos_and_route_fields(self) -> None:
        from app.m4g_cms import reset_page_content

        admin = TestClient(app)
        login = admin.post(
            "/m4g/gestione/login",
            data={"password": M4G_TEST_PASSWORD},
            follow_redirects=False,
        )
        self.assertIn(login.status_code, (302, 303))
        gpx = (
            b'<?xml version="1.0" encoding="UTF-8"?>'
            b'<gpx version="1.1"><trk><name>Medio</name><trkseg>'
            b'<trkpt lat="45.46" lon="9.19"></trkpt></trkseg></trk></gpx>'
        )
        try:
            merch = admin.post(
                "/m4g/gestione/merch",
                data={
                    "slot": "socks",
                    "title": "Calze test",
                    "blurb": "Lana del test",
                },
                files={"photo": ("calze.png", b"\x89PNG\r\n\x1a\n", "image/png")},
            )
            self.assertEqual(merch.status_code, 200)
            page = self.client.get("/m4g/merch")
            self.assertEqual(page.status_code, 200)
            self.assertIn("Calze test", page.text)
            self.assertIn("Lana del test", page.text)
            self.assertIn("/m4g/cms/media/", page.text)
            self.assertIn("T-shirt Move4Gaza", page.text)

            route = admin.post(
                "/m4g/gestione/route",
                data={
                    "route_key": "64",
                    "title": "Medio test 64",
                    "copy": "Copy del medio",
                },
                files={"gpx": ("medio.gpx", gpx, "application/gpx+xml")},
            )
            self.assertEqual(route.status_code, 200)
            bike = self.client.get("/m4g/bici")
            self.assertEqual(bike.status_code, 200)
            self.assertIn("Medio test 64", bike.text)
            self.assertIn("Copy del medio", bike.text)
            self.assertIn("/m4g/cms/routes/", bike.text)
            self.assertIn("rideforgaza112.gpx", bike.text)

            run_edit = admin.post(
                "/m4g/gestione/route",
                data={
                    "route_key": "run",
                    "title": "Corsa di prova",
                    "copy": "Testo corsa di prova",
                },
            )
            self.assertEqual(run_edit.status_code, 200)
            run_page = self.client.get("/m4g/corsa")
            self.assertIn("Testo corsa di prova", run_page.text)
            self.assertIn("Corsa di prova", run_page.text)
            self.assertIn("amgaz_corsa.gpx", run_page.text)
        finally:
            reset_page_content()

    def test_gestione_requires_admin_login(self) -> None:
        fresh = TestClient(app)
        response = fresh.get("/m4g/gestione")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Area riservata agli organizzatori", response.text)

    def test_go_live_skips_site_password_not_gestione(self) -> None:
        from app.m4g_cms import set_site_public

        set_site_public(True)
        try:
            fresh = TestClient(app)
            home = fresh.get("/m4g/", follow_redirects=False)
            self.assertEqual(home.status_code, 200)
            self.assertNotIn("/m4g/access", home.headers.get("location", ""))
            gestione = fresh.get("/m4g/gestione")
            self.assertIn("Area riservata agli organizzatori", gestione.text)
        finally:
            set_site_public(False)


    def test_giornata_hides_food_section_when_bar_off(self) -> None:
        from app.m4g_cms import set_page_visibility

        admin = TestClient(app)
        admin.post(
            "/m4g/gestione/login",
            data={"password": M4G_TEST_PASSWORD},
            follow_redirects=False,
        )
        try:
            admin.post(
                "/m4g/gestione/pages",
                data={"show_merch": "1", "show_total": "1"},
                follow_redirects=False,
            )
            page = self.client.get("/m4g/giornata")
            self.assertEqual(page.status_code, 200)
            self.assertNotIn("Cibo e bar", page.text)
        finally:
            set_page_visibility(show_bar=True, show_merch=True, show_total=True)

    def test_gpx_download_attachment(self) -> None:
        response = self.client.get("/m4g/gpx/64.gpx")
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment", response.headers.get("content-disposition", ""))
        self.assertIn(b"<gpx", response.content[:5000].lower())
        missing = self.client.get("/m4g/gpx/unknown.gpx")
        self.assertEqual(missing.status_code, 404)

    def test_bar_manual_payment_flow(self) -> None:
        from app import m4g_auth
        from app.m4g_cms import reset_catalog

        admin = TestClient(app)
        admin.post(
            "/m4g/gestione/login",
            data={"password": m4g_auth.M4G_ADMIN_PASSWORD},
            follow_redirects=False,
        )
        try:
            admin.post(
                "/m4g/gestione/pages",
                data={"show_bar": "1", "show_merch": "1", "show_total": "1"},
                follow_redirects=False,
            )
            checkout = self.client.post(
                "/m4g/bar/checkout",
                data={"cart_json": '[{"id":"acqua","quantity":1}]'},
            )
            self.assertEqual(checkout.status_code, 200)
            self.assertIn("Ho pagato con Satispay", checkout.text)
            ref_start = checkout.text.find('action="/m4g/bar/')
            self.assertNotEqual(ref_start, -1)
            import re

            match = re.search(r'/m4g/bar/(BAR[A-F0-9]+)/manual', checkout.text)
            self.assertIsNotNone(match)
            reference = match.group(1)
            code_match = re.search(
                r'class="m4g-pay-code">([A-Z0-9]{5})</code>', checkout.text
            )
            self.assertIsNotNone(code_match)
            short_code = code_match.group(1)
            manual = self.client.post(
                f"/m4g/bar/{reference}/manual",
                data={"method": "satispay"},
                follow_redirects=False,
            )
            self.assertIn(manual.status_code, (302, 303))
            pending = self.client.get(f"/m4g/ordine/{reference}/consumi")
            self.assertEqual(pending.status_code, 200)
            self.assertIn("In verifica", pending.text)
            self.assertIn(short_code, pending.text)
            paid = admin.post(
                "/m4g/gestione/bar-paid",
                data={"reference": reference},
                follow_redirects=False,
            )
            self.assertIn(paid.status_code, (302, 303))
            consumi = self.client.get(f"/m4g/ordine/{reference}/consumi")
            self.assertIn("Da ritirare", consumi.text)
            token_match = re.search(r'data-token="([^"]+)"', consumi.text)
            self.assertIsNotNone(token_match)
            token = token_match.group(1)
            redeem = self.client.post(
                f"/m4g/ordine/{reference}/consumo/{token}/redeem"
            )
            self.assertEqual(redeem.status_code, 200)
            cassa = admin.get("/m4g/gestione/cassa")
            self.assertEqual(cassa.status_code, 200)
            self.assertNotIn(short_code, cassa.text.split("Da verificare")[1].split("Eligible")[0])
        finally:
            reset_catalog()

    def test_vendor_logo_upload(self) -> None:
        from app.m4g_cms import reset_catalog

        admin = TestClient(app)
        admin.post(
            "/m4g/gestione/login",
            data={"password": M4G_TEST_PASSWORD},
            follow_redirects=False,
        )
        try:
            logo = admin.post(
                "/m4g/gestione/vendor-logo",
                data={"vendor_id": "cucina-franca"},
                files={"logo": ("logo.png", b"\x89PNG\r\n\x1a\n", "image/png")},
            )
            self.assertEqual(logo.status_code, 200)
            bar = self.client.get("/m4g/bar")
            self.assertIn("/m4g/cms/media/", bar.text)
            reset_resp = admin.post(
                "/m4g/gestione/vendor-logo-reset",
                data={"vendor_id": "cucina-franca"},
            )
            self.assertEqual(reset_resp.status_code, 200)
        finally:
            reset_catalog()

    def test_admin_password_separate_from_site_preview(self) -> None:
        from app import m4g_auth

        old_admin = m4g_auth.M4G_ADMIN_PASSWORD
        try:
            m4g_auth.M4G_ADMIN_PASSWORD = "gestionale-separato"
            admin = TestClient(app)
            bad = admin.post(
                "/m4g/gestione/login",
                data={"password": M4G_TEST_PASSWORD},
                follow_redirects=False,
            )
            self.assertEqual(bad.status_code, 302)
            self.assertIn("error=bad", bad.headers.get("location", ""))
            good = admin.post(
                "/m4g/gestione/login",
                data={"password": "gestionale-separato"},
                follow_redirects=False,
            )
            self.assertEqual(good.status_code, 302)
            self.assertIn("/m4g/gestione", good.headers.get("location", ""))
        finally:
            m4g_auth.M4G_ADMIN_PASSWORD = old_admin

    def test_csv_exports_require_admin(self) -> None:
        fresh = TestClient(app)
        reg = fresh.get("/m4g/gestione/export/iscrizioni.csv", follow_redirects=False)
        self.assertEqual(reg.status_code, 302)
        admin = TestClient(app)
        admin.post(
            "/m4g/gestione/login",
            data={"password": M4G_TEST_PASSWORD},
            follow_redirects=False,
        )
        reg_ok = admin.get("/m4g/gestione/export/iscrizioni.csv")
        self.assertEqual(reg_ok.status_code, 200)
        self.assertIn("reference", reg_ok.text)
        bar_ok = admin.get("/m4g/gestione/export/bar.csv")
        self.assertEqual(bar_ok.status_code, 200)
        self.assertIn("short_code", bar_ok.text)


if __name__ == "__main__":
    unittest.main()
