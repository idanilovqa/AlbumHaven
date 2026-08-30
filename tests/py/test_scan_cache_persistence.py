from __future__ import annotations

from pathlib import Path
import re
import threading
from types import SimpleNamespace

import pytest
from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION


class FakeCursor:
    def __init__(self, rows=None):
        self._rows = list(rows or [])

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


def test_load_separate_release_keys_accepts_dict_rows():
    from music_app.services.scan_cache_persistence import _load_separate_release_keys

    connection = SimpleNamespace(
        execute=lambda _sql: FakeCursor([
            {"release_key": " artist::album "},
            {"release_key": ""},
        ])
    )

    assert _load_separate_release_keys(connection) == {"artist::album"}


class FakeConnection:
    def __init__(self, *, snapshot_rows=None, file_rows=None, bootstrap_ready=True):
        self.executed = []
        self._snapshot_rows = list(snapshot_rows or [])
        self._file_rows = list(file_rows or [])
        self._bootstrap_ready = bootstrap_ready
        self.exit_exc_type = None
        self.commit_calls = 0
        self.pipeline_entries = 0
        self.pipeline_exits = 0
        self.pipeline_active = False
        self.pipeline_execute_counts = []
        self.execute_pipeline_states = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.exit_exc_type = exc_type
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        self.execute_pipeline_states.append(self.pipeline_active)
        if self.pipeline_active:
            self.pipeline_execute_counts[-1] += 1
        if "bootstrap_context_ready" in sql:
            return FakeCursor([{"bootstrap_context_ready": 1}] if self._bootstrap_ready else [])
        if "metadata -> 'scan_cache'" in sql:
            return FakeCursor(self._snapshot_rows)
        if "local_track_files.metadata #> '{scan_cache,file_entry}'" in sql:
            return FakeCursor(self._file_rows)
        return FakeCursor()

    def commit(self):
        self.commit_calls += 1

    def pipeline(self):
        connection = self

        class FakePipeline:
            def __enter__(self):
                connection.pipeline_entries += 1
                connection.pipeline_active = True
                connection.pipeline_execute_counts.append(0)
                return self

            def __exit__(self, exc_type, exc, traceback):
                connection.pipeline_active = False
                connection.pipeline_exits += 1
                return False

        return FakePipeline()


def _normalized_sql(sql):
    return " ".join(sql.casefold().split())


def test_scan_album_upsert_preserves_structural_release_year_authority():
    from music_app.services import scan_cache_persistence

    normalized_sql = _normalized_sql(
        scan_cache_persistence._upsert_local_album_sql()
    )

    assert (
        "release_year = case "
        "when nullif(library.local_albums.metadata ->> 'release_date', '') is not null "
        "then library.local_albums.release_year "
        "else excluded.release_year end"
    ) in normalized_sql


def test_postgres_cover_selection_updates_only_targeted_inventory_rows_transactionally(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    class CoverSelectionConnection(FakeConnection):
        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            if "updated_albums" in _normalized_sql(sql):
                return FakeCursor(
                    [
                        {
                            "input_path_count": 2,
                            "resolved_path_count": 2,
                            "selected_album_count": 1,
                            "album_track_file_count": 2,
                            "album_rows_updated": 1,
                            "track_file_rows_updated": 2,
                        }
                    ]
                )
            return cursor

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = CoverSelectionConnection()
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://example"},
        connect=lambda _url: connection,
    )
    track_paths = {
        "C:/Generated Test Music/Kaipa/Kaipa/disc-1.mp3",
        "C:/Generated Test Music/Kaipa/Kaipa/disc-2.mp3",
    }
    selected_cover_path = Path("C:/Generated Test Music/Kaipa/Kaipa/cover.jpg")

    result = adapter.persist_cover_selection(
        track_paths=track_paths,
        selected_cover_path=selected_cover_path,
        cover_revision="cover-revision-123",
    )

    assert result == {"album_rows_updated": 1, "track_file_rows_updated": 2}
    mutation_calls = [
        (sql, params)
        for sql, params in connection.executed
        if "updated_albums" in _normalized_sql(sql)
    ]
    assert len(mutation_calls) == 1
    mutation_sql, mutation_params = mutation_calls[0]
    normalized_sql = _normalized_sql(mutation_sql)
    assert "update library.local_albums" in normalized_sql
    assert "update library.local_track_files" in normalized_sql
    assert "library.local_tracks" in normalized_sql
    assert "bootstrap_context.library_id" in normalized_sql
    for stale_remote_field in (
        "remote_cover_url",
        "remote_cover_thumbnail_url",
        "remote_cover_source",
        "remote_cover_source_label",
        "remote_cover_album_url",
        "remote_cover_width",
        "remote_cover_height",
    ):
        assert normalized_sql.count(stale_remote_field) >= 2
    assert normalized_sql.count("- array[") >= 2
    assert normalized_sql.count("%(selected_cover_path)s::text") >= 2
    assert normalized_sql.count("%(cover_revision)s::text") >= 2
    assert mutation_params == {
        "track_paths": sorted(track_paths),
        "selected_cover_path": str(selected_cover_path),
        "cover_revision": "cover-revision-123",
    }
    assert connection.exit_exc_type is None
    assert all("insert into library." not in _normalized_sql(sql) for sql, _params in connection.executed)


@pytest.mark.parametrize("cover_selection_origin", ["user", "automatic"])
def test_postgres_cover_selection_persists_normalized_album_origin_and_guards_automatic_writes(
    monkeypatch,
    cover_selection_origin,
):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    class OriginConnection(FakeConnection):
        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            if "updated_albums" in _normalized_sql(sql):
                return FakeCursor([{
                    "input_path_count": 1,
                    "resolved_path_count": 1,
                    "selected_album_count": 1,
                    "album_track_file_count": 1,
                    "album_rows_updated": 1,
                    "track_file_rows_updated": 1,
                    "blocked_by_user_selection": False,
                }])
            return cursor

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = OriginConnection()
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://ownership-test"},
        connect=lambda _url: connection,
    )

    adapter.persist_cover_selection(
        track_paths={"C:/Music/Artist/Album/song.mp3"},
        selected_cover_path=Path("C:/Music/Artist/Album/cover.jpg"),
        cover_revision="revision-1",
        cover_selection_origin=cover_selection_origin,
        reject_if_user_controlled=cover_selection_origin == "automatic",
    )

    sql, params = next(
        (sql, params)
        for sql, params in connection.executed
        if "updated_albums" in _normalized_sql(sql)
    )
    normalized_sql = _normalized_sql(sql)
    assert params["cover_selection_origin"] == cover_selection_origin
    assert "cover_selection_origin" in normalized_sql
    assert "library.local_albums.metadata" in normalized_sql
    assert "library.local_track_files.metadata" in normalized_sql
    track_file_update_sql = normalized_sql.split("updated_track_files as (", 1)[1]
    assert "cover_selection_origin" not in track_file_update_sql
    if cover_selection_origin == "automatic":
        assert "reject_if_user_controlled" in params
        assert "metadata ->> 'cover_selection_origin'" in normalized_sql
        assert "<> 'user'" in normalized_sql


def test_postgres_cover_selection_explicit_clear_removes_album_and_track_authority(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    class ClearSelectionConnection(FakeConnection):
        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            if "updated_albums" in _normalized_sql(sql):
                return FakeCursor([{
                    "input_path_count": 1,
                    "resolved_path_count": 1,
                    "selected_album_count": 1,
                    "album_track_file_count": 2,
                    "album_rows_updated": 1,
                    "track_file_rows_updated": 2,
                }])
            return cursor

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = ClearSelectionConnection()
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://clear-cover-test"},
        connect=lambda _url: connection,
    )

    result = adapter.persist_cover_selection(
        track_paths={"C:/Music/Artist/Album/song.mp3"},
        selected_cover_path=None,
        clear_selection=True,
    )

    assert result == {"album_rows_updated": 1, "track_file_rows_updated": 2}
    sql, params = next(
        (sql, params)
        for sql, params in connection.executed
        if "updated_albums" in _normalized_sql(sql)
    )
    normalized_sql = _normalized_sql(sql)
    album_update_sql, track_file_update_sql = normalized_sql.split(
        "updated_track_files as (", 1
    )
    assert "cover_path = %(selected_cover_path)s" in album_update_sql
    assert params["selected_cover_path"] is None
    assert params["cover_revision"] is None
    for cleared_field in (
        "cover_path",
        "cover_revision",
        "cover_selection_origin",
        "remote_cover_url",
        "remote_cover_thumbnail_url",
        "remote_cover_source",
        "remote_cover_source_label",
        "remote_cover_album_url",
        "remote_cover_width",
        "remote_cover_height",
    ):
        assert cleared_field in album_update_sql
    for cleared_track_field in (
        "cover_path",
        "cover_revision",
        "remote_cover_url",
        "remote_cover_thumbnail_url",
        "remote_cover_source",
        "remote_cover_source_label",
        "remote_cover_album_url",
        "remote_cover_width",
        "remote_cover_height",
    ):
        assert cleared_track_field in track_file_update_sql
    assert "cover_selection_origin" not in track_file_update_sql


def test_scan_album_upsert_preserves_existing_cover_selection_origin():
    from music_app.services import scan_cache_persistence

    sql = _normalized_sql(scan_cache_persistence._upsert_local_album_sql())

    assert "metadata = library.local_albums.metadata || excluded.metadata" in sql
    assert "cover_selection_origin" not in sql


