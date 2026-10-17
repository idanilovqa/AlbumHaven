"""Production Library Mix APIRouter + private perimeter transport contracts.

Uses the existing resolver/app-state seams from test_private_route_boundary,
real policy/context/CSRF, and the entire production owned-playlists router.
No route is reimplemented. Service spies are transport doubles, not SQL proof.
The final media-denial tests retain the real native service/policy while mocking
only authorized transaction/source reads; they do not establish DB isolation.
"""
from __future__ import annotations

import asyncio
import base64
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
import json
from urllib.parse import urlencode

import pytest
from fastapi import FastAPI, Request

from music_app.routes import owned_playlists_asgi as routes
from music_app.services import library_mix_postgres as mixes
from music_app.services import owned_playlists as commands
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.capabilities import capability_keys_for_roles
from music_app.services.current_actor import CurrentActor
from music_app.services.policy_evaluator import PolicyEvaluationConstraints, PolicyEvaluator
from music_app.services.private_route_boundary import (
    csrf_mode_for_route, install_private_route_boundary, private_action_for_route,
)
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.owned_playlist_testing import (
    ACCOUNT, SESSION, LIBRARY, REQUEST, PLAYLIST, SOURCE, SOURCE_REVISION,
    ENTRY_A, ENTRY_B, NOW, context, create_body,
)

MIX = "/playlists/creation-source/library-mix"
QUEUE = MIX + "/native-queue"
SESSION_TOKEN = "s" * 43
MEDIA = "library.media.read"
REAL_CAPTURE = mixes.capture
REAL_READ = mixes.read_capture
REAL_QUEUE = mixes.native_queue


def recipe(**changes):
    return {"selection_basis": "per_artist", "songs_per_group": 3,
            "auto_update": True, "playback_order": "unplayed_first", **changes}


def queue_body(**changes):
    return {"source_ref": SOURCE, "source_revision": SOURCE_REVISION,
            "entry_refs": [ENTRY_B, ENTRY_A], "starting_entry_ref": ENTRY_A, **changes}


def mix_create_body(**changes):
    return {**create_body(refs=[ENTRY_A, ENTRY_B]),
            "source_protocol": commands.LIBRARY_MIX_PROTOCOL,
            "mix_playback_order": "unplayed_first", **changes}


def source_response():
    return {"status": "ready", "data": {
        "source": {"kind": "library", "ref": SOURCE, "revision": SOURCE_REVISION},
        "source_protocol": commands.LIBRARY_MIX_PROTOCOL,
        "entries_complete": True, "entries": [],
        "library_mix": {"version": 1, "source": "whole_library", "provider": "lastfm",
                        "metric": "overall_scrobbles", **recipe()},
        "allowed_actions": {"can_read": True, "can_use_for_playlist": True, "can_play": False},
        "actor_scope": {"account_id": ACCOUNT, "library_id": LIBRARY},
        "popularity_refresh_status": "queued", "coverage": {"selected_count": 0}}}


def queue_response():
    return {"source": {"kind": "library", "ref": SOURCE, "revision": SOURCE_REVISION},
            "source_protocol": commands.LIBRARY_MIX_PROTOCOL,
            "starting_item_ref": ENTRY_A,
            "tracks": [{"playlist_item_id": ENTRY_A, "play_count": None,
                        "native_target": {"playlist_item_id": ENTRY_A,
                                          "path": "/synthetic/library/track-901.flac",
                                          "track_ref": "/synthetic/library/track-901.flac",
                                          "title": "Synthetic track", "artist": "Synthetic artist",
                                          "album_title": "Synthetic album", "duration_seconds": 123,
                                          "inventory_track_ref": f"inventory-track:{LIBRARY}:901"}}],
            "unavailable_item_refs": [ENTRY_B]}


