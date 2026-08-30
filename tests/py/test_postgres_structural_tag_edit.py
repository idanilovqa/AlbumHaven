from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

import pytest

from tests.e2e.support import isolatedPostgres

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - skipped without the runtime driver.
    psycopg = None
    dict_row = None


_ISOLATED_RUNTIME_DATABASE_URL = os.environ.get(
    "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL",
    "",
).strip()
_ISOLATED_SETUP_DATABASE_URL = os.environ.get(
    "ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL", ""
).strip()


class FakeCursor:
    def __init__(self, rows=None):
        self._rows = list(rows or [])

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class StructuralTagEditConnection:
    def __init__(self, result_row, *, commit_error: Exception | None = None):
        self.result_row = dict(result_row)
        self.commit_error = commit_error
        self.executed: list[tuple[str, object]] = []
        self.commit_calls = 0
        self.commit_executed_counts: list[int] = []
        self.exit_exc_type = None
        self.exit_executed_count = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.exit_exc_type = exc_type
        self.exit_executed_count = len(self.executed)
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        normalized_sql = _normalized_sql(sql)
        if "bootstrap_context_ready" in normalized_sql:
            return FakeCursor([{"bootstrap_context_ready": 1}])
        if "source_album_track_file_count" in normalized_sql:
            return FakeCursor([self.result_row])
        return FakeCursor()

    def commit(self):
        self.commit_calls += 1
        self.commit_executed_counts.append(len(self.executed))
        if self.commit_error is not None:
            raise self.commit_error


def _normalized_sql(sql: str) -> str:
    return " ".join(sql.casefold().split())


def _entries(album: str = "New Album"):
    paths = [
        "C:/Music/Artist/Old Album/01 First.flac",
        "C:/Music/Artist/Old Album/02 Second.flac",
    ]
    previous = {
        paths[0]: {
            "path": paths[0],
            "mtime": 1720000000.0,
            "size": 1024,
            "album": "Old Album",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": "First",
            "track_number": "1",
            "disc_number": "1",
            "duration_seconds": 180,
            "cover_path": "C:/Music/Artist/Old Album/cover.jpg",
            "cover_revision": "cover-sha-1",
            "play_count": 17,
            "custom_metadata": {"owner_note": "keep me"},
        },
        paths[1]: {
            "path": paths[1],
            "mtime": 1720000001.0,
            "size": 2048,
            "album": "Old Album",
            "album_artist": "Artist",
            "artist": "Artist",
            "title": "Second",
            "track_number": "2",
            "disc_number": "1",
            "duration_seconds": 181,
            "cover_path": "C:/Music/Artist/Old Album/cover.jpg",
            "cover_revision": "cover-sha-1",
            "play_count": 23,
            "custom_metadata": {"owner_note": "also keep me"},
        },
    }
    updated = {
        path: {**entry, "album": album}
        for path, entry in previous.items()
    }
    return paths, previous, updated


def _year_entries(year: int = 2014):
    paths, previous, _updated = _entries(album="Old Album")
    for entry in previous.values():
        entry["year"] = 2004
        entry["release_date"] = "2004-07-16"
    updated = {
        path: {**entry, "year": year, "release_date": str(year)}
        for path, entry in previous.items()
    }
    return paths, previous, updated


def _successful_result(path_count: int = 2):
    return {
        "input_path_count": path_count,
        "resolved_path_count": path_count,
        "source_album_count": 1,
        "source_album_track_file_count": path_count,
        "destination_conflict_count": 0,
        "destination_album_count": 1,
        "album_rows_updated": 1,
        "track_rows_updated": path_count,
        "track_file_rows_updated": path_count,
        "inventory_mutation_revision": 8,
        "destination_album_id": 41,
    }


def _adapter(monkeypatch, connection):
    from music_app.services import scan_cache_persistence

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    return scan_cache_persistence.PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://structural-tag-edit-test"},
        connect=lambda _url: connection,
    )


def _persist_album_rename(
    adapter,
    previous,
    updated,
    *,
    commit_guard=None,
    before_commit=None,
):
    return adapter.persist_structural_tag_edit(
        changed_paths=set(updated),
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"album"},
        commit_guard=commit_guard,
        before_commit=before_commit,
    )


def _persist_track_numbers(adapter, previous, updated):
    return adapter.persist_structural_tag_edit(
        changed_paths=set(updated),
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"track_number"},
    )


def _assert_album_restore_updates_existing_track_identity_in_place(connection):
    executed_sql = [_normalized_sql(sql) for sql, _params in connection.executed]
    assert not any("insert into library.local_tracks" in sql for sql in executed_sql)
    assert not any("insert into library.local_track_files" in sql for sql in executed_sql)

    identity_updates = [
        sql
        for sql in executed_sql
        if "update library.local_tracks" in sql
        and "update library.local_track_files" in sql
        and "destination_album as materialized" in sql
    ]
    assert len(identity_updates) == 1
    restore_sql = identity_updates[0]
    selected_track_files_sql = restore_sql.split(
        "selected_track_files as materialized (", 1
    )[1].split("),", 1)[0]
    assert "library.local_tracks.id as track_id" in selected_track_files_sql
    assert "library.local_track_files.id as track_file_id" in selected_track_files_sql
    assert "library.local_track_files.private_path" in selected_track_files_sql
    assert "scan_cache_stale is false" in selected_track_files_sql

    updated_tracks_sql = restore_sql.split("updated_tracks as (", 1)[1].split(
        "updated_track_files as (", 1
    )[0]
    assert "set album_id =" in updated_tracks_sql
    assert "library.local_tracks.id = selected_track_files.track_id" in updated_tracks_sql
    assert "track_key" not in updated_tracks_sql
    assert "selected_track_files.file_entry -> 'album'" in updated_tracks_sql
    assert "|| selected_track_files.file_entry" not in updated_tracks_sql

    updated_track_files_sql = restore_sql.split(
        "updated_track_files as (", 1
    )[1].split("updated_library as (", 1)[0]
    assert (
        "library.local_track_files.id = selected_track_files.track_file_id"
        in updated_track_files_sql
    )


def test_postgres_album_rename_is_targeted_and_never_round_trips_a_snapshot(monkeypatch):
    paths, previous, updated = _entries()
    unrelated_path = "C:/Music/Other/Untouched/01 Untouched.flac"
    connection = StructuralTagEditConnection(_successful_result())
    adapter = _adapter(monkeypatch, connection)
    monkeypatch.setattr(
        adapter,
        "load_snapshot",
        lambda *_args, **_kwargs: pytest.fail("targeted tag edit loaded the full snapshot"),
    )
    monkeypatch.setattr(
        adapter,
        "save_snapshot",
        lambda *_args, **_kwargs: pytest.fail("targeted tag edit saved the full snapshot"),
    )

    result = _persist_album_rename(adapter, previous, updated)

    assert result == {
        "album_rows_updated": 1,
        "track_rows_updated": 2,
        "track_file_rows_updated": 2,
        "inventory_mutation_revision": 8,
        "destination_album_id": 41,
    }
    mutation_calls = [
        (sql, params)
        for sql, params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    ]
    assert len(mutation_calls) == 1
    mutation_sql, mutation_params = mutation_calls[0]
    normalized_sql = _normalized_sql(mutation_sql)
    assert "unnest(%(changed_paths)s::text[])" in normalized_sql
    assert "library.local_track_files.private_path" in normalized_sql
    assert "update library.local_tracks" in normalized_sql
    assert "update library.local_track_files" in normalized_sql
    assert "update library.libraries" in normalized_sql
    assert "inventory_mutation_revision" in normalized_sql
    assert mutation_params["changed_paths"] == sorted(paths)
    assert unrelated_path not in repr(mutation_params)
    assert all(
        "insert into library.local_tracks" not in _normalized_sql(sql)
        and "insert into library.local_track_files" not in _normalized_sql(sql)
        for sql, _params in connection.executed
    )


