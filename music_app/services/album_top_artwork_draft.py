"""Typed, local pending artwork selections; no working membership mutations."""
from music_app.services.owned_album_tops import (
    AlbumTopError, MAX_TOP_ITEMS, top_uuid, top_revision,
    _draft_item_selections, normalize_top_publication_preview,
)


def _identity(value):
    result = top_uuid(value)
    if result == '00000000-0000-0000-0000-000000000000':
        raise AlbumTopError('invalid_command')
    return result


def normalize(payload):
    if type(payload) is not dict or set(payload) != {
            'revision', 'request_key', 'request_generation', 'draft_ref', 'draft_revision', 'rows'}:
        raise AlbumTopError('invalid_command')
    generation = payload['request_generation']
    if type(generation) is not int or not 1 <= generation <= 253402300799:
        raise AlbumTopError('invalid_command')
    rows = payload['rows']
    if type(rows) is not list or len(rows) > MAX_TOP_ITEMS:
        raise AlbumTopError('invalid_command')
    refs, choices, selections = [], [], []
    for row in rows:
        if type(row) is not dict or set(row) != {'row_ref', 'selection', 'include_artwork'}:
            raise AlbumTopError('invalid_command')
        if type(row['include_artwork']) is not bool:
            raise AlbumTopError('invalid_command')
        refs.append(_identity(row['row_ref']))
        choices.append(row['include_artwork'])
        selections.append(row['selection'])
    if len(set(refs)) != len(refs):
        raise AlbumTopError('invalid_command')
    selections = _draft_item_selections(selections)
    if any(row['kind'] not in {'existing', 'new_local'} or row['source']['kind'] != 'local'
           for row in selections):
        raise AlbumTopError('invalid_command')
    items = [{'item_ref': row.get('item_ref'), 'album_ref': row['album_ref'],
              'selected_local_album_id': row['source']['selected_local_album_id'],
              'selected_source_ref': row['source']['selected_source_ref']} for row in selections]
    draft = normalize_top_publication_preview({'revision': payload['revision'], 'items': items})
    return {'draft': draft, 'row_refs': refs, 'choices': choices,
            'request_key': _identity(payload['request_key']), 'request_generation': generation,
            'draft_ref': _identity(payload['draft_ref']), 'draft_revision': top_revision(payload['draft_revision'])}


def manifest_row(row_ref, item, position, included, scope):
    # The temporary row identity never occupies the saved item_ref field.
    return {'row_ref': row_ref, 'row_kind': 'existing' if item['item_ref'] is not None else 'new_local',
            'saved_item_ref': item['item_ref'], 'catalog_ref': item['album_ref'], 'position': position,
            **scope, 'included': included}


# The following fixed collaborator belongs to TopArtworkPreparationService. It
# owns no transaction, process gate, policy service or working-membership write.
import hashlib
import json
from dataclasses import dataclass
from types import MappingProxyType
from uuid import uuid4

from music_app.services import album_top_publication as publication
from music_app.services import album_top_publication_evidence as evidence
from music_app.services import artwork_proof_codec as codec
from music_app.services import _top_artwork_resolution as resolution
from music_app.services import _top_artwork_draft_proof as proof
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import require_private_action, PrivateLibraryAuthorityError

_MAX_SNAPSHOT = 32 * 1024 * 1024
_HEADER_FIELDS = ('ref', 'top_ref', 'library_id', 'owner_account_id', 'original_session_id',
    'context_ref', 'top_revision', 'draft_ref', 'draft_revision', 'revision', 'request_generation',
    'expires_at', 'state', 'baseline_digest', 'manifest_digest', 'lease_ref', 'lease_expires_at',
    'batch_request_key', 'batch_from_revision', 'batch_items', 'completed_request_key',
    'completed_from_revision')


def bounded_json(value, limit=_MAX_SNAPSHOT):
    chunks, size = [], 0
    for chunk in json.JSONEncoder(sort_keys=True, separators=(',', ':'),
            ensure_ascii=False, allow_nan=False).iterencode(value):
        size += len(chunk.encode('utf-8'))
        if size > limit:
            raise AlbumTopError('artwork_validation_limit', 409)
        chunks.append(chunk)
    return ''.join(chunks)


