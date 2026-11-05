"""Publish relation changes from indexed album facts, without a library snapshot."""
from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Mapping
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
from time import perf_counter

from music_app.services.relation_projection_builder import (
    CURRENT_ALIAS_POLICY, LEGACY_ALIAS_POLICY,
    _album_facts, _display_choice, _is_va_name, _low_value_artist_key,
    _normalize_key, build_postgres_relation_views, serialized_family_key,
)
from music_app.services.relation_projection_postgres import _first_row

_LIST_KEYS = {'artists': None, 'artists_sidebar': 'artist', 'sidebar_families': 'family'}
_MAP_KEYS = ('alias_to_canonical', 'canonical_to_aliases', 'family_to_artists', 'folder_related')
_CONTEXT = """
    select libraries.id as library_id,
      libraries.metadata #> '{scan_cache,relation_projection}' as metadata,
      libraries.metadata #>> '{scan_cache,relations_last_built}' as relations_last_built,
      libraries.metadata ->> 'inventory_mutation_revision' as inventory_mutation_revision,
      state.builder_version as normalized_builder_version,
      state.source_fingerprint as normalized_source_fingerprint,
      state.last_publication_xid::text as normalized_publication_xid,
      gallery.generation as gallery_generation,
      gallery.last_invalidation_xid=pg_current_xact_id_if_assigned() as gallery_owned
    from app.bootstrap_owners owners
    join library.libraries on libraries.owner_account_id=owners.account_id
      and libraries.name='Local Library' and libraries.library_kind='local'
    left join library.local_relation_projection_state state on state.library_id=libraries.id
    left join library.gallery_projection_state gallery on gallery.library_id=libraries.id
    where owners.owner_key='local-bootstrap-owner'
"""


def _jsonb(value):
    from music_app.services.relation_projection_postgres import _jsonb as adapt
    return adapt(value)


def _low_value(name):
    return _is_va_name(name) or _normalize_key(name) in {'', 'unknown artist', 'unknown'}


def _fact_records(rows, album_keys):
    grouped = defaultdict(list)
    for row in rows:
        grouped[int(row['album_id'])].append(dict(row))
    records = []
    for fact in _album_facts(rows):
        names = set((fact.album_artist, *fact.artists)) - {''}
        connections = {
            prefix + key for name in names if not _low_value(name)
            for prefix, key in (('artist:', _normalize_key(name)), ('signature:', _low_value_artist_key(name)))
            if key
        }
        connections.update('container:' + serialized_family_key(location.library_root_id, location.relative_parts[:2])
                           for location in fact.locations)
        low_names = sorted(name for name in names if _low_value(name))
        records.append({
            'album_id': fact.album_id, 'album_key': album_keys[fact.album_id],
            'source_rows': sorted(grouped[fact.album_id], key=lambda row: json.dumps(row, sort_keys=True, default=str)),
            'connection_keys': sorted(connections),
            'low_value_keys': sorted({_normalize_key(name) for name in low_names}),
            'low_value_artists': [{'name': name, 'key': _normalize_key(name)} for name in low_names],
        })
    return records


def _view_entries(views):
    result = []
    for section, member in _LIST_KEYS.items():
        for value in views.get(section, []):
            key = str(value if member is None else value[member])
            names = value.get('artists', []) if section == 'sidebar_families' else [key]
            result.append({'section': section, 'entry_key': key, 'payload': value, 'artist_names': sorted(set(names)),
                           'low_value_keys': sorted({_normalize_key(name) for name in names if _low_value(name)})})
    for section in _MAP_KEYS:
        for key, value in views.get(section, {}).items():
            values = [value] if isinstance(value, str) else sorted(value) if isinstance(value, set) else list(value)
            names = values if section == 'family_to_artists' else [key] if section == 'folder_related' else [key, *values]
            result.append({'section': section, 'entry_key': key, 'payload': values if isinstance(value, set) else value,
                           'artist_names': sorted(set(names)),
                           'low_value_keys': sorted({_normalize_key(name) for name in [*names, *values] if _low_value(name)})})
    for entry in result:
        entry['sort_key'] = str(entry['payload'].get('label') or entry['entry_key']).casefold() if entry['section'] == 'sidebar_families' else entry['entry_key'].casefold()
        if entry['section'] in {'family_to_artists', 'sidebar_families'}:
            family = json.loads(entry['entry_key'])
            entry['connection_keys'] = ['container:' + json.dumps(family[:3], ensure_ascii=False, separators=(',', ':'))]
            entry['artist_names'] = [name for name in entry['artist_names'] if not _low_value(name)]
        else:
            entry['connection_keys'] = sorted({'low:' + _normalize_key(name) for name in entry['artist_names'] if _low_value(name)})
    return result


def _upsert_facts(connection, library_id, records):
    connection.execute("""insert into library.local_relation_album_facts
        (library_id,album_id,album_key,source_rows,connection_keys,low_value_keys,low_value_artists)
        select %(library_id)s, album_id, album_key, source_rows, connection_keys, low_value_keys, low_value_artists
        from jsonb_to_recordset(%(rows)s::jsonb) as r(album_id bigint,album_key text,source_rows jsonb,
          connection_keys text[],low_value_keys text[],low_value_artists jsonb)
        on conflict (library_id,album_id) do update set album_key=excluded.album_key,
          source_rows=excluded.source_rows,connection_keys=excluded.connection_keys,
          low_value_keys=excluded.low_value_keys,low_value_artists=excluded.low_value_artists""",
        {'library_id': library_id, 'rows': _jsonb(records)})


def _entry_table(compatibility):
    return ('library.local_relation_compatibility_entries' if compatibility
            else 'library.local_relation_projection_entries')


def _upsert_entries(connection, library_id, entries, *, compatibility=False):
    connection.execute(f"""insert into {_entry_table(compatibility)}
        (library_id,section,entry_key,payload,sort_key,artist_names,connection_keys,low_value_keys)
        select %(library_id)s,section,entry_key,payload,sort_key,artist_names,connection_keys,low_value_keys
        from jsonb_to_recordset(%(rows)s::jsonb) as r(section text,entry_key text,payload jsonb,sort_key text,artist_names text[],connection_keys text[],low_value_keys text[])
        on conflict (library_id,section,entry_key) do update
          set payload=excluded.payload,sort_key=excluded.sort_key,artist_names=excluded.artist_names,connection_keys=excluded.connection_keys,low_value_keys=excluded.low_value_keys""",
        {'library_id': library_id, 'rows': _jsonb(entries)})


