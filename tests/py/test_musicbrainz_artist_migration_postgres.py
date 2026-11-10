from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from tests.e2e.support import isolatedPostgres


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_ROOT = REPO_ROOT / "migrations" / "postgres"
MIGRATION_NAME = "0171_create_musicbrainz_artist_enrichment.sql"
MIGRATION_PATH = MIGRATIONS_ROOT / MIGRATION_NAME
DISCOGS_MIGRATION_NAME = "0172_add_musicbrainz_artist_discogs_link.sql"
RECHECK_MIGRATION_NAME = "0173_recheck_musicbrainz_matches_from_stored_artist_mbids.sql"
MATCHER_VERSION_MIGRATION_NAME = "0174_add_musicbrainz_matcher_version_and_credit_name.sql"
ALBUM_EVIDENCE_MIGRATION_NAME = "0175_add_musicbrainz_match_album_evidence.sql"


def apply_delivery_migrations(connection) -> None:
    """Apply 0171 and every later Delivery 1 migration, in order."""
    for path in sorted(MIGRATIONS_ROOT.glob("*.sql")):
        if path.name >= MIGRATION_NAME:
            connection.execute(path.read_text(encoding="utf-8"))

ARTIST_TABLES = {
    "integration.musicbrainz_artists",
    "integration.musicbrainz_artist_aliases",
    "integration.musicbrainz_artist_countries",
    "integration.musicbrainz_artist_tags",
    "library.local_artist_musicbrainz_matches",
    "library.local_artist_musicbrainz_candidates",
    "ops.metadata_enrichment_jobs",
    "library.metadata_enrichment_problems",
}


def _normalized_sql() -> str:
    assert MIGRATION_PATH.is_file(), f"missing Delivery 1 migration: {MIGRATION_NAME}"
    return " ".join(MIGRATION_PATH.read_text(encoding="utf-8").casefold().split())


def _dedicated_database_urls_or_skip(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[str, str]:
    setup_value = str(os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV) or "").strip()
    runtime_value = str(os.environ.get(isolatedPostgres.RUNTIME_DATABASE_ENV) or "").strip()
    if not setup_value and not runtime_value:
        pytest.skip("Dedicated isolated Postgres URLs are not configured.")

    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    pgpass_value = str(os.environ.get("PGPASSFILE") or "").strip()
    if not pgpass_value:
        pytest.skip("Dedicated isolated Postgres PGPASSFILE is not configured.")
    pgpass_path = Path(pgpass_value)
    if not pgpass_path.is_file():
        pytest.skip(f"Dedicated isolated Postgres pgpass file is unavailable: {pgpass_path}")
    monkeypatch.setenv("PGPASSFILE", str(pgpass_path))

    psycopg = pytest.importorskip("psycopg")
    try:
        with isolatedPostgres._connect(setup_url) as connection:
            isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        with isolatedPostgres._connect(runtime_url) as connection:
            isolatedPostgres._assert_connected_role(connection, isolatedPostgres.RUNTIME_ROLE)
    except psycopg.OperationalError as exc:
        pytest.skip(f"Dedicated isolated Postgres database is unavailable: {exc}")
    return setup_url, runtime_url


def _drop_application_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        connection.execute("drop schema if exists app, integration, library, ops cascade")


def _apply_pre_delivery_migrations(setup_url: str) -> None:
    migration_paths = sorted(
        path
        for path in MIGRATIONS_ROOT.glob("*.sql")
        if path.is_file() and path.name < MIGRATION_NAME
    )
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        for migration_path in migration_paths:
            migration_sql = migration_path.read_text(encoding="utf-8")
            if "index concurrently" in migration_sql.casefold():
                isolatedPostgres._apply_nontransactional_migration(
                    connection, migration_sql, migration_path.name
                )
            else:
                connection.execute(migration_sql)


