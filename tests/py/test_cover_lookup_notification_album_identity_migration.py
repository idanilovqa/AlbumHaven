from pathlib import Path


MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "migrations"
    / "postgres"
    / "0099_reconcile_cover_lookup_notification_album_identities.sql"
)
REPAIR = (
    Path(__file__).resolve().parents[2]
    / "migrations"
    / "postgres"
    / "0100_archive_invalid_featured_track_cover_notifications.sql"
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


def test_featured_track_identity_repair_archives_only_proven_invalid_notifications():
    sql = REPAIR.read_text(encoding="utf-8").casefold()

    assert "album_identity_reconciliation" in sql
    assert "jsonb_array_length" in sql
    assert "= 1" in sql
    assert "previous_album_id" in sql
    assert "current_album_id" in sql
    assert "scan_cache_stale is false" in sql
    assert "position(" in sql
    assert "notification_obsolete_reason" in sql
    assert "not (tasks.metadata ? 'notification_obsolete_reason')" in sql
    assert "invalid_featured_track_album_reconciliation" in sql
    assert "obsolete_cover_lookup_notifications" in sql
    assert "previous_source_family" in sql
    assert "delete from ops.cover_lookup_tasks" not in sql
    assert "local_album_cover_candidate_snapshots" not in sql


def test_featured_track_identity_repair_preserves_multitrack_album_merges():
    sql = REPAIR.read_text(encoding="utf-8").casefold()

    assert "jsonb_array_length" in sql
    assert "= 1" in sql
    assert "current_track_count > 1" in sql
    assert "previous_track_count = 0" in sql