class Owner:
    def __init__(self):
        self.calls = []
        self.error = None

    def record(self, name, supplied_context, payload, constraints):
        self.calls.append((name, supplied_context, deepcopy(payload), constraints))
        if self.error is not None:
            raise self.error

    def execute(self, supplied_context, command, *, constraints=None):
        self.record("execute", supplied_context, command, constraints)
        return {"ok": True, "action": command.action, "request_key": command.request_key,
                "playlist_id": PLAYLIST, "revision": "1", "changed": True,
                "actor_scope": {"account_id": ACCOUNT, "library_id": LIBRARY}}

    def _authorized(self, *_args, **_kwargs):
        pytest.fail("Rejected input must not reach transaction/source/mutation work")


class Resolver:
    def __init__(self, actor):
        self.actor = actor
        self.calls = []

    def resolve(self, token):
        self.calls.append(token)
        return self.actor


class Harness:
    def __init__(self, owner, resolver, app, constraints):
        self.owner, self.resolver, self.app = owner, resolver, app
        self.constraints = constraints

    def context_ref(self, actor=None):
        actor = self.resolver.actor if actor is None else actor
        return private_ui_context_ref(Request({"type": "http", "app": self.app,
            "state": {"current_actor": actor}, "headers": []}))

    def request(self, method, path, *, payload=None, raw=None, query=None,
                headers=None, omit=(), chunks=None):
        csrf = issue_session_csrf(SESSION_TOKEN, self.app.state.auth_policy_config)
        defaults = {"host": "music.test", "origin": "https://music.test",
            "cookie": f"__Host-album_haven_session={SESSION_TOKEN}; __Host-album_haven_csrf={csrf}",
            "x-album-haven-csrf": csrf, "content-type": "application/json"}
        reference = self.context_ref()
        if reference is not None:
            defaults["x-albumhaven-context"] = reference
        content = raw if raw is not None else json.dumps(payload).encode() if payload is not None else b""
        if chunks is None:
            defaults["content-length"] = str(len(content))
        defaults.update(headers or {})
        for name in omit:
            defaults.pop(name, None)
        request_chunks = list(chunks) if chunks is not None else [content]

        async def run():
            messages = []
            complete = asyncio.Event()

            async def receive():
                if request_chunks:
                    return {"type": "http.request", "body": request_chunks.pop(0),
                            "more_body": bool(request_chunks)}
                # Do not manufacture an early client disconnect that can cancel
                # a streaming middleware response before its body is observed.
                await complete.wait()
                return {"type": "http.disconnect"}

            async def send(message):
                messages.append(message)
                if message["type"] == "http.response.body" and not message.get("more_body", False):
                    complete.set()

            await self.app({"type": "http", "asgi": {"version": "3.0"},
                "http_version": "1.1", "method": method, "scheme": "https",
                "path": path, "raw_path": path.encode("ascii"),
                "query_string": urlencode(query or [], doseq=True).encode("ascii"),
                "headers": [(k.encode("ascii"), v.encode("latin1")) for k, v in defaults.items()],
                "client": ("192.0.2.10", 50000), "server": ("music.test", 443)}, receive, send)
            start = next(m for m in messages if m["type"] == "http.response.start")
            body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
            return start["status"], {k.decode().lower(): v.decode() for k, v in start["headers"]}, json.loads(body) if body else None

        return asyncio.run(run())


@pytest.fixture
def boundary(monkeypatch):
    owner = Owner()
    resolver = Resolver(context(grants=(commands.BROWSE, commands.CREATE)).actor)
    app = FastAPI()
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"}
    app.state.auth_policy_config = {
        "hmac": {"secret": "synthetic-route-origin-and-context-key-32", "key_version": 1}}
    app.state.current_actor_resolver = resolver
    app.state.owned_playlists_service = owner
    constraints = lambda _context: PolicyEvaluationConstraints()
    app.state.policy_constraint_resolver = constraints
    app.include_router(routes.router)
    install_private_route_boundary(app)

    def capture(service, supplied, payload, *, constraints=None):
        assert service is owner
        owner.record("capture", supplied, payload, constraints)
        return source_response()

    def read(service, supplied, ref, revision, *, constraints=None):
        assert service is owner
        owner.record("read", supplied, (ref, revision), constraints)
        return source_response()

    def native(service, supplied, payload, *, constraints=None):
        assert service is owner
        owner.record("queue", supplied, payload, constraints)
        return queue_response()

    monkeypatch.setattr(mixes, "capture", capture)
    monkeypatch.setattr(mixes, "read_capture", read)
    monkeypatch.setattr(mixes, "native_queue", native)
    return Harness(owner, resolver, app, constraints)