def test_postgres_track_number_edit_updates_only_selected_inventory_rows(monkeypatch):
    paths, previous, _updated = _entries(album="Old Album")
    updated = {
        path: {**entry, "track_number": str(index + 14)}
        for index, (path, entry) in enumerate(previous.items())
    }
    connection = StructuralTagEditConnection(_successful_result())
    adapter = _adapter(monkeypatch, connection)
    monkeypatch.setattr(
        adapter,
        "load_snapshot",
        lambda *_args, **_kwargs: pytest.fail("targeted tag edit loaded the full snapshot"),
    )
    monkeypatch.setattr(
        adapter,
        "save_snapshot",
        lambda *_args, **_kwargs: pytest.fail("targeted tag edit saved the full snapshot"),
    )

    result = _persist_track_numbers(adapter, previous, updated)

    assert result["track_rows_updated"] == 2
    assert result["track_file_rows_updated"] == 2
    mutation_sql, mutation_params = next(
        (sql, params)
        for sql, params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    normalized_sql = _normalized_sql(mutation_sql)
    assert "unnest(%(changed_paths)s::text[])" in normalized_sql
    assert "update library.local_tracks" in normalized_sql
    assert "track_number =" in normalized_sql
    assert "update library.local_track_files" in normalized_sql
    assert "inventory_mutation_revision" in normalized_sql
    assert "insert into library.local_tracks" not in normalized_sql
    assert "insert into library.local_track_files" not in normalized_sql
    assert mutation_params["changed_paths"] == sorted(paths)
    assert [row["file_entry"]["track_number"] for row in mutation_params["input_rows"]] == [
        "14",
        "15",
    ]

    validation_connection = StructuralTagEditConnection(_successful_result())
    validation_adapter = _adapter(monkeypatch, validation_connection)
    validation_adapter.validate_structural_tag_edit(
        changed_paths=set(updated),
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"track_number"},
    )


@pytest.mark.parametrize(
    ("result_overrides", "expected_error"),
    [
        (
            {"source_album_count": 2},
            "one source album",
        ),
        (
            {"resolved_path_count": 1},
            "resolve every changed path",
        ),
    ],
)
def test_postgres_album_rename_rejects_partial_mixed_or_unresolved_scope(
    monkeypatch,
    result_overrides,
    expected_error,
):
    _paths, previous, updated = _entries()
    result_row = _successful_result()
    result_row.update(result_overrides)
    connection = StructuralTagEditConnection(result_row)
    adapter = _adapter(monkeypatch, connection)

    with pytest.raises(RuntimeError, match=expected_error):
        _persist_album_rename(adapter, previous, updated)

    assert connection.exit_exc_type is RuntimeError
    assert connection.commit_calls == 0


def test_postgres_album_split_inserts_covered_destination_and_moves_only_selected_path(
    monkeypatch,
):
    paths, previous, updated = _entries()
    selected_path = paths[0]
    result_row = _successful_result(path_count=1)
    result_row["source_album_track_file_count"] = 2
    connection = StructuralTagEditConnection(result_row)
    adapter = _adapter(monkeypatch, connection)

    result = adapter.persist_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"album"},
    )

    assert result["album_rows_updated"] == 1
    assert result["track_rows_updated"] == 1
    assert result["track_file_rows_updated"] == 1
    mutation_sql, mutation_params = next(
        (sql, params)
        for sql, params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    normalized_sql = _normalized_sql(mutation_sql)
    inserted_destination = normalized_sql.split(
        "inserted_destination_album as (", 1
    )[1].split("destination_album as materialized", 1)[0]
    assert "insert into library.local_albums" in normalized_sql
    assert "validated_source_album.cover_path" in normalized_sql
    assert "validated_source_album.metadata" in normalized_sql
    assert "else validated_source_album.release_year" in inserted_destination
    assert "insert into library.local_album_featured_artists" in normalized_sql
    assert "selection_scope.input_path_count <" in normalized_sql
    assert "update library.local_tracks" in normalized_sql
    assert mutation_params["changed_paths"] == [selected_path]

    validation_connection = StructuralTagEditConnection(result_row)
    validation_adapter = _adapter(monkeypatch, validation_connection)
    validation_adapter.validate_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"album"},
    )


def test_postgres_album_split_projects_destination_for_non_album_exception_track(
    monkeypatch,
):
    paths, previous, updated = _entries(album="Problematic Files Rename Probe")
    selected_path = paths[0]
    previous[selected_path]["exception_type"] = "Non-album rarity"
    updated[selected_path]["exception_type"] = "Non-album rarity"
    result_row = _successful_result(path_count=1)
    result_row["source_album_track_file_count"] = 2
    connection = StructuralTagEditConnection(result_row)
    adapter = _adapter(monkeypatch, connection)

    result = adapter.persist_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"album"},
    )

    assert result["album_rows_updated"] == 1
    mutation_params = next(
        params
        for sql, params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    assert mutation_params["destination_album_title"] == "Problematic Files Rename Probe"
    assert mutation_params["changed_paths"] == [selected_path]


def test_postgres_blank_album_edit_keeps_strongly_inferred_track_attached(monkeypatch):
    paths, previous, updated = _entries(album="")
    selected_path = paths[0]
    third_path = "C:/Music/Artist/Old Album/03 Third.flac"
    previous[third_path] = {
        **previous[paths[1]],
        "path": third_path,
        "title": "Third",
        "track_number": "3",
    }
    updated[paths[1]] = dict(previous[paths[1]])
    updated[third_path] = dict(previous[third_path])
    connection = StructuralTagEditConnection(_successful_result(path_count=1))
    connection.result_row["source_album_track_file_count"] = 3
    adapter = _adapter(monkeypatch, connection)

    result = adapter.persist_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"album"},
    )

    mutation_sql, mutation_params = next(
        (sql, params)
        for sql, params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    normalized_sql = _normalized_sql(mutation_sql)
    assert mutation_params["retain_album_membership"] is True
    assert mutation_params["input_rows"][0]["file_entry"]["album"] == ""
    assert "case when %(retain_album_membership)s::boolean then selected_track_files.source_album_id else null end" in normalized_sql
    assert result["retained_album_membership"] is True


def test_postgres_blank_album_selected_track_files_exclude_stale_scan_cache_rows(
    monkeypatch,
):
    paths, previous, updated = _entries(album="")
    selected_path = paths[0]
    connection = StructuralTagEditConnection(_successful_result(path_count=1))
    adapter = _adapter(monkeypatch, connection)

    adapter.persist_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"album"},
    )

    mutation_sql = next(
        _normalized_sql(sql)
        for sql, _params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    selected_track_files_sql = mutation_sql.split(
        "selected_track_files as materialized (", 1
    )[1].split("), selection_scope as materialized", 1)[0]
    assert (
        "join library.local_track_files "
        "on library.local_track_files.private_path = input_rows.private_path "
        "and library.local_track_files.scan_cache_stale is false"
        in selected_track_files_sql
    )


def test_postgres_blank_album_validation_selected_track_files_exclude_stale_scan_cache_rows(
    monkeypatch,
):
    paths, previous, updated = _entries(album="")
    selected_path = paths[0]
    connection = StructuralTagEditConnection(_successful_result(path_count=1))
    adapter = _adapter(monkeypatch, connection)

    adapter.validate_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"album"},
    )

    validation_sql = next(
        _normalized_sql(sql)
        for sql, _params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    selected_track_files_sql = validation_sql.split(
        "selected_track_files as materialized (", 1
    )[1].split("), selection_scope as materialized", 1)[0]
    assert (
        "join library.local_track_files "
        "on library.local_track_files.private_path = input_track_paths.private_path "
        "and library.local_track_files.scan_cache_stale is false"
        in selected_track_files_sql
    )


def test_postgres_blank_album_edit_accepts_an_already_detached_non_album_track(
    monkeypatch,
):
    paths, previous, updated = _entries(album="")
    selected_path = paths[0]
    previous = {selected_path: previous[selected_path]}
    updated = {selected_path: updated[selected_path]}
    result_row = _successful_result(path_count=1)
    result_row.update(
        source_album_count=0,
        source_album_track_file_count=0,
        destination_album_count=0,
        album_rows_updated=0,
        destination_album_id=0,
    )
    connection = StructuralTagEditConnection(result_row)
    adapter = _adapter(monkeypatch, connection)

    adapter.validate_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"album"},
    )
    result = adapter.persist_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"album"},
    )

    blank_album_sql = [
        _normalized_sql(sql)
        for sql, _params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    ]
    assert all(
        "where library.local_tracks.album_id is not null" not in sql
        for sql in blank_album_sql
    )
    assert result["track_rows_updated"] == 1
    assert result["track_file_rows_updated"] == 1
    assert result["retained_album_membership"] is False


