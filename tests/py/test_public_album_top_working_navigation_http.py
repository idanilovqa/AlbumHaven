"""Additive real-router/private-boundary contracts, without claiming SQL or browser proof."""
import asyncio
from dataclasses import replace
from html.parser import HTMLParser
import json
from urllib.parse import parse_qs, quote, urlsplit

import pytest
from starlette.requests import Request

from music_app.routes import owned_album_tops_asgi as routes
from music_app.services.current_actor import ActorState, CurrentActor
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import (
    _is_public, _is_public_share_request, album_top_working_link_path,
    album_top_working_request_path, csrf_mode_for_route, private_action_for_route,
    public_share_request_origin,
)
from tests.py.test_owned_album_top_route_boundary import actor
from tests.py.test_public_album_top_http import (
    ORIGIN, PATH as PUBLIC_PATH, SHARE, Service as GuestService,
    app_for as public_app_for, exchange,
)

TOP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
PATH = "/album-tops/public-link/" + SHARE
TEMPLATE = "/album-tops/public-link/{share_ref}"
TARGET = "/?surface=album_tops&top_ref=" + TOP
BROWSE = "library.browse.read"
DOCUMENT = {"sec-fetch-dest": "document", "accept": "text/html"}
SENTINEL = "private-storage-and-credential-sentinel"


class WorkingService:
    """Transport double only: real SQL authority is exercised in separate tests."""
    def __init__(self):
        self.calls = []
        self.error = None
        self.after = None
        self.value = TOP

    def resolve_public_link(self, context, *, share_ref, constraints=None):
        self.calls.append((context, share_ref, constraints))
        if self.after is not None:
            self.after()
        if self.error is not None:
            raise self.error
        return self.value

    def read_published(self, *args, **kwargs):
        raise AssertionError("The resolver must not authorize through publication-only reads")

    def read(self, *args, **kwargs):
        raise AssertionError("The transport must call the working public-link resolver")


class Links(HTMLParser):
    def __init__(self, body):
        super().__init__()
        self.anchors = []
        self.feed(body.decode("utf-8"))

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.anchors.append(dict(attrs))


def app_for(service=None, *, current=None):
    app = public_app_for(GuestService(), actor() if current is None else current)
    app.state.auth_policy_config["public_base_url"] = ORIGIN
    app.state.owned_album_tops_service = service if service is not None else WorkingService()
    app.include_router(routes.router)
    return app


def request(app=None, **changes):
    app = app_for() if app is None else app
    scope = {
        "type": "http", "method": "GET", "path": PATH, "raw_path": PATH.encode("ascii"),
        "scheme": "https", "server": ("public.example.test", 443),
        "client": ("192.0.2.10", 3000), "headers": [(b"host", b"public.example.test")],
        "query_string": b"", "state": {"current_actor": actor()}, "app": app,
    }
    scope.update(changes)
    return Request(scope)


def response(app, method="GET", path=PATH, **options):
    return asyncio.run(exchange(app, method, path, **options))


def private_headers(headers):
    assert headers[b"cache-control"] == b"private, no-store"
    assert headers[b"referrer-policy"] == b"no-referrer"
    assert headers[b"x-content-type-options"] == b"nosniff"
    assert "sec-fetch-dest" in {
        field.strip().lower() for field in headers.get(b"vary", b"").decode().split(",")
    }


def no_services(app):
    assert app.state.owned_album_tops_service.calls == []
    assert app.state.public_album_tops_service.calls == []


def test_resolver_is_explicit_private_browse_get_head_and_precedes_generic_top_routes():
    indexed = list(enumerate(routes.router.routes))
    matches = [(index, route) for index, route in indexed if route.path == TEMPLATE]
    assert len(matches) == 1
    index, route = matches[0]
    assert route.methods == {"GET", "HEAD"}
    assert index < min(i for i, item in indexed if item.path == "/album-tops/{top_ref}")
    for method in ("GET", "HEAD"):
        assert private_action_for_route(method, TEMPLATE) == BROWSE
        assert csrf_mode_for_route(method, TEMPLATE) == "none"
        req = request(method=method)
        assert not _is_public(method, PATH)
        assert not _is_public_share_request(req)
        assert public_share_request_origin(req) is None