def test_automatic_cover_persistence_reports_concurrent_user_selection_without_writing(
    monkeypatch,
):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    class ConcurrentUserConnection(FakeConnection):
        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            if "updated_albums" in _normalized_sql(sql):
                return FakeCursor([{
                    "input_path_count": 1,
                    "resolved_path_count": 1,
                    "selected_album_count": 1,
                    "album_track_file_count": 1,
                    "album_rows_updated": 0,
                    "track_file_rows_updated": 0,
                    "blocked_by_user_selection": True,
                }])
            return cursor

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = ConcurrentUserConnection()
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://concurrent-user"},
        connect=lambda _url: connection,
    )

    result = adapter.persist_cover_selection(
        track_paths={"C:/Music/Artist/Album/song.mp3"},
        selected_cover_path=Path("C:/Music/Artist/Album/cover.jpg"),
        cover_revision="automatic-revision",
        cover_selection_origin="automatic",
        reject_if_user_controlled=True,
    )

    assert result == {
        "album_rows_updated": 0,
        "track_file_rows_updated": 0,
        "blocked_by_user_selection": True,
    }
    normalized_calls = [_normalized_sql(sql) for sql, _params in connection.executed]
    assert not any(
        "cover_mutation_revision" in sql and "update library.libraries" in sql
        for sql in normalized_calls
    )
    assert [
        "publication-lock"
        if "pg_advisory_xact_lock" in sql
        else "bootstrap-context"
        if "bootstrap_context_ready" in sql
        else "guarded-cover-selection"
        if "updated_albums" in sql
        else "unexpected-write"
        for sql in normalized_calls
    ] == [
        "publication-lock",
        "bootstrap-context",
        "guarded-cover-selection",
    ]


def test_same_art_upgrade_requires_expected_user_origin_and_cover_revision(
    monkeypatch,
):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    class ExpectedStateConnection(FakeConnection):
        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            if "updated_albums" in _normalized_sql(sql):
                return FakeCursor([{
                    "input_path_count": 1,
                    "resolved_path_count": 1,
                    "selected_album_count": 1,
                    "album_track_file_count": 1,
                    "album_rows_updated": 1,
                    "track_file_rows_updated": 1,
                    "blocked_by_user_selection": False,
                    "blocked_by_expected_cover_state": False,
                }])
            return cursor

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = ExpectedStateConnection()
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://same-art-upgrade"},
        connect=lambda _url: connection,
    )

    adapter.persist_cover_selection(
        track_paths={"C:/Music/Artist/Album/song.mp3"},
        selected_cover_path=Path("C:/Music/Artist/Album/cover.jpg"),
        cover_revision="new-revision",
        cover_selection_origin="user",
        expected_cover_selection_origin="user",
        expected_cover_revision="old-revision",
    )

    sql, params = next(
        (sql, params)
        for sql, params in connection.executed
        if "updated_albums" in _normalized_sql(sql)
    )
    normalized_sql = _normalized_sql(sql)
    assert params["expected_cover_selection_origin"] == "user"
    assert params["expected_cover_revision"] == "old-revision"
    assert "metadata ->> 'cover_selection_origin'" in normalized_sql
    assert "metadata ->> 'cover_revision'" in normalized_sql
    assert "blocked_by_expected_cover_state" in normalized_sql


def test_postgres_cover_selection_invokes_commit_guard_after_mutation_before_exit(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    events: list[str] = []

    class GuardedCommitConnection(FakeConnection):
        def execute(self, sql, params=None):
            normalized_sql = _normalized_sql(sql)
            if "local-inventory-publication" in normalized_sql:
                events.append("publication-lock")
            if "cover_mutation_revision" in normalized_sql and "update library.libraries" in normalized_sql:
                events.append("revision-increment")
            cursor = super().execute(sql, params)
            if "updated_albums" in normalized_sql:
                events.append("cover-mutation")
                return FakeCursor(
                    [{
                        "input_path_count": 1,
                        "resolved_path_count": 1,
                        "selected_album_count": 1,
                        "album_track_file_count": 1,
                        "album_rows_updated": 1,
                        "track_file_rows_updated": 1,
                    }]
                )
            return cursor

        def commit(self):
            events.append("database-commit")
            super().commit()

        def __exit__(self, exc_type, exc, traceback):
            events.append("transaction-exit")
            return super().__exit__(exc_type, exc, traceback)

    connection = GuardedCommitConnection()
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://pytest_guarded_cover_commit"},
        connect=lambda _url: connection,
    )
    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)

    def commit_guard(commit_action):
        events.append("guard-enter")
        result = commit_action()
        events.append("guard-exit")
        return result

    result = adapter.persist_cover_selection(
        track_paths={"C:/Generated/Artist/Album/song.mp3"},
        selected_cover_path=Path("C:/Generated/Artist/Album/cover.jpg"),
        cover_revision="selected-revision",
        commit_guard=commit_guard,
    )

    assert result == {"album_rows_updated": 1, "track_file_rows_updated": 1}
    assert connection.commit_calls == 1
    assert events == [
        "publication-lock",
        "revision-increment",
        "cover-mutation",
        "guard-enter",
        "database-commit",
        "guard-exit",
        "transaction-exit",
    ]


def test_postgres_cover_selection_accepts_full_album_update_from_partial_track_match(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    class FullAlbumUpdateConnection(FakeConnection):
        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            if "updated_albums" in _normalized_sql(sql):
                return FakeCursor(
                    [{
                        "input_path_count": 1,
                        "resolved_path_count": 1,
                        "selected_album_count": 1,
                        "album_track_file_count": 2,
                        "album_rows_updated": 1,
                        "track_file_rows_updated": 2,
                    }]
                )
            return cursor

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://pytest_partial_album_cover"},
        connect=lambda _url: FullAlbumUpdateConnection(),
    )

    result = adapter.persist_cover_selection(
        track_paths={"C:/Generated/Artist/Album/disc-1.mp3"},
        selected_cover_path=Path("C:/Generated/Artist/Album/cover.jpg"),
        cover_revision="selected-revision",
    )

    assert result == {"album_rows_updated": 1, "track_file_rows_updated": 2}


@pytest.mark.parametrize(
    ("album_rows_updated", "track_file_rows_updated"),
    [(0, 0), (1, 1), (2, 2)],
)
def test_postgres_cover_selection_count_mismatch_raises_inside_transaction_context(
    monkeypatch,
    album_rows_updated,
    track_file_rows_updated,
):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    class MismatchConnection(FakeConnection):
        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            if "updated_albums" in _normalized_sql(sql):
                return FakeCursor(
                    [{
                        "input_path_count": 2,
                        "resolved_path_count": 2,
                        "selected_album_count": 1,
                        "album_track_file_count": 2,
                        "album_rows_updated": album_rows_updated,
                        "track_file_rows_updated": track_file_rows_updated,
                    }]
                )
            return cursor

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = MismatchConnection()
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://example"},
        connect=lambda _url: connection,
    )

    with pytest.raises(
        RuntimeError,
        match="complete selected album inventory",
    ):
        adapter.persist_cover_selection(
            track_paths={"C:/Generated/Album/one.mp3", "C:/Generated/Album/two.mp3"},
            selected_cover_path=Path("C:/Generated/Album/cover.jpg"),
            cover_revision="revision-123",
        )

    assert connection.exit_exc_type is RuntimeError


def test_cover_selection_success_cannot_be_overwritten_by_an_already_started_scan_publication(
    monkeypatch,
):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    stale_cover_path = "C:/Generated/Kaipa/Kaipa/Art/Back.jpg"
    selected_cover_path = Path("C:/Generated/Kaipa/Kaipa/cover.jpg")
    track_path = "C:/Generated/Kaipa/Kaipa/01 Musiken ar ljuset.mp3"
    store = {
        "album_cover_path": stale_cover_path,
        "track_file_cover_path": stale_cover_path,
    }
    store_lock = threading.Lock()
    advisory_locks: dict[str, threading.Lock] = {}
    scan_ready_to_commit = threading.Event()
    release_scan = threading.Event()
    selection_finished = threading.Event()

    class TransactionalConnection(FakeConnection):
        def __init__(self, role):
            super().__init__()
            self.role = role
            self.pending_album_cover_path = None
            self.pending_track_file_cover_path = None
            self.held_advisory_locks: list[threading.Lock] = []

        def __exit__(self, exc_type, exc, traceback):
            try:
                if exc_type is None:
                    with store_lock:
                        if self.pending_album_cover_path is not None:
                            store["album_cover_path"] = self.pending_album_cover_path
                        if self.pending_track_file_cover_path is not None:
                            store["track_file_cover_path"] = self.pending_track_file_cover_path
                return super().__exit__(exc_type, exc, traceback)
            finally:
                for advisory_lock in reversed(self.held_advisory_locks):
                    advisory_lock.release()

        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            normalized_sql = _normalized_sql(sql)
            if "pg_advisory_xact_lock" in normalized_sql:
                lock_match = re.search(r"'(album-haven:[^']+)'", sql)
                lock_key = lock_match.group(1) if lock_match else normalized_sql
                advisory_lock = advisory_locks.setdefault(lock_key, threading.Lock())
                advisory_lock.acquire()
                self.held_advisory_locks.append(advisory_lock)
                return FakeCursor([{"pg_advisory_xact_lock": None}])
            if "insert into library.local_albums" in normalized_sql:
                self.pending_album_cover_path = params["cover_path"]
            if "insert into library.local_track_files" in normalized_sql:
                file_entry = params["rows"][0]["metadata"]["scan_cache"]["file_entry"]
                self.pending_track_file_cover_path = file_entry["cover_path"]
                if self.role == "scan":
                    scan_ready_to_commit.set()
                    if not release_scan.wait(timeout=2):
                        raise RuntimeError("Timed out waiting to release the stale scan publication.")
            if "updated_albums" in normalized_sql:
                self.pending_album_cover_path = params["selected_cover_path"]
                self.pending_track_file_cover_path = params["selected_cover_path"]
                return FakeCursor(
                    [{
                        "input_path_count": 1,
                        "resolved_path_count": 1,
                        "selected_album_count": 1,
                        "album_track_file_count": 1,
                        "album_rows_updated": 1,
                        "track_file_rows_updated": 1,
                    }]
                )
            return cursor

    def connect(_database_url):
        role = "scan" if threading.current_thread().name == "stale-cover-scan" else "selection"
        return TransactionalConnection(role)

    stale_inventory_rows = (
        [],
        [{"cover_path": stale_cover_path}],
        [],
        [],
        [
            {
                "private_path": track_path,
                "metadata": {
                    "scan_cache": {
                        "file_entry": {
                            "path": track_path,
                            "cover_path": stale_cover_path,
                        }
                    }
                },
            }
        ],
    )
    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    monkeypatch.setattr(
        scan_cache_persistence,
        "_inventory_rows_from_albums",
        lambda _file_cache, _albums: stale_inventory_rows,
    )
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://pytest_cover_race"},
        connect=connect,
        build_albums=lambda _file_cache, _selected_artists: [],
    )
    errors: list[BaseException] = []
    selection_result: dict[str, int] = {}

    def publish_stale_scan():
        try:
            adapter.save_snapshot(
                Path("unused.json"),
                {},
                "generated-root",
                10.0,
            )
        except BaseException as exc:  # pragma: no cover - asserted below for thread handoff.
            errors.append(exc)

    def select_cover():
        try:
            selection_result.update(
                adapter.persist_cover_selection(
                    track_paths={track_path},
                    selected_cover_path=selected_cover_path,
                    cover_revision="selected-cover-revision",
                )
            )
        except BaseException as exc:  # pragma: no cover - asserted below for thread handoff.
            errors.append(exc)
        finally:
            selection_finished.set()

    scan_thread = threading.Thread(target=publish_stale_scan, name="stale-cover-scan")
    selection_thread = threading.Thread(target=select_cover, name="local-cover-selection")
    scan_thread.start()
    try:
        assert scan_ready_to_commit.wait(timeout=2)
        selection_thread.start()
        selection_returned_before_scan_commit = selection_finished.wait(timeout=0.2)
    finally:
        release_scan.set()
    scan_thread.join(timeout=2)
    selection_thread.join(timeout=2)

    assert not scan_thread.is_alive()
    assert not selection_thread.is_alive()
    assert errors == []
    assert selection_result == {
        "album_rows_updated": 1,
        "track_file_rows_updated": 1,
    }
    assert store == {
        "album_cover_path": str(selected_cover_path),
        "track_file_cover_path": str(selected_cover_path),
    }, (
        "Local-select reported success before the stale scan committed. "
        f"selection_returned_before_scan_commit={selection_returned_before_scan_commit}"
    )


