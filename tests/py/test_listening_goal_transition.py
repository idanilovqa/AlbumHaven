"""Pure explicit rollover boundaries; existing Reset/calendar suite stays intact."""
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4
import pytest
from music_app.services import listening_goals as domain
from music_app.services.listening_goal_transition import normalize_goal_transition, transition_goal_period
from music_app.services.listening_goals_commands import GoalsError

UTC=timezone.utc


def state(start=datetime(2026,1,1,tzinfo=UTC),period='week',albums=('manual','bonus'),zone='UTC'):
    value=domain.create_goal_state(top_ref='goal')
    for album in albums:
        value=domain.add_goal(value,album_ref=album,period=period,assignment_id=album+'-assignment',
            occurred_at=start,timezone_name=zone,
            cycle_ids={name:'old-'+name for name in domain.GOAL_PERIODS[domain.GOAL_PERIODS.index(period):]})['state']
    return value


def move(value,period='week',at=datetime(2026,1,8,tzinfo=UTC),**changes):
    return transition_goal_period(value,period=period,
        expected_cycle_id=value['periods'][period]['current']['cycle_id'],new_cycle_id='new-'+period,
        occurred_at=at,timezone_name='UTC',viewer_ref='1',bonus_origin_refs=frozenset({'bonus'}),
        captured_bonus_ref='bonus',unfinished_policy='carry',**changes)


def test_transition_carries_unfinished_and_archives_finished_without_touching_other_periods():
    value=state()
    value=domain.set_goal_completion(value,period='week',expected_cycle_id='old-week',
        album_ref='manual',viewer_ref='1',completed=True,occurred_at=datetime(2026,1,2,tzinfo=UTC))['state']
    before=deepcopy(value)
    after=move(value)
    assert value==before
    assert after['periods']['week']['current']['album_refs']==['bonus']
    assert after['periods']['week']['history'][0]['completion']==before['periods']['week']['current']['completion']
    for period in ('month','six-months','year'):
        assert after['periods'][period]==before['periods'][period]
    assert all(row['album_ref']!='manual' or row['period']!='week' for row in after['assignments'])


@pytest.mark.parametrize('period,at',[('week',datetime(2026,1,8,tzinfo=UTC)),
    ('month',datetime(2026,2,1,tzinfo=UTC)),('six-months',datetime(2026,7,1,tzinfo=UTC)),
    ('year',datetime(2027,1,1,tzinfo=UTC))])
def test_larger_period_policy_at_every_level_and_year_fallback(period,at):
    value=state(period=period,albums=('manual','bonus','older-bonus'))
    after=transition_goal_period(value,period=period,expected_cycle_id='old-'+period,
        new_cycle_id='next',occurred_at=at,timezone_name='UTC',viewer_ref='1',
        bonus_origin_refs=frozenset({'bonus','older-bonus'}),captured_bonus_ref='bonus',unfinished_policy='larger_period')
    assert after['periods'][period]['current']['album_refs']==(
        ['manual','bonus','older-bonus'] if period=='year' else ['manual'])
    for other in value['periods']:
        if other!=period: assert after['periods'][other]==value['periods'][other]


def test_removed_greater_membership_is_never_resurrected():
    value=state()
    value=domain.remove_goal_album(value,period='month',expected_cycle_id='old-month',album_ref='bonus')['state']
    after=transition_goal_period(value,period='week',expected_cycle_id='old-week',new_cycle_id='next',
        occurred_at=datetime(2026,1,8,tzinfo=UTC),timezone_name='UTC',viewer_ref='1',
        bonus_origin_refs=frozenset({'bonus'}),captured_bonus_ref='bonus',unfinished_policy='larger_period')
    assert 'bonus' not in after['periods']['month']['current']['album_refs']
    assert 'bonus' in after['periods']['six-months']['current']['album_refs']


def test_empty_expired_cycle_rolls_once_and_missed_periods_do_not_invent_history():
    value=state(albums=('manual',))
    value=domain.remove_goal_album(value,period='week',expected_cycle_id='old-week',album_ref='manual')['state']
    assert not domain.reset_goal_period(value,period='week',expected_cycle_id='old-week',new_cycle_id='reset',
        occurred_at=datetime(2026,5,1,tzinfo=UTC),timezone_name='UTC')['changed']
    after=move(value,at=datetime(2026,5,1,tzinfo=UTC))
    assert after['periods']['week']['current']['album_refs']==[]
    assert len(after['periods']['week']['history'])==1
    with pytest.raises(domain.GoalsDomainError,match='period_not_due'):
        move(after,at=datetime(2026,5,1,tzinfo=UTC))


