"""Artist Loves transport through the real router, policy, context and CSRF.

Only service results are spies here. Real SQL/authority/native contracts live in
test_artist_loved_persistence_live.py; no fake policy or app.access admission.
"""
import asyncio
from dataclasses import replace
import json
from urllib.parse import urlencode

import pytest

from music_app.services import artist_loved_playlists_postgres as loved
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.capabilities import capability_keys_for_roles
from music_app.services.current_actor import CurrentActor
from music_app.services.policy_evaluator import PolicyEvaluationConstraints, PolicyEvaluator
from tests.py.test_library_mix_route_boundary import (
    boundary, assert_error, commands, context, create_body, routes,
    private_action_for_route, csrf_mode_for_route, SOURCE, SOURCE_REVISION,
    ENTRY_A, ENTRY_B, ACCOUNT, LIBRARY, SESSION_TOKEN, MEDIA, queue_body,
    queue_response,
)

BASE = "/playlists/creation-source/artist-loved"
QUEUE = BASE + "/native-queue"
PROTOCOL = "artist_loved_selection_v1"
REAL_CAPTURE, REAL_READ, REAL_QUEUE = loved.capture, loved.read_capture, loved.native_queue


def descriptor(**changes):
    return {"version": 1, "root_artist_id": "901", "scope_mode": "artist", **changes}


def loved_source():
    return {"status": "ready", "data": {
        "source": {"kind": "library", "ref": SOURCE, "revision": SOURCE_REVISION},
        "source_protocol": PROTOCOL, "entries_complete": True, "entries": [],
        "retained_parent_albums": [],
        "artist_loved": {**descriptor(), "source": "artist_loved", "auto_update": True,
                         "playback_order": "regular"},
        "actor_scope": {"account_id": ACCOUNT, "library_id": LIBRARY},
        "allowed_actions": {"can_read": True, "can_use_for_playlist": True, "can_play": False}}}


def loved_queue():
    return {**queue_response(), "source_protocol": PROTOCOL}


@pytest.fixture
def loved_boundary(boundary, monkeypatch):
    def record(name, service, supplied, payload, *, constraints=None):
        assert service is boundary.owner
        service.record(name, supplied, payload, constraints)
        return loved_queue() if name == "queue" else loved_source()
    monkeypatch.setattr(loved, "capture", lambda service, supplied, payload, **kw:
                        record("capture", service, supplied, payload, **kw))
    monkeypatch.setattr(loved, "read_capture", lambda service, supplied, ref, revision, **kw:
                        record("read", service, supplied, (ref, revision), **kw))
    monkeypatch.setattr(loved, "native_queue", lambda service, supplied, payload, **kw:
                        record("queue", service, supplied, payload, **kw))
    return boundary


@pytest.mark.parametrize("method,path,action", [
    ("POST", BASE, commands.CREATE), ("GET", BASE, commands.CREATE),
    ("POST", QUEUE, commands.BROWSE),
])
def test_exact_routes_use_existing_actions_and_session_csrf(method, path, action):
    assert private_action_for_route(method, path) == action
    assert csrf_mode_for_route(method, path) == ("none" if method == "GET" else "session_header")


def test_router_has_one_owner_and_no_regeneration_or_dynamic_path_shadow():
    registered = {}
    for route in routes.router.routes:
        seen = registered.setdefault(route.path, set())
        assert not seen.intersection(route.methods)
        seen.update(route.methods)
    assert registered[BASE] == {"GET", "POST"}
    assert registered[QUEUE] == {"POST"}
    assert BASE + "/regenerate" not in registered
    paths = [route.path for route in routes.router.routes]
    assert paths.index(BASE) < paths.index("/playlists/{playlist_ref}")
    assert paths.index(QUEUE) < paths.index("/playlists/{playlist_ref}")


