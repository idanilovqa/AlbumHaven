"""Receipt-scoped native targets and action projections for Home and comparison."""
from dataclasses import replace
from datetime import datetime, timezone
import re
from uuid import UUID

from music_app.services.private_album_artwork import album_artwork_url
from music_app.services.allowed_actions import AllowedActions
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.home_activity import ActivityScope, ActivityQuery, ComparisonQuery, HomeActivityError
from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import current_library_transaction
from music_app.services.private_native_targets import PrivateNativeTargets, NativeTargetError, allows
from music_app.services import playlist_creation_sources_postgres as inventory


_ROW=re.compile(r'activity_[a-f0-9]{64}\Z')


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


class ActivityNativeTargets:
    def __init__(self,config,*,connect=None,clock=None,media_resolver=None):
        self.config=config
        self.url=str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        self.connect,self.clock=connect,clock
        self.targets=PrivateNativeTargets(config,media_resolver=media_resolver)

    def _export(self,connection,context,origin,query,row_refs,constraints):
        subject=None
        if origin['audience']!='own':
            row=connection.execute('select account_id from app.social_profiles where account_ref=%s',
                (origin['subject_ref'],)).fetchone()
            if row is None:raise NativeTargetError('source_unavailable',403)
            subject=row['account_id']
        scope=ActivityScope(context.actor.account_id,context.actor.session_id,context.library_id,subject,origin['audience'])
        def allowed(kind,identity):
            target=replace(context,target_account_id=scope.source_account_id)
            actions=(scope.read_action,'library.social.taste.read') if scope.audience=='comparison' else (scope.read_action,)
            granted=all(allows(target,action,ResourceScope(kind,str(identity)),constraints) for action in actions)
            return AllowedActions(actions if granted else ())
        allowed.scope_wide=not callable(constraints)
        return HomeActivityPostgresRepository(self.config).read_native_selection(connection,scope=scope,
            query=query,row_refs=row_refs,allowed_actions_for_resource=allowed)

    def resolve(self,context,*,origin,row_ref,intent,constraints=None):
        origin,query=normalize_native_origin(origin)
        if not isinstance(row_ref,str) or not _ROW.fullmatch(row_ref) or not isinstance(intent,str) or intent not in {'play','details'}:
            raise NativeTargetError('invalid_command',422)
        with current_library_transaction(self.url,context,constraints=constraints,connect=self.connect,clock=self.clock,read_only=True) as (con,live,now):
            rows=self._export(con,live,origin,query,[row_ref],constraints)
            resource=rows[0]['canonical_resource']
            if resource is None:raise NativeTargetError()
            kind,identity=resource['kind'],resource['id']
            if kind=='track':
                target=self.targets.resolve(con,live,identity,intent=intent,constraints=constraints)
            elif intent=='details' and kind=='album':
                target=self.targets.resolve_album(con,live,identity,constraints=constraints)
            elif intent=='details' and kind=='artist':
                scoped=ResourceScope('artist',str(identity))
                if not allows(live,'library.browse.read',scoped,constraints):raise NativeTargetError('forbidden',403)
                row=con.execute('select artist_key from library.local_artists where id=%s and library_id=%s',
                    (identity,live.library_id)).fetchone()
                if row is None or not row['artist_key']:raise NativeTargetError()
                target={'artist_ref':row['artist_key'],'allowed_actions':{'can_view_details':True}}
            else:raise NativeTargetError()
            lock_current_actor_session(con,actor_account_id=live.actor.account_id,actor_session_id=live.actor.session_id,
                clock=self.clock or (lambda:datetime.now(timezone.utc)))
            return {'origin':origin,'row_ref':row_ref,'intent':intent,'native_target':target}

    def project(self,context,*,origin,rows,constraints=None):
        origin,query=normalize_native_origin(origin)
        if not rows:return rows
        refs=[row['id'] for row in rows]
        if len(refs)>100:raise NativeTargetError('invalid_command',422)
        with current_library_transaction(self.url,context,constraints=constraints,connect=self.connect,clock=self.clock,read_only=True) as (con,live,now):
            exported=self._export(con,live,origin,query,refs,constraints)
            mappings={row['row_ref']:row['canonical_resource'] for row in exported}
            track_ids=[resource['id'] for resource in mappings.values() if resource and resource['kind']=='track'
                and allows(live,'library.browse.read',ResourceScope('track',str(resource['id'])),constraints)]
            tracks=inventory.inventory_rows(con,live.library_id,track_ids,config=self.config)
            create=allows(live,'library.playlists.create',None,constraints)
            items=allows(live,'library.playlists.items.manage',None,constraints)
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
                projected={**row,'allowed_actions':actions,'inventory_track_ref':inventory_ref,
                    'artwork_url':album_artwork_url(live,album_id,constraints=constraints)}
                if actions['can_resolve_native_details']:
                    target_kind='artist' if resource['kind']=='artist' else 'album'
                    projected[target_kind+'_target']={'kind':target_kind,'ref':row['id'],'origin':origin,
                        'allowed_actions':{'can_view_details':True}}
                output.append(projected)
            lock_current_actor_session(con,actor_account_id=live.actor.account_id,actor_session_id=live.actor.session_id,
                clock=self.clock or (lambda:datetime.now(timezone.utc)))
            return output
