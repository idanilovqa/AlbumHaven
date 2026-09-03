"""Self-service appearance contracts through the production auth perimeter."""

import asyncio
import json
import re
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from starlette.requests import Request

from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.current_actor import ActorState, CurrentActor
from music_app.services.private_route_boundary import install_private_route_boundary
from tests.py.asgi_testing import decode_json, run_asgi_request


DEFAULTS = {"main_surface_color": None, "panel_background_color": None}
EXTENDED_DEFAULTS = {"palette_id": None, "panel_index": 0, "player_override": None}
CUSTOM = {"main_surface_color": "#12ABCD", "panel_background_color": "#FE019A"}
SESSION = "s" * 43


class Repository:
    def __init__(self):
        self.rows = {}
        self.reads = []
        self.writes = []
        self.fail = False

    def load_preferences(self, *, account_id):
        self.reads.append(account_id)
        if self.fail:
            raise RuntimeError("private database connection details")
        return dict(self.rows.get(account_id, DEFAULTS))

    def save_preferences(self, *, account_id, preferences):
        self.writes.append(account_id)
        if self.fail:
            raise RuntimeError("private database connection details")
        self.rows[account_id] = dict(preferences)
        return dict(preferences)


def _actor(account_id=41, *, state=ActorState.ACTIVE):
    return CurrentActor(state=state, account_id=account_id, session_id=11)


def _app(*, actor=None, deployment="self_hosted"):
    from music_app.routes.appearance_asgi import router

    app = FastAPI()
    repository = Repository()
    resolver = SimpleNamespace(actor=actor or _actor())
    resolver.resolve = lambda _token: resolver.actor
    app.state.current_actor_resolver = resolver
    app.state.appearance_preferences_repository = repository
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": deployment}
    app.state.auth_policy_config = {
        "hmac": {"secret": "test-appearance-policy-key-32-bytes-minimum", "key_version": 1},
        "trusted_origins": ["http://testserver"],
    }
    app.include_router(router)
    install_private_route_boundary(app)
    return app, repository, resolver


def _request(app, method="GET", payload=None, *, csrf=True, origin="http://testserver", query=None):
    token = issue_session_csrf(SESSION, app.state.auth_policy_config)
    headers = {"cookie": f"__Host-album_haven_session={SESSION}; __Host-album_haven_csrf={token}"}
    if method == "PUT":
        headers["origin"] = origin
        if csrf:
            headers["x-album-haven-csrf"] = token
    return run_asgi_request(app, method, "/account/appearance", headers=headers, json_body=payload, query=query)


@pytest.mark.parametrize("deployment", ["hosted", "self_hosted"])
def test_ordinary_active_member_can_read_defaults_without_library_grants(deployment):
    app, repository, _resolver = _app(deployment=deployment)

    status, headers, body = _request(app)

    assert status == 200
    assert decode_json(body) == {
        **DEFAULTS, **EXTENDED_DEFAULTS, "csrf_token": issue_session_csrf(SESSION, app.state.auth_policy_config),
    }
    assert "no-store" in headers["cache-control"]
    assert repository.reads == [41]


def test_save_normalizes_any_rgb_and_reset_is_scoped_to_the_authenticated_account():
    app, repository, resolver = _app()
    lower = {"main_surface_color": "#12abcd", "panel_background_color": "#fe019a"}

    status, headers, body = _request(app, "PUT", lower)

    assert status == 200
    assert decode_json(body) == {**CUSTOM, **EXTENDED_DEFAULTS}
    assert "no-store" in headers["cache-control"]
    assert repository.rows == {41: CUSTOM}
    resolver.actor = _actor(52)
    assert decode_json(_request(app)[2]) == {
        **DEFAULTS, **EXTENDED_DEFAULTS, "csrf_token": issue_session_csrf(SESSION, app.state.auth_policy_config),
    }
    black_white = {"main_surface_color": "#000000", "panel_background_color": "#FFFFFF"}
    assert _request(app, "PUT", black_white)[0] == 200
    resolver.actor = _actor(41)
    assert _request(app, "PUT", DEFAULTS)[0] == 200
    assert repository.rows == {41: DEFAULTS, 52: black_white}
    resolver.actor = _actor(52)
    saved = decode_json(_request(app)[2])
    assert {key: saved[key] for key in DEFAULTS} == black_white


def test_read_query_cannot_select_another_users_preferences():
    app, repository, _resolver = _app()
    repository.rows[52] = CUSTOM

    status, _headers, body = _request(app, query={"account_id": 52})

    assert status == 200
    assert decode_json(body)["main_surface_color"] is None
    assert repository.reads == [41]


