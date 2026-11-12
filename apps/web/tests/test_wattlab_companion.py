from __future__ import annotations

import os

import _no_real_email  # noqa: F401,E402  (prima di app.*)
import unittest

os.environ.setdefault("NEXI_ENDPOINT", "https://example.test/nexi")
os.environ.setdefault("NEXI_SUCCESS_URL", "https://example.test/success")
os.environ.setdefault("NEXI_FAILURE_URL", "https://example.test/failure")
os.environ.setdefault("SESSION_SECRET", "test-wattlab-secret")

from app import wattlab_companion  # noqa: E402
from app.wattlab_auth import issue_wattlab_token, parse_wattlab_token  # noqa: E402
from app.wattlab_companion import (  # noqa: E402
    companion_login_url,
    issue_companion_code,
    parse_companion_code,
)


class CompanionCodeTests(unittest.TestCase):
    def test_code_roundtrip(self) -> None:
        self.assertEqual(parse_companion_code(issue_companion_code(42)), 42)

    def test_code_rejects_tampered_signature(self) -> None:
        payload, _sig = issue_companion_code(7).split(".", 1)
        self.assertIsNone(parse_companion_code(f"{payload}.bad-signature"))
        self.assertIsNone(parse_companion_code("non-un-codice"))

    def test_code_rejects_expired(self) -> None:
        original = wattlab_companion.time.time
        try:
            wattlab_companion.time.time = lambda: 1_000_000
            code = issue_companion_code(99)
            wattlab_companion.time.time = lambda: 1_000_000 + 121
            self.assertIsNone(parse_companion_code(code))
        finally:
            wattlab_companion.time.time = original

    def test_code_and_wattlab_token_are_not_interchangeable(self) -> None:
        token, _ = issue_wattlab_token(5)
        self.assertIsNone(parse_companion_code(token))
        self.assertIsNone(parse_wattlab_token(issue_companion_code(5)))

    def test_login_url_points_to_companion(self) -> None:
        url = companion_login_url(3)
        self.assertTrue(url.startswith("https://"))
        base, code = url.split("/api/auth/amaro?code=", 1)
        self.assertFalse(base.endswith("/"))
        self.assertEqual(parse_companion_code(code), 3)


if __name__ == "__main__":
    unittest.main()
