from __future__ import annotations

import pytest

from music_app.services.listen_history import (
    append_listen_history_entry,
    build_listen_history_status_counts,
    load_listen_history,
    load_pending_scrobble_entries,
    save_listen_history,
    update_listen_history_entry,
)
from music_app.services import listen_history


@pytest.fixture
def fake_listen_history_adapter(monkeypatch):
    stored: list[dict[str, object]] = []

    class PostgresSelection:
        effective_backend = "postgres"

    class FakeListenHistoryAdapter:
        def __init__(self, _config):
            pass

        def load_items(self):
            return [dict(item) for item in stored]

        def save_items(self, items):
            stored[:] = [dict(item) for item in items]

    monkeypatch.setattr(
        listen_history,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: PostgresSelection(),
    )
    monkeypatch.setattr(listen_history, "PostgresListenHistoryAdapter", FakeListenHistoryAdapter)
    return stored


def test_listen_history_runtime_rejects_non_postgres_selection(tmp_path, monkeypatch):
    config = {"DATA_DIR": tmp_path}

    class FileSelection:
        effective_backend = "file"

    monkeypatch.setattr(
        listen_history,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: FileSelection(),
    )

    with pytest.raises(ValueError, match="Postgres-only"):
        load_listen_history(config)

    with pytest.raises(ValueError, match="Postgres-only"):
        save_listen_history(config, [])


def test_append_listen_history_entry_adds_identity_and_preserves_shape(
    tmp_path,
    fake_listen_history_adapter,
):
    config = {"DATA_DIR": tmp_path}
    entry = {
        "track_ref": "C:/Music/song.mp3",
        "segments": [{"start": 0, "end": 12}],
        "scrobble_eligible": True,
        "scrobbled": False,
        "source_provenance": {"kind": "local_playback"},
    }

    saved = append_listen_history_entry(config, entry)

    assert saved["id"]
    assert saved["recorded_at"]
    assert saved["segments"] == [{"start": 0, "end": 12}]
    assert saved["scrobble_eligible"] is True
    assert saved["scrobbled"] is False
    assert saved["source_provenance"] == {"kind": "local_playback"}


def test_update_listen_history_entry_and_pending_scrobble_filter(
    tmp_path,
    fake_listen_history_adapter,
):
    config = {"DATA_DIR": tmp_path}
    first = append_listen_history_entry(
        config,
        {"track_ref": "first", "scrobble_eligible": True, "scrobbled": False},
    )
    append_listen_history_entry(
        config,
        {"track_ref": "second", "scrobble_eligible": True, "scrobbled": True},
    )
    append_listen_history_entry(
        config,
        {"track_ref": "third", "scrobble_eligible": False, "scrobbled": False},
    )

    updated = update_listen_history_entry(
        config,
        str(first["id"]),
        {"scrobble_retry_count": 2},
    )

    assert updated is not None
    assert updated["scrobble_retry_count"] == 2
    assert update_listen_history_entry(config, "", {"x": 1}) is None
    assert [item["track_ref"] for item in load_pending_scrobble_entries(config)] == [
        "first"
    ]
    assert load_pending_scrobble_entries(config, limit=0)[0]["track_ref"] == "first"


def test_build_listen_history_status_counts_uses_one_history_snapshot(monkeypatch):
    config = {"DATA_DIR": "unused"}
    load_calls: list[object] = []

    def fake_load_listen_history(received_config):
        load_calls.append(received_config)
        return [
            {"scrobble_eligible": True, "scrobbled": True},
            {"scrobble_eligible": True, "scrobbled": False},
            {"scrobble_eligible": False, "scrobbled": False},
        ]

    monkeypatch.setattr(listen_history, "load_listen_history", fake_load_listen_history)

    counts = build_listen_history_status_counts(config)

    assert load_calls == [config]
    assert counts == {"listen_history_count": 1, "pending_scrobble_count": 1}


def test_selected_postgres_listen_history_append_update_pending_leaves_stale_json_untouched(
    tmp_path,
    monkeypatch,
):
    config = {
        "DATA_DIR": tmp_path,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"listen_history": "postgres"},
    }
    history_path = tmp_path / "listen_history.json"
    history_path.write_text('{"items":[{"id":"stale","track_ref":"old"}]}', encoding="utf-8")
    stored = [
        {
            "id": "existing",
            "track_ref": "existing-track",
            "recorded_at": "2026-07-02T10:00:00+00:00",
            "scrobble_eligible": True,
            "scrobbled": False,
        }
    ]

    class FakeListenHistoryAdapter:
        def __init__(self, _config):
            pass

        def load_items(self):
            return [dict(item) for item in stored]

        def save_items(self, items):
            stored[:] = [dict(item) for item in items]

    class FakePsycopg:
        def connect(self):
            raise AssertionError("sentinel test should use the fake adapter")

    monkeypatch.setattr("music_app.services.listen_history_postgres.psycopg", FakePsycopg())
    monkeypatch.setattr(listen_history, "PostgresListenHistoryAdapter", FakeListenHistoryAdapter)

    appended = append_listen_history_entry(
        config,
        {
            "track_ref": "new-track",
            "recorded_at": "2026-07-02T10:05:00+00:00",
            "scrobble_eligible": True,
            "scrobbled": False,
        },
    )
    updated = update_listen_history_entry(
        config,
        str(appended["id"]),
        {"scrobbled": True},
    )

    assert updated is not None
    assert updated["scrobbled"] is True
    assert [item["track_ref"] for item in load_pending_scrobble_entries(config)] == [
        "existing-track"
    ]
    assert history_path.read_text(encoding="utf-8") == '{"items":[{"id":"stale","track_ref":"old"}]}'
