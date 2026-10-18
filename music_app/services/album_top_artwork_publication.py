"""Fixed C-2 SQL collaborator; transactions and receipts stay with Top owners.

No connection factory, request-selected mode, image/provider I/O or public proof
projection. The shared phase driver authenticates current complete S and intent
before this collaborator admits immutable SQL lineage under revision N.
"""
from uuid import uuid4

from psycopg.types.json import Jsonb

from music_app.services import album_top_publication as publication
from music_app.services import album_top_publication_evidence as evidence
from music_app.services import album_top_artwork_draft as draft
from music_app.services import album_top_artwork_review as review
from music_app.services import album_top_remote_membership as remote
from music_app.services import artwork_proof_codec as codec
from music_app.services import _top_artwork_draft_proof as proof
from music_app.services.album_top_publication_authority import (
    publication_owner_eligibility, retained_sources, retained_artwork_sources,
)
from music_app.services.owned_album_tops import AlbumTopError, BROWSE, MANAGE, ITEMS, ACCESS

ACTIONS = (BROWSE, MANAGE, ITEMS, ACCESS)


def snapshot_artwork_sources(snapshot):
    return [{'selected_local_album_id': row['selected_local_album_id'],
             'artwork_root_id': row['expected'].root_id}
            for row in snapshot['rows'] if row['included']]


def require_snapshot_eligibility(service, connection, top, snapshot, constraints):
    publication_owner_eligibility(connection, top=top, config=service.owner._config,
        sources=snapshot['scopes'], constraints=constraints,
        artwork_sources=snapshot_artwork_sources(snapshot))


def validate_command(service, connection, live, command, top, link, snapshot, cursor_secret, constraints):
    service.owner._require(live, ACTIONS, constraints, top, owner_only=True)
    descriptor = command.data['artwork_publication']
    review.require_ready(snapshot, descriptor['preparation_revision'])
    if [draft.source_item(row) for row in snapshot['rows']] != command.data['items']:
        raise AlbumTopError('items_changed', 409)
    if command.data['evidence_revision'] != descriptor['review_witness']['metadata_evidence_revision']:
        raise AlbumTopError('invalid_or_stale_review', 409)
    review.verify_publication_intent(snapshot, descriptor, cursor_secret=cursor_secret,
        header=review.publication_header(command.data['title'], command.data['description']),
        action=command.action, link=review.publication_link(link))
    require_snapshot_eligibility(service, connection, top, snapshot, constraints)


def _mapping_page(connection, snapshot, prepared, final, presentations, offset):
    rows = snapshot['rows'][offset:offset + 100]
    witnesses = {}
    if snapshot['kind'] == 'draft':
        # Full S already validated every proof. Re-read only one immutable page
        # to derive the canonical SQL witness; never retain a full proof vector.
        values = connection.execute('''select row_ref,position,
            case when octet_length(source_stamp::text)<=65536 then source_stamp end as source_stamp,
            case when octet_length(acquisition_stamp::text)<=2048 then acquisition_stamp end as acquisition_stamp
            from app.album_top_artwork_draft_items where preparation_ref=%s and included
              and position>%s and position<=%s order by position limit 101''',
            (snapshot['header']['ref'], offset, offset + len(rows))).fetchall()
        selected = {row['position']: row for row in rows if row['included']}
        if len(values) != len(selected):
            raise AlbumTopError('artwork_source_changed', 409)
        for value in values:
            row = selected.get(value['position'])
            if row is None or str(value['row_ref']) != row['row_ref']:
                raise AlbumTopError('artwork_source_changed', 409)
            expected, digest, acquired = proof.ready_binding(value['source_stamp'], value['acquisition_stamp'],
                prepared, library_id=snapshot['header']['library_id'], local_album_id=row['selected_local_album_id'])
            if (expected, digest, acquired) != (row['expected'], row['proof_digest'], row['acquisition_digest']):
                raise AlbumTopError('artwork_source_changed', 409)
            witnesses[row['position']] = codec.canonical_source_bytes(value['source_stamp']).decode('utf-8')
        values = None
    return [{'curator_position': item['curator_position'], 'item_ref': item['item_ref'],
             'original_position': item['original_position'], 'presentation_ref': presentation,
             'descriptor_witness': witnesses.get(item['curator_position'])}
            for item, presentation in zip(final[offset:offset + 100], presentations[offset:offset + 100])]


