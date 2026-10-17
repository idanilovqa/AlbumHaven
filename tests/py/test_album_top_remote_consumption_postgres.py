"""C2-B actual-role consumption, durable recovery and bounded capacity contracts.

Only provider facts are synthetic. Every reservation, fact, retained admission,
item, operation, terminal, counter and authority decision uses the real owner.
True SQL-time expiry cases live in remote_consumption_expiry_acceptance.py and
remain separate acceptance requirements until explicitly selected and run.
"""
import asyncio
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from time import monotonic, sleep
from copy import deepcopy
from datetime import timedelta
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb

from music_app.services.owned_album_tops import BROWSE, CREATE, MANAGE, ITEMS
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.listening_goals_postgres import PostgresListeningGoalsService
from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.remote_top_postgres_support import (
    CONTEXT, db, urls, remote, evidence, destination, prepared_payload, runtime, sql_error,
)
from tests.py.remote_top_retention_postgres_support import retained, invoke, CONSUME
from tests.py.test_album_top_remote_membership_postgres import (
    mixed, pending, prepare_mutation, record_owner_sql,
)
from tests.py.test_album_top_collaboration_postgres import member, new_session, write
from tests.py.test_owned_album_tops_postgres import assert_error
from tests.py.test_album_top_remote_acquisition_lock_order import SQLTrace
from tests.py.test_album_top_remote_acquisition_routes import (
    ACQUIRE, application, call, ready, response,
)
from tests.py.test_owned_album_top_route_boundary import mutation_headers


@contextmanager
def intercept_consume(case, transform):
    """Change one supplied structural input, then execute the actual SQL.

    This is a negative-input seam only. It never supplies a SQL result, creates a
    receipt, changes production authority or bypasses a database trigger.
    """
    connect = case.db.service._connect
    observed = []

    class Connection:
        def __init__(self, real):
            self.real = real

        def execute(self, sql, params=None):
            if 'app.consume_top_remote_acquisitions(' in sql:
                args = list(params)
                args[-1] = Jsonb(deepcopy(params[-1].obj))
                observed.append(deepcopy(args[-1].obj))
                transform(self.real, args)
                params = args
            return self.real.execute(sql, params)

        def __getattr__(self, name):
            return getattr(self.real, name)

    @contextmanager
    def connection(*args, **kwargs):
        with connect(*args, **kwargs) as real:
            yield Connection(real)

    case.db.service._connect = connection
    try:
        yield observed
    finally:
        case.db.service._connect = connect


def selected_acquisition(case, command):
    selectors = command.data.get('selections') or [entry['source'] for entry in command.data['item_selections']]
    ref = next(item['acquisition_ref'] for item in selectors if item['kind'] == 'remote_acquisition')
    return case.acquisitions[ref]


def close_and_reclaim(case, preparation_ref):
    result = case.remote.service.close_preparation(case.db.context(), preparation_ref=preparation_ref,
        payload={}, context_ref=CONTEXT)
    assert result['state'] == 'closed'
    # One exact parent has at most 512 children. Each maintenance request is
    # bounded; no direct cleanup, lowered cap or sleep substitutes for progress.
    for _ in range(34):
        state = case.remote.c2_state()
        if not any(str(row['ref']) == preparation_ref for row in state['album_top_remote_preparations']):
            return result
        progress = case.remote.service.maintain_preparations(case.db.context(),
            payload={'mode': 'reclaim'}, context_ref=CONTEXT)
        assert progress['state'] in {'progress', 'complete'}
    pytest.fail('Explicitly closed preparation was not reclaimed within physical parent bound')


@pytest.mark.parametrize('action', ['create', 'add', 'save'])
def test_create_add_save_consume_only_after_real_receipt_and_final_bridge(mixed, action):
    command = prepare_mutation(mixed, action)
    acquired = selected_acquisition(mixed, command)
    observed = []

    def before(connection, args):
        operation = connection.execute('select * from app.album_list_operations where actor_account_id=%s and request_key=%s',
            (mixed.db.owner.account_id, command.request_key)).fetchone()
        assert operation['command_digest'] == command.digest and operation['original_session_id'] == mixed.db.owner.session_id
        assert operation['receipt']['revision'] == str(args[9])
        assert args[7] == (None if action == 'create' else int(command.data['revision']))
        assert args[9] == (1 if action == 'create' else args[7] + 1)
        for source in args[-1].obj:
            assert connection.execute('select 1 from app.album_list_item_remote_sources where top_ref=%s and item_ref=%s and admission_ref=%s',
                (args[8], source['item_ref'], source['admission_ref'])).fetchone()
            assert connection.execute("select state from app.album_top_remote_attempts where ref=%s",
                (source['attempt_ref'],)).fetchone()['state'] == 'pending'
        observed.append(args)

    with intercept_consume(mixed, before):
        result = mixed.execute(command)
    assert len(observed) == 1
    terminal = next(row for row in mixed.remote.c2_state()['album_top_remote_attempts']
        if str(row['acquisition_ref']) == acquired['receipt']['acquisition_ref'])
    assert terminal['state'] == 'consumed' and str(terminal['operation_request_key']) == command.request_key
    assert str(terminal['consumed_top_ref']) == result['top_ref']
    assert terminal['consumed_revision'] == int(result['revision'])


@pytest.mark.parametrize('change', [
    'missing_receipt', 'actor', 'library', 'request_key', 'digest', 'action', 'target_top',
    'original_revision', 'result_revision', 'original_session', 'item', 'catalog', 'admission',
    'evidence_version', 'missing_bridge', 'retired_admission',
])
def test_consumption_rejects_each_forged_receipt_or_result_binding(mixed, change):
    command = prepare_mutation(mixed, 'add')
    other_session = new_session(mixed.db, mixed.db.owner)
    other_actor = member(mixed.db)
    with mixed.db.connect() as connection:
        other_library = mixed.db.library_for(connection, other_actor)
    retired_ref = None
    if change == 'retired_admission':
        _, retired_ref = mixed.historical()
        mixed.retire(retired_ref)
    before = mixed.snapshot()

    def corrupt(connection, args):
        source = args[-1].obj[0]
        if change == 'missing_receipt':
            args[11] = str(uuid4())
        elif change == 'request_key':
            old = connection.execute('select request_key from app.album_list_operations where actor_account_id=%s and request_key<>%s order by request_key limit 1',
                (mixed.db.owner.account_id, command.request_key)).fetchone()
            assert old is not None
            args[11] = str(old['request_key'])
        elif change == 'actor':
            args[1] = other_actor.account_id
        elif change == 'library':
            args[0] = other_library
        elif change == 'original_session':
            args[2] = other_session.session_id
        elif change == 'digest':
            args[12] = 'b' * 64 if command.digest != 'b' * 64 else 'c' * 64
        elif change == 'action':
            args[10] = 'create'
        elif change == 'target_top':
            args[8] = str(uuid4())
        elif change == 'original_revision':
            args[7] += 1
        elif change == 'result_revision':
            args[9] += 1
        elif change in {'item', 'catalog', 'admission'}:
            source[change + '_ref'] = str(uuid4())
        elif change == 'evidence_version':
            source['evidence_version'] = 'e' * 64 if source['evidence_version'] != 'e' * 64 else 'f' * 64
        elif change == 'missing_bridge':
            # Actual item deletion cascades the bridge. The real receipt stays;
            # it alone cannot authorize consuming a no-longer-final source.
            connection.execute('delete from app.album_list_items where ref=%s and top_ref=%s',
                (source['item_ref'], args[8]))
        elif change == 'retired_admission':
            source['admission_ref'] = retired_ref

    with intercept_consume(mixed, corrupt) as observed:
        assert_error(lambda: mixed.execute(command), 'remote_evidence_unavailable', 409)
    assert len(observed) == 1 and mixed.snapshot() == before