def result_json(value):
    return bounded_json(value, 1024 * 1024)


def source_item(row):
    return {'item_ref': str(row['saved_item_ref']) if row['saved_item_ref'] is not None else None,
            'album_ref': str(row['catalog_ref']),
            'selected_local_album_id': row['selected_local_album_id'],
            'selected_source_ref': str(row['selected_source_ref'])}


def _plain(value):
    if value is None or type(value) in (str, int, bool):
        return value
    if type(value) in (list, tuple):
        return [_plain(item) for item in value]
    if hasattr(value, 'isoformat'):
        return value.isoformat()
    return str(value)


def _header_values(header):
    return [_plain(header[key]) for key in _HEADER_FIELDS]


def fingerprint(header, source_digest):
    return hashlib.sha256(bounded_json(['private-top-artwork-draft-operation-v1',
        _header_values(header), source_digest]).encode('utf-8')).hexdigest()


def require_revision(header, revision, key=None):
    recovery = (key is not None and str(header['completed_request_key']) == key
                and header['completed_from_revision'] == int(revision))
    if header['revision'] != int(revision) and not recovery:
        raise AlbumTopError('artwork_preparation_unavailable', 409)


def load_snapshot(service, connection, live, top, ref, context_ref, draft_ref,
                  draft_revision, constraints):
    """Complete bounded DB snapshot; no filesystem/probe/capture work here."""
    header = connection.execute('''select *,clock_timestamp() as checked_at
        from app.album_top_artwork_preparations where ref=%s and top_ref=%s
          and library_id=%s and owner_account_id=%s and original_session_id=%s
          and context_ref=%s''', (ref, top['ref'], live.library_id, live.actor.account_id,
                                  live.actor.session_id, context_ref)).fetchone()
    if (header is None or header['preparation_kind'] != 'draft'
            or str(header['draft_ref']) != draft_ref or header['draft_revision'] != int(draft_revision)
            or header['top_revision'] != top['revision'] or header['state'] == 'cancelled'
            or header['expires_at'] <= header['checked_at']
            or type(header['item_count']) is not int or not 0 <= header['item_count'] <= 5000):
        raise AlbumTopError('artwork_preparation_unavailable', 409)
    header = dict(header)
    connection.execute('''select app.validate_top_artwork_draft_preparation
        (%s,%s,%s,%s,%s,%s,%s)''', (ref, live.actor.account_id, live.actor.session_id,
        context_ref, top['revision'], draft_ref, int(draft_revision))).fetchone()
    current = connection.execute('''select ref,catalog_ref,original_position,curator_position
        from app.album_list_items where top_ref=%s and library_id=%s
        order by curator_position,ref limit 5001''', (top['ref'], live.library_id)).fetchall()
    if len(current) > 5000:
        raise AlbumTopError('items_changed', 409)
    rows = []
    for offset in range(0, header['item_count'], 100):
        page = connection.execute('''select i.row_ref,i.row_kind,i.saved_item_ref,i.catalog_ref,
            i.position,i.selected_local_album_id,i.selected_source_ref,i.selected_library_root_id,
            i.included,i.status,i.error_code,i.asset_ref,a.content_digest,a.width,a.height,a.byte_length
            from app.album_top_artwork_draft_items i
            left join app.album_top_artwork_assets a on a.ref=i.asset_ref
            where i.preparation_ref=%s and i.position>%s order by i.position limit 101''',
            (ref, offset)).fetchall()
        take = min(100, header['item_count'] - offset)
        if len(page) != take + (1 if header['item_count'] - offset > 100 else 0):
            raise AlbumTopError('items_changed', 409)
        for position, item in enumerate(page[:take], offset + 1):
            if (item['position'] != position or type(item['included']) is not bool
                    or item['row_kind'] not in ('existing', 'new_local')
                    or (item['row_kind'] == 'existing') != (item['saved_item_ref'] is not None)
                    or item['status'] not in ('pending', 'excluded', 'failed', 'ready')
                    or (not item['included']) != (item['status'] == 'excluded')):
                raise AlbumTopError('items_changed', 409)
            row = dict(item)
            for key in ('row_ref', 'catalog_ref', 'selected_source_ref'):
                row[key] = str(row[key])
            rows.append(row)
    if len(rows) != header['item_count'] or len({r['row_ref'] for r in rows}) != len(rows):
        raise AlbumTopError('items_changed', 409)
    publication.validate_draft_membership([source_item(row) for row in rows], current)
    generation = lock_sources(service, connection, live, rows)
    return finish_snapshot(service, connection, live, header, rows, generation,
                           constraints, kind='draft', mode='advance')