def replace_scoped_relation_projection(connection, rows, views, *, metadata, relations_last_built=None):
    """Seed during explicit full publication; never called by an interactive edit."""
    from music_app.services.relation_projection_postgres import RELATION_PROJECTION_BUILDER_VERSION
    from music_app.services.cache import serialize_relation_views
    context = _first_row(connection.execute(_CONTEXT))
    if context is None:
        raise RuntimeError('Relation publication could not resolve the local library.')
    library_id = context['library_id']
    ids = sorted({int(row['album_id']) for row in rows})
    keys = {row['id']: row['album_key'] for row in connection.execute(
        'select id,album_key from library.local_albums where library_id=%s and id=any(%s)', (library_id, ids)).fetchall()}
    records = _fact_records(rows, keys)
    connection.execute('delete from library.local_relation_album_facts where library_id=%s', (library_id,))
    connection.execute('delete from library.local_relation_projection_entries where library_id=%s', (library_id,))
    _upsert_facts(connection, library_id, records)
    _upsert_entries(connection, library_id, _view_entries(serialize_relation_views(views)))
    connection.execute("""insert into library.local_relation_projection_state(library_id,builder_version,source_fingerprint,last_publication_xid)
        values (%s,%s,%s,pg_current_xact_id()) on conflict(library_id) do update
        set builder_version=excluded.builder_version,source_fingerprint=excluded.source_fingerprint,
          last_publication_xid=excluded.last_publication_xid,initialized_at=now()""",
        (library_id, RELATION_PROJECTION_BUILDER_VERSION, metadata['source_fingerprint']))

    legacy_views = build_postgres_relation_views(rows, alias_policy=LEGACY_ALIAS_POLICY)
    connection.execute('delete from library.local_relation_compatibility_entries where library_id=%s', (library_id,))
    _upsert_entries(connection, library_id, _view_entries(legacy_views), compatibility=True)
    stamp = float(relations_last_built or context.get('relations_last_built') or 0)
    from music_app.services import relation_projection_postgres as relations
    from music_app.services.artist_family_postgres import replace_artist_family_projection_in_transaction
    relations.replace_artist_search_projection_in_transaction(
        connection, legacy_views, metadata=metadata, relations_last_built=stamp, legacy=True)
    replace_artist_family_projection_in_transaction(
        connection, legacy_views, relations_last_built=stamp, legacy=True)
    _store_compatibility_state(connection, library_id, metadata, stamp)
    return serialize_relation_views(legacy_views)


def _names(records):
    return {name for record in records for fact in _album_facts(record['source_rows'])
            for name in (fact.album_artist, *fact.artists) if name}


def _restore_low_value_counts(connection, library_id, views, keys):
    if not keys:
        return {}
    rows = connection.execute("""select artist.name,artist.key,count(*) as count
        from library.local_relation_album_facts facts
        cross join lateral jsonb_to_recordset(facts.low_value_artists) as artist(name text,key text)
        where facts.library_id=%s and facts.low_value_keys && %s::text[] and artist.key=any(%s::text[])
        group by artist.name,artist.key""", (library_id, sorted(keys), sorted(keys))).fetchall()
    groups = defaultdict(Counter)
    for row in rows:
        groups[row['key']][row['name']] = int(row['count'])
    for section in ('alias_to_canonical', 'canonical_to_aliases', 'folder_related'):
        views[section] = {name: value for name, value in views[section].items() if _normalize_key(name) not in keys}
    views['artists'] = [name for name in views['artists'] if _normalize_key(name) not in keys]
    views['artists_sidebar'] = [row for row in views['artists_sidebar'] if _normalize_key(row['artist']) not in keys]
    canonical_names = {}
    for key, counts in groups.items():
        canonical = _display_choice(list(counts), counts)
        canonical_names[key] = canonical
        views['artists'].append(canonical)
        views['artists_sidebar'].append({'artist': canonical, 'count': sum(counts.values())})
        views['canonical_to_aliases'][canonical] = sorted(counts, key=str.casefold)
        views['alias_to_canonical'].update({name: canonical for name in counts})
    for section in ('family_to_artists', 'folder_related'):
        views[section] = {
            (canonical_names.get(_normalize_key(name), name) if section == 'folder_related' else name):
            {canonical_names.get(_normalize_key(member), member) for member in members}
            for name, members in views[section].items()
        }
    for row in views['sidebar_families']:
        row['artists'] = sorted({canonical_names.get(_normalize_key(name), name) for name in row['artists']}, key=str.casefold)
        row['count'] = len(row['artists'])
    return canonical_names


def _refresh_low_value_family_references(connection, library_id, views, canonical_names, *, compatibility=False):
    if not canonical_names:
        return []
    previous = connection.execute(f"""select section,entry_key,payload from {_entry_table(compatibility)}
        where library_id=%s and section in ('family_to_artists','sidebar_families','folder_related')
          and low_value_keys && %s::text[]""", (library_id, sorted(canonical_names))).fetchall()
    related = {name: set() for name in canonical_names.values()}
    changed = []
    for row in previous:
        section, key, payload = row['section'], row['entry_key'], row['payload']
        members = payload['artists'] if section == 'sidebar_families' else payload
        renamed = sorted({canonical_names.get(_normalize_key(name), name) for name in members}, key=str.casefold)
        if section == 'family_to_artists':
            for name in related:
                if name in renamed:
                    related[name].update(set(renamed) - {name})
        if renamed != sorted(members, key=str.casefold):
            changed.append(row)
            if section == 'sidebar_families':
                replacement = {**payload, 'artists': renamed, 'count': len(renamed)}
                views[section] = [entry for entry in views[section] if entry['family'] != key] + [replacement]
            else:
                views[section][key] = set(renamed)
    views['folder_related'].update({name: members for name, members in related.items() if members})
    return changed


def _artist_connection_keys(names):
    return {prefix + key for name in names if not _low_value(name)
            for prefix, key in (('artist:', _normalize_key(name)), ('signature:', _low_value_artist_key(name)))
            if key}


