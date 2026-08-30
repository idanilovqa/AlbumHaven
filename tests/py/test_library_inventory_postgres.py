from __future__ import annotations

from contextlib import nullcontext
import re

import pytest

from music_app.services import library_inventory_postgres as inventory_module
from music_app.services.library_inventory_postgres import (
    MAX_NON_ALBUM_CANDIDATE_LIMIT,
    PostgresLibraryInventoryRepository,
    is_library_inventory_postgres_available,
)
from music_app.services.persistence_selection import (
    create_runtime_library_inventory_repository,
    select_runtime_persistence_adapter,
)


DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"


class FakeCursor:
    def __init__(self, *, row=None, rows=None):
        self._row = row
        self._rows = list(rows or [])

    def fetchone(self):
        return self._row

    def fetchall(self):
        return list(self._rows)


class FakeConnection:
    def __init__(self, cursors):
        self.cursors = list(cursors)
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        return False

    def execute(self, sql, params):
        self.calls.append((sql, dict(params)))
        return self.cursors.pop(0)


def repository_for(connection):
    return PostgresLibraryInventoryRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=lambda database_url: (
            nullcontext(connection)
            if database_url == DATABASE_URL
            else pytest.fail(f"unexpected database URL: {database_url}")
        ),
    )


def test_support_state_is_sorted_deterministic_and_loaded_by_one_nonmultiplying_query():
    connection = FakeConnection(
        [
            FakeCursor(
                row={
                    "ignored_version_keys": ["version-z", "version-a"],
                    "manual_version_links": {
                        "child-z": "parent-z",
                        "child-a": "parent-a",
                    },
                }
            )
        ]
    )

    result = repository_for(connection).load_support_state()

    assert result == {
        "ignored_version_keys": ["version-a", "version-z"],
        "manual_version_links": {
            "child-a": "parent-a",
            "child-z": "parent-z",
        },
    }
    assert len(connection.calls) == 1
    sql, params = connection.calls[0]
    assert params == {}
    assert "ignored_version_state as" in sql
    assert "manual_version_state as" in sql
    assert "select ignored_version_keys from ignored_version_state" in sql
    assert "select manual_version_links from manual_version_state" in sql
    assert "ignored_version_state join manual_version_state" not in sql.lower()


def test_inventory_reads_reuse_caller_owned_snapshot_without_opening_connections():
    connection = FakeConnection(
        [
            FakeCursor(row={"ignored_version_keys": [], "manual_version_links": {}}),
            FakeCursor(rows=[]),
        ]
    )
    repository = PostgresLibraryInventoryRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=lambda _database_url: pytest.fail("caller-owned snapshot opened a second connection"),
    )

    assert repository.load_support_state(connection=connection) == {
        "ignored_version_keys": [],
        "manual_version_links": {},
    }
    assert repository.load_non_album_candidates(connection=connection) == []
    assert len(connection.calls) == 2


def test_candidate_rows_retain_raw_inventory_credits_paths_root_category_and_file_entry():
    raw_row = {
        "track_id": 41,
        "track_key": "track-41",
        "track_title": "Loose Track",
        "track_metadata": {"artist": "Raw Track Artist", "artists": ["Credit One", "Credit Two"]},
        "raw_track_album": "",
        "raw_track_album_artist": "Raw Album Artist",
        "artist_id": 7,
        "artist_name": "Catalog Artist",
        "album_id": None,
        "private_path": r"D:\\Music\\Loose Track.flac",
        "relative_path": "Loose Track.flac",
        "root_id": 3,
        "root_path": r"D:\\Music",
        "root_kind": "main",
        "library_root_category": "Loose Singles",
        "file_entry": {
            "artist": "File Credit",
            "album_artist": "File Album Credit",
            "path": r"D:\\Music\\Loose Track.flac",
        },
        "raw_file_artist": "File Credit",
        "raw_file_album_artist": "File Album Credit",
        "exception_override_payload": None,
    }
    connection = FakeConnection([FakeCursor(rows=[raw_row])])

    result = repository_for(connection).load_non_album_candidates()

    assert result == [raw_row]
    assert result[0]["track_metadata"]["artists"] == ["Credit One", "Credit Two"]
    assert result[0]["file_entry"]["album_artist"] == "File Album Credit"
    assert result[0]["private_path"] == r"D:\\Music\\Loose Track.flac"
    assert result[0]["root_path"] == r"D:\\Music"
    assert result[0]["library_root_category"] == "Loose Singles"


