"""Pure listener native dialect/delegation contracts, authored and unexecuted.

These cases do not claim SQL, session or permission acceptance. Invalid inputs
must stop before connection acquisition. Valid-call delegation tests replace only
the internal work method to inspect its fixed mode and separate DTO projection;
actual authority is covered by the companion real PostgreSQL tests.
"""
from copy import deepcopy

import pytest

from music_app.services.activity_native_targets import (
    ActivityNativeTargets, normalize_listener_native_origin, normalize_native_origin,
)
from music_app.services.home_activity import ActivityQuery, ComparisonQuery
from music_app.services.private_native_targets import NativeTargetError


SUBJECT = "00000000-0000-4000-8000-000000000001"
ROW = "activity_" + "a" * 64
SECOND = "activity_" + "b" * 64
TOKEN = "A" * 43


def origin(audience="friend", **patch):
    return {"audience": audience, "subject_ref": None if audience == "own" else SUBJECT,
            "kind": "tracks", "period": "all", "snapshot_ref": TOKEN, **patch}


def no_connect(*_args, **_kwargs):
    raise AssertionError("Pure input validation must not acquire a connection")


@pytest.mark.parametrize("audience", ["own", "friend"])
def test_listener_origin_is_detached_exact_tracks_all(audience):
    supplied = origin(audience)
    result, query = normalize_listener_native_origin(supplied)
    assert result == supplied and result is not supplied
    assert type(query) is ActivityQuery
    assert (query.kind, query.period, query.snapshot_ref) == ("tracks", "all", TOKEN)
    supplied["snapshot_ref"] = "B" * 43
    assert result["snapshot_ref"] == TOKEN


@pytest.mark.parametrize("bad", [
    None, [], "@maya", {}, origin("comparison"), origin(kind="listens"),
    origin(kind="albums"), origin(kind="artists"), origin(period="week"),
    origin(period="month"), origin(period="six"), origin(period="year"),
    origin(period="All"), origin(snapshot_ref=None), origin(snapshot_ref="bad"),
    origin(subject_ref=None), origin("own", subject_ref=SUBJECT),
    origin(subject_ref=1), origin(subject_ref="AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"),
    origin(username="maya"), origin(account_id=1), origin(subject_taste=False),
    {"source": "activity", "account_ref": SUBJECT, "kind": "tracks", "period": "all", "snapshot_ref": TOKEN},
])
def test_unsupported_listener_origin_never_reaches_a_transaction(bad):
    service = ActivityNativeTargets({}, connect=no_connect)
    for operation in (
        lambda: normalize_listener_native_origin(bad),
        lambda: service.project_listener(object(), origin=bad, row_refs=[ROW]),
        lambda: service.resolve_listener(object(), origin=bad, row_ref=ROW, intent="play"),
    ):
        with pytest.raises(NativeTargetError) as caught:
            operation()
        assert (caught.value.code, caught.value.status_code) == ("invalid_command", 422)


@pytest.mark.parametrize("field", ["audience", "subject_ref", "kind", "period", "snapshot_ref"])
def test_missing_listener_origin_field_is_invalid(field):
    supplied = origin()
    del supplied[field]
    with pytest.raises(NativeTargetError, match="invalid_command"):
        normalize_listener_native_origin(supplied)


@pytest.mark.parametrize("row_refs", [
    None, ROW, (), (ROW,), [], [ROW, ROW], [None], [False], [1],
    ["track:1"], ["inventory-track:1:2"], ["/private/track.flac"],
    ["activity_" + "A" * 64], [ROW + "\n"], [ROW[:-1]],
    [{"id": ROW, "allowed_actions": {"can_resolve_native_play": True}}],
    ["activity_" + format(index, "064x") for index in range(101)],
])
def test_projection_accepts_only_bounded_unique_receipt_coordinates(row_refs):
    with pytest.raises(NativeTargetError) as caught:
        ActivityNativeTargets({}, connect=no_connect).project_listener(
            object(), origin=origin(), row_refs=row_refs)
    assert (caught.value.code, caught.value.status_code) == ("invalid_command", 422)


@pytest.mark.parametrize("patch", [
    {"row_ref": None}, {"row_ref": "/private/track.flac"}, {"row_ref": ROW + "\n"},
    {"intent": "queue"}, {"intent": "PLAY"}, {"intent": False},
    {"target_kind": "album"}, {"target_kind": "track", "intent": "details"},
    {"target_kind": False, "intent": "details"},
])
def test_invalid_listener_resolution_is_rejected_before_authority(patch):
    arguments = {"row_ref": ROW, "intent": "play", **patch}
    with pytest.raises(NativeTargetError) as caught:
        ActivityNativeTargets({}, connect=no_connect).resolve_listener(
            object(), origin=origin(), **arguments)
    assert (caught.value.code, caught.value.status_code) == ("invalid_command", 422)