def _load_affected_component(connection, library_id, old, new, cancel_requested, *, include_compatibility=False):
    """Coappearance supplies counts; only aliases and actual families propagate."""
    from music_app.services import relation_projection_postgres as relations
    names = _names([*old, *new])
    component = {row['album_id']: row for row in new}
    containers = {key for row in [*old, *new] for key in row['connection_keys'] if key.startswith('container:')}
    searched = set()
    while True:
        relations._raise_if_projection_cancelled(cancel_requested)
        # Removed alias/family edges need their surviving owners refreshed too.
        previous = connection.execute("""select artist_names from library.local_relation_projection_entries
            where library_id=%s and section in ('canonical_to_aliases','family_to_artists')
              and (artist_names && %s::text[] or connection_keys && %s::text[])""",
            (library_id, sorted(names), sorted(containers))).fetchall()
        if include_compatibility:
            previous.extend(connection.execute("""select artist_names from library.local_relation_compatibility_entries
              where library_id=%s and section in ('canonical_to_aliases','family_to_artists')
              and (artist_names && %s::text[] or connection_keys && %s::text[])""",
              (library_id, sorted(names), sorted(containers))).fetchall())
        names.update(name for entry in previous for name in entry['artist_names'])
        keys = _artist_connection_keys(names) | containers
        batch = keys - searched
        if not batch:
            break
        searched.update(batch)
        related = connection.execute("""select * from library.local_relation_album_facts
            where library_id=%s and connection_keys && %s::text[]""", (library_id, sorted(batch))).fetchall()
        component.update((row['album_id'], row) for row in related)
        views = build_postgres_relation_views(
            [source for record in component.values() for source in record['source_rows']],
            cooperate=(lambda: relations._cooperate_with_foreground(cancel_requested)) if cancel_requested is not None else None)
        alias_views = [views]
        if include_compatibility:
            alias_views.append(build_postgres_relation_views(
                [source for record in component.values() for source in record['source_rows']],
                alias_policy=LEGACY_ALIAS_POLICY,
                cooperate=(lambda: relations._cooperate_with_foreground(cancel_requested)) if cancel_requested is not None else None))
        for policy_views in alias_views:
            for canonical, aliases in policy_views['canonical_to_aliases'].items():
                if names.intersection([canonical, *aliases]):
                    names.update([canonical, *aliases])
            for members in policy_views['family_to_artists'].values():
                if names.intersection(members):
                    names.update(members)
        # Loading a soundtrack for A's count must not walk B's discography.
        target_keys = _artist_connection_keys(names)
        for record in component.values():
            if target_keys.intersection(record['connection_keys']):
                containers.update(key for key in record['connection_keys'] if key.startswith('container:'))
    views = build_postgres_relation_views(
        [source for record in component.values() for source in record['source_rows']],
        cooperate=(lambda: relations._cooperate_with_foreground(cancel_requested)) if cancel_requested is not None else None)
    _restrict_component_views(views, names)
    return component, names, searched, views


def _restrict_component_views(views, names):
    canonical_names = {views['alias_to_canonical'].get(name, name) for name in names}
    views['artists'] = [name for name in views['artists'] if name in canonical_names]
    views['artists_sidebar'] = [entry for entry in views['artists_sidebar'] if entry['artist'] in canonical_names]
    views['alias_to_canonical'] = {name: canonical for name, canonical in views['alias_to_canonical'].items() if canonical in canonical_names}
    views['canonical_to_aliases'] = {name: aliases for name, aliases in views['canonical_to_aliases'].items() if name in canonical_names}
    views['folder_related'] = {name: members for name, members in views['folder_related'].items() if name in canonical_names}
    views['family_to_artists'] = {key: members for key, members in views['family_to_artists'].items() if canonical_names.intersection(members)}
    views['sidebar_families'] = [entry for entry in views['sidebar_families'] if entry['family'] in views['family_to_artists']]
    return views


def _published_aliases(connection, library_id, names):
    if not names:
        return {}
    rows = connection.execute("""select entry_key,payload from library.local_relation_projection_entries
        where library_id=%s and section='alias_to_canonical' and entry_key=any(%s::text[])""",
        (library_id, sorted(names))).fetchall()
    return {row['entry_key']: row['payload'] for row in rows}


def _scan_journal_receipt(connection, library_id):
    return _first_row(connection.execute("""select coalesce(jsonb_agg(to_jsonb(dirty)
      order by album_id), '[]'::jsonb) as journal
      from library.local_relation_dirty_albums dirty where library_id=%s""", (library_id,)))['journal']


def _relation_views_equal(left, right):
    if not isinstance(left, dict) or not isinstance(right, dict) or left.keys() != right.keys():
        return False
    if left.keys() != (set(_LIST_KEYS) | set(_MAP_KEYS)):
        return False
    def members(values):
        if not isinstance(values, (list, tuple, set)) or not all(isinstance(value, str) for value in values):
            raise TypeError('Relation members must be text collections')
        return sorted(values, key=lambda value: (value.casefold(), value))
    def canonical(views):
        # Preserve every field and duplicate; only unordered member collections move.
        if not all(isinstance(views[section], dict) for section in _MAP_KEYS):
            raise TypeError('Relation mappings must be objects')
        for section in ('artists_sidebar', 'sidebar_families'):
            if not isinstance(views[section], list) or not all(isinstance(row, dict) for row in views[section]):
                raise TypeError('Relation sidebar rows must be objects')
        result = {**views, 'artists': members(views['artists'])}
        for section in ('family_to_artists', 'folder_related', 'canonical_to_aliases'):
            result[section] = {key: members(values) for key, values in views[section].items()}
        result['sidebar_families'] = [
            {**row, 'artists': members(row['artists'])} for row in views['sidebar_families']]
        return result
    try:
        return canonical(left) == canonical(right)
    except (AttributeError, KeyError, TypeError):
        return False


def pending_scan_baseline(connection):
    """Retain the proven legacy contract before a native scan changes sources."""
    context = _first_row(connection.execute(_CONTEXT))
    if not context or not context.get('normalized_builder_version'):
        return None
    state = _compatibility_state(connection, context['library_id'])
    if state is None:
        return None
    if (state['source_fingerprint'] != context.get('normalized_source_fingerprint')
            or state['publication_xid'] != context.get('normalized_publication_xid')):
        raise RuntimeError('Pending scan baseline is not proven.')
    shadow = _first_row(connection.execute(
        'select library.local_relation_compatibility_views(%s) as views', (context['library_id'],)))['views']
    if not _relation_views_equal(shadow, _stored_legacy_views(connection, context['library_id'])):
        raise RuntimeError('Retained legacy relations differ from the proven baseline.')
    if state.get('pending_scan_receipt') is not None:
        raise RuntimeError('Pending scan must be reconciled before publishing another scan.')
    return {'library_id': context['library_id'], 'legacy_views': shadow,
            'baseline_fingerprint': state['source_fingerprint'],
            'baseline_publication_xid': state['publication_xid'],
            'current_semantics': state['current_semantics'], 'legacy_semantics': state['legacy_semantics']}


