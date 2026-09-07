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
EXTENDED_DEFAULTS = {
    "palette_id": None,
    "panel_index": 0,
    "player_override": None,
    "waveform_recent_colors": [],
    "compact_player_style": "docked",
    "album_details_layout": "classic_bar",
    "album_playing_row_animation": "enabled",
    "alert_family": "ember",
}
CUSTOM = {"main_surface_color": "#12ABCD", "panel_background_color": "#FE019A"}
SESSION = "s" * 43

CLASSIC_GREEN_PLAYER_STYLE = {
    "surface": {
        "mode": "layered_gradient",
        "angle": 135,
        "start": "#0A2F24",
        "end": "#0A1422",
    },
    "controls": {"fill": "#24B86B", "border": "#AFD8C2"},
    "waveform": {"fill": "#387F68", "edge": "#AFD8C2"},
    "handles": {"color": "#AFD8C2"},
}
ITEM_OUTLINE = {"source": "automatic", "color": None}
INTERACTION_OVERRIDES = {
    "item_hover": None,
    "item_selected": None,
    "button_hover_background": "#27384B",
    "button_pressed": None,
    "item_outline": ITEM_OUTLINE,
}
SELECTION_ACCENT = {"enabled": True, "color": "#6E9BD0"}
AGGREGATE_APPEARANCE = {
    **DEFAULTS,
    **EXTENDED_DEFAULTS,
    "revision": 7,
    "interaction_overrides": INTERACTION_OVERRIDES,
    "selection_accent": SELECTION_ACCENT,
    "player_style_override": CLASSIC_GREEN_PLAYER_STYLE,
    "player_recent_sets": [CLASSIC_GREEN_PLAYER_STYLE],
}


class Repository:
    def __init__(self):
        self.rows = {}
        self.reads = []
        self.writes = []
        self.profiles = []
        self.fail = False

    def load_preferences(self, *, account_id, client_profile="desktop"):
        self.reads.append(account_id)
        self.profiles.append(("read", client_profile))
        if self.fail:
            raise RuntimeError("private database connection details")
        return dict(self.rows.get(account_id, DEFAULTS))

    def save_preferences(self, *, account_id, preferences, client_profile="desktop"):
        self.writes.append(account_id)
        self.profiles.append(("write", client_profile))
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
    assert repository.profiles == [("read", "desktop")]


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


def test_save_rejects_an_oversized_declared_json_body_before_parsing_or_storage():
    app, repository, _resolver = _app()
    token = issue_session_csrf(SESSION, app.state.auth_policy_config)
    oversized = {"padding": "x" * 16_384}

    status, headers, body = run_asgi_request(
        app,
        "PUT",
        "/account/appearance",
        headers={
            "cookie": (
                f"__Host-album_haven_session={SESSION}; "
                f"__Host-album_haven_csrf={token}"
            ),
            "origin": "http://testserver",
            "x-album-haven-csrf": token,
        },
        json_body=oversized,
    )

    assert status == 413
    assert decode_json(body) == {"error": "appearance_payload_too_large"}
    assert "no-store" in headers["cache-control"]
    assert repository.writes == []


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
    assert json.loads(bootstrap.group(1)) == {
        **CUSTOM,
        **EXTENDED_DEFAULTS,
        "revision": 0,
        "interaction_overrides": {
            "item_hover": None,
            "item_selected": None,
            "button_hover_background": None,
            "button_pressed": None,
            "item_outline": {"source": "automatic", "color": None},
        },
        "selection_accent": {"enabled": True, "color": "#34CA78"},
        "player_style_override": None,
        "player_recent_sets": [],
        "load_error": False,
    }
    assert bootstrap.end() < html.index("<body")
    assert "no-store" in headers["cache-control"]
    assert repository.reads == [41]


def test_shell_bootstrap_embeds_the_current_aggregate_revision_before_the_editor_can_save():
    from music_app.routes.account_asgi import router as account_router
    from music_app.services.auth_profile_password_postgres import ProfileAccountView

    app, repository, _resolver = _app()
    app.include_router(account_router)
    repository.rows[41] = AGGREGATE_APPEARANCE
    app.state.profile_password_service = SimpleNamespace(load_profile=lambda **_kwargs: ProfileAccountView(
        username="appearance.member", administrator_set_suggestion=False, sessions=(),
    ))

    status, _headers, body = run_asgi_request(
        app, "GET", "/account", headers={"cookie": f"__Host-album_haven_session={SESSION}"},
    )

    assert status == 200
    html = body.decode("utf-8")
    bootstrap = re.search(r'<script\b[^>]*\bid="appearance-bootstrap"[^>]*>(.*?)</script>', html, re.S)
    assert bootstrap is not None
    assert json.loads(bootstrap.group(1)) == {**AGGREGATE_APPEARANCE, "load_error": False}


