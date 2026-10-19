"""Action-time native queues from locked saved Top membership, never view hints."""
import re

from music_app.services import album_top_remote_membership as remote_membership
from music_app.services.album_top_native_binding import lock_binding, eligible_editions
from music_app.services.owned_album_tops import AlbumTopError, BROWSE, top_uuid, top_revision
from music_app.services.policy import ResourceScope
from music_app.services.private_native_targets import PrivateNativeTargets, NativeTargetError, allows


MAX_QUEUE_TRACKS = 5000
MEDIA = 'library.media.read'
_INVENTORY = re.compile(r'inventory-(album|track):([1-9][0-9]{0,18}):([1-9][0-9]{0,18})\Z')
_SOURCE_KEYS = {'revision', 'item_ref', 'catalog_ref', 'inventory_album_ref',
                'inventory_track_ref', 'canonical_track_ref'}


def _inventory(value, kind):
    match = _INVENTORY.fullmatch(value) if isinstance(value, str) else None
    if match is None or match[1] != kind:
        raise AlbumTopError('invalid_command', 422)
    library, identity = int(match[2]), int(match[3])
    if max(library, identity) > 9223372036854775807:
        raise AlbumTopError('invalid_command', 422)
    return library, identity


def _play_allowed(live, kind, identity, constraints):
    return all(allows(live, action, ResourceScope(kind, str(identity)), constraints)
               for action in (BROWSE, MEDIA))


def _track_order(row):
    return tuple((0, value) if isinstance(value, int) and value > 0 else (1, 0)
                 for value in (row['disc_number'], row['track_number'])) + (row['id'],)