def lock_sources(service, connection, live, rows):
    ids = sorted({row['selected_local_album_id'] for row in rows})
    for offset in range(0, len(ids), 100):
        wanted = ids[offset:offset + 100]
        locked = connection.execute('''select id from library.local_albums
            where library_id=%s and id=any(%s::bigint[]) order by id for share''',
            (live.library_id, wanted)).fetchall()
        if [item['id'] for item in locked] != wanted:
            raise AlbumTopError('evidence_unavailable', 409)
    return evidence.source_barrier(connection, live.library_id)


@dataclass(frozen=True, slots=True, init=False)
class _SavedAdmission:
    facts: tuple
    retained_bytes: int

    def __init__(self):
        raise AlbumTopError('invalid_command')


def _saved_admission(facts, *, retained_bytes=0):
    """Private constructor for already validated/locked saved admission facts."""
    if (type(facts) is not list or len(facts) > 5000
            or type(retained_bytes) is not int or not 0 <= retained_bytes <= _MAX_SNAPSHOT):
        raise AlbumTopError('invalid_command')
    copied = []
    for pair in facts:
        if (type(pair) is not tuple or len(pair) != 2
                or type(pair[0]) is not dict or type(pair[1]) is not dict):
            raise AlbumTopError('invalid_command')
        copied.append((MappingProxyType(dict(pair[0])), MappingProxyType(dict(pair[1]))))
    value = object.__new__(_SavedAdmission)
    object.__setattr__(value, 'facts', tuple(copied))
    object.__setattr__(value, 'retained_bytes', retained_bytes)
    return value


