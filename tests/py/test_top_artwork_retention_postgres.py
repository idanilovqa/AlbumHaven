"""Source-only retention contracts; run only in the admitted synthetic SQL DB.

Reuse the genuine migrator/runtime/owner fixture. No production authority,
connection results, SQL transitions or policy grants are mocked. The
large-manifest fixture omits image creation because start must not decode it.
"""
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest

from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error
from tests.py import test_album_top_artwork_preparation_postgres as foundation
from tests.py.test_album_top_artwork_preparation_postgres import artwork, CONTEXT, ZERO

START = 'app.start_top_artwork_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb,bigint)'
UNMETERED = 'app.start_top_artwork_preparation_unmetered(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb)'
CLEANUP = 'app.cleanup_top_artwork_preparations(uuid,bigint,bigint,bigint)'


def cleanup(case):
    return case.service.cleanup(case.db.context(), top_ref=case.top['top_ref'],
        top_revision_value=case.top['revision'], context_ref=CONTEXT)


def budgets(case):
    return {str(row['scope_ref']): row for row in case.snapshot()['album_top_artwork_budgets']}


def assert_reservation(case, headers, items, proof_bytes):
    values = budgets(case)
    for scope in (ZERO, case.top['top_ref']):
        assert tuple(values[scope][key] for key in ('preparation_count', 'item_count', 'proof_bytes')) == (headers, items, proof_bytes)


def retire(case, ref, *, expired=False):
    with case.db.connect() as connection:
        if expired:
            connection.execute("""with t as (select clock_timestamp()-interval '1 second' as expiry)
                update app.album_top_artwork_preparations set state='cancelled',
                created_at=t.expiry-interval '60 minutes',expires_at=t.expiry,
                lease_ref=null,lease_expires_at=null,batch_request_key=null,batch_from_revision=null,batch_items=null
                from t where ref=%s""", (ref,))
        else:
            connection.execute("""update app.album_top_artwork_preparations set state='cancelled',
                lease_ref=null,lease_expires_at=null,batch_request_key=null,batch_from_revision=null,batch_items=null
                where ref=%s""", (ref,))


def test_start_reserves_exact_manifest_once_and_retains_absolute_generation(artwork):
    case = artwork.build(4, excluded=(1, 3))
    first = case.start()
    assert_reservation(case, 1, 4, 1024 + 2 * 69632 + 2 * 1024)
    before = case.snapshot()
    assert case.start() == first
    assert case.snapshot() == before
    row = before['album_top_artwork_preparations'][0]
    assert int(row['created_at'].timestamp()) == case.payload['request_generation']
    assert (row['expires_at'] - row['created_at']).total_seconds() == 3600
    changed = {**case.payload, 'request_generation': case.payload['request_generation'] - 1}
    assert_error(lambda: case.start(payload=changed), 'request_key_conflict', 409)
    assert case.snapshot() == before


@pytest.mark.parametrize('offset', [-3601, 60])
def test_database_rejects_expired_or_future_request_generation(artwork, offset):
    case = artwork.build(1)
    before = case.snapshot()
    assert_error(lambda: case.start(payload={**case.payload,
        'request_generation': case.payload['request_generation'] + offset}), 'artwork_request_expired', 409)
    assert case.snapshot() == before


@pytest.mark.parametrize('value', [None, True, 0, -1, '123', 253402300800])
def test_generation_requires_bounded_integer(artwork, value):
    case = artwork.build(1)
    assert_error(lambda: case.start(payload={**case.payload, 'request_generation': value}), 'invalid_command', 422)
    assert not case.snapshot()['album_top_artwork_preparations']


def test_maximum_included_manifest_fits_without_pixel_work(artwork, monkeypatch):
    # Only fixture image creation is omitted; real source/catalog/membership and
    # actual current SQL/policy checks are unchanged. No fake authority results.
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = artwork.build(5000)
    def forbidden(*args, **kwargs):
        raise AssertionError('Start must not acquire or decode pixels')
    case.service.capture = forbidden
    case.service.describe = forbidden
    started = case.start()
    assert started['item_count'] == started['included_count'] == 5000
    assert started['ready_count'] == 0
    assert_reservation(case, 1, 5000, 348161024)
    assert not case.snapshot()['album_top_artwork_assets']


@pytest.mark.parametrize('scope,field,maximum', [
    ('top', 'preparation_count', 64), ('account', 'preparation_count', 256),
    ('top', 'item_count', 20000), ('account', 'item_count', 100000),
    ('top', 'proof_bytes', 536870912), ('account', 'proof_bytes', 4294967296),
])
def test_sql_admission_limit_preserves_prior_active_preparation(artwork, scope, field, maximum):
    case = artwork.build(1)
    started = case.start()
    scope_ref = case.top['top_ref'] if scope == 'top' else ZERO
    # Synthetic counter pressure isolates each SQL-side predicate. Restoration
    # is unnecessary because fixture teardown owns all this test's scoped rows.
    with case.db.connect() as connection:
        connection.execute(f'update app.album_top_artwork_budgets set {field}=%s where owner_account_id=%s and scope_ref=%s',
            (maximum, case.db.owner.account_id, scope_ref))
    before = case.snapshot()
    assert_error(lambda: case.start(payload={**case.payload, 'request_key': str(uuid4())}), 'artwork_retention_limit', 409)
    assert case.snapshot() == before
    assert case.read(started)['state'] == 'preparing'


