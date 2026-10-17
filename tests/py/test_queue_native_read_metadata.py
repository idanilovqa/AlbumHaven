"""Native Queue metadata contracts. Scripted service units, not PostgreSQL proof.

Uses the production preference selector with scripted query responses. It does
not prove SQL semantics, transaction isolation, durable state, or full-app routes.
"""
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from music_app.services import private_native_targets as native
from music_app.services import activity_native_targets as activity
from music_app.services import playlist_native_targets as playlist
from music_app.services.owned_playlists import PlaylistError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.owned_playlist_testing import (
    context, inventory_row, ACCOUNT, SESSION, LIBRARY, NOW, PLAYLIST, ITEM_A,
)

KEY = "synthetic-track-901"
MANAGE = "library.track_preferences.manage"
BROWSE = "library.browse.read"
MEDIA = "library.media.read"


class Connection:
    def __init__(self):
        self.queries = []
        self.preference = dict(selection_status="ok", track_id=901, track_ref=KEY,
            track_key=KEY, preference_id=11, preference_key=KEY,
            rating=4, love_tier="loved", is_active_path=False)
        self.item = {"ref": ITEM_A, "local_track_id": 901}

    def execute(self, sql, params):
        self.queries.append((sql, params))
        if isinstance(params, dict):
            assert params == {"account_id": ACCOUNT, "library_id": LIBRARY, "track_refs": [KEY]}
            assert "track_preferences" in sql
            return SimpleNamespace(fetchall=lambda: [self.preference])
        if "from app.playlist_items" in sql:
            assert params == (PLAYLIST, LIBRARY, ITEM_A)
            assert "for share" in sql.lower()
            return SimpleNamespace(fetchone=lambda: self.item)
        assert "local_tracks" in sql and "track_key" in sql, sql
        assert "library_id" in sql and "id" in sql
        assert set(params) == {901, LIBRARY}
        return SimpleNamespace(fetchone=lambda: {"id": 901, "track_key": KEY})


@pytest.fixture
def fixture(monkeypatch):
    connection = Connection()
    row = inventory_row(duration_seconds=None)
    ctx = context(grants=(BROWSE, MANAGE))
    calls = []

    def inventory(con, library, ids, *, lock=False, config=None):
        assert con is connection and library == LIBRARY and ids == [901] and lock is True
        calls.append("inventory")
        return {901: row}

    def media(*args, **kwargs):
        pytest.fail("metadata must never resolve private media files")

    monkeypatch.setattr(native.inventory, "inventory_rows", inventory)
    service = native.PrivateNativeTargets({}, media_resolver=media)
    return SimpleNamespace(connection=connection, row=row, ctx=ctx, service=service, calls=calls)


def resolve(f, **kwargs):
    return f.service.resolve(f.connection, f.ctx, 901, intent="metadata", **kwargs)


def test_metadata_reads_actor_preference_without_media_permission_or_private_paths(fixture):
    result = resolve(fixture)
    assert result["inventory_track_ref"] == f"inventory-track:{LIBRARY}:901"
    assert result["canonical_track_ref"] == result["track_ref"] == KEY
    assert result["source_readable"] is True
    assert result["title"] == fixture.row["title"]
    assert result["artist"] == fixture.row["artist"]
    assert result["album_title"] == fixture.row["album_title"]
    assert result["duration_seconds"] is None
    assert result["availability"] == "local"
    assert result["allowed_actions"]["can_read"] is True
    assert result["allowed_actions"]["can_play"] is False
    assert result["playback_state"]["can_start_here"] is False
    preference = result["track_preference"]
    assert preference["rating"] == 4 and preference["love_tier"] == "loved"
    assert preference["allowed_actions"]["can_set_love_tier"] is True
    assert not {"path", "src", "url", "private_path", "inventory_evidence"} & result.keys()
    assert sum(isinstance(params, dict) for _, params in fixture.connection.queries) == 1


@pytest.mark.parametrize("availability", ["missing", "unresolved"])
def test_retained_nonlocal_metadata_preserves_read_truth_and_known_duration(fixture, availability):
    fixture.row.update(availability=availability, duration_seconds=167.5)
    fixture.ctx = context(grants=(BROWSE, MANAGE, MEDIA))
    result = resolve(fixture)
    assert result["availability"] == availability and result["duration_seconds"] == 167.5
    assert result["source_readable"] is True
    assert result["allowed_actions"]["can_play"] is False
    assert result["playback_state"]["can_start_here"] is False


