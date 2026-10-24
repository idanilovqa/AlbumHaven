"""UNRUN genuine measured writer and completion DTO, explicit DB/lock doubles."""
from contextlib import nullcontext
from copy import deepcopy
from types import SimpleNamespace

import pytest

from music_app.services import admin_authority
from music_app.services import measured_listen_history as measured
from music_app.services import lastfm_sync_bridge as bridge


IDENTITY = {"version": 1, "provider": "lastfm", "provider_username": "Historical user",
            "connection_started_at": "2026-10-20T10:00:00+00:00", "reply": None}


def entry():
    return {"measurement_version": "rendered-pcm-v1",
        "device_id": "00000000-0000-4000-8000-000000000001",
        "session_id": "00000000-0000-4000-8000-000000000002",
        "started_at": "2026-10-20T11:00:00+00:00", "started_at_unix": 1792494000,
        "source_provenance": {"kind": "local_playback", "provider": "album_haven"},
        "sequence": 1, "finalized": False,
        "measured_listened_seconds": 30.0, "max_measured_contiguous_seconds": 30.0,
        "scrobble_eligible": False, "path": "synthetic/track.flac"}


class Connection:
    def __init__(self, previous):
        self.current = None if previous is None else {
            "id": 91, "track_id": 44, "last_sequence": previous["sequence"],
            "measured_listened_seconds": previous["measured_listened_seconds"],
            "max_measured_contiguous_seconds": previous["max_measured_contiguous_seconds"],
            "finalized": previous["finalized"], "metadata": {"source_payload": deepcopy(previous)}}
        self.writes = []

    def __enter__(self): return self
    def __exit__(self, *_args): return False

    def execute(self, sql, params):
        if sql.startswith("select * from integration.listen_history"):
            assert params[:2] == (7, 9)
            return SimpleNamespace(fetchone=lambda: self.current)
        if sql.startswith(("insert into integration.listen_history", "update integration.listen_history set")):
            self.writes.append((sql, params))
            return SimpleNamespace()
        raise AssertionError(sql)


def append(monkeypatch, previous, incoming):
    connection = Connection(previous)
    monkeypatch.setattr(admin_authority, "lock_admin_accounts", lambda *_args: None)
    monkeypatch.setattr(measured, "lock_measured_identity", lambda *_args: None)
    monkeypatch.setattr(measured, "resolve_measured_track", lambda *_args: {"id": 44, "track_key": "synthetic-track"})
    adapter = SimpleNamespace(_connect_to_database=lambda: connection)
    return measured.append_measured(adapter, incoming, account_id=7, library_id=9), connection


def test_new_occurrence_cannot_inject_provider_identity(monkeypatch):
    incoming = {**entry(), "scrobble_submission_identity": {"reply": "forged"}}
    before = deepcopy(incoming)
    result, connection = append(monkeypatch, None, incoming)
    assert "scrobble_submission_identity" not in result
    assert "scrobble_submission_identity" not in connection.writes[0][1][-1].obj["source_payload"]
    assert incoming == before


@pytest.mark.parametrize("sequence", [0, 1, 2])
def test_progress_replay_preserves_stored_binding_and_rejects_injected_replacement(monkeypatch, sequence):
    previous = {**entry(), "scrobble_submission_identity": deepcopy(IDENTITY)}
    incoming = {**entry(), "sequence": sequence, "scrobble_submission_identity": {"reply": "forged"}}
    result, connection = append(monkeypatch, previous, incoming)
    assert result["scrobble_submission_identity"] == IDENTITY
    assert len(connection.writes) == (1 if sequence == 2 else 0)


def test_missing_old_identity_is_not_backfilled_by_progress(monkeypatch):
    result, _ = append(monkeypatch, entry(), {**entry(), "sequence": 2,
        "scrobble_submission_identity": deepcopy(IDENTITY)})
    assert "scrobble_submission_identity" not in result


def test_measured_completion_wire_entry_excludes_private_correlation_identity(monkeypatch):
    monkeypatch.setattr(bridge, "measured_provider_guard", lambda *_args, **_kwargs: nullcontext())
    stored = {**entry(), "id": "a" * 64, "scrobbled": True,
              "scrobble_submission_state": "accepted", "scrobble_submission_identity": deepcopy(IDENTITY)}
    response, status = bridge.record_playback_session_complete({}, entry(), user_timezone="UTC",
        account_id=7, library_id=9, normalize_playback_track_payload=lambda value: value,
        is_meaningful_listen_session=lambda _entry: True,
        append_listen_history_entry=lambda *_args, **_kwargs: deepcopy(stored),
        update_listen_history_entry=lambda *_args, **_kwargs: pytest.fail("No acknowledgement replay"),
        scrobble_track=lambda *_args, **_kwargs: pytest.fail("No resend"),
        log_lastfm_scrobble_event=lambda *_args, **_kwargs: None)
    assert status == 200 and response["scrobbled"] is True
    assert "scrobble_submission_identity" not in response["entry"]
    assert stored["scrobble_submission_identity"] == IDENTITY