def assert_error(response, code, status):
    actual_status, headers, payload = response
    assert actual_status == status
    assert headers["cache-control"] == "private, no-store"
    assert payload == {"ok": False, "error": code}


@pytest.mark.parametrize("method,path,action,csrf", [
    ("POST", MIX, commands.CREATE, "session_header"),
    ("GET", MIX, commands.CREATE, "none"),
    ("POST", QUEUE, commands.BROWSE, "session_header"),
])
def test_new_routes_have_explicit_current_capabilities_and_csrf(method, path, action, csrf):
    assert private_action_for_route(method, path) == action
    assert csrf_mode_for_route(method, path) == csrf


def test_real_route_registration_is_unique_and_static_sources_precede_playlist_writes():
    registered = {}
    for route in routes.router.routes:
        seen = registered.setdefault(route.path, set())
        assert not seen.intersection(route.methods), (route.path, route.methods)
        seen.update(route.methods)
    assert registered[MIX] == {"POST", "GET"}
    assert registered[QUEUE] == {"POST"}
    paths = [route.path for route in routes.router.routes]
    assert paths.index(MIX) < paths.index("/playlists/{playlist_ref}")
    assert paths.index(QUEUE) < paths.index("/playlists/{playlist_ref}")


@pytest.mark.parametrize("method,path,body,query,name,action", [
    ("POST", MIX, recipe(), None, "capture", commands.CREATE),
    ("GET", MIX, None, {"source_ref": SOURCE, "source_revision": SOURCE_REVISION}, "read", commands.CREATE),
    ("POST", QUEUE, queue_body(), None, "queue", commands.BROWSE),
])
def test_real_router_dispatches_current_actor_scope_constraints_and_exact_payload(
        boundary, method, path, body, query, name, action):
    status, headers, result = boundary.request(method, path, payload=body, query=query,
        headers={"x-album-haven-client-surface": "desktop"})
    assert status == 200
    assert headers["cache-control"] == "private, no-store"
    expected = {"status": "ready", "data": queue_response()} if path == QUEUE else source_response()
    assert result == {**expected, "context_ref": boundary.context_ref()}
    assert boundary.resolver.calls == [SESSION_TOKEN]
    assert len(boundary.owner.calls) == 1
    called, supplied, payload, constraints = boundary.owner.calls[0]
    assert called == name and supplied.action == action
    assert supplied.actor is boundary.resolver.actor
    assert supplied.library_id == LIBRARY and supplied.client_surface_class == "private_web"
    assert constraints is boundary.constraints
    assert payload == ((SOURCE, SOURCE_REVISION) if method == "GET" else body)


@pytest.mark.parametrize("method,path", [("POST", MIX), ("GET", MIX), ("POST", QUEUE)])
def test_anonymous_requests_stop_at_authentication_without_service_calls(boundary, method, path):
    boundary.resolver.actor = CurrentActor.anonymous()
    status, headers, payload = boundary.request(method, path,
        payload=recipe() if path == MIX else queue_body(),
        query={"source_ref": SOURCE, "source_revision": SOURCE_REVISION} if method == "GET" else None,
        omit=("cookie", "x-album-haven-csrf"))
    assert status == 401 and payload == {"detail": "Authentication required."}
    assert headers["cache-control"] == "private, no-store"
    assert boundary.resolver.calls == [None]
    assert boundary.owner.calls == []


