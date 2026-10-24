"""The trusted shell and initial private projection share server-derived context."""
from types import SimpleNamespace

from music_app.routes import web_asgi
from music_app.services.private_ui_context import private_ui_context_ref


def request_for(actor):
    captured = {}
    class Templates:
        def TemplateResponse(self, request, name, context):
            captured.update(context)
            return SimpleNamespace(headers={})
    request = SimpleNamespace(
        state=SimpleNamespace(current_actor=actor), cookies={},
        app=SimpleNamespace(state=SimpleNamespace(templates=Templates(),
            auth_policy_config={"hmac": {"secret": "synthetic-shell-context-key-only-1234567890", "key_version": 1}})),
    )
    return request, captured


def test_shell_and_bootstrap_match_exact_shared_hmac_without_mutating_input(monkeypatch):
    actor = SimpleNamespace(is_authenticated=True, account_id=4, session_id=7, current_library_id=9,
                            display_name="Reader", username_display="reader")
    request, captured = request_for(actor)
    monkeypatch.setattr(web_asgi, "_runtime_asset_version", lambda: "fixture")
    monkeypatch.setattr(web_asgi, "allowed_actions_for_request", lambda *args, **kwargs: {})
    monkeypatch.setattr(web_asgi, "issue_session_csrf", lambda *args: "csrf-fixture")
    bootstrap = {"initial_view": {"recent_local_albums": [], "recent_not_local_albums": []}}
    web_asgi._template_response(request, {"bootstrap_payload": bootstrap, "private_ui_context": "untrusted"})
    expected = private_ui_context_ref(request)
    assert captured["private_ui_context"] == expected
    assert captured["bootstrap_payload"]["initial_view"]["context_ref"] == expected
    assert "context_ref" not in bootstrap["initial_view"]
    assert str(actor.session_id) != expected


def test_anonymous_shell_has_no_private_stamp(monkeypatch):
    request, captured = request_for(SimpleNamespace(is_authenticated=False))
    monkeypatch.setattr(web_asgi, "_runtime_asset_version", lambda: "fixture")
    monkeypatch.setattr(web_asgi, "allowed_actions_for_request", lambda *args, **kwargs: {})
    monkeypatch.setattr(web_asgi, "issue_session_csrf", lambda *args: "")
    web_asgi._template_response(request, {})
    assert captured["private_ui_context"] is None