@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_exact_working_path_gate_and_guest_link_gate_agree(method):
    req = request(method=method)
    assert album_top_working_request_path(req) == PATH
    public = request(req.app, method=method, path=PUBLIC_PATH, raw_path=PUBLIC_PATH.encode())
    assert public_share_request_origin(public) == ORIGIN
    assert album_top_working_link_path(public, SHARE) == PATH


@pytest.mark.parametrize("value", [None, "", False, 443, [], {},
    "https://other.example.test", ORIGIN + "/", ORIGIN + "/mounted", ORIGIN + "//",
    ORIGIN + "?next=/", ORIGIN + "#fragment", "https://user@public.example.test",
    "https://public.example.test:443", "HTTPS://public.example.test",
    "https://PUBLIC.example.test", "http://public.example.test", "//public.example.test",
])
def test_authentication_base_must_be_present_canonical_and_the_exact_public_origin(value):
    app = app_for()
    app.state.auth_policy_config["public_base_url"] = value
    req = request(app)
    assert album_top_working_request_path(req) is None
    public = request(app, path=PUBLIC_PATH, raw_path=PUBLIC_PATH.encode())
    assert album_top_working_link_path(public, SHARE) is None
    status, body, headers = response(app)
    assert status == 404 and b"location" not in headers
    private_headers(headers)
    no_services(app)


@pytest.mark.parametrize("key,value", [
    ("ALBUM_HAVEN_PUBLIC_SHARING_ENABLED", False),
    ("ALBUM_HAVEN_PUBLIC_SHARING_ENABLED", "true"),
    ("ALBUM_HAVEN_PUBLIC_SHARING_ENABLED", 1),
    ("ALBUM_HAVEN_PUBLIC_SHARING_ENABLED", None),
    ("ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN", "https://other.example.test"),
    ("ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN", ORIGIN + "/"),
    ("ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN", None),
    ("ALBUM_HAVEN_PUBLIC_BASE_URL", "https://other.example.test"),
    ("ALBUM_HAVEN_PUBLIC_BASE_URL", ORIGIN + "/mounted"),
])
def test_current_public_deployment_admission_is_required_before_resolution(key, value):
    app = app_for()
    app.state.config[key] = value
    assert album_top_working_request_path(request(app)) is None
    status, body, headers = response(app)
    assert status == 404 and b"location" not in headers
    private_headers(headers)
    no_services(app)


def test_trusted_origins_and_raw_app_base_cannot_substitute_for_authentication_base():
    app = app_for()
    app.state.auth_policy_config.pop("public_base_url")
    app.state.auth_policy_config["trusted_origins"] = [ORIGIN]
    assert app.state.config["ALBUM_HAVEN_PUBLIC_BASE_URL"] == ORIGIN
    assert album_top_working_request_path(request(app)) is None
    status, _, headers = response(app)
    assert status == 404 and b"location" not in headers
    no_services(app)


@pytest.mark.parametrize("options", [
    {"host": "other.example.test"}, {"scheme": "http"},
    {"host": "public.example.test:444"},
    {"host": "other.example.test", "headers": {
        "origin": ORIGIN, "referer": ORIGIN + PUBLIC_PATH,
        "x-forwarded-host": "public.example.test", "x-forwarded-proto": "https",
        "forwarded": "host=public.example.test;proto=https",
    }},
])
def test_request_authority_cannot_be_replaced_by_forwarded_origin_or_referer(options):
    app = app_for()
    status, body, headers = response(app, **options)
    assert status == 404 and b"location" not in headers
    private_headers(headers)
    no_services(app)


