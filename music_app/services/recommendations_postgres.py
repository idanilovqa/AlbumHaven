"""Recipient-owned recommendation delivery. Friendship never conveys media access.

The ordinary collection parents/items remain the source of collection membership.
Attribution is private, and writes share their parent/revision transaction.
"""
from contextlib import ExitStack
import json
from uuid import uuid4

from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.friends_postgres import PostgresFriendsStore, authorized_friend_read
from music_app.services.owned_playlists import BROWSE
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import require_private_action
from music_app.services.playlist_creation_sources_postgres import inventory_rows
from music_app.services import playlist_metadata_occurrences as occurrences
from music_app.services.recommendations import (
    RecommendationError, command, attribution_key, person_name, MAX_ITEMS, MAX_RECOMMENDERS,
)


def _ready(connection):
    row = connection.execute("select to_regclass('app.recommendation_attributions') as installed").fetchone()
    if not row or row['installed'] is None:
        raise RecommendationError('recommendations_unavailable', 503)


def load_attributions(connection, context, *, kind, item_refs):
    """Only the recipient gets attribution; never a public/shared DTO decoration."""
    if kind not in ('track', 'album') or len(item_refs) > MAX_ITEMS:
        raise RecommendationError('invalid_query')
    if not item_refs:
        return {}
    field = 'playlist_item_ref' if kind == 'track' else 'top_item_ref'
    rows = connection.execute(f"""select r.{field} as item_ref,r.display_name,
        case when a.is_active and a.disabled_at is null then p.account_ref::text end as account_ref
        from app.recommendation_attributions r
        left join app.accounts a on a.id=r.recommender_account_id
        left join app.social_profiles p on p.account_id=a.id
        where r.recipient_account_id=%s and r.library_id=%s and r.{field}=any(%s::uuid[])
        order by r.created_at,r.ref""", (context.actor.account_id, context.library_id, item_refs)).fetchall()
    result = {}
    for row in rows:
        result.setdefault(str(row['item_ref']), []).append(
            {'display_name': row['display_name'], 'account_ref': row['account_ref']})
    return result


