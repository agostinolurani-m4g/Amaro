from __future__ import annotations

import os
import unittest

os.environ.setdefault("NEXI_ENDPOINT", "https://example.test/nexi")
os.environ.setdefault("NEXI_SUCCESS_URL", "https://example.test/success")
os.environ.setdefault("NEXI_FAILURE_URL", "https://example.test/failure")
os.environ.setdefault("SESSION_SECRET", "test-m4g-secret")
os.environ.setdefault("M4G_SITE_PASSWORD", "test-m4g-password")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


class M4gPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app)
        unlock = cls.client.post(
            "/m4g/access",
            data={"password": "test-m4g-password", "next": "/m4g/"},
            follow_redirects=False,
        )
        assert unlock.status_code in (302, 303)

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


if __name__ == "__main__":
    unittest.main()
