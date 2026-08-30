from __future__ import annotations

import hashlib
import re
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "migrations" / "postgres"
BASELINE_MIGRATION = MIGRATIONS_DIR / "0001_create_current_stack_schemas.sql"
LOCAL_MBID_ASSERTIONS_MIGRATION = MIGRATIONS_DIR / "0002_create_local_mbid_assertions.sql"
LOCAL_MBID_PROJECTION_PROVENANCE_MIGRATION = (
    MIGRATIONS_DIR / "0003_add_local_mbid_projection_provenance.sql"
)
LASTFM_BACKFILL_IDENTITIES_MIGRATION = (
    MIGRATIONS_DIR / "0004_add_lastfm_backfill_identities.sql"
)
POLICY_CONTEXT_HOOKS_MIGRATION = (
    MIGRATIONS_DIR / "0005_add_policy_context_hooks.sql"
)
LASTFM_SYNC_SCOPED_IDENTITIES_MIGRATION = (
    MIGRATIONS_DIR / "0006_scope_lastfm_sync_identities.sql"
)
COVER_LOOKUP_SCOPED_IDENTITIES_MIGRATION = (
    MIGRATIONS_DIR / "0007_scope_cover_lookup_task_identities.sql"
)
SAVED_LOOPS_SCOPED_IDENTITIES_MIGRATION = (
    MIGRATIONS_DIR / "0008_scope_saved_loop_identities.sql"
)
USER_DISCOVERY_PREFERENCES_MIGRATION = (
    MIGRATIONS_DIR / "0009_create_user_discovery_preferences.sql"
)
VIRTUAL_ARTIST_SNAPSHOTS_MIGRATION = (
    MIGRATIONS_DIR / "0010_create_virtual_artist_snapshots.sql"
)
LOG_HISTORY_MIGRATION = MIGRATIONS_DIR / "0011_create_log_history.sql"
VIRTUAL_RELEASE_SNAPSHOTS_MIGRATION = (
    MIGRATIONS_DIR / "0013_create_virtual_release_snapshots.sql"
)
BOOTSTRAP_OWNER_NOMINEM_MIGRATION = (
    MIGRATIONS_DIR / "0014_update_bootstrap_owner_nominem.sql"
)
LOCAL_ARTIST_FAMILY_LINKS_MIGRATION = (
    MIGRATIONS_DIR / "0015_create_local_artist_family_links.sql"
)
LOCAL_ARTIST_FAMILY_LINK_DELETE_GRANT_MIGRATION = (
    MIGRATIONS_DIR / "0016_grant_local_artist_family_link_delete.sql"
)
E2E_PROBLEMATIC_FIXTURE_SEEDS_MIGRATION = (
    MIGRATIONS_DIR / "0017_create_e2e_problematic_fixture_seeds.sql"
)
REPAIR_SAVED_LOOP_RELATIONS_MIGRATION = (
    MIGRATIONS_DIR / "0018_repair_saved_loop_relations.sql"
)
LOCAL_ALBUM_FEATURED_ARTISTS_MIGRATION = (
    MIGRATIONS_DIR / "0019_create_local_album_featured_artists.sql"
)
RUNTIME_DELETE_PRIVILEGES_MIGRATION = (
    MIGRATIONS_DIR / "0020_grant_runtime_delete_privileges.sql"
)
PROBLEMATIC_FILE_GENERATED_PROJECTION_MIGRATION = (
    MIGRATIONS_DIR / "0021_add_problematic_file_generated_projection.sql"
)
LASTFM_SCROBBLE_CONFLICT_IDENTITY_REPAIR_MIGRATION = (
    MIGRATIONS_DIR / "0022_fix_lastfm_pending_scrobble_conflict_identity.sql"
)
LIBRARY_SEARCH_TRIGRAM_INDEXES_MIGRATION = (
    MIGRATIONS_DIR / "0024_add_library_search_trigram_indexes.sql"
)
LOCAL_ALBUM_FEATURED_ARTIST_DELETE_GRANT_MIGRATION = (
    MIGRATIONS_DIR / "0025_grant_local_album_featured_artist_delete.sql"
)
ALBUM_RATINGS_MIGRATION = MIGRATIONS_DIR / "0026_create_album_ratings.sql"
COVER_LOOKUP_TASK_DELETE_GRANT_REPAIR_MIGRATION = (
    MIGRATIONS_DIR / "0027_repair_cover_lookup_task_delete_grant.sql"
)
COVER_LOOKUP_TASK_CONFLICT_IDENTITY_REPAIR_MIGRATION = (
    MIGRATIONS_DIR / "0028_repair_cover_lookup_task_conflict_identity.sql"
)
LASTFM_SESSION_CONFLICT_IDENTITY_REPAIR_MIGRATION = (
    MIGRATIONS_DIR / "0029_repair_lastfm_session_conflict_identity.sql"
)
DROP_LOG_HISTORY_MIGRATION = MIGRATIONS_DIR / "0030_drop_log_history.sql"
PROBLEMATIC_ACTIVE_TRACK_INDEX_MIGRATION = (
    MIGRATIONS_DIR / "0031_add_problematic_active_track_index.sql"
)
PROBLEMATIC_ACTIVE_PROJECTION_INDEX_MIGRATION = (
    MIGRATIONS_DIR / "0032_expand_problematic_active_track_index.sql"
)
PROBLEMATIC_CANDIDATE_INDEX_MIGRATION = (
    MIGRATIONS_DIR / "0036_add_problematic_candidate_index.sql"
)
PROBLEMATIC_TRACK_CANDIDATE_INDEX_MIGRATION = (
    MIGRATIONS_DIR / "0037_add_problematic_track_candidate_index.sql"
)
PROBLEMATIC_REQUIRED_TEXT_CANDIDATE_MIGRATION = (
    MIGRATIONS_DIR / "0038_add_problematic_required_text_candidate.sql"
)
WAVEFORM_PEAK_CACHE_MIGRATION = (
    MIGRATIONS_DIR / "0043_create_local_track_waveform_peaks.sql"
)
TAG_EDIT_INTENTS_MIGRATION = (
    MIGRATIONS_DIR / "0044_create_tag_edit_intents.sql"
)
NON_ALBUM_CANDIDATE_INDEX_MIGRATION = (
    MIGRATIONS_DIR / "0045_add_non_album_candidate_index.sql"
)
SEMANTIC_ALBUM_DELETE_GRANT_REPAIR_MIGRATION = (
    MIGRATIONS_DIR
    / "0039_repair_semantic_album_reconciliation_delete_grants.sql"
)
IGNORED_REPAIRS_DELETE_GRANT_REPAIR_MIGRATION = (
    MIGRATIONS_DIR
    / "0040_repair_ignored_repairs_delete_grant.sql"
)
LOCAL_ALBUM_COVER_CANDIDATE_SNAPSHOTS_MIGRATION = (
    MIGRATIONS_DIR
    / "0041_create_local_album_cover_candidate_snapshots.sql"
)
DISTINCT_COVER_IMPROVEMENT_ALERTS_MIGRATION = (
    MIGRATIONS_DIR
    / "0042_track_distinct_cover_improvement_alerts.sql"
)
SECTION14_ALBUM_IDENTITY_REPAIR_MIGRATION = (
    MIGRATIONS_DIR / "0033_repair_section14_album_identity_corruption.sql"
)
SEMANTIC_LOCAL_ALBUM_RECONCILIATION_MIGRATION = (
    MIGRATIONS_DIR / "0034_reconcile_semantic_local_albums.sql"
)
SEMANTIC_LOCAL_ALBUM_IDENTITY_ENFORCEMENT_MIGRATION = (
    MIGRATIONS_DIR / "0035_enforce_semantic_local_album_identity.sql"
)
LOG_HISTORY_MIGRATION_SHA256 = (
    "282410847b8d0752777cdb3bda5164d109a16b13f385b620b40ae1ede11b017c"
)


def _normalized_sql(sql: str) -> str:
    without_line_comments = re.sub(r"--.*", " ", sql)
    return re.sub(r"\s+", " ", without_line_comments.lower())


def _qualified_table_pattern(table_name: str) -> re.Pattern[str]:
    schema, table = table_name.split(".", 1)
    return re.compile(
        rf"\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?{schema}\.{table}\b",
        re.IGNORECASE,
    )


def _qualified_index_pattern(table_name: str, columns: tuple[str, ...]) -> re.Pattern[str]:
    schema, table = table_name.split(".", 1)
    column_pattern = r"\s*,\s*".join(re.escape(column) for column in columns)
    return re.compile(
        rf"\bcreate\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?"
        rf"\w+\s+on\s+{schema}\.{table}\s*\([^)]*\b{column_pattern}\b[^)]*\)",
        re.IGNORECASE | re.DOTALL,
    )


def _table_sql(sql: str, table_name: str) -> str:
    schema, table = table_name.split(".", 1)
    match = re.search(
        rf"\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?{schema}\.{table}\b[^;]*;",
        sql,
    )
    return match.group(0) if match else ""


@pytest.fixture
def local_mbid_assertions_sql() -> str:
    if not LOCAL_MBID_ASSERTIONS_MIGRATION.exists():
        pytest.skip(
            "local MBID assertions migration SQL is not present yet; "
            "test_local_mbid_assertions_migration_file_exists captures the TDD red state"
        )
    return LOCAL_MBID_ASSERTIONS_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def local_mbid_projection_provenance_sql() -> str:
    if not LOCAL_MBID_PROJECTION_PROVENANCE_MIGRATION.exists():
        pytest.skip(
            "local MBID projection provenance migration SQL is not present yet; "
            "test_local_mbid_projection_provenance_migration_file_exists captures the TDD red state"
        )
    return LOCAL_MBID_PROJECTION_PROVENANCE_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def lastfm_backfill_identities_sql() -> str:
    if not LASTFM_BACKFILL_IDENTITIES_MIGRATION.exists():
        pytest.skip(
            "Last.fm backfill identity migration SQL is not present yet."
        )
    return LASTFM_BACKFILL_IDENTITIES_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def policy_context_hooks_sql() -> str:
    if not POLICY_CONTEXT_HOOKS_MIGRATION.exists():
        pytest.skip("policy context hook migration SQL is not present yet.")
    return POLICY_CONTEXT_HOOKS_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def lastfm_sync_scoped_identities_sql() -> str:
    if not LASTFM_SYNC_SCOPED_IDENTITIES_MIGRATION.exists():
        pytest.skip("Last.fm scoped sync identity migration SQL is not present yet.")
    return LASTFM_SYNC_SCOPED_IDENTITIES_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def lastfm_scrobble_conflict_identity_repair_sql() -> str:
    return LASTFM_SCROBBLE_CONFLICT_IDENTITY_REPAIR_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def cover_lookup_scoped_identities_sql() -> str:
    if not COVER_LOOKUP_SCOPED_IDENTITIES_MIGRATION.exists():
        pytest.skip("Cover lookup scoped identity migration SQL is not present yet.")
    return COVER_LOOKUP_SCOPED_IDENTITIES_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def saved_loops_scoped_identities_sql() -> str:
    if not SAVED_LOOPS_SCOPED_IDENTITIES_MIGRATION.exists():
        pytest.skip("Saved loop scoped identity migration SQL is not present yet.")
    return SAVED_LOOPS_SCOPED_IDENTITIES_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def user_discovery_preferences_sql() -> str:
    if not USER_DISCOVERY_PREFERENCES_MIGRATION.exists():
        pytest.skip("User discovery preferences migration SQL is not present yet.")
    return USER_DISCOVERY_PREFERENCES_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def virtual_artist_snapshots_sql() -> str:
    if not VIRTUAL_ARTIST_SNAPSHOTS_MIGRATION.exists():
        pytest.skip("Virtual artist snapshots migration SQL is not present yet.")
    return VIRTUAL_ARTIST_SNAPSHOTS_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def log_history_sql() -> str:
    if not LOG_HISTORY_MIGRATION.exists():
        pytest.skip("Log history migration SQL is not present yet.")
    return LOG_HISTORY_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def drop_log_history_sql() -> str:
    if not DROP_LOG_HISTORY_MIGRATION.exists():
        pytest.skip(
            "Log History drop migration is not present; "
            "test_drop_log_history_migration_file_exists captures the TDD red state."
        )
    return DROP_LOG_HISTORY_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def section14_album_identity_repair_sql() -> str:
    if not SECTION14_ALBUM_IDENTITY_REPAIR_MIGRATION.exists():
        pytest.skip(
            "Section 14 album identity repair migration SQL is not present yet."
        )
    return SECTION14_ALBUM_IDENTITY_REPAIR_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def semantic_local_album_reconciliation_sql() -> str:
    if not SEMANTIC_LOCAL_ALBUM_RECONCILIATION_MIGRATION.exists():
        pytest.skip(
            "Semantic local-album reconciliation migration SQL is not present yet."
        )
    return SEMANTIC_LOCAL_ALBUM_RECONCILIATION_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def semantic_local_album_identity_enforcement_sql() -> str:
    if not SEMANTIC_LOCAL_ALBUM_IDENTITY_ENFORCEMENT_MIGRATION.exists():
        pytest.skip(
            "Semantic local-album identity enforcement migration SQL is not present yet."
        )
    return SEMANTIC_LOCAL_ALBUM_IDENTITY_ENFORCEMENT_MIGRATION.read_text(
        encoding="utf-8"
    )


