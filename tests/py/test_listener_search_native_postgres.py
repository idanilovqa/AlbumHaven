"""Authored-only PostgreSQL acceptance for listener native authority.

Every case uses the unchanged guarded isolated-database fixture chain. Captures,
receipt exports, live actor/session authority and native resolution use actual
runtime owners. Only the two taste-only helpers receive raising sentinels where
explicitly stated. No HTTP or UI activation is implied by these tests.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
import uuid

import pytest

from music_app.services import activity_native_targets as native_module
from music_app.services.activity_native_targets import ActivityNativeTargets
from music_app.services.capabilities import grant_keys_for_action
from music_app.services.current_actor import CapabilityGrant, LibraryRelationship
from music_app.services.home_activity import HomeActivityError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_library_authority import PrivateLibraryAuthorityError
from music_app.services.private_listener_search_postgres import PostgresListenerSearch
from music_app.services.private_native_targets import NativeTargetError
from music_app.services.track_preferences_postgres import PostgresTrackPreferencesStore
from tests.py.test_activity_native_targets_postgres import native_activity
from tests.py.test_friend_home_activity import social_ledger
from tests.py.test_home_activity_postgres_integration import (
    LEGACY, NOW, RetainedRuntimeConnection, database_urls,
    expire_session_with_database_clock, mutable_ledger,
)

CONTEXT_REF = "b" * 64
CURSOR_SECRET = "listener-native-postgres-contract-secret-20261016"
ACTION_KEYS = {"can_resolve_native_play", "can_resolve_native_details", "can_select_for_playlist"}
BINDING_KEYS = {"row_ref", "allowed_actions", "inventory_track_ref", "artwork_url"}
TARGET_KEYS = {"kind", "ref", "origin", "identity_ref", "allowed_actions"}


def capture_listener(value, *, audience="friend", explicit=False, cursor=None):
    state, context, _service, _probes = value
    subject = state["actor"].account_id if audience == "own" else state["peer"]
    with state["db"].connect() as connection:
        username = connection.execute("select username_normalized from app.accounts where id=%s",
                                      (subject,)).fetchone()["username_normalized"]
    query = "@" + username + (" :tracks listened:all" if explicit else "")
    return PostgresListenerSearch(state["db"].config, clock=lambda: NOW).read(
        context, query=query, context_ref=CONTEXT_REF, cursor_secret=CURSOR_SECRET, cursor=cursor)


def refs(response):
    return [row["id"] for row in response["tracks"]]


def invoke(service, context, response, operation, *, constraints=None, origin=None, row_refs=None):
    origin = response["native_origin"] if origin is None else origin
    selected = refs(response) if row_refs is None else row_refs
    if operation == "project":
        return service.project_listener(context, origin=origin, row_refs=selected, constraints=constraints)
    return service.resolve_listener(context, origin=origin, row_ref=selected[0],
                                    intent=operation, constraints=constraints)


def deny(*actions, resource_kind=None, resource_ref=None):
    """Narrow the real policy evaluator; never substitute an authority result."""
    def constraints(context):
        denied = context.action in actions
        if resource_kind is not None:
            denied = denied and context.resource is not None and context.resource.resource_kind == resource_kind
        if resource_ref is not None:
            denied = denied and context.resource is not None and context.resource.resource_ref == str(resource_ref)
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    return constraints


def assert_bindings(projected, response, selected):
    assert set(projected) == {"origin", "bindings"}
    assert projected["origin"] == response["native_origin"]
    assert set(projected["origin"]) == {"audience", "subject_ref", "kind", "period", "snapshot_ref"}
    assert [binding["row_ref"] for binding in projected["bindings"]] == selected
    for binding in projected["bindings"]:
        assert BINDING_KEYS <= set(binding) <= BINDING_KEYS | {"album_target", "artist_target"}
        assert set(binding["allowed_actions"]) == ACTION_KEYS
        assert all(type(value) is bool for value in binding["allowed_actions"].values())
        for kind in ("album", "artist"):
            target = binding.get(kind + "_target")
            if target is not None:
                assert set(target) == TARGET_KEYS
                assert target["kind"] == kind and target["ref"] == binding["row_ref"]
                assert target["origin"] == projected["origin"]
                assert target["identity_ref"].startswith(kind + "_")
                assert target["allowed_actions"] == {"can_view_details": True}
    text = repr(projected)
    for forbidden in ("synthetic-private", "source_payload", "private_path", "canonical_resource", "row_secret",
                      "subject_taste", "track_preference", "love_tier", "'rating'", "'path'", "'track_ref'"):
        assert forbidden not in text


def seed_distinct_taste(value):
    state, context, _service, _probes = value
    db, track = state["db"], state["data"]["tracks"][0]
    preferences = PostgresTrackPreferencesStore(db.config)
    for account, rating, love in ((context.actor.account_id, 2, "off"), (state["peer"], 5, "loved")):
        preferences.patch_preference(track["key"], {"rating": rating, "love_tier": love},
            account_id=account, library_id=context.library_id, expected_track_id=track["id"])
    with db.connect() as connection:
        album_key = connection.execute("select album_key from library.local_albums where id=%s",
                                       (state["data"]["album"],)).fetchone()["album_key"]
        for account, rating in ((context.actor.account_id, 2), (state["peer"], 9)):
            connection.execute("insert into app.album_ratings(account_id,library_id,album_key,rating,provenance) "
                "values(%s,%s,%s,%s,'explicit_import')", (account, context.library_id, album_key, rating))
    return track


def no_taste(*_args, **_kwargs):
    raise AssertionError("Listener native authority called a Home taste-only helper")


@pytest.mark.parametrize("audience", ["own", "friend"])
@pytest.mark.parametrize("explicit", [False, True])
def test_actual_listener_receipt_projects_only_native_bindings_and_resolves_current_targets(native_activity, audience, explicit):
    state, context, service, probes = native_activity
    response = capture_listener(native_activity, audience=audience, explicit=explicit)
    unchanged = deepcopy(response)
    selected = list(reversed(refs(response)))
    projected = service.project_listener(context, origin=response["native_origin"], row_refs=selected)
    assert_bindings(projected, response, selected)
    assert response == unchanged
    assert len(projected["bindings"]) == (3 if audience == "own" else 2)
    assert all(all(binding["allowed_actions"].values()) for binding in projected["bindings"])
    assert not probes, "Projection is not permission to read a private media path"
    binding = projected["bindings"][0]
    result = service.resolve_listener(context, origin=response["native_origin"], row_ref=binding["row_ref"], intent="play")
    assert set(result) == {"origin", "row_ref", "intent", "native_target"}
    assert result["origin"] == response["native_origin"] and result["row_ref"] == binding["row_ref"]
    assert result["native_target"]["inventory_track_ref"] == binding["inventory_track_ref"]
    assert result["native_target"]["path"] in probes
    assert Path(result["native_target"]["path"]).is_file()
    probes.clear()
    for kind in ("album", "artist"):
        detail = service.resolve_listener(context, origin=response["native_origin"],
            row_ref=binding["row_ref"], intent="details", target_kind=kind)
        assert kind + "_ref" in detail["native_target"]
        assert "subject_taste" not in detail["native_target"] and "path" not in detail["native_target"]
    assert not probes


@pytest.mark.parametrize("audience", ["own", "friend"])
def test_listener_never_calls_home_taste_helpers_and_metadata_uses_the_actor(native_activity, monkeypatch, audience):
    state, context, service, probes = native_activity
    track = seed_distinct_taste(native_activity)
    response = capture_listener(native_activity, audience=audience)
    unchanged = deepcopy(response)
    with monkeypatch.context() as patch:
        patch.setattr(native_module, "project_subject_taste", no_taste)
        patch.setattr(native_module, "subject_album_overlay", no_taste)
        projected = service.project_listener(context, origin=response["native_origin"], row_refs=refs(response))
        assert_bindings(projected, response, refs(response))
        chosen = next(binding for binding in projected["bindings"]
                      if binding["inventory_track_ref"] == f"inventory-track:{context.library_id}:{track['id']}")
        result = service.resolve_listener(context, origin=response["native_origin"], row_ref=chosen["row_ref"],
            intent="metadata", constraints=deny("library.social.taste.read", "library.media.read"))
        target = result["native_target"]
        assert target["track_ref"] == target["canonical_track_ref"] == track["key"]
        assert target["track_preference"]["rating"] == 2
        assert target["track_preference"]["love_tier"] == "off"
        assert target["allowed_actions"] == {"can_read": True, "can_play": False}
        assert "subject_taste" not in target and "path" not in target and not probes
        album = service.resolve_listener(context, origin=response["native_origin"],
            row_ref=chosen["row_ref"], intent="details", target_kind="album")
        assert "album_ref" in album["native_target"] and "subject_taste" not in album["native_target"]
    assert response == unchanged
    assert all(row["rating"] is None and row["detail_ref"] is None for row in response["tracks"])


def test_existing_home_projection_and_resolution_keep_own_and_peer_taste(native_activity):
    state, context, service, probes = native_activity
    track = seed_distinct_taste(native_activity)
    for audience, rating in (("own", 2), ("friend", 5)):
        response = capture_listener(native_activity, audience=audience)
        unchanged = deepcopy(response)
        projected = service.project(context, origin=response["native_origin"], rows=response["tracks"])
        row = next(row for row in projected if row["inventory_track_ref"] == f"inventory-track:{context.library_id}:{track['id']}")
        assert row["rating"] == rating
        assert row["love_tier"] == ("off" if audience == "own" else "loved")
        assert row["id"] in refs(response) and row["title"] == "Track 0000"
        assert row["allowed_actions"]["can_view_details"] is False
        target = service.resolve(context, origin=response["native_origin"], row_ref=row["id"], intent="details", target_kind="album")["native_target"]
        if audience == "friend":
            assert target["subject_taste"]["subject_ref"] == state["peer_ref"]
            assert target["subject_taste"]["rating"] == 9
            assert target["subject_taste"]["read_only"] is True
        else:
            assert "subject_taste" not in target
        assert response == unchanged
    assert not probes


@pytest.mark.parametrize("denied_kind", ["track", "album", "artist"])
def test_native_browse_is_independent_of_accepted_friend_history(native_activity, denied_kind):
    _state, context, service, probes = native_activity
    response = capture_listener(native_activity)
    constraints = deny("library.browse.read", resource_kind=denied_kind)
    projected = invoke(service, context, response, "project", constraints=constraints)
    assert_bindings(projected, response, refs(response))
    for binding in projected["bindings"]:
        if denied_kind == "track":
            assert not any(binding["allowed_actions"].values()) and binding["inventory_track_ref"] is None
            assert "album_target" not in binding and "artist_target" not in binding
        else:
            other = "artist" if denied_kind == "album" else "album"
            assert denied_kind + "_target" not in binding and other + "_target" in binding
            assert binding["allowed_actions"]["can_resolve_native_details"] is True
            assert binding["allowed_actions"]["can_resolve_native_play"] is True
    with pytest.raises(NativeTargetError) as caught:
        service.resolve_listener(context, origin=response["native_origin"], row_ref=refs(response)[0],
            intent="metadata" if denied_kind == "track" else "details",
            target_kind=None if denied_kind == "track" else denied_kind, constraints=constraints)
    assert (caught.value.code, caught.value.status_code) == ("forbidden", 403)
    assert not probes


def test_media_denial_preserves_details_and_playlist_authority_but_never_resolves_a_path(native_activity):
    _state, context, service, probes = native_activity
    response = capture_listener(native_activity)
    constraints = deny("library.media.read")
    projected = invoke(service, context, response, "project", constraints=constraints)
    for binding in projected["bindings"]:
        assert binding["allowed_actions"] == {
            "can_resolve_native_play": False, "can_resolve_native_details": True, "can_select_for_playlist": True,
        }
    with pytest.raises(NativeTargetError) as caught:
        invoke(service, context, response, "play", constraints=constraints)
    assert (caught.value.code, caught.value.status_code) == ("forbidden", 403)
    result = service.resolve_listener(context, origin=response["native_origin"], row_ref=refs(response)[0],
                                      intent="details", target_kind="album", constraints=constraints)
    assert result["native_target"]["allowed_actions"] == {"can_view_details": True, "can_play_album": False}
    assert not probes


def test_durable_media_revocation_is_reloaded_despite_stale_actor_grants(native_activity):
    state, context, service, probes = native_activity
    with state["db"].connect() as connection:
        connection.execute("update app.capabilities set revoked_at=clock_timestamp() where account_id=%s and capability_key=any(%s)",
                           (context.actor.account_id, sorted(grant_keys_for_action("library.media.read"))))
    # Capture after the durable change so its receipt fingerprint is current.
    response = capture_listener(native_activity)
    projected = invoke(service, context, response, "project")
    assert all(not binding["allowed_actions"]["can_resolve_native_play"] for binding in projected["bindings"])
    with pytest.raises(NativeTargetError) as caught:
        invoke(service, context, response, "play")
    assert (caught.value.code, caught.value.status_code) == ("forbidden", 403)
    assert not probes


@pytest.mark.parametrize("create,items", [(True, True), (True, False), (False, True), (False, False)])
def test_playlist_create_and_items_permissions_are_independent_of_history(native_activity, create, items):
    _state, context, service, probes = native_activity
    response = capture_listener(native_activity)
    rejected = ([] if create else ["library.playlists.create"]) + ([] if items else ["library.playlists.items.manage"])
    projected = invoke(service, context, response, "project", constraints=deny(*rejected))
    for binding in projected["bindings"]:
        assert binding["allowed_actions"]["can_select_for_playlist"] is (create or items)
        assert binding["allowed_actions"]["can_resolve_native_play"] is True
        assert binding["allowed_actions"]["can_resolve_native_details"] is True
    assert not probes


def unresolved_listener(value):
    state, _context, _service, _probes = value
    key = "unresolved-native-listener-" + uuid.uuid4().hex
    with state["db"].connect() as connection:
        event = state["db"].event(connection, state["data"], owner=state["peer"], source=LEGACY,
            payload={"title": "Unresolved listener evidence", "path": "/synthetic-private/" + key, "track_ref": "/synthetic-private/" + key})
        connection.execute("update integration.listen_history set track_id=null,track_key=%s where id=%s", (key, event))
    response = capture_listener(value)
    row = next(row for row in response["tracks"] if row["title"] == "Unresolved listener evidence")
    return response, row["id"]


@pytest.mark.parametrize("create,items", [(True, False), (False, True), (False, False)])
def test_unresolved_history_never_becomes_native_inventory_and_only_create_allows_missing_selection(native_activity, create, items):
    _state, context, service, probes = native_activity
    response, row_ref = unresolved_listener(native_activity)
    rejected = ([] if create else ["library.playlists.create"]) + ([] if items else ["library.playlists.items.manage"])
    constraints = deny(*rejected)
    projected = invoke(service, context, response, "project", constraints=constraints, row_refs=[row_ref])
    assert_bindings(projected, response, [row_ref])
    assert projected["bindings"] == [{
        "row_ref": row_ref, "allowed_actions": {"can_resolve_native_play": False,
            "can_resolve_native_details": False, "can_select_for_playlist": create},
        "inventory_track_ref": None, "artwork_url": None,
    }]
    for intent in ("play", "details", "metadata"):
        with pytest.raises(NativeTargetError) as caught:
            invoke(service, context, response, intent, constraints=constraints, row_refs=[row_ref])
        assert (caught.value.code, caught.value.status_code) == ("item_unavailable", 404)
    assert not probes


@pytest.mark.parametrize("operation", ["project", "play"])
def test_current_source_event_policy_is_rechecked_before_native_bindings(native_activity, operation):
    state, context, service, probes = native_activity
    response = capture_listener(native_activity)
    constraints = deny("library.social.history.read", resource_kind="listen_history", resource_ref=state["peer_events"][0])
    with pytest.raises(HomeActivityError) as caught:
        invoke(service, context, response, operation, constraints=constraints)
    assert caught.value.status_code == 410
    assert not probes


@pytest.mark.parametrize("operation", ["project", "play"])
@pytest.mark.parametrize("mismatch", ["unknown_row", "other_receipt", "wrong_audience"])
def test_exact_row_and_receipt_membership_are_revalidated(native_activity, operation, mismatch):
    _state, context, service, probes = native_activity
    response = capture_listener(native_activity)
    origin, selected = response["native_origin"], refs(response)
    expected_status = 403
    if mismatch == "unknown_row":
        selected = [selected[0], "activity_" + "0" * 64] if operation == "project" else ["activity_" + "0" * 64]
    elif mismatch == "other_receipt":
        origin = capture_listener(native_activity)["native_origin"]
    else:
        origin = {**origin, "audience": "own", "subject_ref": None}
        expected_status = 410
    with pytest.raises(HomeActivityError) as caught:
        invoke(service, context, response, operation, origin=origin, row_refs=selected)
    assert caught.value.status_code == expected_status
    assert not probes


@pytest.mark.parametrize("operation", ["project", "metadata"])
@pytest.mark.parametrize("scope", ["actor", "session", "library"])
def test_receipt_cannot_cross_real_authenticated_actor_session_or_library(native_activity, operation, scope):
    state, context, service, probes = native_activity
    response = capture_listener(native_activity, audience="own")
    db = state["db"]
    if scope == "library":
        with db.connect() as connection:
            other = db.catalog(connection, context.actor.account_id)
        actor = replace(context.actor, current_library_id=other["library"],
            library_relationships=(*context.actor.library_relationships, LibraryRelationship(other["library"], "member", False)),
            capability_grants=(*context.actor.capability_grants, CapabilityGrant("library.browse.read", "library", other["library"])))
        with pytest.raises(HomeActivityError) as caught:
            invoke(service, replace(context, actor=actor, library_id=other["library"]), response, operation)
    else:
        account = state["peer"] if scope == "actor" else context.actor.account_id
        with db.session(account, context.library_id) as actor:
            with pytest.raises(HomeActivityError) as caught:
                invoke(service, replace(context, actor=actor), response, operation)
    assert caught.value.status_code == 410
    assert not probes


@pytest.mark.parametrize("operation", ["project", "play"])
@pytest.mark.parametrize("change", ["source", "inventory", "unfriend", "refriend", "subject_disabled", "subject_membership", "subject_browse", "expired_receipt", "retired_receipt", "revoked_session", "idle", "absolute", "browse"])
def test_current_receipt_source_relationship_and_session_changes_fail_closed(native_activity, operation, change):
    state, context, service, probes = native_activity
    db = state["db"]
    response = capture_listener(native_activity)
    if change == "retired_receipt":
        capture_listener(native_activity)
        capture_listener(native_activity)
    else:
        with db.connect() as connection:
            if change == "source":
                connection.execute("update integration.listen_history set finalized=false where id=%s", (state["peer_events"][0],))
            elif change == "inventory":
                connection.execute("update library.local_tracks set title='Changed native inventory' where id=%s", (state["data"]["tracks"][0]["id"],))
            elif change in {"unfriend", "refriend"}:
                connection.execute("update app.friend_connections set state='removed',revision=revision+1 "
                    "where library_id=%s and low_account_id=%s and high_account_id=%s", state["pair"])
            elif change == "subject_disabled":
                connection.execute("update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s", (state["peer"],))
            elif change == "subject_membership":
                connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (state["peer"], context.library_id))
            elif change == "subject_browse":
                connection.execute("update app.capabilities set revoked_at=clock_timestamp() where account_id=%s and capability_key=any(%s)",
                    (state["peer"], sorted(grant_keys_for_action("library.browse.read"))))
            elif change == "expired_receipt":
                connection.execute("update app.activity_snapshots set expires_at=clock_timestamp()-interval '1 microsecond' where account_id=%s", (context.actor.account_id,))
            elif change == "revoked_session":
                connection.execute("update app.account_sessions set revoked_at=clock_timestamp() where id=%s", (context.actor.session_id,))
            elif change in {"idle", "absolute"}:
                expire_session_with_database_clock(connection, context.actor.session_id, change)
            else:
                connection.execute("update app.capabilities set revoked_at=clock_timestamp() where account_id=%s and capability_key=any(%s)",
                    (context.actor.account_id, sorted(grant_keys_for_action("library.browse.read"))))
        if change == "refriend":
            with db.connect() as connection:
                connection.execute("update app.friend_connections set state='accepted',revision=revision+1 "
                    "where library_id=%s and low_account_id=%s and high_account_id=%s", state["pair"])
    expected = PrivateLibraryAuthorityError if change in {"revoked_session", "idle", "absolute", "browse"} else HomeActivityError
    with pytest.raises(expected) as caught:
        invoke(service, context, response, operation)
    if expected is HomeActivityError:
        assert caught.value.status_code == (403 if change in {"unfriend", "subject_disabled", "subject_membership", "subject_browse"} else 410)
    assert not probes


def test_missing_physical_file_cannot_resolve_media_from_a_still_valid_history_receipt(native_activity, tmp_path):
    state, context, service, probes = native_activity
    response = capture_listener(native_activity)
    projected = invoke(service, context, response, "project")
    first = projected["bindings"][0]
    identity = int(first["inventory_track_ref"].rsplit(":", 1)[1])
    with state["db"].connect() as connection:
        paths = connection.execute("select private_path from library.local_track_files where track_id=%s", (identity,)).fetchall()
    for row in paths:
        path = Path(row["private_path"])
        assert path.resolve().is_relative_to((tmp_path / "library").resolve())
        assert path.is_file()
        path.unlink()
    with pytest.raises(NativeTargetError) as caught:
        invoke(service, context, response, "play", row_refs=[first["row_ref"]])
    assert (caught.value.code, caught.value.status_code) == ("item_unavailable", 404)


class NativeRuntimeLease:
    """Retain only the native action owner's real injected transaction."""
    def __init__(self, db, *, before=None, after=None):
        self.db = db
        self.connection = RetainedRuntimeConnection(db, before=before, after=after)
        self.active = 0
        self.calls = 0

    @contextmanager
    def __call__(self, url):
        assert url == self.db.app_url and self.active == 0
        self.active += 1
        self.calls += 1
        try:
            with self.connection as connection:
                yield connection
        finally:
            self.active -= 1

    def service(self, original):
        return ActivityNativeTargets(self.db.config, connect=self,
            media_resolver=original.targets.media_resolver)

    def close(self):
        self.connection.close()


