"""Current-only SQL and durable self receipts on the existing isolated CI database."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
from threading import Barrier
from uuid import uuid4
import pytest
from music_app.services.listening_goal_attention import normalize_goal_attention
from music_app.services.listening_goals_commands import GoalsError
from tests.py.test_listening_goal_bonus_postgres import bonus_db, urls
from tests.py.test_listening_goal_transition_postgres import due, command as transition_command
from tests.py.test_listening_goals_postgres import assert_error
from tests.py.test_listening_goals_manual_postgres import command as manual_command

TABLE = 'app.listening_goal_attention_acknowledgments'


@pytest.fixture
def attention_db(bonus_db):
    # Parent owns all other synthetic resources. Retire our FK rows first, even
    # when acquisition/use assertions fail; do not mutate the parent's table list.
    try:
        yield bonus_db
    finally:
        with bonus_db.connect() as connection:
            connection.execute('delete from '+TABLE+' where account_id=any(%s)', (bonus_db.account_ids,))


def intent(db, **changes):
    event = db.service.read_attention(db.context())['weekly_event']
    return normalize_goal_attention({'action': 'attention_ack', 'request_key': str(uuid4()),
                                     'event': event, **changes})


def acknowledge(db, command=None, *, service=None, actor=None):
    return (service or db.service).acknowledge_attention(db.context(actor), command or intent(db))


def acknowledgments(db):
    with db.connect() as connection:
        return connection.execute('select * from '+TABLE+' where account_id=any(%s) order by cycle_id',
                                  (db.account_ids,)).fetchall()


def test_empty_get_does_not_write_and_first_add_exposes_one_cycle(attention_db):
    db = attention_db
    before = db.snapshot()
    empty = db.service.read_attention(db.context())
    assert empty['indicator'] == 'none' and empty['weekly_event'] is None
    assert db.snapshot() == before and acknowledgments(db) == []
    db.add()
    value = db.service.read_attention(db.context())
    assert value['indicator'] == 'blue' and value['periods']['week']['total'] == 1
    assert value['periods']['week']['completed'] == 0
    assert set(value) == {'goal_ref','revision','evaluated_at','periods','weekly_event','weekly_acknowledged','indicator'}
    assert len(value['periods']) == 4 and acknowledgments(db) == []


def test_exact_replay_noop_no_revision_changes_and_no_library(attention_db):
    db = attention_db
    db.add()
    command = intent(db)
    before = db.service.read(db.context())
    settings = db.service.read_bonus_settings(db.context())
    actor = replace(db.owner, current_library_id=None, library_relationships=(), capability_grants=())
    receipt = acknowledge(db, command, actor=actor)
    assert receipt == {'ok': True, 'action': 'attention_ack', 'request_key': command.request_key,
                       'event': command.event(), 'changed': True}
    assert acknowledge(db, command, actor=actor) == receipt
    assert acknowledge(db, actor=actor)['changed'] is False
    assert db.service.read(db.context()) == before
    assert db.service.read_bonus_settings(db.context()) == settings
    assert db.service.read_attention(db.context(actor))['indicator'] == 'none'
    assert len(acknowledgments(db)) == 1
    assert db.service.read_operation(db.context(), command.request_key) == {'status':'committed','receipt':receipt}


def test_changed_digest_and_other_session_cannot_reuse_receipt(attention_db):
    db = attention_db
    db.add(); command = intent(db); acknowledge(db, command)
    changed = normalize_goal_attention({**command.payload(), 'event': {**command.event(), 'cycle_id': str(uuid4())}})
    assert_error(lambda: acknowledge(db, changed), 'idempotency_key_reused', 409)
    renewed = db.renewed_actor()
    assert_error(lambda: acknowledge(db, command, actor=renewed), 'operation_unavailable', 404)
    assert db.service.read_operation(db.context(renewed),command.request_key) == {'status':'unknown'}


@pytest.mark.parametrize('field', ['goal_ref', 'cycle_id'])
def test_foreign_event_rejected_without_receipt(attention_db, field):
    db = attention_db
    db.add(); command = intent(db)
    forged = normalize_goal_attention({**command.payload(),'event':{**command.event(),field:str(uuid4())}})
    before = db.snapshot()
    assert_error(lambda: acknowledge(db,forged), 'attention_event_changed',409)
    assert db.snapshot() == before and acknowledgments(db) == []


def test_reset_new_event_old_receipt_replays_without_acknowledging_new(attention_db):
    db = attention_db
    db.add(); old = intent(db); receipt = acknowledge(db,old)
    db.service.execute(db.context(),db.reset_command(db.service.read(db.context())))
    new = db.service.read_attention(db.context())
    assert new['weekly_event'] != old.event() and new['indicator'] == 'blue'
    assert acknowledge(db,old) == receipt
    stale = normalize_goal_attention({**old.payload(),'request_key':str(uuid4())})
    assert_error(lambda:acknowledge(db,stale),'attention_event_changed',409)
    assert db.service.read_attention(db.context()) == new


def test_due_red_survives_ack_until_transition(attention_db):
    db = attention_db
    db.add(); due(db)
    assert db.service.read_attention(db.context())['indicator'] == 'red'
    acknowledge(db)
    assert db.service.read_attention(db.context())['indicator'] == 'red'
    db.service.transition(db.context(),transition_command(db))
    assert db.service.read_attention(db.context())['indicator'] == 'blue'


def test_removed_and_readded_same_cycle_stays_acknowledged(attention_db):
    db = attention_db
    added, _ = db.add(); album = added['catalog_ref']; acknowledge(db)
    db.service.execute(db.context(),manual_command(db,'remove',album))
    empty = db.service.read_attention(db.context())
    assert empty['periods']['week']['total'] == 0 and empty['indicator'] == 'none'
    assert empty['weekly_event'] is None
    # The same retained provider identity re-admits existing catalog membership.
    with db.connect() as connection:
        external = connection.execute('select external_id from catalog.release_group_provider_identities where catalog_ref=%s',
                                      (album,)).fetchone()['external_id']
    db.add(db.acquire(external))
    assert db.service.read_attention(db.context())['weekly_acknowledged']
    assert db.service.read_attention(db.context())['indicator'] == 'none'


def test_completed_counts_are_current_manual_marks_not_history(attention_db):
    db = attention_db
    added, _ = db.add(); album = added['catalog_ref']
    db.service.execute(db.context(),manual_command(db,'completion',album))
    assert db.service.read_attention(db.context())['periods']['week']['achieved']
    for _ in range(8):
        db.service.execute(db.context(),db.reset_command(db.service.read(db.context())))
    statements = []
    service = db.bounded_service(before=lambda sql,params:statements.append(sql))
    current = service.read_attention(db.context())
    assert current['periods']['week']['total'] == 1 and current['periods']['week']['completed'] == 0
    queries = [sql for sql in statements if 'from app.listening_goal_cycles' in sql]
    assert len(queries) == 1 and 'c.closed_at is null' in queries[0]
    assert 'i.removed_at is null' in queries[0]
    assert not any('select * from app.listening_goal' in sql or 'catalog.release' in sql for sql in statements)


def test_concurrent_acknowledgments_have_one_append_only_row(attention_db):
    db = attention_db
    db.add(); first, second = intent(db), intent(db); barrier = Barrier(2)
    def run(command):
        barrier.wait(timeout=10)
        return acknowledge(db,command)
    with ThreadPoolExecutor(max_workers=2) as pool:
        receipts = list(pool.map(run,[first,second]))
    assert sorted(receipt['changed'] for receipt in receipts) == [False,True]
    assert len(acknowledgments(db)) == 1


@pytest.mark.parametrize('stage', ['acknowledgments','operations'])
def test_each_insert_failure_rolls_back_ack_and_receipt(attention_db,stage):
    db = attention_db
    db.add(); command = intent(db); before = db.snapshot()
    def fail(sql,params):
        if sql.startswith('insert into app.listening_goal_'+('attention_acknowledgments' if stage=='acknowledgments' else 'operations')):
            raise RuntimeError('synthetic attention fault')
    with pytest.raises(RuntimeError,match='synthetic attention fault'):
        acknowledge(db,command,service=db.bounded_service(after=fail))
    assert db.snapshot() == before and acknowledgments(db) == []


def test_expired_final_session_rolls_back_attention(attention_db):
    db = attention_db
    db.add(); command = intent(db); before = db.snapshot(); now = db.now
    def expire(sql,params):
        if sql.startswith('insert into app.listening_goal_attention_acknowledgments'):
            db.now = now + timedelta(days=1000)
    try:
        assert_error(lambda:acknowledge(db,command,service=db.bounded_service(after=expire)), 'forbidden',403)
    finally:
        db.now = now
    assert db.snapshot() == before and acknowledgments(db) == []


def test_effective_privileges_and_cross_account_foreign_key(attention_db):
    import psycopg
    db = attention_db
    db.add(); command = intent(db); acknowledge(db,command)
    with db.connect() as connection:
        other = db.actor(connection)
        for privilege in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'):
            result = connection.execute('''select has_table_privilege('album_haven_app',%s,%s) as app,
                has_table_privilege('album_haven_readonly',%s,%s) as readonly''',
                (TABLE,privilege,TABLE,privilege)).fetchone()
            assert result == {'app':privilege in {'SELECT','INSERT'},'readonly':False}
        assert connection.execute('''select count(*) as n from pg_class c cross join lateral
            aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) p
            where c.oid=%s::regclass and p.grantee=0''',(TABLE,)).fetchone()['n'] == 0
    for sql in ['update '+TABLE+' set acknowledged_at=acknowledged_at where account_id=%s',
                'delete from '+TABLE+' where account_id=%s']:
        with pytest.raises(psycopg.Error) as caught:
            with db.connector()(db.app_url) as connection:
                connection.execute(sql,(db.owner.account_id,))
        assert caught.value.sqlstate == '42501'
    with pytest.raises(psycopg.Error) as caught:
        with db.connect() as connection:
            connection.execute('insert into '+TABLE+' values(%s,%s,%s,%s,%s)',
                (other.account_id,command.goal_ref,command.cycle_id,'weekly_cycle_started',db.now))
    assert caught.value.sqlstate == '23503'
    assert_error(lambda:acknowledge(db,command,actor=other),'attention_event_changed',409)


def test_empty_or_nonweekly_event_is_not_acknowledgeable(attention_db):
    db = attention_db
    added, _ = db.add(); old = intent(db)
    month = db.service.read(db.context())['periods']['month']['cycle']['cycle_id']
    wrong = normalize_goal_attention({**old.payload(),'event':{**old.event(),'cycle_id':month}})
    assert_error(lambda:acknowledge(db,wrong),'attention_event_changed',409)
    db.service.execute(db.context(),manual_command(db,'remove',added['catalog_ref']))
    assert_error(lambda:acknowledge(db,old),'attention_event_changed',409)
    assert acknowledgments(db) == []


def test_progress_revision_change_does_not_change_cycle_event(attention_db):
    db = attention_db
    added, _ = db.add(); command = intent(db)
    db.service.execute(db.context(),manual_command(db,'completion',added['catalog_ref']))
    before = db.service.read(db.context())
    assert acknowledge(db,command)['changed']
    assert db.service.read(db.context()) == before
    assert db.service.read_attention(db.context())['periods']['week']['achieved']


def test_ack_racing_reset_never_clears_replacement_cycle(attention_db):
    db = attention_db
    db.add(); command = intent(db); reset = db.reset_command(db.service.read(db.context()))
    barrier = Barrier(2)
    def ack():
        barrier.wait(timeout=10)
        try:
            return acknowledge(db,command)
        except GoalsError as error:
            assert error.code == 'attention_event_changed' and error.status == 409
            return None
    def restart():
        barrier.wait(timeout=10)
        return db.service.execute(db.context(),reset)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = pool.submit(ack), pool.submit(restart)
        receipt, restarted = first.result(timeout=20), second.result(timeout=20)
    assert restarted['changed']
    current = db.service.read_attention(db.context())
    assert current['weekly_event'] != command.event() and current['indicator'] == 'blue'
    assert len(acknowledgments(db)) == (1 if receipt else 0)


def test_policy_denial_prevents_both_read_and_ack(attention_db):
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    db = attention_db
    db.add(); command = intent(db); before = db.snapshot()
    denied = PolicyEvaluationConstraints(request_origin_allowed=False)
    assert_error(lambda:db.service.read_attention(db.context(),constraints=denied),'forbidden',403)
    assert_error(lambda:db.service.acknowledge_attention(db.context(),command,constraints=denied),'forbidden',403)
    assert db.snapshot() == before and acknowledgments(db) == []
