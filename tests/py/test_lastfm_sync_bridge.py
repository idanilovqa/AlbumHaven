from __future__ import annotations

import pytest


def test_lastfm_integration_status_reports_postgres_backed_local_orchestration(monkeypatch):
    from music_app.services import lastfm_sync_bridge

    monkeypatch.setattr(
        lastfm_sync_bridge,
        "load_lastfm_sync_state",
        lambda _config: {"sync_problems": {}, "last_retry_summary": {}},
    )

    status = lastfm_sync_bridge.build_lastfm_integration_status(
        {},
        base_status={"connected": True},
        listen_history_count=2,
        pending_scrobble_count=1,
    )

    assert status["sync_state_mode"] == "local_postgres_orchestration"


def _complete_payload(
    *,
    duration_seconds: object = 240,
    total_listened_seconds: object = 180,
    max_contiguous_seconds: object = 180,
    scrobbled: bool = False,
) -> dict[str, object]:
    return {
        "path": "C:/Music/Artist/Album/Song.flac",
        "title": "Song",
        "artist": "Artist",
        "album": "Album",
        "album_artist": "Artist",
        "started_at": "2026-05-13T12:00:00+00:00",
        "ended_at": "2026-05-13T12:04:00+00:00",
        "started_at_unix": 100,
        "duration_seconds": duration_seconds,
        "total_listened_seconds": total_listened_seconds,
        "max_contiguous_seconds": max_contiguous_seconds,
        "finished_fully": False,
        "skipped": True,
        "completion_reason": "track-change",
        "scrobbled": scrobbled,
        "track_number": "1",
        "request_origin": {
            "client_kind": "private_web",
            "origin_type": "browser_tab",
            "origin_id": "tab-123",
        },
    }


class _PlaybackCompleteHarness:
    def __init__(self) -> None:
        self.config = {"TESTING": True}
        self.scrobble_calls: list[dict[str, object]] = []
        self.appended_entries: list[dict[str, object]] = []
        self.updated_entries: list[dict[str, object]] = []
        self.logged_events: list[dict[str, object]] = []

    def normalize_payload(self, payload: dict[str, object]) -> dict[str, object]:
        return {
            "artist": str(payload.get("artist") or ""),
            "track": str(payload.get("title") or ""),
            "album": str(payload.get("album") or ""),
            "album_artist": str(payload.get("album_artist") or ""),
            "duration": int(float(payload.get("duration_seconds") or 0)),
            "track_number": str(payload.get("track_number") or ""),
            "timestamp": int(payload.get("started_at_unix") or 0),
            "request_origin": dict(payload.get("request_origin") or {}),
        }

    def append_entry(self, _config: dict[str, object], entry: dict[str, object]) -> dict[str, object]:
        stored = {**entry, "id": "listen-1"}
        self.appended_entries.append(stored)
        return stored

    def update_entry(
        self,
        _config: dict[str, object],
        entry_id: str,
        updates: dict[str, object],
    ) -> dict[str, object] | None:
        assert entry_id == "listen-1"
        updated = {**self.appended_entries[0], **updates}
        self.updated_entries.append(updated)
        return updated

    def scrobble_track(self, _config: dict[str, object], payload: dict[str, object]) -> None:
        self.scrobble_calls.append(payload)

    def log_event(self, action: str, **kwargs: object) -> None:
        self.logged_events.append({"action": action, **kwargs})

    def record(
        self, payload: dict[str, object], *, record_retryable_scrobble=None
    ) -> tuple[dict[str, object], int]:
        from music_app.services.lastfm_sync_bridge import record_playback_session_complete
        from music_app.services.listen_history import is_meaningful_listen_session

        kwargs = {}
        if record_retryable_scrobble is not None:
            kwargs["record_retryable_scrobble"] = record_retryable_scrobble
        return record_playback_session_complete(
            self.config,
            payload,
            user_timezone="America/Denver",
            normalize_playback_track_payload=self.normalize_payload,
            is_meaningful_listen_session=is_meaningful_listen_session,
            append_listen_history_entry=self.append_entry,
            update_listen_history_entry=self.update_entry,
            scrobble_track=self.scrobble_track,
            log_lastfm_scrobble_event=self.log_event,
            **kwargs,
        )


