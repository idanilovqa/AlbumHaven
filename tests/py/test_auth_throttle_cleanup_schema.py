from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations" / "postgres" / "0051_add_auth_throttle_cleanup_index.sql"


def test_cleanup_migration_indexes_expiry_without_expanding_runtime_privileges():
    sql = " ".join(MIGRATION.read_text(encoding="utf-8").lower().split())
    assert "on app.auth_throttles (window_expires_at, id)" in sql
    assert "grant" not in sql
