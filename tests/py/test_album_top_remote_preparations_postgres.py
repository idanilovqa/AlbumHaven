"""Actual C2-A acquisition service, current authority and PostgreSQL transitions.

Only provider facts and the monotonic clock are explicit external seams. Every
reservation, replay, lock, rollback and SQL response uses the real current owner
and isolated runtime role. No historical-v1 seeding or membership activation.
"""
from contextlib import contextmanager
import json
from datetime import timedelta
from uuid import uuid4

import pytest

from music_app.services.album_top_remote_acquisition import load_pending_remote_source
from music_app.services.album_top_remote_sources import normalize_remote_destination
from music_app.services.owned_album_tops import AlbumTopError, BROWSE, CREATE, ITEMS
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.remote_album_evidence import RemoteAlbumEvidenceError
from tests.py.test_album_top_remote_membership_postgres import mixed
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.remote_top_postgres_support import remote
from tests.py.remote_preparation_postgres_support import preparations, db, urls
from tests.py.remote_top_postgres_support import CONTEXT, destination, evidence, payload
from tests.py.test_album_top_remote_acquisition_lock_order import SQLTrace, _named_top, _account_lock
from tests.py.test_album_top_collaboration_postgres import member, write
from tests.py.test_owned_album_tops_postgres import assert_error


def begin(case, target, *, actor=None, form_ref=None, **options):
    return case.service.begin_preparation(case.db.context(actor), payload={
        'destination': target, 'form_ref': form_ref or target.get('draft_ref') or str(uuid4())},
        context_ref=options.pop('context_ref', CONTEXT), **options)


def own(case, operation, *, actor=None, parent=None, **options):
    method = {'status': case.service.preparation_status, 'close': case.service.close_preparation,
              'maintain': case.service.maintain_preparations}[operation]
    if operation == 'close':
        options.update(preparation_ref=parent['preparation_ref'], payload={})
    elif operation == 'maintain':
        options['payload'] = {'mode': options.pop('mode', 'reclaim')}
    return method(case.db.context(actor), context_ref=options.pop('context_ref', CONTEXT), **options)


def states(case):
    rows = case.state()
    return rows['album_top_remote_attempts'], rows['album_top_remote_preparations'], rows['album_top_remote_pending_budgets']


def test_real_begin_initialization_status_and_close_are_bounded_private_projections(preparations):
    case = preparations
    target = destination()
    before = case.unrelated()
    status = own(case, 'status')
    assert status['state'] == 'status' and status['parents'] == []
    assert status['capacity']['counts_complete'] is False
    assert case.state()['album_top_remote_pending_budgets'] == []
    required = begin(case, target)
    assert required['state'] == 'maintenance_required' and required['resource'] == 'legacy_initialization'
    assert required['error'] == 'remote_preparation_maintenance_required'
    assert case.calls == [] and states(case)[1] == []
    initialized = own(case, 'maintain')
    assert initialized['branch'] == 'legacy_initialization'
    assert initialized['capacity']['counts_complete'] is True
    parent = begin(case, target)
    assert parent == begin(case, target)
    assert parent['state'] == 'ready' and parent['destination'] == target
    assert parent['form_ref'] == target['draft_ref']
    assert parent['capacity']['worst_case_new_acquisitions'] == 512
    status = own(case, 'status')
    assert len(status['parents']) == 1 and status['parents'][0]['state'] == 'accepting'
    assert not {'destination', 'destination_ref', 'owner_account_id', 'library_id', 'title', 'facts'} & status['parents'][0].keys()
    assert 'destination' not in status and status['context_ref'] == CONTEXT
    closed = own(case, 'close', parent=parent)
    assert closed['state'] == 'closed' and closed['removed_attempts'] == closed['removed_facts'] == 0
    assert closed['capacity']['physical_parents'] == 0
    assert_error(lambda: own(case, 'close', parent=parent), 'remote_preparation_unavailable', 409)
    assert case.unrelated() == before and case.calls == []