@pytest.mark.parametrize(
    ("requested_limit", "expected_limit"),
    [
        (0, 1),
        (-50, 1),
        (25, 25),
        (MAX_NON_ALBUM_CANDIDATE_LIMIT + 500, MAX_NON_ALBUM_CANDIDATE_LIMIT),
    ],
)
def test_candidate_filters_are_batched_deduplicated_bounded_and_parameterized(
    requested_limit,
    expected_limit,
):
    connection = FakeConnection([FakeCursor(rows=[])])

    repository_for(connection).load_non_album_candidates(
        track_ids=[9, "3", 9, ""],
        private_paths=[r"D:\\b.flac", "", r"D:\\a.flac", r"D:\\b.flac"],
        limit=requested_limit,
    )

    assert len(connection.calls) == 1
    sql, params = connection.calls[0]
    assert "override_payload ? 'exception_type'" in sql
    assert "as exception_override_present" in sql
    assert params == {
        "track_ids": [3, 9],
        "track_id_count": 2,
        "private_paths": [r"D:\\a.flac", r"D:\\b.flac"],
        "private_path_count": 2,
        "limit": expected_limit,
    }
    assert "%(track_ids)s::bigint[]" in sql
    assert "%(private_paths)s::text[]" in sql
    assert "limit %(limit)s" in sql.lower()
    assert r"D:\\a.flac" not in sql


def test_candidate_query_includes_only_loose_tracks_or_meaningfully_overridden_album_tracks():
    sql = inventory_module._non_album_candidates_sql().lower()
    normalized_sql = " ".join(sql.split())
    loose_track_path = normalized_sql.split(
        "eligible_track_file_ids as (",
        1,
    )[1].split(" union ", 1)[0]

    assert "library.local_track_files.scan_cache_stale is false" in loose_track_path
    assert "coalesce(library.local_track_files.scan_file_album, '')" in loose_track_path
    assert re.search(
        r"in\s*\(\s*'',\s*'unknown',\s*'unknown artist',\s*"
        r"'unknown album',\s*'none',\s*'null'\s*\)",
        loose_track_path,
    )
    assert " ~ " in loose_track_path
    assert (
        "coalesce( library.local_track_files.scan_file_album, "
        "library.local_tracks.metadata ->> 'album', library.local_albums.title, '' )"
    ) in normalized_sql
    assert "or exception_override.exception_type is not null" in sql
    assert "nullif(btrim(ranked_exception_overrides.override_payload ->> 'exception_type'), '')" in sql
    assert "jsonb_typeof(ranked_exception_overrides.override_payload) = 'string'" in sql
    assert "then nullif(btrim(ranked_exception_overrides.override_payload #>> '{}'), '')" in sql


def test_candidate_query_does_not_treat_a_detached_track_with_a_real_album_as_non_album():
    sql = inventory_module._non_album_candidates_sql().lower()
    normalized_sql = " ".join(sql.split())
    loose_track_path = normalized_sql.split(
        "eligible_track_file_ids as (",
        1,
    )[1].split(" union ", 1)[0]

    # A detached relational album is not itself a non-album signal. The stored
    # scan projection must drive the indexed prefilter, while the effective
    # album predicate keeps the Python shaper's blank/unknown/marker semantics.
    assert "library.local_tracks.album_id is null" not in normalized_sql
    assert "library.local_track_files.scan_file_album" in loose_track_path
    assert "library.local_tracks.metadata ->> 'album'" in normalized_sql
    assert "library.local_albums.title" in normalized_sql
    assert re.search(
        r"in\s*\(\s*'',\s*'unknown',\s*'unknown artist',\s*"
        r"'unknown album',\s*'none',\s*'null'\s*\)",
        normalized_sql,
    )
    assert " ~ " in normalized_sql
    assert "exception_override.exception_type is not null" in normalized_sql


def test_candidate_query_excludes_stale_files_and_files_belonging_to_inactive_roots():
    sql = inventory_module._non_album_candidates_sql().lower()

    assert "library.local_track_files.scan_cache_stale is false" in sql
    assert "metadata #>> '{scan_cache,stale}'" not in sql
    assert "join library.library_roots" in sql
    assert "library.library_roots.is_active is true" in sql
    assert "left join library.library_roots" not in sql


