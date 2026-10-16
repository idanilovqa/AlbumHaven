"""Dormant typed admission against real PostgreSQL authority and shared quotas.

No capture success is fabricated. Runtime execution belongs to the admitted
root executor; source authoring alone does not establish SQL acceptance.
"""
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest

from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error
from tests.py.test_album_top_artwork_preparation_postgres import artwork, CONTEXT, ZERO
from tests.py import test_album_top_artwork_preparation_postgres as foundation
from tests.py.test_top_artwork_retention_postgres import budgets, assert_reservation, retire, cleanup
from tests.py.postgres_runtime_role_contract import assert_runtime_role

DRAFT = 'app.start_top_artwork_draft_preparation(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,bigint,uuid,bigint,text,jsonb)'
BASELINE = 'app.top_artwork_draft_baseline(uuid,bigint,bigint,bigint)'


def reclaim_drafts(case):
    # Only the fixture's real owned draft staging. Use admitted runtime cleanup,
    # not a trigger bypass or a direct immutable-row DELETE in teardown.
    with case.db.connect() as connection:
        connection.execute("""with t as (select clock_timestamp()-interval '1 second' as expiry)
            update app.album_top_artwork_preparations set state='cancelled',created_at=t.expiry-interval '60 minutes',
              expires_at=t.expiry,lease_ref=null,lease_expires_at=null,batch_request_key=null,
              batch_from_revision=null,batch_items=null from t
            where owner_account_id=%s and preparation_kind='draft'""", (case.db.owner.account_id,))
        tops = connection.execute('''select distinct t.ref,t.library_id,t.owner_account_id,t.revision
            from app.album_lists t join app.album_top_artwork_preparations p on p.top_ref=t.ref
            where p.owner_account_id=%s and p.preparation_kind='draft' ''', (case.db.owner.account_id,)).fetchall()
    for top in tops:
        # Admission limits permit at most20k typed rows/Top. Legacy overage
        # belongs to separate migration tests, not this new empty table.
        for _ in range(128):
            with psycopg.connect(case.db.app_url, row_factory=dict_row) as connection:
                connection.execute('select app.cleanup_top_artwork_preparations(%s,%s,%s,%s)',
                    (top['ref'], top['library_id'], top['owner_account_id'], top['revision']))
                remaining = connection.execute("select count(*) as n from app.album_top_artwork_preparations where top_ref=%s and preparation_kind='draft'",
                    (top['ref'],)).fetchone()['n']
            if remaining == 0:
                break
        assert remaining == 0


@pytest.fixture
def draft_case(artwork):
    try:
        yield artwork
    finally:
        reclaim_drafts(artwork)


def command(case, *, new=(), order=None):
    rows = []
    for index in range(len(case.items)) if order is None else order:
        item = case.items[index]
        selection = {'kind': 'new_local' if index in new else 'existing', 'album_ref': item['album_ref'],
            'source': {'kind': 'local', 'selected_local_album_id': item['selected_local_album_id'],
                       'selected_source_ref': item['selected_source_ref']}}
        if index not in new:
            selection['item_ref'] = item['item_ref']
        rows.append({'row_ref': str(uuid4()), 'selection': selection, 'include_artwork': item['include_artwork']})
    return {'revision': case.top['revision'], 'request_key': str(uuid4()),
        'request_generation': case.payload['request_generation'], 'draft_ref': str(uuid4()), 'draft_revision': '1', 'rows': rows}


def start(case, payload, **options):
    return case.service.start_draft(case.db.context(), top_ref=case.top['top_ref'], payload=payload,
        context_ref=CONTEXT, **options)


def snapshot(case):
    with case.db.connect() as connection:
        rows = connection.execute('select * from app.album_top_artwork_draft_items where owner_account_id=%s order by preparation_ref,position',
            (case.db.owner.account_id,)).fetchall()
    return {**case.snapshot(), 'draft_items': rows}


def sql_rows(case, payload):
    return [{'row_ref': row['row_ref'], 'row_kind': row['selection']['kind'],
        'saved_item_ref': row['selection'].get('item_ref'), 'catalog_ref': row['selection']['album_ref'],
        'position': position, 'selected_local_album_id': row['selection']['source']['selected_local_album_id'],
        'selected_source_ref': row['selection']['source']['selected_source_ref'],
        'selected_library_root_id': case.metadata_root, 'included': row['include_artwork']}
        for position, row in enumerate(payload['rows'], 1)]


def direct(case, payload, rows=None, *, baseline=None, connection=None):
    if connection is None:
        with psycopg.connect(case.db.app_url, row_factory=dict_row) as real:
            return direct(case, payload, rows, baseline=baseline, connection=real)
    if baseline is None:
        baseline = connection.execute('select app.top_artwork_draft_baseline(%s,%s,%s,%s) as digest',
            (case.top['top_ref'], case.db.library, case.db.owner.account_id, int(payload['revision']))).fetchone()['digest']
    return connection.execute('select app.start_top_artwork_draft_preparation(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) as ref',
        (str(uuid4()), case.top['top_ref'], case.db.library, case.db.owner.account_id, case.db.owner.session_id,
         CONTEXT, int(payload['revision']), payload['request_key'], payload['request_generation'],
         payload['draft_ref'], int(payload['draft_revision']), baseline,
         Jsonb(sql_rows(case, payload) if rows is None else rows))).fetchone()['ref']