def record_pending_scan_receipt(connection, baseline, metadata):
    """Bind the final dirty journal to this native scan's atomic publication."""
    if baseline is None or metadata.get('status') != 'stale':
        return
    if (metadata.get('rebuild_reason') != 'scan_inventory_changed'
            or metadata.get('built_from_fingerprint') != baseline['baseline_fingerprint']):
        raise RuntimeError('Pending scan does not retain its proven baseline.')
    journal = _scan_journal_receipt(connection, baseline['library_id'])
    if not journal:
        raise RuntimeError('Pending scan has no dirty journal evidence.')
    receipt = {key: value for key, value in baseline.items() if key != 'legacy_views'}
    receipt.update(source_fingerprint=metadata['source_fingerprint'], journal=journal,
                   capture_xid=_first_row(connection.execute('select pg_current_xact_id()::text as xid'))['xid'])
    connection.execute('update library.local_relation_compatibility_state set pending_scan_receipt=%s,pending_scan_xid=pg_current_xact_id() where library_id=%s',
                       (_jsonb(receipt), baseline['library_id']))


def _validate_pending_scan_receipt(connection, context, state, metadata, retained):
    receipt = state.get('pending_scan_receipt') if state else None
    expected = {
        'library_id': context['library_id'],
        'baseline_fingerprint': context['normalized_source_fingerprint'],
        'baseline_publication_xid': context['normalized_publication_xid'],
        'current_semantics': CURRENT_ALIAS_POLICY, 'legacy_semantics': LEGACY_ALIAS_POLICY,
        'source_fingerprint': metadata.get('source_fingerprint'),
        'journal': _scan_journal_receipt(connection, context['library_id']),
    }
    capture_xid = str(receipt.get('capture_xid', '')) if isinstance(receipt, dict) else ''
    if (not capture_xid or capture_xid != str(state.get('pending_scan_transaction'))
            or not isinstance(receipt, dict)
            or not expected['journal']
            or any(receipt.get(key) != value for key, value in expected.items())
            or float(context.get('relations_last_built') or 0) != state['relations_last_built']
            or metadata.get('rebuild_reason') != 'scan_inventory_changed'
            or metadata.get('built_from_fingerprint') != expected['baseline_fingerprint']):
        raise RuntimeError('Pending scan receipt does not match retained publication evidence.')
    shadow = _first_row(connection.execute(
        'select library.local_relation_compatibility_views(%s) as views', (context['library_id'],)))['views']
    if not _relation_views_equal(shadow, retained):
        raise RuntimeError('Retained legacy relations differ from the pending scan baseline.')


