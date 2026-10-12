"""Retain every Queue occurrence's read authority through Create and Add."""
import json
import re

from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.owned_playlists import (
    BROWSE, COMPLETE_INVENTORY_PROTOCOL, MAX_PLAYLIST_ITEMS_PER_COMMAND,
    PlaylistError, inventory_identity, playlist_revision, uuid_ref,
)
from music_app.services.policy import ResourceScope
from music_app.services import playlist_activity_sources as activity
from music_app.services import playlist_creation_sources_postgres as sources

QUEUE_VERSION = 'queue_occurrences_v1'


def normalize_occurrences(value, library_id):
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_PLAYLIST_ITEMS_PER_COMMAND:
        raise PlaylistError('invalid_command')
    result = []
    fields = {'inventory': {'kind', 'track_ref'},
              'activity': {'kind', 'track_ref', 'origin', 'row_ref'},
              'playlist': {'kind', 'track_ref', 'playlist_ref', 'revision', 'item_ref'}}
    for row in value:
        if not isinstance(row, dict) or not isinstance(row.get('kind'), str) or row['kind'] not in fields or set(row) != fields[row['kind']]:
            raise PlaylistError('invalid_command')
        library, _ = inventory_identity(row['track_ref'])
        if library != library_id:
            raise PlaylistError('source_unavailable', 404)
        item = {'kind': row['kind'], 'track_ref': row['track_ref']}
        if row['kind'] == 'activity':
            if not isinstance(row['row_ref'], str) or not re.fullmatch(r'activity_[a-f0-9]{64}', row['row_ref']):
                raise PlaylistError('invalid_command')
            item.update(origin=activity.normalize_activity_origin(row['origin']), row_ref=row['row_ref'])
        elif row['kind'] == 'playlist':
            item.update(playlist_ref=uuid_ref(row['playlist_ref']), revision=playlist_revision(row['revision']),
                        item_ref=uuid_ref(row['item_ref']))
        result.append(item)
    return result


def is_queue(source):
    return (source.get('origin_descriptor') or {}).get('queue') == QUEUE_VERSION


def _subject_refs(occurrences):
    return sorted({row['origin']['subject_ref'] for row in occurrences
                   if row['kind'] == 'activity' and row['origin']['audience'] == 'friend'})


def lock_targets(owner, context, *, source_ref=None, occurrences=None, constraints=None):
    """Read private lock keys only; full authorization occurs after all locks."""
    owner._require(context, (BROWSE,), constraints)
    with owner._connect(owner._url) as connection:
        if source_ref is not None:
            row = connection.execute('''select origin_descriptor from app.playlist_creation_sources
                where ref=%s and actor_account_id=%s and session_id=%s and library_id=%s
                  and protocol=%s and source_kind='library' ''',
                (source_ref, context.actor.account_id, context.actor.session_id, context.library_id,
                 COMPLETE_INVENTORY_PROTOCOL)).fetchone()
            origin = (row or {}).get('origin_descriptor') or {}
            refs = origin.get('subject_refs', []) if origin.get('queue') == QUEUE_VERSION else []
        else:
            refs = _subject_refs(occurrences)
        if not refs:
            return ()
        rows = connection.execute('''select p.account_id from app.social_profiles p
            join library.library_memberships m on m.account_id=p.account_id and m.library_id=%s
            where p.account_ref=any(%s::uuid[]) order by p.account_id''',
            (context.library_id, refs)).fetchall()
        return tuple(row['account_id'] for row in rows)


def lock_playlists(connection, context, refs, *, destination=None):
    # Source/destination overlap and opposite Add directions must take the same
    # parent order. UPDATE avoids a later shared-to-exclusive lock upgrade.
    refs = sorted(set(refs) | ({destination} if destination is not None else set()))
    if refs:
        connection.execute('''select ref from app.playlists where library_id=%s
            and ref=any(%s::uuid[]) order by ref for update''', (context.library_id, refs)).fetchall()


def _resolve(owner, connection, context, occurrences, constraints):
    """Resolve exact receipts without a playback probe or label matching."""
    groups = {}
    playlist_items = {}
    for row in occurrences:
        if row['kind'] == 'activity':
            key = json.dumps(row['origin'], sort_keys=True)
            groups.setdefault(key, {'origin': row['origin'], 'refs': []})['refs'].append(row['row_ref'])
        elif row['kind'] == 'playlist':
            playlist_items.setdefault(row['playlist_ref'], set()).add(row['item_ref'])
    exported = {}
    for key in sorted(groups):
        group = groups[key]
        rows = activity._export(connection, context, group['origin'], list(dict.fromkeys(group['refs'])),
                                config=owner._config, constraints=constraints)
        exported[key] = {row['row_ref']: row for row in rows}
    playlists = {}
    for ref in sorted(playlist_items):
        playlist = owner._playlist(connection, context, ref)
        owner._require(context, (BROWSE,), constraints, playlist)
        item_refs = sorted(playlist_items[ref])
        items = connection.execute('''select ref,local_track_id from app.playlist_items
            where playlist_ref=%s and ref=any(%s::uuid[])''', (ref, item_refs)).fetchall()
        playlists[ref] = (playlist, {str(item['ref']): item['local_track_id'] for item in items})
    result = []
    for occurrence in occurrences:
        row = dict(occurrence)
        _, track_id = inventory_identity(row['track_ref'])
        if not owner._resource_allowed(context, BROWSE, ResourceScope('track', str(track_id)), constraints):
            raise PlaylistError('source_unavailable', 403)
        if row['kind'] == 'activity':
            current = exported[json.dumps(row['origin'], sort_keys=True)][row['row_ref']]
            resource = current['canonical_resource']
            if resource is None or resource['kind'] != 'track' or resource['id'] != track_id:
                raise PlaylistError('source_changed', 409)
            row['activity_lineage'] = current['lineage']
        elif row['kind'] == 'playlist':
            playlist, items = playlists[row['playlist_ref']]
            if str(playlist['revision']) != row['revision'] or items.get(row['item_ref']) != track_id:
                raise PlaylistError('source_changed', 409)
        result.append(row)
    return result


