"""Short current-player leases. No listen history or remote player control."""
from contextlib import nullcontext
from dataclasses import replace
from datetime import timedelta
from uuid import UUID, uuid4
import hmac
import re

from music_app.services.auth_tokens import issue_opaque_token, hash_opaque_token
from music_app.services.home_activity import ActivityScope, HomeActivityError
from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
from music_app.services.friends_postgres import authorized_friend_read
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import current_library_transaction, require_private_action
from music_app.services.private_native_targets import allows
from music_app.services.private_album_artwork import album_artwork_url
from music_app.services.subject_home_taste import project_subject_taste
from music_app.services import playlist_creation_sources_postgres as inventory

LEASE = timedelta(seconds=15)
MIN_REFRESH = timedelta(seconds=2)
_INVENTORY_REF = re.compile(r'inventory-track:([1-9][0-9]{0,18}):([1-9][0-9]{0,18})\Z')


class PresenceError(ValueError):
    def __init__(self,code='invalid_command',status_code=422):
        self.code,self.status_code=code,status_code
        super().__init__(code)


def _sequence(payload):
    value=payload.get('sequence')
    if type(value) is not int or not 0<value<2**53:raise PresenceError()


def parse_presence_source(payload):
    if not isinstance(payload,dict) or set(payload)!={'track_ref','player_ref','sequence'}:raise PresenceError()
    _sequence(payload)
    if not isinstance(payload['track_ref'],str) or not _INVENTORY_REF.fullmatch(payload['track_ref']):raise PresenceError()
    if any(int(value)>2**63-1 for value in _INVENTORY_REF.fullmatch(payload['track_ref']).groups()):raise PresenceError()
    try:
        if not isinstance(payload['player_ref'],str) or str(UUID(payload['player_ref']))!=payload['player_ref']:raise ValueError()
    except ValueError:raise PresenceError() from None
    return dict(payload)


def parse_presence_update(payload):
    if not isinstance(payload,dict) or set(payload)!={'presence_ref','sequence','state'}:raise PresenceError()
    _sequence(payload)
    if not isinstance(payload['state'],str) or payload['state'] not in {'playing','paused','stopped'}:raise PresenceError()
    try:
        if not isinstance(payload['presence_ref'],str) or len(payload['presence_ref'])!=43:raise ValueError()
        hash_opaque_token(payload['presence_ref'])
    except ValueError:raise PresenceError() from None
    return dict(payload)