class AlbumTopNativeQueue:
    def __init__(self, tops, *, media_resolver=None):
        self.tops = tops
        self.native = PrivateNativeTargets(tops._config, media_resolver=media_resolver)

    def _top(self, connection, live, ref, revision, constraints):
        top = self.tops._top(connection, live, ref)
        self.tops._require(live, (BROWSE,), constraints, top)
        if str(top['revision']) != revision:
            raise AlbumTopError('revision_conflict', 409)
        return top

    def capture(self, context, *, top_ref, payload, context_ref, constraints=None):
        ref = top_uuid(top_ref)
        if not isinstance(payload, dict) or set(payload) != {'revision'}:
            raise AlbumTopError('invalid_command', 422)
        revision = top_revision(payload['revision'])
        remote_membership.require_context(context_ref)
        with self.tops._authorized(context, constraints) as (connection, live, _):
            top = self._top(connection, live, ref, revision, constraints)
            members = connection.execute('''select ref,catalog_ref from app.album_list_items
                where top_ref=%s order by curator_position,ref''', (ref,)).fetchall()
            remote = remote_membership.bindings(connection, top)
            editions, unavailable = {}, {}
            # All catalog locks use a common order, independent of curator order.
            for member in sorted(members, key=lambda row: (str(row['catalog_ref']), str(row['ref']))):
                item, catalog = str(member['ref']), str(member['catalog_ref'])
                if item in remote:
                    unavailable[item] = 'remote_summary'
                    continue
                lock_binding(connection, top_ref=ref, item_ref=item, library_id=live.library_id,
                             revision=revision, catalog_ref=catalog)
                candidates = eligible_editions(connection, live.library_id, catalog)
                if len(candidates) != 1:
                    visible = candidates and all(allows(live, BROWSE,
                        ResourceScope('album', str(row['id'])), constraints) for row in candidates)
                    unavailable[item] = 'ambiguous_edition' if visible else 'unavailable'
                    continue
                album = candidates[0]
                if not _play_allowed(live, 'album', album['id'], constraints):
                    unavailable[item] = 'unavailable'
                    continue
                editions[item] = album
            # Acquire track locks in inventory's order, without a SHARE-to-UPDATE
            # upgrade. The bound rejects the entire capture; never truncate a block.
            album_ids = sorted({row['id'] for row in editions.values()})
            tracks = connection.execute('''select id,album_id,track_key,disc_number,track_number
                from library.local_tracks where library_id=%s and album_id=any(%s)
                order by id limit %s for update''',
                (live.library_id, album_ids, MAX_QUEUE_TRACKS + 1)).fetchall() if album_ids else []
            if len(tracks) > MAX_QUEUE_TRACKS:
                raise AlbumTopError('queue_too_large', 422)
            by_album = {}
            for row in tracks:
                by_album.setdefault(row['album_id'], []).append(row)
            # Count occurrences too: distinct canonical members can share inventory.
            if sum(len(by_album.get(album['id'], ())) for album in editions.values()) > MAX_QUEUE_TRACKS:
                raise AlbumTopError('queue_too_large', 422)
            targets = self.native.resolve_play_queue(connection, live,
                [row['id'] for row in tracks if row['track_key']], constraints=constraints)
            albums = []
            for member in members:
                item, catalog = str(member['ref']), str(member['catalog_ref'])
                if item not in editions:
                    continue
                album = editions[item]
                current = eligible_editions(connection, live.library_id, catalog)
                if len(current) != 1 or current[0] != album:
                    raise AlbumTopError('native_binding_changed', 409)
                if not _play_allowed(live, 'album', album['id'], constraints):
                    raise AlbumTopError('forbidden', 403)
                album_ref = f"inventory-album:{live.library_id}:{album['id']}"
                rows = sorted(by_album.get(album['id'], ()), key=_track_order)
                output = []
                for row in rows:
                    if row['id'] not in targets:
                        continue
                    if not _play_allowed(live, 'track', row['id'], constraints):
                        raise AlbumTopError('forbidden', 403)
                    source = {'revision': revision, 'item_ref': item, 'catalog_ref': catalog,
                        'inventory_album_ref': album_ref,
                        'inventory_track_ref': f"inventory-track:{live.library_id}:{row['id']}",
                        'canonical_track_ref': row['track_key']}
                    output.append({'queue_item_ref': f"{item}:{row['id']}",
                                   'source': source, 'native_target': targets[row['id']]})
                if len(output) != len(rows) or not output:
                    unavailable[item] = 'tracks_unavailable'
                if output:
                    albums.append({'item_ref': item, 'catalog_ref': catalog,
                        'inventory_album_ref': album_ref, 'album_ref': album['album_key'], 'tracks': output})
            self.tops._require(live, (BROWSE,), constraints, top)
            return {'top_ref': ref, 'revision': revision, 'albums': albums,
                    'unavailable_items': [{'item_ref': str(row['ref']), 'reason': unavailable[str(row['ref'])]}
                        for row in members if str(row['ref']) in unavailable]}

    def resolve(self, context, *, top_ref, payload, context_ref, constraints=None):
        ref = top_uuid(top_ref)
        if not isinstance(payload, dict) or set(payload) != _SOURCE_KEYS:
            raise AlbumTopError('invalid_command', 422)
        revision, item = top_revision(payload['revision']), top_uuid(payload['item_ref'])
        catalog = top_uuid(payload['catalog_ref'])
        library, album_id = _inventory(payload['inventory_album_ref'], 'album')
        track_library, track_id = _inventory(payload['inventory_track_ref'], 'track')
        key = payload['canonical_track_ref']
        if not isinstance(key, str) or not key or track_library != library:
            raise AlbumTopError('invalid_command', 422)
        remote_membership.require_context(context_ref)
        with self.tops._authorized(context, constraints) as (connection, live, _):
            if library != live.library_id:
                raise AlbumTopError('item_unavailable', 404)
            top = self._top(connection, live, ref, revision, constraints)
            if item in remote_membership.bindings(connection, top):
                raise AlbumTopError('item_unavailable', 404)
            member = connection.execute('''select catalog_ref from app.album_list_items
                where top_ref=%s and ref=%s''', (ref, item)).fetchone()
            if member is None or str(member['catalog_ref']) != catalog:
                raise AlbumTopError('item_unavailable', 404)
            lock_binding(connection, top_ref=ref, item_ref=item, library_id=library,
                         revision=revision, catalog_ref=catalog)
            editions = eligible_editions(connection, library, catalog)
            if len(editions) != 1 or editions[0]['id'] != album_id:
                raise AlbumTopError('native_binding_changed', 409)
            if not _play_allowed(live, 'album', album_id, constraints):
                raise AlbumTopError('forbidden', 403)
            track = connection.execute('''select track_key from library.local_tracks
                where library_id=%s and album_id=%s and id=%s for update''',
                (library, album_id, track_id)).fetchone()
            if track is None or track['track_key'] != key:
                raise AlbumTopError('item_unavailable', 404)
            try:
                target = self.native.resolve(connection, live, track_id, intent='play', constraints=constraints)
            except NativeTargetError as error:
                raise AlbumTopError(error.code, error.status_code) from None
            if not all(_play_allowed(live, kind, identity, constraints)
                       for kind, identity in (('album', album_id), ('track', track_id))):
                raise AlbumTopError('forbidden', 403)
            if eligible_editions(connection, library, catalog) != editions:
                raise AlbumTopError('native_binding_changed', 409)
            self.tops._require(live, (BROWSE,), constraints, top)
            return {'top_ref': ref, 'source': dict(payload), 'native_target': target}
