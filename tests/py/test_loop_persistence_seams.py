from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services.loops import (
    delete_loop,
    load_loops,
    reorder_loops,
    resolve_loop_media_path,
    save_loops,
)
from music_app.services.saved_loops_postgres import SavedLoopsPostgresAdapter


class _FakeSavedLoopsAdapter:
    saved_payload = None
    rows = [
        {"id": "pg-a", "name": "Postgres A"},
        {"id": "pg-b", "name": "Postgres B"},
    ]

    def __init__(self, config):
        self.config = config

    def load_loops(self):
        return list(self.rows)

    def save_loops(self, loops):
        self.__class__.saved_payload = list(loops)
        self.__class__.rows = list(loops)


class _FakePsycopg:
    def connect(self):
        raise AssertionError("availability should not open a database connection")


class _FakeCursor:
    def __init__(self, rows=None):
        self._rows = list(rows or [])

    def fetchone(self):
        if not self._rows:
            return None
        return self._rows[0]

    def fetchall(self):
        return list(self._rows)


class _FakeTransaction:
    def __init__(self, connection: "_FakeConnection"):
        self.connection = connection

    def __enter__(self):
        self.connection.transaction_entries += 1
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.connection.transaction_exits += 1
        return False


class _FakeConnection:
    def __init__(self, *, rows=None, bootstrap_ready=True, upsert_returns=True):
        self.rows = list(rows or [])
        self.bootstrap_ready = bootstrap_ready
        self.upsert_returns = upsert_returns
        self.operations: list[dict[str, object]] = []
        self.closed = False
        self.transaction_entries = 0
        self.transaction_exits = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.closed = True
        return False

    def transaction(self):
        return _FakeTransaction(self)

    def execute(self, sql, params=None):
        sql_text = str(sql)
        self.operations.append({"sql": sql_text, "params": params})
        lowered = sql_text.lower()
        if "bootstrap_context_ready" in lowered:
            return _FakeCursor([{"bootstrap_context_ready": 1}] if self.bootstrap_ready else [])
        if "insert into app.saved_loops" in lowered:
            return _FakeCursor([{"saved": 1}] if self.upsert_returns else [])
        if "from app.saved_loops as saved_loop" in lowered:
            return _FakeCursor(self.rows)
        return _FakeCursor()


def test_saved_loop_metadata_requires_postgres_selection_without_touching_json(
    tmp_path,
    monkeypatch,
):
    config = {"DATA_DIR": tmp_path}
    index_path = tmp_path / "loops" / "loops.json"
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text('{"loops": [{"id": "stale-file"}]}', encoding="utf-8")

    monkeypatch.setattr(
        "music_app.services.loops.select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(effective_backend="file"),
    )

    with pytest.raises(RuntimeError, match="Postgres persistence"):
        load_loops(config)

    with pytest.raises(RuntimeError, match="Postgres persistence"):
        save_loops(config, [{"id": "new"}])

    with pytest.raises(RuntimeError, match="Postgres persistence"):
        reorder_loops(config, ["stale-file"])

    assert index_path.read_text(encoding="utf-8") == '{"loops": [{"id": "stale-file"}]}'


def test_reorder_loops_persists_known_ids_and_appends_omitted_ids(tmp_path, monkeypatch):
    monkeypatch.setattr("music_app.services.saved_loops_postgres.psycopg", _FakePsycopg())
    monkeypatch.setattr("music_app.services.loops.SavedLoopsPostgresAdapter", _FakeSavedLoopsAdapter)
    _FakeSavedLoopsAdapter.rows = [{"id": "a"}, {"id": "b"}, {"id": "c"}]
    config = {
        "DATA_DIR": tmp_path,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"saved_loops": "postgres"},
    }

    assert reorder_loops(config, ["c", "missing", "a", "c"]) == [
        {"id": "c"},
        {"id": "a"},
        {"id": "b"},
    ]
    assert load_loops(config) == [{"id": "c"}, {"id": "a"}, {"id": "b"}]


