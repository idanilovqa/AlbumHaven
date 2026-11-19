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


def test_an_unmeasured_completion_is_refused_before_anything_is_stored_or_sent():
    from music_app.services.lastfm_sync_bridge import record_playback_session_complete
    from music_app.services.measured_listen_history import MeasuredListenError

    def forbidden(*_args, **_kwargs):
        pytest.fail("an unmeasured completion reached storage or Last.fm")

    with pytest.raises(MeasuredListenError):
        record_playback_session_complete(
            {}, _complete_payload(), user_timezone="UTC", normalize_playback_track_payload=forbidden,
            is_meaningful_listen_session=forbidden, append_listen_history_entry=forbidden,
            update_listen_history_entry=forbidden, scrobble_track=forbidden, log_lastfm_scrobble_event=forbidden,
        )


@pytest.mark.parametrize(("error_kind", "expected"), [
    # The request never left the server: sending it again cannot count it twice.
    ("configuration_error", ("not_sent", True, "pending_retry")),
    # A timeout or unreadable answer after the POST may have been recorded.
    ("network_error", ("uncertain", False, "permanent_failure")),
    ("malformed_response", ("uncertain", False, "permanent_failure")),
])
def test_measured_completion_retries_only_a_failure_last_fm_cannot_have_recorded(monkeypatch, error_kind, expected):
    from contextlib import nullcontext

    from music_app.services import lastfm_sync_bridge
    from music_app.services.lastfm import LastfmError
    from music_app.services.listen_history import is_meaningful_listen_session

    stored: dict[str, object] = {}
    monkeypatch.setattr(
        lastfm_sync_bridge,
        "measured_provider_guard",
        lambda *_args, **_kwargs: nullcontext(),
    )

    def append_entry(_config, entry, **_scope):
        stored.update(entry, id="listen-1")
        return dict(stored)

    def update_entry(_config, entry_id, updates, **_scope):
        assert entry_id == "listen-1"
        stored.update(updates)
        return dict(stored)

    def failing_submission(_config, _payload, *, session):
        assert session is not None
        raise LastfmError("Last.fm submission failed.", retryable=True, error_kind=error_kind)

    payload = {
        **_complete_payload(),
        "measurement_version": "rendered-pcm-v1",
        "device_id": "11111111-1111-4111-8111-111111111111",
        "session_id": "22222222-2222-4222-8222-222222222222",
        "sequence": 1,
        "finalized": True,
        "measured_listened_seconds": 180.0,
        "max_measured_contiguous_seconds": 180.0,
    }
    response, status = lastfm_sync_bridge.record_playback_session_complete(
        {},
        payload,
        account_id=1,
        library_id=1,
        lastfm_session=object(),
        user_timezone="UTC",
        normalize_playback_track_payload=lambda value: value,
        is_meaningful_listen_session=is_meaningful_listen_session,
        append_listen_history_entry=append_entry,
        update_listen_history_entry=update_entry,
        scrobble_track=failing_submission,
        log_lastfm_scrobble_event=lambda *_args, **_kwargs: None,
    )

    assert status == 200
    assert response["scrobbled"] is False
    assert (
        stored["scrobble_submission_state"], stored["scrobble_retryable"], stored["sync_problem"]["status"]
    ) == expected
    assert stored["scrobble_retry_count"] == 1
