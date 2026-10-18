"""Receipt-scoped native targets for Home, comparison and listener Search.

Listener entry points are server-owned service seams only. HTTP admission stays
with its existing owners; the raw listener-history-v1 reader is unchanged.
"""
from dataclasses import replace
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
import re
import hashlib
import hmac
from uuid import UUID

from music_app.services.friends_postgres import authorized_friend_read
from music_app.services.postgres_connections import pooled_connection
from music_app.services.private_album_artwork import album_artwork_url
from music_app.services.allowed_actions import AllowedActions
from music_app.services.auth_tokens import hash_opaque_token
from music_app.services.subject_home_taste import (project_subject_taste, subject_album_overlay,
    readable_taste, UNKNOWN_ALBUM, UNKNOWN_TRACK)
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.home_activity import ActivityScope, ActivityQuery, ComparisonQuery, HomeActivityError
from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
from music_app.services.policy import PolicyContext, ResourceScope
from music_app.services.private_library_authority import current_library_transaction
from music_app.services.private_native_targets import PrivateNativeTargets, NativeTargetError, allows
from music_app.services import playlist_creation_sources_postgres as inventory


_ROW=re.compile(r'activity_[a-f0-9]{64}\Z')


def _listener_actor_native_context(listener_context):
    if not isinstance(listener_context,PolicyContext):
        raise NativeTargetError('private_search_unavailable',503)
    return replace(listener_context,target_account_id=None)


def _listener_row_hints(rows):
    hints=[]
    for row in rows:
        resource=row['canonical_resource']
        if resource is not None and (resource.get('kind')!='track'
                or type(resource.get('id')) is not int or resource['id']<=0):
            raise NativeTargetError('private_search_unavailable',503)
        hints.append((row['row_ref'],resource['id'] if resource else None))
    return tuple(hints)


def _listener_admissions(context,hints,constraints):
    return tuple((ref,identity is not None and allows(context,'library.browse.read',
        ResourceScope('track',str(identity)),constraints)) for ref,identity in hints)


def _listener_closure(connection,library_id,identities):
    if not identities:
        return ((),(),(),(),())
    tracks=connection.execute("""select id,album_id,artist_id from library.local_tracks
        where library_id=%s and id=any(%s::bigint[]) order by id""",(library_id,list(identities))).fetchall()
    present=[row['id'] for row in tracks]
    files=connection.execute("""select id,track_id,library_root_id from library.local_track_files
        where track_id=any(%s::bigint[]) order by id""",(present,)).fetchall()
    albums=sorted({row['album_id'] for row in tracks if row['album_id'] is not None})
    artists=sorted({row['artist_id'] for row in tracks if row['artist_id'] is not None})
    roots=sorted({row['library_root_id'] for row in files if row['library_root_id'] is not None})
    locked_albums=tuple(row['id'] for row in connection.execute("""select id from library.local_albums
        where library_id=%s and id=any(%s::bigint[]) order by id""",(library_id,albums)).fetchall())
    locked_artists=tuple(row['id'] for row in connection.execute("""select id from library.local_artists
        where library_id=%s and id=any(%s::bigint[]) order by id""",(library_id,artists)).fetchall())
    locked_roots=tuple(row['id'] for row in connection.execute("""select id from library.library_roots
        where library_id=%s and id=any(%s::bigint[]) order by id""",(library_id,roots)).fetchall())
    if (locked_albums!=tuple(albums) or locked_artists!=tuple(artists) or locked_roots!=tuple(roots)):
        # An out-of-library dependency was not frozen by the inventory owner.
        # Never discover and lock such a target after receipt acquisition.
        raise NativeTargetError('search_cursor_restart_required',409)
    return (tuple((row['id'],row['album_id'],row['artist_id']) for row in tracks),
            tuple((row['id'],row['track_id'],row['library_root_id']) for row in files),
            locked_albums,locked_artists,locked_roots)


