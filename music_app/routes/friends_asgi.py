"""Authenticated Friends endpoints using the shared private route boundary."""
from __future__ import annotations

import hmac

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.services.friends_postgres import FriendConflictError, FriendScopeError, PostgresFriendsStore
from music_app.services.policy import ResourceScope
from music_app.services.social_cursors import encode_social_cursor, decode_social_cursor
from music_app.services.policy_asgi import allowed_actions_for_request, require_action

from music_app.services.private_ui_context import private_ui_context_ref, PrivateUIContextError
from music_app.routes.bounded_json import read_bounded_json_object, JSONBodyTooLarge

router=APIRouter()


def _scope(request):
    actor=request.state.current_actor
    if not actor.is_authenticated or actor.current_library_id is None or not any(
        relation.library_id==actor.current_library_id for relation in actor.library_relationships
    ):
        raise HTTPException(403,'Social scope is unavailable.')
    return {'account_id':actor.account_id,'library_id':actor.current_library_id}


async def _call(request,method,**kwargs):
    scope=_scope(request)
    if method in {'transition','policy','mark_notification_read','compare_taste','current_profile'}:
        scope['actor_session_id']=request.state.current_actor.session_id
    try:
        store=PostgresFriendsStore(request.app.state.config)
        result=await run_in_threadpool(getattr(store,method),**scope,**kwargs)
        return result
    except FriendScopeError:
        raise HTTPException(403,'Social scope is unavailable.') from None
    except FriendConflictError as exc:
        raise HTTPException(409,str(exc)) from None
    except ValueError as exc:
        raise HTTPException(400,str(exc)) from None
    except Exception:
        raise HTTPException(503,'Friends are temporarily unavailable.') from None


def _context_ref(request):
    try:
        value=private_ui_context_ref(request)
    except PrivateUIContextError:
        raise HTTPException(503,'Private interface context is unavailable.') from None
    if value is None:
        raise HTTPException(403,'Social scope is unavailable.')
    return value


def _require_context(request):
    supplied=request.headers.get('x-albumhaven-context','')
    current=_context_ref(request)
    if len(supplied)!=64 or not supplied.isascii() or not hmac.compare_digest(supplied,current):
        raise HTTPException(409,'stale_context')


def _response(request,payload):
    return JSONResponse(jsonable_encoder({**payload,'context_ref':_context_ref(request)}),
        headers={'Cache-Control':'private, no-store'})


def _cursor_arguments(request, query):
    actor = request.state.current_actor
    return {'secret': request.app.state.auth_policy_config['hmac']['secret'],
            'scope': [actor.account_id, actor.session_id, actor.current_library_id, query]}


def _position(request, cursor, query):
    try:
        return decode_social_cursor(cursor, **_cursor_arguments(request, query))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


def _finish_page(request, result, query):
    result['next_cursor'] = encode_social_cursor(
        result.pop('next_after'), **_cursor_arguments(request, query),
    )
    return _response(request,result)


def _limit_actions(request,member):
    actions=allowed_actions_for_request(request,('library.social.read','library.social.manage','library.social.history.read','library.social.taste.read'),
        resource=ResourceScope('account',str(member['account_id'])))
    relation=member['relationship']['allowed_actions']
    for key in ('can_request','can_accept','can_decline','can_cancel','can_unfriend'):
        relation[key]=relation[key] and actions.allows('library.social.manage')
    relation['can_view_profile']=actions.allows('library.social.read')
    relation['can_read_history']=relation['can_read_history'] and actions.allows('library.social.history.read')
    relation['can_compare_taste']=relation['can_compare_taste'] and actions.allows('library.social.taste.read')
    return {key:value for key,value in member.items() if key!='account_id'}


async def _payload(request,keys):
    _require_context(request)
    try:
        payload=await read_bounded_json_object(request)
    except JSONBodyTooLarge:
        raise HTTPException(413,'Friends request is too large.') from None
    if not isinstance(payload,dict) or set(payload)!=set(keys):
        raise HTTPException(400,'Invalid Friends request.')
    return payload


@router.get('/friends')
async def get_friends(request:Request,mode:str='accepted',cursor:str|None=Query(None,max_length=4096),limit:int=Query(50,ge=1,le=100)):
    if mode not in {'accepted','incoming','outgoing'}:
        raise HTTPException(400,'Invalid Friends list.')
    query='members:'+mode
    result=await _call(request,'list_members',mode=mode,after=_position(request,cursor,query),limit=limit)
    profile=await _call(request,'current_profile')
    result['current_user']={key:value for key,value in profile.items() if key!='account_id'}
    allowed=allowed_actions_for_request(request,('library.social.manage','library.social.read'))
    result['allowed_actions']={'can_request':allowed.allows('library.social.manage'),'can_read':True,
        'can_discover_members':allowed.allows('library.social.read')}
    result['members']=[visible for member in result['members'] if allowed_actions_for_request(request,('library.social.read',),resource=ResourceScope('account',str(member['account_id']))).allows('library.social.read')
        and (visible:=_limit_actions(request,member)) is not None]
    return _finish_page(request,result,query)


