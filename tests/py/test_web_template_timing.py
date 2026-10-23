"""Numeric-only attribution for slow HTML worker/render phases."""
from types import SimpleNamespace

from music_app.routes import web_asgi


def test_template_timing_separates_worker_wait_hash_context_and_render(monkeypatch):
    now, cpu = [10.0], [1.0]
    monkeypatch.setattr(web_asgi.time, "perf_counter", lambda: now[0])
    monkeypatch.setattr(web_asgi.time, "thread_time", lambda: cpu[0])

    def advance(elapsed, execution):
        now[0] += elapsed
        cpu[0] += execution

    def digest():
        advance(0.1, 0.05)
        return "asset-digest"

    def policy(_request, _actions):
        advance(0.2, 0.02)
        return "allowed"

    def csrf(*_args):
        advance(0.05, 0.01)
        return "private-csrf"

    response = SimpleNamespace(body=b"private")
    captured = []

    class Templates:
        def TemplateResponse(self, request, name, context):
            captured.append(context)
            advance(1.2, 0.3)
            return response

    monkeypatch.setattr(web_asgi, "_runtime_asset_version", digest)
    monkeypatch.setattr(web_asgi, "allowed_actions_for_request", policy)
    monkeypatch.setattr(web_asgi, "issue_session_csrf", csrf)
    request = SimpleNamespace(
        state=SimpleNamespace(index_template_submitted_at=8.0),
        app=SimpleNamespace(state=SimpleNamespace(templates=Templates(), auth_policy_config={})),
        cookies={"__Host-album_haven_session": "private-session"},
    )
    assert web_asgi._template_response(request, {"query": "private-query"}) is response
    assert captured[0]["query"] == "private-query"
    assert captured[0]["account_menu_csrf_token"] == "private-csrf"
    assert request.app.state.runtime_asset_version == "asset-digest"
    assert request.state.index_template_timing == {
        "template_worker_wait_ms": 2000.0,
        "template_work_elapsed_ms": 1950.0,
        "template_thread_cpu_ms": 420.0,
        "template_asset_hash_ms": 100.0,
        "template_context_ms": 650.0,
        "template_render_ms": 1200.0,
        "template_response_bytes": 7,
    }
    assert "private" not in repr(request.state.index_template_timing)