@pytest.mark.parametrize(
    ("duration_seconds", "listened_seconds"),
    [
        (120, 60),
        (700, 300),
    ],
)
def test_record_playback_session_complete_scrobbles_at_short_and_long_track_thresholds(
    monkeypatch,
    duration_seconds,
    listened_seconds,
):
    from music_app.services import lastfm_sync_bridge

    harness = _PlaybackCompleteHarness()
    cleared_listen_ids: list[str] = []
    monkeypatch.setattr(
        lastfm_sync_bridge,
        "clear_pending_scrobble",
        lambda _config, *, listen_id: cleared_listen_ids.append(listen_id),
    )

    response, status = harness.record(
        _complete_payload(
            duration_seconds=duration_seconds,
            total_listened_seconds=listened_seconds,
            max_contiguous_seconds=listened_seconds,
        )
    )

    assert status == 200
    assert response["ok"] is True
    assert response["scrobbled"] is True
    assert response["scrobble_error"] == ""
    assert harness.scrobble_calls == [
        {
            "artist": "Artist",
            "track": "Song",
            "album": "Album",
            "album_artist": "Artist",
            "duration": duration_seconds,
            "track_number": "1",
            "timestamp": 100,
            "request_origin": {
                "client_kind": "private_web",
                "origin_type": "browser_tab",
                "origin_id": "tab-123",
            },
        }
    ]
    assert harness.appended_entries[0]["scrobble_eligible"] is True
    assert harness.updated_entries[0]["scrobbled"] is True
    assert harness.updated_entries[0]["scrobble_retry_count"] == 1
    assert harness.updated_entries[0]["sync_problem"] is None
    assert cleared_listen_ids == ["listen-1"]
    assert harness.logged_events[0]["action"] == "Last.fm scrobble succeeded"


def test_record_playback_session_complete_queues_failed_scrobble_with_retry_problem(monkeypatch):
    from music_app.services import lastfm_sync_bridge
    from music_app.services.lastfm import LastfmError

    harness = _PlaybackCompleteHarness()
    pending_calls: list[dict[str, object]] = []

    def fail_scrobble(_config: dict[str, object], payload: dict[str, object]) -> None:
        harness.scrobble_calls.append(payload)
        raise LastfmError("Temporary Last.fm outage", retryable=True)

    def record_pending(_config: dict[str, object], **kwargs: object) -> None:
        pending_calls.append({"config": _config, **kwargs})

    monkeypatch.setattr(lastfm_sync_bridge, "record_pending_scrobble", record_pending)
    harness.scrobble_track = fail_scrobble

    response, status = harness.record(_complete_payload())

    assert status == 200
    assert response["ok"] is True
    assert response["scrobbled"] is False
    assert response["scrobble_error"] == "Temporary Last.fm outage"
    assert harness.scrobble_calls[0]["track"] == "Song"
    assert harness.updated_entries[0]["scrobbled"] is False
    assert harness.updated_entries[0]["scrobble_error"] == "Temporary Last.fm outage"
    assert harness.updated_entries[0]["scrobble_retry_count"] == 1
    assert harness.updated_entries[0]["sync_problem"] == {
        "provider": "lastfm",
        "kind": "scrobble",
        "status": "pending_retry",
        "message": "Temporary Last.fm outage",
    }
    assert pending_calls == [
        {
            "config": harness.config,
            "listen_id": "listen-1",
            "entry": harness.updated_entries[0],
            "retry_count": 1,
            "error": "Temporary Last.fm outage",
        }
    ]
    assert harness.logged_events[0]["action"] == "Last.fm scrobble queued"
    assert harness.logged_events[0]["level"] == "warning"
    assert harness.logged_events[0]["retry_count"] == 1


def test_retryable_playback_failure_uses_injected_atomic_durable_composer():
    from music_app.services.lastfm import LastfmError

    harness = _PlaybackCompleteHarness()
    durable_calls = []

    def fail_scrobble(_config, payload):
        harness.scrobble_calls.append(payload)
        raise LastfmError("provider busy", retryable=True)

    harness.scrobble_track = fail_scrobble
    response, status = harness.record(
        _complete_payload(),
        record_retryable_scrobble=lambda config, **values: durable_calls.append(
            (config, values)
        ),
    )

    assert status == 200 and response["scrobbled"] is False
    assert len(durable_calls) == 1
    assert durable_calls[0][1]["listen_id"] == "listen-1"
    assert durable_calls[0][1]["retry_count"] == 1


