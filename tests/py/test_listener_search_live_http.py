"""Actual HTTP owner admission with real policy and optional real SQL service.

No application startup or production configuration module is needed. Request
objects use explicit test-owned configuration through the route's normal seam.
"""
import asyncio
import json
from types import SimpleNamespace
from urllib.parse import urlencode
import pytest
from starlette.requests import Request
from music_app.routes import private_search_asgi as routes
from music_app.services.current_actor import ActorState,CurrentActor,CapabilityGrant,LibraryRelationship
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.listener_search_live_support import (
    SECRET,database_urls,mutable_ledger,social_ledger,profile,service,assert_wire,
)

ROW='activity_'+'a'*64
HANDLERS={
    'bindings':routes.listener_search_native_bindings_response,
    'single':routes.listener_search_native_target_response,
    'batch':routes.listener_search_native_targets_response,
}


def actor():
    return CurrentActor(state=ActorState.ACTIVE,account_id=41,session_id=8,current_library_id=73,
        library_relationships=(LibraryRelationship(73,'member',False),),
        capability_grants=(CapabilityGrant('library.browse.read','library',73),))


def http_request(*,state=None,query=(),body=None,raw=None,header='valid',content_type='application/json',extra_headers=()):
    config={'ALBUM_HAVEN_DEPLOYMENT_MODE':'self_hosted'}
    if state:config.update(state['db'].config)
    app=SimpleNamespace(state=SimpleNamespace(config=config,library_state={},
        auth_policy_config={'hmac':{'secret':SECRET,'key_version':1}}))
    if state:app.state.private_listener_search_service=service(state)
    headers=[(b'content-type',content_type.encode()),*extra_headers]
    scope={'type':'http','method':'POST' if body is not None or raw is not None else 'GET',
        'path':'/view-data','app':app,'state':{'current_actor':state['actor'] if state else actor()},
        'scheme':'https','client':('192.0.2.10',50000),'server':('music.test',443),
        'query_string':urlencode(query,doseq=True).encode(),'headers':headers}
    preliminary=Request(scope)
    if header is not None:
        value=private_ui_context_ref(preliminary) if header=='valid' else header
        headers.append((b'x-albumhaven-context',value.encode()))
    encoded=raw if raw is not None else json.dumps(body).encode() if body is not None else b''
    consumed=False
    async def receive():
        nonlocal consumed
        if consumed:return {'type':'http.disconnect'}
        consumed=True
        return {'type':'http.request','body':encoded,'more_body':False}
    return Request(scope,receive)


def assert_response(response,status):
    assert response.status_code==status
    assert {'private','no-store'} <= {v.strip() for v in response.headers['cache-control'].split(',')}
    data=json.loads(response.body)
    if status!=200:
        assert set(data)=={'ok','error_code','error','location'}
        assert data['ok'] is False
        assert not {'tracks','artists_sidebar','music_dir','native_target'} & data.keys()
    assert SECRET not in response.body.decode() and 'postgresql://' not in response.body.decode()
    return data


def command(operation):
    value={'result_token':'opaque'}
    value['row_ref' if operation=='single' else 'row_refs']=ROW if operation=='single' else [ROW]
    if operation!='bindings':value['intent']='metadata'
    return value


@pytest.mark.parametrize('operation',HANDLERS)
@pytest.mark.parametrize('override',['target_account_id','context','prelock','hint','configuration','subject_taste','origin','allowed_actions'])
def test_reject_every_authority_override(operation,override):
    value=command(operation)
    value[override]=None
    assert_response(asyncio.run(HANDLERS[operation](http_request(body=value))),400)