def test_delete_loop_removes_owned_media_and_previews_but_ignores_outside_paths(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr("music_app.services.saved_loops_postgres.psycopg", _FakePsycopg())
    monkeypatch.setattr("music_app.services.loops.SavedLoopsPostgresAdapter", _FakeSavedLoopsAdapter)
    config = {
        "DATA_DIR": tmp_path,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"saved_loops": "postgres"},
    }
    loop_media = tmp_path / "loops" / "loop-1.mp3"
    loop_media.parent.mkdir(parents=True, exist_ok=True)
    loop_media.write_bytes(b"loop")
    preview = tmp_path / "loop_previews" / "loop-1_pplus1.mp3"
    preview.parent.mkdir(parents=True, exist_ok=True)
    preview.write_bytes(b"preview")
    outside = tmp_path / "outside.mp3"
    outside.write_bytes(b"outside")
    _FakeSavedLoopsAdapter.rows = [
        {"id": "loop-1", "path": str(loop_media)},
        {"id": "loop-2", "path": str(outside)},
    ]

    assert delete_loop(config, "loop-1")[0] is True
    assert not loop_media.exists()
    assert not preview.exists()
    assert outside.exists()
    assert resolve_loop_media_path(config, "loop-2") is None


def test_resolve_loop_media_path_uses_current_data_root_for_legacy_persisted_path(
    tmp_path,
    monkeypatch,
):
    current_data_root = tmp_path / "current-data"
    canonical_loop = current_data_root / "loops" / "legacy-loop.mp3"
    canonical_loop.parent.mkdir(parents=True)
    canonical_loop.write_bytes(b"current-loop")
    legacy_loop = tmp_path / "legacy-data" / "loops" / "legacy-loop.mp3"
    legacy_loop.parent.mkdir(parents=True)
    legacy_loop.write_bytes(b"legacy-loop")
    config = {"DATA_DIR": current_data_root}
    monkeypatch.setattr(
        "music_app.services.loops.load_loops",
        lambda _config: [{"id": "legacy-loop", "path": str(legacy_loop)}],
    )

    assert resolve_loop_media_path(config, "legacy-loop") == canonical_loop.resolve()


def test_resolve_loop_media_path_rejects_external_paths_and_traversal_ids(
    tmp_path,
    monkeypatch,
):
    current_data_root = tmp_path / "current-data"
    escaped_candidate = current_data_root / "outside.mp3"
    escaped_candidate.parent.mkdir(parents=True)
    escaped_candidate.write_bytes(b"outside")
    arbitrary_external = tmp_path / "legacy-data" / "loops" / "external-loop.mp3"
    arbitrary_external.parent.mkdir(parents=True)
    arbitrary_external.write_bytes(b"external")
    config = {"DATA_DIR": current_data_root}
    monkeypatch.setattr(
        "music_app.services.loops.load_loops",
        lambda _config: [
            {"id": "external-loop", "path": str(arbitrary_external)},
            {"id": "../outside", "path": str(escaped_candidate)},
        ],
    )

    assert resolve_loop_media_path(config, "external-loop") is None
    assert resolve_loop_media_path(config, "../outside") is None


def test_delete_loop_with_legacy_path_removes_canonical_media_and_previews_only(
    tmp_path,
    monkeypatch,
):
    current_data_root = tmp_path / "current-data"
    canonical_loop = current_data_root / "loops" / "legacy-loop.mp3"
    canonical_loop.parent.mkdir(parents=True)
    canonical_loop.write_bytes(b"current-loop")
    legacy_loop = tmp_path / "legacy-data" / "loops" / "legacy-loop.mp3"
    legacy_loop.parent.mkdir(parents=True)
    legacy_loop.write_bytes(b"legacy-loop")
    preview = current_data_root / "loop_previews" / "legacy-loop_pplus2.mp3"
    preview.parent.mkdir(parents=True)
    preview.write_bytes(b"preview")
    config = {
        "DATA_DIR": current_data_root,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"saved_loops": "postgres"},
    }
    monkeypatch.setattr("music_app.services.saved_loops_postgres.psycopg", _FakePsycopg())
    monkeypatch.setattr("music_app.services.loops.SavedLoopsPostgresAdapter", _FakeSavedLoopsAdapter)
    _FakeSavedLoopsAdapter.rows = [
        {"id": "legacy-loop", "path": str(legacy_loop)},
        {"id": "keep-loop", "path": str(current_data_root / "loops" / "keep-loop.mp3")},
    ]

    deleted, remaining = delete_loop(config, "legacy-loop")

    assert deleted is True
    assert remaining == [
        {"id": "keep-loop", "path": str(current_data_root / "loops" / "keep-loop.mp3")}
    ]
    assert not canonical_loop.exists()
    assert not preview.exists()
    assert legacy_loop.read_bytes() == b"legacy-loop"


