"""Actual D router/perimeter/template with explicit service contract doubles.

No app/config bootstrap and no database evidence is claimed by these tests.
The existing ASGI exchange and unchanged middleware-owner extraction are reused.
"""
import asyncio
import ast
from copy import deepcopy
import json
from pathlib import Path

import pytest

from music_app.routes import public_album_tops_asgi as routes
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.private_route_boundary import public_share_request_origin, _is_public_share_request
from tests.py.test_public_album_top_http import app_for, exchange, actor, origin_request, SHARE, ITEM, PATH, ORIGIN
from tests.py.test_public_album_top_html import MetadataService, Page, BROWSER

PUBLICATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
ASSET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
PNG = b'\x89PNG\r\n\x1a\nretained-bytes-at-explicit-service-double-boundary'
PNG_PATH = f'{PATH}/publications/{PUBLICATION}/items/{ITEM}/artwork/{ASSET}.png'


class ArtworkService(MetadataService):
    def __init__(self):
        super().__init__()
        self.images, self.admissions, self.order = [], [], []
        self.admission_error = None
        self.on_admission = None
        self.image_error = None
        self.image_value = None
    def read_guest(self, **options):
        value = super().read_guest(**options)
        value.update(publication_ref=PUBLICATION, publication_contract_version=2)
        rows = [value['item']] if options.get('item_ref') is not None else value['items']
        for row in rows: row['artwork_ref'] = ASSET
        self.order.append('metadata')
        return value
    def read_guest_artwork(self, *, share_ref, publication_ref, item_ref, asset_ref, head_only,
                           request_origin, constraints=None):
        self.images.append(dict(share_ref=share_ref, publication_ref=publication_ref, item_ref=item_ref,
            asset_ref=asset_ref, head_only=head_only, request_origin=request_origin, constraints=constraints))
        self.order.append('image')
        if self.image_error: raise self.image_error
        if self.image_value is not None: return deepcopy(self.image_value)
        return {'content_type': 'image/png', 'content_length': len(PNG), 'body': b'' if head_only else PNG}
    def recheck_guest_response(self, *, share_ref, publication_ref, publication_contract_version,
                               request_origin, item_ref=None, asset_ref=None, constraints=None):
        self.admissions.append(dict(share_ref=share_ref, publication_ref=publication_ref,
            publication_contract_version=publication_contract_version, item_ref=item_ref, asset_ref=asset_ref,
            request_origin=request_origin, constraints=constraints))
        self.order.append('admission')
        if self.on_admission: self.on_admission()
        if self.admission_error: raise self.admission_error


def request(service=None, *, method='GET', path=PNG_PATH, **options):
    return asyncio.run(exchange(app_for(service or ArtworkService()), method, path, **options))


def fixed(headers, *, image=True):
    assert headers[b'cache-control'] == b'private, no-store'
    assert headers[b'x-content-type-options'] == b'nosniff'
    assert headers[b'referrer-policy'] == b'no-referrer'
    for key in (b'etag', b'last-modified', b'accept-ranges', b'content-range', b'content-disposition'):
        assert key not in headers
    if image: assert b'vary' not in headers


@pytest.mark.parametrize('method', ['GET', 'HEAD'])
def test_exact_four_uuid_png_shape_is_in_existing_perimeter(method):
    req = origin_request(method=method, path=PNG_PATH, raw_path=PNG_PATH.encode())
    assert public_share_request_origin(req) == ORIGIN and _is_public_share_request(req)


@pytest.mark.parametrize('changes', [
    {'method': 'POST'}, {'method': 'OPTIONS'}, {'path': PNG_PATH + '/'},
    {'path': PNG_PATH[:-4]}, {'path': PNG_PATH.replace('.png', '.PNG')},
    {'path': PNG_PATH.replace(ASSET, ASSET.upper())},
    {'path': PNG_PATH.replace('/artwork/', '/artwork/../artwork/')},
    {'raw_path': PNG_PATH.replace('artwork', '%61rtwork').encode()},
    {'raw_path': PNG_PATH.replace('/artwork/', '%2fartwork%2f').encode()},
    {'raw_path': PNG_PATH.encode() + b'%2e'}, {'scheme': 'http'},
    {'headers': [(b'host', b'foreign.example.test'), (b'x-forwarded-host', b'public.example.test')]},
])
def test_png_perimeter_does_not_admit_encoded_alternate_or_wrong_origin_paths(changes):
    req = origin_request(path=PNG_PATH, raw_path=PNG_PATH.encode())
    req.scope.update(changes)
    assert public_share_request_origin(req) is None and not _is_public_share_request(req)


