"""Background Last.fm scrobble submission.

One worker thread per process sends every pending scrobble on its own: at
start-up, when a listen is left unsent, and again after each backoff (30 s
doubling to 15 minutes, plus jitter) until Last.fm accepts it, so an outage
ends without anyone acting. With nothing waiting it costs one query per wake or
idle check. Submit and reconnecting an account only queue a pass, so requests
cost the same however many scrobbles wait. A pass sends up
to 50 scrobbles per Last.fm call. Each batch is claimed in one transaction,
which marks its listens as being submitted before any is sent, and its results
are stored in a second one, so a listen is never sent twice, even after a crash.
"""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import logging
import random
import threading
import time
from typing import Any

from music_app.services.app_logging import log_app_event
from music_app.services.lastfm import (
    LASTFM_SCROBBLE_BATCH_LIMIT,
    LastfmError,
    LastfmSession,
    lastfm_api_enabled,
    load_saved_lastfm_sessions,
    scrobble_tracks,
)
from music_app.services.lastfm_listen_sync import record_retry_results
from music_app.services.lastfm_sync_bridge import (
    ATTEMPTING_UPDATES,
    failed_batch_disposition,
    plan_pending_scrobble,
    scrobble_attempt_updates,
    scrobble_due_at,
    scrobble_retry_delay_seconds,
)
from music_app.services.listen_history import (
    build_listen_history_status_counts,
    has_sendable_scrobbles,
    is_pending_scrobble_entry,
    listen_history_connection,
    load_pending_scrobble_entries,
)
from music_app.services.listen_history_postgres import (
    PendingListenEntry,
    lock_pending_entries,
    write_listen_entries,
)
from music_app.services.log_history import HistoryScope
from music_app.services.measured_listen_history import VERSION as MEASURED_VERSION

# With nothing waiting, the worker sleeps until woken, and checks this often with one query.
_IDLE_CHECK_SECONDS = 30 * 60
# Each scheduled retry waits up to this much longer, so passes do not align with other clients.
_RETRY_JITTER = 0.2
_RETRY_LOCK = threading.Lock()
_WORKER_LOCK = threading.Lock()
_WORKER_THREAD: threading.Thread | None = None
_WORKER_APP_KEY = ""
_WORKER_STOP_EVENT: threading.Event | None = None
_WORKER_WAKE_EVENT: threading.Event | None = None
# Requested passes by account, and each account's latest submission state. Both
# are guarded by _WORKER_LOCK.
_REQUESTS: dict[int, "_RetryRequest"] = {}
_SUBMISSIONS: dict[int, dict[str, str]] = {}
# Set when a listen was left unsent: the worker checks for sendable listens at once.
_CHECK_REQUESTED = False

SUBMISSION_FAILED = "Album Haven could not submit pending scrobbles to Last.fm."
SUBMISSION_INCOMPLETE = "Some pending scrobbles could not be submitted to Last.fm."


class LastfmRetryBatchError(RuntimeError):
    def __init__(self, summary: dict[str, int]) -> None:
        super().__init__("Last.fm retry batch failed.")
        self.summary = dict(summary)


@dataclass(frozen=True)
class _RetryRequest:
    library_ids: frozenset[int] | None
    reauthenticated: bool = False
    bypass_backoff: bool = False
    # Where a failed Submit is recorded for the person who asked.
    history_scope: HistoryScope | None = None

    def merge(self, other: "_RetryRequest") -> "_RetryRequest":
        return _RetryRequest(
            library_ids=None if self.library_ids is None or other.library_ids is None
            else self.library_ids | other.library_ids,
            reauthenticated=self.reauthenticated or other.reauthenticated,
            bypass_backoff=self.bypass_backoff or other.bypass_backoff,
            history_scope=self.history_scope or other.history_scope,
        )


@dataclass
class LastfmRetryPass:
    summary: dict[str, int]
    # Seconds until the next waiting listen may be sent (after a failed batch, its
    # backoff); None when nothing is left to send.
    retry_in_seconds: float | None = None