class PostgresRecommendations:
    def __init__(self, config, *, connect=None, clock=None):
        self.owner = PostgresOwnedPlaylistsService(config, connect=connect, clock=clock)
        self.friends = PostgresFriendsStore(config, connect=connect)

    def _account(self, context, ref):
        return self.friends.resolve_account_ref(account_id=context.actor.account_id,
            library_id=context.library_id, account_ref=ref)

    def execute(self, context, payload, *, manual=False, constraints=None):
        value = command(payload, manual=manual)
        if value.library_id is not None and value.library_id != context.library_id:
            raise RecommendationError('source_unavailable', 404)
        owner = self.owner
        target_ref = value.recommender_ref if manual else value.recipient_ref
        target = self._account(context, target_ref) if target_ref else None
        source_owner = None
        if value.source_top_ref is not None or value.source_playlist_ref is not None:
            table = 'app.album_lists' if value.source_top_ref else 'app.playlists'
            source_ref = value.source_top_ref or value.source_playlist_ref
            with owner._connect(owner._url) as lookup:
                hint = lookup.execute(f'select owner_account_id from {table} where ref=%s and library_id=%s',
                    (source_ref, context.library_id)).fetchone()
                source_owner = hint['owner_account_id'] if hint else None
            # Playlist ownership is only a lock-order hint here. A missing old
            # source must not invalidate an already committed delivery receipt.
            if source_owner is None and value.source_top_ref is not None:
                raise RecommendationError('source_unavailable', 404)
        targets = tuple(sorted({account for account in (target, source_owner) if account is not None}))
        with owner._authorized(context, constraints, target_account_ids=targets) as (connection, live, _), ExitStack() as checks:
            _ready(connection)
            owner._require(live, (BROWSE,), constraints)
            def require_command():
                if manual:
                    action = 'library.playlists.create' if value.kind == 'track' else 'library.album_tops.create'
                    require_private_action(live, action, constraints=constraints)
                else:
                    require_private_action(live, 'library.social.manage',
                        resource=ResourceScope('account', str(target)), constraints=constraints)
            require_command()
            if target is not None:
                profile = checks.enter_context(authorized_friend_read(connection, account_id=live.actor.account_id,
                    library_id=live.library_id, target_account_id=target))
                if profile['account_ref'] != target_ref:
                    raise RecommendationError('friend_changed', 409)
            else:
                profile = None
            recipient = live.actor.account_id if manual else target
            prior = connection.execute("""select original_session_id,command_digest,receipt
                from app.recommendation_operations where actor_account_id=%s and library_id=%s
                and request_key=%s""", (live.actor.account_id, live.library_id, value.request_key)).fetchone()
            if prior is not None:
                if prior['original_session_id'] != live.actor.session_id or prior['command_digest'] != value.digest:
                    raise RecommendationError('request_conflict', 409)
                lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                    actor_session_id=live.actor.session_id, clock=owner._clock)
                require_command()
                return prior['receipt']
            source = None
            if value.source_playlist_ref:
                if source_owner is None:
                    raise RecommendationError('source_unavailable', 404)
                source = self._playlist_source(connection, live, value, source_owner, constraints)
            if value.catalog_ref is None and value.source_playlist_ref is None:
                require_private_action(live, BROWSE, resource=ResourceScope(value.kind, str(value.resource_id)), constraints=constraints)
            # Lock inventory before the collection parent, matching ordinary owners.
            if source is None:
                source = (self._catalog_source(connection, live, value, source_owner, constraints)
                          if value.catalog_ref else self._source(connection, live, value))
            if manual:
                by_id = target
                name = person_name(profile['display_name']) if profile else value.recommender_name
                by_ref = profile['account_ref'] if profile else None
            else:
                sender = connection.execute("""select a.display_name,p.account_ref::text
                    from app.accounts a join app.social_profiles p on p.account_id=a.id where a.id=%s""",
                    (live.actor.account_id,)).fetchone()
                if not sender:
                    raise RecommendationError('sender_unavailable', 403)
                by_id, name, by_ref = live.actor.account_id, person_name(sender['display_name']), sender['account_ref']
            identity = attribution_key(account_ref=by_ref, name=name)
            collection = self._collection(connection, live.library_id, recipient, value.kind)
            item = self._item(connection, live, value, collection, source)
            field = 'playlist_item_ref' if value.kind == 'track' else 'top_item_ref'
            existing = connection.execute(f"""select ref,attribution_kind from app.recommendation_attributions
                where {field}=%s and identity_key=%s""", (item, identity)).fetchone()
            if existing is None:
                count = connection.execute(f'select count(*) as total from app.recommendation_attributions where {field}=%s', (item,)).fetchone()['total']
                if count >= MAX_RECOMMENDERS:
                    raise RecommendationError('too_many_recommenders', 409)
                connection.execute(f"""insert into app.recommendation_attributions
                    (ref,recipient_account_id,library_id,{field},identity_key,recommender_account_id,
                     display_name,added_by_account_id,attribution_kind)
                    values(%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (str(uuid4()), recipient, live.library_id,
                    item, identity, by_id, name, live.actor.account_id, 'manual' if manual else 'friend'))
            elif not manual and existing['attribution_kind'] == 'manual':
                connection.execute('''update app.recommendation_attributions set attribution_kind='friend',
                    added_by_account_id=%s where ref=%s''', (live.actor.account_id, str(existing['ref'])))
            require_command()
            if value.source_playlist_ref:
                if self._playlist_source(connection, live, value, source_owner, constraints) != source:
                    raise RecommendationError('source_changed', 409)
            elif value.catalog_ref:
                self._catalog_source(connection, live, value, source_owner, constraints)
            else:
                require_private_action(live, BROWSE, resource=ResourceScope(value.kind, str(value.resource_id)), constraints=constraints)
            if existing is None or not manual and existing['attribution_kind'] == 'manual':
                table = 'app.playlists' if value.kind == 'track' else 'app.album_lists'
                connection.execute(f'update {table} set revision=revision+1,updated_at=now() where ref=%s', (str(collection['ref']),))
            lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=owner._clock)
            # A sender receives delivery status, not the recipient's private collection ID.
            receipt = {'status': 'recommended', 'kind': value.kind, 'already_recommended': existing is not None}
            if manual:
                receipt['collection_ref'] = str(collection['ref'])
            connection.execute("""insert into app.recommendation_operations
                (actor_account_id,library_id,request_key,original_session_id,command_digest,receipt)
                values(%s,%s,%s,%s,%s,%s::jsonb)""", (live.actor.account_id, live.library_id,
                value.request_key, live.actor.session_id, value.digest, json.dumps(receipt)))
            return receipt

    def _playlist_source(self, connection, context, value, expected_owner, constraints):
        if not occurrences.installed(connection):
            raise RecommendationError('recommendations_unavailable', 503)
        playlist = self.owner._playlist(connection, context, value.source_playlist_ref)
        if (playlist['owner_account_id'] != expected_owner
                or playlist['revision'] != value.source_revision):
            raise RecommendationError('source_changed', 409)
        self.owner._require(context, (BROWSE,), constraints, playlist)
        row = connection.execute('''select ref,original_local_track_id,metadata_occurrence_ref,
            title,artist,album_title,original_album_id,release_year,disc_number,track_number,duration_seconds
            from app.playlist_items where playlist_ref=%s and library_id=%s and ref=%s for share''',
            (value.source_playlist_ref, context.library_id, value.source_item_ref)).fetchone()
        if row is None:
            raise RecommendationError('source_unavailable', 404)
        # Only authored facts and internal identity survive. No source ACL,
        # private activity/attribution lineage or playback link is transferred.
        return {key: row[key] for key in ('original_local_track_id', 'title', 'artist',
            'album_title', 'original_album_id', 'release_year', 'disc_number',
            'track_number', 'duration_seconds')} | {'metadata_occurrence_ref': occurrences.origin(row)}

    @staticmethod
    def _catalog_source(connection, context, value, expected_owner, constraints):
        from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
        from music_app.services import album_top_remote_membership as remote
        top = PostgresOwnedAlbumTopsService._top(connection, context, value.source_top_ref)
        if top['owner_account_id'] != expected_owner or top['revision'] != value.source_revision:
            raise RecommendationError('source_changed', 409)
        PostgresOwnedAlbumTopsService._require(context, (BROWSE,), constraints, top)
        item = connection.execute("""select ref,catalog_ref from app.album_list_items
            where top_ref=%s and library_id=%s and ref=%s for share""",
            (value.source_top_ref, context.library_id, value.source_item_ref)).fetchone()
        if item is None or str(item['catalog_ref']) != value.catalog_ref:
            raise RecommendationError('source_changed', 409)
        retained = remote.bindings(connection, top)
        selected = {value.source_item_ref: retained[value.source_item_ref]} if value.source_item_ref in retained else {}
        if selected:
            remote.lock_read_sources(connection, top, selected)
            if selected[value.source_item_ref]['retired_at'] is not None:
                raise RecommendationError('source_unavailable', 409)
        # Forward only canonical metadata. Do not copy acquisition tokens,
        # provider/source URLs, playback authority or another account's evidence.
        PostgresOwnedAlbumTopsService._require(context, (BROWSE,), constraints, top)
        return {'catalog_ref': value.catalog_ref, 'metadata_only': True}

    def _source(self, connection, context, value):
        if value.kind == 'track':
            source = inventory_rows(connection, context.library_id, [value.resource_id], lock=True,
                                    config=self.owner._config).get(value.resource_id)
            if source is None:
                raise RecommendationError('source_unavailable', 404)
            return source
        row = connection.execute("""select a.title,a.release_year,ar.name as artist_display
            from library.local_albums a join library.local_artists ar on ar.id=a.artist_id and ar.library_id=a.library_id
            where a.id=%s and a.library_id=%s for update of a""", (value.resource_id, context.library_id)).fetchone()
        if row is None:
            raise RecommendationError('source_unavailable', 404)
        existing = connection.execute('select catalog_ref from library.catalog_album_links where library_id=%s and local_album_id=%s',
                                      (context.library_id, value.resource_id)).fetchone()
        if existing:
            return {'catalog_ref': str(existing['catalog_ref'])}
        if any(type(row[key]) is not str or not row[key].strip() or len(row[key]) > 1000 for key in ('title', 'artist_display')):
            raise RecommendationError('source_unavailable', 409)
        ref = str(uuid4())
        year = row['release_year']
        connection.execute('insert into catalog.release_groups(ref,title,artist_display,release_year) values(%s,%s,%s,%s)',
                           (ref, row['title'], row['artist_display'], year if type(year) is int and 1 <= year <= 9999 else None))
        connection.execute('insert into library.catalog_album_links(library_id,local_album_id,catalog_ref) values(%s,%s,%s)',
                           (context.library_id, value.resource_id, ref))
        return {'catalog_ref': ref}

    @staticmethod
    def _collection(connection, library_id, recipient, kind):
        table = 'app.playlists' if kind == 'track' else 'app.album_lists'
        # Recipient account is already locked in global account order, serializing
        # lazy creation and same-recipient deliveries without advisory keys.
        row = connection.execute(f'''select * from {table} where owner_account_id=%s
            and library_id=%s and recommendation_collection for update''', (recipient, library_id)).fetchone()
        if row is None:
            row = connection.execute(f'''insert into {table}
                (ref,owner_account_id,library_id,title,description,recommendation_collection)
                values(%s,%s,%s,'Recommended By','Music recommended to you.',true) returning *''',
                (str(uuid4()), recipient, library_id)).fetchone()
        if row['deleted_at'] is not None or row['visibility'] != 'private':
            raise RecommendationError('collection_unavailable', 409)
        return row

    def _item(self, connection, context, value, collection, source):
        ref = str(collection['ref'])
        table, parent, identity = ('app.playlist_items', 'playlist_ref', 'original_local_track_id') if value.kind == 'track' else ('app.album_list_items', 'top_ref', 'catalog_ref')
        resource = value.resource_id if value.kind == 'track' else source['catalog_ref']
        if value.source_playlist_ref:
            resource = source['original_local_track_id']
        if value.source_playlist_ref and resource is None:
            existing = connection.execute('''select ref from app.playlist_items
                where playlist_ref=%s and metadata_occurrence_ref=%s''',
                (ref, source['metadata_occurrence_ref'])).fetchone()
        else:
            existing = connection.execute(f'select ref from {table} where {parent}=%s and {identity}=%s', (ref, resource)).fetchone()
        if existing:
            return str(existing['ref'])
        count = connection.execute(f'select count(*) as total from {table} where {parent}=%s', (ref,)).fetchone()['total']
        if count >= MAX_ITEMS:
            raise RecommendationError('collection_full', 409)
        if value.source_playlist_ref:
            item = str(uuid4())
            connection.execute('''insert into app.playlist_items
                (ref,playlist_ref,library_id,position,original_local_track_id,local_track_id,
                 title,artist,album_title,original_album_id,release_year,disc_number,track_number,
                 duration_seconds,metadata_occurrence_ref,source_kind)
                values(%s,%s,%s,%s,%s,null,%s,%s,%s,%s,%s,%s,%s,%s,%s,'playlist')''',
                (item, ref, context.library_id, count + 1, resource, source['title'], source['artist'],
                 source['album_title'], source['original_album_id'], source['release_year'],
                 source['disc_number'], source['track_number'], source['duration_seconds'],
                 source['metadata_occurrence_ref']))
            return item
        if value.kind == 'track':
            self.owner._insert_items(connection, context, ref, [source], offset=count)
            return str(connection.execute(f'select ref from {table} where {parent}=%s and {identity}=%s', (ref, resource)).fetchone()['ref'])
        item = str(uuid4())
        connection.execute('''insert into app.album_list_items
            (ref,top_ref,library_id,catalog_ref,original_position,curator_position,recommendation_metadata_only)
            values(%s,%s,%s,%s,%s,%s,%s)''',
            (item, ref, context.library_id, resource, collection['next_original_position'], count+1, source.get('metadata_only', False)))
        connection.execute('update app.album_lists set next_original_position=next_original_position+1 where ref=%s', (ref,))
        return item

    def album_attributions(self, context, album_id, *, constraints=None):
        if type(album_id) is not int or not 0 < album_id <= 9223372036854775807:
            raise RecommendationError('invalid_query')
        with self.owner._authorized(context, constraints) as (connection, live, _):
            require_private_action(live, BROWSE, resource=ResourceScope('album', str(album_id)), constraints=constraints)
            installed = connection.execute("select to_regclass('app.recommendation_attributions') as installed").fetchone()
            if not installed or installed['installed'] is None:
                lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                    actor_session_id=live.actor.session_id, clock=self.owner._clock)
                return {'recommenders': []}
            rows = connection.execute('''select i.ref from app.album_list_items i
                join app.album_lists t on t.ref=i.top_ref and t.library_id=i.library_id
                join library.catalog_album_links l on l.catalog_ref=i.catalog_ref and l.library_id=i.library_id
                where t.owner_account_id=%s and t.library_id=%s and t.recommendation_collection
                and t.deleted_at is null and l.local_album_id=%s''', (live.actor.account_id, live.library_id, album_id)).fetchall()
            refs = [str(row['ref']) for row in rows]
            by_item = load_attributions(connection, live, kind='album', item_refs=refs)
            require_private_action(live, BROWSE, resource=ResourceScope('album', str(album_id)), constraints=constraints)
            lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=self.owner._clock)
            return {'recommenders': [by for ref in refs for by in by_item.get(ref, [])]}
