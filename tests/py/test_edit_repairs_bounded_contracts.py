"""Bounded-interaction contract for one tag repair's file write (freeze guard).

A save writes each changed file once and hides that one file from the watcher while it does. The
suppression resolves only that file's path, however many other saves are suppressing theirs.
"""
from __future__ import annotations

from contextlib import ExitStack

import pytest

from music_app.services import edit_state, library_watch_suppression as suppression_module
from music_app.services.library_watch_suppression import LibraryWatchSuppression
from tests.py.bounded_interactions import OperationCounts, measure_scale_pair
from tests.py.filesystem_operation_counting import count_filesystem_and_media

_WORKER = "py:services/edit_state.py#apply_repairs_worker"


def _repair_one_file(tmp_path, monkeypatch, in_flight: int, *, resolve_every_entry: bool = False) -> OperationCounts:
    """Repair one file while ``in_flight`` other files are suppressed by other saves."""
    suppression = LibraryWatchSuppression()
    monkeypatch.setattr(suppression_module, "library_watch_suppression", suppression)
    target = tmp_path / str(in_flight) / "01.mp3"
    written = []
    # The media write itself is the save's own work; this contract counts what surrounds it.
    monkeypatch.setattr(edit_state, "apply_text_repairs_to_file", lambda path, repairs: (written.append(path) or True, ["title"]))
    if resolve_every_entry:
        # The regression this contract rejects: re-resolving every suppressed path per write.
        key = LibraryWatchSuppression._key
        original = suppression.suppress

        def suppress(paths):
            for entry in list(suppression._entries):
                key(entry)
            return original(paths)

        monkeypatch.setattr(suppression, "suppress", suppress)
    with ExitStack() as others:
        for index in range(in_flight):
            others.enter_context(suppression.suppress([tmp_path / "other" / f"{index:05d}.mp3"]))
        counts = OperationCounts()
        with count_filesystem_and_media(monkeypatch, counts):
            result = edit_state.apply_repairs_worker(str(target), {"title": "Repaired"})
    assert result == (str(target), True, ["title"]) and written == [target], "the one file is written once"
    return counts


def test_a_tag_repair_resolves_only_its_own_file_however_many_saves_are_in_flight(tmp_path, monkeypatch):
    from tests.py.bounded_interactions import _checked_in_entries

    entry = _checked_in_entries()[_WORKER]
    measure_scale_pair(
        interaction_id=_WORKER,
        small=entry["cardinalities"]["small"],
        large=entry["cardinalities"]["production"],
        run=lambda size: _repair_one_file(tmp_path, monkeypatch, size),
        budgets=entry["budgets"],
        growth=(entry["growth"]["metric"], entry["growth"]["largeMinusSmallMax"]),
    )


def test_the_tag_repair_contract_rejects_resolving_every_suppressed_path(tmp_path, monkeypatch):
    from tests.py.bounded_interactions import _checked_in_entries

    entry = _checked_in_entries()[_WORKER]
    with pytest.raises(AssertionError, match="grew|exceeds"):
        measure_scale_pair(
            interaction_id=_WORKER,
            small=entry["cardinalities"]["small"],
            large=entry["cardinalities"]["production"],
            run=lambda size: _repair_one_file(tmp_path, monkeypatch, size, resolve_every_entry=True),
            budgets=entry["budgets"],
            growth=(entry["growth"]["metric"], entry["growth"]["largeMinusSmallMax"]),
            registry={"interactions": [entry]},  # a mutation check records no evidence
        )