def test_scan_rows_built_before_cover_selection_are_rejected_after_selection_commits(
    monkeypatch,
):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    stale_cover_path = "C:/Generated/Kaipa/Kaipa/Art/Back.jpg"
    selected_cover_path = Path("C:/Generated/Kaipa/Kaipa/cover.jpg")
    track_path = "C:/Generated/Kaipa/Kaipa/01 Musiken ar ljuset.mp3"
    store = {
        "album_cover_path": stale_cover_path,
        "track_file_cover_path": stale_cover_path,
        "cover_mutation_revision": 0,
    }
    store_lock = threading.Lock()
    advisory_locks: dict[str, threading.Lock] = {}
    stale_rows_built = threading.Event()
    allow_scan_transaction = threading.Event()
    scan_connections = []
    scan_errors: list[BaseException] = []

    class RevisionAwareTransaction(FakeConnection):
        def __init__(self, role):
            super().__init__()
            self.role = role
            self.pending_album_cover_path = None
            self.pending_track_file_cover_path = None
            self.held_advisory_locks: list[threading.Lock] = []
            self.rolled_back = False

        def __exit__(self, exc_type, exc, traceback):
            self.rolled_back = exc_type is not None
            try:
                if exc_type is None:
                    with store_lock:
                        if self.pending_album_cover_path is not None:
                            store["album_cover_path"] = self.pending_album_cover_path
                        if self.pending_track_file_cover_path is not None:
                            store["track_file_cover_path"] = self.pending_track_file_cover_path
                        if self.role == "selection":
                            store["cover_mutation_revision"] += 1
                return super().__exit__(exc_type, exc, traceback)
            finally:
                for advisory_lock in reversed(self.held_advisory_locks):
                    advisory_lock.release()

        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            normalized_sql = _normalized_sql(sql)
            if "pg_advisory_xact_lock" in normalized_sql:
                lock_match = re.search(r"'(album-haven:[^']+)'", sql)
                lock_key = lock_match.group(1) if lock_match else normalized_sql
                advisory_lock = advisory_locks.setdefault(lock_key, threading.Lock())
                advisory_lock.acquire()
                self.held_advisory_locks.append(advisory_lock)
                return FakeCursor([{"pg_advisory_xact_lock": None}])
            if "cover_mutation_revision" in normalized_sql:
                with store_lock:
                    revision = store["cover_mutation_revision"]
                return FakeCursor([{"cover_mutation_revision": revision}])
            if "insert into library.local_albums" in normalized_sql:
                self.pending_album_cover_path = params["cover_path"]
            if "insert into library.local_track_files" in normalized_sql:
                file_entry = params["rows"][0]["metadata"]["scan_cache"]["file_entry"]
                self.pending_track_file_cover_path = file_entry["cover_path"]
            if "updated_albums" in normalized_sql:
                self.pending_album_cover_path = params["selected_cover_path"]
                self.pending_track_file_cover_path = params["selected_cover_path"]
                return FakeCursor(
                    [{
                        "input_path_count": 1,
                        "resolved_path_count": 1,
                        "selected_album_count": 1,
                        "album_track_file_count": 1,
                        "album_rows_updated": 1,
                        "track_file_rows_updated": 1,
                    }]
                )
            return cursor

    def connect(_database_url):
        role = "scan" if threading.current_thread().name == "prebuilt-stale-cover-scan" else "selection"
        connection = RevisionAwareTransaction(role)
        if role == "scan":
            scan_connections.append(connection)
        return connection

    stale_inventory_rows = (
        [],
        [{"cover_path": stale_cover_path}],
        [],
        [],
        [
            {
                "private_path": track_path,
                "metadata": {
                    "scan_cache": {
                        "file_entry": {
                            "path": track_path,
                            "cover_path": stale_cover_path,
                        }
                    }
                },
            }
        ],
    )

    def build_stale_inventory_rows(_file_cache, _albums):
        with store_lock:
            assert store["cover_mutation_revision"] == 0
        stale_rows_built.set()
        if not allow_scan_transaction.wait(timeout=2):
            raise RuntimeError("Timed out before stale scan publication was released.")
        return stale_inventory_rows

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    monkeypatch.setattr(
        scan_cache_persistence,
        "_inventory_rows_from_albums",
        build_stale_inventory_rows,
    )
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://pytest_cover_revision_race"},
        connect=connect,
        build_albums=lambda _file_cache, _selected_artists: [],
    )

    def publish_prebuilt_stale_scan():
        try:
            adapter.save_snapshot(
                Path("unused.json"),
                {},
                "generated-root",
                11.0,
            )
        except BaseException as exc:  # pragma: no cover - asserted below for thread handoff.
            scan_errors.append(exc)

    scan_thread = threading.Thread(
        target=publish_prebuilt_stale_scan,
        name="prebuilt-stale-cover-scan",
    )
    scan_thread.start()
    try:
        assert stale_rows_built.wait(timeout=2)
        selection_result = adapter.persist_cover_selection(
            track_paths={track_path},
            selected_cover_path=selected_cover_path,
            cover_revision="selected-cover-revision",
        )
        assert selection_result == {
            "album_rows_updated": 1,
            "track_file_rows_updated": 1,
        }
        with store_lock:
            assert store == {
                "album_cover_path": str(selected_cover_path),
                "track_file_cover_path": str(selected_cover_path),
                "cover_mutation_revision": 1,
            }
    finally:
        allow_scan_transaction.set()
    scan_thread.join(timeout=2)

    assert not scan_thread.is_alive()
    assert len(scan_connections) == 1
    assert {
        "scan_rolled_back": scan_connections[0].rolled_back,
        "scan_error_count": len(scan_errors),
        "store": store,
    } == {
        "scan_rolled_back": True,
        "scan_error_count": 1,
        "store": {
            "album_cover_path": str(selected_cover_path),
            "track_file_cover_path": str(selected_cover_path),
            "cover_mutation_revision": 1,
        },
    }
    assert isinstance(
        scan_errors[0],
        scan_cache_persistence.ScanCachePublicationSuperseded,
    )


def test_set_based_track_sql_preserves_scoped_upsert_contract():
    from music_app.services import scan_cache_persistence

    sql = _normalized_sql(scan_cache_persistence._upsert_local_track_sql())

    assert "jsonb_to_recordset(%(rows)s::jsonb)" in sql
    assert "metadata jsonb" in sql
    assert "library.local_albums.library_id = bootstrap_context.library_id" in sql
    assert "library.local_artists.library_id = bootstrap_context.library_id" in sql
    assert "on conflict (library_id, track_key) do update" in sql
    for assignment in (
        "album_id = excluded.album_id",
        "artist_id = excluded.artist_id",
        "title = excluded.title",
        "disc_number = excluded.disc_number",
        "track_number = excluded.track_number",
        "duration_seconds = excluded.duration_seconds",
        "last_seen_at = now()",
        "metadata = library.local_tracks.metadata || excluded.metadata",
    ):
        assert assignment in sql


def test_set_based_track_upsert_skips_unchanged_conflict_rows():
    from music_app.services import scan_cache_persistence

    sql = _normalized_sql(scan_cache_persistence._upsert_local_track_sql())

    assert (
        "where ( library.local_tracks.album_id, library.local_tracks.artist_id, "
        "library.local_tracks.title, library.local_tracks.disc_number, "
        "library.local_tracks.track_number, library.local_tracks.duration_seconds, "
        "library.local_tracks.metadata ) is distinct from ( excluded.album_id, "
        "excluded.artist_id, excluded.title, excluded.disc_number, "
        "excluded.track_number, excluded.duration_seconds, "
        "library.local_tracks.metadata || excluded.metadata )"
    ) in sql