@pytest.mark.parametrize('action,denied', [
    ('create', BROWSE), ('create', CREATE), ('create', 'session'),
    ('add', BROWSE), ('add', ITEMS), ('add', 'session'),
    ('save', BROWSE), ('save', MANAGE), ('save', ITEMS), ('save', 'session'),
])
def test_final_denial_after_actual_consume_restores_all_pending_and_working_state(mixed, action, denied):
    command = prepare_mutation(mixed, action)
    before = mixed.snapshot()
    observed = []

    def after(sql, connection):
        if 'app.consume_top_remote_acquisitions(' in sql:
            rows = connection.execute("select state from app.album_top_remote_attempts where operation_request_key=%s",
                (command.request_key,)).fetchall()
            assert rows and all(row['state'] == 'consumed' for row in rows)
            observed.append(rows)
            if denied == 'session':
                mixed.db.service._clock = lambda: mixed.db.now + timedelta(days=2)

    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not (observed and context.action == denied))

    mixed.remote.after_statement = after
    assert_error(lambda: mixed.execute(command, constraints=constraints), 'forbidden', 403)
    assert len(observed) == 1 and mixed.snapshot() == before


@pytest.mark.parametrize('action', ['add', 'save'])
@pytest.mark.parametrize('advance', [False, True])
def test_consumed_acquisition_replay_is_informational_under_current_rights(mixed, action, advance):
    command = prepare_mutation(mixed, action)
    acquired = selected_acquisition(mixed, command)
    result = mixed.execute(command)
    current = mixed.execute(mixed.command('save', result, title='New current revision')) if advance else result
    before = mixed.snapshot()
    calls = len(mixed.remote.calls)
    response = mixed.remote.acquire(acquired['command'])
    assert set(response) == {'version', 'context_ref', 'preparation_ref', 'request_key', 'destination', 'state',
        'acquisition_ref', 'evidence_version', 'consumed_top_ref', 'consumed_revision', 'operation_request_key'}
    assert response['state'] == 'consumed' and response['destination'] == acquired['command']['destination']
    assert response['consumed_top_ref'] == result['top_ref'] and response['consumed_revision'] == result['revision']
    assert response['operation_request_key'] == command.request_key
    assert 'album' not in response and 'item_selections' not in response
    assert mixed.snapshot() == before and len(mixed.remote.calls) == calls
    if advance:
        # A different acquisition is still tied to actual current revision.
        fresh = {**acquired['command'], 'request_key': str(uuid4())}
        assert_error(lambda: mixed.remote.acquire(fresh), 'revision_conflict', 409)
        assert mixed.snapshot() == before and current['revision'] != result['revision']


def test_consumed_create_replay_discovers_result_top_before_authority_locks(mixed):
    acquired = mixed.acquire()
    top, operation = mixed.create(local=False, acquired=acquired)
    body = mixed.acquisitions[acquired['acquisition_ref']]['command']
    before = mixed.snapshot()
    events = []
    mixed.remote.after_statement = lambda sql, connection: events.append(('sql', sql))
    def constraints(context):
        events.append(('policy', context.action))
        return PolicyEvaluationConstraints(request_origin_allowed=True)
    with record_owner_sql(mixed.db) as recorded:
        response = mixed.remote.acquire(body, constraints=constraints)
    statements = [sql for _, sql, _ in recorded]
    discovery = next(i for i, sql in enumerate(statements) if sql.startswith('select a.consumed_top_ref'))
    readers = [i for i, sql in enumerate(statements) if 'app.read_top_remote_consumed_create(' in sql]
    assert len(readers) == 2 and discovery < readers[0] < readers[1]
    assert any('from app.album_lists' in sql for sql in statements[readers[0] + 1:readers[1]])
    assert not any('app.lock_top_remote_pending_actor(' in sql or 'app.reserve_top_remote_attempt(' in sql
        or sql.startswith(('insert ', 'update ', 'delete ')) for sql in statements)
    reader_args = [params for _, sql, params in recorded if 'app.read_top_remote_consumed_create(' in sql]
    assert reader_args[0] == reader_args[1] and reader_args[0][-1] == top['top_ref']
    assert reader_args[0][8] is None
    clocks = [i for i, event in enumerate(events) if event == ('sql', 'select clock_timestamp()::text as checked_at')]
    assert len(clocks) == 1
    second_read = [i for i, event in enumerate(events)
        if event[0] == 'sql' and 'app.read_top_remote_consumed_create(' in event[1]][-1]
    final_policies = [i for i, event in enumerate(events) if event[0] == 'policy' and i > second_read]
    assert final_policies and second_read < min(final_policies) <= max(final_policies) < clocks[0]
    assert not any(event[0] == 'policy' for event in events[clocks[0] + 1:])
    assert next(params for _, sql, params in recorded
        if sql == 'select clock_timestamp()::text as checked_at') is None
    assert response['state'] == 'consumed' and response['operation_request_key'] == operation.request_key
    assert mixed.snapshot() == before


@pytest.mark.parametrize('value', [None, True, 0, '', '2026-10-16T00:00:00',
    '2026-10-16T00:00:00+25:00', 'x' * 65])
def test_final_sql_timestamp_parser_refuses_untyped_unzoned_or_malformed_values(value):
    from music_app.services.album_top_remote_preparations import _timestamp
    assert_error(lambda: _timestamp(value), 'remote_acquisition_unavailable', 503)