def test_durable_owned_playback_failure_is_excluded_from_legacy_retry_selector():
    from music_app.services.lastfm import LastfmError
    from music_app.services.listen_history import is_pending_scrobble_entry

    harness = _PlaybackCompleteHarness()
    harness.scrobble_track = lambda *_args: (_ for _ in ()).throw(
        LastfmError("provider busy", retryable=True)
    )
    response, status = harness.record(
        _complete_payload(),
        record_retryable_scrobble=lambda *_args, **_kwargs: object(),
    )

    assert status == 200
    assert response["entry"]["scrobble_durable_job_owned"] is True
    assert is_pending_scrobble_entry(response["entry"]) is False


@pytest.mark.parametrize("error_kind", ["network_error", "malformed_response"])
def test_possible_initial_send_is_marked_ambiguous_and_never_enqueued(
    error_kind, monkeypatch
):
    from music_app.services.lastfm import LastfmError
    from music_app.services import lastfm_sync_bridge

    harness = _PlaybackCompleteHarness()
    durable_calls = []
    monkeypatch.setattr(
        lastfm_sync_bridge, "clear_pending_scrobble", lambda *_args, **_kwargs: None
    )
    harness.scrobble_track = lambda *_args: (_ for _ in ()).throw(
        LastfmError("uncertain provider outcome", retryable=True, error_kind=error_kind)
    )

    response, status = harness.record(
        _complete_payload(),
        record_retryable_scrobble=lambda *_args, **kwargs: durable_calls.append(kwargs),
    )

    assert status == 200 and durable_calls == []
    assert response["entry"]["scrobble_retryable"] is False
    assert response["entry"]["sync_problem"]["status"] == "ambiguous"


def test_initial_reauthentication_failure_is_persisted_as_hold_not_immediate_job():
    from music_app.services.lastfm import LastfmError

    harness = _PlaybackCompleteHarness()
    durable_calls = []
    harness.scrobble_track = lambda *_args: (_ for _ in ()).throw(
        LastfmError("session expired", reauthentication_required=True)
    )

    harness.record(
        _complete_payload(),
        record_retryable_scrobble=lambda *_args, **kwargs: durable_calls.append(kwargs),
    )

    assert durable_calls[0]["reauthentication_required"] is True


@pytest.mark.parametrize("http_status", [429, 502, 503])
def test_record_playback_session_complete_queues_empty_transient_http_failure(monkeypatch, http_status):
    from music_app.services import lastfm_sync_bridge
    from music_app.services.lastfm import _lastfm_error_from_body

    harness = _PlaybackCompleteHarness()
    pending_calls: list[dict[str, object]] = []
    cleared_listen_ids: list[str] = []

    def fail_scrobble(_config: dict[str, object], payload: dict[str, object]) -> None:
        harness.scrobble_calls.append(payload)
        raise _lastfm_error_from_body(
            b"",
            fallback=f"Last.fm request failed with HTTP {http_status}.",
            http_status=http_status,
        )

    monkeypatch.setattr(
        lastfm_sync_bridge,
        "record_pending_scrobble",
        lambda _config, **kwargs: pending_calls.append({"config": _config, **kwargs}),
    )
    monkeypatch.setattr(
        lastfm_sync_bridge,
        "clear_pending_scrobble",
        lambda _config, *, listen_id: cleared_listen_ids.append(listen_id),
    )
    harness.scrobble_track = fail_scrobble

    response, status = harness.record(_complete_payload())

    assert status == 200
    assert response["scrobbled"] is False
    assert response["scrobble_error"] == f"Last.fm request failed with HTTP {http_status}."
    assert harness.updated_entries[0]["scrobble_retryable"] is True
    assert harness.updated_entries[0]["sync_problem"]["status"] == "pending_retry"
    assert pending_calls[0]["listen_id"] == "listen-1"
    assert cleared_listen_ids == []


def test_record_playback_session_complete_ignores_too_short_listens():
    harness = _PlaybackCompleteHarness()

    response, status = harness.record(
        _complete_payload(
            duration_seconds=120,
            total_listened_seconds=10,
            max_contiguous_seconds=10,
        )
    )

    assert status == 200
    assert response == {
        "ok": True,
        "entry": None,
        "scrobbled": False,
        "scrobble_error": "",
        "ignored": True,
    }
    assert harness.appended_entries == []
    assert harness.updated_entries == []
    assert harness.scrobble_calls == []
    assert harness.logged_events == []


