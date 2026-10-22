"""Real private ASGI perimeter; repository behavior is tested separately in SQL."""
import asyncio

import pytest
from music_app.services.current_actor import CurrentActor

from tests.py.test_owned_album_top_route_boundary import (
    Service, actor, middleware_app, mutation_headers, asgi_response, TOP, REQUEST,
)


def body(action):
    value = {"request_key": REQUEST, "revision": "1"}
    if action == "enable_external":
        value.update(title="Published title", description="Approved description",
                     items=[], evidence_revision="a" * 64)
    return value


@pytest.mark.parametrize("action", ["enable_external", "revoke_external"])
def test_owner_publication_actions_reach_existing_normalizer_and_private_envelope(action):
    service = Service()
    current = actor()
    app = middleware_app(service, current)
    status, data, headers = asyncio.run(asgi_response(app, "POST", f"/album-tops/{TOP}/{action}",
        headers=mutation_headers(app, current), payload=body(action)))
    assert status == 200 and data["status"] == "ready"
    assert headers[b"cache-control"] == b"private, no-store"
    assert len(service.calls) == 1
    operation, context, command, constraints = service.calls[0]
    assert operation == "execute" and context.actor == current
    assert command.action == action and command.top_ref == TOP and command.request_key == REQUEST
    assert dict(command.data) == {key: value for key, value in body(action).items() if key != "request_key"}


@pytest.mark.parametrize("action", ["enable_external", "revoke_external"])
@pytest.mark.parametrize("denial", ["csrf", "context", "origin", "anonymous"])
def test_owner_publication_actions_keep_existing_perimeter(action, denial):
    service = Service()
    current = actor()
    app = middleware_app(service, current)
    headers = mutation_headers(app, current)
    if denial == "csrf":
        headers.pop("x-album-haven-csrf")
    elif denial == "context":
        headers["x-albumhaven-context"] = "0" * 64
    elif denial == "origin":
        headers["origin"] = "https://foreign.test"
    else:
        headers.pop("cookie")
        app.state.current_actor_resolver.actor = CurrentActor.anonymous()
    status, data, response_headers = asyncio.run(asgi_response(app, "POST", f"/album-tops/{TOP}/{action}",
        headers=headers, payload=body(action)))
    assert status in {401, 403, 409}
    assert response_headers[b"cache-control"] == b"private, no-store"
    assert service.calls == []


@pytest.mark.parametrize("action", ["enable_external", "revoke_external"])
def test_browser_publication_identity_and_url_are_rejected(action):
    service = Service()
    current = actor()
    app = middleware_app(service, current)
    payload = {**body(action), "public_url": "https://foreign.test/", "publication_ref": TOP}
    status, data, _ = asyncio.run(asgi_response(app, "POST", f"/album-tops/{TOP}/{action}",
        headers=mutation_headers(app, current), payload=payload))
    assert status == 422 and data["error"] == "invalid_command"
    assert service.calls == []