def publish_affected_relation_projection(connection, *, album_ids=(), album_keys=(), track_paths=(), reason='structural_tag_edit', config=None, cancel_requested=None, expected_gallery_generation=None, prepare_compatibility=False):
    from music_app.services import relation_projection_postgres as relations
    context = _first_row(connection.execute(_CONTEXT))
    if context is None or context.get('normalized_builder_version') != relations.RELATION_PROJECTION_BUILDER_VERSION:
        raise RuntimeError('Library relation index is not ready. Finish library startup before editing tags.')
    library_id = context['library_id']
    compatibility_state = _compatibility_state(connection, library_id)
    if compatibility_state is None and not prepare_compatibility:
        raise RuntimeError('Relation compatibility preparation is required before editing tags.')
    if compatibility_state is not None and not prepare_compatibility and (
        compatibility_state['source_fingerprint'] != context.get('normalized_source_fingerprint')
        or compatibility_state['publication_xid'] != context.get('normalized_publication_xid')
    ):
        raise RuntimeError('Relation compatibility evidence changed; explicit preparation is required.')
    metadata = dict(context.get('metadata') or {})
    normalized_fingerprint = context.get('normalized_source_fingerprint')
    fingerprint_changed = normalized_fingerprint is not None and (
        metadata.get('source_fingerprint') != normalized_fingerprint
        or metadata.get('built_from_fingerprint') != normalized_fingerprint
    )
    replay_pending = reason == 'pending_source_changes'
    if fingerprint_changed and not replay_pending:
        raise RuntimeError('Library source evidence changed; explicit startup reconciliation is required.')
    if metadata.get('builder_version') != relations.RELATION_PROJECTION_BUILDER_VERSION:
        raise RuntimeError('Library relation index requires startup reconciliation before editing tags.')
    stamp = float(context.get('relations_last_built') or 0)
    ids = set(album_ids)
    keys = set(album_keys)
    legacy_views = None
    if replay_pending:
        dirty = connection.execute('select * from library.local_relation_dirty_albums where library_id=%s for update', (library_id,)).fetchall()
        ids.update(row['album_id'] for row in dirty)
        keys.update(key for row in dirty for key in row['album_keys'])
        if fingerprint_changed or any(row['album_id'] < 0 for row in dirty) or prepare_compatibility:
            # A legacy full publication is a token plus a complete canonical
            # contract, not permission to trust an arbitrary checksum. Capture
            # that contract before touching indexed facts and verify it again
            # against the scoped rebuild before acknowledging any journal row.
            legacy = relations._relation_projection_scan_cache_from_row(
                _first_row(connection.execute(relations._load_relation_projection_sql())))
            legacy['relation_views'] = _stored_legacy_views(connection, library_id)
            native_pending = metadata.get('status') == 'stale'
            if native_pending:
                _validate_pending_scan_receipt(connection, context, compatibility_state, metadata, legacy['relation_views'])
            invalid = None if native_pending else relations.relation_projection_stale_reason(legacy)
            if not invalid and not prepare_compatibility:
                current_snapshot = dict(legacy)
                current_snapshot['relation_views'] = _first_row(connection.execute(
                    'select library.local_relation_views(%s,true) as views', (library_id,)))['views']
                current_snapshot[relations.RELATION_PROJECTION_METADATA_KEY] = {
                    **metadata, 'status': 'ready', 'source_fingerprint': normalized_fingerprint,
                    'built_from_fingerprint': normalized_fingerprint,
                }
                current_snapshot['relations_last_built'] = compatibility_state['relations_last_built']
                invalid = relations.artist_search_projection_stale_reason(current_snapshot)
            if invalid:
                raise RuntimeError('Legacy publication cannot be replayed safely: ' + invalid)
            if native_pending:
                metadata['built_from_fingerprint'] = metadata['source_fingerprint']
            else:
                legacy_views = legacy['relation_views']
    current_albums = connection.execute("""select id,album_key from library.local_albums
        where library_id=%(library_id)s and (id=any(%(album_ids)s::bigint[]) or album_key=any(%(album_keys)s::text[])
          or id in (select tracks.album_id from library.local_track_files files
            join library.local_tracks tracks on tracks.id=files.track_id
            where tracks.library_id=%(library_id)s and files.private_path=any(%(paths)s::text[])))
        union all select 0 as id, null as album_key where exists (
          select 1 from library.local_track_files files join library.local_tracks tracks on tracks.id=files.track_id
          where tracks.library_id=%(library_id)s and tracks.album_id is null
            and files.private_path=any(%(paths)s::text[]))""",
        {'library_id': library_id, 'album_ids': sorted(ids), 'album_keys': sorted(keys), 'paths': sorted({variant for path in track_paths for variant in (str(path), str(Path(path)))})}).fetchall()
    ids.update(row['id'] for row in current_albums)
    old = connection.execute("""select * from library.local_relation_album_facts
        where library_id=%s and (album_id=any(%s::bigint[]) or album_key=any(%s::text[]))""",
        (library_id, sorted(ids), sorted(keys))).fetchall()
    ids.update(row['album_id'] for row in old)
    keys.update(row['album_key'] for row in old)
    if not replay_pending:
        unrelated = _first_row(connection.execute("""select 1 from library.local_relation_dirty_albums
            where library_id=%s and not (album_id=any(%s::bigint[]))
              and not (album_id=0 and first_change_xid is not distinct from pg_current_xact_id()) limit 1""", (library_id, sorted(ids))))
        if unrelated is not None:
            pending = connection.execute("""select album_id,first_inventory_revision,
                first_gallery_generation,first_change_xid::text,
                pg_current_xact_id()::text as publication_xid
                from library.local_relation_dirty_albums where library_id=%s
                  and not (album_id=any(%s::bigint[]))
                  and not (album_id=0 and first_change_xid is not distinct from pg_current_xact_id())
                order by album_id limit 5""", (library_id, sorted(ids))).fetchall()
            logging.getLogger(__name__).warning(
                'Scoped publication deferred: reason=%s library=%s expected_generation=%s affected_count=%s affected_sample=%s pending=%s',
                reason, library_id, expected_gallery_generation, len(ids), sorted(ids)[:5], pending)
            raise RuntimeError('Library changes are still being reconciled. Retry this edit when library preparation finishes.')
        dirty = connection.execute("""select * from library.local_relation_dirty_albums
            where library_id=%s and (album_id=any(%s::bigint[])
              or (album_id=0 and first_change_xid=pg_current_xact_id())) for update""", (library_id, sorted(ids))).fetchall()
        keys.update(key for row in dirty for key in row['album_keys'])
    prior_generations = [row['first_gallery_generation'] for row in dirty if row.get('first_gallery_generation') is not None]
    if expected_gallery_generation is not None:
        prior_generations.append(expected_gallery_generation)
    rows = connection.execute(relations.load_relation_source_rows_sql(scoped=True), {'album_ids': sorted(ids)}).fetchall()
    current_keys = {row['id']: row['album_key'] for row in connection.execute(
        'select id,album_key from library.local_albums where library_id=%s and id=any(%s::bigint[])',
        (library_id, sorted(ids))).fetchall()}
    new = _fact_records(rows, current_keys)
    connection.execute('delete from library.local_relation_album_facts where library_id=%s and album_id=any(%s::bigint[])',
                       (library_id, sorted(ids)))
    _upsert_facts(connection, library_id, new)

    comparable = ('album_id', 'source_rows', 'connection_keys', 'low_value_keys', 'low_value_artists')
    old_values = {row['album_id']: {key: row[key] for key in comparable} for row in old}
    if old_values == {row['album_id']: {key: row[key] for key in comparable} for row in new}:
        names = _names(new)
        aliases = _published_aliases(connection, library_id, names)
        result = {
            'projection_mode': 'targeted', 'relation_view_patch': {'remove': {}, 'upsert': {}},
            'processed_relation_album_ids': [row['album_id'] for row in dirty],
            'relations_last_built': stamp, 'relation_patch_revision': int(context.get('inventory_mutation_revision') or 0),
            'first_gallery_generation': min(prior_generations) if prior_generations else None,
            'orphaned_source_artists': [], 'affected_relation_album_ids': sorted(ids),
            'affected_relation_album_keys': sorted(keys | set(current_keys.values())),
            'affected_relation_aliases': aliases,
        }
        return _finish_publication(connection, context, metadata, result, reason=reason, config=config,
                                   copy_legacy_views=False, legacy_views=legacy_views, prepare_compatibility=prepare_compatibility)

    component, affected_names, _, views = _load_affected_component(
        connection, library_id, old, new, cancel_requested,
        include_compatibility=compatibility_state is not None)
    previous_entries, low_display_albums = _patch_entry_contract(
        connection, library_id, views, affected_names)
    if compatibility_state is not None:
        legacy_component = _restrict_component_views(build_postgres_relation_views(
            [source for record in component.values() for source in record['source_rows']],
            alias_policy=LEGACY_ALIAS_POLICY,
        ), affected_names)
        _patch_entry_contract(connection, library_id, legacy_component, affected_names, compatibility=True)
        _patch_family_links(connection, legacy_component, affected_names, stamp, legacy=True)
        _patch_search_rows(connection, legacy_component, affected_names, metadata, stamp, legacy=True)
    _patch_family_links(connection, views, affected_names | set(views['folder_related']), stamp)
    _patch_search_rows(connection, views, affected_names, metadata, stamp)
    removals = defaultdict(list)
    for entry in previous_entries:
        removals[entry['section']].append(entry['entry_key'])
    result = {
        'projection_mode': 'targeted', 'relation_view_patch': {'remove': dict(removals), 'upsert': views},
        'processed_relation_album_ids': [row['album_id'] for row in dirty],
        'relations_last_built': stamp,
        'relation_patch_revision': int(context.get('inventory_mutation_revision') or 0),
        'first_gallery_generation': min(prior_generations) if prior_generations else None,
        'orphaned_source_artists': sorted(affected_names - set(views['alias_to_canonical'])),
        'affected_relation_aliases': views['alias_to_canonical'],
        'affected_relation_album_ids': sorted(ids | set(component) | {row['album_id'] for row in low_display_albums}),
        'affected_relation_album_keys': sorted(keys | {row['album_key'] for row in component.values()} | {row['album_key'] for row in low_display_albums}),
    }
    return _finish_publication(connection, context, metadata, result, reason=reason, config=config,
                               legacy_views=legacy_views, prepare_compatibility=prepare_compatibility)


