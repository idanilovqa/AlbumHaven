"""Dormant typed capture SQL against the unchanged real PostgreSQL fixtures.

Runtime-role calls, actual PNG acquisition, real blocking and rollback are
required. Source authoring is not execution evidence. No fixture role, database
URL, config module, route or native decoder substitute is installed here.
"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import asdict
from hashlib import sha256
import json
import os
from pathlib import Path
from threading import Event
from time import monotonic, sleep
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest

from music_app.services import artwork_proof_codec as codec
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error
from tests.py.test_album_top_artwork_preparation_postgres import artwork, CONTEXT, ZERO
from tests.py import test_album_top_artwork_preparation_postgres as foundation
from tests.py.test_top_artwork_draft_preparation_postgres import (
    draft_case, command, direct, start, snapshot, remote_draft_case,
)
from tests.py.test_top_artwork_retention_postgres import budgets, cleanup, retire
from tests.py.postgres_runtime_role_contract import assert_runtime_role

READ = 'app.validate_top_artwork_draft_preparation(uuid,bigint,bigint,text,bigint,uuid,bigint)'
CLAIM = 'app.claim_top_artwork_draft_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,uuid,bigint)'
COMPLETE = 'app.complete_top_artwork_draft_batch(uuid,bigint,bigint,text,bigint,uuid,uuid,uuid,bigint,jsonb,bytea[])'
PRIVATE = (
    'app.deny_top_artwork_draft_identity_update()',
    'app._top_artwork_draft_baseline(uuid,bigint,bigint,bigint)',
    'app._validate_top_artwork_draft(uuid,bigint,bigint,text,bigint,uuid,bigint)',
    'app._lock_top_artwork_draft_sources(uuid,bigint)',
    'app._top_artwork_json_integer(jsonb,numeric,numeric)',
    'app._top_artwork_decimal(jsonb,boolean)',
    'app._top_artwork_v2_pair_valid(jsonb,jsonb,text,bigint,bigint)',
    'app._admit_top_artwork_asset(uuid,bigint,bigint,text,text,integer,integer,bytea)',
)
SOURCE_DOMAIN = b'AlbumHaven/artwork-descriptor/v2\0'
requires_posix_artwork = pytest.mark.skipif(
    os.name != 'posix',
    reason='Requires actual POSIX artwork acquisition or a typed POSIX inventory snapshot')


def runtime(case):
    return psycopg.connect(case.db.app_url, row_factory=dict_row)


def identity(case, status, payload):
    return (status['preparation_ref'], case.db.owner.account_id, case.db.owner.session_id,
            CONTEXT, int(case.top['revision']), payload['draft_ref'], int(payload['draft_revision']))


def validate(case, status, payload, *, connection=None):
    if connection is None:
        with runtime(case) as connection:
            assert_runtime_role(connection, case.db)
            return validate(case, status, payload, connection=connection)
    connection.execute('select app.validate_top_artwork_draft_preparation(%s,%s,%s,%s,%s,%s,%s)',
                       identity(case, status, payload))


def claim_args(case, status, payload, key, lease):
    return (status['preparation_ref'], case.db.owner.account_id, case.db.owner.session_id,
            CONTEXT, int(status['preparation_revision']), key, lease,
            payload['draft_ref'], int(payload['draft_revision']))


def claim(case, status, payload, *, key=None, lease=None, connection=None):
    key, lease = key or str(uuid4()), lease or str(uuid4())
    if connection is None:
        with runtime(case) as connection:
            assert_runtime_role(connection, case.db)
            return claim(case, status, payload, key=key, lease=lease, connection=connection)
    refs = connection.execute('select app.claim_top_artwork_draft_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s) as refs',
                              claim_args(case, status, payload, key, lease)).fetchone()['refs']
    return key, lease, refs


def complete(case, status, payload, key, lease, results, pngs, *, connection=None, array_sql=None):
    if connection is None:
        with runtime(case) as connection:
            assert_runtime_role(connection, case.db)
            return complete(case, status, payload, key, lease, results, pngs,
                            connection=connection, array_sql=array_sql)
    args = claim_args(case, status, payload, key, lease) + (Jsonb(results),)
    if array_sql is None:
        connection.execute('select app.complete_top_artwork_draft_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                           args + (pngs,))
    else:
        # Fixed test-owned SQL literals only; not an application extension point.
        connection.execute('select app.complete_top_artwork_draft_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,' + array_sql + ')',
                           args + tuple(pngs))


def header(case, status):
    with case.db.connect() as connection:
        return connection.execute('select * from app.album_top_artwork_preparations where ref=%s',
                                  (status['preparation_ref'],)).fetchone()


def refreshed(case, status):
    return {**status, 'preparation_revision': str(header(case, status)['revision'])}


def failed(refs):
    return [{'row_ref': str(ref), 'status': 'failed', 'error_code': 'artwork_unavailable'} for ref in refs]


def actual_results(case, payload, refs):
    """Acquire actual bytes, then convert observed legacy facts with the codec.

    This tests the SQL trusted-writer boundary. Service resolver/fencing tests
    separately prove the producer obtained the complete inventory legitimately.
    """
    with case.db.connect() as connection:
        roots = connection.execute('select id,root_path from library.library_roots where library_id=%s and is_active order by id',
                                   (case.db.library,)).fetchall()
    inventory = {'inventory_version': 1, 'library_id': case.db.library, 'platform': 'posix',
        'resolver_contract': 'artwork-posix-bounded-selection-v1',
        'roots': [{'root_id': row['id'], 'root_path': row['root_path'], 'browse_eligible': True} for row in roots]}
    digest = codec.inventory_digest(inventory)
    results, pngs = [], []
    for ref in refs:
        row = next(row for row in payload['rows'] if row['row_ref'] == str(ref))
        local = row['selection']['source']['selected_local_album_id']
        index = case.album_ids.index(local)
        source = foundation.describe_artwork_source(library_id=case.db.library, local_album_id=local,
            artwork_root_id=case.artwork_root, artwork_root_path=case.artwork_path,
            stored_cover_path=str(case.cover_paths[index]), resolved_cover_path=case.cover_paths[index])
        captured = foundation.capture_artwork(source)
        legacy = asdict(source)
        source_v2 = {key: legacy[key] for key in ('library_id', 'local_album_id', 'artwork_root_id',
            'artwork_root_path', 'stored_cover_path', 'resolved_cover_path')}
        source_v2.update(relative_parts=list(source.relative_parts), descriptor_version=2, platform='posix',
            root={'device': str(source.root_device), 'inode': str(source.root_inode)},
            selection_context={'version': 1, 'resolver_contract': 'artwork-posix-bounded-selection-v1', 'inventory_digest': digest})
        info = asdict(captured.file_observation)
        acquisition = {'acquisition_version': 2, 'platform': 'posix', 'descriptor_digest': codec.descriptor_digest(source_v2),
            'input_bytes': captured.input_bytes, 'input_pixels': captured.input_pixels,
            'file': {key: value if key == 'size' else str(value) for key, value in info.items()}}
        codec.validate_pair(source_v2, acquisition)
        codec.bind_inventory(source_v2, inventory)
        results.append({'row_ref': str(ref), 'status': 'ready', 'asset_ref': str(uuid4()),
            'content_digest': captured.content_digest, 'width': captured.width, 'height': captured.height,
            'source_stamp': source_v2, 'acquisition_stamp': acquisition,
            'source_bytes': codec.canonical_source_bytes(source_v2).decode('ascii')})
        pngs.append(captured.png)
    return results, pngs


def read_draft(case, status, payload, **kwargs):
    return case.service.read_draft(case.db.context(), top_ref=case.top['top_ref'],
        preparation_ref=status['preparation_ref'], top_revision_value=case.top['revision'],
        draft_ref=payload['draft_ref'], draft_revision=payload['draft_revision'], context_ref=CONTEXT, **kwargs)


def advance_draft(case, status, payload, **kwargs):
    return case.service.advance_draft(case.db.context(), top_ref=case.top['top_ref'],
        preparation_ref=status['preparation_ref'], top_revision_value=case.top['revision'],
        draft_ref=payload['draft_ref'], draft_revision=payload['draft_revision'],
        preparation_revision=status['preparation_revision'], request_key=str(uuid4()), context_ref=CONTEXT, **kwargs)


def test_real_runtime_acl_and_kind_boundary(draft_case):
    case = draft_case.build(1)
    saved = case.start()
    payload = command(case)
    with runtime(case) as connection:
        role = assert_runtime_role(connection, case.db)
        for signature in (READ, CLAIM, COMPLETE):
            assert connection.execute('select has_function_privilege(%s,%s,\'EXECUTE\') as yes', (role, signature)).fetchone()['yes']
        for signature in PRIVATE:
            assert connection.execute('select has_function_privilege(%s,%s,\'EXECUTE\') as yes', (role, signature)).fetchone()['yes'] is False
        for privilege in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'):
            assert connection.execute('select has_table_privilege(%s,%s,%s) as yes',
                (role, 'app.album_top_artwork_draft_items', privilege)).fetchone()['yes'] is False
    for operation in (lambda: validate(case, saved, payload), lambda: claim(case, saved, payload),
                      lambda: complete(case, saved, payload, str(uuid4()), str(uuid4()), [], [])):
        before = snapshot(case)
        with pytest.raises(psycopg.Error): operation()
        assert snapshot(case) == before
    drafted = start(case, payload)
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState): case.claim(drafted)
    before = snapshot(case)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with runtime(case) as connection:
            connection.execute('update app.album_top_artwork_draft_items set status=status where preparation_ref=%s', (drafted['preparation_ref'],))
    assert snapshot(case) == before


@pytest.mark.parametrize('count', [0, 1, 101])
def test_no_image_transition_latest_key_and_immutable_excluded(draft_case, count):
    case = draft_case.build(count, excluded=tuple(range(count)))
    payload = command(case)
    status = start(case, payload)
    assert header(case, status)['state'] == 'preparing'
    validate(case, status, payload)
    assert header(case, status)['revision'] == 1
    before = snapshot(case)
    key, lease, refs = claim(case, status, payload)
    assert refs == []
    after = header(case, status)
    assert after['state'] == 'ready' and after['revision'] == 2
    assert after['lease_ref'] is None and after['batch_items'] is None
    assert str(after['completed_request_key']) == key and after['completed_from_revision'] == 1
    assert snapshot(case)['album_top_artwork_budgets'] == before['album_top_artwork_budgets']
    ready = snapshot(case)
    assert claim(case, status, payload, key=key)[2] == []
    assert claim(case, refreshed(case, status), payload)[2] == []
    assert snapshot(case) == ready
    with pytest.raises(psycopg.Error): claim(case, status, payload)
    if count:
        with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
            with case.db.connect() as connection:
                connection.execute('update app.album_top_artwork_draft_items set status=status where preparation_ref=%s', (status['preparation_ref'],))
    assert snapshot(case) == ready


def test_pending_first_four_claims_failed_retry_and_latest_receipt(draft_case):
    case = draft_case.build(6)
    payload = command(case)
    status = start(case, payload)
    key, lease, refs = claim(case, status, payload)
    assert [str(ref) for ref in refs] == [row['row_ref'] for row in payload['rows'][:4]]
    before = snapshot(case)
    with pytest.raises(psycopg.errors.LockNotAvailable): claim(case, status, payload, key=key, lease=lease)
    assert snapshot(case) == before
    complete(case, status, payload, key, lease, failed(refs), [None] * 4)
    assert claim(case, status, payload, key=key)[2] == []
    second = refreshed(case, status)
    key2, lease2, refs2 = claim(case, second, payload)
    # pending rows 5,6 are chosen first, then failed 1,2; storage/result order is position.
    assert [str(ref) for ref in refs2] == [payload['rows'][i]['row_ref'] for i in (0, 1, 4, 5)]
    complete(case, second, payload, key2, lease2, failed(refs2), [None] * 4)
    with pytest.raises(psycopg.Error): claim(case, status, payload, key=key)
    assert claim(case, second, payload, key=key2)[2] == []


@pytest.mark.parametrize('new_local', [False, True])
@requires_posix_artwork
def test_actual_png_typed_ready_proofs_and_immutable_pins(draft_case, new_local):
    case = draft_case.build(2, same_pixels=True)
    if new_local:
        case.top, _ = case.db.create(refs=[])
    payload = command(case, new=(0, 1) if new_local else ())
    status = start(case, payload)
    key, lease, refs = claim(case, status, payload)
    results, pngs = actual_results(case, payload, refs)
    complete(case, status, payload, key, lease, results, pngs)
    rows = snapshot(case)['draft_items']
    assert len({row['asset_ref'] for row in rows}) == 1
    assert all(row['status'] == 'ready' for row in rows)
    assert all((row['saved_item_ref'] is None) is new_local for row in rows)
    for row in rows: codec.validate_pair(row['source_stamp'], row['acquisition_stamp'])
    assert header(case, status)['revision'] == 2 and header(case, status)['state'] == 'ready'
    for amount in budgets(case).values():
        assert amount['asset_count'] == 1 and amount['byte_count'] == len(pngs[0])
    before = snapshot(case)
    for assignment in ('status=status', "status='failed',asset_ref=null,source_stamp=null,acquisition_stamp=null,error_code='artwork_limit'",
                       'row_ref=row_ref'):
        with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
            with case.db.connect() as connection:
                connection.execute('update app.album_top_artwork_draft_items set '+assignment+' where preparation_ref=%s', (status['preparation_ref'],))
    assert snapshot(case) == before


@pytest.mark.parametrize('mutation', ['extra', 'missing', 'scalar', 'row_ref', 'width_bool', 'height_string', 'zero_asset',
    'digest', 'legacy', 'windows', 'scope', 'root', 'root_path', 'stored', 'root_decimal', 'signed_decimal',
    'file_size', 'relative', 'source_extra', 'acquisition_extra', 'witness_json', 'witness_pair', 'domain', 'bytes', 'png'])
@requires_posix_artwork
def test_runtime_strict_v2_result_matrix_rolls_back(draft_case, mutation):
    case = draft_case.build(2)
    payload = command(case)
    status = start(case, payload)
    key, lease, refs = claim(case, status, payload)
    results, pngs = actual_results(case, payload, refs)
    bad = results[-1]
    if mutation == 'extra': bad['extra'] = True
    elif mutation == 'missing': del bad['height']
    elif mutation == 'scalar': results[-1] = None
    elif mutation == 'row_ref': bad['row_ref'] = results[0]['row_ref']
    elif mutation == 'width_bool': bad['width'] = True
    elif mutation == 'height_string': bad['height'] = '24'
    elif mutation == 'zero_asset': bad['asset_ref'] = ZERO
    elif mutation == 'digest': bad['content_digest'] = 'A' * 64
    elif mutation == 'legacy': del bad['source_stamp']['descriptor_version']
    elif mutation == 'windows': bad['source_stamp']['platform'] = 'win32'
    elif mutation == 'scope': bad['source_stamp']['local_album_id'] += 1
    elif mutation == 'root': bad['source_stamp']['artwork_root_id'] = 9223372036854775807
    elif mutation == 'root_path': bad['source_stamp']['artwork_root_path'] += '/changed'
    elif mutation == 'stored': bad['source_stamp']['stored_cover_path'] += '.changed'
    elif mutation == 'root_decimal': bad['source_stamp']['root']['inode'] = '01'
    elif mutation == 'signed_decimal': bad['acquisition_stamp']['file']['mtime_ns'] = '-0'
    elif mutation == 'file_size': bad['acquisition_stamp']['file']['size'] += 1
    elif mutation == 'relative': bad['source_stamp']['relative_parts'] = ['..', 'cover.png']
    elif mutation == 'source_extra': bad['source_stamp']['extra'] = 'no'
    elif mutation == 'acquisition_extra': bad['acquisition_stamp']['extra'] = False
    elif mutation == 'witness_json': bad['source_bytes'] = '{'
    elif mutation == 'witness_pair': bad['source_bytes'] = '{}'
    elif mutation == 'domain': bad['acquisition_stamp']['descriptor_digest'] = sha256(bad['source_bytes'].encode()).hexdigest()
    elif mutation == 'bytes': bad['source_bytes'] = ' ' * 65537
    elif mutation == 'png': pngs[-1] = pngs[-1] + b'not-the-hashed-png'
    # Source mutations are given an internally consistent witness, so rejection
    # must come from schema/current binding rather than an incidental old digest.
    if mutation in {'legacy', 'windows', 'scope', 'root', 'root_path', 'stored', 'root_decimal', 'relative', 'source_extra'}:
        bad['source_bytes'] = json.dumps(bad['source_stamp'], sort_keys=True, separators=(',', ':'), ensure_ascii=True)
        bad['acquisition_stamp']['descriptor_digest'] = sha256(SOURCE_DOMAIN + bad['source_bytes'].encode()).hexdigest()
    before = snapshot(case)
    with pytest.raises(psycopg.Error): complete(case, status, payload, key, lease, results, pngs)
    assert snapshot(case) == before


@pytest.mark.parametrize('array_sql', ['NULL::bytea[]', "'{}'::bytea[]", "array_fill(NULL::bytea,ARRAY[2],ARRAY[0])",
                                      'ARRAY[[NULL::bytea,NULL::bytea]]'])
def test_png_array_dimension_lower_bound_and_cardinality(draft_case, array_sql):
    case = draft_case.build(2)
    payload = command(case)
    status = start(case, payload)
    key, lease, refs = claim(case, status, payload)
    before = snapshot(case)
    with pytest.raises(psycopg.errors.CheckViolation):
        complete(case, status, payload, key, lease, failed(refs), [], array_sql=array_sql)
    assert snapshot(case) == before


@pytest.mark.parametrize('kind', ['reorder', 'duplicate', 'missing', 'extra', 'failed_extra', 'failed_error_null'])
def test_claim_result_exact_order_cardinality_and_failed_shape(draft_case, kind):
    case = draft_case.build(2)
    payload = command(case)
    status = start(case, payload)
    key, lease, refs = claim(case, status, payload)
    results, pngs = failed(refs), [None, None]
    if kind == 'reorder': results.reverse()
    elif kind == 'duplicate': results[1] = deepcopy(results[0])
    elif kind == 'missing': results.pop()
    elif kind == 'extra': results.append(deepcopy(results[0]))
    elif kind == 'failed_extra': results[-1]['source_stamp'] = {}
    elif kind == 'failed_error_null': results[-1]['error_code'] = None
    before = snapshot(case)
    with pytest.raises(psycopg.Error): complete(case, status, payload, key, lease, results, pngs)
    assert snapshot(case) == before


@pytest.mark.parametrize('variant', ['whitespace', 'key_order', 'escape', 'duplicate_key', 'numeric_spelling'])
@requires_posix_artwork
def test_noncanonical_sql_witness_is_private_unusable_state(draft_case, variant):
    case = draft_case.build(1)
    payload = command(case)
    status = start(case, payload)
    key, lease, refs = claim(case, status, payload)
    results, pngs = actual_results(case, payload, refs)
    result = results[0]
    source = result['source_stamp']
    canonical = result['source_bytes']
    if variant == 'whitespace': witness = ' ' + canonical + '\n'
    elif variant == 'key_order': witness = json.dumps(dict(reversed(list(source.items()))), separators=(',', ':'), ensure_ascii=True)
    elif variant == 'escape': witness = canonical.replace('"posix"', '"\\u0070osix"')
    elif variant == 'duplicate_key': witness = '{"platform":"posix",' + canonical[1:]
    else: witness = canonical.replace('"descriptor_version":2', '"descriptor_version":2.0')
    assert witness != canonical and json.loads(witness) == source
    result['source_bytes'] = witness
    result['acquisition_stamp']['descriptor_digest'] = sha256(SOURCE_DOMAIN + witness.encode('utf-8')).hexdigest()
    complete(case, status, payload, key, lease, results, pngs)
    with pytest.raises(codec.InvalidArtworkProof): codec.validate_pair(source, result['acquisition_stamp'])
    before = snapshot(case)
    # Full ready validation is mandatory even when the requested output page is empty.
    assert_error(lambda: read_draft(case, status, payload, after=5000, limit=1), 'artwork_source_changed', 409)
    # Recovering the latest completed key is also a full proof consumer.
    assert_error(lambda: case.service.advance_draft(case.db.context(), top_ref=case.top['top_ref'],
        preparation_ref=status['preparation_ref'], top_revision_value=case.top['revision'],
        draft_ref=payload['draft_ref'], draft_revision=payload['draft_revision'],
        preparation_revision=status['preparation_revision'], request_key=key, context_ref=CONTEXT),
        'artwork_source_changed', 409)
    assert snapshot(case) == before


@pytest.mark.parametrize('phase', ['read', 'claim', 'complete'])
@pytest.mark.parametrize('change', ['off_page_link', 'source_state', 'metadata_root', 'existing_membership', 'baseline_revision'])
def test_full_sql_validation_includes_excluded_and_off_page_rows(draft_case, phase, change):
    case = draft_case.build(101, excluded=(100,))
    payload = command(case)
    status = start(case, payload)
    if phase == 'complete': key, lease, refs = claim(case, status, payload)
    with case.db.connect() as connection:
        if change == 'off_page_link':
            connection.execute('delete from library.catalog_album_links where library_id=%s and local_album_id=%s',
                               (case.db.library, case.album_ids[-1]))
        elif change == 'source_state':
            connection.execute("update library.album_metadata_sources set state='invalid' where ref=%s", (case.source_refs[-1],))
        elif change == 'metadata_root':
            connection.execute('update library.library_roots set is_active=false where id=%s', (case.metadata_root,))
        elif change == 'existing_membership':
            connection.execute('delete from app.album_list_items where ref=%s', (case.items[-1]['item_ref'],))
        else:
            connection.execute('update app.album_lists set revision=revision+1 where ref=%s', (case.top['top_ref'],))
    before = snapshot(case)
    with pytest.raises(psycopg.Error):
        if phase == 'read': validate(case, status, payload)
        elif phase == 'claim': claim(case, status, payload)
        else: complete(case, status, payload, key, lease, failed(refs), [None] * len(refs))
    assert snapshot(case) == before
    # Restore only the direct synthetic parent revision so normal fixture cleanup
    # can use its exact owned scope; source mutations are fixture-owned rows.
    if change == 'baseline_revision':
        with case.db.connect() as connection:
            connection.execute('update app.album_lists set revision=revision-1 where ref=%s', (case.top['top_ref'],))


def _wait_for_block(case, pid, blocker_pid):
    deadline = monotonic() + 5
    while monotonic() < deadline:
        with case.db.connect() as monitor:
            row = monitor.execute('select %s=any(pg_blocking_pids(%s)) as blocked', (blocker_pid, pid)).fetchone()
        if row['blocked']: return
        sleep(0.01)
    raise AssertionError('Completion never reached the actual budget lock wait')


@pytest.mark.parametrize('typed', [False, True])
@pytest.mark.parametrize('deadline_kind', ['lease', 'preparation'])
@pytest.mark.parametrize('reused', [False, True])
@requires_posix_artwork
def test_real_budget_wait_past_original_deadline_rolls_back_every_write(draft_case, typed, deadline_kind, reused):
    case = draft_case.build(2, same_pixels=True)
    payload = command(case)
    # A cancelled predecessor retains a real immutable asset for the dedup path.
    if reused:
        previous = case.start()
        assert case.advance(previous)['ready_count'] == 2
    if typed:
        status = start(case, payload)
        key, lease, refs = claim(case, status, payload)
        results, pngs = actual_results(case, payload, refs)
    else:
        status = case.start(payload={**case.payload, 'request_key': str(uuid4())})
        key, lease, refs = case.claim(status)
        results, pngs = case.results(refs)
    with case.db.connect() as connection:
        if deadline_kind == 'lease':
            connection.execute("update app.album_top_artwork_preparations set lease_expires_at=clock_timestamp()+interval '3 seconds' where ref=%s",
                               (status['preparation_ref'],))
        else:
            connection.execute("""with t as (select clock_timestamp()+interval '3 seconds' as expiry)
                update app.album_top_artwork_preparations set expires_at=t.expiry,created_at=t.expiry-interval '60 minutes',
                  lease_expires_at=t.expiry from t where ref=%s""", (status['preparation_ref'],))
    before = snapshot(case)
    entered = Event()
    worker = {}
    def run():
        with runtime(case) as connection:
            assert_runtime_role(connection, case.db)
            connection.execute("set local statement_timeout='15s'")
            worker['pid'] = connection.info.backend_pid
            entered.set()
            if typed:
                complete(case, status, payload, key, lease, results, pngs, connection=connection)
            else:
                connection.execute('select app.complete_top_artwork_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                    (status['preparation_ref'], case.db.owner.account_id, case.db.owner.session_id, CONTEXT,
                     int(status['preparation_revision']), key, lease, Jsonb(results), pngs))
    with ThreadPoolExecutor(max_workers=1) as executor:
        with case.db.connect() as blocker:
            blocker.execute('select 1 from app.album_top_artwork_budgets where owner_account_id=%s and scope_ref=%s for update',
                            (case.db.owner.account_id, ZERO))
            future = executor.submit(run)
            assert entered.wait(5)
            _wait_for_block(case, worker['pid'], blocker.info.backend_pid)
            blocker.execute('select pg_sleep(greatest(0,extract(epoch from lease_expires_at-clock_timestamp()))+0.05) from app.album_top_artwork_preparations where ref=%s',
                            (status['preparation_ref'],))
        with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState): future.result(timeout=10)
    # Compare the actual pre-wait claim, receipts, both stores, all asset bytes,
    # original budget columns and retention counters, not just a row count.
    assert snapshot(case) == before


def test_read_helper_neither_upgrades_top_nor_locks_preparation_or_clock(draft_case):
    case = draft_case.build(1)
    payload = command(case)
    status = start(case, payload)
    with runtime(case) as reader:
        validate(case, status, payload, connection=reader)
        with case.db.connect() as other:
            other.execute("set local lock_timeout='200ms'")
            other.execute('select ref from app.album_lists where ref=%s for share nowait', (case.top['top_ref'],))
            other.execute('select ref from app.album_top_artwork_preparations where ref=%s for update nowait', (status['preparation_ref'],))
            other.execute('select library_id from library.public_metadata_source_state where library_id=%s for update nowait', (case.db.library,))
        with runtime(case) as writer:
            writer.execute("set local lock_timeout='100ms'")
            with pytest.raises(psycopg.errors.LockNotAvailable): claim(case, status, payload, connection=writer)
            writer.rollback()
    assert claim(case, status, payload)[2]


def test_direct_claim_selected_album_lock_precedes_metadata_clock(draft_case):
    case = draft_case.build(2, excluded=(1,))
    payload = command(case)
    status = start(case, payload)
    entered, worker = Event(), {}
    def run():
        with runtime(case) as connection:
            assert_runtime_role(connection, case.db)
            connection.execute("set local statement_timeout='10s'")
            worker['pid'] = connection.info.backend_pid
            entered.set()
            return claim(case, status, payload, connection=connection)
    with ThreadPoolExecutor(max_workers=1) as executor:
        with case.db.connect() as blocker:
            # Excluded selections are also part of the full source lock vector.
            blocker.execute('select id from library.local_albums where id=%s for update', (case.album_ids[-1],))
            future = executor.submit(run)
            assert entered.wait(5)
            _wait_for_block(case, worker['pid'], blocker.info.backend_pid)
            with case.db.connect() as observer:
                observer.execute('select library_id from library.public_metadata_source_state where library_id=%s for update nowait', (case.db.library,))
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    observer.execute('select ref from app.album_lists where ref=%s for share nowait', (case.top['top_ref'],))
        assert len(future.result(timeout=5)[2]) == 1


@requires_posix_artwork
def test_saved_and_draft_share_one_asset_and_either_pin_blocks_cleanup(draft_case):
    case = draft_case.build(1)
    saved = case.start()
    case.advance(saved)
    asset = case.snapshot()['album_top_artwork_assets'][0]['ref']
    payload = command(case)
    status = start(case, payload)
    key, lease, refs = claim(case, status, payload)
    results, pngs = actual_results(case, payload, refs)
    complete(case, status, payload, key, lease, results, pngs)
    state = snapshot(case)
    assert len(state['album_top_artwork_assets']) == 1
    assert state['draft_items'][0]['asset_ref'] == asset
    assert state['album_top_artwork_preparation_items'][0]['asset_ref'] == asset
    for value in budgets(case).values():
        assert value['byte_count'] == len(pngs[0]) and value['asset_count'] == 1
    # Even an exact synthetic migrator permit cannot override a saved or draft pin.
    for remaining in ('both', 'draft'):
        with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
            with case.db.connect() as connection:
                connection.execute("insert into app.album_top_artwork_cleanup_permits values(txid_current(),pg_backend_pid(),'asset',%s,%s)",
                                   (case.top['top_ref'], asset))
                connection.execute('delete from app.album_top_artwork_assets where ref=%s', (asset,))
        if remaining == 'both':
            retire(case, saved['preparation_ref'], expired=True)
            removed = cleanup(case)
            assert removed['items_deleted'] == 1 and removed['assets_deleted'] == 0
    assert cleanup(case)['assets_deleted'] == 0
    retire(case, status['preparation_ref'], expired=True)
    assert cleanup(case)['assets_deleted'] == 1
    assert not snapshot(case)['draft_items']
    for value in budgets(case).values():
        assert value['asset_count'] == value['byte_count'] == value['item_count'] == value['proof_bytes'] == 0


@requires_posix_artwork
def test_real_same_top_cleanup_waits_for_typed_pin_commit(draft_case):
    case = draft_case.build(1)
    payload = command(case)
    status = start(case, payload)
    key, lease, refs = claim(case, status, payload)
    results, pngs = actual_results(case, payload, refs)
    with runtime(case) as completing:
        complete(case, status, payload, key, lease, results, pngs, connection=completing)
        with runtime(case) as cleaning:
            cleaning.execute("set local lock_timeout='100ms'")
            with pytest.raises(psycopg.errors.LockNotAvailable):
                cleaning.execute('select app.cleanup_top_artwork_preparations(%s,%s,%s,%s)',
                    (case.top['top_ref'], case.db.library, case.db.owner.account_id, int(case.top['revision'])))
            cleaning.rollback()
    assert cleanup(case)['assets_deleted'] == 0
    assert snapshot(case)['draft_items'][0]['asset_ref'] is not None


def _function(source, prefix):
    body = source[source.index(prefix):]
    return body[:body.index('end $$;') + len('end $$;')]


@pytest.mark.parametrize('overage', [False, True])
@requires_posix_artwork
def test_nonempty_0134_backfill_preserves_headers_receipts_assets_and_all_counters(draft_case, overage):
    case = draft_case.build(4, excluded=(3,))
    saved = case.start()
    saved_key, saved_lease, saved_refs = case.claim(saved)
    saved_results, saved_pngs = case.results(saved_refs[:1])
    saved_results += [{'item_ref': str(ref), 'status': 'failed', 'error_code': 'artwork_unavailable'} for ref in saved_refs[1:]]
    saved_pngs += [None] * (len(saved_refs) - 1)
    case.complete(saved, saved_key, saved_lease, saved_results, saved_pngs)
    payload = command(case)
    drafted = start(case, payload)
    if overage:
        with case.db.connect() as connection:
            # Real historical cancelled headers with exact reservation charges.
            connection.execute('''insert into app.album_top_artwork_preparations
                (ref,top_ref,library_id,owner_account_id,original_session_id,context_ref,top_revision,
                 start_request_key,manifest_digest,item_count,created_at,expires_at,state,
                 request_generation,retained_item_count)
                select md5(g::text||%s)::uuid,top_ref,library_id,owner_account_id,original_session_id,context_ref,top_revision,
                  md5(g::text||%s)::uuid,manifest_digest,0,created_at,expires_at,'cancelled',request_generation,0
                  from app.album_top_artwork_preparations cross join generate_series(1,66) g where ref=%s''',
                (str(uuid4()), str(uuid4()), saved['preparation_ref']))
            connection.execute('''update app.album_top_artwork_budgets set preparation_count=preparation_count+66,
                proof_bytes=proof_bytes+66*1024,cleanup_asset_after=%s where owner_account_id=%s''',
                (str(uuid4()), case.db.owner.account_id))
    before = snapshot(case)
    repository = Path(__file__).resolve().parents[2]
    old = (repository / 'migrations/postgres/0130_private_top_artwork_drafts.sql').read_text(encoding='utf-8')
    alias = (repository / 'migrations/postgres/0131_top_artwork_completion_alias.sql').read_text(encoding='utf-8')
    upgrade = (repository / 'migrations/postgres/0134_private_top_artwork_draft_capture.sql').read_text(encoding='utf-8')
    retention = (repository / 'migrations/postgres/0129_top_artwork_retention.sql').read_text(encoding='utf-8')
    class RollbackFixture(Exception): pass
    with pytest.raises(RollbackFixture):
        with case.db.connect() as connection:
            connection.execute('lock table app.album_top_artwork_preparations,app.album_top_artwork_draft_items,app.album_top_artwork_preparation_items,app.album_top_artwork_assets,app.album_top_artwork_budgets in access exclusive mode')
            connection.execute('drop trigger top_artwork_draft_identity_immutable on app.album_top_artwork_draft_items')
            for signature in (READ, CLAIM, COMPLETE) + PRIVATE:
                connection.execute('drop function ' + signature)
            connection.execute('drop trigger top_artwork_draft_initial_status on app.album_top_artwork_draft_items')
            connection.execute('''alter table app.album_top_artwork_draft_items drop column status cascade,
                drop column asset_ref cascade,drop column source_stamp cascade,drop column acquisition_stamp cascade,
                drop column error_code cascade''')
            connection.execute(_function(old, 'create function app.guard_top_artwork_draft_item').replace('create function', 'create or replace function', 1))
            connection.execute(_function(old, 'create function app.top_artwork_draft_baseline').replace('create function', 'create or replace function', 1))
            connection.execute(_function(old, 'create or replace function app.cleanup_top_artwork_preparations'))
            connection.execute(_function(retention, 'create or replace function app.guard_top_artwork_asset'))
            connection.execute(alias)
            old_baseline = connection.execute('select app.top_artwork_draft_baseline(%s,%s,%s,%s) as digest',
                (case.top['top_ref'], case.db.library, case.db.owner.account_id, int(case.top['revision']))).fetchone()['digest']
            connection.execute(upgrade)
            for name in foundation.RELATIONS:
                actual = connection.execute(f'select * from app.{name} where owner_account_id=%s order by 1,2',
                    (case.db.owner.account_id,)).fetchall()
                assert actual == before[name]
            new_baseline = connection.execute('select app.top_artwork_draft_baseline(%s,%s,%s,%s) as digest',
                (case.top['top_ref'], case.db.library, case.db.owner.account_id, int(case.top['revision']))).fetchone()['digest']
            assert new_baseline == old_baseline
            rows = connection.execute('select * from app.album_top_artwork_draft_items where preparation_ref=%s order by position',
                                      (drafted['preparation_ref'],)).fetchall()
            assert [row['status'] for row in rows] == ['pending', 'pending', 'pending', 'excluded']
            assert all(row['asset_ref'] is row['source_stamp'] is row['acquisition_stamp'] is row['error_code'] is None for row in rows)
            for row in rows:
                original = next(item for item in before['draft_items'] if item['row_ref'] == row['row_ref'])
                assert row == original
            with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
                with connection.transaction():
                    connection.execute('update app.album_top_artwork_draft_items set status=status where preparation_ref=%s', (drafted['preparation_ref'],))
            raise RollbackFixture()
    assert snapshot(case) == before


# Reuse the genuine remote membership/admission fixtures solely for structural
# baseline equality; no provider call or former-editor permission is fabricated.
from tests.py.remote_top_postgres_support import remote
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_album_top_remote_membership_postgres import mixed


def test_mixed_retired_remote_baseline_digest_matches_original_0130(remote_draft_case):
    mixed_case, case = remote_draft_case
    case.build(1)
    top, admission = mixed_case.historical()
    mixed_case.retire(admission)
    case.top = top
    repository = Path(__file__).resolve().parents[2]
    old = (repository / 'migrations/postgres/0130_private_top_artwork_drafts.sql').read_text(encoding='utf-8')
    args = (top['top_ref'], case.db.library, case.db.owner.account_id, int(top['revision']))
    with runtime(case) as connection:
        new_digest = connection.execute('select app.top_artwork_draft_baseline(%s,%s,%s,%s) as digest', args).fetchone()['digest']
    class RollbackFixture(Exception): pass
    with pytest.raises(RollbackFixture):
        with case.db.connect() as connection:
            connection.execute(_function(old, 'create function app.top_artwork_draft_baseline').replace('create function', 'create or replace function', 1))
            old_digest = connection.execute('select app.top_artwork_draft_baseline(%s,%s,%s,%s) as digest', args).fetchone()['digest']
            assert old_digest == new_digest
            raise RollbackFixture()
    calls = len(mixed_case.remote.calls)
    payload = command(case, new=(0,))
    status = start(case, payload)
    validate(case, status, payload)
    assert len(mixed_case.remote.calls) == calls


@pytest.mark.parametrize('scope', ['session', 'owner', 'context', 'draft_ref', 'draft_revision'])
def test_exact_typed_identity_rejects_before_claim_or_proof_mutation(draft_case, scope):
    case = draft_case.build(1)
    payload = command(case)
    status = start(case, payload)
    args = list(claim_args(case, status, payload, str(uuid4()), str(uuid4())))
    index = {'owner': 1, 'session': 2, 'context': 3, 'draft_ref': 7, 'draft_revision': 8}[scope]
    args[index] = ('b' * 64 if scope == 'context' else str(uuid4()) if scope == 'draft_ref' else args[index] + 1)
    before = snapshot(case)
    with pytest.raises(psycopg.Error):
        with runtime(case) as connection:
            connection.execute('select app.claim_top_artwork_draft_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s)', args)
    assert snapshot(case) == before


@pytest.mark.parametrize('transition', ['expired_lease', 'cancelled', 'wrong_key', 'wrong_lease'])
def test_stale_direct_completion_never_revives_generation(draft_case, transition):
    case = draft_case.build(1)
    payload = command(case)
    status = start(case, payload)
    key, lease, refs = claim(case, status, payload)
    if transition == 'expired_lease':
        with case.db.connect() as connection:
            connection.execute("update app.album_top_artwork_preparations set lease_expires_at=clock_timestamp()-interval '1 second' where ref=%s", (status['preparation_ref'],))
    elif transition == 'cancelled': retire(case, status['preparation_ref'])
    elif transition == 'wrong_key': key = str(uuid4())
    else: lease = str(uuid4())
    before = snapshot(case)
    with pytest.raises(psycopg.Error): complete(case, status, payload, key, lease, failed(refs), [None])
    assert snapshot(case) == before


@requires_posix_artwork
def test_scoped_foreign_key_rejects_cross_top_pin_even_for_migration_owner(draft_case):
    case = draft_case.build(1)
    saved = case.start()
    case.advance(saved)
    old_asset = case.snapshot()['album_top_artwork_assets'][0]['ref']
    case.top, _ = case.db.create(refs=[])
    payload = command(case, new=(0,))
    drafted = start(case, payload)
    key, lease, refs = claim(case, drafted, payload)
    results, pngs = actual_results(case, payload, refs)
    before = snapshot(case)
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        with case.db.connect() as connection:
            connection.execute('''update app.album_top_artwork_draft_items set status='ready',asset_ref=%s,
                source_stamp=%s,acquisition_stamp=%s where preparation_ref=%s and row_ref=%s''',
                (old_asset, Jsonb(results[0]['source_stamp']), Jsonb(results[0]['acquisition_stamp']), drafted['preparation_ref'], str(refs[0])))
    assert snapshot(case) == before


@requires_posix_artwork
def test_invalid_utf8_witness_rejected_before_any_sql_body_writes(draft_case):
    case = draft_case.build(1)
    payload = command(case)
    status = start(case, payload)
    key, lease, refs = claim(case, status, payload)
    results, pngs = actual_results(case, payload, refs)
    before = snapshot(case)
    with pytest.raises(psycopg.Error):
        with runtime(case) as connection:
            connection.execute('''select app.complete_top_artwork_draft_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s,
                jsonb_set(%s::jsonb,'{0,source_bytes}',to_jsonb(convert_from(decode('ff','hex'),'UTF8'))),%s)''',
                claim_args(case, status, payload, key, lease) + (Jsonb(results), pngs))
    assert snapshot(case) == before


@pytest.mark.parametrize('included', [False, pytest.param(True, marks=requires_posix_artwork)])
def test_actual_shared_gate_busy_never_claims_and_no_image_never_acquires(draft_case, monkeypatch, included):
    case = draft_case.build(1, excluded=() if included else (0,))
    payload = command(case)
    status = start(case, payload)
    gate = foundation.preparation_module._DECODE_REQUESTS
    assert gate.acquire(blocking=False)
    assert gate.acquire(blocking=False)
    try:
        before = snapshot(case)
        if included:
            assert_error(lambda: advance_draft(case, status, payload), 'artwork_busy', 409)
            assert snapshot(case) == before
        else:
            ready = advance_draft(case, status, payload)
            assert ready['state'] == 'ready' and header(case, status)['lease_ref'] is None
        # This invocation must not release either slot owned by the test.
        assert not gate.acquire(blocking=False)
    finally:
        gate.release()
        gate.release()
    assert gate.acquire(blocking=False)
    assert gate.acquire(blocking=False)
    assert not gate.acquire(blocking=False)
    gate.release()
    gate.release()


@pytest.mark.parametrize('failure', ['final_policy', 'owner_exit', 'commit_ack'])
@requires_posix_artwork
def test_a1_failure_releases_owned_gate_exactly_once_without_probe_or_claim(draft_case, monkeypatch, failure):
    from contextlib import contextmanager
    from music_app.services.owned_album_tops import AlbumTopError
    case = draft_case.build(1)
    payload = command(case)
    status = start(case, payload)
    before = snapshot(case)
    calls = []
    probe = case.service._draft_probe
    def observed_probe(*args, **kwargs):
        calls.append('probe')
        return probe(*args, **kwargs)
    monkeypatch.setattr(case.service, '_draft_probe', observed_probe)
    if failure == 'final_policy':
        finish = case.service._draft_finish
        def reject(*args, **kwargs):
            finish(*args, **kwargs)
            raise AlbumTopError('forbidden', 403)
        monkeypatch.setattr(case.service, '_draft_finish', reject)
    else:
        authorized = case.service._authorized
        @contextmanager
        def rejected_exit(*args, **kwargs):
            with authorized(*args, **kwargs) as current:
                yield current
                if failure == 'owner_exit': raise AlbumTopError('forbidden', 403)
            # Inject an unsuccessful outer acknowledgement only after the real
            # read-only A1 transaction exits. It still cannot dispatch P1.
            if failure == 'commit_ack': raise AlbumTopError('forbidden', 403)
        monkeypatch.setattr(case.service, '_authorized', rejected_exit)
    assert_error(lambda: advance_draft(case, status, payload), 'forbidden', 403)
    assert calls == [] and snapshot(case) == before
    gate = foundation.preparation_module._DECODE_REQUESTS
    assert gate.acquire(blocking=False)
    assert gate.acquire(blocking=False)
    assert not gate.acquire(blocking=False)
    gate.release()
    gate.release()


@requires_posix_artwork
def test_real_typed_service_four_phases_two_probes_fresh_inventory_and_outside_io(draft_case, monkeypatch):
    from contextlib import contextmanager
    case = draft_case.build(1)
    payload = command(case)
    status = start(case, payload)
    active = [0]
    contexts, phases, probes, captures = [], [], [], []
    authorized = case.service._authorized
    @contextmanager
    def observed_authority(*args, **kwargs):
        with authorized(*args, **kwargs) as current:
            active[0] += 1
            phases.append(current[0])
            try: yield current
            finally: active[0] -= 1
    monkeypatch.setattr(case.service, '_authorized', observed_authority)
    prepare = codec.prepare_inventory_binding
    def observed_prepare(value):
        assert active[0] == 1
        prepared = prepare(value)
        contexts.append(prepared)
        return prepared
    monkeypatch.setattr(codec, 'prepare_inventory_binding', observed_prepare)
    probe = case.service._draft_probe
    def observed_probe(value):
        assert active[0] == 0
        probes.append(value['header']['revision'])
        return probe(value)
    monkeypatch.setattr(case.service, '_draft_probe', observed_probe)
    capture = case.service.capture
    def observed_capture(value):
        assert active[0] == 0
        # The exact synchronous capture and its cleanup complete before this
        # wrapper returns. No fake image result or detached worker is installed.
        result = capture(value)
        captures.append(result.content_digest)
        return result
    monkeypatch.setattr(case.service, 'capture', observed_capture)
    result = advance_draft(case, status, payload)
    assert result['state'] == 'ready' and result['ready_count'] == 1
    assert len(phases) == len(contexts) == 4 and len({id(value) for value in contexts}) == 4
    assert len(probes) == 2 and len(captures) == 1 and active[0] == 0
    phases.clear(); contexts.clear(); probes.clear(); captures.clear()
    assert read_draft(case, result, payload, after=5000, limit=1)['ready_count'] == 1
    assert len(phases) == len(contexts) == 2 and contexts[0] is not contexts[1]
    assert len(probes) == 1 and captures == []


def test_metadata_only_service_has_zero_codec_inventory_probe_or_capture(draft_case, monkeypatch):
    case = draft_case.build(101, excluded=tuple(range(101)))
    payload = command(case)
    status = start(case, payload)
    def forbidden(*args, **kwargs): raise AssertionError('All-excluded operation entered image work')
    monkeypatch.setattr(codec, 'prepare_inventory_binding', forbidden)
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    monkeypatch.setattr(case.service, 'capture', forbidden)
    statements = []
    foundation.observe_owner_connection(case, monkeypatch, lambda sql, params: statements.append(sql))
    ready = advance_draft(case, status, payload)
    assert ready['state'] == 'ready'
    assert read_draft(case, ready, payload, after=100, limit=1)['item_count'] == 101
    # Metadata source/root joins are mandatory, but no complete active artwork
    # root inventory statement or proof page can appear on this branch.
    assert not any('from library.library_roots where library_id=' in sql for sql in statements)
    assert not any("status='ready'" in sql and 'source_stamp' in sql for sql in statements)


@requires_posix_artwork
def test_all_ready_off_page_source_change_rejects_whole_status(draft_case):
    case = draft_case.build(101, excluded=tuple(range(100)))
    payload = command(case)
    status = start(case, payload)
    key, lease, refs = claim(case, status, payload)
    assert [str(ref) for ref in refs] == [payload['rows'][-1]['row_ref']]
    results, pngs = actual_results(case, payload, refs)
    complete(case, status, payload, key, lease, results, pngs)
    with case.db.connect() as connection:
        connection.execute('update library.local_albums set cover_path=%s where id=%s',
                           (str(case.cover_paths[0]), case.album_ids[-1]))
    before = snapshot(case)
    assert_error(lambda: read_draft(case, status, payload, after=0, limit=1), 'artwork_source_changed', 409)
    assert snapshot(case) == before


def test_failed_identity_noop_and_pending_reset_remain_forbidden(draft_case):
    case = draft_case.build(1)
    payload = command(case)
    status = start(case, payload)
    key, lease, refs = claim(case, status, payload)
    complete(case, status, payload, key, lease, failed(refs), [None])
    before = snapshot(case)
    for assignment in ('included=included', 'row_ref=row_ref', "status='pending',error_code=null"):
        with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
            with case.db.connect() as connection:
                connection.execute('update app.album_top_artwork_draft_items set '+assignment+' where preparation_ref=%s', (status['preparation_ref'],))
    assert snapshot(case) == before


@requires_posix_artwork
def test_saved_dedup_keeps_0131_unused_proposed_asset_identity_semantics(draft_case):
    case = draft_case.build(2, same_pixels=True)
    saved = case.start()
    key, lease, refs = case.claim(saved)
    results, pngs = case.results(refs)
    # 0131 only casts a proposed UUID when inserting. The second result reuses
    # the first exact image, so extracting the helper must not introduce an
    # eager UUID cast (draft results separately require a canonical UUID).
    results[1]['asset_ref'] = 'unused-on-the-dedup-branch'
    case.complete(saved, key, lease, results, pngs)
    assert len(case.snapshot()['album_top_artwork_assets']) == 1
    assert header(case, saved)['state'] == 'ready'


@requires_posix_artwork
def test_logical_preparation_limit_counts_each_deduplicated_pin(draft_case):
    case = draft_case.build(700, same_pixels=True)
    pixels = b''.join(sha256(str(index).encode('ascii')).digest() for index in range(6144))
    path = case.cover_paths[0]
    with foundation.Image.frombytes('RGB', (256, 256), pixels) as image:
        image.save(path, format='PNG')
    case.cover_paths[:] = [path] * len(case.cover_paths)
    with case.db.connect() as connection:
        connection.execute('update library.local_albums set cover_path=%s where library_id=%s and id=any(%s)',
                           (str(path), case.db.library, case.album_ids))
    payload = command(case)
    status = start(case, payload)
    logical, completed = 0, 0
    while completed < 700:
        key, lease, refs = claim(case, status, payload)
        results, pngs = actual_results(case, payload, refs)
        incoming = sum(len(png) for png in pngs)
        before = snapshot(case)
        if logical + incoming > 134217728:
            with pytest.raises(psycopg.errors.CheckViolation) as rejected:
                complete(case, status, payload, key, lease, results, pngs)
            assert rejected.value.diag.constraint_name == 'top_artwork_publication_budget'
            assert snapshot(case) == before
            assert completed > 0
            for value in budgets(case).values():
                assert value['asset_count'] == 1 and value['byte_count'] == len(pngs[0])
            return
        complete(case, status, payload, key, lease, results, pngs)
        logical += incoming
        completed += len(refs)
        status = refreshed(case, status)
    raise AssertionError('Actual high-entropy PNG vector did not exercise the logical 128 MiB limit')


@pytest.mark.parametrize('change', ['off_batch_cover', 'off_batch_source', 'lease_deadline', 'preparation_deadline'])
@requires_posix_artwork
def test_capture_gap_retains_complete_vector_and_original_claim_deadlines(draft_case, monkeypatch, change):
    case = draft_case.build(5)
    payload = command(case)
    status = start(case, payload)
    actual_capture = case.service.capture
    mutated = []
    def capture_then_change(source):
        result = actual_capture(source)
        if not mutated:
            with case.db.connect() as connection:
                if change == 'off_batch_cover':
                    connection.execute('update library.local_albums set cover_path=%s where id=%s',
                        (str(case.cover_paths[0]), case.album_ids[-1]))
                elif change == 'off_batch_source':
                    connection.execute('update library.album_metadata_sources set container_identity=%s where ref=%s',
                        (str(case.metadata_path / 'still-valid-new-container'), case.source_refs[-1]))
                elif change == 'lease_deadline':
                    # Exact same claim IDs/revision/rows, different time binding.
                    connection.execute("update app.album_top_artwork_preparations set lease_expires_at=lease_expires_at+interval '1 second' where ref=%s",
                        (status['preparation_ref'],))
                else:
                    connection.execute("update app.album_top_artwork_preparations set expires_at=expires_at+interval '1 second',created_at=created_at+interval '1 second' where ref=%s",
                        (status['preparation_ref'],))
            mutated.append(change)
        return result
    monkeypatch.setattr(case.service, 'capture', capture_then_change)
    assert_error(lambda: advance_draft(case, status, payload), 'artwork_source_changed', 409)
    assert mutated == [change]
    state = snapshot(case)
    assert state['album_top_artwork_assets'] == []
    assert all(row['status'] == 'pending' and row['asset_ref'] is None for row in state['draft_items'])
    actual = header(case, status)
    assert actual['revision'] == 1 and actual['completed_request_key'] is None
    assert actual['lease_ref'] is not None  # A2 claim remains; A4 never completed.


def _assert_snapshot_query_pages(statements, count, ready, *, images, phases, maximum):
    pages = (count + 99) // 100
    proof_pages = (ready + 99) // 100
    manifest = [sql for sql in statements if 'i.row_kind,i.saved_item_ref' in sql.replace(' ', '')
                and 'a.content_digest' in sql and 'limit 101' in sql]
    # Match each fixed query by its distinguishing owner projection, not timing.
    sources = [sql for sql in statements if sql.startswith('with wanted as')]
    locks = [sql for sql in statements if sql.startswith('select id from library.local_albums')]
    proofs = [sql for sql in statements if sql.startswith('select row_ref,position,source_stamp,acquisition_stamp')]
    roots = [sql for sql in statements if sql.startswith('select id, case when octet_length(root_path)')]
    assert len(manifest) == phases * pages
    assert len(sources) == phases * pages
    assert len(locks) == phases * pages
    assert len(proofs) == phases * proof_pages
    assert len(roots) == phases * int(images)
    assert len(statements) <= maximum
    assert not any(sql.startswith('select cover_path') for sql in statements)
    assert not any(sql.startswith('select s.ref,s.library_id') for sql in statements)


@pytest.mark.parametrize('count', [0, 1, 99, 100, 101, 250, 4999, 5000])
def test_actual_metadata_only_query_ledger_uses_fixed_hundred_row_pages(draft_case, monkeypatch, count, record_property):
    case = draft_case.build(count, excluded=tuple(range(count)))
    payload = command(case)
    status = start(case, payload)
    statements = []
    foundation.observe_owner_connection(case, monkeypatch, lambda sql, params: statements.append(sql))
    started = monotonic()
    result = read_draft(case, status, payload, after=5000, limit=1)
    pages = (count + 99) // 100
    assert result['item_count'] == count and result['items'] == []
    _assert_snapshot_query_pages(statements, count, 0, images=False, phases=1, maximum=18 + 3 * pages)
    record_property('typed_metadata_read_sql_count', len(statements))
    record_property('typed_metadata_read_wall_seconds', monotonic() - started)
    statements.clear()
    ready = advance_draft(case, status, payload)
    assert ready['state'] == 'ready'
    _assert_snapshot_query_pages(statements, count, 0, images=False, phases=1, maximum=20 + 3 * pages)


@requires_posix_artwork
def test_actual_typed_250_images_complete_in_63_batches(draft_case, monkeypatch, record_property):
    case = draft_case.build(250, same_pixels=True)
    payload = command(case)
    status = start(case, payload)
    actual_capture = case.service.capture
    counts = []
    def observed_capture(source):
        counts[-1] += 1
        return actual_capture(source)
    monkeypatch.setattr(case.service, 'capture', observed_capture)
    started = monotonic()
    while status['state'] != 'ready':
        counts.append(0)
        status = advance_draft(case, status, payload)
        assert len(counts) <= 63
    assert counts == [4] * 62 + [2]
    assert status['ready_count'] == 250
    record_property('typed_250_63_batches_wall_seconds', monotonic() - started)


@requires_posix_artwork
def test_actual_all_ready_5000_read_has_bounded_full_vector_sql(draft_case, monkeypatch, record_property):
    from contextlib import contextmanager
    case = draft_case.build(5000, same_pixels=True)
    payload = command(case)
    status = start(case, payload)
    # Build real ready storage through admitted <=4-row runtime claims/completions
    # and actual captures. No trusted direct ready-row insertion or fake proof.
    for _ in range(1250):
        key, lease, refs = claim(case, status, payload)
        results, pngs = actual_results(case, payload, refs)
        complete(case, status, payload, key, lease, results, pngs)
        status = refreshed(case, status)
    assert header(case, status)['state'] == 'ready'
    statements = []
    foundation.observe_owner_connection(case, monkeypatch, lambda sql, params: statements.append(sql))
    phases = []
    authorized = case.service._authorized
    @contextmanager
    def observed(*args, **kwargs):
        offset = len(statements)
        with authorized(*args, **kwargs) as current:
            yield current
        phases.append(statements[offset:])
    monkeypatch.setattr(case.service, '_authorized', observed)
    started = monotonic()
    response = read_draft(case, status, payload, after=5000, limit=1)
    assert response['ready_count'] == 5000 and response['items'] == []
    _assert_snapshot_query_pages(statements, 5000, 5000, images=True, phases=2, maximum=436)
    assert len(phases) == 2
    for phase, ceiling in zip(phases, (217, 219)):
        _assert_snapshot_query_pages(phase, 5000, 5000, images=True, phases=1, maximum=ceiling)
    record_property('typed_ready_5000_read_sql_count', len(statements))
    record_property('typed_ready_5000_read_wall_seconds', monotonic() - started)


@pytest.mark.parametrize('probe_number', [1, 2])
@pytest.mark.parametrize('change', ['off_batch_cover', 'new_root_inventory', 'selected_source', 'root_policy'])
@requires_posix_artwork
def test_each_probe_gap_rechecks_full_sources_inventory_and_policy(draft_case, monkeypatch, probe_number, change):
    from music_app.services.owned_album_tops import AlbumTopError
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    case = draft_case.build(5)
    payload = command(case)
    status = start(case, payload)
    original_probe = case.service._draft_probe
    calls, deny = [], [False]
    def constraints(context):
        blocked = (deny[0] and context.resource is not None
            and context.resource.resource_kind == 'library_root'
            and context.resource.resource_ref == str(case.artwork_root))
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)
    def observe_then_change(value):
        observations = original_probe(value)
        calls.append(True)
        if len(calls) == probe_number:
            if change == 'root_policy':
                deny[0] = True
            else:
                with case.db.connect() as connection:
                    if change == 'off_batch_cover':
                        connection.execute('update library.local_albums set cover_path=%s where id=%s',
                            (str(case.cover_paths[0]), case.album_ids[-1]))
                    elif change == 'new_root_inventory':
                        case.root(connection, case.directory / 'new-inventory-root')
                    else:
                        connection.execute('update library.album_metadata_sources set container_identity=%s where ref=%s',
                            (str(case.metadata_path / 'changed-source-container'), case.source_refs[-1]))
        return observations
    monkeypatch.setattr(case.service, '_draft_probe', observe_then_change)
    with pytest.raises(AlbumTopError) as caught:
        advance_draft(case, status, payload, constraints=constraints)
    assert caught.value.code in {'artwork_source_changed', 'forbidden'}
    assert len(calls) == probe_number
    state = snapshot(case)
    assert state['album_top_artwork_assets'] == []
    assert all(row['status'] == 'pending' for row in state['draft_items'])
    actual = header(case, status)
    assert actual['revision'] == 1 and actual['completed_request_key'] is None
    assert (actual['lease_ref'] is None) is (probe_number == 1)


@pytest.mark.parametrize('failure', ['proof', 'A3', 'A4', 'none'])
@requires_posix_artwork
def test_image_gate_release_follows_actual_cleanup_and_capture_reference_drop(draft_case, monkeypatch, failure):
    import weakref
    from music_app.services import _top_artwork_draft_proof as proof_owner
    case = draft_case.build(1)
    payload = command(case)
    status = start(case, payload)
    references, released, active = [], [], [False]
    actual_capture = case.service.capture
    def capture(source):
        active[0] = True
        try:
            result = actual_capture(source)
            references.append(weakref.ref(result))
            return result
        finally:
            active[0] = False
    monkeypatch.setattr(case.service, 'capture', capture)
    actual_gate = foundation.preparation_module._DECODE_REQUESTS
    class ObservedGate:
        def acquire(self, *, blocking):
            return actual_gate.acquire(blocking=blocking)
        def release(self):
            assert active[0] is False
            assert references and all(reference() is None for reference in references)
            released.append(True)
            actual_gate.release()
    monkeypatch.setattr(foundation.preparation_module, '_DECODE_REQUESTS', ObservedGate())
    if failure == 'proof':
        def rejected_pair(captured, source):
            # The exception's original frame owns captured until the service
            # explicitly drops that traceback; a dictionary clear alone fails.
            assert captured is not None
            raise RuntimeError('synthetic post-capture proof rejection')
        monkeypatch.setattr(proof_owner, 'captured_pair', rejected_pair)
    elif failure in {'A3', 'A4'}:
        original = case.service._draft_finish
        finishes = []
        def reject_phase(*args, **kwargs):
            original(*args, **kwargs)
            finishes.append(True)
            if len(finishes) == (3 if failure == 'A3' else 4):
                raise RuntimeError('synthetic post-capture authority rejection')
        monkeypatch.setattr(case.service, '_draft_finish', reject_phase)
    if failure == 'none':
        assert advance_draft(case, status, payload)['ready_count'] == 1
    else:
        with pytest.raises(RuntimeError):
            advance_draft(case, status, payload)
        assert snapshot(case)['album_top_artwork_assets'] == []
    assert released == [True] and all(reference() is None for reference in references)


@requires_posix_artwork
def test_off_batch_pending_producer_bound_rejects_before_claim(draft_case, monkeypatch):
    import os
    if os.name != 'posix':
        pytest.skip('This case constructs a real POSIX component-boundary source')
    case = draft_case.build(5)
    # Resolver grammar allows 256 absolute non-anchor components; the legacy
    # capture/codec producer permits only 256 including the anchor. The fifth
    # pending row is outside the first <=4 claim and must still be rejected.
    depth = 256 - len(case.artwork_path.parts)
    directory = case.artwork_path.joinpath(*(['d'] * depth))
    directory.mkdir(parents=True)
    cover = foundation.png_file(directory / 'cover.png')
    assert len(cover.parts) == 257
    with case.db.connect() as connection:
        connection.execute('update library.local_albums set cover_path=%s where id=%s',
            (str(cover), case.album_ids[-1]))
    payload = command(case)
    status = start(case, payload)
    before = snapshot(case)
    assert_error(lambda: read_draft(case, status, payload, after=0, limit=1), 'artwork_source_changed', 409)
    assert_error(lambda: advance_draft(case, status, payload), 'artwork_source_changed', 409)
    assert snapshot(case) == before and header(case, status)['lease_ref'] is None


# Append-only F1 acceptance fragment for test_top_artwork_draft_capture_postgres.py.
# Uses that module's unchanged genuine fixtures/helpers/imports. This fragment
# is source only; no test, import, AST, SQL or native execution was performed.


def _race_draft_args(case, status, payload, session_id, key, lease):
    return (status['preparation_ref'], case.db.owner.account_id, session_id, CONTEXT,
            int(status['preparation_revision']), key, lease,
            payload['draft_ref'], int(payload['draft_revision']))


def _race_claim_draft(case, status, payload, session_id):
    key, lease = str(uuid4()), str(uuid4())
    args = _race_draft_args(case, status, payload, session_id, key, lease)
    with runtime(case) as connection:
        assert_runtime_role(connection, case.db)
        refs = connection.execute('select app.claim_top_artwork_draft_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s) as refs',
                                  args).fetchone()['refs']
    return key, lease, refs


def _race_complete_saved(connection, case, status, key, lease, results, pngs):
    connection.execute('select app.complete_top_artwork_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s)',
        (status['preparation_ref'], case.db.owner.account_id, case.db.owner.session_id, CONTEXT,
         int(status['preparation_revision']), key, lease, Jsonb(results), pngs))


def _race_complete_draft(connection, case, status, payload, session_id, key, lease, results, pngs):
    connection.execute('select app.complete_top_artwork_draft_batch(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
        _race_draft_args(case, status, payload, session_id, key, lease) + (Jsonb(results), pngs))


def _race_budget_after(before, byte_delta, asset_delta):
    # Compare every original physical and retention column, permitting only the
    # exact physical charge. Reservations and cleanup cursors must not drift.
    return {**before, 'byte_count': before['byte_count'] + byte_delta,
            'asset_count': before['asset_count'] + asset_delta}


@pytest.mark.parametrize('first_kind', ['saved', 'draft'])
@pytest.mark.parametrize('rollback_first', [False, True])
@requires_posix_artwork
def test_concurrent_same_top_saved_draft_completion_shares_one_physical_charge(
        draft_case, first_kind, rollback_first):
    case = draft_case.build(1)
    saved = case.start()
    second_actor = foundation.new_session(case.db, case.db.owner)
    payload = command(case)
    drafted = case.service.start_draft(case.db.context(second_actor), top_ref=case.top['top_ref'],
        payload=payload, context_ref=CONTEXT)
    assert header(case, saved)['state'] == header(case, drafted)['state'] == 'preparing'
    assert header(case, saved)['original_session_id'] != header(case, drafted)['original_session_id']
    saved_key, saved_lease, saved_refs = case.claim(saved)
    draft_key, draft_lease, draft_refs = _race_claim_draft(case, drafted, payload, second_actor.session_id)
    saved_results, saved_pngs = case.results(saved_refs)
    draft_results, draft_pngs = actual_results(case, payload, draft_refs)
    assert saved_pngs == draft_pngs  # Actual independent capture, not copied result objects.
    before = snapshot(case)
    initial_budgets = budgets(case)
    entered, worker = Event(), {}
    def finish(connection, kind):
        if kind == 'saved':
            _race_complete_saved(connection, case, saved, saved_key, saved_lease, saved_results, saved_pngs)
        else:
            _race_complete_draft(connection, case, drafted, payload, second_actor.session_id,
                                 draft_key, draft_lease, draft_results, draft_pngs)
    second_kind = 'draft' if first_kind == 'saved' else 'saved'
    def second_completion():
        with runtime(case) as connection:
            assert_runtime_role(connection, case.db)
            connection.execute("set local statement_timeout='15s'")
            worker['pid'] = connection.info.backend_pid
            entered.set()
            finish(connection, second_kind)
    with ThreadPoolExecutor(max_workers=1) as executor:
        with runtime(case) as first:
            assert_runtime_role(first, case.db)
            first.execute("set local statement_timeout='15s'")
            finish(first, first_kind)
            future = executor.submit(second_completion)
            assert entered.wait(5)
            _wait_for_block(case, worker['pid'], first.info.backend_pid)
            # First completion retains Top UPDATE; the second cannot yet obtain
            # its preparation/budget mutation phase. The independent Top SHARE
            # attempt confirms this is actual same-Top serialization.
            with case.db.connect() as observer:
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    observer.execute('select ref from app.album_lists where ref=%s for share nowait',
                                     (case.top['top_ref'],))
            if rollback_first:
                first.rollback()
            else:
                first.commit()
        future.result(timeout=10)
    state = snapshot(case)
    assert len(state['album_top_artwork_assets']) == 1
    asset = state['album_top_artwork_assets'][0]
    assert bytes(asset['png']) == saved_pngs[0]
    assert asset['content_digest'] == saved_results[0]['content_digest']
    assert str(asset['top_ref']) == case.top['top_ref']
    for scope, value in budgets(case).items():
        assert value == _race_budget_after(initial_budgets[scope], len(saved_pngs[0]), 1)
    saved_row = state['album_top_artwork_preparation_items'][0]
    draft_row = state['draft_items'][0]
    if rollback_first:
        first_status = saved if first_kind == 'saved' else drafted
        original = next(row for row in before['album_top_artwork_preparations']
                        if str(row['ref']) == first_status['preparation_ref'])
        assert header(case, first_status) == original
        if first_kind == 'saved':
            assert saved_row == before['album_top_artwork_preparation_items'][0]
            assert draft_row['status'] == 'ready' and draft_row['asset_ref'] == asset['ref']
        else:
            assert draft_row == before['draft_items'][0]
            assert saved_row['status'] == 'ready' and saved_row['asset_ref'] == asset['ref']
        return
    assert saved_row['status'] == draft_row['status'] == 'ready'
    assert saved_row['asset_ref'] == draft_row['asset_ref'] == asset['ref']
    assert header(case, saved)['revision'] == header(case, drafted)['revision'] == 2
    assert str(header(case, saved)['completed_request_key']) == saved_key
    assert str(header(case, drafted)['completed_request_key']) == draft_key
    assert cleanup(case)['assets_deleted'] == 0
    # Retiring either first-completed store leaves the other independent pin.
    first_status = saved if first_kind == 'saved' else drafted
    second_status = drafted if first_kind == 'saved' else saved
    retire(case, first_status['preparation_ref'], expired=True)
    retained = cleanup(case)
    assert retained['items_deleted'] == 1 and retained['assets_deleted'] == 0
    remaining = snapshot(case)
    assert remaining['album_top_artwork_assets'][0]['ref'] == asset['ref']
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
        with case.db.connect() as connection:
            connection.execute("insert into app.album_top_artwork_cleanup_permits values(txid_current(),pg_backend_pid(),'asset',%s,%s)",
                               (case.top['top_ref'], asset['ref']))
            connection.execute('delete from app.album_top_artwork_assets where ref=%s', (asset['ref'],))
    retire(case, second_status['preparation_ref'], expired=True)
    assert cleanup(case)['assets_deleted'] == 1
    assert not snapshot(case)['album_top_artwork_assets']


@pytest.mark.parametrize('first_kind', ['saved', 'draft'])
@requires_posix_artwork
def test_concurrent_distinct_tops_account_budget_precedes_top_budget_and_rolls_back_loser(draft_case, first_kind):
    case = draft_case.build(1)
    saved_top = dict(case.top)
    saved = case.start()
    saved_key, saved_lease, saved_refs = case.claim(saved)
    saved_results, saved_pngs = case.results(saved_refs)
    case.top, _ = case.db.create(refs=[])
    draft_top = dict(case.top)
    assert draft_top['top_ref'] != saved_top['top_ref']
    payload = command(case, new=(0,))
    drafted = start(case, payload)
    draft_key, draft_lease, draft_refs = claim(case, drafted, payload)
    draft_results, draft_pngs = actual_results(case, payload, draft_refs)
    assert saved_pngs == draft_pngs
    image_bytes = len(saved_pngs[0])
    account_limit = 4294967296
    # Explicit synthetic ledger boundary: the test does not pretend to allocate
    # 4 GiB of historical images. All NEW assets/pixels/proofs below are real.
    # Exactly one physical insertion fits the remaining account byte allowance.
    with case.db.connect() as connection:
        connection.execute('update app.album_top_artwork_budgets set byte_count=%s where owner_account_id=%s and scope_ref=%s',
                           (account_limit - image_bytes, case.db.owner.account_id, ZERO))
    before = snapshot(case)
    initial_budgets = budgets(case)
    first_top = saved_top if first_kind == 'saved' else draft_top
    second_top = draft_top if first_kind == 'saved' else saved_top
    second_kind = 'draft' if first_kind == 'saved' else 'saved'
    loser = drafted if second_kind == 'draft' else saved
    entered, worker = Event(), {}
    def finish(connection, kind):
        if kind == 'saved':
            _race_complete_saved(connection, case, saved, saved_key, saved_lease, saved_results, saved_pngs)
        else:
            _race_complete_draft(connection, case, drafted, payload, case.db.owner.session_id,
                                 draft_key, draft_lease, draft_results, draft_pngs)
    def second_completion():
        with runtime(case) as connection:
            assert_runtime_role(connection, case.db)
            connection.execute("set local statement_timeout='15s'")
            worker['pid'] = connection.info.backend_pid
            entered.set()
            finish(connection, second_kind)
    with ThreadPoolExecutor(max_workers=1) as executor:
        with runtime(case) as first:
            assert_runtime_role(first, case.db)
            first.execute("set local statement_timeout='15s'")
            finish(first, first_kind)
            future = executor.submit(second_completion)
            assert entered.wait(5)
            _wait_for_block(case, worker['pid'], first.info.backend_pid)
            # Different Tops cannot be blocked by one shared Top lock. The
            # waiter already owns its own Top, but has not taken its Top budget:
            # this demonstrates account-budget-before-Top-budget ordering.
            with case.db.connect() as observer:
                observer.execute('select scope_ref from app.album_top_artwork_budgets where owner_account_id=%s and scope_ref=%s for update nowait',
                                 (case.db.owner.account_id, second_top['top_ref']))
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    observer.execute('select ref from app.album_lists where ref=%s for share nowait',
                                     (second_top['top_ref'],))
            with case.db.connect() as observer:
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    observer.execute('select scope_ref from app.album_top_artwork_budgets where owner_account_id=%s and scope_ref=%s for update nowait',
                                     (case.db.owner.account_id, ZERO))
            first.commit()
        with pytest.raises(psycopg.errors.CheckViolation):
            future.result(timeout=10)
    state = snapshot(case)
    assert len(state['album_top_artwork_assets']) == 1
    asset = state['album_top_artwork_assets'][0]
    assert str(asset['top_ref']) == first_top['top_ref'] and bytes(asset['png']) == saved_pngs[0]
    actual_budgets = budgets(case)
    assert actual_budgets[ZERO] == _race_budget_after(initial_budgets[ZERO], image_bytes, 1)
    assert actual_budgets[ZERO]['byte_count'] == account_limit
    assert actual_budgets[first_top['top_ref']] == _race_budget_after(initial_budgets[first_top['top_ref']], image_bytes, 1)
    assert actual_budgets[second_top['top_ref']] == initial_budgets[second_top['top_ref']]
    # The failed completion must retain its exact original claim/lease and all
    # receipt/revision fields, with zero partially inserted rows or proof pins.
    original_header = next(row for row in before['album_top_artwork_preparations']
                           if str(row['ref']) == loser['preparation_ref'])
    assert header(case, loser) == original_header
    relation = 'draft_items' if second_kind == 'draft' else 'album_top_artwork_preparation_items'
    assert state[relation] == before[relation]
    winning_relation = 'album_top_artwork_preparation_items' if first_kind == 'saved' else 'draft_items'
    assert state[winning_relation][0]['status'] == 'ready'
    assert state[winning_relation][0]['asset_ref'] == asset['ref']
    # Identical PNG bytes on the losing Top cannot borrow the other Top's asset
    # or physical charge. It succeeds only after an explicit fixture allowance
    # reset, and then acquires its own scoped asset and independent charge.
    with case.db.connect() as connection:
        connection.execute('update app.album_top_artwork_budgets set byte_count=%s where owner_account_id=%s and scope_ref=%s',
                           (image_bytes, case.db.owner.account_id, ZERO))
    with runtime(case) as retried:
        assert_runtime_role(retried, case.db)
        finish(retried, second_kind)
    final = snapshot(case)
    assert len(final['album_top_artwork_assets']) == 2
    assert {str(row['top_ref']) for row in final['album_top_artwork_assets']} == {saved_top['top_ref'], draft_top['top_ref']}
    assert len({row['ref'] for row in final['album_top_artwork_assets']}) == 2
    final_budgets = budgets(case)
    assert final_budgets[ZERO]['byte_count'] == 2 * image_bytes and final_budgets[ZERO]['asset_count'] == 2
    for top in (saved_top, draft_top):
        assert final_budgets[top['top_ref']]['byte_count'] == image_bytes
        assert final_budgets[top['top_ref']]['asset_count'] == 1


@pytest.mark.parametrize('deadline_kind', ['preparation', pytest.param('lease', marks=requires_posix_artwork)])
def test_slow_final_policy_callback_cannot_outlive_original_database_deadline(draft_case, monkeypatch, deadline_kind):
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    case = draft_case.build(1, excluded=(0,) if deadline_kind == 'preparation' else ())
    payload = command(case)
    status = start(case, payload)
    lease = None
    if deadline_kind == 'lease':
        _, lease, _ = claim(case, status, payload)
    with case.db.connect() as connection:
        if deadline_kind == 'preparation':
            connection.execute("""with t as (select clock_timestamp()+interval '3 seconds' as expiry)
                update app.album_top_artwork_preparations set expires_at=t.expiry,
                  created_at=t.expiry-interval '60 minutes' from t where ref=%s""",
                (status['preparation_ref'],))
        else:
            connection.execute("update app.album_top_artwork_preparations set lease_expires_at=clock_timestamp()+interval '3 seconds' where ref=%s",
                (status['preparation_ref'],))
    original = header(case, status)
    deadline = original['expires_at' if deadline_kind == 'preparation' else 'lease_expires_at']
    before = snapshot(case)
    in_final, delayed = [False], []
    finish = case.service._draft_finish
    def observed_finish(*args, **kwargs):
        in_final[0] = True
        try:
            return finish(*args, **kwargs)
        finally:
            in_final[0] = False
    monkeypatch.setattr(case.service, '_draft_finish', observed_finish)
    def slow_constraint(context):
        if in_final[0] and not delayed:
            # Genuine PostgreSQL time and a real slow final callback. No fake
            # clock or substituted source observation; the fixture-shortened deadline stays fixed.
            with case.db.connect() as connection:
                connection.execute('select pg_sleep(greatest(0,extract(epoch from %s::timestamptz-clock_timestamp()))+0.05)',
                    (deadline,))
            delayed.append(True)
        return PolicyEvaluationConstraints(request_origin_allowed=True)
    def operation():
        if deadline_kind == 'preparation':
            # Whole metadata-only transition would otherwise acknowledge ready.
            return advance_draft(case, status, payload, constraints=slow_constraint)
        # Exercise the same final fence with a genuine SQL claim and a fixture-shortened deadline,
        # avoiding a two-minute native capture test. It remains unchanged during this fence.
        with case.service._authorized(case.db.context(), slow_constraint) as (connection, live, _):
            top = case.service._top(connection, live, case.top['top_ref'], case.top['revision'], slow_constraint)
            current, prepared = case.service._draft_snapshot(connection, live, top,
                status['preparation_ref'], CONTEXT, payload['draft_ref'], payload['draft_revision'], slow_constraint)
            from music_app.services import album_top_artwork_draft as draft_owner
            response = draft_owner.status(connection, current)
            case.service._draft_finish(connection, live, top, current, {}, slow_constraint, lease=lease)
            return response
    assert_error(operation, 'artwork_preparation_unavailable', 409)
    assert delayed == [True]
    assert snapshot(case) == before


@pytest.mark.parametrize('boundary', ['P1', 'capture', 'P2'])
@pytest.mark.parametrize('change', ['session', 'catalog', 'top_revision', 'preparation_revision'])
@requires_posix_artwork
def test_each_operation_gap_rejects_session_catalog_and_revision_changes(draft_case, monkeypatch, boundary, change):
    case = draft_case.build(5)
    payload = command(case)
    status = start(case, payload)
    changed, probes = [], []
    def mutate():
        with case.db.connect() as connection:
            if change == 'session':
                connection.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s',
                    (case.db.owner.session_id,))
            elif change == 'catalog':
                connection.execute('delete from library.catalog_album_links where library_id=%s and local_album_id=%s',
                    (case.db.library, case.album_ids[-1]))
            elif change == 'top_revision':
                connection.execute('update app.album_lists set revision=revision+1 where ref=%s',
                    (case.top['top_ref'],))
            else:
                connection.execute('update app.album_top_artwork_preparations set revision=revision+1 where ref=%s',
                    (status['preparation_ref'],))
        changed.append(True)
    original_probe = case.service._draft_probe
    def probe(value):
        result = original_probe(value)
        probes.append(True)
        if boundary == ('P1' if len(probes) == 1 else 'P2'):
            mutate()
        return result
    monkeypatch.setattr(case.service, '_draft_probe', probe)
    original_loop = case.service._capture_rows
    def capture_loop(*args, **kwargs):
        result = original_loop(*args, **kwargs)
        if boundary == 'capture': mutate()
        return result
    monkeypatch.setattr(case.service, '_capture_rows', capture_loop)
    expected = {'session': ('forbidden', 403), 'catalog': ('artwork_preparation_unavailable', 409),
                'top_revision': ('revision_conflict', 409), 'preparation_revision': ('artwork_source_changed', 409)}[change]
    try:
        assert_error(lambda: advance_draft(case, status, payload), *expected)
    finally:
        # Restore only synthetic authority/revision mutations needed by teardown.
        if changed and change in {'session', 'top_revision'}:
            with case.db.connect() as connection:
                if change == 'session':
                    connection.execute('update app.account_sessions set revoked_at=null where id=%s', (case.db.owner.session_id,))
                else:
                    connection.execute('update app.album_lists set revision=revision-1 where ref=%s', (case.top['top_ref'],))
    assert changed == [True]
    state = snapshot(case)
    assert state['album_top_artwork_assets'] == []
    assert all(row['status'] == 'pending' for row in state['draft_items'])
    assert header(case, status)['completed_request_key'] is None


@pytest.mark.parametrize('boundary', ['capture', 'P2'])
@requires_posix_artwork
def test_failed_real_capture_does_not_bypass_complete_vector_gap_fence(draft_case, monkeypatch, boundary):
    case = draft_case.build(5)
    payload = command(case)
    status = start(case, payload)
    actual_capture = case.service.capture
    original_pixels = case.cover_paths[0].read_bytes()
    failed = []
    def missing_file_capture(source):
        if not failed:
            case.cover_paths[0].unlink()
            failed.append(True)
        return actual_capture(source)
    monkeypatch.setattr(case.service, 'capture', missing_file_capture)
    mutated, probes = [], []
    def mutate():
        with case.db.connect() as connection:
            connection.execute('update library.local_albums set cover_path=%s where id=%s',
                (str(case.cover_paths[1]), case.album_ids[-1]))
        mutated.append(True)
    original_loop = case.service._capture_rows
    def capture_loop(*args, **kwargs):
        result = original_loop(*args, **kwargs)
        assert result[payload['rows'][0]['row_ref']] is None
        # Preserve the genuine failed capture result, but restore the input so
        # the subsequent full-vector probe reaches the intended mutation gap.
        case.cover_paths[0].write_bytes(original_pixels)
        if boundary == 'capture': mutate()
        return result
    monkeypatch.setattr(case.service, '_capture_rows', capture_loop)
    original_probe = case.service._draft_probe
    def probe(value):
        result = original_probe(value)
        probes.append(True)
        if boundary == 'P2' and len(probes) == 2: mutate()
        return result
    monkeypatch.setattr(case.service, '_draft_probe', probe)
    assert_error(lambda: advance_draft(case, status, payload), 'artwork_source_changed', 409)
    assert failed == mutated == [True]
    state = snapshot(case)
    assert state['album_top_artwork_assets'] == []
    assert all(row['status'] == 'pending' for row in state['draft_items'])


@pytest.mark.parametrize('count', [250, 5000])
@requires_posix_artwork
def test_each_image_phase_has_derived_service_owned_query_ceiling(draft_case, monkeypatch, count, record_property):
    from contextlib import contextmanager
    case = draft_case.build(count, same_pixels=True)
    payload = command(case)
    status = start(case, payload)
    statements, phases = [], []
    foundation.observe_owner_connection(case, monkeypatch, lambda sql, params: statements.append(sql))
    authorized = case.service._authorized
    @contextmanager
    def observed(*args, **kwargs):
        offset = len(statements)
        with authorized(*args, **kwargs) as current:
            yield current
        phases.append(statements[offset:])
    monkeypatch.setattr(case.service, '_authorized', observed)
    response = advance_draft(case, status, payload)
    assert response['ready_count'] == 4 and len(phases) == 4
    pages = (count + 99) // 100
    base = 16 + 1 + 3 * pages
    for index, phase in enumerate(phases):
        ceiling = base + (4 if index in (1, 3) else 0)
        _assert_snapshot_query_pages(phase, count, 0, images=True, phases=1, maximum=ceiling)
        assert len(phase) <= (221 if index in (1, 3) else 217)
        record_property('typed_phase_' + str(index + 1) + '_sql_count', len(phase))


@pytest.mark.parametrize('change', ['inventory', 'root_policy'])
@requires_posix_artwork
def test_capture_gap_rechecks_root_inventory_and_policy(draft_case, monkeypatch, change):
    from music_app.services.owned_album_tops import AlbumTopError
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    case = draft_case.build(5)
    payload = command(case)
    status = start(case, payload)
    changed = []
    def constraints(context):
        blocked = (bool(changed) and change == 'root_policy' and context.resource is not None
            and context.resource.resource_kind == 'library_root'
            and context.resource.resource_ref == str(case.artwork_root))
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)
    original_loop = case.service._capture_rows
    def capture_loop(*args, **kwargs):
        result = original_loop(*args, **kwargs)
        if change == 'inventory':
            with case.db.connect() as connection:
                case.root(connection, case.directory / 'capture-gap-new-root')
        changed.append(True)
        return result
    monkeypatch.setattr(case.service, '_capture_rows', capture_loop)
    with pytest.raises(AlbumTopError) as caught:
        advance_draft(case, status, payload, constraints=constraints)
    assert caught.value.code in {'artwork_source_changed', 'forbidden'}
    assert changed == [True]
    state = snapshot(case)
    assert state['album_top_artwork_assets'] == []
    assert all(row['status'] == 'pending' for row in state['draft_items'])
    assert header(case, status)['completed_request_key'] is None


def test_5001_command_rows_reject_before_projection_probe_or_capture(draft_case, monkeypatch):
    from music_app.services import album_top_publication_evidence as evidence
    from music_app.services import album_top_artwork_draft as draft_owner
    case = draft_case.build(1)
    payload = command(case)
    payload['rows'] = [deepcopy(payload['rows'][0]) for _ in range(5001)]
    for row in payload['rows']:
        row['row_ref'] = str(uuid4())
    calls = []
    def forbidden(*args, **kwargs):
        calls.append(True)
        raise AssertionError('over-limit command reached source or image work')
    monkeypatch.setattr(evidence, 'selection_source', forbidden)
    monkeypatch.setattr(draft_owner, '_draft_item_selections', forbidden)
    monkeypatch.setattr(evidence, 'artwork_selection_page', forbidden)
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    monkeypatch.setattr(case.service, 'capture', forbidden)
    before = snapshot(case)
    assert_error(lambda: start(case, payload), 'invalid_command', 422)
    assert calls == [] and snapshot(case) == before


@pytest.mark.skipif(os.name != 'nt', reason='Checks actual Windows host rejection; no simulated native success')
def test_windows_public_descriptor_entry_fails_closed_before_capture(tmp_path):
    from music_app.services.public_top_artwork_acquisition import (
        ArtworkAcquisitionUnavailable, describe_artwork_source,
    )
    root = tmp_path / 'artwork'
    cover = root / 'cover.png'
    with pytest.raises(ArtworkAcquisitionUnavailable) as caught:
        describe_artwork_source(library_id=1, local_album_id=1, artwork_root_id=1,
            artwork_root_path=root, stored_cover_path=str(cover), resolved_cover_path=cover)
    assert str(caught.value) == 'artwork_platform_unavailable'


@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_saved_and_typed_no_image_entries_use_same_driver_without_probe(draft_case, monkeypatch, kind):
    from music_app.services import _top_artwork_preparation_phases as phases
    case = draft_case.build(2, excluded={0, 1})
    reads, advances = [], []
    original_read, original_advance = phases.read, phases.advance
    def read(service, identity, **options):
        reads.append(options['kind'])
        return original_read(service, identity, **options)
    def advance(service, identity, **options):
        advances.append(options['kind'])
        return original_advance(service, identity, **options)
    def forbidden(*args, **kwargs):
        raise AssertionError('No-image branch must not probe or capture')
    monkeypatch.setattr(phases, 'read', read)
    monkeypatch.setattr(phases, 'advance', advance)
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    monkeypatch.setattr(case.service, 'capture', forbidden)
    if kind == 'saved':
        status = case.start()
        assert case.read(status) == status
        result = case.advance(status)
    else:
        payload = command(case)
        status = start(case, payload)
        observed = read_draft(case, status, payload)
        result = advance_draft(case, observed, payload)
    assert result['state'] == 'ready' and result['included_count'] == 0
    assert reads == [kind] and advances == [kind]


@requires_posix_artwork
@pytest.mark.parametrize('kind', ['saved', 'draft'])
def test_shared_driver_retains_single_gate_through_actual_capture_and_final_exit(draft_case, monkeypatch, kind):
    from music_app.services import album_top_artwork_preparation as service_module
    case = draft_case.build(1)
    if kind == 'saved':
        status = case.start()
    else:
        payload = command(case)
        status = start(case, payload)
    capture, finish = case.service.capture, case.service._draft_finish
    gate = service_module._DECODE_REQUESTS
    observed = []
    def held(label):
        # Exactly one token belongs to this synchronous request. The other can
        # be acquired immediately; a third must remain unavailable.
        assert gate.acquire(blocking=False)
        try:
            assert not gate.acquire(blocking=False)
        finally:
            gate.release()
        observed.append(label)
    def acquired(source):
        held('capture')
        return capture(source)
    def finished(*args, **kwargs):
        held('finish')
        return finish(*args, **kwargs)
    monkeypatch.setattr(case.service, 'capture', acquired)
    monkeypatch.setattr(case.service, '_draft_finish', finished)
    result = case.advance(status) if kind == 'saved' else advance_draft(case, status, payload)
    assert result['ready_count'] == 1
    assert observed.count('capture') == 1 and observed.count('finish') == 4
    assert gate.acquire(blocking=False)
    try:
        assert gate.acquire(blocking=False)
        gate.release()
    finally:
        gate.release()


# S R2 B1: append-only typed missing-cover compatibility regressions. Genuine
# ready storage precedes the source mutation; no native success is substituted.
@pytest.mark.parametrize('cover', [None, '', 'x' * 16385, '\u00e9' * 8193])
@pytest.mark.parametrize('operation', ['read', 'empty_read', 'advance', 'latest_key'])
@requires_posix_artwork
def test_typed_ready_missing_current_cover_preserves_unavailable_before_proof_or_claim(
        draft_case, monkeypatch, cover, operation):
    case = draft_case.build(1)
    payload = command(case)
    started = start(case, payload)
    key, lease, refs = claim(case, started, payload)
    results, pngs = actual_results(case, payload, refs)
    complete(case, started, payload, key, lease, results, pngs)
    ready = refreshed(case, started)
    original_header = dict(header(case, ready))
    original_payload = deepcopy(payload)
    retained = snapshot(case)
    assert original_header['state'] == 'ready'
    assert str(original_header['completed_request_key']) == key
    assert original_header['completed_from_revision'] == int(started['preparation_revision'])
    with case.db.connect() as connection:
        connection.execute('update library.local_albums set cover_path=%s where library_id=%s and id=%s',
                           (cover, case.db.library, case.album_ids[0]))

    owner = foundation.preparation_module.artwork_draft
    projected, statements = [], []
    actual_projection = owner.evidence.artwork_selection_page

    def observe_projection(*args, **kwargs):
        page = actual_projection(*args, **kwargs)
        assert len(page) == 1
        source, _ = page[0]
        # NULL and SQL-bounded oversized strings project to NULL; empty text
        # remains empty. All four must keep the historical typed error mapping.
        assert source['cover_path'] == ('' if cover == '' else None)
        projected.append(source['cover_path'])
        return page

    def forbidden(*args, **kwargs):
        raise AssertionError('Missing typed current cover reached proof, probe, capture, claim or status')

    def executed(sql, params):
        statements.append(sql)
        assert not sql.startswith('select row_ref,position,source_stamp,acquisition_stamp')
        assert not sql.startswith('select app.claim_top_artwork_draft_batch')
        assert not sql.startswith('select app.complete_top_artwork_draft_batch')
        assert not sql.startswith("select count(*) filter(where status='ready')")

    with monkeypatch.context() as guarded:
        guarded.setattr(owner.evidence, 'artwork_selection_page', observe_projection)
        guarded.setattr(owner.proof, 'ready_binding', forbidden)
        guarded.setattr(owner, 'status', forbidden)
        guarded.setattr(case.service, '_draft_probe', forbidden)
        guarded.setattr(case.service, 'capture', forbidden)
        guarded.setattr(case.service, '_draft_claim', forbidden)
        foundation.observe_owner_connection(case, guarded, executed)
        if operation in ('read', 'empty_read'):
            invoke = lambda: read_draft(case, ready, payload,
                after=5000 if operation == 'empty_read' else 0, limit=1)
        elif operation == 'advance':
            invoke = lambda: advance_draft(case, ready, payload)
        else:
            # Recover exactly the completed key with its original from-revision.
            # A stale/replacement key would exercise a different error boundary.
            invoke = lambda: case.service.advance_draft(case.db.context(), top_ref=case.top['top_ref'],
                preparation_ref=started['preparation_ref'], top_revision_value=case.top['revision'],
                draft_ref=payload['draft_ref'], draft_revision=payload['draft_revision'],
                preparation_revision=started['preparation_revision'], request_key=key, context_ref=CONTEXT)
        assert_error(invoke, 'artwork_unavailable', 409)
    assert len(projected) == 1
    assert sum(sql.startswith('with wanted as') for sql in statements) == 1
    assert snapshot(case) == retained and dict(header(case, ready)) == original_header
    assert payload == original_payload
    # Restoring the exact current selection recovers the same retained proof,
    # generation, lifetime and latest receipt, without requiring any recapture.
    with case.db.connect() as connection:
        connection.execute('update library.local_albums set cover_path=%s where library_id=%s and id=%s',
                           (str(case.cover_paths[0]), case.db.library, case.album_ids[0]))
    with monkeypatch.context() as guarded:
        guarded.setattr(case.service, 'capture', forbidden)
        recovered = case.service.advance_draft(case.db.context(), top_ref=case.top['top_ref'],
            preparation_ref=started['preparation_ref'], top_revision_value=case.top['revision'],
            draft_ref=payload['draft_ref'], draft_revision=payload['draft_revision'],
            preparation_revision=started['preparation_revision'], request_key=key, context_ref=CONTEXT)
        assert recovered['state'] == 'ready' and recovered['ready_count'] == 1
        assert read_draft(case, recovered, payload)['ready_count'] == 1
    assert snapshot(case) == retained and dict(header(case, ready)) == original_header


@pytest.mark.parametrize('boundary', ['p1', 'capture', 'p2'])
@requires_posix_artwork
def test_saved_root_policy_correction_leaves_typed_gap_comparison_unchanged(
        draft_case, monkeypatch, boundary):
    case = draft_case.build(5)
    payload = command(case)
    started = start(case, payload)
    before = snapshot(case)
    original_probe, original_loop = case.service._draft_probe, case.service._capture_rows
    denied, probes, captures = [False], [], []

    def constraints(context):
        resource = context.resource
        blocked = (denied[0] and context.action == 'library.browse.read'
            and resource is not None and resource.resource_kind == 'library_root'
            and resource.resource_ref == str(case.artwork_root))
        if resource is not None and resource.resource_ref == str(case.metadata_root):
            assert blocked is False
        return foundation.PolicyEvaluationConstraints(request_origin_allowed=not blocked)

    def probe(value):
        assert not denied[0]
        result = original_probe(value)
        assert {observed.root_id for observed, _ in result.values()} == {case.artwork_root}
        probes.append(True)
        if boundary == ('p1' if len(probes) == 1 else 'p2'):
            denied[0] = True
        return result

    def capture_loop(*args, **kwargs):
        assert boundary != 'p1' and not denied[0]
        result = original_loop(*args, **kwargs)
        assert len(result) == 4 and all(value is not None for value in result.values())
        captures.append(True)
        if boundary == 'capture':
            denied[0] = True
        return result

    def forbidden(*args, **kwargs):
        raise AssertionError('Typed operation reached saved-only root policy or safe status')

    monkeypatch.setattr(case.service, '_draft_probe', probe)
    monkeypatch.setattr(case.service, '_capture_rows', capture_loop)
    monkeypatch.setattr(foundation.preparation_module.saved_artwork, 'require_observed_roots', forbidden)
    monkeypatch.setattr(foundation.preparation_module.artwork_draft, 'status', forbidden)
    assert_error(lambda: advance_draft(case, started, payload, constraints=constraints),
                 'artwork_source_changed', 409)
    assert denied[0] is True and len(probes) == (2 if boundary == 'p2' else 1)
    assert len(captures) == int(boundary != 'p1')
    after = snapshot(case)
    # The original typed A2 lease semantics are unchanged; every durable row,
    # proof, receipt, generation and budget must otherwise remain byte-equivalent.
    for state in (before, after):
        for row in state['album_top_artwork_preparations']:
            for key in ('lease_ref', 'lease_expires_at', 'batch_request_key', 'batch_from_revision', 'batch_items'):
                row.pop(key)
    assert after == before
    assert (header(case, started)['lease_ref'] is None) is (boundary == 'p1')