class _ListenerNativePolicy:
    """Observe native decisions and recompute them before publication."""
    def __init__(self,constraints):
        self.constraints=constraints
        self.decisions={}
        self.changed=False

    def __call__(self,context):
        from music_app.services.policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints
        effective=self.constraints(context) if callable(self.constraints) else self.constraints
        if effective is not None and not isinstance(effective,PolicyEvaluationConstraints):
            raise NativeTargetError('private_search_unavailable',503)
        if context.target_account_id is None:
            allowed=PolicyEvaluator().evaluate(context,constraints=effective).decision.allowed
            key=(context.action,context.resource)
            old=self.decisions.get(key)
            if old is not None and old[1]!=allowed:self.changed=True
            self.decisions[key]=(context,allowed)
        return effective

    def assert_unchanged(self):
        from music_app.services.policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints
        if self.changed:raise NativeTargetError('search_cursor_restart_required',409)
        for context,expected in tuple(self.decisions.values()):
            current=self.constraints(context) if callable(self.constraints) else self.constraints
            if current is not None and not isinstance(current,PolicyEvaluationConstraints):
                raise NativeTargetError('private_search_unavailable',503)
            if PolicyEvaluator().evaluate(context,constraints=current).decision.allowed!=expected:
                raise NativeTargetError('search_cursor_restart_required',409)


class _ListenerNativePrelock:
    def __init__(self,connection,context,hints,admissions,closure,constraints):
        self.connection,self.context,self.hints=connection,context,hints
        self.admissions,self.closure=admissions,closure
        self.identities=tuple(sorted({identity for (ref,identity),(_,allowed) in zip(hints,admissions) if allowed}))
        self.native_ids=frozenset(row[0] for row in closure[0])
        self.transaction=connection.execute('select txid_current() as id').fetchone()['id']
        self.active=True
        self.policy=_ListenerNativePolicy(constraints)

    def assert_unchanged(self,connection,listener_context,constraints):
        from psycopg.pq import TransactionStatus
        context=_listener_actor_native_context(listener_context)
        if (not self.active or connection is not self.connection or context!=self.context
                or connection.info.transaction_status!=TransactionStatus.INTRANS
                or connection.execute('select txid_current() as id').fetchone()['id']!=self.transaction):
            raise NativeTargetError('private_search_unavailable',503)
        if (_listener_admissions(context,self.hints,constraints)!=self.admissions
                or _listener_closure(connection,context.library_id,self.identities)!=self.closure):
            raise NativeTargetError('search_cursor_restart_required',409)
        self.policy.assert_unchanged()


def canonical_target_identity(secret, kind, identity):
    """Comparable only inside one authorized snapshot; never a resolver token."""
    return kind + "_" + hmac.new(secret, f"native-target:{kind}:{identity}".encode(), hashlib.sha256).hexdigest()


def normalize_native_origin(value):
    if not isinstance(value,dict) or set(value)!={'audience','subject_ref','kind','period','snapshot_ref'}:
        raise NativeTargetError('invalid_command',422)
    if not isinstance(value['audience'],str) or value['audience'] not in {'own','friend','comparison'}:
        raise NativeTargetError('invalid_command',422)
    if value['audience']=='own':
        if value['subject_ref'] is not None:raise NativeTargetError('invalid_command',422)
    else:
        try:
            if not isinstance(value['subject_ref'],str) or str(UUID(value['subject_ref']))!=value['subject_ref']:
                raise ValueError()
        except ValueError:raise NativeTargetError('invalid_command',422) from None
    try:
        cls=ComparisonQuery if value['audience']=='comparison' else ActivityQuery
        query=cls(kind=value['kind'],period=value['period'],snapshot_ref=value['snapshot_ref'])
    except HomeActivityError:raise NativeTargetError('invalid_command',422) from None
    if not query.snapshot_ref:raise NativeTargetError('invalid_command',422)
    return dict(value),query


def normalize_listener_native_origin(value):
    """The bounded listener grammar can only issue own/friend tracks/all receipts."""
    origin,query=normalize_native_origin(value)
    if origin['audience'] not in {'own','friend'} or query.kind!='tracks' or query.period!='all':
        raise NativeTargetError('invalid_command',422)
    return origin,query