def finish_snapshot(service, connection, live, header, rows, generation, constraints,
                    *, kind, mode, admission=None):
    """Fixed saved/draft source projection and whole ready-vector proof owner.

    Admission is the saved adapter's exact server-built facts under locks. It
    supplies no callback or SQL and cannot choose the proof kind or root.
    """
    if kind not in ('saved', 'draft') or mode not in ('read', 'advance', 'start_ack'):
        raise AlbumTopError('artwork_preparation_unavailable', 409)
    if admission is not None and (type(admission) is not _SavedAdmission or mode != 'start_ack'
                                  or len(admission.facts) != len(rows)):
        raise AlbumTopError('artwork_preparation_unavailable', 409)
    if kind == 'draft' and (mode == 'start_ack' or admission is not None):
        raise AlbumTopError('artwork_preparation_unavailable', 409)
    ref = header['ref']
    included = [row for row in rows if row['included']]
    observed = [row for row in included if kind == 'draft' or mode == 'advance' or row['status'] == 'ready']
    observed_refs = {row['row_ref'] for row in observed}
    inventory, prepared, roots = None, None, ()
    if observed:
        root_rows = connection.execute('''select id,
            case when octet_length(root_path)<=8192 then root_path end as root_path
            from library.library_roots where library_id=%s and is_active is true
            order by id limit 1025''', (live.library_id,)).fetchall()
        if not root_rows or len(root_rows) > 1024 or any(row['root_path'] is None for row in root_rows):
            raise AlbumTopError('artwork_unavailable', 409)
        entries = []
        for root in root_rows:
            try:
                require_private_action(live, 'library.browse.read',
                    resource=ResourceScope('library_root', str(root['id'])), constraints=constraints)
                eligible = True
            except PrivateLibraryAuthorityError:
                eligible = False
            entries.append({'root_id': root['id'], 'root_path': root['root_path'],
                            'browse_eligible': eligible})
        inventory = {'inventory_version': 1, 'library_id': live.library_id, 'platform': 'posix',
                     'resolver_contract': resolution.CONTRACT, 'roots': entries}
        prepared = codec.prepare_inventory_binding(inventory)
        roots = tuple(resolution.RootInput(item['root_id'], item['root_path']) for item in entries)
    # Inventory/context exists before any ready-proof page. The context stays
    # with this transaction; only its digest and primitive row facts may leave.
    scopes, facts = [], []
    header_budget = len(bounded_json(_header_values(header)).encode('utf-8')) + 512
    # Start carries its admission/header/manifest charge forward; the final
    # compact facts are additional retained representation, not a second quota.
    used = max(header_budget, admission.retained_bytes) if admission is not None else header_budget
    by_ref = {row['row_ref']: row for row in rows}
    for offset in range(0, len(rows), 100):
        page = rows[offset:offset + 100]
        selections = [{'row_ref': row['row_ref'], **source_item(row),
                       'selected_library_root_id': row['selected_library_root_id'],
                       'include_artwork': row['row_ref'] in observed_refs} for row in page]
        projected = (admission.facts[offset:offset + len(page)] if admission is not None else
                     evidence.artwork_selection_page(connection, live, selections, constraints))
        for row, (source, scope) in zip(page, projected):
            scopes.append(scope)
            if row['included']:
                require_private_action(live, 'library.artwork.read',
                    resource=ResourceScope('album', str(row['selected_local_album_id'])), constraints=constraints)
            row['observe'] = row['row_ref'] in observed_refs
            cover = row.get('current_cover_path') if admission is not None else source['cover_path']
            if row['observe'] and not cover:
                raise AlbumTopError('artwork_source_changed' if kind == 'saved' and row['status'] == 'ready' else 'artwork_unavailable', 409)
            row['cover_path'] = cover if row['observe'] else None
            row['expected'] = None
            row['proof_digest'] = None
            row['acquisition_digest'] = None
            row['source_facts'] = [source[key] for key in ('state', 'capture_builder_version',
                'path_flavor', 'container_identity', 'root_path', 'title_origin', 'artist_origin')]
            row_facts = [_plain(row[key]) for key in ('row_ref', 'row_kind', 'saved_item_ref',
                'catalog_ref', 'position', 'selected_local_album_id', 'selected_source_ref',
                'selected_library_root_id', 'included', 'status', 'error_code', 'asset_ref',
                'content_digest', 'width', 'height', 'byte_length')]
            row_facts += [None, None, row['source_facts'], row['cover_path']]
            used += len(bounded_json(row_facts, _MAX_SNAPSHOT - used).encode('utf-8')) + 1
            if used > _MAX_SNAPSHOT:
                raise AlbumTopError('artwork_validation_limit', 409)
            row['facts'] = row_facts
            facts.append(row_facts)
    ready_count = sum(row['status'] == 'ready' for row in rows)
    after = 0
    for offset in range(0, ready_count, 100):
        if kind == 'draft':
            page = connection.execute('''select row_ref,position,source_stamp,acquisition_stamp
                from app.album_top_artwork_draft_items where preparation_ref=%s and status='ready'
                  and position>%s order by position limit 101''', (ref, after)).fetchall()
        else:
            page = connection.execute('''select item_ref as row_ref,position,
                case when octet_length(source_stamp::text)<=65536 then source_stamp end as source_stamp,
                case when octet_length(acquisition_stamp::text)<=2048 then acquisition_stamp end as acquisition_stamp
                from app.album_top_artwork_preparation_items where preparation_ref=%s and status='ready'
                  and position>%s order by position limit 101''', (ref, after)).fetchall()
        take = min(100, ready_count - offset)
        if len(page) != take + (1 if ready_count - offset > 100 else 0):
            raise AlbumTopError('artwork_preparation_unavailable', 409)
        for item in page[:take]:
            row = by_ref.get(str(item['row_ref']))
            if row is None or row['status'] != 'ready' or row['position'] != item['position']:
                raise AlbumTopError('artwork_preparation_unavailable', 409)
            if kind == 'draft':
                expected, digest, acquisition_digest = proof.ready_binding(item['source_stamp'],
                    item['acquisition_stamp'], prepared, library_id=live.library_id,
                    local_album_id=row['selected_local_album_id'])
            else:
                expected, digest, acquisition_digest = proof.saved_ready_binding(item['source_stamp'],
                    item['acquisition_stamp'], library_id=live.library_id,
                    local_album_id=row['selected_local_album_id'], stored_cover_path=row['cover_path'])
            if codec.source_object(item['source_stamp'])['stored_cover_path'] != row['cover_path']:
                proof.unavailable()
            # Each JSON null (4 bytes) becomes a quoted 64-byte digest (66).
            # Charge before retaining either replacement in the compact vector.
            used += 2 * (66 - 4)
            if used > _MAX_SNAPSHOT:
                raise AlbumTopError('artwork_validation_limit', 409)
            row['expected'], row['proof_digest'], row['acquisition_digest'] = expected, digest, acquisition_digest
            row['facts'][16:18] = [digest, acquisition_digest]
            after = item['position']
        page = None
    source_digest = hashlib.sha256(bounded_json(['private-top-artwork-' + kind + '-sources-v1',
        generation, facts, prepared.digest if prepared else None],
        _MAX_SNAPSHOT - header_budget).encode('utf-8')).hexdigest()
    digest = fingerprint(header, source_digest)
    return ({'kind': kind, 'mode': mode, 'observe_count': len(observed), 'header': header, 'rows': rows, 'scopes': scopes, 'roots': roots,
             'included_count': len(included), 'digest': digest,
             'source_digest': source_digest,
             'inventory_digest': prepared.digest if prepared else None}, prepared)


