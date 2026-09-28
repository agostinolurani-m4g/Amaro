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
        cls.client = TestClient(app)
        unlock = cls.client.post(
            "/m4g/access",
            data={"password": M4G_TEST_PASSWORD, "next": "/m4g/"},
            follow_redirects=False,
        )
        if unlock.status_code not in (302, 303):
            raise RuntimeError(
                f"M4G access unlock failed ({unlock.status_code}); check M4G_SITE_PASSWORD"
            )

    def test_home_contains_pdf_sections(self) -> None:
        response = self.client.get("/m4g/")
        self.assertEqual(response.status_code, 200)
        body = response.text
        self.assertIn("Cos'è Move4Gaza", body)
        self.assertIn("Il programma della giornata", body)
        self.assertIn("DONA QUI", body)
        self.assertIn("17 ottobre 2026", body)

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


if __name__ == "__main__":
    unittest.main()
