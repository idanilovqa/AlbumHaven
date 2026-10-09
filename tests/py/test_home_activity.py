"""Own Home activity contracts; pure seams only, with independently owned data."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest
from starlette.datastructures import QueryParams

from music_app.services import home_activity as activity
from music_app.services import private_ui_context
from music_app.services import listen_history as history
from music_app.services.allowed_actions import AllowedActions

NOW = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)
START = NOW - timedelta(days=7)
MEASURED = "rendered_local_listen_session"
LEGACY = "runtime_listen_history_adapter"
BACKFILL = "phase_6_json_file_backfill"
PRIVATE_PATH = "/private/home-activity-fixture/one.flac"
PRIVATE_TOKEN = "home-activity-private-provider-token"
SCOPE = activity.ActivityScope(account_id=41, session_id=11, library_id=73)


def ledger_row(row_id=1, *, source=MEASURED, **changes):
    measured = source == MEASURED
    result = {
        "id": row_id, "account_id": 41, "library_id": 73,
        "track_id": 101, "track_key": "track-101", "album_id": 201,
        "played_at": NOW - timedelta(hours=1), "source_family": source,
        "measurement_version": "rendered-pcm-v1" if measured else None,
        "finalized": True if measured else None,
        "measured_listened_seconds": 12.5 if measured else None,
        "scrobble_status": "pending",
        "metadata": {"source_payload": {
            "title": "Original track", "artist": "Original artist",
            "album": "Original album", "album_artist": "Original artist",
            "track_ref": PRIVATE_PATH, "path": PRIVATE_PATH,
            "total_listened_seconds": 90, "max_contiguous_seconds": 30,
            "started_at": (NOW - timedelta(days=30)).isoformat(),
            "recorded_at": (NOW + timedelta(days=30)).isoformat(),
            "source_provenance": {"kind": "local_playback"},
            "provider_token": PRIVATE_TOKEN,
        }},
    }
    result.update(changes)
    return result


def normalize(rows, **changes):
    kwargs = {"account_id": 41, "library_id": 73, "window_start": START, "window_end": NOW}
    kwargs.update(changes)
    return history.normalize_listen_history_rows(rows, **kwargs)


@pytest.mark.parametrize("field", ["account_id", "session_id", "library_id"])
@pytest.mark.parametrize("value", [None, True, False, 0, -1, "41", 1.5])
def test_activity_scope_rejects_nonpositive_or_untyped_identity(field, value):
    values = {"account_id": 41, "session_id": 11, "library_id": 73, field: value}
    with pytest.raises(ValueError):
        activity.ActivityScope(**values)


@pytest.mark.parametrize("period,expected,label", [
    ("week", datetime(2026, 10, 1, 12, tzinfo=timezone.utc), "Last week"),
    ("month", datetime(2026, 9, 8, 12, tzinfo=timezone.utc), "Last month"),
    ("six", datetime(2026, 4, 8, 12, tzinfo=timezone.utc), "Last 6 months"),
    ("year", datetime(2025, 10, 8, 12, tzinfo=timezone.utc), "Last year"),
    ("all", None, "All time"),
])
def test_all_public_period_keys_resolve_server_owned_utc_bounds(period, expected, label):
    window = activity.resolve_activity_window(period, now=NOW, timezone_name="UTC")
    assert window.start == expected
    assert window.end == NOW
    assert window.timezone == "UTC"
    assert window.period_label == label
    assert isinstance(window.range_label, str) and window.range_label.strip()


@pytest.mark.parametrize("period,now,expected", [
    ("month", datetime(2024, 3, 31, 12, tzinfo=timezone.utc), datetime(2024, 2, 29, 12, tzinfo=timezone.utc)),
    ("month", datetime(2025, 3, 31, 12, tzinfo=timezone.utc), datetime(2025, 2, 28, 12, tzinfo=timezone.utc)),
    ("six", datetime(2026, 8, 31, 12, tzinfo=timezone.utc), datetime(2026, 2, 28, 12, tzinfo=timezone.utc)),
    ("year", datetime(2024, 2, 29, 12, tzinfo=timezone.utc), datetime(2023, 2, 28, 12, tzinfo=timezone.utc)),
])
def test_calendar_month_and_year_subtraction_clamps_end_of_month(period, now, expected):
    window = activity.resolve_activity_window(period, now=now, timezone_name="UTC")
    assert window.start == expected
    assert window.end == now


@pytest.mark.parametrize("now,expected,hours", [
    (datetime(2026, 3, 10, 16, tzinfo=timezone.utc), datetime(2026, 3, 3, 17, tzinfo=timezone.utc), 167),
    (datetime(2026, 11, 3, 17, tzinfo=timezone.utc), datetime(2026, 10, 27, 16, tzinfo=timezone.utc), 169),
])
def test_home_week_preserves_seven_local_calendar_days_across_both_dst_transitions(now, expected, hours):
    window = activity.resolve_activity_window("week", now=now, timezone_name="America/New_York")
    assert window.start == expected
    assert window.end == now
    assert (window.end - window.start).total_seconds() == hours * 3600
    assert window.timezone == "America/New_York"


@pytest.mark.parametrize("now,expected", [
    (datetime(2026, 4, 8, 6, 30, tzinfo=timezone.utc), datetime(2026, 3, 8, 7, 30, tzinfo=timezone.utc)),
    (datetime(2026, 12, 1, 6, 30, tzinfo=timezone.utc), datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc)),
])
def test_calendar_month_target_resolves_gap_forward_and_overlap_earlier(now, expected):
    assert activity.resolve_activity_window("month", now=now, timezone_name="America/New_York").start == expected


@pytest.mark.parametrize("period", ["", "30d", "1w", "six_months", "friends", None])
def test_unknown_period_is_not_reinterpreted(period):
    with pytest.raises(ValueError):
        activity.resolve_activity_window(period, now=NOW, timezone_name="UTC")


@pytest.mark.parametrize("now", [datetime(2026, 10, 8), "2026-10-08", None])
def test_period_resolution_requires_an_aware_reference_instant(now):
    with pytest.raises(ValueError):
        activity.resolve_activity_window("week", now=now, timezone_name="UTC")


@pytest.mark.parametrize("kind", ["tracks", "albums", "artists", "listens"])
@pytest.mark.parametrize("period", ["week", "month", "six", "year", "all"])
def test_query_accepts_exact_four_kinds_and_five_periods(kind, period):
    query = activity.parse_activity_query(QueryParams({"kind": kind, "period": period}))
    assert query.kind == kind and query.period == period
    assert query.page_size == 100
    assert query.snapshot_ref is None and query.cursor is None


@pytest.mark.parametrize("query", [
    "kind=track", "period=30d", "kind=albums&kind=tracks", "period=week&period=all",
    "kind=albums&account_ref=other", "account_ref=null", "account_id=41", "library_id=73", "session_id=11",
    "start=2026-01-01", "end=2026-10-08", "timezone=UTC", "unexpected=x",
    "page=0", "page=-1", "page=1.5", "page=true", "page=0002",
    "page_size=99", "page_size=101", "page_size=0", "page_size=100&page_size=100",
    "period=week&page=2", "period=month&page=1", "period=year&page=2",
    "cursor=not-a-receipt", "snapshot_ref=", "snapshot_ref=../../private",
    "period=all&cursor=not-a-receipt", "period=six&page=2&cursor=not-a-receipt",
])
def test_query_rejects_scope_overrides_ambiguous_input_and_mixed_paging(query):
    with pytest.raises(ValueError):
        activity.parse_activity_query(QueryParams(query))


@pytest.mark.parametrize("changes,accepted", [
    ({}, True), ({"measured_listened_seconds": 10}, False),
    ({"measured_listened_seconds": 10.0001}, True), ({"finalized": False}, False),
    ({"finalized": "true"}, False), ({"measurement_version": "future-v2"}, False),
    ({"source_family": "unapproved_source"}, False),
    ({"measured_listened_seconds": float("nan")}, False),
    ({"measured_listened_seconds": float("inf")}, False),
    ({"measured_listened_seconds": True}, False), ({"measured_listened_seconds": "12.5"}, False),
    ({"account_id": 42}, False), ({"library_id": 74}, False),
    ({"account_id": True}, False), ({"id": True}, False), ({"id": -1}, False),
])
def test_shared_measured_normalization_keeps_typed_authoritative_qualification(changes, accepted):
    row = ledger_row(**changes)
    row["metadata"]["source_payload"].update({
        "account_id": 41, "library_id": 73, "finalized": True,
        "measured_listened_seconds": 999, "row_id": 999, "track_id": 999,
        "source_provenance": {"kind": "lastfm_import"},
    })
    events = normalize([row])
    assert len(events) == int(accepted)
    if accepted:
        assert events[0]["row_id"] == row["id"]
        assert events[0]["track_id"] == row["track_id"]
        assert events[0]["listened_seconds"] == row["measured_listened_seconds"]
        assert events[0]["played_at"] == row["played_at"]
        assert events[0]["time_provenance"] == "measured_started_at"
        assert events[0]["source_provenance"] == {"kind": "local_playback", "provider": "album_haven"}


@pytest.mark.parametrize("source", [LEGACY, BACKFILL])
@pytest.mark.parametrize("total,contiguous,accepted", [
    (10, 0, False), (10.0004, 0, False), (10.001, 0, True), (5, 12, True),
    (10.0004, 12, True), (float("inf"), 30, False), (30, float("nan"), False),
    ("malformed", 30, False), (True, 30, False), (30, False, False), (-1, 30, False),
])
def test_shared_legacy_normalization_keeps_finite_three_decimal_qualification(source, total, contiguous, accepted):
    row = ledger_row(source=source)
    row["metadata"]["source_payload"].update({"total_listened_seconds": total, "max_contiguous_seconds": contiguous})
    events = normalize([row])
    assert len(events) == int(accepted)
    if accepted:
        assert events[0]["played_at"] == row["played_at"]
        assert events[0]["time_provenance"] == "legacy_recorded_at"


@pytest.mark.parametrize("status", [None, "pending", "scrobbled", "failed"])
def test_meaningful_history_does_not_depend_on_scrobble_submission_status(status):
    row = ledger_row(scrobble_status=status)
    row["metadata"]["source_payload"].update({
        "scrobbled": status == "scrobbled", "scrobble_eligible": status == "pending", "scrobble_submission_state": status,
    })
    assert [event["row_id"] for event in normalize([row])] == [1]


def test_new_half_open_normalization_preserves_the_existing_recent_inclusive_default():
    rows = [ledger_row(1, played_at=START - timedelta(microseconds=1)), ledger_row(2, played_at=START),
            ledger_row(3, played_at=NOW), ledger_row(4, played_at=NOW),
            ledger_row(5, played_at=NOW + timedelta(microseconds=1)), ledger_row(6, played_at="malformed"),
            ledger_row(7, played_at=NOW.replace(tzinfo=None))]
    before = deepcopy(rows)
    assert [event["row_id"] for event in normalize(rows)] == [2, 3, 4]
    assert [event["row_id"] for event in normalize(rows, end_inclusive=False)] == [2]
    assert rows == before


def test_existing_recent_loader_still_uses_inclusive_end_and_keeps_distinct_sessions(monkeypatch):
    rows = [ledger_row(1, played_at=START), ledger_row(2, played_at=NOW), ledger_row(3, played_at=NOW)]
    calls = []

    class Repository:
        def load_recent_items(self, **kwargs):
            calls.append(kwargs)
            return deepcopy(rows)

    monkeypatch.setattr(history, "_listen_history_adapter", lambda _config: Repository())
    result = history.load_recent_listen_history({}, account_id=41, library_id=73, window_start=START, window_end=NOW)
    assert [event["row_id"] for event in result] == [1, 2, 3]
    assert calls == [{"account_id": 41, "library_id": 73, "window_start": START, "window_end": NOW}]


def resolved_row(row_id=1, **changes):
    return ledger_row(row_id, **{
        "resolved_track_id": 101, "resolved_track_key": "track-101", "resolved_track_title": "Canonical track",
        "resolved_track_artist_id": 301, "resolved_track_artist_name": "Canonical artist",
        "resolved_album_id": 201, "resolved_album_key": "album-201", "resolved_album_title": "Canonical album",
        "resolved_album_artist_id": 301, "resolved_album_artist_name": "Canonical artist",
        "resolved_duration_seconds": 240, "active_file": True, "identity_conflict": False,
        **changes,
    })


def project(rows, *, kind="tracks", denied=(), window=None):
    def allowed(resource_kind, resource_id):
        return AllowedActions(()) if (resource_kind, resource_id) in denied else AllowedActions(("library.browse.read",))

    return activity.build_activity_projection(
        rows, scope=SCOPE, kind=kind,
        window=window or activity.resolve_activity_window("week", now=NOW, timezone_name="UTC"),
        allowed_actions_for_resource=allowed, row_key_secret=b"test-only-home-row-secret-32bytes!",
    )


@pytest.mark.parametrize("kind,row_kind,count", [("tracks", "track", 1), ("albums", "album", 1), ("artists", "artist", 1), ("listens", "listen", 3)])
def test_aggregation_counts_meaningful_events_not_rows_or_full_listens(kind, row_kind, count):
    inputs = [resolved_row(1), resolved_row(2, source_family=LEGACY, measurement_version=None),
              resolved_row(3, source_family=BACKFILL, measurement_version=None)]
    before = deepcopy(inputs)
    result = project(inputs + [deepcopy(inputs[0])], kind=kind)
    assert len(result.rows) == count
    assert result.total_listens == 3
    assert sum(row["listen_count"] for row in result.rows) == 3
    assert {row["kind"] for row in result.rows} == {row_kind}
    assert len({row["id"] for row in result.rows}) == count
    assert inputs == before
    for row in result.rows:
        assert row.get("full_listen_count") is None
        assert row.get("rating") is None
        assert row.get("artwork_url") is None
        assert row.get("detail_ref") is None
        assert row["allowed_actions"].get("can_view_details") is False
        assert row.get("scrobble_count") is None
        assert row.get("lastfm_playcount") is None
    if kind in {"tracks", "listens"}:
        assert all(row["duration_seconds"] == 240 for row in result.rows)
        assert all(row["duration_seconds"] != 12.5 for row in result.rows)


def test_canonical_parent_identities_drive_groups_without_title_based_merges():
    inputs = [resolved_row(1), resolved_row(2, track_id=102, resolved_track_id=102, resolved_track_key="track-102"),
              resolved_row(3, track_id=103, resolved_track_id=103, resolved_track_key="track-103",
                           resolved_album_id=202, resolved_album_key="album-202", resolved_track_artist_id=302,
                           resolved_album_artist_id=302)]
    assert sorted(row["listen_count"] for row in project(inputs, kind="tracks").rows) == [1, 1, 1]
    assert sorted(row["listen_count"] for row in project(inputs, kind="albums").rows) == [1, 2]
    assert sorted(row["listen_count"] for row in project(inputs, kind="artists").rows) == [1, 2]


@pytest.mark.parametrize("kind", ["tracks", "albums", "artists", "listens"])
def test_unknown_identities_remain_distinct_readable_occurrences(kind):
    result = project([ledger_row(1, track_id=None), ledger_row(2, track_id=None)], kind=kind)
    assert len(result.rows) == 2
    assert result.total_listens == 2
    assert len({row["id"] for row in result.rows}) == 2
    for row in result.rows:
        assert row["listen_count"] == 1
        assert row["availability"] == "unresolved"
        assert row["source_readable"] is True
        assert row.get("detail_ref") is None
        assert row.get("track_preference") is None
        assert not any(row["allowed_actions"].values())


@pytest.mark.parametrize("kind", ["tracks", "albums", "artists", "listens"])
@pytest.mark.parametrize("denied", [("track", 101), ("album", 201), ("artist", 301)])
def test_current_resource_denial_removes_events_before_computing_rows_and_totals(kind, denied):
    result = project([resolved_row()], kind=kind, denied={denied})
    assert result.rows == []
    assert result.total_listens == 0
    assert result.coverage["observed_start"] is None
    assert result.coverage["observed_end"] is None


def test_projection_rejects_a_non_authoritative_boolean_policy_result():
    with pytest.raises(ValueError):
        activity.build_activity_projection(
            [resolved_row()], scope=SCOPE, kind="tracks",
            window=activity.resolve_activity_window("week", now=NOW, timezone_name="UTC"),
            allowed_actions_for_resource=lambda _kind, _ref: True,
        )


def test_conflicting_measured_identity_never_falls_back_to_reused_path():
    conflict = resolved_row(track_id=999, identity_conflict=True)
    result = project([conflict])
    assert result.rows == []
    assert result.total_listens == 0


def test_removed_measured_identity_does_not_claim_alias_resolution():
    # A malformed join cannot make a removed numeric measured identity current.
    removed = resolved_row(track_id=None, resolved_track_id=101)
    row = project([removed]).rows[0]
    assert row["availability"] == "unresolved"
    assert row["title"] == "Original track"
    assert row.get("detail_ref") is None


def test_idless_legacy_event_may_use_repository_verified_exact_alias():
    row = resolved_row(source_family=LEGACY, measurement_version=None, track_id=None)
    result = project([row])
    assert result.total_listens == 1
    assert result.rows[0]["title"] == "Canonical track"
    assert result.rows[0]["availability"] == "local"


def test_stale_file_keeps_identity_and_count_without_asserting_media_absence():
    result = project([resolved_row(active_file=False)])
    assert result.total_listens == 1
    assert result.rows[0]["availability"] == "unresolved"
    assert result.rows[0]["title"] == "Canonical track"
    assert not any(result.rows[0]["allowed_actions"].values())


@pytest.mark.parametrize("kind,availability", [
    ("tracks", "local"), ("listens", "local"),
    ("albums", "unresolved"), ("artists", "unresolved"),
])
def test_local_track_file_does_not_claim_unresolved_parent_identity_is_local(kind, availability):
    row = resolved_row(resolved_album_id=None, resolved_album_title=None,
        resolved_track_artist_id=None, resolved_track_artist_name=None,
        resolved_album_artist_id=None, resolved_album_artist_name=None)
    result = project([row], kind=kind)
    assert result.total_listens == 1
    assert result.rows[0]["listen_count"] == 1
    assert result.rows[0]["availability"] == availability
    assert result.rows[0]["detail_ref"] is None
    assert not any(result.rows[0]["allowed_actions"].values())


def test_projection_enforces_scoped_half_open_range_and_stable_ties():
    rows = [resolved_row(1, played_at=START), resolved_row(2, played_at=NOW),
            resolved_row(3, played_at=START - timedelta(microseconds=1)), resolved_row(4, account_id=42),
            resolved_row(5, library_id=74), resolved_row(6), resolved_row(7)]
    first = project(rows, kind="listens")
    second = project(list(reversed(rows)), kind="listens")
    assert first.total_listens == 3
    assert first.rows == second.rows
    assert first.fingerprint == second.fingerprint
    assert [row["last_listened_at"] for row in first.rows] == [
        (NOW - timedelta(hours=1)).isoformat(), (NOW - timedelta(hours=1)).isoformat(), START.isoformat(),
    ]


@pytest.mark.parametrize("field", ["title", "artist", "album", "album_artist"])
@pytest.mark.parametrize("value", [
    {"secret": PRIVATE_TOKEN}, [PRIVATE_PATH], PRIVATE_PATH, "file:///private/media.flac",
    "FILE:///private/media.flac", "File:///private/media.flac",
    "HTTP://private.example/media.flac", "HTTPS://private.example/media.flac",
])
def test_unresolved_hostile_display_fields_cannot_serialize_paths_or_containers(field, value):
    row = ledger_row(track_id=None)
    row["metadata"]["source_payload"][field] = value
    public = repr(project([row]).rows)
    assert PRIVATE_PATH not in public
    assert PRIVATE_TOKEN not in public
    assert "file:///private/media.flac" not in public
    assert "source_payload" not in public
    if isinstance(value, str):
        assert value not in public


def test_public_projection_has_no_private_identity_or_media_reference_fields():
    row = project([resolved_row()]).rows[0]
    forbidden = {"account_id", "session_id", "library_id", "row_id", "track_id", "album_id", "artist_id",
                 "track_key", "track_ref", "path", "source_payload", "metadata", "fingerprint", "source_entry_id"}
    assert forbidden.isdisjoint(row)
    assert PRIVATE_PATH not in repr(row) and PRIVATE_TOKEN not in repr(row)
    assert row["title"] == "Canonical track"
    assert row["artist"] == "Canonical artist"
    assert row["album_title"] == "Canonical album"


@pytest.mark.parametrize("sources", [[], [MEASURED], [MEASURED, LEGACY, BACKFILL]])
def test_coverage_describes_available_evidence_without_asserting_continuous_or_import_coverage(sources):
    inputs = [resolved_row(index, source_family=source, measurement_version="rendered-pcm-v1" if source == MEASURED else None,
                           played_at=NOW - timedelta(hours=index)) for index, source in enumerate(sources, 1)]
    coverage = project(inputs).coverage
    assert coverage["requested_start"] == START.isoformat()
    assert coverage["requested_end"] == NOW.isoformat()
    assert coverage["timezone"] == "UTC"
    assert coverage["source_families"] == sorted(set(sources))
    assert coverage["complete_for_available_snapshot"] is True
    assert coverage["complete_for_requested_period"] is False
    assert isinstance(coverage["label"], str) and coverage["label"].strip()
    assert coverage["observed_start"] == (min(row["played_at"] for row in inputs).isoformat() if inputs else None)
    assert coverage["observed_end"] == (max(row["played_at"] for row in inputs).isoformat() if inputs else None)


def test_all_time_has_no_invented_lower_bound_and_no_full_history_claim():
    window = activity.resolve_activity_window("all", now=NOW, timezone_name="UTC")
    coverage = project([resolved_row()], window=window).coverage
    assert coverage["requested_start"] is None
    assert coverage["complete_for_requested_period"] is False


def test_fingerprint_tracks_semantic_source_changes_but_not_scrobble_delivery_state():
    original = resolved_row()
    changed = deepcopy(original)
    changed["scrobble_status"] = "scrobbled"
    changed["metadata"]["source_payload"].update({"scrobbled": True, "scrobble_attempts": 8, "scrobble_submission_state": "accepted"})
    assert project([original]).fingerprint == project([changed]).fingerprint
    for field, value in [("finalized", False), ("measured_listened_seconds", 9), ("resolved_track_title", "Repaired title")]:
        assert project([original]).fingerprint != project([{**original, field: value}]).fingerprint


@pytest.mark.parametrize("resolved", [False, True])
def test_own_source_readability_is_checked_before_display_or_totals(resolved):
    result = project([resolved_row() if resolved else ledger_row(track_id=None)], denied={("listen_history", 1)})
    assert result.rows == []
    assert result.total_listens == 0
    assert result.coverage["observed_start"] is None


@pytest.mark.parametrize("saved_timezone", [None, "", "Not/A_Timezone"])
@pytest.mark.parametrize("now_parts,expected,hours", [
    ((2026, 3, 10, 16), datetime(2026, 3, 3, 17, tzinfo=timezone.utc), 167),
    ((2026, 11, 3, 17), datetime(2026, 10, 27, 16, tzinfo=timezone.utc), 169),
])
def test_missing_or_invalid_saved_timezone_preserves_server_calendar_rules(monkeypatch, saved_timezone, now_parts, expected, hours):
    from zoneinfo import ZoneInfo

    server_zone = ZoneInfo("America/New_York")

    class ServerDateTime(datetime):
        def astimezone(self, tz=None):
            value = datetime(self.year, self.month, self.day, self.hour, self.minute, self.second, self.microsecond,
                             tzinfo=self.tzinfo, fold=self.fold)
            if value.tzinfo is None:
                value = value.replace(tzinfo=server_zone)
            converted = value.astimezone(server_zone if tz is None else tz)
            if tz is None:
                converted = converted.replace(tzinfo=timezone(converted.utcoffset()))
            return type(self)(converted.year, converted.month, converted.day, converted.hour, converted.minute,
                              converted.second, converted.microsecond, tzinfo=converted.tzinfo, fold=converted.fold)

    monkeypatch.setattr(activity, "datetime", ServerDateTime)
    now = ServerDateTime(*now_parts, tzinfo=timezone.utc)
    window = activity.resolve_activity_window("week", now=now, timezone_name=saved_timezone)
    assert window.start == expected
    assert window.timezone == "server-local"
    assert (window.end - window.start).total_seconds() == hours * 3600


@pytest.mark.parametrize("change,status", [("anonymous", 401), ("inactive", 401), ("no_membership", 403), ("bootstrap_no_membership", 403), ("no_session", 403)])
def test_read_service_rejects_incomplete_actor_scope_before_repository_access(change, status):
    from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship

    calls = []

    class Repository:
        def read(self, **kwargs):
            calls.append(kwargs)
            raise AssertionError("Invalid actor reached the repository")

    actor = CurrentActor(
        state=ActorState.ANONYMOUS if change == "anonymous" else ActorState.INACTIVE if change == "inactive" else ActorState.ACTIVE,
        account_id=41, session_id=None if change == "no_session" else 11, current_library_id=73,
        is_bootstrap_owner=change == "bootstrap_no_membership",
        library_relationships=() if "no_membership" in change else (LibraryRelationship(73, "member", False),),
    )
    with pytest.raises(activity.HomeActivityError) as caught:
        activity.read_home_activity({}, actor=actor, query=activity.ActivityQuery(), now=NOW,
                                    repository=Repository(), allowed_actions_for_resource=lambda *_: AllowedActions(("library.browse.read",)))
    assert caught.value.status_code == status
    assert calls == []


def context_request(*, account_id=41, session_id=11, library_id=73, state=None, secret="test-home-context-secret-at-least-32-bytes", key_version=1):
    from types import SimpleNamespace
    from starlette.requests import Request
    from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship

    current = CurrentActor(
        state=ActorState.ACTIVE if state is None else state,
        account_id=account_id, session_id=session_id, current_library_id=library_id,
        username_display="private-home-test-user",
        library_relationships=(LibraryRelationship(library_id, "member", False),) if library_id is not None else (),
    )
    app = SimpleNamespace(state=SimpleNamespace(auth_policy_config={"hmac": {"secret": secret, "key_version": key_version}}))
    request = Request({"type": "http", "app": app})
    request.state.current_actor = current
    return request


def test_initial_context_ref_is_stable_opaque_and_contains_no_actor_or_session_payload():
    import re

    request = context_request()
    context = private_ui_context.private_ui_context_ref(request)
    assert re.fullmatch(r"[a-f0-9]{64}", context)
    assert private_ui_context.private_ui_context_ref(context_request()) == context
    assert "private-home-test-user" not in context
    assert "test-home-context-secret" not in context
    assert context not in {"41", "11", "73", "41:11:73"}


@pytest.mark.parametrize("change", [
    {"account_id": 42}, {"session_id": 12}, {"library_id": 74},
    {"secret": "different-home-context-secret-at-least-32-bytes"}, {"key_version": 2},
])
def test_initial_context_ref_changes_when_any_actor_scope_or_signing_context_changes(change):
    assert private_ui_context.private_ui_context_ref(context_request(**change)) != private_ui_context.private_ui_context_ref(context_request())


@pytest.mark.parametrize("state_name", ["ANONYMOUS", "INACTIVE"])
def test_unauthenticated_actor_cannot_receive_a_private_context_token(state_name):
    from music_app.services.current_actor import ActorState

    assert private_ui_context.private_ui_context_ref(context_request(state=getattr(ActorState, state_name))) is None


@pytest.mark.parametrize("secret", [None, "", "too-short", 123, {"private": PRIVATE_TOKEN}])
def test_initial_context_signing_fails_closed_when_hmac_setup_is_unavailable(secret):
    with pytest.raises(private_ui_context.PrivateUIContextError) as caught:
        private_ui_context.private_ui_context_ref(context_request(secret=secret))
    assert caught.value.status_code == 503
    assert caught.value.code == "private_ui_context_unavailable"
    assert PRIVATE_TOKEN not in str(caught.value)


@pytest.mark.parametrize("change", [{"account_id": None}, {"session_id": None}, {"library_id": None}])
def test_initial_context_ref_never_mints_authority_for_an_incomplete_active_scope(change):
    with pytest.raises(private_ui_context.PrivateUIContextError) as caught:
        private_ui_context.private_ui_context_ref(context_request(**change))
    assert caught.value.status_code == 503
    assert caught.value.code == "private_ui_context_unavailable"


@pytest.mark.parametrize("sqlstate,attempts", [("40001", 2), ("40P01", 2), ("55P03", 1)])
def test_prepublication_retry_bound_distinguishes_serialization_deadlock_and_nowait(monkeypatch, sqlstate, attempts):
    from music_app.services.home_activity_postgres import HomeActivityPostgresRepository

    class DatabaseConflict(RuntimeError):
        def __init__(self):
            super().__init__("synthetic prepublication conflict")
            self.sqlstate = sqlstate

    class Connection:
        def __init__(self):
            self.operations = []

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, statement, _params=()):
            self.operations.append(" ".join(statement.lower().split()))
            return self

        def commit(self):
            self.operations.append("commit")

        def rollback(self):
            self.operations.append("rollback")

        def close(self):
            self.operations.append("close")

    connections, creations = [], []

    def connect(_url):
        connection = Connection()
        connections.append(connection)
        return connection

    def create(_self, connection, *_args):
        creations.append(connection)
        raise DatabaseConflict()

    monkeypatch.setattr(HomeActivityPostgresRepository, "_authority", staticmethod(lambda *_args: "unit-authority"))
    monkeypatch.setattr(HomeActivityPostgresRepository, "_create", create)
    repository = HomeActivityPostgresRepository({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://localhost/pytest_home_activity_unit"}, connect=connect)
    with pytest.raises(activity.HomeActivityError) as caught:
        repository.read(scope=SCOPE, query=activity.ActivityQuery(), now=NOW, build_projection=lambda *_args: None)
    assert caught.value.status_code == 503
    assert caught.value.code == "activity_busy"
    assert len(connections) == len(creations) == attempts
    for connection in connections:
        assert sum("pg_advisory_lock(" in statement for statement in connection.operations) == 1
        assert sum("pg_advisory_unlock(" in statement for statement in connection.operations) == 1
        assert "rollback" in connection.operations


def test_shared_private_ui_context_uses_its_shared_hmac_domain(monkeypatch):
    from music_app.services.auth_tokens import keyed_bucket_digest

    calls = []

    def capture(**kwargs):
        calls.append(kwargs)
        return keyed_bucket_digest(**kwargs)

    monkeypatch.setattr(private_ui_context, "keyed_bucket_digest", capture)
    result = private_ui_context.private_ui_context_ref(context_request())
    assert len(result) == 64
    assert len(calls) == 1
    assert calls[0]["domain"] == "private-ui-context"
