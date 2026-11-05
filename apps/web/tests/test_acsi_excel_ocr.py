from __future__ import annotations

import os

import _no_real_email  # noqa: F401,E402  (prima di app.*)
import re
import tempfile
import unittest
import zipfile
from unittest import mock
from xml.etree import ElementTree as ET

os.environ.setdefault("NEXI_ENDPOINT", "https://example.test/nexi")
os.environ.setdefault("NEXI_SUCCESS_URL", "https://example.test/nexi/success")
os.environ.setdefault("NEXI_FAILURE_URL", "https://example.test/nexi/failure")
os.environ.setdefault("SESSION_SECRET", "test-acsi-secret")
os.environ.setdefault("M4G_SITE_PASSWORD", "test-m4g-password")

from app import acsi, ocr  # noqa: E402
from app.models import Member  # noqa: E402

_ROOT_RE = re.compile(r"<worksheet\b[^>]*>")
_XMLNS_RE = re.compile(r'xmlns(?::[\w.-]+)?="[^"]+"')


class AcsiExcelTests(unittest.TestCase):
    def setUp(self) -> None:
        handle = tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx")
        handle.close()
        self.output = handle.name

    def tearDown(self) -> None:
        os.unlink(self.output)

    def _sheet_xml(self, path) -> str:
        with zipfile.ZipFile(path) as archive:
            return archive.read(acsi.ACSI_SHEET_PATH).decode("utf-8")

    def test_excel_mantiene_namespace_del_modello(self) -> None:
        member = Member(
            id=1,
            first_name="Mario",
            last_name="Rossi",
            email="mario@example.test",
            codice_fiscale="RSSMRA80A01F205X",
            sport_type="Solo ciclismo",
        )
        acsi._write_acsi_excel([member], acsi.ACSI_TEMPLATE_PATH, self.output)

        original = self._sheet_xml(acsi.ACSI_TEMPLATE_PATH)
        generated = self._sheet_xml(self.output)
        ET.fromstring(generated.encode("utf-8"))  # XML ben formato

        original_ns = set(_XMLNS_RE.findall(_ROOT_RE.search(original).group(0)))
        generated_ns = set(_XMLNS_RE.findall(_ROOT_RE.search(generated).group(0)))
        # mc:Ignorable="x14ac" richiede che x14ac resti dichiarato, o Excel
        # considera il file danneggiato.
        self.assertTrue(original_ns <= generated_ns, original_ns - generated_ns)
        self.assertIsNone(re.search(r"\bns\d+:", generated))

        row = re.search(r'<row r="13".*?</row>', generated, re.S).group(0)
        self.assertIn("Rossi", row)
        self.assertIn("CICLISMO - 184", row)


class VisionErrorTests(unittest.TestCase):
    def test_errore_vision_salva_motivo_senza_chiave(self) -> None:
        api_key = "AIzaTEST-chiave-segreta"
        body = {
            "error": {
                "code": 403,
                "message": "This API method requires billing to be enabled.",
                "status": "PERMISSION_DENIED",
                "details": [{"reason": "BILLING_DISABLED"}],
            }
        }
        response = mock.Mock(ok=False, status_code=403)
        response.json.return_value = body

        with mock.patch.object(ocr.settings, "google_vision_api_key", api_key), \
                mock.patch.object(ocr.requests, "post", return_value=response) as post:
            with self.assertRaises(ValueError) as ctx:
                ocr._vision_ocr_image_bytes(b"png")

        message = str(ctx.exception)
        self.assertIn("403", message)
        self.assertIn("BILLING_DISABLED", message)
        self.assertNotIn(api_key, message)
        _args, kwargs = post.call_args
        self.assertNotIn("params", kwargs)
        self.assertEqual(kwargs["headers"]["X-goog-api-key"], api_key)


if __name__ == "__main__":
    unittest.main()
