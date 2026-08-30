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

    def record(self, payload: dict[str, object]) -> tuple[dict[str, object], int]:
        from music_app.services.lastfm_sync_bridge import record_playback_session_complete
        from music_app.services.listen_history import is_meaningful_listen_session

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
