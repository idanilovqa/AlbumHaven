"""Bounded, immutable Playlist conversion evidence; only explicit Save creates a Top."""
from datetime import timedelta
import json

from music_app.services.owned_album_tops import (
    AlbumTopError, BROWSE, CREATE, MAX_TOP_ITEMS, top_uuid, top_revision,
)
from music_app.services.owned_playlists import PlaylistError
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.policy import ResourceScope

LIFETIME = timedelta(minutes=60)
MAX_PREVIEWS = 64
MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024


def _source(connection, live, playlist_ref, constraints):
    try:
        playlist = PostgresOwnedPlaylistsService._playlist(connection, live, playlist_ref)
        PostgresOwnedPlaylistsService._require(live, (BROWSE,), constraints, playlist)
        return playlist
    except PlaylistError as error:
        raise AlbumTopError(error.code, error.status_code) from None


def _readable(live, kind, identity, constraints):
    return PostgresOwnedPlaylistsService._resource_allowed(
        live, BROWSE, ResourceScope(kind, str(identity)), constraints)


def ordered_snapshot(rows, *, readable):
    """Resolve only admitted IDs, never album names, paths or local playability."""
    if not rows:
        raise AlbumTopError('playlist_empty', 409)
    if len(rows) > MAX_TOP_ITEMS:
        raise AlbumTopError('playlist_too_large', 413)
    albums, report, seen = [], [], set()
    for row in rows:
        item = {'playlist_item_ref': str(row['ref']), 'position': row['position']}
        if row['local_track_id'] is None:
            reason = 'unresolved' if row['original_local_track_id'] is not None else 'unsupported'
        elif row['track_id'] is None or row['album_id'] is None:
            reason = 'unresolved'
        elif not readable('track', row['track_id']) or not readable('album', row['album_id']):
            reason = 'unavailable'
        elif row['catalog_ref'] is None:
            reason = 'unresolved'
        elif str(row['catalog_ref']) in seen:
            reason = 'duplicate'
        else:
            reason = 'included'
            ref = str(row['catalog_ref'])
            seen.add(ref)
            albums.append({'album_ref': ref, 'title': row['title'],
                           'artist': row['artist_display'], 'year': row['release_year']})
        # Rejected source metadata and private inventory IDs never enter the DTO.
        report.append({**item, 'reason': reason})
    return {'albums': albums, 'report': report}


def _load(connection, live, ref, context_ref, now):
    row = connection.execute("""select * from app.playlist_album_top_previews
        where ref=%s and actor_account_id=%s and library_id=%s""",
        (ref, live.actor.account_id, live.library_id)).fetchone()
    if (row is None or row['original_session_id'] != live.actor.session_id
            or row['context_ref'] != context_ref or row['discarded_at'] is not None):
        raise AlbumTopError('preview_unavailable', 404)
    if row['expires_at'] <= now:
        raise AlbumTopError('preview_expired', 410)
    return row


def _project(row):
    return {'preview_ref': str(row['ref']), 'source': {
        'playlist_ref': str(row['playlist_ref']), 'revision': str(row['playlist_revision'])},
        'expires_at': row['expires_at'].isoformat(), **row['snapshot']}


def _authorize_snapshot(tops, connection, live, row, constraints):
    _source(connection, live, str(row['playlist_ref']), constraints)
    tops._require(live, (BROWSE, CREATE), constraints)
    if any(not _readable(live, 'track', identity, constraints) for identity in row['source_track_ids']):
        raise AlbumTopError('forbidden', 403)
    refs = [item['album_ref'] for item in row['snapshot']['albums']]
    tops._catalog(connection, live, refs, constraints)
    # Parent/catalog locks and policy resolution may have waited across expiry.
    # Transaction-entry time is not evidence that this receipt is still live.
    if row['expires_at'] <= tops._clock():
        raise AlbumTopError('preview_expired', 410)
    return refs