def test_cleanup_keeps_cancelled_key_tombstone_and_does_not_extend_request(artwork):
    case = artwork.build(3)
    first = case.start()
    retire(case, first['preparation_ref'])
    result = cleanup(case)
    assert result == {'preparations_deleted': 0, 'items_deleted': 3, 'assets_deleted': 0,
                      'assets_scanned': 0, 'tombstones_retained': 1}
    assert_reservation(case, 1, 0, 1024)
    before = case.snapshot()
    assert_error(case.start, 'artwork_preparation_unavailable', 409)
    assert case.snapshot() == before
    retire(case, first['preparation_ref'], expired=True)
    assert cleanup(case)['preparations_deleted'] == 1
    assert_reservation(case, 0, 0, 0)
    assert cleanup(case)['preparations_deleted'] == 0


def test_cleanup_is_globally_bounded_to_512_items_and_32_headers(artwork, monkeypatch):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = artwork.build(600)
    first = case.start()
    retire(case, first['preparation_ref'], expired=True)
    first_pass = cleanup(case)
    assert first_pass['items_deleted'] == 512 and first_pass['preparations_deleted'] == 0
    assert_reservation(case, 1, 88, 1024 + 88 * 69632)
    before = case.snapshot()
    assert_error(lambda: case.advance(first), 'artwork_preparation_unavailable', 409)
    assert case.snapshot() == before
    second_pass = cleanup(case)
    assert second_pass['items_deleted'] == 88 and second_pass['preparations_deleted'] == 1
    assert_reservation(case, 0, 0, 0)
    assert not case.snapshot()['album_top_artwork_preparations']


def test_cleanup_does_not_touch_live_batch_or_decode(artwork):
    case = artwork.build(1)
    started = case.start()
    key, lease, chosen = case.claim(started)
    before = case.snapshot()
    def forbidden(*args, **kwargs):
        raise AssertionError('Cleanup must not resolve artwork or decode')
    case.service.capture = case.service.describe = case.service.resolver = forbidden
    result = cleanup(case)
    assert result['items_deleted'] == result['preparations_deleted'] == 0
    assert case.snapshot() == before


def test_deduplicated_asset_survives_other_live_preparation_then_reclaims_once(artwork):
    case = artwork.build(1)
    first = case.advance(case.start())
    second = case.start(payload={**case.payload, 'request_key': str(uuid4())})
    second = case.advance(second)
    assert len(case.snapshot()['album_top_artwork_assets']) == 1
    # The new start cancelled the first; cleanup removes its proof but the new
    # ready proof still pins the same immutable PNG.
    cleanup(case)
    assert len(case.snapshot()['album_top_artwork_assets']) == 1
    retire(case, second['preparation_ref'], expired=True)
    result = cleanup(case)
    assert result['assets_deleted'] == 1
    assert not case.snapshot()['album_top_artwork_assets']
    for row in budgets(case).values():
        assert row['asset_count'] == row['byte_count'] == 0
    assert cleanup(case)['assets_deleted'] == 0


def test_runtime_cannot_mint_permits_call_unmetered_start_or_mutate_counters(artwork):
    case = artwork.build(1)
    case.start()
    with psycopg.connect(case.db.app_url, row_factory=dict_row) as runtime:
        connected_role = foundation.assert_runtime_role(runtime, case.db)
    with case.db.connect() as connection:
        for role in dict.fromkeys(('album_haven_app', connected_role)):
            for signature in (UNMETERED, 'app.lock_top_artwork_budgets(uuid,bigint,bigint)'):
                assert connection.execute("select has_function_privilege(%s,%s,'EXECUTE') as allowed",
                    (role, signature)).fetchone()['allowed'] is False
            for signature in (START, CLEANUP):
                assert connection.execute("select has_function_privilege(%s,%s,'EXECUTE') as allowed",
                    (role, signature)).fetchone()['allowed'] is True
        for role in dict.fromkeys(('album_haven_app', connected_role, 'album_haven_readonly')):
            for privilege in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'):
                assert connection.execute("select has_table_privilege(%s,'app.album_top_artwork_cleanup_permits',%s) as allowed",
                    (role, privilege)).fetchone()['allowed'] is False
    statements = [
        ('select * from app.album_top_artwork_cleanup_permits', ()),
        ('select app.start_top_artwork_preparation_unmetered(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
         (str(uuid4()), case.top['top_ref'], case.db.library, case.db.owner.account_id,
          case.db.owner.session_id, CONTEXT, int(case.top['revision']), str(uuid4()), 'a' * 64, Jsonb([]))),
        ("insert into app.album_top_artwork_cleanup_permits values(txid_current(),pg_backend_pid(),'asset',%s,%s)",
         (case.top['top_ref'], str(uuid4()))),
        ('update app.album_top_artwork_budgets set proof_bytes=0 where owner_account_id=%s', (case.db.owner.account_id,)),
        ('delete from app.album_top_artwork_preparations where top_ref=%s', (case.top['top_ref'],)),
    ]
    for statement, parameters in statements:
        with psycopg.connect(case.db.app_url, row_factory=dict_row) as connection:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                connection.execute(statement, parameters)
            connection.rollback()


