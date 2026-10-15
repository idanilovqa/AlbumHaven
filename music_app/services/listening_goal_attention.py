"""Current-cycle attention facts and exact self-acknowledgment commands.

Cycle references identify events; only the account repository authorizes them.
No history, library, provider, catalog metadata or playback inference belongs here.
"""
from dataclasses import dataclass
from datetime import date, datetime, timezone
import hashlib
import json
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from music_app.services.listening_goals import GOAL_PERIODS, _due_date
from music_app.services.listening_goals_commands import GoalsError, uuid_ref, revision

EVENT_KIND = 'weekly_cycle_started'
ACTION = 'attention_ack'


@dataclass(frozen=True)
class GoalAttentionCommand:
    request_key: str
    goal_ref: str
    cycle_id: str

    def event(self):
        return {'kind': EVENT_KIND, 'goal_ref': self.goal_ref, 'cycle_id': self.cycle_id}

    def payload(self):
        return {'action': ACTION, 'request_key': self.request_key, 'event': self.event()}

    @property
    def digest(self):
        return hashlib.sha256(json.dumps(self.payload(), sort_keys=True,
            separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def normalize_goal_attention(payload):
    if type(payload) is not dict or set(payload) != {'action', 'request_key', 'event'}:
        raise GoalsError('invalid_command')
    event = payload['event']
    if (payload['action'] != ACTION or type(payload['action']) is not str
            or type(event) is not dict or set(event) != {'kind', 'goal_ref', 'cycle_id'}
            or type(event['kind']) is not str or event['kind'] != EVENT_KIND):
        raise GoalsError('invalid_command')
    return GoalAttentionCommand(uuid_ref(payload['request_key']), uuid_ref(event['goal_ref']),
                                uuid_ref(event['cycle_id']))


def project_goal_attention(aggregate, rows, now):
    """Project at most four current-cycle SQL count rows with server calendar time."""
    def invalid():
        raise GoalsError('attention_unavailable', 503)
    if (not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None
            or len(rows) > len(GOAL_PERIODS)):
        invalid()
    try:
        goal_ref = uuid_ref(str(aggregate['ref'])) if aggregate else None
        version = revision(str(aggregate['revision'])) if aggregate else '1'
    except (GoalsError, KeyError, TypeError, ValueError):
        invalid()
    periods = {name: {'cycle_id': None, 'due_date': None, 'timezone_name': None,
                     'total': 0, 'completed': 0, 'due': False, 'achieved': False}
               for name in GOAL_PERIODS}
    seen = set()
    acknowledged = False
    event = None
    for row in rows:
        try:
            name = row['period']
            if name not in periods or name in seen or goal_ref is None or str(row['goal_ref']) != goal_ref:
                invalid()
            seen.add(name)
            cycle = uuid_ref(str(row['cycle_id']))
            total, completed = row['total'], row['completed']
            if (type(total) is not int or type(completed) is not int or total < 0
                    or total > 9007199254740991 or not 0 <= completed <= total
                    or type(row['acknowledged']) is not bool):
                invalid()
            start, due = row['start_date'], row['due_date']
            zone_name = row['timezone_name']
            if (type(start) is not date or type(due) is not date or due <= start
                    or type(zone_name) is not str or not 1 <= len(zone_name) <= 255):
                invalid()
            if due != _due_date(start, name) and (name != 'year' or due != _due_date(start, name, legacy_year=True)):
                invalid()
            zone = ZoneInfo(zone_name)
            periods[name] = {'cycle_id': cycle, 'due_date': due.isoformat(), 'timezone_name': zone_name,
                'total': total, 'completed': completed,
                'due': now.astimezone(zone).date() >= due,
                'achieved': total > 0 and completed == total}
            if name == 'week':
                acknowledged = row['acknowledged']
                if total:
                    event = {'kind': EVENT_KIND, 'goal_ref': goal_ref, 'cycle_id': cycle}
        except (KeyError, TypeError, ValueError, OverflowError, ZoneInfoNotFoundError) as error:
            invalid()
    red = any(value['total'] > 0 and value['due'] for value in periods.values())
    return {'goal_ref': goal_ref, 'revision': version, 'evaluated_at': now.astimezone(timezone.utc).isoformat(),
            'periods': periods, 'weekly_event': event, 'weekly_acknowledged': acknowledged,
            'indicator': 'red' if red else 'blue' if event and not acknowledged else 'none'}
