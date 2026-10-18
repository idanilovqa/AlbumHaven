"""G1 actual mounted router/private boundary, with real guarded fixture service."""
import json
import pytest
from tests.py.popularity_search_postgres_support import mix_urls, popular_db
from tests.py.test_private_popularity_search_http import mounted_popularity
from music_app.services.private_route_boundary import private_action_for_route, csrf_mode_for_route

PATHS = {'target':'/search/popularity-album-target','matches':'/search/popularity-album-matches'}


def body(f,operation):
    status,page = f.call(query={'q':':popular','search_presentation':'albums'})
    assert status == 200
    value = {'result_token':page['native']['result_token'],'album_ref':page['albums'][0]['id']}
    if operation == 'target': return value
    status,resolved = f.call(PATHS['target'],body=value)
    assert status == 200
    return {'source':{'kind':'album-publication',**value},
        'native_album_ref':resolved['data']['native_target']['album_ref'],
        'page_key':'search-detail-page-1','rows':[{'slot':'search-detail-row-1',
        'inventory_track_ref':f'inventory-track:{f.db.library}:{f.db.tracks[0]}'}]}


def forbid(f,monkeypatch):
    calls = []
    def forbidden(*args,**kwargs):
        calls.append(True); raise AssertionError('Rejected command reached service')
    for name in ('resolve_album_target','album_matches'):
        monkeypatch.setattr(f.app.state.private_popularity_search_service,name,forbidden)
    return calls


@pytest.mark.parametrize('operation',PATHS)
def test_actual_routes_browse_csrf_no_store_and_real_service(mounted_popularity,operation):
    f = mounted_popularity
    path = PATHS[operation]
    assert {r.path:r.methods for r in f.app.routes if r.path in PATHS.values()} == {p:{'POST'} for p in PATHS.values()}
    assert private_action_for_route('POST',path) == 'library.browse.read'
    assert csrf_mode_for_route('POST',path) == 'session_header'
    status,value = f.call(path,body=body(f,operation))
    assert status == 200
    assert value['context_ref'] == f.context and 'lifetime' in value
    assert value['contract_version'] == ('popularity-search-album-native-v1' if operation == 'target' else 'popularity-search-album-matches-v1')


@pytest.mark.parametrize('operation',PATHS)
@pytest.mark.parametrize('headers', [
    {'x-album-haven-csrf':None},{'x-album-haven-csrf':'wrong'},
    {'origin':'https://foreign.example'}, {'cookie':None},
    {'x-albumhaven-context':None},{'x-albumhaven-context':'A'*64},
    {'x-albumhaven-context':'b'*64}])
def test_real_perimeter_rejects_before_service(mounted_popularity,monkeypatch,operation,headers):
    f = mounted_popularity
    command = body(f,operation)
    calls = forbid(f,monkeypatch)
    status,value = f.call(PATHS[operation],body=command,change_headers=headers)
    assert status in {401,403,409}
    assert not calls and value.get('ok') is not True


@pytest.mark.parametrize('operation',PATHS)
def test_missing_context_does_not_read_stream(mounted_popularity,monkeypatch,operation):
    from starlette.requests import Request
    f = mounted_popularity
    calls = forbid(f,monkeypatch)
    original = Request.stream
    reads = []
    async def observed(self):
        reads.append(True)
        async for chunk in original(self): yield chunk
    monkeypatch.setattr(Request,'stream',observed)
    status,_ = f.call(PATHS[operation],raw=b'{}',change_headers={'x-albumhaven-context':None})
    assert status == 409 and reads == [] and calls == []


@pytest.mark.parametrize('operation',PATHS)
@pytest.mark.parametrize('where',['body','service'])
def test_context_rechecked_after_each_await(mounted_popularity,monkeypatch,operation,where):
    from starlette.requests import Request
    from music_app.routes import private_search_asgi as routes
    f = mounted_popularity
    command = body(f,operation)
    changed = [False]
    actual_context = routes.private_ui_context_ref
    def context(request): return 'b'*64 if changed[0] else actual_context(request)
    monkeypatch.setattr(routes,'private_ui_context_ref',context)
    if where == 'body':
        actual_stream = Request.stream
        async def stream(self):
            async for chunk in actual_stream(self): yield chunk
            changed[0] = True
        monkeypatch.setattr(Request,'stream',stream)
        calls = forbid(f,monkeypatch)
    else:
        name = 'resolve_album_target' if operation == 'target' else 'album_matches'
        actual = getattr(f.app.state.private_popularity_search_service,name)
        def service(*args,**kwargs):
            result = actual(*args,**kwargs); changed[0] = True; return result
        monkeypatch.setattr(f.app.state.private_popularity_search_service,name,service)
    status,value = f.call(PATHS[operation],body=command)
    assert status == 409 and value['error_code'] == 'stale_context'
    if where == 'body': assert calls == []


@pytest.mark.parametrize('operation',PATHS)
@pytest.mark.parametrize('raw', [b'{"result_token":"a","result_token":"b"}',
    b'{"rows":[{"slot":"a","slot":"b"}]}',b'{"x":NaN}',b'{"x":Infinity}',
    b'{"x":1.5}',b'null',b'[]',b'[[[[{}]]]]',b'\xff',b'{'])
def test_strict_json_rejects_before_service(mounted_popularity,monkeypatch,operation,raw):
    f = mounted_popularity
    calls = forbid(f,monkeypatch)
    status,_ = f.call(PATHS[operation],raw=raw)
    assert status == 400 and calls == []


@pytest.mark.parametrize('operation',PATHS)
@pytest.mark.parametrize('over',[False,True])
@pytest.mark.parametrize('declared',['absent','honest','lying'])
def test_streaming_byte_ceilings_exact_and_over(mounted_popularity,operation,over,declared):
    f = mounted_popularity
    command = body(f,operation)
    limit = 8192 if operation == 'target' else 98304
    raw = json.dumps(command).encode()
    raw += b' '*(limit+int(over)-len(raw))
    headers = {} if declared == 'absent' else {'content-length':str(len(raw) if declared == 'honest' else 2)}
    status,_ = f.call(PATHS[operation],chunks=[raw[:17],raw[17:]],change_headers=headers)
    assert status == (400 if over else 200)


@pytest.mark.parametrize('operation',PATHS)
def test_query_content_type_surplus_and_sanitized_failure(mounted_popularity,monkeypatch,operation):
    f = mounted_popularity
    command = body(f,operation)
    for options in ({'query':{'q':':popular'}},{'change_headers':{'content-type':'text/plain'}}):
        assert f.call(PATHS[operation],body=command,**options)[0] == 400
    assert f.call(PATHS[operation],body={**command,'extra':True})[0] == 400
    name = 'resolve_album_target' if operation == 'target' else 'album_matches'
    def broken(*args,**kwargs): raise RuntimeError('PRIVATE_SQL_AND_PATH_MUST_NOT_ESCAPE')
    monkeypatch.setattr(f.app.state.private_popularity_search_service,name,broken)
    status,value = f.call(PATHS[operation],body=command)
    assert status == 503 and value['error_code'] == 'private_search_unavailable'
    assert 'PRIVATE_SQL_AND_PATH' not in json.dumps(value)