def test_get_returns_one_complete_revisioned_appearance_snapshot_and_csrf():
    app, repository, _resolver = _app()
    repository.rows[41] = AGGREGATE_APPEARANCE

    status, headers, body = _request(app)

    assert status == 200
    assert decode_json(body) == {
        **AGGREGATE_APPEARANCE,
        "csrf_token": issue_session_csrf(SESSION, app.state.auth_policy_config),
    }
    assert "no-store" in headers["cache-control"]
    assert repository.reads == [41]


def test_put_accepts_one_complete_snapshot_and_forwards_expected_revision_atomically():
    app, repository, _resolver = _app()
    submitted = {
        **{key: value for key, value in AGGREGATE_APPEARANCE.items()
           if key not in {"revision", "player_recent_sets"}},
        "expected_revision": 7,
        "applied_player_set": CLASSIC_GREEN_PLAYER_STYLE,
    }
    saved = {**AGGREGATE_APPEARANCE, "revision": 8}
    captured = []

    def save_preferences(*, account_id, preferences, expected_revision, client_profile="desktop"):
        captured.append((account_id, client_profile, expected_revision, preferences))
        return saved

    repository.save_preferences = save_preferences

    status, headers, body = _request(app, "PUT", submitted)

    assert status == 200
    assert decode_json(body) == saved
    assert "no-store" in headers["cache-control"]
    assert captured == [(41, "desktop", 7, {
        key: value for key, value in submitted.items() if key != "expected_revision"
    })]


def test_stale_put_returns_authoritative_snapshot_without_mutating_any_section():
    from music_app.services.appearance_preferences_postgres import AppearanceRevisionConflict

    app, repository, _resolver = _app()
    current = {**AGGREGATE_APPEARANCE, "revision": 9}
    submitted = {
        **{key: value for key, value in AGGREGATE_APPEARANCE.items()
           if key not in {"revision", "player_recent_sets"}},
        "expected_revision": 7,
        "selection_accent": {"enabled": True, "color": "#855F4F"},
    }

    def conflict(**_kwargs):
        raise AppearanceRevisionConflict(current=current)

    repository.save_preferences = conflict

    status, headers, body = _request(app, "PUT", submitted)

    assert status == 409
    assert decode_json(body) == {"error": "appearance_conflict", "appearance": current}
    assert "no-store" in headers["cache-control"]
    assert repository.rows == {}


@pytest.mark.parametrize("invalid", [
    {"player_style_override": {**CLASSIC_GREEN_PLAYER_STYLE, "css": "display:none"}},
    {"player_style_override": {
        **CLASSIC_GREEN_PLAYER_STYLE,
        "surface": {**CLASSIC_GREEN_PLAYER_STYLE["surface"], "angle": 361},
    }},
    {"player_style_override": {
        **CLASSIC_GREEN_PLAYER_STYLE,
        "controls": {"fill": "#24B86B", "border": "green"},
    }},
    {"interaction_overrides": {**INTERACTION_OVERRIDES, "button_hover_background": "#FFF"}},
    {"interaction_overrides": {
        **INTERACTION_OVERRIDES,
        "item_outline": {"source": "player", "color": "#86B7EF"},
    }},
    {"interaction_overrides": {
        **INTERACTION_OVERRIDES,
        "item_outline": {"source": "custom", "color": None},
    }},
    {"selection_accent": {"enabled": 1, "color": "#6E9BD0"}},
    {"selection_accent": {"enabled": True, "color": "#6E9BD0", "account_id": 52}},
    {"player_recent_sets": []},
])
def test_aggregate_put_rejects_invalid_or_server_owned_nested_state_before_write(invalid):
    app, repository, _resolver = _app()
    submitted = {
        **{key: value for key, value in AGGREGATE_APPEARANCE.items()
           if key not in {"revision", "player_recent_sets"}},
        "expected_revision": 7,
        **invalid,
    }

    status, headers, body = _request(app, "PUT", submitted)

    assert status == 400
    assert decode_json(body) == {"error": "invalid_appearance"}
    assert "no-store" in headers["cache-control"]
    assert repository.writes == []


def test_production_app_registers_each_appearance_method_once():
    from music_app import create_asgi_app

    app = create_asgi_app()
    registrations = [
        (method, route.path)
        for route in app.routes
        if getattr(route, "path", None) == "/account/appearance"
        for method in getattr(route, "methods", set())
    ]

    assert sorted(registrations) == [
        ("GET", "/account/appearance"),
        ("PUT", "/account/appearance"),
    ]
