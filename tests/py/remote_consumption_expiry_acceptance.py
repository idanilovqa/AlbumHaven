"""Explicitly selected real-expiry acceptance; this is NOT ordinary discovery.

Select this exact module only in a separately approved run with more than one
hour available. The normal 45-minute Windows job is deliberately unchanged.
One explicit batch owns independent synthetic actor/library/fixture stacks and
runs selected cases concurrently, amortizing actual 30-minute and 60-minute waits.
Each parametrized result independently raises its worker's original failure.

No timestamp rewriting, shortened SQL lifetime, fabricated pending history,
clock replacement, or retired/closed substitute establishes expiry here. The
post-boundary gates are explicitly inserted PostgreSQL advisory-lock waits,
NOT claims of native table-lock contention. Production calls/cursors/results
are unchanged; actual backend blocking and the real SQL deadline are observed.
The exact required source-name mapping is CASES below and the packet inventory.
Unselected, interrupted, missing-database and skipped cases remain uncovered.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
from dataclasses import replace
from datetime import timedelta
from hashlib import sha256
import json
from threading import Event
from time import monotonic
from uuid import uuid4
import warnings

import pytest

from music_app.services.owned_album_tops import BROWSE, CREATE
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.remote_album_evidence import RemoteAlbumEvidenceError
from tests.py import test_owned_album_tops_postgres as owner_contract
from tests.py import test_album_top_remote_membership_postgres as membership_contract
from tests.py import test_album_top_remote_acquisition_postgres as acquisition_contract
from tests.py import test_album_top_remote_acquisition_routes as http_contract
from tests.py import remote_top_postgres_support as acquisition_support
from tests.py import remote_top_retention_postgres_support as retention_support
from tests.py import remote_preparation_cutoff_support as cutoff_support
from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.test_album_top_collaboration_postgres import new_session

urls = owner_contract.urls
CONTEXT = acquisition_support.CONTEXT
runtime = acquisition_support.runtime
assert_error = owner_contract.assert_error
pending = membership_contract.pending

# Every original source name maps to an independently reported stable case ID
# in the packet inventory. Retired/explicit-close cases stay in fast owners.
CASES = (
    'acquisition_exact_recovery_expired',
    'acquisition_pending_loader_expired',
    'retention_pending_expired',
    'membership_expired_create', 'membership_expired_add', 'membership_expired_save',
    'membership_post_preload_expiry',
    'membership_post_retention_expiry_create',
    'membership_post_retention_expiry_add',
    'membership_post_retention_expiry_save',
    'membership_post_receipt_expiry_create',
    'membership_post_receipt_expiry_add',
    'membership_post_receipt_expiry_save',
    'landed_create_receipt_after_expiry_and_removal',
    'unlanded_frozen_retry_expired_create',
    'unlanded_frozen_retry_expired_add',
    'unlanded_frozen_retry_expired_save',
    'http_exact_recovery_expired',
    'draining_and_full_parent_expiry_matrix',
    'consumed_create_full_expiry_after_native_top',
    'consumed_create_full_expiry_after_final_policy',
    'consumed_top_full_expiry_after_final_policy',
    'legacy_old_writer_service_and_http_real_expiry',
)


def _sql_now(database):
    # A fresh, read-only runtime transaction each poll. No account, Top or source
    # transaction stays open for the initial half-hour/hour aging period.
    with runtime(database) as connection:
        assert_runtime_role(connection, database)
        return connection.execute('select clock_timestamp() as now').fetchone()['now']


def _wait_sql(database, deadline, stop, *, before=0):
    target = deadline - timedelta(seconds=before)
    while True:
        if stop.is_set():
            raise RuntimeError('Real-expiry batch interrupted; acceptance remains uncovered')
        observed = _sql_now(database)
        remaining = (target - observed).total_seconds()
        if remaining <= 0:
            return observed
        stop.wait(min(5.0, remaining))


def _initial_long_session(database):
    """Actual new fixture session, before acquisition; never alter pending time."""
    with database.connect() as connection:
        row = connection.execute('''insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,clock_timestamp(),clock_timestamp(),clock_timestamp(),
                clock_timestamp()+interval '2 hours',clock_timestamp()+interval '1 day')
            returning id,authenticated_at,idle_expires_at,absolute_expires_at''',
            (database.owner.account_id, sha256(uuid4().bytes).digest())).fetchone()
    assert row['idle_expires_at'] - row['authenticated_at'] >= timedelta(hours=2)
    database.owner = replace(database.owner, session_id=row['id'], authenticated_at=row['authenticated_at'])


def _fact(case, acquired):
    row = next(row for row in case.remote.rows() if str(row['ref']) == acquired['acquisition_ref'])
    assert row['preparation_ref'] is not None and row['attempt_ref'] is not None
    assert row['retired_at'] is None
    assert row['expires_at'] - row['created_at'] == timedelta(minutes=30)
    assert _sql_now(case.db) < row['expires_at'], 'Fresh source unexpectedly expired during setup'
    parent = _parent(case, str(row['preparation_ref']))
    assert parent['created_at'] <= row['created_at'] < parent['accepts_until']
    assert row['expires_at'] <= parent['fully_expires_at']
    return row


def _parent(case, reference):
    row = next(row for row in case.remote.c2_state()['album_top_remote_preparations'] if str(row['ref']) == reference)
    assert row['accepts_until'] - row['created_at'] == timedelta(minutes=30)
    assert row['fully_expires_at'] - row['created_at'] == timedelta(minutes=60)
    assert row['closed_at'] is None
    return row


def _expired(case, fact, stop):
    observed = _wait_sql(case.db, fact['expires_at'] + timedelta(milliseconds=50), stop)
    assert observed >= fact['expires_at']
    assert (observed - fact['created_at']).total_seconds() >= 1800
    return {'acquisition_ref': str(fact['ref']), 'created_at': fact['created_at'],
        'expires_at': fact['expires_at'], 'expired_sql_at': observed,
        'elapsed_sql_seconds': (observed - fact['created_at']).total_seconds()}


def _membership_command(case, action):
    top = None if action == 'create' else case.db.create(refs=[])[0]
    acquired = case.acquire(top)
    if action == 'create':
        command = case.command(action, title='Elapsed expiry acceptance',
            draft_ref=acquired['destination']['draft_ref'], selections=[pending(acquired)])
    elif action == 'add':
        command = case.command(action, top, selections=[pending(acquired)])
    else:
        command = case.command(action, top, title='Must roll back after expiry',
            item_selections=[{'kind': 'new_remote', 'source': pending(acquired)}])
    return acquired, _fact(case, acquired), command


@contextmanager
def _attempt_trace(case):
    """Record attempted SQL, including a real SQL call that raises; no mock rows."""
    connect = case.db.service._connect
    trace = []

    class Connection:
        def __init__(self, real):
            self.real = real

        def execute(self, sql, params=None):
            entry = {'sql': ' '.join(sql.lower().split()), 'params': params, 'completed': False}
            trace.append(entry)
            result = self.real.execute(sql, params)
            entry['completed'] = True
            return result

        def __getattr__(self, name):
            return getattr(self.real, name)

    @contextmanager
    def observed(*args, **kwargs):
        with connect(*args, **kwargs) as connection:
            yield Connection(connection)

    case.db.service._connect = observed
    try:
        yield trace
    finally:
        case.db.service._connect = connect


@contextmanager
def _post_boundary_gate(case, deadline, stop):
    """Inserted post-boundary advisory wait; real blocker, bounded by existing 5s.

    A transparent successful-statement observer calls cross(raw_connection).
    The original statement has really completed and its result is left intact.
    An independent runtime backend proves this backend is waiting for this exact
    blocker, then releases only after the original immutable SQL deadline.
    """
    reached = Event()
    released = Event()
    observation = {}
    lock_key = uuid4().int % (2 ** 63 - 1)
    with runtime(case.db) as blocker:
        assert_runtime_role(blocker, case.db)
        blocker.execute('select pg_advisory_xact_lock(%s)', (lock_key,)).fetchone()
        blocker_pid = blocker.info.backend_pid

        def release_after_expiry():
            try:
                assert reached.wait(5), 'Target production boundary was not reached'
                end = monotonic() + 2
                seen = None
                while monotonic() < end and not stop.is_set():
                    with runtime(case.db) as probe:
                        role = assert_runtime_role(probe, case.db)
                        seen = probe.execute('''select pid,usename,wait_event_type,
                            pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=%s''',
                            (observation['worker_pid'],)).fetchone()
                    if (seen is not None and seen['usename'] == role and seen['wait_event_type'] == 'Lock'
                            and blocker_pid in seen['blockers']):
                        break
                    stop.wait(0.01)
                assert seen is not None and seen['wait_event_type'] == 'Lock'
                assert blocker_pid in seen['blockers'], 'Exact runtime blocker was never observed'
                observation['blocked_backend'] = dict(seen)
                observation['release_sql_at'] = _wait_sql(case.db, deadline + timedelta(milliseconds=50), stop)
                assert observation['release_sql_at'] >= deadline
            finally:
                # Also release if a boundary assertion fails: no stranded worker.
                blocker.rollback()
                released.set()

        def cross(connection):
            assert not reached.is_set(), 'Boundary gate must be traversed exactly once'
            assert_runtime_role(connection, case.db)
            observed = connection.execute('select clock_timestamp() as now').fetchone()['now']
            remaining = (deadline - observed).total_seconds()
            assert 0 < remaining < 4, 'Expected live source immediately before the real boundary wait'
            observation.update(worker_pid=connection.info.backend_pid, entered_sql_at=observed,
                immutable_deadline=deadline, blocker_pid=blocker_pid)
            reached.set()
            connection.execute('select pg_advisory_xact_lock(%s)', (lock_key,)).fetchone()
            observed = connection.execute('select clock_timestamp() as now').fetchone()['now']
            assert released.wait(1)
            assert observed >= deadline, 'Gate released before actual SQL expiry'
            observation['resumed_sql_at'] = observed

        with ThreadPoolExecutor(max_workers=1) as pool:
            monitor = pool.submit(release_after_expiry)
            try:
                yield cross, observation
            finally:
                # If production refused before this boundary the monitor fails,
                # rather than silently accepting an earlier-boundary substitute.
                monitor.result(timeout=8)


def _snapshot(case):
    # Preserve the original acquisition suite's Goals/unrelated proof as well
    # as every membership/catalog/publication/receipt/C2 rollback field.
    return {'membership': case.snapshot(), 'unrelated': case.remote.unrelated()}


def _quiet_failure(case, callback, code='remote_evidence_unavailable'):
    before, calls = _snapshot(case), len(case.remote.calls)
    assert_error(callback, code, 409)
    assert _snapshot(case) == before
    assert len(case.remote.calls) == calls
    return before


def _simple_expired(case, name, stop):
    if name == 'retention_pending_expired':
        top = case.storage.top()
        acquired = case.acquire(top)
        fact = _fact(case, acquired)
        catalog = case.storage.mapping(acquired)
        proof = _expired(case, fact, stop)
        before, calls = _snapshot(case), len(case.remote.calls)
        with runtime(case.db) as connection:
            assert_runtime_role(connection, case.db)
            # The actual retention definer establishes/rechecks its exact full
            # source prefix and rejects expired source before any history write.
            case.storage.locks(connection, top, pending_budget=True)
            acquisition_support.sql_error(connection, '55000', lambda: retention_support.invoke(connection,
                retention_support.RETAIN, case.storage.retain_args(top, acquired, catalog)),
                constraint='top_remote_expired')
        assert _snapshot(case) == before and len(case.remote.calls) == calls
        assert case.storage.counts()['admission_count'] == 0
        return proof
    acquired = case.acquire()
    fact = _fact(case, acquired)
    command = case.acquisitions[acquired['acquisition_ref']]['command']
    proof = _expired(case, fact, stop)
    if name == 'acquisition_exact_recovery_expired':
        _quiet_failure(case, lambda: case.remote.acquire(command), 'remote_preparation_unavailable')
    else:
        assert name == 'acquisition_pending_loader_expired'
        _quiet_failure(case, lambda: acquisition_contract.pending(case.remote, acquired, command))
    assert len(case.remote.rows()) == 1 and case.remote.rows()[0] == fact
    return proof


def _expired_membership(case, action, stop):
    acquired, fact, command = _membership_command(case, action)
    proof = _expired(case, fact, stop)
    case.remote.statements.clear()
    _quiet_failure(case, lambda: case.execute(command))
    assert not any('insert into catalog.' in sql or 'app.retain_top_remote_acquisition' in sql
        or 'app.consume_top_remote_acquisitions' in sql for sql in case.remote.statements)
    assert str(case.remote.rows()[0]['ref']) == acquired['acquisition_ref']
    return proof


def _boundary_expiry(case, boundary, action, stop):
    acquired, fact, command = _membership_command(case, action)
    before, calls = _snapshot(case), len(case.remote.calls)
    _wait_sql(case.db, fact['expires_at'], stop, before=3)
    case.remote.statements.clear()
    reached = []
    with _post_boundary_gate(case, fact['expires_at'], stop) as (cross, proof):
        def after(sql, connection):
            match = (sql.startswith('select *,clock_timestamp() as checked_at from app.album_top_remote_acquisitions')
                if boundary == 'preload' else ('app.retain_top_remote_acquisition(' in sql
                if boundary == 'retention' else sql.startswith('insert into app.album_list_operations')))
            if not match:
                return
            # These reads observe the actual same transaction; no invented
            # operation, admission, final bridge, cursor result or SQL timestamp.
            state = connection.execute('''select
                (select count(*) from app.album_top_remote_admissions where library_id=%s) as admissions,
                (select count(*) from app.album_list_item_remote_sources where library_id=%s) as bridges,
                (select count(*) from app.album_list_operations where actor_account_id=%s and request_key=%s) as receipts''',
                (case.db.library, case.db.library, case.db.owner.account_id, command.request_key)).fetchone()
            assert state['admissions'] == (0 if boundary == 'preload' else 1)
            if boundary == 'receipt':
                assert state['receipts'] == 1 and state['bridges'] == 1
            else:
                assert state['receipts'] == 0
            reached.append({'completed_production_sql': sql, 'transaction_state': dict(state)})
            cross(connection)
        case.remote.after_statement = after
        try:
            with _attempt_trace(case) as trace:
                assert_error(lambda: case.execute(command), 'remote_evidence_unavailable', 409)
        finally:
            case.remote.after_statement = None
    assert len(reached) == 1 and _snapshot(case) == before and len(case.remote.calls) == calls
    assert (proof['resumed_sql_at'] - fact['created_at']).total_seconds() >= 1800
    if boundary == 'preload':
        # B resamples SQL time inside the v2 loader immediately after preload.
        # The earlier guard now prevents mapping; the distinct retention/receipt
        # cases below preserve the old actual-prior-write rollback requirement.
        assert not any('insert into catalog.' in entry['sql'] or 'app.retain_top_remote_acquisition' in entry['sql']
            for entry in trace)
        assert any(entry['sql'] == 'select clock_timestamp() as checked_at' and entry['completed'] for entry in trace)
    else:
        assert any('insert into catalog.release_group_provider_identities' in entry['sql'] and entry['completed'] for entry in trace)
        assert any('app.retain_top_remote_acquisition(' in entry['sql'] and entry['completed'] for entry in trace)
        assert any(entry['sql'].startswith('insert into app.album_list_operations') and entry['completed'] for entry in trace)
        consumption = [entry for entry in trace if 'app.consume_top_remote_acquisitions(' in entry['sql']]
        assert len(consumption) == 1 and consumption[0]['completed'] is False
    return {**proof, 'acquisition_ref': acquired['acquisition_ref'], 'boundary': boundary, 'observations': reached}


def _landed_receipt(case, stop):
    acquired = case.acquire()
    fact = _fact(case, acquired)
    top, command = case.create(local=False, acquired=acquired)
    source = case.read(top)['edit_draft']['item_selections'][0]['source']
    item = case.read(top)['items'][0]['ref']
    top = case.execute(case.command('remove', top, item_refs=[item]))
    proof = _expired(case, fact, stop)
    closed = case.remote.service.close_preparation(case.db.context(),
        preparation_ref=str(fact['preparation_ref']), payload={}, context_ref=CONTEXT)
    assert closed['removed_attempts'] == 1 and closed['removed_facts'] == 0 and closed['released_bytes'] == 0
    state = case.remote.c2_state()
    assert state['album_top_remote_preparations'] == [] and state['album_top_remote_attempts'] == []
    before, calls = _snapshot(case), len(case.remote.calls)
    case.remote.statements.clear()
    receipt = case.execute(command, actor=new_session(case.db, case.db.owner))
    assert receipt['top_ref'] == top['top_ref'] and receipt['revision'] == '1'
    assert _snapshot(case) == before and case.read(top)['items'] == [] and len(case.remote.calls) == calls
    forbidden = ('from app.album_top_remote_acquisitions', 'app.retain_top_remote_acquisition',
        'app.consume_top_remote_acquisitions', 'app.lock_top_remote_pending_actor',
        'app.lock_top_remote_membership_sources', 'app.begin_top_remote_preparation')
    assert not any(token in sql for sql in case.remote.statements for token in forbidden)
    readded = case.execute(case.command('add', top, selections=[source]))
    assert len(case.read(readded)['items']) == 1
    assert case.rows('album_top_remote_retained_budgets')[0]['admission_count'] == 1
    assert case.remote.c2_state() == state
    return proof


def _unlanded_receipt(case, action, stop):
    acquired, fact, command = _membership_command(case, action)
    before, calls = _snapshot(case), len(case.remote.calls)
    reached = []

    class ForcedOuterRollback(RuntimeError):
        pass

    def after(sql, connection):
        if 'app.consume_top_remote_acquisitions(' in sql:
            row = connection.execute('''select state from app.album_top_remote_attempts where acquisition_ref=%s''',
                (acquired['acquisition_ref'],)).fetchone()
            assert row['state'] == 'consumed'
            assert connection.execute('select ref from app.album_top_remote_acquisitions where ref=%s',
                (acquired['acquisition_ref'],)).fetchone() is None
            assert connection.execute('select request_key from app.album_list_operations where actor_account_id=%s and request_key=%s',
                (case.db.owner.account_id, command.request_key)).fetchone() is not None
            reached.append(True)
            raise ForcedOuterRollback('Explicit test rollback after actual consume and receipt')
    case.remote.after_statement = after
    try:
        with pytest.raises(ForcedOuterRollback):
            case.execute(command)
    finally:
        case.remote.after_statement = None
    assert reached == [True] and _snapshot(case) == before
    proof = _expired(case, fact, stop)
    case.remote.statements.clear()
    _quiet_failure(case, lambda: case.execute(command))
    assert len(case.remote.calls) == calls
    assert not any('app.consume_top_remote_acquisitions' in sql or 'insert into app.album_list_operations' in sql
        for sql in case.remote.statements)
    return {**proof, 'frozen_operation_key': command.request_key, 'rollback_after_actual_consume': True}


def _http_expired(case, stop):
    app = http_contract.application(case.remote)
    auth = http_contract.mutation_headers(app, case.db.owner)
    command = http_contract.http_command(case.remote, app, http_contract.ACQUIRE)
    command['release_group_id'] = case.remote.facts.release_group_id
    acquired = http_contract.ready(http_contract.call(app, http_contract.ACQUIRE, headers=auth, payload=command))
    fact = _fact(case, acquired)
    assert fact['context_ref'] == auth['x-albumhaven-context']
    proof = _expired(case, fact, stop)
    before, calls = _snapshot(case), len(case.remote.calls)
    status, body, headers = http_contract.call(app, http_contract.ACQUIRE, headers=auth, payload=command)
    assert status == 409 and body['error'] == 'remote_preparation_unavailable'
    assert headers[b'cache-control'] == b'private, no-store'
    assert _snapshot(case) == before and len(case.remote.calls) == calls
    return proof


def _consumed_create_full_expiry(case, stop):
    acquired = case.acquire()
    fact = _fact(case, acquired)
    command = case.acquisitions[acquired['acquisition_ref']]['command']
    top, _ = case.create(local=False, acquired=acquired)
    parent = _parent(case, str(fact['preparation_ref']))
    before, calls = _snapshot(case), len(case.remote.calls)
    _wait_sql(case.db, parent['fully_expires_at'], stop, before=3)
    first_reader, top_reads = [], []
    with _post_boundary_gate(case, parent['fully_expires_at'], stop) as (cross, proof):
        def after(sql, connection):
            if 'app.read_top_remote_consumed_create(' in sql:
                first_reader.append(sql)
            elif sql.startswith('select * from app.album_lists where ref=') and 'for update' in sql and first_reader:
                assert len(first_reader) == 1
                top_reads.append(sql)
                # This is the native owner's already-held exact result Top read.
                # The synthetic wait follows its real SELECT, before the second
                # fixed reader and projection. It is not a pre-Top expiry probe.
                row = connection.execute('select ref,owner_account_id from app.album_lists where ref=%s',
                    (top['top_ref'],)).fetchone()
                assert str(row['ref']) == top['top_ref'] and row['owner_account_id'] == case.db.owner.account_id
                cross(connection)
        case.remote.after_statement = after
        try:
            with _attempt_trace(case) as trace:
                assert_error(lambda: case.remote.acquire(command), 'remote_preparation_unavailable', 409)
        finally:
            case.remote.after_statement = None
    readers = [entry for entry in trace if 'app.read_top_remote_consumed_create(' in entry['sql']]
    assert len(readers) == 2 and readers[0]['completed'] and not readers[1]['completed']
    assert readers[0]['params'] == readers[1]['params']
    assert str(readers[0]['params'][-1]) == top['top_ref']
    assert len(first_reader) == len(top_reads) == 1
    assert (proof['resumed_sql_at'] - parent['created_at']).total_seconds() >= 3600
    assert _snapshot(case) == before and len(case.remote.calls) == calls
    assert not any('app.reserve_top_remote_attempt' in entry['sql'] or 'app.lock_top_remote_pending_actor' in entry['sql']
        or entry['sql'].startswith(('insert ', 'update ', 'delete ')) for entry in trace)
    return {**proof, 'parent_created_at': parent['created_at'], 'native_top_ref': top['top_ref'],
        'first_fixed_read_completed': True, 'second_fixed_read_refused': True}


def _consumed_create_full_expiry_after_policy(case, stop):
    acquired = case.acquire()
    fact = _fact(case, acquired)
    command = case.acquisitions[acquired['acquisition_ref']]['command']
    top, _ = case.create(local=False, acquired=acquired)
    parent = _parent(case, str(fact['preparation_ref']))
    before, calls = _snapshot(case), len(case.remote.calls)
    _wait_sql(case.db, parent['fully_expires_at'], stop, before=3)
    completed_readers, policy_returns, order = [], [], []
    final_clock_sql = 'select clock_timestamp()::text as checked_at'
    with _post_boundary_gate(case, parent['fully_expires_at'], stop) as (cross, proof):
        def after(sql, connection):
            if 'app.read_top_remote_consumed_create(' in sql:
                completed_readers.append(connection)
                order.append('fixed_reader_' + str(len(completed_readers)))
            elif sql.startswith('select * from app.album_lists where ref=') and 'for update' in sql and completed_readers:
                assert len(completed_readers) == 1
                order.append('native_top')
            elif sql == final_clock_sql:
                assert policy_returns == ['create', 'resource_browse']
                assert connection.info.backend_pid == proof['worker_pid']
                order.append('final_target_free_clock')
                proof['final_clock_backend_pid'] = connection.info.backend_pid

        def constraints(context):
            if len(completed_readers) == 2:
                if context.action == CREATE:
                    assert context.resource is None and policy_returns == []
                    assert completed_readers[0] is completed_readers[1]
                    assert order == ['fixed_reader_1', 'native_top', 'fixed_reader_2']
                    order.append('final_create_policy_wait')
                    # Both exact structural SQL readers have really completed.
                    # This real policy callback now waits on that same runtime
                    # backend, then permits Create after the immutable deadline.
                    cross(completed_readers[1])
                    policy_returns.append('create')
                    order.append('final_create_policy_allowed')
                elif context.action == BROWSE and context.resource is not None:
                    assert policy_returns == ['create']
                    policy_returns.append('resource_browse')
                    order.append('final_resource_browse_allowed')
            return PolicyEvaluationConstraints(request_origin_allowed=True)

        case.remote.after_statement = after
        try:
            with _attempt_trace(case) as trace:
                assert_error(lambda: case.remote.acquire(command, constraints=constraints),
                    'remote_preparation_unavailable', 409)
        finally:
            case.remote.after_statement = None
    readers = [entry for entry in trace if 'app.read_top_remote_consumed_create(' in entry['sql']]
    assert len(readers) == 2 and all(entry['completed'] for entry in readers)
    assert readers[0]['params'] == readers[1]['params']
    assert str(readers[0]['params'][-1]) == top['top_ref']
    assert order == ['fixed_reader_1', 'native_top', 'fixed_reader_2',
        'final_create_policy_wait', 'final_create_policy_allowed',
        'final_resource_browse_allowed', 'final_target_free_clock']
    clocks = [entry for entry in trace if entry['sql'] == final_clock_sql]
    assert len(clocks) == 1 and clocks[0]['completed'] and clocks[0]['params'] is None
    assert trace[-1] is clocks[0], 'No new target, callback SQL or state write may follow the final clock'
    assert (proof['resumed_sql_at'] - parent['created_at']).total_seconds() >= 3600
    assert _snapshot(case) == before and len(case.remote.calls) == calls
    assert not any('app.reserve_top_remote_attempt' in entry['sql'] or 'app.lock_top_remote_pending_actor' in entry['sql']
        or entry['sql'].startswith(('insert ', 'update ', 'delete ')) for entry in trace)
    return {**proof, 'parent_created_at': parent['created_at'], 'native_top_ref': top['top_ref'],
        'both_fixed_readers_completed': True, 'late_create_policy_permitted': True,
        'late_resource_browse_permitted': True, 'target_free_final_clock_completed': True,
        'acknowledgement_refused_after_final_policy': True, 'boundary_order': order}


def _consumed_top_full_expiry_after_policy(case, stop):
    top = case.db.create(refs=[])[0]
    acquired = case.acquire(top)
    fact = _fact(case, acquired)
    command = case.acquisitions[acquired['acquisition_ref']]['command']
    result = case.execute(case.command('add', top, selections=[pending(acquired)]))
    assert result['top_ref'] == top['top_ref'] and int(result['revision']) == int(top['revision']) + 1
    parent = _parent(case, str(fact['preparation_ref']))
    before, calls = _snapshot(case), len(case.remote.calls)
    _wait_sql(case.db, parent['fully_expires_at'], stop, before=3)
    replay_connections, policy_returns, order = [], [], []
    final_clock_sql = 'select clock_timestamp()::text as checked_at'
    with _post_boundary_gate(case, parent['fully_expires_at'], stop) as (cross, proof):
        def after(sql, connection):
            if 'app.reserve_top_remote_attempt(' in sql:
                assert replay_connections == []
                replay_connections.append(connection)
                order.append('consumed_replay_read')
            elif sql == final_clock_sql:
                assert policy_returns == ['browse', 'items']
                assert connection.info.backend_pid == proof['worker_pid']
                order.append('final_target_free_clock')
                proof['final_clock_backend_pid'] = connection.info.backend_pid

        def cancelled():
            if replay_connections:
                assert order == ['consumed_replay_read']
                order.append('late_cancellation_allowed')
            return False

        def constraints(context):
            if replay_connections:
                assert context.resource is not None
                if context.action == BROWSE:
                    assert order == ['consumed_replay_read', 'late_cancellation_allowed']
                    policy_returns.append('browse')
                    order.append('late_browse_allowed')
                elif context.action == membership_contract.ITEMS:
                    assert policy_returns == ['browse']
                    order.append('late_items_policy_wait')
                    # The real replay definer already returned the consumed
                    # state. Current Items now permits only after an observed
                    # same-backend wait crosses the original full60 deadline.
                    cross(replay_connections[0])
                    policy_returns.append('items')
                    order.append('late_items_policy_allowed')
            return PolicyEvaluationConstraints(request_origin_allowed=True)

        case.remote.after_statement = after
        try:
            with _attempt_trace(case) as trace:
                assert_error(lambda: case.remote.acquire(command, constraints=constraints,
                    should_cancel=cancelled), 'remote_preparation_unavailable', 409)
        finally:
            case.remote.after_statement = None
    replay = [entry for entry in trace if 'app.reserve_top_remote_attempt(' in entry['sql']]
    assert len(replay) == 1 and replay[0]['completed']
    assert replay[0]['params'] == case.remote.binding_v2(command)
    assert order == ['consumed_replay_read', 'late_cancellation_allowed', 'late_browse_allowed',
        'late_items_policy_wait', 'late_items_policy_allowed', 'final_target_free_clock']
    clocks = [entry for entry in trace if entry['sql'] == final_clock_sql]
    assert len(clocks) == 1 and clocks[0]['completed'] and clocks[0]['params'] is None
    assert trace[trace.index(replay[0]) + 1:] == clocks, 'No new target, initializer or state write after replay'
    assert not any(entry['sql'].startswith(('insert ', 'update ', 'delete ')) for entry in trace)
    assert (proof['resumed_sql_at'] - parent['created_at']).total_seconds() >= 3600
    assert _snapshot(case) == before and len(case.remote.calls) == calls
    return {**proof, 'parent_created_at': parent['created_at'], 'native_top_ref': top['top_ref'],
        'original_revision': top['revision'], 'consumed_revision': result['revision'],
        'consumed_replay_read_completed': True, 'late_cancellation_permitted': True,
        'late_browse_permitted': True, 'late_items_permitted': True,
        'target_free_final_clock_completed': True, 'acknowledgement_refused_after_final_policy': True,
        'boundary_order': order}


def _draining_matrix(case, stop):
    # Five separate normal parents; no near-acceptance insertion or deadline
    # adjustment. Their original server-created accepting/full times stay exact.
    consumed = case.acquire()
    _fact(case, consumed)
    consumed_command = case.acquisitions[consumed['acquisition_ref']]['command']
    case.create(local=False, acquired=consumed)
    failed_command = case.remote.prepare_v2(mbid=str(uuid4()))
    def known_failure():
        raise RemoteAlbumEvidenceError('provider_unavailable')
    case.remote.provider_hook = known_failure
    try:
        failed = case.remote.acquire(failed_command)
    finally:
        case.remote.provider_hook = None
    assert failed['state'] == 'failed'
    reserved_command = case.remote.prepare_v2(mbid=str(uuid4()))
    pending_parent, pending_target = case.remote.begin_v2()
    consuming_parent, consuming_target = case.remote.begin_v2()
    initial = case.remote.c2_state()
    parents = {str(row['ref']): _parent(case, str(row['ref'])) for row in initial['album_top_remote_preparations']}
    assert len(parents) == 5
    # Finish fresh facts shortly before the original parents start draining.
    # Facts still receive their own full, exact 30-minute lifetime. This is only
    # draining coverage, never a substitute for the fact-expiry cases above.
    late_deadline = min(parents[reserved_command['preparation_ref']]['accepts_until'],
        parents[pending_parent['preparation_ref']]['accepts_until'],
        parents[consuming_parent['preparation_ref']]['accepts_until'])
    _wait_sql(case.db, late_deadline, stop, before=15)
    reserved = case.remote.reserve_v2(reserved_command)
    assert reserved['dispatch'] is True
    reserved_row = next(row for row in case.remote.c2_state()['album_top_remote_attempts']
        if str(row['ref']) == reserved['attempt_ref'])
    assert reserved_row['lease_until'] == parents[reserved_command['preparation_ref']]['accepts_until']
    assert reserved_row['created_at'] < reserved_row['lease_until']
    pending_command = acquisition_support.prepared_payload(pending_parent, pending_target, mbid=str(uuid4()))
    case.remote.facts = acquisition_support.evidence(mbid=pending_command['release_group_id'],
        title='Draining pending ' + uuid4().hex)
    late_pending = case.remote.acquire(pending_command)
    late_pending_fact = _fact(case, late_pending)
    consuming_command = acquisition_support.prepared_payload(consuming_parent, consuming_target, mbid=str(uuid4()))
    case.remote.facts = acquisition_support.evidence(mbid=consuming_command['release_group_id'],
        title='Draining consumed ' + uuid4().hex)
    case.external_ids.append(case.remote.facts.release_group_id)
    case.fact_titles.append(case.remote.facts.title)
    late_consuming = case.remote.acquire(consuming_command)
    late_consuming_fact = _fact(case, late_consuming)
    assert late_pending_fact['expires_at'] - late_pending_fact['created_at'] == timedelta(minutes=30)
    assert late_consuming_fact['expires_at'] - late_consuming_fact['created_at'] == timedelta(minutes=30)
    _wait_sql(case.db, max(row['accepts_until'] for row in parents.values()) + timedelta(milliseconds=50), stop)
    assert _sql_now(case.db) < min(late_pending_fact['expires_at'], late_consuming_fact['expires_at'])
    before, calls = _snapshot(case), len(case.remote.calls)
    status = case.remote.service.preparation_status(case.db.context(), context_ref=CONTEXT)
    assert len(status['parents']) == 5 and all(row['state'] == 'draining' for row in status['parents'])
    assert case.remote.acquire(pending_command) == late_pending
    assert case.remote.acquire(consumed_command)['state'] == 'consumed'
    assert case.remote.acquire(failed_command) == failed
    assert_error(lambda: case.remote.acquire(reserved_command), 'remote_preparation_unavailable', 409)
    expired_reservation = case.remote.reserve_v2(reserved_command)
    assert expired_reservation['state'] == 'expired' and expired_reservation['dispatch'] is False
    assert _sql_now(case.db) >= reserved_row['lease_until']
    # Exact retries and genuinely new keys never obtain another dispatch right.
    for command in (consumed_command, failed_command, reserved_command, pending_command, consuming_command):
        assert_error(lambda command=command: case.remote.acquire({**command, 'request_key': str(uuid4())}),
            'remote_preparation_unavailable', 409)
    with runtime(case.db) as connection:
        assert_runtime_role(connection, case.db)
        original_facts = acquisition_support.evidence(mbid=reserved_command['release_group_id'])
        args = (*case.remote.binding_v2(reserved_command), reserved['attempt_ref'], reserved['acquisition_ref'],
            original_facts.digest, original_facts.title, original_facts.artist_display,
            original_facts.first_release_date, original_facts.primary_type)
        acquisition_support.sql_error(connection, '55000', lambda: connection.execute(
            'select app.finish_top_remote_attempt(' + ','.join(['%s'] * len(args)) + ')', args),
            constraint='top_remote_expired')
    for denied in (BROWSE, CREATE):
        assert_error(lambda denied=denied: case.remote.acquire(consumed_command,
            constraints=lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != denied)),
            'forbidden', 403)
    assert _snapshot(case) == before and len(case.remote.calls) == calls
    case.create(local=False, acquired=late_consuming)
    assert case.remote.acquire(consuming_command)['state'] == 'consumed'
    after_consumption = _snapshot(case)
    # No reclaim/close occurs: full lifetime must deny even with physical rows.
    full = max(row['fully_expires_at'] for row in parents.values())
    observed = _wait_sql(case.db, full + timedelta(milliseconds=50), stop)
    assert all((observed - row['created_at']).total_seconds() >= 3600 for row in parents.values())
    for command in (consumed_command, failed_command, reserved_command, pending_command, consuming_command):
        assert_error(lambda command=command: case.remote.acquire(command), 'remote_preparation_unavailable', 409)
    status = case.remote.service.preparation_status(case.db.context(), context_ref=CONTEXT)
    assert len(status['parents']) == 5 and all(row['state'] == 'expired' for row in status['parents'])
    assert _snapshot(case) == after_consumption and len(case.remote.calls) == calls
    state = case.remote.c2_state()
    assert len(state['album_top_remote_preparations']) == 5
    assert {row['state'] for row in state['album_top_remote_attempts']} == {'consumed', 'failed', 'reserved', 'pending'}
    assert all(row['closed_at'] is None for row in state['album_top_remote_preparations'])
    return {'parent_created_at': min(row['created_at'] for row in parents.values()),
        'latest_full_expiry': full, 'expired_sql_at': observed, 'physical_parents_before_cleanup': 5,
        'late_pending_actual_ttl_seconds': 1800, 'draining_live_consumption_proved': True}


def _legacy_expiry(case, stop):
    # Separate, explicitly supplied EMPTY transition database. These are the
    # actual pre-0132 runtime old-writer rows, never post-cutoff direct INSERTs.
    app = http_contract.application(case)
    auth = http_contract.mutation_headers(app, case.db.owner)
    service_command = acquisition_support.payload()
    http_command = acquisition_support.payload()
    service_ref = case.seed_old_command(service_command)
    http_ref = case.seed_old_command(http_command, context_ref=auth['x-albumhaven-context'])
    original = case.rows()
    assert {str(row['ref']) for row in original} == {service_ref, http_ref}
    assert all(row['expires_at'] - row['created_at'] == timedelta(minutes=30) for row in original)
    case.apply_cutoff()
    case.apply_consumption()
    service_first = case.acquire(service_command)
    http_first = http_contract.ready(http_contract.call(app, http_contract.ACQUIRE, headers=auth, payload=http_command))
    assert service_first['acquisition_ref'] == service_ref and http_first['acquisition_ref'] == http_ref
    assert case.calls == []
    before = case.rows()
    for row in before:
        expected = next(old for old in original if old['ref'] == row['ref'])
        assert {key: row[key] for key in expected} == expected
        assert row['preparation_ref'] is None and row['attempt_ref'] is None
    observed = _wait_sql(case.db, max(row['expires_at'] for row in before) + timedelta(milliseconds=50), stop)
    assert all((observed - row['created_at']).total_seconds() >= 1800 for row in before)
    assert_error(lambda: case.acquire(service_command), 'remote_evidence_unavailable', 409)
    status, body, headers = http_contract.call(app, http_contract.ACQUIRE, headers=auth, payload=http_command)
    assert status == 409 and body['error'] == 'remote_evidence_unavailable'
    assert headers[b'cache-control'] == b'private, no-store'
    assert case.rows() == before and case.calls == []
    return {'legacy_acquisition_refs': [service_ref, http_ref], 'expired_sql_at': observed,
        'phases': [entry['phase'] for entry in case.phase_ledgers], 'provider_calls': 0}


def _run(case, name, stop):
    if name in {'acquisition_exact_recovery_expired', 'acquisition_pending_loader_expired', 'retention_pending_expired'}:
        return _simple_expired(case, name, stop)
    if name.startswith('membership_expired_'):
        return _expired_membership(case, name.rsplit('_', 1)[1], stop)
    if name == 'membership_post_preload_expiry':
        return _boundary_expiry(case, 'preload', 'create', stop)
    if name.startswith('membership_post_retention_expiry_'):
        return _boundary_expiry(case, 'retention', name.rsplit('_', 1)[1], stop)
    if name.startswith('membership_post_receipt_expiry_'):
        return _boundary_expiry(case, 'receipt', name.rsplit('_', 1)[1], stop)
    if name == 'landed_create_receipt_after_expiry_and_removal':
        return _landed_receipt(case, stop)
    if name.startswith('unlanded_frozen_retry_expired_'):
        return _unlanded_receipt(case, name.rsplit('_', 1)[1], stop)
    if name == 'http_exact_recovery_expired':
        return _http_expired(case, stop)
    if name == 'draining_and_full_parent_expiry_matrix':
        return _draining_matrix(case, stop)
    if name == 'consumed_create_full_expiry_after_native_top':
        return _consumed_create_full_expiry(case, stop)
    if name == 'consumed_create_full_expiry_after_final_policy':
        return _consumed_create_full_expiry_after_policy(case, stop)
    if name == 'consumed_top_full_expiry_after_final_policy':
        return _consumed_top_full_expiry_after_policy(case, stop)
    assert name == 'legacy_old_writer_service_and_http_real_expiry'
    return _legacy_expiry(case, stop)


class _Batch:
    def __init__(self):
        self.futures = {}
        self.setup_errors = {}
        self.checked = set()

    def result(self, name):
        self.checked.add(name)
        if name in self.setup_errors:
            # In particular, the exact missing-transition-DB skip is reported
            # only for its legacy case, never as a fresh-v2 pass or blanket skip.
            raise self.setup_errors[name]
        return self.futures[name].result(timeout=3900)


@pytest.fixture(scope='module')
def real_expiry_batch(urls, request):
    """One explicit batch; intact existing fixture setup/finalizers per case.

    Directly entering the wrapped fixture generators reuses their real setup
    and cleanup without changing any shared fixture's pytest scope. Independent
    databases here mean independent synthetic actor/library sets on the same
    admitted test database, not provisioning databases or widening privileges.
    """
    stop = Event()
    batch = _Batch()
    selected = {item.callspec.params['case_name'] for item in request.session.items
        if item.getparent(pytest.Module) is request.node and hasattr(item, 'callspec')
        and 'case_name' in item.callspec.params}
    assert selected and selected.issubset(CASES)
    with ExitStack() as stack:
        pool = ThreadPoolExecutor(max_workers=len(CASES))
        try:
            for name in CASES:
                if name not in selected:
                    continue
                try:
                    if name == 'legacy_old_writer_service_and_http_real_expiry':
                        case = stack.enter_context(contextmanager(cutoff_support.cutoff_transition.__wrapped__)())
                        _initial_long_session(case.db)
                    else:
                        database = stack.enter_context(contextmanager(owner_contract.db.__wrapped__)(urls))
                        _initial_long_session(database)
                        remote = stack.enter_context(contextmanager(acquisition_support.remote.__wrapped__)(database))
                        retained = stack.enter_context(retention_support.retention_case(remote))
                        case = stack.enter_context(membership_contract.membership_case(retained))
                    batch.futures[name] = pool.submit(_run, case, name, stop)
                except (Exception, pytest.skip.Exception) as error:
                    batch.setup_errors[name] = error
            yield batch
        finally:
            stop.set()
            pool.shutdown(wait=True, cancel_futures=True)
            missing = sorted(set(CASES) - batch.checked)
            if missing:
                warnings.warn('Real-expiry acceptance results were not selected/asserted and remain uncovered: '
                    + ', '.join(missing), RuntimeWarning)
            # ExitStack now performs every original finalizer after all worker
            # and gate transactions have retired; no teardown races live work.


@pytest.mark.parametrize('case_name', CASES, ids=CASES)
def test_real_expiry_acceptance_case(real_expiry_batch, case_name, record_property):
    proof = real_expiry_batch.result(case_name)
    assert isinstance(proof, dict) and proof
    record_property('real_expiry_case', case_name)
    record_property('actual_sql_boundary_evidence', json.dumps(proof, default=str, sort_keys=True))