@pytest.mark.parametrize("method", ["POST", "GET"])
def test_browse_member_has_intrinsic_personal_create_without_media_grant(boundary, method):
    supplied = context(grants=(commands.BROWSE,))
    boundary.resolver.actor = supplied.actor
    evaluator = PolicyEvaluator()
    assert evaluator.evaluate(replace(supplied, action=commands.CREATE)).decision.allowed
    assert not evaluator.evaluate(replace(supplied, action=MEDIA)).decision.allowed
    status, headers, payload = boundary.request(method, MIX, payload=recipe(),
        query={"source_ref": SOURCE, "source_revision": SOURCE_REVISION} if method == "GET" else None)
    assert status == 200 and headers["cache-control"] == "private, no-store"
    assert payload == {**source_response(), "context_ref": boundary.context_ref()}
    assert len(boundary.owner.calls) == 1
    name, current, _payload, constraints = boundary.owner.calls[0]
    assert name == ("capture" if method == "POST" else "read")
    assert current.actor is supplied.actor and current.action == commands.CREATE
    assert constraints is boundary.constraints


def test_native_queue_without_browse_is_denied_before_service(boundary):
    boundary.resolver.actor = context(grants=(commands.CREATE,)).actor
    status, headers, payload = boundary.request("POST", QUEUE, payload=queue_body())
    assert status == 403 and payload == {"detail": "Action not permitted."}
    assert headers["cache-control"] == "private, no-store"
    assert boundary.owner.calls == []


@pytest.mark.parametrize("role", ["viewer", "listener", "musician", "owner", "admin"])
@pytest.mark.parametrize("method,path", [("POST", MIX), ("GET", MIX), ("POST", "/playlists")])
def test_actual_role_presets_can_generate_read_and_save_personal_mixes(boundary, role, method, path):
    supplied = context(grants=capability_keys_for_roles((role,)))
    boundary.resolver.actor = supplied.actor
    evaluator = PolicyEvaluator()
    assert evaluator.evaluate(replace(supplied, action=commands.CREATE)).decision.allowed
    assert evaluator.evaluate(replace(supplied, action=MEDIA)).decision.allowed is (
        role in {"listener", "musician", "owner"})
    status, headers, payload = boundary.request(method, path,
        payload=mix_create_body() if path == "/playlists" else recipe(),
        query={"source_ref": SOURCE, "source_revision": SOURCE_REVISION} if method == "GET" else None)
    assert status == 200 and headers["cache-control"] == "private, no-store"
    assert payload["status"] == "ready" and payload["context_ref"] == boundary.context_ref()
    if path == "/playlists":
        assert payload["data"]["playlist_id"] == PLAYLIST
    else:
        assert payload == {**source_response(), "context_ref": boundary.context_ref()}
    assert len(boundary.owner.calls) == 1
    name, current, _payload, constraints = boundary.owner.calls[0]
    assert name == ("execute" if path == "/playlists" else "read" if method == "GET" else "capture")
    assert current.actor is supplied.actor and current.action == commands.CREATE
    assert constraints is boundary.constraints


@pytest.mark.parametrize("method,path,denied_action", [
    ("POST", MIX, commands.CREATE), ("GET", MIX, commands.CREATE),
    ("POST", QUEUE, commands.BROWSE),
])
def test_intrinsic_personal_authority_still_obeys_current_route_policy_constraints(
        boundary, method, path, denied_action):
    boundary.resolver.actor = context(grants=(commands.BROWSE,)).actor
    observed = []

    def constraints(supplied):
        observed.append(supplied.action)
        return PolicyEvaluationConstraints(client_surface_allowed=supplied.action != denied_action)

    boundary.app.state.policy_constraint_resolver = constraints
    status, headers, payload = boundary.request(method, path,
        payload=recipe() if path == MIX else queue_body(),
        query={"source_ref": SOURCE, "source_revision": SOURCE_REVISION} if method == "GET" else None)
    assert status == 403 and payload == {"detail": "Action not permitted."}
    assert headers["cache-control"] == "private, no-store"
    assert observed == [denied_action]
    assert boundary.owner.calls == []


