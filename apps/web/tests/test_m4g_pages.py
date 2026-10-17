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
        self.assertIn("data-m4g-adherents-carousel", body)
        self.assertIn("m4g-adherents-carousel__track", body)
        self.assertIn("m4g-adherents-carousel.js", body)
        self.assertIn("Amaro", body)
        self.assertIn("Il Forno di Lambrate", body)
        self.assertIn("Le Polveri", body)
        self.assertIn("Partizan Bonola", body)
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

    def test_chi_siamo_sunbirds_update_section(self) -> None:
        from app.m4g_config import M4G_EVENT

        response = self.client.get("/m4g/chi-siamo")
        self.assertEqual(response.status_code, 200)
        body = response.text
        update = M4G_EVENT["beneficiary"]["update"]
        self.assertIn("Cosa hanno fatto i Sunbirds dall", body)
        humanitarian_title = update["blocks"][0]["title"]
        sport_title = update["blocks"][1]["title"]
        self.assertIn(humanitarian_title, body)
        self.assertIn(sport_title, body)
        self.assertLess(body.index(humanitarian_title), body.index(sport_title))
        wck_quote = update["blocks"][0]["segments"][0]["quotes"][0]
        self.assertIn(wck_quote, body)
        self.assertIn('data-block="humanitarian"', body)
        self.assertIn('data-block="sport"', body)

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
                    "v_id": ["cucina-test", "forno-test"],
                    "v_name": ["Cucina Test", "Forno Test"],
                    "v_blurb": ["Primi del giorno", "Pizza"],
                    "v_status": ["confirmed", "confirmed"],
                },
                follow_redirects=False,
            )
            self.assertIn(kitchen.status_code, (302, 303))
            menu = admin.post(
                "/m4g/gestione/menu",
                data={
                    "sec_category": "Pranzo — Cucina Test",
                    "sec_vendor": "cucina-test",
                    "sec_kind": "cibo",
                    "item_section": ["0", "0"],
                    "item_id": ["piatto-test", "pizza-test"],
                    "item_name": ["Lasagna solidale", "Margherita"],
                    "item_price": ["8,50", "5,00"],
                    "item_vendor": ["", "forno-test"],
                },
                follow_redirects=False,
            )
            self.assertIn(menu.status_code, (302, 303))
            page = self.client.get("/m4g/bar")
            self.assertEqual(page.status_code, 200)
            self.assertIn("Lasagna solidale", page.text)
            self.assertIn("8.50", page.text)
            self.assertIn("Cucina Test", page.text)
            self.assertIn("m4g-item__producer", page.text)
            self.assertIn("m4g-menu-tabs", page.text)
            self.assertIn('id="menu-cibo"', page.text)
            self.assertIn('href="#menu-cibo"', page.text)
            self.assertIn("m4g-vendors-marquee", page.text)
            self.assertIn('data-menu-kind="cibo"', page.text)
            self.assertIn("Margherita", page.text)
            self.assertIn("Forno Test", page.text)
            bere_tab = self.client.get("/m4g/bar?tipo=bere")
            self.assertEqual(bere_tab.status_code, 200)
            self.assertIn('data-menu-tipo="bere"', bere_tab.text)
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
                    "models": "1,2,4",
                },
                files=[
                    ("model_photo", ("m1.png", b"\x89PNG\r\n\x1a\n", "image/png")),
                    ("model_photo", ("m2.png", b"\x89PNG\r\n\x1a\n", "image/png")),
                ],
            )
            self.assertEqual(merch.status_code, 200)
            page = self.client.get("/m4g/merch")
            self.assertEqual(page.status_code, 200)
            self.assertIn("Calze test", page.text)
            self.assertIn("Lana del test", page.text)
            self.assertIn("3 modelli", page.text)
            self.assertIn("m4g-merch-model__name", page.text)
            self.assertIn("data-m4g-merch-model=\"1\"", page.text)
            self.assertIn("data-m4g-merch-model=\"2\"", page.text)
            self.assertIn("data-m4g-merch-model=\"4\"", page.text)
            self.assertGreaterEqual(page.text.count("/m4g/cms/media/"), 2)
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
            self.assertIn("strava.com/routes/3546291038841771126", run_page.text)
            self.assertIn("komoot.com", run_page.text)
        finally:
            reset_page_content()

    def test_gestione_requires_admin_login(self) -> None:
        fresh = TestClient(app)
        response = fresh.get("/m4g/gestione")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Area riservata all'organizzazione", response.text)

    def test_go_live_skips_site_password_not_gestione(self) -> None:
        from app.m4g_cms import set_site_public

        set_site_public(True)
        try:
            fresh = TestClient(app)
            home = fresh.get("/m4g/", follow_redirects=False)
            self.assertEqual(home.status_code, 200)
            self.assertNotIn("/m4g/access", home.headers.get("location", ""))
            gestione = fresh.get("/m4g/gestione")
            self.assertIn("Area riservata all'organizzazione", gestione.text)
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

    def test_home_hides_total_when_off(self) -> None:
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
                data={"show_bar": "1", "show_merch": "1"},
                follow_redirects=False,
            )
            page = self.client.get("/m4g/")
            self.assertEqual(page.status_code, 200)
            self.assertNotIn("Raccolta di questa edizione", page.text)
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
            email_save = self.client.post(
                f"/m4g/ordine/{reference}/email",
                data={"email": "bar-manual@example.test"},
            )
            self.assertEqual(email_save.status_code, 200)
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
            self.assertIn("Recati allo stand", consumi.text)
            token_match = re.search(r'data-token="([^"]+)"', consumi.text)
            self.assertIsNotNone(token_match)
            token = token_match.group(1)
            redeem = self.client.post(
                f"/m4g/ordine/{reference}/consumo/{token}/redeem"
            )
            self.assertEqual(redeem.status_code, 200)
            redeem_body = redeem.json()
            self.assertEqual(redeem_body.get("outcome"), "claimed")
            self.assertEqual(redeem_body.get("status"), "redeemed")
            redeem_again = self.client.post(
                f"/m4g/ordine/{reference}/consumo/{token}/redeem"
            )
            self.assertEqual(redeem_again.status_code, 409)
            again_body = redeem_again.json()
            self.assertEqual(again_body.get("outcome"), "already_redeemed")
            cassa = admin.get("/m4g/gestione/cassa")
            self.assertEqual(cassa.status_code, 200)
            self.assertNotIn(short_code, cassa.text.split("Da verificare")[1].split("Eligible")[0])
        finally:
            reset_catalog()

    def test_bar_redeem_two_banners_same_order(self) -> None:
        from app import m4g_auth
        from app.m4g_cms import reset_catalog

        import re

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
                data={"cart_json": '[{"id":"acqua","quantity":2}]'},
            )
            self.assertEqual(checkout.status_code, 200)
            match = re.search(r'/m4g/bar/(BAR[A-F0-9]+)/manual', checkout.text)
            self.assertIsNotNone(match)
            reference = match.group(1)
            self.client.post(
                f"/m4g/bar/{reference}/manual",
                data={"method": "satispay"},
                follow_redirects=False,
            )
            admin.post(
                "/m4g/gestione/bar-paid",
                data={"reference": reference},
                follow_redirects=False,
            )
            consumi = self.client.get(f"/m4g/ordine/{reference}/consumi")
            tokens = re.findall(r'data-token="([^"]+)"', consumi.text)
            self.assertEqual(len(tokens), 2)
            for token in tokens:
                response = self.client.post(
                    f"/m4g/ordine/{reference}/consumo/{token}/redeem"
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json().get("outcome"), "claimed")
        finally:
            reset_catalog()

    def test_adherents_cms_and_logo(self) -> None:
        from app.m4g_cms import reset_catalog

        admin = TestClient(app)
        admin.post(
            "/m4g/gestione/login",
            data={"password": M4G_TEST_PASSWORD},
            follow_redirects=False,
        )
        try:
            saved = admin.post(
                "/m4g/gestione/adherents",
                data={"a_id": "assoc-test", "a_name": "Associazione Test"},
                follow_redirects=False,
            )
            self.assertIn(saved.status_code, (302, 303))
            home = self.client.get("/m4g/")
            self.assertIn("Associazione Test", home.text)
            logo = admin.post(
                "/m4g/gestione/adherent-logo",
                data={"adherent_id": "assoc-test"},
                files={"logo": ("logo.png", b"\x89PNG\r\n\x1a\n", "image/png")},
            )
            self.assertEqual(logo.status_code, 200)
            home_logo = self.client.get("/m4g/")
            self.assertIn("/m4g/cms/media/", home_logo.text)
            reset_resp = admin.post(
                "/m4g/gestione/adherent-logo-reset",
                data={"adherent_id": "assoc-test"},
            )
            self.assertEqual(reset_resp.status_code, 200)
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
            self.assertIn("m4g-item__logo", bar.text)
            reset_resp = admin.post(
                "/m4g/gestione/vendor-logo-reset",
                data={"vendor_id": "cucina-franca"},
            )
            self.assertEqual(reset_resp.status_code, 200)
        finally:
            reset_catalog()

    def test_m4g_qr_pages(self) -> None:
        index = self.client.get("/m4g/qr")
        self.assertEqual(index.status_code, 200)
        self.assertIn("/m4g/qr/iscrizione", index.text)
        self.assertIn("/m4g/qr/donazione", index.text)
        self.assertIn("/m4g/qr/cibo", index.text)
        self.assertIn("/m4g/qr/bere", index.text)
        self.assertIn("/m4g/qr/merch", index.text)
        registration = self.client.get("/m4g/qr/iscrizione")
        self.assertEqual(registration.status_code, 200)
        self.assertNotIn("api.qrserver.com", registration.text)
        self.assertIn("<svg", registration.text)
        self.assertIn("/m4g/qr/iscrizione.svg", registration.text)
        self.assertIn("/m4g/qr/iscrizione.png", registration.text)
        self.assertIn("/m4g/iscrizione", registration.text)
        png = self.client.get("/m4g/qr/iscrizione.png")
        self.assertEqual(png.status_code, 200)
        self.assertEqual(png.headers.get("content-type"), "image/png")
        from app.m4g_qr import png_width_from_bytes

        width = png_width_from_bytes(png.content)
        self.assertGreaterEqual(width, 10_000)
        donation = self.client.get("/m4g/qr/donazione")
        self.assertEqual(donation.status_code, 200)
        self.assertNotIn("api.qrserver.com", donation.text)
        self.assertIn("/m4g/donazione", donation.text)
        food = self.client.get("/m4g/qr/cibo")
        self.assertEqual(food.status_code, 200)
        self.assertIn("tipo=cibo", food.text)
        drinks = self.client.get("/m4g/qr/bere")
        self.assertEqual(drinks.status_code, 200)
        self.assertIn("tipo=bere", drinks.text)
        merch = self.client.get("/m4g/qr/merch")
        self.assertEqual(merch.status_code, 200)
        self.assertIn("/m4g/merch", merch.text)

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
        merch_ok = admin.get("/m4g/gestione/export/merch.csv")
        self.assertEqual(merch_ok.status_code, 200)
        self.assertIn("product", merch_ok.text)

    def test_gestione_merch_orders_section(self) -> None:
        import re

        from app.database import SessionLocal
        from app.m4g_cms import set_page_visibility
        from app.models import BarOrder

        email = "ordine-merch@example.test"
        try:
            set_page_visibility(show_bar=True, show_merch=True, show_total=True)
            checkout = self.client.post(
                "/m4g/merch/checkout",
                data={
                    "cart_json": '[{"slot":"socks","model":"2","size":"L","quantity":2}]',
                },
            )
            self.assertEqual(checkout.status_code, 200)
            self.assertIn("Nessuna consegna", checkout.text)
            self.assertIn('id="m4g-order-email"', checkout.text)
            ref_match = re.search(r"Riferimento: <code>(MRC[A-F0-9]+)</code>", checkout.text)
            self.assertIsNotNone(ref_match)
            reference = ref_match.group(1)
            saved = self.client.post(
                f"/m4g/ordine/{reference}/email",
                data={"email": email},
            )
            self.assertEqual(saved.status_code, 200)
            admin = TestClient(app)
            admin.post(
                "/m4g/gestione/login",
                data={"password": M4G_TEST_PASSWORD},
                follow_redirects=False,
            )
            gestione = admin.get("/m4g/gestione/ordini")
            self.assertEqual(gestione.status_code, 200)
            self.assertIn('id="cms-ordini"', gestione.text)
            self.assertIn("Ordini merch", gestione.text)
            self.assertIn('id="cms-cibo"', gestione.text)
            self.assertIn("Ordini cibo", gestione.text)
            ordini_html = gestione.text.split('id="cms-ordini"', 1)[1].split(
                'id="cms-iscrizioni"', 1
            )[0]
            self.assertIn(email, ordini_html)
            self.assertIn("Calze solidali", ordini_html)
            merch_csv = admin.get("/m4g/gestione/export/merch.csv")
            self.assertIn("Calze solidali", merch_csv.text)
            self.assertIn(email, merch_csv.text)
            self.assertIn(reference, merch_csv.text)
        finally:
            session = SessionLocal()
            try:
                session.query(BarOrder).filter(BarOrder.email == email).delete()
                session.commit()
            finally:
                session.close()

    def test_gestione_food_orders_page(self) -> None:
        import re

        from app.m4g_cms import set_page_visibility

        set_page_visibility(show_bar=True, show_merch=True, show_total=True)
        checkout = self.client.post(
            "/m4g/bar/checkout",
            data={"cart_json": '[{"id":"piadina","quantity":2}]'},
        )
        self.assertEqual(checkout.status_code, 200)
        ref_match = re.search(r"Riferimento: <code>(BAR[A-F0-9]+)</code>", checkout.text)
        self.assertIsNotNone(ref_match)
        reference = ref_match.group(1)
        self.addCleanup(self._delete_bar_order, reference)
        admin = TestClient(app)
        admin.post(
            "/m4g/gestione/login",
            data={"password": M4G_TEST_PASSWORD},
            follow_redirects=False,
        )
        resto = admin.get("/m4g/gestione")
        self.assertEqual(resto.status_code, 200)
        self.assertNotIn('id="cms-cibo"', resto.text)
        self.assertIn('href="/m4g/gestione/ordini"', resto.text)
        ordini = admin.get("/m4g/gestione/ordini")
        self.assertEqual(ordini.status_code, 200)
        cibo_html = ordini.text.split('id="cms-cibo"', 1)[1].split('id="cms-ordini"', 1)[0]
        self.assertIn("Piadina", cibo_html)
        self.assertIn(reference, cibo_html)
        self.assertNotIn(reference, ordini.text.split('id="cms-ordini"', 1)[1])

    @staticmethod
    def _delete_bar_order(reference: str) -> None:
        from app.database import SessionLocal
        from app.models import BarOrder

        session = SessionLocal()
        try:
            session.query(BarOrder).filter_by(reference=reference).delete()
            session.commit()
        finally:
            session.close()

    def test_bar_legal_and_multi_voucher_codes(self) -> None:
        import re

        from app import m4g_auth
        from app.database import SessionLocal
        from app.m4g_cms import reset_catalog
        from app.m4g_common import mark_bar_order_paid
        from app.models import BarOrder

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
            bar = self.client.get("/m4g/bar")
            self.assertIn("salti la coda", bar.text.lower())
            self.assertIn("raccolta fondi Move4Gaza", bar.text)
            self.assertIn("donazioni", bar.text.lower())
            checkout = self.client.post(
                "/m4g/bar/checkout",
                data={"cart_json": '[{"id":"birra-piccola","quantity":3}]'},
            )
            self.assertEqual(checkout.status_code, 200)
            match = re.search(r"Riferimento: <code>(BAR[A-F0-9]+)</code>", checkout.text)
            self.assertIsNotNone(match)
            reference = match.group(1)
            session = SessionLocal()
            try:
                order = session.query(BarOrder).filter_by(reference=reference).first()
                self.assertIsNotNone(order)
                mark_bar_order_paid(order, session)
            finally:
                session.close()
            consumi = self.client.get(f"/m4g/ordine/{reference}/consumi")
            self.assertEqual(consumi.status_code, 200)
            self.assertIn("Recati allo stand", consumi.text)
            tokens = re.findall(r'data-token="([^"]+)"', consumi.text)
            self.assertEqual(len(tokens), 3)
            self.assertEqual(len(set(tokens)), 3)
            codes = re.findall(r'class="m4g-pay-code">([A-Z0-9]{5})</code>', consumi.text)
            self.assertGreaterEqual(len(codes), 1)
            self.assertTrue(all(code == codes[0] for code in codes))
        finally:
            reset_catalog()

    def test_order_confirmation_email_once(self) -> None:
        from unittest.mock import patch

        from app.database import SessionLocal
        from app.m4g_cms import reset_catalog
        from app.models import BarOrder

        with patch("app.m4g_mail._smtp_send", return_value=True) as send_mock:
            checkout = self.client.post(
                "/m4g/bar/checkout",
                data={"cart_json": '[{"id":"acqua","quantity":1}]'},
            )
            self.assertEqual(checkout.status_code, 200)
            import re

            ref_match = re.search(r'data-m4g-payment-order-ref="(BAR[A-F0-9]+)"', checkout.text)
            self.assertIsNotNone(ref_match)
            reference = ref_match.group(1)
            addr = "conferma-ordine@example.test"
            ok1 = self.client.post(
                f"/m4g/ordine/{reference}/email", data={"email": addr}
            )
            ok2 = self.client.post(
                f"/m4g/ordine/{reference}/email", data={"email": addr}
            )
            self.assertEqual(ok1.status_code, 200)
            self.assertEqual(ok2.status_code, 200)
            self.assertEqual(send_mock.call_count, 1)
            body = send_mock.call_args[0][2]
            self.assertIn("/m4g/ordine/", body)
            self.assertIn("/paga", body)
        session = SessionLocal()
        try:
            session.query(BarOrder).filter(BarOrder.reference == reference).delete()
            session.commit()
        finally:
            session.close()
            reset_catalog()

    def test_cassa_awaiting_without_items_json(self) -> None:
        from app import m4g_auth
        from app.database import SessionLocal
        from app.m4g_cms import reset_catalog
        from app.models import BarOrder

        admin = TestClient(app)
        admin.post(
            "/m4g/gestione/login",
            data={"password": m4g_auth.M4G_ADMIN_PASSWORD},
            follow_redirects=False,
        )
        reference = None
        try:
            checkout = self.client.post(
                "/m4g/merch/checkout",
                data={"cart_json": '[{"slot":"socks","model":"1","size":"S","quantity":1}]'},
            )
            import re

            ref_match = re.search(r'data-m4g-payment-order-ref="(MRC[A-F0-9]+)"', checkout.text)
            reference = ref_match.group(1)
            self.client.post(
                f"/m4g/ordine/{reference}/email",
                data={"email": "cassa@example.test"},
            )
            self.client.post(
                f"/m4g/merch/{reference}/manual",
                data={"method": "satispay"},
                follow_redirects=False,
            )
            cassa = admin.get("/m4g/gestione/cassa?kind=merch")
            self.assertEqual(cassa.status_code, 200)
            self.assertIn("cassa@example.test", cassa.text)
            self.assertNotIn("price_cents", cassa.text)
        finally:
            if reference:
                session = SessionLocal()
                try:
                    session.query(BarOrder).filter_by(reference=reference).delete()
                    session.commit()
                finally:
                    session.close()
            reset_catalog()

    def test_merch_page_no_delivery_notice(self) -> None:
        from app.m4g_cms import set_page_visibility

        try:
            set_page_visibility(show_merch=True)
            page = self.client.get("/m4g/merch")
            self.assertEqual(page.status_code, 200)
            self.assertIn("Nessuna consegna", page.text)
            self.assertIn("ricavato verrà donato", page.text)
            self.assertIn("m4g-merch-checkout-form", page.text)
        finally:
            set_page_visibility(show_merch=True)

    def test_other_amount_on_donation_and_registration(self) -> None:
        from app.database import SessionLocal
        from app.models import M4gRegistration

        email = "altro-importo@example.test"
        donate = self.client.get("/m4g/donazione")
        self.assertEqual(donate.status_code, 200)
        self.assertIn("Altro importo", donate.text)
        self.assertIn("superiore a 15 €", donate.text)
        for path in ("/m4g/bici", "/m4g/corsa", "/m4g/ingresso"):
            page = self.client.get(path)
            self.assertEqual(page.status_code, 200, path)
            self.assertIn("Altro importo", page.text)
            self.assertIn("superiore a 15 €", page.text)
        soccer = self.client.get("/m4g/calcio")
        self.assertEqual(soccer.status_code, 200)
        self.assertIn("Altro importo", soccer.text)
        self.assertIn("superiore a 75 €", soccer.text)

        person = {
            "first_name": "Ada",
            "last_name": "Test",
            "email": email,
        }
        try:
            self._assert_other_amount_submits(person, email)
        finally:
            session = SessionLocal()
            try:
                session.query(M4gRegistration).filter(M4gRegistration.email == email).delete()
                session.commit()
            finally:
                session.close()

    def _assert_other_amount_submits(self, person: dict[str, str], email: str) -> None:
        too_low = self.client.post(
            "/m4g/donazione",
            data={**person, "amount_mode": "custom", "amount_eur": "15"},
        )
        self.assertEqual(too_low.status_code, 400)
        ok = self.client.post(
            "/m4g/donazione",
            data={**person, "amount_mode": "custom", "amount_eur": "20"},
        )
        self.assertEqual(ok.status_code, 200)
        self.assertIn("20.00 €", ok.text)
        standard = self.client.post("/m4g/donazione", data=person)
        self.assertEqual(standard.status_code, 200)
        self.assertIn("15.00 €", standard.text)
        self.assertIn("https://www.paypal.com/pool/9t6Ot5Kez2?sr=wccr", standard.text)
        self.assertIn("Aggiorna importo", standard.text)
        self.assertIn("Bonifico", standard.text)
        self.assertIn("PayPal", standard.text)
        from app.database import SessionLocal
        from app.models import M4gRegistration

        lookup_public = SessionLocal()
        try:
            twenty = (
                lookup_public.query(M4gRegistration)
                .filter_by(email=email, activity="donation", amount_cents=2000)
                .one()
            )
            twenty_ref = twenty.reference
        finally:
            lookup_public.close()
        too_small = self.client.post(
            f"/m4g/pagamento/{twenty_ref}/importo",
            data={"amount_eur": "10"},
        )
        self.assertEqual(too_small.status_code, 400)
        fixed = self.client.post(
            f"/m4g/pagamento/{twenty_ref}/importo",
            data={"amount_eur": "80"},
        )
        self.assertEqual(fixed.status_code, 200)
        self.assertIn("80.00", fixed.text)
        self.assertIn("Importo aggiornato", fixed.text)
        login = self.client.post(
            "/m4g/gestione/login",
            data={"password": M4G_TEST_PASSWORD},
            follow_redirects=False,
        )
        self.assertIn(login.status_code, (302, 303))
        gestione = self.client.get("/m4g/gestione/ordini")
        self.assertEqual(gestione.status_code, 200)
        self.assertIn("Elenco iscrizioni e donazioni", gestione.text)
        self.assertIn("Ada", gestione.text)
        self.assertIn("Donazione", gestione.text)
        self.assertIn("Donazione libera", gestione.text)
        self.assertIn("<th>Iscrizione</th>", gestione.text)
        self.assertIn("15.00", gestione.text)
        self.assertRegex(gestione.text, r"\d{2}/\d{2}/\d{4} \d{2}:\d{2}")
        self.assertIn("Non pagata", gestione.text)
        from app.database import SessionLocal
        from app.models import M4gRegistration

        lookup = SessionLocal()
        try:
            reg = (
                lookup.query(M4gRegistration)
                .filter_by(email=email, activity="donation", amount_cents=1500)
                .order_by(M4gRegistration.id.desc())
                .first()
            )
            self.assertIsNotNone(reg)
            ref = reg.reference
        finally:
            lookup.close()
        updated = self.client.post(
            "/m4g/gestione/registration-amount",
            data={"reference": ref, "amount_eur": "100"},
            follow_redirects=True,
        )
        self.assertEqual(updated.status_code, 200)
        self.assertIn("100.00", updated.text)
        self.assertIn("Importo aggiornato", updated.text)
        hidden = self.client.post(
            "/m4g/gestione/registration-hide",
            data={"reference": ref},
            follow_redirects=False,
        )
        self.assertIn(hidden.status_code, (302, 303))
        visible = self.client.get("/m4g/gestione/ordini")
        self.assertNotIn(ref, visible.text)
        archive = self.client.get("/m4g/gestione/ordini?show_hidden=1")
        self.assertEqual(archive.status_code, 200)
        self.assertIn(ref, archive.text)
        self.assertIn("Non pagata", archive.text)
        check = SessionLocal()
        try:
            stored = check.query(M4gRegistration).filter_by(reference=ref).one()
            self.assertTrue(stored.hidden)
            self.assertEqual(stored.payment_status, "unpaid")
            self.assertEqual(stored.amount_cents, 10000)
            self.assertIsNone(stored.paid_at)
        finally:
            check.close()

        bike_low = self.client.post(
            "/m4g/bici",
            data={**person, "amount_mode": "custom", "amount_eur": "15,00"},
        )
        self.assertEqual(bike_low.status_code, 400)
        bike_ok = self.client.post(
            "/m4g/bici",
            data={**person, "distance": "64", "amount_mode": "custom", "amount_eur": "25"},
        )
        self.assertEqual(bike_ok.status_code, 200)
        self.assertIn("25.00 €", bike_ok.text)
        listed = self.client.get("/m4g/gestione/ordini")
        self.assertIn("64 km", listed.text)

        soccer_base = {
            "team_name": "Solidal",
            "captain": "Ada Test",
            "email": email,
            "fairplay": "1",
            "count": "6",
        }
        soccer_low = self.client.post(
            "/m4g/calcio",
            data={**soccer_base, "amount_mode": "custom", "amount_eur": "75"},
        )
        self.assertEqual(soccer_low.status_code, 400)
        soccer_std = self.client.post("/m4g/calcio", data=soccer_base)
        self.assertEqual(soccer_std.status_code, 200)
        self.assertIn("75.00 €", soccer_std.text)
        soccer_ok = self.client.post(
            "/m4g/calcio",
            data={**soccer_base, "amount_mode": "custom", "amount_eur": "76"},
        )
        self.assertEqual(soccer_ok.status_code, 200)
        self.assertIn("76.00 €", soccer_ok.text)
        soccer_list = self.client.get("/m4g/gestione/ordini")
        self.assertIn("Solidal", soccer_list.text)
        self.assertIn("6 giocatori", soccer_list.text)