@pytest.mark.parametrize('method', ['POST', 'PUT', 'DELETE', 'OPTIONS'])
def test_nonread_png_methods_never_reach_guest_service(method):
    service = ArtworkService(); status, _, _ = request(service, method=method)
    assert status in {401, 403, 405} and not service.images and not service.admissions


@pytest.mark.parametrize('query', [b'?', b'limit=1', b'cursor=x', b'foo=', b'a=1&a=2', b'token=secret', b'%00'])
@pytest.mark.parametrize('method', ['GET', 'HEAD'])
def test_any_nonempty_png_query_is_rejected_before_service(query, method):
    service = ArtworkService(); status, body, headers = request(service, method=method, query=query)
    assert status == 400 and not service.images and not service.admissions
    assert body == b'' if method == 'HEAD' else json.loads(body) == {'ok': False, 'error': 'invalid_query'}
    fixed(headers)


@pytest.mark.parametrize('current', [None, actor()])
@pytest.mark.parametrize('method', ['GET', 'HEAD'])
def test_png_get_head_have_same_public_scope_and_exact_headers(current, method):
    service = ArtworkService()
    status, body, headers = asyncio.run(exchange(app_for(service, current), method, PNG_PATH,
        headers={'accept': BROWSER, 'range': 'bytes=0-1', 'if-none-match': '*',
                 'if-modified-since': 'Wed, 21 Oct 2037 07:28:00 GMT'}))
    assert status == 200 and body == (b'' if method == 'HEAD' else PNG)
    assert headers[b'content-type'] == b'image/png' and int(headers[b'content-length']) == len(PNG)
    fixed(headers)
    assert len(service.images) == len(service.admissions) == 1
    read, final = service.images[0], service.admissions[0]
    for key, expected in [('share_ref', SHARE), ('publication_ref', PUBLICATION), ('item_ref', ITEM), ('asset_ref', ASSET)]:
        assert read[key] == final[key] == expected
    assert read['head_only'] is (method == 'HEAD') and final['publication_contract_version'] == 2
    assert read['request_origin'].origin_type == final['request_origin'].origin_type == 'network'
    assert read['request_origin'].origin_key == final['request_origin'].origin_key == ORIGIN
    assert 'context' not in read and 'cursor_secret' not in read


@pytest.mark.parametrize('method', ['GET', 'HEAD'])
@pytest.mark.parametrize('error,status', [(AlbumTopError('unavailable', 404), 404),
    (AlbumTopError('forbidden', 403), 404), (RuntimeError('private database credential sentinel'), 503)])
def test_png_denials_stay_fixed_json_and_never_html_or_partial(method, error, status):
    service = ArtworkService(); service.image_error = error
    actual, body, headers = request(service, method=method, headers={'accept': BROWSER, 'range': 'bytes=0-1'})
    assert actual == status and not service.admissions
    assert headers[b'content-type'].startswith(b'application/json'); fixed(headers)
    assert body == b'' if method == 'HEAD' else json.loads(body) == {'ok': False, 'error': 'unavailable'}
    assert b'credential' not in body and PNG not in body


@pytest.mark.parametrize('head_only', [False, True])
@pytest.mark.parametrize('change', [
    {'content_type': 'text/html'}, {'content_length': 327681}, {'content_length': True},
    {'body': 'private string'}, {'private_path': '/secret'}, {'body': b'wrong length'},
])
def test_malformed_png_service_results_never_reach_final_admission(head_only, change):
    service = ArtworkService()
    service.image_value = {'content_type': 'image/png', 'content_length': len(PNG),
                           'body': b'' if head_only else PNG, **change}
    status, body, _ = request(service, method='HEAD' if head_only else 'GET')
    assert status in {404, 503} and not service.admissions and PNG not in body and b'/secret' not in body