def assert_native_session_lock_released(db, context):
    # The injected physical application connection is deliberately still open.
    with db.connect() as observer:
        row = observer.execute("select id from app.account_sessions where id=%s and account_id=%s for update nowait",
                               (context.actor.session_id, context.actor.account_id)).fetchone()
        assert row["id"] == context.actor.session_id


@pytest.mark.parametrize("operation", ["project", "metadata"])
def test_native_action_uses_existing_receipt_and_final_real_session_lock_on_its_injected_transaction(native_activity, operation):
    state, context, original, probes = native_activity
    response = capture_listener(native_activity)
    lease = NativeRuntimeLease(state["db"])
    try:
        result = invoke(lease.service(original), context, response, operation)
        assert result and lease.calls == 1 and lease.active == 0
        operations = lease.connection.operations
        sessions = [index for index, item in enumerate(operations)
                    if item[0] == "sql" and "from app.account_sessions" in item[1] and "for update" in item[1]]
        exports = [index for index, item in enumerate(operations)
                   if item[0] == "sql" and "payload->>'id'=any" in item[1]]
        assert len(sessions) == 2 and len(exports) == 1
        assert sessions[0] < exports[0] < sessions[1]
        assert operations[sessions[0]][2] == operations[sessions[1]][2] == (context.actor.session_id, context.actor.account_id)
        assert ("commit",) in operations[sessions[1] + 1:]
        assert not any(item[0] == "sql" and ("from integration.listen_history h" in item[1]
            or "insert into app.activity_snapshots" in item[1]) for item in operations)
        assert lease.connection.closed is False and not probes
        assert_native_session_lock_released(state["db"], context)
    finally:
        lease.close()