def _patch_entry_contract(connection, library_id, views, affected_names, *, compatibility=False):
    low_keys = {_normalize_key(name) for name in affected_names if _low_value(name)}
    entry_connections = {'low:' + key for key in low_keys}
    previous_entries = connection.execute(f"""select section,entry_key,payload,artist_names
        from {_entry_table(compatibility)}
        where library_id=%s and (artist_names && %s::text[] or connection_keys && %s::text[])""",
        (library_id, sorted(affected_names), sorted(entry_connections))).fetchall()
    # Previous canonical choices can differ from the current source spelling.
    affected_names.update(name for entry in previous_entries for name in entry['artist_names'])
    canonical_low_names = _restore_low_value_counts(connection, library_id, views, low_keys)
    previous_low_names = {_normalize_key(entry['entry_key']): entry['entry_key'] for entry in previous_entries
                          if entry['section'] == 'canonical_to_aliases' and _low_value(entry['entry_key'])}
    changed_low_keys = [key for key, name in canonical_low_names.items() if previous_low_names.get(key) != name]
    low_display_albums = connection.execute(f"""select album_id,album_key from library.local_relation_album_facts
        where library_id=%s and low_value_keys && %s::text[]""", (library_id, changed_low_keys)).fetchall() if changed_low_keys else []
    entries = _view_entries(views)
    affected_names.update(name for entry in entries for name in entry['artist_names'])
    connection.execute(f"""delete from {_entry_table(compatibility)}
        where library_id=%s and (artist_names && %s::text[] or connection_keys && %s::text[])""",
        (library_id, sorted(affected_names), sorted(entry_connections)))
    _upsert_entries(connection, library_id, entries, compatibility=compatibility)
    previous_entries.extend(_refresh_low_value_family_references(connection, library_id, views, canonical_low_names, compatibility=compatibility))
    _upsert_entries(connection, library_id, _view_entries(views), compatibility=compatibility)
    return previous_entries, low_display_albums



def _stored_legacy_views(connection, library_id):
    row = _first_row(connection.execute(
        "select metadata #> '{scan_cache,relation_views}' as views from library.libraries where id=%s",
        (library_id,)))
    return row.get('views') if row else None


def _compatibility_state(connection, library_id):
    state = _first_row(connection.execute(
        'select *, pending_scan_xid::text as pending_scan_transaction, last_publication_xid::text as publication_xid from library.local_relation_compatibility_state where library_id=%s',
        (library_id,)))
    if state is not None and (
        state['legacy_semantics'] != LEGACY_ALIAS_POLICY
        or state['current_semantics'] != CURRENT_ALIAS_POLICY
    ):
        raise RuntimeError('Unknown relation compatibility semantics; journal retained.')
    return state


def _store_compatibility_state(connection, library_id, metadata, relations_last_built):
    connection.execute("""insert into library.local_relation_compatibility_state
      (library_id,legacy_semantics,current_semantics,source_fingerprint,relations_last_built,last_publication_xid)
      values (%s,%s,%s,%s,%s,pg_current_xact_id())
      on conflict(library_id) do update set
        legacy_semantics=excluded.legacy_semantics,current_semantics=excluded.current_semantics,
        source_fingerprint=excluded.source_fingerprint,relations_last_built=excluded.relations_last_built,last_publication_xid=excluded.last_publication_xid,
        pending_scan_receipt=NULL,pending_scan_xid=NULL""",
      (library_id, LEGACY_ALIAS_POLICY, CURRENT_ALIAS_POLICY, metadata['source_fingerprint'], relations_last_built))


def _prepare_compatibility_in_transaction(connection, context, metadata, captured_legacy_views):
    from music_app.services.cache import serialize_relation_views

    library_id = context['library_id']
    records = connection.execute(
        'select source_rows from library.local_relation_album_facts where library_id=%s order by album_id',
        (library_id,)).fetchall()
    rows = [source for record in records for source in record['source_rows']]
    current = serialize_relation_views(build_postgres_relation_views(rows))
    legacy = serialize_relation_views(build_postgres_relation_views(rows, alias_policy=LEGACY_ALIAS_POLICY))
    normalized = _first_row(connection.execute(
        'select library.local_relation_views(%s,true) as views', (library_id,)))
    if not normalized or not _relation_views_equal(normalized['views'], current):
        raise RuntimeError('Cached source facts differ from current normalized relations; journal retained.')
    if not _relation_views_equal(captured_legacy_views, legacy):
        raise RuntimeError('Legacy publication differs from the frozen legacy source rebuild; journal retained.')
    connection.execute('delete from library.local_relation_compatibility_entries where library_id=%s', (library_id,))
    _upsert_entries(connection, library_id, _view_entries(legacy), compatibility=True)
    from music_app.services import relation_projection_postgres as relations
    from music_app.services.artist_family_postgres import replace_artist_family_projection_in_transaction
    stamp = float(context.get('relations_last_built') or 0)
    for views, legacy_policy in ((current, False), (legacy, True)):
        relations.replace_artist_search_projection_in_transaction(
            connection, views, metadata=metadata, relations_last_built=stamp, legacy=legacy_policy)
        replace_artist_family_projection_in_transaction(
            connection, views, relations_last_built=stamp, legacy=legacy_policy)
    _store_compatibility_state(connection, library_id, metadata, stamp)


