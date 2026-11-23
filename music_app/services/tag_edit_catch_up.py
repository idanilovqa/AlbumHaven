"""Edits always save: the library catches up with a save whose files are written and verified.

Owner (2026-11-23, confirmed to 6.5: "Yes, that's my rule"): once a save has written and checked its files,
it has succeeded. If its database step fails afterwards, the files keep the new tags and the library
re-reads only that save's files: case 56's per-intent reconciliation, run now instead of at the next start.

One catch-up runs per intent at a time, on one worker. An attempt that can't finish (the request still
holds the intent, or the database step fails again) is retried with back-off, then on the journal owner's
next drain, and at the latest by startup recovery. Never a tight loop, never a library-wide read.
"""
from __future__ import annotations

import logging
import threading
from concurrent.futures import Future
from time import monotonic
from types import SimpleNamespace
from typing import Callable

from music_app.services.runtime_shutdown import create_daemon_executor

_LOGGER = logging.getLogger(__name__)
_EXECUTOR = create_daemon_executor(max_workers=1, thread_name_prefix="albumhaven-tag-edit-catch-up")
# Seconds before each retry of an attempt that could not finish; past the last, the next drain retries.
_RETRY_DELAYS = (0.5, 2.0, 10.0, 60.0)
_LOCK = threading.Lock()
_RUNNING: dict[str, Future] = {}
_WAITING: dict[str, dict[str, object]] = {}

# "settled" (the library holds the save), "failed" (a reconcile attempt failed) or "busy" (the intent is
# still held by its request: a silent retry, never reported).
OutcomeCallback = Callable[[str], None]


def queue_tag_edit_catch_up(config, intent_id: str, *, on_settled: OutcomeCallback | None = None) -> Future:
    """Queue the catch-up of one verified save; a catch-up of the same intent already queued is reused."""
    intent_id = str(intent_id)
    with _LOCK:
        running = _RUNNING.get(intent_id)
        if running is not None and not running.done():
            return running
        _WAITING.pop(intent_id, None)
        future = _EXECUTOR.submit(_run, config, intent_id, on_settled)
        _RUNNING[intent_id] = future
        return future


def retry_waiting_catch_ups() -> int:
    """The journal owner's drain: retry every catch-up whose back-off has run out. Returns how many."""
    now = monotonic()
    with _LOCK:
        due = [(intent_id, record) for intent_id, record in _WAITING.items() if record["retry_at"] <= now]
    for intent_id, record in due:
        queue_tag_edit_catch_up(record["config"], intent_id, on_settled=record["on_settled"])
    return len(due)


def _run(config, intent_id: str, on_settled: OutcomeCallback | None) -> dict[str, int]:
    try:
        summary = _reconcile_intent(intent_id, config=config)
    except Exception:
        _LOGGER.exception("Tag edit catch-up failed intent_id=%s", intent_id)
        summary = {"completed": 0, "rolled_back": 0, "reconciled_external": 0, "failed": 1}
    settled = bool(summary.get("completed") or summary.get("reconciled_external") or summary.get("rolled_back"))
    outcome = "settled" if settled else ("busy" if summary.get("busy") else "failed")
    with _LOCK:
        _RUNNING.pop(intent_id, None)
        if settled:
            _WAITING.pop(intent_id, None)
        else:
            attempts = int((_WAITING.get(intent_id) or {}).get("attempts", 0)) + 1
            _WAITING[intent_id] = {"config": config, "on_settled": on_settled, "attempts": attempts,
                                   "retry_at": monotonic() + _RETRY_DELAYS[min(attempts, len(_RETRY_DELAYS)) - 1]}
            if attempts <= len(_RETRY_DELAYS):
                timer = threading.Timer(_RETRY_DELAYS[attempts - 1], retry_waiting_catch_ups)
                timer.daemon = True
                timer.start()
            elif outcome == "busy":
                # Still held after every timed retry: the page gets its answer; the drain keeps retrying.
                outcome = "failed"
    if on_settled is not None and outcome != "busy":
        try:
            on_settled(outcome)
        except Exception:
            _LOGGER.exception("Could not record a tag edit catch-up's outcome intent_id=%s", intent_id)
    return summary


def _reconcile_intent(intent_id: str, *, config) -> dict[str, int]:
    """Case 56's reconciliation of one claimed intent, called as it is. None claimed (the save's request
    still holds the intent, or it is already finished) counts as not finished yet."""
    from music_app.services.library_roots import library_root_cache_identity
    from music_app.services.tag_edit_intents_postgres import PostgresTagEditIntentRepository
    from music_app.services.tag_edit_recovery import _reconcile_claimed_tag_edit_intent

    repository = PostgresTagEditIntentRepository(config)
    with repository.claim_unfinished_intent(
        intent_id, library_root_identity=library_root_cache_identity(config),
    ) as claimed:
        if claimed is None:
            # Already finished (by an earlier attempt or startup recovery), or still held by its request.
            status = repository.request_status(intent_id) or ""
            finished = status in {"completed", "reconciled_external", "rolled_back"}
            return {"completed": int(finished), "rolled_back": 0, "reconciled_external": 0,
                    "failed": int(not finished), "busy": int(not finished)}
        return _reconcile_claimed_tag_edit_intent(
            SimpleNamespace(config=config, logger=_LOGGER), repository, claimed)
