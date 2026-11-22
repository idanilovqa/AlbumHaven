"""Bounded-interaction contract for a superseded scan's republish (freeze guard, 6.5's ruling).

A full scan superseded by a watcher or tag-edit publication merges the newer rows and drops the
files another writer removed. Per attempt that is one statement over the scan's own files, and a
disk check only for a file the library no longer knows; never one per scanned file.
"""
from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

from music_app.services import scan_state
from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
from tests.py.bounded_interactions import OperationCounts, measure_scale_pair

_REPUBLISH = "py:services/scan_cache_persistence.py#PostgresScanCacheAdapter.load_removed_unpublished_paths"
_VANISHED = 2


class _Library:
    """library.local_track_files, answering the one membership statement."""

    def __init__(self, known, counts):
        self._known, self._counts = known, counts

    def __enter__(self):
        return self

    def __exit__(self, *_failure):
        return False

    def execute(self, query, params=None):
        assert "library.local_track_files" in query
        self._counts.sql_statements += 1
        self._counts.candidate_rows += len(params["paths"])
        rows = [{"private_path": path} for path in params["paths"] if path in self._known]
        self._counts.returned_rows += len(rows)
        return SimpleNamespace(fetchall=lambda: rows)


def _republish(tmp_path, monkeypatch, file_count: int, *, per_path_check: bool = False) -> OperationCounts:
    """One republish attempt over a scan of ``file_count`` files, ``_VANISHED`` of them removed since."""
    scanned = {str(tmp_path / str(file_count) / f"{index:05d}.mp3"): {"mtime": 1.0} for index in range(file_count)}
    vanished = set(list(scanned)[:_VANISHED])
    counts = OperationCounts()
    adapter = PostgresScanCacheAdapter.__new__(PostgresScanCacheAdapter)
    adapter._connect_to_database = lambda: _Library(set(scanned) - vanished, counts)
    load_removed = adapter.load_removed_unpublished_paths
    if per_path_check:
        # The regression this contract rejects: a disk check for every scanned file.
        def load_removed(paths):
            return adapter.load_removed_unpublished_paths(paths) | {path for path in paths if not os.path.exists(path)}
    exists = os.path.exists

    def counted_exists(path):
        counts.count("stat_calls")
        return exists(path)

    monkeypatch.setattr(os.path, "exists", counted_exists)
    try:
        publication_state = {"file_cache": dict(scanned)}
        scan_state._merge_newer_published_inventory(
            SimpleNamespace(
                load_inventory_mutation_revision=lambda: 7,
                load_inventory_published_since=lambda _since: ({}, set()),
                load_removed_unpublished_paths=load_removed,
            ),
            publication_state,
            since=0.0,
            separate_release_keys=set(),
        )
    finally:
        monkeypatch.setattr(os.path, "exists", exists)
    if not per_path_check:  # the mutation also drops files that were never written to this test's disk
        assert set(publication_state["file_cache"]) == set(scanned) - vanished, "the removed files stay removed"
    return counts


def test_a_superseded_scans_republish_checks_only_the_files_the_library_lost(tmp_path, monkeypatch):
    from tests.py.bounded_interactions import _checked_in_entries

    entry = _checked_in_entries()[_REPUBLISH]
    assert scan_state._SUPERSEDED_SCAN_REPUBLISH_ATTEMPTS == 5, "the per-attempt cost is paid at most 5 times"
    measure_scale_pair(
        interaction_id=_REPUBLISH,
        small=entry["cardinalities"]["small"],
        large=entry["cardinalities"]["production"],
        run=lambda size: _republish(tmp_path, monkeypatch, size),
        budgets=entry["budgets"],
        growth=(entry["growth"]["metric"], entry["growth"]["largeMinusSmallMax"]),
    )


@pytest.mark.parametrize("statements", [1, 2])
def test_the_republish_contract_rejects_a_disk_check_per_file_or_a_growing_statement_count(
    tmp_path, monkeypatch, statements,
):
    """The contract fails on either regression 6.5 named."""
    from tests.py.bounded_interactions import _checked_in_entries

    entry = _checked_in_entries()[_REPUBLISH]

    def run(size):
        counts = _republish(tmp_path, monkeypatch, size, per_path_check=statements == 1)
        if statements == 2:
            counts.sql_statements += size // entry["cardinalities"]["small"]  # one more statement per batch
        return counts

    with pytest.raises(AssertionError, match="grew|exceeds|budget"):
        measure_scale_pair(
            interaction_id=_REPUBLISH,
            small=entry["cardinalities"]["small"],
            large=entry["cardinalities"]["production"],
            run=run,
            budgets=entry["budgets"],
            growth=(entry["growth"]["metric"], entry["growth"]["largeMinusSmallMax"]),
            registry={"interactions": [entry]},  # a mutation check records no evidence
        )
