"""Listener Search adapter over the existing authorized Home track receipt.

HTTP admission is deliberately separate. Initial all-time capture inherits
Home's full-history work and coverage; only subsequent pages have a 100-row
page bound. Custom resource constraints retain Home's full receipt recheck.
"""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
import re

from music_app.services.allowed_actions import AllowedActions
from music_app.services.home_activity import ActivityQuery, ActivityScope, HomeActivityError, PAGE_SIZE, read_home_activity
from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
from music_app.services.policy import PolicyContext, ResourceScope
from music_app.services.private_library_authority import require_private_action, PrivateLibraryAuthorityError
from music_app.services.private_listener_search_cursor import (
    encode_listener_cursor, decode_listener_cursor, encode_listener_search_token,
    decode_listener_search_token, MAX_SAFE_INTEGER, LIVE_VERSION,
)
from music_app.services.private_search_contract import (
    PrivateSearchError, normalize_listener_history_query, normalize_listener_search_query,
    ListenerHistoryCriteria, ListenerSearchCriteria, ListenerSearchRequest,
)
from music_app.services.private_listener_search_predicate import ListenerLovePredicate
from music_app.services.activity_native_targets import ActivityNativeTargets
from music_app.services.private_native_targets import NativeTargetError
from music_app.services.private_search_subject import (
    BROWSE, HISTORY, ListenerHistoryExpectation, PostgresListenerSearchSubjects,
)
from music_app.services.social_cursors import _cipher

CONTRACT_VERSION = 'listener-history-v1'
_CONTEXT = re.compile(r'[a-f0-9]{64}', re.ASCII)


def _restart():
    return PrivateSearchError('search_cursor_restart_required', 409)


@contextmanager
def _live_errors():
    try:
        yield
    except PrivateSearchError:
        raise
    except HomeActivityError as error:
        if error.status_code == 410:
            raise _restart() from None
        if error.status_code in {401,403}:
            raise PrivateSearchError('private_search_forbidden',403) from None
        raise PrivateSearchError('private_search_unavailable',503) from None
    except NativeTargetError as error:
        raise PrivateSearchError(error.code,error.status_code) from None
    except PrivateLibraryAuthorityError:
        raise PrivateSearchError('private_search_forbidden',403) from None
    except Exception:
        raise PrivateSearchError('private_search_unavailable',503) from None


def _safe_count(value):
    if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
        raise PrivateSearchError('private_search_unavailable',503)
    return value


def _entry_hints(entries):
    result=[]
    for entry in entries:
        resource=entry['canonical_resource']
        if resource is not None and (resource.get('kind')!='track' or type(resource.get('id')) is not int
                or not 0<resource['id']<=9223372036854775807):
            raise PrivateSearchError('private_search_unavailable',503)
        result.append((entry['row_ref'],resource['id'] if resource else None))
    return tuple(result)


def _criteria_from_token(token):
    scope=token['scope']
    return ListenerSearchCriteria(scope['username'],tuple(scope['love_include']),tuple(scope['love_exclude']))


def normalize_listener_native_command(row_refs, *, operation, intent=None, target_kind=None):
    if (type(row_refs) not in {list,tuple} or not 1<=len(row_refs)<=100
            or any(type(ref) is not str or not re.fullmatch(r'activity_[a-f0-9]{64}',ref) for ref in row_refs)
            or len(set(row_refs))!=len(row_refs)
            or type(operation) is not str or operation not in {'bindings','single','batch'}):
        raise PrivateSearchError('invalid_command',422)
    if (operation=='single' and (len(row_refs)!=1 or type(intent) is not str or intent not in {'metadata','play','details'})
            or operation=='batch' and (type(intent) is not str or intent not in {'metadata','play'})
            or operation=='bindings' and intent is not None
            or target_kind is not None and (type(target_kind) is not str or operation!='single' or intent!='details'
                                           or target_kind not in {'album','artist'})):
        raise PrivateSearchError('invalid_command',422)
    return tuple(row_refs)