def test_postgres_album_restore_accepts_an_already_detached_blank_album_track(
    monkeypatch,
):
    paths, restored, blank = _entries(album="")
    selected_path = paths[0]
    previous = {selected_path: blank[selected_path]}
    updated = {selected_path: restored[selected_path]}
    result_row = _successful_result(path_count=1)
    result_row.update(source_album_count=0, source_album_track_file_count=0)
    connection = StructuralTagEditConnection(result_row)
    adapter = _adapter(monkeypatch, connection)

    adapter.validate_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"album"},
    )
    result = adapter.persist_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"album"},
    )

    assert result["track_rows_updated"] == 1
    assert result["track_file_rows_updated"] == 1
    assert result["destination_album_id"] == 41
    executed_sql = [_normalized_sql(sql) for sql, _params in connection.executed]
    assert any("insert into library.local_albums" in sql for sql in executed_sql)
    _assert_album_restore_updates_existing_track_identity_in_place(connection)


def test_postgres_album_restore_accepts_mixed_inferred_and_detached_blank_tracks(
    monkeypatch,
):
    paths, restored, blank = _entries(album="")
    third_path = "C:/Music/Artist/Old Album/03 Third.flac"
    restored[third_path] = {
        **restored[paths[1]],
        "path": third_path,
        "title": "Third",
        "track_number": "3",
    }
    blank[third_path] = {**restored[third_path], "album": ""}
    for path in paths:
        blank[path]["album_id"] = 41
    blank[third_path]["album_id"] = None
    for index, path in enumerate(blank, start=1):
        durable_track_key = f"durable-restore-track-{index}"
        assert durable_track_key != path
        blank[path]["track_key"] = durable_track_key
        restored[path]["track_key"] = durable_track_key
    result_row = _successful_result(path_count=3)
    result_row.update(source_album_count=1, source_album_track_file_count=2)
    connection = StructuralTagEditConnection(result_row)
    adapter = _adapter(monkeypatch, connection)

    adapter.validate_structural_tag_edit(
        changed_paths=set(blank),
        previous_file_entries=blank,
        updated_file_entries=restored,
        changed_field_names={"album"},
    )
    result = adapter.persist_structural_tag_edit(
        changed_paths=set(blank),
        previous_file_entries=blank,
        updated_file_entries=restored,
        changed_field_names={"album"},
    )

    assert result["track_rows_updated"] == 3
    assert result["track_file_rows_updated"] == 3
    assert result["destination_album_id"] == 41
    _assert_album_restore_updates_existing_track_identity_in_place(connection)


def test_postgres_album_restore_preserves_attached_blank_track_identity(monkeypatch):
    paths, previous, updated = _entries(album="Old Album")
    selected_path = paths[0]
    previous[selected_path]["album"] = ""
    previous[selected_path]["album_id"] = 41
    durable_track_key = "durable-attached-track-key"
    assert durable_track_key != selected_path
    previous[selected_path]["track_key"] = durable_track_key
    updated[selected_path]["track_key"] = durable_track_key
    connection = StructuralTagEditConnection(_successful_result(path_count=1))
    adapter = _adapter(monkeypatch, connection)

    result = adapter.persist_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"album"},
    )

    assert result["track_rows_updated"] == 1
    assert result["track_file_rows_updated"] == 1
    assert result["retained_album_membership"] is False
    executed_sql = [_normalized_sql(sql) for sql, _params in connection.executed]
    assert any("insert into library.local_albums" in sql for sql in executed_sql)
    _assert_album_restore_updates_existing_track_identity_in_place(connection)


class _CommitSuppressingConnection:
    def __init__(self, connection):
        self._connection = connection

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        return False

    def execute(self, sql, params=None):
        return self._connection.cursor(row_factory=dict_row).execute(sql, params)

    def commit(self):
        raise AssertionError("The live restore contract must suppress adapter commits.")


def _isolated_runtime_database_url_or_skip() -> str:
    if psycopg is None or not _ISOLATED_RUNTIME_DATABASE_URL:
        pytest.skip(
            "ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL is required for the live restore contract."
        )
    parsed = urlparse(_ISOLATED_RUNTIME_DATABASE_URL)
    database_name = Path(parsed.path or "").name.casefold()
    username = (parsed.username or "").casefold()
    legacy_identity = database_name == "album_haven_scan_e2e" and username == "album_haven_app"
    suffix = database_name.removeprefix("album_haven_ci_") if database_name.startswith("album_haven_ci_") else ""
    ci_identity = bool(suffix) and username == f"album_haven_app_{suffix}"
    if not legacy_identity and not ci_identity:
        pytest.fail("Live restore contract requires a matching isolated scan or strict CI database/runtime role.")
    return _ISOLATED_RUNTIME_DATABASE_URL


def _live_restore_rows(connection, *, track_ids, track_file_ids):
    tracks = connection.execute(
        """
        select id, track_key, album_id, metadata
        from library.local_tracks
        where id = any(%s)
        order by id
        """,
        (list(track_ids),),
    ).fetchall()
    track_files = connection.execute(
        """
        select id, track_id, private_path, metadata
        from library.local_track_files
        where id = any(%s)
        order by id
        """,
        (list(track_file_ids),),
    ).fetchall()
    return tracks, track_files