def test_actual_v2_acquisition_commits_before_provider_and_replays_first_facts(preparations):
    case = preparations
    parent, target = case.begin()
    command = case.command(parent, target)
    before = case.unrelated()
    first = case.acquire(command)
    assert first['version'] == 2 and first['state'] == 'pending'
    assert first['preparation_ref'] == parent['preparation_ref'] and first['destination'] == target
    assert first['album']['metadata_coverage'] == 'album_summary_only'
    assert first['album']['track_metadata_status'] == 'unavailable' and first['album']['track_count'] is None
    assert not {'tracks', 'edition', 'artwork', 'catalog_ref', 'media_ref'} & first['album'].keys()
    attempts, parents, budgets = states(case)
    assert len(attempts) == len(parents) == len(budgets) == 1
    assert attempts[0]['state'] == 'pending' and parents[0]['attempt_count'] == parents[0]['pending_count'] == 1
    assert parents[0]['reservation_count'] == budgets[0]['reservation_count'] == 0
    assert parents[0]['pending_bytes'] == budgets[0]['pending_bytes'] == case.rows()[0]['facts_bytes']
    case.facts = evidence(title='Later provider correction')
    snapshot = case.state()
    assert case.acquire(command) == first and case.state() == snapshot
    assert len(case.calls) == 1 and case.unrelated() == before
    assert all('listening_goal' not in sql and 'provider_identities' not in sql for sql in case.statements)


def test_exact_retry_during_first_provider_is_in_flight_without_dispatch(preparations):
    case = preparations
    parent, target = case.begin()
    command = case.command(parent, target)
    retry = []
    case.provider_hook = lambda: retry.append(case.acquire(command))
    result = case.acquire(command)
    assert result['state'] == 'pending' and len(case.calls) == 1
    assert len(retry) == 1 and retry[0]['state'] == 'in_flight' and retry[0]['retry_after_seconds'] == 1
    assert not {'acquisition_ref', 'evidence_version', 'album', 'dispatch', 'attempt_ref'} & retry[0].keys()
    assert states(case)[1][0]['attempt_count'] == 1


@pytest.mark.parametrize('kind', ['create', 'top'])
def test_fresh_v1_refuses_before_provider_and_never_initializes_preparation_budget(preparations, kind):
    case = preparations
    top = case.db.create(refs=[])[0] if kind == 'top' else None
    before = case.state()
    assert_error(lambda: case.acquire(payload(destination(top))), 'remote_acquisition_version_required', 409)
    assert case.calls == [] and case.state() == before


@pytest.mark.parametrize('phase', ['begin', 'acquire', 'replay'])
@pytest.mark.parametrize('action', [BROWSE, CREATE, ITEMS])
def test_current_actions_precede_preparation_acquisition_and_replay(preparations, phase, action):
    case = preparations
    top = case.db.create(refs=[])[0] if action == ITEMS else None
    target = destination(top)
    parent, _ = case.begin(target)
    command = case.command(parent, target)
    if phase == 'replay':
        case.acquire(command)
    before, calls = case.state(), len(case.calls)
    observed = []
    def constraints(context):
        observed.append(context.action)
        return PolicyEvaluationConstraints(request_origin_allowed=context.action != action)
    callback = lambda: begin(case, target, form_ref=parent['form_ref'], constraints=constraints)
    if phase != 'begin':
        callback = lambda: case.acquire(command, constraints=constraints)
    assert_error(callback, 'forbidden', 403)
    assert action in observed and case.state() == before and len(case.calls) == calls


@pytest.mark.parametrize('phase', ['begin', 'acquire'])
@pytest.mark.parametrize('role', ['owner', 'editor', 'viewer', 'server_reader', 'private_stranger'])
def test_preparations_use_actual_named_items_authority(preparations, phase, role):
    case = preparations
    other = member(case.db)
    top, _ = case.db.create(refs=[])
    actor, expected = case.db.owner, None
    if role in {'editor', 'viewer'}:
        top, _ = write(case.db, 'grant_' + role, top, account_id=other.account_id, role=role)
        actor = other
        expected = None if role == 'editor' else ('forbidden', 403)
    elif role == 'server_reader':
        top, _ = write(case.db, 'visibility', top, visibility='server_shared')
        actor, expected = other, ('forbidden', 403)
    elif role == 'private_stranger':
        actor, expected = other, ('top_unavailable', 404)
    target = destination(top)
    # Structural setup does not grant policy. The actual begin/acquire below
    # must enforce the same current owner/editor authority on these facts.
    parent, _ = case.begin(target, actor=actor)
    command = case.command(parent, target)
    before = case.state()
    callback = lambda: begin(case, target, actor=actor, form_ref=parent['form_ref'])
    if phase == 'acquire':
        callback = lambda: case.acquire(command, actor=actor)
    if expected:
        assert_error(callback, *expected)
        assert case.state() == before and case.calls == []
    else:
        result = callback()
        assert result['state'] == ('ready' if phase == 'begin' else 'pending')
        if phase == 'acquire':
            assert case.rows()[0]['actor_account_id'] == actor.account_id
            assert case.rows()[0]['destination_owner_account_id'] == case.db.owner.account_id