@pytest.mark.parametrize('denied', [None, BROWSE, ITEMS, 'cancel', 'session'])
def test_consumed_top_final_clock_follows_current_cancellation_and_items_authority(mixed, denied):
    editor = member(mixed.db)
    top, _ = mixed.db.create(refs=[])
    top, _ = write(mixed.db, 'grant_editor', top, account_id=editor.account_id, role='editor')
    acquired = acquire_form(mixed, top, evidence(mbid=str(uuid4())), actor=editor)
    body = mixed.acquisitions[acquired['acquisition_ref']]['command']
    result = mixed.execute(mixed.command('add', top, selections=[pending(acquired)]), actor=editor)
    before, calls = mixed.snapshot(), len(mixed.remote.calls)
    events, reserved = [], []
    clock_sql = 'select clock_timestamp()::text as checked_at'

    def after(sql, connection):
        events.append(('sql', sql))
        if 'app.reserve_top_remote_attempt(' in sql:
            reserved.append(connection.info.backend_pid)

    def cancelled():
        if reserved:
            events.append(('cancel', denied == 'cancel'))
        return bool(reserved and denied == 'cancel')

    def constraints(context):
        if reserved:
            events.append(('policy', context.action))
            assert context.resource is not None
            if denied == 'session' and context.action == ITEMS:
                mixed.db.service._clock = lambda: mixed.db.now + timedelta(days=2)
        # A named editor's replay needs Browse/Items, never owner's Create.
        return PolicyEvaluationConstraints(request_origin_allowed=context.action != CREATE
            and not (reserved and context.action == denied))

    mixed.remote.after_statement = after
    with record_owner_sql(mixed.db) as recorded:
        action = lambda: mixed.remote.acquire(body, actor=editor,
            constraints=constraints, should_cancel=cancelled)
        if denied is None:
            response = action()
            assert response['state'] == 'consumed' and response['consumed_top_ref'] == result['top_ref']
            assert response['consumed_revision'] == result['revision']
        else:
            assert_error(action, 'provider_cancelled' if denied == 'cancel' else 'forbidden',
                503 if denied == 'cancel' else 403)
    mixed.remote.after_statement = None
    replays = [(sql, params) for _, sql, params in recorded if 'app.reserve_top_remote_attempt(' in sql]
    assert len(replays) == len(reserved) == 1
    assert replays[0][1] == mixed.remote.binding_v2(body, actor=editor)
    replay_index = next(i for i, event in enumerate(events)
        if event[0] == 'sql' and 'app.reserve_top_remote_attempt(' in event[1])
    tail = events[replay_index + 1:]
    assert tail[0] == ('cancel', denied == 'cancel')
    policies = [event[1] for event in tail if event[0] == 'policy']
    assert policies == ([] if denied == 'cancel' else [BROWSE] if denied == BROWSE else [BROWSE, ITEMS])
    clocks = [i for i, event in enumerate(tail) if event == ('sql', clock_sql)]
    if denied in (None, 'session'):
        assert len(clocks) == 1 and clocks[0] == 3
        assert not any(event[0] in ('policy', 'cancel') for event in tail[clocks[0] + 1:])
        assert next(params for _, sql, params in recorded if sql == clock_sql) is None
        assert any('from app.account_sessions' in event[1] for event in tail[clocks[0] + 1:] if event[0] == 'sql')
    else:
        assert clocks == []
    assert mixed.snapshot() == before and len(mixed.remote.calls) == calls


@pytest.mark.parametrize('outcome', ['pending', 'failed'])
def test_existing_top_acquisition_keeps_items_authority_without_create_requirement(mixed, outcome):
    from music_app.services.remote_album_evidence import RemoteAlbumEvidenceError
    editor = member(mixed.db)
    top, _ = mixed.db.create(refs=[])
    top, _ = write(mixed.db, 'grant_editor', top, account_id=editor.account_id, role='editor')
    body = mixed.remote.prepare_v2(destination(top), actor=editor)
    observed = []
    def constraints(context):
        observed.append(context.action)
        return PolicyEvaluationConstraints(request_origin_allowed=context.action != CREATE)
    if outcome == 'failed':
        original = mixed.remote.service.provider
        def unavailable(*args, **kwargs):
            original(*args, **kwargs)
            raise RemoteAlbumEvidenceError('provider_unavailable')
        mixed.remote.service.provider = unavailable
    result = mixed.remote.acquire(body, actor=editor, constraints=constraints)
    assert result['state'] == outcome and result['destination'] == body['destination']
    assert BROWSE in observed and ITEMS in observed and CREATE not in observed
    assert len(mixed.remote.calls) == 1
    state = mixed.remote.c2_state()
    assert len(state['album_top_remote_attempts']) == 1
    assert state['album_top_remote_attempts'][0]['state'] == outcome
    assert len(state['album_top_remote_acquisitions']) == (outcome == 'pending')


@pytest.mark.parametrize('point', ['first_reader', 'native_top', 'second_reader'])
@pytest.mark.parametrize('denied', [BROWSE, CREATE, 'session'])
def test_consumed_create_final_response_denial_has_no_dml(mixed, point, denied):
    acquired = mixed.acquire()
    mixed.create(local=False, acquired=acquired)
    command = mixed.acquisitions[acquired['acquisition_ref']]['command']
    seen, readers = [], 0

    def after(sql, connection):
        nonlocal readers
        if 'app.read_top_remote_consumed_create(' in sql:
            readers += 1
            if point == ('first_reader' if readers == 1 else 'second_reader'):
                seen.append(point)
        elif point == 'native_top' and readers == 1 and 'from app.album_lists' in sql:
            seen.append(point)
        if seen and denied == 'session':
            mixed.db.service._clock = lambda: mixed.db.now + timedelta(days=2)

    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not (seen and context.action == denied))

    before = mixed.snapshot()
    mixed.remote.after_statement = after
    mixed.remote.statements.clear()
    assert_error(lambda: mixed.remote.acquire(command, constraints=constraints), 'forbidden', 403)
    assert seen and mixed.snapshot() == before
    assert not any('app.reserve_top_remote_attempt(' in sql or sql.startswith(('insert ', 'update ', 'delete '))
        for sql in mixed.remote.statements)


@pytest.mark.parametrize('action', ['create', 'add', 'save'])
def test_exact_membership_receipt_recovers_after_revision_change_close_and_cleanup(mixed, action):
    command = prepare_mutation(mixed, action)
    acquired = selected_acquisition(mixed, command)
    landed = mixed.execute(command)
    current = mixed.execute(mixed.command('save', landed, title='Changed after lost response'))
    close_and_reclaim(mixed, acquired['command']['preparation_ref'])
    before = mixed.snapshot()
    mixed.remote.statements.clear()
    calls = len(mixed.remote.calls)
    recovered = mixed.execute(command, actor=new_session(mixed.db, mixed.db.owner))
    assert recovered == landed and mixed.snapshot() == before and len(mixed.remote.calls) == calls
    assert mixed.read(current)['title'] == 'Changed after lost response'
    forbidden = ('from app.album_top_remote_acquisitions', 'app.lock_top_remote_pending_actor(',
        'app.lock_top_remote_membership_sources(', 'app.retain_top_remote_acquisition(',
        'app.consume_top_remote_acquisitions(', 'app.reserve_top_remote_attempt(')
    assert not any(any(part in sql for part in forbidden) for sql in mixed.remote.statements)


def test_unlanded_membership_retry_cannot_refresh_discarded_sources(mixed):
    command = prepare_mutation(mixed, 'create')
    acquired = selected_acquisition(mixed, command)
    original = mixed.snapshot()
    consumed = []
    def after(sql, connection):
        if 'app.consume_top_remote_acquisitions(' in sql:
            consumed.append(True)
    mixed.remote.after_statement = after
    constraints = lambda context: PolicyEvaluationConstraints(
        request_origin_allowed=not (consumed and context.action == CREATE))
    assert_error(lambda: mixed.execute(command, constraints=constraints), 'forbidden', 403)
    assert consumed == [True] and mixed.snapshot() == original
    mixed.remote.after_statement = None
    close_and_reclaim(mixed, acquired['command']['preparation_ref'])
    before = mixed.snapshot()
    assert_error(lambda: mixed.execute(command), 'remote_evidence_unavailable', 409)
    assert mixed.snapshot() == before