def test_cleanup_current_permission_denial_rolls_back(artwork):
    case = artwork.build(2)
    started = case.start()
    retire(case, started['preparation_ref'])
    before = case.snapshot()
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != foundation.ACCESS)
    assert_error(lambda: case.service.cleanup(case.db.context(), top_ref=case.top['top_ref'],
        top_revision_value=case.top['revision'], context_ref=CONTEXT, constraints=constraints), 'forbidden', 403)
    assert case.snapshot() == before


def test_nonempty_legacy_backfill_preserves_rows_and_real_overlimit_usage(artwork):
    case = artwork.build(2, excluded=(1,))
    case.advance(case.start())
    migration = Path(__file__).resolve().parents[2] / 'migrations/postgres/0129_top_artwork_retention.sql'
    # Reconstruct only this migration's preimage transactionally in the isolated
    # synthetic database; never commit a downgrade or weaken the runtime fixture.
    with case.db.connect() as connection:
        with connection.transaction(force_rollback=True):
            connection.execute('lock table app.album_top_artwork_preparations,app.album_top_artwork_preparation_items,app.album_top_artwork_assets,app.album_top_artwork_budgets in access exclusive mode')
            before = connection.execute('select ref,manifest_digest,item_count from app.album_top_artwork_preparations order by ref').fetchall()
            retained_assets = connection.execute('select * from app.album_top_artwork_assets where top_ref=%s order by ref', (case.top['top_ref'],)).fetchall()
            assert len(retained_assets) == 1
            connection.execute('drop function ' + START)
            connection.execute('drop function ' + CLEANUP)
            connection.execute('drop function app.lock_top_artwork_budgets(uuid,bigint,bigint)')
            connection.execute('alter function ' + UNMETERED + ' rename to start_top_artwork_preparation')
            connection.execute('drop table app.album_top_artwork_cleanup_permits')
            for name in ('top_artwork_expiry_cleanup', 'top_artwork_cancelled_cleanup', 'top_artwork_asset_scan', 'top_artwork_asset_references'):
                connection.execute('drop index app.' + name)
            connection.execute('alter table app.album_top_artwork_preparations drop column request_generation,drop column retained_item_count')
            connection.execute('alter table app.album_top_artwork_budgets drop column preparation_count,drop column item_count,drop column proof_bytes,drop column cleanup_asset_after')
            # Add 65 cancelled legacy empty manifests. A real over-limit header
            # count must survive the upgrade, rather than being clamped/deleted.
            for _ in range(65):
                connection.execute("""insert into app.album_top_artwork_preparations
                    (ref,top_ref,library_id,owner_account_id,original_session_id,context_ref,top_revision,
                     start_request_key,manifest_digest,item_count,created_at,expires_at,state)
                    select %s,top_ref,library_id,owner_account_id,original_session_id,context_ref,top_revision,
                     %s,manifest_digest,0,created_at,expires_at,'cancelled'
                    from app.album_top_artwork_preparations where top_ref=%s limit 1""",
                    (str(uuid4()), str(uuid4()), case.top['top_ref']))
            connection.execute(migration.read_text())
            rows = connection.execute('select ref,manifest_digest,item_count from app.album_top_artwork_preparations order by ref').fetchall()
            assert all(row in rows for row in before)
            for scope in (ZERO, case.top['top_ref']):
                row = connection.execute('select preparation_count,item_count,proof_bytes from app.album_top_artwork_budgets where owner_account_id=%s and scope_ref=%s',
                    (case.db.owner.account_id, scope)).fetchone()
                assert row == {'preparation_count': 66, 'item_count': 2, 'proof_bytes': 66 * 1024 + 69632 + 1024}
            assert connection.execute('select count(*) as n from app.album_top_artwork_cleanup_permits').fetchone()['n'] == 0
            assert connection.execute('select * from app.album_top_artwork_assets where top_ref=%s order by ref', (case.top['top_ref'],)).fetchall() == retained_assets
            for scope in (ZERO, case.top['top_ref']):
                assert connection.execute('select asset_count,byte_count from app.album_top_artwork_budgets where owner_account_id=%s and scope_ref=%s',
                    (case.db.owner.account_id, scope)).fetchone() == {'asset_count': 1, 'byte_count': retained_assets[0]['byte_length']}