@pytest.mark.parametrize('changed', ['account', 'session', 'membership', 'browse', 'editor', 'revision', 'deleted'])
def test_provider_gap_preserves_reservation_but_cannot_store_after_authority_change(preparations, changed):
    case = preparations
    editor = member(case.db)
    top, _ = case.db.create(refs=[])
    top, _ = write(case.db, 'grant_editor', top, account_id=editor.account_id, role='editor')
    grant_ref = top['grant_ref']
    parent, target = case.begin(destination(top), actor=editor)
    command = case.command(parent, target)
    def change():
        with case.db.connect() as connection:
            if changed == 'account':
                connection.execute('update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s', (editor.account_id,))
            elif changed == 'session':
                connection.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s', (editor.session_id,))
            elif changed == 'membership':
                connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s', (editor.account_id, case.db.library))
            elif changed == 'browse':
                connection.execute('update app.capabilities set revoked_at=clock_timestamp() where account_id=%s', (editor.account_id,))
            elif changed == 'editor':
                connection.execute('delete from app.album_list_access_grants where ref=%s', (grant_ref,))
        if changed == 'revision':
            write(case.db, 'save', top, title='Changed during provider read')
        elif changed == 'deleted':
            write(case.db, 'delete', top)
    case.provider_hook = change
    expected = ('top_unavailable', 404) if changed in {'editor', 'deleted'} else (
        ('revision_conflict', 409) if changed == 'revision' else ('forbidden', 403))
    assert_error(lambda: case.acquire(command, actor=editor), *expected)
    assert len(case.calls) == 1 and case.rows() == []
    attempts, parents, budgets = states(case)
    assert attempts[0]['state'] == 'reserved' and parents[0]['attempt_count'] == 1
    assert parents[0]['reservation_count'] == budgets[0]['reservation_count'] == 1


@pytest.mark.parametrize('boundary', ['session_expiry', 'policy', 'cancel'])
@pytest.mark.parametrize('transition', ['reserve', 'finish'])
def test_final_current_fences_rollback_exact_transition_not_prior_commit(preparations, boundary, transition):
    case = preparations
    parent, target = case.begin()
    command = case.command(parent, target)
    observed_now = [case.db.now]
    case.db.service._clock = lambda: observed_now[0]
    observed = []
    def after(sql, connection):
        if sql.startswith('select app.' + transition + '_top_remote_attempt('):
            observed.append(connection.execute('select state from app.album_top_remote_attempts where preparation_ref=%s',
                (parent['preparation_ref'],)).fetchone()['state'])
            if boundary == 'session_expiry':
                observed_now[0] += timedelta(days=2)
    case.after_statement = after
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=not (observed and boundary == 'policy'))
    cancelled = lambda: bool(observed and boundary == 'cancel')
    assert_error(lambda: case.acquire(command, constraints=constraints, should_cancel=cancelled),
        'provider_cancelled' if boundary == 'cancel' else 'forbidden', 503 if boundary == 'cancel' else 403)
    assert observed == ['reserved' if transition == 'reserve' else 'pending']
    assert case.rows() == []
    attempts, parents, budgets = states(case)
    if transition == 'reserve':
        assert attempts == [] and parents[0]['attempt_count'] == budgets[0]['pending_count'] == 0
        assert case.calls == []
    else:
        assert attempts[0]['state'] == 'reserved' and parents[0]['attempt_count'] == 1
        assert budgets[0]['reservation_count'] == 1 and len(case.calls) == 1


@pytest.mark.parametrize('failure', ['provider_unavailable', 'invalid_provider_metadata', 'provider_identity_changed', 'invalid_provider_user_agent'])
def test_known_failure_records_once_refunds_pending_and_never_reruns(preparations, failure):
    case = preparations
    parent, target = case.begin()
    command = case.command(parent, target)
    def fail():
        raise RemoteAlbumEvidenceError(failure)
    case.provider_hook = fail
    first = case.acquire(command)
    assert first['state'] == 'failed' and first['error'] == (
        'provider_unavailable' if failure == 'invalid_provider_user_agent' else failure)
    before = case.state()
    assert case.acquire(command) == first and case.state() == before and len(case.calls) == 1
    attempts, parents, budgets = states(case)
    assert attempts[0]['state'] == 'failed' and parents[0]['attempt_count'] == 1
    assert parents[0]['pending_count'] == parents[0]['pending_bytes'] == parents[0]['reservation_count'] == 0
    assert budgets[0]['pending_count'] == budgets[0]['pending_bytes'] == budgets[0]['reservation_count'] == 0