def _listener_row_refs(values):
    if (type(values) is not list or not 1<=len(values)<=100
            or any(type(value) is not str or not _ROW.fullmatch(value) for value in values)
            or len(set(values))!=len(values)):
        raise NativeTargetError('invalid_command',422)
    return list(values)


class ActivityNativeTargets:
    def __init__(self,config,*,connect=None,clock=None,media_resolver=None):
        self.config=config
        self.url=str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        self.connect,self.clock=connect,clock
        self.targets=PrivateNativeTargets(config,media_resolver=media_resolver)

    def prelock_listener_on_connection(self,connection,listener_context,*,row_hints,constraints=None):
        from psycopg.pq import TransactionStatus
        context=_listener_actor_native_context(listener_context)
        if (connection.info.transaction_status!=TransactionStatus.INTRANS
                or type(row_hints) is not tuple or not 1<=len(row_hints)<=100
                or any(type(pair) is not tuple or len(pair)!=2 or not isinstance(pair[0],str)
                    or not _ROW.fullmatch(pair[0]) or pair[1] is not None and (
                        type(pair[1]) is not int or not 0<pair[1]<=9223372036854775807) for pair in row_hints)
                or len({pair[0] for pair in row_hints})!=len(row_hints)):
            raise NativeTargetError('private_search_unavailable',503)
        admissions=_listener_admissions(context,row_hints,constraints)
        identities=sorted({identity for (_,identity),(_,allowed) in zip(row_hints,admissions) if allowed})
        # Before any final receipt lock; config=None suppresses probes only here.
        if identities:
            inventory.inventory_rows(connection,context.library_id,identities,lock=True,config=None)
        closure=_listener_closure(connection,context.library_id,identities)
        return _ListenerNativePrelock(connection,context,row_hints,admissions,closure,constraints)

    def _listener_prelocked(self,connection,listener_context,origin,row_refs,prelock,constraints):
        if type(prelock) is not _ListenerNativePrelock:
            raise NativeTargetError('private_search_unavailable',503)
        refs=_listener_row_refs(list(row_refs))
        if tuple(refs)!=tuple(ref for ref,_ in prelock.hints):
            raise NativeTargetError('private_search_unavailable',503)
        prelock.assert_unchanged(connection,listener_context,constraints)
        origin,query=normalize_listener_native_origin(origin)
        context=_listener_actor_native_context(listener_context)
        exported=self._export(connection,context,origin,query,refs,prelock.policy,
            listener_context.target_account_id if origin['audience']!='own' else None)
        if _listener_row_hints(exported)!=prelock.hints:
            raise NativeTargetError('search_cursor_restart_required',409)
        return context,origin,query

    def project_listener_on_connection(self,connection,listener_context,*,origin,row_refs,prelock,constraints=None):
        context,origin,query=self._listener_prelocked(connection,listener_context,origin,row_refs,prelock,constraints)
        projected=self._project_on_connection(connection,context,origin=origin,query=query,
            rows=[{'id':ref} for ref in row_refs],constraints=prelock.policy,subject_taste=False,
            expected_hints=prelock.hints,native_track_ids=prelock.native_ids,
            expected_subject_id=listener_context.target_account_id if origin['audience']!='own' else None)
        prelock.assert_unchanged(connection,listener_context,constraints)
        return {'origin':origin,'bindings':[
            {'row_ref':row['id'],'allowed_actions':row['allowed_actions'],
             'inventory_track_ref':row['inventory_track_ref'],'artwork_url':row['artwork_url'],
             **{key:row[key] for key in ('album_target','artist_target') if key in row}}
            for row in projected]}

    def resolve_listener_on_connection(self,connection,listener_context,*,origin,row_ref,intent,
                                       target_kind=None,prelock,constraints=None):
        if (not isinstance(intent,str) or intent not in {'metadata','play','details'}
                or target_kind is not None and (not isinstance(target_kind,str)
                    or target_kind not in {'album','artist'} or intent!='details')):
            raise NativeTargetError('invalid_command',422)
        context,origin,query=self._listener_prelocked(connection,listener_context,origin,[row_ref],prelock,constraints)
        identity=prelock.hints[0][1]
        if identity is None:raise NativeTargetError()
        if not prelock.admissions[0][1]:raise NativeTargetError('forbidden',403)
        if identity not in prelock.native_ids:raise NativeTargetError()
        result=self._resolve_on_connection(connection,context,origin=origin,query=query,row_ref=row_ref,
            intent=intent,target_kind=target_kind,constraints=prelock.policy,subject_taste=False,
            expected_hints=prelock.hints,
            expected_subject_id=listener_context.target_account_id if origin['audience']!='own' else None)
        prelock.assert_unchanged(connection,listener_context,constraints)
        return result

    def resolve_listener_batch_on_connection(self,connection,listener_context,*,origin,row_refs,intent,
                                             prelock,constraints=None):
        context,origin,_=self._listener_prelocked(connection,listener_context,origin,row_refs,prelock,constraints)
        if not isinstance(intent,str) or intent not in {'metadata','play'}:
            raise NativeTargetError('invalid_command',422)
        identities=sorted(prelock.native_ids)
        resolver=self.targets.resolve_metadata_batch if intent=='metadata' else self.targets.resolve_play_queue
        targets=resolver(connection,context,identities,constraints=prelock.policy) if identities else {}
        items=[{'row_ref':ref,'status':'ready' if identity in targets else 'unavailable',
                'native_target':targets.get(identity)} for ref,identity in prelock.hints]
        prelock.assert_unchanged(connection,listener_context,constraints)
        return {'origin':origin,'intent':intent,'items':items}

    def _subject_hint(self,origin):
        if origin['audience']=='own':return None
        with (self.connect or pooled_connection)(self.url) as connection:
            connection.execute('set transaction read only')
            row=connection.execute('select account_id from app.social_profiles where account_ref=%s',
                (origin['subject_ref'],)).fetchone()
            if row is None or type(row['account_id']) is not int or row['account_id']<1:
                raise NativeTargetError('source_unavailable',403)
            return row['account_id']

    def _subject_binding(self,connection,origin,expected_subject_id):
        if origin['audience']=='own':
            if expected_subject_id is not None:raise NativeTargetError('source_unavailable',403)
            return None
        if type(expected_subject_id) is not int or expected_subject_id<1:
            raise NativeTargetError('source_unavailable',403)
        row=connection.execute("""select account_id from app.social_profiles
            where account_ref=%s and account_id=%s for share""",
            (origin['subject_ref'],expected_subject_id)).fetchone()
        if row is None:raise NativeTargetError('source_unavailable',403)
        return expected_subject_id

    @contextmanager
    def _subject_guard(self,connection,context,origin,expected_subject_id):
        subject=self._subject_binding(connection,origin,expected_subject_id)
        guard=(authorized_friend_read(connection,account_id=context.actor.account_id,
            library_id=context.library_id,target_account_id=subject) if subject is not None else nullcontext())
        with guard:
            yield
            self._subject_binding(connection,origin,expected_subject_id)
            lock_current_actor_session(connection,actor_account_id=context.actor.account_id,
                actor_session_id=context.actor.session_id,clock=self.clock or (lambda:datetime.now(timezone.utc)))

    def _export(self,connection,context,origin,query,row_refs,constraints,expected_subject_id=None):
        subject=self._subject_binding(connection,origin,expected_subject_id)
        scope=ActivityScope(context.actor.account_id,context.actor.session_id,context.library_id,subject,origin['audience'])
        def allowed(kind,identity):
            target=replace(context,target_account_id=scope.source_account_id)
            actions=(scope.read_action,'library.social.taste.read') if scope.audience=='comparison' else (scope.read_action,)
            granted=all(allows(target,action,ResourceScope(kind,str(identity)),constraints) for action in actions)
            browse=allows(replace(context,target_account_id=None),'library.browse.read',ResourceScope(kind,str(identity)),constraints)
            return AllowedActions(actions + (('library.browse.read',) if browse else ())) if granted else AllowedActions(())
        allowed.scope_wide=(not callable(constraints)
            or type(constraints) is _ListenerNativePolicy and not callable(constraints.constraints))
        return HomeActivityPostgresRepository(self.config).read_native_selection(connection,scope=scope,
            query=query,row_refs=row_refs,allowed_actions_for_resource=allowed)

    def resolve(self,context,*,origin,row_ref,intent,target_kind=None,constraints=None):
        origin,query=normalize_native_origin(origin)
        return self._resolve(context,origin=origin,query=query,row_ref=row_ref,intent=intent,
            target_kind=target_kind,constraints=constraints,subject_taste=True)

    def resolve_listener(self,context,*,origin,row_ref,intent,target_kind=None,constraints=None):
        """Reauthorize one listener row through native owners without peer taste."""
        origin,query=normalize_listener_native_origin(origin)
        return self._resolve(context,origin=origin,query=query,row_ref=row_ref,intent=intent,
            target_kind=target_kind,constraints=constraints,subject_taste=False)

    def _resolve(self,context,*,origin,query,row_ref,intent,target_kind,constraints,subject_taste):
        if not isinstance(row_ref,str) or not _ROW.fullmatch(row_ref) or not isinstance(intent,str) or intent not in {'play','details','metadata'}:
            raise NativeTargetError('invalid_command',422)
        if target_kind is not None and (intent != "details" or not isinstance(target_kind,str) or target_kind not in {"album","artist"}):
            raise NativeTargetError("invalid_command",422)
        subject=self._subject_hint(origin)
        with current_library_transaction(self.url,context,constraints=constraints,connect=self.connect,clock=self.clock,
                read_only=True,target_account_id=subject) as (con,live,now):
            with self._subject_guard(con,live,origin,subject):
                result=self._resolve_on_connection(con,live,origin=origin,query=query,row_ref=row_ref,intent=intent,
                    target_kind=target_kind,constraints=constraints,subject_taste=subject_taste,expected_subject_id=subject)
        return result

    def _resolve_on_connection(self,con,live,*,origin,query,row_ref,intent,target_kind,constraints,subject_taste,expected_hints=None,expected_subject_id=None):
        rows=self._export(con,live,origin,query,[row_ref],constraints,expected_subject_id)
        if expected_hints is not None and _listener_row_hints(rows) != expected_hints:
            raise NativeTargetError('search_cursor_restart_required',409)
        resource=rows[0]['canonical_resource']
        if resource is None:raise NativeTargetError()
        kind,identity=resource['kind'],resource['id']
        if target_kind is not None:
            if kind=='track':
                if not allows(live,'library.browse.read',ResourceScope('track',str(identity)),constraints):
                    raise NativeTargetError('forbidden',403)
                parents=con.execute('select album_id,artist_id from library.local_tracks where id=%s and library_id=%s',
                    (identity,live.library_id)).fetchone()
                identity=parents.get(target_kind+'_id') if parents else None
                if identity is None:raise NativeTargetError()
                kind=target_kind
            elif kind!=target_kind:raise NativeTargetError()
        if kind=='track':
            target=self.targets.resolve(con,live,identity,intent=intent,constraints=constraints)
        elif intent=='details' and kind=='album':
            target=self.targets.resolve_album(con,live,identity,constraints=constraints)
        elif intent=='details' and kind=='artist':
            scoped=ResourceScope('artist',str(identity))
            if not allows(live,'library.browse.read',scoped,constraints):raise NativeTargetError('forbidden',403)
            row=con.execute('select artist_key,name from library.local_artists where id=%s and library_id=%s',
                (identity,live.library_id)).fetchone()
            if row is None or not row['artist_key']:raise NativeTargetError()
            target={'artist_ref':row['artist_key'],'title':row['name'],'allowed_actions':{'can_view_details':True}}
        else:raise NativeTargetError()
        if intent=='details' and 'album_ref' in target:
            album=con.execute('select a.id,a.title,ar.name as artist from library.local_albums a left join library.local_artists ar on ar.id=a.artist_id and ar.library_id=a.library_id where a.library_id=%s and a.album_key=%s',
                (live.library_id,target['album_ref'])).fetchone()
            if album is None:raise NativeTargetError()
            target={**target,'title':album['title'],'artist':album['artist']}
            if subject_taste and origin['audience']!='own':
                target['subject_taste']=subject_album_overlay(con,live,origin,album['id'],constraints=constraints,expected_subject_id=expected_subject_id)
        lock_current_actor_session(con,actor_account_id=live.actor.account_id,actor_session_id=live.actor.session_id,
            clock=self.clock or (lambda:datetime.now(timezone.utc)))
        final=self._export(con,live,origin,query,[row_ref],constraints,expected_subject_id)
        if final!=rows:raise NativeTargetError('source_unavailable',403)
        if not allows(live,'library.browse.read',ResourceScope(kind,str(identity)),constraints):
            raise NativeTargetError('forbidden',403)
        if intent=='play' and not allows(live,'library.media.read',ResourceScope(kind,str(identity)),constraints):
            raise NativeTargetError('forbidden',403)
        if 'subject_taste' in target:
            overlay=target['subject_taste']
            if not readable_taste(live,expected_subject_id,'album',album['id'],constraints):
                overlay.update(UNKNOWN_ALBUM)
            overlay['tracks']=[item for item in overlay['tracks'] if readable_taste(live,expected_subject_id,
                'track',int(item['inventory_track_ref'].rsplit(':',1)[1]),constraints)]
        return {'origin':origin,'row_ref':row_ref,'intent':intent,'native_target':target}

    def project(self,context,*,origin,rows,constraints=None):
        origin,query=normalize_native_origin(origin)
        return self._project(context,origin=origin,query=query,rows=rows,
            constraints=constraints,subject_taste=True)

    def project_listener(self,context,*,origin,row_refs,constraints=None):
        """Return separate native bindings, never reader rows or subject taste.

        Row references are receipt coordinates, not catalog IDs. No caller
        metadata or actions enter this projection; the existing receipt and
        native owners derive every binding under one authority transaction.
        """
        origin,query=normalize_listener_native_origin(origin)
        refs=_listener_row_refs(row_refs)
        projected=self._project(context,origin=origin,query=query,
            rows=[{'id':ref} for ref in refs],constraints=constraints,subject_taste=False)
        return {'origin':origin,'bindings':[
            {'row_ref':row['id'],'allowed_actions':row['allowed_actions'],
             'inventory_track_ref':row['inventory_track_ref'],'artwork_url':row['artwork_url'],
             **{key:row[key] for key in ('album_target','artist_target') if key in row}}
            for row in projected]}

    def _project(self,context,*,origin,query,rows,constraints,subject_taste):
        if not rows:return rows
        refs=_listener_row_refs([row['id'] for row in rows])
        subject=self._subject_hint(origin)
        with current_library_transaction(self.url,context,constraints=constraints,connect=self.connect,clock=self.clock,
                read_only=True,target_account_id=subject) as (con,live,now):
            with self._subject_guard(con,live,origin,subject):
                result=self._project_on_connection(con,live,origin=origin,query=query,rows=rows,
                    constraints=constraints,subject_taste=subject_taste,expected_subject_id=subject)
        return result

    def _project_on_connection(self,con,live,*,origin,query,rows,constraints,subject_taste,expected_hints=None,native_track_ids=None,expected_subject_id=None):
        refs=[row['id'] for row in rows]
        exported=self._export(con,live,origin,query,refs,constraints,expected_subject_id)
        if expected_hints is not None and _listener_row_hints(exported) != expected_hints:
            raise NativeTargetError('search_cursor_restart_required',409)
        mappings={row['row_ref']:row['canonical_resource'] for row in exported}
        admissions={ref:allows(live,'library.browse.read',ResourceScope(resource['kind'],str(resource['id'])),constraints)
            for ref,resource in mappings.items() if resource is not None}
        snapshot=con.execute('select row_secret from app.activity_snapshots where token_digest=%s and account_id=%s and session_id=%s and library_id=%s',
            (hash_opaque_token(query.snapshot_ref),live.actor.account_id,live.actor.session_id,live.library_id)).fetchone()
        if snapshot is None:raise NativeTargetError('source_unavailable',403)
        secret=bytes(snapshot['row_secret'])
        track_ids=[resource['id'] for resource in mappings.values() if resource and resource['kind']=='track'
            and (native_track_ids is None or resource['id'] in native_track_ids)
            and allows(live,'library.browse.read',ResourceScope('track',str(resource['id'])),constraints)]
        tracks=({} if native_track_ids is not None and not track_ids else
                inventory.inventory_rows(con,live.library_id,track_ids,config=self.config))
        parents={row['id']:row for row in con.execute('select id,album_id,artist_id from library.local_tracks where library_id=%s and id=any(%s::bigint[])',
            (live.library_id,track_ids)).fetchall()}
        create=allows(live,'library.playlists.create',None,constraints)
        items=allows(live,'library.playlists.items.manage',None,constraints)
        taste=project_subject_taste(con,live,origin,mappings,constraints=constraints,expected_subject_id=expected_subject_id) if subject_taste and origin['audience']!='comparison' else {}
        output=[]
        for row in rows:
            resource=mappings[row['id']]
            actions={**row.get('allowed_actions',{}),'can_resolve_native_play':False,
                'can_resolve_native_details':False,'can_select_for_playlist':False}
            if resource is None:
                actions['can_select_for_playlist']=create and origin['audience']!='comparison' and query.kind in {'tracks','listens'}
            else:
                kind,identity=resource['kind'],resource['id']
                readable=allows(live,'library.browse.read',ResourceScope(kind,str(identity)),constraints)
                if kind=='track' and identity in tracks and readable:
                    current=tracks[identity]
                    actions['can_resolve_native_play']=current['availability']=='local' and allows(live,'library.media.read',ResourceScope(kind,str(identity)),constraints)
                    album=current['original_album_id']
                    actions['can_resolve_native_details']=album is not None and allows(live,'library.browse.read',ResourceScope('album',str(album)),constraints)
                    actions['can_select_for_playlist']=create or items
                elif kind in {'album','artist'}:
                    actions['can_resolve_native_details']=readable
            inventory_ref=(f"inventory-track:{live.library_id}:{resource['id']}"
                if resource and resource['kind']=='track' and resource['id'] in tracks else None)
            album_id=(resource['id'] if resource and resource['kind']=='album' else
                tracks[resource['id']].get('original_album_id') if resource and resource['kind']=='track' and resource['id'] in tracks else None)
            projected={**row,**taste.get(row['id'],{}),'allowed_actions':actions,'inventory_track_ref':inventory_ref,
                'artwork_url':album_artwork_url(live,album_id,constraints=constraints)}
            detail_ids={}
            if resource and resource['kind']=='track' and resource['id'] in tracks:
                detail_ids={kind:parents.get(resource['id'],{}).get(kind+'_id') for kind in ('album','artist')}
            elif resource and resource['kind'] in {'album','artist'}:
                detail_ids={resource['kind']:resource['id']}
            for kind,identity in detail_ids.items():
                if identity is not None and allows(live,'library.browse.read',ResourceScope(kind,str(identity)),constraints):
                    projected[kind+'_target']={'kind':kind,'ref':row['id'],'origin':origin,
                        'identity_ref':canonical_target_identity(secret,kind,identity),
                        'allowed_actions':{'can_view_details':True}}
            actions['can_resolve_native_details']=any(kind+'_target' in projected for kind in ('album','artist'))
            output.append(projected)
        lock_current_actor_session(con,actor_account_id=live.actor.account_id,actor_session_id=live.actor.session_id,
            clock=self.clock or (lambda:datetime.now(timezone.utc)))
        final=self._export(con,live,origin,query,refs,constraints,expected_subject_id)
        if final!=exported:raise NativeTargetError('source_unavailable',403)
        for projected in output:
            resource=mappings[projected['id']]
            if resource is not None:
                kind,identity=resource['kind'],resource['id']
                if admissions[projected['id']]!=allows(live,'library.browse.read',ResourceScope(kind,str(identity)),constraints):
                    raise NativeTargetError('forbidden',403)
                if projected['id'] in taste and not readable_taste(live,
                        expected_subject_id if origin['audience']!='own' else live.actor.account_id,kind,identity,constraints):
                    projected.update(UNKNOWN_ALBUM if kind=='album' else UNKNOWN_TRACK)
        return output