def request(snapshot):
    return resolution.ResolutionInput(str(uuid4()), snapshot['digest'], 'posix', resolution.CONTRACT,
        snapshot['roots'], tuple(resolution.RowInput(row['row_ref'], row['selected_local_album_id'],
            row['cover_path'], row['expected']) for row in snapshot['rows'] if row.get('observe', row['included'])), 1)


def compare(before, after):
    if before['digest'] != after['digest'] or _header_values(before['header']) != _header_values(after['header']):
        raise AlbumTopError('artwork_source_changed', 409)


def status(connection, snapshot, *, after=0, limit=100):
    header = snapshot['header']
    counts = connection.execute('''select count(*) filter(where status='ready') as ready,
        count(*) filter(where included) as included,count(*) filter(where status='failed') as failed,
        coalesce(sum(a.byte_length),0) as byte_length from app.album_top_artwork_draft_items i
        left join app.album_top_artwork_assets a on a.ref=i.asset_ref where preparation_ref=%s''',
        (header['ref'],)).fetchone()
    page = connection.execute('''select i.row_ref,i.row_kind,i.saved_item_ref,i.catalog_ref,i.position,
        i.included,i.status,i.error_code,i.asset_ref,a.content_digest,a.width,a.height,a.byte_length
        from app.album_top_artwork_draft_items i left join app.album_top_artwork_assets a on a.ref=i.asset_ref
        where preparation_ref=%s and position>%s order by position limit %s''',
        (header['ref'], after, limit + 1)).fetchall()
    return {'preparation_kind': 'draft', 'preparation_ref': str(header['ref']),
        'preparation_revision': str(header['revision']), 'draft_ref': str(header['draft_ref']),
        'draft_revision': str(header['draft_revision']), 'saved_top_revision': str(header['top_revision']),
        'state': header['state'], 'expires_at': header['expires_at'].isoformat(),
        'item_count': header['item_count'], 'included_count': counts['included'],
        'ready_count': counts['ready'], 'failed_count': counts['failed'], 'byte_length': counts['byte_length'],
        'items': [{key: (_plain(row[key])) for key in ('row_ref', 'row_kind', 'saved_item_ref',
            'catalog_ref', 'position', 'included', 'status', 'error_code', 'asset_ref',
            'content_digest', 'width', 'height', 'byte_length')} for row in page[:limit]],
        'next_position': page[limit - 1]['position'] if len(page) > limit else None}
