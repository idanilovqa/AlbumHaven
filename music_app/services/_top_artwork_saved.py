"""Fixed legacy saved-kind adapter; no filesystem or independent phase driver."""
from uuid import uuid4
from psycopg.types.json import Jsonb

from music_app.services import album_top_artwork_draft as shared
from music_app.services import album_top_publication_evidence as evidence
from music_app.services import artwork_proof_codec as codec
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import require_private_action


def header(connection, live, top, ref, context_ref):
    # Preserve the genuine saved runtime header-observation seam.
    row = connection.execute('''select *,clock_timestamp() as checked_at from app.album_top_artwork_preparations
        where ref=%s and top_ref=%s and library_id=%s and owner_account_id=%s
          and original_session_id=%s and context_ref=%s''',
        (ref, top['ref'], live.library_id, live.actor.account_id, live.actor.session_id, context_ref)).fetchone()
    if (row is None or row['preparation_kind'] != 'saved'
            or row['state'] == 'cancelled' or row['expires_at'] <= row['checked_at']
            or row['top_revision'] != top['revision'] or type(row['item_count']) is not int
            or not 0 <= row['item_count'] <= 5000):
        raise AlbumTopError('artwork_preparation_unavailable', 409)
    return dict(row)


def members(connection, live, top):
    rows = connection.execute('''select ref,catalog_ref,original_position,curator_position
        from app.album_list_items where top_ref=%s and library_id=%s
        order by curator_position,ref limit 5001''', (top['ref'], live.library_id)).fetchall()
    if len(rows) > 5000:
        raise AlbumTopError('items_changed', 409)
    return rows


def manifest(connection, live, preparation, *, start_ack=False, admission_budget=None):
    if start_ack:
        if (type(admission_budget) is not list or len(admission_budget) != 1
                or type(admission_budget[0]) is not int or admission_budget[0] < 512):
            raise AlbumTopError('invalid_command')
        admission_budget[0] += len(shared.bounded_json(shared._header_values(preparation),
            shared._MAX_SNAPSHOT - admission_budget[0]).encode('utf-8')) + 1
        if admission_budget[0] > shared._MAX_SNAPSHOT:
            raise AlbumTopError('artwork_validation_limit', 409)
    rows = []
    for offset in range(0, preparation['item_count'], 100):
        if start_ack:
            # D1: initial admission is cover-free. This already budgeted stored
            # manifest page supplies CURRENT ready cover under exact held locks.
            page = connection.execute('''select i.library_id,i.item_ref,i.catalog_ref,i.position,
                i.selected_local_album_id,i.selected_source_ref,i.selected_library_root_id,
                i.included,i.status,i.error_code,i.asset_ref,a.content_digest,a.width,a.height,a.byte_length,
                case when i.included is true and i.status='ready' then
                  c.id is not null and c.cover_path is not null and c.cover_path<>''
                  and octet_length(c.cover_path)<=16384 end as current_cover_valid,
                case when i.included is true and i.status='ready' and c.id is not null
                  and c.cover_path is not null and c.cover_path<>'' and octet_length(c.cover_path)<=16384
                  then c.cover_path end as current_cover_path
                from app.album_top_artwork_preparation_items i
                left join app.album_top_artwork_assets a on a.ref=i.asset_ref
                left join library.local_albums c on c.library_id=i.library_id
                  and c.id=i.selected_local_album_id and i.included is true and i.status='ready'
                where i.preparation_ref=%s and i.library_id=%s and i.position>%s order by i.position limit 101''',
                (preparation['ref'], live.library_id, offset)).fetchall()
        else:
            page = connection.execute('''select i.library_id,i.item_ref,i.catalog_ref,i.position,
                i.selected_local_album_id,i.selected_source_ref,i.selected_library_root_id,
                i.included,i.status,i.error_code,i.asset_ref,a.content_digest,a.width,a.height,a.byte_length
                from app.album_top_artwork_preparation_items i
                left join app.album_top_artwork_assets a on a.ref=i.asset_ref
                where i.preparation_ref=%s and i.library_id=%s and i.position>%s order by i.position limit 101''',
                (preparation['ref'], live.library_id, offset)).fetchall()
        take = min(100, preparation['item_count'] - offset)
        if len(page) != take + (1 if preparation['item_count'] - offset > 100 else 0):
            raise AlbumTopError('items_changed', 409)
        for position, item in enumerate(page[:take], offset + 1):
            if (item['position'] != position or item['library_id'] != live.library_id
                    or type(item['included']) is not bool
                    or item['status'] not in ('pending', 'excluded', 'failed', 'ready')
                    or (not item['included']) != (item['status'] == 'excluded')):
                raise AlbumTopError('items_changed', 409)
            if start_ack and item['status'] == 'ready' and item['current_cover_valid'] is not True:
                raise AlbumTopError('artwork_source_changed', 409)
            row = dict(item)
            for key in ('item_ref', 'catalog_ref', 'selected_source_ref'):
                row[key] = str(row[key])
            row.update(row_ref=row['item_ref'], saved_item_ref=row['item_ref'], row_kind='existing')
            if start_ack:
                # Canonical row object includes the exact SQL-bounded current
                # cover. Charge before retaining it; the 101-row fetch remains
                # the fixed transient page allowance, never a second vector.
                encoded = shared.bounded_json({key: shared._plain(value) for key, value in row.items()},
                    shared._MAX_SNAPSHOT - admission_budget[0])
                admission_budget[0] += len(encoded.encode('utf-8')) + 1
                encoded = None
                if admission_budget[0] > shared._MAX_SNAPSHOT:
                    raise AlbumTopError('artwork_validation_limit', 409)
            rows.append(row)
    if len(rows) != preparation['item_count'] or len({r['item_ref'] for r in rows}) != len(rows):
        raise AlbumTopError('items_changed', 409)
    return rows


