from __future__ import annotations

from types import SimpleNamespace


def test_retry_pending_lastfm_scrobbles_marks_successful_entries(monkeypatch):
    from music_app.services import lastfm_retry
    from music_app.services import lastfm_sync_bridge

    config = {"LASTFM_API_ENABLED": True}
    entry = {
        "id": "listen-1",
        "title": "Song",
        "artist": "Artist",
        "album": "Album",
        "album_artist": "Artist",
        "started_at_unix": 100,
        "duration_seconds": 180,
        "track_number": "",
        "scrobble_eligible": True,
        "scrobbled": False,
        "scrobble_retry_count": 1,
    }
    updates: list[dict[str, object]] = []
    summaries: list[dict[str, int]] = []
    calls: list[dict[str, object]] = []

    monkeypatch.setattr(lastfm_retry, "load_pending_scrobble_entries", lambda config, limit: [entry])
    monkeypatch.setattr(
        lastfm_retry,
        "update_listen_history_entry",
        lambda config, entry_id, payload: updates.append(payload) or {**entry, **payload},
    )
    monkeypatch.setattr(lastfm_retry, "scrobble_track", lambda config, payload: calls.append(payload))
    monkeypatch.setattr(lastfm_retry, "pending_scrobble_count", lambda config: 0)
    monkeypatch.setattr(lastfm_retry, "record_retry_summary", lambda config, summary: summaries.append(dict(summary)))
    monkeypatch.setattr(lastfm_retry, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(lastfm_sync_bridge, "clear_pending_scrobble", lambda config, listen_id: None)

    summary = lastfm_retry.retry_pending_lastfm_scrobbles(config)

    assert summary == {
        "pending_before": 1,
        "attempted": 1,
        "succeeded": 1,
        "failed": 0,
        "pending_after": 0,
    }
    assert len(calls) == 1
    assert updates[0]["scrobbled"] is True
    assert updates[0]["scrobble_error"] == ""
    assert updates[0]["scrobble_retry_count"] == 2
    assert updates[0]["scrobbled_at"]
    assert summaries == [summary]


def test_retry_pending_lastfm_scrobbles_keeps_failed_entries_queued(monkeypatch):
    from music_app.services import lastfm_retry
    from music_app.services import lastfm_sync_bridge
    from music_app.services.lastfm import LastfmError

    config = {"LASTFM_API_ENABLED": True}
    entry = {
        "id": "listen-1",
        "title": "Song",
        "artist": "Artist",
        "album": "Album",
        "album_artist": "Artist",
        "started_at_unix": 100,
        "duration_seconds": 180,
        "track_number": "",
        "scrobble_eligible": True,
        "scrobbled": False,
    }
    updates: list[dict[str, object]] = []
    summaries: list[dict[str, int]] = []

    def fail_scrobble(config, payload):
        raise LastfmError("Temporary failure", retryable=True)

    monkeypatch.setattr(lastfm_retry, "load_pending_scrobble_entries", lambda config, limit: [entry])
    monkeypatch.setattr(
        lastfm_retry,
        "update_listen_history_entry",
        lambda config, entry_id, payload: updates.append(payload) or {**entry, **payload},
    )
    monkeypatch.setattr(lastfm_retry, "scrobble_track", fail_scrobble)
    monkeypatch.setattr(lastfm_retry, "pending_scrobble_count", lambda config: 1)
    monkeypatch.setattr(lastfm_retry, "record_retry_summary", lambda config, summary: summaries.append(dict(summary)))
    monkeypatch.setattr(lastfm_retry, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(lastfm_sync_bridge, "record_pending_scrobble", lambda *args, **kwargs: None)

    summary = lastfm_retry.retry_pending_lastfm_scrobbles(config)

    assert summary == {
        "pending_before": 1,
        "attempted": 1,
        "succeeded": 0,
        "failed": 1,
        "pending_after": 1,
    }
    assert updates[0]["scrobbled"] is False
    assert updates[0]["scrobble_error"] == "Temporary failure"
    assert updates[0]["scrobble_retry_count"] == 1
    assert updates[0]["last_scrobble_attempt_at"]
    assert summaries == [summary]


def test_retry_worker_does_not_branch_on_testing_config(monkeypatch):
    from music_app.services import lastfm_retry

    starts = []

    class FakeEvent:
        def __init__(self):
            self._set = False

        def is_set(self):
            return self._set

        def set(self):
            self._set = True

    class FakeThread:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def start(self):
            starts.append(self.kwargs["name"])

        def is_alive(self):
            return False

    monkeypatch.setattr(lastfm_retry, "_WORKER_THREAD", None)
    monkeypatch.setattr(lastfm_retry, "_WORKER_APP_KEY", "")
    monkeypatch.setattr(lastfm_retry, "_WORKER_STOP_EVENT", None)
    monkeypatch.setattr(lastfm_retry.threading, "Event", FakeEvent)
    monkeypatch.setattr(lastfm_retry.threading, "Thread", FakeThread)
    app = SimpleNamespace(
        config={"TESTING": True, "DATA_DIR": "test-runtime"},
        logger=SimpleNamespace(),
    )

    lastfm_retry.start_lastfm_retry_worker(app)

    assert starts == ["albumhaven-lastfm-retry"]
    assert lastfm_retry._WORKER_APP_KEY == "test-runtime"
    assert lastfm_retry.stop_lastfm_retry_worker(app) is True


def test_pending_scrobble_permanent_provider_error_is_not_requeued(monkeypatch):
    from music_app.services import lastfm_sync_bridge
    from music_app.services.lastfm import LastfmError

    entry = {
        "id": "listen-1",
        "artist": "Artist",
        "title": "Song",
        "started_at_unix": 100,
        "scrobble_eligible": True,
        "scrobbled": False,
    }
    updates = []
    cleared = []
    pending = []
    monkeypatch.setattr(lastfm_sync_bridge, "clear_pending_scrobble", lambda config, *, listen_id: cleared.append(listen_id))
    monkeypatch.setattr(lastfm_sync_bridge, "record_pending_scrobble", lambda *args, **kwargs: pending.append(kwargs))

    result = lastfm_sync_bridge.process_pending_scrobble_attempt(
        {},
        entry,
        update_listen_history_entry=lambda config, entry_id, payload: updates.append(payload) or {**entry, **payload},
        scrobble_track=lambda config, payload: (_ for _ in ()).throw(
            LastfmError("Authentication failed", code=4, retryable=False, error_kind="invalid_credentials")
        ),
        log_lastfm_scrobble_event=lambda *args, **kwargs: None,
    )

    assert result == {"attempted": True, "succeeded": False, "failed": True}
    assert updates[0]["scrobble_retryable"] is False
    assert updates[0]["sync_problem"]["status"] == "permanent_failure"
    assert pending == []
    assert cleared == ["listen-1"]


def test_pending_scrobble_respects_backoff_and_max_attempts(monkeypatch):
    from datetime import datetime, timezone
    from music_app.services import lastfm_sync_bridge

    calls = []
    updates = []
    cleared = []
    monkeypatch.setattr(lastfm_sync_bridge, "clear_pending_scrobble", lambda config, *, listen_id: cleared.append(listen_id))

    deferred = lastfm_sync_bridge.process_pending_scrobble_attempt(
        {},
        {
            "id": "deferred",
            "scrobble_retry_count": 1,
            "last_scrobble_attempt_at": datetime.now(timezone.utc).isoformat(),
        },
        update_listen_history_entry=lambda *args: None,
        scrobble_track=lambda config, payload: calls.append(payload),
        log_lastfm_scrobble_event=lambda *args, **kwargs: None,
    )
    exhausted = lastfm_sync_bridge.process_pending_scrobble_attempt(
        {},
        {"id": "exhausted", "scrobble_retry_count": 5, "scrobble_error": "still down"},
        update_listen_history_entry=lambda config, entry_id, payload: updates.append(payload),
        scrobble_track=lambda config, payload: calls.append(payload),
        log_lastfm_scrobble_event=lambda *args, **kwargs: None,
    )

    assert deferred == {"attempted": False, "succeeded": False, "failed": False}
    assert exhausted == {"attempted": False, "succeeded": False, "failed": True}
    assert calls == []
    assert updates[0]["scrobble_retry_exhausted"] is True
    assert cleared == ["exhausted"]


def test_pending_scrobble_not_connected_attempts_back_off_and_exhaust(monkeypatch):
    from music_app.services import lastfm_sync_bridge

    entry = {
        "id": "listen-not-connected",
        "artist": "Artist",
        "title": "Song",
        "started_at_unix": 100,
        "scrobble_eligible": True,
        "scrobbled": False,
    }
    updates = []
    pending = []
    cleared = []
    provider_calls = []

    def update_entry(config, entry_id, payload):
        assert entry_id == entry["id"]
        updates.append(dict(payload))
        entry.update(payload)
        return dict(entry)

    def not_connected(config, payload):
        provider_calls.append(dict(payload))
        return SimpleNamespace(
            succeeded=False,
            sent=False,
            outcome="not_connected",
            message="Last.fm account is not connected.",
        )

    monkeypatch.setattr(
        lastfm_sync_bridge,
        "record_pending_scrobble",
        lambda *args, **kwargs: pending.append(dict(kwargs)),
    )
    monkeypatch.setattr(
        lastfm_sync_bridge,
        "clear_pending_scrobble",
        lambda config, *, listen_id: cleared.append(listen_id),
    )

    first = lastfm_sync_bridge.process_pending_scrobble_attempt(
        {},
        entry,
        update_listen_history_entry=update_entry,
        scrobble_track=not_connected,
        log_lastfm_scrobble_event=lambda *args, **kwargs: None,
    )

    assert first == {"attempted": False, "succeeded": False, "failed": True}
    assert entry["scrobble_retry_count"] == 1
    assert entry["last_scrobble_attempt_at"]
    assert pending[-1]["retry_count"] == 1

    deferred = lastfm_sync_bridge.process_pending_scrobble_attempt(
        {},
        entry,
        update_listen_history_entry=update_entry,
        scrobble_track=not_connected,
        log_lastfm_scrobble_event=lambda *args, **kwargs: None,
    )

    assert deferred == {"attempted": False, "succeeded": False, "failed": False}
    assert len(provider_calls) == 1
    assert len(updates) == 1

    for expected_count in range(2, 6):
        entry["last_scrobble_attempt_at"] = "2000-01-01T00:00:00+00:00"
        result = lastfm_sync_bridge.process_pending_scrobble_attempt(
            {},
            entry,
            update_listen_history_entry=update_entry,
            scrobble_track=not_connected,
            log_lastfm_scrobble_event=lambda *args, **kwargs: None,
        )
        assert result == {"attempted": False, "succeeded": False, "failed": True}
        assert entry["scrobble_retry_count"] == expected_count
        assert entry["last_scrobble_attempt_at"] != "2000-01-01T00:00:00+00:00"

    assert len(provider_calls) == 5
    assert [item["retry_count"] for item in pending] == [1, 2, 3, 4]
    assert entry["scrobble_retryable"] is False
    assert entry["scrobble_retry_exhausted"] is True
    assert entry["sync_problem"]["status"] == "retry_exhausted"
    assert cleared == ["listen-not-connected"]


def test_reauthentication_required_retry_waits_for_successful_reconnect(monkeypatch):
    from datetime import datetime, timezone
    from music_app.services import lastfm_sync_bridge

    entry = {
        "id": "needs-reauth",
        "artist": "Artist",
        "title": "Song",
        "started_at_unix": 100,
        "scrobble_retry_count": 1,
        "last_scrobble_attempt_at": datetime.now(timezone.utc).isoformat(),
        "scrobble_reauthentication_required": True,
    }
    calls = []
    updates = []
    monkeypatch.setattr(lastfm_sync_bridge, "clear_pending_scrobble", lambda *args, **kwargs: None)

    blocked = lastfm_sync_bridge.process_pending_scrobble_attempt(
        {},
        entry,
        update_listen_history_entry=lambda *args: None,
        scrobble_track=lambda config, payload: calls.append(payload),
        log_lastfm_scrobble_event=lambda *args, **kwargs: None,
    )
    retried = lastfm_sync_bridge.process_pending_scrobble_attempt(
        {},
        entry,
        update_listen_history_entry=lambda config, entry_id, payload: updates.append(payload),
        scrobble_track=lambda config, payload: calls.append(payload),
        log_lastfm_scrobble_event=lambda *args, **kwargs: None,
        reauthenticated=True,
    )

    assert blocked == {"attempted": False, "succeeded": False, "failed": False}
    assert retried == {"attempted": True, "succeeded": True, "failed": False}
    assert len(calls) == 1
    assert updates[0]["scrobbled"] is True