@pytest.fixture
def virtual_release_snapshots_sql() -> str:
    if not VIRTUAL_RELEASE_SNAPSHOTS_MIGRATION.exists():
        pytest.skip("Virtual release snapshots migration SQL is not present yet.")
    return VIRTUAL_RELEASE_SNAPSHOTS_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def bootstrap_owner_nominem_sql() -> str:
    if not BOOTSTRAP_OWNER_NOMINEM_MIGRATION.exists():
        pytest.skip("Bootstrap owner nominem migration SQL is not present yet.")
    return BOOTSTRAP_OWNER_NOMINEM_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def local_artist_family_links_sql() -> str:
    if not LOCAL_ARTIST_FAMILY_LINKS_MIGRATION.exists():
        pytest.skip("Local artist family links migration SQL is not present yet.")
    return LOCAL_ARTIST_FAMILY_LINKS_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def local_artist_family_link_delete_grant_sql() -> str:
    if not LOCAL_ARTIST_FAMILY_LINK_DELETE_GRANT_MIGRATION.exists():
        pytest.skip("Local artist family link delete grant migration SQL is not present yet.")
    return LOCAL_ARTIST_FAMILY_LINK_DELETE_GRANT_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def e2e_problematic_fixture_seeds_sql() -> str:
    if not E2E_PROBLEMATIC_FIXTURE_SEEDS_MIGRATION.exists():
        pytest.skip("E2E problematic fixture seeds migration SQL is not present yet.")
    return E2E_PROBLEMATIC_FIXTURE_SEEDS_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def repair_saved_loop_relations_sql() -> str:
    if not REPAIR_SAVED_LOOP_RELATIONS_MIGRATION.exists():
        pytest.skip("Saved loop relation repair migration SQL is not present yet.")
    return REPAIR_SAVED_LOOP_RELATIONS_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def local_album_featured_artists_sql() -> str:
    if not LOCAL_ALBUM_FEATURED_ARTISTS_MIGRATION.exists():
        pytest.skip("Local album featured artists migration SQL is not present yet.")
    return LOCAL_ALBUM_FEATURED_ARTISTS_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def runtime_delete_privileges_sql() -> str:
    if not RUNTIME_DELETE_PRIVILEGES_MIGRATION.exists():
        pytest.skip("Runtime delete privilege migration SQL is not present yet.")
    return RUNTIME_DELETE_PRIVILEGES_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def album_ratings_sql() -> str:
    if not ALBUM_RATINGS_MIGRATION.exists():
        pytest.skip("Album ratings migration SQL is not present yet.")
    return ALBUM_RATINGS_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def cover_lookup_task_delete_grant_repair_sql() -> str:
    if not COVER_LOOKUP_TASK_DELETE_GRANT_REPAIR_MIGRATION.exists():
        pytest.skip("Cover lookup task DELETE grant repair migration SQL is not present yet.")
    return COVER_LOOKUP_TASK_DELETE_GRANT_REPAIR_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def cover_lookup_task_conflict_identity_repair_sql() -> str:
    if not COVER_LOOKUP_TASK_CONFLICT_IDENTITY_REPAIR_MIGRATION.exists():
        pytest.skip("Cover lookup task conflict-identity repair migration SQL is not present yet.")
    return COVER_LOOKUP_TASK_CONFLICT_IDENTITY_REPAIR_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def lastfm_session_conflict_identity_repair_sql() -> str:
    if not LASTFM_SESSION_CONFLICT_IDENTITY_REPAIR_MIGRATION.exists():
        pytest.skip("Last.fm session conflict-identity repair migration SQL is not present yet.")
    return LASTFM_SESSION_CONFLICT_IDENTITY_REPAIR_MIGRATION.read_text(encoding="utf-8")


@pytest.fixture
def local_album_cover_candidate_snapshots_sql() -> str:
    if not LOCAL_ALBUM_COVER_CANDIDATE_SNAPSHOTS_MIGRATION.exists():
        pytest.skip(
            "Local album cover candidate snapshots migration SQL is not present yet; "
            "test_local_album_cover_candidate_snapshots_migration_file_exists "
            "captures the TDD red state."
        )
    return LOCAL_ALBUM_COVER_CANDIDATE_SNAPSHOTS_MIGRATION.read_text(
        encoding="utf-8"
    )


@pytest.fixture
def baseline_sql() -> str:
    if not BASELINE_MIGRATION.exists():
        pytest.skip(
            "baseline migration SQL is not present yet; "
            "test_required_baseline_migration_file_exists captures the TDD red state"
        )
    return BASELINE_MIGRATION.read_text(encoding="utf-8")


def test_postgres_migration_filenames_are_zero_padded_sql_and_lexically_ordered():
    migration_names = sorted(
        path.name
        for path in MIGRATIONS_DIR.iterdir()
        if path.is_file() and path.suffix.lower() == ".sql"
    )
    migration_numbers = [int(name[:4]) for name in migration_names]

    assert all(re.fullmatch(r"\d{4}_[a-z0-9_]+\.sql", name) for name in migration_names)
    assert migration_numbers == list(range(1, len(migration_numbers) + 1))
    assert migration_names[-10:] == [
        "0036_add_problematic_candidate_index.sql",
        "0037_add_problematic_track_candidate_index.sql",
        "0038_add_problematic_required_text_candidate.sql",
        "0039_repair_semantic_album_reconciliation_delete_grants.sql",
        "0040_repair_ignored_repairs_delete_grant.sql",
        "0041_create_local_album_cover_candidate_snapshots.sql",
        "0042_track_distinct_cover_improvement_alerts.sql",
        "0043_create_local_track_waveform_peaks.sql",
        "0044_create_tag_edit_intents.sql",
        "0045_add_non_album_candidate_index.sql",
    ]


def test_non_album_candidate_migration_indexes_active_exact_album_markers():
    assert NON_ALBUM_CANDIDATE_INDEX_MIGRATION.exists()
    sql = _normalized_sql(
        NON_ALBUM_CANDIDATE_INDEX_MIGRATION.read_text(encoding="utf-8")
    )

    assert (
        "create index if not exists local_track_files_active_non_album_candidate_idx "
        "on library.local_track_files (track_id)"
    ) in sql
    assert "where scan_cache_stale is false" in sql
    assert "lower(btrim(coalesce(scan_file_album, '')))" in sql
    assert re.search(
        r"in\s*\(\s*'',\s*'unknown',\s*'unknown artist',\s*"
        r"'unknown album',\s*'none',\s*'null'\s*\)",
        sql,
    )
    assert " ~ " in sql


def test_distinct_cover_improvement_alerts_migration_adds_candidate_identity():
    assert DISTINCT_COVER_IMPROVEMENT_ALERTS_MIGRATION.exists()
    sql = _normalized_sql(
        DISTINCT_COVER_IMPROVEMENT_ALERTS_MIGRATION.read_text(encoding="utf-8")
    )
    assert "add column if not exists automatic_improvement_candidate_id text" in sql


def test_local_album_cover_candidate_snapshots_migration_file_exists():
    assert LOCAL_ALBUM_COVER_CANDIDATE_SNAPSHOTS_MIGRATION.exists(), (
        "missing local album cover candidate snapshots migration: "
        "migrations/postgres/0041_create_local_album_cover_candidate_snapshots.sql"
    )


def test_local_album_cover_candidate_snapshots_migration_creates_album_scoped_table(
    local_album_cover_candidate_snapshots_sql,
):
    sql = _normalized_sql(local_album_cover_candidate_snapshots_sql)

    assert _qualified_table_pattern(
        "library.local_album_cover_candidate_snapshots"
    ).search(local_album_cover_candidate_snapshots_sql)
    required_fragments = {
        "album_id bigint primary key references library.local_albums(id) on delete cascade",
        "search_generation uuid not null",
        "search_kind text not null",
        "status text not null",
        "revision bigint not null",
        "candidates jsonb not null",
        "best_candidate_id text",
        "automatic_improvement_revision bigint not null",
        "seen_automatic_improvement_revision bigint not null",
        "started_at timestamptz not null",
        "updated_at timestamptz not null",
        "finished_at timestamptz",
    }

    assert sorted(fragment for fragment in required_fragments if fragment not in sql) == []


def test_local_album_cover_candidate_snapshots_migration_enforces_payload_contract(
    local_album_cover_candidate_snapshots_sql,
):
    sql = _normalized_sql(local_album_cover_candidate_snapshots_sql)
    search_kind_check = re.search(r"search_kind\s+in\s*\(([^)]*)\)", sql)
    status_check = re.search(r"status\s+in\s*\(([^)]*)\)", sql)

    assert search_kind_check is not None
    assert set(re.findall(r"'([^']+)'", search_kind_check.group(1))) == {
        "automatic",
        "manual",
    }
    assert status_check is not None
    assert set(re.findall(r"'([^']+)'", status_check.group(1))) == {
        "running",
        "completed",
        "failed",
    }
    assert "revision >= 0" in sql
    assert "automatic_improvement_revision >= 0" in sql
    assert "seen_automatic_improvement_revision >= 0" in sql
    assert "jsonb_typeof(candidates) = 'array'" in sql


def test_local_album_cover_candidate_snapshots_migration_uses_primary_key_for_album_lookup(
    local_album_cover_candidate_snapshots_sql,
):
    assert not _qualified_index_pattern(
        "library.local_album_cover_candidate_snapshots", ("album_id",)
    ).search(local_album_cover_candidate_snapshots_sql)


def test_local_album_cover_candidate_snapshots_migration_grants_bounded_writes(
    local_album_cover_candidate_snapshots_sql,
):
    sql = _normalized_sql(local_album_cover_candidate_snapshots_sql)
    table = "library.local_album_cover_candidate_snapshots"

    assert "rolname = 'album_haven_app'" in sql
    assert "rolname = 'album_haven_migrator'" in sql
    assert f"grant select, insert, update on table {table} to album_haven_app" in sql
    assert (
        f"grant select, insert, update on table {table} to album_haven_migrator"
        in sql
    )
    assert "grant delete" not in sql
    assert "grant all" not in sql


def test_local_album_cover_candidate_snapshots_migration_backfills_legacy_cover_ownership(
    local_album_cover_candidate_snapshots_sql,
):
    sql = _normalized_sql(local_album_cover_candidate_snapshots_sql)

    assert "update library.local_albums" in sql
    assert "jsonb_set" in sql
    assert "'{cover_selection_origin}'" in sql
    assert "'\"user\"'::jsonb" in sql
    assert "nullif(btrim(cover_path), '') is not null" in sql
    assert "nullif(btrim(metadata ->> 'remote_cover_url'), '') is not null" in sql
    assert "metadata ->> 'cover_selection_origin' is null" in sql
    origin_check = re.search(
        r"metadata\s*->>\s*'cover_selection_origin'\s+not\s+in\s*\(([^)]*)\)",
        sql,
    )
    assert origin_check is not None
    assert set(re.findall(r"'([^']+)'", origin_check.group(1))) == {
        "user",
        "automatic",
    }


def test_section14_album_identity_repair_migration_file_exists():
    assert SECTION14_ALBUM_IDENTITY_REPAIR_MIGRATION.exists(), (
        "missing Section 14 album identity data repair migration: "
        "migrations/postgres/0033_repair_section14_album_identity_corruption.sql"
    )


def test_semantic_local_album_reconciliation_migration_file_exists():
    assert SEMANTIC_LOCAL_ALBUM_RECONCILIATION_MIGRATION.exists(), (
        "missing semantic local-album startup repair migration: "
        "migrations/postgres/0034_reconcile_semantic_local_albums.sql"
    )


def test_semantic_local_album_identity_enforcement_follows_cleanup_migration():
    assert SEMANTIC_LOCAL_ALBUM_IDENTITY_ENFORCEMENT_MIGRATION.exists()
    assert (
        SEMANTIC_LOCAL_ALBUM_RECONCILIATION_MIGRATION.name
        < SEMANTIC_LOCAL_ALBUM_IDENTITY_ENFORCEMENT_MIGRATION.name
    )