def matching_members(rows, current):
    if [(row['item_ref'], row['catalog_ref'], row['position']) for row in rows] != [
            (str(row['ref']), str(row['catalog_ref']), row['curator_position']) for row in current]:
        raise AlbumTopError('items_changed', 409)


def load_snapshot(service, connection, live, top, identity, constraints, mode):
    preparation = header(connection, live, top, identity['preparation_ref'], identity['context_ref'])
    current = members(connection, live, top)
    rows = manifest(connection, live, preparation)
    matching_members(rows, current)
    generation = shared.lock_sources(service, connection, live, rows)
    return shared.finish_snapshot(service, connection, live, preparation, rows, generation,
                                  constraints, kind='saved', mode=mode)


def start(service, context, ref, draft, choices, key, request_generation, context_ref, constraints):
    # Admission and response are separate facts. An exception after this first
    # successful exit does not undo the committed exact-key start/replay.
    from music_app.services import _top_artwork_preparation_phases as phases
    identity = {'context': context, 'top_ref': ref, 'top_revision': draft['revision'],
                'context_ref': context_ref}
    prepared = None
    try:
        with service._authorized(context, constraints) as (connection, live, _):
            top = service._start_top(connection, live, ref, draft['revision'], key, constraints)
            current = members(connection, live, top)
            if [(str(row['ref']), str(row['catalog_ref'])) for row in current] != [
                    (item['item_ref'], item['album_ref']) for item in draft['items']]:
                raise AlbumTopError('items_changed', 409)
            generation = shared.lock_sources(service, connection, live, draft['items'])
            facts, admitted, used = [], [], 512
            for offset in range(0, len(draft['items']), 100):
                page = draft['items'][offset:offset + 100]
                wanted = [{'row_ref': item['item_ref'], **item, 'include_artwork': choices[offset + index]}
                          for index, item in enumerate(page)]
                projected = evidence.artwork_admission_page(connection, live, wanted, constraints)
                for index, (item, (source, scope)) in enumerate(zip(page, projected), offset):
                    included = choices[index]
                    if included:
                        require_private_action(live, 'library.artwork.read',
                            resource=ResourceScope('album', str(item['selected_local_album_id'])), constraints=constraints)
                    entry = {'item_ref': item['item_ref'], 'catalog_ref': item['album_ref'],
                             'position': index + 1, **scope, 'included': included}
                    # Charge each admitted source fact before retaining the vector.
                    used += len(shared.bounded_json([entry, [source[field] for field in ('state',
                        'capture_builder_version', 'path_flavor', 'container_identity', 'root_path',
                        'title_origin', 'artist_origin')]], shared._MAX_SNAPSHOT - used).encode('utf-8')) + 1
                    if used > shared._MAX_SNAPSHOT:
                        raise AlbumTopError('artwork_validation_limit', 409)
                    admitted.append(entry)
                    facts.append((source, scope))
            digest = evidence.digest(['private-top-artwork-preparation-v2', ref, live.library_id,
                live.actor.account_id, live.actor.session_id, context_ref, draft['revision'], request_generation, admitted])
            created = connection.execute('''select app.start_top_artwork_preparation
                (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) as ref''',
                (str(uuid4()), ref, live.library_id, live.actor.account_id, live.actor.session_id, context_ref,
                 int(draft['revision']), key, digest, Jsonb(admitted), request_generation)).fetchone()['ref']
            identity['preparation_ref'] = str(created)
            preparation = header(connection, live, top, str(created), context_ref)
            admission_budget = [used]
            rows = manifest(connection, live, preparation, start_ack=True, admission_budget=admission_budget)
            matching_members(rows, current)
            if [{key: row[key] for key in ('item_ref', 'catalog_ref', 'position',
                    'selected_local_album_id', 'selected_source_ref', 'selected_library_root_id', 'included')}
                    for row in rows] != admitted:
                raise AlbumTopError('items_changed', 409)
            snapshot, prepared = shared.finish_snapshot(service, connection, live, preparation,
                rows, generation, constraints, kind='saved', mode='start_ack', admission=shared._saved_admission(facts, retained_bytes=admission_budget[0]))
            if not snapshot['observe_count']:
                response = service._status(connection, preparation)
                service._draft_finish(connection, live, top, snapshot, {}, constraints)
                return response
            service._draft_finish(connection, live, top, snapshot, {}, constraints)
            prepared = None
        return phases.finish_start(service, identity, snapshot, constraints=constraints)
    except codec.InvalidArtworkProof:
        raise AlbumTopError('artwork_source_changed', 409) from None
    finally:
        prepared = None


def claim(connection, live, identity, revision, key, lease):
    return connection.execute('''select app.claim_top_artwork_batch(%s,%s,%s,%s,%s,%s,%s) as items''',
        (identity['preparation_ref'], live.actor.account_id, live.actor.session_id,
         identity['context_ref'], int(revision), key, lease)).fetchone()['items']


def complete(connection, live, identity, revision, key, lease, results, pngs):
    connection.execute('''select app.complete_top_artwork_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
        (identity['preparation_ref'], live.actor.account_id, live.actor.session_id,
         identity['context_ref'], int(revision), key, lease,
         Jsonb(results, dumps=shared.result_json), pngs)).fetchone()


def require_observed_roots(live, root_ids, constraints):
    """Fresh saved-only authority before comparison; IDs are server observations."""
    for root_id in root_ids:
        require_private_action(live, 'library.browse.read',
            resource=ResourceScope('library_root', str(root_id)), constraints=constraints)