def test_set_based_track_file_sql_preserves_scoped_upsert_contract():
    from music_app.services import scan_cache_persistence

    sql = _normalized_sql(scan_cache_persistence._upsert_local_track_file_sql())

    assert "jsonb_to_recordset(%(rows)s::jsonb)" in sql
    assert "metadata jsonb" in sql
    assert "library.local_tracks.library_id = bootstrap_context.library_id" in sql
    assert "library.require_local_track_file_root_id(" in sql
    assert "on conflict (private_path) do update" in sql
    for assignment in (
        "track_id = excluded.track_id",
        "library_root_id = excluded.library_root_id",
        "relative_path = excluded.relative_path",
        "file_size_bytes = excluded.file_size_bytes",
        "modified_at = excluded.modified_at",
        "last_seen_at = now()",
        "metadata = library.local_track_files.metadata || excluded.metadata",
    ):
        assert assignment in sql


def test_set_based_track_file_upsert_skips_unchanged_conflict_rows():
    from music_app.services import scan_cache_persistence

    sql = _normalized_sql(scan_cache_persistence._upsert_local_track_file_sql())

    assert (
        "where ( library.local_track_files.track_id, "
        "library.local_track_files.library_root_id, "
        "library.local_track_files.relative_path, "
        "library.local_track_files.file_size_bytes, "
        "library.local_track_files.modified_at, "
        "library.local_track_files.metadata ) is distinct from ( "
        "excluded.track_id, excluded.library_root_id, excluded.relative_path, "
        "excluded.file_size_bytes, excluded.modified_at, "
        "library.local_track_files.metadata || excluded.metadata )"
    ) in sql


def test_structural_album_edit_scopes_selection_and_completeness_to_active_track_files():
    from music_app.services import scan_cache_persistence

    sql = _normalized_sql(
        scan_cache_persistence._persist_structural_album_tag_edit_sql()
    )

    assert sql.count(
        "library.local_track_files.metadata #>> '{scan_cache,stale}'"
    ) >= 2
    assert sql.count("::boolean, false ) is false") >= 2


def test_scan_publication_relies_on_row_local_identity_constraint_without_full_library_reconciliation():
    import inspect

    from music_app.services import scan_cache_persistence

    source = inspect.getsource(
        scan_cache_persistence.PostgresScanCacheAdapter.save_snapshot
    )

    assert "_upsert_local_album_sql()" in source
    assert "_upsert_local_track_sql()" in source
    assert "_upsert_local_track_file_sql()" in source
    assert "_execute_semantic_local_album_reconciliation(connection)" not in source


def test_set_based_batches_unwrap_nested_jsonb_before_wrapping_outer_payload(monkeypatch):
    from music_app.services import scan_cache_persistence

    class FakeJsonb:
        def __init__(self, obj):
            self.obj = obj

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", FakeJsonb)
    connection = FakeConnection()

    scan_cache_persistence._execute_set_based_batches(
        connection,
        "set-based sql",
        [
            {
                "track_key": "track-1",
                "metadata": FakeJsonb(
                    {"scan_cache": {"file_entry": {"album": "Tender Buttons"}}}
                ),
            }
        ],
    )

    outer_payload = connection.executed[0][1]["rows"]
    assert isinstance(outer_payload, FakeJsonb)
    assert outer_payload.obj == [
        {
            "track_key": "track-1",
            "metadata": {
                "scan_cache": {"file_entry": {"album": "Tender Buttons"}}
            },
        }
    ]


def test_postgres_scan_cache_adapter_batches_large_track_publication_setwise(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    row_counts = {
        "artist": 401,
        "album": 401,
        "featured": 401,
        "track": 7_201,
        "track_file": 7_201,
    }
    inventory_rows = (
        [{"row": index} for index in range(row_counts["artist"])],
        [{"row": index} for index in range(row_counts["album"])],
        [
            {
                "album_key": f"album-{index}",
                "artist_key": f"artist-{index}",
                "featured_kind": "owner",
            }
            for index in range(row_counts["featured"])
        ],
        [{"row": index} for index in range(row_counts["track"])],
        [
            {"private_path": f"C:/Music/track-{index}.flac"}
            for index in range(row_counts["track_file"])
        ],
    )
    monkeypatch.setattr(
        scan_cache_persistence,
        "_inventory_rows_from_albums",
        lambda _file_cache, _albums: inventory_rows,
    )
    connection = FakeConnection()
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        build_albums=lambda _file_cache, _selected_artists: [],
    )

    adapter.save_snapshot(Path("unused.json"), {}, "root-identity", 5.0)

    pipelined_sql_markers = (
        "insert into library.local_artists",
        "insert into library.local_albums",
        "insert into library.local_album_featured_artists",
    )
    pipelined_execute_indexes = [
        index
        for index, (sql, params) in enumerate(connection.executed)
        if params is not None
        and any(marker in sql for marker in pipelined_sql_markers)
    ]
    track_execute_indexes = [
        index
        for index, (sql, _params) in enumerate(connection.executed)
        if "insert into library.local_tracks" in sql
    ]
    track_file_execute_indexes = [
        index
        for index, (sql, _params) in enumerate(connection.executed)
        if "insert into library.local_track_files" in sql
    ]
    pipeline_batch_size = 1_000
    expected_pipeline_batches = sum(
        (row_count + pipeline_batch_size - 1) // pipeline_batch_size
        for row_count in (
            row_counts["artist"],
            row_counts["album"],
            row_counts["featured"],
        )
    )
    assert connection.pipeline_entries == expected_pipeline_batches
    assert connection.pipeline_exits == expected_pipeline_batches
    assert len(pipelined_execute_indexes) == 1_203
    assert max(connection.pipeline_execute_counts) <= pipeline_batch_size
    assert all(
        connection.execute_pipeline_states[index]
        for index in pipelined_execute_indexes
    )
    assert len(track_execute_indexes) == 8
    assert len(track_file_execute_indexes) == 8
    assert all(
        connection.execute_pipeline_states[index] is False
        for index in [*track_execute_indexes, *track_file_execute_indexes]
    )
    track_batch_sizes = [
        len(connection.executed[index][1]["rows"])
        for index in track_execute_indexes
    ]
    track_file_batch_sizes = [
        len(connection.executed[index][1]["rows"])
        for index in track_file_execute_indexes
    ]
    assert track_batch_sizes == [1_000] * 7 + [201]
    assert track_file_batch_sizes == [1_000] * 7 + [201]
    assert sum(track_batch_sizes) == row_counts["track"]
    assert sum(track_file_batch_sizes) == row_counts["track_file"]
    assert len(pipelined_execute_indexes) + len(track_execute_indexes) + len(track_file_execute_indexes) == 1_219
    assert max(track_execute_indexes) < min(track_file_execute_indexes)
    stale_mark_index = next(
        index
        for index, (sql, _params) in enumerate(connection.executed)
        if "update library.local_track_files" in sql
    )
    assert max(track_file_execute_indexes) < stale_mark_index
    relation_source_index = next(
        index
        for index, (sql, _params) in enumerate(connection.executed)
        if "as owner_artist_id" in sql
    )
    assert stale_mark_index < relation_source_index
    assert connection.execute_pipeline_states[relation_source_index] is False


def test_postgres_scan_cache_adapter_saves_inventory_rows(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = FakeConnection()
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
    )
    file_cache = {
        "C:/Music/Broadcast/Tender Buttons/01 I Found The F.mp3": {
            "path": "C:/Music/Broadcast/Tender Buttons/01 I Found The F.mp3",
            "mtime": 1710000000.0,
            "size": 12345,
            "album": "Tender Buttons",
            "album_artist": "Broadcast",
            "title": "I Found The F",
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "artist": "Broadcast",
            "duration_seconds": 178,
            "cover_path": "C:/Music/Broadcast/Tender Buttons/cover.jpg",
            "local_cover_width": 600,
            "local_cover_height": 600,
            "remote_cover_url": None,
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": None,
            "remote_cover_source_label": None,
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "year": 2005,
            "edition": "",
            "album_rating": 0,
            "library_root_id": "main",
            "library_root_category": "main_library",
            "exception_type": None,
        },
        "C:/Music/Incoming/problem-file.mp3": {
            "path": "C:/Music/Incoming/problem-file.mp3",
            "mtime": 1710000005.0,
            "size": 999,
            "album": "Loose Tracks",
            "album_artist": "Unknown Artist",
            "title": "Problem File",
            "track_number": None,
            "disc_number": None,
            "disc_number_raw": None,
            "artist": "Unknown Artist",
            "duration_seconds": None,
            "cover_path": None,
            "local_cover_width": None,
            "local_cover_height": None,
            "remote_cover_url": None,
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": None,
            "remote_cover_source_label": None,
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "year": None,
            "edition": None,
            "album_rating": 0,
            "library_root_id": "incoming",
            "library_root_category": "hoard",
            "exception_type": "missing_tags",
        }
    }

    adapter.save_snapshot(
        Path("unused-library-cache.json"),
        file_cache,
        "root-identity",
        1710000010.0,
    )

    executed_sql = [sql for sql, _params in connection.executed]
    assert any("update library.libraries" in sql for sql in executed_sql)
    assert any("insert into library.local_artists" in sql for sql in executed_sql)
    assert any("insert into library.local_albums" in sql for sql in executed_sql)
    assert any("insert into library.local_album_featured_artists" in sql for sql in executed_sql)
    assert any("delete from library.local_album_featured_artists" in sql for sql in executed_sql)
    assert any("insert into library.local_tracks" in sql for sql in executed_sql)
    assert any("insert into library.local_track_files" in sql for sql in executed_sql)
    assert any("update library.local_track_files" in sql for sql in executed_sql)

    snapshot_params = [
        params for sql, params in connection.executed if "update library.libraries" in sql
    ][0]
    assert snapshot_params["scan_cache"]["library_root_identity"] == "root-identity"
    assert snapshot_params["scan_cache"]["last_scan"] == 1710000010.0
    assert snapshot_params["scan_cache"]["relation_views"] == {}
    assert snapshot_params["scan_cache"]["relation_projection"]["status"] == "stale"

    track_file_rows = [
        row
        for sql, params in connection.executed
        if "insert into library.local_track_files" in sql
        for row in params["rows"]
    ]
    assert len(track_file_rows) == 2
    track_file_params = track_file_rows[0]
    assert track_file_params["private_path"].replace("\\", "/") == (
        "C:/Music/Broadcast/Tender Buttons/01 I Found The F.mp3"
    )
    assert track_file_params["file_size_bytes"] == 12345
    assert track_file_params["metadata"]["scan_cache"]["stale"] is False
    assert track_file_params["metadata"]["scan_cache"]["file_entry"]["album"] == "Tender Buttons"
    cache_only_params = track_file_rows[1]
    assert cache_only_params["private_path"] == "C:/Music/Incoming/problem-file.mp3"
    assert cache_only_params["metadata"]["scan_cache"]["cache_only"] is True
    assert cache_only_params["metadata"]["scan_cache"]["file_entry"]["exception_type"] == "missing_tags"
    stale_params = [
        params for sql, params in connection.executed if "update library.local_track_files" in sql
    ][0]
    assert stale_params["current_paths"] == [
        "C:/Music/Broadcast/Tender Buttons/01 I Found The F.mp3",
        "C:/Music/Incoming/problem-file.mp3",
    ]
    assert stale_params["current_path_count"] == 2

    synchronize_params = next(
        params
        for sql, params in connection.executed
        if "delete from library.local_album_featured_artists" in sql
    )
    assert synchronize_params["source"] == "runtime_scan_cache"
    assert synchronize_params["current_featured_rows"] == [
        {
            "album_key": "broadcast::tender buttons",
            "artist_key": "broadcast",
            "featured_kind": "owner",
        },
        {
            "album_key": "broadcast::tender buttons",
            "artist_key": "broadcast",
            "featured_kind": "featured_track_artist",
        },
    ]