def capture(owner, context, occurrences, *, constraints=None):
    from psycopg.types.json import Jsonb
    from music_app.services.playlist_complete_sources import _header
    occurrences = normalize_occurrences(occurrences, context.library_id)
    targets = lock_targets(owner, context, occurrences=occurrences, constraints=constraints)
    with owner._authorized(context, constraints, target_account_ids=targets) as (connection, live, now):
        owner._require(live, (BROWSE,), constraints)
        playlist_refs = sorted({row['playlist_ref'] for row in occurrences if row['kind'] == 'playlist'})
        lock_playlists(connection, live, playlist_refs)
        ids = list(dict.fromkeys(inventory_identity(row['track_ref'])[1] for row in occurrences))
        current = sources.inventory_rows(connection, live.library_id, ids, lock=True, config=owner._config)
        if set(current) != set(ids):
            raise PlaylistError('source_changed', 409)
        now = lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                                        actor_session_id=live.actor.session_id, clock=owner._clock)
        resolved = _resolve(owner, connection, live, occurrences, constraints)
        origin = {'queue': QUEUE_VERSION, 'subject_refs': _subject_refs(occurrences), 'playlist_refs': playlist_refs}
        source = _header(connection, live, now, protocol=COMPLETE_INVENTORY_PROTOCOL, kind='library', origin=origin)
        lineages = {identity: [] for identity in ids}
        for row in resolved:
            lineages[inventory_identity(row['track_ref'])[1]].append(row)
        captured = [{**current[identity], 'source_lineage': {'queue': QUEUE_VERSION, 'occurrences': lineages[identity]}}
                    for identity in ids]
        rows = sources._observe_page(connection, source, captured)
        origin['entry_order'] = [str(row['ref']) for row in rows]
        connection.execute('update app.playlist_creation_sources set origin_descriptor=%s where ref=%s',
                           (Jsonb(origin), source['ref']))
        return {'status': 'ready', 'data': {**sources.source_envelope(source), 'entries_complete': True,
            'entries': [sources.project_entry(source, row, album_readable=lambda album_id: owner._resource_allowed(
                live, BROWSE, ResourceScope('album', str(album_id)), constraints)) for row in rows],
            'retained_parent_albums': [], 'actor_scope': owner._scope(live)}}


def selected(owner, connection, context, source, entry_refs, *, constraints=None, destination=None):
    if not is_queue(source):
        raise PlaylistError('source_changed', 409)
    origin = source['origin_descriptor']
    requested = list(entry_refs)
    if not requested:
        entry_refs = origin.get('entry_order')
        if not isinstance(entry_refs, list) or not entry_refs:
            raise PlaylistError('source_changed', 409)
    lock_playlists(connection, context, origin['playlist_refs'], destination=destination)
    stored = connection.execute('''select * from app.playlist_creation_entries
        where source_ref=%s and ref=any(%s::uuid[])''', (source['ref'], entry_refs)).fetchall()
    by_ref = {str(row['ref']): sources._plain(row) for row in stored}
    if set(by_ref) != set(entry_refs):
        raise PlaylistError('source_unavailable', 409)
    rows = [by_ref[ref] for ref in entry_refs]
    occurrences = []
    retained = []
    for row in rows:
        lineage = row.get('source_lineage') or {}
        if lineage.get('queue') != QUEUE_VERSION or not lineage.get('occurrences'):
            raise PlaylistError('source_changed', 409)
        retained.extend(lineage['occurrences'])
        for occurrence in lineage['occurrences']:
            clean = {key: value for key, value in occurrence.items() if key != 'activity_lineage'}
            if inventory_identity(clean['track_ref'])[1] != row['original_local_track_id']:
                raise PlaylistError('source_changed', 409)
            occurrences.append(clean)
    selected_rows = sources.selected_entries(connection, context, source, entry_refs, config=owner._config)
    # Empty Create still validates its complete retained source authority.
    if occurrences:
        occurrences = normalize_occurrences(occurrences, context.library_id)
        if _resolve(owner, connection, context, occurrences, constraints) != retained:
            raise PlaylistError('source_changed', 409)
    return selected_rows if requested else []