@pytest.mark.parametrize("operation", ["project", "metadata"])
@pytest.mark.parametrize("expiry", ["idle", "absolute"])
def test_session_naturally_expiring_after_native_export_is_denied_by_final_actual_session_check(native_activity, operation, expiry):
    state, context, original, probes = native_activity
    db = state["db"]
    response = capture_listener(native_activity)
    with db.connect() as connection:
        if expiry == "idle":
            connection.execute("update app.account_sessions set idle_expires_at=clock_timestamp()+interval '5 seconds' where id=%s", (context.actor.session_id,))
        else:
            connection.execute("with deadline as (select clock_timestamp()+interval '5 seconds' as at) "
                "update app.account_sessions set idle_expires_at=deadline.at,absolute_expires_at=deadline.at from deadline where id=%s", (context.actor.session_id,))
    session_checks = 0
    reached_final = False
    lease = None
    def before(sql):
        nonlocal session_checks, reached_final
        if "from app.account_sessions" in sql and "for update" in sql:
            session_checks += 1
            if session_checks == 2:
                reached_final = True
                # Real server time crosses a persisted expiry. No session helper,
                # actor state, authority result or request clock is substituted.
                lease.connection.connection.execute("select pg_sleep(greatest(0,extract(epoch from "
                    "(idle_expires_at-clock_timestamp())))+0.02) from app.account_sessions where id=%s",
                    (context.actor.session_id,)).fetchone()
    lease = NativeRuntimeLease(db, before=before)
    try:
        with pytest.raises(PrivateLibraryAuthorityError):
            invoke(lease.service(original), context, response, operation)
        assert reached_final and session_checks == 2
        assert lease.calls == 1 and lease.active == 0 and not probes
        assert ("rollback",) in lease.connection.operations
        with db.connect() as connection:
            expired = connection.execute("select idle_expires_at<=clock_timestamp() as expired from app.account_sessions where id=%s", (context.actor.session_id,)).fetchone()["expired"]
        assert expired is True
        assert_native_session_lock_released(db, context)
    finally:
        lease.close()


