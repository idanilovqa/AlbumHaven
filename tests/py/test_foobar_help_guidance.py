"""Pure served-help contract: no application startup, DB, browser or user data."""
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "foobar_help_guidance_owner", ROOT / "music_app/services/foobar_integrations.py")
OWNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OWNER)


class ServedHelpGuidance(unittest.TestCase):
    def setUp(self):
        self.payload = OWNER.build_foobar_help_payload(
            build_asset_url=lambda key, download: "/utilities/integrations/foobar/assets/" + key + ("?download=1" if download else ""))
        self.copy = "\n".join(section["body_markdown"] for section in self.payload["sections"])

    def test_current_formats_are_distinguished_from_reference_only_formats(self):
        self.assertNotIn("history import is unavailable in this build", self.copy)
        self.assertRegex(self.copy, r"(?i)UTF-8.*TSV")
        self.assertRegex(self.copy, r"(?i)finalized.*SQLite")
        self.assertRegex(self.copy, r"(?i)self-contained")
        self.assertRegex(self.copy, r"(?i)WAL")
        self.assertRegex(self.copy, r"(?i)XML[^\n.]*not supported|not supported[^\n.]*XML")

    def test_dates_retain_provenance_without_guessing_timezone_or_full_listens(self):
        self.assertRegex(self.copy, r"(?i)UTC offset")
        self.assertRegex(self.copy, r"(?i)raw (?:text|timestamp|date|value)")
        self.assertRegex(self.copy, r"(?i)unresolved[^\n.]*timezone|timezone[^\n.]*unresolved")
        self.assertRegex(self.copy, r"(?i)(?:do not|never|not)[^\n.]*guess")
        self.assertRegex(self.copy, r"(?i)FILETIME")
        self.assertRegex(self.copy, r"(?i)incomplete")
        self.assertRegex(self.copy, r"(?i)(?:not|never)[^\n.]*full|full[^\n.]*not")

    def test_reexport_is_not_resume_and_upload_privacy_is_explicit(self):
        self.assertRegex(self.copy, r"(?i)export a new file|re-export")
        self.assertRegex(self.copy, r"(?i)exact original file")
        self.assertRegex(self.copy, r"(?i)review[^\n.]*confirm")
        self.assertRegex(self.copy, r"(?i)(?:sent|upload)[^\n.]*server|server[^\n.]*upload")
        self.assertRegex(self.copy, r"(?i)private|sensitive")
        self.assertRegex(self.copy, r"(?i)24 hours|24-hour")
        self.assertRegex(self.copy, r"(?i)(?:does not|never)[^\n.]*configur")
        self.assertRegex(self.copy, r"(?i)(?:does not|never)[^\n.]*scripts")

    def test_existing_reference_assets_remain_read_only_links(self):
        self.assertTrue(self.payload["ok"])
        assets = self.payload["reference_assets"]
        self.assertEqual(self.payload["reference_asset_count"], len(assets))
        self.assertEqual({asset["asset_key"] for asset in assets}, {
            "how-to-modal-copy", "text-tools-standard-preset", "text-tools-enhanced-preset",
            "foobar-internal-setup-summary-2026-05-28", "backup-foobar-db-script",
            "export-text-tools-stats-script", "register-foobar-db-task-script"})
        for asset in assets:
            self.assertEqual(asset["view_url"], "/utilities/integrations/foobar/assets/" + asset["asset_key"])
            self.assertEqual(asset["download_url"], asset["view_url"] + "?download=1")


if __name__ == "__main__":
    unittest.main()