@pytest.mark.parametrize("status", ["missing", "conflict"])
def test_unselected_preference_stays_unknown_and_has_no_canonical_alias(fixture, status):
    fixture.connection.preference["selection_status"] = status
    result = resolve(fixture)
    assert result.get("track_preference") is None
    assert result.get("canonical_track_ref") is None and result.get("track_ref") is None
    assert result["source_readable"] is True


def test_exact_proven_inventory_id_is_verified_after_preference_selection(fixture):
    fixture.connection.preference["track_id"] = 902
    result = resolve(fixture)
    assert result.get("track_preference") is None
    assert result.get("canonical_track_ref") is None and result.get("track_ref") is None
    assert result["inventory_track_ref"] == f"inventory-track:{LIBRARY}:901"


def test_preference_manage_grant_is_independent_from_browse_and_media(fixture):
    fixture.ctx = context(grants=(BROWSE, MEDIA))
    result = resolve(fixture)
    assert result["track_preference"]["love_tier"] == "loved"
    assert result["track_preference"]["allowed_actions"]["can_set_love_tier"] is False
    assert result["allowed_actions"]["can_play"] is True


def test_resource_constraints_still_narrow_metadata_and_preference_editing(fixture):
    seen = []
    def narrowed(value):
        seen.append((value.action, value.resource.resource_kind, value.resource.resource_ref))
        return PolicyEvaluationConstraints(request_origin_allowed=value.action != MANAGE)
    assert resolve(fixture, constraints=narrowed)["track_preference"]["allowed_actions"]["can_set_love_tier"] is False
    assert (MANAGE, "track", "901") in seen
    with pytest.raises(native.NativeTargetError, match="forbidden"):
        resolve(fixture, constraints=lambda _: PolicyEvaluationConstraints(request_origin_allowed=False))


def test_metadata_permission_cannot_authorize_fresh_play(fixture):
    resolve(fixture)
    with pytest.raises(native.NativeTargetError, match="forbidden"):
        fixture.service.resolve(fixture.connection, fixture.ctx, 901, intent="play")


def test_activity_metadata_retains_original_friend_receipt_and_own_actor(fixture, monkeypatch):
    origin = dict(audience="friend", subject_ref="00000000-0000-4000-8000-000000000001",
        kind="tracks", period="week", snapshot_ref="A" * 43)
    row_ref = "activity_" + "a" * 64
    events = []
    @contextmanager
    def transaction(url, ctx, **kwargs):
        assert ctx is fixture.ctx and kwargs["read_only"] is True
        events.append("transaction")
        yield fixture.connection, fixture.ctx, NOW
        events.append("exit")
    monkeypatch.setattr(activity, "current_library_transaction", transaction)
    def session(con, **kwargs):
        assert con is fixture.connection
        assert (kwargs["actor_account_id"], kwargs["actor_session_id"]) == (ACCOUNT, SESSION)
        events.append("session")
    monkeypatch.setattr(activity, "lock_current_actor_session", session)
    service = activity.ActivityNativeTargets({})
    service.targets = fixture.service
    def export(con, ctx, received, query, refs, constraints):
        assert con is fixture.connection and ctx is fixture.ctx
        assert received == origin and refs == [row_ref]
        events.append("receipt")
        return [{"canonical_resource": {"kind": "track", "id": 901}}]
    monkeypatch.setattr(service, "_export", export)
    result = service.resolve(fixture.ctx, origin=origin, row_ref=row_ref, intent="metadata")
    assert result["origin"] == origin and result["row_ref"] == row_ref and result["intent"] == "metadata"
    assert result["native_target"]["track_preference"]["love_tier"] == "loved"
    assert "subject_taste" not in result["native_target"]
    assert events == ["transaction", "receipt", "session", "exit"]