@router.get('/friends/discover')
async def discover_members(request:Request,q:str=Query('',max_length=100),cursor:str|None=Query(None,max_length=4096),limit:int=Query(50,ge=1,le=100)):
    query='discover:'+q
    result=await _call(request,'list_members',mode='discover',query=q,after=_position(request,cursor,query),limit=limit)
    result['members']=[visible for member in result['members'] if allowed_actions_for_request(request,('library.social.read',),resource=ResourceScope('account',str(member['account_id']))).allows('library.social.read')
        and (visible:=_limit_actions(request,member)) is not None]
    return _finish_page(request,result,query)


@router.get('/friends/notifications')
async def get_notifications(request:Request,cursor:str|None=Query(None,max_length=4096),limit:int=Query(50,ge=1,le=100)):
    query='notifications'
    result=await _call(request,'notifications',after=_position(request,cursor,query),limit=limit)
    result['notifications']=[notice for notice in result['notifications'] if allowed_actions_for_request(
        request,('library.social.read',),resource=ResourceScope('account',str(notice['sender_account_id']))
    ).allows('library.social.read')]
    for notice in result['notifications']:
        actions=allowed_actions_for_request(request,('library.social.manage',),resource=ResourceScope('account',str(notice['sender_account_id'])))
        notice['actionable']=notice['actionable'] and actions.allows('library.social.manage')
        notice.pop('sender_account_id')
    return _finish_page(request,result,query)


@router.post('/friends/notifications/{notification_id}/read')
async def mark_notification_read(request:Request,notification_id:int):
    _require_context(request)
    return _response(request,await _call(request,'mark_notification_read',notification_id=notification_id))


@router.get('/friends/{account_ref}')
async def get_friend_profile(request:Request,account_ref:str):
    account_id=await _call(request,'resolve_account_ref',account_ref=account_ref)
    await require_action('library.social.read',resource=ResourceScope('account',str(account_id)))(request)
    result=await _call(request,'profile',target_account_id=account_id)
    return _response(request,_limit_actions(request,result))


@router.post('/friends/requests')
async def request_friend(request:Request):
    payload=await _payload(request,{'target_account_ref'})
    target=await _call(request,'resolve_account_ref',account_ref=payload['target_account_ref'])
    await require_action('library.social.manage',resource=ResourceScope('account',str(target)),refresh_actor=True)(request)
    result=await _call(request,'transition',target_account_id=target,action='request')
    return _response(request,_limit_actions(request,{'account_id':target,'relationship':result})['relationship'])


@router.post('/friends/{account_ref}/{action}')
async def change_friend(request:Request,account_ref:str,action:str):
    if action not in {'accept','decline','cancel','unfriend'}:
        raise HTTPException(404,'Friend action not found.')
    account_id=await _call(request,'resolve_account_ref',account_ref=account_ref)
    payload=await _payload(request,{'expected_revision'})
    await require_action('library.social.manage',resource=ResourceScope('account',str(account_id)),refresh_actor=True)(request)
    result=await _call(request,'transition',target_account_id=account_id,action=action,expected_revision=payload['expected_revision'])
    return _response(request,_limit_actions(request,{'account_id':account_id,'relationship':result})['relationship'])


@router.get('/friends/{account_ref}/taste')
async def compare_friend_taste(request:Request,account_ref:str,kind:str='tracks',cursor:str|None=Query(None,max_length=4096),limit:int=Query(50,ge=1,le=100)):
    account_id=await _call(request,'resolve_account_ref',account_ref=account_ref)
    await require_action('library.social.taste.read',resource=ResourceScope('account',str(account_id)))(request)
    query='taste:'+account_ref+':'+kind
    result=await _call(request,'compare_taste',target_account_id=account_id,kind=kind,after=_position(request,cursor,query),limit=limit)
    result['rows']=[row for row in result['rows'] if allowed_actions_for_request(
        request,('library.social.taste.read',),resource=ResourceScope('track' if kind=='tracks' else 'album',str(row['resource_id']))
    ).allows('library.social.taste.read')]
    return _finish_page(request,result,query)


@router.get('/admin/friends-policy')
async def get_friends_policy(request:Request):
    return _response(request,await _call(request,'policy'))


@router.put('/admin/friends-policy')
async def put_friends_policy(request:Request):
    payload=await _payload(request,{'auto_friend'})
    if type(payload['auto_friend']) is not bool:
        raise HTTPException(400,'auto_friend must be a boolean.')
    return _response(request,await _call(request,'policy',auto_friend=payload['auto_friend']))