def pending_scrobble_count(
    config: dict[str, Any], *, account_id: int | None = None, library_id: int | None = None,
) -> int:
    if account_id is not None and library_id is not None:
        return build_listen_history_status_counts(
            config, account_id=account_id, library_id=library_id,
        )["pending_scrobble_count"]
    return len(load_pending_scrobble_entries(
        config,
        limit=None,
        eligible=lambda pending: (
            (account_id is None or pending.account_id == account_id)
            and (library_id is None or pending.library_id == library_id)
        ),
    ))


def request_lastfm_submission(scope: HistoryScope) -> str:
    """Submit: sends the library's pending scrobbles now, ignoring retry backoff.

    Returns the account's submission state. While its pass runs, Submit starts nothing."""
    return _queue_request(scope.account_id, _RetryRequest(
        library_ids=frozenset({scope.library_id}), bypass_backoff=True, history_scope=scope,
    ))


def request_lastfm_reconnect_retry(account_id: int) -> str:
    """After a reconnection, retries the account's scrobbles that were waiting for it."""
    return _queue_request(account_id, _RetryRequest(library_ids=None, reauthenticated=True))


def _queue_request(account_id: int, request: _RetryRequest) -> str:
    """Queues a background pass for one account and wakes the worker; returns its state.

    While the account's pass runs, a further request starts nothing, unless it
    follows a reconnection, which is queued to run next."""
    with _WORKER_LOCK:
        state = _SUBMISSIONS.get(account_id, {}).get("state")
        if state == "running" and not request.reauthenticated:
            return state
        queued = _REQUESTS.get(account_id)
        _REQUESTS[account_id] = request if queued is None else queued.merge(request)
        if state != "running":
            _SUBMISSIONS[account_id] = {"state": "queued", "error": ""}
        if _WORKER_WAKE_EVENT is not None:
            _WORKER_WAKE_EVENT.set()
        return _SUBMISSIONS[account_id]["state"]


def lastfm_submission_status(account_id: int) -> dict[str, str]:
    """The account's latest requested submission: idle, queued, running, or failed with a safe error."""
    with _WORKER_LOCK:
        return dict(_SUBMISSIONS.get(account_id) or {"state": "idle", "error": ""})


def retry_pending_lastfm_scrobbles(
    config: dict[str, Any],
    *,
    reauthenticated: bool = False,
    account_id: int | None = None,
    library_ids: frozenset[int] | None = None,
    bypass_backoff: bool = False,
) -> LastfmRetryPass:
    """Sends the pending scrobbles in scope, in batches of up to 50 per account."""
    result = LastfmRetryPass(summary={
        "pending_before": 0, "attempted": 0, "succeeded": 0, "failed": 0, "pending_after": 0,
    })
    if not lastfm_api_enabled(config):
        return result
    summary = result.summary
    pending_changes: dict[str, dict[str, object] | None] = {}
    scope_summaries: dict[tuple[int, int], dict[str, int]] = {}
    with _RETRY_LOCK:
        try:
            with listen_history_connection(config) as connection:
                pending = load_pending_scrobble_entries(
                    config,
                    limit=None,
                    connection=connection,
                    eligible=lambda item: (
                        (account_id is None or item.account_id == account_id)
                        and (library_ids is None or item.library_id in library_ids)
                    ),
                )
                sessions = load_saved_lastfm_sessions(connection, {item.account_id for item in pending})
                pending = [item for item in pending if item.account_id in sessions]
                summary["pending_before"] = summary["pending_after"] = len(pending)
                now = datetime.now(timezone.utc)
                latest = {item.row_id: item.entry for item in pending}
                for batch in _account_batches(pending, now=now, reauthenticated=reauthenticated,
                                              bypass_backoff=bypass_backoff):
                    stored, failure = _submit_batch(
                        config, connection, batch, session=sessions[batch[0].account_id],
                        reauthenticated=reauthenticated, bypass_backoff=bypass_backoff,
                    )
                    for before, after, attempted in stored:
                        latest[after.row_id] = after.entry
                        _count_result(summary, scope_summaries, before, after, attempted=attempted)
                        if after.entry.get("measurement_version") != MEASURED_VERSION:
                            pending_changes[str(after.entry["id"])] = (
                                after.entry if is_pending_scrobble_entry(after.entry) else None
                            )
                    if failure is not None:
                        # The provider is failing: later batches wait for the same backoff.
                        result.retry_in_seconds = failure
                        break
                else:
                    result.retry_in_seconds = _seconds_until_next_due(latest.values(), now=now)
            if pending_changes or (account_id is None and summary["attempted"]):
                record_retry_results(
                    config,
                    pending_changes=pending_changes,
                    summary=summary if account_id is None else None,
                )
        except Exception as exc:
            raise LastfmRetryBatchError(summary) from exc
        finally:
            _log_scope_summaries(config, scope_summaries)
    return result