@pytest.mark.parametrize("path", [MIX, QUEUE])
@pytest.mark.parametrize("case", ["missing_origin", "cross_origin", "missing_header", "missing_cookie",
                                  "header_mismatch", "wrong_session_token"])
def test_new_posts_enforce_real_session_csrf_before_service(boundary, path, case):
    headers, omit = {}, ()
    if case == "missing_origin":
        omit = ("origin",)
    elif case == "cross_origin":
        headers["origin"] = "https://attacker.test"
    elif case == "missing_header":
        omit = ("x-album-haven-csrf",)
    elif case == "missing_cookie":
        headers["cookie"] = f"__Host-album_haven_session={SESSION_TOKEN}"
    elif case == "header_mismatch":
        headers["x-album-haven-csrf"] = "x" * 43
    else:
        other_session = base64.urlsafe_b64encode(bytes(range(32))).decode("ascii").rstrip("=")
        assert other_session != SESSION_TOKEN
        wrong = issue_session_csrf(other_session, boundary.app.state.auth_policy_config)
        headers.update(cookie=f"__Host-album_haven_session={SESSION_TOKEN}; __Host-album_haven_csrf={wrong}",
                       **{"x-album-haven-csrf": wrong})
    status, response_headers, payload = boundary.request("POST", path,
        payload=recipe() if path == MIX else queue_body(), headers=headers, omit=omit)
    assert status == 403 and payload == {"detail": "CSRF validation failed."}
    assert response_headers["cache-control"] == "private, no-store"
    assert boundary.resolver.calls == [SESSION_TOKEN]
    assert boundary.owner.calls == []


@pytest.mark.parametrize("path", [MIX, QUEUE, "/playlists"])
@pytest.mark.parametrize("supplied", [None, "", "0" * 63, "0" * 64, "é" * 64])
def test_fresh_context_is_required_for_every_mix_mutation(boundary, path, supplied):
    headers = {} if supplied is None else {"x-albumhaven-context": supplied}
    assert_error(boundary.request("POST", path, payload=recipe(), headers=headers,
        omit=("x-albumhaven-context",) if supplied is None else ()), "stale_context", 409)
    assert boundary.owner.calls == []


@pytest.mark.parametrize("path", [MIX, QUEUE])
@pytest.mark.parametrize("field,value", [("account_id", ACCOUNT + 1), ("session_id", SESSION + 1),
                                         ("current_library_id", LIBRARY + 1)])
def test_header_from_previous_identity_cannot_cross_current_scope(boundary, path, field, value):
    old_actor = replace(boundary.resolver.actor, **{field: value})
    assert_error(boundary.request("POST", path, payload=recipe(),
        headers={"x-albumhaven-context": boundary.context_ref(old_actor)}), "stale_context", 409)
    assert boundary.owner.calls == []


@pytest.mark.parametrize("path", [MIX, QUEUE])
def test_post_query_cannot_smuggle_scope_or_selection(boundary, path):
    assert_error(boundary.request("POST", path, payload=recipe(), query={"library_id": 999}), "invalid_command", 422)
    assert boundary.owner.calls == []


@pytest.mark.parametrize("query", [[], [("source_ref", SOURCE)], [("source_revision", SOURCE_REVISION)],
    [("source_ref", SOURCE), ("source_revision", SOURCE_REVISION), ("q", "needle")],
    [("source_ref", SOURCE), ("source_ref", SOURCE), ("source_revision", SOURCE_REVISION)],
    [("source_ref", SOURCE), ("source_revision", SOURCE_REVISION), ("source_revision", SOURCE_REVISION)]])