def test_semantic_local_album_identity_enforcement_uses_row_local_unique_index_and_triggers(
    semantic_local_album_identity_enforcement_sql,
):
    sql = _normalized_sql(semantic_local_album_identity_enforcement_sql)

    assert (
        "add column if not exists semantic_identity_discriminator "
        "text not null default ''"
    ) in sql
    assert (
        "create unique index if not exists "
        "local_albums_semantic_identity_key on library.local_albums"
    ) in sql
    assert "nulls not distinct" in sql
    assert "where artist_id is not null and nullif(btrim(title), '') is not null" in sql
    assert "deferrable initially deferred" not in sql
    assert (
        "create or replace function library.acquire_inventory_publication_lock()"
    ) in sql
    assert (
        "pg_advisory_xact_lock( "
        "hashtext('album-haven:local-inventory-publication')"
    ) in sql
    assert (
        "create trigger separate_releases_inventory_publication_lock "
        "before insert or delete or update on library.separate_releases "
        "for each statement"
    ) in sql
    assert (
        "create trigger local_artists_inventory_publication_lock "
        "before update on library.local_artists for each statement"
    ) in sql
    assert (
        "create or replace function "
        "library.enforce_semantic_local_album_identity()"
    ) not in sql
    assert (
        "execute function library.enforce_semantic_local_album_identity()"
    ) not in sql
    assert (
        "before insert or update of library_id, artist_id, album_key, title, "
        "release_year, metadata, semantic_identity_discriminator "
        "on library.local_albums"
    ) in sql
    assert (
        "after insert or delete or update of library_id, release_key "
        "on library.separate_releases"
    ) in sql
    assert "after update of library_id, name on library.local_artists" in sql
    assert "old.library_id is distinct from new.library_id" in sql
    assert "errcode = '23514'" in sql
    assert "constraint = 'local_artists_library_id_immutable'" in sql
    assert "semantic_identity_discriminator = albums.album_key" in sql
    assert "semantic_identity_discriminator = ''" in sql
    assert "nullif(btrim(albums.metadata ->> 'album_artist'), '')" in sql


def test_semantic_album_cleanup_uses_trimmed_album_artist_fallback(
    semantic_local_album_reconciliation_sql,
    semantic_local_album_identity_enforcement_sql,
):
    cleanup_sql = _normalized_sql(semantic_local_album_reconciliation_sql)
    enforcement_sql = _normalized_sql(
        semantic_local_album_identity_enforcement_sql
    )

    expected = "nullif( btrim( library.local_albums.metadata ->> 'album_artist' ), '' )"
    assert expected in cleanup_sql
    assert "nullif(btrim(albums.metadata ->> 'album_artist'), '')" in enforcement_sql


def test_semantic_local_album_reconciliation_migration_repairs_full_dependency_graph(
    semantic_local_album_reconciliation_sql,
):
    sql = _normalized_sql(semantic_local_album_reconciliation_sql)

    assert "min(library.local_albums.id)" in sql
    assert "library.local_albums.library_id" in sql
    assert "library.local_albums.artist_id" in sql
    assert "lower(btrim(library.local_albums.title))" in sql
    assert "library.local_albums.release_year" in sql
    assert "library.local_albums.metadata ->> 'edition'" in sql
    assert "library.separate_releases" in sql
    assert "library.local_albums.artist_id is not null" in sql
    assert "bootstrap_context" not in sql
    assert "local-bootstrap-owner" not in sql
    assert "update library.local_tracks" in sql
    assert "insert into library.local_album_featured_artists" in sql
    assert "update library.local_mbid_assertions" in sql
    assert "insert into app.album_ratings" in sql
    assert "insert into library.ignored_versions" in sql
    assert "on conflict (library_id, version_key) do update" in sql
    assert "delete from library.ignored_versions" in sql
    assert "insert into library.manual_versions" in sql
    assert "where mapped_version.child_key <> mapped_version.parent_key" in sql
    assert "on conflict (library_id, child_key) do update" in sql
    assert "delete from library.manual_versions" in sql
    assert "update ops.cover_lookup_tasks" in sql
    assert "update library.local_albums" in sql
    assert "cover_path" in sql
    assert "metadata" in sql
    assert "delete from library.local_albums" in sql


def test_semantic_local_album_reconciliation_migration_preserves_best_evidence_as_one_row(
    semantic_local_album_reconciliation_sql,
):
    sql = _normalized_sql(semantic_local_album_reconciliation_sql)

    ranking_fragments = [
        "(library.local_albums.mbid is not null) desc",
        "library.local_albums.mbid_assertion_state <> 'unreviewed' ) desc",
        "library.local_albums.evidence_confidence desc nulls last",
        (
            "semantic_album_members.album_id = "
            "semantic_album_members.canonical_album_id ) desc"
        ),
        "(library.local_albums.evidence_source is not null) desc",
        "semantic_album_members.album_id",
    ]
    ranking_positions = []
    search_from = sql.index(ranking_fragments[0])
    for fragment in ranking_fragments:
        position = sql.index(fragment, search_from)
        ranking_positions.append(position)
        search_from = position + len(fragment)
    assert ranking_positions == sorted(ranking_positions)
    assert (
        "join library.local_albums as best_evidence_album "
        "on best_evidence_album.id = "
        "merged_album_projection.best_evidence_album_id"
    ) in sql
    for evidence_field in (
        "mbid",
        "mbid_assertion_state",
        "evidence_source",
        "evidence_confidence",
        "mbid_assertion_migration_run_id",
        "mbid_assertion_scan_run_ref",
    ):
        assert f"{evidence_field} = best_evidence_album.{evidence_field}" in sql


def test_semantic_local_album_reconciliation_migration_prefers_meaningful_metadata_per_key(
    semantic_local_album_reconciliation_sql,
):
    sql = _normalized_sql(semantic_local_album_reconciliation_sql)

    meaningful_value_fragments = [
        "metadata_entry.value = 'null'::jsonb then false",
        "jsonb_typeof(metadata_entry.value) = 'string'",
        "nullif( btrim(metadata_entry.value #>> '{}'), '' ) is not null",
        "jsonb_typeof(metadata_entry.value) = 'array'",
        "metadata_entry.value <> '[]'::jsonb",
        "jsonb_typeof(metadata_entry.value) = 'object'",
        "metadata_entry.value <> '{}'::jsonb",
    ]
    assert all(fragment in sql for fragment in meaningful_value_fragments)
    assert (
        "( metadata_candidates.album_id = "
        "metadata_candidates.canonical_album_id and "
        "metadata_value_is_meaningful ) desc"
    ) in sql
    assert "metadata_value_is_meaningful desc" in sql


def test_section14_legacy_album_merge_is_restricted_to_exact_year_key_twins(
    section14_album_identity_repair_sql,
):
    sql = _normalized_sql(section14_album_identity_repair_sql)

    assert "year_album.artist_id is not distinct from base_album.artist_id" in sql
    assert "lower(btrim(year_album.title)) = lower(btrim(base_album.title))" in sql
    assert (
        "year_album.release_year is not distinct from base_album.release_year"
    ) in sql
    assert (
        "year_album.album_key = ( base_album.album_key || '::year::' "
        "|| base_album.release_year::text )"
    ) in sql
    assert sql.count("metadata ->> 'edition'") >= 3
    assert "base_album.album_key not like '%::year::%'" in sql
    assert ") = 2" in sql


def test_section14_empty_id3_repair_requires_one_track_artist_and_destination(
    section14_album_identity_repair_sql,
):
    sql = _normalized_sql(section14_album_identity_repair_sql)

    assert "btrim(bad_artist.name) = '['''']'" in sql
    assert "btrim(bad_artist.artist_key) = '['''']'" in sql
    assert "candidate.track_artist_count = 1" in sql
    assert (
        "destination.release_year is not distinct from bad_album.release_year"
    ) in sql
    assert "where unambiguous_candidates.destination_count = 1" in sql
    assert "where destination_claim_count = 1" in sql
    assert "raise warning" in sql
    assert "ambiguous literal empty-id3 album artist row(s) untouched" in sql


def test_section14_repair_preserves_relations_and_file_projection(
    section14_album_identity_repair_sql,
):
    sql = _normalized_sql(section14_album_identity_repair_sql)

    assert "insert into app.album_ratings" in sql
    assert "on conflict (account_id, library_id, album_key) do update" in sql
    assert "'preserved_merged_rating'" in sql
    assert "insert into library.local_album_featured_artists" in sql
    assert (
        "on conflict (library_id, album_id, artist_id, featured_kind) do update"
    ) in sql
    assert "update library.local_mbid_assertions as assertion" in sql
    assert "update library.local_artist_mbid_assertions as assertion" in sql
    assert "update library.local_track_files as track_file" in sql
    assert "'{scan_cache,file_entry,album_artist}'" in sql
    assert "set scan_file_album_artist" not in sql
    assert "delete from library.local_artist_family_links as family_link" in sql
    assert "family_link.artist_id = repaired.malformed_artist_id" in sql
    assert "family_link.related_artist_id = repaired.malformed_artist_id" in sql
    projection_sql = _normalized_sql(
        PROBLEMATIC_FILE_GENERATED_PROJECTION_MIGRATION.read_text(encoding="utf-8")
    )
    assert (
        "add column if not exists scan_file_album_artist text "
        "generated always as ( case when "
        "jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object' "
        "then metadata #>> '{scan_cache,file_entry,album_artist}' end ) stored"
    ) in projection_sql
    assert "update library.local_tracks as track set album_id" in sql


def test_section14_repair_is_rerunnable_and_deletes_only_unreferenced_bad_artist(
    section14_album_identity_repair_sql,
):
    sql = _normalized_sql(section14_album_identity_repair_sql)

    assert "drop table if exists pg_temp.section14_album_merges" in sql
    assert "on conflict (redundant_album_id) do nothing" in sql
    assert "delete from library.local_albums as redundant" in sql
    assert "delete from library.local_artists as bad_artist" in sql
    for relation in (
        "library.local_albums",
        "library.local_tracks",
        "library.local_album_featured_artists",
        "library.local_artist_family_links",
        "library.local_artist_mbid_assertions",
        "library.local_mbid_assertions",
    ):
        assert f"select 1 from {relation}" in sql


def test_problematic_active_track_index_migration_supports_duplicate_candidate_scan():
    assert PROBLEMATIC_ACTIVE_TRACK_INDEX_MIGRATION.exists()
    sql = _normalized_sql(
        PROBLEMATIC_ACTIVE_TRACK_INDEX_MIGRATION.read_text(encoding="utf-8")
    )

    assert (
        "create index if not exists local_track_files_active_track_id_idx "
        "on library.local_track_files (track_id) where scan_cache_stale is false"
    ) in sql


def test_problematic_active_projection_index_covers_compact_candidate_scan():
    assert PROBLEMATIC_ACTIVE_PROJECTION_INDEX_MIGRATION.exists()
    sql = _normalized_sql(
        PROBLEMATIC_ACTIVE_PROJECTION_INDEX_MIGRATION.read_text(encoding="utf-8")
    )

    assert (
        "drop index if exists library.local_track_files_active_track_id_idx"
    ) in sql
    assert (
        "create index local_track_files_active_track_id_idx "
        "on library.local_track_files (track_id) include ("
    ) in sql
    for column_name in (
        "private_path",
        "scan_file_entry_is_object",
        "scan_file_album",
        "scan_file_album_artist",
        "scan_file_artist",
        "scan_file_title",
        "scan_file_year",
        "scan_file_track_number",
        "scan_file_text_mojibake_candidate",
        "scan_file_metadata_problem_candidate",
    ):
        assert column_name in sql
    assert "where scan_cache_stale is false" in sql
    assert "metadata" not in sql.replace(
        "scan_file_metadata_problem_candidate",
        "",
    )


def test_problematic_candidate_index_avoids_unneeded_path_and_title_columns():
    assert PROBLEMATIC_CANDIDATE_INDEX_MIGRATION.exists()
    sql = _normalized_sql(
        PROBLEMATIC_CANDIDATE_INDEX_MIGRATION.read_text(encoding="utf-8")
    )

    assert (
        "create index if not exists local_track_files_problem_candidate_idx "
        "on library.local_track_files (track_id) include ("
    ) in sql
    for column_name in (
        "scan_file_entry_is_object",
        "scan_file_album",
        "scan_file_album_artist",
        "scan_file_year",
        "scan_file_text_mojibake_candidate",
        "scan_file_metadata_problem_candidate",
    ):
        assert column_name in sql
    assert "where scan_cache_stale is false" in sql
    for excluded_column in (
        "private_path",
        "scan_file_artist",
        "scan_file_title",
        "scan_file_track_number",
    ):
        assert excluded_column not in sql