@pytest.mark.parametrize("operation", ["project", "metadata"])
def test_another_accepted_subject_cannot_reuse_original_friend_receipt(native_activity, operation):
    state, context, service, probes = native_activity
    response = capture_listener(native_activity)
    with state["db"].connect() as connection:
        other = state["db"].account(connection)
        state["db"].membership(connection, other, context.library_id)
        low, high = sorted((context.actor.account_id, other))
        connection.execute("insert into app.friend_connections(library_id,low_account_id,high_account_id,requester_account_id,state,origin) "
            "values(%s,%s,%s,%s,'accepted','request')", (context.library_id, low, high, context.actor.account_id))
        other_ref = str(connection.execute("select account_ref from app.social_profiles where account_id=%s", (other,)).fetchone()["account_ref"])
    origin = {**response["native_origin"], "subject_ref": other_ref}
    with pytest.raises(HomeActivityError) as caught:
        invoke(service, context, response, operation, origin=origin)
    assert caught.value.status_code == 410 and not probes


def test_native_parent_identities_are_typed_and_scoped_to_the_exact_receipt(native_activity):
    _state, context, service, probes = native_activity
    first = capture_listener(native_activity)
    bindings = invoke(service, context, first, "project")["bindings"]
    assert len(bindings) == 2
    for kind in ("album", "artist"):
        assert bindings[0][kind + "_target"]["identity_ref"] == bindings[1][kind + "_target"]["identity_ref"]
        assert bindings[0][kind + "_target"]["ref"] != bindings[1][kind + "_target"]["ref"]
    assert bindings[0]["album_target"]["identity_ref"] != bindings[0]["artist_target"]["identity_ref"]
    second = capture_listener(native_activity)
    fresh = invoke(service, context, second, "project")["bindings"]
    assert first["native_origin"]["snapshot_ref"] != second["native_origin"]["snapshot_ref"]
    for kind in ("album", "artist"):
        assert bindings[0][kind + "_target"]["identity_ref"] != fresh[0][kind + "_target"]["identity_ref"]
    assert not probes