def test_direct_runtime_helper_enforces_generation_without_python_validation(artwork):
    case = artwork.build(1)
    case.start()
    with case.db.connect() as connection:
        row = connection.execute('select * from app.album_top_artwork_preparations where top_ref=%s',
            (case.top['top_ref'],)).fetchone()
        manifest = connection.execute('''select item_ref,catalog_ref,position,selected_local_album_id,
            selected_source_ref,selected_library_root_id,included
            from app.album_top_artwork_preparation_items where preparation_ref=%s order by position''',
            (row['ref'],)).fetchall()
    # Jsonb needs wire-safe UUIDs, exactly as the service's manifest normalizer.
    manifest = [{key: str(value) if key in {'item_ref', 'catalog_ref', 'selected_source_ref'} else value
                 for key, value in item.items()} for item in manifest]
    before = case.snapshot()
    with psycopg.connect(case.db.app_url, row_factory=dict_row) as connection:
        with pytest.raises(psycopg.errors.CheckViolation) as failure:
            connection.execute('select app.start_top_artwork_preparation(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (str(uuid4()), case.top['top_ref'], case.db.library, case.db.owner.account_id,
                 case.db.owner.session_id, CONTEXT, int(case.top['revision']), str(uuid4()),
                 'c' * 64, Jsonb(manifest), case.payload['request_generation'] - 3601))
        assert failure.value.diag.constraint_name == 'top_artwork_request_expired'
        connection.rollback()
    assert case.snapshot() == before


def test_runtime_cleanup_serializes_with_real_top_read_lock(artwork):
    case = artwork.build(1)
    started = case.start()
    retire(case, started['preparation_ref'])
    before = case.snapshot()
    with psycopg.connect(case.db.app_url, row_factory=dict_row) as reader:
        reader.execute('select ref from app.album_lists where ref=%s for share', (case.top['top_ref'],)).fetchone()
        with psycopg.connect(case.db.app_url, row_factory=dict_row) as cleaner:
            cleaner.execute("set local lock_timeout='100ms'")
            with pytest.raises(psycopg.errors.LockNotAvailable):
                cleaner.execute('select app.cleanup_top_artwork_preparations(%s,%s,%s,%s)',
                    (case.top['top_ref'], case.db.library, case.db.owner.account_id, int(case.top['revision'])))
            cleaner.rollback()
        reader.rollback()
    assert case.snapshot() == before
    assert cleanup(case)['items_deleted'] == 1


def test_cleanup_failure_rolls_back_deleted_rows_counters_and_permits(artwork):
    case = artwork.build(2)
    started = case.start()
    retire(case, started['preparation_ref'])
    # Force an actual nonnegative-budget constraint failure after DELETE. This
    # proves transactional rollback of the guards/permits and both budget rows.
    with case.db.connect() as connection:
        connection.execute('update app.album_top_artwork_budgets set item_count=0 where owner_account_id=%s and scope_ref=%s',
            (case.db.owner.account_id, ZERO))
    before = case.snapshot()
    with pytest.raises(AlbumTopError):
        cleanup(case)
    assert case.snapshot() == before
    with case.db.connect() as connection:
        assert connection.execute('select count(*) as n from app.album_top_artwork_cleanup_permits').fetchone()['n'] == 0


def test_cleanup_header_selection_is_bounded_for_empty_tombstones(artwork):
    case = artwork.build(0)
    for _ in range(40):
        case.start(payload={**case.payload, 'request_key': str(uuid4())})
    assert_reservation(case, 40, 0, 40 * 1024)
    with case.db.connect() as connection:
        connection.execute("""with t as (select clock_timestamp()-interval '1 second' as expiry)
            update app.album_top_artwork_preparations set state='cancelled',
                created_at=t.expiry-interval '60 minutes',expires_at=t.expiry
            from t where top_ref=%s""", (case.top['top_ref'],))
    assert cleanup(case)['preparations_deleted'] == 32
    assert_reservation(case, 8, 0, 8 * 1024)
    assert cleanup(case)['preparations_deleted'] == 8
    assert_reservation(case, 0, 0, 0)


def test_asset_scan_window_is_bounded_even_when_every_asset_is_referenced(artwork):
    case = artwork.build(129)
    status = case.start()
    while status['state'] != 'ready':
        status = case.advance(status)
    first = cleanup(case)
    assert first['assets_scanned'] == 128 and first['assets_deleted'] == 0
    second = cleanup(case)
    assert second['assets_scanned'] == 1 and second['assets_deleted'] == 0
    assert len(case.snapshot()['album_top_artwork_assets']) == 129
    assert budgets(case)[case.top['top_ref']]['cleanup_asset_after'] is None


def test_two_top_cleanup_calls_serialize_on_shared_account_budget(artwork):
    case = artwork.build(1)
    case.start()
    other, _ = case.db.create(refs=case.catalog_refs)
    with psycopg.connect(case.db.app_url, row_factory=dict_row) as first:
        first.execute('select app.cleanup_top_artwork_preparations(%s,%s,%s,%s)',
            (case.top['top_ref'], case.db.library, case.db.owner.account_id, int(case.top['revision'])))
        with psycopg.connect(case.db.app_url, row_factory=dict_row) as second:
            second.execute("set local lock_timeout='100ms'")
            with pytest.raises(psycopg.errors.LockNotAvailable):
                second.execute('select app.cleanup_top_artwork_preparations(%s,%s,%s,%s)',
                    (other['top_ref'], case.db.library, case.db.owner.account_id, int(other['revision'])))
            second.rollback()
        first.rollback()