def test_typed_new_members_reorder_and_removal_do_not_mutate_saved_state(draft_case, monkeypatch):
    case = draft_case.build(3, excluded=(1,))
    case.top = case.db.service.execute(case.db.context(), case.db.command('remove', case.top, item_refs=[case.items[2]['item_ref']]))
    payload = command(case, new=(2,), order=(2, 0))
    def forbidden(*args, **kwargs):
        raise AssertionError('Admission must not describe or capture pixels')
    monkeypatch.setattr(case.service, 'capture', forbidden)
    monkeypatch.setattr(case.service, 'describe', forbidden)
    public = case.publication_state()
    admitted = start(case, payload)
    assert admitted['preparation_kind'] == 'draft' and admitted['state'] == 'preparing'
    assert admitted['item_count'] == admitted['included_count'] == 2
    assert case.publication_state() == public
    rows = snapshot(case)['draft_items']
    assert [row['row_kind'] for row in rows] == ['new_local', 'existing']
    assert rows[0]['saved_item_ref'] is None and str(rows[1]['saved_item_ref']) == case.items[0]['item_ref']
    assert [str(row['row_ref']) for row in rows] == [row['row_ref'] for row in payload['rows']]
    assert_reservation(case, 1, 2, 1024 + 2 * 69632)
    before = snapshot(case)
    assert start(case, payload) == admitted and snapshot(case) == before
    changed = deepcopy(payload)
    changed['rows'][0]['include_artwork'] = False
    assert_error(lambda: start(case, changed), 'request_key_conflict', 409)
    assert snapshot(case) == before


@pytest.mark.parametrize('field,value', [('include_artwork','true'), ('include_artwork',1), ('row_ref',None)])
def test_typed_command_rejects_ambiguous_identity_and_choices(draft_case, field, value):
    case = draft_case.build(1)
    payload = command(case)
    payload['rows'][0][field] = value
    assert_error(lambda: start(case, payload), 'invalid_command', 422)
    assert not snapshot(case)['draft_items']


@pytest.mark.parametrize('value', ['true','false','t',1,0,None,[],{}])
def test_direct_runtime_rejects_nonboolean_tail_before_reservation(draft_case, value):
    case = draft_case.build(2)
    payload = command(case)
    rows = sql_rows(case, payload)
    rows[-1]['included'] = value
    before = snapshot(case)
    with pytest.raises(psycopg.errors.CheckViolation):
        direct(case, payload, rows)
    assert snapshot(case) == before


@pytest.mark.parametrize('shape', ['scalar','array','extra','missing','duplicate_row','duplicate_catalog','duplicate_saved',
    'wrong_saved','new_existing','position','local_string','root_boolean','wrong_root','wrong_local','source','baseline'])
def test_sql_typed_manifest_binding_rejects_malformed_vectors(draft_case, shape):
    case = draft_case.build(2)
    payload = command(case)
    rows = sql_rows(case, payload)
    baseline = None
    if shape == 'scalar': rows[-1] = None
    elif shape == 'array': rows[-1] = []
    elif shape == 'extra': rows[-1]['extra'] = True
    elif shape == 'missing': rows[-1].pop('saved_item_ref')
    elif shape == 'duplicate_row': rows[-1]['row_ref'] = rows[0]['row_ref']
    elif shape == 'duplicate_catalog': rows[-1]['catalog_ref'] = rows[0]['catalog_ref']
    elif shape == 'duplicate_saved': rows[-1]['saved_item_ref'] = rows[0]['saved_item_ref']
    elif shape == 'wrong_saved': rows[-1]['saved_item_ref'] = str(uuid4())
    elif shape == 'new_existing': rows[-1].update(row_kind='new_local', saved_item_ref=None)
    elif shape == 'position': rows[-1]['position'] = 1
    elif shape == 'local_string': rows[-1]['selected_local_album_id'] = str(rows[-1]['selected_local_album_id'])
    elif shape == 'root_boolean': rows[-1]['selected_library_root_id'] = True
    elif shape == 'wrong_root': rows[-1]['selected_library_root_id'] = case.artwork_root
    elif shape == 'wrong_local': rows[-1]['selected_local_album_id'] = rows[0]['selected_local_album_id']
    elif shape == 'source': rows[-1]['selected_source_ref'] = str(uuid4())
    elif shape == 'baseline': baseline = '0' * 64
    before = snapshot(case)
    with pytest.raises(psycopg.errors.CheckViolation):
        direct(case, payload, rows, baseline=baseline)
    assert snapshot(case) == before


def test_saved_entries_cannot_read_claim_complete_or_recover_draft(draft_case):
    case = draft_case.build(1)
    payload = command(case)
    admitted = start(case, payload)
    before = snapshot(case)
    assert_error(lambda: case.read(admitted), 'artwork_preparation_unavailable', 409)
    assert_error(lambda: case.advance(admitted), 'artwork_preparation_unavailable', 409)
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState): case.claim(admitted)
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
        case.complete(admitted, str(uuid4()), str(uuid4()), [], [])
    assert_error(lambda: case.start(payload={**case.payload, 'request_key': payload['request_key']}), 'request_key_conflict', 409)
    assert snapshot(case) == before