def test_problematic_required_text_candidate_upgrades_existing_candidate_index():
    assert PROBLEMATIC_REQUIRED_TEXT_CANDIDATE_MIGRATION.exists()
    sql = _normalized_sql(
        PROBLEMATIC_REQUIRED_TEXT_CANDIDATE_MIGRATION.read_text(encoding="utf-8")
    )

    assert (
        "create index if not exists local_track_files_problem_candidate_v5_idx "
        "on library.local_track_files (track_id) include ("
    ) in sql
    assert (
        "create index if not exists local_track_files_required_text_missing_candidate_idx "
        "on library.local_track_files (track_id) where scan_cache_stale is false "
        "and scan_file_entry_is_object is true"
    ) in sql
    assert "scan_file_artist" in sql
    assert "scan_file_title" in sql
    assert sql.count("!~ '[^[:space:]]'") == 4
    assert "metadata" not in sql.replace("scan_file_metadata_problem_candidate", "")
    assert "drop index if exists library.local_track_files_problem_candidate_idx" in sql
    assert "drop index if exists library.local_track_files_problem_candidate_v2_idx" in sql
    assert "drop index if exists library.local_track_files_problem_candidate_v3_idx" in sql
    assert "drop index if exists library.local_track_files_problem_candidate_v4_idx" in sql
    assert (
        "drop column if exists scan_file_required_text_missing_candidate"
        in sql
    )


def test_problematic_track_candidate_index_covers_the_active_join_projection():
    assert PROBLEMATIC_TRACK_CANDIDATE_INDEX_MIGRATION.exists()
    sql = _normalized_sql(
        PROBLEMATIC_TRACK_CANDIDATE_INDEX_MIGRATION.read_text(encoding="utf-8")
    )

    assert (
        "create index if not exists local_tracks_problem_candidate_idx "
        "on library.local_tracks (id) include ("
    ) in sql
    for column_name in (
        "library_id",
        "album_id",
        "disc_number",
        "track_number",
        "scan_title_problem_candidate",
    ):
        assert column_name in sql
    assert "metadata" not in sql


def test_cover_lookup_task_delete_grant_repair_migration_file_exists():
    assert COVER_LOOKUP_TASK_DELETE_GRANT_REPAIR_MIGRATION.exists(), (
        "missing required cover lookup task DELETE grant repair migration: "
        "migrations/postgres/0027_repair_cover_lookup_task_delete_grant.sql"
    )


def test_cover_lookup_task_conflict_identity_repair_migration_file_exists():
    assert COVER_LOOKUP_TASK_CONFLICT_IDENTITY_REPAIR_MIGRATION.exists(), (
        "missing required cover lookup task conflict-identity repair migration: "
        "migrations/postgres/0028_repair_cover_lookup_task_conflict_identity.sql"
    )


def test_lastfm_session_conflict_identity_repair_migration_file_exists():
    assert LASTFM_SESSION_CONFLICT_IDENTITY_REPAIR_MIGRATION.exists(), (
        "missing required Last.fm session conflict-identity repair migration: "
        "migrations/postgres/0029_repair_lastfm_session_conflict_identity.sql"
    )


def test_lastfm_session_conflict_identity_repair_adds_unconditional_identity(
    lastfm_session_conflict_identity_repair_sql,
):
    sql = _normalized_sql(lastfm_session_conflict_identity_repair_sql)

    assert re.search(
        r"\bcreate\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?lastfm_sessions_account_username_idx\b"
        r".*\bon\s+integration\.lastfm_sessions\s*\(\s*account_id\s*,\s*provider_username\s*\)",
        sql,
    )
    assert "where is_active" not in sql
    assert "create table" not in sql
    assert "grant " not in sql


def test_cover_lookup_task_conflict_identity_repair_replaces_legacy_index(
    cover_lookup_task_conflict_identity_repair_sql,
):
    sql = _normalized_sql(cover_lookup_task_conflict_identity_repair_sql)

    assert "drop index if exists ops.cover_lookup_tasks_task_key_idx" in sql
    assert re.search(
        r"\bcreate\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?cover_lookup_tasks_task_key_idx\b"
        r".*\bon\s+ops\.cover_lookup_tasks\s*\("
        r".*\blibrary_id\b.*"
        r".*\(metadata->>'source_family'\).*"
        r".*\btask_key\b.*"
        r"\).*where\s+library_id\s+is\s+not\s+null\s+and\s+metadata\s+\?\s+'source_family'",
        sql,
    )
    assert "create table" not in sql
    assert "grant " not in sql


def test_cover_lookup_task_delete_grant_repair_is_role_guarded_and_least_privilege(
    cover_lookup_task_delete_grant_repair_sql,
):
    sql = _normalized_sql(cover_lookup_task_delete_grant_repair_sql)

    assert "rolname = 'album_haven_app'" in sql
    assert "grant delete on table ops.cover_lookup_tasks to album_haven_app" in sql
    assert sql.count("grant delete on table") == 1
    assert "album_haven_readonly" not in sql
    assert "album_haven_migrator" not in sql
    assert "grant all" not in sql
    assert "on all tables" not in sql
    assert not re.search(
        r"\bgrant\s+(?:select|insert|update|truncate|references|trigger)\b",
        sql,
    )


def test_album_ratings_migration_file_exists():
    assert ALBUM_RATINGS_MIGRATION.exists(), (
        "missing app-owned album ratings migration: "
        "migrations/postgres/0026_create_album_ratings.sql"
    )


def test_album_ratings_migration_creates_nullable_scoped_authority(album_ratings_sql):
    sql = _normalized_sql(album_ratings_sql)

    assert _qualified_table_pattern("app.album_ratings").search(album_ratings_sql)
    required_fragments = {
        "id bigint generated always as identity primary key",
        "account_id bigint not null references app.accounts(id) on delete cascade",
        "library_id bigint not null references library.libraries(id) on delete cascade",
        "album_key text not null",
        "rating smallint",
        "provenance text not null",
        "created_at timestamptz not null default now()",
        "updated_at timestamptz not null default now()",
        "metadata jsonb not null default '{}'::jsonb",
    }

    assert sorted(fragment for fragment in required_fragments if fragment not in sql) == []
    assert "album_ratings_rating_range_check" in sql
    assert "rating is null or rating between 1 and 10" in sql
    assert "foreign key (library_id, album_key)" in sql
    assert (
        "references library.local_albums(library_id, album_key) on delete cascade"
        in sql
    )


def test_album_ratings_migration_indexes_stable_authority_identity(album_ratings_sql):
    required_indexes = {
        ("app.album_ratings", ("account_id", "library_id", "album_key")),
        ("app.album_ratings", ("library_id", "album_key")),
    }
    missing_indexes = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(album_ratings_sql)
    )
    sql = _normalized_sql(album_ratings_sql)

    assert missing_indexes == []
    assert "create unique index if not exists album_ratings_account_library_album_key_idx" in sql


def test_album_ratings_migration_grants_bounded_runtime_access(album_ratings_sql):
    sql = _normalized_sql(album_ratings_sql)

    assert "rolname = 'album_haven_readonly'" in sql
    assert "rolname = 'album_haven_app'" in sql
    assert "rolname = 'album_haven_migrator'" in sql
    assert "grant select on table app.album_ratings to album_haven_readonly" in sql
    assert "grant select, insert, update on table app.album_ratings to album_haven_app" in sql
    assert "grant select, insert, update on table app.album_ratings to album_haven_migrator" in sql
    assert "grant usage, select on sequence app.album_ratings_id_seq to album_haven_app" in sql
    assert "grant usage, select on sequence app.album_ratings_id_seq to album_haven_migrator" in sql
    assert "grant select, insert, update, delete" not in sql
    assert "grant all" not in sql


def test_local_album_featured_artist_delete_grant_is_runtime_scoped():
    sql = _normalized_sql(
        LOCAL_ALBUM_FEATURED_ARTIST_DELETE_GRANT_MIGRATION.read_text(encoding="utf-8")
    )

    assert "rolname = 'album_haven_app'" in sql
    assert (
        "grant delete on table library.local_album_featured_artists to album_haven_app"
        in sql
    )
    assert "album_haven_readonly" not in sql
    assert "album_haven_migrator" not in sql
    assert "grant all" not in sql


def test_library_search_trigram_migration_only_adds_extension_and_indexes():
    sql = _normalized_sql(
        LIBRARY_SEARCH_TRIGRAM_INDEXES_MIGRATION.read_text(encoding="utf-8")
    )

    for forbidden in (
        "create table",
        "alter table",
        "drop table",
        "delete from",
        "update ",
        "insert into",
        "grant ",
    ):
        assert forbidden not in sql


def test_library_search_trigram_migration_uses_explicit_non_public_extension_schema():
    sql = _normalized_sql(
        LIBRARY_SEARCH_TRIGRAM_INDEXES_MIGRATION.read_text(encoding="utf-8")
    )

    extension_install = re.search(
        r"\bcreate extension if not exists pg_trgm with schema "
        r"(?P<schema>[a-z_][a-z0-9_]*)\b",
        sql,
    )

    assert extension_install is not None
    assert extension_install.group("schema") != "public"


def test_library_search_trigram_migration_resolves_operator_class_schema_from_extension():
    sql = _normalized_sql(
        LIBRARY_SEARCH_TRIGRAM_INDEXES_MIGRATION.read_text(encoding="utf-8")
    )

    assert "pg_extension" in sql
    assert "pg_namespace" in sql
    assert ".extnamespace" in sql
    assert re.search(r"\bextname\s*=\s*'pg_trgm'", sql)
    assert re.search(r"%i(?:\.gin_trgm_ops|\.%i)", sql)


def test_problematic_file_generated_projection_removes_superseded_index():
    sql = _normalized_sql(
        PROBLEMATIC_FILE_GENERATED_PROJECTION_MIGRATION.read_text(encoding="utf-8")
    )

    assert "drop index if exists library.local_track_files_active_track_projection_idx" in sql


def test_problematic_file_generated_projection_is_stored_and_jsonb_derived():
    sql = _normalized_sql(
        PROBLEMATIC_FILE_GENERATED_PROJECTION_MIGRATION.read_text(encoding="utf-8")
    )

    for column in (
        "scan_cache_stale",
        "scan_file_entry_is_object",
        "scan_file_album",
        "scan_file_album_artist",
        "scan_file_artist",
        "scan_file_title",
        "scan_file_year",
        "scan_file_track_number",
        "scan_file_text_mojibake_candidate",
        "scan_file_metadata_problem_candidate",
    ):
        assert f"add column if not exists {column}" in sql
    assert sql.count("generated always as") == 12
    assert sql.count(" stored") == 12
    assert "scan_cache,file_entry,track_number" in sql
    assert "::boolean" not in sql
    assert "'true', 't', 'yes', 'y', 'on', '1'" in sql


def test_problematic_text_candidate_function_is_immutable_parallel_safe_and_least_privilege():
    sql = _normalized_sql(
        PROBLEMATIC_FILE_GENERATED_PROJECTION_MIGRATION.read_text(encoding="utf-8")
    )

    assert "create or replace function library.problematic_text_candidate(candidate_text text)" in sql
    assert "returns boolean language sql immutable parallel safe" in sql
    assert "revoke all on function library.problematic_text_candidate(text) from public" in sql
    assert "grant execute on function library.problematic_text_candidate(text) to album_haven_app" in sql
    assert "scan_file_text_mojibake_candidate boolean generated always as" in sql
    assert sql.count("library.problematic_text_candidate(metadata #>>") == 6
    assert "scan_title_problem_candidate boolean" in sql
    assert "scan_name_problem_candidate boolean" in sql


def test_required_baseline_migration_file_exists():
    assert BASELINE_MIGRATION.exists(), (
        "missing required baseline migration: "
        "migrations/postgres/0001_create_current_stack_schemas.sql"
    )


def test_local_mbid_assertions_migration_file_exists():
    assert LOCAL_MBID_ASSERTIONS_MIGRATION.exists(), (
        "missing required reviewable migration: "
        "migrations/postgres/0002_create_local_mbid_assertions.sql"
    )


def test_local_mbid_projection_provenance_migration_file_exists():
    assert LOCAL_MBID_PROJECTION_PROVENANCE_MIGRATION.exists(), (
        "missing required projection provenance migration: "
        "migrations/postgres/0003_add_local_mbid_projection_provenance.sql"
    )


def test_policy_context_hooks_migration_file_exists():
    assert POLICY_CONTEXT_HOOKS_MIGRATION.exists(), (
        "missing required policy context hook migration: "
        "migrations/postgres/0005_add_policy_context_hooks.sql"
    )


def test_user_discovery_preferences_migration_file_exists():
    assert USER_DISCOVERY_PREFERENCES_MIGRATION.exists(), (
        "missing required discovery preference migration: "
        "migrations/postgres/0009_create_user_discovery_preferences.sql"
    )


def test_virtual_artist_snapshots_migration_file_exists():
    assert VIRTUAL_ARTIST_SNAPSHOTS_MIGRATION.exists(), (
        "missing required virtual artist snapshots migration: "
        "migrations/postgres/0010_create_virtual_artist_snapshots.sql"
    )


def test_log_history_migration_file_exists():
    assert LOG_HISTORY_MIGRATION.exists(), (
        "missing required log history migration: "
        "migrations/postgres/0011_create_log_history.sql"
    )