def sql_manifest(case):
    with case.db.connect() as connection:
        rows = connection.execute('''select item_ref,catalog_ref,position,selected_local_album_id,
            selected_source_ref,selected_library_root_id,included
            from app.album_top_artwork_preparation_items where preparation_ref=(
              select ref from app.album_top_artwork_preparations where top_ref=%s
                and state in ('preparing','ready') order by created_at desc limit 1)
            order by position''', (case.top['top_ref'],)).fetchall()
    return [{key: str(value) if key in {'item_ref', 'catalog_ref', 'selected_source_ref'} else value
             for key, value in row.items()} for row in rows]


def direct_start(case, rows, *, generation=None, key=None, connection=None, session=None):
    args = (str(uuid4()), case.top['top_ref'], case.db.library, case.db.owner.account_id,
            session or case.db.owner.session_id, CONTEXT, int(case.top['revision']), key or str(uuid4()),
            'd' * 64, Jsonb(rows), generation if generation is not None else case.payload['request_generation'])
    query = 'select app.start_top_artwork_preparation(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) as ref'
    if connection is not None:
        return connection.execute(query, args).fetchone()['ref']
    with psycopg.connect(case.db.app_url, row_factory=dict_row) as runtime:
        foundation.assert_runtime_role(runtime, case.db)
        return runtime.execute(query, args).fetchone()['ref']


@pytest.mark.parametrize('bad', ['true', 'false', 't', '1', 1, 0, None, [], {}, ['true']])
def test_direct_sql_rejects_non_boolean_included_even_after_literal_true(artwork, bad):
    case = artwork.build(2)
    case.start()
    rows = sql_manifest(case)
    rows[0]['included'] = True
    rows[-1]['included'] = bad
    before = case.snapshot()
    with pytest.raises(psycopg.errors.CheckViolation) as failure:
        direct_start(case, rows)
    assert failure.value.diag.constraint_name == 'top_artwork_manifest'
    assert case.snapshot() == before
    with case.db.connect() as connection:
        assert connection.execute('select count(*) as n from app.album_top_artwork_cleanup_permits').fetchone()['n'] == 0


@pytest.mark.parametrize('bad', [None, True, 1, 'row', [], ['item']])
def test_direct_sql_rejects_non_object_tail_without_partial_work(artwork, bad):
    case = artwork.build(2)
    case.start()
    rows = sql_manifest(case)
    rows[-1] = bad
    before = case.snapshot()
    with pytest.raises(psycopg.errors.CheckViolation) as failure:
        direct_start(case, rows)
    assert failure.value.diag.constraint_name == 'top_artwork_manifest'
    assert case.snapshot() == before


@pytest.mark.parametrize('change', ['missing_included', 'missing_source', 'extra_field', 'duplicate_item',
    'duplicate_catalog', 'duplicate_position', 'omitted_row', 'substituted_source', 'invalid_tail'])
def test_direct_sql_preserves_complete_saved_manifest_safeguards(artwork, change):
    case = artwork.build(2)
    case.start()
    rows = sql_manifest(case)
    if change == 'missing_included':
        rows[-1].pop('included')
    elif change == 'missing_source':
        rows[-1].pop('selected_source_ref')
    elif change == 'extra_field':
        rows[-1]['untrusted'] = True
    elif change.startswith('duplicate_'):
        field = {'duplicate_item': 'item_ref', 'duplicate_catalog': 'catalog_ref', 'duplicate_position': 'position'}[change]
        rows[-1][field] = rows[0][field]
    elif change == 'omitted_row':
        rows.pop()
    elif change == 'substituted_source':
        rows[-1]['selected_source_ref'] = rows[0]['selected_source_ref']
    else:
        rows[-1]['item_ref'] = str(uuid4())
    before = case.snapshot()
    with pytest.raises(psycopg.IntegrityError):
        direct_start(case, rows)
    assert case.snapshot() == before


@pytest.mark.parametrize('choices', [(True, True), (False, False), (True, False)])
def test_direct_sql_literal_choices_match_stored_state_and_exact_charge(artwork, choices):
    case = artwork.build(2)
    case.start()
    rows = sql_manifest(case)
    for row, included in zip(rows, choices):
        row['included'] = included
    ref = direct_start(case, rows)
    with case.db.connect() as connection:
        stored = connection.execute('select included,status from app.album_top_artwork_preparation_items where preparation_ref=%s order by position', (ref,)).fetchall()
        assert stored == [{'included': included, 'status': 'pending' if included else 'excluded'} for included in choices]
        state = connection.execute('select state from app.album_top_artwork_preparations where ref=%s', (ref,)).fetchone()['state']
        assert state == ('preparing' if any(choices) else 'ready')
        # Compare counters to actual persisted booleans across both retained
        # manifests, not to classifications supplied by the caller.
        actual = connection.execute('''select count(*) as rows,
            sum(case when included then 69632 else 1024 end) as bytes
            from app.album_top_artwork_preparation_items where top_ref=%s''', (case.top['top_ref'],)).fetchone()
    assert_reservation(case, 2, actual['rows'], 2048 + actual['bytes'])