def test_shared_saved_and_draft_quota_successors_and_failed_admission(draft_case):
    case = draft_case.build(2)
    saved = case.start()
    draft = start(case, command(case))
    assert_reservation(case, 2, 4, 2 * 1024 + 4 * 69632)
    states = {str(row['ref']): row['state'] for row in case.snapshot()['album_top_artwork_preparations']}
    assert states[saved['preparation_ref']] == 'cancelled' and states[draft['preparation_ref']] == 'preparing'
    # A failed saved admission cannot cancel the active draft or retain its
    # attempted cleanup of the cancelled saved predecessor.
    with case.db.connect() as connection:
        connection.execute('update app.album_top_artwork_budgets set preparation_count=64 where owner_account_id=%s and scope_ref=%s',
            (case.db.owner.account_id, case.top['top_ref']))
    before = snapshot(case)
    assert_error(lambda: case.start(payload={**case.payload, 'request_key':str(uuid4())}), 'artwork_retention_limit', 409)
    assert snapshot(case) == before


@pytest.mark.parametrize('deleted', [False, True])
def test_mixed_cleanup_has_one_global_item_bound_and_recovers_deleted_owner(draft_case, monkeypatch, deleted):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(300)
    saved = case.start()
    drafted = start(case, command(case))
    retire(case, saved['preparation_ref'], expired=True)
    retire(case, drafted['preparation_ref'], expired=True)
    if deleted:
        case.top = case.db.service.execute(case.db.context(), case.db.command('delete',case.top))
    first = cleanup(case)
    assert first['items_deleted'] == 512 and first['preparations_deleted'] <= 2
    second = cleanup(case)
    assert second['items_deleted'] == 88
    assert_reservation(case, 0, 0, 0)
    assert snapshot(case)['draft_items'] == []


def test_maximum_typed_manifest_reservation_and_ten_pass_reclamation(draft_case, monkeypatch):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(5000)
    case.top, _ = case.db.create(refs=[])
    admitted = start(case, command(case, new=range(5000)))
    assert_reservation(case, 1, 5000, 348161024)
    retire(case, admitted['preparation_ref'], expired=True)
    counts = [cleanup(case)['items_deleted'] for _ in range(10)]
    assert counts == [512] * 9 + [392]
    assert_reservation(case, 0, 0, 0)


@pytest.mark.parametrize('denial', ['policy','session','artwork'])
def test_late_authority_denial_rolls_back_draft_reservation(draft_case, monkeypatch, denial):
    case = draft_case.build(1)
    completed = []
    def checkpoint(statement, params):
        if statement.startswith('select app.start_top_artwork_draft_preparation'):
            completed.append(True)
            if denial == 'session':
                monkeypatch.setattr(case.db.service,'_clock',lambda:case.db.now+foundation.timedelta(hours=2))
    foundation.observe_owner_connection(case,monkeypatch,checkpoint)
    def constraints(context):
        blocked = completed and ((denial=='policy' and context.action==foundation.ACCESS)
            or (denial=='artwork' and context.action==foundation.ARTWORK))
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)
    before = snapshot(case)
    assert_error(lambda:start(case,command(case),constraints=constraints),'forbidden',403)
    assert completed == [True] and snapshot(case) == before


@pytest.mark.parametrize('offset', [-3601, 60])
def test_draft_database_generation_is_not_refreshed(draft_case, offset):
    case = draft_case.build(1)
    payload = command(case)
    payload['request_generation'] += offset
    before = snapshot(case)
    assert_error(lambda:start(case,payload),'artwork_request_expired',409)
    assert snapshot(case) == before


def test_draft_real_expiry_deleted_header_and_fresh_generation(draft_case):
    case = draft_case.build(1)
    payload = command(case)
    with case.db.connect() as connection:
        payload['request_generation'] = connection.execute("select floor(extract(epoch from clock_timestamp()))::bigint-3595 as n").fetchone()['n']
    first = start(case,payload)
    with case.db.connect() as connection:
        connection.execute('select pg_sleep(greatest(0,%s+3600-extract(epoch from clock_timestamp()))+0.05)',
            (payload['request_generation'],))
    assert cleanup(case)['preparations_deleted'] == 1
    assert_error(lambda:start(case,payload),'artwork_request_expired',409)
    with case.db.connect() as connection:
        generation = connection.execute('select floor(extract(epoch from clock_timestamp()))::bigint as n').fetchone()['n']
    fresh = {**payload,'request_generation':generation}
    second = start(case,fresh)
    assert second['preparation_ref'] != first['preparation_ref']
    assert start(case,fresh) == second


