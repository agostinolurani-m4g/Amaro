import os

import _no_real_email  # noqa: F401,E402  (prima di app.*)
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("NEXI_ENDPOINT", "https://example.test/nexi")
os.environ.setdefault("NEXI_SUCCESS_URL", "https://example.test/success")
os.environ.setdefault("NEXI_FAILURE_URL", "https://example.test/failure")
os.environ.setdefault("SESSION_SECRET", "test-wattlab-secret")

from app import wattlab_download  # noqa: E402
from app.wattlab_download import format_bytes, installer_version, wattlab_installer_info  # noqa: E402


class WattlabDownloadTests(unittest.TestCase):
    def test_format_bytes(self) -> None:
        self.assertEqual(format_bytes(0), "—")
        self.assertEqual(format_bytes(2 * 1024 * 1024), "2.0 MB")

    def test_installer_info_shape(self) -> None:
        info = wattlab_installer_info()
        self.assertIn("available", info)
        self.assertIn("version", info)
        self.assertIsInstance(info["available"], bool)

    def test_installer_version(self) -> None:
        self.assertEqual(installer_version(Path("WattLab_0.1.12_x64-setup.exe")), (0, 1, 12))
        self.assertEqual(installer_version(Path("altro.exe")), ())

    def test_newest_version_wins_over_mtime(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            old = Path(tmp) / "WattLab_0.1.2_x64-setup.exe"
            new = Path(tmp) / "WattLab_0.1.10_x64-setup.exe"
            new.write_bytes(b"x")
            old.write_bytes(b"x")  # scritto dopo: mtime più recente
            with mock.patch.object(wattlab_download, "_candidate_dirs", return_value=[Path(tmp)]),                     mock.patch.object(wattlab_download.settings, "wattlab_installer_path", None):
                self.assertEqual(wattlab_download.resolve_wattlab_installer(), new)
                self.assertEqual(wattlab_installer_info()["version"], "0.1.10")


if __name__ == "__main__":
    unittest.main()