def test_delivery_1_migration_is_next_and_lexically_ordered():
    names = sorted(path.name for path in MIGRATIONS_ROOT.glob("*.sql") if path.is_file())

    assert MIGRATION_NAME in names
    start = names.index(MIGRATION_NAME)
    assert names[start:start + 5] == [MIGRATION_NAME, DISCOGS_MIGRATION_NAME, RECHECK_MIGRATION_NAME,
                                      MATCHER_VERSION_MIGRATION_NAME, ALBUM_EVIDENCE_MIGRATION_NAME]
    # 0112 is the ported Problematic Files path projection, also a reserved number.
    assert names[names.index(MIGRATION_NAME) - 1].startswith("0112_")


def test_migration_creates_only_the_required_artist_foundation_and_display_projection():
    sql = _normalized_sql()

    for table_name in ARTIST_TABLES:
        assert f"create table if not exists {table_name}" in sql
    assert "create or replace view integration.musicbrainz_artist_display_genres" in sql
    assert "release_group" not in sql
    assert "recording_mbid" not in sql
    assert "local_track_musicbrainz" not in sql


def test_canonical_artist_projection_uses_uuid_mbids_and_bounded_normalized_facts():
    sql = _normalized_sql()

    required_fragments = {
        "mbid uuid primary key",
        "canonical_name text not null",
        "sort_name text",
        "preferred_native_name text",
        "artist_kind text",
        "refreshed_at timestamptz not null",
        "artist_mbid uuid not null references integration.musicbrainz_artists(mbid)",
        "alias_normalized text not null",
        "country_code text not null",
        "tag_name text not null",
        "tag_normalized text not null",
        "vote_count integer not null",
        "is_genre boolean not null",
        "provenance text not null",
    }
    assert sorted(fragment for fragment in required_fragments if fragment not in sql) == []
    assert re.search(r"check \(char_length\(canonical_name\) between 1 and \d+\)", sql)
    assert re.search(r"check \(char_length\(tag_normalized\) between 1 and \d+\)", sql)
    assert re.search(
        r"unique index if not exists \w+ on integration\.musicbrainz_artist_tags "
        r"\(artist_mbid, tag_normalized\)",
        sql,
    )


def test_match_candidate_job_and_problem_states_are_checked_and_artist_only():
    sql = _normalized_sql()

    for state in ("pending", "matched", "ambiguous", "not_found", "conflict", "manual_review"):
        assert f"'{state}'" in sql
    for state in ("queued", "leased", "retry_wait", "succeeded", "needs_review", "exhausted"):
        assert f"'{state}'" in sql
    for decision_source in ("automatic", "manual"):
        assert f"'{decision_source}'" in sql
    assert "check (confidence between 0 and 1)" in sql
    assert "check (candidate_score between 0 and 1)" in sql
    assert "check (target_kind = 'artist')" in sql
    assert "check (candidate_count >= 0)" in sql
    assert "check (attempt_count >= 0)" in sql


def test_match_and_candidate_rows_keep_bounded_decision_and_audit_evidence():
    sql = _normalized_sql()

    for column in (
        "decision_source text not null",
        "evidence_summary text not null",
        "selected_at timestamptz",
        "decided_by_account_id bigint",
        "last_verified_at timestamptz",
        "provider_classification text",
        "provider_observed_at timestamptz",
        "provider_response_hash text",
        "rejection_reason text",
        "observed_at timestamptz not null",
        "first_observed_at timestamptz not null",
        "last_observed_at timestamptz not null",
        "resolved_at timestamptz",
        "resolution_source text",
    ):
        assert column in sql


def test_library_owned_rows_use_library_safe_foreign_keys():
    sql = _normalized_sql()

    assert "unique (library_id, id)" in sql
    for table_name in (
        "library.local_artist_musicbrainz_matches",
        "library.local_artist_musicbrainz_candidates",
        "ops.metadata_enrichment_jobs",
        "library.metadata_enrichment_problems",
    ):
        table_start = sql.index(f"create table if not exists {table_name}")
        table_sql = sql[table_start : sql.index(");", table_start) + 2]
        assert "library_id bigint not null" in table_sql
        assert "local_artist_id bigint not null" in table_sql
        assert (
            "foreign key (library_id, local_artist_id) references "
            "library.local_artists(library_id, id)"
        ) in table_sql


