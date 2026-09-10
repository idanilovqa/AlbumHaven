from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations" / "postgres" / "0050_add_security_audit_cleanup_index.sql"


def test_cleanup_migration_adds_global_retention_index_without_runtime_delete_grant():
    sql = " ".join(MIGRATION.read_text(encoding="utf-8").lower().split())

    assert re.search(
        r"create index if not exists security_audit_events_cleanup_idx "
        r"on app\.security_audit_events \(occurred_at, id\)",
        sql,
    )
    assert not re.search(
        r"grant delete .* security_audit_events .* album_haven_app", sql
    )