def test_source_query_requires_one_exact_tuple_before_service(boundary, query):
    assert_error(boundary.request("GET", MIX, query=query), "invalid_source_query", 422)
    assert boundary.owner.calls == []


@pytest.mark.parametrize("field", ["source_ref", "source_revision"])
@pytest.mark.parametrize("invalid", ["", "not-a-uuid", "0", "é"])
def test_source_tuple_values_use_real_service_validation_before_transaction(boundary, monkeypatch, field, invalid):
    monkeypatch.setattr(mixes, "read_capture", REAL_READ)
    query = {"source_ref": SOURCE, "source_revision": SOURCE_REVISION, field: invalid}
    assert_error(boundary.request("GET", MIX, query=query), "invalid_command", 422)
    assert boundary.owner.calls == []


@pytest.mark.parametrize("path,limit", [(MIX, 4096), (QUEUE, commands.MAX_PLAYLIST_COMMAND_BYTES)])
@pytest.mark.parametrize("case", ["declared_large", "stream_large", "exact_limit"])
def test_body_byte_limit_is_exact_and_applies_to_streams(boundary, path, limit, case):
    payload = recipe() if path == MIX else queue_body()
    encoded = json.dumps(payload).encode()
    raw = encoded + b" " * (limit - len(encoded))
    if case == "declared_large":
        response = boundary.request("POST", path, raw=b"{}", headers={"content-length": str(limit + 1)})
    elif case == "stream_large":
        response = boundary.request("POST", path, chunks=[raw, b" "])
    else:
        response = boundary.request("POST", path, chunks=[raw[:101], raw[101:]])
    if case == "exact_limit":
        assert response[0] == 200
        assert len(boundary.owner.calls) == 1 and boundary.owner.calls[0][2] == payload
    else:
        assert_error(response, "command_too_large", 413)
        assert boundary.owner.calls == []


@pytest.mark.parametrize("path,function,error", [(MIX, REAL_CAPTURE, "invalid_library_mix_recipe"),
                                                (QUEUE, REAL_QUEUE, "invalid_command")])
@pytest.mark.parametrize("raw,length", [(b"{", None), (b"[]", None), (b"null", None),
    (b"1", None), (b"\xff", None), (b"{}", "oops"), (b"{}", "-1"), (b"{}", "3")])
def test_invalid_json_and_lengths_reject_before_command_side_effects(boundary, monkeypatch, path, function, error, raw, length):
    monkeypatch.setattr(mixes, "capture" if path == MIX else "native_queue", function)
    headers = {"content-length": length} if length is not None else {}
    assert_error(boundary.request("POST", path, raw=raw, headers=headers), error, 422)
    assert boundary.owner.calls == []


@pytest.mark.parametrize("changes", [{"songs_per_group": True}, {"songs_per_group": 0},
    {"songs_per_group": 5001}, {"auto_update": 1}, {"selection_basis": "playlist"},
    {"playback_order": "personal_popularity"}, {"provider": "personal_lastfm"},
    {"library_id": 999}, {"source": "current_page"}, {"entry_refs": [ENTRY_A]}])
def test_recipe_contract_is_whole_library_exact_and_validated_before_capture(boundary, monkeypatch, changes):
    monkeypatch.setattr(mixes, "capture", REAL_CAPTURE)
    assert_error(boundary.request("POST", MIX, payload=recipe(**changes)), "invalid_library_mix_recipe", 422)
    assert boundary.owner.calls == []


@pytest.mark.parametrize("changes", [{"entry_refs": []}, {"entry_refs": "bad"},
    {"entry_refs": [ENTRY_A, ENTRY_A]}, {"entry_refs": [ENTRY_A] * 5001},
    {"entry_refs": ["bad"]}, {"starting_entry_ref": PLAYLIST},
    {"source_ref": "bad"}, {"source_revision": "bad"},
    {"library_id": 999}, {"native_target": {"path": "/untrusted"}}])