def test_actual_expiry_deleted_header_rejects_old_generation_accepts_distinct_new_generation(artwork):
    case = artwork.build(1)
    case.start()
    rows = sql_manifest(case)
    with case.db.connect() as connection:
        generation = connection.execute('select floor(extract(epoch from clock_timestamp()))::bigint-3595 as value').fetchone()['value']
    key = str(uuid4())
    ref = direct_start(case, rows, generation=generation, key=key)
    # Let genuine PostgreSQL time expire this original five-second remainder;
    # do not rewrite created_at/expires_at or pretend the old request expired.
    with case.db.connect() as connection:
        remaining = connection.execute('select greatest(extract(epoch from expires_at-clock_timestamp()),0) as wait from app.album_top_artwork_preparations where ref=%s', (ref,)).fetchone()['wait']
        assert 0 <= remaining <= 5
        connection.execute('select pg_sleep(%s)', (float(remaining) + 0.05,))
    cleanup(case)
    with case.db.connect() as connection:
        assert connection.execute('select ref from app.album_top_artwork_preparations where ref=%s', (ref,)).fetchone() is None
    before = case.snapshot()
    with pytest.raises(psycopg.errors.CheckViolation) as failure:
        direct_start(case, rows, generation=generation, key=key)
    assert failure.value.diag.constraint_name == 'top_artwork_request_expired'
    assert case.snapshot() == before
    with case.db.connect() as connection:
        fresh = connection.execute('select floor(extract(epoch from clock_timestamp()))::bigint as value').fetchone()['value']
    replacement = direct_start(case, rows, generation=fresh, key=key)
    assert replacement != ref
    assert direct_start(case, rows, generation=fresh, key=key) == replacement


def test_maximum_manifest_reclaims_in_ten_bounded_passes(artwork, monkeypatch):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = artwork.build(5000)
    started = case.start()
    retire(case, started['preparation_ref'], expired=True)
    passes = [cleanup(case) for _ in range(10)]
    assert [value['items_deleted'] for value in passes] == [512] * 9 + [392]
    assert sum(value['preparations_deleted'] for value in passes) == 1
    assert_reservation(case, 0, 0, 0)


def test_cancelled_claim_cannot_complete_after_cleanup(artwork):
    case = artwork.build(1)
    started = case.start()
    key, lease, chosen = case.claim(started)
    results, pngs = case.results(chosen)
    retire(case, started['preparation_ref'])
    cleanup(case)
    before = case.snapshot()
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
        case.complete(started, key, lease, results, pngs)
    assert case.snapshot() == before


def test_nonempty_legacy_item_and_proof_overage_is_backfilled_without_clamping(artwork, monkeypatch):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = artwork.build(5000)
    started = case.start()
    migration = Path(__file__).resolve().parents[2] / 'migrations/postgres/0129_top_artwork_retention.sql'
    with case.db.connect() as connection:
        with connection.transaction(force_rollback=True):
            connection.execute('lock table app.album_top_artwork_preparations,app.album_top_artwork_preparation_items,app.album_top_artwork_assets,app.album_top_artwork_budgets in access exclusive mode')
            connection.execute('drop function ' + START)
            connection.execute('drop function ' + CLEANUP)
            connection.execute('drop function app.lock_top_artwork_budgets(uuid,bigint,bigint)')
            connection.execute('alter function ' + UNMETERED + ' rename to start_top_artwork_preparation')
            connection.execute('drop table app.album_top_artwork_cleanup_permits')
            for name in ('top_artwork_expiry_cleanup', 'top_artwork_cancelled_cleanup', 'top_artwork_asset_scan', 'top_artwork_asset_references'):
                connection.execute('drop index app.' + name)
            connection.execute('alter table app.album_top_artwork_preparations drop column request_generation,drop column retained_item_count')
            connection.execute('alter table app.album_top_artwork_budgets drop column preparation_count,drop column item_count,drop column proof_bytes,drop column cleanup_asset_after')
            for _ in range(4):
                ref = str(uuid4())
                connection.execute('''insert into app.album_top_artwork_preparations
                    (ref,top_ref,library_id,owner_account_id,original_session_id,context_ref,top_revision,
                     start_request_key,manifest_digest,item_count,created_at,expires_at,state)
                    select %s,top_ref,library_id,owner_account_id,original_session_id,context_ref,top_revision,
                     %s,manifest_digest,item_count,created_at,expires_at,'cancelled'
                    from app.album_top_artwork_preparations where ref=%s''', (ref, str(uuid4()), started['preparation_ref']))
                connection.execute('''insert into app.album_top_artwork_preparation_items
                    (preparation_ref,top_ref,library_id,owner_account_id,item_ref,catalog_ref,position,
                     selected_local_album_id,selected_source_ref,selected_library_root_id,included,status)
                    select %s,top_ref,library_id,owner_account_id,item_ref,catalog_ref,position,
                     selected_local_album_id,selected_source_ref,selected_library_root_id,included,status
                    from app.album_top_artwork_preparation_items where preparation_ref=%s''', (ref, started['preparation_ref']))
            connection.execute(migration.read_text())
            assert connection.execute('select count(*) as n from app.album_top_artwork_preparation_items where top_ref=%s', (case.top['top_ref'],)).fetchone()['n'] == 25000
            for scope in (ZERO, case.top['top_ref']):
                assert connection.execute('select preparation_count,item_count,proof_bytes from app.album_top_artwork_budgets where owner_account_id=%s and scope_ref=%s',
                    (case.db.owner.account_id, scope)).fetchone() == {'preparation_count': 5, 'item_count': 25000, 'proof_bytes': 5 * 348161024}
            # Guarded cleanup works on actual oversized legacy state, releasing
            # only its real bounded rows instead of fabricating a fitting count.
            result = connection.execute('select app.cleanup_top_artwork_preparations(%s,%s,%s,%s) as value',
                (case.top['top_ref'], case.db.library, case.db.owner.account_id, int(case.top['revision']))).fetchone()['value']
            assert result['items_deleted'] == 512
            assert connection.execute('select item_count from app.album_top_artwork_budgets where owner_account_id=%s and scope_ref=%s',
                (case.db.owner.account_id, case.top['top_ref'])).fetchone()['item_count'] == 25000 - 512


