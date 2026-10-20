"""Caller-scoped local admissions; saved membership is never regenerated."""
from dataclasses import dataclass

from music_app.services.album_top_artist_scope import artist_scope, normalize_artist_scope
from music_app.services.artist_family_postgres import (
    ArtistFamilyIdentityUnavailable, load_artist_family_identity_scope,
)
from music_app.services.library_mix import ArtistMixScope
from music_app.services.library_mix_inventory_postgres import scoped_album_order
from music_app.services.owned_album_tops import AlbumTopError, BROWSE, MAX_TOP_ITEMS
from music_app.services.owned_playlists import PlaylistError
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import PrivateLibraryAuthorityError, require_private_action
from music_app.services import album_top_remote_artist_scope as remote_scope


@dataclass(frozen=True)
class ScopeWitness:
    root_artist_id: str
    mode: str
    members: tuple
    albums: tuple
    refs: tuple
    bindings: tuple


def _allowed(live, constraints, kind, identity):
    try:
        require_private_action(live, BROWSE, resource=ResourceScope(kind, str(identity)),
                               constraints=constraints)
        return True
    except PrivateLibraryAuthorityError:
        return False


def _members(connection, live, scope, constraints):
    try:
        result = load_artist_family_identity_scope(connection, library_id=live.library_id,
            root_artist_id=int(scope['root_artist_id']), scope_mode=scope['mode'],
            is_artist_readable=lambda identity: _allowed(live, constraints, 'artist', identity))
    except PermissionError:
        raise AlbumTopError('artist_scope_unavailable', 404) from None
    except ArtistFamilyIdentityUnavailable:
        raise AlbumTopError('artist_scope_unavailable', 503) from None
    if result is None:
        raise AlbumTopError('artist_scope_unavailable', 404)
    return result


def _albums(connection, live, members, constraints):
    # Existing Gallery membership semantics, without any Mix/Loved permissions,
    # playback predicates, ranking, quota or transient creation filter defaults.
    scope = ArtistMixScope(members, (), ('main_library', 'new_arrivals', 'hoard'),
                           ('studio', 'ep', 'live', 'demo', 'compilation', 'single'))
    try:
        return scoped_album_order(connection, live, scope, dynamic=True,
            is_readable=lambda identity: _allowed(live, constraints, 'album', identity),
            is_artist_readable=lambda identity: _allowed(live, constraints, 'artist', identity))
    except PlaylistError as error:
        if error.code == 'library_mix_unavailable':
            raise AlbumTopError('artist_scope_unavailable', 503) from None
        raise AlbumTopError('artist_scope_changed', 409) from None


def _bindings(connection, live, refs, albums, constraints):
    if not refs:
        return ()
    rows = connection.execute('''select catalog_ref,local_album_id
        from library.catalog_album_links where library_id=%s and catalog_ref=any(%s::uuid[])
        order by catalog_ref,local_album_id''', (live.library_id, list(refs))).fetchall()
    admitted = set(albums)
    return tuple((str(row['catalog_ref']), row['local_album_id']) for row in rows
                 if row['local_album_id'] in admitted
                 and _allowed(live, constraints, 'album', row['local_album_id']))


def capture(connection, live, scope, refs, constraints):
    # The caller's existing library FOR SHARE fences supported scan/relation
    # publication commits. Add no Artist/credit locks before later catalog or
    # artwork album locks. Recheck exact facts after those owners' waits.
    scope = normalize_artist_scope(scope)
    refs = tuple(sorted(set(refs)))
    members = _members(connection, live, scope, constraints)
    albums = _albums(connection, live, members, constraints)
    bindings = _bindings(connection, live, refs, albums, constraints)
    if {ref for ref, _identity in bindings} != set(refs):
        raise AlbumTopError('album_outside_artist_scope', 409)
    return ScopeWitness(scope['root_artist_id'], scope['mode'], members, albums, refs, bindings)


def finish(connection, live, witness, constraints):
    if witness is None:
        return
    if isinstance(witness, remote_scope.RemoteScopeWitness):
        return remote_scope.finish(connection, live, witness, constraints)
    scope = {'root_artist_id': witness.root_artist_id, 'mode': witness.mode}
    try:
        current = capture(connection, live, scope, witness.refs, constraints)
    except AlbumTopError as error:
        if error.code == 'album_outside_artist_scope' or (
                error.code == 'artist_scope_unavailable' and error.status_code == 404):
            raise AlbumTopError('artist_scope_changed', 409) from None
        raise
    if current != witness:
        raise AlbumTopError('artist_scope_changed', 409)


def _new_refs(command):
    data = command.data
    if command.action in {'create', 'add'}:
        if 'selections' in data:
            return [row['album_ref'] for row in data['selections'] if row['kind'] == 'local_catalog']
        return data.get('album_refs', [])
    if command.action in {'save', 'enable_external'}:
        if 'item_selections' in data:
            rows = [row for row in data['item_selections'] if row['kind'] != 'existing']
            return [row['album_ref'] for row in rows if row['kind'] == 'new_local']
        return [row['album_ref'] for row in data.get('items', []) if row['item_ref'] is None]
    return []


def start(connection, live, command, top, constraints):
    scope = artist_scope(top)
    if scope is None or command.action not in {'create', 'add', 'save', 'enable_external'}:
        return None
    selectors = remote_scope.new_selectors(connection, live, command, top)
    refs = _new_refs(command)
    if refs:
        retained = connection.execute('''select catalog_ref from app.album_list_items
            where top_ref=%s and library_id=%s''', (top['ref'], live.library_id)).fetchall()
        existing = {str(row['catalog_ref']) for row in retained}
        refs = [ref for ref in refs if ref not in existing]
    # Empty creation must prove its root; retained-only edits do not refresh a
    # saved family or make a deleted origin prevent removal/reorder/metadata.
    local = capture(connection, live, scope, refs, constraints) if refs or selectors or command.action == 'create' else None
    return remote_scope.capture(connection, live, top, local, selectors) if selectors else local