def test_current_baseline_change_and_cross_session_context_fail_closed(draft_case):
    case = draft_case.build(1)
    payload = command(case)
    admitted = start(case,payload)
    before = snapshot(case)
    assert_error(lambda:case.service.start_draft(case.db.context(),top_ref=case.top['top_ref'],payload=payload,
        context_ref='b'*64),'request_key_conflict',409)
    actor = foundation.new_session(case.db,case.db.owner)
    assert_error(lambda:case.service.start_draft(case.db.context(actor),top_ref=case.top['top_ref'],payload=payload,
        context_ref=CONTEXT),'request_key_conflict',409)
    assert snapshot(case) == before
    case.top = case.db.service.execute(case.db.context(),case.db.command('save',case.top,title='Changed baseline'))
    assert_error(lambda:start(case,payload),'revision_conflict',409)
    assert snapshot(case) == before


def test_actual_runtime_privileges_and_immutable_typed_rows(draft_case):
    case = draft_case.build(1)
    start(case,command(case))
    with psycopg.connect(case.db.app_url,row_factory=dict_row) as connection:
        role = assert_runtime_role(connection,case.db)
        for privilege in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'):
            assert connection.execute('select has_table_privilege(%s,%s,%s) as yes',
                (role,'app.album_top_artwork_draft_items',privilege)).fetchone()['yes'] is (privilege=='SELECT')
        for signature in (DRAFT,BASELINE):
            assert connection.execute('select has_function_privilege(%s,%s,%s) as yes',
                (role,signature,'EXECUTE')).fetchone()['yes'] is True
        for signature in ('app.lock_top_artwork_saved_preparation(uuid)',
                'app.start_top_artwork_preparation_saved_v2(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb,bigint)',
                'app.claim_top_artwork_batch_saved_v1(uuid,bigint,bigint,text,bigint,uuid,uuid)',
                'app.complete_top_artwork_batch_saved_v1(uuid,bigint,bigint,text,bigint,uuid,uuid,jsonb,bytea[])'):
            assert connection.execute('select has_function_privilege(%s,%s,%s) as yes',
                (role,signature,'EXECUTE')).fetchone()['yes'] is False
    before = snapshot(case)
    for statement in ('delete from app.album_top_artwork_draft_items where false',
                      'update app.album_top_artwork_draft_items set included=included where false',
                      'truncate app.album_top_artwork_draft_items'):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with psycopg.connect(case.db.app_url) as connection: connection.execute(statement)
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
        with case.db.connect() as connection:
            connection.execute('update app.album_top_artwork_draft_items set included=included where owner_account_id=%s',
                (case.db.owner.account_id,))
    assert snapshot(case) == before


def test_same_top_draft_admission_lock_serializes(draft_case):
    case = draft_case.build(1)
    payload = command(case)
    with psycopg.connect(case.db.app_url,row_factory=dict_row) as first:
        direct(case,payload,connection=first)
        with psycopg.connect(case.db.app_url,row_factory=dict_row) as second:
            second.execute("set local lock_timeout='100ms'")
            with pytest.raises(psycopg.errors.LockNotAvailable):
                direct(case,command(case),connection=second)
            second.rollback()
        first.commit()
    assert_reservation(case,1,1,70656)


# Existing real immutable remote fixtures; no provider requests are issued by
# historical() or draft admission. Dependency order tears down typed rows before
# the remote fixture removes its synthetic parent Tops.
from tests.py.remote_top_postgres_support import remote
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_album_top_remote_membership_postgres import mixed


@pytest.fixture
def remote_draft_case(mixed, artwork):
    try:
        yield mixed, artwork
    finally:
        reclaim_drafts(artwork)


@pytest.mark.parametrize('replacement',[False,True])
def test_retired_former_editor_remote_baseline_can_be_removed_or_replaced(remote_draft_case,replacement):
    mixed, case = remote_draft_case
    case.build(1)
    editor = foundation.member(case.db,grants=(foundation.BROWSE,foundation.MANAGE,foundation.ITEMS,'capability.view'))
    top, admission = mixed.historical(actor=editor)
    with case.db.connect() as connection:
        grant = connection.execute('select ref from app.album_list_access_grants where top_ref=%s and account_id=%s',
            (top['top_ref'],editor.account_id)).fetchone()['ref']
        member = connection.execute('select ref,catalog_ref from app.album_list_items where top_ref=%s',
            (top['top_ref'],)).fetchone()
    top,_ = foundation.write(case.db,'revoke_editor',top,grant_ref=str(grant))
    mixed.retire(admission)
    case.top = top
    if replacement:
        with case.db.connect() as connection:
            connection.execute('update library.catalog_album_links set catalog_ref=%s where library_id=%s and local_album_id=%s',
                (member['catalog_ref'],case.db.library,case.items[0]['selected_local_album_id']))
        case.items[0].update(item_ref=str(member['ref']),album_ref=str(member['catalog_ref']))
    payload = command(case,new=() if replacement else (0,))
    before = mixed.snapshot()
    calls = len(mixed.remote.calls)
    admitted = start(case,payload)
    assert admitted['item_count'] == 1
    assert len(mixed.remote.calls) == calls and mixed.snapshot() == before
    with case.db.connect() as connection:
        assert connection.execute('select retired_at from app.album_top_remote_admissions where ref=%s',
            (admission,)).fetchone()['retired_at'] is not None