def test_explicit_scan_publishes_family_links_before_compilation_aware_ready_metadata_on_same_transaction(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = FakeConnection()
    events = []
    relation_views = {
        "artists": ["Artist One", "Artist Two"],
        "artists_sidebar": ["Artist One"],
        "family_to_artists": {},
        "folder_related": {"Artist One": ["Artist Two"]},
        "sidebar_families": [],
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
    }
    published_relation_timestamps = []

    def replace_family_projection(active_connection, payload, *, relations_last_built):
        assert active_connection is connection
        assert payload["folder_related"] == relation_views["folder_related"]
        assert payload["artists"] == relation_views["artists"]
        assert relations_last_built > 0
        published_relation_timestamps.append(relations_last_built)
        events.append("family_replace")

    monkeypatch.setattr(
        scan_cache_persistence,
        "replace_artist_family_projection_in_transaction",
        replace_family_projection,
    )
    monkeypatch.setattr(
        scan_cache_persistence,
        "build_relation_views_from_postgres_rows",
        lambda _config, _rows: relation_views,
    )
    monkeypatch.setattr(
        scan_cache_persistence,
        "relation_source_fingerprint",
        lambda _rows: "canonical-fingerprint",
    )
    original_execute = connection.execute

    def execute(sql, params=None):
        if "jsonb_build_object('scan_cache'" in sql:
            events.append("scan_cache_save")
        return original_execute(sql, params)

    connection.execute = execute
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        build_albums=lambda _file_cache, _selected_artists: [],
    )

    adapter.save_snapshot(
        Path("unused-library-cache.json"),
        {},
        "root-identity",
        10.0,
        rebuild_relation_projection=True,
    )

    assert events == ["family_replace", "scan_cache_save"]
    snapshot_params = next(
        params
        for sql, params in connection.executed
        if "jsonb_build_object('scan_cache'" in sql
    )
    assert snapshot_params["scan_cache"]["relations_last_built"] == (
        published_relation_timestamps[0]
    )
    assert snapshot_params["scan_cache"]["relation_projection"]["status"] == "ready"
    assert snapshot_params["scan_cache"]["relation_projection"]["source_fingerprint"] == (
        "canonical-fingerprint"
    )
    assert snapshot_params["scan_cache"]["relation_projection"]["built_from_fingerprint"] == (
        "canonical-fingerprint"
    )
    assert snapshot_params["scan_cache"]["relation_projection"]["builder_version"] == (
        scan_cache_persistence.RELATION_PROJECTION_BUILDER_VERSION
    )


def test_unrebuilt_projection_with_changed_fingerprint_stays_stale_and_preserves_provenance(
    monkeypatch,
):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    relation_views = {
        "artists": ["Artist One", "Artist Two"],
        "artists_sidebar": ["Artist One"],
        "family_to_artists": {"artist-one": ["Artist One", "Artist Two"]},
        "folder_related": {"Artist One": ["Artist Two"]},
        "sidebar_families": [],
        "alias_to_canonical": {"Artist Two": "Artist One"},
        "canonical_to_aliases": {"Artist One": ["Artist Two"]},
    }
    connection = FakeConnection(
        snapshot_rows=[
            {
                "scan_cache": {
                    "library_root_identity": "root-identity",
                    "last_scan": 9.0,
                    "relations_last_built": 9.5,
                    "relation_views": relation_views,
                    "relation_projection": {
                        "status": "ready",
                        "builder_version": (
                            scan_cache_persistence.RELATION_PROJECTION_BUILDER_VERSION
                        ),
                        "source_fingerprint": "previous-fingerprint",
                        "built_from_fingerprint": "previous-fingerprint",
                    },
                }
            }
        ]
    )
    replacements = []
    monkeypatch.setattr(
        scan_cache_persistence,
        "replace_artist_family_projection_in_transaction",
        lambda *_args, **_kwargs: replacements.append("replace"),
    )
    monkeypatch.setattr(
        scan_cache_persistence,
        "relation_source_fingerprint",
        lambda _rows: "current-fingerprint",
    )
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        build_albums=lambda _file_cache, _selected_artists: [],
    )

    adapter.save_snapshot(
        Path("unused-library-cache.json"),
        {},
        "root-identity",
        10.0,
        relation_views=relation_views,
        relations_last_built=12.5,
    )

    assert replacements == []
    snapshot_params = next(
        params
        for sql, params in connection.executed
        if "jsonb_build_object('scan_cache'" in sql
    )
    projection_metadata = snapshot_params["scan_cache"]["relation_projection"]
    assert projection_metadata["status"] == "stale"
    assert projection_metadata["source_fingerprint"] == "current-fingerprint"
    assert projection_metadata["built_from_fingerprint"] == "previous-fingerprint"


@pytest.mark.parametrize(
    "existing_projection_metadata",
    [
        None,
        {
            "status": "stale",
            "builder_version": "local-relation-builder-v3",
        },
        {
            "status": "ready",
            "builder_version": "local-relation-builder-v2",
        },
    ],
    ids=["missing-metadata", "stale-status", "outdated-builder"],
)
def test_equal_caller_views_do_not_replace_or_certify_unhealthy_existing_projection(
    monkeypatch,
    existing_projection_metadata,
):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    relation_views = {
        "artists": ["Artist One", "Artist Two"],
        "artists_sidebar": [],
        "family_to_artists": {"artist-one": ["Artist One", "Artist Two"]},
        "folder_related": {"Artist One": ["Artist Two"]},
        "sidebar_families": [],
        "alias_to_canonical": {"Artist Two": "Artist One"},
        "canonical_to_aliases": {"Artist One": ["Artist Two"]},
    }
    existing_scan_cache = {
        "library_root_identity": "root-identity",
        "last_scan": 9.0,
        "relations_last_built": 9.5,
        "relation_views": relation_views,
    }
    if existing_projection_metadata is not None:
        existing_scan_cache["relation_projection"] = existing_projection_metadata
    connection = FakeConnection(
        snapshot_rows=[{"scan_cache": existing_scan_cache}]
    )
    replacements = []
    monkeypatch.setattr(
        scan_cache_persistence,
        "replace_artist_family_projection_in_transaction",
        lambda *_args, **_kwargs: replacements.append("replace"),
    )
    monkeypatch.setattr(
        scan_cache_persistence,
        "relation_source_fingerprint",
        lambda _rows: "current-fingerprint",
    )
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        build_albums=lambda _file_cache, _selected_artists: [],
    )

    adapter.save_snapshot(
        Path("unused-library-cache.json"),
        {},
        "root-identity",
        10.0,
        relation_views=relation_views,
        relations_last_built=12.5,
    )

    assert replacements == []
    snapshot_params = next(
        params
        for sql, params in connection.executed
        if "jsonb_build_object('scan_cache'" in sql
    )
    projection_metadata = snapshot_params["scan_cache"]["relation_projection"]
    assert projection_metadata["status"] == "stale"
    assert not (
        projection_metadata.get("status") == "ready"
        and projection_metadata.get("builder_version")
        == scan_cache_persistence.RELATION_PROJECTION_BUILDER_VERSION
    )
    assert projection_metadata["source_fingerprint"] == "current-fingerprint"
    assert projection_metadata.get("built_from_fingerprint") != "current-fingerprint"