def test_playlist_metadata_checks_exact_membership_and_returns_current_revision(fixture, monkeypatch):
    events = []
    class Owner:
        _clock = staticmethod(lambda: NOW)
        @contextmanager
        def _authorized(self, ctx, constraints):
            events.append("transaction")
            yield fixture.connection, fixture.ctx, NOW
        def _playlist(self, con, ctx, ref):
            assert con is fixture.connection and ref == PLAYLIST
            events.append("playlist")
            return {"revision": 7}
        def _require(self, ctx, actions, constraints, resource):
            assert ctx is fixture.ctx and actions == (playlist.BROWSE,)
            events.append("browse")
    monkeypatch.setattr(playlist, "lock_current_actor_session", lambda con, **kwargs: events.append("session"))
    service = playlist.PlaylistNativeTargets({}, playlists=Owner())
    service._targets = fixture.service
    result = service.resolve(fixture.ctx, playlist_ref=PLAYLIST, item_ref=ITEM_A, intent="metadata")
    assert (result["playlist_id"], result["playlist_item_id"], result["revision"], result["intent"]) == (PLAYLIST, ITEM_A, "7", "metadata")
    assert events == ["transaction", "playlist", "browse", "session"]
    fixture.connection.item = None
    with pytest.raises(PlaylistError, match="item_unavailable"):
        service.resolve(fixture.ctx, playlist_ref=PLAYLIST, item_ref=ITEM_A, intent="metadata")


def test_activity_route_admits_metadata_without_widening_command_keys(monkeypatch):
    """Direct handler unit only; not ASGI middleware or full-app acceptance."""
    import asyncio
    import json
    from music_app.routes import activity_native_targets_asgi as route
    stamp = "a" * 64
    body = {"origin": {"audience": "own", "subject_ref": None, "kind": "tracks",
        "period": "week", "snapshot_ref": "A" * 43},
        "row_ref": "activity_" + "a" * 64, "intent": "metadata"}
    calls = []
    monkeypatch.setattr(route, "native_activity_context", lambda request: (object(), None))
    monkeypatch.setattr(route, "private_ui_context_ref", lambda request: stamp)
    async def read(request):
        return body
    monkeypatch.setattr(route, "read_bounded_json_object", read)
    class Service:
        def __init__(self, config):
            pass
        def resolve(self, context, **kwargs):
            calls.append(kwargs)
            return {"intent": kwargs["intent"], "native_target": {"source_readable": True}}
    monkeypatch.setattr(route, "ActivityNativeTargets", Service)
    request = SimpleNamespace(headers={"x-albumhaven-context": stamp}, app=SimpleNamespace(state=SimpleNamespace(config={})))
    reply = asyncio.run(route.activity_native_target(request))
    assert reply.status_code == 200 and json.loads(reply.body)["data"]["intent"] == "metadata"
    assert calls[0]["origin"] == body["origin"] and calls[0]["row_ref"] == body["row_ref"]
    assert reply.headers["cache-control"] == "private, no-store"
    for extra in ({"revision": "7"}, {"track_ref": KEY}, {"target_kind": "album"}):
        original = dict(body)
        body.update(extra)
        assert asyncio.run(route.activity_native_target(request)).status_code == 422
        body.clear()
        body.update(original)
    assert len(calls) == 1


def test_playlist_route_admits_only_existing_intent_query_shape(monkeypatch):
    """Direct handler unit, retaining existing response and policy owners."""
    from music_app.routes import playlist_native_targets_asgi as route
    calls = []
    monkeypatch.setattr(route, "_context", lambda request, action: (object(), None))
    monkeypatch.setattr(route, "_service", lambda request: object())
    monkeypatch.setattr(route, "_response", lambda request, data: data)
    monkeypatch.setattr(route, "_error", lambda error: {"error": error.code})
    class Service:
        def __init__(self, config, **kwargs):
            pass
        def resolve(self, context, **kwargs):
            calls.append(kwargs)
            return {"intent": kwargs["intent"]}
    monkeypatch.setattr(route, "PlaylistNativeTargets", Service)
    request = SimpleNamespace(query_params={"intent": "metadata"}, app=SimpleNamespace(state=SimpleNamespace(config={})))
    assert route.playlist_native_target(request, PLAYLIST, ITEM_A)["data"]["intent"] == "metadata"
    assert calls[0]["playlist_ref"] == PLAYLIST and calls[0]["item_ref"] == ITEM_A
    request.query_params["revision"] = "7"
    assert route.playlist_native_target(request, PLAYLIST, ITEM_A) == {"error": "invalid_command"}
    assert len(calls) == 1