def test_queue_shape_is_validated_by_real_service_before_transaction(boundary, monkeypatch, changes):
    monkeypatch.setattr(mixes, "native_queue", REAL_QUEUE)
    assert_error(boundary.request("POST", QUEUE, payload=queue_body(**changes)), "invalid_command", 422)
    assert boundary.owner.calls == []


@pytest.mark.parametrize("field", ["source_ref", "source_revision", "entry_refs", "starting_entry_ref"])
def test_queue_requires_all_four_fields(boundary, monkeypatch, field):
    monkeypatch.setattr(mixes, "native_queue", REAL_QUEUE)
    payload = queue_body()
    del payload[field]
    assert_error(boundary.request("POST", QUEUE, payload=payload), "invalid_command", 422)
    assert boundary.owner.calls == []


@pytest.mark.parametrize("order", ["regular", "shuffle", "unplayed_first"])
def test_existing_create_route_accepts_mix_protocol_and_preserves_order(boundary, order):
    status, headers, payload = boundary.request("POST", "/playlists",
        payload=mix_create_body(entry_refs=[ENTRY_B, ENTRY_A], mix_playback_order=order))
    assert status == 200 and headers["cache-control"] == "private, no-store"
    assert payload["status"] == "ready" and payload["context_ref"] == boundary.context_ref()
    assert payload["data"]["playlist_id"] == PLAYLIST
    _, supplied, command, constraints = boundary.owner.calls[0]
    assert supplied.action == commands.CREATE and constraints is boundary.constraints
    assert command.action == "create" and command.request_key == REQUEST
    assert command.data["source_protocol"] == commands.LIBRARY_MIX_PROTOCOL
    assert command.data["entry_refs"] == [ENTRY_B, ENTRY_A]
    assert command.data["mix_playback_order"] == order


@pytest.mark.parametrize("changes", [{"source_protocol": "untrusted_mix"}, {"mode": "missing"},
    {"mix_playback_order": "wrong"}, {"entry_refs": [ENTRY_A, ENTRY_A]},
    {"source": {"kind": "playlist", "ref": SOURCE, "revision": SOURCE_REVISION}},
    {"account_id": 999}, {"library_id": 999}, {"actor_scope": {"account_id": 999}}])
def test_existing_create_route_rejects_invalid_mix_commands_before_execute(boundary, changes):
    assert_error(boundary.request("POST", "/playlists", payload=mix_create_body(**changes)), "invalid_command", 422)
    assert boundary.owner.calls == []


def test_mix_playback_option_cannot_expand_ordinary_selection_protocol(boundary):
    assert_error(boundary.request("POST", "/playlists", payload={**create_body(),
        "mix_playback_order": "shuffle"}), "invalid_command", 422)
    assert boundary.owner.calls == []


@pytest.mark.parametrize("method,path", [("POST", MIX), ("GET", MIX), ("POST", QUEUE), ("POST", "/playlists")])
@pytest.mark.parametrize("code,status", [("forbidden", 403), ("source_unavailable", 404),
    ("source_expired", 410), ("source_changed", 409), ("library_mix_unavailable", 503)])
def test_service_errors_propagate_without_success_envelope_or_retry(boundary, method, path, code, status):
    boundary.owner.error = commands.PlaylistError(code, status)
    payload = recipe() if path == MIX else queue_body() if path == QUEUE else mix_create_body()
    assert_error(boundary.request(method, path, payload=payload,
        query={"source_ref": SOURCE, "source_revision": SOURCE_REVISION} if method == "GET" else None), code, status)
    assert len(boundary.owner.calls) == 1


@pytest.mark.parametrize("method,path", [("PUT", MIX), ("PATCH", MIX), ("DELETE", MIX),
    ("GET", QUEUE), ("PUT", QUEUE), ("POST", MIX + "/extra")])