def save(service, connection, live, command, top, link, snapshot, prepared, now, constraints):
    """Pre-mutation admission -> actual apply/map/seal/pointer; no receipt here."""
    captured = None
    try:
        captured = evidence.capture_artwork_review(connection, live, top=top,
            items=command.data['items'], constraints=constraints)
        descriptor = command.data['artwork_publication']
        witness, intent = descriptor['review_witness'], descriptor['publication_intent']
        if (captured['generation'] != snapshot['metadata_generation']
                or captured['evidence_revision'] != witness['metadata_evidence_revision']
                or len(captured['items']) != len(snapshot['rows'])):
            raise AlbumTopError('evidence_stale', 409)
        current = publication.working_items(connection, top)
        ref, header = str(uuid4()), snapshot['header']
        link_binding = review.publication_link(link)
        arguments = (ref, header['ref'], live.actor.account_id, live.actor.session_id,
            header['context_ref'], header['revision'], top['revision'], command.action,
            command.data['title'], command.data['description'], captured['evidence_revision'],
            witness['review_digest'], snapshot['digest'], intent['intent_digest'],
            witness['asset_manifest_digest'], captured['generation'], command.request_key,
            command.digest, link_binding['link_state'],
            int(link_binding['link_revision']) if link_binding['link_revision'] is not None else None)
        connection.execute('select app.admit_top_artwork_publication('
            + ','.join(['%s'] * 20) + ') as fingerprint', arguments).fetchone()
        remote.clear_artwork_local_replacements(connection, top, command.data['items'])
        final = publication.apply_draft(connection, top, command.data['items'], current)
        if (len(final) != len(snapshot['rows']) or len({row['item_ref'] for row in final}) != len(final)
                or any(row['album_ref'] != staged['catalog_ref'] or row['curator_position'] != staged['position']
                    or staged['saved_item_ref'] is not None and row['item_ref'] != str(staged['saved_item_ref'])
                    for row, staged in zip(final, snapshot['rows']))):
            raise AlbumTopError('items_changed', 409)
        revision = top['revision'] + 1
        connection.execute('''update app.album_lists set title=%s,description=%s,revision=%s,updated_at=%s
            where ref=%s and revision=%s''',
            (command.data['title'], command.data['description'], revision, now, top['ref'], top['revision']))
        presentations = [evidence.admit_presentation(connection, top['library_id'], captured['generation'], row)
                         for row in captured['items']]
        captured = None
        for offset in range(0, len(final), 100):
            page = _mapping_page(connection, snapshot, prepared, final, presentations, offset)
            mapped = connection.execute('select app.map_top_artwork_publication_page(%s,%s) as count',
                                        (ref, Jsonb(page))).fetchone()['count']
            if mapped != len(page):
                raise AlbumTopError('artwork_preparation_unavailable', 409)
            page = None
        connection.execute('select app.seal_top_artwork_publication(%s,null)', (ref,)).fetchone()
        published = connection.execute('''select publication_revision from app.album_list_publications
            where ref=%s and top_ref=%s and library_id=%s and contract_version=2''',
            (ref, top['ref'], top['library_id'])).fetchone()
        if published is None:
            raise AlbumTopError('artwork_preparation_unavailable', 409)
        share_ref = str(link['ref']) if link else str(uuid4())
        link_revision = link['link_revision'] + 1 if link else 1
        connection.execute('''insert into app.shared_links
            (ref,top_ref,library_id,state,active_publication_ref,link_revision,enabled_at)
            values(%s,%s,%s,'enabled',%s,%s,%s) on conflict(top_ref) do update
            set state='enabled',active_publication_ref=excluded.active_publication_ref,
                link_revision=excluded.link_revision,enabled_at=excluded.enabled_at,revoked_at=null''',
            (share_ref, top['ref'], top['library_id'], ref, link_revision, now))
        receipt = {'top_ref': str(top['ref']), 'revision': str(revision), 'action': command.action,
            'request_key': command.request_key, 'publication': publication._publication_receipt(
                {'ref': share_ref, 'state': 'enabled', 'link_revision': link_revision},
                ref, published['publication_revision'])}
        return receipt, {**top, 'revision': revision, 'title': command.data['title'],
                         'description': command.data['description']}
    finally:
        captured = None


def consume(connection, receipt):
    ref = receipt['publication']['publication_ref']
    connection.execute('select app.consume_top_artwork_publication(%s)', (ref,)).fetchone()
    # Both same-named C1 deferred triggers, without changing unrelated modes.
    # R2 prevents later mutable closure changes after these events are drained.
    connection.execute('set constraints app.artwork_publication_finalize immediate')


def finish(service, connection, live, top, snapshot, observations, receipt, constraints):
    ref = receipt['publication']['publication_ref']
    sources = retained_sources(connection, ref)
    artwork = retained_artwork_sources(connection, ref)
    review._json_size(receipt, 16384)
    evidence.canonical(receipt)
    publication_owner_eligibility(connection, top=top, config=service.owner._config,
        sources=sources, artwork_sources=artwork, constraints=constraints)
    # Uses only compact current scopes/original deadline, never staging SQL or
    # old-N membership validation. Every write/finalizer/response SQL precedes it.
    compact = {'header': {'expires_at': snapshot['header']['expires_at']},
        'scopes': sources, 'rows': [{'included': True,
            'selected_local_album_id': source['selected_local_album_id']} for source in artwork]}
    service._draft_finish(connection, live, top, compact, observations, constraints)