@pytest.mark.parametrize('failure', ['cancelled', 'unexpected', 'base_exception'])
def test_unknown_or_cancelled_provider_outcome_keeps_original_reservation(preparations, failure):
    case = preparations
    parent, target = case.begin()
    command = case.command(parent, target)
    class Interrupted(BaseException):
        pass
    def fail():
        if failure == 'cancelled':
            raise RemoteAlbumEvidenceError('provider_cancelled')
        if failure == 'unexpected':
            raise RuntimeError('Synthetic unknown provider failure')
        raise Interrupted()
    case.provider_hook = fail
    if failure == 'cancelled':
        assert_error(lambda: case.acquire(command), 'provider_cancelled', 503)
    else:
        with pytest.raises(RuntimeError if failure == 'unexpected' else Interrupted):
            case.acquire(command)
    assert case.rows() == [] and states(case)[0][0]['state'] == 'reserved'
    retry = case.acquire(command)
    assert retry['state'] == 'in_flight' and len(case.calls) == 1
    assert not {'acquisition_ref', 'album', 'evidence_version'} & retry.keys()


def test_unknown_reservation_commit_acknowledgement_never_dispatches_on_retry(preparations):
    case = preparations
    parent, target = case.begin()
    command = case.command(parent, target)
    original = case.db.service._connect
    committed = []
    @contextmanager
    def lose_ack(*args, **kwargs):
        with original(*args, **kwargs) as connection:
            yield connection
        # Exact actual transaction has committed. No cursor/result is replaced.
        if any(sql.startswith('select app.reserve_top_remote_attempt(') for sql in case.statements):
            committed.append(True)
            raise RuntimeError('Synthetic commit acknowledgement lost')
    case.db.service._connect = lose_ack
    with pytest.raises(RuntimeError, match='acknowledgement lost'):
        case.acquire(command)
    case.db.service._connect = original
    assert committed == [True] and case.calls == []
    assert states(case)[0][0]['state'] == 'reserved'
    assert case.acquire(command)['state'] == 'in_flight' and case.calls == []


@pytest.mark.parametrize('stage', ['discovery', 'reservation', 'commit', 'provider'])
def test_monotonic_deadline_is_anchored_before_every_wait(preparations, stage):
    case = preparations
    top, _ = case.db.create(refs=[])
    parent, target = case.begin(destination(top))
    command = case.command(parent, target)
    now = [100.0]
    case.service.monotonic_clock = lambda: now[0]
    def after(sql, connection):
        if stage == 'discovery' and sql == 'select owner_account_id from app.album_lists where ref=%s and library_id=%s':
            now[0] = 221.0
        if stage == 'reservation' and sql.startswith('select app.reserve_top_remote_attempt('):
            now[0] = 221.0
    case.after_statement = after
    if stage == 'provider':
        case.provider_hook = lambda: now.__setitem__(0, 221.0)
    original = case.db.service._connect
    if stage == 'commit':
        @contextmanager
        def wait_commit(*args, **kwargs):
            with original(*args, **kwargs) as connection:
                yield connection
            if any(sql.startswith('select app.reserve_top_remote_attempt(') for sql in case.statements):
                now[0] = 221.0
        case.db.service._connect = wait_commit
    assert_error(lambda: case.acquire(command), 'provider_cancelled', 503)
    case.db.service._connect = original
    assert len(case.calls) == (1 if stage == 'provider' else 0)
    assert case.rows() == [] and states(case)[0][0]['state'] == 'reserved'
    assert states(case)[1][0]['attempt_count'] == 1


@pytest.mark.parametrize('value', [True, None, float('nan'), float('inf'), float('-inf'), '100'])
def test_invalid_monotonic_clock_cannot_reserve_or_dispatch(preparations, value):
    case = preparations
    parent, target = case.begin()
    before = case.state()
    case.service.monotonic_clock = lambda: value
    assert_error(lambda: case.acquire(case.command(parent, target)), 'remote_acquisition_unavailable', 503)
    assert case.calls == [] and case.state() == before


def test_monotonic_clock_rollback_after_commit_is_cancelled(preparations):
    case = preparations
    parent, target = case.begin()
    values = iter([100.0, 99.0])
    case.service.monotonic_clock = lambda: next(values)
    assert_error(lambda: case.acquire(case.command(parent, target)), 'provider_cancelled', 503)
    assert case.calls == [] and states(case)[0][0]['state'] == 'reserved'