@pytest.mark.parametrize("query", [
    b"return_to=https%3A%2F%2Fattacker.example", b"top_ref=" + TOP.encode(),
    b"account_id=99", b"library_id=99", b"limit=1", b"cursor=x",
    b"x=1&x=2", b"return_to=%2F&return_to=%2Faccount", b"x", b"=", b"&", b"&&",
])
@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_every_nonempty_query_is_rejected_before_service(query, method):
    app = app_for()
    assert album_top_working_request_path(request(app, query_string=query)) is None
    status, body, headers = response(app, method, query=query)
    assert status == 400 and b"location" not in headers
    private_headers(headers)
    if method == "HEAD":
        assert body == b""
    else:
        assert json.loads(body) == {"ok": False, "error": "invalid_query"}
    no_services(app)


@pytest.mark.parametrize("raw_path", [
    PATH.replace("a", "%61", 1).encode(), PATH.encode() + b"/", PATH.upper().encode(),
    b"/album-tops/public-link%2F" + SHARE.encode(),
    b"/album-tops/public-link/" + SHARE.encode() + b"%00",
])
@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_decoded_route_match_does_not_admit_a_noncanonical_raw_path(raw_path, method):
    app = app_for()
    assert album_top_working_request_path(request(app, method=method, raw_path=raw_path)) is None
    status, body, headers = response(app, method, raw_path=raw_path)
    assert status == 404 and b"location" not in headers
    private_headers(headers)
    if method == "HEAD":
        assert body == b""
    else:
        assert json.loads(body) == {"ok": False, "error": "unavailable"}
    no_services(app)


@pytest.mark.parametrize("raw_path", [None, "not-bytes", b""])
def test_new_private_path_requires_exact_raw_path_evidence(raw_path):
    app = app_for()
    req = request(app, raw_path=raw_path)
    assert album_top_working_request_path(req) is None
    if raw_path is None:
        del req.scope["raw_path"]
        assert album_top_working_request_path(req) is None
    no_services(app)


@pytest.mark.parametrize("share_ref", [SHARE.upper(), SHARE.replace("-", ""), "not-a-uuid", ""])
def test_noncanonical_share_never_becomes_a_working_navigation_target(share_ref):
    app = app_for()
    path = "/album-tops/public-link/" + share_ref
    req = request(app, path=path, raw_path=path.encode())
    assert album_top_working_request_path(req) is None
    public = request(app, path=PUBLIC_PATH, raw_path=PUBLIC_PATH.encode())
    assert album_top_working_link_path(public, share_ref) is None
    no_services(app)


@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_success_is_fixed_native_303_from_authorized_top_and_established_private_context(method):
    service = WorkingService()
    app = app_for(service)
    resolver = lambda context: PolicyEvaluationConstraints()
    app.state.policy_constraint_resolver = resolver
    status, body, headers = response(app, method)
    assert status == 303 and body == b"" and headers[b"location"] == TARGET.encode()
    private_headers(headers)
    assert len(service.calls) == 1
    context, share_ref, constraints = service.calls[0]
    assert share_ref == SHARE and constraints is resolver
    assert context.actor.account_id == 41 and context.actor.session_id == 8
    assert context.library_id == 73 and context.action == BROWSE
    assert context.client_surface_class == "private_web"
    assert app.state.current_actor_resolver.tokens == [None]
    assert app.state.public_album_tops_service.calls == []
    assert urlsplit(headers[b"location"].decode()).netloc == ""
    assert parse_qs(urlsplit(headers[b"location"].decode()).query) == {
        "surface": ["album_tops"], "top_ref": [TOP],
    }


def test_head_and_get_reauthorize_independently_and_share_redirect_headers():
    app = app_for()
    first = response(app)
    second = response(app, "HEAD")
    assert first[0] == second[0] == 303 and first[1] == second[1] == b""
    assert len(app.state.owned_album_tops_service.calls) == 2
    for key in (b"location", b"content-length", b"cache-control", b"referrer-policy",
                b"x-content-type-options", b"vary"):
        assert first[2][key] == second[2][key]