@pytest.mark.parametrize('scope', ['top', 'account'])
def test_near_limit_multi_session_admission_serializes_then_rejects_without_leak(artwork, scope):
    from types import SimpleNamespace
    case = artwork.build(1)
    case.start()
    rows = sql_manifest(case)
    actor = foundation.new_session(case.db, case.db.owner)
    second_case, second_rows = case, rows
    if scope == 'account':
        other, _ = case.db.create(refs=case.catalog_refs)
        new_item = case.db.read(other)['items'][0]
        second_case = SimpleNamespace(db=case.db, top=other, payload=case.payload)
        second_rows = [{**rows[0], 'item_ref': new_item['ref']}]
    with case.db.connect() as connection:
        connection.execute('update app.album_top_artwork_budgets set preparation_count=%s where owner_account_id=%s and scope_ref=%s',
            (63 if scope == 'top' else 255, case.db.owner.account_id, case.top['top_ref'] if scope == 'top' else ZERO))
    # Genuine runtime connections contend on the same Top or account budget.
    # One remaining slot is admitted, the concurrent attempt must wait, and its
    # retry after commit must see the exhausted quota rather than over-admit.
    with psycopg.connect(case.db.app_url, row_factory=dict_row) as first:
        direct_start(case, rows, connection=first)
        with psycopg.connect(case.db.app_url, row_factory=dict_row) as second:
            second.execute("set local lock_timeout='100ms'")
            with pytest.raises(psycopg.errors.LockNotAvailable):
                direct_start(second_case, second_rows, connection=second, session=actor.session_id)
            second.rollback()
        first.commit()
    before = case.snapshot()
    with pytest.raises(psycopg.errors.CheckViolation) as failure:
        direct_start(second_case, second_rows, session=actor.session_id)
    assert failure.value.diag.constraint_name == 'top_artwork_retention_limit'
    assert case.snapshot() == before


@pytest.mark.parametrize('denial', ['policy', 'session'])
@pytest.mark.parametrize('deleted', [False, True])
def test_cleanup_final_authority_fence_rolls_back_real_reclamation(artwork, monkeypatch, denial, deleted):
    case = artwork.build(2)
    started = case.start()
    retire(case, started['preparation_ref'])
    if deleted:
        delete_top(case)
    completed = []
    def checkpoint(statement, params):
        if statement.startswith('select app.cleanup_top_artwork_preparations'):
            completed.append(True)
            if denial == 'session':
                # Same injected authorization clock seam used by retained
                # owner tests; PostgreSQL request-generation time is untouched.
                monkeypatch.setattr(case.db.service, '_clock', lambda: case.db.now + foundation.timedelta(hours=2))
    foundation.observe_owner_connection(case, monkeypatch, checkpoint)
    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not (
            denial == 'policy' and completed and context.action == foundation.ACCESS))
    before = case.snapshot()
    assert_error(lambda: case.service.cleanup(case.db.context(), top_ref=case.top['top_ref'],
        top_revision_value=case.top['revision'], context_ref=CONTEXT, constraints=constraints), 'forbidden', 403)
    assert completed == [True]
    assert case.snapshot() == before


def test_failed_admission_rolls_back_a_real_preceding_cleanup_pass(artwork):
    case = artwork.build(2)
    first = case.start()
    retire(case, first['preparation_ref'])
    with case.db.connect() as connection:
        connection.execute('update app.album_top_artwork_budgets set preparation_count=64 where owner_account_id=%s and scope_ref=%s',
            (case.db.owner.account_id, case.top['top_ref']))
    before = case.snapshot()
    assert_error(lambda: case.start(payload={**case.payload, 'request_key': str(uuid4())}), 'artwork_retention_limit', 409)
    # Cleanup would have deleted two real cancelled item rows and subtracted
    # their charges, but failed admission must roll that work back too.
    assert case.snapshot() == before
    assert cleanup(case)['items_deleted'] == 2