@pytest.mark.parametrize("method,path,name,action", [
    ("POST", BASE, "capture", commands.CREATE), ("GET", BASE, "read", commands.CREATE),
    ("POST", QUEUE, "queue", commands.BROWSE),
])
def test_dispatch_keeps_exact_descriptor_source_and_current_context(loved_boundary, method, path, name, action):
    h = loved_boundary
    body = queue_body() if path == QUEUE else descriptor()
    query = {"source_ref": SOURCE, "source_revision": SOURCE_REVISION} if method == "GET" else None
    status, headers, result = h.request(method, path, payload=body if method == "POST" else None, query=query)
    assert status == 200 and headers["cache-control"] == "private, no-store"
    expected = {"status": "ready", "data": loved_queue()} if path == QUEUE else loved_source()
    assert result == {**expected, "context_ref": h.context_ref()}
    assert h.resolver.calls == [SESSION_TOKEN]
    assert len(h.owner.calls) == 1
    called, supplied, payload, constraints = h.owner.calls[0]
    assert called == name and supplied.action == action
    assert supplied.actor is h.resolver.actor and supplied.library_id == LIBRARY
    assert constraints is h.constraints
    assert payload == ((SOURCE, SOURCE_REVISION) if method == "GET" else body)


@pytest.mark.parametrize("method,path", [("POST", BASE), ("GET", BASE), ("POST", QUEUE), ("POST", "/playlists")])
def test_actual_library_scoped_viewer_can_read_and_create_without_media(loved_boundary, method, path):
    h = loved_boundary
    supplied = context(grants=capability_keys_for_roles(("viewer",)))
    assert all(g.scope_kind == "library" and g.scope_id == LIBRARY for g in supplied.actor.capability_grants)
    h.resolver.actor = supplied.actor
    assert PolicyEvaluator().evaluate(replace(supplied, action=commands.CREATE)).decision.allowed
    assert not PolicyEvaluator().evaluate(replace(supplied, action=MEDIA)).decision.allowed
    body = ({**create_body(refs=[]), "source_protocol": PROTOCOL} if path == "/playlists"
            else queue_body() if path == QUEUE else descriptor())
    result = h.request(method, path, payload=body if method == "POST" else None,
        query={"source_ref": SOURCE, "source_revision": SOURCE_REVISION} if method == "GET" else None)
    assert result[0] == 200 and result[1]["cache-control"] == "private, no-store"
    assert len(h.owner.calls) == 1
    # The queue spy proves coarse Browse admission only. The live suite proves
    # this same Viewer cannot resolve media through the real native service.


@pytest.mark.parametrize("method,path", [("POST", BASE), ("GET", BASE), ("POST", QUEUE)])
def test_anonymous_stops_at_real_authentication(loved_boundary, method, path):
    h = loved_boundary
    h.resolver.actor = CurrentActor.anonymous()
    status, headers, body = h.request(method, path, payload=descriptor(),
        query={"source_ref": SOURCE, "source_revision": SOURCE_REVISION} if method == "GET" else None,
        omit=("cookie", "x-album-haven-csrf"))
    assert status == 401 and body == {"detail": "Authentication required."}
    assert headers["cache-control"] == "private, no-store" and h.owner.calls == []


@pytest.mark.parametrize("path", [BASE, QUEUE])
@pytest.mark.parametrize("case", ["origin_missing", "origin_cross", "header_missing", "cookie_missing", "mismatch"])
def test_post_csrf_rejects_before_service(loved_boundary, path, case):
    h = loved_boundary
    headers, omit = {}, ()
    if case == "origin_missing": omit = ("origin",)
    elif case == "origin_cross": headers["origin"] = "https://attacker.test"
    elif case == "header_missing": omit = ("x-album-haven-csrf",)
    elif case == "cookie_missing": headers["cookie"] = f"__Host-album_haven_session={SESSION_TOKEN}"
    else: headers["x-album-haven-csrf"] = "x" * 43
    status, response_headers, body = h.request("POST", path, payload=descriptor(), headers=headers, omit=omit)
    assert status == 403 and body == {"detail": "CSRF validation failed."}
    assert response_headers["cache-control"] == "private, no-store" and h.owner.calls == []