def test_a_full_hundred_row_page_and_real_continuation_each_receive_exact_native_bindings(native_activity, tmp_path):
    state, context, service, probes = native_activity
    db, data = state["db"], state["data"]
    with db.connect() as connection:
        roots = connection.execute("select id,root_path from library.library_roots where library_id=%s", (context.library_id,)).fetchall()
        assert len(roots) == 1
        root = Path(roots[0]["root_path"]).resolve()
        assert root == (tmp_path / "library").resolve()
        # Existing peer history has two tracks. Add 103 different owned tracks.
        for index in range(3, 106):
            key = "native-listener-" + uuid.uuid4().hex
            path = root / (key + ".flac")
            path.write_bytes(b"synthetic-native-listener-fixture")
            identity = connection.execute("insert into library.local_tracks(library_id,album_id,artist_id,track_key,title,duration_seconds) "
                "values(%s,%s,%s,%s,%s,240) returning id", (context.library_id, data["album"], data["artist"], key, f"Native listener {index:03}")).fetchone()["id"]
            connection.execute("insert into library.local_track_files(track_id,library_root_id,private_path) values(%s,%s,%s)",
                               (identity, roots[0]["id"], str(path)))
            track = {"id": identity, "key": key, "path": str(path)}
            data["tracks"].append(track)
            event = db.event(connection, data, owner=state["peer"], track=track,
                             played_at=NOW - timedelta(seconds=index + 1))
            state["peer_events"].append(event)
    first = capture_listener(native_activity, explicit=True)
    assert len(first["tracks"]) == 100 and first["page"]["total_rows"] == 105
    second = capture_listener(native_activity, explicit=True, cursor=first["page"]["next_cursor"])
    assert len(second["tracks"]) == 5 and second["page"]["next_cursor"] is None
    assert second["native_origin"] == first["native_origin"]
    all_inventory = []
    for response in (first, second):
        selected = list(reversed(refs(response)))
        projected = invoke(service, context, response, "project", row_refs=selected)
        assert_bindings(projected, response, selected)
        assert all(all(binding["allowed_actions"].values()) for binding in projected["bindings"])
        all_inventory.extend(binding["inventory_track_ref"] for binding in projected["bindings"])
    assert len(all_inventory) == len(set(all_inventory)) == 105
    assert not probes