@pytest.mark.parametrize('ready', [False, True])
@pytest.mark.parametrize('overage', [False, True])
def test_nonempty_saved_state_and_budgets_survive_0130_additive_migration(draft_case, ready, overage):
    case = draft_case.build(2)
    started = case.start()
    if ready:
        assert case.advance(started)['ready_count'] == 2
    if overage:
        # Real legacy empty cancelled headers with their exact charges, not
        # a counter-only claim of nonempty over-limit migration evidence.
        with case.db.connect() as connection:
            for _ in range(66):
                connection.execute('''insert into app.album_top_artwork_preparations
                    (ref,top_ref,library_id,owner_account_id,original_session_id,context_ref,top_revision,
                     start_request_key,manifest_digest,item_count,created_at,expires_at,state,
                     request_generation,retained_item_count)
                    select %s,top_ref,library_id,owner_account_id,original_session_id,context_ref,top_revision,
                      %s,manifest_digest,0,created_at,expires_at,'cancelled',request_generation,0
                      from app.album_top_artwork_preparations where ref=%s''',
                    (str(uuid4()),str(uuid4()),started['preparation_ref']))
            connection.execute('''update app.album_top_artwork_budgets
                set preparation_count=preparation_count+66,proof_bytes=proof_bytes+66*1024
                where owner_account_id=%s''',(case.db.owner.account_id,))
    before = snapshot(case)
    repository = Path(__file__).resolve().parents[2]
    migration = (repository/'migrations/postgres/0130_private_top_artwork_drafts.sql').read_text(encoding='utf-8')
    retention = (repository/'migrations/postgres/0129_top_artwork_retention.sql').read_text(encoding='utf-8')
    cleanup_source = retention[retention.index('create function app.cleanup_top_artwork_preparations'):]
    cleanup_source = cleanup_source[:cleanup_source.index('end $$;')+len('end $$;')]
    class RollbackFixture(Exception): pass
    with pytest.raises(RollbackFixture):
        with case.db.connect() as connection:
            # Isolated forced-rollback reconstruction only. Actual legacy rows
            # and real counters are retained; no existing trigger is disabled.
            connection.execute('lock table app.album_top_artwork_preparations,app.album_top_artwork_preparation_items,app.album_top_artwork_budgets in access exclusive mode')
            connection.execute('drop function '+DRAFT)
            connection.execute('drop function '+BASELINE)
            connection.execute('drop function app.lock_top_artwork_saved_preparation(uuid)')
            connection.execute('drop function '+foundation.START_SIGNATURE)
            connection.execute('drop function '+foundation.CLAIM_SIGNATURE)
            connection.execute('drop function '+foundation.COMPLETE_SIGNATURE)
            connection.execute('alter function app.start_top_artwork_preparation_saved_v2(uuid,uuid,bigint,bigint,bigint,text,bigint,uuid,text,jsonb,bigint) rename to start_top_artwork_preparation')
            connection.execute('alter function app.claim_top_artwork_batch_saved_v1(uuid,bigint,bigint,text,bigint,uuid,uuid) rename to claim_top_artwork_batch')
            connection.execute('alter function app.complete_top_artwork_batch_saved_v1(uuid,bigint,bigint,text,bigint,uuid,uuid,jsonb,bytea[]) rename to complete_top_artwork_batch')
            connection.execute('drop table app.album_top_artwork_draft_items')
            connection.execute('drop function app.guard_top_artwork_draft_item()')
            connection.execute('alter table app.album_top_artwork_preparation_items drop column preparation_kind cascade')
            connection.execute('alter table app.album_top_artwork_preparations drop column preparation_kind cascade,drop column draft_ref cascade,drop column draft_revision cascade,drop column baseline_digest cascade')
            connection.execute('alter table app.album_top_artwork_cleanup_permits drop constraint album_top_artwork_cleanup_permits_kind_check')
            connection.execute("alter table app.album_top_artwork_cleanup_permits add constraint album_top_artwork_cleanup_permits_kind_check check(kind in ('item','asset'))")
            connection.execute(cleanup_source.replace('create function','create or replace function',1))
            connection.execute(migration)
            after = connection.execute('select * from app.album_top_artwork_preparations where owner_account_id=%s order by 1,2',
                (case.db.owner.account_id,)).fetchall()
            assert after == before['album_top_artwork_preparations']
            actual_budgets = connection.execute('select * from app.album_top_artwork_budgets where owner_account_id=%s order by 1,2',
                (case.db.owner.account_id,)).fetchall()
            assert actual_budgets == before['album_top_artwork_budgets']
            for name in ('album_top_artwork_assets','album_top_artwork_preparation_items'):
                assert connection.execute(f'select * from app.{name} where owner_account_id=%s order by 1,2',
                    (case.db.owner.account_id,)).fetchall() == before[name]
            raise RollbackFixture()
    assert snapshot(case) == before


@pytest.mark.parametrize('count',[0,2])
def test_empty_or_all_excluded_draft_admission_does_not_acquire(draft_case,monkeypatch,count):
    case = draft_case.build(count,excluded=tuple(range(count)))
    def forbidden(*args,**kwargs): raise AssertionError('Metadata admission cannot acquire artwork')
    monkeypatch.setattr(case.service,'describe',forbidden)
    monkeypatch.setattr(case.service,'capture',forbidden)
    admitted = start(case,command(case))
    assert admitted['state']=='preparing' and admitted['included_count']==0
    assert admitted['item_count']==count
    assert_reservation(case,1,count,1024+1024*count)
    assert not case.snapshot()['album_top_artwork_assets']