@pytest.mark.parametrize('action', ['add', 'save'])
def test_late_local_member_failure_rolls_back_actual_prior_retention(mixed, action):
    top, _ = mixed.db.create(refs=[])
    acquired = mixed.acquire(top)
    absent = str(uuid4())
    data = {'selections': [pending(acquired), {'kind': 'local_catalog', 'album_ref': absent}]} if action == 'add' else {
        'item_selections': [{'kind': 'new_remote', 'source': pending(acquired)},
            {'kind': 'new_local', 'album_ref': absent, 'source': {'kind': 'unselected'}}]}
    before = mixed.snapshot()
    mixed.remote.statements.clear()
    assert_error(lambda: mixed.execute(mixed.command(action, top, **data)), 'album_unavailable', 409)
    assert any('app.retain_top_remote_acquisition(' in sql for sql in mixed.remote.statements)
    assert not any('app.consume_top_remote_acquisitions(' in sql for sql in mixed.remote.statements)
    assert mixed.snapshot() == before


def acquire_form(case, top, facts, *, form_ref=None, actor=None):
    case.remote.facts = facts
    case.external_ids.append(facts.release_group_id)
    case.fact_titles.append(facts.title)
    command = case.remote.prepare_v2(destination(top), actor=actor, form_ref=form_ref, mbid=facts.release_group_id)
    result = case.remote.acquire(command, actor=actor)
    fact = next(row for row in case.remote.rows() if str(row['ref']) == result['acquisition_ref'])
    case.acquisitions[result['acquisition_ref']] = {'command': command, 'receipt': result,
        'fact': fact, 'actor': actor or case.db.owner}
    return result


def spend_remaining_attempts(case, acquired):
    """Exhaust one real generation without modifying counters or time."""
    original = case.acquisitions[acquired['acquisition_ref']]['command']
    with runtime(case.db) as connection:
        connection.commit()
        for _ in range(511):
            body = {**original, 'request_key': str(uuid4())}
            reserved = case.remote.reserve_v2(body, connection=connection)
            assert reserved['state'] == 'reserved' and reserved['dispatch'] is True
            connection.commit()
            failed = invoke(connection, 'app.fail_top_remote_attempt', (*case.remote.binding_v2(body),
                reserved['attempt_ref'], reserved['acquisition_ref'], 'provider_unavailable'))
            assert failed['state'] == 'failed'
            connection.commit()
    parent = next(row for row in case.remote.c2_state()['album_top_remote_preparations']
        if str(row['ref']) == original['preparation_ref'])
    assert parent['attempt_count'] == 512 and parent['pending_count'] == 1 and parent['closed_at'] is None


@pytest.mark.parametrize('same_generation', [False, True])
def test_duplicate_canonical_identity_from_distinct_attempts_rolls_back_every_consumption(mixed, same_generation):
    top, _ = mixed.db.create(refs=[])
    facts = evidence(mbid=str(uuid4()))
    first = acquire_form(mixed, top, facts)
    if not same_generation:
        spend_remaining_attempts(mixed, first)
    second = acquire_form(mixed, top, facts)
    assert first['request_key'] != second['request_key']
    assert (first['preparation_ref'] == second['preparation_ref']) is same_generation
    before = mixed.snapshot()
    command = mixed.command('add', top, selections=[pending(first), pending(second)])
    assert_error(lambda: mixed.execute(command), 'duplicate_album', 409)
    assert mixed.snapshot() == before


@pytest.mark.parametrize('reverse', [False, True])
def test_multi_generation_prelocks_are_complete_sorted_and_independent_of_curator_order(mixed, reverse):
    top, _ = mixed.db.create(refs=[])
    first = acquire_form(mixed, top, evidence(mbid=str(uuid4()), title='First generation'))
    spend_remaining_attempts(mixed, first)
    second = acquire_form(mixed, top, evidence(mbid=str(uuid4()), title='Second generation'))
    assert first['preparation_ref'] != second['preparation_ref']
    parents = mixed.remote.c2_state()['album_top_remote_preparations']
    assert len({str(row['form_ref']) for row in parents}) == 1
    acquisitions = [first, second][::(-1 if reverse else 1)]
    command = mixed.command('add', top, selections=[pending(item) for item in acquisitions])
    with record_owner_sql(mixed.db) as recorded:
        result = mixed.execute(command)
    statements = [sql for _, sql, _ in recorded]
    batch = next(i for i, sql in enumerate(statements) if 'app.lock_top_remote_membership_sources(' in sql)
    mapping = [i for i, sql in enumerate(statements) if 'catalog.release_group_provider_identities' in sql]
    retaining = [i for i, sql in enumerate(statements) if 'app.retain_top_remote_acquisition(' in sql]
    assert len(retaining) == 2 and mapping and batch < min(mapping) < min(retaining)
    descriptors = next(params[-1].obj for _, sql, params in recorded if 'app.lock_top_remote_membership_sources(' in sql)
    assert {item['preparation_ref'] for item in descriptors} == {first['preparation_ref'], second['preparation_ref']}
    mapping_keys = [params[2] for _, sql, params in recorded
        if sql.startswith('select catalog_ref from catalog.release_group_provider_identities') and 'for share' not in sql]
    assert mapping_keys == sorted(mapping_keys)
    retained_catalogs = [str(params[-1]) for _, sql, params in recorded if 'app.retain_top_remote_acquisition(' in sql]
    assert retained_catalogs == sorted(retained_catalogs)
    detail = mixed.read(result)
    expected = [mixed.acquisitions[item['acquisition_ref']]['fact']['title'] for item in acquisitions]
    assert [item['title'] for item in detail['items']] == expected
    # The actual fixed batch function's full internal row-lock order is also
    # tested with independent runtime contention below, not inferred from this
    # outer statement log alone.


def test_reused_admission_consumes_new_attempt_without_rewriting_first_lineage(mixed):
    acquired = mixed.acquire()
    first_body = mixed.acquisitions[acquired['acquisition_ref']]['command']
    top, first_command = mixed.create(local=False, acquired=acquired)
    original = mixed.rows('album_top_remote_admissions')[0]
    first_terminal = next(row for row in mixed.remote.c2_state()['album_top_remote_attempts']
        if str(row['acquisition_ref']) == acquired['acquisition_ref'])
    top = mixed.execute(mixed.command('remove', top, item_refs=[mixed.read(top)['items'][0]['ref']]))
    facts = evidence(mbid=original['external_id'], title=original['title'], artist=original['artist_display'])
    later = mixed.acquire(top, facts=facts)
    top = mixed.execute(mixed.command('add', top, selections=[pending(later)]))
    latest = next(row for row in mixed.remote.c2_state()['album_top_remote_attempts']
        if str(row['acquisition_ref']) == later['acquisition_ref'])
    assert latest['consumed_admission_ref'] == first_terminal['consumed_admission_ref'] == original['ref']
    assert latest['consumed_item_ref'] != first_terminal['consumed_item_ref']
    assert mixed.rows('album_top_remote_admissions') == [original]
    assert mixed.storage.counts(top)['admission_count'] == 1
    close_and_reclaim(mixed, first_body['preparation_ref'])
    assert mixed.rows('album_top_remote_admissions') == [original]
    assert mixed.execute(first_command)['revision'] == '1'
    assert mixed.read(top)['items'][0]['ref'] == str(latest['consumed_item_ref'])


