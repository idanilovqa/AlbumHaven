"""Credit lineage through existing actual acquisition/retention/Copy owners."""
from datetime import timedelta
from uuid import UUID

import pytest

from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.remote_top_postgres_support import remote, db, urls, runtime, sql_error
from tests.py.remote_top_retention_postgres_support import retained, invoke, COPY, RETAIN
from tests.py.remote_preparation_postgres_support import preparations
from tests.py.test_album_top_remote_retention_postgres import copy_args
from tests.py.test_owned_album_tops_postgres import assert_error
from tests.py.test_remote_album_credited_storage_postgres import credit_facts
from tests.py.test_remote_album_credited_evidence import ARTIST, OTHER


@pytest.mark.parametrize('ids', [None, (ARTIST, OTHER, ARTIST)])
def test_retention_reuse_and_copy_preserve_first_exact_credit_lineage(retained, ids):
    case = retained
    facts = credit_facts(case.remote, ids)
    top = case.top()
    pending = case.pending(top, facts=facts)
    catalog = case.mapping(pending)
    acquired = next(row for row in case.remote.rows() if str(row['ref']) == pending['acquisition_ref'])
    admission = case.retain(top, pending, catalog)
    original = case.row(admission)
    expected = None if ids is None else [UUID(value) for value in ids]
    assert acquired['credited_artist_ids'] == original['credited_artist_ids'] == expected
    assert original['evidence_version'] == facts.digest
    assert case.counts(top) == {'admission_count': 1, 'facts_bytes': acquired['facts_bytes']}
    before = case.counts(top)
    calls = list(case.remote.calls)
    assert case.retain(top, pending, catalog) == admission
    assert case.row(admission) == original
    assert case.counts(top) == before
    item = case.member(top, catalog, admission, facts.digest)
    target = case.top()
    with runtime(case.db) as connection:
        case.locks(connection, top)
        copied = str(invoke(connection, COPY, copy_args(case, top, item, admission, target)))
    copy = case.row(copied)
    for field in ('credited_artist_ids', 'evidence_version', 'title', 'artist_display',
                  'provider', 'entity_kind', 'external_id', 'first_release_date', 'primary_type',
                  'initiating_actor_account_id', 'original_session_id', 'original_acquisition_ref',
                  'original_destination_kind', 'original_destination_ref', 'original_context_ref',
                  'acquired_at', 'admission_deadline'):
        assert copy[field] == original[field]
    assert str(copy['copied_from_admission_ref']) == admission
    assert copy['admission_kind'] == 'copy'
    assert case.counts(target) == before
    assert case.remote.calls == calls
    with case.db.connect() as connection:
        sql_error(connection, '55000', lambda: connection.execute(
            'update app.album_top_remote_admissions set credited_artist_ids=%s where ref=%s',
            ([UUID(OTHER)], copied)), constraint='top_remote_facts_immutable')
    assert case.row(copied) == copy


def test_same_display_changed_credit_order_cannot_replace_retained_history(retained):
    case = retained
    first = credit_facts(case.remote, (ARTIST, OTHER))
    top = case.top()
    pending = case.pending(top, facts=first)
    catalog = case.mapping(pending)
    admission = case.retain(top, pending, catalog)
    original = case.row(admission)
    before = case.counts(top)
    newer = case.pending(top, facts=credit_facts(case.remote, (OTHER, ARTIST)))
    with runtime(case.db) as connection:
        case.locks(connection, top, pending=newer)
        sql_error(connection, '55000', lambda: invoke(connection, RETAIN,
            case.retain_args(top, newer, catalog)), constraint='top_remote_retained_conflict')
    assert case.row(admission) == original
    assert case.counts(top) == before


@pytest.mark.parametrize('boundary', ['session_expiry', 'policy', 'cancel'])
@pytest.mark.parametrize('transition', ['reserve', 'finish'])
def test_credit_acquisition_final_authority_fences_rollback_transition(preparations, boundary, transition):
    case = preparations
    case.facts = credit_facts(case)
    parent, target = case.begin()
    command = case.command(parent, target)
    now = [case.db.now]
    case.db.service._clock = lambda: now[0]
    observed = []
    def after(sql, connection):
        if sql.startswith('select app.' + transition + '_top_remote_attempt('):
            observed.append(connection.execute('select state from app.album_top_remote_attempts where preparation_ref=%s',
                (parent['preparation_ref'],)).fetchone()['state'])
            if boundary == 'session_expiry':
                now[0] += timedelta(days=2)
    case.after_statement = after
    constraints = lambda context: PolicyEvaluationConstraints(request_origin_allowed=not (observed and boundary == 'policy'))
    cancelled = lambda: bool(observed and boundary == 'cancel')
    assert_error(lambda: case.acquire(command, constraints=constraints, should_cancel=cancelled),
        'provider_cancelled' if boundary == 'cancel' else 'forbidden', 503 if boundary == 'cancel' else 403)
    assert observed == ['reserved' if transition == 'reserve' else 'pending']
    assert case.rows() == []
    state = case.state()
    attempts = state['album_top_remote_attempts']
    if transition == 'reserve':
        assert attempts == []
        assert case.calls == []
    else:
        assert len(attempts) == 1 and attempts[0]['state'] == 'reserved'
        assert len(case.calls) == 1