def test_current_match_active_work_and_due_work_have_scoped_indexes():
    sql = _normalized_sql()

    required_index_patterns = (
        r"create unique index if not exists \w+ on library\.local_artist_musicbrainz_matches "
        r"\(library_id, local_artist_id\)",
        r"create unique index if not exists \w+ on ops\.metadata_enrichment_jobs "
        r"\(library_id, local_artist_id, job_kind\) where state in "
        r"\('queued', 'leased', 'retry_wait'\)",
        r"create index if not exists \w+ on ops\.metadata_enrichment_jobs "
        r"\(next_attempt_at, priority, id\) where state in \('queued', 'retry_wait'\)",
        r"create unique index if not exists \w+ on library\.metadata_enrichment_problems "
        r"\(library_id, local_artist_id, reason_code\) where lifecycle_state = 'active'",
    )
    for pattern in required_index_patterns:
        assert re.search(pattern, sql), pattern


def test_all_tags_are_retained_but_display_genres_are_ranked_and_bounded_in_a_view():
    sql = _normalized_sql()
    view_start = sql.index(
        "create or replace view integration.musicbrainz_artist_display_genres"
    )
    view_sql = sql[view_start:]

    assert "delete from integration.musicbrainz_artist_tags" not in sql
    assert "is_genre is true" in view_sql
    assert "vote_count > 0" in view_sql
    assert "vote_count = 0" in view_sql
    assert "not exists" in view_sql
    assert "vote_count < 0" not in view_sql
    assert "row_number() over" in view_sql
    assert "order by vote_count desc, tag_normalized asc" in view_sql
    assert "display_rank <= 3" in view_sql


def test_migration_does_not_create_raw_provider_payload_authority():
    sql = _normalized_sql()

    forbidden_columns = (
        "provider_payload",
        "raw_payload",
        "raw_response",
        "response_json",
        "source_payload",
        "inventory_json",
    )
    for column in forbidden_columns:
        assert not re.search(rf"\b{column}\s+jsonb\b", sql)
    assert "jsonb not null" not in sql


def test_migration_grants_only_bounded_runtime_access():
    sql = _normalized_sql()

    table_list = ", ".join(sorted(ARTIST_TABLES))
    assert "rolname = 'album_haven_readonly'" in sql
    assert "rolname = 'album_haven_app'" in sql
    assert "rolname = 'album_haven_migrator'" in sql
    assert "grant all" not in sql
    assert "on all tables" not in sql
    assert "grant truncate" not in sql
    assert "revoke all on" in sql
    for table_name in ARTIST_TABLES:
        assert re.search(
            rf"grant select on table [^;]*\b{re.escape(table_name)}\b[^;]* to album_haven_readonly",
            sql,
        ) or f"grant select on table {table_list} to album_haven_readonly" in sql
        assert re.search(
            rf"grant select, insert, update on table [^;]*\b{re.escape(table_name)}\b[^;]* "
            r"to album_haven_app",
            sql,
        ) or f"grant select, insert, update on table {table_list} to album_haven_app" in sql

    replaceable_projection_tables = {
        "integration.musicbrainz_artist_aliases",
        "integration.musicbrainz_artist_countries",
        "integration.musicbrainz_artist_tags",
        "library.local_artist_musicbrainz_candidates",
    }
    delete_grants = re.findall(
        r"grant delete on table (?P<tables>[^;]+) to album_haven_app", sql
    )
    granted_delete_tables = {
        table_name.strip()
        for grant in delete_grants
        for table_name in grant.split(",")
    }
    assert granted_delete_tables <= replaceable_projection_tables
    assert not re.search(
        r"grant delete on table [^;]+ to (?!album_haven_app\b)\w+", sql
    )