def test_last_consumption_keeps_parent_open_for_already_reserved_work(mixed):
    acquired = mixed.acquire()
    body = mixed.acquisitions[acquired['acquisition_ref']]['command']
    next_facts = evidence(mbid=str(uuid4()), title='Already reserved sibling')
    next_body = {**body, 'request_key': str(uuid4()), 'release_group_id': next_facts.release_group_id}
    reserved = mixed.remote.reserve_v2(next_body)
    assert reserved['state'] == 'reserved' and reserved['dispatch'] is True
    top, _ = mixed.create(local=False, acquired=acquired)
    state = mixed.remote.c2_state()
    parent = next(row for row in state['album_top_remote_preparations'] if str(row['ref']) == body['preparation_ref'])
    assert parent['closed_at'] is None and parent['pending_count'] == parent['reservation_count'] == 1
    assert parent['attempt_count'] == 2
    finished = mixed.remote.finish_v2(next_body, reserved, facts=next_facts)
    assert finished['state'] == 'pending'
    assert mixed.remote.acquire(next_body)['state'] == 'pending'
    assert mixed.read(top)['items'][0]['title'] == mixed.acquisitions[acquired['acquisition_ref']]['fact']['title']
    # A new genuinely empty form remains open too; zero children never imply a
    # close or discard command that might race a subsequent reserve.
    empty, _ = mixed.remote.begin_v2(destination(top))
    assert empty['attempt_count'] == 0 and empty['pending_count'] == 0 and empty['state'] == 'ready'


def test_250_maximum_valid_remote_summaries_create_and_immediate_add(mixed):
    target = destination()
    title, artist = '🌑' * 1000, '🎵' * 1000
    acquisitions = [mixed.acquire(target=target,
        facts=evidence(mbid=str(uuid4()), title=title, artist=artist)) for _ in range(250)]
    assert len({item['preparation_ref'] for item in acquisitions}) == 1
    command = mixed.command('create', title='Remote Top 250', draft_ref=target['draft_ref'],
        selections=[pending(item) for item in acquisitions])
    top = mixed.execute(command)
    detail = mixed.read(top)
    assert len(detail['items']) == 250
    assert all(item['title'] == title and item['artist_display'] == artist
        and item['track_metadata_status'] == 'unavailable' and item['track_count'] is None for item in detail['items'])
    state = mixed.remote.c2_state()
    parent = next(row for row in state['album_top_remote_preparations'] if str(row['ref']) == acquisitions[0]['preparation_ref'])
    assert (parent['attempt_count'], parent['pending_count'], parent['pending_bytes'], parent['reservation_count']) == (250, 0, 0, 0)
    assert parent['closed_at'] is None
    assert len(mixed.rows('album_list_item_remote_sources')) == len(mixed.rows('album_top_remote_admissions')) == 250
    added = mixed.acquire(top)
    top = mixed.execute(mixed.command('add', top, selections=[pending(added)]))
    assert len(mixed.read(top)['items']) == 251 and len(mixed.remote.calls) == 251


def test_successive_consumed_batches_cross_old_pending_history_limits(mixed):
    """Actual reserve/commit/finish/commit; no generated-series pending seed.

    Five destinations each retain 2250 distinct facts (11250 total), below real
    5000-member, 20000-per-Top and 100000-owner retained limits. Every 250-item
    batch closes/reclaims its temporary form after the genuine membership commit.
    """
    completed, top_refs = 0, []
    with runtime(mixed.db) as connection:
        connection.commit()  # acknowledge the runtime fixture's SET LOCAL prefix
        for top_index in range(5):
            top = None
            destination_count = 0
            for batch_index in range(9):
                target = destination(top)
                parent, target = mixed.remote.begin_v2(target)
                selected = []
                for index in range(250):
                    facts = evidence(mbid=str(uuid4()), title=f'Capacity {top_index}/{batch_index}/{index}')
                    mixed.external_ids.append(facts.release_group_id)
                    mixed.fact_titles.append(facts.title)
                    body = prepared_payload(parent, target, mbid=facts.release_group_id)
                    reserved = mixed.remote.reserve_v2(body, connection=connection)
                    assert reserved['state'] == 'reserved' and reserved['dispatch'] is True
                    connection.commit()
                    finished = mixed.remote.finish_v2(body, reserved, facts=facts, connection=connection)
                    assert finished['state'] == 'pending' and finished['evidence_version'] == facts.digest
                    connection.commit()
                    selected.append({'kind': 'remote_acquisition', 'acquisition_ref': finished['acquisition_ref'],
                        'evidence_version': finished['evidence_version']})
                command = mixed.command('create', title=f'Capacity Top {top_index}', draft_ref=target['draft_ref'],
                    selections=selected) if top is None else mixed.command('add', top, selections=selected)
                top = mixed.execute(command)
                destination_count += 250
                completed += 250
                state = mixed.remote.c2_state()
                actual = next(row for row in state['album_top_remote_preparations'] if str(row['ref']) == parent['preparation_ref'])
                assert actual['attempt_count'] == 250 and actual['pending_count'] == actual['pending_bytes'] == 0
                assert actual['closed_at'] is None
                closed = close_and_reclaim(mixed, parent['preparation_ref'])
                assert closed['removed_facts'] == closed['released_bytes'] == 0
                assert not mixed.remote.rows()
                assert not mixed.remote.c2_state()['album_top_remote_attempts']
            assert destination_count == 2250 > 2000
            assert len(mixed.read(top)['items']) == destination_count
            assert mixed.storage.counts(top)['admission_count'] == destination_count
            top_refs.append(top['top_ref'])
    assert completed == 11250 > 10000 and len(set(top_refs)) == 5
    assert mixed.storage.counts()['admission_count'] == completed
    state = mixed.remote.c2_state()
    assert len(state['album_top_remote_pending_budgets']) == 1
    budget = state['album_top_remote_pending_budgets'][0]
    assert budget['pending_count'] == budget['pending_bytes'] == budget['reservation_count'] == 0
    assert not state['album_top_remote_preparations'] and not state['album_top_remote_attempts']
    assert not mixed.remote.calls, 'Structural capacity setup must not introduce provider I/O'


def test_consumption_and_retry_never_double_refund_or_restore_attempt_slots(mixed):
    command = prepare_mutation(mixed, 'create')
    acquired = selected_acquisition(mixed, command)
    captured = []
    with intercept_consume(mixed, lambda connection, args: captured.append(args)):
        landed = mixed.execute(command)
    before = mixed.snapshot()
    assert mixed.execute(command) == landed and mixed.snapshot() == before
    with runtime(mixed.db) as connection:
        assert_runtime_role(connection, mixed.db)
        sql_error(connection, '55000', lambda: invoke(connection, CONSUME, captured[0]),
            constraint='top_remote_expired')
    assert mixed.snapshot() == before
    parent = next(row for row in mixed.remote.c2_state()['album_top_remote_preparations']
        if str(row['ref']) == acquired['command']['preparation_ref'])
    assert parent['attempt_count'] == 1 and parent['pending_count'] == parent['pending_bytes'] == 0
    retained_before = mixed.rows('album_top_remote_admissions'), mixed.rows('album_top_remote_retained_budgets')
    closed = close_and_reclaim(mixed, acquired['command']['preparation_ref'])
    assert closed['released_bytes'] == closed['removed_facts'] == 0
    assert (mixed.rows('album_top_remote_admissions'), mixed.rows('album_top_remote_retained_budgets')) == retained_before