def test_live_postgres_blank_album_restore_preserves_mixed_track_identity_and_atomicity():
    database_url = _isolated_runtime_database_url_or_skip()
    if not _ISOLATED_SETUP_DATABASE_URL:
        pytest.skip("ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL is required for isolated setup.")
    isolatedPostgres.prepare_isolated_database(_ISOLATED_SETUP_DATABASE_URL, database_url)
    token = uuid4().hex
    artist_name = f"Codex Restore Artist {token}"
    destination_album = f"Codex Restore Album {token}"
    paths = [
        f"C:/__codex_restore__/{token}/01 Attached.flac",
        f"C:/__codex_restore__/{token}/02 Detached.flac",
    ]
    track_keys = [
        f"codex-restore-attached-{token}",
        f"codex-restore-detached-{token}",
    ]
    previous = {
        path: {
            "path": path,
            "mtime": 1000.0 + index,
            "size": 2000 + index,
            "album": "",
            "album_artist": artist_name,
            "artist": artist_name,
            "title": title,
            "track_number": str(index),
            "disc_number": "1",
            "duration_seconds": 180 + index,
            "track_key": track_keys[index - 1],
        }
        for index, (path, title) in enumerate(
            zip(paths, ("Attached", "Detached"), strict=True),
            start=1,
        )
    }
    updated = {
        path: {
            **entry,
            "album": destination_album,
            "mtime": float(entry["mtime"]) + 100.0,
            "size": int(entry["size"]) + 100,
        }
        for path, entry in previous.items()
    }

    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    connection = psycopg.connect(database_url)
    try:
        library_row = connection.execute(
            """
            select library.libraries.id,
                   coalesce(
                     nullif(
                       library.libraries.metadata ->> 'inventory_mutation_revision',
                       ''
                     )::bigint,
                     0
                   )
            from app.bootstrap_owners
            join library.libraries
              on library.libraries.owner_account_id = app.bootstrap_owners.account_id
             and library.libraries.name = 'Local Library'
             and library.libraries.library_kind = 'local'
            where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
            limit 1
            """
        ).fetchone()
        assert library_row is not None
        library_id, initial_revision = library_row
        artist_id = connection.execute(
            """
            insert into library.local_artists (library_id, artist_key, name, metadata)
            values (%s, %s, %s, '{}'::jsonb)
            returning id
            """,
            (library_id, f"codex-restore-artist-{token}", artist_name),
        ).fetchone()[0]
        source_album_id = connection.execute(
            """
            insert into library.local_albums (
              library_id, artist_id, album_key, title, metadata
            )
            values (%s, %s, %s, %s, '{}'::jsonb)
            returning id
            """,
            (
                library_id,
                artist_id,
                f"codex-restore-source-{token}",
                f"Codex Blank Source {token}",
            ),
        ).fetchone()[0]

        track_ids = []
        track_file_ids = []
        for index, path in enumerate(paths):
            track_id = connection.execute(
                """
                insert into library.local_tracks (
                  library_id, album_id, artist_id, track_key, title, track_number, metadata
                )
                values (%s, %s, %s, %s, %s, %s, %s::jsonb)
                returning id
                """,
                (
                    library_id,
                    source_album_id if index == 0 else None,
                    artist_id,
                    track_keys[index],
                    previous[path]["title"],
                    index + 1,
                    json.dumps({"album": "", "preserved": token}),
                ),
            ).fetchone()[0]
            track_file_id = connection.execute(
                """
                insert into library.local_track_files (
                  track_id, private_path, metadata
                )
                values (
                  %s,
                  %s,
                  jsonb_build_object(
                    'scan_cache',
                    jsonb_build_object(
                      'source', 'scan_cache',
                      'stale', false,
                      'file_entry', %s::jsonb
                    )
                  )
                )
                returning id
                """,
                (track_id, path, json.dumps(previous[path])),
            ).fetchone()[0]
            track_ids.append(track_id)
            track_file_ids.append(track_file_id)

        proxy = _CommitSuppressingConnection(connection)
        adapter = PostgresScanCacheAdapter(
            {"ALBUM_HAVEN_APP_DATABASE_URL": database_url},
            connect=lambda _url: proxy,
        )
        result = adapter.persist_structural_tag_edit(
            changed_paths=set(paths),
            previous_file_entries=previous,
            updated_file_entries=updated,
            changed_field_names={"album"},
            commit_guard=lambda _commit: None,
        )
        destination_album_id = int(result["destination_album_id"])
        assert destination_album_id > 0
        assert result["track_rows_updated"] == 2
        assert result["track_file_rows_updated"] == 2

        tracks, track_files = _live_restore_rows(
            connection,
            track_ids=track_ids,
            track_file_ids=track_file_ids,
        )
        assert [row[0] for row in tracks] == sorted(track_ids)
        assert {row[1] for row in tracks} == set(track_keys)
        assert {row[2] for row in tracks} == {destination_album_id}
        assert all(row[3].get("album") == destination_album for row in tracks)
        assert all("mtime" not in row[3] and "size" not in row[3] for row in tracks)
        assert [row[0] for row in track_files] == sorted(track_file_ids)
        assert {row[1] for row in track_files} == set(track_ids)
        assert {row[2] for row in track_files} == set(paths)
        for row in track_files:
            file_entry = row[3]["scan_cache"]["file_entry"]
            expected = updated[row[2]]
            assert file_entry["album"] == destination_album
            assert float(file_entry["mtime"]) == expected["mtime"]
            assert int(file_entry["size"]) == expected["size"]
        assert connection.execute(
            """
            select count(*)
            from library.local_tracks
            where library_id = %s
              and (track_key = any(%s) or id = any(%s))
            """,
            (library_id, track_keys, track_ids),
        ).fetchone()[0] == 2
        successful_revision = connection.execute(
            """
            select coalesce(
              nullif(metadata ->> 'inventory_mutation_revision', '')::bigint,
              0
            )
            from library.libraries
            where id = %s
            """,
            (library_id,),
        ).fetchone()[0]
        assert successful_revision == initial_revision + 1

        rows_before_failure = _live_restore_rows(
            connection,
            track_ids=track_ids,
            track_file_ids=track_file_ids,
        )
        missing_path = f"C:/__codex_restore__/{token}/03 Missing.flac"
        missing_previous = {
            **previous,
            missing_path: {
                **previous[paths[1]],
                "path": missing_path,
                "title": "Missing",
                "track_key": f"codex-restore-missing-{token}",
            },
        }
        missing_updated = {
            **updated,
            missing_path: {
                **missing_previous[missing_path],
                "album": destination_album,
                "mtime": 1200.0,
                "size": 2300,
            },
        }
        with pytest.raises(RuntimeError, match="complete album inventory"):
            adapter.persist_structural_tag_edit(
                changed_paths=set(missing_updated),
                previous_file_entries=missing_previous,
                updated_file_entries=missing_updated,
                changed_field_names={"album"},
                commit_guard=lambda _commit: None,
            )
        assert _live_restore_rows(
            connection,
            track_ids=track_ids,
            track_file_ids=track_file_ids,
        ) == rows_before_failure
        assert connection.execute(
            """
            select coalesce(
              nullif(metadata ->> 'inventory_mutation_revision', '')::bigint,
              0
            )
            from library.libraries
            where id = %s
            """,
            (library_id,),
        ).fetchone()[0] == successful_revision
    finally:
        connection.rollback()
        connection.close()
        isolatedPostgres.reset_application_tables(_ISOLATED_SETUP_DATABASE_URL)