def test_postgres_scan_cache_adapter_preserves_existing_relation_snapshot_when_omitted(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = FakeConnection(
        snapshot_rows=[
            {
                "scan_cache": {
                    "library_root_identity": "root-identity",
                    "last_scan": 1700000000.0,
                    "relations_last_built": 1700000001.0,
                    "relation_views": {"artists": ["Broadcast"]},
                }
            }
        ],
    )
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
    )

    adapter.save_snapshot(
        Path("unused-library-cache.json"),
        {
            "C:/Music/Incoming/problem-file.mp3": {
                "path": "C:/Music/Incoming/problem-file.mp3",
                "mtime": 1710000005.0,
                "size": 999,
                "album": "Loose Tracks",
                "album_artist": "Unknown Artist",
                "title": "Problem File",
                "track_number": None,
                "disc_number": None,
                "disc_number_raw": None,
                "artist": "Unknown Artist",
                "duration_seconds": None,
                "cover_path": None,
                "local_cover_width": None,
                "local_cover_height": None,
                "remote_cover_url": None,
                "remote_cover_thumbnail_url": None,
                "remote_cover_source": None,
                "remote_cover_source_label": None,
                "remote_cover_album_url": None,
                "remote_cover_width": None,
                "remote_cover_height": None,
                "year": None,
                "edition": None,
                "album_rating": 0,
                "library_root_id": "incoming",
                "library_root_category": "hoard",
                "exception_type": "missing_tags",
            }
        },
        "root-identity",
        1710000010.0,
    )

    snapshot_params = [
        params for sql, params in connection.executed if "update library.libraries" in sql
    ][0]
    assert snapshot_params["scan_cache"]["last_scan"] == 1710000010.0
    assert snapshot_params["scan_cache"]["relations_last_built"] == 1700000001.0
    assert snapshot_params["scan_cache"]["relation_views"] == {
        "artists": ["Broadcast"],
        "artists_sidebar": [],
        "family_to_artists": {},
        "folder_related": {},
        "sidebar_families": [],
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
    }
    assert snapshot_params["scan_cache"]["relation_projection"]["status"] == "stale"


def _complete_projection_for_certification(artist):
    return {
        "artists": [artist],
        "artists_sidebar": [{"artist": artist, "count": 1}],
        "family_to_artists": {},
        "folder_related": {artist: set()},
        "sidebar_families": [],
        "alias_to_canonical": {artist: artist},
        "canonical_to_aliases": {artist: [artist]},
    }


def test_postgres_snapshot_without_explicit_rebuild_cannot_certify_caller_legacy_views_as_current(
    monkeypatch,
):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = FakeConnection()
    legacy_views = _complete_projection_for_certification("Legacy Caller")
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        build_albums=lambda *_args: [],
    )

    adapter.save_snapshot(
        Path("unused-library-cache.json"),
        {},
        "root-identity",
        10.0,
        relation_views=legacy_views,
        relations_last_built=12.5,
    )

    snapshot = next(
        params["scan_cache"]
        for sql, params in connection.executed
        if "jsonb_build_object('scan_cache'" in sql
    )
    assert snapshot.get("relation_views", {}) == {}
    assert "Legacy Caller" not in repr(snapshot.get("relation_views", {}))
    metadata = snapshot.get("relation_projection") or {}
    assert metadata["status"] == "stale"
    assert metadata.get("builder_version") != (
        scan_cache_persistence.RELATION_PROJECTION_BUILDER_VERSION
    )


def test_explicit_postgres_rebuild_certifies_only_canonical_source_projection(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = FakeConnection()
    canonical = _complete_projection_for_certification("Canonical Source")
    monkeypatch.setattr(
        scan_cache_persistence,
        "build_relation_views_from_postgres_rows",
        lambda _config, _rows: canonical,
    )
    monkeypatch.setattr(
        scan_cache_persistence,
        "relation_source_fingerprint",
        lambda _rows: "canonical-fingerprint",
    )
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        build_albums=lambda *_args: [],
    )

    committed = adapter.save_snapshot(
        Path("unused-library-cache.json"),
        {},
        "root-identity",
        10.0,
        relation_views=_complete_projection_for_certification("Legacy Caller"),
        relations_last_built=12.5,
        rebuild_relation_projection=True,
    )

    snapshot = next(
        params["scan_cache"]
        for sql, params in connection.executed
        if "jsonb_build_object('scan_cache'" in sql
    )
    assert snapshot["relation_views"]["artists"] == ["Canonical Source"]
    assert snapshot["relation_projection"]["status"] == "ready"
    assert snapshot["relation_projection"]["builder_version"] == (
        scan_cache_persistence.RELATION_PROJECTION_BUILDER_VERSION
    )
    assert committed["relation_views"]["artists"] == ["Canonical Source"]


def test_unrelated_write_preserves_healthy_current_projection_without_invoking_builder(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    canonical = _complete_projection_for_certification("Persisted Canonical")
    connection = FakeConnection(snapshot_rows=[{"scan_cache": {
        "library_root_identity": "root-identity",
        "relation_views": canonical,
        "relations_last_built": 8.0,
        "relation_projection": {
            "status": "ready",
            "builder_version": scan_cache_persistence.RELATION_PROJECTION_BUILDER_VERSION,
            "source_fingerprint": "same",
            "built_from_fingerprint": "same",
        },
    }}])
    monkeypatch.setattr(scan_cache_persistence, "relation_source_fingerprint", lambda _rows: "same")
    monkeypatch.setattr(
        scan_cache_persistence,
        "build_relation_views_from_postgres_rows",
        lambda *_args: pytest.fail("unrelated write rebuilt a healthy projection"),
    )
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        build_albums=lambda *_args: [],
    )

    adapter.save_snapshot(
        Path("unused-library-cache.json"),
        {},
        "root-identity",
        10.0,
        relation_views=_complete_projection_for_certification("Caller Legacy"),
    )

    snapshot = next(
        params["scan_cache"]
        for sql, params in connection.executed
        if "jsonb_build_object('scan_cache'" in sql
    )
    assert snapshot["relation_views"]["artists"] == ["Persisted Canonical"]
    assert snapshot["relation_projection"]["status"] == "ready"
    assert snapshot["relation_projection"]["built_from_fingerprint"] == "same"


def test_changed_source_fingerprint_marks_preserved_projection_stale_without_rewriting_provenance(
    monkeypatch,
):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    canonical = _complete_projection_for_certification("Persisted Canonical")
    connection = FakeConnection(snapshot_rows=[{"scan_cache": {
        "library_root_identity": "root-identity",
        "relation_views": canonical,
        "relations_last_built": 8.0,
        "relation_projection": {
            "status": "ready",
            "builder_version": "local-relation-builder-v5",
            "source_fingerprint": "old",
            "built_from_fingerprint": "old",
        },
    }}])
    monkeypatch.setattr(scan_cache_persistence, "relation_source_fingerprint", lambda _rows: "new")
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        build_albums=lambda *_args: [],
    )

    adapter.save_snapshot(Path("unused-library-cache.json"), {}, "root-identity", 10.0)

    metadata = next(
        params["scan_cache"]["relation_projection"]
        for sql, params in connection.executed
        if "jsonb_build_object('scan_cache'" in sql
    )
    assert metadata["status"] == "stale"
    assert metadata["builder_version"] == "local-relation-builder-v5"
    assert metadata["source_fingerprint"] == "new"
    assert metadata["built_from_fingerprint"] == "old"


def test_postgres_scan_cache_adapter_splits_featured_track_artists_into_featured_rows(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = FakeConnection()
    album = SimpleNamespace(
        key="artist one::album one",
        name="Album One",
        album_artist="Artist One",
        artists=["Artist One"],
        year=2024,
        cover_path=None,
        edition=None,
        root_provenance={"root": "main"},
        tracks=[
            SimpleNamespace(
                path="C:/Music/Artist One/Album One/01 Song One.flac",
                title="Song One",
                artist="Artist One feat. Guest One",
                album="Album One",
                album_artist="Artist One",
                disc_number=1,
                track_number=1,
                duration_seconds=215,
                root_provenance={"root": "main"},
            )
        ],
    )
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        build_albums=lambda _file_cache, _selected_artists: [album],
    )

    adapter.save_snapshot(
        Path("unused-library-cache.json"),
        {
            "C:/Music/Artist One/Album One/01 Song One.flac": {
                "path": "C:/Music/Artist One/Album One/01 Song One.flac",
                "mtime": 1710000000.0,
                "size": 12345,
                "album": "Album One",
                "album_artist": "Artist One",
                "title": "Song One",
                "track_number": 1,
                "disc_number": 1,
                "disc_number_raw": "1",
                "artist": "Artist One feat. Guest One",
                "duration_seconds": 215,
                "cover_path": None,
                "year": 2024,
                "edition": None,
                "album_rating": 0,
                "library_root_id": "main",
                "library_root_category": "albums",
                "exception_type": None,
            }
        },
        "root-identity",
        1710000010.0,
    )

    album_params = [
        params for sql, params in connection.executed if "insert into library.local_albums" in sql
    ][0]
    assert album_params["metadata"]["featured_artists"] == ["Guest One"]

    featured_rows = [
        params
        for sql, params in connection.executed
        if params is not None
        and "insert into library.local_album_featured_artists" in sql
    ]
    assert {
        (row["artist_key"], row["featured_kind"])
        for row in featured_rows
    } == {
        ("artist one", "owner"),
        ("artist one", "featured_track_artist"),
        ("guest one", "featured_track_artist"),
    }


