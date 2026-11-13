from __future__ import annotations

import os

import _no_real_email  # noqa: F401,E402  (prima di app.*)
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

os.environ.setdefault("NEXI_ENDPOINT", "https://example.test/nexi")
os.environ.setdefault("NEXI_SUCCESS_URL", "https://example.test/success")
os.environ.setdefault("NEXI_FAILURE_URL", "https://example.test/failure")
os.environ.setdefault("SESSION_SECRET", "test-wattlab-secret")

from app import wattlab_coach  # noqa: E402
from app.wattlab_coach import build_request, consume_call, used_today  # noqa: E402


def _body(**extra):
    return {
        "system": "Istantanea atleta",
        "messages": [{"role": "user", "content": "Come sto?"}],
        **extra,
    }


class CoachRequestTests(unittest.TestCase):
    def test_model_and_limits_fixed_by_server(self) -> None:
        params, stream = build_request(_body(model="claude-opus-5-5", max_tokens=99999, stream=True))
        self.assertEqual(params["model"], wattlab_coach.settings.coach_model)
        self.assertEqual(params["max_tokens"], 8000)
        self.assertEqual(params["output_config"], {"effort": "medium"})
        self.assertTrue(stream)
        self.assertTrue(params["system"].startswith(wattlab_coach.SERVER_RULES))
        self.assertTrue(params["system"].endswith("Istantanea atleta"))

    def test_json_mode_uses_low_effort(self) -> None:
        params, stream = build_request(_body(mode="json"))
        self.assertEqual(params["output_config"], {"effort": "low"})
        self.assertFalse(stream)

    def test_tools_are_reduced_to_known_fields(self) -> None:
        params, _ = build_request(
            _body(tools=[{"name": "carico_allenamento", "description": "CTL", "input_schema": {"type": "object"}, "type": "web_search_20260209"}])
        )
        self.assertEqual(params["tools"], [{"name": "carico_allenamento", "description": "CTL", "input_schema": {"type": "object"}}])

    def test_rejects_last_message_from_assistant(self) -> None:
        with self.assertRaises(HTTPException):
            build_request(_body(messages=[{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]))

    def test_rejects_unknown_block(self) -> None:
        bad = [{"role": "user", "content": [{"type": "image", "source": {}}]}]
        with self.assertRaises(HTTPException):
            build_request(_body(messages=bad))

    def test_tool_loop_messages_pass(self) -> None:
        messages = [
            {"role": "user", "content": "Carico?"},
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "", "signature": "x"},
                    {"type": "tool_use", "id": "t1", "name": "carico_allenamento", "input": {}},
                ],
            },
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "CTL 50"}]},
        ]
        params, _ = build_request(_body(messages=messages))
        self.assertEqual(len(params["messages"]), 3)


class CoachQuotaTests(unittest.TestCase):
    def test_daily_quota(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            with mock.patch.object(wattlab_coach, "sync_root", lambda: Path(raw)), mock.patch.object(
                wattlab_coach.settings, "coach_daily_calls", 2
            ):
                self.assertEqual(consume_call(5), 1)
                self.assertEqual(consume_call(5), 2)
                with self.assertRaises(HTTPException) as ctx:
                    consume_call(5)
                self.assertEqual(ctx.exception.status_code, 429)
                self.assertEqual(used_today(5), 2)
                self.assertEqual(used_today(6), 0)


if __name__ == "__main__":
    unittest.main()
