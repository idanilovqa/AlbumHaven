"""Explicit due-only selected-period rollover; retained-album Reset is separate."""
from copy import deepcopy
from dataclasses import dataclass
from datetime import date
import hashlib
import json
from zoneinfo import available_timezones

from music_app.services import listening_goals as domain
from music_app.services.listening_goals_commands import GoalsError, uuid_ref, revision


@dataclass(frozen=True)
class GoalTransitionCommand:
    request_key: str
    revision: str
    settings_revision: str
    period: str
    expected_cycle_id: str
    timezone_name: str

    def payload(self):
        return {name: getattr(self, name) for name in (
            'request_key', 'revision', 'settings_revision', 'period', 'expected_cycle_id', 'timezone_name')}

    @property
    def digest(self):
        return hashlib.sha256(json.dumps({'action': 'transition', **self.payload()},
            sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def normalize_goal_transition(payload):
    if type(payload) is not dict or set(payload) != {
            'request_key', 'revision', 'settings_revision', 'period', 'expected_cycle_id', 'timezone_name'}:
        raise GoalsError('invalid_command')
    if type(payload['period']) is not str or payload['period'] not in domain.GOAL_PERIODS:
        raise GoalsError('invalid_command')
    try:
        domain._zone(payload['timezone_name'], available_timezones(), 'invalid_command')
    except domain.GoalsDomainError as error:
        raise GoalsError(error.code) from error
    return GoalTransitionCommand(uuid_ref(payload['request_key']), revision(payload['revision']),
        revision(payload['settings_revision']), payload['period'], uuid_ref(payload['expected_cycle_id']),
        payload['timezone_name'])


def transition_goal_period(state, *, period, expected_cycle_id, new_cycle_id, occurred_at,
                           timezone_name, viewer_ref, bonus_origin_refs, captured_bonus_ref,
                           unfinished_policy, rated_refs=frozenset()):
    """Archive one due cycle, carry its unfinished members without new admission."""
    zone_names, cycle_ids = domain._validate_state(state)
    domain._period(period)
    domain._identity(viewer_ref)
    domain._identity(new_cycle_id)
    if (type(bonus_origin_refs) is not frozenset or unfinished_policy not in {'carry', 'larger_period'}):
        raise domain.GoalsDomainError('invalid_input')
    for ref in bonus_origin_refs:
        domain._identity(ref)
    if captured_bonus_ref is not None:
        domain._identity(captured_bonus_ref)
        if captured_bonus_ref not in bonus_origin_refs:
            raise domain.GoalsDomainError('invalid_state')
    current = domain._selected_cycle(state, period, expected_cycle_id)
    if current is None:
        raise domain.GoalsDomainError('period_not_started')
    instant = domain._instant(occurred_at)
    old_zone = domain._zone(current['timezone_name'], zone_names)
    new_zone = domain._zone(timezone_name, zone_names)
    if instant.astimezone(old_zone).date() < date.fromisoformat(current['due_date']):
        raise domain.GoalsDomainError('period_not_due')
    if new_cycle_id in cycle_ids:
        raise domain.GoalsDomainError('cycle_id_conflict')
    bounds = [current['started_at']]
    bounds.extend(value for marks in current['completion'].values() for value in marks.values())
    relevant_periods = domain.GOAL_PERIODS[:domain.GOAL_PERIODS.index(period) + 1]
    bounds.extend(row['assigned_at'] for row in state['assignments']
                  if row['period'] in relevant_periods and row['album_ref'] in current['album_refs'])
    if any(instant < domain._stored_instant(value) for value in bounds):
        raise domain.GoalsDomainError('event_before_cycle')
    members = current['album_refs']
    if type(rated_refs) is not frozenset or not rated_refs.issubset(set(members)):
        raise domain.GoalsDomainError('invalid_input')
    if period == 'week' and len(members) > 7:
        raise domain.GoalsDomainError('weekly_capacity')
    marks = current['completion'].get(viewer_ref, {})
    retained = [ref for ref in members if ref not in marks and ref not in rated_refs and
        (period == 'year' or unfinished_policy == 'carry' or ref not in bonus_origin_refs)]
    updated = deepcopy(state)
    archive = {**updated['periods'][period]['current'], 'closed_at': instant.isoformat()}
    updated['periods'][period] = {
        'current': domain._new_cycle(period, new_cycle_id, instant, timezone_name, new_zone, retained),
        'history': [*updated['periods'][period]['history'], archive],
    }
    updated['assignments'] = [row for row in updated['assignments']
        if row['period'] != period or row['album_ref'] in retained]
    active = {ref for value in updated['periods'].values() for ref in value['current']['album_refs']}
    updated['album_refs'] = [ref for ref in updated['album_refs'] if ref in active]
    domain._validate_state(updated)
    return updated