def test_postgres_scan_cache_adapter_loads_snapshot_without_file_cache_json(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    file_entry = {
        "path": "C:/Music/Broadcast/Tender Buttons/01 I Found The F.mp3",
        "mtime": 1710000000.0,
        "size": 12345,
        "album": "Tender Buttons",
        "album_artist": "Broadcast",
        "title": "I Found The F",
        "track_number": 1,
        "disc_number": 1,
        "disc_number_raw": "1",
        "artist": "Broadcast",
        "duration_seconds": 178,
        "cover_path": None,
        "local_cover_width": None,
        "local_cover_height": None,
        "remote_cover_url": None,
        "remote_cover_thumbnail_url": None,
        "remote_cover_source": None,
        "remote_cover_source_label": None,
        "remote_cover_album_url": None,
        "remote_cover_width": None,
        "remote_cover_height": None,
        "year": 2005,
        "edition": "",
        "album_rating": 0,
        "library_root_id": "main",
        "library_root_category": "main_library",
        "exception_type": None,
    }
    connection = FakeConnection(
        snapshot_rows=[
            {
                "scan_cache": {
                    "library_root_identity": "root-identity",
                    "last_scan": 1710000010.0,
                    "relations_last_built": 1710000011.0,
                    "relation_views": {"artists": ["Broadcast"]},
                }
            }
        ],
        file_rows=[
            {
                "private_path": file_entry["path"],
                "file_entry": file_entry,
            }
        ],
    )
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
    )

    file_cache, last_scan, relation_views, relations_last_built, error = adapter.load_snapshot(
        Path("must-not-be-read.json"),
        "root-identity",
    )

    assert error is None
    assert last_scan == 1710000010.0
    assert relations_last_built == 1710000011.0
    assert relation_views["artists"] == ["Broadcast"]
    assert list(file_cache) == [file_entry["path"]]
    assert file_cache[file_entry["path"]]["album"] == "Tender Buttons"
    assert file_cache[file_entry["path"]]["size"] == 12345
    load_file_entries = [
        params for sql, params in connection.executed if "metadata #>> '{scan_cache,source}' = %(source)s" in sql
    ]
    assert load_file_entries == [{"source": "runtime_scan_cache"}]
    assert len(connection.executed) == 3


def test_postgres_scan_cache_hydration_overlays_authoritative_album_compilation_state(
    monkeypatch,
):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    track_path = (
        "C:/Music/Control Family/Non-Compilation Cross-Credits/Disc 1/01.mp3"
    )
    file_entry = {
        "path": track_path,
        "mtime": 1710000000.0,
        "size": 12345,
        "album": "Non-Compilation Cross-Credits",
        "album_artist": "Control Signal Lead",
        "title": "Control Signal 1",
        "track_number": 1,
        "disc_number": 1,
        "disc_number_raw": "1",
        "artist": "Control Signal Partner",
        "duration_seconds": 178,
        "cover_path": None,
        "year": 2026,
        "edition": "",
        "album_rating": None,
        "library_root_id": "main",
        "library_root_category": "main_library",
        "exception_type": None,
    }
    connection = FakeConnection(
        snapshot_rows=[
            {
                "scan_cache": {
                    "library_root_identity": "root-identity",
                    "last_scan": 1710000010.0,
                    "relation_views": {},
                }
            }
        ],
        file_rows=[
            {
                "private_path": track_path,
                "file_entry": file_entry,
                "album_is_compilation": False,
            }
        ],
    )
    adapter = PostgresScanCacheAdapter(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": (
                "postgresql://album_haven_app@localhost/app"
            )
        },
        connect=lambda _database_url: connection,
    )

    file_cache, _last_scan, _relation_views, _last_built, error = (
        adapter.load_snapshot(Path("must-not-be-read.json"), "root-identity")
    )

    assert error is None
    assert file_cache[track_path]["is_compilation"] is False
    load_sql = next(
        sql
        for sql, _params in connection.executed
        if "local_track_files.metadata #> '{scan_cache,file_entry}'" in sql
    )
    assert "library.local_albums.metadata ? 'is_compilation'" in load_sql
    assert "as album_is_compilation" in load_sql


def test_postgres_scan_cache_metadata_schema_version_survives_inventory_hydration(monkeypatch):
    from config import PERSISTENCE_BACKEND_POSTGRES
    from music_app.services import library_hydration, scan_cache_persistence
    from music_app.services.library_hydration import hydrate_library_state_from_disk
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    track_path = "C:/Music/Artist/Album/01 Song.mp3"
    file_entry = {
        "path": track_path,
        "mtime": 1710000000.0,
        "size": 12345,
        "album": "Album",
        "album_artist": "Artist",
        "title": "Song",
        "track_number": 1,
        "disc_number": 1,
        "disc_number_raw": "1",
        "artist": "Artist",
        "duration_seconds": 178,
        "cover_path": None,
        "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
    }
    album = SimpleNamespace(
        key="artist::album",
        name="Album",
        album_artist="Artist",
        artists=["Artist"],
        year=2026,
        cover_path=None,
        edition=None,
        root_provenance=None,
        album_rating=None,
        tracks=[
            SimpleNamespace(
                path=track_path,
                title="Song",
                artist="Artist",
                album="Album",
                album_artist="Artist",
                disc_number=1,
                track_number=1,
                duration_seconds=178,
                root_provenance=None,
            )
        ],
    )
    *_inventory_rows, track_file_rows = scan_cache_persistence._inventory_rows_from_albums(
        {track_path: file_entry},
        [album],
    )
    persisted_file_entry = track_file_rows[0]["metadata"]["scan_cache"]["file_entry"]
    connection = FakeConnection(
        snapshot_rows=[
            {
                "scan_cache": {
                    "library_root_identity": "root-identity",
                    "last_scan": 1710000010.0,
                }
            }
        ],
        file_rows=[
            {
                "private_path": track_path,
                "file_entry": persisted_file_entry,
            }
        ],
    )
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
    )
    monkeypatch.setattr(
        library_hydration,
        "library_root_cache_identity",
        lambda _config: "root-identity",
    )
    monkeypatch.setattr(
        library_hydration,
        "select_scan_cache_adapter",
        lambda _config: adapter,
    )
    monkeypatch.setattr(
        library_hydration,
        "select_runtime_persistence_adapter",
        lambda _seam_id, _config: SimpleNamespace(
            effective_backend=PERSISTENCE_BACKEND_POSTGRES
        ),
    )
    monkeypatch.setattr(
        library_hydration,
        "load_separate_release_keys",
        lambda _config: set(),
    )
    library_state = {"albums": []}

    hydrated = hydrate_library_state_from_disk(
        library_state,
        {
            "CACHE_PATH": Path("must-not-be-read.json"),
            "IMAGE_EXTENSIONS": {".jpg"},
        },
        ensure_relations=False,
        validate_cache=False,
    )

    assert hydrated is True
    assert (
        library_state["file_cache"][track_path]["metadata_schema_version"]
        == FILE_METADATA_SCHEMA_VERSION
    )
    assert library_state["scan_metadata_repair_required"] is False


def test_postgres_scan_cache_adapter_ignores_mismatched_root_identity(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = FakeConnection(
        snapshot_rows=[{"scan_cache": {"library_root_identity": "other-root", "last_scan": 5.0}}],
        file_rows=[{"private_path": "should-not-load.mp3", "file_entry": {"path": "should-not-load.mp3"}}],
    )
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
    )

    assert adapter.load_snapshot(Path("unused.json"), "root-identity") == ({}, 0.0, {}, 0.0, None)
    assert len(connection.executed) == 2


def test_postgres_scan_cache_adapter_strict_load_propagates_original_database_error():
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    database_error = RuntimeError("database connection failed")
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: (_ for _ in ()).throw(database_error),
    )

    with pytest.raises(RuntimeError) as raised:
        adapter.load_snapshot_strict(Path("must-not-be-read.json"), "root-identity")

    assert raised.value is database_error


def test_postgres_scan_cache_adapter_default_load_preserves_compatibility_error_snapshot():
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    database_error = RuntimeError("database connection failed")
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: (_ for _ in ()).throw(database_error),
    )

    assert adapter.load_snapshot(Path("must-not-be-read.json"), "root-identity") == (
        {},
        0.0,
        {},
        0.0,
        "Could not read Postgres scan cache: database connection failed",
    )


def test_postgres_scan_cache_adapter_raises_when_bootstrap_context_is_missing(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = FakeConnection(bootstrap_ready=False)
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
    )

    with pytest.raises(RuntimeError, match="bootstrap local owner/library context"):
        adapter.save_snapshot(Path("unused.json"), {}, "root-identity", 5.0)


def test_select_scan_cache_adapter_rejects_file_runtime_selection(monkeypatch):
    from music_app.services import scan_cache_persistence

    monkeypatch.setattr(
        scan_cache_persistence,
        "is_scan_cache_postgres_available",
        lambda config: False,
    )

    with pytest.raises(ValueError, match="file is not supported for runtime persistence"):
        scan_cache_persistence.select_scan_cache_adapter({"PERSISTENCE_BACKENDS": {"scan_cache": "file"}})


def test_select_scan_cache_adapter_rejects_non_postgres_effective_selection(monkeypatch):
    from types import SimpleNamespace

    from music_app.services import scan_cache_persistence

    monkeypatch.setattr(
        scan_cache_persistence,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(
            requested_backend="postgres",
            effective_backend="file",
        ),
    )

    with pytest.raises(RuntimeError, match="scan_cache runtime persistence selected file"):
        scan_cache_persistence.select_scan_cache_adapter(
            {"PERSISTENCE_BACKENDS": {"scan_cache": "postgres"}}
        )


def test_scan_cache_module_does_not_export_removed_file_runtime_adapters():
    from music_app.services import scan_cache_persistence

    assert not hasattr(scan_cache_persistence, "FileScanCacheAdapter")
    assert not hasattr(
        scan_cache_persistence,
        "select_scan_cache_adapter_with_legacy_fallback",
    )
    assert "backend = \"file\"" not in Path(
        "music_app/services/scan_cache_persistence.py"
    ).read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("raw_rating", "expected_rating", "expected_source"),
    [
        (8, 8, "file_tag"),
        (0, None, None),
        (11, None, None),
        ("not-a-rating", None, None),
        (True, None, None),
        (False, None, None),
        (None, None, None),
    ],
)
def test_local_album_inventory_always_replaces_tag_rating_metadata(
    monkeypatch,
    raw_rating,
    expected_rating,
    expected_source,
):
    from music_app.services import scan_cache_persistence

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    album = SimpleNamespace(
        key="broadcast::tender buttons",
        name="Tender Buttons",
        album_artist="Broadcast",
        artists=["Broadcast"],
        year=2005,
        cover_path=None,
        edition=None,
        root_provenance={"root_id": "main"},
        album_rating=raw_rating,
        tracks=[],
    )

    _artists, album_rows, _featured, _tracks, _files = (
        scan_cache_persistence._inventory_rows_from_albums({}, [album])
    )

    assert album_rows[0]["metadata"]["tag_album_rating"] == expected_rating
    assert album_rows[0]["metadata"]["tag_album_rating_source"] == expected_source