def _record_measured_completion(monkeypatch, provider, durable_recorder):
    from contextlib import nullcontext

    from music_app.services import lastfm_sync_bridge
    from music_app.services.listen_history import is_meaningful_listen_session

    monkeypatch.setattr(
        lastfm_sync_bridge,
        "measured_provider_guard",
        lambda *_args, **_kwargs: nullcontext(),
    )
    stored = {}

    def append_entry(_config, entry, **scope):
        assert scope == {"account_id": 7, "library_id": 9}
        stored.update({**entry, "id": "measured-listen-1", "persisted": True})
        return dict(stored)

    def update_entry(_config, entry_id, updates, **scope):
        assert entry_id == "measured-listen-1"
        assert scope == {"account_id": 7, "library_id": 9}
        stored.update(updates)
        return dict(stored)

    payload = {
        **_complete_payload(),
        "measurement_version": "rendered-pcm-v1",
        "device_id": "cb94994e-b97e-4f92-968a-f9cb552a0694",
        "session_id": "45d9facc-f9f8-46e0-a590-6743394144f5",
        "sequence": 1,
        "finalized": True,
        "measured_listened_seconds": 180,
        "max_measured_contiguous_seconds": 180,
    }
    return lastfm_sync_bridge.record_playback_session_complete(
        {},
        payload,
        user_timezone="UTC",
        account_id=7,
        library_id=9,
        lastfm_session=object(),
        normalize_playback_track_payload=lambda value: value,
        is_meaningful_listen_session=is_meaningful_listen_session,
        append_listen_history_entry=append_entry,
        update_listen_history_entry=update_entry,
        scrobble_track=provider,
        log_lastfm_scrobble_event=lambda *_args, **_kwargs: None,
        record_retryable_scrobble=durable_recorder,
    )


@pytest.mark.parametrize(
    ("error", "expected_reauthentication"),
    [
        ("retryable", False),
        ("reauthentication", True),
    ],
)
def test_measured_known_not_sent_failure_is_accepted_by_durable_retry_owner(
    monkeypatch, error, expected_reauthentication
):
    from music_app.services.lastfm import LastfmError

    durable_calls = []

    def provider(*_args, **_kwargs):
        if error == "reauthentication":
            raise LastfmError(
                "session expired",
                code=9,
                reauthentication_required=True,
                error_kind="provider_error",
            )
        raise LastfmError(
            "provider busy", code=11, retryable=True, error_kind="provider_error"
        )

    body, status = _record_measured_completion(
        monkeypatch,
        provider,
        lambda config, **values: durable_calls.append((config, values)) or object(),
    )

    assert status == 200
    assert len(durable_calls) == 1
    config, values = durable_calls[0]
    assert config == {}
    assert values["listen_id"] == "measured-listen-1"
    assert values["entry"]["id"] == "measured-listen-1"
    assert values["entry"]["persisted"] is True
    assert values["entry"]["scrobble_submission_state"] == "not_sent"
    assert values["retry_count"] == 1
    assert values["error"] in {"provider busy", "session expired"}
    assert values.get("reauthentication_required", False) is expected_reauthentication
    assert body["entry"]["scrobble_durable_job_owned"] is True


def test_measured_retry_marks_durable_ownership_only_after_acceptance(monkeypatch):
    from music_app.services.lastfm import LastfmError

    body, status = _record_measured_completion(
        monkeypatch,
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            LastfmError(
                "provider busy", code=11, retryable=True, error_kind="provider_error"
            )
        ),
        lambda *_args, **_kwargs: None,
    )

    assert status == 200
    assert body["entry"].get("scrobble_durable_job_owned") is not True


@pytest.mark.parametrize("outcome", ["accepted", "sent", "uncertain", "permanent"])
def test_measured_non_retryable_provider_outcomes_are_never_durably_enqueued(
    monkeypatch, outcome
):
    from music_app.services.lastfm import LastfmError, LastfmSubmissionOutcome

    def provider(*_args, **_kwargs):
        if outcome == "accepted":
            return None
        if outcome == "sent":
            return LastfmSubmissionOutcome(
                sent=True,
                accepted=0,
                outcome="unconfirmed",
                message="provider receipt unavailable",
            )
        if outcome == "uncertain":
            raise LastfmError(
                "possible send", retryable=True, error_kind="network_error"
            )
        raise LastfmError(
            "permanent rejection", code=6, retryable=False, error_kind="provider_error"
        )

    durable_calls = []
    body, status = _record_measured_completion(
        monkeypatch,
        provider,
        lambda *_args, **values: durable_calls.append(values) or object(),
    )

    assert status == 200
    assert durable_calls == []
    assert body["entry"].get("scrobble_durable_job_owned") is not True