def test_drop_log_history_migration_file_exists():
    assert DROP_LOG_HISTORY_MIGRATION.exists(), (
        "missing required Log History drop migration: "
        "migrations/postgres/0030_drop_log_history.sql"
    )


def test_original_log_history_migration_remains_unchanged():
    assert hashlib.sha256(LOG_HISTORY_MIGRATION.read_bytes()).hexdigest() == (
        LOG_HISTORY_MIGRATION_SHA256
    )


def test_virtual_release_snapshots_migration_file_exists():
    assert VIRTUAL_RELEASE_SNAPSHOTS_MIGRATION.exists(), (
        "missing required virtual release snapshots migration: "
        "migrations/postgres/0013_create_virtual_release_snapshots.sql"
    )


def test_bootstrap_owner_nominem_migration_file_exists():
    assert BOOTSTRAP_OWNER_NOMINEM_MIGRATION.exists(), (
        "missing required bootstrap owner identity migration: "
        "migrations/postgres/0014_update_bootstrap_owner_nominem.sql"
    )


def test_local_artist_family_links_migration_file_exists():
    assert LOCAL_ARTIST_FAMILY_LINKS_MIGRATION.exists(), (
        "missing required local artist family links migration: "
        "migrations/postgres/0015_create_local_artist_family_links.sql"
    )


def test_e2e_problematic_fixture_seeds_migration_file_exists():
    assert E2E_PROBLEMATIC_FIXTURE_SEEDS_MIGRATION.exists(), (
        "missing required E2E problematic fixture seed migration: "
        "migrations/postgres/0017_create_e2e_problematic_fixture_seeds.sql"
    )


def test_repair_saved_loop_relations_migration_file_exists():
    assert REPAIR_SAVED_LOOP_RELATIONS_MIGRATION.exists(), (
        "missing required saved loop repair migration: "
        "migrations/postgres/0018_repair_saved_loop_relations.sql"
    )


def test_local_album_featured_artists_migration_file_exists():
    assert LOCAL_ALBUM_FEATURED_ARTISTS_MIGRATION.exists(), (
        "missing required featured-artist inventory migration: "
        "migrations/postgres/0019_create_local_album_featured_artists.sql"
    )


def test_policy_context_hooks_keep_grants_surfaces_and_origins_distinct(
    policy_context_hooks_sql,
):
    sql = _normalized_sql(policy_context_hooks_sql)
    required_tables = {
        "app.client_surface_classes",
        "app.deployment_mode_rules",
        "app.request_origins",
    }
    missing_tables = sorted(
        table
        for table in required_tables
        if not _qualified_table_pattern(table).search(policy_context_hooks_sql)
    )

    required_fragments = {
        "surface_key text primary key",
        "client_surface_class text not null references app.client_surface_classes(surface_key) on delete restrict",
        "capability_key text not null",
        "effect text not null default 'reserved'",
        "account_id bigint references app.accounts(id) on delete set null",
        "origin_type text not null",
        "origin_key text not null",
    }
    missing_fragments = sorted(
        fragment for fragment in required_fragments if fragment not in sql
    )

    for surface_key in ("cloud_web", "private_web", "desktop", "mobile", "tv", "node"):
        assert f"('{surface_key}'" in sql

    assert missing_tables == []
    assert missing_fragments == []
    assert "alter table app.capabilities" not in sql
    assert "client_surface_class" not in _table_sql(sql, "app.capabilities")
    assert "deployment_mode" not in _table_sql(sql, "app.capabilities")
    assert "origin_key" not in _table_sql(sql, "app.capabilities")


def test_policy_context_hooks_indexes_and_grants_are_bounded(policy_context_hooks_sql):
    sql = _normalized_sql(policy_context_hooks_sql)
    required_indexes = {
        ("app.deployment_mode_rules", ("deployment_mode", "rule_key", "client_surface_class", "capability_key")),
        ("app.deployment_mode_rules", ("client_surface_class", "capability_key")),
        ("app.request_origins", ("account_id",)),
        ("app.request_origins", ("client_surface_class", "last_seen_at")),
        ("app.request_origins", ("client_surface_class", "origin_type", "origin_key")),
    }
    missing_indexes = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(policy_context_hooks_sql)
    )

    assert missing_indexes == []
    assert "deployment_mode_rules_effect_check" in sql
    assert "effect in ('reserved', 'allow', 'deny')" in sql
    assert (
        "revoke insert, update, delete on table "
        "app.client_surface_classes, app.deployment_mode_rules from album_haven_app"
    ) in sql
    assert (
        "revoke usage, select on sequence app.deployment_mode_rules_id_seq from album_haven_app"
    ) in sql
    assert "grant select on table app.client_surface_classes, app.deployment_mode_rules to album_haven_app" in sql
    assert "grant select, insert, update on table app.request_origins to album_haven_app" in sql
    assert "grant select, insert, update, delete" not in sql


def test_local_mbid_projection_provenance_migration_adds_columns_and_indexes(
    local_mbid_projection_provenance_sql,
):
    sql = _normalized_sql(local_mbid_projection_provenance_sql)
    projection_tables = (
        "library.local_artists",
        "library.local_albums",
        "library.local_tracks",
    )

    for table_name in projection_tables:
        assert f"alter table {table_name}" in sql
        assert (
            "mbid_assertion_migration_run_id bigint "
            "references ops.migration_runs(id) on delete set null"
        ) in sql
        assert "mbid_assertion_scan_run_ref text" in sql

    required_indexes = {
        (table_name, ("mbid_assertion_migration_run_id",))
        for table_name in projection_tables
    } | {
        (table_name, ("library_id", "evidence_source", "mbid_assertion_state", "mbid_assertion_migration_run_id"))
        for table_name in projection_tables
    }
    required_indexes.add(
        (
            "library.local_artist_mbid_assertions",
            ("migration_run_id",),
        )
    )
    required_indexes.add(
        (
            "library.local_artist_mbid_assertions",
            ("mbid_assertion_scan_run_ref",),
        )
    )

    missing = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(local_mbid_projection_provenance_sql)
    )

    assert missing == []


def test_local_mbid_projection_provenance_migration_adds_artist_assertion_run_fk(
    local_mbid_projection_provenance_sql,
):
    sql = _normalized_sql(local_mbid_projection_provenance_sql)

    assert "alter table library.local_artist_mbid_assertions" in sql
    assert (
        "migration_run_id bigint references ops.migration_runs(id) on delete set null"
    ) in sql
    assert "mbid_assertion_scan_run_ref text" in sql


def test_local_mbid_assertions_migration_creates_review_table(local_mbid_assertions_sql):
    sql = _normalized_sql(local_mbid_assertions_sql)

    assert _qualified_table_pattern("library.local_mbid_assertions").search(sql)
    required_fragments = {
        "id bigint generated always as identity primary key",
        "library_id bigint not null references library.libraries(id) on delete cascade",
        "artist_id bigint references library.local_artists(id) on delete cascade",
        "album_id bigint references library.local_albums(id) on delete cascade",
        "track_id bigint references library.local_tracks(id) on delete cascade",
        "target_kind text not null",
        "target_key text not null",
        "evidence_source text not null",
        "mbid uuid",
        "mbid_assertion_state text not null",
        "confidence numeric(5, 4)",
        "explanation text",
        "observed_at timestamptz not null default now()",
        "migration_run_id bigint references ops.migration_runs(id) on delete set null",
        "source_payload jsonb not null default '{}'::jsonb",
    }

    missing = sorted(fragment for fragment in required_fragments if fragment not in sql)
    assert missing == []


def test_local_mbid_assertions_migration_uses_safe_check_constraints(local_mbid_assertions_sql):
    sql = _normalized_sql(local_mbid_assertions_sql)

    assert "add constraint if not exists" not in sql
    assert "local_mbid_assertions_target_kind_check" in sql
    assert "target_kind in ('artist', 'album', 'track')" in sql
    assert "local_mbid_assertions_target_fk_match_check" in sql
    assert "(target_kind = 'artist' and artist_id is not null and album_id is null and track_id is null)" in sql
    assert "(target_kind = 'album' and artist_id is null and album_id is not null and track_id is null)" in sql
    assert "(target_kind = 'track' and artist_id is null and album_id is null and track_id is not null)" in sql
    assert "pg_constraint" in sql
    assert "conrelid = 'library.local_mbid_assertions'::regclass" in sql


def test_local_mbid_assertions_target_fk_deletes_cascade_to_preserve_match_check(
    local_mbid_assertions_sql,
):
    sql = _normalized_sql(local_mbid_assertions_sql)

    assert "artist_id bigint references library.local_artists(id) on delete cascade" in sql
    assert "album_id bigint references library.local_albums(id) on delete cascade" in sql
    assert "track_id bigint references library.local_tracks(id) on delete cascade" in sql

    forbidden_target_fk_fragments = {
        "artist_id bigint references library.local_artists(id) on delete set null",
        "album_id bigint references library.local_albums(id) on delete set null",
        "track_id bigint references library.local_tracks(id) on delete set null",
    }
    present = sorted(fragment for fragment in forbidden_target_fk_fragments if fragment in sql)

    assert present == []


def test_local_mbid_assertions_migration_declares_fk_and_review_indexes(local_mbid_assertions_sql):
    required_indexes = {
        ("library.local_mbid_assertions", ("library_id",)),
        ("library.local_mbid_assertions", ("artist_id",)),
        ("library.local_mbid_assertions", ("album_id",)),
        ("library.local_mbid_assertions", ("track_id",)),
        ("library.local_mbid_assertions", ("migration_run_id",)),
        ("library.local_mbid_assertions", ("library_id", "target_kind", "mbid_assertion_state")),
        ("library.local_mbid_assertions", ("evidence_source", "mbid_assertion_state")),
    }

    missing = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(local_mbid_assertions_sql)
    )

    assert missing == []


def test_local_mbid_assertions_migration_grants_least_privilege(local_mbid_assertions_sql):
    sql = _normalized_sql(local_mbid_assertions_sql)

    assert "rolname = 'album_haven_readonly'" in sql
    assert "rolname = 'album_haven_app'" in sql
    assert "rolname = 'album_haven_migrator'" in sql
    assert "grant select on table library.local_mbid_assertions to album_haven_readonly" in sql
    assert "grant select, insert, update on table library.local_mbid_assertions to album_haven_app" in sql
    assert "grant select, insert, update on table library.local_mbid_assertions to album_haven_migrator" in sql
    assert "grant usage, select on sequence library.local_mbid_assertions_id_seq to album_haven_app" in sql
    assert "grant usage, select on sequence library.local_mbid_assertions_id_seq to album_haven_migrator" in sql
    assert "grant select, insert, update, delete" not in sql


def test_baseline_creates_current_stack_schemas_and_migration_status_table(baseline_sql):
    sql = _normalized_sql(baseline_sql)

    for schema_name in ("app", "library", "integration", "ops"):
        assert re.search(rf"\bcreate\s+schema\s+if\s+not\s+exists\s+{schema_name}\b", sql)
    assert _qualified_table_pattern("ops.schema_migrations").search(sql)


def test_baseline_includes_current_stack_table_families(baseline_sql):
    required_tables = {
        "library.libraries",
        "library.library_roots",
        "library.library_root_provenance",
        "library.library_root_settings",
        "library.move_policy_settings",
        "library.local_artists",
        "library.local_albums",
        "library.local_tracks",
        "library.local_track_files",
        "library.ignored_versions",
        "library.ignored_repairs",
        "library.manual_versions",
        "library.separate_releases",
        "library.exception_overrides",
        "integration.lastfm_settings",
        "integration.lastfm_sessions",
        "integration.pending_scrobbles",
        "integration.scrobble_retry_state",
        "integration.listen_history",
        "integration.lastfm_loved_tracks",
        "app.track_preferences",
        "app.saved_loops",
        "app.bootstrap_owners",
        "app.accounts",
        "app.account_sessions",
        "app.capabilities",
        "library.library_memberships",
        "ops.migration_runs",
        "ops.migration_source_summaries",
    }

    missing = sorted(
        table
        for table in required_tables
        if not _qualified_table_pattern(table).search(baseline_sql)
    )

    assert missing == []


def test_baseline_separates_app_track_love_from_lastfm_provider_love(baseline_sql):
    sql = _normalized_sql(baseline_sql)

    assert re.search(
        r"\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?app\.track_preferences\b[^;]*\blove_tier\b",
        sql,
    )
    assert re.search(
        r"\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?integration\.lastfm_loved_tracks\b",
        sql,
    )
    assert "lastfm_loved" in sql


def test_baseline_pins_current_track_preference_domains(baseline_sql):
    sql = _normalized_sql(baseline_sql)

    assert re.search(
        r"\btrack_preferences_love_tier_check\b.*\blove_tier\s+is\s+null\s+or\s+love_tier\s+in\s*"
        r"\(\s*'off'\s*,\s*'loved'\s*,\s*'obsessed'\s*\)",
        sql,
    )
    assert re.search(
        r"\btrack_preferences_rating_range_check\b.*\brating\s+is\s+null\s+or\s+rating\s+between\s+1\s+and\s+5\b",
        sql,
    )
    assert "rating between 0 and 100" not in sql