def test_draft_identity_revision_collision_successor_and_saved_replacement(draft_case):
    case = draft_case.build(1)
    payload = command(case)
    first = start(case,payload)
    before = snapshot(case)
    collision = {**payload,'request_key':str(uuid4())}
    assert_error(lambda:start(case,collision),'request_key_conflict',409)
    assert snapshot(case)==before
    successor = {**collision,'draft_revision':'2'}
    second = start(case,successor)
    assert second['preparation_ref']!=first['preparation_ref']
    states = {str(row['ref']):row['state'] for row in case.snapshot()['album_top_artwork_preparations']}
    assert states[first['preparation_ref']]=='cancelled' and states[second['preparation_ref']]=='preparing'
    saved = case.start()
    states = {str(row['ref']):row['state'] for row in case.snapshot()['album_top_artwork_preparations']}
    assert states[second['preparation_ref']]=='cancelled' and states[saved['preparation_ref']]=='preparing'
    # Saved start's bounded cleanup reclaimed the first cancelled typed row.
    assert_reservation(case,3,2,3*1024+2*69632)


def test_cross_top_account_budget_serializes_draft_then_saved(draft_case):
    from types import SimpleNamespace
    from tests.py.test_top_artwork_retention_postgres import direct_start
    case = draft_case.build(1)
    # Seed the actual shared account row through ordinary saved admission.
    case.start()
    other,_ = case.db.create(refs=case.catalog_refs)
    item = case.db.read(other)['items'][0]
    actor = foundation.new_session(case.db,case.db.owner)
    other_case = SimpleNamespace(db=case.db,top=other,payload=case.payload)
    saved_rows = [{'item_ref':item['ref'],'catalog_ref':item['catalog_ref'],'position':1,
        'selected_local_album_id':case.items[0]['selected_local_album_id'],
        'selected_source_ref':case.items[0]['selected_source_ref'],'selected_library_root_id':case.metadata_root,'included':True}]
    with case.db.connect() as connection:
        connection.execute('update app.album_top_artwork_budgets set preparation_count=255 where owner_account_id=%s and scope_ref=%s',
            (case.db.owner.account_id,ZERO))
    with psycopg.connect(case.db.app_url,row_factory=dict_row) as first:
        direct(case,command(case),connection=first)
        with psycopg.connect(case.db.app_url,row_factory=dict_row) as second:
            second.execute("set local lock_timeout='100ms'")
            with pytest.raises(psycopg.errors.LockNotAvailable):
                direct_start(other_case,saved_rows,connection=second,session=actor.session_id)
            second.rollback()
        first.commit()
    before=snapshot(case)
    with pytest.raises(psycopg.errors.CheckViolation) as failure:
        direct_start(other_case,saved_rows,session=actor.session_id)
    assert failure.value.diag.constraint_name=='top_artwork_retention_limit'
    assert snapshot(case)==before


def test_database_expiry_after_sql_admission_rolls_back_acknowledgement(draft_case,monkeypatch):
    case=draft_case.build(1)
    payload=command(case)
    with case.db.connect() as connection:
        payload['request_generation']=connection.execute('select floor(extract(epoch from clock_timestamp()))::bigint-3595 as n').fetchone()['n']
    observed=[]
    def checkpoint(statement,params):
        if statement.startswith('select app.start_top_artwork_draft_preparation'):
            with case.db.connect() as connection:
                connection.execute('select pg_sleep(greatest(0,%s+3600-extract(epoch from clock_timestamp()))+0.05)',
                    (payload['request_generation'],))
            observed.append(True)
    foundation.observe_owner_connection(case,monkeypatch,checkpoint)
    before=snapshot(case)
    assert_error(lambda:start(case,payload),'artwork_request_expired',409)
    assert observed==[True] and snapshot(case)==before


@pytest.mark.parametrize('field',['row_ref','draft_ref','request_key'])
def test_zero_private_identity_is_rejected_by_normalizer(draft_case,field):
    case=draft_case.build(1)
    payload=command(case)
    if field=='row_ref': payload['rows'][0][field]=ZERO
    else: payload[field]=ZERO
    before=snapshot(case)
    assert_error(lambda:start(case,payload),'invalid_command',422)
    assert snapshot(case)==before