def test_failed_retry_can_observe_advanced_top_but_pending_retry_cannot(preparations):
    case = preparations
    top, _ = case.db.create(refs=[])
    parent, target = case.begin(destination(top))
    failed = case.command(parent, target)
    def fail():
        raise RemoteAlbumEvidenceError('provider_unavailable')
    case.provider_hook = fail
    failure = case.acquire(failed)
    case.provider_hook = None
    pending = case.command(parent, target)
    case.acquire(pending)
    changed, _ = write(case.db, 'save', top, title='Advanced current Top')
    assert changed['revision'] != top['revision']
    before = case.state()
    assert case.acquire(failed) == failure
    assert_error(lambda: case.acquire(pending), 'revision_conflict', 409)
    assert_error(lambda: case.acquire(case.command(parent, target)), 'revision_conflict', 409)
    assert case.state() == before and len(case.calls) == 2


@pytest.mark.parametrize('operation', ['status', 'close', 'maintain'])
def test_actor_own_state_survives_editor_departure_without_old_top_authority(preparations, operation):
    case = preparations
    editor = member(case.db)
    top, _ = case.db.create(refs=[])
    top, _ = write(case.db, 'grant_editor', top, account_id=editor.account_id, role='editor')
    parent, target = case.begin(destination(top), actor=editor)
    case.acquire(case.command(parent, target), actor=editor)
    with case.db.connect() as connection:
        connection.execute('delete from app.album_list_access_grants where ref=%s', (top['grant_ref'],))
    result = own(case, operation, actor=editor, parent=parent)
    assert result['state'] in {'status', 'closed', 'complete'}
    assert len(case.calls) == 1
    if operation == 'status':
        assert result['parents'][0]['preparation_ref'] == parent['preparation_ref']
        assert 'destination_ref' not in result['parents'][0]
    if operation == 'close':
        assert result['removed_facts'] == result['removed_attempts'] == 1
        assert result['capacity']['actor_pending_count'] == 0


@pytest.mark.parametrize('operation', ['status', 'close', 'maintain'])
@pytest.mark.parametrize('boundary', ['policy', 'cancel', 'session_expiry'])
def test_own_state_final_authority_fences_rollback_cleanup(preparations, operation, boundary):
    case = preparations
    parent, target = case.begin()
    case.acquire(case.command(parent, target))
    before = case.state()
    now = [case.db.now]
    case.db.service._clock = lambda: now[0]
    observed = []
    function = {'status': 'status_top_remote_preparations', 'close': 'close_top_remote_preparation',
                'maintain': 'maintain_top_remote_preparations'}[operation]
    def after(sql, connection):
        if sql.startswith('select app.' + function + '('):
            observed.append(True)
            if boundary == 'session_expiry':
                now[0] += timedelta(days=2)
    case.after_statement = after
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=not (observed and boundary == 'policy'))
    assert_error(lambda: own(case, operation, parent=parent, constraints=constraints,
        should_cancel=lambda: bool(observed and boundary == 'cancel')),
        'provider_cancelled' if boundary == 'cancel' else 'forbidden', 503 if boundary == 'cancel' else 403)
    assert observed == [True] and case.state() == before and len(case.calls) == 1


def test_explicit_close_during_provider_prevents_late_completion_and_refetch(preparations):
    case = preparations
    parent, target = case.begin()
    command = case.command(parent, target)
    closed = []
    case.provider_hook = lambda: closed.append(own(case, 'close', parent=parent))
    assert_error(lambda: case.acquire(command), 'remote_preparation_unavailable', 409)
    assert closed[0]['removed_attempts'] == 1 and closed[0]['released_bytes'] == 16384
    assert_error(lambda: case.acquire(command), 'remote_preparation_unavailable', 409)
    assert len(case.calls) == 1 and case.rows() == [] and states(case)[0] == []


@pytest.mark.parametrize('editor_first', [False, True])
def test_sorted_actor_owner_budget_top_parent_order_in_both_provider_phases(preparations, editor_first):
    case = preparations
    owner, editor, top = _named_top(case, editor_first=editor_first)
    parent, target = case.begin(destination(top), actor=editor)
    command = case.command(parent, target)
    trace = SQLTrace(case)
    case.db.service._connect = trace.observed
    result = trace.call('acquire', lambda: case.acquire(command, actor=editor))
    assert result['state'] == 'pending'
    accounts, tops = trace.assert_order('acquire', editor, owner, top, phases=2)
    entries = trace.selected('acquire')
    budgets = [entry for entry in entries if entry['sql'].startswith('select app.lock_top_remote_pending_actor(')]
    assert len(budgets) == 2
    for account, budget, top_lock in zip(accounts, budgets, tops):
        assert account['connection'] == budget['connection'] == top_lock['connection']
        assert account['order'] < budget['order'] < top_lock['order']
        assert budget['params'] == (editor.account_id,)
        structural = [entry for entry in entries if entry['connection'] == budget['connection'] and (
            entry['sql'].startswith('select app.reserve_top_remote_attempt(') or entry['sql'].startswith('select app.finish_top_remote_attempt('))]
        assert len(structural) == 1 and structural[0]['order'] > top_lock['order']
        assert structural[0]['params'][2] == editor.account_id and structural[0]['params'][7] == owner.account_id