def test_baseline_pins_account_owned_current_state_columns(baseline_sql):
    sql = _normalized_sql(baseline_sql)
    account_owned_tables = (
        "app.capabilities",
        "app.track_preferences",
        "integration.lastfm_settings",
        "integration.lastfm_sessions",
        "integration.lastfm_loved_tracks",
    )

    for table_name in account_owned_tables:
        schema, table = table_name.split(".", 1)
        assert re.search(
            rf"\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?{schema}\.{table}\b[^;]*"
            rf"\baccount_id\s+bigint\s+not\s+null\s+references\s+app\.accounts\(id\)",
            sql,
        ), f"{table_name}.account_id must be not null and account-owned"

    assert re.search(
        r"\bcreate\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?capabilities_active_scope_idx\s+"
        r"on\s+app\.capabilities\s*"
        r"\(\s*account_id\s*,\s*capability_key\s*,\s*scope_kind\s*,\s*scope_id\s*\)\s+"
        r"nulls\s+not\s+distinct\s+where\s+revoked_at\s+is\s+null\b",
        sql,
    )
    assert re.search(
        r"\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?integration\.lastfm_loved_tracks\b[^;]*"
        r"\btrack_key\s+text\s+not\s+null\b",
        sql,
    )


def test_baseline_pins_phase_7_account_and_permission_hook_tables(baseline_sql):
    sql = _normalized_sql(baseline_sql)

    required_fragments = {
        "create table if not exists app.accounts",
        "account_kind text not null default 'bootstrap_owner'",
        "create table if not exists app.account_sessions",
        "session_token_hash text not null",
        "create table if not exists app.capabilities",
        "capability_key text not null",
        "scope_kind text not null default 'global'",
        "create table if not exists library.libraries",
        "owner_account_id bigint references app.accounts(id) on delete set null",
        "create table if not exists library.library_memberships",
        "membership_role text not null default 'owner'",
    }
    missing = sorted(fragment for fragment in required_fragments if fragment not in sql)

    required_indexes = {
        ("app.account_sessions", ("account_id",)),
        ("app.account_sessions", ("session_token_hash",)),
        ("app.capabilities", ("account_id",)),
        ("app.capabilities", ("account_id", "capability_key", "scope_kind", "scope_id")),
        ("library.libraries", ("owner_account_id",)),
        ("library.libraries", ("owner_account_id", "name", "library_kind")),
        ("library.library_memberships", ("account_id",)),
        ("library.library_memberships", ("library_id",)),
        ("library.library_memberships", ("library_id", "account_id")),
    }
    missing_indexes = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(baseline_sql)
    )

    assert missing == []
    assert missing_indexes == []
    assert "create table if not exists app.refresh_token_families" not in sql
    assert "create table if not exists app.external_identity_bindings" not in sql


def test_baseline_defers_future_feature_tables_and_unsupported_sql(baseline_sql):
    sql = _normalized_sql(baseline_sql)
    forbidden_terms = {
        "pinboard",
        "album_tops",
        "playlists",
        "musicbrainz",
        "listenbrainz",
        "perfect_search",
        "search_documents",
        "catalog.artists",
        "catalog.releases",
        "catalog_artists",
        "catalog_releases",
    }

    present_terms = sorted(term for term in forbidden_terms if term in sql)

    assert present_terms == []
    assert "add constraint if not exists" not in sql


def test_baseline_declares_fk_and_common_filter_indexes(baseline_sql):
    required_indexes = {
        ("library.library_roots", ("library_id",)),
        ("library.library_root_provenance", ("library_root_id",)),
        ("library.local_artists", ("library_id",)),
        ("library.local_albums", ("library_id",)),
        ("library.local_albums", ("artist_id",)),
        ("library.local_album_featured_artists", ("library_id",)),
        ("library.local_album_featured_artists", ("album_id",)),
        ("library.local_album_featured_artists", ("artist_id",)),
        ("library.local_album_featured_artists", ("library_id", "artist_id")),
        ("library.local_tracks", ("library_id",)),
        ("library.local_tracks", ("album_id",)),
        ("library.local_track_files", ("track_id",)),
        ("library.library_memberships", ("account_id",)),
        ("library.library_memberships", ("library_id",)),
        ("integration.pending_scrobbles", ("library_id",)),
        ("integration.listen_history", ("library_id", "played_at")),
        ("app.track_preferences", ("account_id",)),
        ("app.saved_loops", ("account_id",)),
        ("app.saved_loops", ("library_id",)),
        ("app.saved_loops", ("track_id",)),
        ("app.saved_loops", ("parent_loop_id",)),
        ("ops.migration_source_summaries", ("migration_run_id",)),
    }

    missing = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(baseline_sql)
    )

    assert missing == []


def test_baseline_declares_saved_loops_metadata_table_and_constraints(baseline_sql):
    sql = _normalized_sql(baseline_sql)

    assert _qualified_table_pattern("app.saved_loops").search(baseline_sql)
    required_fragments = {
        "account_id bigint references app.accounts(id) on delete set null",
        "library_id bigint references library.libraries(id) on delete cascade",
        "track_id bigint references library.local_tracks(id) on delete set null",
        "loop_key text not null",
        "source_private_path text",
        "loop_private_path text",
        "start_seconds numeric(12, 3) not null",
        "end_seconds numeric(12, 3) not null",
        "parent_loop_id bigint references app.saved_loops(id) on delete set null",
        "metadata jsonb not null default '{}'::jsonb",
    }
    missing = sorted(fragment for fragment in required_fragments if fragment not in sql)
    required_indexes = {
        ("app.saved_loops", ("account_id",)),
        ("app.saved_loops", ("library_id",)),
        ("app.saved_loops", ("track_id",)),
        ("app.saved_loops", ("parent_loop_id",)),
        ("app.saved_loops", ("loop_key",)),
    }
    missing_indexes = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(baseline_sql)
    )

    assert missing == []
    assert missing_indexes == []
    assert "saved_loops_time_order_check" in sql
    assert "check (end_seconds > start_seconds)" in sql


def test_baseline_declares_inline_projection_attribution_columns_and_indexes(baseline_sql):
    sql = _normalized_sql(baseline_sql)
    projection_tables = (
        "library.local_artists",
        "library.local_albums",
        "library.local_tracks",
    )

    for table_name in projection_tables:
        schema, table = table_name.split(".", 1)
        assert re.search(
            rf"\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?{schema}\.{table}\b[^;]*"
            rf"\bmbid_assertion_state\s+text\s+not\s+null\s+default\s+'unreviewed'[^;]*"
            rf"\bevidence_source\s+text\b[^;]*"
            rf"\bevidence_confidence\s+numeric\(5,\s*4\)",
            sql,
        ), f"{table_name} must keep inline source-attributed MBID projection columns"

    required_indexes = {
        (table_name, ("library_id", "evidence_source", "mbid_assertion_state"))
        for table_name in projection_tables
    }
    missing = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(baseline_sql)
    )

    assert missing == []


def test_baseline_declares_local_album_featured_artists_table_and_constraints(baseline_sql):
    sql = _normalized_sql(baseline_sql)

    required_fragments = {
        "create table if not exists library.local_album_featured_artists",
        "library_id bigint not null references library.libraries(id) on delete cascade",
        "album_id bigint not null references library.local_albums(id) on delete cascade",
        "artist_id bigint not null references library.local_artists(id) on delete cascade",
        "featured_kind text not null",
        "metadata jsonb not null default '{}'::jsonb",
        "constraint local_album_featured_artists_featured_kind_check check ( featured_kind in ('owner', 'featured_member', 'featured_track_artist') )",
    }
    missing = sorted(fragment for fragment in required_fragments if fragment not in sql)
    assert missing == []

    required_indexes = {
        ("library.local_album_featured_artists", ("library_id",)),
        ("library.local_album_featured_artists", ("album_id",)),
        ("library.local_album_featured_artists", ("artist_id",)),
        ("library.local_album_featured_artists", ("library_id", "artist_id")),
        ("library.local_album_featured_artists", ("library_id", "album_id", "artist_id", "featured_kind")),
    }
    missing_indexes = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(baseline_sql)
    )
    assert missing_indexes == []


def test_baseline_declares_listen_history_source_identity(baseline_sql):
    sql = _normalized_sql(baseline_sql)

    assert re.search(
        r"\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?integration\.listen_history\b[^;]*"
        r"\bsource_family\s+text\b[^;]*\bsource_entry_id\s+text\b",
        sql,
    )
    assert re.search(
        r"\bcreate\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?listen_history_source_identity_idx\b"
        r".*\bon\s+integration\.listen_history\s*\(\s*source_family\s*,\s*source_entry_id\s*\)"
        r".*\bwhere\s+source_family\s+is\s+not\s+null\s+and\s+source_entry_id\s+is\s+not\s+null\b",
        sql,
    )


def test_baseline_declares_cover_lookup_task_operational_table(baseline_sql):
    sql = _normalized_sql(baseline_sql)

    assert _qualified_table_pattern("ops.cover_lookup_tasks").search(baseline_sql)
    required_fragments = {
        "task_key text not null",
        "status text not null",
        "requested_at timestamptz not null default now()",
        "completed_at timestamptz",
        "album_key text",
        "selected_cover_private_path text",
        "provider_payload jsonb not null default '{}'::jsonb",
        "error_message text",
        "metadata jsonb not null default '{}'::jsonb",
    }
    missing = sorted(fragment for fragment in required_fragments if fragment not in sql)
    required_indexes = {
        ("ops.cover_lookup_tasks", ("library_id",)),
        ("ops.cover_lookup_tasks", ("status", "requested_at")),
        ("ops.cover_lookup_tasks", ("task_key",)),
    }
    missing_indexes = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(baseline_sql)
    )

    assert missing == []
    assert missing_indexes == []
    assert "grant select, insert, update on table ops.cover_lookup_tasks to album_haven_app" in sql
    assert "grant usage, select on sequence ops.cover_lookup_tasks_id_seq to album_haven_app" in sql


def test_lastfm_backfill_identity_migration_adds_only_unique_indexes(
    lastfm_backfill_identities_sql,
):
    sql = _normalized_sql(lastfm_backfill_identities_sql)

    assert "create table" not in sql
    assert re.search(
        r"\bcreate\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?lastfm_sessions_active_account_username_idx\b"
        r".*\bon\s+integration\.lastfm_sessions\s*\(\s*account_id\s*,\s*provider_username\s*\)"
        r".*\bwhere\s+is_active\b",
        sql,
    )
    assert re.search(
        r"\bcreate\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?pending_scrobbles_source_identity_idx\b"
        r".*\bon\s+integration\.pending_scrobbles\s*\(\s*\(payload->>'source_family'\)\s*,\s*\(payload->>'source_key'\)\s*\)"
        r".*\bwhere\s+payload\s+\?\s+'source_family'\s+and\s+payload\s+\?\s+'source_key'",
        sql,
    )
    assert re.search(
        r"\bcreate\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?scrobble_retry_state_source_identity_idx\b"
        r".*\bon\s+integration\.scrobble_retry_state\s*\("
        r".*\(metadata->>'source_family'\).*"
        r".*\(metadata->>'source_section'\).*"
        r".*\(metadata->>'source_key'\).*"
        r"\).*where\s+metadata\s+\?\s+'source_family'\s+and\s+metadata\s+\?\s+'source_section'\s+and\s+metadata\s+\?\s+'source_key'",
        sql,
    )


def test_lastfm_sync_scoped_identity_migration_replaces_global_indexes(
    lastfm_sync_scoped_identities_sql,
):
    sql = _normalized_sql(lastfm_sync_scoped_identities_sql)

    assert "create unique index if not exists lastfm_sessions_account_username_idx" in sql
    assert re.search(
        r"\bcreate\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?lastfm_sessions_account_username_idx\b"
        r".*\bon\s+integration\.lastfm_sessions\s*\(\s*account_id\s*,\s*provider_username\s*\)",
        sql,
    )
    assert "drop index if exists pending_scrobbles_source_identity_idx" in sql
    assert "drop index if exists scrobble_retry_state_source_identity_idx" in sql
    assert re.search(
        r"\bcreate\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?pending_scrobbles_source_identity_idx\b"
        r".*\bon\s+integration\.pending_scrobbles\s*\("
        r".*\baccount_id\b.*\blibrary_id\b.*"
        r".*\(payload->>'source_family'\).*"
        r".*\(payload->>'source_key'\).*"
        r"\).*where\s+account_id\s+is\s+not\s+null\s+and\s+library_id\s+is\s+not\s+null",
        sql,
    )
    assert re.search(
        r"\bcreate\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?scrobble_retry_state_source_identity_idx\b"
        r".*\bon\s+integration\.scrobble_retry_state\s*\("
        r".*\(metadata->>'account_id'\).*"
        r".*\(metadata->>'library_id'\).*"
        r".*\(metadata->>'source_family'\).*"
        r".*\(metadata->>'source_section'\).*"
        r".*\(metadata->>'source_key'\).*"
        r"\).*where\s+metadata\s+\?\s+'account_id'\s+and\s+metadata\s+\?\s+'library_id'",
        sql,
    )
    assert "jsonb_build_object( 'account_id', bootstrap_context.account_id::text, 'library_id'" in sql


