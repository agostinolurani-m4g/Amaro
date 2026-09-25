import os
import unittest

os.environ.setdefault("NEXI_ENDPOINT", "https://example.test/nexi")
os.environ.setdefault("NEXI_SUCCESS_URL", "https://example.test/success")
os.environ.setdefault("NEXI_FAILURE_URL", "https://example.test/failure")
os.environ.setdefault("SESSION_SECRET", "test-wattlab-secret")

from app.wattlab_download import format_bytes, wattlab_installer_info  # noqa: E402


class WattlabDownloadTests(unittest.TestCase):
    def test_format_bytes(self) -> None:
        self.assertEqual(format_bytes(0), "—")
        self.assertEqual(format_bytes(2 * 1024 * 1024), "2.0 MB")

    def test_installer_info_shape(self) -> None:
        info = wattlab_installer_info()
        self.assertIn("available", info)
        self.assertIn("version", info)
        self.assertIsInstance(info["available"], bool)


if __name__ == "__main__":
    unittest.main()