@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_conditional_headers_cannot_reuse_a_previous_authorized_redirect(method):
    service = WorkingService()
    app = app_for(service)
    assert response(app, method)[0] == 303
    service.error = AlbumTopError("forbidden", 403)
    status, body, headers = response(app, method, headers={
        "if-none-match": '"previous-result"', "if-modified-since": "Wed, 21 Oct 2015 07:28:00 GMT",
    })
    assert status == 403 and b"location" not in headers
    private_headers(headers)
    assert len(service.calls) == 2
    if method == "HEAD":
        assert body == b""
    else:
        assert json.loads(body) == {"ok": False, "error": "forbidden"}


@pytest.mark.parametrize("denial", ["anonymous", "expired", "inactive"])
def test_only_exact_document_401_returns_to_same_private_resolver_after_login(denial):
    current = replace(actor(), state=ActorState.INACTIVE) if denial == "inactive" else CurrentActor.anonymous()
    app = app_for(current=current)
    headers = dict(DOCUMENT)
    if denial == "expired":
        headers["cookie"] = "__Host-album_haven_session=" + "s" * 43
    status, body, result = response(app, headers=headers)
    assert status == 303 and body == b""
    assert result[b"location"] == ("/login?return_to=" + quote(PATH, safe="")).encode()
    assert parse_qs(urlsplit(result[b"location"].decode()).query) == {"return_to": [PATH]}
    private_headers(result)
    assert app.state.current_actor_resolver.tokens == ["s" * 43 if denial == "expired" else None]
    no_services(app)


@pytest.mark.parametrize("headers", [
    {}, {"accept": "text/html"}, {"sec-fetch-dest": "empty"},
    {"sec-fetch-dest": "iframe", "accept": "text/html"},
    {"sec-fetch-dest": "Document", "accept": "text/html"},
    {"sec-fetch-dest": "document,empty"},
])
def test_anonymous_api_or_non_document_request_keeps_normal_401(headers):
    app = app_for(current=CurrentActor.anonymous())
    status, body, result = response(app, headers=headers)
    assert status == 401 and json.loads(body) == {"detail": "Authentication required."}
    assert b"location" not in result
    private_headers(result)
    no_services(app)


def test_anonymous_head_document_keeps_401_and_never_attempts_login_or_service():
    app = app_for(current=CurrentActor.anonymous())
    status, body, headers = response(app, "HEAD", headers=DOCUMENT)
    assert status == 401 and body == b"" and b"location" not in headers
    assert int(headers[b"content-length"]) == len(b'{"detail":"Authentication required."}')
    private_headers(headers)
    no_services(app)


@pytest.mark.parametrize("method", ["GET", "HEAD"])
@pytest.mark.parametrize("headers", [{}, DOCUMENT])
def test_boundary_policy_403_remains_denied_without_login_or_a_second_authority_attempt(method, headers):
    app = app_for(current=replace(actor(), capability_grants=()))
    status, body, result = response(app, method, headers=headers)
    assert status == 403 and b"location" not in result
    if method == "GET":
        assert json.loads(body) == {"detail": "Action not permitted."}
    else:
        assert body == b""
        assert int(result[b"content-length"]) == len(b'{"detail":"Action not permitted."}')
    private_headers(result)
    assert app.state.current_actor_resolver.tokens == [None]
    no_services(app)


@pytest.mark.parametrize("path,query,raw_path", [
    ("/album-tops", b"", None), ("/album-tops/" + TOP, b"", None),
    (PATH + "/", b"", None), (PATH.upper(), b"", None),
    (PATH, b"return_to=%2F%2Fattacker.example", None), (PATH, b"&", None),
    (PATH, b"", PATH.replace("a", "%61", 1).encode()),
])
def test_login_exception_never_expands_to_other_routes_queries_or_raw_aliases(path, query, raw_path):
    app = app_for(current=CurrentActor.anonymous())
    options = {"query": query, "headers": DOCUMENT}
    if raw_path is not None:
        options["raw_path"] = raw_path
    status, body, headers = response(app, path=path, **options)
    assert status == 401 and b"location" not in headers
    assert json.loads(body) == {"detail": "Authentication required."}
    no_services(app)