def test_listener_projection_delegates_only_row_ids_and_returns_separate_allowlisted_bindings(monkeypatch):
    service, context, constraints = ActivityNativeTargets({}, connect=no_connect), object(), object()
    supplied = [ROW, SECOND]
    calls = []
    target = {"kind": "album", "ref": ROW, "origin": origin(), "identity_ref": "album_" + "c" * 64,
              "allowed_actions": {"can_view_details": True}}

    def work(actual_context, **options):
        calls.append((actual_context, options))
        return [{"id": ROW, "allowed_actions": {"can_resolve_native_play": False,
                "can_resolve_native_details": True, "can_select_for_playlist": False},
                "inventory_track_ref": None, "artwork_url": None, "album_target": target,
                "rating": 5, "subject_taste": {"must_not_escape": True}, "path": "/private/path"},
                {"id": SECOND, "allowed_actions": {"can_resolve_native_play": False,
                "can_resolve_native_details": False, "can_select_for_playlist": False},
                "inventory_track_ref": None, "artwork_url": None}]

    monkeypatch.setattr(service, "_project", work)
    result = service.project_listener(context, origin=origin(), row_refs=supplied, constraints=constraints)
    actual_context, options = calls[0]
    assert actual_context is context and options["constraints"] is constraints
    assert options["subject_taste"] is False
    assert options["rows"] == [{"id": ROW}, {"id": SECOND}]
    assert type(options["query"]) is ActivityQuery
    assert supplied == [ROW, SECOND]
    assert set(result) == {"origin", "bindings"}
    assert result["origin"] == origin()
    assert [row["row_ref"] for row in result["bindings"]] == supplied
    assert set(result["bindings"][0]) == {"row_ref", "allowed_actions", "inventory_track_ref", "artwork_url", "album_target"}
    assert set(result["bindings"][1]) == {"row_ref", "allowed_actions", "inventory_track_ref", "artwork_url"}
    assert result["bindings"][0]["album_target"] == target
    assert not any(key in repr(result) for key in ("subject_taste", "rating", "/private/path"))


def test_exact_hundred_listener_references_are_forwarded_in_original_order(monkeypatch):
    service = ActivityNativeTargets({}, connect=no_connect)
    values = ["activity_" + format(index, "064x") for index in range(100)]
    seen = []
    def work(_context, **options):
        seen.extend(row["id"] for row in options["rows"])
        return [{**row, "allowed_actions": {}, "inventory_track_ref": None, "artwork_url": None}
                for row in options["rows"]]
    monkeypatch.setattr(service, "_project", work)
    result = service.project_listener(object(), origin=origin(), row_refs=values)
    assert seen == values
    assert [row["row_ref"] for row in result["bindings"]] == values


@pytest.mark.parametrize("intent,target_kind", [("play", None), ("metadata", None),
    ("details", None), ("details", "album"), ("details", "artist")])
def test_listener_resolution_has_fixed_authority_only_mode(monkeypatch, intent, target_kind):
    service, context, constraints = ActivityNativeTargets({}, connect=no_connect), object(), object()
    calls, response = [], object()
    def work(actual_context, **options):
        calls.append((actual_context, options))
        return response
    monkeypatch.setattr(service, "_resolve", work)
    result = service.resolve_listener(context, origin=origin(), row_ref=ROW, intent=intent,
        target_kind=target_kind, constraints=constraints)
    assert result is response
    actual_context, options = calls[0]
    assert actual_context is context and options["constraints"] is constraints
    assert options["origin"] == origin() and type(options["query"]) is ActivityQuery
    assert options["row_ref"] == ROW and options["intent"] == intent and options["target_kind"] == target_kind
    assert options["subject_taste"] is False


@pytest.mark.parametrize("audience,kind,period", [("own", "listens", "week"),
    ("friend", "albums", "month"), ("comparison", "artists", "all")])
def test_existing_home_wrappers_keep_their_dialect_and_taste_mode(monkeypatch, audience, kind, period):
    service, supplied = ActivityNativeTargets({}, connect=no_connect), origin(audience, kind=kind, period=period)
    expected = normalize_native_origin(supplied)
    rows = [{"id": ROW, "title": "Existing Home row"}]
    saved = deepcopy(rows)
    calls = []
    def work(context, **options):
        calls.append(options)
        return rows
    monkeypatch.setattr(service, "_project", work)
    monkeypatch.setattr(service, "_resolve", work)
    assert service.project(object(), origin=supplied, rows=rows) is rows
    assert service.resolve(object(), origin=supplied, row_ref=ROW, intent="details") is rows
    assert rows == saved
    assert calls[0]["rows"] is rows
    for call in calls:
        assert call["subject_taste"] is True
        assert call["origin"] == supplied and call["query"] == expected[1]
        assert type(call["query"]) is (ComparisonQuery if audience == "comparison" else ActivityQuery)


@pytest.mark.parametrize("method", ["project_listener", "resolve_listener"])
def test_callers_cannot_select_the_private_taste_mode(method):
    service = ActivityNativeTargets({}, connect=no_connect)
    arguments = {"origin": origin(), "subject_taste": True}
    arguments.update({"row_refs": [ROW]} if method == "project_listener" else {"row_ref": ROW, "intent": "play"})
    with pytest.raises(TypeError):
        getattr(service, method)(object(), **arguments)