@pytest.mark.parametrize('start,period,zone,before,due,expected_due',[
    (datetime(2026,12,31,12,tzinfo=UTC),'year','UTC',datetime(2026,12,31,23,59,tzinfo=UTC),datetime(2027,1,1,tzinfo=UTC),'2028-01-01'),
    (datetime(2028,1,31,12,tzinfo=UTC),'month','UTC',datetime(2028,2,28,23,59,tzinfo=UTC),datetime(2028,2,29,tzinfo=UTC),'2028-03-29'),
    (datetime(2026,3,1,12,tzinfo=UTC),'week','America/New_York',datetime(2026,3,8,4,59,tzinfo=UTC),datetime(2026,3,8,5,tzinfo=UTC),'2026-03-15'),
])
def test_captured_local_due_date_and_new_calendar_boundary(start,period,zone,before,due,expected_due):
    value=state(start=start,period=period,zone=zone)
    with pytest.raises(domain.GoalsDomainError,match='period_not_due'):
        move(value,period=period,at=before)
    assert move(value,period=period,at=due)['periods'][period]['current']['due_date']==expected_due


def test_overcapacity_never_silently_truncates():
    value=state(albums=tuple('manual-'+str(i) for i in range(6))+('bonus',))
    with pytest.raises(domain.GoalsDomainError,match='weekly_capacity'):
        move(value)


def test_completion_in_other_period_does_not_remove_selected_unfinished_member():
    value=state()
    value=domain.set_goal_completion(value,period='week',expected_cycle_id='old-week',album_ref='manual',
        viewer_ref='1',completed=True,occurred_at=datetime(2026,1,2,tzinfo=UTC))['state']
    value=domain.set_goal_completion(value,period='week',expected_cycle_id='old-week',album_ref='manual',
        viewer_ref='1',completed=False,occurred_at=datetime(2026,1,2,tzinfo=UTC))['state']
    assert move(value)['periods']['week']['current']['album_refs']==['manual','bonus']


@pytest.mark.parametrize('changes',[{'carry_refs':[]},{'bonus_origin_refs':[]},{'account_id':1},
    {'expected_cycle_id':None},{'period':'quarter'},{'settings_revision':True},{'timezone_name':'bad/zone'}])
def test_command_accepts_no_client_carry_or_provenance_authority(changes):
    payload={'request_key':str(uuid4()),'revision':'1','settings_revision':'1','period':'week',
             'expected_cycle_id':str(uuid4()),'timezone_name':'UTC',**changes}
    with pytest.raises(GoalsError):normalize_goal_transition(payload)


def test_legacy_year_capture_is_not_reinterpreted_as_calendar_year_midcycle():
    value=state(start=datetime(2026,6,15,tzinfo=UTC),period='year')
    value['periods']['year']['current']['due_date']='2027-06-15'
    with pytest.raises(domain.GoalsDomainError,match='period_not_due'):
        move(value,period='year',at=datetime(2027,1,1,tzinfo=UTC))
    after=move(value,period='year',at=datetime(2027,6,15,tzinfo=UTC))
    assert after['periods']['year']['current']['due_date']=='2028-01-01'
    assert after['periods']['year']['history'][0]['due_date']=='2027-06-15'


def test_event_before_current_assignment_is_rejected_without_history_rewrite():
    value=state()
    value['assignments'][0]['assigned_at']='2026-01-09T00:00:00+00:00'
    with pytest.raises(domain.GoalsDomainError,match='event_before_cycle'):
        move(value,at=datetime(2026,1,8,tzinfo=UTC))


def test_propagated_smaller_period_admission_cannot_be_archived_before_its_event():
    value=state(albums=('manual',))
    value=domain.add_goal(value,album_ref='late-week',period='week',assignment_id='late-assignment',
        occurred_at=datetime(2026,2,2,tzinfo=UTC),timezone_name='UTC',cycle_ids={})['state']
    with pytest.raises(domain.GoalsDomainError,match='event_before_cycle'):
        move(value,period='month',at=datetime(2026,2,1,tzinfo=UTC))