@pytest.mark.parametrize('change', ['missing_parent', 'missing_attempt', 'actor', 'session', 'context',
    'destination', 'version', 'retired', 'consumed'])
def test_v2_pending_selector_loads_only_with_exact_current_prelocked_bindings(mixed, change):
    from tests.py.test_album_top_remote_acquisition_postgres import pending, selector
    from tests.py.test_album_top_collaboration_postgres import member, new_session
    case = mixed.remote
    command = case.prepare_v2()
    receipt = case.acquire(command)
    before = case.c2_state(), case.unrelated()
    row, facts = pending(case, receipt, command)
    assert str(row['ref']) == receipt['acquisition_ref'] and facts.digest == receipt['evidence_version']
    assert (case.c2_state(), case.unrelated()) == before
    assert_error(lambda: pending(case, receipt, command, provide_prelock=False), 'remote_membership_unavailable', 409)
    options = {}
    if change in {'missing_parent', 'missing_attempt'}:
        key = 'preparation_ref' if change == 'missing_parent' else 'attempt_ref'
        options['discovered_override'] = {key: str(uuid4())}
    elif change == 'actor':
        options['actor'] = member(case.db)
    elif change == 'session':
        options['actor'] = new_session(case.db, case.db.owner)
    elif change == 'context':
        options['context_ref'] = 'b' * 64
    elif change == 'destination':
        options['target'] = {'kind': 'create', 'draft_ref': str(uuid4())}
    elif change == 'version':
        options['selected'] = {**selector(receipt), 'evidence_version': 'b' * 64}
    elif change == 'retired':
        case.retire_pending(receipt['acquisition_ref'])
    else:
        # This is the real Create/receipt/bridge owner, not a terminal setter.
        mixed.create(local=False, acquired=receipt)
    before = case.c2_state(), case.unrelated()
    assert_error(lambda: pending(case, receipt, command, **options), 'remote_evidence_unavailable', 409)
    assert (case.c2_state(), case.unrelated()) == before and len(case.calls) == 1
    # Real expired source refusal is retained in the explicitly selected elapsed-
    # time loader case, not replaced by the retired/consumed expansions above.


@pytest.mark.parametrize('when', ['after_discovery', 'during_provider'])
@pytest.mark.parametrize('replacement_kind', ['third_member', 'actor_becomes_owner'])
def test_v2_pins_one_discovered_owner_across_both_provider_phases(preparations, when, replacement_kind):
    from tests.py.test_album_top_remote_acquisition_lock_order import _replace_fixture_owner, _ids, _DISCOVERY
    case = preparations
    owner, editor, top = _named_top(case)
    replacement = editor if replacement_kind == 'actor_becomes_owner' else member(case.db)
    parent, target = case.begin(destination(top), actor=editor)
    command = case.command(parent, target)
    trace = SQLTrace(case)
    case.db.service._connect = trace.observed
    changed = []
    def change():
        assert not changed
        changed.append(True)
        _replace_fixture_owner(case, top, replacement, remove_grant=replacement_kind == 'actor_becomes_owner')
    if when == 'after_discovery':
        def after(entry, connection):
            if entry['label'] == 'acquire' and entry['sql'] == _DISCOVERY:
                change()
        trace.after = after
    else:
        case.provider_hook = change
    assert_error(lambda: trace.call('acquire', lambda: case.acquire(command, actor=editor)), 'concurrent_change', 409)
    trace.assert_order('acquire', editor, owner, top, phases=1 if when == 'after_discovery' else 2)
    assert changed == [True] and len(case.calls) == (when == 'during_provider')
    assert case.rows() == []
    attempts = states(case)[0]
    assert len(attempts) == (when == 'during_provider')
    if attempts:
        assert attempts[0]['state'] == 'reserved'
    if replacement_kind == 'third_member':
        assert all(replacement.account_id not in _ids(entry['params'])
            for entry in trace.selected('acquire') if _account_lock(entry['sql']))


