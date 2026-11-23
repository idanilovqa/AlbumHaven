"""Edits always save, owner's rule (2026-11-23, confirmed to 6.5: "Yes, that's my rule"): once a save has
written and checked its files, it has succeeded. A later failure of the database step never restores the
files' old tags; the library catches up by re-reading only that save's files (case 56's per-intent
reconciliation, run now instead of at the next start). Only a failed file write reverts.
"""
from __future__ import annotations

import threading
import time

import pytest

from tests.py.test_edits_always_save_rows_postgres import (  # noqa: F401 (live fixture)
    ALBUM, _file_title, _persisted_title, _post_edit, _rows, edit_route,
)

CATCH_UP_BOUND_SECONDS = 10.0


def _fail_first(monkeypatch, owner, name, times, error):
    """``owner.name`` raises ``error`` on its first ``times`` calls, then runs as before."""
    original = getattr(owner, name)
    calls = []

    def failing(*args, **kwargs):
        calls.append(1)
        if len(calls) <= times:
            raise error
        return original(*args, **kwargs)

    monkeypatch.setattr(owner, name, failing)
    return calls


def _file_album(path):
    from mutagen.id3 import ID3

    return str(ID3(path).get("TALB"))


def _until(check, *, timeout=CATCH_UP_BOUND_SECONDS):
    began = time.perf_counter()
    while time.perf_counter() - began < timeout:
        if check():
            return time.perf_counter() - began
        time.sleep(0.1)
    return None


def _intent_statuses(route):
    return {row["status"] for row in _rows(route.setup_url, "select status from library.tag_edit_intents")}


def _album_titled(route, title):
    return bool(_rows(route.setup_url, "select 1 from library.local_albums where title = %s", (title,)))


def _accepted(status, payload):
    """Saved, or saved and finishing: never reported as a failure once the files are verified."""
    return status in (200, 202) and payload.get("ok") is True


def test_live_a_structural_save_whose_db_step_fails_after_its_files_are_verified_keeps_them_and_catches_up(
        edit_route, monkeypatch):
    from music_app.services.scan_cache_persistence import (
        PostgresScanCacheAdapter, StructuralTagEditDestinationConflict,
    )

    # Another album with the target identity appeared after the Save was checked: the first DB finish fails.
    _fail_first(monkeypatch, PostgresScanCacheAdapter, "persist_structural_tag_edit", 1,
                StructuralTagEditDestinationConflict("destination appeared meanwhile"))
    paths = list(edit_route.entries)

    status, payload, _elapsed = _post_edit(edit_route, {path: {"album": "Renamed After Verify"} for path in paths})

    assert _accepted(status, payload), f"A save with verified files was reported failed: {status} {payload}"
    assert all(_file_album(path) == "Renamed After Verify" for path in paths), "The files' old tags were restored."
    assert _until(lambda: _album_titled(edit_route, "Renamed After Verify")) is not None, (
        "The library never caught up with the saved files.")
    assert "rolled_back" not in _intent_statuses(edit_route)
    assert _until(lambda: _intent_statuses(edit_route) <= {"completed", "reconciled_external"}) is not None, (
        f"The intent never finished: {_intent_statuses(edit_route)}")


def test_live_a_media_field_save_whose_db_step_fails_after_its_files_are_verified_keeps_them_and_catches_up(
        edit_route, monkeypatch):
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    _fail_first(monkeypatch, PostgresScanCacheAdapter, "persist_targeted_inventory_mutation", 1,
                RuntimeError("the database connection was lost"))
    target = next(iter(edit_route.entries))

    status, payload, _elapsed = _post_edit(edit_route, {target: {"title": "Title After Verify"}})

    assert _accepted(status, payload), f"A save with verified files was reported failed: {status} {payload}"
    assert _file_title(target) == "Title After Verify", "The file's old title was restored."
    assert _until(lambda: _persisted_title(edit_route, target) == "Title After Verify") is not None, (
        "The library never caught up with the saved file.")
    assert "rolled_back" not in _intent_statuses(edit_route)


def test_live_an_exception_change_saved_with_a_media_field_lands_through_the_catch_up(edit_route, monkeypatch):
    """The exception-override step runs after the files are verified. Its failure restores nothing, and the
    exception value, part of the user's edit, lands through the same catch-up."""
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

    _fail_first(monkeypatch, PostgresScanCacheAdapter, "persist_targeted_inventory_mutation", 1,
                RuntimeError("the database connection was lost"))
    target = next(iter(edit_route.entries))

    status, payload, _elapsed = _post_edit(
        edit_route, {target: {"title": "Rarity After Verify", "exception_type": "Non-album rarity"}})

    assert _accepted(status, payload), f"A save with verified files was reported failed: {status} {payload}"
    assert _file_title(target) == "Rarity After Verify"

    def exception_landed():
        return any("Non-album rarity" in str(row["override_payload"]) for row in _rows(
            edit_route.setup_url, "select override_payload from library.exception_overrides"))

    assert _until(lambda: exception_landed() and _persisted_title(edit_route, target) == "Rarity After Verify"), (
        "The exception change or the title never landed.")


def test_live_a_catch_up_that_fails_once_completes_on_the_next_drain(edit_route, monkeypatch):
    """6.5: a failed catch-up never waits only for a restart. The journal owner's next drain retries it."""
    from music_app.services.gallery_projection_postgres import queue_journaled_relation_drain
    from music_app.services.scan_cache_persistence import (
        PostgresScanCacheAdapter, StructuralTagEditDestinationConflict,
    )

    # The save's finish and the first catch-up both fail; the retry succeeds.
    _fail_first(monkeypatch, PostgresScanCacheAdapter, "persist_structural_tag_edit", 2,
                StructuralTagEditDestinationConflict("destination appeared meanwhile"))
    paths = list(edit_route.entries)

    status, payload, _elapsed = _post_edit(edit_route, {path: {"album": "Caught Up On Retry"} for path in paths})

    assert _accepted(status, payload), f"A save with verified files was reported failed: {status} {payload}"
    assert all(_file_album(path) == "Caught Up On Retry" for path in paths)
    queue_journaled_relation_drain(edit_route.config)
    assert _until(lambda: _album_titled(edit_route, "Caught Up On Retry")) is not None, (
        "A catch-up that failed once never completed without a restart.")


def test_one_catch_up_runs_per_intent_at_a_time(monkeypatch):
    """Single-flight per intent: queued twice while the first runs, the intent is reconciled once."""
    from music_app.services import tag_edit_catch_up

    started, release = [], threading.Event()

    def slow_reconcile(intent_id, **_kwargs):
        started.append(intent_id)
        release.wait(5)
        return {"completed": 1, "rolled_back": 0, "reconciled_external": 0, "failed": 0}

    monkeypatch.setattr(tag_edit_catch_up, "_reconcile_intent", slow_reconcile)
    first = tag_edit_catch_up.queue_tag_edit_catch_up({}, "intent-1")
    second = tag_edit_catch_up.queue_tag_edit_catch_up({}, "intent-1")
    release.set()
    first.result(timeout=10)
    if second is not first:
        second.result(timeout=10)

    assert started == ["intent-1"], f"The intent was reconciled {len(started)} times at once."