def test_candidate_query_keeps_reused_active_file_cte_key_only_and_rejoins_heavy_file_data():
    sql = inventory_module._non_album_candidates_sql().lower()
    active_file_cte = sql.split("active_track_files as (", 1)[1].split(
        "),\n        exception_candidates as (",
        1,
    )[0]
    active_file_projection = active_file_cte.split("from library.local_track_files", 1)[0]

    assert active_file_projection.split() == [
        "select",
        "library.local_track_files.id,",
        "library.local_track_files.track_id,",
        "library.local_track_files.private_path",
    ]
    assert "library.local_track_files.scan_cache_stale is false" in active_file_cte
    assert "metadata #>> '{scan_cache,stale}'" not in active_file_cte
    assert "library.local_track_files.private_path = any(%(private_paths)s::text[])" in active_file_cte

    assert "join library.local_track_files\n          on library.local_track_files.id = active_track_files.id" in sql
    assert "library.local_track_files.relative_path" in sql
    assert "library.local_track_files.file_size_bytes" in sql
    assert "library.local_track_files.modified_at" in sql
    assert "library.local_track_files.content_signature" in sql
    assert "library.local_track_files.metadata as track_file_metadata" in sql
    assert "library.local_track_files.metadata #> '{scan_cache,file_entry}' as file_entry" in sql
    assert "active_track_files.relative_path" not in sql
    assert "active_track_files.metadata as track_file_metadata" not in sql
    assert "active_track_files.file_entry" not in sql

    assert "partition by exception_candidates.track_file_id" in sql
    assert "exception_candidates.match_priority" in sql
    assert "exception_candidates.updated_at desc" in sql
    assert "exception_candidates.id desc" in sql
    assert "where ranked_exception_overrides.match_rank = 1" in sql
    assert "library.local_tracks.album_id is null" not in sql
    assert "library.local_track_files.scan_file_album" in sql
    assert "library.local_tracks.metadata ->> 'album'" in sql
    assert "library.local_albums.title" in sql
    assert "or exception_override.exception_type is not null" in sql
    assert "active_track_files.private_path," in sql
    assert "active_track_files.id\n        limit %(limit)s" in sql


def test_candidate_query_prefilters_active_files_through_three_indexed_eligibility_paths():
    sql = inventory_module._non_album_candidates_sql().lower()
    assert "eligible_track_file_ids as (" in sql
    eligible_cte = sql.split("eligible_track_file_ids as (", 1)[1].split(
        "),\n        active_track_files as (",
        1,
    )[0]
    eligibility_paths = eligible_cte.split("\n\n          union\n\n")

    assert len(eligibility_paths) == 3
    assert "union all" not in eligible_cte
    assert "override_payload" not in eligible_cte
    assert "exception_type" not in eligible_cte

    loose_track_path, private_path_override_path, track_id_override_path = eligibility_paths
    assert "select library.local_track_files.id as track_file_id" in loose_track_path
    assert "from library.local_tracks" in loose_track_path
    assert "bootstrap_context.library_id = library.local_tracks.library_id" in loose_track_path
    assert "library.local_track_files.track_id = library.local_tracks.id" in loose_track_path
    assert "library.local_track_files.scan_cache_stale is false" in loose_track_path
    assert "library.local_track_files.scan_file_album" in loose_track_path
    assert "library.local_tracks.album_id is null" not in loose_track_path

    assert "select library.local_track_files.id as track_file_id" in private_path_override_path
    assert "from library.exception_overrides" in private_path_override_path
    assert "bootstrap_context.library_id = library.exception_overrides.library_id" in private_path_override_path
    assert "library.local_track_files.private_path = library.exception_overrides.track_key" in private_path_override_path
    assert "library.local_tracks.id = library.local_track_files.track_id" in private_path_override_path
    assert "library.local_tracks.library_id = library.exception_overrides.library_id" in private_path_override_path

    assert "select library.local_track_files.id as track_file_id" in track_id_override_path
    assert "from library.exception_overrides" in track_id_override_path
    assert "bootstrap_context.library_id = library.exception_overrides.library_id" in track_id_override_path
    assert "library.local_tracks.id = library.exception_overrides.track_id" in track_id_override_path
    assert "library.local_tracks.library_id = library.exception_overrides.library_id" in track_id_override_path
    assert "library.local_track_files.track_id = library.local_tracks.id" in track_id_override_path

    active_file_cte = sql.split("active_track_files as (", 1)[1].split(
        "),\n        exception_candidates as (",
        1,
    )[0]
    assert "join eligible_track_file_ids" in active_file_cte
    assert "eligible_track_file_ids.track_file_id = library.local_track_files.id" in active_file_cte
    assert sql.index("eligible_track_file_ids as (") < sql.index("active_track_files as (")
    assert sql.index("active_track_files as (") < sql.index("ranked_exception_overrides as (")

    assert "0 as match_priority" in sql
    assert "1 as match_priority" in sql
    assert "exception_candidates.match_priority" in sql
    assert "where ranked_exception_overrides.match_rank = 1" in sql
    assert "library.local_tracks.album_id is null" not in sql
    assert "library.local_track_files.scan_file_album" in loose_track_path
    assert "or exception_override.exception_type is not null" in sql


