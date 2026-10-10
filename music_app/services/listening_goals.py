"""Pure calendar, membership and manual-completion transitions for Goals.

Callers supply resolved identities and explicit times. Authorization, persistence,
operation receipts and ordinary Top progress belong to their existing owners.
"""

from __future__ import annotations

from calendar import monthrange
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones


GOAL_PERIODS = ("week", "month", "six-months", "year")
_CYCLE_FIELDS = {
    "cycle_id", "started_at", "start_date", "due_date", "timezone_name",
    "album_refs", "completion",
}
_CYCLE_VIEW_FIELDS = (
    "cycle_id", "started_at", "start_date", "due_date", "timezone_name",
)


class GoalsDomainError(ValueError):
    """A malformed input or conflicting Goals transition."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _identity(value, code="invalid_input"):
    if type(value) is not str or not value.strip():
        raise GoalsDomainError(code)
    try:
        value.encode("utf-8")
    except UnicodeError as error:
        raise GoalsDomainError(code) from error


def _period(value, code="invalid_input"):
    if type(value) is not str or value not in GOAL_PERIODS:
        raise GoalsDomainError(code)


def _fields(value, fields):
    if type(value) is not dict or value.keys() != fields:
        raise GoalsDomainError("invalid_state")


def _album_ids(value):
    if type(value) is not list:
        raise GoalsDomainError("invalid_state")
    seen = set()
    for album_ref in value:
        _identity(album_ref, "invalid_state")
        if album_ref in seen:
            raise GoalsDomainError("invalid_state")
        seen.add(album_ref)
    return seen


def _instant(value):
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise GoalsDomainError("invalid_input")
    try:
        if value.utcoffset() is None:
            raise ValueError("An aware instant is required")
        return value.astimezone(timezone.utc)
    except (ValueError, TypeError, OverflowError) as error:
        raise GoalsDomainError("invalid_input") from error


def _stored_instant(value):
    if type(value) is not str:
        raise GoalsDomainError("invalid_state")
    try:
        parsed = datetime.fromisoformat(value)
    except (ValueError, OverflowError) as error:
        raise GoalsDomainError("invalid_state") from error
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise GoalsDomainError("invalid_state")
    if parsed.astimezone(timezone.utc).isoformat() != value:
        raise GoalsDomainError("invalid_state")
    return parsed


def _zone(value, zone_names, code="invalid_input"):
    _identity(value, code)
    if (
        value in {"localtime", "posixrules"}
        or value.startswith(("posix/", "right/"))
        or "\\" in value
        or any(part in {"", ".", ".."} for part in value.split("/"))
        or value not in zone_names
    ):
        raise GoalsDomainError(code)
    try:
        return ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError, OSError) as error:
        raise GoalsDomainError(code) from error


def _due_date(start, period, code="invalid_input"):
    try:
        if period == "week":
            return start + timedelta(days=7)
        months = {"month": 1, "six-months": 6, "year": 12}[period]
        year, month = divmod(start.year * 12 + start.month - 1 + months, 12)
        month += 1
        return date(year, month, min(start.day, monthrange(year, month)[1]))
    except (ValueError, OverflowError) as error:
        raise GoalsDomainError(code) from error


def _validate_cycle(cycle, period, zone_names, cycle_ids, *, archived=False):
    _fields(cycle, _CYCLE_FIELDS | {"closed_at"} if archived else _CYCLE_FIELDS)
    _identity(cycle["cycle_id"], "invalid_state")
    if cycle["cycle_id"] in cycle_ids:
        raise GoalsDomainError("invalid_state")
    cycle_ids.add(cycle["cycle_id"])
    started = _stored_instant(cycle["started_at"])
    closed = _stored_instant(cycle["closed_at"]) if archived else None
    if closed is not None and closed < started:
        raise GoalsDomainError("invalid_state")
    _zone(cycle["timezone_name"], zone_names, "invalid_state")
    if type(cycle["start_date"]) is not str:
        raise GoalsDomainError("invalid_state")
    try:
        start_date = date.fromisoformat(cycle["start_date"])
    except ValueError as error:
        raise GoalsDomainError("invalid_state") from error
    if start_date.isoformat() != cycle["start_date"]:
        raise GoalsDomainError("invalid_state")
    # Captured dates survive later timezone-rule changes; only check arithmetic.
    if (
        type(cycle["due_date"]) is not str
        or _due_date(start_date, period, "invalid_state").isoformat() != cycle["due_date"]
    ):
        raise GoalsDomainError("invalid_state")
    albums = _album_ids(cycle["album_refs"])
    if type(cycle["completion"]) is not dict:
        raise GoalsDomainError("invalid_state")
    for viewer_ref, marks in cycle["completion"].items():
        _identity(viewer_ref, "invalid_state")
        if type(marks) is not dict or not marks:
            raise GoalsDomainError("invalid_state")
        for album_ref, value in marks.items():
            _identity(album_ref, "invalid_state")
            marked = _stored_instant(value)
            if album_ref not in albums or marked < started or (closed is not None and marked > closed):
                raise GoalsDomainError("invalid_state")
    return started, closed


def _validate_state(state):
    _fields(state, {"top_ref", "automatic_source", "album_refs", "assignments", "periods"})
    _identity(state["top_ref"], "invalid_state")
    if type(state["automatic_source"]) is not str or state["automatic_source"] != "listening-goals":
        raise GoalsDomainError("invalid_state")
    albums = _album_ids(state["album_refs"])
    if type(state["periods"]) is not dict or type(state["assignments"]) is not list:
        raise GoalsDomainError("invalid_state")
    zone_names = available_timezones()
    cycle_ids = set()
    current_albums = set()
    for period, period_state in state["periods"].items():
        _period(period, "invalid_state")
        _fields(period_state, {"current", "history"})
        if type(period_state["history"]) is not list:
            raise GoalsDomainError("invalid_state")
        current_start, _ = _validate_cycle(period_state["current"], period, zone_names, cycle_ids)
        current_albums.update(period_state["current"]["album_refs"])
        previous_close = None
        for archive in period_state["history"]:
            started, closed = _validate_cycle(archive, period, zone_names, cycle_ids, archived=True)
            if previous_close is not None and previous_close != started:
                raise GoalsDomainError("invalid_state")
            previous_close = closed
        if previous_close is not None and previous_close != current_start:
            raise GoalsDomainError("invalid_state")
    if albums != current_albums:
        raise GoalsDomainError("invalid_state")
    assignment_ids = set()
    assigned_pairs = set()
    for assignment in state["assignments"]:
        _fields(assignment, {"assignment_id", "album_ref", "period", "assigned_at"})
        _identity(assignment["assignment_id"], "invalid_state")
        _identity(assignment["album_ref"], "invalid_state")
        _period(assignment["period"], "invalid_state")
        _stored_instant(assignment["assigned_at"])
        pair = (assignment["album_ref"], assignment["period"])
        period_state = state["periods"].get(assignment["period"])
        if (
            assignment["assignment_id"] in assignment_ids
            or pair in assigned_pairs
            or period_state is None
            or assignment["album_ref"] not in period_state["current"]["album_refs"]
        ):
            raise GoalsDomainError("invalid_state")
        assignment_ids.add(assignment["assignment_id"])
        assigned_pairs.add(pair)
    return zone_names, cycle_ids


def _selected_cycle(state, period, expected_cycle_id):
    if expected_cycle_id is not None:
        _identity(expected_cycle_id)
    period_state = state["periods"].get(period)
    current = period_state["current"] if period_state is not None else None
    actual_id = current["cycle_id"] if current is not None else None
    if actual_id != expected_cycle_id:
        raise GoalsDomainError("cycle_conflict")
    return current


def _new_cycle(period, cycle_id, instant, timezone_name, zone, album_refs=()):
    try:
        start = instant.astimezone(zone).date()
    except (ValueError, OverflowError) as error:
        raise GoalsDomainError("invalid_input") from error
    return {
        "cycle_id": cycle_id, "started_at": instant.isoformat(),
        "start_date": start.isoformat(), "due_date": _due_date(start, period).isoformat(),
        "timezone_name": timezone_name, "album_refs": list(album_refs), "completion": {},
    }


def _unchanged(state, reason):
    return {"state": deepcopy(state), "changed": False, "reason": reason}


def create_goal_state(*, top_ref):
    """Create one automatic Top with no opened periods."""
    _identity(top_ref)
    return {
        "top_ref": top_ref, "automatic_source": "listening-goals",
        "album_refs": [], "assignments": [], "periods": {},
    }


def add_goal(state, *, album_ref, period, assignment_id, occurred_at, timezone_name, cycle_ids):
    """Assign an album to the selected period and materialize larger membership."""
    zone_names, retained_cycle_ids = _validate_state(state)
    _identity(album_ref)
    _period(period)
    _identity(assignment_id)
    instant = _instant(occurred_at)
    zone = _zone(timezone_name, zone_names)
    included = GOAL_PERIODS[GOAL_PERIODS.index(period):]
    if type(cycle_ids) is not dict:
        raise GoalsDomainError("invalid_input")
    for key, value in cycle_ids.items():
        _period(key)
        if key not in included:
            raise GoalsDomainError("invalid_input")
        _identity(value)
    if any(row["album_ref"] == album_ref and row["period"] == period for row in state["assignments"]):
        return _unchanged(state, "already_added")
    if any(row["assignment_id"] == assignment_id for row in state["assignments"]):
        raise GoalsDomainError("assignment_id_conflict")
    missing = [name for name in included if name not in state["periods"]]
    if any(name not in cycle_ids for name in missing):
        raise GoalsDomainError("invalid_input")
    new_ids = [cycle_ids[name] for name in missing]
    if len(set(new_ids)) != len(new_ids) or retained_cycle_ids.intersection(new_ids):
        raise GoalsDomainError("cycle_id_conflict")
    for name in included:
        period_state = state["periods"].get(name)
        if period_state is not None and instant < _stored_instant(period_state["current"]["started_at"]):
            raise GoalsDomainError("event_before_cycle")
    new_cycles = {
        name: _new_cycle(name, cycle_ids[name], instant, timezone_name, zone)
        for name in missing
    }
    updated = deepcopy(state)
    for name in included:
        if name in new_cycles:
            updated["periods"][name] = {"current": new_cycles[name], "history": []}
        current = updated["periods"][name]["current"]
        if album_ref not in current["album_refs"]:
            current["album_refs"] = [*current["album_refs"], album_ref]
    if album_ref not in updated["album_refs"]:
        updated["album_refs"] = [*updated["album_refs"], album_ref]
    updated["assignments"] = [*updated["assignments"], {
        "assignment_id": assignment_id, "album_ref": album_ref,
        "period": period, "assigned_at": instant.isoformat(),
    }]
    return {"state": updated, "changed": True, "reason": ""}


def reset_goal_period(state, *, period, expected_cycle_id, new_cycle_id, occurred_at, timezone_name):
    """Archive only the selected cycle and restart its retained membership."""
    zone_names, cycle_ids = _validate_state(state)
    _period(period)
    _identity(new_cycle_id)
    instant = _instant(occurred_at)
    zone = _zone(timezone_name, zone_names)
    current = _selected_cycle(state, period, expected_cycle_id)
    if current is None or not current["album_refs"]:
        return _unchanged(state, "empty_period")
    if new_cycle_id in cycle_ids:
        raise GoalsDomainError("cycle_id_conflict")
    bounds = [current["started_at"]]
    bounds.extend(value for marks in current["completion"].values() for value in marks.values())
    relevant_periods = GOAL_PERIODS[:GOAL_PERIODS.index(period) + 1]
    bounds.extend(
        row["assigned_at"] for row in state["assignments"]
        if row["album_ref"] in current["album_refs"] and row["period"] in relevant_periods
    )
    if any(instant < _stored_instant(value) for value in bounds):
        raise GoalsDomainError("event_before_cycle")
    new_cycle = _new_cycle(period, new_cycle_id, instant, timezone_name, zone, current["album_refs"])
    updated = deepcopy(state)
    archive = {**updated["periods"][period]["current"], "closed_at": instant.isoformat()}
    updated["periods"][period] = {
        "current": new_cycle, "history": [*updated["periods"][period]["history"], archive],
    }
    return {"state": updated, "changed": True, "reason": ""}


def remove_goal_album(state, *, period, expected_cycle_id, album_ref):
    """Remove selected current membership without pruning larger cycles or history."""
    _validate_state(state)
    _period(period)
    _identity(album_ref)
    current = _selected_cycle(state, period, expected_cycle_id)
    if current is None or album_ref not in current["album_refs"]:
        return _unchanged(state, "not_member")
    updated = deepcopy(state)
    current = updated["periods"][period]["current"]
    current["album_refs"] = [ref for ref in current["album_refs"] if ref != album_ref]
    current["completion"] = {
        viewer: {ref: value for ref, value in marks.items() if ref != album_ref}
        for viewer, marks in current["completion"].items()
        if any(ref != album_ref for ref in marks)
    }
    updated["assignments"] = [
        row for row in updated["assignments"]
        if not (row["album_ref"] == album_ref and row["period"] == period)
    ]
    if not any(album_ref in value["current"]["album_refs"] for value in updated["periods"].values()):
        updated["album_refs"] = [ref for ref in updated["album_refs"] if ref != album_ref]
    return {"state": updated, "changed": True, "reason": ""}


def set_goal_completion(state, *, period, expected_cycle_id, album_ref, viewer_ref, completed, occurred_at):
    """Set manual completion across current memberships, or clear only the selection."""
    _validate_state(state)
    _period(period)
    _identity(album_ref)
    _identity(viewer_ref)
    if type(completed) is not bool:
        raise GoalsDomainError("invalid_input")
    instant = _instant(occurred_at)
    selected = _selected_cycle(state, period, expected_cycle_id)
    if selected is None or album_ref not in selected["album_refs"]:
        raise GoalsDomainError("album_not_in_period")
    if completed:
        changed_periods = [
            name for name, value in state["periods"].items()
            if album_ref in value["current"]["album_refs"]
            and album_ref not in value["current"]["completion"].get(viewer_ref, {})
        ]
    else:
        changed_periods = [period] if album_ref in selected["completion"].get(viewer_ref, {}) else []
    if not changed_periods:
        return _unchanged(state, "unchanged")
    if any(
        instant < _stored_instant(state["periods"][name]["current"]["started_at"])
        for name in changed_periods
    ):
        raise GoalsDomainError("event_before_cycle")
    updated = deepcopy(state)
    for name in changed_periods:
        current = updated["periods"][name]["current"]
        completion = dict(current["completion"])
        marks = dict(completion.get(viewer_ref, {}))
        if completed:
            marks[album_ref] = instant.isoformat()
        else:
            del marks[album_ref]
        if marks:
            completion[viewer_ref] = marks
        else:
            del completion[viewer_ref]
        current["completion"] = completion
    return {"state": updated, "changed": True, "reason": ""}


def goal_period_view(state, *, period, viewer_ref):
    """Project current membership in Top order, with only this viewer's marks."""
    _validate_state(state)
    _period(period)
    _identity(viewer_ref)
    period_state = state["periods"].get(period)
    current = period_state["current"] if period_state is not None else None
    members = set(current["album_refs"]) if current is not None else set()
    albums = [ref for ref in state["album_refs"] if ref in members]
    marks = current["completion"].get(viewer_ref, {}) if current is not None else {}
    manual_completed_at = {ref: marks.get(ref) for ref in albums}
    completed = sum(value is not None for value in manual_completed_at.values())
    total = len(albums)
    return {
        "top_ref": state["top_ref"], "period": period,
        "cycle": {key: current[key] for key in _CYCLE_VIEW_FIELDS} if current is not None else None,
        "album_refs": albums, "manual_completed_at": manual_completed_at,
        "completed": completed, "total": total,
        "percent": (200 * completed + total) // (2 * total) if total else 0,
    }