def test_postgres_album_split_reuses_legacy_key_with_same_release_identity(
    monkeypatch,
):
    paths, previous, updated = _year_entries(year=2000)
    selected_path = paths[0]
    result_row = _successful_result(path_count=1)
    result_row["source_album_track_file_count"] = 2
    connection = StructuralTagEditConnection(result_row)
    adapter = _adapter(monkeypatch, connection)

    adapter.persist_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"year"},
    )

    mutation_sql, mutation_params = next(
        (sql, params)
        for sql, params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    normalized_sql = _normalized_sql(mutation_sql)
    locked_album_scope = normalized_sql.split(
        "locked_album_scope as materialized (", 1
    )[1].split("existing_destination_album as materialized", 1)[0]
    copied_ratings = normalized_sql.split(
        "copied_album_ratings as (", 1
    )[1].split("copied_featured_artists as (", 1)[0]

    assert mutation_params["destination_album_key"].endswith("::year::2000")
    assert mutation_params["destination_release_year"] == 2000
    assert mutation_params["destination_edition"] == ""
    assert mutation_params["updates_release_year"] is True
    assert (
        "library.local_albums.artist_id is not distinct from "
        "source_album_identity.artist_id"
    ) in locked_album_scope
    assert (
        "library.local_albums.release_year is not distinct from "
        "case when %(updates_release_year)s::boolean "
        "then %(destination_release_year)s "
        "else source_album_identity.release_year end"
    ) in locked_album_scope
    assert "library.local_albums.metadata ->> 'edition'" in locked_album_scope
    assert "destination_album.album_key" in copied_ratings


def test_postgres_year_split_uses_year_identity_and_persists_only_selected_file_year(
    monkeypatch,
):
    paths, previous, updated = _year_entries()
    selected_path = paths[0]
    result_row = _successful_result(path_count=1)
    result_row["source_album_track_file_count"] = 2
    connection = StructuralTagEditConnection(result_row)
    adapter = _adapter(monkeypatch, connection)

    result = adapter.persist_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"year"},
    )

    assert result["album_rows_updated"] == 1
    mutation_sql, mutation_params = next(
        (sql, params)
        for sql, params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    normalized_sql = _normalized_sql(mutation_sql)
    assert mutation_params["destination_album_key"].endswith("::year::2014")
    assert mutation_params["destination_album_title"] == "Old Album"
    assert mutation_params["destination_release_year"] == 2014
    assert mutation_params["destination_release_date"] == "2014"
    assert mutation_params["updates_release_year"] is True
    assert mutation_params["input_rows"] == [
        {
            "private_path": selected_path,
            "file_entry": {"release_date": "2014", "year": 2014},
        }
    ]
    inserted_destination = normalized_sql.split(
        "inserted_destination_album as (", 1
    )[1].split("destination_album as materialized", 1)[0]
    renamed_source = normalized_sql.split(
        "renamed_source_album as (", 1
    )[1].split("inserted_destination_album as (", 1)[0]
    assert "%(destination_release_year)s" in inserted_destination
    assert "%(destination_release_date)s" in inserted_destination
    assert "then %(destination_release_year)s" in renamed_source
    assert "%(destination_release_date)s" in renamed_source
    assert (
        "(select input_path_count from selection_scope) = "
        "( select count(*) from source_album_track_files"
    ) in renamed_source


def test_postgres_year_split_prevalidation_uses_year_destination_identity(
    monkeypatch,
):
    paths, previous, updated = _year_entries()
    selected_path = paths[0]
    result_row = _successful_result(path_count=1)
    result_row["source_album_track_file_count"] = 2
    connection = StructuralTagEditConnection(result_row)
    adapter = _adapter(monkeypatch, connection)

    adapter.validate_structural_tag_edit(
        changed_paths={selected_path},
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"year"},
    )

    _validation_sql, validation_params = next(
        (sql, params)
        for sql, params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    assert validation_params["destination_album_key"].endswith("::year::2014")


@pytest.mark.parametrize(
    "changed_field_names",
    [
        {"album", "year"},
        {"album_artist"},
        {"edition"},
    ],
)
def test_postgres_targeted_structural_edit_rejects_broader_field_sets(
    monkeypatch,
    changed_field_names,
):
    _paths, previous, updated = _year_entries()
    connection = StructuralTagEditConnection(_successful_result())
    adapter = _adapter(monkeypatch, connection)

    with pytest.raises(ValueError, match="album-only or year-only"):
        adapter.persist_structural_tag_edit(
            changed_paths=set(updated),
            previous_file_entries=previous,
            updated_file_entries=updated,
            changed_field_names=changed_field_names,
        )


def test_postgres_album_rename_preserves_row_identity_cover_and_unrelated_metadata(monkeypatch):
    _paths, previous, updated = _entries()
    connection = StructuralTagEditConnection(_successful_result())
    adapter = _adapter(monkeypatch, connection)

    _persist_album_rename(adapter, previous, updated)

    mutation_sql = next(
        sql
        for sql, _params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    normalized_sql = _normalized_sql(mutation_sql)
    assert "set album_id =" in normalized_sql
    assert "set album_key =" in normalized_sql
    assert "where library.local_tracks.id =" in normalized_sql
    assert "where library.local_track_files.id =" in normalized_sql
    assert "coalesce(library.local_track_files.metadata" in normalized_sql
    assert "#> '{scan_cache,file_entry}'" in normalized_sql
    assert "cover_path" in normalized_sql
    destination_album_update = normalized_sql.split(
        "renamed_source_album as (", 1
    )[1].split("inserted_destination_album as (", 1)[0]
    assert "cover_path" not in destination_album_update
    assert "cover_revision" not in destination_album_update
    assert "metadata =" not in destination_album_update
    assert "not exists" in normalized_sql
    assert "delete from library.local_tracks" not in normalized_sql
    assert "delete from library.local_track_files" not in normalized_sql
    assert (
        "and (select input_path_count from selection_scope) = "
        "( select count(*) from source_album_track_files )"
        in destination_album_update
    )


def test_postgres_album_only_rename_never_overwrites_current_album_metadata(
    monkeypatch,
):
    _paths, previous, updated = _entries()
    for entry in previous.values():
        entry.update(
            {
                "album_artist": "Prepared Artist",
                "artists": ["Prepared Artist"],
                "edition": "Prepared Edition",
                "root_provenance": {"root": "prepared"},
            }
        )
    for path, entry in previous.items():
        updated[path] = {**entry, "album": "New Album"}
    connection = StructuralTagEditConnection(_successful_result())
    adapter = _adapter(monkeypatch, connection)

    _persist_album_rename(adapter, previous, updated)

    mutation_sql, mutation_params = next(
        (sql, params)
        for sql, params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    normalized_sql = _normalized_sql(mutation_sql)
    destination_album_update = normalized_sql.split(
        "renamed_source_album as (", 1
    )[1].split("inserted_destination_album as (", 1)[0]

    assert "set album_key = case" in destination_album_update
    assert (
        "when %(destination_is_explicit_separate)s::boolean"
        in destination_album_update
    )
    assert "else %(destination_album_key)s" in destination_album_update
    assert "title = %(destination_album_title)s" in destination_album_update
    assert "last_seen_at = now()" in destination_album_update
    assert mutation_params["updates_release_year"] is False
    assert mutation_params["destination_is_explicit_separate"] is False
    assert "else library.local_albums.release_year" in destination_album_update
    assert "cover_path =" not in destination_album_update
    assert "metadata =" not in destination_album_update
    assert "%(destination_album_metadata)s" not in destination_album_update
    assert "destination_album_metadata" not in mutation_params


def test_postgres_album_rename_payload_excludes_cover_state_owned_by_current_rows(
    monkeypatch,
):
    _paths, previous, updated = _entries()
    authoritative_cover_fields = {
        "cover_path",
        "cover_revision",
        "local_cover_width",
        "local_cover_height",
        "remote_cover_url",
        "remote_cover_thumbnail_url",
        "remote_cover_source",
        "remote_cover_source_label",
        "remote_cover_album_url",
        "remote_cover_width",
        "remote_cover_height",
    }
    for entry in previous.values():
        entry["mtime"] = 1.0
        entry["size"] = 100
    for entry in updated.values():
        entry["mtime"] = 2.0
        entry["size"] = 200
        entry["cover_path"] = "C:/Music/Artist/Old Album/stale-prepared-cover.jpg"
        entry["cover_revision"] = "stale-prepared-cover"
        entry["local_cover_width"] = 1200
        entry["local_cover_height"] = 1200
        entry["remote_cover_url"] = "https://stale.example/cover.jpg"
        entry["remote_cover_thumbnail_url"] = "https://stale.example/thumb.jpg"
        entry["remote_cover_source"] = "stale-provider"
        entry["remote_cover_source_label"] = "Stale Provider"
        entry["remote_cover_album_url"] = "https://stale.example/album"
        entry["remote_cover_width"] = 600
        entry["remote_cover_height"] = 600
    connection = StructuralTagEditConnection(_successful_result())
    adapter = _adapter(monkeypatch, connection)

    _persist_album_rename(adapter, previous, updated)

    _sql, mutation_params = next(
        (sql, params)
        for sql, params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    input_file_entries = [
        row["file_entry"]
        for row in mutation_params["input_rows"]
    ]
    assert all(
        authoritative_cover_fields.isdisjoint(file_entry)
        for file_entry in input_file_entries
    )
    assert all(file_entry["mtime"] == 2.0 for file_entry in input_file_entries)
    assert all(file_entry["size"] == 200 for file_entry in input_file_entries)
    assert "destination_album_metadata" not in mutation_params


def test_postgres_album_rename_merges_full_source_into_existing_destination(monkeypatch):
    _paths, previous, updated = _entries()
    connection = StructuralTagEditConnection(_successful_result())
    adapter = _adapter(monkeypatch, connection)

    result = _persist_album_rename(adapter, previous, updated)

    assert result["track_file_rows_updated"] == 2
    mutation_sql = next(
        sql
        for sql, _params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    normalized_sql = _normalized_sql(mutation_sql)

    assert "destination_conflict as materialized" not in normalized_sql
    assert "existing_destination_album as materialized" in normalized_sql
    assert "copied_album_ratings as (" in normalized_sql
    assert "on conflict (account_id, library_id, album_key) do nothing" in normalized_sql
    assert "copied_featured_artists as (" in normalized_sql
    assert "cross join destination_album" in normalized_sql
    assert "updated_album_mbid_assertions as (" in normalized_sql
    assert "vacated_source_album as materialized (" in normalized_sql
    assert "select count(*) from updated_tracks" in normalized_sql
    assert "select count(*) from updated_track_files" in normalized_sql
    assert (
        "or (select input_path_count from selection_scope) < "
        "( select count(*) from source_album_track_files )" in normalized_sql
    )


def test_semantic_album_reconciliation_moves_dependents_and_deletes_redundant_rows():
    from music_app.services.scan_cache_persistence import (
        _reconcile_semantic_local_albums_sql,
    )

    normalized_sql = _normalized_sql(
        " ".join(_reconcile_semantic_local_albums_sql())
    )

    assert "semantic_album_candidates as materialized" in normalized_sql
    assert "min(library.local_albums.id)" in normalized_sql
    assert "canonical_album_id" in normalized_sql
    assert "redundant_album_id" in normalized_sql
    assert "update library.local_tracks" in normalized_sql
    assert "set album_id = semantic_album_candidates.canonical_album_id" in normalized_sql
    assert "insert into library.local_album_featured_artists" in normalized_sql
    assert "on conflict (library_id, album_id, artist_id, featured_kind)" in normalized_sql
    assert "update library.local_mbid_assertions" in normalized_sql
    assert "set album_id = semantic_album_candidates.canonical_album_id" in normalized_sql
    assert "insert into app.album_ratings" in normalized_sql
    assert "semantic_album_candidates.canonical_album_key" in normalized_sql
    assert "on conflict (account_id, library_id, album_key)" in normalized_sql
    assert "update library.local_albums" in normalized_sql
    assert "cover_path" in normalized_sql
    assert "metadata" in normalized_sql
    assert "delete from library.local_albums" in normalized_sql
    assert "library.local_albums.id = semantic_album_candidates.redundant_album_id" in normalized_sql


def test_semantic_album_reconciliation_identity_preserves_release_distinctions():
    from music_app.services.scan_cache_persistence import (
        _reconcile_semantic_local_albums_sql,
    )

    normalized_sql = _normalized_sql(
        " ".join(_reconcile_semantic_local_albums_sql())
    )

    assert "library.local_albums.library_id" in normalized_sql
    assert "library.local_albums.artist_id" in normalized_sql
    assert "lower(btrim(library.local_albums.title))" in normalized_sql
    assert "library.local_albums.release_year" in normalized_sql
    assert "library.local_albums.metadata ->> 'edition'" in normalized_sql
    assert "library.separate_releases" in normalized_sql
    assert "library.separate_releases.release_key" in normalized_sql
    assert "not exists" in normalized_sql
    assert "with bootstrap_context as materialized" in normalized_sql
    assert "app.bootstrap_owners.owner_key = 'local-bootstrap-owner'" in normalized_sql
    assert "join bootstrap_context" in normalized_sql
    assert "library.local_albums.artist_id is not null" in normalized_sql


def test_semantic_album_reconciliation_preserves_one_best_evidence_bundle():
    from music_app.services.scan_cache_persistence import (
        _reconcile_semantic_local_albums_sql,
    )

    normalized_sql = _normalized_sql(
        " ".join(_reconcile_semantic_local_albums_sql())
    )

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
    search_from = normalized_sql.index(ranking_fragments[0])
    for fragment in ranking_fragments:
        position = normalized_sql.index(fragment, search_from)
        ranking_positions.append(position)
        search_from = position + len(fragment)
    assert ranking_positions == sorted(ranking_positions)
    assert (
        "join library.local_albums as best_evidence_album "
        "on best_evidence_album.id = "
        "merged_album_projection.best_evidence_album_id"
    ) in normalized_sql
    for evidence_field in (
        "mbid",
        "mbid_assertion_state",
        "evidence_source",
        "evidence_confidence",
        "mbid_assertion_migration_run_id",
        "mbid_assertion_scan_run_ref",
    ):
        assert (
            f"{evidence_field} = best_evidence_album.{evidence_field}"
            in normalized_sql
        )


def test_semantic_album_reconciliation_prefers_meaningful_metadata_per_key():
    from music_app.services.scan_cache_persistence import (
        _reconcile_semantic_local_albums_sql,
    )

    normalized_sql = _normalized_sql(
        " ".join(_reconcile_semantic_local_albums_sql())
    )

    meaningful_value_fragments = [
        "metadata_entry.value = 'null'::jsonb then false",
        "jsonb_typeof(metadata_entry.value) = 'string'",
        "nullif( btrim(metadata_entry.value #>> '{}'), '' ) is not null",
        "jsonb_typeof(metadata_entry.value) = 'array'",
        "metadata_entry.value <> '[]'::jsonb",
        "jsonb_typeof(metadata_entry.value) = 'object'",
        "metadata_entry.value <> '{}'::jsonb",
    ]
    assert all(fragment in normalized_sql for fragment in meaningful_value_fragments)
    assert (
        "( metadata_candidates.album_id = "
        "metadata_candidates.canonical_album_id and "
        "metadata_value_is_meaningful ) desc"
    ) in normalized_sql
    assert "metadata_value_is_meaningful desc" in normalized_sql


def test_semantic_album_reconciliation_rekeys_version_and_cover_dependencies():
    from music_app.services.scan_cache_persistence import (
        _reconcile_semantic_local_albums_sql,
    )

    normalized_sql = _normalized_sql(
        " ".join(_reconcile_semantic_local_albums_sql())
    )

    assert "insert into library.ignored_versions" in normalized_sql
    assert "on conflict (library_id, version_key) do update" in normalized_sql
    assert "delete from library.ignored_versions" in normalized_sql
    assert (
        "library.ignored_versions.version_key = "
        "semantic_album_candidates.redundant_album_key"
    ) in normalized_sql
    assert "insert into library.manual_versions" in normalized_sql
    assert "child_candidate.canonical_album_key" in normalized_sql
    assert "parent_candidate.canonical_album_key" in normalized_sql
    assert "where mapped_version.child_key <> mapped_version.parent_key" in normalized_sql
    assert "on conflict (library_id, child_key) do update" in normalized_sql
    assert "delete from library.manual_versions" in normalized_sql
    assert (
        "library.manual_versions.child_key = "
        "semantic_album_candidates.redundant_album_key"
    ) in normalized_sql
    assert (
        "library.manual_versions.parent_key = "
        "semantic_album_candidates.redundant_album_key"
    ) in normalized_sql
    assert "update ops.cover_lookup_tasks" in normalized_sql
    assert "set album_key = semantic_album_candidates.canonical_album_key" in normalized_sql


def test_semantic_album_reconciliation_serializes_bootstrap_library_before_candidates(
    monkeypatch,
):
    import inspect

    from music_app.services import scan_cache_persistence

    statements = scan_cache_persistence._reconcile_semantic_local_albums_sql()
    assert isinstance(statements, tuple)
    assert statements
    lock_sql = _normalized_sql(statements[0])
    assert "pg_advisory_xact_lock" in lock_sql
    assert "bootstrap_context.library_id" in lock_sql
    assert "app.bootstrap_owners.owner_key = 'local-bootstrap-owner'" in lock_sql
    candidate_index = next(
        index
        for index, statement in enumerate(statements)
        if "insert into pg_temp.semantic_album_candidates" in _normalized_sql(statement)
    )
    assert candidate_index > 0

    executed: list[str] = []
    monkeypatch.setattr(
        scan_cache_persistence,
        "_reconcile_semantic_local_albums_sql",
        lambda: ("select 'lock'", "select 'reconcile'"),
    )
    scan_cache_persistence._execute_semantic_local_album_reconciliation(
        type(
            "RecordingConnection",
            (),
            {"execute": lambda _self, sql: executed.append(sql)},
        )()
    )
    assert executed == ["select 'lock'", "select 'reconcile'"]
    executor_source = inspect.getsource(
        scan_cache_persistence._execute_semantic_local_album_reconciliation
    )
    assert "isinstance" not in executor_source
    assert "for statement in _reconcile_semantic_local_albums_sql()" in executor_source


def test_semantic_album_reconciliation_can_scope_candidates_to_target_identity():
    from music_app.services.scan_cache_persistence import (
        _reconcile_semantic_local_albums_sql,
    )

    normalized_sql = _normalized_sql(
        " ".join(
            _reconcile_semantic_local_albums_sql(
                target_album_ids=(41,),
            )
        )
    )

    assert "semantic_album_target_identities as materialized" in normalized_sql
    assert "library.local_albums.id = any(%(target_album_ids)s::bigint[])" in normalized_sql
    assert (
        "target_identity.artist_id is not distinct from "
        "library.local_albums.artist_id"
    ) in normalized_sql
    assert (
        "target_identity.normalized_title = "
        "lower(btrim(library.local_albums.title))"
    ) in normalized_sql
    assert (
        "target_identity.release_year is not distinct from "
        "library.local_albums.release_year"
    ) in normalized_sql
    assert (
        "target_identity.normalized_edition = "
        "lower( btrim( coalesce( "
        "library.local_albums.metadata ->> 'edition', '' ) ) )"
    ) in normalized_sql


def test_structural_album_tag_save_runs_reconciliation_before_transaction_exit(monkeypatch):
    from music_app.services import scan_cache_persistence

    _paths, previous, updated = _entries()
    connection = StructuralTagEditConnection(_successful_result())
    adapter = _adapter(monkeypatch, connection)
    reconciliation_calls: list[tuple[int, ...] | None] = []
    reconciliation_sql = (
        "select 'semantic-album-reconciliation-start'",
        "select 'semantic-album-reconciliation-finish'",
    )

    def fake_reconciliation_sql(*, target_album_ids=None):
        reconciliation_calls.append(target_album_ids)
        return reconciliation_sql

    monkeypatch.setattr(
        scan_cache_persistence,
        "_reconcile_semantic_local_albums_sql",
        fake_reconciliation_sql,
    )

    result = _persist_album_rename(adapter, previous, updated)

    executed_sql = [_normalized_sql(sql) for sql, _params in connection.executed]
    mutation_index = next(
        index
        for index, sql in enumerate(executed_sql)
        if "source_album_track_file_count" in sql
    )
    reconciliation_indexes = [
        executed_sql.index(_normalized_sql(statement))
        for statement in reconciliation_sql
    ]
    assert mutation_index < reconciliation_indexes[0]
    assert reconciliation_indexes == sorted(reconciliation_indexes)
    assert reconciliation_calls == [(41,)]
    assert result["destination_album_id"] == 41
    assert connection.commit_calls == 0
    assert connection.exit_exc_type is None
    assert connection.exit_executed_count is not None
    assert reconciliation_indexes[-1] < connection.exit_executed_count


def test_postgres_album_rename_prevalidation_allows_existing_destination(monkeypatch):
    _paths, previous, updated = _entries()
    connection = StructuralTagEditConnection(_successful_result())
    adapter = _adapter(monkeypatch, connection)

    adapter.validate_structural_tag_edit(
        changed_paths=set(updated),
        previous_file_entries=previous,
        updated_file_entries=updated,
        changed_field_names={"album"},
    )

    validation_sql = next(
        sql
        for sql, _params in connection.executed
        if "source_album_track_file_count" in _normalized_sql(sql)
    )
    normalized_sql = _normalized_sql(validation_sql)
    assert "destination_conflict as materialized" not in normalized_sql
    assert "0 as destination_conflict_count" in normalized_sql


def test_postgres_album_rename_returns_only_after_commit_and_propagates_commit_failure(monkeypatch):
    _paths, previous, updated = _entries()
    successful_connection = StructuralTagEditConnection(_successful_result())
    successful_adapter = _adapter(monkeypatch, successful_connection)
    events: list[str] = []

    result = _persist_album_rename(
        successful_adapter,
        previous,
        updated,
        commit_guard=lambda commit: (events.append("before_commit"), commit(), events.append("after_commit")),
    )

    assert result["track_file_rows_updated"] == 2
    assert events == ["before_commit", "after_commit"]
    assert successful_connection.commit_calls == 1

    failed_connection = StructuralTagEditConnection(
        _successful_result(),
        commit_error=RuntimeError("structural tag edit commit failed"),
    )
    failed_adapter = _adapter(monkeypatch, failed_connection)
    with pytest.raises(RuntimeError, match="commit failed"):
        _persist_album_rename(
            failed_adapter,
            previous,
            updated,
            commit_guard=lambda commit: commit(),
        )

    assert failed_connection.commit_calls == 1
    assert failed_connection.exit_exc_type is RuntimeError


def test_structural_tag_edit_runs_intent_completion_on_domain_transaction_before_commit(monkeypatch):
    _paths, previous, updated = _entries()
    connection = StructuralTagEditConnection(_successful_result())
    adapter = _adapter(monkeypatch, connection)
    events: list[object] = []

    result = _persist_album_rename(
        adapter,
        previous,
        updated,
        before_commit=lambda received_connection: events.append(
            ("intent-completed", received_connection)
        ),
        commit_guard=lambda commit: (
            events.append("before-commit"),
            commit(),
            events.append("after-commit"),
        ),
    )

    assert result["track_file_rows_updated"] == 2
    assert events == [
        ("intent-completed", connection),
        "before-commit",
        "after-commit",
    ]
    assert connection.commit_calls == 1


def test_selected_postgres_album_rename_does_not_use_legacy_snapshot_finalizer(monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as routes

    targeted_finalizer = object()
    monkeypatch.setattr(routes, "_is_selected_postgres_library_browse_request", lambda _request: True)
    monkeypatch.setattr(routes, "_has_edit_tags_media_write_fields", lambda _payload: True)
    monkeypatch.setattr(
        routes,
        "_asgi_selected_postgres_structural_tag_edit_queue_finalize_save_task_builder",
        lambda _request: targeted_finalizer,
        raising=False,
    )
    monkeypatch.setattr(
        routes,
        "_asgi_selected_postgres_media_write_queue_finalize_save_task_builder",
        lambda _request: pytest.fail("album rename selected the legacy snapshot finalizer"),
    )

    selected = routes._edit_tags_queue_finalize_save_task_builder(
        object(),
        {
            "updates": {
                "C:/Music/Artist/Old Album/01 First.flac": {"album": "New Album"},
                "C:/Music/Artist/Old Album/02 Second.flac": {"album": "New Album"},
            }
        },
    )

    assert selected is targeted_finalizer


def test_selected_postgres_year_only_edit_uses_targeted_structural_finalizer(
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as routes

    targeted_finalizer = object()
    monkeypatch.setattr(
        routes,
        "_is_selected_postgres_library_browse_request",
        lambda _request: True,
    )
    monkeypatch.setattr(
        routes,
        "_has_edit_tags_media_write_fields",
        lambda _payload: True,
    )
    monkeypatch.setattr(
        routes,
        "_asgi_selected_postgres_structural_tag_edit_queue_finalize_save_task_builder",
        lambda _request: targeted_finalizer,
    )
    monkeypatch.setattr(
        routes,
        "_asgi_selected_postgres_media_write_queue_finalize_save_task_builder",
        lambda _request: pytest.fail("year-only edit selected the snapshot finalizer"),
    )

    selected = routes._edit_tags_queue_finalize_save_task_builder(
        object(),
        {
            "updates": {
                "C:/Music/Artist/Old Album/01 First.flac": {"year": "2014"},
            }
        },
    )

    assert selected is targeted_finalizer


def test_selected_postgres_track_number_edit_uses_targeted_inventory_finalizer(
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as routes

    targeted_finalizer = object()
    monkeypatch.setattr(
        routes,
        "_is_selected_postgres_library_browse_request",
        lambda _request: True,
    )
    monkeypatch.setattr(
        routes,
        "_has_edit_tags_media_write_fields",
        lambda _payload: True,
    )
    monkeypatch.setattr(
        routes,
        "_asgi_selected_postgres_structural_tag_edit_queue_finalize_save_task_builder",
        lambda _request: targeted_finalizer,
    )
    monkeypatch.setattr(
        routes,
        "_asgi_selected_postgres_media_write_queue_finalize_save_task_builder",
        lambda _request: pytest.fail("track-number edit selected the snapshot finalizer"),
    )

    selected = routes._edit_tags_queue_finalize_save_task_builder(
        object(),
        {
            "updates": {
                "C:/Music/Artist/Album/14 Fourteenth.flac": {"track_number": "14"},
                "C:/Music/Artist/Album/15 Fifteenth.flac": {"track_number": "15"},
            }
        },
    )

    assert selected is targeted_finalizer


def test_selected_postgres_mixed_structural_edit_does_not_use_targeted_finalizer(
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as routes

    snapshot_finalizer = object()
    monkeypatch.setattr(
        routes,
        "_is_selected_postgres_library_browse_request",
        lambda _request: True,
    )
    monkeypatch.setattr(
        routes,
        "_has_edit_tags_media_write_fields",
        lambda _payload: True,
    )
    monkeypatch.setattr(
        routes,
        "_asgi_selected_postgres_structural_tag_edit_queue_finalize_save_task_builder",
        lambda _request: pytest.fail("mixed edit selected targeted finalizer"),
    )
    monkeypatch.setattr(
        routes,
        "_asgi_selected_postgres_media_write_queue_finalize_save_task_builder",
        lambda _request: snapshot_finalizer,
    )

    selected = routes._edit_tags_queue_finalize_save_task_builder(
        object(),
        {
            "updates": {
                "C:/Music/Artist/Old Album/01 First.flac": {
                    "album": "New Album",
                    "year": "2014",
                },
            }
        },
    )

    assert selected is snapshot_finalizer


def test_selected_postgres_structural_finalizer_uses_authoritative_album_finder(monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as routes

    request = object()
    authoritative_finder = object()
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        routes,
        "_postgres_album_finder_for_track_paths",
        lambda received_request: (
            authoritative_finder
            if received_request is request
            else pytest.fail("structural finalizer used the wrong request")
        ),
    )
    monkeypatch.setattr(
        routes,
        "queue_finalize_structural_tag_edit_save_task",
        lambda **kwargs: captured.update(kwargs),
    )

    queue_finalize = routes._asgi_selected_postgres_structural_tag_edit_queue_finalize_save_task_builder(
        request
    )
    queue_finalize(config={})

    assert captured["find_albums_by_track_paths"] is authoritative_finder


def test_selected_postgres_year_compensation_restores_exact_release_date(monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as routes

    track_path = "C:/Music/Artist/Old Album/01 First.flac"
    applied_repairs: list[tuple[str, dict[str, str]]] = []
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        routes,
        "_apply_repairs_worker",
        lambda path, repairs: applied_repairs.append((path, dict(repairs))),
    )
    monkeypatch.setattr(
        routes,
        "queue_finalize_structural_tag_edit_save_task",
        lambda **kwargs: captured.update(kwargs),
    )

    queue_finalize = (
        routes._asgi_selected_postgres_structural_tag_edit_queue_finalize_save_task_builder(
            object()
        )
    )
    queue_finalize(config={})
    captured["compensate_structural_tag_edit"](
        changed_paths={track_path},
        previous_file_entries={
            track_path: {
                "year": 2004,
                "release_date": "2004-07-16",
            }
        },
        changed_field_names={"year"},
    )

    assert applied_repairs == [(track_path, {"year": "2004-07-16"})]


def test_selected_postgres_compensation_restores_only_fields_changed_per_path(
    monkeypatch,
):
    from music_app.routes import api_wave_a_asgi_routes as routes

    first_path = "C:/Music/Artist/Album/01 First.flac"
    second_path = "C:/Music/Artist/Album/02 Second.flac"
    applied_repairs: list[tuple[str, dict[str, str]]] = []
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        routes,
        "_apply_repairs_worker",
        lambda path, repairs: applied_repairs.append((path, dict(repairs))),
    )
    monkeypatch.setattr(
        routes,
        "queue_finalize_structural_tag_edit_save_task",
        lambda **kwargs: captured.update(kwargs),
    )

    queue_finalize = (
        routes._asgi_selected_postgres_structural_tag_edit_queue_finalize_save_task_builder(
            object()
        )
    )
    queue_finalize(config={})
    captured["compensate_structural_tag_edit"](
        changed_paths={first_path, second_path},
        previous_file_entries={
            first_path: {"album": "Old", "title": "First"},
            second_path: {"album": "Old", "title": "Second"},
        },
        updated_file_entries={
            first_path: {"album": "New", "title": "First"},
            second_path: {"album": "Old", "title": "Renamed"},
        },
        changed_field_names={"album", "title"},
    )

    assert applied_repairs == [
        (first_path, {"album": "Old"}),
        (second_path, {"title": "Second"}),
    ]


def test_full_snapshot_prepared_before_targeted_rename_is_rejected_by_inventory_revision(monkeypatch):
    from music_app.services import scan_cache_persistence

    class RevisionConnection(StructuralTagEditConnection):
        def execute(self, sql, params=None):
            normalized_sql = _normalized_sql(sql)
            if "inventory_mutation_revision" in normalized_sql and "select" in normalized_sql:
                self.executed.append((sql, params))
                return FakeCursor([{"inventory_mutation_revision": 1}])
            return super().execute(sql, params)

    connection = RevisionConnection(_successful_result())
    adapter = _adapter(monkeypatch, connection)
    received_separate_release_keys: list[set[str] | None] = []
    monkeypatch.setattr(
        adapter,
        "_build_albums",
        lambda _cache, selected: received_separate_release_keys.append(selected) or [],
    )
    monkeypatch.setattr(
        scan_cache_persistence,
        "_inventory_rows_from_albums",
        lambda _cache, _albums: ([], [], [], [], []),
    )

    with pytest.raises(
        scan_cache_persistence.ScanCachePublicationSuperseded,
        match="inventory.*changed|structural.*edit",
    ):
        adapter.save_snapshot(
            Path("unused.json"),
            {},
            "root-identity",
            1.0,
            expected_inventory_mutation_revision=0,
            separate_release_keys={"artist::album"},
        )

    assert received_separate_release_keys == [{"artist::album"}]
    assert all(
        "insert into library.local_albums" not in _normalized_sql(sql)
        and "insert into library.local_tracks" not in _normalized_sql(sql)
        and "insert into library.local_track_files" not in _normalized_sql(sql)
        for sql, _params in connection.executed
    )