class M4gPaidEmailTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._client = TestClient(app)
        cls.client = cls._client.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        client = getattr(cls, "_client", None)
        if client is not None:
            client.__exit__(None, None, None)

    def _make_pending_reg(self, suffix: str) -> str:
        from app.database import SessionLocal
        from app.models import M4gRegistration

        email = f"m4g-paid-mail-{suffix}@example.test"
        ref = f"M4GMAIL{suffix.upper()}"[:20]
        session = SessionLocal()
        try:
            session.query(M4gRegistration).filter(
                M4gRegistration.email == email
            ).delete()
            session.query(M4gRegistration).filter_by(reference=ref).delete()
            session.commit()
            reg = M4gRegistration(
                reference=ref,
                activity="run",
                first_name="Luigi",
                last_name="Cor",
                email=email,
                amount_cents=1500,
                payload_json="{}",
                payment_status="pending",
            )
            session.add(reg)
            session.commit()
            return ref
        finally:
            session.close()

    def _cleanup(self, ref: str) -> None:
        from app.database import SessionLocal
        from app.models import M4gRegistration

        session = SessionLocal()
        try:
            session.query(M4gRegistration).filter_by(reference=ref).delete()
            session.commit()
        finally:
            session.close()

    def test_gestione_mark_paid_does_not_send_email(self) -> None:
        from unittest.mock import patch

        ref = self._make_pending_reg("one")
        self.addCleanup(lambda: self._cleanup(ref))
        sent: list[tuple[str, str, str]] = []

        def capture(to: str, subject: str, body: str) -> bool:
            sent.append((to, subject, body))
            return True

        login = self.client.post(
            "/m4g/gestione/login",
            data={"password": M4G_TEST_PASSWORD},
            follow_redirects=False,
        )
        self.assertIn(login.status_code, (302, 303))
        with patch("app.m4g_mail._smtp_send", side_effect=capture):
            paid = self.client.post(
                "/m4g/gestione/registration-paid",
                data={"reference": ref},
                follow_redirects=False,
            )
        self.assertIn(paid.status_code, (302, 303))
        self.assertEqual(len(sent), 0)

    def test_gestione_send_email_button(self) -> None:
        from unittest.mock import patch

        ref = self._make_pending_reg("btn")
        self.addCleanup(lambda: self._cleanup(ref))
        sent: list[tuple[str, str, str]] = []

        def capture(to: str, subject: str, body: str) -> bool:
            sent.append((to, subject, body))
            return True

        self.client.post(
            "/m4g/gestione/login",
            data={"password": M4G_TEST_PASSWORD},
            follow_redirects=False,
        )
        self.client.post(
            "/m4g/gestione/registration-paid",
            data={"reference": ref},
            follow_redirects=False,
        )
        with patch("app.m4g_mail._smtp_send", side_effect=capture):
            mail = self.client.post(
                "/m4g/gestione/registration-send-email",
                data={"reference": ref},
                follow_redirects=False,
            )
        self.assertIn(mail.status_code, (302, 303))
        self.assertEqual(len(sent), 1)
        self.assertIn("Benvenutə", sent[0][2])
        repeat = self.client.post(
            "/m4g/gestione/registration-send-email",
            data={"reference": ref},
            follow_redirects=False,
        )
        self.assertIn(repeat.status_code, (302, 303))
        self.assertEqual(len(sent), 1)

    def test_nexi_success_sends_one_confirmation_email(self) -> None:
        from unittest.mock import patch

        from app.database import SessionLocal
        from app.m4g_common import apply_m4g_payment_by_reference, mark_registration_paid
        from app.models import M4gRegistration

        ref = self._make_pending_reg("dup")
        self.addCleanup(lambda: self._cleanup(ref))
        sent: list[str] = []

        def capture(to: str, subject: str, body: str) -> bool:
            sent.append(to)
            return True

        with patch("app.m4g_mail._smtp_send", side_effect=capture):
            session = SessionLocal()
            try:
                apply_m4g_payment_by_reference(ref, session, True, None)
                reg = session.query(M4gRegistration).filter_by(reference=ref).one()
                mark_registration_paid(reg, session)
                apply_m4g_payment_by_reference(ref, session, True, None)
            finally:
                session.close()

        self.assertEqual(len(sent), 1)

    def test_send_email_retries_after_smtp_failure(self) -> None:
        from unittest.mock import patch

        from app.database import SessionLocal
        from app.m4g_common import mark_registration_paid
        from app.m4g_mail import send_paid_confirmation
        from app.models import M4gRegistration

        ref = self._make_pending_reg("retry")
        self.addCleanup(lambda: self._cleanup(ref))
        attempts = {"n": 0}

        def flaky(to: str, subject: str, body: str) -> bool:
            attempts["n"] += 1
            return attempts["n"] > 1

        session = SessionLocal()
        try:
            reg = session.query(M4gRegistration).filter_by(reference=ref).one()
            mark_registration_paid(reg, session)
            with patch("app.m4g_mail._smtp_send", side_effect=flaky):
                reg = session.query(M4gRegistration).filter_by(reference=ref).one()
                self.assertFalse(send_paid_confirmation(reg, session))
                reg = session.query(M4gRegistration).filter_by(reference=ref).one()
                self.assertIsNone(reg.paid_email_sent_at)
                reg = session.query(M4gRegistration).filter_by(reference=ref).one()
                self.assertTrue(send_paid_confirmation(reg, session))
        finally:
            session.close()

        self.assertEqual(attempts["n"], 2)

    def _unlock_m4g_site(self) -> None:
        unlock = self.client.post(
            "/m4g/access",
            data={"password": M4G_TEST_PASSWORD, "next": "/m4g/"},
            follow_redirects=False,
        )
        self.assertIn(unlock.status_code, (302, 303))

    def _make_paid_reg(self, suffix: str, activity: str = "run") -> tuple[str, str]:
        from app.database import SessionLocal
        from app.m4g_common import mark_registration_paid
        from app.models import M4gRegistration

        email = f"m4g-confirm-{suffix}@example.test"
        ref = f"M4GCFM{suffix.upper()}"[:20]
        session = SessionLocal()
        try:
            session.query(M4gRegistration).filter(
                M4gRegistration.email == email
            ).delete()
            session.query(M4gRegistration).filter_by(reference=ref).delete()
            session.commit()
            reg = M4gRegistration(
                reference=ref,
                activity=activity,
                first_name="Anna",
                last_name="Test",
                email=email,
                amount_cents=2000,
                payload_json="{}",
                payment_status="pending",
            )
            session.add(reg)
            session.commit()
            reg = session.query(M4gRegistration).filter_by(reference=ref).one()
            token = mark_registration_paid(reg, session)
            return ref, token
        finally:
            session.close()

    def test_donation_confirmation_email_includes_share_links(self) -> None:
        from app.database import SessionLocal
        from app.m4g_mail import build_paid_confirmation
        from app.models import M4gRegistration

        ref, _token = self._make_paid_reg("donmail", activity="donation")
        self.addCleanup(lambda: self._cleanup(ref))
        session = SessionLocal()
        try:
            reg = session.query(M4gRegistration).filter_by(reference=ref).one()
            _subject, body = build_paid_confirmation(reg)
        finally:
            session.close()
        self.assertIn("wa.me", body)
        self.assertIn("instagram.com/p/Dd65foPiL6K", body)
        self.assertIn("parentə", body)
        self.assertIn("move-4-gaza.com", body)
        self.assertIn("Condividi su WhatsApp:", body)

    def test_confirm_page_donation_share_and_card(self) -> None:
        ref, token = self._make_paid_reg("donpage", activity="donation")
        self.addCleanup(lambda: self._cleanup(ref))
        self._unlock_m4g_site()
        response = self.client.get(f"/m4g/conferma/{token}")
        self.assertEqual(response.status_code, 200)
        body = response.text
        self.assertIn("m4g-donate-card", body)
        self.assertIn("Copia link", body)
        self.assertIn("WhatsApp", body)
        self.assertIn("Condividi su WhatsApp:", body)
        self.assertIn("Riposta una storia su Instagram:", body)
        self.assertIn("www.move-4-gaza.com", body)
        self.assertIn("data-m4g-copy=", body)

    def test_confirm_page_registration_share(self) -> None:
        ref, token = self._make_paid_reg("regpage", activity="run")
        self.addCleanup(lambda: self._cleanup(ref))
        self._unlock_m4g_site()
        response = self.client.get(f"/m4g/conferma/{token}")
        self.assertEqual(response.status_code, 200)
        body = response.text
        self.assertNotIn("m4g-donate-card", body)
        self.assertIn("bellissima iniziativa", body)
        self.assertIn("Copia link", body)

    def test_bulk_logistics_email(self) -> None:
        from datetime import datetime, timezone
        from email.message import EmailMessage
        from unittest.mock import patch

        from app.config import settings
        from app.database import SessionLocal
        from app.m4g_common import mark_registration_paid
        from app.m4g_mail import send_bulk_logistics_email
        from app.models import M4gRegistration

        refs: list[str] = []
        sent_messages: list[EmailMessage] = []

        class FakeSMTP:
            def send_message(self, message: EmailMessage) -> None:
                sent_messages.append(message)

            def quit(self) -> None:
                return None

        def add_reg(
            suffix: str,
            *,
            email: str | None = "bulk-log@example.test",
            payment_status: str = "paid",
            hidden: bool = False,
            logistics_sent: bool = False,
            activity: str = "run",
        ) -> str:
            ref = f"M4GLG{suffix.upper()}"[:20]
            refs.append(ref)
            session = SessionLocal()
            try:
                session.query(M4gRegistration).filter_by(reference=ref).delete()
                reg = M4gRegistration(
                    reference=ref,
                    activity=activity,
                    first_name="A",
                    last_name="B",
                    email=email,
                    amount_cents=1000,
                    payload_json="{}",
                    payment_status=payment_status,
                    hidden=hidden,
                )
                if logistics_sent:
                    reg.logistics_email_sent_at = datetime.now(timezone.utc)
                session.add(reg)
                session.commit()
                if payment_status == "paid" and not logistics_sent:
                    reg = session.query(M4gRegistration).filter_by(reference=ref).one()
                    mark_registration_paid(reg, session)
                return ref
            finally:
                session.close()

        add_reg("a1", email="same@example.test")
        add_reg("a2", email="same@example.test")
        add_reg("b1", email="other@example.test")
        add_reg("pend", payment_status="pending")
        add_reg("hid", hidden=True)
        add_reg("noem", email=None)
        add_reg("done", logistics_sent=True, email="done@example.test")
        def cleanup_all() -> None:
            for r in refs:
                self._cleanup(r)

        self.addCleanup(cleanup_all)

        with (
            patch.object(settings, "smtp_host", "localhost"),
            patch.object(settings, "smtp_from", "staff@move-4-gaza.test"),
            patch("app.m4g_mail._smtp_connect", return_value=FakeSMTP()),
        ):
            session = SessionLocal()
            try:
                result = send_bulk_logistics_email(session)
            finally:
                session.close()

        self.assertIsNone(result.get("error"))
        self.assertEqual(result["failed"], 0)
        self.assertGreaterEqual(result["no_email"], 1)
        ours = [m for m in sent_messages if m["To"] in ("same@example.test", "other@example.test")]
        self.assertEqual(len(ours), 2)
        for msg in ours:
            self.assertEqual(msg["Subject"], "Info logistiche M4G 2026")
            body = msg.get_content()
            self.assertIn("Move4Gaza", body)
            self.assertIn("Ponte delle Barche", body)
            names = sorted(
                part.get_filename()
                for part in msg.iter_attachments()
            )
            self.assertEqual(
                names,
                [
                    "bici-112km.gpx",
                    "bici-25km.gpx",
                    "bici-64km.gpx",
                    "corsa.gpx",
                ],
            )

        session = SessionLocal()
        try:
            for ref in ("M4GLGA1", "M4GLGA2", "M4GLGB1"):
                reg = session.query(M4gRegistration).filter_by(reference=ref).one()
                self.assertIsNotNone(reg.logistics_email_sent_at)
            pending = session.query(M4gRegistration).filter_by(reference="M4GLGPEND").one()
            self.assertIsNone(pending.logistics_email_sent_at)
        finally:
            session.close()

    def test_bulk_logistics_email_smtp_failure_leaves_unmarked(self) -> None:
        import smtplib
        from unittest.mock import patch

        from app.config import settings
        from app.database import SessionLocal
        from app.m4g_common import mark_registration_paid
        from app.m4g_mail import send_bulk_logistics_email
        from app.models import M4gRegistration

        ref = self._make_pending_reg("lgfail")
        self.addCleanup(lambda: self._cleanup(ref))
        session = SessionLocal()
        try:
            reg = session.query(M4gRegistration).filter_by(reference=ref).one()
            mark_registration_paid(reg, session)
        finally:
            session.close()

        class FlakySMTP:
            def __init__(self) -> None:
                self.calls = 0

            def send_message(self, _message) -> None:
                self.calls += 1
                raise smtplib.SMTPException("boom")

            def quit(self) -> None:
                return None

        with (
            patch.object(settings, "smtp_host", "localhost"),
            patch.object(settings, "smtp_from", "staff@move-4-gaza.test"),
            patch("app.m4g_mail._smtp_connect", return_value=FlakySMTP()),
        ):
            session = SessionLocal()
            try:
                result = send_bulk_logistics_email(session)
                reg = session.query(M4gRegistration).filter_by(reference=ref).one()
                self.assertEqual(result["sent"], 0)
                self.assertEqual(result["failed"], 1)
                self.assertIsNone(reg.logistics_email_sent_at)
            finally:
                session.close()

    def test_gestione_logistics_email_button(self) -> None:
        from email.message import EmailMessage
        from unittest.mock import patch

        from app.config import settings
        from app.database import SessionLocal
        from app.m4g_common import mark_registration_paid
        from app.models import M4gRegistration

        ref = self._make_pending_reg("lgbtn")
        self.addCleanup(lambda: self._cleanup(ref))
        session = SessionLocal()
        try:
            reg = session.query(M4gRegistration).filter_by(reference=ref).one()
            mark_registration_paid(reg, session)
        finally:
            session.close()

        sent_messages: list[EmailMessage] = []

        class FakeSMTP:
            def send_message(self, message: EmailMessage) -> None:
                sent_messages.append(message)

            def quit(self) -> None:
                return None

        self.client.post(
            "/m4g/gestione/login",
            data={"password": M4G_TEST_PASSWORD},
            follow_redirects=False,
        )
        page = self.client.get("/m4g/gestione/ordini")
        self.assertIn("Invia mail logistica", page.text)

        with (
            patch.object(settings, "smtp_host", "localhost"),
            patch.object(settings, "smtp_from", "staff@move-4-gaza.test"),
            patch("app.m4g_mail._smtp_connect", return_value=FakeSMTP()),
        ):
            post = self.client.post(
                "/m4g/gestione/logistics-email",
                follow_redirects=False,
            )
        self.assertIn(post.status_code, (302, 303))
        self.assertTrue(
            any(
                m["To"] == "m4g-paid-mail-lgbtn@example.test"
                for m in sent_messages
            )
        )
        follow = self.client.get(post.headers["location"])
        self.assertIn("Mail logistica:", follow.text)


if __name__ == "__main__":
    unittest.main()