@pytest.mark.parametrize("failure", ["disabled", "different_auth_base", "missing_auth_base", "different_public_origin"])
def test_document_login_exception_also_requires_current_same_origin_deployment_gate(failure):
    app = app_for(current=CurrentActor.anonymous())
    if failure == "disabled":
        app.state.config["ALBUM_HAVEN_PUBLIC_SHARING_ENABLED"] = False
    elif failure == "different_public_origin":
        app.state.config["ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN"] = "https://other.example.test"
    elif failure == "missing_auth_base":
        app.state.auth_policy_config.pop("public_base_url")
    else:
        app.state.auth_policy_config["public_base_url"] = "https://private.example.test"
    status, body, headers = response(app, headers=DOCUMENT)
    assert status == 401 and json.loads(body) == {"detail": "Authentication required."}
    assert b"location" not in headers
    private_headers(headers)
    no_services(app)


@pytest.mark.parametrize("method", ["GET", "HEAD"])
@pytest.mark.parametrize("code,status", [("forbidden", 403), ("top_unavailable", 404), ("forbidden", 401)])
def test_service_denial_preserves_status_and_api_shape_without_login_retry(code, status, method):
    service = WorkingService()
    service.error = AlbumTopError(code, status)
    app = app_for(service)
    actual, body, headers = response(app, method)
    assert actual == status and b"location" not in headers
    private_headers(headers)
    if method == "HEAD":
        assert body == b""
    else:
        assert json.loads(body) == {"ok": False, "error": code}
    assert len(service.calls) == 1 and app.state.public_album_tops_service.calls == []


@pytest.mark.parametrize("status", [401, 403, 404])
def test_authenticated_document_domain_denial_is_generic_and_has_only_safe_public_return(status):
    service = WorkingService()
    service.error = AlbumTopError("forbidden" if status in {401, 403} else "top_unavailable", status)
    app = app_for(service)
    actual, body, headers = response(app, headers=DOCUMENT)
    assert actual == status and b"location" not in headers
    private_headers(headers)
    assert headers[b"content-type"].startswith(b"text/html")
    links = Links(body).anchors
    assert any(link.get("href") == PUBLIC_PATH for link in links)
    assert all(link.get("href") == PUBLIC_PATH for link in links)
    assert TOP.encode() not in body and b"account_id" not in body and b"context_ref" not in body
    assert len(service.calls) == 1 and app.state.public_album_tops_service.calls == []


@pytest.mark.parametrize("method", ["GET", "HEAD"])
@pytest.mark.parametrize("headers", [{}, DOCUMENT])
def test_unexpected_service_failure_stays_sanitized_503(method, headers):
    service = WorkingService()
    service.error = RuntimeError(SENTINEL)
    app = app_for(service)
    status, body, result = response(app, method, headers=headers)
    assert status == 503 and b"location" not in result and SENTINEL.encode() not in body
    private_headers(result)
    if method == "HEAD":
        assert body == b""
    elif not headers:
        assert json.loads(body) == {"ok": False, "error": "unavailable"}
    assert len(service.calls) == 1 and app.state.public_album_tops_service.calls == []


@pytest.mark.parametrize("failure", ["disabled", "public_origin", "deployment_base", "deployment_mount",
    "auth_base", "missing_auth_base", "auth_mount"])
@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_current_gate_is_rechecked_after_await_and_stale_success_is_discarded(failure, method):
    service = WorkingService()
    app = app_for(service)
    def change_after_resolution():
        if failure == "disabled":
            app.state.config["ALBUM_HAVEN_PUBLIC_SHARING_ENABLED"] = False
        elif failure == "public_origin":
            app.state.config["ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN"] = "https://other.example.test"
        elif failure in {"deployment_base", "deployment_mount"}:
            app.state.config["ALBUM_HAVEN_PUBLIC_BASE_URL"] = (
                ORIGIN + "/mounted" if failure == "deployment_mount" else "https://other.example.test"
            )
        elif failure == "missing_auth_base":
            app.state.auth_policy_config.pop("public_base_url")
        else:
            app.state.auth_policy_config["public_base_url"] = (
                ORIGIN + "/mounted" if failure == "auth_mount" else "https://private.example.test"
            )
    service.after = change_after_resolution
    status, body, headers = response(app, method)
    assert status == 404 and b"location" not in headers and TOP.encode() not in body
    private_headers(headers)
    if method == "HEAD":
        assert body == b""
    else:
        assert json.loads(body) == {"ok": False, "error": "unavailable"}
    assert len(service.calls) == 1 and app.state.public_album_tops_service.calls == []


