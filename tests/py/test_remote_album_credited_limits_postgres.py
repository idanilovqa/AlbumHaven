"""Real lock wait and unchanged storage ceilings with full credited fact bytes."""
from concurrent.futures import ThreadPoolExecutor
from time import monotonic, sleep
from uuid import UUID, uuid4
import psycopg
import pytest
from tests.py.remote_preparation_postgres_support import preparations, db, urls
from tests.py.remote_top_postgres_support import remote, runtime, sql_error, evidence
from tests.py.remote_top_retention_postgres_support import retained, invoke, RETAIN
from tests.py.test_remote_preparation_storage_postgres import wait_until
from tests.py.test_remote_album_credited_storage_postgres import credit_facts, finish_args
from tests.py.test_remote_album_credited_evidence import ARTIST


def test_extended_finish_resamples_lease_after_real_parent_lock_wait(preparations):
    case = preparations
    parent, target = case.insert_timed_parent(age_seconds=1790)
    command = case.command(parent, target)
    reservation = case.reserve(command)
    facts = credit_facts(case)
    args = finish_args(case, command, reservation, facts) + ([UUID(value) for value in facts.credited_artist_ids],)
    def finish():
        with runtime(case.db) as connection:
            connection.execute("set local lock_timeout='15s'")
            return invoke(connection, 'app.finish_top_remote_attempt', args)
    with case.db.connect() as blocker:
        blocker.execute('select ref from app.album_top_remote_preparations where ref=%s for update',
            (parent['preparation_ref'],)).fetchone()
        with ThreadPoolExecutor(max_workers=1) as pool:
            task = pool.submit(finish)
            deadline = monotonic() + 5
            observed = False
            while monotonic() < deadline:
                with runtime(case.db) as probe:
                    observed = probe.execute("""select exists(select 1 from pg_stat_activity
                        where usename=current_user and pid<>pg_backend_pid() and wait_event_type='Lock'
                        and query like 'select app.finish_top_remote_attempt(%%') as blocked""").fetchone()['blocked']
                if observed:
                    break
                sleep(0.01)
            assert observed, 'Extended finish did not reach the actual parent lock'
            wait_until(case, reservation['lease_until'])
            blocker.commit()
            with pytest.raises(psycopg.Error) as caught:
                task.result(timeout=5)
            assert caught.value.diag.constraint_name == 'top_remote_expired'
    state = case.state()
    assert state['album_top_remote_acquisitions'] == []
    assert state['album_top_remote_attempts'][0]['state'] == 'reserved'


@pytest.mark.parametrize('scope', ['top', 'owner'])
def test_full_credit_bytes_obey_exact_unchanged_retention_ceiling(retained, scope):
    case = retained
    target = case.top()
    facts = credit_facts(case.remote, (ARTIST,) * 100)
    pending = case.pending(target, facts=facts)
    catalog = case.mapping(pending)
    size = next(row['facts_bytes'] for row in case.remote.rows() if str(row['ref']) == pending['acquisition_ref'])
    if scope == 'top':
        case.seed_bytes(target, 67108864-size)
    else:
        for _ in range(7):
            case.seed_bytes(case.top(), 67108864)
        case.seed_bytes(case.top(), 67108864-size)
    admission = case.retain(target, pending, catalog)
    counts = case.counts(target if scope == 'top' else None)
    assert counts['facts_bytes'] == (67108864 if scope == 'top' else 536870912)
    assert case.retain(target, pending, catalog) == admission
    case.remote.facts = evidence(mbid=str(uuid4()))
    other = case.pending(target, facts=credit_facts(case.remote))
    other_catalog = case.mapping(other, case.db.album_refs[1])
    with runtime(case.db) as connection:
        case.locks(connection, target, pending=other)
        sql_error(connection, '55000', lambda: invoke(connection, RETAIN,
            case.retain_args(target, other, other_catalog)), constraint='top_remote_retained_budget')
    assert case.counts(target if scope == 'top' else None) == counts


def test_maximum_valid_credit_vector_and_unicode_fit_reserved_fact_limit(preparations):
    case = preparations
    case.facts = evidence(title='😀'*1000, artist='😀'*1000)
    facts = credit_facts(case, (ARTIST,) * 100)
    parent, target = case.begin()
    command = case.command(parent, target)
    reservation = case.reserve(command)
    args = finish_args(case, command, reservation, facts) + ([UUID(ARTIST)] * 100,)
    result = case.sql('finish_top_remote_attempt', args)
    assert 11000 < result['facts']['facts_bytes'] <= 16384
    other = case.command(parent, target)
    reserved = case.reserve(other)
    before = case.state()
    bad = list(finish_args(case, other, reserved, facts))
    bad[15] = '😀' * 5000
    bad.append([UUID(ARTIST)] * 100)
    with runtime(case.db) as connection:
        sql_error(connection, '55000', lambda: invoke(connection, 'app.finish_top_remote_attempt', bad),
            constraint='top_remote_expired')
    assert case.state() == before