class PlaylistAlbumTopPreviews:
    def __init__(self, tops):
        self.tops = tops

    def capture(self, context, *, playlist_ref, payload, context_ref, constraints=None):
        from psycopg.types.json import Jsonb
        playlist_ref = top_uuid(playlist_ref)
        if type(payload) is not dict or set(payload) != {'request_key', 'revision'}:
            raise AlbumTopError('invalid_command')
        ref, revision = top_uuid(payload['request_key']), top_revision(payload['revision'])
        with self.tops._authorized(context, constraints) as (connection, live, now):
            self.tops._require(live, (BROWSE, CREATE), constraints)
            # Account/library transaction first, then Playlist parent, inventory,
            # and receipt. No existing Top is locked by this flow.
            playlist = _source(connection, live, playlist_ref, constraints)
            old = connection.execute('select ref from app.playlist_album_top_previews where ref=%s', (ref,)).fetchone()
            if old:
                row = _load(connection, live, ref, context_ref, self.tops._clock())
                if str(row['playlist_ref']) != playlist_ref or str(row['playlist_revision']) != revision:
                    raise AlbumTopError('request_key_conflict', 409)
                _authorize_snapshot(self.tops, connection, live, row, constraints)
                return _project(row)
            if str(playlist['revision']) != revision:
                raise AlbumTopError('revision_conflict', 409)
            connection.execute("""delete from app.playlist_album_top_previews where ref in (
                select ref from app.playlist_album_top_previews where actor_account_id=%s
                and library_id=%s and saved_top_ref is null and expires_at<=%s order by expires_at,ref limit 64)""",
                (live.actor.account_id, live.library_id, now))
            count = connection.execute("""select count(*) as count from app.playlist_album_top_previews
                where actor_account_id=%s and library_id=%s and saved_top_ref is null""", (live.actor.account_id, live.library_id)).fetchone()['count']
            if count >= MAX_PREVIEWS:
                raise AlbumTopError('preview_limit', 429)
            rows = connection.execute("""select i.ref,i.position,i.local_track_id,i.original_local_track_id,t.id as track_id,
                a.id as album_id,l.catalog_ref,c.title,c.artist_display,c.release_year
                from app.playlist_items i
                left join library.local_tracks t on t.id=i.local_track_id and t.library_id=%s
                left join library.local_albums a on a.id=t.album_id and a.library_id=t.library_id
                left join library.catalog_album_links l on l.local_album_id=a.id and l.library_id=a.library_id
                left join catalog.release_groups c on c.ref=l.catalog_ref
                where i.playlist_ref=%s order by i.position,i.ref limit %s""",
                (live.library_id, playlist_ref, MAX_TOP_ITEMS + 1)).fetchall()
            snapshot = ordered_snapshot(rows, readable=lambda kind, identity: _readable(live, kind, identity, constraints))
            snapshot['title'] = playlist['title']
            snapshot['description'] = playlist['description']
            if len(json.dumps(snapshot, ensure_ascii=False).encode('utf-8')) > MAX_SNAPSHOT_BYTES:
                raise AlbumTopError('preview_too_large', 413)
            # Authorization is checked again after the bounded read, before it
            # can be retained. No playlist/queue/Top content is changed here.
            _source(connection, live, playlist_ref, constraints)
            self.tops._require(live, (BROWSE, CREATE), constraints)
            source_tracks = [row['track_id'] for row, item in zip(rows, snapshot['report'])
                             if item['reason'] == 'included']
            now = self.tops._clock()
            row = connection.execute("""insert into app.playlist_album_top_previews
                (ref,actor_account_id,original_session_id,library_id,context_ref,playlist_ref,
                 playlist_revision,source_track_ids,snapshot,created_at,expires_at)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning *""",
                (ref, live.actor.account_id, live.actor.session_id, live.library_id, context_ref,
                 playlist_ref, revision, source_tracks, Jsonb(snapshot), now, now + LIFETIME)).fetchone()
            _authorize_snapshot(self.tops, connection, live, row, constraints)
            return _project(row)

    def discard(self, context, *, preview_ref, context_ref, constraints=None):
        ref = top_uuid(preview_ref)
        with self.tops._authorized(context, constraints) as (connection, live, now):
            self.tops._require(live, (BROWSE,), constraints)
            # Discard has no dependency on continuing source access. A revoked
            # Playlist must not prevent retiring this actor's own preview.
            connection.execute("""update app.playlist_album_top_previews set discarded_at=%s
                where ref=%s and actor_account_id=%s and library_id=%s and original_session_id=%s
                  and context_ref=%s and discarded_at is null and saved_top_ref is null""",
                (now, ref, live.actor.account_id, live.library_id, live.actor.session_id, context_ref))
            return {'preview_ref': ref, 'discarded': True}


def save_albums(tops, connection, live, command, context_ref, constraints):
    """Called after native operation replay, before creating any Top or baseline."""
    row = _load(connection, live, command.data['playlist_preview_ref'], context_ref, tops._clock())
    refs = _authorize_snapshot(tops, connection, live, row, constraints)
    if not refs:
        raise AlbumTopError('preview_empty', 409)
    return refs
