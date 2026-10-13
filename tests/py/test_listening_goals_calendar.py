"""Pure Goals calendar contracts; no application, persistence, or UI bootstrap."""

from copy import deepcopy
from datetime import date, datetime
import importlib.util
import os
from pathlib import Path

import pytest


@pytest.fixture(scope="module")
def goals():
    # A focused recovery run may target a pinned baseline or staged candidate.
    source = Path(os.environ.get(
        "ALBUMHAVEN_GOALS_MODULE",
        str(Path(__file__).resolve().parents[2] / "music_app/services/listening_goals.py"),
    ))
    spec = importlib.util.spec_from_file_location("goals_calendar_under_test", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def instant(value):
    return datetime.fromisoformat(value)


def add(goals, *, when, zone="UTC", period="year"):
    state = goals.create_goal_state(top_ref="calendar-top")
    return goals.add_goal(
        state, album_ref="album-a", period=period,
        assignment_id="assignment-a", occurred_at=instant(when),
        timezone_name=zone,
        cycle_ids={name: f"cycle-{name}" for name in goals.GOAL_PERIODS[
            goals.GOAL_PERIODS.index(period):
        ]},
    )["state"]


@pytest.mark.parametrize("when,zone,start,due", [
    ("2024-07-10T12:00:00+00:00", "UTC", "2024-07-10", "2025-01-01"),
    ("2024-02-29T12:00:00+00:00", "UTC", "2024-02-29", "2025-01-01"),
    ("2024-12-31T23:59:59+00:00", "UTC", "2024-12-31", "2025-01-01"),
    ("2025-01-01T00:00:00+00:00", "UTC", "2025-01-01", "2026-01-01"),
    # One UTC instant belongs to different calendar years in these zones.
    ("2025-01-01T00:30:00+00:00", "America/Los_Angeles", "2024-12-31", "2025-01-01"),
    ("2025-01-01T00:30:00+00:00", "Pacific/Kiritimati", "2025-01-01", "2026-01-01"),
    ("2024-12-31T10:00:00+00:00", "Pacific/Kiritimati", "2025-01-01", "2026-01-01"),
    ("2024-12-31T09:59:59+00:00", "Pacific/Kiritimati", "2024-12-31", "2025-01-01"),
    ("2025-01-01T07:59:59+00:00", "America/Los_Angeles", "2024-12-31", "2025-01-01"),
    ("2025-01-01T08:00:00+00:00", "America/Los_Angeles", "2025-01-01", "2026-01-01"),
])
def test_new_year_cycle_ends_at_next_local_january_first(goals, when, zone, start, due):
    state = add(goals, when=when, zone=zone)
    cycle = state["periods"]["year"]["current"]
    assert cycle["start_date"] == start
    assert cycle["due_date"] == due
    assert cycle["timezone_name"] == zone
    # Reading the newly created representation must also validate successfully.
    view = goals.goal_period_view(state, period="year", viewer_ref="viewer-a")
    assert view["cycle"]["due_date"] == due
    assert view["album_refs"] == ["album-a"]


def legacy_state():
    """Pre-change records, authored independently of the new-cycle constructor."""
    archive = {
        "cycle_id": "legacy-archive", "started_at": "2023-08-31T12:00:00+00:00",
        "start_date": "2023-08-31", "due_date": "2024-08-31",
        "timezone_name": "UTC", "album_refs": ["album-a"],
        "completion": {"viewer-a": {"album-a": "2023-09-01T12:00:00+00:00"}},
        "closed_at": "2024-02-29T12:00:00+00:00",
    }
    current = {
        "cycle_id": "legacy-current", "started_at": archive["closed_at"],
        "start_date": "2024-02-29", "due_date": "2025-02-28",
        "timezone_name": "UTC", "album_refs": ["album-a"],
        "completion": {"viewer-a": {"album-a": "2024-03-01T12:00:00+00:00"}},
    }
    return {
        "top_ref": "legacy-top", "automatic_source": "listening-goals",
        "album_refs": ["album-a"],
        "assignments": [{"assignment_id": "legacy-assignment", "album_ref": "album-a",
                         "period": "year", "assigned_at": archive["started_at"]}],
        "periods": {"year": {"current": current, "history": [archive]}},
    }


def test_legacy_annual_current_and_archive_remain_readable_without_rewriting(goals):
    state = legacy_state()
    before = deepcopy(state)
    view = goals.goal_period_view(state, period="year", viewer_ref="viewer-a")
    assert view["cycle"]["due_date"] == "2025-02-28"
    assert view["completed"] == 1
    assert state == before


def test_reset_legacy_year_keeps_history_and_starts_this_year(goals):
    state = legacy_state()
    before = deepcopy(state)
    result = goals.reset_goal_period(
        state, period="year", expected_cycle_id="legacy-current",
        new_cycle_id="this-year", occurred_at=instant("2024-10-12T12:00:00+00:00"),
        timezone_name="America/Los_Angeles",
    )
    updated = result["state"]
    selected = updated["periods"]["year"]
    assert result["changed"] is True
    assert state == before
    assert selected["history"] == [
        *before["periods"]["year"]["history"],
        {**before["periods"]["year"]["current"], "closed_at": "2024-10-12T12:00:00+00:00"},
    ]
    assert selected["current"]["due_date"] == "2025-01-01"
    assert selected["current"]["completion"] == {}
    assert selected["current"]["album_refs"] == ["album-a"]
    assert updated["assignments"] == before["assignments"]
    assert goals.goal_period_view(updated, period="year", viewer_ref="viewer-a")["completed"] == 0


@pytest.mark.parametrize("period", ["week", "month", "six-months", "year"])
def test_reset_changes_only_selected_period_retaining_albums_and_history(goals, period):
    state = add(goals, when="2024-01-15T12:00:00+00:00", period="week")
    # Give every period existing history so isolation also covers broader archives.
    for name in goals.GOAL_PERIODS:
        state = goals.reset_goal_period(
            state, period=name, expected_cycle_id=f"cycle-{name}",
            new_cycle_id=f"second-{name}", occurred_at=instant("2024-02-15T12:00:00+00:00"),
            timezone_name="UTC",
        )["state"]
    state = goals.set_goal_completion(
        state, period="week", expected_cycle_id="second-week", album_ref="album-a",
        viewer_ref="viewer-a", completed=True, occurred_at=instant("2024-02-16T12:00:00+00:00"),
    )["state"]
    before = deepcopy(state)
    updated = goals.reset_goal_period(
        state, period=period, expected_cycle_id=f"second-{period}",
        new_cycle_id=f"third-{period}", occurred_at=instant("2024-03-15T12:00:00+00:00"),
        timezone_name="Pacific/Kiritimati",
    )["state"]
    assert state == before
    for name in goals.GOAL_PERIODS:
        if name != period:
            assert updated["periods"][name] == before["periods"][name]
    assert updated["album_refs"] == before["album_refs"]
    assert updated["assignments"] == before["assignments"]
    old = before["periods"][period]
    selected = updated["periods"][period]
    assert selected["history"] == [*old["history"], {
        **old["current"], "closed_at": "2024-03-15T12:00:00+00:00",
    }]
    assert selected["current"]["album_refs"] == old["current"]["album_refs"]
    assert selected["current"]["completion"] == {}
    assert selected["current"]["timezone_name"] == "Pacific/Kiritimati"
    expected_due = {"week": "2024-03-23", "month": "2024-04-16",
                    "six-months": "2024-09-16", "year": "2025-01-01"}
    assert selected["current"]["start_date"] == "2024-03-16"
    assert selected["current"]["due_date"] == expected_due[period]
    assert goals.goal_period_view(updated, period=period, viewer_ref="viewer-a")["completed"] == 0


@pytest.mark.parametrize("period,start,expected", [
    ("week", "2024-02-25", "2024-03-03"),
    ("week", "2024-12-29", "2025-01-05"),
    ("month", "2024-01-31", "2024-02-29"),
    ("month", "2025-01-31", "2025-02-28"),
    ("month", "2024-12-31", "2025-01-31"),
    ("six-months", "2023-08-31", "2024-02-29"),
    ("six-months", "2024-08-31", "2025-02-28"),
])
def test_other_period_calendar_arithmetic_is_unchanged(goals, period, start, expected):
    assert goals._due_date(date.fromisoformat(start), period).isoformat() == expected


@pytest.mark.parametrize("where", ["current", "history"])
@pytest.mark.parametrize("bad_due", ["2025-12-31", "2025-01-02", "not-a-date", None])
def test_annual_compatibility_does_not_accept_arbitrary_due_dates(goals, where, bad_due):
    state = legacy_state()
    cycle = state["periods"]["year"]["current" if where == "current" else "history"]
    if where == "history":
        cycle = cycle[0]
    cycle["due_date"] = bad_due
    with pytest.raises(goals.GoalsDomainError) as caught:
        goals.goal_period_view(state, period="year", viewer_ref="viewer-a")
    assert caught.value.code == "invalid_state"


@pytest.mark.parametrize("period", ["week", "month", "six-months", "year"])
@pytest.mark.parametrize("code", ["invalid_input", "invalid_state"])
def test_due_date_overflow_is_a_domain_error(goals, period, code):
    with pytest.raises(goals.GoalsDomainError) as caught:
        goals._due_date(date(9999, 12, 31), period, code)
    assert caught.value.code == code


def test_new_year_cycle_overflow_does_not_mutate_state(goals):
    state = goals.create_goal_state(top_ref="overflow-top")
    before = deepcopy(state)
    with pytest.raises(goals.GoalsDomainError) as caught:
        goals.add_goal(
            state, album_ref="album-a", period="year", assignment_id="assignment-a",
            occurred_at=instant("9999-12-31T12:00:00+00:00"), timezone_name="UTC",
            cycle_ids={"year": "overflow-year"},
        )
    assert caught.value.code == "invalid_input"
    assert state == before


@pytest.mark.parametrize("when,start,due", [
    ("2025-01-01T07:59:59+00:00", "2024-12-31", "2025-01-01"),
    ("2025-01-01T08:00:00+00:00", "2025-01-01", "2026-01-01"),
])
def test_year_reset_uses_new_captured_zone_at_new_year_boundary(goals, when, start, due):
    state = legacy_state()
    before = deepcopy(state)
    updated = goals.reset_goal_period(
        state, period="year", expected_cycle_id="legacy-current",
        new_cycle_id="boundary-reset", occurred_at=instant(when),
        timezone_name="America/Los_Angeles",
    )["state"]
    current = updated["periods"]["year"]["current"]
    assert current["start_date"] == start
    assert current["due_date"] == due
    assert current["timezone_name"] == "America/Los_Angeles"
    assert updated["periods"]["year"]["history"] == [
        *before["periods"]["year"]["history"],
        {**before["periods"]["year"]["current"], "closed_at": when},
    ]
    assert state == before
    assert goals.goal_period_view(updated, period="year", viewer_ref="viewer-a")["total"] == 1


def test_year_reset_overflow_does_not_partially_archive(goals):
    state = legacy_state()
    before = deepcopy(state)
    with pytest.raises(goals.GoalsDomainError) as caught:
        goals.reset_goal_period(
            state, period="year", expected_cycle_id="legacy-current",
            new_cycle_id="overflow-reset", occurred_at=instant("9999-12-31T12:00:00+00:00"),
            timezone_name="UTC",
        )
    assert caught.value.code == "invalid_input"
    assert state == before
