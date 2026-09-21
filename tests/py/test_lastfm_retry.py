from __future__ import annotations

from types import SimpleNamespace

import pytest

from music_app.services.listen_history_postgres import PendingListenEntry


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

    monkeypatch.setattr(lastfm_retry, "get_saved_lastfm_session", lambda config, *, account_id: SimpleNamespace(username="owned") if account_id == 7 else None)
    monkeypatch.setattr(lastfm_retry, "load_pending_scrobble_entries", lambda config, limit, *, eligible: list(filter(eligible, [PendingListenEntry(entry, account_id=7, library_id=9, row_id=11)]))[:limit])
    monkeypatch.setattr(
        lastfm_retry,
        "update_listen_history_entry",
        lambda config, entry_id, payload, **scope: updates.append(payload) or {**entry, **payload},
    )
    monkeypatch.setattr(lastfm_retry, "scrobble_track", lambda config, payload, *, session: calls.append(payload))
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

    def fail_scrobble(config, payload, *, session):
        raise LastfmError("Temporary failure", retryable=True)

    monkeypatch.setattr(lastfm_retry, "get_saved_lastfm_session", lambda config, *, account_id: SimpleNamespace(username="owned") if account_id == 7 else None)
    monkeypatch.setattr(lastfm_retry, "load_pending_scrobble_entries", lambda config, limit, *, eligible: list(filter(eligible, [PendingListenEntry(entry, account_id=7, library_id=9, row_id=11)]))[:limit])
    monkeypatch.setattr(
        lastfm_retry,
        "update_listen_history_entry",
        lambda config, entry_id, payload, **scope: updates.append(payload) or {**entry, **payload},
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
        update_listen_history_entry=lambda config, entry_id, payload, **scope: updates.append(payload) or {**entry, **payload},
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


def test_invalid_pending_scrobble_payload_fails_without_provider_attempt(monkeypatch):
    from music_app.services import lastfm_sync_bridge

    entry = {
        "id": "listen-invalid",
        "title": "Song",
        "started_at_unix": 100,
        "scrobble_eligible": True,
        "scrobbled": False,
    }
    provider_calls = []
    monkeypatch.setattr(
        lastfm_sync_bridge,
        "clear_pending_scrobble",
        lambda *args, **kwargs: None,
    )

    result = lastfm_sync_bridge.process_pending_scrobble_attempt(
        {},
        entry,
        update_listen_history_entry=lambda _config, _entry_id, updates: {**entry, **updates},
        scrobble_track=lambda _config, payload: provider_calls.append(payload),
        log_lastfm_scrobble_event=lambda *args, **kwargs: None,
    )

    assert result == {"attempted": False, "succeeded": False, "failed": True}
    assert provider_calls == []


def test_retry_batch_counts_invalid_payload_failure_without_attempt(monkeypatch):
    from music_app.services import lastfm_retry
    from music_app.services import lastfm_sync_bridge

    entry = {
        "id": "listen-invalid",
        "title": "Song",
        "started_at_unix": 100,
        "scrobble_eligible": True,
        "scrobbled": False,
    }
    provider_calls = []
    monkeypatch.setattr(lastfm_retry, "get_saved_lastfm_session", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(
        lastfm_retry,
        "load_pending_scrobble_entries",
        lambda *_args, **_kwargs: [PendingListenEntry(entry, 7, 9, 11)],
    )
    monkeypatch.setattr(
        lastfm_retry,
        "update_listen_history_entry",
        lambda _config, _entry_id, updates, **_scope: {**entry, **updates},
    )
    monkeypatch.setattr(
        lastfm_retry,
        "scrobble_track",
        lambda _config, payload, *, session: provider_calls.append((payload, session)),
    )
    monkeypatch.setattr(lastfm_retry, "pending_scrobble_count", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(lastfm_retry, "record_retry_summary", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(lastfm_sync_bridge, "clear_pending_scrobble", lambda *args, **kwargs: None)

    summary = lastfm_retry.retry_pending_lastfm_scrobbles(
        {"LASTFM_API_ENABLED": True},
        account_id=7,
        library_id=9,
        bypass_backoff=True,
    )

    assert summary == {
        "pending_before": 1,
        "attempted": 0,
        "succeeded": 0,
        "failed": 1,
        "pending_after": 0,
    }
    assert provider_calls == []


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


def test_manual_retry_bypasses_only_time_backoff(monkeypatch):
    from datetime import datetime, timezone
    from music_app.services import lastfm_sync_bridge

    calls = []
    deferred = {
        "id": "deferred",
        "artist": "Artist",
        "title": "Song",
        "started_at_unix": 100,
        "scrobble_retry_count": 1,
        "last_scrobble_attempt_at": datetime.now(timezone.utc).isoformat(),
    }
    reauthentication_required = {
        **deferred,
        "id": "reauth-required",
        "scrobble_reauthentication_required": True,
    }
    monkeypatch.setattr(lastfm_sync_bridge, "clear_pending_scrobble", lambda *args, **kwargs: None)

    submitted = lastfm_sync_bridge.process_pending_scrobble_attempt(
        {}, deferred,
        update_listen_history_entry=lambda _config, _entry_id, updates: {**deferred, **updates},
        scrobble_track=lambda _config, payload: calls.append(payload) or SimpleNamespace(succeeded=True),
        log_lastfm_scrobble_event=lambda *args, **kwargs: None,
        bypass_backoff=True,
    )
    blocked = lastfm_sync_bridge.process_pending_scrobble_attempt(
        {}, reauthentication_required,
        update_listen_history_entry=lambda *args, **kwargs: None,
        scrobble_track=lambda _config, payload: calls.append(payload),
        log_lastfm_scrobble_event=lambda *args, **kwargs: None,
        bypass_backoff=True,
    )

    assert submitted == {"attempted": True, "succeeded": True, "failed": False}
    assert blocked == {"attempted": False, "succeeded": False, "failed": False}
    assert len(calls) == 1


def test_retry_scope_includes_account_and_library_and_counts_nonattempt_failure(monkeypatch):
    from music_app.services import lastfm_retry

    config = {"LASTFM_API_ENABLED": True}
    entries = [
        PendingListenEntry({"id": "target", "scrobble_retry_count": 5}, 7, 9, 11),
        PendingListenEntry({"id": "other-library"}, 7, 10, 12),
        PendingListenEntry({"id": "other-account"}, 8, 9, 13),
    ]
    seen = []
    monkeypatch.setattr(lastfm_retry, "get_saved_lastfm_session", lambda _config, *, account_id: object())
    monkeypatch.setattr(
        lastfm_retry, "load_pending_scrobble_entries",
        lambda _config, limit, *, eligible: [item for item in entries if eligible(item)][:limit],
    )
    monkeypatch.setattr(lastfm_retry, "update_listen_history_entry", lambda *args, **kwargs: seen.append(args[1]) or {})
    monkeypatch.setattr(lastfm_retry, "pending_scrobble_count", lambda _config, **scope: 0)
    monkeypatch.setattr(lastfm_retry, "record_retry_summary", lambda *args, **kwargs: None)
    monkeypatch.setattr("music_app.services.lastfm_sync_bridge.clear_pending_scrobble", lambda *args, **kwargs: None)

    summary = lastfm_retry.retry_pending_lastfm_scrobbles(
        config, account_id=7, library_id=9, bypass_backoff=True,
    )

    assert seen == ["target"]
    assert summary == {
        "pending_before": 1, "attempted": 0, "succeeded": 0,
        "failed": 1, "pending_after": 0,
    }


def test_manual_retry_suppresses_per_row_history_while_worker_retry_preserves_it(monkeypatch):
    from music_app.services import lastfm_retry

    entry = PendingListenEntry({
        "id": "listen-1", "artist": "Private Artist", "album": "Private Album",
        "title": "Private Track",
    }, 7, 9, 11)
    events = []

    def process(*_args, log_lastfm_scrobble_event, **_kwargs):
        log_lastfm_scrobble_event(
            "Last.fm scrobble failed",
            level="error",
            payload={"artist": "Private Artist", "album": "Private Album", "track": "Private Track"},
            error="private provider body",
        )
        return {"attempted": True, "succeeded": False, "failed": True}

    monkeypatch.setattr(lastfm_retry, "get_saved_lastfm_session", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(lastfm_retry, "load_pending_scrobble_entries", lambda *_args, **_kwargs: [entry])
    monkeypatch.setattr(lastfm_retry, "process_pending_scrobble_attempt", process)
    monkeypatch.setattr(lastfm_retry, "pending_scrobble_count", lambda *_args, **_kwargs: 1)
    monkeypatch.setattr(lastfm_retry, "record_retry_summary", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(lastfm_retry, "log_app_event", lambda *args, **kwargs: events.append((args, kwargs)))

    lastfm_retry.retry_pending_lastfm_scrobbles(
        {"LASTFM_API_ENABLED": True}, account_id=7, library_id=9, bypass_backoff=True,
    )
    assert events == []

    lastfm_retry.retry_pending_lastfm_scrobbles(
        {"LASTFM_API_ENABLED": True}, account_id=7, library_id=9,
    )
    assert len(events) == 1
    assert events[0][1]["artist"] == "Private Artist"
    assert events[0][1]["error"] == "private provider body"


def test_retry_batch_error_preserves_completed_aggregate_progress(monkeypatch):
    from music_app.services import lastfm_retry

    entries = [
        PendingListenEntry({"id": "first"}, 7, 9, 11),
        PendingListenEntry({"id": "second"}, 7, 9, 12),
    ]
    calls = 0

    def process(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("private provider response")
        return {"attempted": True, "succeeded": True, "failed": False}

    monkeypatch.setattr(lastfm_retry, "get_saved_lastfm_session", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(lastfm_retry, "load_pending_scrobble_entries", lambda *_args, **_kwargs: entries)
    monkeypatch.setattr(lastfm_retry, "process_pending_scrobble_attempt", process)
    monkeypatch.setattr(lastfm_retry, "pending_scrobble_count", lambda *_args, **_kwargs: 1)

    with pytest.raises(lastfm_retry.LastfmRetryBatchError) as error:
        lastfm_retry.retry_pending_lastfm_scrobbles(
            {"LASTFM_API_ENABLED": True}, account_id=7, library_id=9, bypass_backoff=True,
        )

    assert error.value.summary == {
        "pending_before": 2, "attempted": 1, "succeeded": 1,
        "failed": 1, "pending_after": 1,
    }
    assert "private provider response" not in str(error.value)


def test_retry_batch_error_survives_pending_recount_failure(monkeypatch):
    from music_app.services import lastfm_retry

    entries = [
        PendingListenEntry({"id": "first"}, 7, 9, 11),
        PendingListenEntry({"id": "second"}, 7, 9, 12),
    ]
    calls = 0

    def process(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("row failure")
        return {"attempted": True, "succeeded": True, "failed": False}

    monkeypatch.setattr(lastfm_retry, "get_saved_lastfm_session", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(lastfm_retry, "load_pending_scrobble_entries", lambda *_args, **_kwargs: entries)
    monkeypatch.setattr(lastfm_retry, "process_pending_scrobble_attempt", process)
    monkeypatch.setattr(
        lastfm_retry,
        "pending_scrobble_count",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("recount failure")),
    )

    with pytest.raises(lastfm_retry.LastfmRetryBatchError) as error:
        lastfm_retry.retry_pending_lastfm_scrobbles(
            {"LASTFM_API_ENABLED": True}, account_id=7, library_id=9, bypass_backoff=True,
        )

    assert error.value.summary == {
        "pending_before": 2,
        "attempted": 1,
        "succeeded": 1,
        "failed": 1,
        "pending_after": 2,
    }


def test_pending_count_preserves_existing_account_only_retry_scope(monkeypatch):
    from music_app.services import lastfm_retry

    entries = [
        PendingListenEntry({"id": "owned"}, 7, 9, 11),
        PendingListenEntry({"id": "other"}, 8, 10, 12),
    ]
    monkeypatch.setattr(
        lastfm_retry, "load_pending_scrobble_entries",
        lambda _config, limit, *, eligible=None: [
            item for item in entries if eligible is None or eligible(item)
        ][:limit],
    )

    assert lastfm_retry.pending_scrobble_count({}, account_id=7) == 1


def test_manual_measured_retry_uses_shared_guards_and_retry_bookkeeping(monkeypatch):
    from datetime import datetime, timezone
    from music_app.services import lastfm_retry, lastfm_sync_bridge

    base = {
        "measurement_version": "rendered-pcm-v1",
        "artist": "Artist",
        "title": "Song",
        "started_at_unix": 100,
        "scrobble_eligible": True,
        "scrobble_retryable": True,
        "scrobbled": False,
    }
    entries = [
        PendingListenEntry({
            **base,
            "id": "eligible",
            "scrobble_retry_count": 1,
            "last_scrobble_attempt_at": datetime.now(timezone.utc).isoformat(),
        }, 7, 9, 11),
        PendingListenEntry({
            **base,
            "id": "reauth",
            "scrobble_reauthentication_required": True,
        }, 7, 9, 12),
        PendingListenEntry({
            **base,
            "id": "exhausted",
            "scrobble_retry_count": 5,
        }, 7, 9, 13),
        PendingListenEntry({
            **base,
            "id": "uncertain",
            "scrobble_submission_state": "uncertain",
        }, 7, 9, 14),
    ]
    provider_calls = []
    updates = []
    monkeypatch.setattr(lastfm_retry, "get_saved_lastfm_session", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(
        lastfm_retry,
        "load_pending_scrobble_entries",
        lambda _config, limit, *, eligible: [item for item in entries if eligible(item)][:limit],
    )
    monkeypatch.setattr(
        lastfm_retry,
        "record_playback_session_complete",
        lambda _config, payload, **_kwargs: (
            provider_calls.append(payload["id"])
            or ({"scrobbled": True, "entry": {**payload, "scrobbled": True}}, 200)
        ),
    )
    monkeypatch.setattr(
        lastfm_retry,
        "update_listen_history_entry",
        lambda _config, entry_id, payload, **scope: (
            updates.append((entry_id, dict(payload), scope))
            or {**next(item.entry for item in entries if item.entry["id"] == entry_id), **payload}
        ),
    )
    monkeypatch.setattr(lastfm_retry, "pending_scrobble_count", lambda *_args, **_kwargs: 2)
    monkeypatch.setattr(
        lastfm_sync_bridge,
        "clear_pending_scrobble",
        lambda *_args, **_kwargs: pytest.fail(
            "Measured retries must not mutate the legacy sync-state collection"
        ),
    )

    summary = lastfm_retry.retry_pending_lastfm_scrobbles(
        {"LASTFM_API_ENABLED": True},
        account_id=7,
        library_id=9,
        bypass_backoff=True,
    )

    assert provider_calls == ["eligible"]
    assert summary == {
        "pending_before": 4,
        "attempted": 1,
        "succeeded": 1,
        "failed": 1,
        "pending_after": 2,
    }
    eligible_updates = [payload for entry_id, payload, _scope in updates if entry_id == "eligible"]
    assert eligible_updates[-1]["scrobble_retry_count"] == 2
    assert eligible_updates[-1]["last_scrobble_attempt_at"]
    exhausted_updates = [payload for entry_id, payload, _scope in updates if entry_id == "exhausted"]
    assert exhausted_updates[-1]["scrobble_retry_exhausted"] is True


def test_manual_measured_retry_counts_retryable_provider_failure_as_attempted(monkeypatch):
    from contextlib import nullcontext

    from music_app.services import lastfm_retry, lastfm_sync_bridge, measured_listen_history
    from music_app.services.lastfm import LastfmError

    entry = {
        "id": "measured-retryable",
        "measurement_version": "rendered-pcm-v1",
        "device_id": "device-1",
        "session_id": "session-1",
        "sequence": 1,
        "artist": "Artist",
        "title": "Song",
        "started_at_unix": 100,
        "scrobble_eligible": True,
        "scrobble_retryable": True,
        "scrobbled": False,
    }
    pending = PendingListenEntry(entry, 7, 9, 11)
    stored = dict(entry)
    provider_calls = []

    def update_entry(_config, entry_id, updates, **_scope):
        assert entry_id == entry["id"]
        stored.update(updates)
        return dict(stored)

    def fail_scrobble(_config, payload, *, session):
        provider_calls.append((dict(payload), session))
        raise LastfmError("Service Offline", code=11, retryable=True)

    monkeypatch.setattr(lastfm_retry, "get_saved_lastfm_session", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(
        lastfm_retry, "load_pending_scrobble_entries",
        lambda _config, limit, *, eligible: [pending] if eligible(pending) else [],
    )
    monkeypatch.setattr(lastfm_retry, "update_listen_history_entry", update_entry)
    monkeypatch.setattr(lastfm_retry, "pending_scrobble_count", lambda *_args, **_kwargs: 1)
    monkeypatch.setattr(lastfm_retry, "is_meaningful_listen_session", lambda _entry: True)
    monkeypatch.setattr(lastfm_retry, "normalize_playback_track_payload", lambda payload: dict(payload))
    monkeypatch.setattr(lastfm_retry, "scrobble_track", fail_scrobble)
    monkeypatch.setattr(measured_listen_history, "normalize_measurement", lambda item, **_scope: item)
    monkeypatch.setattr(lastfm_sync_bridge, "measured_provider_guard", lambda *_args, **_kwargs: nullcontext())
    monkeypatch.setattr(
        lastfm_sync_bridge,
        "record_pending_scrobble",
        lambda *_args, **_kwargs: pytest.fail(
            "Measured retries must not mutate the legacy sync-state collection"
        ),
    )
    monkeypatch.setattr(
        lastfm_sync_bridge,
        "clear_pending_scrobble",
        lambda *_args, **_kwargs: pytest.fail(
            "Measured retries must not mutate the legacy sync-state collection"
        ),
    )

    summary = lastfm_retry.retry_pending_lastfm_scrobbles(
        {"LASTFM_API_ENABLED": True},
        account_id=7,
        library_id=9,
        bypass_backoff=True,
    )

    assert len(provider_calls) == 1
    assert stored["scrobble_submission_state"] == "not_sent"
    assert stored["scrobble_retryable"] is True
    assert summary == {
        "pending_before": 1,
        "attempted": 1,
        "succeeded": 0,
        "failed": 1,
        "pending_after": 1,
    }


def test_manual_measured_retry_persists_code_9_guard_and_does_not_resubmit(monkeypatch):
    from contextlib import nullcontext

    from music_app.services import lastfm_retry, lastfm_sync_bridge, measured_listen_history
    from music_app.services.lastfm import LastfmError

    stored = {
        "id": "measured-reauthentication-required",
        "measurement_version": "rendered-pcm-v1",
        "device_id": "device-1",
        "session_id": "session-1",
        "sequence": 1,
        "artist": "Artist",
        "title": "Song",
        "started_at_unix": 100,
        "scrobble_eligible": True,
        "scrobble_retryable": True,
        "scrobbled": False,
    }
    provider_calls = []

    def load_pending(_config, limit, *, eligible):
        pending = PendingListenEntry(dict(stored), 7, 9, 11)
        return [pending] if limit and eligible(pending) else []

    def update_entry(_config, entry_id, updates, **_scope):
        assert entry_id == stored["id"]
        stored.update(updates)
        return dict(stored)

    def code_9_scrobble(_config, payload, *, session):
        provider_calls.append((dict(payload), session))
        if len(provider_calls) == 1:
            raise LastfmError(
                "Invalid session key (Last.fm error 9)",
                code=9,
                reauthentication_required=True,
            )
        return SimpleNamespace(succeeded=True, sent=True)

    monkeypatch.setattr(lastfm_retry, "get_saved_lastfm_session", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(lastfm_retry, "load_pending_scrobble_entries", load_pending)
    monkeypatch.setattr(lastfm_retry, "update_listen_history_entry", update_entry)
    monkeypatch.setattr(
        lastfm_retry,
        "pending_scrobble_count",
        lambda *_args, **_kwargs: 0 if stored.get("scrobbled") else 1,
    )
    monkeypatch.setattr(lastfm_retry, "is_meaningful_listen_session", lambda _entry: True)
    monkeypatch.setattr(lastfm_retry, "normalize_playback_track_payload", lambda payload: dict(payload))
    monkeypatch.setattr(lastfm_retry, "scrobble_track", code_9_scrobble)
    monkeypatch.setattr(measured_listen_history, "normalize_measurement", lambda item, **_scope: item)
    monkeypatch.setattr(lastfm_sync_bridge, "measured_provider_guard", lambda *_args, **_kwargs: nullcontext())
    monkeypatch.setattr(
        lastfm_sync_bridge,
        "record_pending_scrobble",
        lambda *_args, **_kwargs: pytest.fail(
            "Measured retries must not mutate the legacy sync-state collection"
        ),
    )
    monkeypatch.setattr(
        lastfm_sync_bridge,
        "clear_pending_scrobble",
        lambda *_args, **_kwargs: pytest.fail(
            "Measured retries must not mutate the legacy sync-state collection"
        ),
    )

    first = lastfm_retry.retry_pending_lastfm_scrobbles(
        {"LASTFM_API_ENABLED": True},
        account_id=7,
        library_id=9,
        bypass_backoff=True,
    )
    second = lastfm_retry.retry_pending_lastfm_scrobbles(
        {"LASTFM_API_ENABLED": True},
        account_id=7,
        library_id=9,
        bypass_backoff=True,
    )
    provider_calls_after_manual_retry = len(provider_calls)
    blocked_state = {
        "reauthentication_required": stored.get("scrobble_reauthentication_required"),
        "retryable": stored.get("scrobble_retryable"),
        "sync_problem_status": (stored.get("sync_problem") or {}).get("status"),
    }
    reconnected = lastfm_retry.retry_pending_lastfm_scrobbles(
        {"LASTFM_API_ENABLED": True},
        account_id=7,
        library_id=9,
        reauthenticated=True,
    )

    assert first == {
        "pending_before": 1,
        "attempted": 1,
        "succeeded": 0,
        "failed": 1,
        "pending_after": 1,
    }
    assert second == {
        "pending_before": 1,
        "attempted": 0,
        "succeeded": 0,
        "failed": 0,
        "pending_after": 1,
    }
    assert provider_calls_after_manual_retry == 1
    assert blocked_state == {
        "reauthentication_required": True,
        "retryable": True,
        "sync_problem_status": "reauthentication_required",
    }
    assert reconnected == {
        "pending_before": 1,
        "attempted": 1,
        "succeeded": 1,
        "failed": 0,
        "pending_after": 0,
    }
    assert len(provider_calls) == 2
    assert stored["scrobble_reauthentication_required"] is False
    assert stored["scrobbled"] is True


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
