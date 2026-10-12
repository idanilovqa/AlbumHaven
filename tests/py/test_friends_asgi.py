"""Friends HTTP contracts with real authentication, CSRF, and Postgres persistence."""
from types import SimpleNamespace

import pytest

from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
from music_app.services.current_actor_postgres import PostgresCurrentActorResolver
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_ui_context import private_ui_context_ref
from tests.py.asgi_testing import decode_json,run_asgi_request
from tests.py.test_friends_postgres import friends,taste_database


@pytest.fixture
def friends_app(friends,asgi_app):
    f=friends
    asgi_app.state.config.update(f.config)
    sessions=PostgresAuthSessionService(f.config)
    issued={account:sessions.issue_session(account) for account in (f.a,f.b,f.c)}
    asgi_app.state.current_actor_resolver=PostgresCurrentActorResolver(f.config,session_service=sessions)
    def request(method,path,*,account=None,headers=None,**kwargs):
        token=issued[account or f.a].raw_token
        csrf=issue_session_csrf(token,asgi_app.state.auth_policy_config)
        actor=asgi_app.state.current_actor_resolver.resolve(token)
        context_ref=private_ui_context_ref(SimpleNamespace(state=SimpleNamespace(current_actor=actor),app=asgi_app))
        supplied={'cookie':f'__Host-album_haven_session={token}; __Host-album_haven_csrf={csrf}',
                  'x-album-haven-csrf':csrf,'x-albumhaven-context':context_ref or '',**(headers or {})}
        status,returned,body=run_asgi_request(asgi_app,method,path,headers=supplied,**kwargs)
        return status,returned,decode_json(body)
    return SimpleNamespace(request=request,app=asgi_app)


def test_real_routes_round_trip_request_accept_and_unfriend(friends,friends_app):
    f=friends;client=friends_app
    status,headers,result=client.request('POST','/friends/requests',json_body={'target_account_ref':f.refs[f.b]})
    assert status==200,result
    assert headers['cache-control']=='private, no-store'
    status,_,notifications=client.request('GET','/friends/notifications',account=f.b)
    assert status==200 and notifications['notifications'][0]['actionable']
    status,_,accepted=client.request('POST',f'/friends/{f.refs[f.a]}/accept',account=f.b,json_body={'expected_revision':result['revision']})
    assert status==200 and accepted['state']=='accepted'
    status,_,profile=client.request('GET',f'/friends/{f.refs[f.b]}')
    assert status==200 and profile['relationship']['allowed_actions']['can_compare_taste']
    status,_,taste=client.request('GET',f'/friends/{f.refs[f.b]}/taste')
    assert status==200 and taste['rows']==[]
    status,_,removed=client.request('POST',f'/friends/{f.refs[f.b]}/unfriend',json_body={'expected_revision':accepted['revision']})
    assert status==200 and removed['state']=='removed'
    status,headers,_=client.request('GET',f'/friends/{f.refs[f.b]}/taste')
    assert status==403 and headers['cache-control']=='private, no-store'


@pytest.mark.parametrize('headers',[{'origin':'https://wrong.example'}, {'x-album-haven-csrf':'wrong'}])
def test_friends_writes_require_origin_and_csrf(friends,friends_app,headers):
    status,returned,_=friends_app.request('POST','/friends/requests',json_body={'target_account_ref':friends.refs[friends.b]},headers=headers)
    assert status==403 and returned['cache-control']=='private, no-store'
    assert friends.store.profile(account_id=friends.a,library_id=friends.main,target_account_id=friends.b)['relationship']['state']=='none'


@pytest.mark.parametrize('payload',[{'target_account_id':True},{'target_account_id':1,'account_id':2},{'target_account_id':None}])
def test_target_spoofing_and_invalid_ids_are_rejected(friends_app,payload):
    status,_,_=friends_app.request('POST','/friends/requests',json_body=payload)
    assert status==400


def test_resource_denial_stops_mutation_and_hides_discovery(friends,friends_app):
    f=friends
    friends_app.app.state.policy_constraint_resolver=lambda context:PolicyEvaluationConstraints(
        deployment_allowed=not(context.resource and context.resource.resource_kind=='account' and context.resource.resource_ref==str(f.b)))
    status,_,_=friends_app.request('POST','/friends/requests',json_body={'target_account_ref':f.refs[f.b]})
    assert status==403
    status,_,body=friends_app.request('GET','/friends/discover',query={'q':f.prefix})
    assert status==200
    assert f.refs[f.b] not in {member['account_ref'] for member in body['members']}
    assert f.refs[f.c] in {member['account_ref'] for member in body['members']}


def test_removed_social_grant_denies_existing_authenticated_session(friends,friends_app):
    f=friends
    with f.connect() as c:
        c.execute("update app.capabilities set revoked_at=now() where account_id=%s and scope_id=%s and capability_key='capability.social'",(f.a,f.main))
    status,headers,_=friends_app.request('GET','/friends')
    assert status==403 and headers['cache-control']=='private, no-store'


def test_regular_social_member_cannot_change_server_policy(friends_app):
    status,_,_=friends_app.request('PUT','/admin/friends-policy',json_body={'auto_friend':True})
    assert status==403


def test_filtered_member_boundary_is_an_encrypted_query_bound_cursor(friends,friends_app):
    f=friends
    friends_app.app.state.policy_constraint_resolver=lambda context:PolicyEvaluationConstraints(
        deployment_allowed=not(context.resource and context.resource.resource_kind=='account' and context.resource.resource_ref==str(f.b)))
    status,_,body=friends_app.request('GET','/friends/discover',query={'q':f.prefix,'limit':1})
    assert status==200 and body['members']==[]
    assert 'next_after' not in body and isinstance(body['next_cursor'],str)
    cursor=body['next_cursor']
    status,_,page=friends_app.request('GET','/friends/discover',query={'q':f.prefix,'limit':1,'cursor':cursor})
    assert status==200 and page['members'][0]['account_ref']==f.refs[f.c]
    assert 'account_id' not in page['members'][0]
    status,_,_=friends_app.request('GET','/friends/discover',query={'q':'different','cursor':cursor})
    assert status==400
    status,_,_=friends_app.request('GET','/friends/discover',account=f.c,query={'q':f.prefix,'cursor':cursor})
    assert status==400


def test_friends_list_returns_current_profile_and_session_bound_context(friends,friends_app):
    status,headers,body=friends_app.request('GET','/friends')
    assert status==200 and headers['cache-control']=='private, no-store'
    assert len(body['context_ref'])==64
    assert body['current_user']['account_ref']==friends.refs[friends.a]
    assert 'account_id' not in body['current_user']
    assert body['allowed_actions']['can_discover_members'] is True
    _,_,other=friends_app.request('GET','/friends',account=friends.b)
    assert other['context_ref']!=body['context_ref']


@pytest.mark.parametrize('stamp',['','0'*64,'wrong'])
def test_stale_friend_ui_context_cannot_mutate_current_session(friends,friends_app,stamp):
    status,_,body=friends_app.request('POST','/friends/requests',
        headers={'x-albumhaven-context':stamp},json_body={'target_account_ref':friends.refs[friends.b]})
    assert status==409 and body['detail']=='stale_context'
    assert friends.store.profile(account_id=friends.a,library_id=friends.main,
        target_account_id=friends.b)['relationship']['state']=='none'


def test_friend_write_body_is_bounded_before_json_decode(friends_app):
    status,_,_=friends_app.request('POST','/friends/requests',body=b' '*17000,
        headers={'content-type':'application/json'})
    assert status==413