@pytest.mark.parametrize('kind', ['top', 'item'])
@pytest.mark.parametrize('accept', ['application/json', BROWSER])
@pytest.mark.parametrize('method', ['GET', 'HEAD'])
def test_v2_metadata_exact_positive_projection_and_fresh_admission(kind, accept, method):
    service = ArtworkService(); path = PATH + ('/items/' + ITEM if kind == 'item' else '')
    status, body, headers = request(service, method=method, path=path, headers={'accept': accept})
    assert status == 200 and len(service.admissions) == 1 and not service.images
    fixed(headers, image=False); assert headers[b'vary'] == b'Accept'
    final = service.admissions[0]
    assert final['publication_ref'] == PUBLICATION and final['publication_contract_version'] == 2
    assert final['item_ref'] == (ITEM if kind == 'item' else None) and final['asset_ref'] is None
    if method == 'HEAD': assert body == b''
    else:
        data = Page(body).payload['data'] if accept == BROWSER else json.loads(body)['data']
        assert data['publication_contract_version'] == 2
        assert data['allowed_actions'] == {'can_read': True, 'can_open_item': True}
        assert (data['item'] if kind == 'item' else data['items'][0])['artwork_ref'] == ASSET
        if accept == BROWSER:
            assert b'approved artwork' in body and b'audio' in body.lower()


@pytest.mark.parametrize('accept', ['application/json', BROWSER])
@pytest.mark.parametrize('change', ['missing_version', 'string_version', 'bool_version', 'extra', 'url'])
def test_malformed_or_mixed_v2_never_admits_or_fetches_images(accept, change):
    service = ArtworkService(); original = service.read_guest
    def changed(**options):
        value = original(**options)
        if change == 'missing_version': value.pop('publication_contract_version')
        elif change == 'string_version': value['publication_contract_version'] = '2'
        elif change == 'bool_version': value['publication_contract_version'] = True
        elif change == 'extra': value['items'][0]['source_stamp'] = {'secret': True}
        else: value['items'][0]['artwork_ref'] = 'https://private.example/'
        return value
    service.read_guest = changed
    status, body, _ = request(service, path=PATH, headers={'accept': accept})
    assert status in {404, 503} and not service.admissions and not service.images
    assert b'Approved album' not in body and b'private.example' not in body and b'source_stamp' not in body
    if accept == BROWSER: assert Page(body).payload is None


def test_v2_html_escapes_approved_labels_with_no_inline_image_request():
    service = ArtworkService(); original = service.read_guest
    hostile = '</script><img src="https://foreign.example/" onerror="bad()"> & <script>bad()</script>'
    def changed(**options):
        value = original(**options); value['title'] = '<script>Title & "</script>'
        value['items'][0]['title'] = hostile; return value
    service.read_guest = changed
    status, body, _ = request(service, path=PATH, headers={'accept': BROWSER})
    assert status == 200 and Page(body).payload['data']['items'][0]['title'] == hostile
    assert b'<img src="https://foreign.example/' not in body and b'<script>bad()' not in body
    assert b'\\u003c/script\\u003e' in body and not service.images


@pytest.mark.parametrize('representation', ['png', 'json', 'html'])
@pytest.mark.parametrize('failure', ['revoked', 'republished', 'policy', 'commit', 'deployment'])
@pytest.mark.parametrize('method', ['GET', 'HEAD'])
def test_prepared_response_is_discarded_when_final_admission_changes(monkeypatch, representation, failure, method):
    service = ArtworkService(); app = app_for(service); prepared = []
    if representation == 'png':
        actual = routes.Response
        def construct(*args, **kwargs):
            result = actual(*args, **kwargs); prepared.append(result); service.order.append('constructed'); return result
        monkeypatch.setattr(routes, 'Response', construct)
    else:
        actual = routes._response
        def construct(*args, **kwargs):
            result = actual(*args, **kwargs)
            if result.status_code == 200: prepared.append(result); service.order.append('constructed')
            return result
        monkeypatch.setattr(routes, '_response', construct)
    def admission():
        assert prepared and service.order[-2:] == ['constructed', 'admission']
        if method == 'HEAD': assert prepared[0].body == b''
        if failure == 'deployment': app.state.config['ALBUM_HAVEN_PUBLIC_SHARING_ENABLED'] = False
        elif failure == 'commit': raise RuntimeError('private transaction exit sentinel')
        else: raise AlbumTopError('unavailable', 404)
    service.on_admission = admission
    status, body, _ = asyncio.run(exchange(app, method, PNG_PATH if representation == 'png' else PATH,
        headers={'accept': BROWSER if representation == 'html' else 'application/json'}))
    assert status == (503 if failure == 'commit' else 404)
    assert b'Approved' not in body and PNG not in body and b'sentinel' not in body
    assert service.order[-1] == 'admission'
    if method == 'HEAD': assert body == b''
    elif representation == 'html': assert Page(body).payload is None
    else: assert json.loads(body) == {'ok': False, 'error': 'unavailable'}