@pytest.mark.parametrize("payload", [
    {}, {"main_surface_color": "#123456"},
    {**CUSTOM, "account_id": 52}, {**CUSTOM, "csrf_token": "caller-token"},
    {**CUSTOM, "panel_background_color": "#fff"},
    {**CUSTOM, "main_surface_color": "#12345678"},
    {**CUSTOM, "main_surface_color": "#123456\n"},
    {**CUSTOM, "main_surface_color": "red"},
    {**CUSTOM, "main_surface_color": 123456},
    {**CUSTOM, "main_surface_color": "#123456; color:red"}, [],
])
def test_invalid_or_overposting_save_is_rejected_before_either_color_changes(payload):
    app, repository, _resolver = _app()
    repository.rows[41] = CUSTOM

    status, _headers, body = _request(app, "PUT", payload)

    assert status == 400
    assert decode_json(body) == {"error": "invalid_appearance"}
    assert repository.writes == []
    assert repository.rows == {41: CUSTOM}


@pytest.mark.parametrize("actor", [CurrentActor.anonymous(), _actor(state=ActorState.INACTIVE)])
@pytest.mark.parametrize("method", ["GET", "PUT"])
def test_unauthenticated_or_inactive_user_cannot_read_or_write_preferences(actor, method):
    app, repository, _resolver = _app(actor=actor)

    status, _headers, _body = _request(app, method, CUSTOM if method == "PUT" else None)

    assert status == 401
    assert repository.reads == []
    assert repository.writes == []


@pytest.mark.parametrize("options", [{"csrf": False}, {"origin": "https://attacker.test"}])
def test_save_requires_session_csrf_and_same_origin(options):
    app, repository, _resolver = _app()

    status, _headers, _body = _request(app, "PUT", CUSTOM, **options)

    assert status == 403
    assert repository.writes == []


@pytest.mark.parametrize("method", ["GET", "PUT"])
def test_storage_failure_is_retryable_without_exposing_database_details_or_success(method):
    app, repository, _resolver = _app()
    repository.fail = True

    status, headers, body = _request(app, method, CUSTOM if method == "PUT" else None)

    assert status == 503
    assert decode_json(body) == {"error": "appearance_unavailable"}
    assert "no-store" in headers["cache-control"]
    assert repository.rows == {}


def _shell_request(app, actor):
    request = Request({"type": "http", "app": app, "headers": []})
    request.state.current_actor = actor
    return request


def test_shell_hydration_uses_each_requests_actor_and_does_not_reuse_another_theme():
    from music_app.routes.appearance_asgi import load_appearance_context

    app, repository, _resolver = _app()
    repository.rows[41] = CUSTOM

    first = asyncio.run(load_appearance_context(_shell_request(app, _actor(41))))
    second = asyncio.run(load_appearance_context(_shell_request(app, _actor(52))))

    assert first == {"appearance_preferences": {**CUSTOM, **EXTENDED_DEFAULTS}, "appearance_load_error": False}
    assert second == {"appearance_preferences": {**DEFAULTS, **EXTENDED_DEFAULTS}, "appearance_load_error": False}
    assert repository.reads == [41, 52]


@pytest.mark.parametrize("actor", [CurrentActor.anonymous(), _actor(state=ActorState.INACTIVE)])
def test_public_or_expired_session_hydration_returns_defaults_without_loading_account_data(actor):
    from music_app.routes.appearance_asgi import load_appearance_context

    app, repository, _resolver = _app()
    repository.rows[41] = CUSTOM

    context = asyncio.run(load_appearance_context(_shell_request(app, actor)))

    assert context == {"appearance_preferences": {**DEFAULTS, **EXTENDED_DEFAULTS}, "appearance_load_error": False}
    assert repository.reads == []


def test_shell_storage_failure_returns_explicit_retry_state_and_defaults():
    from music_app.routes.appearance_asgi import load_appearance_context

    app, repository, _resolver = _app()
    repository.fail = True

    context = asyncio.run(load_appearance_context(_shell_request(app, _actor())))

    assert context == {"appearance_preferences": {**DEFAULTS, **EXTENDED_DEFAULTS}, "appearance_load_error": True}


def test_direct_account_settings_embeds_its_authenticated_theme_before_body_rendering():
    from music_app.routes.account_asgi import router as account_router
    from music_app.services.auth_profile_password_postgres import ProfileAccountView

    app, repository, _resolver = _app()
    app.include_router(account_router)
    repository.rows[41] = CUSTOM
    app.state.profile_password_service = SimpleNamespace(load_profile=lambda **_kwargs: ProfileAccountView(
        username="appearance.member", administrator_set_suggestion=False, sessions=(),
    ))

    status, headers, body = run_asgi_request(
        app, "GET", "/account", headers={"cookie": f"__Host-album_haven_session={SESSION}"},
    )

    assert status == 200
    html = body.decode("utf-8")
    bootstrap = re.search(r'<script\b[^>]*\bid="appearance-bootstrap"[^>]*>(.*?)</script>', html, re.S)
    assert bootstrap is not None
    assert json.loads(bootstrap.group(1)) == {**CUSTOM, **EXTENDED_DEFAULTS, "load_error": False}
    assert bootstrap.end() < html.index("<body")
    assert "no-store" in headers["cache-control"]
    assert repository.reads == [41]