@pytest.mark.parametrize("path", [BASE, QUEUE])
@pytest.mark.parametrize("case", ["missing", "stale", "session", "account", "library"])
def test_context_replacement_cannot_reuse_old_action(loved_boundary, path, case):
    h = loved_boundary
    actor = h.resolver.actor
    fields = {"session": "session_id", "account": "account_id", "library": "current_library_id"}
    value = (h.context_ref(replace(actor, **{fields[case]: getattr(actor, fields[case]) + 1}))
             if case in fields else "stale")
    assert_error(h.request("POST", path, payload=descriptor(),
        headers={"x-albumhaven-context": value},
        omit=("x-albumhaven-context",) if case == "missing" else ()), "stale_context", 409)
    assert h.owner.calls == []


@pytest.mark.parametrize("method,path", [("POST", BASE), ("GET", BASE), ("POST", QUEUE)])
def test_current_constraints_cannot_be_bypassed_by_intrinsic_create(loved_boundary, method, path):
    h = loved_boundary
    h.app.state.policy_constraint_resolver = lambda _context: PolicyEvaluationConstraints(client_surface_allowed=False)
    status, headers, body = h.request(method, path, payload=descriptor(),
        query={"source_ref": SOURCE, "source_revision": SOURCE_REVISION} if method == "GET" else None)
    assert status == 403 and body == {"detail": "Action not permitted."}
    assert headers["cache-control"] == "private, no-store" and h.owner.calls == []


@pytest.mark.parametrize("query", [[], [("source_ref", SOURCE)], [("source_revision", SOURCE_REVISION)],
    [("source_ref", SOURCE), ("source_revision", SOURCE_REVISION), ("root_artist_id", "901")],
    [("source_ref", SOURCE), ("source_ref", SOURCE), ("source_revision", SOURCE_REVISION)],
    [("source_ref", SOURCE), ("source_revision", SOURCE_REVISION), ("source_revision", SOURCE_REVISION)]])
def test_get_requires_one_exact_source_tuple(loved_boundary, query):
    assert_error(loved_boundary.request("GET", BASE, query=query), "invalid_source_query", 422)
    assert loved_boundary.owner.calls == []


@pytest.mark.parametrize("path", [BASE, QUEUE])
def test_post_rejects_query_scope_smuggling(loved_boundary, path):
    assert_error(loved_boundary.request("POST", path, payload=descriptor(), query={"library_id": 999}), "invalid_command", 422)
    assert loved_boundary.owner.calls == []


@pytest.mark.parametrize("path,limit", [(BASE, commands.MAX_PLAYLIST_COMMAND_BYTES), (QUEUE, commands.MAX_PLAYLIST_COMMAND_BYTES)])
@pytest.mark.parametrize("case", ["declared_large", "stream_large", "exact_limit"])
def test_exact_byte_limits_apply_to_declared_and_streamed_body(loved_boundary, path, limit, case):
    body = descriptor() if path == BASE else queue_body()
    raw = json.dumps(body).encode()
    raw += b" " * (limit - len(raw))
    if case == "declared_large":
        result = loved_boundary.request("POST", path, raw=b"{}", headers={"content-length": str(limit + 1)})
    elif case == "stream_large":
        result = loved_boundary.request("POST", path, chunks=[raw, b" "])
    else:
        result = loved_boundary.request("POST", path, chunks=[raw[:101], raw[101:]])
    if case == "exact_limit":
        assert result[0] == 200 and loved_boundary.owner.calls[0][2] == body
    else:
        assert_error(result, "command_too_large", 413)
        assert loved_boundary.owner.calls == []


@pytest.mark.parametrize("changes", [{"version": True}, {"root_artist_id": 901},
    {"root_artist_id": "0"}, {"root_artist_id": "0901"}, {"scope_mode": "current_page"},
    {"library_id": LIBRARY}, {"entry_refs": []}, {"playback_order": "shuffle"},
    {"filter": "loved"}, {"root_artist_name": "Replacement"}, {"recipe": {}}])
def test_real_capture_rejects_noncanonical_descriptor_before_transaction(loved_boundary, monkeypatch, changes):
    monkeypatch.setattr(loved, "capture", REAL_CAPTURE)
    assert_error(loved_boundary.request("POST", BASE, payload=descriptor(**changes)), "invalid_artist_loved_descriptor", 422)
    assert loved_boundary.owner.calls == []