def _seconds_until_next_due(entries, *, now: datetime) -> float | None:
    """Seconds until the earliest listen still waiting may be sent; None when none waits.

    A listen that needs its account reconnected waits for the reconnection instead."""
    due = [
        scrobble_due_at(entry, now=now)
        for entry in entries
        if is_pending_scrobble_entry(entry) and not entry.get("scrobble_reauthentication_required")
    ]
    return max(0.0, (min(due) - now).total_seconds()) if due else None


def _account_batches(
    pending: list[PendingListenEntry], *, now: datetime, reauthenticated: bool, bypass_backoff: bool,
) -> Iterator[list[PendingListenEntry]]:
    """Each account's listens that have a next step, in batches of up to 50."""
    by_account: dict[int, list[PendingListenEntry]] = {}
    for item in pending:
        if plan_pending_scrobble(item.entry, now=now, reauthenticated=reauthenticated,
                                 bypass_backoff=bypass_backoff) is not None:
            by_account.setdefault(item.account_id, []).append(item)
    for items in by_account.values():
        for start in range(0, len(items), LASTFM_SCROBBLE_BATCH_LIMIT):
            yield items[start:start + LASTFM_SCROBBLE_BATCH_LIMIT]


def _submit_batch(
    config: dict[str, Any],
    connection: Any,
    batch: list[PendingListenEntry],
    *,
    session: LastfmSession,
    reauthenticated: bool,
    bypass_backoff: bool,
) -> tuple[list[tuple[PendingListenEntry, PendingListenEntry, bool]], int | None]:
    """Claims, sends, and stores one batch. Returns each listen's entry before and
    after and whether it was sent, and the backoff in seconds when the Last.fm
    call as a whole failed."""
    now = datetime.now(timezone.utc)
    stored: list[tuple[PendingListenEntry, PendingListenEntry, bool]] = []
    sending: list[tuple[PendingListenEntry, dict[str, object]]] = []
    with connection.transaction():
        claimed = []
        for item in lock_pending_entries(connection, batch).values():
            # Another submitter may have handled the listen since the pass loaded it.
            plan = plan_pending_scrobble(item.entry, now=now, reauthenticated=reauthenticated,
                                         bypass_backoff=bypass_backoff)
            if plan is None:
                continue
            if plan.payload is None:
                updated = replace(item, entry={**item.entry, **plan.updates})
                stored.append((item, updated, False))
                claimed.append(updated)
            else:
                sending.append((item, plan.payload))
                claimed.append(replace(item, entry={**item.entry, **ATTEMPTING_UPDATES}))
        write_listen_entries(connection, claimed)
    if not sending:
        return stored, None
    retry_in = None
    try:
        outcomes = scrobble_tracks(config, [payload for _item, payload in sending], session=session)
        results = [
            scrobble_attempt_updates(item.entry, attempted_at=now, submission_state="accepted")
            if outcome.succeeded
            else scrobble_attempt_updates(item.entry, attempted_at=now, error=outcome.message,
                                          submission_state="sent")
            for (item, _payload), outcome in zip(sending, outcomes)
        ]
    except LastfmError as error:
        results = []
        for item, _payload in sending:
            retryable, state = failed_batch_disposition(
                error, measured=item.entry.get("measurement_version") == MEASURED_VERSION,
            )
            results.append(scrobble_attempt_updates(
                item.entry, attempted_at=now, error=str(error), retryable=retryable,
                reauthentication_required=error.reauthentication_required, submission_state=state,
            ))
        attempts = max(int(item.entry.get("scrobble_retry_count") or 0) + 1 for item, _payload in sending)
        retry_in = max(scrobble_retry_delay_seconds(attempts), error.retry_after_seconds or 0)
    sent = [replace(item, entry={**item.entry, **updates}) for (item, _payload), updates in zip(sending, results)]
    with connection.transaction():
        write_listen_entries(connection, sent)
    stored.extend((before, after, True) for (before, _payload), after in zip(sending, sent))
    return stored, retry_in