def test_unsupported_methods_and_paths_never_dispatch_commands(boundary, method, path):
    # Unknown method/path classifications default to app.access. An owner makes
    # this a routing assertion rather than a generic-capability denial check.
    boundary.resolver.actor = context(bootstrap=True).actor
    status, _headers, _body = boundary.request(method, path, payload=recipe())
    assert status == (404 if path.endswith("/extra") else 405)
    assert boundary.owner.calls == []


@pytest.mark.parametrize("grants,denied_action,error,status,source_count", [
    ((commands.BROWSE,), None, "item_unavailable", 404, 1),
    ((commands.BROWSE, MEDIA), MEDIA, "item_unavailable", 404, 1),
    ((commands.BROWSE, MEDIA), commands.CREATE, "forbidden", 403, 0),
])
def test_intrinsic_create_and_media_obey_independent_native_policy_controls(
        boundary, monkeypatch, grants, denied_action, error, status, source_count):
    """Real native policy, mocked source/transaction; no DB or filesystem proof."""
    boundary.resolver.actor = context(grants=grants).actor
    if denied_action is not None:
        boundary.app.state.policy_constraint_resolver = lambda supplied: PolicyEvaluationConstraints(
            client_surface_allowed=supplied.action != denied_action)
    monkeypatch.setattr(mixes, "native_queue", REAL_QUEUE)
    source_calls = []

    class NoSQL:
        def execute(self, *_args, **_kwargs):
            pytest.fail("Media denial must happen before media or personal-count SQL")

    @contextmanager
    def authorized(supplied, constraints):
        yield NoSQL(), supplied, NOW

    boundary.owner._config = {}
    boundary.owner._authorized = authorized
    boundary.owner._require = routes.PostgresOwnedPlaylistsService._require

    def load_source(connection, supplied, ref, revision, now, **kwargs):
        source_calls.append((supplied, ref, revision, kwargs))
        return {"origin_descriptor": {"entry_order": [ENTRY_A, ENTRY_B]}}

    monkeypatch.setattr(mixes.sources, "load_source", load_source)
    monkeypatch.setattr(mixes, "selected", lambda *_args, **_kwargs: [
        {"ref": ENTRY_A, "original_local_track_id": 901},
        {"ref": ENTRY_B, "original_local_track_id": 902}])
    assert_error(boundary.request("POST", QUEUE, payload=queue_body()), error, status)
    assert len(source_calls) == source_count
    if source_count:
        assert source_calls[0][3] == {"protocol": commands.LIBRARY_MIX_PROTOCOL, "kind": "library"}
    assert boundary.owner.calls == []


@pytest.mark.parametrize("field", ["selection_basis", "songs_per_group", "auto_update"])
def test_recipe_requires_each_mandatory_field_before_capture(boundary, monkeypatch, field):
    monkeypatch.setattr(mixes, "capture", REAL_CAPTURE)
    payload = recipe()
    del payload[field]
    assert_error(boundary.request("POST", MIX, payload=payload), "invalid_library_mix_recipe", 422)
    assert boundary.owner.calls == []


def test_native_queue_returns_exact_ready_envelope_for_shared_private_ui_consumer(boundary):
    status, headers, payload = boundary.request("POST", QUEUE, payload=queue_body())
    assert status == 200 and headers["cache-control"] == "private, no-store"
    assert payload == {"status": "ready", "data": queue_response(),
                       "context_ref": boundary.context_ref()}
    assert payload["data"]["starting_item_ref"] == ENTRY_A
    assert payload["data"]["tracks"][0]["playlist_item_id"] == ENTRY_A
    target = payload["data"]["tracks"][0]["native_target"]
    assert target["path"] == target["track_ref"] == "/synthetic/library/track-901.flac"
    assert target["playlist_item_id"] == ENTRY_A
    assert payload["data"]["unavailable_item_refs"] == [ENTRY_B]
    assert len(boundary.owner.calls) == 1 and boundary.owner.calls[0][0] == "queue"