def test_local_album_inventory_persists_cover_ownership_and_remote_provenance(monkeypatch):
    from music_app.services import scan_cache_persistence

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    album = SimpleNamespace(
        key="mastodon::crack the skye fixture 09",
        name="Crack The Skye Fixture 09",
        album_artist="Mastodon",
        artists=["Mastodon"],
        year=2009,
        cover_path="C:/Music/Mastodon/Crack The Skye Fixture 09/cover.jpg",
        cover_revision="sha256:fixture-user-cover",
        cover_selection_origin="user",
        local_cover_width=640,
        local_cover_height=640,
        remote_cover_url="https://covers.example/full.jpg",
        remote_cover_thumbnail_url="https://covers.example/thumb.jpg",
        remote_cover_source="fixture-existing",
        remote_cover_source_label="Fixture Existing Cover",
        remote_cover_album_url="https://covers.example/album",
        remote_cover_width=640,
        remote_cover_height=640,
        edition="Fixture Edition",
        root_provenance={"root_id": "main"},
        album_rating=None,
        tracks=[],
    )

    _artists, album_rows, _featured, _tracks, _files = (
        scan_cache_persistence._inventory_rows_from_albums({}, [album])
    )

    metadata = album_rows[0]["metadata"]
    assert metadata["cover_selection_origin"] == "user"
    assert metadata["local_cover_width"] == 640
    assert metadata["local_cover_height"] == 640
    assert metadata["remote_cover_url"] == "https://covers.example/full.jpg"
    assert metadata["remote_cover_thumbnail_url"] == "https://covers.example/thumb.jpg"
    assert metadata["remote_cover_source"] == "fixture-existing"
    assert metadata["remote_cover_source_label"] == "Fixture Existing Cover"
    assert metadata["remote_cover_album_url"] == "https://covers.example/album"
    assert metadata["remote_cover_width"] == 640
    assert metadata["remote_cover_height"] == 640


def test_local_album_inventory_does_not_publish_null_cover_authority(monkeypatch):
    from music_app.services import scan_cache_persistence

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    album = SimpleNamespace(
        key="mastodon::leviathan",
        name="Leviathan",
        album_artist="Mastodon",
        artists=["Mastodon"],
        year=2004,
        cover_path=None,
        cover_revision=None,
        edition=None,
        root_provenance={"root_id": "main"},
        album_rating=None,
        tracks=[],
    )

    _artists, album_rows, _featured, _tracks, _files = (
        scan_cache_persistence._inventory_rows_from_albums({}, [album])
    )

    metadata = album_rows[0]["metadata"]
    assert "cover_selection_origin" not in metadata
    assert "remote_cover_url" not in metadata


@pytest.mark.parametrize(
    ("raw_rating", "expected_candidates"),
    [
        (1, [{"album_key": "broadcast::tender buttons", "tag_album_rating": 1}]),
        (10, [{"album_key": "broadcast::tender buttons", "tag_album_rating": 10}]),
        (0, []),
        (11, []),
        (True, []),
        (False, []),
    ],
)
def test_tag_album_rating_candidates_accept_only_integer_one_through_ten(
    raw_rating,
    expected_candidates,
):
    from music_app.services import scan_cache_persistence

    album = SimpleNamespace(
        key="broadcast::tender buttons",
        album_rating=raw_rating,
    )

    assert scan_cache_persistence._tag_album_rating_candidates([album]) == (
        expected_candidates
    )


def test_postgres_scan_publication_persists_album_compilation_state(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = FakeConnection()
    albums = [
        SimpleNamespace(
            key=f"fixture::{title.casefold()}",
            name=title,
            album_artist=artist,
            artists=[artist],
            is_compilation=is_compilation,
            year=2026,
            cover_path=None,
            edition=None,
            root_provenance={"root_id": "main"},
            album_rating=None,
            tracks=[],
        )
        for title, artist, is_compilation in [
            ("Compilation Contract", "Compilation Artist", True),
            ("Ordinary Contract", "Ordinary Artist", False),
        ]
    ]
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        build_albums=lambda _file_cache, _selected_artists: albums,
    )

    adapter.save_snapshot(
        Path("unused-library-cache.json"),
        {},
        "root-identity",
        1710000010.0,
    )

    persisted_album_metadata = {
        params["title"]: params["metadata"]
        for sql, params in connection.executed
        if "insert into library.local_albums" in sql
    }
    assert persisted_album_metadata["Compilation Contract"]["is_compilation"] is True
    assert persisted_album_metadata["Ordinary Contract"]["is_compilation"] is False


def test_local_album_inventory_retains_cover_revision_after_track_metadata_rewrite(
    monkeypatch,
):
    from music_app.services import scan_cache_persistence

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    track_path = "C:/Music/Artist One/Album One/01 - Track One.mp3"
    album = SimpleNamespace(
        key="artist one::album one",
        name="Album One",
        album_artist="Artist One",
        artists=["Artist One"],
        year=2026,
        cover_path="C:/Music/Artist One/Album One/cover.jpg",
        cover_revision="exact-cover-sha256",
        edition="Fixture Edition",
        root_provenance={"root_id": "main"},
        album_rating=None,
        tracks=[
            SimpleNamespace(
                path=track_path,
                title="Track One",
                artist="Guest Artist",
                album="Album One",
                album_artist="Artist One",
                disc_number=1,
                track_number=1,
                duration_seconds=180,
                root_provenance={"root_id": "main"},
            )
        ],
    )
    file_cache = {
        track_path: {
            "path": track_path,
            "size": 123,
            "mtime": 456.0,
            "album": "Album One",
            "album_artist": "Artist One",
            "title": "Track One",
            "track_number": 1,
            "disc_number": 1,
            "artist": "Guest Artist",
            "duration_seconds": 180,
        }
    }

    _artists, album_rows, _featured, _tracks, _files = (
        scan_cache_persistence._inventory_rows_from_albums(file_cache, [album])
    )

    assert album_rows[0]["metadata"]["featured_artists"] == ["Guest Artist"]
    assert album_rows[0]["metadata"]["cover_revision"] == "exact-cover-sha256"


def test_postgres_scan_cache_snapshot_does_not_seed_ratings_by_default(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    seed_calls = []
    monkeypatch.setattr(
        scan_cache_persistence.PostgresAlbumRatingsService,
        "seed_missing_album_ratings_in_transaction",
        lambda _self, *args, **kwargs: seed_calls.append((args, kwargs)),
    )
    connection = FakeConnection()
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        build_albums=lambda _file_cache, _selected_artists: [],
    )

    adapter.save_snapshot(Path("unused.json"), {}, "root-identity", 5.0)

    assert seed_calls == []


def test_postgres_scan_cache_snapshot_seeds_after_inventory_and_snapshot_writes(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = FakeConnection()
    events = []
    original_execute = connection.execute

    def execute(sql, params=None):
        if "insert into library.local_albums" in sql:
            events.append("album_inventory")
        if "jsonb_build_object('scan_cache'" in sql:
            events.append("scan_snapshot")
        return original_execute(sql, params)

    connection.execute = execute

    def seed_missing(active_connection, candidates, *, source):
        assert active_connection is connection
        events.append("rating_seed")
        assert candidates == [
            {"album_key": "broadcast::tender buttons", "tag_album_rating": 8}
        ]
        assert source == "file_tag_scan"

    def guard(seed_action):
        events.append("seed_guard_enter")
        seed_action()
        assert connection.commit_calls == 1
        events.append("seed_guard_exit")

    monkeypatch.setattr(
        scan_cache_persistence.PostgresAlbumRatingsService,
        "seed_missing_album_ratings_in_transaction",
        lambda _self, *args, **kwargs: seed_missing(*args, **kwargs),
    )
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        build_albums=lambda _file_cache, _selected_artists: [
            SimpleNamespace(
                key="broadcast::tender buttons",
                name="Tender Buttons",
                album_artist="Broadcast",
                artists=["Broadcast"],
                year=2005,
                cover_path=None,
                edition=None,
                root_provenance=None,
                album_rating=8,
                tracks=[],
            )
        ],
    )

    adapter.save_snapshot(
        Path("unused.json"),
        {},
        "root-identity",
        5.0,
        seed_missing_album_ratings=True,
        album_rating_seed_guard=guard,
    )

    assert events == [
        "album_inventory",
        "scan_snapshot",
        "seed_guard_enter",
        "rating_seed",
        "seed_guard_exit",
    ]


def test_postgres_scan_cache_rating_seed_failure_rolls_back_and_propagates(monkeypatch):
    from music_app.services import scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    connection = FakeConnection()
    seed_error = RuntimeError("rating seed failed")

    def fail_seed(*_args, **_kwargs):
        raise seed_error

    monkeypatch.setattr(
        scan_cache_persistence.PostgresAlbumRatingsService,
        "seed_missing_album_ratings_in_transaction",
        lambda _self, *args, **kwargs: fail_seed(*args, **kwargs),
    )
    adapter = PostgresScanCacheAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda _database_url: connection,
        build_albums=lambda _file_cache, _selected_artists: [],
    )

    with pytest.raises(RuntimeError) as raised:
        adapter.save_snapshot(
            Path("unused.json"),
            {},
            "root-identity",
            5.0,
            seed_missing_album_ratings=True,
            album_rating_seed_guard=lambda seed_action: seed_action(),
        )

    assert raised.value is seed_error
    assert connection.exit_exc_type is RuntimeError
    assert connection.commit_calls == 0
    assert any("jsonb_build_object('scan_cache'" in sql for sql, _params in connection.executed)