def _count_result(
    summary: dict[str, int],
    scope_summaries: dict[tuple[int, int], dict[str, int]],
    before: PendingListenEntry,
    after: PendingListenEntry,
    *,
    attempted: bool,
) -> None:
    succeeded = bool(after.entry.get("scrobbled"))
    scope = scope_summaries.setdefault(
        (after.account_id, after.library_id), {"attempted": 0, "succeeded": 0, "failed": 0},
    )
    for counts in (summary, scope):
        counts["attempted"] += int(attempted)
        counts["succeeded"] += int(succeeded)
        counts["failed"] += int(not succeeded)
    if is_pending_scrobble_entry(before.entry) and not is_pending_scrobble_entry(after.entry):
        summary["pending_after"] -= 1


def _log_scope_summaries(config: dict[str, Any], scope_summaries: dict[tuple[int, int], dict[str, int]]) -> None:
    """One history event per account library the pass touched, holding counts only."""
    logger = logging.getLogger("music_app")
    for (account_id, library_id), counts in scope_summaries.items():
        log_app_event(
            config,
            logger,
            "Last.fm scrobble retry pass completed",
            level="warning" if counts["failed"] else "info",
            history=True,
            history_scope=HistoryScope(library_id=library_id, account_id=account_id, origin_kind="retry"),
            integration="Last.fm",
            **counts,
        )


def _take_request() -> tuple[int, _RetryRequest] | None:
    with _WORKER_LOCK:
        if not _REQUESTS:
            return None
        account_id = next(iter(_REQUESTS))
        request = _REQUESTS.pop(account_id)
        _SUBMISSIONS[account_id] = {"state": "running", "error": ""}
        return account_id, request


def _run_requested_pass(config: dict[str, Any], logger: Any, account_id: int, request: _RetryRequest) -> float | None:
    """Runs one requested pass and records the account's submission state. Returns
    the backoff in seconds when Last.fm failed."""
    summary = {"pending_before": 0, "attempted": 0, "succeeded": 0, "failed": 0, "pending_after": 0}
    error = ""
    retry_in = None
    try:
        result = retry_pending_lastfm_scrobbles(
            config, account_id=account_id, library_ids=request.library_ids,
            reauthenticated=request.reauthenticated, bypass_backoff=request.bypass_backoff,
        )
        summary, retry_in = result.summary, result.retry_in_seconds
        if summary["failed"] or summary["pending_after"]:
            error = SUBMISSION_INCOMPLETE
    except Exception as exc:
        # The account must never stay "running": any failure ends its pass as failed.
        summary, error = getattr(exc, "summary", summary), SUBMISSION_FAILED
    with _WORKER_LOCK:
        if account_id in _REQUESTS:
            _SUBMISSIONS[account_id] = {"state": "queued", "error": ""}
        else:
            _SUBMISSIONS[account_id] = {"state": "failed" if error else "idle", "error": error}
    if error and request.history_scope is not None:
        log_app_event(
            config,
            logger,
            "Last.fm pending scrobble submission failed",
            level="error",
            history=True,
            history_scope=request.history_scope,
            integration="Last.fm",
            status="failed",
            failure_stage="submission",
            error=error,
            **{key: int(summary.get(key) or 0) for key in (
                "attempted", "succeeded", "failed", "pending_before", "pending_after",
            )},
        )
    return retry_in


def _run_periodic_pass(config: dict[str, Any], logger: Any) -> float | None:
    """Sends every account's due listens when any is waiting. Returns the seconds until
    the next waiting listen is due, or None when nothing waits."""
    try:
        # With nothing to send this is one query and no Last.fm call.
        if not lastfm_api_enabled(config) or not has_sendable_scrobbles(config):
            return None
        result = retry_pending_lastfm_scrobbles(config)
    except Exception as exc:
        log_app_event(config, logger, "Last.fm retry worker failed", level="error", error=str(exc))
        return None
    summary = result.summary
    if summary["attempted"]:
        log_app_event(
            config,
            logger,
            "Last.fm retry pass completed",
            attempted=summary["attempted"],
            succeeded=summary["succeeded"],
            failed=summary["failed"],
            pending_after=summary["pending_after"],
        )
    return result.retry_in_seconds