@contextmanager
def trace_owner(case):
    observer = SQLTrace(case.remote)
    previous = case.db.service._connect
    case.db.service._connect = observer.observed
    try:
        yield observer
    finally:
        case.db.service._connect = previous


def wait_for_block(case, trace, label, blocker_pid):
    deadline = monotonic() + 3
    with case.db.connect() as connection:
        while monotonic() < deadline:
            pids = {entry['pid'] for entry in trace.selected(label) if not entry['completed']}
            for pid in pids:
                blockers = connection.execute('select pg_blocking_pids(%s) as blockers', (pid,)).fetchone()['blockers']
                if blocker_pid in blockers:
                    return pid
            sleep(.01)
    pytest.fail(f'{label} did not enter the expected actual PostgreSQL wait')


@pytest.mark.parametrize('stage', ['parent', 'attempt', 'fact'])
@pytest.mark.parametrize('reverse', [False, True])
def test_batch_row_locks_precede_later_families_in_complete_sorted_order(mixed, stage, reverse):
    top, _ = mixed.db.create(refs=[])
    first = acquire_form(mixed, top, evidence(mbid=str(uuid4())))
    second = acquire_form(mixed, top, evidence(mbid=str(uuid4())), form_ref=str(uuid4()))
    acquired = [first, second][::(-1 if reverse else 1)]
    facts = [mixed.acquisitions[item['acquisition_ref']]['fact'] for item in acquired]
    ordered_parents = sorted(str(fact['preparation_ref']) for fact in facts)
    ordered_attempts = [str(fact['attempt_ref']) for fact in sorted(facts,
        key=lambda fact: (str(fact['preparation_ref']), str(fact['request_key'])))]
    ordered_facts = sorted(str(fact['ref']) for fact in facts)
    tables = {'parent': ('album_top_remote_preparations', ordered_parents),
        'attempt': ('album_top_remote_attempts', ordered_attempts),
        'fact': ('album_top_remote_acquisitions', ordered_facts)}
    table, identities = tables[stage]
    command = mixed.command('add', top, selections=[pending(item) for item in acquired])
    with trace_owner(mixed) as trace, ThreadPoolExecutor(max_workers=1) as pool:
        with mixed.db.connect() as blocker:
            blocker.execute('select ref from app.' + table + ' where ref=%s for update', (identities[-1],)).fetchone()
            future = pool.submit(trace.call, 'member', lambda: mixed.execute(command))
            try:
                wait_for_block(mixed, trace, 'member', blocker.info.backend_pid)
                with mixed.db.connect() as probe:
                    sql_error(probe, '55P03', lambda: probe.execute('select ref from app.' + table
                        + ' where ref=%s for update nowait', (identities[0],)).fetchone())
                    for earlier in ['parent', 'attempt', 'fact'][:['parent', 'attempt', 'fact'].index(stage)]:
                        earlier_table, earlier_ids = tables[earlier]
                        for ref in earlier_ids:
                            sql_error(probe, '55P03', lambda ref=ref, earlier_table=earlier_table:
                                probe.execute('select ref from app.' + earlier_table
                                    + ' where ref=%s for update nowait', (ref,)).fetchone())
                    for later in ['parent', 'attempt', 'fact'][['parent', 'attempt', 'fact'].index(stage) + 1:]:
                        later_table, later_ids = tables[later]
                        rows = probe.execute('select ref from app.' + later_table
                            + ' where ref=any(%s::uuid[]) for update nowait', (later_ids,)).fetchall()
                        assert len(rows) == 2
            finally:
                blocker.rollback()
        result = future.result(timeout=10)
    assert len(mixed.read(result)['items']) == 2


def test_cross_actor_reversed_identity_batches_and_single_goal_mapping_do_not_cycle(mixed):
    other = member(mixed.db)
    first_top, _ = mixed.db.create(refs=[])
    second_top = mixed.db.service.execute(mixed.db.context(other), mixed.db.create_command(refs=[]))
    facts = [evidence(mbid=ref, title='Shared identity ' + ref) for ref in sorted([str(uuid4()), str(uuid4())])]
    first = [acquire_form(mixed, first_top, fact) for fact in facts]
    second = [acquire_form(mixed, second_top, fact, actor=other) for fact in reversed(facts)]
    commands = [mixed.command('add', first_top, selections=[pending(item) for item in first]),
        mixed.command('add', second_top, selections=[pending(item) for item in second])]
    goals_before = {key: value for key, value in mixed.remote.unrelated().items() if key.startswith('listening_goal')}
    # The existing Goals single-identity adapter invokes the exact shared mapper
    # and holds its real unique identity transaction while both Top owners race.
    row = mixed.acquisitions[first[0]['acquisition_ref']]['fact']
    with trace_owner(mixed) as trace, ThreadPoolExecutor(max_workers=2) as pool:
        with runtime(mixed.db) as goal_connection:
            assert_runtime_role(goal_connection, mixed.db)
            mapped = PostgresListeningGoalsService._catalog(goal_connection, row)
            futures = [pool.submit(trace.call, 'first', lambda: mixed.db.service.execute(mixed.db.context(), commands[0], context_ref=CONTEXT)),
                pool.submit(trace.call, 'second', lambda: mixed.db.service.execute(mixed.db.context(other), commands[1], context_ref=CONTEXT))]
            try:
                first_pid = wait_for_block(mixed, trace, 'first', goal_connection.info.backend_pid)
                second_pid = wait_for_block(mixed, trace, 'second', goal_connection.info.backend_pid)
                assert first_pid != second_pid
            finally:
                goal_connection.commit()
        results = [future.result(timeout=10) for future in futures]
    assert [item['title'] for item in mixed.read(results[0])['items']] == [fact.title for fact in facts]
    assert [item['title'] for item in mixed.read(results[1], actor=other)['items']] == [fact.title for fact in reversed(facts)]
    with runtime(mixed.db) as connection:
        identities = connection.execute('select external_id,catalog_ref from catalog.release_group_provider_identities where external_id=any(%s) order by external_id',
            ([fact.release_group_id for fact in facts],)).fetchall()
    assert len(identities) == 2 and str(identities[0]['catalog_ref']) == mapped
    final = mixed.remote.c2_state()
    assert final['album_top_remote_acquisitions'] == []
    assert len(final['album_top_remote_attempts']) == 4
    assert all(row['state'] == 'consumed' for row in final['album_top_remote_attempts'])
    assert all(row['pending_count'] == row['pending_bytes'] == row['reservation_count'] == 0
        for row in final['album_top_remote_pending_budgets'])
    assert all(row['attempt_count'] == 2 and row['pending_count'] == 0 and row['closed_at'] is None
        for row in final['album_top_remote_preparations'])
    with runtime(mixed.db) as connection:
        for actor, command, result in zip((mixed.db.owner, other), commands, results):
            operation = connection.execute('select * from app.album_list_operations where actor_account_id=%s and request_key=%s',
                (actor.account_id, command.request_key)).fetchone()
            assert operation['receipt'] == result and operation['command_digest'] == command.digest
            assert operation['original_session_id'] == actor.session_id
            terminals = [row for row in final['album_top_remote_attempts'] if row['actor_account_id'] == actor.account_id]
            assert len(terminals) == 2
            for terminal in terminals:
                bridge = connection.execute('select * from app.album_list_item_remote_sources where top_ref=%s and item_ref=%s',
                    (result['top_ref'], terminal['consumed_item_ref'])).fetchone()
                assert bridge['admission_ref'] == terminal['consumed_admission_ref']
                assert bridge['catalog_ref'] == terminal['consumed_catalog_ref']
                assert str(terminal['operation_request_key']) == command.request_key
                assert terminal['consumed_revision'] == int(result['revision']) == 2
    goals_after = {key: value for key, value in mixed.remote.unrelated().items() if key.startswith('listening_goal')}
    assert goals_after == goals_before
    for label in ('first', 'second'):
        entries = trace.selected(label)
        keys = [entry['params'][2] for entry in entries if entry['sql'].startswith(
            'select catalog_ref from catalog.release_group_provider_identities') and 'for share' not in entry['sql']]
        # A losing mapper repeats its exact first SELECT after unique conflict.
        assert keys == sorted(keys)