class PostgresListenerSearch:
    def __init__(self, config, *, connect=None, clock=None):
        self.config, self.connect = config, connect
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.subjects = PostgresListenerSearchSubjects(config, connect=connect, clock=clock)

    @staticmethod
    def _decode_live(context,context_ref,cursor_secret,token,*,purpose,request=None):
        if (not isinstance(context,PolicyContext)
                or not isinstance(context_ref,str) or not _CONTEXT.fullmatch(context_ref)):
            raise PrivateSearchError()
        if context.target_account_id is not None or not context.actor.is_authenticated:
            raise PrivateSearchError('private_search_forbidden',403)
        _cipher(cursor_secret)
        try:
            decoded=decode_listener_search_token(token,secret=cursor_secret,purpose=purpose)
        except ValueError:
            raise PrivateSearchError() from None
        expected={'actor_account_id':context.actor.account_id,'actor_session_id':context.actor.session_id,
                  'library_id':context.library_id,'context_ref':context_ref}
        if request is not None:
            expected.update(username=request.criteria.username,love_include=list(request.criteria.love_include),
                            love_exclude=list(request.criteria.love_exclude),page_size=request.limit)
        if decoded and any(decoded['scope'][key]!=value for key,value in expected.items()):
            raise _restart()
        return decoded

    @staticmethod
    def _subject_scope(context,context_ref,criteria,subject,limit):
        return {'actor_account_id':context.actor.account_id,'actor_session_id':context.actor.session_id,
                'library_id':context.library_id,'context_ref':context_ref,'username':criteria.username,
                'account_ref':subject.account_ref,'audience':'own' if subject.account_id==context.actor.account_id else 'friend',
                'relationship_revision':subject.relationship_revision,
                'love_include':list(criteria.love_include),'love_exclude':list(criteria.love_exclude),'page_size':limit}

    def _assert_subject(self,context,criteria,subject,token):
        expected=self._subject_scope(context,token['scope']['context_ref'],criteria,subject,token['scope']['page_size'])
        if any(token['scope'][key]!=value for key,value in expected.items()):
            raise _restart()

    def _history_receipt(self,connection,context,subject,criteria,snapshot_ref,*,constraints):
        own=subject.account_id==context.actor.account_id
        scope=ActivityScope(context.actor.account_id,context.actor.session_id,context.library_id,
                            None if own else subject.account_id,'own' if own else 'friend')
        def allowed(kind,identity):
            try:
                require_private_action(context,subject.history_action,resource=ResourceScope(kind,str(identity)),constraints=constraints)
            except PrivateLibraryAuthorityError:
                return AllowedActions(())
            return AllowedActions((subject.history_action,))
        allowed.scope_wide=not callable(constraints)
        listener=ListenerHistoryExpectation(criteria.username,subject.account_ref,subject.relationship_revision)
        return HomeActivityPostgresRepository(self.config,connect=self.connect).listener_search_receipt(
            connection,scope=scope,snapshot_ref=snapshot_ref,listener=listener,
            allowed_actions_for_resource=allowed,now=self.clock())

    @staticmethod
    def _predicate(connection,context,subject,criteria,constraints,cursor_secret,receipt,expected=None):
        if not criteria.filtered:
            return None,{'love_revision':None,'taste_policy_digest':None}
        predicate=ListenerLovePredicate(connection,live_context=context,subject=subject,criteria=criteria,
            constraints=constraints,cursor_secret=cursor_secret,receipt=receipt)
        evidence=predicate.authorize()
        if expected is not None and any(expected[key]!=value for key,value in evidence.items()):
            raise _restart()
        return predicate,evidence

    def read_live(self,context,*,request,context_ref,cursor_secret,constraints=None):
        with _live_errors():
            if (type(request) is not ListenerSearchRequest or request.presentation!='tracks'
                    or type(request.limit) is not int or not 1<=request.limit<=100
                    or normalize_listener_search_query(request.query)!=request.criteria):
                raise PrivateSearchError()
            continuation=self._decode_live(context,context_ref,cursor_secret,request.cursor,purpose='cursor',request=request)
            criteria=request.criteria
            if continuation:
                snapshot_ref=continuation['snapshot_ref']
            else:
                raw=self.read(context,query=f'@{criteria.username} :tracks listened:all',context_ref=context_ref,
                    cursor_secret=cursor_secret,constraints=constraints)
                snapshot_ref=raw['native_origin']['snapshot_ref']
            with self.subjects.authorized(context,criteria=ListenerHistoryCriteria(criteria.username),constraints=constraints) as (con,live,subject):
                if continuation:self._assert_subject(live,criteria,subject,continuation)
                with self._history_receipt(con,live,subject,criteria,snapshot_ref,constraints=constraints) as receipt:
                    history=receipt.summary
                    total=_safe_count(history['total_tracks'])
                    _safe_count(history['total_listens'])
                    predicate,evidence=self._predicate(con,live,subject,criteria,constraints,cursor_secret,receipt,
                                                       continuation['scope'] if continuation else None)
                    position=continuation['position'] if continuation else {'after_ordinal':0,'matched_before':0}
                    after,matched=position['after_ordinal'],position['matched_before']
                    if continuation and after>=total:raise _restart()
                    candidates=receipt.window(after)
                    if ([entry['ordinal'] for entry in candidates]!=list(range(after+1,min(after+100,total)+1))):
                        raise PrivateSearchError('private_search_unavailable',503)
                    matches=predicate.matches(candidates) if predicate else {entry['row_ref']:True for entry in candidates}
                    selected,examined=[],0
                    for entry in candidates:
                        examined+=1
                        after=entry['ordinal']
                        if matches[entry['row_ref']]:
                            row=entry['payload']
                            if row.get('kind')!='track' or row.get('availability') not in {'local','unresolved'}:
                                raise PrivateSearchError('private_search_unavailable',503)
                            _safe_count(row.get('listen_count'))
                            selected.append({**{key:row.get(key) for key in ('id','kind','title','artist','album_title',
                                'listen_count','last_listened_at','duration_seconds','source_label','availability')},
                                'source_readable':True})
                            if len(selected)==request.limit:break
                    matched=_safe_count(matched+len(selected))
                    has_more=after<total
                    scope={**self._subject_scope(live,context_ref,criteria,subject,request.limit),**evidence}
                    next_cursor=encode_listener_search_token(snapshot_ref,secret=cursor_secret,scope=scope,purpose='cursor',
                        position={'after_ordinal':after,'matched_before':matched}) if has_more else None
                    result_token=encode_listener_search_token(snapshot_ref,secret=cursor_secret,scope=scope,purpose='result')
                    payload={'status':'ready','private_search':True,'contract_version':LIVE_VERSION,'context_ref':context_ref,
                        'query':request.query,'criteria':criteria.as_payload(),'presentation':'tracks','listener':subject.listener_payload(),
                        'tracks':selected,'page':{'limit':request.limit,'returned_count':len(selected),'candidates_examined':examined,
                            'has_more':has_more,'next_cursor':next_cursor,'total_matches':total if not predicate else (matched if not has_more else None)},
                        'history':history,'native':{'result_token':result_token}}
                    if predicate:predicate.assert_unchanged(evidence)
            return payload

    def _listener_native_hints(self,context,*,token,row_refs,constraints):
        criteria=_criteria_from_token(token)
        with self.subjects.authorized(context,criteria=ListenerHistoryCriteria(criteria.username),constraints=constraints) as (con,live,subject):
            self._assert_subject(live,criteria,subject,token)
            with self._history_receipt(con,live,subject,criteria,token['snapshot_ref'],constraints=constraints) as receipt:
                hints=_entry_hints(receipt.selection(row_refs))
        return hints

    def _listener_native_command(self,context,*,token,row_refs,operation,intent,target_kind,constraints,cursor_secret,result_token):
        criteria=_criteria_from_token(token)
        native=ActivityNativeTargets(self.config,connect=self.connect,clock=self.clock)
        hints=self._listener_native_hints(context,token=token,row_refs=row_refs,constraints=constraints)
        prelock=None
        try:
            with self.subjects.authorized(context,criteria=ListenerHistoryCriteria(criteria.username),constraints=constraints) as (con,live,subject):
                self._assert_subject(live,criteria,subject,token)
                prelock=native.prelock_listener_on_connection(con,live,row_hints=hints,constraints=constraints)
                with self._history_receipt(con,live,subject,criteria,token['snapshot_ref'],constraints=constraints) as receipt:
                    entries=receipt.selection(row_refs)
                    if _entry_hints(entries)!=hints:raise _restart()
                    predicate,evidence=self._predicate(con,live,subject,criteria,constraints,cursor_secret,receipt,token['scope'])
                    if predicate and not all(predicate.matches(entries).values()):
                        raise PrivateSearchError('private_search_forbidden',403)
                    origin={'audience':token['scope']['audience'],
                            'subject_ref':None if token['scope']['audience']=='own' else subject.account_ref,
                            'kind':'tracks','period':'all','snapshot_ref':token['snapshot_ref']}
                    args={'origin':origin,'prelock':prelock,'constraints':constraints}
                    if operation=='bindings':
                        result=native.project_listener_on_connection(con,live,row_refs=row_refs,**args)
                        bindings=[]
                        for binding in result['bindings']:
                            current={key:binding[key] for key in ('row_ref','allowed_actions','inventory_track_ref','artwork_url')}
                            for key in ('album_target','artist_target'):
                                if key in binding:
                                    target=binding[key]
                                    current[key]={'kind':target['kind'],'row_ref':target['ref'],'identity_ref':target['identity_ref'],
                                                  'allowed_actions':{'can_view_details':True}}
                            bindings.append(current)
                        data={'bindings':bindings}
                        contract='listener-search-native-bindings-v1'
                    elif operation=='single':
                        result=native.resolve_listener_on_connection(con,live,row_ref=row_refs[0],intent=intent,target_kind=target_kind,**args)
                        data={key:result[key] for key in ('row_ref','intent','native_target')}
                        contract='listener-search-native-v1'
                    else:
                        result=native.resolve_listener_batch_on_connection(con,live,row_refs=row_refs,intent=intent,**args)
                        data={'intent':intent,'items':result['items']}
                        contract='listener-search-native-batch-v1'
                    payload={'status':'ready','contract_version':contract,'context_ref':token['scope']['context_ref'],
                             'result_token':result_token,'data':data}
                    if _entry_hints(receipt.selection(row_refs))!=hints:raise _restart()
                    prelock.assert_unchanged(con,live,constraints)
                    if predicate:predicate.assert_unchanged(evidence)
            return payload
        finally:
            if prelock is not None:prelock.active=False

    def _live_native(self,context,*,result_token,row_refs,context_ref,cursor_secret,constraints,operation,intent=None,target_kind=None):
        with _live_errors():
            refs=normalize_listener_native_command(row_refs,operation=operation,intent=intent,target_kind=target_kind)
            token=self._decode_live(context,context_ref,cursor_secret,result_token,purpose='result')
            payload=self._listener_native_command(context,token=token,row_refs=refs,operation=operation,intent=intent,
                target_kind=target_kind,constraints=constraints,cursor_secret=cursor_secret,result_token=result_token)
            return payload

    def project_live_bindings(self,context,*,result_token,row_refs,context_ref,cursor_secret,constraints=None):
        return self._live_native(context,result_token=result_token,row_refs=row_refs,context_ref=context_ref,
            cursor_secret=cursor_secret,constraints=constraints,operation='bindings')

    def resolve_live_target(self,context,*,result_token,row_ref,intent,context_ref,cursor_secret,target_kind=None,constraints=None):
        return self._live_native(context,result_token=result_token,row_refs=[row_ref],intent=intent,target_kind=target_kind,
            context_ref=context_ref,cursor_secret=cursor_secret,constraints=constraints,operation='single')

    def resolve_live_targets(self,context,*,result_token,row_refs,intent,context_ref,cursor_secret,constraints=None):
        return self._live_native(context,result_token=result_token,row_refs=row_refs,intent=intent,
            context_ref=context_ref,cursor_secret=cursor_secret,constraints=constraints,operation='batch')

    def read(self, context, *, query, context_ref, cursor_secret, cursor=None, constraints=None):
        """Only the normalized handle selects a subject; no client ID override."""
        criteria = normalize_listener_history_query(query)
        if (not isinstance(context, PolicyContext) or not isinstance(context_ref, str)
                or not _CONTEXT.fullmatch(context_ref)):
            raise PrivateSearchError()
        # Check configuration before materializing a receipt, even for page 1.
        try:
            _cipher(cursor_secret)
        except (RuntimeError, UnicodeError):
            raise PrivateSearchError('private_search_unavailable', 503) from None
        try:
            continuation = decode_listener_cursor(cursor, secret=cursor_secret)
        except ValueError:
            raise PrivateSearchError() from None
        actor = context.actor
        request_scope = {
            'actor_account_id': actor.account_id, 'actor_session_id': actor.session_id,
            'library_id': context.library_id, 'context_ref': context_ref, 'username': criteria.username,
        }
        if continuation and any(continuation['scope'][key] != value
                for key, value in request_scope.items()):
            raise _restart()
        # This connection closes before Home acquires any capture/session lock.
        # Its identity is a hint, revalidated inside the Home subject guard.
        target = self.subjects.lookup_hint(context, criteria=criteria, constraints=constraints)
        own = target == actor.account_id
        audience, action = ('own', BROWSE) if own else ('friend', HISTORY)
        if continuation and continuation['scope']['audience'] != audience:
            raise _restart()
        scoped = replace(context, target_account_id=None if own else target)

        def allowed(kind, reference):
            try:
                require_private_action(scoped, action,
                    resource=ResourceScope(kind, str(reference)), constraints=constraints)
            except PrivateLibraryAuthorityError:
                return AllowedActions(())
            return AllowedActions((action,))

        allowed.scope_wide = not callable(constraints)
        expected = continuation['scope'] if continuation else None
        listener = ListenerHistoryExpectation(criteria.username,
            expected['account_ref'] if expected else None,
            expected['relationship_revision'] if expected else None)
        activity_query = ActivityQuery(kind='tracks', period='all',
            snapshot_ref=continuation['snapshot_ref'] if continuation else None,
            page=continuation['page'] if continuation else None)
        try:
            result = read_home_activity(self.config, actor=actor, query=activity_query,
                subject_account_id=None if own else target, allowed_actions_for_resource=allowed,
                now=self.clock(), listener=listener,
                repository=HomeActivityPostgresRepository(self.config, connect=self.connect))
        except HomeActivityError as error:
            if error.status_code in {401, 403}:
                raise PrivateSearchError('private_search_forbidden', 403) from None
            if error.status_code == 410:
                raise _restart() from None
            if error.status_code == 503:
                raise PrivateSearchError('private_search_unavailable', 503) from None
            raise PrivateSearchError() from None
        data, current_listener = result['data'], result['listener']
        page = data['pagination']['page']
        total = data['pagination']['total_rows']
        has_more = page * PAGE_SIZE < total
        scope = {**request_scope, 'account_ref': current_listener['account_ref'], 'audience': audience,
                 'relationship_revision': result['listener_relationship_revision']}
        next_cursor = encode_listener_cursor(data['snapshot_ref'], page + 1,
            secret=cursor_secret, scope=scope) if has_more else None
        # Origin is a receipt coordinate, never media, taste or write authority.
        # Native consumers must independently reauthorize through their owner.
        origin = {'audience': audience, 'subject_ref': None if own else current_listener['account_ref'],
                  'kind': 'tracks', 'period': 'all', 'snapshot_ref': data['snapshot_ref']}
        return {
            'status': result['status'], 'private_search': True, 'contract_version': CONTRACT_VERSION,
            'context_ref': context_ref, 'query': query.strip(), 'criteria': criteria.as_payload(),
            'presentation': 'tracks', 'listener': current_listener, 'tracks': data['rows'],
            'page': {'limit': PAGE_SIZE, 'number': page, 'returned_count': len(data['rows']),
                     'total_rows': total, 'has_more': has_more, 'next_cursor': next_cursor},
            'history': {key: data[key] for key in ('snapshot_ref', 'expires_at', 'total_listens',
                        'period_label', 'range_label', 'coverage')},
            'native_origin': origin,
        }
