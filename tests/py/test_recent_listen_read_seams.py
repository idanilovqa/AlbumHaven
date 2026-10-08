"""Actor-owned Recent contracts; repository doubles here are unit seams only."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from music_app.services import listen_history as history
from music_app.services import recent_listen_read_seams as recent
from music_app.services.allowed_actions import AllowedActions
from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter


NOW = datetime(2026, 10, 3, 12, tzinfo=timezone.utc)
START = NOW - timedelta(days=7)
CONFIG = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://localhost/pytest_recent_unit"}
MEASURED = "rendered_local_listen_session"
LEGACY = "runtime_listen_history_adapter"
BACKFILL = "phase_6_json_file_backfill"
PRIVATE_PATH = "/private/recent-fixture/track.flac"


def ledger_row(row_id=1, *, source=MEASURED, **changes):
    measured = source == MEASURED
    result = {
        "id": row_id, "account_id": 41, "library_id": 73,
        "track_id": 101, "track_key": "track-101", "album_id": 201,
        "played_at": NOW - timedelta(hours=1), "source_family": source,
        "measurement_version": "rendered-pcm-v1" if measured else None,
        "finalized": True if measured else None,
        "measured_listened_seconds": 12.5 if measured else None,
        "metadata": {"source_payload": {
            "title": "Track", "artist": "Artist", "album_artist": "Artist",
            "album": "Album", "path": PRIVATE_PATH, "track_ref": PRIVATE_PATH,
            "total_listened_seconds": 90, "max_contiguous_seconds": 30,
            "started_at": (NOW - timedelta(days=30)).isoformat(),
            "recorded_at": (NOW + timedelta(days=30)).isoformat(),
            "source_provenance": {"kind": "local_playback"},
            "private_provider_token": "never-in-a-recent-dto",
        }},
    }
    result.update(changes)
    return result


def album_candidate(**changes):
    result = {
        "id": 201, "key": "album-201", "name": "Album", "album_artist": "Artist",
        "album_track_count": 2, "total_duration_seconds": 240, "can_play": True,
        "legacy_track_refs": {PRIVATE_PATH: 101, "track-101": 101},
    }
    result.update(changes)
    return result


@pytest.fixture
def repository(monkeypatch):
    state = {"rows": [], "albums": [], "calls": [], "timezone": "UTC", "timezone_accounts": []}

    def load_items(_self, **kwargs):
        state["calls"].append(("items", kwargs))
        return deepcopy(state["rows"])

    def load_albums(_self, **kwargs):
        state["calls"].append(("albums", kwargs))
        assert kwargs["library_id"] == 73
        return deepcopy(state["albums"])

    def saved_timezone(_config, *, account_id):
        state["timezone_accounts"].append(account_id)
        return state["timezone"]

    monkeypatch.setattr(PostgresListenHistoryAdapter, "load_recent_items", load_items, raising=False)
    monkeypatch.setattr(PostgresListenHistoryAdapter, "load_recent_album_candidates", load_albums, raising=False)
    monkeypatch.setattr(recent, "get_lastfm_user_timezone", saved_timezone)
    return state


def read_events(**changes):
    kwargs = {"account_id": 41, "library_id": 73, "window_start": START, "window_end": NOW}
    kwargs.update(changes)
    return history.load_recent_listen_history(CONFIG, **kwargs)


def build_recent(*, now=NOW, actions=("library.browse.read", "library.media.read")):
    return recent.build_recent_listen_payloads(
        CONFIG, account_id=41, library_id=73, now=now,
        allowed_actions_for_album=lambda _album: AllowedActions(tuple(actions)),
    )


@pytest.mark.parametrize("field", ["account_id", "library_id"])
@pytest.mark.parametrize("value", [None, True, 0, -1, "41", 1.5])
def test_recent_scope_is_required_before_repository_read(repository, field, value):
    with pytest.raises(ValueError):
        read_events(**{field: value})
    assert repository["calls"] == []


@pytest.mark.parametrize("changes,accepted", [
    ({}, True), ({"measured_listened_seconds": 10}, False),
    ({"measured_listened_seconds": 10.0001}, True), ({"finalized": False}, False),
    ({"finalized": "true"}, False), ({"measurement_version": "future-v2"}, False),
    ({"source_family": "unapproved_source"}, False),
    ({"measured_listened_seconds": float("nan")}, False),
    ({"measured_listened_seconds": float("inf")}, False),
    ({"measured_listened_seconds": True}, False),
    ({"measured_listened_seconds": "12.5"}, False),
    ({"account_id": 42}, False), ({"library_id": 74}, False),
])
def test_measured_read_uses_valid_finalized_typed_values(repository, changes, accepted):
    row = ledger_row(**changes)
    row["metadata"]["source_payload"].update({
        "account_id": 41, "library_id": 73, "finalized": True,
        "measured_listened_seconds": 999, "total_listened_seconds": 999,
    })
    repository["rows"] = [row]
    events = read_events()
    assert len(events) == int(accepted)
    if accepted:
        assert events[0]["row_id"] == row["id"]
        assert events[0]["listened_seconds"] == row["measured_listened_seconds"]
        assert events[0]["played_at"] == row["played_at"]
        assert events[0]["time_provenance"] == "measured_started_at"


@pytest.mark.parametrize("source", [LEGACY, BACKFILL])
@pytest.mark.parametrize("total,contiguous,accepted", [
    (10, 0, False), (10.0004, 0, False), (10.001, 0, True),
    (5, 12, True), (10.0004, 12, True), (float("inf"), 30, False),
    (30, float("nan"), False), ("malformed", 30, False),
])
def test_legacy_qualification_preserves_finite_three_decimal_rule(
    repository, source, total, contiguous, accepted,
):
    row = ledger_row(source=source)
    row["metadata"]["source_payload"].update({
        "total_listened_seconds": total, "max_contiguous_seconds": contiguous,
    })
    repository["rows"] = [row]
    events = read_events()
    assert len(events) == int(accepted)
    if accepted:
        assert events[0]["played_at"] == row["played_at"]
        assert events[0]["time_provenance"] == "legacy_recorded_at"
        assert events[0]["listened_seconds"] == total


def test_read_enforces_inclusive_typed_time_bounds_without_session_dedup(repository):
    repository["rows"] = [
        ledger_row(1, played_at=START - timedelta(microseconds=1)),
        ledger_row(2, played_at=START), ledger_row(3, played_at=NOW),
        ledger_row(4, played_at=NOW),
        ledger_row(5, played_at=NOW + timedelta(microseconds=1)),
        ledger_row(6, played_at="malformed"),
    ]
    events = read_events()
    assert [event["row_id"] for event in events] == [2, 3, 4]
    assert events[1]["played_at"] == events[2]["played_at"] == NOW


@pytest.mark.parametrize("now,expected_start", [
    (datetime(2026, 3, 10, 16, tzinfo=timezone.utc), datetime(2026, 3, 3, 17, tzinfo=timezone.utc)),
    (datetime(2026, 11, 3, 17, tzinfo=timezone.utc), datetime(2026, 10, 27, 16, tzinfo=timezone.utc)),
])
def test_recent_window_uses_accounts_seven_local_calendar_days(repository, now, expected_start):
    repository["timezone"] = "America/New_York"
    assert build_recent(now=now) == {"recent_local_albums": [], "recent_not_local_albums": []}
    assert repository["timezone_accounts"] == [41]
    item_call = next(kwargs for name, kwargs in repository["calls"] if name == "items")
    assert item_call == {
        "account_id": 41, "library_id": 73, "window_start": expected_start, "window_end": now,
    }


@pytest.mark.parametrize("saved_timezone", ["", "Not/A_Timezone"])
@pytest.mark.parametrize("now_parts,expected_start,elapsed_hours", [
    ((2026, 3, 10, 16), datetime(2026, 3, 3, 17, tzinfo=timezone.utc), 167),
    ((2026, 11, 3, 17), datetime(2026, 10, 27, 16, tzinfo=timezone.utc), 169),
])
def test_missing_or_invalid_timezone_uses_server_rules_across_dst(
    repository, monkeypatch, saved_timezone, now_parts, expected_start, elapsed_hours,
):
    # Simulate Python's system-local conversion on every platform, including
    # Windows CI: each astimezone() returns a fixed-offset tzinfo, but conversion
    # of a different date must use the server's rules for that date. No OS-wide
    # timezone mutation, tzset availability check, or skipped assertion is needed.
    server_zone = ZoneInfo("America/New_York")

    class ServerDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 1, 15, 17, tzinfo=timezone.utc).astimezone(tz)

        def astimezone(self, tz=None):
            value = datetime(
                self.year, self.month, self.day, self.hour, self.minute,
                self.second, self.microsecond, tzinfo=self.tzinfo, fold=self.fold,
            )
            if value.tzinfo is None:
                value = value.replace(tzinfo=server_zone)
            converted = value.astimezone(server_zone if tz is None else tz)
            if tz is None:
                converted = converted.replace(tzinfo=timezone(converted.utcoffset()))
            return type(self)(
                converted.year, converted.month, converted.day, converted.hour,
                converted.minute, converted.second, converted.microsecond,
                tzinfo=converted.tzinfo, fold=converted.fold,
            )

    repository["timezone"] = saved_timezone
    monkeypatch.setattr(recent, "datetime", ServerDateTime)
    now = ServerDateTime(*now_parts, tzinfo=timezone.utc)
    build_recent(now=now)
    call = next(kwargs for name, kwargs in repository["calls"] if name == "items")
    assert call["window_start"] == expected_start
    assert call["window_end"] == now
    assert (call["window_end"] - call["window_start"]).total_seconds() == elapsed_hours * 3600


def test_mixed_summary_preserves_event_count_duration_provenance_and_unknown_sessions(repository):
    repository["rows"] = [ledger_row(1), ledger_row(2, source=LEGACY), ledger_row(3, source=BACKFILL)]
    repository["albums"] = [album_candidate()]
    before = deepcopy(repository["rows"])
    first = build_recent()
    assert build_recent() == first
    assert repository["rows"] == before
    row = first["recent_local_albums"][0]
    assert row["album_ref"] == "album-201"
    assert row["listen_event_count"] == 3
    assert row["listened_track_count"] == 1
    assert row["listened_duration_seconds"] == 192.5
    assert row["listened_duration_by_source"] == {MEASURED: 12.5, LEGACY: 90.0, BACKFILL: 90.0}
    assert row["time_provenance"] == ["legacy_recorded_at", "measured_started_at"]
    assert row["completion_state"] is None and row["sitting_state"] is None
    assert row.get("full_listen_count") is None
    assert PRIVATE_PATH not in repr(first)
    assert "never-in-a-recent-dto" not in repr(first)
    assert "source_payload" not in repr(first)


def test_legacy_duration_rounds_the_aggregate_without_losing_each_events_fraction(repository):
    rows = [ledger_row(index, source=LEGACY) for index in (1, 2, 3)]
    for row in rows:
        row["metadata"]["source_payload"].update({
            "total_listened_seconds": 11.0004, "max_contiguous_seconds": 11.0004,
        })
    repository["rows"] = rows
    repository["albums"] = [album_candidate()]
    summary = build_recent()["recent_local_albums"][0]
    assert summary["listen_event_count"] == 3
    assert summary["listened_duration_seconds"] == 33.001
    assert summary["listened_duration_by_source"] == {LEGACY: 33.001}


@pytest.mark.parametrize("actions,playable,expected", [
    (("library.browse.read",), True, {"can_open_album": True, "can_play_album": False}),
    (("library.browse.read", "library.media.read"), True, {"can_open_album": True, "can_play_album": True}),
    (("library.browse.read", "library.media.read"), False, {"can_open_album": True, "can_play_album": False}),
    ((), True, {"can_open_album": False, "can_play_album": False}),
])
def test_recent_actions_intersect_resource_availability_and_policy(repository, actions, playable, expected):
    repository["rows"] = [ledger_row()]
    repository["albums"] = [album_candidate(can_play=playable)]
    row = build_recent(actions=actions)["recent_local_albums"][0]
    assert row["allowed_actions"] == expected


@pytest.mark.parametrize("claimed_kind", ["local_playback", "lastfm_import"])
def test_removed_measured_identity_is_not_title_or_path_rematched_or_reclassified(repository, claimed_kind):
    row = ledger_row(track_id=None, album_id=None)
    row["metadata"]["source_payload"]["source_provenance"] = {"kind": claimed_kind}
    repository["rows"] = [row]
    repository["albums"] = [album_candidate()]
    before = deepcopy(repository["rows"])
    assert build_recent() == {"recent_local_albums": [], "recent_not_local_albums": []}
    assert repository["rows"] == before


def test_group_order_uses_latest_typed_row_id_for_equal_times(repository):
    repository["rows"] = [ledger_row(20), ledger_row(10, track_id=102, album_id=202)]
    repository["albums"] = [album_candidate(), album_candidate(id=202, key="album-202", legacy_track_refs={})]
    first = build_recent()["recent_local_albums"]
    repository["rows"].reverse()
    second = build_recent()["recent_local_albums"]
    assert [row["album_ref"] for row in first] == ["album-201", "album-202"]
    assert second == first


def test_external_known_totals_never_imply_completion_or_sitting(repository):
    row = ledger_row(source=BACKFILL, track_id=None, album_id=None)
    row["metadata"]["source_payload"].update({
        "source_provenance": {"kind": "lastfm_import", "provider": "lastfm"},
        "album_track_count": 1, "album_duration_seconds": 90,
    })
    repository["rows"] = [row]
    result = build_recent()
    assert result["recent_local_albums"] == []
    external = result["recent_not_local_albums"][0]
    assert external["album_track_count"] == 1
    assert external["completion_state"] is None and external["sitting_state"] is None
    assert external.get("full_listen_count") is None
    assert external["allowed_actions"] == {"can_open_album": False, "can_play_album": False}


@pytest.mark.parametrize("unsafe_cover", [PRIVATE_PATH, "file:///private/recent-fixture/cover.jpg", r"C:\Private\cover.jpg"])
def test_external_recent_cover_fields_cannot_expose_private_paths(repository, unsafe_cover):
    row = ledger_row(source=BACKFILL, track_id=None, album_id=None)
    row["metadata"]["source_payload"].update({
        "source_provenance": {"kind": "lastfm_import"},
        "remote_cover_url": unsafe_cover, "remote_cover_thumbnail_url": unsafe_cover,
    })
    repository["rows"] = [row]
    result = build_recent()
    assert len(result["recent_not_local_albums"]) == 1
    assert unsafe_cover not in repr(result)
    assert result["recent_not_local_albums"][0]["remote_cover_url"] is None
    assert result["recent_not_local_albums"][0]["remote_cover_thumbnail_url"] is None
