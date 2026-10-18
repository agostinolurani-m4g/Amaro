import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "test-wattlab-secret")

from app.wattlab_sync import get_member_sync, merge_member_sync  # noqa: E402


class WattlabSyncTests(unittest.TestCase):
    def test_merge_keeps_newer_calendar_entry(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            merge_member_sync(
                7,
                {
                    "calendar": [
                        {"id": "a", "title": "vecchio", "updatedAt": "2026-01-01T00:00:00Z"}
                    ]
                },
                root,
            )
            merged = merge_member_sync(
                7,
                {
                    "calendar": [
                        {"id": "a", "title": "nuovo", "updatedAt": "2026-02-01T00:00:00Z"},
                        {"id": "b", "title": "altro", "updatedAt": "2026-02-02T00:00:00Z"},
                    ]
                },
                root,
            )
            by_id = {item["id"]: item["title"] for item in merged["calendar"]}
            self.assertEqual(by_id, {"a": "nuovo", "b": "altro"})
            again = get_member_sync(7, root)
            self.assertEqual(len(again["calendar"]), 2)


if __name__ == "__main__":
    unittest.main()
