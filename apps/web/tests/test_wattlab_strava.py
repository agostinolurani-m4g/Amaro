from __future__ import annotations

import os
import unittest

os.environ.setdefault("NEXI_ENDPOINT", "https://example.test/nexi")
os.environ.setdefault("NEXI_SUCCESS_URL", "https://example.test/success")
os.environ.setdefault("NEXI_FAILURE_URL", "https://example.test/failure")
os.environ.setdefault("SESSION_SECRET", "test-wattlab-secret")

from app.wattlab_strava import (  # noqa: E402
    issue_strava_oauth_state,
    parse_strava_oauth_state,
    strava_is_configured,
)


class WattlabStravaStateTests(unittest.TestCase):
    def test_oauth_state_roundtrip(self) -> None:
        state = issue_strava_oauth_state(17)
        self.assertEqual(parse_strava_oauth_state(state), 17)

    def test_oauth_state_rejects_tamper(self) -> None:
        payload, _sig = issue_strava_oauth_state(3).split(".", 1)
        self.assertIsNone(parse_strava_oauth_state(f"{payload}.aaaa"))

    def test_oauth_state_rejects_expired(self) -> None:
        from app import wattlab_strava

        original = wattlab_strava.time.time
        try:
            wattlab_strava.time.time = lambda: 1_000_000
            state = issue_strava_oauth_state(8)
            wattlab_strava.time.time = lambda: 9_999_999_999
            self.assertIsNone(parse_strava_oauth_state(state))
        finally:
            wattlab_strava.time.time = original

    def test_not_configured_without_env(self) -> None:
        self.assertFalse(strava_is_configured())


if __name__ == "__main__":
    unittest.main()