def _finish_publication(connection, context, metadata, result, *, reason, config, copy_legacy_views=True, legacy_views=None, prepare_compatibility=False):
    library_id = context['library_id']
    if prepare_compatibility:
        _prepare_compatibility_in_transaction(connection, context, metadata, legacy_views)
    if legacy_views is not None:
        rebuilt = _first_row(connection.execute('select library.local_relation_compatibility_views(%s) as views', (library_id,)))
        if not rebuilt or not _relation_views_equal(rebuilt['views'], legacy_views):
            raise RuntimeError('Legacy publication differs from the scoped source rebuild; journal retained.')
    metadata.update(status='ready', targeted_patch_reason=reason,
                    targeted_patch_timestamp=datetime.now(timezone.utc).isoformat())
    connection.execute('update library.local_relation_projection_state set source_fingerprint=%s,last_publication_xid=pg_current_xact_id() where library_id=%s',
                       (metadata['source_fingerprint'], library_id))
    _store_compatibility_state(connection, library_id, metadata, result['relations_last_built'])
    bridge_started = perf_counter()
    if copy_legacy_views:
        # Older writers need the cached summary, never a rebuild of album/track sources.
        connection.execute("""update library.libraries set metadata=jsonb_set(jsonb_set(metadata,
            '{scan_cache,relation_projection}',%(metadata)s::jsonb),
            '{scan_cache,relation_views}',library.local_relation_compatibility_views(id)),updated_at=now() where id=%(library_id)s""",
            {'library_id': library_id, 'metadata': _jsonb(metadata)})
    else:
        connection.execute("""update library.libraries set metadata=jsonb_set(metadata,
            '{scan_cache,relation_projection}',%(metadata)s::jsonb),updated_at=now() where id=%(library_id)s""",
            {'library_id': library_id, 'metadata': _jsonb(metadata)})
    connection.execute('delete from library.local_relation_dirty_albums where library_id=%s and album_id=any(%s::bigint[])',
                       (library_id, result['processed_relation_album_ids']))
    result['relation_compatibility_bridge_ms'] = (perf_counter() - bridge_started) * 1000
    if config is not None:
        from music_app.services.gallery_projection_postgres import patch_gallery_membership_in_transaction
        if result['first_gallery_generation'] is None:
            raise RuntimeError('Affected library changes have no gallery publication journal.')
        target_generation = None
        if context.get('gallery_generation') is not None:
            current = _first_row(connection.execute("""select generation,
                last_invalidation_xid=pg_current_xact_id_if_assigned() as owned
                from library.gallery_projection_state where library_id=%s""", (library_id,)))
            start = int(context['gallery_generation'])
            target_generation = int(current['generation'])
            if target_generation != start and not (
                not context.get('gallery_owned') and current.get('owned')
                and target_generation == start + 1
            ):
                raise RuntimeError('Library sources changed during scoped publication; retry reconciliation.')
        patch_gallery_membership_in_transaction(
            connection, config, affected_album_ids=result['affected_relation_album_ids'],
            affected_album_keys=result['affected_relation_album_keys'],
            alias_to_canonical=result['affected_relation_aliases'],
            expected_generation=result['first_gallery_generation'],
            expected_target_generation=target_generation,
        )
    return result


def tag_edit_baseline_ready(config, *, connect=None):
    """Read only projection markers before any physical media write."""
    from music_app.services import relation_projection_postgres as relations
    from music_app.services.gallery_projection_postgres import BUILDER_VERSION
    with (connect or relations._connect)(config['ALBUM_HAVEN_APP_DATABASE_URL']) as connection:
        row = _first_row(connection.execute("""select
            context.normalized_builder_version=%(relation_version)s
            and context.metadata->>'status'='ready'
            and context.metadata->>'builder_version'=%(relation_version)s
            and state.source_fingerprint=context.metadata->>'source_fingerprint'
          and exists(select 1 from library.local_relation_compatibility_state compatibility
            where compatibility.library_id=state.library_id
              and compatibility.current_semantics='current-v11-explicit-collaboration'
              and compatibility.legacy_semantics='legacy-v11-broad-aliases'
              and compatibility.source_fingerprint=state.source_fingerprint
              and compatibility.last_publication_xid=state.last_publication_xid)
            and not exists(select 1 from library.local_relation_dirty_albums dirty
              where dirty.library_id=context.library_id)
            and exists(select 1 from library.gallery_membership_headers header
              where header.library_id=context.library_id and header.builder_version=%(gallery_version)s)
            and not exists(select 1 from library.gallery_membership_headers header
              join library.gallery_projection_state gallery on gallery.library_id=header.library_id
              where header.library_id=context.library_id and header.builder_version=%(gallery_version)s
                and header.source_generation<>gallery.generation) as ready
            from (""" + _CONTEXT + """) context
            join library.local_relation_projection_state state on state.library_id=context.library_id""",
            {'relation_version': relations.RELATION_PROJECTION_BUILDER_VERSION, 'gallery_version': BUILDER_VERSION}))
    return bool(row and row.get('ready'))



def prepare_relation_compatibility(config, *, connect=None, cancel_requested=None):
    """Prove both contracts from cached facts before enabling mixed-version writes."""
    from music_app.services import relation_projection_postgres as relations

    connector = connect or relations._connect
    with connector(config['ALBUM_HAVEN_APP_DATABASE_URL']) as connection, relations._cancel_active_connection_on_request(connection, cancel_requested):
        connection.execute(relations.inventory_publication_advisory_lock_sql())
        connection.execute(relations.relation_projection_advisory_lock_sql())
        context = _first_row(connection.execute(_CONTEXT))
        if not context or context.get('normalized_builder_version') != relations.RELATION_PROJECTION_BUILDER_VERSION:
            raise RuntimeError('Current normalized relation index is required for compatibility preparation.')
        library_id = context['library_id']
        state = _compatibility_state(connection, library_id)
        pending = _first_row(connection.execute(
            'select 1 from library.local_relation_dirty_albums where library_id=%s limit 1', (library_id,)))
        if pending:
            result = publish_affected_relation_projection(
                connection, reason='pending_source_changes', config=config,
                cancel_requested=cancel_requested, prepare_compatibility=True)
            result['compatibility_prepared'] = True
            return result
        snapshot = relations._relation_projection_scan_cache_from_row(
            _first_row(connection.execute(relations._load_relation_projection_sql())))
        snapshot['relation_views'] = _stored_legacy_views(connection, library_id)
        if relations.relation_projection_stale_reason(snapshot):
            raise RuntimeError('Legacy publication is not ready for compatibility preparation.')
        metadata = dict(context.get('metadata') or {})
        if (metadata.get('source_fingerprint') != context.get('normalized_source_fingerprint')
                or metadata.get('built_from_fingerprint') != context.get('normalized_source_fingerprint')):
            raise RuntimeError('Source fingerprint changed without journal evidence; compatibility preparation refused.')
        legacy_views = snapshot.get('relation_views')
        if (state is not None and state['source_fingerprint'] == context.get('normalized_source_fingerprint')
                and state['publication_xid'] == context.get('normalized_publication_xid')):
            shadow = _first_row(connection.execute(
                'select library.local_relation_compatibility_views(%s) as views', (library_id,)))
            if not shadow or not _relation_views_equal(shadow['views'], legacy_views):
                raise RuntimeError('Legacy publication differs from proven compatibility entries; journal retained.')
            return {'compatibility_prepared': False}
        _prepare_compatibility_in_transaction(connection, context, metadata, legacy_views)
        connection.execute(
            'update library.local_relation_projection_state set last_publication_xid=pg_current_xact_id() where library_id=%s',
            (library_id,))
        return {'compatibility_prepared': True}


