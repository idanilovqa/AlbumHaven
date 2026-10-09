"""Durable same-server relationships. Friendship never conveys media authority."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any
from uuid import UUID
import hashlib
import json

from music_app.services.admin_authority import ADMIN_LIBRARY_AUTHORITY_SQL, lock_admin_accounts
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session, RecentAuthenticationRequired
from music_app.services.postgres_connections import pooled_connection
from music_app.services.track_preferences_postgres import load_track_preferences_on_connection


class FriendScopeError(PermissionError):
    """The selected account is outside current Social authority."""


class FriendConflictError(ValueError):
    """The relationship changed or this actor cannot make that transition."""


_ELIGIBLE_SQL = """
select a.id as account_id,p.account_ref::text,a.display_name,a.username_display
from app.accounts a join app.social_profiles p on p.account_id=a.id
join library.library_memberships m on m.account_id=a.id and m.library_id=%(library_id)s
where a.id=any(%(accounts)s) and a.is_active and a.disabled_at is null
  and exists (select 1 from app.capabilities c where c.account_id=a.id
    and c.capability_key='capability.social' and c.revoked_at is null
    and ((c.scope_kind='library' and c.scope_id=%(library_id)s)
      or (c.scope_kind='global' and c.scope_id is null)))
"""
_PAIR_SQL = """select * from app.friend_connections
where library_id=%(library_id)s and low_account_id=%(low)s and high_account_id=%(high)s"""


def _scope(account_id, library_id, target_account_id=None):
    values = (account_id,library_id) if target_account_id is None else (account_id,library_id,target_account_id)
    if any(type(value) is not int or value < 1 for value in values):
        raise FriendScopeError("Social scope is unavailable.")
    if target_account_id == account_id:
        raise FriendScopeError("Select another member.")
    accounts = sorted({account_id,target_account_id} - {None})
    return {"account_id":account_id,"library_id":library_id,"accounts":accounts,
            "target_account_id":target_account_id,"low":accounts[0],"high":accounts[-1]}


def _authorize(connection, params):
    rows = connection.execute(_ELIGIBLE_SQL,params).fetchall()
    if {row['account_id'] for row in rows} != set(params['accounts']):
        raise FriendScopeError("Social scope is unavailable.")
    return {row['account_id']:dict(row) for row in rows}


def _session(connection, account_id, actor_session_id):
    try:
        lock_current_actor_session(connection, actor_account_id=account_id,
            actor_session_id=actor_session_id, clock=lambda: datetime.now(timezone.utc))
    except RecentAuthenticationRequired:
        raise FriendScopeError('The current session is unavailable.') from None


def _admin_authority(connection, account_id, library_id):
    authority=connection.execute(f"""select actor.id from app.accounts actor
        join library.libraries locked_library on locked_library.id=%s
        where actor.id=%s and actor.is_active and actor.disabled_at is null
          and {ADMIN_LIBRARY_AUTHORITY_SQL}""",(library_id,account_id)).fetchone()
    if not authority:
        raise FriendScopeError('Administrator authority is required.')


def _relation(row, account_id):
    state = row['state'] if row else 'none'
    incoming = state == 'pending' and row['requester_account_id'] != account_id
    return {"state":state,"direction":('incoming' if incoming else 'outgoing') if state=='pending' else None,
            "revision":row['revision'] if row else 0,
            "origin":row['origin'] if row else None,
            "allowed_actions":{"can_request":state in {'none','removed','declined','cancelled'},
                "can_accept":incoming,"can_decline":incoming,
                "can_cancel":state=='pending' and not incoming,"can_unfriend":state=='accepted',
                "can_read_history":state=='accepted',"can_compare_taste":state=='accepted'}}


@contextmanager
def authorized_friend_read(connection, *, account_id: int, library_id: int, target_account_id: int):
    """Guard a consumer's SQL on this connection and transaction, never cache it.

    Hold account and relationship locks through the consumer query and recheck
    current Social authority before releasing the read. Cross-account consumers
    must also enforce their own action/resource/deployment/client policy.
    """
    params = _scope(account_id,library_id,target_account_id)
    connection.execute("select id from app.accounts where id=any(%s) order by id for share",
                       (params['accounts'],)).fetchall()
    connection.execute("""select id from library.library_memberships
        where account_id=any(%(accounts)s) and library_id=%(library_id)s order by id for share""",params).fetchall()
    connection.execute("""select id from app.capabilities where account_id=any(%(accounts)s)
        and capability_key='capability.social' and revoked_at is null
        and ((scope_kind='library' and scope_id=%(library_id)s) or (scope_kind='global' and scope_id is null))
        order by id for share""",params).fetchall()
    profiles = _authorize(connection,params)
    row = connection.execute(_PAIR_SQL+' for share',params).fetchone()
    if not row or row['state'] != 'accepted':
        raise FriendScopeError("Friendship is required.")
    yield {**profiles[target_account_id], "relationship_revision": row["revision"]}
    _authorize(connection,params)


def load_friend_taste(connection, *, account_id, library_id, target_account_id, kind, resource_ids):
    """Read comparable facts for exact canonical IDs on the guarded connection.

    The content revision can invalidate frozen comparison facts after a change.
    It is not a replacement for live relationship, session or resource authority.
    """
    if kind not in {'tracks', 'albums'} or not isinstance(resource_ids, (list, tuple)):
        raise ValueError('Invalid comparison resources.')
    if len(resource_ids) > 1000 or any(type(value) is not int or value < 1 for value in resource_ids):
        raise ValueError('Invalid comparison resources.')
    ids = sorted(set(resource_ids))
    params = _scope(account_id, library_id, target_account_id)
    params['resource_ids'] = ids
    items = {}
    with authorized_friend_read(connection, account_id=account_id, library_id=library_id,
                                target_account_id=target_account_id):
        if kind == 'tracks':
            tracks = connection.execute("""select t.id,t.track_key from library.local_tracks t
                where t.library_id=%(library_id)s and t.id=any(%(resource_ids)s)
                  and exists(select 1 from library.local_track_files f where f.track_id=t.id and f.scan_cache_stale is false)
                order by t.id""", params).fetchall()
            refs = [row['track_key'] for row in tracks]
            own = load_track_preferences_on_connection(connection, refs, account_id=account_id, library_id=library_id)
            peer = load_track_preferences_on_connection(connection, refs, account_id=target_account_id, library_id=library_id)
            for row in tracks:
                facts = {}
                for name, lookup in (('own', own), ('friend', peer)):
                    taste = lookup.get(row['track_key'], {})
                    valid = taste.get('track_id') == row['id']
                    facts[name + '_rating'] = taste.get('rating') if valid else None
                    facts[name + '_love_tier'] = taste.get('love_tier') if valid else None
                    facts[name + '_taste_state'] = 'available' if valid else 'unavailable'
                items[row['id']] = facts
        else:
            rows = connection.execute("""select a.id,own.rating as own_rating,peer.rating as friend_rating
                from library.local_albums a
                left join app.album_ratings own on own.library_id=a.library_id and own.album_key=a.album_key and own.account_id=%(account_id)s
                left join app.album_ratings peer on peer.library_id=a.library_id and peer.album_key=a.album_key and peer.account_id=%(target_account_id)s
                where a.library_id=%(library_id)s and a.id=any(%(resource_ids)s)
                  and exists(select 1 from library.local_tracks t join library.local_track_files f on f.track_id=t.id
                    where t.album_id=a.id and t.library_id=a.library_id and f.scan_cache_stale is false)
                order by a.id""", params).fetchall()
            items = {row['id']: {'own_rating': row['own_rating'], 'friend_rating': row['friend_rating'],
                     'own_favorite': None, 'friend_favorite': None,
                     'own_taste_state': 'available', 'friend_taste_state': 'available'} for row in rows}
    revision = hashlib.sha256(json.dumps(
        {'kind': kind, 'resource_ids': ids, 'items': items}, sort_keys=True, separators=(',', ':'),
    ).encode()).hexdigest()
    return {'items': items, 'revision': revision}


def read_friend_taste_page(connection, *, account_id,library_id,target_account_id,kind='tracks',after=0,limit=50):
    """Enumerate one bounded canonical taste page on the supplied transaction."""
    if kind not in {'tracks','albums'} or type(after) is not int or after<0 or type(limit) is not int or not 1<=limit<=100:
        raise ValueError('Invalid taste page.')
    params=_scope(account_id,library_id,target_account_id)
    params.update(after=after,limit=limit+1)
    with authorized_friend_read(connection,account_id=account_id,library_id=library_id,target_account_id=target_account_id):
        if kind=='tracks':
            rows=connection.execute("""select t.id as resource_id,t.track_key,t.title,
                  a.title as album_title,coalesce(artist.name,'') as artist_name
                from library.local_tracks t
                left join library.local_albums a on a.id=t.album_id and a.library_id=t.library_id
                left join library.local_artists artist on artist.id=t.artist_id and artist.library_id=t.library_id
                where t.library_id=%(library_id)s and t.id>%(after)s
                  and exists (select 1 from library.local_track_files f
                    where f.track_id=t.id and f.scan_cache_stale is false)
                  and exists (select 1 from app.track_preferences p
                    where p.library_id=t.library_id and p.account_id=any(%(accounts)s)
                      and (p.track_key=t.track_key or exists (
                        select 1 from library.local_track_files f where f.track_id=t.id
                          and f.scan_cache_stale is false and f.private_path=p.track_key)))
                order by t.id limit %(limit)s""",params).fetchall()
        else:
            rows=connection.execute("""select a.id as resource_id,a.title,artist.name as artist_name,
                  own.rating as own_rating,peer.rating as friend_rating
                from library.local_albums a
                left join library.local_artists artist on artist.id=a.artist_id and artist.library_id=a.library_id
                left join app.album_ratings own on own.library_id=a.library_id and own.album_key=a.album_key and own.account_id=%(account_id)s
                left join app.album_ratings peer on peer.library_id=a.library_id and peer.album_key=a.album_key and peer.account_id=%(target_account_id)s
                where a.library_id=%(library_id)s and a.id>%(after)s
                  and (own.rating is not null or peer.rating is not null)
                  and exists (select 1 from library.local_tracks t join library.local_track_files f on f.track_id=t.id
                    where t.album_id=a.id and t.library_id=a.library_id and f.scan_cache_stale is false)
                order by a.id limit %(limit)s""",params).fetchall()
        taste = load_friend_taste(connection, account_id=account_id, library_id=library_id,
            target_account_id=target_account_id, kind=kind,
            resource_ids=[row['resource_id'] for row in rows[:limit]])
        projected = []
        for row in rows[:limit]:
            facts = taste['items'].get(row['resource_id'])
            if facts is None:
                continue
            if not any(facts[name + '_rating'] is not None
                       or facts.get(name + '_love_tier') in {'loved', 'obsessed'}
                       for name in ('own', 'friend')):
                continue
            projected.append({**{key:value for key,value in row.items() if key!='track_key'}, **facts})
    return {'kind':kind,'rows':projected,
            'next_after':rows[limit-1]['resource_id'] if len(rows)>limit else None,
            'allowed_actions':{'can_edit_friend_taste':False}}


class PostgresFriendsStore:
    def __init__(self, config: Mapping[str,object], *, connect: Callable[[str],Any] | None=None):
        self._url = str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        if not self._url:
            raise RuntimeError('ALBUM_HAVEN_APP_DATABASE_URL is required for Friends.')
        self._connect = connect or pooled_connection

    def resolve_account_ref(self, *, account_id,library_id,account_ref):
        params=_scope(account_id,library_id)
        try:
            reference=str(UUID(str(account_ref)))
        except (ValueError,TypeError,AttributeError):
            raise FriendScopeError('Social scope is unavailable.') from None
        with self._connect(self._url) as connection:
            _authorize(connection,params)
            row=connection.execute('select account_id from app.social_profiles where account_ref=%s::uuid',(reference,)).fetchone()
            if not row:
                raise FriendScopeError('Social scope is unavailable.')
            params=_scope(account_id,library_id,row['account_id'])
            _authorize(connection,params)
            return row['account_id']

    def list_members(self, *, account_id, library_id, mode='accepted', query='', after=0, limit=50):
        params=_scope(account_id,library_id)
        if mode not in {'accepted','incoming','outgoing','discover'} or not isinstance(query,str) or len(query)>100:
            raise ValueError('Invalid Friends query.')
        if type(after) is not int or after<0 or type(limit) is not int or not 1<=limit<=100:
            raise ValueError('Invalid Friends page.')
        params.update(after=after,limit=limit+1,query='%'+query.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%')
        with self._connect(self._url) as connection:
            _authorize(connection,params)
            rows=connection.execute("""
              select a.id as account_id,p.account_ref::text,a.display_name,a.username_display,
                     f.state,f.requester_account_id,f.origin,f.revision
              from app.accounts a join app.social_profiles p on p.account_id=a.id
              join library.library_memberships m on m.account_id=a.id and m.library_id=%(library_id)s
              left join app.friend_connections f on f.library_id=m.library_id
                and f.low_account_id=least(a.id,%(account_id)s)
                and f.high_account_id=greatest(a.id,%(account_id)s)
              where a.id<>%(account_id)s and a.id>%(after)s and a.is_active and a.disabled_at is null
                and (a.display_name ilike %(query)s or a.username_display ilike %(query)s)
                and exists (select 1 from app.capabilities c where c.account_id=a.id
                  and c.capability_key='capability.social' and c.revoked_at is null
                  and ((c.scope_kind='library' and c.scope_id=m.library_id)
                    or (c.scope_kind='global' and c.scope_id is null)))
                and ( %(mode)s='discover' or ( %(mode)s='accepted' and f.state='accepted')
                  or (f.state='pending' and ((%(mode)s='incoming' and f.requester_account_id<>%(account_id)s)
                    or (%(mode)s='outgoing' and f.requester_account_id=%(account_id)s))))
              order by a.id limit %(limit)s
            """,{**params,'mode':mode}).fetchall()
            _authorize(connection,params)
        members=[{**{key:row[key] for key in ('account_id','account_ref','display_name','username_display')},
                  'relationship':_relation(row if row['state'] else None,account_id)} for row in rows[:limit]]
        return {'members':members,'next_after':members[-1]['account_id'] if len(rows)>limit else None}

    def current_profile(self, *, account_id, library_id, actor_session_id):
        params=_scope(account_id,library_id)
        with self._connect(self._url) as connection:
            _session(connection,account_id,actor_session_id)
            profiles=_authorize(connection,params)
            _session(connection,account_id,actor_session_id)
            return profiles[account_id]

    def profile(self, *, account_id, library_id, target_account_id):
        params=_scope(account_id,library_id,target_account_id)
        with self._connect(self._url) as connection:
            profiles=_authorize(connection,params)
            row=connection.execute(_PAIR_SQL,params).fetchone()
            _authorize(connection,params)
            return {**profiles[target_account_id],'relationship':_relation(row,account_id)}

    def transition(self, *, account_id, library_id, target_account_id, action, actor_session_id, expected_revision=None):
        params=_scope(account_id,library_id,target_account_id)
        if action not in {'request','accept','decline','cancel','unfriend'}:
            raise ValueError('Invalid Friends action.')
        if action!='request' and (type(expected_revision) is not int or expected_revision<1):
            raise ValueError('A relationship revision is required.')
        with self._connect(self._url) as connection:
            lock_admin_accounts(connection,account_id,target_account_id)
            _authorize(connection,params)
            # The same lock orders automatic inserts against explicit requests.
            connection.execute("select pg_advisory_xact_lock(hashtextextended('album-haven-social:' || %s::text,0))",(library_id,))
            row=connection.execute(_PAIR_SQL+' for update',params).fetchone()
            _session(connection,account_id,actor_session_id)
            _authorize(connection,params)
            if action=='request' and row and row['state']=='pending' and row['requester_account_id']==account_id:
                return _relation(row,account_id)
            if action=='request':
                if row and row['state'] in {'accepted','pending'}:
                    raise FriendConflictError('Relationship already exists.')
                state='pending'
            else:
                if not row or row['revision'] != expected_revision:
                    raise FriendConflictError('Relationship changed. Reload and retry.')
                incoming=row['state']=='pending' and row['requester_account_id']!=account_id
                valid=(action in {'accept','decline'} and incoming
                    or action=='cancel' and row['state']=='pending' and not incoming
                    or action=='unfriend' and row['state']=='accepted')
                if not valid:
                    raise FriendConflictError('Relationship transition is not permitted.')
                state={'accept':'accepted','decline':'declined','cancel':'cancelled','unfriend':'removed'}[action]
            params.update(state=state,requester=account_id if action=='request' else row['requester_account_id'],
                          origin='request' if action=='request' else row['origin'])
            changed=connection.execute("""
              insert into app.friend_connections(library_id,low_account_id,high_account_id,requester_account_id,state,origin)
              values (%(library_id)s,%(low)s,%(high)s,%(requester)s,%(state)s,%(origin)s)
              on conflict (library_id,low_account_id,high_account_id) do update
              set state=excluded.state,requester_account_id=excluded.requester_account_id,origin=excluded.origin,
                  revision=app.friend_connections.revision+1,updated_at=now()
              returning *
            """,params).fetchone()
            # Obsolete request notices stop being actionable in this transaction.
            connection.execute("""update app.friend_notifications set read_at=coalesce(read_at,now())
              where library_id=%(library_id)s and low_account_id=%(low)s and high_account_id=%(high)s
                and kind='friend_request'""",params)
            if action in {'request','accept'}:
                connection.execute("""insert into app.friend_notifications(
                  library_id,low_account_id,high_account_id,connection_revision,recipient_account_id,sender_account_id,kind)
                  values (%(library_id)s,%(low)s,%(high)s,%(revision)s,%(target_account_id)s,%(account_id)s,%(kind)s)
                  on conflict do nothing""",{**params,'revision':changed['revision'],
                    'kind':'friend_request' if action=='request' else 'friend_accepted'})
            _authorize(connection,params)
            _session(connection,account_id,actor_session_id)
            return _relation(changed,account_id)

    def notifications(self, *, account_id,library_id,after=0,limit=50):
        params=_scope(account_id,library_id)
        if type(after) is not int or after<0 or type(limit) is not int or not 1<=limit<=100:
            raise ValueError('Invalid notification page.')
        with self._connect(self._url) as connection:
            _authorize(connection,params)
            rows=connection.execute("""select n.id,n.kind,n.sender_account_id,p.account_ref::text as sender_account_ref,a.display_name,
                    n.connection_revision,n.created_at,n.read_at,
                    (n.kind='friend_request' and f.state='pending'
                     and f.revision=n.connection_revision and f.requester_account_id=n.sender_account_id) as actionable
                from app.friend_notifications n join app.accounts a on a.id=n.sender_account_id
                join app.social_profiles p on p.account_id=a.id
                join library.library_memberships m on m.account_id=a.id and m.library_id=n.library_id
                join app.friend_connections f on f.library_id=n.library_id
                  and f.low_account_id=n.low_account_id and f.high_account_id=n.high_account_id
                where n.library_id=%(library_id)s and n.recipient_account_id=%(account_id)s
                  and (%(after)s=0 or n.id<%(after)s) and a.is_active and a.disabled_at is null
                  and exists(select 1 from app.capabilities c where c.account_id=a.id
                    and c.capability_key='capability.social' and c.revoked_at is null
                    and ((c.scope_kind='library' and c.scope_id=n.library_id)
                      or (c.scope_kind='global' and c.scope_id is null)))
                order by n.id desc limit %(limit)s""",{**params,'after':after,'limit':limit+1}).fetchall()
            _authorize(connection,params)
        notices=[dict(row) for row in rows[:limit]]
        return {'notifications':notices,'next_after':notices[-1]['id'] if len(rows)>limit else None}

    def mark_notification_read(self, *, account_id,library_id,notification_id,actor_session_id):
        params=_scope(account_id,library_id)
        if type(notification_id) is not int or notification_id<1:
            raise ValueError('Invalid notification.')
        with self._connect(self._url) as connection:
            lock_admin_accounts(connection,account_id,account_id)
            _authorize(connection,params)
            _session(connection,account_id,actor_session_id)
            row=connection.execute("""update app.friend_notifications set read_at=coalesce(read_at,now())
                where id=%s and recipient_account_id=%s and library_id=%s returning id""",
                (notification_id,account_id,library_id)).fetchone()
            if not row:
                raise FriendScopeError('Notification is unavailable.')
            _authorize(connection,params)
            _session(connection,account_id,actor_session_id)
        return {'id':row['id'],'read':True}

    def policy(self, *, account_id,library_id,actor_session_id,auto_friend=None):
        params=_scope(account_id,library_id)
        if auto_friend is not None and type(auto_friend) is not bool:
            raise ValueError('auto_friend must be a boolean.')
        with self._connect(self._url) as connection:
            lock_admin_accounts(connection,account_id,account_id)
            connection.execute("select pg_advisory_xact_lock(hashtextextended('album-haven-social:' || %s::text,0))",(library_id,))
            _session(connection,account_id,actor_session_id)
            _admin_authority(connection,account_id,library_id)
            if auto_friend is not None:
                connection.execute("""insert into app.friend_policies(library_id,auto_friend,updated_by_account_id)
                    values (%s,%s,%s) on conflict(library_id) do update
                    set auto_friend=excluded.auto_friend,updated_by_account_id=excluded.updated_by_account_id,updated_at=now()""",
                    (library_id,auto_friend,account_id))
                if auto_friend:
                    connection.execute('select app.sync_automatic_friends(%s)',(library_id,))
            row=connection.execute('select auto_friend from app.friend_policies where library_id=%s',(library_id,)).fetchone()
            _session(connection,account_id,actor_session_id)
            _admin_authority(connection,account_id,library_id)
        return {'auto_friend':bool(row and row['auto_friend'])}

    def compare_taste(self, *, account_id,library_id,target_account_id,actor_session_id,kind='tracks',after=0,limit=50):
        with self._connect(self._url) as connection:
            with authorized_friend_read(connection, account_id=account_id, library_id=library_id,
                                        target_account_id=target_account_id):
                _session(connection, account_id, actor_session_id)
                result = read_friend_taste_page(connection, account_id=account_id, library_id=library_id,
                    target_account_id=target_account_id, kind=kind, after=after, limit=limit)
                _session(connection, account_id, actor_session_id)
                return result