def delete_top(case):
    receipt = case.db.service.execute(case.db.context(), case.db.command('delete', case.top))
    case.top = receipt
    return receipt


@pytest.mark.parametrize('ready', [False, True])
def test_deleted_top_cleanup_recovers_exact_quota_without_resurrection(artwork, ready):
    case = artwork.build(2)
    started = case.start()
    if ready:
        started = case.advance(started)
        assert started['ready_count'] == 2
        assert case.snapshot()['album_top_artwork_assets']
    delete_top(case)
    publication = case.publication_state()
    before = case.snapshot()
    # A live, uncancelled proof remains retained even on a deleted parent.
    assert cleanup(case)['items_deleted'] == 0
    assert case.snapshot()['album_top_artwork_preparation_items'] == before['album_top_artwork_preparation_items']
    retire(case, started['preparation_ref'], expired=True)
    result = cleanup(case)
    assert result['items_deleted'] == 2
    assert result['preparations_deleted'] == 1
    # Cursor may already have reached the last pinned key in the first pass.
    cleanup(case)
    cleanup(case)
    assert not case.snapshot()['album_top_artwork_preparations']
    assert not case.snapshot()['album_top_artwork_preparation_items']
    assert not case.snapshot()['album_top_artwork_assets']
    assert_reservation(case, 0, 0, 0)
    for value in budgets(case).values():
        assert value['asset_count'] == value['byte_count'] == 0
    assert case.publication_state() == publication
    assert cleanup(case)['items_deleted'] == 0
    for operation in (lambda: case.start(), lambda: case.read(started), lambda: case.advance(started)):
        assert_error(operation, 'top_unavailable', 404)
    other, _ = case.db.create(refs=[item['album_ref'] for item in case.items])
    rows = case.db.read(other)['items']
    items = [{**item, 'item_ref': row['ref']} for item, row in zip(case.items, rows)]
    status = case.start(top_ref=other['top_ref'], payload={**case.payload,
        'revision': other['revision'], 'request_key': str(uuid4()), 'items': items})
    assert status['item_count'] == 2


def test_deleted_top_cleanup_requires_current_exact_scope_and_cannot_complete_claim(artwork):
    case = artwork.build(1)
    started = case.start()
    key, lease, chosen = case.claim(started)
    results, pngs = case.results(chosen)
    old_revision = case.top['revision']
    delete_top(case)
    before = case.snapshot()
    assert_error(lambda: case.service.cleanup(case.db.context(), top_ref=case.top['top_ref'],
        top_revision_value=old_revision, context_ref=CONTEXT), 'revision_conflict', 409)
    for library, owner, revision in ((case.db.library, case.db.owner.account_id, int(old_revision)),
            (case.db.library + 1000000, case.db.owner.account_id, int(case.top['revision'])),
            (case.db.library, case.db.owner.account_id + 1000000, int(case.top['revision'])),
            (None, case.db.owner.account_id, int(case.top['revision']))):
        with psycopg.connect(case.db.app_url, row_factory=dict_row) as connection:
            with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState) as failure:
                connection.execute('select app.cleanup_top_artwork_preparations(%s,%s,%s,%s)',
                    (case.top['top_ref'], library, owner, revision))
            assert failure.value.diag.constraint_name == 'top_artwork_scope'
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
        case.claim(started)
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
        case.complete(started, key, lease, results, pngs)
    assert case.snapshot() == before
    retire(case, started['preparation_ref'])
    assert cleanup(case)['items_deleted'] == 1
    assert_reservation(case, 1, 0, 1024)


def test_deleted_top_cleanup_never_admits_editor_or_missing_manage(artwork):
    case = artwork.build(1)
    editor = foundation.member(case.db, grants=('capability.view', foundation.ACCESS,
        foundation.BROWSE, foundation.ITEMS, foundation.MANAGE))
    case.top, _ = foundation.write(case.db, 'visibility', case.top, visibility='server_shared')
    case.top, _ = foundation.write(case.db, 'grant_editor', case.top, account_id=editor.account_id, role='editor')
    case.payload['revision'] = case.top['revision']
    started = case.start()
    delete_top(case)
    retire(case, started['preparation_ref'], expired=True)
    before = case.snapshot()
    assert_error(lambda: case.service.cleanup(case.db.context(editor), top_ref=case.top['top_ref'],
        top_revision_value=case.top['revision'], context_ref=CONTEXT), 'top_unavailable', 404)
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != foundation.MANAGE)
    assert_error(lambda: case.service.cleanup(case.db.context(), top_ref=case.top['top_ref'],
        top_revision_value=case.top['revision'], context_ref=CONTEXT, constraints=constraints), 'forbidden', 403)
    assert case.snapshot() == before
    assert cleanup(case)['items_deleted'] == 1