def ensure_pending_relation_projection_ready(config, *, connect=None, cancel_requested=None):
    """Replay journaled old-writer changes through the same atomic scoped path."""
    from music_app.services import relation_projection_postgres as relations
    connector = connect or relations._connect
    with connector(config['ALBUM_HAVEN_APP_DATABASE_URL']) as connection, relations._cancel_active_connection_on_request(connection, cancel_requested):
        connection.execute(relations.inventory_publication_advisory_lock_sql())
        connection.execute(relations.relation_projection_advisory_lock_sql())
        context = _first_row(connection.execute(_CONTEXT))
        if context is None or context.get('normalized_builder_version') != relations.RELATION_PROJECTION_BUILDER_VERSION:
            return {'initialized': False}
        pending = _first_row(connection.execute('select 1 from library.local_relation_dirty_albums where library_id=%s limit 1',
                                     (context['library_id'],)))
        if pending is None:
            return {'initialized': True, 'updated': False}
        result = publish_affected_relation_projection(connection, config=config, reason='pending_source_changes', cancel_requested=cancel_requested)
        return {'initialized': True, 'updated': True, **result}


def initialize_scoped_relation_projection(config, *, connect=None):
    """Explicit pre-serving upgrade; full inventory work is allowed only here."""
    from music_app.services.relation_projection_postgres import _ensure_relation_projection_ready
    result = _ensure_relation_projection_ready({**config, 'SHARED_LIBRARY_BROWSE_ONLY': False}, connect=connect,
                                               allow_initialized_rebuild=True)
    return {**result, **load_current_relation_state(config, connect=connect)}


def load_current_relation_state(config, *, connect=None):
    from music_app.services.relation_projection_postgres import _connect
    from music_app.services.cache import deserialize_relation_views
    with (connect or _connect)(config['ALBUM_HAVEN_APP_DATABASE_URL']) as connection:
        row = _first_row(connection.execute('select context.*, library.local_relation_views(context.library_id) as relation_views '
                                 'from (' + _CONTEXT + ') context'))
    if row is None or not isinstance(row.get('relation_views'), Mapping):
        raise RuntimeError('Current relation state could not resolve the local library.')
    return {'relation_views': deserialize_relation_views(row['relation_views']),
            'relations_last_built': float(row.get('relations_last_built') or 0),
            'relation_patch_revision': int(row.get('inventory_mutation_revision') or 0)}


def _patch_family_links(connection, views, affected_names, stamp, *, legacy=False):
    from music_app.services import artist_family_postgres as family
    from music_app.services.library_inventory_postgres import local_inventory_identity_key
    rows = family._projection_rows(views, relations_last_built=stamp,
        relationship_source=family._LEGACY_RELATIONSHIP_SOURCE if legacy else family._RELATIONSHIP_SOURCE)
    params = {'rows': _jsonb(rows), 'row_count': len(rows), 'relationship_source': family._LEGACY_RELATIONSHIP_SOURCE if legacy else family._RELATIONSHIP_SOURCE,
              'affected_keys': sorted({local_inventory_identity_key(name) for name in affected_names})}
    if rows:
        count = _first_row(connection.execute(family._count_artist_family_projection_replacement_rows_sql(), params))
        if int(count.get('replacement_row_count') or 0) != len(rows):
            raise RuntimeError('Affected artist-family projection did not resolve every identity.')
    connection.execute(family._replace_artist_family_projection_sql(scoped=True, legacy=legacy), params)


def _patch_search_rows(connection, views, affected_names, metadata, stamp, *, legacy=False):
    from music_app.services import relation_projection_postgres as relations
    from music_app.services.library_inventory_postgres import local_inventory_identity_key
    keys = sorted({local_inventory_identity_key(name) for name in affected_names} - {''})
    rows = {row['normalized_artist_key']: row for row in relations._artist_search_projection_rows(views)}
    for start in range(0, len(keys), 256):
        batch = keys[start:start + 256]
        connection.execute(relations._patch_artist_search_projection_sql(legacy=legacy), {
            'affected_normalized_keys': batch, 'rows': _jsonb([rows[key] for key in batch if key in rows]),
            'builder_version': metadata['builder_version'], 'source_fingerprint': metadata['source_fingerprint'],
            'relations_last_built': stamp,
        })


def apply_relation_view_patch(current, patch):
    """Apply a committed delta to a process-local full-view compatibility cache."""
    if not isinstance(current, Mapping) or not isinstance(patch, Mapping):
        raise TypeError('Relation delta requires current views and a patch.')
    result = dict(current)
    removals, additions = patch.get('remove', {}), patch.get('upsert', {})
    for section, member in _LIST_KEYS.items():
        removed = set(removals.get(section, []))
        replacement = {str(value if member is None else value[member]): value for value in additions.get(section, [])}
        retained = [value for value in current.get(section, [])
                    if str(value if member is None else value[member]) not in removed | replacement.keys()]
        result[section] = sorted([*retained, *replacement.values()],
                                key=lambda value: (str(value.get('label') or value['family']).casefold(), value['family'])
                                if section == 'sidebar_families' else (str(value if member is None else value[member]).casefold(),))
    for section in _MAP_KEYS:
        removed = set(removals.get(section, []))
        result[section] = {key: value for key, value in current.get(section, {}).items() if key not in removed}
        result[section].update(additions.get(section, {}))
    return result


def apply_committed_relation_state(state, result, *, config=None):
    patch = result.get('relation_view_patch')
    if isinstance(patch, Mapping):
        revision = int(result.get('relation_patch_revision') or 0)
        if revision < int(state.get('relation_patch_revision') or 0):
            return
        previous_revision = state.get('relation_patch_revision')
        base_revision = result.get('relation_patch_base_revision')
        complete_transaction_delta = (
            previous_revision is not None and base_revision is not None
            and int(base_revision) == int(previous_revision)
            and 0 <= int(base_revision) <= revision
        )
        if previous_revision is None or (revision > int(previous_revision) + 1 and not complete_transaction_delta):
            if config is None:
                raise RuntimeError('A relation revision gap requires a current database view.')
            state.update(load_current_relation_state(config))
            return
        state['relation_views'] = apply_relation_view_patch(state.get('relation_views') or {}, patch)
        state['relation_patch_revision'] = revision
    elif isinstance(result.get('relation_views'), dict):
        state['relation_views'] = dict(result['relation_views'])
        if 'relation_patch_revision' in result:
            state['relation_patch_revision'] = int(result['relation_patch_revision'])
    else:
        raise RuntimeError('Postgres persistence returned no canonical relation projection state.')
    state['relations_last_built'] = float(result.get('relations_last_built') or 0)
