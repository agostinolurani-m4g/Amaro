from __future__ import annotations

import os
import time
import unittest

os.environ.setdefault("NEXI_ENDPOINT", "https://example.test/nexi")
os.environ.setdefault("NEXI_SUCCESS_URL", "https://example.test/success")
os.environ.setdefault("NEXI_FAILURE_URL", "https://example.test/failure")
os.environ.setdefault("SESSION_SECRET", "test-wattlab-secret")

from app.wattlab_auth import (  # noqa: E402
    _member_payload,
    _wattlab_membership_status,
    issue_wattlab_token,
    parse_wattlab_token,
)
from app.models import Member  # noqa: E402


class WattlabTokenTests(unittest.TestCase):
    def test_token_roundtrip(self) -> None:
        token, expires_at = issue_wattlab_token(42)
        self.assertTrue(expires_at.endswith("Z"))
        self.assertEqual(parse_wattlab_token(token), 42)

    def test_token_rejects_tampered_signature(self) -> None:
        token, _ = issue_wattlab_token(7)
        payload, _sig = token.split(".", 1)
        self.assertIsNone(parse_wattlab_token(f"{payload}.bad-signature"))

    def test_token_rejects_expired(self) -> None:
        from app import wattlab_auth

        original = wattlab_auth.time.time
        try:
            wattlab_auth.time.time = lambda: 1_000_000
            token, _ = issue_wattlab_token(99)
            wattlab_auth.time.time = lambda: 9_999_999_999
            self.assertIsNone(parse_wattlab_token(token))
        finally:
            wattlab_auth.time.time = original

    def test_membership_status_active_when_paid(self) -> None:
        member = Member(
            id=1,
            name="Test User",
            email="test@example.com",
            first_name="Test",
            last_name="User",
            membership_type="annuale",
            payment_status="paid",
            membership_status="tesserato",
        )
        self.assertEqual(_wattlab_membership_status(member), "active")
        payload = _member_payload(member)
        self.assertEqual(payload["membershipStatus"], "active")

    def test_membership_status_expired_when_unpaid(self) -> None:
        member = Member(
            id=2,
            name="Test User",
            email="test@example.com",
            first_name="Test",
            last_name="User",
            membership_type="annuale",
            payment_status="pending",
            membership_status="da_tesserare",
        )
        self.assertEqual(_wattlab_membership_status(member), "expired")


if __name__ == "__main__":
    unittest.main()