@pytest.mark.parametrize('operation', ['acquire', 'close', 'maintain', 'status'])
def test_false_cancellation_observer_cannot_remove_last_policy_fence(preparations, operation):
    case = preparations
    parent, target = case.begin()
    command = case.command(parent, target)
    if operation != 'acquire':
        case.acquire(command)
    before = case.state()
    reached, denied = [], []
    function = {'acquire': 'finish_top_remote_attempt', 'close': 'close_top_remote_preparation',
                'maintain': 'maintain_top_remote_preparations', 'status': 'status_top_remote_preparations'}[operation]
    case.after_statement = lambda sql, connection: reached.append(True) if sql.startswith('select app.' + function + '(') else None
    def cancelled():
        if reached:
            denied.append(True)
        return False
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=not denied)
    callback = (lambda: case.acquire(command, constraints=constraints, should_cancel=cancelled)) if operation == 'acquire' else (
        lambda: own(case, operation, parent=parent, constraints=constraints, should_cancel=cancelled))
    assert_error(callback, 'forbidden', 403)
    assert reached == [True] and denied
    if operation == 'acquire':
        assert case.rows() == [] and states(case)[0][0]['state'] == 'reserved'
    else:
        assert case.state() == before


@pytest.mark.parametrize('wait_owner', ['request_lock', 'pacing'])
def test_actual_adapter_and_shared_transport_recheck_same_deadline_after_wait(preparations, monkeypatch, wait_owner):
    from music_app.services import musicbrainz_http
    from music_app.services.remote_album_provider import fetch_release_group_evidence
    case = preparations
    parent, target = case.begin()
    now, entered, opened = [100.0], [], []
    case.service.monotonic_clock = lambda: now[0]
    monkeypatch.setattr(musicbrainz_http, '_STRICT_EVIDENCE_URL_CACHE', {})
    monkeypatch.setattr(musicbrainz_http, '_BLOCKED_UNTIL', 0.0)
    monkeypatch.setattr(musicbrainz_http, '_BLOCK_REASON', '')
    if wait_owner == 'request_lock':
        class WaitLock:
            def __enter__(self):
                entered.append('lock')
                now[0] = 221.0
            def __exit__(self, *args):
                return False
        monkeypatch.setattr(musicbrainz_http, '_REQUEST_LOCK', WaitLock())
    else:
        def wait():
            entered.append('pacing')
            now[0] = 221.0
        monkeypatch.setattr(musicbrainz_http, '_wait_for_slot', wait)
    def no_open(*args, **kwargs):
        opened.append(True)
        raise AssertionError('Expired reservation reached network opener')
    monkeypatch.setattr(musicbrainz_http.urllib.request, 'build_opener', no_open)
    def provider(identity, **options):
        case.outside_authority()
        entered.append('adapter')
        return fetch_release_group_evidence(identity, **options)
    case.service.provider = provider
    assert_error(lambda: case.acquire(case.command(parent, target)), 'provider_cancelled', 503)
    assert entered == ['adapter', 'lock' if wait_owner == 'request_lock' else 'pacing']
    assert opened == [] and case.rows() == [] and states(case)[0][0]['state'] == 'reserved'


def test_actual_short_sql_lease_cannot_be_replaced_by_a_fresh_120_second_window(preparations):
    case = preparations
    parent, target = case.insert_timed_parent(age_seconds=1790)
    now = [100.0]
    case.service.monotonic_clock = lambda: now[0]
    def after(sql, connection):
        if sql.startswith('select app.reserve_top_remote_attempt('):
            now[0] = 111.0
    case.after_statement = after
    assert_error(lambda: case.acquire(case.command(parent, target)), 'provider_cancelled', 503)
    attempts, parents, budgets = states(case)
    assert len(attempts) == 1 and attempts[0]['state'] == 'reserved'
    assert attempts[0]['lease_until'] == parents[0]['accepts_until']
    assert 0 < (attempts[0]['lease_until'] - attempts[0]['created_at']).total_seconds() <= 10
    assert budgets[0]['reservation_count'] == 1 and case.calls == [] and case.rows() == []