def test_v2_renderer_failure_has_no_admission_or_snapshot_content():
    service = ArtworkService(); app = app_for(service)
    class Broken:
        def TemplateResponse(self, *args, **kwargs): raise RuntimeError('private rendering sentinel')
    app.state.templates = Broken()
    status, body, _ = asyncio.run(exchange(app, path=PATH, headers={'accept': BROWSER}))
    assert status == 503 and not service.admissions and not service.images
    assert Page(body).payload is None and b'Approved' not in body and b'sentinel' not in body


@pytest.mark.parametrize('method', ['GET', 'HEAD'])
def test_encoded_response_bound_is_applied_before_head_suppression(monkeypatch, method):
    service = ArtworkService()
    status, body, _ = request(service, path=PATH)
    assert status == 200
    monkeypatch.setattr(routes, 'MAX_PUBLIC_RESPONSE_BYTES', len(body) - 1)
    service.admissions.clear()
    status, rejected_body, _ = request(service, method=method, path=PATH)
    assert status == 503 and not service.admissions and b'Approved' not in rejected_body


def test_actual_html_cache_middleware_and_png_keep_distinct_contracts():
    # Execute just the existing nested middleware owner, never _configure_asgi_app.
    path = Path(__file__).resolve().parents[2] / 'music_app' / '__init__.py'
    module = ast.parse(path.read_text(encoding='utf-8'))
    configure = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == '_configure_asgi_app')
    middleware = next(node for node in configure.body if isinstance(node, ast.AsyncFunctionDef)
                      and node.name == 'require_runtime_javascript_revalidation')
    app = app_for(ArtworkService())
    isolated = ast.fix_missing_locations(ast.Module(body=[middleware], type_ignores=[]))
    exec(compile(isolated, str(path), 'exec'), {'app': app})
    status, body, headers = asyncio.run(exchange(app, path=PATH, headers={'accept': BROWSER}))
    assert status == 200 and Page(body).payload['data']['publication_contract_version'] == 2
    assert headers[b'cache-control'] == b'no-store, max-age=0'
    assert headers[b'pragma'] == b'no-cache' and headers[b'expires'] == b'0'
    status, body, headers = asyncio.run(exchange(app, path=PNG_PATH))
    assert status == 200 and body == PNG; fixed(headers)


@pytest.mark.parametrize('kind,limit', [('top', 100), ('item', 250)])
@pytest.mark.parametrize('accept', ['application/json', BROWSER])
def test_maximum_pages_with_unicode_and_html_escaping_stay_within_encoded_bound(kind, limit, accept):
    from uuid import UUID
    service = ArtworkService(); original = service.read_guest
    def maximal(**options):
        value = original(**options)
        if kind == 'top':
            value['title'] = '<&>' * 33
            value['description'] = '\U0001f3b5' * 1000
            row = value['items'][0]
            value['items'] = [{**row, 'item_ref': str(UUID(int=index + 1)),
                'original_position': str(index + 1), 'curator_position': index + 1,
                'title': '\U0001f3b5' * 1000, 'artist': '<&>' * 333,
                'details_path': PATH + '/items/' + str(UUID(int=index + 1))} for index in range(limit)]
        else:
            value['tracks'] = [{'track_ref': str(UUID(int=index + 1)), 'position': index + 1,
                'title': '\U0001f3b5' * 1000, 'artist': '\U0001f3b5' * 1000,
                'duration_ms': 2**31 - 1} for index in range(limit)]
            value['track_count'] = 5000; value['next_cursor'] = 'continuation'
        return value
    service.read_guest = maximal
    status, body, headers = request(service, path=PATH + ('/items/' + ITEM if kind == 'item' else ''),
        query=f'limit={limit}'.encode(), headers={'accept': accept})
    assert status == 200 and len(body) <= 8 * 1024 * 1024
    assert int(headers[b'content-length']) == len(body) and len(service.admissions) == 1
    data = Page(body).payload['data'] if accept == BROWSER else json.loads(body)['data']
    assert len(data['items'] if kind == 'top' else data['tracks']) == limit