def test_live_migration_is_idempotent_preserves_existing_data_and_enforces_isolation(
    monkeypatch: pytest.MonkeyPatch,
):
    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    cleanup_complete = False
    try:
        _drop_application_schemas(setup_url)
        _apply_pre_delivery_migrations(setup_url)
        isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)

        with isolatedPostgres._connect(setup_url) as connection:
            owner = connection.execute(
                """
                select app.bootstrap_owners.account_id, library.libraries.id as library_id
                from app.bootstrap_owners
                join library.libraries
                  on library.libraries.owner_account_id = app.bootstrap_owners.account_id
                where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                limit 1
                """
            ).fetchone()
            library_id = int(owner["library_id"])
            artist_id = int(
                connection.execute(
                    """
                    insert into library.local_artists (library_id, artist_key, name, metadata)
                    values (%s, 'delivery-1-existing-artist', 'Existing Artist',
                            '{"survives_delivery_1":true}'::jsonb)
                    returning id
                    """,
                    (library_id,),
                ).fetchone()["id"]
            )
            album_id = int(
                connection.execute(
                    """
                    insert into library.local_albums
                      (library_id, artist_id, album_key, title, metadata)
                    values (%s, %s, 'delivery-1-existing-album', 'Existing Album',
                            '{"survives_delivery_1":true}'::jsonb)
                    returning id
                    """,
                    (library_id, artist_id),
                ).fetchone()["id"]
            )
            track_id = int(
                connection.execute(
                    """
                    insert into library.local_tracks
                      (library_id, album_id, artist_id, track_key, title, metadata)
                    values (%s, %s, %s, 'delivery-1-existing-track', 'Existing Track',
                            '{"survives_delivery_1":true}'::jsonb)
                    returning id
                    """,
                    (library_id, album_id, artist_id),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into app.e2e_problematic_file_fixture_seeds (seed_key, payload)
                values ('delivery-1-existing-problem',
                        '{"problem_reasons":["Missing year"]}'::jsonb)
                on conflict (seed_key) do update set payload = excluded.payload
                """
            )

            migration_sql = MIGRATION_PATH.read_text(encoding="utf-8")
            connection.execute(migration_sql)
            first_catalog = connection.execute(
                """
                select schemaname, tablename
                from pg_tables
                where schemaname in ('integration', 'library', 'ops')
                  and schemaname || '.' || tablename = any(%s)
                order by schemaname, tablename
                """,
                (sorted(ARTIST_TABLES),),
            ).fetchall()
            connection.execute(migration_sql)
            second_catalog = connection.execute(
                """
                select schemaname, tablename
                from pg_tables
                where schemaname in ('integration', 'library', 'ops')
                  and schemaname || '.' || tablename = any(%s)
                order by schemaname, tablename
                """,
                (sorted(ARTIST_TABLES),),
            ).fetchall()

            assert {f"{row['schemaname']}.{row['tablename']}" for row in first_catalog} == ARTIST_TABLES
            assert second_catalog == first_catalog
            assert connection.execute(
                "select name, metadata from library.local_artists where id = %s", (artist_id,)
            ).fetchone() == {
                "name": "Existing Artist",
                "metadata": {"survives_delivery_1": True},
            }
            assert connection.execute(
                "select title, metadata from library.local_albums where id = %s", (album_id,)
            ).fetchone() == {
                "title": "Existing Album",
                "metadata": {"survives_delivery_1": True},
            }
            assert connection.execute(
                "select title, metadata from library.local_tracks where id = %s", (track_id,)
            ).fetchone() == {
                "title": "Existing Track",
                "metadata": {"survives_delivery_1": True},
            }
            assert connection.execute(
                "select payload from app.e2e_problematic_file_fixture_seeds "
                "where seed_key = 'delivery-1-existing-problem'"
            ).fetchone() == {"payload": {"problem_reasons": ["Missing year"]}}

            positive_artist_mbid = "00000000-0000-0000-0000-000000000087"
            zero_fallback_artist_mbid = "00000000-0000-0000-0000-000000000088"
            connection.execute(
                """
                insert into integration.musicbrainz_artists
                  (mbid, canonical_name, refreshed_at)
                values
                  (%s, 'Positive Genre Artist', now()),
                  (%s, 'Zero Fallback Artist', now())
                """,
                (positive_artist_mbid, zero_fallback_artist_mbid),
            )
            connection.execute(
                """
                insert into integration.musicbrainz_artist_tags
                  (artist_mbid, tag_name, tag_normalized, vote_count, is_genre, provenance)
                values
                  (%s, 'Heavy Metal', 'heavy metal', 12, true, 'musicbrainz'),
                  (%s, 'Power Metal', 'power metal', 12, true, 'musicbrainz'),
                  (%s, 'Progressive Metal', 'progressive metal', 8, true, 'musicbrainz'),
                  (%s, 'Speed Metal', 'speed metal', 2, true, 'musicbrainz'),
                  (%s, 'Epic', 'epic', 50, false, 'musicbrainz'),
                  (%s, 'Rock', 'rock', 0, true, 'musicbrainz'),
                  (%s, 'Pop', 'pop', -1, true, 'musicbrainz'),
                  (%s, 'Ambient', 'ambient', 0, true, 'musicbrainz'),
                  (%s, 'Folk', 'folk', 0, true, 'musicbrainz'),
                  (%s, 'Rock', 'rock', 0, true, 'musicbrainz'),
                  (%s, 'Dark', 'dark', 99, false, 'musicbrainz'),
                  (%s, 'Noise', 'noise', -3, true, 'musicbrainz')
                """,
                (
                    positive_artist_mbid,
                    positive_artist_mbid,
                    positive_artist_mbid,
                    positive_artist_mbid,
                    positive_artist_mbid,
                    positive_artist_mbid,
                    positive_artist_mbid,
                    zero_fallback_artist_mbid,
                    zero_fallback_artist_mbid,
                    zero_fallback_artist_mbid,
                    zero_fallback_artist_mbid,
                    zero_fallback_artist_mbid,
                ),
            )
            assert connection.execute(
                "select count(*) from integration.musicbrainz_artist_tags"
            ).fetchone() == {"count": 12}
            assert connection.execute(
                """
                select tag_name, vote_count, display_rank
                from integration.musicbrainz_artist_display_genres
                where artist_mbid = %s
                order by display_rank
                """,
                (positive_artist_mbid,),
            ).fetchall() == [
                {"tag_name": "Heavy Metal", "vote_count": 12, "display_rank": 1},
                {"tag_name": "Power Metal", "vote_count": 12, "display_rank": 2},
                {"tag_name": "Progressive Metal", "vote_count": 8, "display_rank": 3},
            ]
            assert connection.execute(
                """
                select tag_name, vote_count, display_rank
                from integration.musicbrainz_artist_display_genres
                where artist_mbid = %s
                order by display_rank
                """,
                (zero_fallback_artist_mbid,),
            ).fetchall() == [
                {"tag_name": "Ambient", "vote_count": 0, "display_rank": 1},
                {"tag_name": "Folk", "vote_count": 0, "display_rank": 2},
                {"tag_name": "Rock", "vote_count": 0, "display_rank": 3},
            ]

            second_account_id = int(
                connection.execute(
                    """
                    insert into app.accounts
                      (display_name, account_kind, username_display, username_normalized,
                       contact_email, contact_email_normalized)
                    values ('Delivery 1 Other Owner', 'managed', 'delivery-1-other',
                            'delivery-1-other', 'delivery-1-other@example.test',
                            'delivery-1-other@example.test')
                    returning id
                    """
                ).fetchone()["id"]
            )
            second_library_id = int(
                connection.execute(
                    """
                    insert into library.libraries (owner_account_id, name, library_kind)
                    values (%s, 'Delivery 1 Other Library', 'local') returning id
                    """,
                    (second_account_id,),
                ).fetchone()["id"]
            )
            with pytest.raises(pytest.importorskip("psycopg").errors.ForeignKeyViolation):
                with connection.transaction():
                    connection.execute(
                        """
                        insert into library.local_artist_musicbrainz_matches
                          (library_id, local_artist_id, state, decision_source,
                           confidence, evidence_summary)
                        values (%s, %s, 'pending', 'automatic', 0, 'cross-library probe')
                        """,
                        (second_library_id, artist_id),
                    )

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)
