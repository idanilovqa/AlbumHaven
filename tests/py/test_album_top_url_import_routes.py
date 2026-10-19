"""Existing native source route dispatch and trusted-origin ownership."""
import asyncio
from uuid import uuid4
from music_app.routes import owned_album_tops_asgi as routes
from test_album_top_source_import_routes import Service, source_request
from test_owned_album_top_route_boundary import decoded


def test_url_intake_uses_existing_source_route_and_preserves_private_fragment():
    service = Service()
    payload = {'request_key': str(uuid4()), 'title': 'URL', 'description': '',
        'kind': 'url', 'filename': None, 'content': 'https://example.org/list?q=private#part'}
    response = asyncio.run(routes.submit_album_top_source_import(source_request(service, payload=payload)))
    assert response.status_code == 200 and response.headers['cache-control'] == 'private, no-store'
    assert service.calls[0][2]['payload'] == payload
    assert decoded(response)['data']['top_ref'] is None


def test_factory_uses_validated_auth_policy_not_request_origin(monkeypatch):
    req = source_request(None)
    req.app.state.auth_policy_config = {'public_base_url': 'https://app.example.org/',
        'trusted_origins': ('https://other.example.org',)}
    sentinel = object()
    monkeypatch.setattr(routes, '_service', lambda request: sentinel)
    service = routes._source_import_service(req)
    assert service.tops is sentinel
    assert service.source_origins == ('app.example.org', 'other.example.org')