def test_metadata_only_v1_preview_publish_and_enabled_save_bypass_artwork(remote_draft_case,monkeypatch):
    from tests.py.test_album_top_owner_publication_postgres import configured
    mixed,case=remote_draft_case
    case.build(1,excluded=(0,))
    configured(case.db)
    def forbidden(*args,**kwargs): raise AssertionError('Metadata-only v1 cannot acquire artwork')
    monkeypatch.setattr(case.service,'capture',forbidden)
    monkeypatch.setattr(case.service,'describe',forbidden)
    monkeypatch.setattr(foundation.preparation_module,'capture_artwork',forbidden)
    monkeypatch.setattr(foundation.preparation_module,'describe_artwork_source',forbidden)
    items=[{key:value for key,value in item.items() if key!='include_artwork'} for item in case.items]
    constraint=lambda context:PolicyEvaluationConstraints(request_origin_allowed=context.action!=foundation.ARTWORK)
    for action in ('enable_external','save'):
        before=snapshot(case)
        preview=case.db.service.publication_preview(case.db.context(),top_ref=case.top['top_ref'],
            payload={'revision':case.top['revision'],'items':items},constraints=constraint)
        assert snapshot(case)==before
        command_value=case.db.command(action,case.top,items=items,evidence_revision=preview['evidence_revision'])
        case.top=case.db.service.execute(case.db.context(),command_value,constraints=constraint)
        assert case.top['publication']['state']=='enabled'
        assert snapshot(case)==before
    with case.db.connect() as connection:
        rows=connection.execute('select contract_version from app.album_list_publications where top_ref=%s',
            (case.top['top_ref'],)).fetchall()
        assert len(rows)==2 and all(row['contract_version']==1 for row in rows)


def test_typed_new_member_does_not_enumerate_or_lock_alternate_local_links(draft_case, monkeypatch):
    case = draft_case.build(1)
    selected = case.items[0]
    case.top, _ = case.db.create(refs=[])
    with case.db.connect() as connection:
        artist = connection.execute('select artist_id from library.local_albums where id=%s',
            (selected['selected_local_album_id'],)).fetchone()['artist_id']
        siblings = connection.execute('''insert into library.local_albums
            (library_id,artist_id,album_key,title,release_year,metadata)
            select %s,%s,%s || n::text,'Unselected local edition',2000,'{}'
            from generate_series(1,251) as series(n) returning id''',
            (case.db.library, artist, 'draft-sibling:' + case.db.token + ':')).fetchall()
        sibling_ids = sorted(row['id'] for row in siblings)
        connection.execute('''insert into library.catalog_album_links(library_id,local_album_id,catalog_ref)
            select library_id,id,%s from library.local_albums
            where library_id=%s and id=any(%s::bigint[])''',
            (selected['album_ref'], case.db.library, sibling_ids))
    statements, lock_pages, checked = [], [], []
    def checkpoint(statement, params):
        statements.append(statement)
        if statement.startswith('select id from library.local_albums'):
            lock_pages.append(list(params[1]))
        if (statement.startswith('select library.lock_public_metadata_source')
                or statement.startswith('select app.start_top_artwork_draft_preparation')):
            # Observe real concurrent row locks both before exact-source reads
            # and after SQL admission. A catalog-wide SHARE lock fails NOWAIT.
            with case.db.connect() as concurrent:
                rows = concurrent.execute('''select id from library.local_albums
                    where library_id=%s and id=any(%s::bigint[]) order by id for update nowait''',
                    (case.db.library, sibling_ids)).fetchall()
                assert [row['id'] for row in rows] == sibling_ids
            checked.append(statement.split('(')[0].strip())
    foundation.observe_owner_connection(case, monkeypatch, checkpoint)
    public = case.publication_state()
    admitted = start(case, command(case, new=(0,)))
    assert admitted['item_count'] == admitted['included_count'] == 1
    assert lock_pages == [[selected['selected_local_album_id']]]
    assert checked == ['select library.lock_public_metadata_source',
                       'select app.start_top_artwork_draft_preparation']
    link_reads = [statement for statement in statements
                  if statement.startswith('select ') and 'library.catalog_album_links' in statement]
    assert len(link_reads) == 1
    assert 'where s.ref=%s and s.library_id=%s and s.local_album_id=%s and c.catalog_ref=%s' in link_reads[0]
    assert 'for share' not in link_reads[0]
    assert case.publication_state() == public


@pytest.mark.parametrize('resource_kind', ['album', 'album_metadata_source', 'library_root'])
@pytest.mark.parametrize('included', [False, True])
def test_exact_selected_browse_denial_cannot_use_permitted_sibling(draft_case, resource_kind, included):
    case = draft_case.build(2)
    selected, sibling = case.items
    case.top, _ = case.db.create(refs=[])
    sibling_path = case.directory / 'sibling-metadata'
    with case.db.connect() as connection:
        sibling_root = case.root(connection, sibling_path)
        connection.execute('''update library.catalog_album_links set catalog_ref=%s
            where library_id=%s and local_album_id=%s''',
            (selected['album_ref'], case.db.library, sibling['selected_local_album_id']))
        connection.execute('''update library.album_metadata_sources
            set library_root_id=%s,container_identity=%s where ref=%s''',
            (sibling_root, str(sibling_path / 'album-1'), sibling['selected_source_ref']))
        connection.execute('''update library.local_track_files set library_root_id=%s,private_path=%s
            where metadata_source_ref=%s''',
            (sibling_root, str(sibling_path / 'album-1' / '01.flac'), sibling['selected_source_ref']))
    sibling['album_ref'] = selected['album_ref']
    selected['include_artwork'] = sibling['include_artwork'] = included
    denied_ref = {'album': selected['selected_local_album_id'],
                  'album_metadata_source': selected['selected_source_ref'],
                  'library_root': case.metadata_root}[resource_kind]
    constraints = foundation.deny_resource(resource_kind, denied_ref)
    public, before = case.publication_state(), snapshot(case)
    assert_error(lambda: start(case, command(case, new=(0,), order=(0,)), constraints=constraints),
        'forbidden', 403)
    assert snapshot(case) == before and case.publication_state() == public
    # The alternative is genuinely admitted through the same current policy,
    # rather than merely claiming that some sibling would have been allowed.
    allowed = start(case, command(case, new=(1,), order=(1,)), constraints=constraints)
    assert allowed['item_count'] == 1 and allowed['included_count'] == int(included)
    rows = snapshot(case)['draft_items']
    assert len(rows) == 1
    assert rows[0]['selected_local_album_id'] == sibling['selected_local_album_id']
    assert str(rows[0]['selected_source_ref']) == sibling['selected_source_ref']
    assert rows[0]['selected_library_root_id'] == sibling_root
    assert case.publication_state() == public


