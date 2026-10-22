"""Bounded owner-only choices from existing inventory, never a capture or scan.

The caller owns the single current-library transaction. Like publication_preview,
lock order is account/library authority, Top, link, then source-generation barrier.
"""
import re
from uuid import UUID

from music_app.services import album_top_publication as publication
from music_app.services import album_top_publication_evidence as evidence
from music_app.services.album_top_publication_authority import require_source_browse
from music_app.services.owned_album_tops import AlbumTopError, BROWSE, MANAGE, ITEMS, ACCESS, top_uuid, top_revision
from music_app.services.public_album_tops import snapshot_text
from music_app.services.social_cursors import decode_social_cursor, encode_social_cursor

_CONTEXT = re.compile(r'[0-9a-f]{64}\Z', re.ASCII)
_MAX_LOCAL = 9223372036854775807
_MASK = (1 << 128) - 1
_ACTIONS = (BROWSE, MANAGE, ITEMS, ACCESS)


def validate_request(*, top_ref, item_ref, revision, context_ref, cursor=None, limit=50):
    if (type(limit) is not int or not 1 <= limit <= 100
            or type(context_ref) is not str or not _CONTEXT.fullmatch(context_ref)
            or cursor is not None and (type(cursor) is not str or not 1 <= len(cursor) <= 4096)):
        raise AlbumTopError('invalid_query')
    try:
        return {'top_ref': top_uuid(top_ref), 'item_ref': top_uuid(item_ref),
                'revision': top_revision(revision), 'context_ref': context_ref, 'cursor': cursor, 'limit': limit}
    except AlbumTopError:
        raise AlbumTopError('invalid_query') from None


def _position(cursor, secret, scope):
    try:
        value = decode_social_cursor(cursor, secret=secret, scope=scope)
        if cursor is None:
            return 0, str(UUID(int=0))
        local, ref = value >> 128, value & _MASK
        if not 0 < local <= _MAX_LOCAL:
            raise ValueError
        return local, str(UUID(int=ref))
    except ValueError:
        raise AlbumTopError('invalid_cursor') from None


def _label(value):
    return snapshot_text(value, maximum=1000)


def read_sources(owner, connection, live, *, top_ref, item_ref, revision, context_ref,
                 cursor, limit, cursor_secret, constraints):
    top = owner._top(connection, live, top_ref)
    owner._require(live, _ACTIONS, constraints, top, owner_only=True)
    publication.lock_link(connection, top)
    if str(top['revision']) != revision:
        raise AlbumTopError('revision_conflict', 409)
    item = connection.execute('''select ref,catalog_ref from app.album_list_items
        where top_ref=%s and library_id=%s and ref=%s''',
        (top_ref, live.library_id, item_ref)).fetchone()
    if item is None:
        raise AlbumTopError('item_unavailable', 404)
    # Existing barrier only locks tables and the generation row. It does not
    # reconcile inventory, capture tracks, increment a clock or admit a snapshot.
    generation = evidence.source_barrier(connection, live.library_id)
    scope = ['album-top-publication-sources-v1', live.actor.account_id, live.actor.session_id,
             live.library_id, context_ref, top_ref, item_ref, revision, str(item['catalog_ref']),
             str(generation), limit]
    rows, next_cursor = _source_page(owner, connection, live, top, str(item['catalog_ref']),
        item_ref, scope, cursor, limit, cursor_secret, constraints)
    return {'top_ref': top_ref, 'revision': revision, 'item_ref': item_ref,
            'album_ref': str(item['catalog_ref']), 'sources': rows,
            'next_cursor': next_cursor}