def test_selected_postgres_saved_loops_load_save_and_reorder_leave_stale_json_untouched(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr("music_app.services.saved_loops_postgres.psycopg", _FakePsycopg())
    monkeypatch.setattr("music_app.services.loops.SavedLoopsPostgresAdapter", _FakeSavedLoopsAdapter)
    _FakeSavedLoopsAdapter.rows = [
        {"id": "pg-a", "name": "Postgres A"},
        {"id": "pg-b", "name": "Postgres B"},
    ]
    _FakeSavedLoopsAdapter.saved_payload = None
    stale_index = tmp_path / "loops" / "loops.json"
    stale_index.parent.mkdir(parents=True, exist_ok=True)
    stale_index.write_text('{"loops": [{"id": "stale-file"}]}', encoding="utf-8")
    config = {
        "DATA_DIR": tmp_path,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"saved_loops": "postgres"},
    }

    assert load_loops(config) == [
        {"id": "pg-a", "name": "Postgres A"},
        {"id": "pg-b", "name": "Postgres B"},
    ]

    save_loops(config, [{"id": "new"}, "not-a-dict", {"id": "next"}])
    assert _FakeSavedLoopsAdapter.saved_payload == [{"id": "new"}, {"id": "next"}]
    assert stale_index.read_text(encoding="utf-8") == '{"loops": [{"id": "stale-file"}]}'

    assert reorder_loops(config, ["next", "new"]) == [{"id": "next"}, {"id": "new"}]
    assert _FakeSavedLoopsAdapter.saved_payload == [{"id": "next"}, {"id": "new"}]
    assert stale_index.read_text(encoding="utf-8") == '{"loops": [{"id": "stale-file"}]}'


def test_selected_postgres_saved_loops_delete_removes_metadata_and_owned_media_without_touching_json(
    tmp_path,
    monkeypatch,
):
    loop_media = tmp_path / "loops" / "pg-a.mp3"
    loop_media.parent.mkdir(parents=True, exist_ok=True)
    loop_media.write_bytes(b"loop")
    preview = tmp_path / "loop_previews" / "pg-a_pplus1.mp3"
    preview.parent.mkdir(parents=True, exist_ok=True)
    preview.write_bytes(b"preview")
    stale_index = tmp_path / "loops" / "loops.json"
    stale_index.write_text('{"loops": [{"id": "stale-file"}]}', encoding="utf-8")
    _FakeSavedLoopsAdapter.rows = [
        {"id": "pg-a", "path": str(loop_media)},
        {"id": "pg-b", "path": str(tmp_path / "outside.mp3")},
    ]
    monkeypatch.setattr("music_app.services.saved_loops_postgres.psycopg", _FakePsycopg())
    monkeypatch.setattr("music_app.services.loops.SavedLoopsPostgresAdapter", _FakeSavedLoopsAdapter)
    config = {
        "DATA_DIR": tmp_path,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"saved_loops": "postgres"},
    }

    deleted, remaining = delete_loop(config, "pg-a")

    assert deleted is True
    assert remaining == [{"id": "pg-b", "path": str(tmp_path / "outside.mp3")}]
    assert _FakeSavedLoopsAdapter.saved_payload == remaining
    assert not loop_media.exists()
    assert not preview.exists()
    assert stale_index.read_text(encoding="utf-8") == '{"loops": [{"id": "stale-file"}]}'