@pytest.mark.parametrize("kind", ["track", "album"])
def test_track_and_album_media_permissions_are_independent_at_native_resolution(native_activity, kind):
    state, context, service, probes = native_activity
    response = capture_listener(native_activity)
    track_id = state["data"]["tracks"][0]["id"]
    denied_id = track_id if kind == "track" else state["data"]["album"]
    constraints = deny("library.media.read", resource_kind=kind, resource_ref=denied_id)
    projected = invoke(service, context, response, "project", constraints=constraints)
    chosen = None
    for binding in projected["bindings"]:
        selected_track = binding["inventory_track_ref"] == f"inventory-track:{context.library_id}:{track_id}"
        expected_play = not (kind == "track" and selected_track)
        assert binding["allowed_actions"]["can_resolve_native_play"] is expected_play
        assert binding["allowed_actions"]["can_resolve_native_details"] is True
        if selected_track:
            chosen = binding["row_ref"]
    assert chosen is not None
    album = service.resolve_listener(context, origin=response["native_origin"], row_ref=chosen,
        intent="details", target_kind="album", constraints=constraints)["native_target"]
    assert album["allowed_actions"] == {"can_view_details": True, "can_play_album": False}
    if kind == "track":
        with pytest.raises(NativeTargetError) as caught:
            invoke(service, context, response, "play", constraints=constraints, row_refs=[chosen])
        assert (caught.value.code, caught.value.status_code) == ("forbidden", 403)
        assert not probes
    else:
        played = invoke(service, context, response, "play", constraints=constraints, row_refs=[chosen])
        assert played["native_target"]["path"] in probes