def _source_page(owner, connection, live, top, catalog_ref, item_ref, scope,
                 cursor, limit, cursor_secret, constraints):
    after_local, after_ref = _position(cursor, cursor_secret, scope)
    candidates = connection.execute('''select s.ref,s.local_album_id
        from library.album_metadata_sources s
        join library.catalog_album_links c on c.library_id=s.library_id and c.local_album_id=s.local_album_id
        where s.library_id=%s and c.catalog_ref=%s and s.state='active'
          and (s.local_album_id,s.ref)>(%s,%s::uuid)
        order by s.local_album_id,s.ref limit %s''',
        (live.library_id, catalog_ref, after_local, after_ref, limit + 1)).fetchall()
    rows, scopes = [], []
    for candidate in candidates[:limit]:
        selected = {'album_ref': str(catalog_ref), 'item_ref': item_ref,
                    'selected_local_album_id': candidate['local_album_id'],
                    'selected_source_ref': str(candidate['ref'])}
        try:
            source, source_scope = evidence.selection_source(connection, live, selected, constraints)
            if source['title_origin'] != 'tag_metadata' or source['artist_origin'] != 'tag_metadata':
                continue
            title, artist = _label(source['title']), _label(source['artist'])
            year = source['year']
            if year is not None and (type(year) is not int or not 1 <= year <= 9999):
                continue
        except AlbumTopError as error:
            if error.code not in {'forbidden', 'evidence_unavailable', 'unavailable'}:
                raise
            continue
        rows.append({'selected_local_album_id': selected['selected_local_album_id'],
                     'selected_source_ref': selected['selected_source_ref'],
                     'title': title, 'artist': artist, 'year': year})
        scopes.append(source_scope)
    # A mutable policy resolver may change during a later candidate lookup.
    # Recheck every emitted source and all owner gates after the last wait.
    for source_scope in scopes:
        require_source_browse(live, source_scope, constraints)
    owner._require(live, _ACTIONS, constraints, top, owner_only=True)
    position = None
    if len(candidates) > limit:
        last = candidates[limit - 1]
        position = (last['local_album_id'] << 128) | UUID(str(last['ref'])).int
    return rows, encode_social_cursor(position, secret=cursor_secret, scope=scope)


def validate_draft_request(*, top_ref, payload, context_ref):
    expected = {'revision', 'draft_ref', 'draft_revision', 'row_ref', 'item_ref',
                'album_ref', 'cursor', 'limit'}
    if type(payload) is not dict or set(payload) != expected:
        raise AlbumTopError('invalid_query')
    # Reuse the saved query's bounded scalar/context/cursor checks without
    # inventing a saved row identity for a new local selection.
    values = validate_request(top_ref=top_ref, item_ref=payload['row_ref'],
        revision=payload['revision'], context_ref=context_ref,
        cursor=payload['cursor'], limit=payload['limit'])
    try:
        draft_ref, row_ref = top_uuid(payload['draft_ref']), top_uuid(payload['row_ref'])
        album_ref = top_uuid(payload['album_ref'])
        item_ref = top_uuid(payload['item_ref']) if payload['item_ref'] is not None else None
        draft_revision = top_revision(payload['draft_revision'])
        if '00000000-0000-0000-0000-000000000000' in (values['top_ref'], draft_ref, row_ref, album_ref, item_ref):
            raise AlbumTopError('invalid_query')
    except AlbumTopError:
        raise AlbumTopError('invalid_query') from None
    return {**values, 'item_ref': item_ref, 'album_ref': album_ref, 'draft_ref': draft_ref,
            'draft_revision': draft_revision, 'row_ref': row_ref}


def read_draft_sources(owner, connection, live, *, top_ref, revision, draft_ref,
                       draft_revision, row_ref, item_ref, album_ref, context_ref,
                       cursor, limit, cursor_secret, constraints):
    top = owner._top(connection, live, top_ref)
    owner._require(live, _ACTIONS, constraints, top, owner_only=True)
    publication.lock_link(connection, top)
    if str(top['revision']) != revision:
        raise AlbumTopError('revision_conflict', 409)
    if item_ref is not None:
        item = connection.execute('''select ref from app.album_list_items
            where top_ref=%s and library_id=%s and ref=%s and catalog_ref=%s''',
            (top_ref, live.library_id, item_ref, album_ref)).fetchone()
        if item is None:
            raise AlbumTopError('item_unavailable', 404)
    elif connection.execute('''select ref from app.album_list_items
            where top_ref=%s and library_id=%s and catalog_ref=%s''',
            (top_ref, live.library_id, album_ref)).fetchone() is not None:
        raise AlbumTopError('items_changed', 409)
    generation = evidence.source_barrier(connection, live.library_id)
    if connection.execute('''select 1 from library.catalog_album_links
            where library_id=%s and catalog_ref=%s limit 1''',
            (live.library_id, album_ref)).fetchone() is None:
        raise AlbumTopError('item_unavailable', 404)
    scope = ['album-top-artwork-draft-sources-v1', live.actor.account_id, live.actor.session_id,
        live.library_id, context_ref, top_ref, revision, draft_ref, draft_revision, row_ref,
        item_ref, album_ref, str(generation), limit]
    rows, next_cursor = _source_page(owner, connection, live, top, album_ref, item_ref,
        scope, cursor, limit, cursor_secret, constraints)
    return {'top_ref': top_ref, 'revision': revision, 'draft_ref': draft_ref,
        'draft_revision': draft_revision, 'row_ref': row_ref, 'item_ref': item_ref,
        'album_ref': album_ref, 'sources': rows, 'next_cursor': next_cursor}
