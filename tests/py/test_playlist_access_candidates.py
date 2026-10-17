"""Directory contracts at the policy, pagination and transport seams."""
from contextlib import contextmanager
from dataclasses import replace
import json
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from starlette.requests import Request

from music_app.routes import owned_playlists_asgi as routes
from music_app.services import owned_playlists_postgres as repository
from music_app.services.owned_playlists import ACCESS, BROWSE, PlaylistError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import _PRIVATE_ROUTE_ACTIONS
from music_app.services.social_cursors import decode_social_cursor
from tests.py.test_playlist_collaboration import P, G, context

SECRET = "synthetic-playlist-cursor-secret-32-characters"


def directory(monkeypatch, rows=(), *, live=None, owner=11):
    live = live or context()
    calls = []
    class Connection:
        def execute(self, sql, params):
            calls.append((sql, params))
            return SimpleNamespace(fetchall=lambda: list(rows))
    service = repository.PostgresOwnedPlaylistsService({"ALBUM_HAVEN_APP_DATABASE_URL":"synthetic"})
    @contextmanager
    def authorized(ctx, constraints):
        yield Connection(), live, None
    monkeypatch.setattr(service, "_authorized", authorized)
    monkeypatch.setattr(service, "_playlist", lambda *args: {
        "ref":P, "owner_account_id":owner, "visibility":"server_shared", "revision":4})
    monkeypatch.setattr(repository, "lock_current_actor_session", lambda *args, **kwargs: calls.append("session"))
    return service, calls


def row(account, *, granted=False):
    return {"account_id":account, "account_ref":f"40000000-0000-4000-8000-{account:012x}", "display_name":"Reader",
            "username_display":"reader", "grant_ref":G if granted else None,
            "role":"editor" if granted else None}


def test_directory_returns_bounded_minimal_rows_and_encrypted_continuation(monkeypatch):
    service, calls = directory(monkeypatch, [row(44), row(45, granted=True), row(46)])
    result = service.read_access_candidates(context(), P, query="a%_\\", limit=2, cursor_secret=SECRET)
    assert result["playlist_id"] == P and result["revision"] == "4"
    assert result["actor_scope"] == {"account_id":11, "library_id":33}
    assert result["candidates"] == [
        {**row(44), "allowed_actions":{"can_grant_editor":True}},
        {**row(45, granted=True), "allowed_actions":{"can_grant_editor":False}},
    ]
    assert decode_social_cursor(result["next_cursor"], secret=SECRET,
        scope=["playlist-access-candidates-v1",11,22,33,P,"a%_\\"]) == 45
    assert calls[0][1]["query"] == "%a\\%\\_\\\\%"
    assert calls[0][1]["limit"] == 3 and calls[-1] == "session"
    assert "capability.social" not in calls[0][0]
    assert "contact_email" not in calls[0][0]


@pytest.mark.parametrize("kwargs", [
    {"limit":0}, {"limit":101}, {"limit":True}, {"limit":"5"},
    {"query":None}, {"query":"x"*101}, {"query":"bad\0query"}, {"query":"\ud800"},
])
def test_directory_rejects_invalid_queries_before_reading(monkeypatch, kwargs):
    service, calls = directory(monkeypatch)
    with pytest.raises(PlaylistError, match="invalid_access_query"):
        service.read_access_candidates(context(), P, cursor_secret=SECRET, **kwargs)
    assert calls == []