def test_postgres_saved_loops_adapter_loads_loop_payloads_with_parent_keys():
    connection = _FakeConnection(
        rows=[
            {
                "loop_key": "child-loop",
                "source_private_path": "C:/Music/source.mp3",
                "loop_private_path": "C:/Data/loops/child-loop.mp3",
                "start_seconds": 1.25,
                "end_seconds": 3.5,
                "created_at": "2026-07-02T10:00:00+00:00",
                "parent_loop_key": "parent-loop",
                "metadata": {
                    "source_payload": {
                        "id": "child-loop",
                        "name": "Child Loop",
                        "artist": "Artist",
                        "title": "Title",
                        "album": "Album",
                        "cover_path": "C:/covers/cover.jpg",
                    }
                },
            }
        ]
    )
    adapter = SavedLoopsPostgresAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    assert adapter.load_loops() == [
        {
            "id": "child-loop",
            "name": "Child Loop",
            "artist": "Artist",
            "title": "Title",
            "album": "Album",
            "cover_path": "C:/covers/cover.jpg",
            "path": "C:/Data/loops/child-loop.mp3",
            "source_path": "C:/Music/source.mp3",
            "start_seconds": 1.25,
            "end_seconds": 3.5,
            "duration_seconds": 2.25,
            "parent_loop_id": "parent-loop",
            "created_at": "2026-07-02T10:00:00+00:00",
        }
    ]
    assert any("app.bootstrap_owners" in operation["sql"] for operation in connection.operations)
    assert connection.closed


def test_postgres_saved_loops_adapter_saves_scoped_upserts_and_links_parents(monkeypatch):
    monkeypatch.setattr("music_app.services.saved_loops_postgres.Jsonb", None)
    connection = _FakeConnection()
    adapter = SavedLoopsPostgresAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )

    adapter.save_loops(
        [
            {
                "id": "child-loop",
                "name": "Child Loop",
                "path": "C:/Data/loops/child-loop.mp3",
                "source_path": "C:/Music/source.mp3",
                "start_seconds": 1.25,
                "end_seconds": 3.5,
                "parent_loop_id": "parent-loop",
                "created_at": "2026-07-02T10:00:00+00:00",
            },
            "not-a-dict",
            {"id": "missing-times"},
            {"id": "bad-start", "start_seconds": "x", "end_seconds": 2},
            {"id": "bad-order", "start_seconds": 3, "end_seconds": 3},
        ]
    )

    mark_removed = [
        operation
        for operation in connection.operations
        if "update app.saved_loops" in operation["sql"].lower()
        and '"removed":true' in operation["sql"].replace(" ", "").lower()
    ]
    upserts = [
        operation
        for operation in connection.operations
        if "insert into app.saved_loops" in operation["sql"].lower()
    ]
    parent_links = [
        operation
        for operation in connection.operations
        if "parent_loop.loop_key = child_loop.metadata ->> 'parent_loop_key'"
        in operation["sql"].lower()
    ]

    assert connection.transaction_entries == 1
    assert connection.transaction_exits == 1
    assert len(mark_removed) == 1
    assert mark_removed[0]["params"] == (1, ["child-loop"])
    assert len(upserts) == 1
    assert "track_id" in upserts[0]["sql"].lower()
    assert "source_track_match" in upserts[0]["sql"].lower()
    assert "metadata_track_match" in upserts[0]["sql"].lower()
    assert "on conflict (account_id, library_id, loop_key)" in upserts[0]["sql"].lower()
    assert "where account_id is not null" in upserts[0]["sql"].lower()
    assert "track_id = coalesce(excluded.track_id, app.saved_loops.track_id)" in upserts[0]["sql"].lower()
    assert "parent_loop_id = null" in upserts[0]["sql"].lower()
    assert upserts[0]["params"]["loop_key"] == "child-loop"
    assert upserts[0]["params"]["source_private_path"] == "C:/Music/source.mp3"
    assert upserts[0]["params"]["loop_private_path"] == "C:/Data/loops/child-loop.mp3"
    assert upserts[0]["params"]["start_seconds"] == 1.25
    assert upserts[0]["params"]["end_seconds"] == 3.5
    assert upserts[0]["params"]["created_at"] == "2026-07-02T10:00:00+00:00"
    assert upserts[0]["params"]["parent_loop_key"] == "parent-loop"
    assert len(parent_links) == 1
    assert "track_id = coalesce(child_loop.track_id, parent_loop_match.track_id)" in parent_links[0]["sql"].lower()
    assert connection.closed

