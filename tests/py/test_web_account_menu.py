from types import SimpleNamespace

import pytest
from starlette.requests import Request

from music_app.routes import web_asgi
from music_app.services.auth_session_csrf import matches_session_csrf


@pytest.mark.parametrize("can_manage", [False, True])
def test_shell_menu_uses_policy_projection_and_session_bound_csrf(monkeypatch, can_manage):
    session = "s" * 43
    config = {"hmac": {"secret": "s" * 32, "key_version": 1}}
    allowed = SimpleNamespace(allows=lambda action: can_manage and action == "accounts.read")
    calls = []

    def project(request, actions):
        calls.append((request, actions))
        return allowed

    class Templates:
        def TemplateResponse(self, request, name, context):
            assert name == "index.html"
            return context

    monkeypatch.setattr(web_asgi, "allowed_actions_for_request", project, raising=False)
    app = SimpleNamespace(state=SimpleNamespace(
        templates=Templates(), runtime_asset_version="test", auth_policy_config=config,
    ))
    request = Request({
        "type": "http", "app": app,
        "headers": [(b"cookie", f"__Host-album_haven_session={session}".encode())],
    })

    context = web_asgi._template_response(request, {})

    assert calls == [(request, ("accounts.read",))]
    assert context["account_menu_allowed_actions"] is allowed
    assert context["account_menu_allowed_actions"].allows("accounts.read") is can_manage
    assert matches_session_csrf(session, context["account_menu_csrf_token"], config)
