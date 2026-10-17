"""Real account transactions, retained SQL and receipts for explicit rollover."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import date, datetime, time, timedelta
from threading import Barrier
from uuid import uuid4
from zoneinfo import ZoneInfo
import pytest
from music_app.services.listening_goal_transition import normalize_goal_transition
from music_app.services.listening_goals_commands import GoalsError
from tests.py.test_listening_goal_bonus_postgres import bonus_db, urls, bonus_snapshot
from tests.py.test_listening_goals_postgres import assert_error


def command(db,period='week',**changes):
    state=db.service.read(db.context())
    cycle=state['periods'][period]['cycle']
    return normalize_goal_transition({'request_key':str(uuid4()),'revision':state['revision'],
        'settings_revision':db.service.read_bonus_settings(db.context())['settings_revision'],
        'period':period,'expected_cycle_id':cycle['cycle_id'] if cycle else str(uuid4()),
        'timezone_name':'UTC',**changes})


def due(db,period='week'):
    cycle=db.service.read(db.context())['periods'][period]['cycle']
    db.now=datetime.combine(date.fromisoformat(cycle['due_date']),time(),ZoneInfo(cycle['timezone_name']))
    # Keep real synthetic sessions live across the deliberate calendar jump.
    with db.connect() as connection:
        connection.execute('''update app.account_sessions set idle_expires_at=%s,absolute_expires_at=%s
            where account_id=any(%s)''',(db.now+timedelta(days=400),db.now+timedelta(days=401),db.account_ids))


def move(db,period='week',*,service=None,actor=None,intent=None):
    return (service or db.service).transition(db.context(actor),intent or command(db,period))


def test_five_manual_and_bonus_carry_with_disable_and_no_library(bonus_db):
    db=bonus_db
    db.source()
    for _ in range(5):db.add()
    db.settings(enabled=True,album_mode='next')
    drawn=db.draw()
    db.settings(enabled=False)
    due(db)
    before=db.service.read(db.context())
    intent=command(db)
    actor=replace(db.owner,current_library_id=None,library_relationships=())
    receipt=move(db,actor=actor,intent=intent)
    assert receipt['manual_count']==5 and receipt['manual_slots_available']==0 and receipt['bonus_carried']
    assert not receipt['bonus_slot_available']
    after=db.service.read(db.context())
    assert after['periods']['week']['album_refs']==before['periods']['week']['album_refs']
    assert db.service.read_current_bonus(db.context())['bonus']['catalog_ref']==drawn['catalog_ref']
    for period in ('month','six-months','year'):assert after['periods'][period]==before['periods'][period]
    assert move(db,actor=actor,intent=intent)==receipt
    assert_error(lambda:move(db),'period_not_due',409)


@pytest.mark.parametrize('period',['week','month','six-months','year'])
def test_larger_period_policy_uses_captured_origin_at_every_period(bonus_db,period):
    db=bonus_db
    # Original MB admission is retained; later real captured draw is the origin.
    first,_=db.add()
    album=first['catalog_ref']
    db.remove_all(album)
    db.source([album])
    db.settings(enabled=True,unfinished_policy='larger_period',album_mode='next')
    db.draw()
    manual,_=db.add()
    due(db,period)
    before=db.service.read(db.context())
    result=move(db,period)
    after=db.service.read(db.context())
    assert (album in after['periods'][period]['album_refs'])==(period=='year')
    assert manual['catalog_ref'] in after['periods'][period]['album_refs']
    assert result['retained_count']==(2 if period=='year' else 1)
    for other in ('week','month','six-months','year'):
        if other!=period:assert after['periods'][other]==before['periods'][other]
    with db.connect() as connection:
        row=connection.execute('select admission_kind from app.listening_goal_albums where account_id=%s and catalog_ref=%s',
            (db.owner.account_id,album)).fetchone()
        assert row['admission_kind']=='musicbrainz'


def test_multiple_old_bonuses_progress_from_month_without_restoring_removed_greater_membership(bonus_db):
    db=bonus_db
    db.source()
    db.settings(enabled=True,unfinished_policy='larger_period',album_mode='next')
    first=db.draw()['catalog_ref']
    due(db)
    move(db)
    second=db.draw()['catalog_ref']
    assert second!=first
    db.selected('remove',first,period='six-months')
    due(db,'month')
    move(db,'month')
    state=db.service.read(db.context())
    assert first not in state['periods']['month']['album_refs'] and second not in state['periods']['month']['album_refs']
    assert first not in state['periods']['six-months']['album_refs']
    assert second in state['periods']['six-months']['album_refs']
    assert first in state['periods']['year']['album_refs']
    assert db.service.read_current_bonus(db.context())['bonus']['catalog_ref']==second


def test_completed_bonus_exclusion_and_archived_marks_survive_rollover(bonus_db):
    db=bonus_db
    db.source()
    db.settings(enabled=True)
    album=db.draw()['catalog_ref']
    db.selected('completion',album)
    assert db.exclusion(album)
    due(db)
    result=move(db)
    assert result['retained_count']==0 and result['bonus_slot_available']
    assert db.exclusion(album)
    history=db.history()['cycles'][0]
    assert history['albums'][0]['manual_completed_at'] is not None
    assert history['albums'][0]['catalog_ref']==album


def test_empty_expired_rollover_and_exact_retry_after_source_loss(bonus_db):
    db=bonus_db
    db.source()
    db.settings(enabled=True)
    album=db.draw()['catalog_ref']
    db.remove_all(album)
    due(db)
    intent=command(db)
    result=move(db,intent=intent)
    assert result['retained_count']==0 and result['bonus_slot_available']
    with db.connect() as connection:
        connection.execute('delete from app.album_lists where owner_account_id=%s',(db.owner.account_id,))
        connection.execute('delete from library.library_memberships where account_id=%s',(db.owner.account_id,))
    actor=replace(db.owner,current_library_id=None,library_relationships=())
    assert move(db,actor=actor,intent=intent)==result
    assert_error(lambda:move(db),'period_not_due',409)
    assert db.service.read_current_bonus(db.context())['bonus'] is None


def test_source_exhaustion_after_rollover_cannot_undo_personal_transition(bonus_db):
    db=bonus_db
    top,refs=db.source()
    db.settings(enabled=True,source_mode='selected',selected_top_refs=[],unfinished_policy='larger_period')
    db.add()
    due(db)
    receipt=move(db)
    before=(db.service.read(db.context()),db.history())
    assert db.draw()['reason']=='no_eligible_source'
    assert (db.service.read(db.context()),db.history())==before
    assert db.service.read_operation(db.context(),receipt['request_key'])['receipt']==receipt


@pytest.mark.parametrize('stale',['revision','settings','cycle','not_due','never_started'])
def test_transition_fences_fail_without_mutation(bonus_db,stale):
    db=bonus_db
    if stale=='never_started':
        intent=command(db)
        expected='period_not_started'
    else:
        db.add()
        intent=command(db)
        if stale!='not_due':due(db)
        if stale=='revision':
            db.add();expected='revision_conflict'
        elif stale=='settings':
            db.settings(unfinished_policy='larger_period');expected='settings_revision_conflict'
        elif stale=='cycle':
            intent=normalize_goal_transition({**intent.payload(),'expected_cycle_id':str(uuid4())});expected='cycle_conflict'
        else:expected='period_not_due'
    before=(db.snapshot(),bonus_snapshot(db))
    assert_error(lambda:move(db,intent=intent),expected,409)
    assert (db.snapshot(),bonus_snapshot(db))==before


def test_receipt_digest_session_and_forged_pair_boundaries(bonus_db):
    db=bonus_db
    db.add();due(db)
    intent=command(db)
    result=move(db,intent=intent)
    changed=normalize_goal_transition({**intent.payload(),'timezone_name':'Europe/Paris'})
    assert_error(lambda:move(db,intent=changed),'idempotency_key_reused',409)
    assert_error(lambda:move(db,intent=intent,actor=db.renewed_actor()),'operation_unavailable',404)
    other=db.other_actor()
    assert_error(lambda:move(db,intent=intent,actor=replace(db.owner,session_id=other.session_id)),'forbidden',403)
    assert move(db,intent=intent)==result


@pytest.mark.parametrize('same_key',[True,False])
def test_concurrent_transition_commands_have_one_archive_and_exact_receipt(bonus_db,same_key):
    db=bonus_db
    db.add();due(db)
    first=command(db)
    second=first if same_key else command(db)
    ready=Barrier(2,timeout=5)
    def worker(intent):
        ready.wait()
        try:return move(db,service=db.bounded_service(),intent=intent)
        except GoalsError as error:return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(worker,item) for item in (first,second)]
        results=[future.result(timeout=20) for future in futures]
    if same_key:assert results[0]==results[1]
    else:assert sum(isinstance(item,dict) for item in results)==1 and 'revision_conflict' in results
    assert len(db.history()['cycles'])==1


@pytest.mark.parametrize('checkpoint',['close','cycle','item','retirement','bonus','receipt'])
def test_failure_after_actual_sql_rolls_back_transition_completely(bonus_db,checkpoint):
    db=bonus_db
    db.source();db.settings(enabled=True)
    db.draw()
    manual,_=db.add()
    db.selected('completion',manual['catalog_ref'])
    due(db)
    intent=command(db)
    targets={'close':'update app.listening_goal_cycles set closed_at',
        'cycle':'insert into app.listening_goal_cycles','item':'insert into app.listening_goal_cycle_items',
        'retirement':'update app.listening_goal_assignments set removed_at',
        'bonus':'insert into app.listening_goal_bonus_draws','receipt':'insert into app.listening_goal_operations'}
    hit=[]
    def after(sql,params):
        if sql.startswith(targets[checkpoint]):
            hit.append(True)
            raise RuntimeError('synthetic transition rollback')
    before=(db.snapshot(),bonus_snapshot(db))
    with pytest.raises(RuntimeError,match='synthetic transition rollback'):
        move(db,service=db.bounded_service(after=after),intent=intent)
    assert hit==[True] and (db.snapshot(),bonus_snapshot(db))==before


def test_final_session_expiry_rolls_back_transition_receipt_and_history(bonus_db):
    db=bonus_db
    db.add();due(db)
    intent=command(db)
    inserted=[]
    def after(sql,params):
        if sql.startswith('insert into app.listening_goal_operations'):inserted.append(True)
        if inserted and 'from app.account_sessions' in sql and 'for update' in sql:
            db.now+=timedelta(days=500)
    before=(db.snapshot(),bonus_snapshot(db))
    assert_error(lambda:move(db,service=db.bounded_service(after=after),intent=intent),'forbidden',403)
    assert inserted==[True] and (db.snapshot(),bonus_snapshot(db))==before


@pytest.mark.parametrize('other',['reset','remove','completion','settings'])
def test_transition_serializes_with_existing_writers(bonus_db,other):
    from music_app.services.listening_goal_bonus_settings import normalize_bonus_settings
    from tests.py.test_listening_goal_bonus_settings import payload as settings_payload
    from tests.py.test_listening_goals_manual_postgres import command as manual_command
    db=bonus_db
    added,_=db.add();due(db)
    intent=command(db)
    if other=='reset':
        competing=db.reset_command(db.service.read(db.context()))
    elif other=='settings':
        competing=normalize_bonus_settings(settings_payload(settings_revision=intent.settings_revision,
            unfinished_policy='larger_period'))
    else:
        competing=manual_command(db,other,added['catalog_ref'])
    barrier=Barrier(2,timeout=5)
    def worker(transition):
        service=db.bounded_service()
        barrier.wait()
        try:
            if transition:return service.transition(db.context(),intent)
            if other=='settings':return service.save_bonus_settings(db.context(),competing)
            return service.execute(db.context(),competing)
        except GoalsError as error:return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        first,second=pool.submit(worker,True),pool.submit(worker,False)
        results=first.result(timeout=20),second.result(timeout=20)
    if other=='settings':
        assert isinstance(results[1],dict)
        assert isinstance(results[0],dict) or results[0]=='settings_revision_conflict'
        if isinstance(results[0],dict):assert results[0]['settings_revision']==intent.settings_revision
    else:
        assert sum(isinstance(item,dict) for item in results)==1
        assert 'revision_conflict' in results


def test_early_reset_stays_retained_restart_while_rollover_is_due_only(bonus_db):
    db=bonus_db
    added,_=db.add()
    before=db.service.read(db.context())
    assert_error(lambda:move(db),'period_not_due',409)
    receipt=db.service.execute(db.context(),db.reset_command(before))
    after=db.service.read(db.context())
    assert receipt['changed'] and after['periods']['week']['album_refs']==[added['catalog_ref']]
    for period in ('month','six-months','year'):assert after['periods'][period]==before['periods'][period]


def test_year_transition_keeps_unfinished_bonus_with_larger_policy_and_disabled_selection(bonus_db):
    db=bonus_db
    db.source();db.settings(enabled=True,unfinished_policy='larger_period')
    drawn=db.draw()
    db.settings(enabled=False)
    due(db,'year')
    before=db.service.read(db.context())
    receipt=move(db,'year')
    after=db.service.read(db.context())
    assert drawn['catalog_ref'] in after['periods']['year']['album_refs']
    assert receipt['retained_count']==1
    assert after['periods']['year']['cycle']['due_date']==str(db.now.year+1)+'-01-01'
    for period in ('week','month','six-months'):assert after['periods'][period]==before['periods'][period]
    with db.connect() as connection:
        assert connection.execute('select count(*) as n from app.album_list_item_progress where account_id=%s',
            (db.owner.account_id,)).fetchone()['n']==0


def test_selected_unfinished_carries_without_clearing_other_period_completion(bonus_db):
    db=bonus_db
    added,_=db.add()
    album=added['catalog_ref']
    db.selected('completion',album)
    db.selected('completion',album,completed=False)
    due(db)
    before=db.service.read(db.context())
    move(db)
    after=db.service.read(db.context())
    assert after['periods']['week']['album_refs']==[album]
    assert after['periods']['week']['completed']==0
    for period in ('month','six-months','year'):
        assert after['periods'][period]==before['periods'][period]
        assert after['periods'][period]['completed']==1


def test_propagated_assignment_future_time_rejects_real_sql_transition(bonus_db):
    db=bonus_db
    db.add()
    due(db,'month')
    due_instant=db.now
    db.now+=timedelta(days=1)
    db.add()
    intent=command(db,'month')
    db.now=due_instant
    before=db.snapshot()
    assert_error(lambda:move(db,'month',intent=intent),'event_before_cycle',409)
    assert db.snapshot()==before