@pytest.mark.parametrize('identity', ['missing_retained', 'wrong_retained_catalog', 'new_already_saved'])
def test_typed_and_legacy_drafts_preserve_saved_membership_identity_errors(draft_case, monkeypatch, identity):
    case = draft_case.build(2)
    payload = command(case, new=(0,) if identity == 'new_already_saved' else (), order=(0,))
    selection = payload['rows'][0]['selection']
    if identity == 'missing_retained':
        selection['item_ref'] = str(uuid4())
    elif identity == 'wrong_retained_catalog':
        selection['item_ref'] = case.items[1]['item_ref']
    legacy_items = [{'item_ref': selection.get('item_ref'), 'album_ref': selection['album_ref'],
        'selected_local_album_id': selection['source']['selected_local_album_id'],
        'selected_source_ref': selection['source']['selected_source_ref']}]
    statements = []
    foundation.observe_owner_connection(case, monkeypatch,
        lambda statement, params: statements.append(statement))
    public, before = case.publication_state(), snapshot(case)
    operations = (
        lambda: start(case, payload),
        lambda: case.db.service.publication_preview(case.db.context(), top_ref=case.top['top_ref'],
            payload={'revision': case.top['revision'], 'items': legacy_items}),
        lambda: case.db.service.execute(case.db.context(), case.db.command('save', case.top, items=legacy_items)),
    )
    for operation in operations:
        statements.clear()
        assert_error(operation, 'items_changed', 409)
        assert not any('library.local_albums' in statement or 'library.catalog_album_links' in statement
                       or 'library.lock_public_metadata_source' in statement
                       or 'app.start_top_artwork_draft_preparation' in statement for statement in statements)
        assert snapshot(case) == before and case.publication_state() == public


def test_all_selected_rows_lock_in_sorted_hundred_row_pages_before_source_barrier(draft_case, monkeypatch):
    monkeypatch.setattr(foundation, 'png_file', lambda path, number=0: path)
    case = draft_case.build(205, excluded=tuple(range(0, 205, 2)))
    new = (1, 101, 204)
    case.top = case.db.service.execute(case.db.context(), case.db.command('remove', case.top,
        item_refs=[case.items[index]['item_ref'] for index in new]))
    payload = command(case, new=new, order=range(204, -1, -1))
    selected_ids = sorted(item['selected_local_album_id'] for item in case.items)
    expected_pages = [selected_ids[offset:offset + 100] for offset in range(0, 205, 100)]
    events, pages, source_reads = [], [], []
    def checkpoint(statement, params):
        if statement.startswith('select id from library.local_albums'):
            assert not any(event.startswith('barrier_') for event in events)
            assert 'order by id for share' in statement
            pages.append(list(params[1]))
            events.append('selected_lock')
        elif statement.startswith('lock table library.album_metadata_sources'):
            assert pages == expected_pages
            events.append('barrier_tables')
        elif statement.startswith('select library.lock_public_metadata_source'):
            assert events == ['selected_lock'] * 3 + ['barrier_tables']
            # Exercise actual retained SHARE locks at every page boundary,
            # including excluded retained rows and the excluded new tail row.
            for album in [selected_ids[index] for index in (0, 99, 100, 199, 200, 204)]:
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    with case.db.connect() as concurrent:
                        concurrent.execute('select id from library.local_albums where id=%s for update nowait',
                            (album,))
            events.append('barrier_clock')
        elif statement.startswith('select s.ref,s.library_id,s.local_album_id,s.library_root_id'):
            assert events[-1] == 'barrier_clock'
            source_reads.append(params[2])
    foundation.observe_owner_connection(case, monkeypatch, checkpoint)
    public = case.publication_state()
    admitted = start(case, payload)
    assert pages == expected_pages and [len(page) for page in pages] == [100, 100, 5]
    assert source_reads == [row['selection']['source']['selected_local_album_id'] for row in payload['rows']]
    assert admitted['item_count'] == 205 and admitted['included_count'] == 102
    rows = snapshot(case)['draft_items']
    assert [row['selected_local_album_id'] for row in rows] == source_reads
    assert [row['included'] for row in rows] == [row['include_artwork'] for row in payload['rows']]
    assert case.publication_state() == public
