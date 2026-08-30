from __future__ import annotations

import pytest

from music_app.services import lastfm_listen_sync
from music_app.services.lastfm_postgres import (
    _delete_scrobble_retry_state_sql,
    _load_scrobble_retry_state_sql,
    _upsert_pending_scrobble_sql,
    _upsert_scrobble_retry_state_sql,
)
from music_app.services.lastfm_listen_sync import (
    clear_pending_scrobble,
    load_lastfm_sync_state,
    record_pending_scrobble,
    record_retry_summary,
    save_lastfm_sync_state,
)


@pytest.fixture
def fake_lastfm_sync_state_adapter(monkeypatch):
    stored = {
        "pending_scrobbles": {},
        "sync_problems": {},
        "last_retry_summary": {},
    }

    class PostgresSelection:
        effective_backend = "postgres"

    class FakeLastfmSyncStateAdapter:
        def __init__(self, _config):
            pass

        def load_sync_state(self):
            return {
                "pending_scrobbles": dict(stored["pending_scrobbles"]),
                "sync_problems": dict(stored["sync_problems"]),
                "last_retry_summary": dict(stored["last_retry_summary"]),
            }

        def save_sync_state(self, sync_state):
            stored["pending_scrobbles"] = dict(sync_state.get("pending_scrobbles") or {})
            stored["sync_problems"] = dict(sync_state.get("sync_problems") or {})
            stored["last_retry_summary"] = dict(sync_state.get("last_retry_summary") or {})
            return sync_state

    monkeypatch.setattr(
        lastfm_listen_sync,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: PostgresSelection(),
    )
    monkeypatch.setattr(lastfm_listen_sync, "LastfmPostgresAdapter", FakeLastfmSyncStateAdapter)
    return stored


def test_lastfm_sync_state_runtime_rejects_non_postgres_selection(tmp_path, monkeypatch):
    config = {"DATA_DIR": tmp_path}

    class FileSelection:
        effective_backend = "file"

    monkeypatch.setattr(
        lastfm_listen_sync,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: FileSelection(),
    )

    with pytest.raises(ValueError, match="Postgres-only"):
        load_lastfm_sync_state(config)

    with pytest.raises(ValueError, match="Postgres-only"):
        save_lastfm_sync_state(config, {"pending_scrobbles": {}})


def test_pending_scrobble_and_retry_summary_state_shapes(
    tmp_path,
    fake_lastfm_sync_state_adapter,
):
    config = {"DATA_DIR": tmp_path}

    record_pending_scrobble(
        config,
        listen_id="listen-1",
        entry={"track_ref": "C:/Music/song.mp3"},
        retry_count=2,
        error="Temporary failure",
    )
    state = load_lastfm_sync_state(config)

    assert state["pending_scrobbles"]["listen-1"] == {
        "retry_count": 2,
        "last_error": "Temporary failure",
        "track_ref": "C:/Music/song.mp3",
    }
    assert state["sync_problems"]["listen-1"]["provider"] == "lastfm"

    clear_pending_scrobble(config, listen_id="listen-1")
    assert load_lastfm_sync_state(config)["pending_scrobbles"] == {}

    record_retry_summary(
        config,
        {
            "pending_before": 2,
            "attempted": 2,
            "succeeded": 1,
            "failed": 1,
            "pending_after": 1,
        },
    )
    summary = load_lastfm_sync_state(config)["last_retry_summary"]
    assert summary["attempted"] == 2
    assert summary["pending_after"] == 1
    assert summary["recorded_at"]


def test_selected_postgres_sync_state_pending_and_retry_summary_leave_stale_json_untouched(
    tmp_path,
    monkeypatch,
):
    config = {
        "DATA_DIR": tmp_path,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"lastfm_sync_state": "postgres"},
    }
    sync_path = tmp_path / "lastfm_sync_state.json"
    sync_path.write_text(
        '{"pending_scrobbles":{"stale":{"track_ref":"old"}}}',
        encoding="utf-8",
    )
    stored = {
        "pending_scrobbles": {},
        "sync_problems": {},
        "last_retry_summary": {},
    }

    class FakeLastfmSyncStateAdapter:
        def __init__(self, _config):
            pass

        def load_sync_state(self):
            return {
                "pending_scrobbles": dict(stored["pending_scrobbles"]),
                "sync_problems": dict(stored["sync_problems"]),
                "last_retry_summary": dict(stored["last_retry_summary"]),
            }

        def save_sync_state(self, sync_state):
            stored["pending_scrobbles"] = dict(sync_state["pending_scrobbles"])
            stored["sync_problems"] = dict(sync_state["sync_problems"])
            stored["last_retry_summary"] = dict(sync_state["last_retry_summary"])
            return sync_state

    class FakePsycopg:
        def connect(self):
            raise AssertionError("sentinel test should use the fake adapter")

    monkeypatch.setattr("music_app.services.lastfm_postgres.psycopg", FakePsycopg())
    monkeypatch.setattr(lastfm_listen_sync, "LastfmPostgresAdapter", FakeLastfmSyncStateAdapter)

    record_pending_scrobble(
        config,
        listen_id="listen-db",
        entry={"track_ref": "db-track"},
        retry_count=3,
        error="retry me",
    )
    clear_pending_scrobble(config, listen_id="listen-db")
    record_retry_summary(
        config,
        {
            "pending_before": 1,
            "attempted": 1,
            "succeeded": 1,
            "failed": 0,
            "pending_after": 0,
        },
    )

    state = load_lastfm_sync_state(config)
    assert state["pending_scrobbles"] == {}
    assert state["last_retry_summary"]["attempted"] == 1
    assert state["last_retry_summary"]["pending_after"] == 0
    assert sync_path.read_text(encoding="utf-8") == '{"pending_scrobbles":{"stale":{"track_ref":"old"}}}'


def test_postgres_sync_state_retry_sql_is_bootstrap_scoped():
    load_sql = _load_scrobble_retry_state_sql()
    delete_sql = _delete_scrobble_retry_state_sql()
    upsert_sql = _upsert_scrobble_retry_state_sql()

    assert "with bootstrap_context as" in load_sql
    assert "with bootstrap_context as" in delete_sql
    assert "with bootstrap_context as" in upsert_sql
    assert "pending_scrobbles.library_id = bootstrap_context.library_id" in load_sql
    assert "pending_scrobbles.account_id = bootstrap_context.account_id" in delete_sql
    assert "coalesce(" not in load_sql
    assert "coalesce(" not in delete_sql
    assert "(metadata->>'account_id')" in upsert_sql
    assert "(metadata->>'library_id')" in upsert_sql
    pending_upsert_sql = _upsert_pending_scrobble_sql()
    assert "account_id,\n          library_id,\n          (payload->>'source_family')" in pending_upsert_sql
    assert "where account_id is not null" in pending_upsert_sql
    assert "and library_id is not null" in pending_upsert_sql
    assert "and payload ? 'source_family'" in pending_upsert_sql
    assert "and payload ? 'source_key'" in pending_upsert_sql
    assert "where metadata ? 'account_id'" in upsert_sql
    assert "and metadata ? 'library_id'" in upsert_sql
    assert "and metadata ? 'source_family'" in upsert_sql
    assert "and metadata ? 'source_section'" in upsert_sql
    assert "and metadata ? 'source_key'" in upsert_sql
    assert "'account_id', bootstrap_context.account_id::text" in upsert_sql
    assert "'library_id', bootstrap_context.library_id::text" in upsert_sql