class LiveActivityPostgres:
    def __init__(self,config,*,connect=None,clock=None):
        self.config=config
        self.url=str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        self.connect,self.clock=connect,clock

    @staticmethod
    def _fingerprint(connection,account_id,session_id,library_id,now):
        # Migration 0096 invalidates on intervening authority transitions, even
        # if the same grant values are subsequently restored.
        return HomeActivityPostgresRepository._authority(connection,ActivityScope(account_id,session_id,library_id),now)

    def _track(self,connection,context,track_id,constraints):
        if type(track_id) is not int or track_id<1:raise PresenceError('item_unavailable',404)
        resource=ResourceScope('track',str(track_id))
        for action in ('library.browse.read','library.media.read'):
            require_private_action(context,action,resource=resource,constraints=constraints)
        rows=inventory.inventory_rows(connection,context.library_id,[track_id],config=self.config)
        if track_id not in rows or rows[track_id]['availability']!='local':raise PresenceError('item_unavailable',404)
        return rows[track_id]

    def source(self,context,payload,*,constraints=None):
        command=parse_presence_source(payload)
        with current_library_transaction(self.url,context,constraints=constraints,connect=self.connect,clock=self.clock) as (con,live,now):
            current=con.execute('select * from app.current_playback_presence where account_id=%s and library_id=%s for update',
                (live.actor.account_id,live.library_id)).fetchone()
            if current:
                same=current['session_id']==live.actor.session_id and str(current['player_ref'])==command['player_ref']
                if not same and current['expires_at']>now:raise PresenceError('publisher_busy',409)
                if same and command['sequence']<=current['last_sequence']:raise PresenceError('stale_sequence',409)
            library_id,track_id=map(int,_INVENTORY_REF.fullmatch(command['track_ref']).groups())
            if library_id!=live.library_id:raise PresenceError('item_unavailable',404)
            self._track(con,live,track_id,constraints)
            issued=issue_opaque_token()
            fingerprint=self._fingerprint(con,live.actor.account_id,live.actor.session_id,live.library_id,now)
            con.execute('''insert into app.current_playback_presence
                (account_id,library_id,session_id,player_ref,token_digest,occurrence_ref,track_id,last_sequence,state,authority_fingerprint,observed_at,expires_at)
                values(%s,%s,%s,%s,%s,%s,%s,%s,'ready',%s,%s,%s)
                on conflict(account_id,library_id) do update set session_id=excluded.session_id,player_ref=excluded.player_ref,
                token_digest=excluded.token_digest,occurrence_ref=excluded.occurrence_ref,track_id=excluded.track_id,
                last_sequence=excluded.last_sequence,state=excluded.state,authority_fingerprint=excluded.authority_fingerprint,
                observed_at=excluded.observed_at,expires_at=excluded.expires_at''',
                (live.actor.account_id,live.library_id,live.actor.session_id,command['player_ref'],issued.digest,uuid4(),track_id,command['sequence'],fingerprint,now,now+LEASE))
            return {'presence_ref':issued.raw,'expires_at':(now+LEASE).isoformat()}

    def update(self,context,payload,*,constraints=None):
        command=parse_presence_update(payload)
        with current_library_transaction(self.url,context,constraints=constraints,connect=self.connect,clock=self.clock) as (con,live,now):
            row=con.execute('select * from app.current_playback_presence where account_id=%s and library_id=%s for update',
                (live.actor.account_id,live.library_id)).fetchone()
            if (row is None or row['session_id']!=live.actor.session_id
                    or not hmac.compare_digest(bytes(row['token_digest']),hash_opaque_token(command['presence_ref']))):
                raise PresenceError('source_unavailable',404)
            if command['sequence']<=row['last_sequence']:raise PresenceError('stale_sequence',409)
            if row['expires_at']<=now or row['state']=='invalidated':raise PresenceError('source_expired',410)
            if command['state']=='playing':
                if row['state']=='playing' and now-row['observed_at']<MIN_REFRESH:raise PresenceError('refresh_too_soon',429)
                self._track(con,live,row['track_id'],constraints)
            fingerprint=self._fingerprint(con,live.actor.account_id,live.actor.session_id,live.library_id,now)
            con.execute('''update app.current_playback_presence set state=%s,last_sequence=%s,observed_at=%s,expires_at=%s,
                authority_fingerprint=%s where account_id=%s and library_id=%s''',
                (command['state'],command['sequence'],now,now+LEASE,fingerprint,live.actor.account_id,live.library_id))
            return {'state':command['state'],'expires_at':(now+LEASE).isoformat()}

    def read(self,context,*,subject_ref=None,constraints=None):
        if subject_ref is not None:
            try:
                if not isinstance(subject_ref,str) or str(UUID(subject_ref))!=subject_ref:raise ValueError()
            except ValueError:raise PresenceError() from None
        # Resolve public identity before ordered account locks, with no facts read.
        from music_app.services.postgres_connections import pooled_connection
        with (self.connect or pooled_connection)(self.url) as con:
            target=con.execute('select account_id from app.social_profiles where account_ref=%s',(subject_ref,)).fetchone() if subject_ref else None
        subject=context.actor.account_id if subject_ref is None else target['account_id'] if target else None
        if subject is None or (subject_ref is not None and subject==context.actor.account_id):raise PresenceError('activity_denied',403)
        with current_library_transaction(self.url,context,constraints=constraints,connect=self.connect,clock=self.clock,
                target_account_id=subject,read_only=True) as (con,live,now):
            friend=subject!=live.actor.account_id
            scoped=replace(live,target_account_id=subject) if friend else live
            action='library.social.history.read' if friend else 'library.browse.read'
            require_private_action(scoped,action,resource=ResourceScope('account',str(subject)),constraints=constraints)
            guard=authorized_friend_read(con,account_id=live.actor.account_id,library_id=live.library_id,target_account_id=subject) if friend else nullcontext()
            with guard:
                row=con.execute('''select * from app.current_playback_presence where account_id=%s and library_id=%s
                    and state='playing' and expires_at>greatest(%s,clock_timestamp())''',(subject,live.library_id,now)).fetchone()
                if row is None or row['track_id'] is None:return None
                try:fingerprint=self._fingerprint(con,subject,row['session_id'],live.library_id,now)
                except HomeActivityError:return None
                if fingerprint!=row['authority_fingerprint']:return None
                # Account SHARE locks already exclude the publisher. Lock the
                # track before reading its labels/parents, without taking a
                # presence row lock that would invert catalog-delete FK order.
                resources=con.execute('select album_id,artist_id from library.local_tracks where library_id=%s and id=%s for share',
                    (live.library_id,row['track_id'])).fetchone()
                if resources is None:return None
                track=inventory.inventory_rows(con,live.library_id,[row['track_id']],config=self.config).get(row['track_id'])
                if not track or track['availability']!='local':return None
                identities=[('track',row['track_id']),('album',resources['album_id']),('artist',resources['artist_id'])]
                if not all(allows(scoped,action,ResourceScope(kind,str(identity)),constraints) for kind,identity in identities if identity):return None
                ref='playing_'+str(row['occurrence_ref'])
                origin={'audience':'friend' if friend else 'own','subject_ref':subject_ref}
                taste=project_subject_taste(con,live,origin,{ref:{'kind':'track','id':row['track_id']}},constraints=constraints).get(ref,{})
                projected={'id':ref,'kind':'track','title':track['title'],'artist':track['artist'],'album_title':track['album_title'],
                    'duration_seconds':track['duration_seconds'],'availability':'local','source_readable':True,'source_label':'Now playing',
                    'listen_count':None,'last_listened_at':None,'artwork_url':album_artwork_url(live,resources['album_id'],constraints=constraints),
                    **taste,'allowed_actions':{'can_view_details':False,'can_resolve_native_play':False,'can_resolve_native_details':False,'can_select_for_playlist':False}}
                # A catalog mutation may have invalidated this observation
                # before we acquired the track lock. Recheck after projection,
                # without reversing catalog -> presence mutation lock order.
                valid=con.execute('''select 1 from app.current_playback_presence
                    where account_id=%s and library_id=%s and session_id=%s and occurrence_ref=%s
                      and token_digest=%s and track_id=%s and state='playing'
                      and expires_at>greatest(%s,clock_timestamp())''',
                    (subject,live.library_id,row['session_id'],row['occurrence_ref'],row['token_digest'],row['track_id'],now)).fetchone()
                if valid is None:return None
                return {'subject_ref':subject_ref,'occurrence_ref':str(row['occurrence_ref']),'observed_at':row['observed_at'].isoformat(),
                    'expires_at':row['expires_at'].isoformat(),'state':'playing','row':projected}