def test_candidate_query_selects_private_path_override_before_track_id_then_newest_and_id():
    sql = inventory_module._non_album_candidates_sql().lower()

    assert "exception_candidates as" in sql
    assert "ranked_exception_overrides as" in sql
    assert "active_track_files.private_path = library.exception_overrides.track_key" in sql
    assert "library.local_tracks.id = library.exception_overrides.track_id" in sql
    assert "0 as match_priority" in sql
    assert "1 as match_priority" in sql
    assert "union all" in sql
    assert "partition by exception_candidates.track_file_id" in sql
    precedence = "exception_candidates.match_priority"
    newest = "exception_candidates.updated_at desc"
    deterministic_tiebreaker = "exception_candidates.id desc"
    assert sql.index(precedence) < sql.index(newest) < sql.index(deterministic_tiebreaker)
    assert "where ranked_exception_overrides.match_rank = 1" in sql
    assert "on exception_override.track_file_id = active_track_files.id" in sql


def test_inventory_sql_has_no_musicbrainz_or_lastfm_authority_selectors():
    sql = "\n".join(
        (
            inventory_module._support_state_sql(),
            inventory_module._non_album_candidates_sql(),
        )
    ).lower()

    for forbidden in ("mbid", "musicbrainz", "lastfm", "last.fm", "integration."):
        assert forbidden not in sql


def test_inventory_runtime_selection_requires_url_and_driver_and_builds_repository(monkeypatch):
    class FakePsycopg:
        @staticmethod
        def connect(*_args, **_kwargs):
            raise AssertionError("availability must not connect")

    monkeypatch.setattr(inventory_module, "psycopg", FakePsycopg())
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL,
        "PERSISTENCE_BACKENDS": {"library_inventory": "postgres"},
    }

    assert is_library_inventory_postgres_available(config) is True
    selection = select_runtime_persistence_adapter("library_inventory", config)
    repository = create_runtime_library_inventory_repository(config, connect=lambda _url: None)

    assert selection.requested_backend == "postgres"
    assert selection.effective_backend == "postgres"
    assert isinstance(repository, PostgresLibraryInventoryRepository)


@pytest.mark.parametrize(
    "config",
    [
        None,
        {},
        {"ALBUM_HAVEN_APP_DATABASE_URL": ""},
    ],
)
def test_inventory_runtime_selection_rejects_missing_database_url(config, monkeypatch):
    class FakePsycopg:
        connect = object()

    monkeypatch.setattr(inventory_module, "psycopg", FakePsycopg())

    assert is_library_inventory_postgres_available(config) is False
    if isinstance(config, dict):
        selected_config = dict(config)
        selected_config["PERSISTENCE_BACKENDS"] = {"library_inventory": "postgres"}
        with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
            select_runtime_persistence_adapter("library_inventory", selected_config)


def test_inventory_runtime_selection_rejects_missing_driver(monkeypatch):
    monkeypatch.setattr(inventory_module, "psycopg", None)
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL,
        "PERSISTENCE_BACKENDS": {"library_inventory": "postgres"},
    }

    assert is_library_inventory_postgres_available(config) is False
    with pytest.raises(ValueError, match="Postgres runtime persistence adapter"):
        select_runtime_persistence_adapter("library_inventory", config)


def test_inventory_repository_rejects_missing_database_url_before_connecting():
    repository = PostgresLibraryInventoryRepository(
        {},
        connect=lambda _url: pytest.fail("missing URL must fail before connect"),
    )

    with pytest.raises(RuntimeError, match="ALBUM_HAVEN_APP_DATABASE_URL is required"):
        repository.load_support_state()
