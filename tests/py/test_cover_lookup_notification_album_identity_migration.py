from pathlib import Path


MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "migrations"
    / "postgres"
    / "0099_reconcile_cover_lookup_notification_album_identities.sql"
)


def test_cover_lookup_notification_identity_migration_preserves_history_and_candidates():
    sql = MIGRATION.read_text(encoding="utf-8").casefold()

    assert "jsonb_array_elements_text" in sql
    assert "scan_cache_stale is false" in sql
    assert "count(distinct resolved_paths.private_path)" in sql
    assert "count(distinct resolved_paths.album_id) = 1" in sql
    assert "'{source_payload,album_payload,album_id}'" in sql
    assert "'{source_payload,album_payload,key}'" in sql
    assert "previous_album_id" in sql
    assert "local_album_cover_candidate_snapshots" in sql
    assert "on conflict (album_id) do update" in sql
    assert "delete from ops.cover_lookup_tasks" not in sql
    assert "delete from library.local_album_cover_candidate_snapshots" not in sql