@pytest.mark.parametrize('operation', ['reserve', 'finish', 'consume'])
@pytest.mark.parametrize('winner', ['close', 'operation'])
def test_close_reserve_finish_and_consume_use_one_consistent_lock_prefix(mixed, operation, winner):
    acquired = mixed.acquire()
    body = mixed.acquisitions[acquired['acquisition_ref']]['command']
    command = mixed.command('create', title='Close race', draft_ref=body['destination']['draft_ref'],
        selections=[pending(acquired)])
    if operation == 'reserve':
        body = {**body, 'request_key': str(uuid4()), 'release_group_id': str(uuid4())}
    reservation = None
    # finish needs its own committed reservation rather than replay of the
    # already-pending first body.
    if operation == 'finish':
        body = {**body, 'request_key': str(uuid4()), 'release_group_id': str(uuid4())}
        reservation = mixed.remote.reserve_v2(body)
        assert reservation['state'] == 'reserved'
    held, release = Event(), Event()
    blocker_pid = []

    def close():
        return mixed.remote.service.close_preparation(mixed.db.context(), preparation_ref=body['preparation_ref'],
            payload={}, context_ref=CONTEXT)

    def act():
        if operation == 'consume':
            # Concurrent close may reclaim terminal detail immediately after
            # commit; assert final durable state below rather than using the
            # sequential fixture's immediate terminal-presence assertion.
            return mixed.db.service.execute(mixed.db.context(), command, context_ref=CONTEXT)
        function = 'app.reserve_top_remote_attempt' if operation == 'reserve' else 'app.finish_top_remote_attempt'
        args = mixed.remote.binding_v2(body)
        if operation == 'finish':
            facts = evidence(mbid=body['release_group_id'])
            args = (*args, reservation['attempt_ref'], reservation['acquisition_ref'], facts.digest,
                facts.title, facts.artist_display, facts.first_release_date, facts.primary_type)
        # Use the same observed runtime connector so both contenders retain
        # actual role, SQL, transaction, lock timeout and waiter evidence.
        with mixed.db.service._connect(mixed.db.service._url) as connection:
            assert_runtime_role(connection, mixed.db)
            return invoke(connection, function, args)

    with trace_owner(mixed) as trace, ThreadPoolExecutor(max_workers=2) as pool:
        def after(entry, connection):
            target = 'app.close_top_remote_preparation(' if winner == 'close' else (
                'app.consume_top_remote_acquisitions(' if operation == 'consume' else
                'app.' + ('reserve_top_remote_attempt(' if operation == 'reserve' else 'finish_top_remote_attempt('))
            if entry['label'] == 'winner' and target in entry['sql']:
                blocker_pid.append(entry['pid'])
                held.set()
                assert release.wait(5), 'Contender never reached its real authority lock'
        trace.after = after
        first = pool.submit(trace.call, 'winner', close if winner == 'close' else act)
        try:
            assert held.wait(5)
            second = pool.submit(trace.call, 'waiter', act if winner == 'close' else close)
            wait_for_block(mixed, trace, 'waiter', blocker_pid[0])
        finally:
            release.set()
        first_result = first.result(timeout=10)
        if winner == 'close':
            if operation == 'consume':
                assert_error(lambda: second.result(timeout=10), 'remote_evidence_unavailable', 409)
            else:
                import psycopg
                with pytest.raises(psycopg.Error) as caught:
                    second.result(timeout=10)
                assert caught.value.sqlstate == '55000'
                assert caught.value.diag.constraint_name == 'top_remote_preparation_unavailable'
            assert first_result['state'] == 'closed'
        else:
            closed = second.result(timeout=10)
            assert closed['state'] == 'closed'
    state = mixed.remote.c2_state()
    assert not state['album_top_remote_acquisitions']
    budget = state['album_top_remote_pending_budgets'][0]
    assert budget['pending_count'] == budget['pending_bytes'] == budget['reservation_count'] == 0
    if winner == 'operation' and operation == 'consume':
        assert len(mixed.rows('album_top_remote_admissions')) == 1
        assert mixed.execute(command) == first_result
    else:
        assert not mixed.rows('album_top_remote_admissions')


@pytest.mark.parametrize('change', ['actor', 'session', 'context', 'library', 'deleted_top', 'editor_departure', 'changed_body'])
def test_consumed_replay_retains_scope_and_current_destination_denials(mixed, change):
    editor = member(mixed.db)
    top, _ = mixed.db.create(refs=[])
    top, _ = write(mixed.db, 'grant_editor', top, account_id=editor.account_id, role='editor')
    grant_ref = top['grant_ref']
    acquired = acquire_form(mixed, top, evidence(mbid=str(uuid4())), actor=editor)
    body = mixed.acquisitions[acquired['acquisition_ref']]['command']
    top = mixed.execute(mixed.command('add', top, selections=[pending(acquired)]), actor=editor)
    options = {'actor': editor}
    changed = dict(body)
    expected = ('remote_evidence_unavailable', 409)
    if change == 'actor':
        options['actor'] = mixed.db.owner
        expected = ('remote_preparation_unavailable', 409)
    elif change == 'session':
        options['actor'] = new_session(mixed.db, editor)
    elif change == 'context':
        options['context_ref'] = 'c' * 64
    elif change == 'library':
        with mixed.db.connect() as connection:
            library = mixed.db.library_for(connection, editor)
            options['actor'] = mixed.db.member(connection, editor, library)
        expected = ('top_unavailable', 404)
    elif change == 'deleted_top':
        top = mixed.execute(mixed.command('delete', top))
        expected = ('top_unavailable', 404)
    elif change == 'editor_departure':
        with mixed.db.connect() as connection:
            connection.execute('delete from app.album_list_access_grants where ref=%s', (grant_ref,))
        expected = ('top_unavailable', 404)
    else:
        changed['release_group_id'] = str(uuid4())
        expected = ('request_key_conflict', 409)
    before = mixed.snapshot()
    calls = len(mixed.remote.calls)
    assert_error(lambda: mixed.remote.acquire(changed, **options), *expected)
    assert mixed.snapshot() == before and len(mixed.remote.calls) == calls