def test_invalid_private_ui_identity_is_rejected_before_resolver_work():
    app = app_for()
    app.state.auth_policy_config["hmac"]["key_version"] = 0
    status, body, headers = response(app)
    assert status == 503 and json.loads(body) == {"ok": False, "error": "private_ui_context_unavailable"}
    assert b"location" not in headers
    private_headers(headers)
    no_services(app)


@pytest.mark.parametrize("state", [None, CurrentActor.anonymous(), replace(actor(), state=ActorState.INACTIVE)])
def test_route_does_not_trust_an_unestablished_private_actor_even_without_middleware(state):
    app = app_for()
    req = request(app, state={} if state is None else {"current_actor": state})
    result = asyncio.run(routes.open_public_album_top_working(req, SHARE))
    assert result.status_code == 403 and json.loads(result.body) == {"ok": False, "error": "forbidden"}
    assert "location" not in result.headers
    no_services(app)


@pytest.mark.parametrize("share_ref", [SHARE.upper(), SHARE.replace("-", ""), "not-a-uuid"])
def test_noncanonical_share_is_rejected_by_actual_private_router(share_ref):
    app = app_for()
    status, body, headers = response(app, path="/album-tops/public-link/" + share_ref)
    assert status == 404 and b"location" not in headers
    private_headers(headers)
    no_services(app)


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
def test_other_methods_never_get_the_document_login_exception(method):
    app = app_for(current=CurrentActor.anonymous())
    status, body, headers = response(app, method, headers=DOCUMENT)
    assert status == 401 and b"location" not in headers
    assert json.loads(body) == {"detail": "Authentication required."}
    no_services(app)


def test_existing_anonymous_root_login_redirect_is_unchanged():
    app = app_for(current=CurrentActor.anonymous())
    status, body, headers = response(app, path="/")
    assert status == 303 and headers[b"location"] == b"/login"
    no_services(app)


@pytest.mark.parametrize("value", [None, [], {}, {"public_base_url": ORIGIN + "/mounted"}])
def test_missing_or_malformed_authentication_configuration_fails_closed_in_pure_gate(value):
    app = app_for()
    app.state.auth_policy_config = value
    assert album_top_working_request_path(request(app)) is None
    public = request(app, path=PUBLIC_PATH, raw_path=PUBLIC_PATH.encode())
    assert album_top_working_link_path(public, SHARE) is None
    no_services(app)


@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_unexpected_private_boundary_error_is_sanitized_before_service(method):
    app = app_for()
    def failing_constraints(context):
        raise RuntimeError(SENTINEL)
    app.state.policy_constraint_resolver = failing_constraints
    status, body, headers = response(app, method)
    assert status == 503 and b"location" not in headers and SENTINEL.encode() not in body
    private_headers(headers)
    if method == "HEAD":
        assert body == b""
    else:
        assert json.loads(body) == {"ok": False, "error": "unavailable"}
    no_services(app)


@pytest.mark.parametrize("value", [None, TOP.upper(), "//attacker.example/", TOP + "&return_to=/account", {"top_ref": TOP}])
def test_invalid_resolver_result_cannot_become_a_redirect(value):
    service = WorkingService()
    service.value = value
    app = app_for(service)
    status, body, headers = response(app)
    assert status == 404 and json.loads(body) == {"ok": False, "error": "unavailable"}
    assert b"location" not in headers
    private_headers(headers)
    assert b"attacker.example" not in body and b"return_to=" not in body
    assert len(service.calls) == 1 and app.state.public_album_tops_service.calls == []