@pytest.mark.parametrize('intent',['metadata','play','details'])
@pytest.mark.parametrize('target_kind',[None,True,[],{},'track','Album'])
def test_present_target_kind_must_be_album_or_artist_for_details(intent,target_kind,monkeypatch):
    calls=[]
    def forbidden(*args,**kwargs):
        calls.append(True)
        raise AssertionError("Invalid command constructed private service")
    monkeypatch.setattr(routes.PostgresListenerSearch,"__init__",forbidden)
    value=command('single')
    value.update(intent=intent,target_kind=target_kind)
    response=asyncio.run(HANDLERS['single'](http_request(body=value)))
    # Exact-schema rejection is required before attempting opaque token decode.
    assert_response(response,422)
    assert calls==[]


@pytest.mark.parametrize('operation',HANDLERS)
@pytest.mark.parametrize('kind',['query','content_type','oversized','duplicate','array','empty_token'])
def test_native_bounded_exact_json_admission(operation,kind):
    value=command(operation)
    kwargs={'body':value}
    if kind=='query':kwargs['query']={'q':'@maya'}
    elif kind=='content_type':kwargs['content_type']='text/plain'
    elif kind=='oversized':kwargs['raw']=b' '*16385
    elif kind=='duplicate':kwargs['raw']=b'{"result_token":"a","result_token":"b"}'
    elif kind=='array':kwargs['body']=[]
    else:value['result_token']=''
    assert_response(asyncio.run(HANDLERS[operation](http_request(**kwargs))),400)


@pytest.mark.parametrize('header',[None,'bad','f'*64])
@pytest.mark.parametrize('operation',['read',*HANDLERS])
def test_matching_context_header_is_mandatory(operation,header):
    request=http_request(query={'q':'@maya'} if operation=='read' else (),
        body=None if operation=='read' else command(operation),header=header)
    response=routes.private_search_view_response(request) if operation=='read' else asyncio.run(HANDLERS[operation](request))
    assert assert_response(response,409)['error_code']=='stale_context'


@pytest.mark.parametrize('field',['artist','all_artists','omit_sidebar','category','gallery_scope','search_sidebar_cursor','payload_tier'])
def test_read_rejects_ordinary_and_own_love_fields(field):
    response=routes.private_search_view_response(http_request(query={'q':'@maya',field:'1'}))
    assert_response(response,400)


def test_real_route_dispatches_typed_listener_request_to_real_sql(social_ledger):
    state=social_ledger
    name=profile(state['db'],state['peer'])['username_normalized']
    query='  @'+name.upper()+'  '
    response=routes.private_search_view_response(http_request(state=state,query={'surface':'albums','q':query}))
    value=assert_response(response,200)
    assert_wire(value)
    assert value['query']==query and value['listener']['account_ref']==state['peer_ref']
    # Result-token native action carries the route-produced context, not a test constant.
    body={'result_token':value['native']['result_token'],'row_refs':[r['id'] for r in value['tracks']]}
    response=asyncio.run(HANDLERS['bindings'](http_request(state=state,body=body)))
    actual=assert_response(response,200)
    assert actual['contract_version']=='listener-search-native-bindings-v1'


def test_early_view_data_dispatch_does_not_enter_transient_fallback(monkeypatch):
    from music_app.routes import api_read_asgi_routes as api
    def forbidden(*args,**kwargs):raise AssertionError('Listener request reached ordinary fallback')
    monkeypatch.setattr(api,'_transient_scan_view_response',forbidden)
    monkeypatch.setattr(api,'_should_use_transient_scan_browse_state',lambda *args:True)
    monkeypatch.setattr(api,'select_runtime_persistence_adapter',lambda *args:SimpleNamespace(effective_backend=api.PERSISTENCE_BACKEND_POSTGRES))
    response=api.view_data(http_request(query={'surface':'albums','q':'@maya'},header=None))
    assert_response(response,409)


def test_infrastructure_exception_is_private_503_not_empty_or_ordinary(monkeypatch):
    def broken(*args,**kwargs):raise RuntimeError('postgresql://synthetic-private')
    monkeypatch.setattr(routes.PostgresListenerSearch,'read_live',broken)
    response=routes.private_search_view_response(http_request(query={'q':'@maya'}))
    data=assert_response(response,503)
    assert data['error_code']=='private_search_unavailable'