@pytest.mark.parametrize("field", ["source_ref", "source_revision"])
def test_real_read_rejects_bad_uuid_before_transaction(loved_boundary, monkeypatch, field):
    monkeypatch.setattr(loved, "read_capture", REAL_READ)
    assert_error(loved_boundary.request("GET", BASE, query={"source_ref": SOURCE,
        "source_revision": SOURCE_REVISION, field: "not-a-uuid"}), "invalid_command", 422)
    assert loved_boundary.owner.calls == []


@pytest.mark.parametrize("changes", [{"entry_refs": []}, {"entry_refs": [ENTRY_A, ENTRY_A]},
    {"entry_refs": [ENTRY_A] * 5001}, {"entry_refs": ["bad"]}, {"starting_entry_ref": SOURCE},
    {"source_ref": "bad"}, {"source_revision": "bad"}, {"library_id": LIBRARY},
    {"native_target": {"path": "/untrusted"}}])
def test_real_queue_rejects_untrusted_command_before_transaction(loved_boundary, monkeypatch, changes):
    monkeypatch.setattr(loved, "native_queue", REAL_QUEUE)
    assert_error(loved_boundary.request("POST", QUEUE, payload=queue_body(**changes)), "invalid_command", 422)
    assert loved_boundary.owner.calls == []


@pytest.mark.parametrize("field", ["source_ref", "source_revision", "entry_refs", "starting_entry_ref"])
def test_real_queue_requires_all_fields(loved_boundary, monkeypatch, field):
    monkeypatch.setattr(loved, "native_queue", REAL_QUEUE)
    payload = queue_body()
    del payload[field]
    assert_error(loved_boundary.request("POST", QUEUE, payload=payload), "invalid_command", 422)


@pytest.mark.parametrize("order", ["regular", "shuffle", "unplayed_first"])
def test_ordinary_create_admits_loved_protocol_and_playback_order(loved_boundary, order):
    body = {**create_body(refs=[ENTRY_A, ENTRY_B]), "source_protocol": PROTOCOL, "mix_playback_order": order}
    status, headers, result = loved_boundary.request("POST", "/playlists", payload=body)
    assert status == 200 and headers["cache-control"] == "private, no-store"
    _, _, command, constraints = loved_boundary.owner.calls[0]
    assert command.data["source_protocol"] == PROTOCOL
    assert command.data["mix_playback_order"] == order
    assert command.data["entry_refs"] == [ENTRY_A, ENTRY_B]
    assert constraints is loved_boundary.constraints


@pytest.mark.parametrize("code,status", [("source_unavailable", 404), ("source_changed", 409),
    ("source_expired", 410), ("artist_loved_unavailable", 503), ("artist_loved_too_large", 422)])
def test_service_failures_are_private_classified_and_not_retried(loved_boundary, code, status):
    loved_boundary.owner.error = commands.PlaylistError(code, status)
    assert_error(loved_boundary.request("POST", BASE, payload=descriptor()), code, status)
    assert len(loved_boundary.owner.calls) == 1


def unsigned_transport(app, method, path, *, headers, body, query=None):
    """Dispatch supplied bytes only; do not sign using deliberately broken keys.

This is the existing Harness ASGI receive/send contract, without its automatic
CSRF/context generation. Production middleware, router and policy stay mounted.
"""
    async def run():
        messages, sent = [], False
        complete = asyncio.Event()
        async def receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            await complete.wait()
            return {"type": "http.disconnect"}
        async def send(message):
            messages.append(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                complete.set()
        await app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": method, "scheme": "https", "path": path, "raw_path": path.encode("ascii"),
            "query_string": urlencode(query or {}).encode("ascii"),
            "headers": [(key.encode("ascii"), value.encode("ascii")) for key, value in headers.items()],
            "client": ("192.0.2.10", 50000), "server": ("music.test", 443)}, receive, send)
        start = next(message for message in messages if message["type"] == "http.response.start")
        raw = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
        return start["status"], {key.decode().lower(): value.decode() for key, value in start["headers"]}, json.loads(raw)
    return asyncio.run(run())


