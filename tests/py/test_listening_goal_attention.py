"""Exact attention contracts; explicit server time, no application/SQL doubles."""
from datetime import date, datetime, timezone
from uuid import uuid4
import pytest
from music_app.services.listening_goal_attention import (
    normalize_goal_attention, project_goal_attention,
)
from music_app.services.listening_goals import _due_date
from music_app.services.listening_goals_commands import GoalsError

GOAL = str(uuid4())
CYCLE = str(uuid4())
NOW = datetime(2026, 1, 8, tzinfo=timezone.utc)


def payload(**changes):
    return {'action': 'attention_ack', 'request_key': str(uuid4()),
            'event': {'kind': 'weekly_cycle_started', 'goal_ref': GOAL, 'cycle_id': CYCLE}, **changes}


def row(period='week', **changes):
    start = date(2026, 1, 1)
    return {'goal_ref': GOAL, 'period': period, 'cycle_id': CYCLE,
            'start_date': start, 'due_date': _due_date(start, period if period in {'week','month','six-months','year'} else 'week'), 'timezone_name': 'UTC',
            'total': 2, 'completed': 1, 'acknowledged': False, **changes}


def project(rows, now=NOW):
    return project_goal_attention({'ref': GOAL, 'revision': 7}, rows, now)


def test_exact_command_and_digest_detach_event():
    value = payload()
    command = normalize_goal_attention(value)
    assert command.payload() == value
    assert normalize_goal_attention(value).digest == command.digest
    value['event']['cycle_id'] = str(uuid4())
    assert command.event()['cycle_id'] == CYCLE
    assert normalize_goal_attention(value).digest != command.digest


@pytest.mark.parametrize('change', [
    {'action': 'reset'}, {'account_id': 1}, {'library_id': 1}, {'revision': '1'},
    {'request_key': None}, {'request_key': '00000000-0000-0000-0000-000000000000'},
    {'event': None}, {'event': {'kind': 'weekly_cycle_started', 'goal_ref': GOAL}},
    {'event': {'kind': 'achievement', 'goal_ref': GOAL, 'cycle_id': CYCLE}},
    {'event': {'kind': 'weekly_cycle_started', 'goal_ref': GOAL, 'cycle_id': CYCLE, 'account_id': 1}},
])
def test_invalid_commands(change):
    with pytest.raises(GoalsError) as caught:
        normalize_goal_attention(payload(**change))
    assert caught.value.code == 'invalid_command'


def test_empty_projection_has_fixed_periods_no_event_or_dot():
    result = project_goal_attention(None, [], NOW)
    assert set(result['periods']) == {'week', 'month', 'six-months', 'year'}
    assert result['goal_ref'] is None and result['revision'] == '1'
    assert result['weekly_event'] is None and result['indicator'] == 'none'
    assert not any(p['achieved'] or p['due'] for p in result['periods'].values())


def test_red_precedence_is_not_achievement_or_ack():
    result = project([row()])
    assert result['indicator'] == 'red' and not result['periods']['week']['achieved']
    assert project([row(acknowledged=True)])['indicator'] == 'red'
    before = datetime(2026, 1, 7, tzinfo=timezone.utc)
    assert project([row()], before)['indicator'] == 'blue'
    assert project([row(acknowledged=True)], before)['indicator'] == 'none'
    assert project([row(completed=2)], before)['periods']['week']['achieved']
    assert project([row(total=0, completed=0)])['indicator'] == 'none'
    assert not project([row(total=0, completed=0)])['periods']['week']['achieved']


@pytest.mark.parametrize('period', ['week', 'month', 'six-months', 'year'])
def test_due_boundary_uses_captured_timezone(period):
    value = row(period, timezone_name='America/Los_Angeles')
    due = value['due_date']
    # July is daylight saving time; test the exact boundary in the actual zone.
    from zoneinfo import ZoneInfo
    from datetime import timedelta
    after = datetime.combine(due, datetime.min.time(), ZoneInfo(value['timezone_name']))
    before = after - timedelta(microseconds=1)
    assert not project([value], before)['periods'][period]['due']
    assert project([value], after)['periods'][period]['due']


def test_due_larger_period_wins_over_unacknowledged_future_week():
    week = row(start_date=date(2026, 2, 1), due_date=date(2026, 2, 8))
    result = project([week, row('month', cycle_id=str(uuid4()))], datetime(2026, 2, 1, tzinfo=timezone.utc))
    assert result['indicator'] == 'red' and not result['periods']['week']['due']


@pytest.mark.parametrize('change', [
    {'total': True}, {'total': -1}, {'total': 9007199254740992}, {'completed': 3},
    {'completed': -1}, {'acknowledged': 1}, {'timezone_name': 'Invalid/Zone'},
    {'due_date': date(2026, 1, 2)}, {'start_date': '2026-01-01'},
    {'period': 'day'}, {'goal_ref': str(uuid4())}, {'cycle_id': 'forged'},
])
def test_invalid_stored_facts_fail_closed(change):
    with pytest.raises(GoalsError) as caught:
        project([row(**change)])
    assert caught.value.code == 'attention_unavailable' and caught.value.status == 503


def test_duplicate_period_or_naive_clock_fails_closed():
    for rows, now in [([row(), row()], NOW), ([row()], datetime(2026, 1, 8))]:
        with pytest.raises(GoalsError) as caught:
            project(rows, now)
        assert caught.value.status == 503