@pytest.mark.parametrize('intent,target_kind',[('metadata','omitted'),('details','omitted'),
    ('details','album'),('details','artist')])
def test_valid_single_commands_preserve_omitted_and_details_controls(social_ledger,intent,target_kind):
    state=social_ledger
    name=profile(state['db'],state['peer'])['username_normalized']
    result=assert_response(routes.private_search_view_response(http_request(state=state,query={'q':'@'+name})),200)
    body={'result_token':result['native']['result_token'],'row_ref':result['tracks'][0]['id'],'intent':intent}
    if target_kind!='omitted':body['target_kind']=target_kind
    response=asyncio.run(HANDLERS['single'](http_request(state=state,body=body)))
    value=assert_response(response,200)
    assert value['data']['intent']==intent
    if target_kind!='omitted':assert target_kind+'_ref' in value['data']['native_target']


def test_three_listener_routes_are_post_only_and_remain_separate():
    from music_app.routes.api_read_asgi_routes import router
    expected={'/search/listener-native-bindings','/search/listener-native-target','/search/listener-native-targets'}
    found={route.path:route.methods for route in router.routes if route.path in expected}
    assert found=={path:{'POST'} for path in expected}


@pytest.fixture
def mounted_listener(social_ledger):
    """Actual router/perimeter/session/policy/SQL; only isolated library selection.

    The durable actor resolver remains real. Its normal host-library selector is
    replaced only by this uniquely owned fixture library after real membership
    resolution, avoiding edits to a shared bootstrap owner or global grants.
    """
    from dataclasses import replace
    from fastapi import FastAPI
    from music_app.routes.api_read_asgi_routes import router
    from music_app.services.auth_session_csrf import issue_session_csrf
    from music_app.services.auth_tokens import issue_opaque_token
    from music_app.services.current_actor_postgres import PostgresCurrentActorResolver
    from music_app.services.private_route_boundary import install_private_route_boundary
    from tests.py.asgi_testing import run_asgi_request
    state=social_ledger
    issued=issue_opaque_token()
    with state['db'].connect() as con:
        con.execute('update app.account_sessions set session_token_hash=%s where id=%s',(issued.digest,state['actor'].session_id))
        con.execute('update app.capabilities set revoked_at=clock_timestamp() where account_id=%s',(state['actor'].account_id,))
        con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,'capability.view','library',%s)",
            (state['actor'].account_id,state['data']['library']))
    app=FastAPI()
    app.state.config={**state['db'].config,'ALBUM_HAVEN_DEPLOYMENT_MODE':'self_hosted'}
    app.state.auth_policy_config={'hmac':{'secret':SECRET,'key_version':1}}
    app.state.library_state={}
    real=PostgresCurrentActorResolver(app.state.config)
    class FixtureLibraryResolver:
        def resolve(self,token):
            resolved=real.resolve(token)
            if not resolved.is_authenticated:return resolved
            library=state['data']['library']
            assert any(item.library_id==library for item in resolved.library_relationships)
            return replace(resolved,current_library_id=library)
    app.state.current_actor_resolver=FixtureLibraryResolver()
    app.state.private_listener_search_service=service(state)
    app.include_router(router)
    install_private_route_boundary(app)
    csrf=issue_session_csrf(issued.raw,app.state.auth_policy_config)
    f=SimpleNamespace(app=app,state=state,calls=[])
    def call(path,*,body=None,query=None,change_headers=None):
        current=app.state.current_actor_resolver.resolve(issued.raw)
        scope={'type':'http','method':'POST' if body is not None else 'GET','path':path,
            'app':app,'state':{'current_actor':current},'headers':[], 'query_string':b''}
        context=private_ui_context_ref(Request(scope))
        headers={'cookie':f'__Host-album_haven_session={issued.raw}; __Host-album_haven_csrf={csrf}',
            'origin':'http://testserver','x-album-haven-csrf':csrf,'x-albumhaven-context':context or ''}
        for key,value in (change_headers or {}).items():
            if value is None:headers.pop(key,None)
            else:headers[key]=value
        status,response_headers,raw=run_asgi_request(app,'POST' if body is not None else 'GET',path,
            query=query,headers=headers,json_body=body)
        assert {'private','no-store'} <= {p.strip() for p in response_headers.get('cache-control','').split(',')}
        return status,json.loads(raw)
    f.call=call
    current=app.state.current_actor_resolver.resolve(issued.raw)
    assert not current.is_bootstrap_owner
    assert [(g.capability_key,g.scope_kind,g.scope_id) for g in current.capability_grants]==[
        ('capability.view','library',state['data']['library'])]
    name=profile(state['db'],state['peer'])['username_normalized']
    status,f.result=call('/view-data',query={'surface':'albums','q':'@'+name})
    assert status==200
    return f