def valid_transport_headers(h, body):
    csrf = issue_session_csrf(SESSION_TOKEN, h.app.state.auth_policy_config)
    return {"host": "music.test", "origin": "https://music.test", "content-type": "application/json",
        "content-length": str(len(body)), "x-albumhaven-context": h.context_ref(),
        "cookie": f"__Host-album_haven_session={SESSION_TOKEN}; __Host-album_haven_csrf={csrf}",
        "x-album-haven-csrf": csrf}


@pytest.mark.parametrize("method,path", [("POST", BASE), ("GET", BASE), ("POST", QUEUE)])
@pytest.mark.parametrize("failure", ["invalid_origin_key", "throwing_policy_resolver"])
def test_early_boundary_failure_is_private_unavailable_without_service_dispatch(loved_boundary, method, path, failure):
    h = loved_boundary
    raw = json.dumps(queue_body() if path == QUEUE else descriptor()).encode()
    headers = valid_transport_headers(h, raw)
    if failure == "invalid_origin_key":
        h.app.state.auth_policy_config = {"hmac": {"secret": "short", "key_version": 1}}
    else:
        def fail(_context): raise RuntimeError("synthetic policy resolver failure")
        h.app.state.policy_constraint_resolver = fail
    result = unsigned_transport(h.app, method, path, headers=headers, body=raw,
        query={"source_ref": SOURCE, "source_revision": SOURCE_REVISION} if method == "GET" else None)
    assert_error(result, "artist_loved_unavailable", 503)
    assert "context_ref" not in result[2] and h.owner.calls == []
    assert h.resolver.calls == [SESSION_TOKEN]


@pytest.mark.parametrize("method,path", [("PUT", BASE), ("GET", QUEUE),
    ("GET", "/playlists/creation-source/library-mix"), ("GET", "/playlists/creation-source/artist-popular")])
def test_loved_early_error_closure_does_not_cover_other_method_or_legacy_route(loved_boundary, method, path):
    h = loved_boundary
    raw = b"{}"
    headers = valid_transport_headers(h, raw)
    h.app.state.auth_policy_config = {"hmac": {"secret": "short", "key_version": 1}}
    # Invalid origin configuration raises before app.access evaluation. There
    # is no global grant or policy bypass to make unsupported methods run.
    with pytest.raises(RuntimeError, match="Policy request-origin key configuration is invalid"):
        unsigned_transport(h.app, method, path, headers=headers, body=raw)
    assert h.owner.calls == []


@pytest.mark.parametrize("path,function,code", [(BASE, REAL_CAPTURE, "invalid_artist_loved_descriptor"),
                                               (QUEUE, REAL_QUEUE, "invalid_command")])
@pytest.mark.parametrize("raw,length", [(b"{", None), (b"[]", None), (b"null", None), (b"1", None),
    (b"\xff", None), (b"{}", "wrong"), (b"{}", "-1"), (b"{}", "3")])
def test_invalid_json_and_lengths_do_not_open_transaction(loved_boundary, monkeypatch, path, function, code, raw, length):
    monkeypatch.setattr(loved, "capture" if path == BASE else "native_queue", function)
    assert_error(loved_boundary.request("POST", path, raw=raw,
        headers={"content-length": length} if length is not None else {}), code, 422)
    assert loved_boundary.owner.calls == []


@pytest.mark.parametrize("outcome", ["created", "existing"])
def test_ordinary_create_preserves_explicit_loved_receipt_outcome(loved_boundary, monkeypatch, outcome):
    h = loved_boundary
    original = h.owner.execute
    def execute(context, command, *, constraints=None):
        result = original(context, command, constraints=constraints)
        return {**result, "creation_outcome": outcome, "changed": outcome == "created",
                "added_count": 2 if outcome == "created" else 0}
    monkeypatch.setattr(h.owner, "execute", execute)
    status, _headers, result = h.request("POST", "/playlists", payload={
        **create_body(refs=[ENTRY_A, ENTRY_B]), "source_protocol": PROTOCOL})
    assert status == 200 and result["data"]["creation_outcome"] == outcome
    assert result["data"]["changed"] is (outcome == "created")
    assert result["data"]["added_count"] == (2 if outcome == "created" else 0)