def validate_remote_facts(witness, candidates):
    return remote_scope.validate(witness, candidates)


def copy_scope(connection, top, target_ref):
    scope = artist_scope(top)
    if scope is not None:
        connection.execute('''update app.album_lists set listen_through_artist_id=%s,
            listen_through_scope_mode=%s where ref=%s and library_id=%s''',
            (int(scope['root_artist_id']), scope['mode'], target_ref, top['library_id']))


def proposed_items(connection, live, top, items, current, constraints):
    from music_app.services.album_top_publication import validate_draft_membership
    refs = validate_draft_membership(items, current)
    scope = artist_scope(top)
    return capture(connection, live, scope, refs, constraints) if scope is not None and refs else None


def requested_scope(top, requested):
    if requested is not None:
        if top is not None:
            raise AlbumTopError('invalid_command')
        return normalize_artist_scope(requested)
    return artist_scope(top) if top is not None else None


def local_admission(connection, live, scope, album_id, constraints):
    if scope is None:
        return None
    witness = capture(connection, live, scope, (), constraints)
    if album_id not in witness.albums:
        raise AlbumTopError('album_outside_artist_scope', 409)
    return witness


def confirm_local_admission(connection, live, witness, album_id, constraints):
    if witness is not None:
        finish(connection, live, witness, constraints)


def _creation_metadata(metadata, preference):
    metadata = metadata if type(metadata) is dict else {}
    explicit = metadata.get('release_type')
    explicit = explicit.strip().lower() if type(explicit) is str else None
    release_type = explicit if explicit in {'studio', 'ep', 'live', 'demo', 'compilation', 'single'} else None
    if metadata.get('is_compilation') is True:
        release_type = 'compilation' if release_type in (None, 'compilation') else None
    preference = preference if type(preference) is dict else {}
    rating = preference.get('rating')
    available = preference.get('taste_state') == 'available' and 'rating' in preference and (
        rating is None or type(rating) is int and 1 <= rating <= 10)
    return {'release_type': release_type,
        'rating_state': 'available' if available else 'unavailable',
        'rating': rating if available else None, 'artwork_url': None}


def search(connection, live, scope, *, query, cursor, limit, cursor_secret, top_ref, constraints):
    from music_app.services.album_top_viewer_actions import page_position
    from music_app.services.social_cursors import encode_social_cursor
    from music_app.services.album_preferences_postgres import load_album_preferences_on_connection
    from music_app.services.private_album_artwork import album_artwork_url

    witness = capture(connection, live, scope, (), constraints)
    if len(witness.albums) > MAX_TOP_ITEMS:
        raise AlbumTopError('top_too_large', 413)
    cursor_scope = ['album-top-artist-picker-v1', live.actor.account_id,
        live.actor.session_id, live.library_id, top_ref, witness.root_artist_id,
        witness.mode, list(witness.members), list(witness.albums), query]
    after = page_position(cursor, cursor_secret, cursor_scope)
    rows = connection.execute('''select a.id,a.title,a.release_year,a.metadata,ar.name as artist,
        l.catalog_ref,selected.position from unnest(%s::bigint[]) with ordinality
        as selected(id,position) join library.local_albums a
          on a.id=selected.id and a.library_id=%s
        join library.local_artists ar on ar.id=a.artist_id and ar.library_id=a.library_id
        left join library.catalog_album_links l on l.local_album_id=a.id and l.library_id=a.library_id
        where selected.position>%s and (%s='' or strpos(lower(a.title),lower(%s))>0
          or strpos(lower(ar.name),lower(%s))>0)
        order by selected.position limit %s''',
        (list(witness.albums), live.library_id, after, query, query, query, limit + 1)).fetchall()
    albums = []
    for row in rows[:limit]:
        if not _allowed(live, constraints, 'album', row['id']):
            raise AlbumTopError('artist_scope_changed', 409)
        if any(type(row[key]) is not str or not row[key].strip() or len(row[key]) > 1000
               for key in ('title', 'artist')):
            continue
        albums.append({'local_album_id': row['id'],
            'inventory_album_ref': f"inventory-album:{live.library_id}:{row['id']}",
            'album_ref': str(row['catalog_ref']) if row['catalog_ref'] is not None else None,
            'title': row['title'], 'artist': row['artist'],
            'year': row['release_year'] if type(row['release_year']) is int
                and 1 <= row['release_year'] <= 9999 else None})
    preferences = load_album_preferences_on_connection(connection,
        account_id=live.actor.account_id, library_id=live.library_id,
        album_ids=[album['local_album_id'] for album in albums])
    metadata = {row['id']: row['metadata'] for row in rows[:limit]}
    for album in albums:
        identity = album['local_album_id']
        if not _allowed(live, constraints, 'album', identity):
            raise AlbumTopError('artist_scope_changed', 409)
        album['creation_metadata'] = _creation_metadata(metadata[identity], preferences.get(identity))
        album['creation_metadata']['artwork_url'] = album_artwork_url(live, identity, constraints=constraints)
    finish(connection, live, witness, constraints)
    for album in albums:
        identity = album['local_album_id']
        if not _allowed(live, constraints, 'album', identity):
            raise AlbumTopError('artist_scope_changed', 409)
        album['creation_metadata']['artwork_url'] = album_artwork_url(live, identity, constraints=constraints)
    return {'albums': albums, 'next_cursor': encode_social_cursor(
        rows[limit - 1]['position'] if len(rows) > limit else None,
        secret=cursor_secret, scope=cursor_scope)}
