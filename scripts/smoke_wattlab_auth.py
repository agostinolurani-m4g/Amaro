#!/usr/bin/env python3
"""Smoke test token HMAC helpers without importing FastAPI."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import time
import unittest

SESSION_SECRET = "test-wattlab-secret"


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def issue_token(member_id: int, ttl_days: int = 30) -> str:
    exp = int(time.time()) + ttl_days * 86400
    payload = json.dumps({"member_id": member_id, "exp": exp}, separators=(",", ":"))
    payload_b64 = b64url_encode(payload.encode("utf-8"))
    signature = hmac.new(
        SESSION_SECRET.encode("utf-8"),
        payload_b64.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return f"{payload_b64}.{b64url_encode(signature)}"


def parse_token(token: str) -> int | None:
    try:
        payload_b64, sig_b64 = token.split(".", 1)
    except ValueError:
        return None
    expected_sig = hmac.new(
        SESSION_SECRET.encode("utf-8"),
        payload_b64.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    try:
        actual_sig = b64url_decode(sig_b64)
    except Exception:
        return None
    if not hmac.compare_digest(expected_sig, actual_sig):
        return None
    payload = json.loads(b64url_decode(payload_b64))
    if payload.get("exp", 0) < int(time.time()):
        return None
    member_id = payload.get("member_id")
    return member_id if isinstance(member_id, int) else None


class SmokeTests(unittest.TestCase):
    def test_paid_token_roundtrip(self) -> None:
        token = issue_token(101)
        self.assertEqual(parse_token(token), 101)

    def test_wrong_password_token_invalid(self) -> None:
        token = issue_token(5)
        bad = token[:-3] + "xxx"
        self.assertIsNone(parse_token(bad))


if __name__ == "__main__":
    result = unittest.main(exit=False)
    sys.exit(0 if result.result.wasSuccessful() else 1)