def retry_delay_with_jitter(seconds: float) -> float:
    """A scheduled retry waits its backoff plus up to 20% more, never less."""
    return seconds * (1 + random.uniform(0, _RETRY_JITTER))


def wake_lastfm_retry_worker() -> None:
    """A listen was left unsent: the worker checks at once, and sends it when its backoff allows."""
    global _CHECK_REQUESTED
    with _WORKER_LOCK:
        _CHECK_REQUESTED = True
        if _WORKER_WAKE_EVENT is not None:
            _WORKER_WAKE_EVENT.set()


def _take_check_request() -> bool:
    global _CHECK_REQUESTED
    with _WORKER_LOCK:
        requested, _CHECK_REQUESTED = _CHECK_REQUESTED, False
        return requested


def start_lastfm_retry_worker(app) -> None:
    """Starts the one worker that sends waiting scrobbles on its own: at start-up, when a
    listen is left unsent or Submit asks, and after each backoff until none waits."""
    config = app.config
    logger = app.logger

    global _WORKER_THREAD, _WORKER_APP_KEY, _WORKER_STOP_EVENT, _WORKER_WAKE_EVENT
    app_key = str(config.get("DATA_DIR") or "")
    with _WORKER_LOCK:
        if (
            _WORKER_THREAD
            and _WORKER_THREAD.is_alive()
            and _WORKER_APP_KEY == app_key
            and (_WORKER_STOP_EVENT is None or not _WORKER_STOP_EVENT.is_set())
        ):
            return

        if _WORKER_STOP_EVENT is not None:
            _WORKER_STOP_EVENT.set()
        if _WORKER_WAKE_EVENT is not None:
            _WORKER_WAKE_EVENT.set()

        stop_event = threading.Event()
        wake_event = threading.Event()

        def worker() -> None:
            next_check = time.monotonic()
            while not stop_event.is_set():
                if _take_check_request():
                    next_check = time.monotonic()
                request = _take_request()
                if request is not None:
                    retry_in = _run_requested_pass(config, logger, *request)
                    if retry_in is not None:
                        # Submit resets the backoff; what it left waiting is due after its own.
                        next_check = min(next_check, time.monotonic() + retry_delay_with_jitter(retry_in))
                    continue
                now = time.monotonic()
                if now < next_check:
                    wake_event.wait(next_check - now)
                    wake_event.clear()
                    continue
                retry_in = _run_periodic_pass(config, logger)
                next_check = time.monotonic() + (
                    _IDLE_CHECK_SECONDS if retry_in is None else retry_delay_with_jitter(retry_in)
                )

        _WORKER_APP_KEY = app_key
        _WORKER_STOP_EVENT = stop_event
        _WORKER_WAKE_EVENT = wake_event
        thread = _WORKER_THREAD = threading.Thread(
            target=worker,
            name="albumhaven-lastfm-retry",
            daemon=True,
        )
    # Started outside the lock, which the worker takes to read its requests.
    thread.start()


def stop_lastfm_retry_worker(app=None, *, wait: bool = False, timeout: float = 5.0) -> bool:
    global _WORKER_THREAD, _WORKER_APP_KEY, _WORKER_STOP_EVENT, _WORKER_WAKE_EVENT

    app_key = str(app.config.get("DATA_DIR") or "") if app is not None else ""
    thread: threading.Thread | None = None
    with _WORKER_LOCK:
        if app is not None and app_key != _WORKER_APP_KEY:
            return False
        if _WORKER_STOP_EVENT is None:
            return False

        _WORKER_STOP_EVENT.set()
        if _WORKER_WAKE_EVENT is not None:
            _WORKER_WAKE_EVENT.set()
        thread = _WORKER_THREAD

    if wait and thread is not None:
        thread.join(timeout=timeout)

    with _WORKER_LOCK:
        if _WORKER_THREAD is thread and (thread is None or not thread.is_alive()):
            _WORKER_THREAD = None
            _WORKER_APP_KEY = ""
            _WORKER_STOP_EVENT = None
            _WORKER_WAKE_EVENT = None

    return True
