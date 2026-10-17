"""Pure, immutable private Album Top activity timelines.

Callers own authorization, persistence and server-authoritative occurrence times.
This module neither records listening evidence nor replays progress mutations.
"""

from bisect import bisect_right
from dataclasses import dataclass
from datetime import datetime, timezone


class ActivityError(ValueError):
    """An invalid activity command or occurrence instant."""


@dataclass(frozen=True, slots=True)
class _Activity:
    # Starts active; each subsequent instant toggles state. Equal instants retain
    # command order and represent empty intervals rather than invented gaps.
    _transitions: tuple[datetime, ...]

    @property
    def active(self) -> bool:
        return len(self._transitions) % 2 == 1

    @property
    def revision(self) -> int:
        return len(self._transitions) - 1


def _instant(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ActivityError("An aware datetime is required")
    try:
        if value.utcoffset() is None:
            raise ValueError("An aware datetime is required")
        return value.astimezone(timezone.utc)
    except (ValueError, TypeError, OverflowError) as error:
        raise ActivityError("An aware datetime is required") from error


def new_activity(started_at: datetime) -> _Activity:
    """Start recorded activity without inventing earlier activity history."""
    return _Activity((_instant(started_at),))


def set_activity(state: _Activity, active: bool, occurred_at: datetime) -> _Activity:
    """Apply an ordered transition; equal-state commands preserve all history."""
    if type(active) is not bool:
        raise ActivityError("Activity must be a boolean")
    instant = _instant(occurred_at)
    if instant < state._transitions[-1]:
        raise ActivityError("Activity commands cannot precede the latest transition")
    if active == state.active:
        return state
    return _Activity(state._transitions + (instant,))


def progress_allowed(state: _Activity, occurred_at: datetime) -> bool:
    """Allow credit only while active and for a recorded active occurrence.

    Validate even while paused. Reactivation never makes a paused occurrence
    eligible; retained earlier active occurrences remain eligible for their owner.
    """
    instant = _instant(occurred_at)
    return state.active and bisect_right(state._transitions, instant) % 2 == 1


def restore_activity(payload: dict) -> _Activity:
    """Hydrate typed persisted history without retaining caller-owned containers."""
    if type(payload) is not dict or payload.keys() != {'active', 'revision', 'transitions'}:
        raise ActivityError("Activity must contain exactly active, revision and transitions")
    active, revision, rows = payload['active'], payload['revision'], payload['transitions']
    if type(active) is not bool:
        raise ActivityError("Activity must be a boolean")
    if type(revision) is not int or revision < 0:
        raise ActivityError("Activity revision must be a nonnegative integer")
    if type(rows) is not list or not rows:
        raise ActivityError("Activity transitions must be a nonempty list")
    if revision != len(rows) - 1 or active != (len(rows) % 2 == 1):
        raise ActivityError("Activity projection must match its history")

    transitions = []
    for expected_revision, row in enumerate(rows):
        if type(row) is not dict or row.keys() != {'revision', 'occurred_at'}:
            raise ActivityError("Each transition must contain exactly revision and occurred_at")
        if type(row['revision']) is not int or row['revision'] != expected_revision:
            raise ActivityError("Transition revisions must be contiguous from zero")
        instant = _instant(row['occurred_at'])
        if transitions and instant < transitions[-1]:
            raise ActivityError("Activity transitions must be nondecreasing")
        transitions.append(instant)
    return _Activity(tuple(transitions))