def test_lastfm_scrobble_conflict_identity_repair_qualifies_replaced_indexes(
    lastfm_scrobble_conflict_identity_repair_sql,
):
    sql = _normalized_sql(lastfm_scrobble_conflict_identity_repair_sql)

    assert "drop index if exists integration.pending_scrobbles_source_identity_idx" in sql
    assert "drop index if exists integration.scrobble_retry_state_source_identity_idx" in sql
    assert re.search(
        r"create\s+unique\s+index\s+pending_scrobbles_source_identity_idx"
        r".*on\s+integration\.pending_scrobbles\s*\(\s*account_id\s*,\s*library_id\s*,"
        r".*\(payload->>'source_family'\).*\(payload->>'source_key'\).*\)"
        r".*where\s+account_id\s+is\s+not\s+null\s+and\s+library_id\s+is\s+not\s+null",
        sql,
    )
    assert re.search(
        r"create\s+unique\s+index\s+scrobble_retry_state_source_identity_idx"
        r".*on\s+integration\.scrobble_retry_state\s*\("
        r".*\(metadata->>'account_id'\).*\(metadata->>'library_id'\)"
        r".*\(metadata->>'source_family'\).*\(metadata->>'source_section'\)"
        r".*\(metadata->>'source_key'\).*\)",
        sql,
    )
    assert "grant " not in sql


def test_cover_lookup_scoped_identity_migration_replaces_global_task_key_index(
    cover_lookup_scoped_identities_sql,
):
    sql = _normalized_sql(cover_lookup_scoped_identities_sql)

    assert "drop index if exists ops.cover_lookup_tasks_task_key_idx" in sql
    assert re.search(
        r"\bcreate\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?cover_lookup_tasks_task_key_idx\b"
        r".*\bon\s+ops\.cover_lookup_tasks\s*\("
        r".*\blibrary_id\b.*"
        r".*\(metadata->>'source_family'\).*"
        r".*\btask_key\b.*"
        r"\).*where\s+library_id\s+is\s+not\s+null\s+and\s+metadata\s+\?\s+'source_family'",
        sql,
    )


def test_saved_loops_scoped_identity_migration_replaces_global_loop_key_index(
    saved_loops_scoped_identities_sql,
):
    sql = _normalized_sql(saved_loops_scoped_identities_sql)

    assert "drop index if exists app.saved_loops_loop_key_idx" in sql
    assert re.search(
        r"\bcreate\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?saved_loops_loop_key_idx\b"
        r".*\bon\s+app\.saved_loops\s*\("
        r"\s*account_id\s*,\s*library_id\s*,\s*loop_key\s*"
        r"\).*where\s+account_id\s+is\s+not\s+null\s+and\s+library_id\s+is\s+not\s+null",
        sql,
    )


def test_repair_saved_loop_relations_migration_repairs_scope_parent_links_and_track_links(
    repair_saved_loop_relations_sql,
):
    sql = _normalized_sql(repair_saved_loop_relations_sql)

    assert "drop index if exists app.saved_loops_loop_key_idx" in sql
    assert re.search(
        r"\bcreate\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?saved_loops_loop_key_idx\b"
        r".*\bon\s+app\.saved_loops\s*\("
        r"\s*account_id\s*,\s*library_id\s*,\s*loop_key\s*"
        r"\).*where\s+account_id\s+is\s+not\s+null\s+and\s+library_id\s+is\s+not\s+null",
        sql,
    )
    assert "update app.saved_loops as loop_row" in sql
    assert "metadata_track_candidates" in sql
    assert "source_track_matches" in sql
    assert "parent_loop_matches" in sql
    assert "parent_loop_id = coalesce(resolved.parent_loop_id, loop_row.parent_loop_id)" in sql
    assert "track_id = coalesce(loop_row.track_id, resolved.track_id)" in sql
    assert "'repair_migration', '0018_repair_saved_loop_relations'" in sql


def test_local_album_featured_artists_migration_creates_repairable_relation(local_album_featured_artists_sql):
    sql = _normalized_sql(local_album_featured_artists_sql)

    required_fragments = {
        "create table if not exists library.local_album_featured_artists",
        "library_id bigint not null references library.libraries(id) on delete cascade",
        "album_id bigint not null references library.local_albums(id) on delete cascade",
        "artist_id bigint not null references library.local_artists(id) on delete cascade",
        "featured_kind text not null",
        "metadata jsonb not null default '{}'::jsonb",
        "constraint local_album_featured_artists_featured_kind_check check ( featured_kind in ('owner', 'featured_member', 'featured_track_artist') )",
    }
    missing = sorted(fragment for fragment in required_fragments if fragment not in sql)
    assert missing == []

    required_indexes = {
        ("library.local_album_featured_artists", ("library_id",)),
        ("library.local_album_featured_artists", ("album_id",)),
        ("library.local_album_featured_artists", ("artist_id",)),
        ("library.local_album_featured_artists", ("library_id", "artist_id")),
        ("library.local_album_featured_artists", ("library_id", "album_id", "artist_id", "featured_kind")),
    }
    missing_indexes = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(local_album_featured_artists_sql)
    )
    assert missing_indexes == []


def test_local_album_featured_artists_migration_grants_no_runtime_delete(
    local_album_featured_artists_sql,
):
    sql = _normalized_sql(local_album_featured_artists_sql)

    assert "rolname = 'album_haven_readonly'" in sql
    assert "rolname = 'album_haven_app'" in sql
    assert "rolname = 'album_haven_migrator'" in sql
    assert "grant select on table library.local_album_featured_artists to album_haven_readonly" in sql
    assert (
        "grant select, insert, update on table library.local_album_featured_artists to album_haven_app"
    ) in sql
    assert (
        "grant select, insert, update on table library.local_album_featured_artists to album_haven_migrator"
    ) in sql
    assert "grant usage, select on sequence library.local_album_featured_artists_id_seq to album_haven_app" in sql
    assert (
        "grant usage, select on sequence library.local_album_featured_artists_id_seq to album_haven_migrator"
    ) in sql
    assert "grant select, insert, update, delete" not in sql
    assert "delete on table library.local_album_featured_artists" not in sql


def test_user_discovery_preferences_migration_creates_scoped_table(
    user_discovery_preferences_sql,
):
    sql = _normalized_sql(user_discovery_preferences_sql)

    assert _qualified_table_pattern("app.user_discovery_preferences").search(
        user_discovery_preferences_sql
    )
    required_fragments = {
        "id bigint generated always as identity primary key",
        "account_id bigint not null references app.accounts(id) on delete cascade",
        "preference_scope text not null",
        "preferences_payload jsonb not null default '{}'::jsonb",
        "metadata jsonb not null default '{}'::jsonb",
        "updated_at timestamptz not null default now()",
    }
    missing = sorted(fragment for fragment in required_fragments if fragment not in sql)
    required_indexes = {
        ("app.user_discovery_preferences", ("account_id",)),
        ("app.user_discovery_preferences", ("account_id", "preference_scope")),
    }
    missing_indexes = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(user_discovery_preferences_sql)
    )

    assert missing == []
    assert missing_indexes == []
    assert "create unique index if not exists user_discovery_preferences_account_scope_idx" in sql


def test_user_discovery_preferences_migration_grants_no_runtime_delete(
    user_discovery_preferences_sql,
):
    sql = _normalized_sql(user_discovery_preferences_sql)

    assert "rolname = 'album_haven_readonly'" in sql
    assert "rolname = 'album_haven_app'" in sql
    assert "grant select on table app.user_discovery_preferences to album_haven_readonly" in sql
    assert (
        "grant select, insert, update on table app.user_discovery_preferences "
        "to album_haven_app"
    ) in sql
    assert (
        "grant usage, select on sequence app.user_discovery_preferences_id_seq "
        "to album_haven_app"
    ) in sql
    assert "grant select, insert, update, delete" not in sql
    assert "delete on table app.user_discovery_preferences" not in sql


def test_virtual_artist_snapshots_migration_creates_snapshot_tables(
    virtual_artist_snapshots_sql,
):
    sql = _normalized_sql(virtual_artist_snapshots_sql)

    assert _qualified_table_pattern("app.virtual_artist_snapshots").search(
        virtual_artist_snapshots_sql
    )
    assert _qualified_table_pattern("app.virtual_artist_recent_lookups").search(
        virtual_artist_snapshots_sql
    )
    required_fragments = {
        "account_id bigint not null references app.accounts(id) on delete cascade",
        "virtual_artist_ref text not null",
        "candidate_ref text not null",
        "provider text not null",
        "provider_artist_id text not null",
        "default_release_scope text not null",
        "actor_key text not null",
        "active_release_scope text not null",
        "metadata jsonb not null default '{}'::jsonb",
    }
    missing = sorted(fragment for fragment in required_fragments if fragment not in sql)
    required_indexes = {
        ("app.virtual_artist_snapshots", ("account_id",)),
        ("app.virtual_artist_snapshots", ("account_id", "virtual_artist_ref")),
        ("app.virtual_artist_snapshots", ("account_id", "expires_at")),
        ("app.virtual_artist_recent_lookups", ("account_id",)),
        (
            "app.virtual_artist_recent_lookups",
            ("account_id", "actor_key", "virtual_artist_ref"),
        ),
        (
            "app.virtual_artist_recent_lookups",
            ("account_id", "actor_key", "recorded_at"),
        ),
    }
    missing_indexes = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(virtual_artist_snapshots_sql)
    )

    assert missing == []
    assert missing_indexes == []


def test_virtual_artist_snapshots_migration_grants_no_runtime_delete(
    virtual_artist_snapshots_sql,
):
    sql = _normalized_sql(virtual_artist_snapshots_sql)

    assert "rolname = 'album_haven_readonly'" in sql
    assert "rolname = 'album_haven_app'" in sql
    assert "rolname = 'album_haven_migrator'" in sql
    assert (
        "grant select on table app.virtual_artist_snapshots, app.virtual_artist_recent_lookups "
        "to album_haven_readonly"
    ) in sql
    assert (
        "grant select, insert, update on table app.virtual_artist_snapshots, "
        "app.virtual_artist_recent_lookups to album_haven_app"
    ) in sql
    assert "grant select, insert, update, delete" not in sql
    assert "delete on table app.virtual_artist_snapshots" not in sql
    assert "delete on table app.virtual_artist_recent_lookups" not in sql


def test_log_history_migration_creates_scoped_runtime_table(log_history_sql):
    sql = _normalized_sql(log_history_sql)

    assert _qualified_table_pattern("ops.log_history").search(log_history_sql)
    required_fragments = {
        "id bigint generated always as identity primary key",
        "account_id bigint references app.accounts(id) on delete set null",
        "library_id bigint references library.libraries(id) on delete cascade",
        "entry_key text not null",
        "logged_at timestamptz not null default now()",
        "metadata jsonb not null default '{}'::jsonb",
    }
    missing = sorted(fragment for fragment in required_fragments if fragment not in sql)
    required_indexes = {
        ("ops.log_history", ("account_id", "logged_at")),
        ("ops.log_history", ("library_id", "logged_at")),
        ("ops.log_history", ("account_id", "library_id", "entry_key")),
    }
    missing_indexes = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(log_history_sql)
    )

    assert missing == []
    assert missing_indexes == []


def test_log_history_migration_grants_no_runtime_delete(log_history_sql):
    sql = _normalized_sql(log_history_sql)

    assert "rolname = 'album_haven_readonly'" in sql
    assert "rolname = 'album_haven_app'" in sql
    assert "grant select on table ops.log_history to album_haven_readonly" in sql
    assert "grant select, insert, update on table ops.log_history to album_haven_app" in sql
    assert "grant usage, select on sequence ops.log_history_id_seq to album_haven_app" in sql
    assert "grant select, insert, update, delete" not in sql
    assert "delete on table ops.log_history" not in sql


def test_drop_log_history_migration_removes_postgres_table(drop_log_history_sql):
    sql = _normalized_sql(drop_log_history_sql)

    assert re.search(
        r"\bdrop\s+table\s+if\s+exists\s+ops\.log_history\b",
        sql,
    )