def test_consumed_create_structural_reader_refuses_forged_destination_owner(mixed):
    acquired = mixed.acquire()
    top, _ = mixed.create(local=False, acquired=acquired)
    body = mixed.acquisitions[acquired['acquisition_ref']]['command']
    forged_owner = member(mixed.db)
    args = list(mixed.remote.binding_v2(body)) + [top['top_ref']]
    args[7] = forged_owner.account_id
    before = mixed.snapshot()
    with runtime(mixed.db) as connection:
        assert_runtime_role(connection, mixed.db)
        sql_error(connection, '55000', lambda: invoke(connection, 'app.read_top_remote_consumed_create', args),
            constraint='top_remote_scope')
    assert mixed.snapshot() == before


@pytest.mark.parametrize('race', ['consumed_after_missing_hint', 'closed_after_present_hint'])
def test_consumed_create_discovery_never_adopts_a_late_or_replaced_lock_target(mixed, race):
    acquired = mixed.acquire()
    body = mixed.acquisitions[acquired['acquisition_ref']]['command']
    command = mixed.command('create', title='Discovery race', draft_ref=body['destination']['draft_ref'],
        selections=[pending(acquired)])
    landed = mixed.execute(command) if race == 'closed_after_present_hint' else None
    changed = []
    expected = []
    with trace_owner(mixed) as trace:
        def after(entry, connection):
            if entry['label'] == 'replay' and entry['sql'].startswith('select a.consumed_top_ref') and not changed:
                changed.append(True)
                if race == 'consumed_after_missing_hint':
                    trace.call('landing', lambda: mixed.execute(command))
                else:
                    trace.call('closing', lambda: close_and_reclaim(mixed, body['preparation_ref']))
                expected.append(mixed.snapshot())
        trace.after = after
        assert_error(lambda: trace.call('replay', lambda: mixed.remote.acquire(body)), 'remote_preparation_unavailable', 409)
    assert changed == [True] and mixed.snapshot() == expected[0]
    entries = trace.selected('replay')
    assert sum(entry['sql'].startswith('select a.consumed_top_ref') for entry in entries) == 1
    if race == 'consumed_after_missing_hint':
        assert not any('app.read_top_remote_consumed_create(' in entry['sql'] for entry in entries)
        assert mixed.remote.acquire(body)['state'] == 'consumed'
    else:
        readers = [entry for entry in entries if 'app.read_top_remote_consumed_create(' in entry['sql']]
        assert len(readers) == 1 and readers[0]['params'][-1] == landed['top_ref']
    assert len(mixed.remote.calls) == 1


def test_preseen_membership_receipt_disappearance_refuses_without_new_source_or_mutation(mixed):
    command = prepare_mutation(mixed, 'create')
    acquired = selected_acquisition(mixed, command)
    mixed.execute(command)
    close_and_reclaim(mixed, acquired['command']['preparation_ref'])
    changed, expected = [], []
    with trace_owner(mixed) as trace:
        def after(entry, connection):
            if entry['label'] == 'replay' and entry['sql'].startswith('select request_key from app.album_list_operations') and not changed:
                with mixed.db.connect() as trusted:
                    trusted.execute('delete from app.album_list_operations where actor_account_id=%s and request_key=%s',
                        (mixed.db.owner.account_id, command.request_key))
                changed.append(True)
                expected.append(mixed.snapshot())
        trace.after = after
        assert_error(lambda: trace.call('replay', lambda: mixed.execute(command)), 'concurrent_change', 409)
    assert changed == [True] and mixed.snapshot() == expected[0]
    assert not any('from app.album_top_remote_acquisitions' in entry['sql'] or entry['sql'].startswith('insert ')
        for entry in trace.selected('replay'))


def test_cleanup_races_v2_retention_without_touching_history(mixed):
    top, _ = mixed.db.create(refs=[])
    acquired = mixed.acquire(top)
    body = mixed.acquisitions[acquired['acquisition_ref']]['command']
    catalog = mixed.storage.mapping(acquired)
    held, release = Event(), Event()
    pid = []

    def retain():
        with mixed.db.service._connect(mixed.db.service._url) as connection:
            assert_runtime_role(connection, mixed.db)
            mixed.storage.locks(connection, top, pending=acquired)
            ref = invoke(connection, 'app.retain_top_remote_acquisition', mixed.storage.retain_args(top, acquired, catalog))
            pid.append(connection.info.backend_pid)
            held.set()
            assert release.wait(5)
            return str(ref)

    with trace_owner(mixed) as trace, ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(trace.call, 'retention', retain)
        try:
            assert held.wait(5)
            second = pool.submit(trace.call, 'cleanup', lambda: mixed.remote.service.close_preparation(
                mixed.db.context(), preparation_ref=body['preparation_ref'], payload={}, context_ref=CONTEXT))
            wait_for_block(mixed, trace, 'cleanup', pid[0])
        finally:
            release.set()
        admission = first.result(timeout=10)
        result = second.result(timeout=10)
    assert result['state'] == 'closed' and result['removed_facts'] == 1
    retained_row = mixed.storage.row(admission)
    assert str(retained_row['original_acquisition_ref']) == acquired['acquisition_ref']
    assert retained_row['evidence_version'] == acquired['evidence_version'] and retained_row['retired_at'] is None
    assert mixed.storage.counts(top)['admission_count'] == 1
    assert not mixed.remote.rows() and not mixed.rows('album_list_item_remote_sources')
    assert mixed.remote.c2_state()['album_top_remote_pending_budgets'][0]['pending_count'] == 0


def test_consumed_response_uses_private_http_envelope_without_generic_activation(mixed):
    facts = evidence(mbid=str(uuid4()))
    mixed.external_ids.append(facts.release_group_id)
    mixed.fact_titles.append(facts.title)
    mixed.remote.facts = facts
    app = application(mixed.remote)
    headers = mutation_headers(app, mixed.db.owner)
    context_ref = headers['x-albumhaven-context']
    body = mixed.remote.prepare_v2(context_ref=context_ref, mbid=facts.release_group_id)
    acquired = ready(call(app, ACQUIRE, headers=headers, payload=body))
    command = mixed.command('create', title='Actual private consumed response',
        draft_ref=body['destination']['draft_ref'], selections=[pending(acquired)])
    top = mixed.db.service.execute(mixed.db.context(), command, context_ref=context_ref)
    before = mixed.snapshot()
    acknowledged = ready(call(app, ACQUIRE, headers=headers, payload=body))
    assert acknowledged['state'] == 'consumed' and acknowledged['consumed_top_ref'] == top['top_ref']
    assert acknowledged['operation_request_key'] == command.request_key
    assert not {'album', 'facts', 'items', 'edit_draft', 'item_selections'} & acknowledged.keys()
    assert mixed.snapshot() == before and len(mixed.remote.calls) == 1
    stale = {**headers, 'x-albumhaven-context': '0' * 64}
    status, _, response_headers = call(app, ACQUIRE, headers=stale, payload=body)
    assert status == 409 and response_headers[b'cache-control'] == b'private, no-store'
    # Exact normal route remains gated even though the private preparation API
    # can acknowledge this stored result under current server context.
    status, denied, response_headers = asyncio.run(response(app, 'POST', '/album-tops',
        headers=headers, payload={**command.data, 'request_key': command.request_key}))
    assert status == 409 and denied['error'] == 'remote_membership_unavailable'
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert mixed.snapshot() == before and len(mixed.remote.calls) == 1
