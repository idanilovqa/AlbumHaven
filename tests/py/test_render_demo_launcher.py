"""Deployment safeguards; no network, database, or production state is touched."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("render_demo", ROOT / "scripts" / "render_demo.py")
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


class RenderDemoConfigurationTests(unittest.TestCase):
    def test_accepts_dedicated_render_database(self):
        url = "postgresql://demo:generated-password@dpg-example/albumhaven_mobile_demo_db"
        self.assertEqual(demo.validate_database_url(url, "dpg-example"), url)

    def test_rejects_missing_connection_secret(self):
        with self.assertRaisesRegex(demo.DemoConfigurationError, "Internal Database URL"):
            demo.validate_database_url("", "dpg-example")

    def test_rejects_real_database(self):
        with self.assertRaises(demo.DemoConfigurationError):
            demo.validate_database_url("postgresql://demo:secret@dpg-example/album_haven_core", "dpg-example")

    def test_rejects_other_host(self):
        with self.assertRaises(demo.DemoConfigurationError):
            demo.validate_database_url("postgresql://demo:secret@other/albumhaven_mobile_demo_db", "dpg-example")

    def test_rejects_injected_connection_options(self):
        with self.assertRaises(demo.DemoConfigurationError):
            demo.validate_database_url("postgresql://demo:secret@dpg-example/albumhaven_mobile_demo_db?options=anything", "dpg-example")

    def test_error_does_not_disclose_secret(self):
        with self.assertRaises(demo.DemoConfigurationError) as caught:
            demo.validate_database_url("postgresql://demo:do-not-disclose@other/private", "dpg-example")
        self.assertNotIn("do-not-disclose", str(caught.exception))

    def test_runtime_connection_uses_application_role(self):
        result = demo.runtime_database_url("postgresql://admin:administrator-secret@dpg-example/albumhaven_mobile_demo_db", "a/b:@!?value")
        self.assertTrue(result.startswith("postgresql://album_haven_app:a%2Fb%3A%40%21%3Fvalue@"))
        self.assertNotIn("administrator-secret", result)

    def test_unrelated_existing_database_is_not_seeded(self):
        connection = Mock()
        connection.execute.return_value.fetchone.return_value = ("app.bootstrap_owners",)
        connection.execute.return_value.fetchall.return_value = [("someone-elses-library",)]
        with self.assertRaisesRegex(RuntimeError, "ownership marker"):
            demo.assert_demo_ownership(connection)

    def test_existing_demo_is_not_reseeded_as_new(self):
        connection = Mock()
        connection.execute.return_value.fetchone.return_value = ("app.bootstrap_owners",)
        connection.execute.return_value.fetchall.return_value = [(demo.MARKER,)]
        self.assertFalse(demo.assert_demo_ownership(connection))

    def test_fresh_database_can_be_seeded(self):
        connection = Mock()
        connection.execute.return_value.fetchone.side_effect = [(None,), (0,)]
        self.assertTrue(demo.assert_demo_ownership(connection))


if __name__ == "__main__":
    unittest.main()