@pytest.mark.parametrize('fault', ['nan', 'infinity', 'boolean', 'text', 'none', 'clock_exception', 'observer_exception', 'regression', 'external_cancel', 'task_cancelled'])
def test_actual_transport_post_io_callback_failure_is_irreversible(preparations, monkeypatch, fault):
    import asyncio
    from music_app.services import musicbrainz_http
    from music_app.services.remote_album_provider import fetch_release_group_evidence
    from tests.py.remote_top_postgres_support import ARTIST_MBID
    case = preparations
    parent, target = case.begin()
    command = case.command(parent, target)
    post_io, injected, opened, callbacks, reads = [], [], [], [], []
    now = [100.0]
    failure = asyncio.CancelledError('Task cancellation') if fault == 'task_cancelled' else (
        RuntimeError('Transient external observer failure'))
    invalid = {'nan': float('nan'), 'infinity': float('inf'), 'boolean': True, 'text': '100', 'none': None, 'regression': 105.0}
    def clock():
        if post_io and not injected and fault not in {'observer_exception', 'external_cancel'}:
            injected.append(fault)
            if fault in {'clock_exception', 'task_cancelled'}:
                raise failure
            return invalid[fault]
        return now[0]
    def observer():
        if post_io and not injected and fault in {'observer_exception', 'external_cancel'}:
            injected.append(fault)
            if fault == 'observer_exception':
                raise failure
            return True
        return False
    case.service.monotonic_clock = clock
    body = json.dumps({'id': command['release_group_id'], 'title': 'Remote album',
        'primary-type': 'Album', 'artist-credit': [{'name': 'Remote artist', 'artist': {'id': ARTIST_MBID}}],
        'first-release-date': '2000'}).encode('utf-8')
    class Response:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            post_io.append(True)
            return False
        def read(self, maximum):
            reads.append(maximum)
            return body
    class Opener:
        def open(self, request, *, timeout):
            opened.append((request.full_url, timeout))
            return Response()
    monkeypatch.setattr(musicbrainz_http, '_STRICT_EVIDENCE_URL_CACHE', {})
    monkeypatch.setattr(musicbrainz_http, '_BLOCKED_UNTIL', 0.0)
    monkeypatch.setattr(musicbrainz_http, '_BLOCK_REASON', '')
    monkeypatch.setattr(musicbrainz_http, '_NEXT_ALLOWED_AT_MONOTONIC', 0.0)
    monkeypatch.setattr(musicbrainz_http, '_wait_for_slot', lambda: None)
    monkeypatch.setattr(musicbrainz_http.urllib.request, 'build_opener', lambda *handlers: Opener())
    def provider(identity, **options):
        case.outside_authority()
        callbacks.append(options['should_cancel'])
        # The actual adapter/transport accepts110 before the post-I/O fault.
        # A regression to105 stays above the original100 anchor and must retire.
        now[0] = 110.0
        return fetch_release_group_evidence(identity, **options)
    case.service.provider = provider
    expected = asyncio.CancelledError if fault == 'task_cancelled' else (
        RuntimeError if fault.endswith('exception') else AlbumTopError)
    with pytest.raises(expected) as caught:
        case.acquire(command, should_cancel=observer)
    if expected is not AlbumTopError:
        assert caught.value is failure
    else:
        assert caught.value.code == ('provider_cancelled' if fault in {'regression', 'external_cancel'} else 'remote_acquisition_unavailable')
        assert caught.value.status_code == 503
    assert injected == [fault] and len(opened) == len(post_io) == len(callbacks) == 1
    assert reads == [musicbrainz_http._STRICT_SUCCESS_MAX_BYTES + 1]
    # Both raw seams have recovered. The exact acquisition callback must still
    # propagate its first failure; transport retries cannot restore its lifetime.
    assert clock() == 110.0 and observer() is False
    if fault in {'regression', 'external_cancel'}:
        assert callbacks[0]() is True
    else:
        with pytest.raises(expected) as repeated:
            callbacks[0]()
        assert repeated.value is caught.value
    assert musicbrainz_http._STRICT_EVIDENCE_URL_CACHE == {}
    assert case.rows() == [] and states(case)[0][0]['state'] == 'reserved'
    assert not any(sql.startswith(('select app.finish_top_remote_attempt(', 'select app.fail_top_remote_attempt('))
        for sql in case.statements)
    snapshot = case.state()
    assert case.acquire(command)['state'] == 'in_flight'
    assert case.state() == snapshot and len(opened) == len(callbacks) == 1


@pytest.mark.parametrize('reason', ['deadline', 'rollback', 'external_cancel'])
def test_true_cancellation_remains_latched_after_raw_signals_recover(preparations, reason):
    case = preparations
    parent, target = case.begin()
    now, external, observed = [100.0], [False], []
    case.service.monotonic_clock = lambda: now[0]
    def provider(identity, **options):
        case.outside_authority()
        now[0] = 221.0 if reason == 'deadline' else 99.0 if reason == 'rollback' else 100.0
        external[0] = reason == 'external_cancel'
        observed.append(options['should_cancel']())
        now[0], external[0] = 100.0, False
        observed.append(options['should_cancel']())
        return case.facts
    case.service.provider = provider
    assert_error(lambda: case.acquire(case.command(parent, target), should_cancel=lambda: external[0]),
        'provider_cancelled', 503)
    assert observed == [True, True] and case.rows() == [] and states(case)[0][0]['state'] == 'reserved'
    assert not any(sql.startswith(('select app.finish_top_remote_attempt(', 'select app.fail_top_remote_attempt('))
        for sql in case.statements)
