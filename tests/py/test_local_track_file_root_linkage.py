from __future__ import annotations

import re
from pathlib import Path

from music_app.services import scan_cache_persistence


REPO_ROOT = Path(__file__).resolve().parents[2]
ROOT_LINKAGE_MIGRATION = (
    REPO_ROOT / "migrations" / "postgres" / "0023_link_local_track_files_to_library_roots.sql"
)


def _normalized_sql(sql: str) -> str:
    without_comments = re.sub(r"--.*", " ", sql)
    return re.sub(r"\s+", " ", without_comments.casefold()).strip()


def _migration_sql() -> str:
    return _normalized_sql(ROOT_LINKAGE_MIGRATION.read_text(encoding="utf-8"))


def test_root_linkage_migration_defines_priority_scope_and_boundary_contracts():
    sql = _migration_sql()

    assert "where library.library_roots.library_id = requested_library_id" in sql
    assert "library.library_roots.is_active is true" in sql
    assert "'logical-root-id'::text as method" in sql
    assert "'explicit-root-path'::text" in sql
    assert "'longest-path-containment'::text" in sql
    assert "select active_roots.id, 0 as priority" in sql
    assert "select active_roots.id, 1," in sql
    assert "select active_roots.id, 2," in sql
    assert "input.private_path_style = active_roots.root_path_style" in sql
    assert "when 'windows' then e'\\\\' else '/'" in sql
    assert "max(priority_candidates.match_length) over ()" in sql
    assert "when count(*) = 0 then 'unresolved'" in sql
    assert "else 'ambiguous'" in sql


def test_root_linkage_requirement_fails_closed_with_check_violation_sqlstate():
    sql = _migration_sql()

    assert "create or replace function library.require_local_track_file_root_id" in sql
    assert "if resolution.resolution_status <> 'resolved' then" in sql
    assert "using errcode = '23514'" in sql
    assert "library_id=%s candidate_count=%s method=%s" in sql


def test_production_scan_and_import_upserts_require_and_store_root_foreign_key():
    scan_sql = _normalized_sql(scan_cache_persistence._upsert_local_track_file_sql())

    from scripts import migrate_app_data_to_postgres

    import_sql = _normalized_sql(migrate_app_data_to_postgres._upsert_local_track_file_sql())
    for sql in (scan_sql, import_sql):
        assert "insert into library.local_track_files" in sql
        assert "track_id, library_root_id," in sql
        assert "library.require_local_track_file_root_id(" in sql
        assert "library_root_id = excluded.library_root_id" in sql


def test_scan_reload_uses_same_library_active_root_authority():
    sql = _normalized_sql(scan_cache_persistence._load_file_entries_sql())

    assert "join library.library_roots" in sql
    assert "library.library_roots.id = library.local_track_files.library_root_id" in sql
    assert "library.library_roots.library_id = library.local_tracks.library_id" in sql
    assert "library.library_roots.is_active is true" in sql


def test_root_linkage_migration_is_rerunnable_and_fails_on_unresolved_rows():
    sql = _migration_sql()

    assert sql.count("create or replace function library.local_path_style") == 1
    assert sql.count("create or replace function library.local_path_key") == 1
    assert sql.count("create or replace function library.local_track_file_root_resolution") == 1
    assert sql.count("create or replace function library.require_local_track_file_root_id") == 1
    assert "where library.local_track_files.library_root_id is null" in sql
    assert "'root_linkage', jsonb_build_object(" in sql
    assert "'status', unresolved.resolution_status" in sql
    assert "'candidate_count', unresolved.candidate_count" in sql
    assert "raise exception '% local_track_files remain without library_root_id'" in sql
    assert "using errcode = '23514'" in sql
    assert "detail = format('unresolved_local_track_file_count=%s', unresolved_count)" in sql
    assert "hint = 'configure or repair active library-root path/provenance mappings, then rerun migration 0023.'" in sql
    assert "raise warning" not in sql


def test_root_linkage_path_keys_are_platform_aware_and_cross_style_safe():
    sql = _migration_sql()

    assert "then 'windows'" in sql
    assert "then 'posix'" in sql
    assert "when 'windows' then lower(" in sql
    assert "when 'posix' then case" in sql
    assert "library.local_path_style(explicit_path.path_value) = active_roots.root_path_style" in sql
    assert "library.local_path_key(explicit_path.path_value) = active_roots.root_path_key" in sql
    assert "drop function if exists library.windows_path_key(text)" in sql


def test_root_linkage_functions_follow_least_privilege_grants():
    sql = _migration_sql()
    signatures = (
        "library.local_path_style(text)",
        "library.local_path_key(text)",
        "library.local_track_file_root_resolution(bigint, text, jsonb)",
        "library.require_local_track_file_root_id(bigint, text, jsonb)",
    )

    for signature in signatures:
        assert f"revoke all on function {signature} from public" in sql
        assert f"grant execute on function {signature} to album_haven_app" in sql
        assert f"grant execute on function {signature} to album_haven_migrator" in sql


def test_root_linkage_0023_has_no_artist_identity_or_provider_schema():
    sql = _migration_sql()

    assert "create table" not in sql
    for prohibited in ("alias", "mbid", "musicbrainz", "lastfm"):
        assert prohibited not in sql
    assert not re.search(r"create\s+schema[^;]*normal", sql)