def test_virtual_release_snapshots_migration_creates_scoped_snapshot_table(
    virtual_release_snapshots_sql,
):
    sql = _normalized_sql(virtual_release_snapshots_sql)

    assert _qualified_table_pattern("ops.virtual_release_snapshots").search(
        virtual_release_snapshots_sql
    )
    required_fragments = {
        "library_id bigint not null references library.libraries(id) on delete cascade",
        "virtual_release_ref text not null",
        "title text not null",
        "artist_credit jsonb not null default '[]'::jsonb",
        "release_date_precision text not null default 'unknown'",
        "source_attributions jsonb not null default '[]'::jsonb",
        "source_provenance jsonb not null default '{}'::jsonb",
        "expires_at timestamptz not null",
        "metadata jsonb not null default '{}'::jsonb",
    }
    missing = sorted(fragment for fragment in required_fragments if fragment not in sql)
    required_indexes = {
        ("ops.virtual_release_snapshots", ("library_id",)),
        ("ops.virtual_release_snapshots", ("library_id", "expires_at")),
        ("ops.virtual_release_snapshots", ("library_id", "virtual_release_ref")),
    }
    missing_indexes = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(virtual_release_snapshots_sql)
    )

    assert missing == []
    assert missing_indexes == []
    assert "where not metadata ? 'purged_at'" in sql


def test_virtual_release_snapshots_migration_grants_no_runtime_delete(
    virtual_release_snapshots_sql,
):
    sql = _normalized_sql(virtual_release_snapshots_sql)

    assert "rolname = 'album_haven_readonly'" in sql
    assert "rolname = 'album_haven_app'" in sql
    assert "grant select on table ops.virtual_release_snapshots to album_haven_readonly" in sql
    assert "grant select, insert, update on table ops.virtual_release_snapshots to album_haven_app" in sql
    assert "grant usage, select on sequence ops.virtual_release_snapshots_id_seq to album_haven_app" in sql
    assert "grant select, insert, update, delete" not in sql
    assert "delete on table ops.virtual_release_snapshots" not in sql


def test_bootstrap_owner_nominem_migration_updates_existing_bootstrap_identity(
    bootstrap_owner_nominem_sql,
):
    sql = _normalized_sql(bootstrap_owner_nominem_sql)

    assert "where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'" in sql
    assert "set display_name = 'nominem'" in sql
    assert "'display_name', 'nominem'" in sql
    assert "update app.bootstrap_owners" in sql
    assert "phase_6_bootstrap_owner_nominem_migration" in sql
    assert "insert into app.accounts" not in sql


def test_local_artist_family_links_migration_creates_scoped_table(
    local_artist_family_links_sql,
):
    sql = _normalized_sql(local_artist_family_links_sql)

    assert _qualified_table_pattern("library.local_artist_family_links").search(
        local_artist_family_links_sql
    )
    required_fragments = {
        "library_id bigint not null references library.libraries(id) on delete cascade",
        "artist_id bigint not null references library.local_artists(id) on delete cascade",
        "related_artist_id bigint not null references library.local_artists(id) on delete cascade",
        "relationship_weight smallint not null default 1",
        "source_family text not null",
        "source_ref text",
        "metadata jsonb not null default '{}'::jsonb",
        "check (artist_id <> related_artist_id)",
    }
    missing = sorted(fragment for fragment in required_fragments if fragment not in sql)
    required_indexes = {
        ("library.local_artist_family_links", ("library_id",)),
        ("library.local_artist_family_links", ("artist_id",)),
        ("library.local_artist_family_links", ("related_artist_id",)),
        ("library.local_artist_family_links", ("library_id", "artist_id", "relationship_weight")),
        ("library.local_artist_family_links", ("library_id", "related_artist_id")),
        (
            "library.local_artist_family_links",
            ("library_id", "artist_id", "related_artist_id", "relationship_weight", "source_family"),
        ),
    }
    missing_indexes = sorted(
        f"{table}({', '.join(columns)})"
        for table, columns in required_indexes
        if not _qualified_index_pattern(table, columns).search(local_artist_family_links_sql)
    )

    assert missing == []
    assert missing_indexes == []


def test_local_artist_family_links_migration_grants_no_runtime_delete(
    local_artist_family_links_sql,
):
    sql = _normalized_sql(local_artist_family_links_sql)

    assert "rolname = 'album_haven_readonly'" in sql
    assert "rolname = 'album_haven_app'" in sql
    assert "rolname = 'album_haven_migrator'" in sql
    assert "grant select on table library.local_artist_family_links to album_haven_readonly" in sql
    assert "grant select, insert, update on table library.local_artist_family_links to album_haven_app" in sql
    assert "grant usage, select on sequence library.local_artist_family_links_id_seq to album_haven_app" in sql
    assert "grant select, insert, update on table library.local_artist_family_links to album_haven_migrator" in sql
    assert "grant usage, select on sequence library.local_artist_family_links_id_seq to album_haven_migrator" in sql
    assert "grant select, insert, update, delete" not in sql


def test_local_artist_family_link_delete_grant_migration_enables_writer_refresh(
    local_artist_family_link_delete_grant_sql,
):
    sql = _normalized_sql(local_artist_family_link_delete_grant_sql)

    assert "rolname = 'album_haven_app'" in sql
    assert "rolname = 'album_haven_migrator'" in sql
    assert "grant delete on table library.local_artist_family_links to album_haven_app" in sql
    assert "grant delete on table library.local_artist_family_links to album_haven_migrator" in sql
    assert "album_haven_readonly" not in sql


def test_runtime_delete_privileges_migration_grants_only_required_table_deletes(
    runtime_delete_privileges_sql,
):
    sql = _normalized_sql(runtime_delete_privileges_sql)
    required_tables = {
        "integration.pending_scrobbles",
        "integration.scrobble_retry_state",
        "integration.listen_history",
        "library.move_policy_settings",
        "library.ignored_versions",
        "library.ignored_repairs",
        "library.manual_versions",
        "library.separate_releases",
        "library.exception_overrides",
        "ops.cover_lookup_tasks",
    }
    grant_match = re.search(
        r"\bgrant delete on table (?P<tables>.+?) to album_haven_app\b",
        sql,
    )

    assert "rolname = 'album_haven_app'" in sql
    assert grant_match is not None
    assert {table_name.strip() for table_name in grant_match.group("tables").split(",")} == required_tables
    assert sql.count("grant delete on table") == 1
    assert "to album_haven_app" in sql
    assert "album_haven_readonly" not in sql
    assert "album_haven_migrator" not in sql
    assert "grant all" not in sql
    assert "on all tables" not in sql
    assert not re.search(r"\bgrant\s+(?:select|insert|update|truncate|references|trigger)\b", sql)


def test_semantic_album_delete_grant_repair_is_least_privileged():
    sql = _normalized_sql(
        SEMANTIC_ALBUM_DELETE_GRANT_REPAIR_MIGRATION.read_text(encoding="utf-8")
    )

    assert (
        "grant delete on table library.ignored_versions, "
        "library.manual_versions to album_haven_app"
    ) in sql
    assert sql.count("grant delete on table") == 1
    assert "album_haven_readonly" not in sql
    assert "grant all" not in sql
    assert "on all tables" not in sql


def test_ignored_repairs_delete_grant_repair_is_least_privileged():
    sql = _normalized_sql(
        IGNORED_REPAIRS_DELETE_GRANT_REPAIR_MIGRATION.read_text(encoding="utf-8")
    )

    assert "rolname = 'album_haven_app'" in sql
    assert "grant delete on table library.ignored_repairs to album_haven_app" in sql
    assert sql.count("grant delete on table") == 1
    assert "album_haven_readonly" not in sql
    assert "grant all" not in sql
    assert "on all tables" not in sql


def test_e2e_problematic_fixture_seeds_migration_creates_seed_table_and_bootstrap_seed(
    e2e_problematic_fixture_seeds_sql,
):
    sql = _normalized_sql(e2e_problematic_fixture_seeds_sql)

    assert _qualified_table_pattern("app.e2e_problematic_file_fixture_seeds").search(
        e2e_problematic_fixture_seeds_sql
    )
    assert "seed_key text not null" in sql
    assert "payload jsonb not null default '{}'::jsonb" in sql
    assert "create unique index if not exists e2e_problematic_file_fixture_seeds_seed_key_idx" in sql
    assert "insert into app.e2e_problematic_file_fixture_seeds" in sql
    assert "'problematic-files-small'" in sql
    assert "grant select on table app.e2e_problematic_file_fixture_seeds to album_haven_app" in sql


def test_baseline_grants_runtime_and_readonly_roles(baseline_sql):
    sql = _normalized_sql(baseline_sql)

    assert "rolname = 'album_haven_readonly'" in sql
    assert "rolname = 'album_haven_app'" in sql
    assert "grant usage on schema app, library, integration, ops to album_haven_readonly" in sql
    assert "grant select on all tables in schema app, library, integration, ops to album_haven_readonly" in sql
    assert "grant usage on schema app, library, integration, ops to album_haven_app" in sql
    assert "revoke all on all tables in schema app, library, integration, ops from album_haven_app" in sql
    assert (
        "grant select, insert, update on all tables in schema app, library, integration "
        "to album_haven_app"
    ) in sql
    assert "grant select, insert, update on table ops.cover_lookup_tasks to album_haven_app" in sql
    assert "ops.schema_migrations to album_haven_app" not in sql
    assert "ops.migration_runs to album_haven_app" not in sql
    assert "ops.migration_source_summaries to album_haven_app" not in sql
    assert "grant select, insert, update, delete" not in sql
    assert "alter default privileges in schema app grant select on tables to album_haven_readonly" in sql
    assert (
        "alter default privileges in schema app grant select, insert, update on tables "
        "to album_haven_app"
    ) in sql
    assert "alter default privileges in schema ops grant select, insert, update on tables to album_haven_app" not in sql
    assert "alter default privileges in schema ops grant usage, select on sequences to album_haven_app" not in sql


def test_baseline_avoids_duplicate_single_column_indexes_when_unique_index_exists(baseline_sql):
    sql = _normalized_sql(baseline_sql)

    assert _qualified_index_pattern("library.libraries", ("owner_account_id", "name", "library_kind")).search(
        baseline_sql
    )
    assert "library_root_settings_library_id_idx" not in sql
    assert "lastfm_settings_account_id_idx" not in sql
    assert _qualified_index_pattern("library.library_root_settings", ("library_id",)).search(
        baseline_sql
    )
    assert _qualified_index_pattern("integration.lastfm_settings", ("account_id",)).search(
        baseline_sql
    )


def test_waveform_peak_cache_has_bounded_payload_identity_and_least_privilege_grants():
    sql = _normalized_sql(
        WAVEFORM_PEAK_CACHE_MIGRATION.read_text(encoding="utf-8")
    )

    assert "create table if not exists library.local_track_waveform_peaks" in sql
    assert (
        "track_file_id bigint not null references library.local_track_files(id) on delete cascade"
        in sql
    )
    assert "sample_count integer not null" in sql
    assert "analyzer_version text not null" in sql
    assert "file_size_bytes bigint not null" in sql
    assert "modified_at_ns bigint not null" in sql
    assert "content_signature text" in sql
    assert "left_peaks real[] not null" in sql
    assert "right_peaks real[] not null" in sql
    assert "primary key (track_file_id, sample_count)" in sql
    assert "sample_count > 0" in sql
    assert "cardinality(left_peaks) = sample_count" in sql
    assert "cardinality(right_peaks) = sample_count" in sql
    assert "grant select, insert, update on table" in sql
    assert "library.local_track_waveform_peaks" in sql
    assert "to album_haven_app" in sql
    assert "grant select on table" in sql
    assert "to album_haven_readonly" in sql
    assert "grant delete" not in sql
    assert "grant all" not in sql


def test_tag_edit_intents_migration_creates_recoverable_least_privilege_journal():
    sql = _normalized_sql(TAG_EDIT_INTENTS_MIGRATION.read_text(encoding="utf-8"))

    assert "create table if not exists library.tag_edit_intents" in sql
    assert "id uuid primary key" in sql
    assert "library_root_identity text not null" in sql
    assert "changes jsonb not null" in sql
    assert "jsonb_typeof(changes) = 'array'" in sql
    for status in (
        "prepared",
        "files_verified",
        "completed",
        "rolled_back",
        "reconciled_external",
        "recovery_failed",
    ):
        assert f"'{status}'" in sql
    assert "create index if not exists tag_edit_intents_unfinished_idx" in sql
    assert (
        "on library.tag_edit_intents (library_root_identity, created_at, id)"
        in sql
    )
    assert "where status in ('prepared', 'files_verified', 'recovery_failed')" in sql
    assert "grant select, insert, update on table" in sql
    assert "to album_haven_app" in sql
    assert "to album_haven_migrator" in sql
    assert (
        "revoke select on table library.tag_edit_intents from album_haven_readonly"
        in sql
    )
    assert "grant select on table library.tag_edit_intents to album_haven_readonly" not in sql
    assert "grant delete" not in sql
    assert "grant all" not in sql