@pytest.mark.parametrize("change", ["query", "playlist", "actor", "session", "library", "tampered", "numeric"])
def test_continuation_rejects_cross_scope_and_forged_tokens(monkeypatch, change):
    service, _ = directory(monkeypatch, [row(44), row(45)])
    token = service.read_access_candidates(context(), P, cursor_secret=SECRET, limit=1)["next_cursor"]
    ctx, ref, query = context(), P, ""
    if change == "query": query = "different"
    if change == "playlist": ref = G
    if change == "actor": ctx = replace(ctx, actor=replace(ctx.actor, account_id=12))
    if change == "session": ctx = replace(ctx, actor=replace(ctx.actor, session_id=23))
    if change == "library": ctx = replace(ctx, library_id=34)
    if change == "tampered": token = token[:-2]+"ab"
    if change == "numeric": token = "44"
    service, calls = directory(monkeypatch, live=ctx, owner=ctx.actor.account_id)
    # Authority has separate tests; this isolates every required cursor binding.
    monkeypatch.setattr(service, "_require", lambda *args, **kwargs: None)
    with pytest.raises(PlaylistError, match="invalid_cursor"):
        service.read_access_candidates(ctx, ref, cursor_secret=SECRET, query=query, cursor=token)
    assert calls == []


@pytest.mark.parametrize("live,owner,constraints", [
    (context(grants=(BROWSE,)), 11, None),
    (context(), 55, None),
    (context(bootstrap=True), 55, None),
    (context(), 11, lambda ctx: PolicyEvaluationConstraints(request_origin_allowed=ctx.action != ACCESS)),
    (context(), 11, lambda ctx: PolicyEvaluationConstraints(deployment_allowed=ctx.resource is None)),
])
def test_live_owner_access_and_resource_constraints_precede_directory(monkeypatch, live, owner, constraints):
    service, calls = directory(monkeypatch, live=live, owner=owner)
    with pytest.raises(PlaylistError, match="forbidden"):
        service.read_access_candidates(context(), P, cursor_secret=SECRET, constraints=constraints)
    assert calls == []


def test_empty_and_last_page_have_no_cursor(monkeypatch):
    for rows in ([], [row(44)]):
        service, _ = directory(monkeypatch, rows)
        assert service.read_access_candidates(context(), P, cursor_secret=SECRET)["next_cursor"] is None


def request(query):
    return Request({"type":"http", "method":"GET", "path":f"/playlists/{P}/access-candidates",
        "query_string":urlencode(query).encode(), "headers":[],
        "app":SimpleNamespace(state=SimpleNamespace(auth_policy_config={"hmac":{"secret":SECRET}}))})


def test_route_direct_envelope_exact_policy_and_private_context(monkeypatch):
    seen = []
    service = SimpleNamespace(read_access_candidates=lambda *args, **kwargs: (
        seen.append((args, kwargs)) or {"playlist_id":P,"revision":"4","candidates":[],"next_cursor":None,
                                     "actor_scope":{"account_id":11,"library_id":33}}))
    monkeypatch.setattr(routes, "_service", lambda req: service)
    monkeypatch.setattr(routes, "_context", lambda req, action: (seen.append(action) or (context(), None)))
    monkeypatch.setattr(routes, "_context_ref", lambda req: "a"*64)
    response = routes.playlist_access_candidates(request({"q":"Reader","limit":"50"}), P)
    assert response.status_code == 200 and response.headers["cache-control"] == "private, no-store"
    payload = json.loads(response.body)
    assert payload["context_ref"] == "a"*64 and "data" not in payload
    assert seen[0] == ACCESS and seen[1][1]["query"] == "Reader"
    assert _PRIVATE_ROUTE_ACTIONS[("GET", "/playlists/{playlist_ref}/access-candidates")] == ACCESS
    matches = [route for route in routes.router.routes if route.path == "/playlists/{playlist_ref}/access-candidates"]
    assert len(matches) == 1 and matches[0].methods == {"GET"}


@pytest.mark.parametrize("query", [
    {"account_id":"12"}, {"library_id":"34"}, {"after":"10"}, {"limit":"-1"},
    {"limit":"1000"}, {"limit":"１"}, [("q","one"),("q","two")],
])
def test_route_rejects_spoofed_or_ambiguous_queries(monkeypatch, query):
    monkeypatch.setattr(routes, "_service", lambda req: pytest.fail("Invalid input reached service"))
    response = routes.playlist_access_candidates(request(query), P)
    assert response.status_code == 422 and json.loads(response.body)["error"] == "invalid_access_query"