MOUNTED_PATHS={'bindings':'/search/listener-native-bindings',
    'single':'/search/listener-native-target','batch':'/search/listener-native-targets'}


def mounted_command(f,operation):
    value={'result_token':f.result['native']['result_token']}
    refs=[row['id'] for row in f.result['tracks']]
    value['row_ref' if operation=='single' else 'row_refs']=refs[0] if operation=='single' else refs
    if operation!='bindings':value['intent']='metadata'
    return value


@pytest.mark.parametrize('operation',MOUNTED_PATHS)
def test_mounted_library_scoped_viewer_reaches_all_native_owners(mounted_listener,operation):
    from music_app.services.private_route_boundary import private_action_for_route,csrf_mode_for_route
    path=MOUNTED_PATHS[operation]
    assert private_action_for_route('POST',path)=='library.browse.read'
    assert csrf_mode_for_route('POST',path)=='session_header'
    status,payload=mounted_listener.call(path,body=mounted_command(mounted_listener,operation))
    assert status==200 and payload['status']=='ready'


@pytest.mark.parametrize('operation',MOUNTED_PATHS)
@pytest.mark.parametrize('change',[{'x-album-haven-csrf':None},{'x-album-haven-csrf':'wrong'},
    {'origin':'https://foreign.example'},{'origin':None},{'cookie':'__Host-album_haven_session='+'x'*43}])
def test_mounted_session_csrf_and_origin_fail_before_service(mounted_listener,operation,change,monkeypatch):
    calls=[]
    def forbidden(*args,**kwargs):calls.append(True);raise AssertionError('Perimeter failure reached service')
    for method in ('project_live_bindings','resolve_live_target','resolve_live_targets'):
        monkeypatch.setattr(mounted_listener.app.state.private_listener_search_service,method,forbidden)
    status,payload=mounted_listener.call(MOUNTED_PATHS[operation],body=mounted_command(mounted_listener,operation),change_headers=change)
    assert status==(401 if 'cookie' in change else 403)
    assert not calls and 'data' not in payload


@pytest.mark.parametrize('operation',MOUNTED_PATHS)
def test_mounted_durable_browse_denial_has_private_error_before_service(mounted_listener,operation,monkeypatch):
    state=mounted_listener.state
    with state['db'].connect() as con:
        con.execute('update app.capabilities set revoked_at=clock_timestamp() where account_id=%s',(state['actor'].account_id,))
    calls=[]
    def forbidden(*args,**kwargs):calls.append(True);raise AssertionError('Denied viewer reached service')
    for method in ('project_live_bindings','resolve_live_target','resolve_live_targets'):
        monkeypatch.setattr(mounted_listener.app.state.private_listener_search_service,method,forbidden)
    status,payload=mounted_listener.call(MOUNTED_PATHS[operation],body=mounted_command(mounted_listener,operation))
    assert status==403 and not calls and 'data' not in payload
