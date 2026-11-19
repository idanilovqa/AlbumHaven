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

A listen whose submission outcome is unknown (a lost or unclear answer, or a
crash after its claim) is never sent again blindly. Thirty minutes after its
submission started, a pass looks it up among the account's scrobbles on Last.fm,
in batches of up to 50 listens, reading only the hours around their timestamps.
Listed (the same second and the same artist or track, each scrobble standing for
one listen), it is accepted; not listed, it returns to the send queue, as often
as it takes. Its result is stored under the same locks as a submission, and only
while the listen is still unchanged since it was loaded.
"""
from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import logging
import operator
import random
import threading
import time
from typing import Any

from music_app.services.app_logging import log_app_event
from music_app.services.lastfm import (
    LASTFM_SCROBBLE_BATCH_LIMIT,
    LastfmError,
    LastfmSession,
    get_lastfm_scrobbles_between,
    lastfm_api_enabled,
    load_saved_lastfm_sessions,
    scrobble_tracks,
)
from music_app.services.lastfm_listen_sync import record_retry_results
from music_app.services.lastfm_sync_bridge import (
    attempting_updates,
    failed_batch_disposition,
    failed_verification_updates,
    is_same_scrobble,
    listen_scrobble_identity,
    plan_pending_scrobble,
    scrobble_attempt_updates,
    scrobble_due_at,
    scrobble_identity,
    scrobble_retry_delay_seconds,
    scrobble_verification_due,
    scrobble_verification_due_at,
    verified_scrobble_updates,
)
from music_app.services.listen_history import (
    build_listen_history_status_counts,
    has_sendable_scrobbles,
    is_pending_scrobble_entry,
    is_unverified_scrobble_entry,
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
# A lookup reads the account's scrobbles in windows of at most an hour around a batch's listens,
# at most 15 pages of 200 each: Last.fm takes at most 2,800 scrobbles a day, 14 such pages.
_VERIFICATION_WINDOW_SECONDS = 60 * 60
_VERIFICATION_MAX_PAGES = 15
# Each scheduled retry waits up to this much longer, so passes do not align with other clients.
_RETRY_JITTER = 0.2
_RETRY_LOCK = threading.Lock()
_WORKER_LOCK = threading.Lock()
_WORKER_THREAD: threading.Thread | None = None
_WORKER_APP_KEY = ""
_WORKER_STOP_EVENT: threading.Event | None = None
_WORKER_WAKE_EVENT: threading.Event | None = None
# Requested passes by account, each account's running pass, and its latest
# submission state. All are guarded by _WORKER_LOCK.
_REQUESTS: dict[int, "_RetryRequest"] = {}
_RUNNING: dict[int, "_RetryRequest"] = {}
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

    def covers(self, other: "_RetryRequest") -> bool:
        """Whether this pass already sends everything [other] asks for."""
        return (
            (self.library_ids is None or (other.library_ids is not None and other.library_ids <= self.library_ids))
            and (self.reauthenticated or not other.reauthenticated)
            and (self.bypass_backoff or not other.bypass_backoff)
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

    Returns the account's submission state. While a pass that already covers the
    library runs, Submit starts nothing."""
    return _queue_request(scope.account_id, _RetryRequest(
        library_ids=frozenset({scope.library_id}), bypass_backoff=True, history_scope=scope,
    ))


def request_lastfm_reconnect_retry(account_id: int) -> str:
    """After a reconnection, retries the account's scrobbles that were waiting for it."""
    return _queue_request(account_id, _RetryRequest(library_ids=None, reauthenticated=True))


def _queue_request(account_id: int, request: _RetryRequest) -> str:
    """Queues a background pass for one account and wakes the worker; returns its state.

    While the account's pass runs, a request it already covers starts nothing;
    any other (another library, a reconnection) is queued to run next."""
    with _WORKER_LOCK:
        state = _SUBMISSIONS.get(account_id, {}).get("state")
        running = _RUNNING.get(account_id)
        if state == "running" and running is not None and running.covers(request):
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
    """Looks up the listens in scope whose outcome is unknown, then sends the pending
    scrobbles, each in batches of up to 50 per account.

    A failing Last.fm stops the pass; an account it asks to reconnect only stops that account's batches."""
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
                loaded = load_pending_scrobble_entries(
                    config,
                    limit=None,
                    connection=connection,
                    include_unverified=True,
                    eligible=lambda item: (
                        (account_id is None or item.account_id == account_id)
                        and (library_ids is None or item.library_id in library_ids)
                    ),
                )
                sessions = load_saved_lastfm_sessions(connection, {item.account_id for item in loaded})
                loaded = [item for item in loaded if item.account_id in sessions]
                pending = [item for item in loaded if is_pending_scrobble_entry(item.entry)]
                summary["pending_before"] = summary["pending_after"] = len(pending)
                now = datetime.now(timezone.utc)
                latest = {item.row_id: item for item in loaded}

                def store(after: PendingListenEntry) -> None:
                    latest[after.row_id] = after
                    if after.entry.get("measurement_version") != MEASURED_VERSION:
                        pending_changes[str(after.entry["id"])] = (
                            after.entry if is_pending_scrobble_entry(after.entry) else None
                        )

                # Accounts Last.fm asked to reconnect: their other listens wait for the reconnection.
                revoked: set[int] = set()
                # Accounts whose lookup Last.fm refused (a renamed user, say): their other lookups
                # wait for the backoff, while their sends and every other account carry on.
                refused: set[int] = set()
                # Set when Last.fm is failing: the pass stops, and later batches wait for its backoff.
                stopped = False
                for batch in _account_batches(
                    [item for item in loaded if is_unverified_scrobble_entry(item.entry)],
                    due=lambda entry: scrobble_verification_due(
                        entry, now=now, reauthenticated=reauthenticated, bypass_backoff=bypass_backoff),
                ):
                    if batch[0].account_id in revoked | refused:
                        continue
                    stored, retry_in, error = _verify_batch(
                        config, connection, batch, session=sessions[batch[0].account_id], now=now,
                    )
                    for after in stored:
                        store(after)
                        _count_verification(summary, scope_summaries, after)
                        if is_pending_scrobble_entry(after.entry):
                            pending.append(after)
                    if error is not None and error.reauthentication_required:
                        revoked.add(batch[0].account_id)
                    elif error is not None and not error.retryable:
                        refused.add(batch[0].account_id)
                    elif error is not None:
                        result.retry_in_seconds, stopped = retry_in, True
                        break
                for batch in () if stopped else _account_batches(pending, due=lambda entry: plan_pending_scrobble(
                    entry, now=now, reauthenticated=reauthenticated, bypass_backoff=bypass_backoff,
                ) is not None):
                    if batch[0].account_id in revoked:
                        continue
                    stored, retry_in, error = _submit_batch(
                        config, connection, batch, session=sessions[batch[0].account_id],
                        reauthenticated=reauthenticated, bypass_backoff=bypass_backoff,
                    )
                    for before, after, attempted in stored:
                        store(after)
                        _count_result(summary, scope_summaries, before, after, attempted=attempted)
                    if error is not None and error.reauthentication_required:
                        revoked.add(batch[0].account_id)
                    elif error is not None:
                        result.retry_in_seconds, stopped = retry_in, True
                        break
                if not stopped:
                    result.retry_in_seconds = _seconds_until_next_due(
                        (item.entry for item in latest.values() if item.account_id not in revoked), now=now,
                    )
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
    """Seconds until the earliest listen still waiting may be sent or looked up; None when none waits.

    A listen that needs its account reconnected waits for the reconnection instead."""
    due = [
        scrobble_due_at(entry, now=now) if is_pending_scrobble_entry(entry)
        else scrobble_verification_due_at(entry, now=now)
        for entry in entries
        if (is_pending_scrobble_entry(entry) or is_unverified_scrobble_entry(entry))
        and not entry.get("scrobble_reauthentication_required")
    ]
    return max(0.0, (min(due) - now).total_seconds()) if due else None


def _account_batches(
    items: list[PendingListenEntry], *, due: Callable[[dict[str, object]], bool],
) -> Iterator[list[PendingListenEntry]]:
    """Each account's listens whose next step is ``due``, in batches of up to 50."""
    by_account: dict[int, list[PendingListenEntry]] = {}
    for item in items:
        if due(item.entry):
            by_account.setdefault(item.account_id, []).append(item)
    for account_items in by_account.values():
        for start in range(0, len(account_items), LASTFM_SCROBBLE_BATCH_LIMIT):
            yield account_items[start:start + LASTFM_SCROBBLE_BATCH_LIMIT]


def _verify_batch(
    config: dict[str, Any],
    connection: Any,
    batch: list[PendingListenEntry],
    *,
    session: LastfmSession,
    now: datetime,
) -> tuple[list[PendingListenEntry], int | None, LastfmError | None]:
    """Looks a batch of listens whose outcome is unknown up on Last.fm, then stores every
    result in one transaction. Returns each stored listen and, when Last.fm could not be
    read, the backoff in seconds and the error."""
    listed: set[int] = set()
    unread: set[int] = set()
    failure = None
    try:
        for window in _verification_windows(batch):
            found, complete = _listed_scrobbles(config, session, window)
            listens = [(item, listen_scrobble_identity(item.entry)) for _timestamp, item in window]
            # A listed scrobble accounts for one listen only, so two listens in the same second
            # never both rest on it; exact names are matched before corrected ones.
            for matches in (operator.eq, is_same_scrobble):
                for item, listen in listens:
                    scrobbles = found.get(listen[0], [])
                    match = next((scrobble for scrobble in scrobbles if matches(listen, scrobble)), None)
                    if match is not None and item.row_id not in listed:
                        scrobbles.remove(match)
                        listed.add(item.row_id)
            if not complete:
                unread.update(item.row_id for item, _listen in listens if item.row_id not in listed)
    except LastfmError as error:
        failure = error
    loaded = {item.row_id: item.entry for item in batch}
    stored = []
    with connection.transaction():
        for item in lock_pending_entries(connection, batch).values():
            # A submitter or another lookup may have handled the listen since it was loaded.
            if item.entry != loaded[item.row_id]:
                continue
            if item.row_id in listed or (failure is None and item.row_id not in unread):
                updates = verified_scrobble_updates(item.entry, listed=item.row_id in listed, verified_at=now)
            else:
                updates = failed_verification_updates(
                    item.entry, looked_up_at=now,
                    reauthentication_required=failure is not None and failure.reauthentication_required,
                )
            stored.append(replace(item, entry={**item.entry, **updates}))
        write_listen_entries(connection, stored)
    retry_in = None
    if failure is not None:
        failures = max(int(entry.get("scrobble_verification_failures") or 0) + 1 for entry in loaded.values())
        retry_in = max(scrobble_retry_delay_seconds(failures), failure.retry_after_seconds or 0)
    return stored, retry_in, failure


def _verification_windows(batch: list[PendingListenEntry]) -> list[list[tuple[int, PendingListenEntry]]]:
    """The batch's listens with their timestamps, grouped into windows spanning at most an hour.

    A listen without a timestamp cannot be on Last.fm: it is left out, so it counts as not listed
    and the send queue fails it as invalid."""
    windows: list[list[tuple[int, PendingListenEntry]]] = []
    timed = ((listen_scrobble_identity(item.entry)[0], item) for item in batch)
    for timestamp, item in sorted((pair for pair in timed if pair[0] > 0), key=lambda pair: pair[0]):
        if windows and timestamp - windows[-1][0][0] <= _VERIFICATION_WINDOW_SECONDS:
            windows[-1].append((timestamp, item))
        else:
            windows.append([(timestamp, item)])
    return windows


def _listed_scrobbles(
    config: dict[str, Any], session: LastfmSession, window: list[tuple[int, PendingListenEntry]],
) -> tuple[dict[int, list[tuple[int, str, str]]], bool]:
    """The scrobbles Last.fm lists from the first to the last listen of a window, by their
    second, and whether it listed all of them within the page limit."""
    found: dict[int, list[tuple[int, str, str]]] = {}
    page = 1
    while True:
        scrobbles, pages = get_lastfm_scrobbles_between(
            config, session=session, after=window[0][0] - 1, before=window[-1][0] + 1, page=page,
        )
        for scrobble in scrobbles:
            identity = scrobble_identity(scrobble.timestamp, scrobble.artist, scrobble.track)
            found.setdefault(identity[0], []).append(identity)
        if page >= min(pages, _VERIFICATION_MAX_PAGES):
            return found, pages <= _VERIFICATION_MAX_PAGES
        page += 1


def _submit_batch(
    config: dict[str, Any],
    connection: Any,
    batch: list[PendingListenEntry],
    *,
    session: LastfmSession,
    reauthenticated: bool,
    bypass_backoff: bool,
) -> tuple[list[tuple[PendingListenEntry, PendingListenEntry, bool]], int | None, LastfmError | None]:
    """Claims, sends, and stores one batch. Returns each listen's entry before and
    after and whether it was sent, and, when the Last.fm call as a whole failed,
    the backoff in seconds and the error."""
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
                claimed.append(replace(item, entry={**item.entry, **attempting_updates(now)}))
        write_listen_entries(connection, claimed)
    if not sending:
        return stored, None, None
    retry_in = failure = None
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
        failure = error
        results = []
        for item, _payload in sending:
            retryable, state = failed_batch_disposition(error)
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
    return stored, retry_in, failure


def _count_result(
    summary: dict[str, int],
    scope_summaries: dict[tuple[int, int], dict[str, int]],
    before: PendingListenEntry,
    after: PendingListenEntry,
    *,
    attempted: bool,
) -> None:
    succeeded = bool(after.entry.get("scrobbled"))
    scope = _scope_counts(scope_summaries, after)
    for counts in (summary, scope):
        counts["attempted"] += int(attempted)
        counts["succeeded"] += int(succeeded)
        counts["failed"] += int(not succeeded)
    if is_pending_scrobble_entry(before.entry) and not is_pending_scrobble_entry(after.entry):
        summary["pending_after"] -= 1


def _count_verification(
    summary: dict[str, int], scope_summaries: dict[tuple[int, int], dict[str, int]], after: PendingListenEntry,
) -> None:
    """Counts a listen found on Last.fm, returned to the send queue, or, after a failed
    lookup, still unknown: that counts as failed, so Submit reports it as incomplete."""
    scope = _scope_counts(scope_summaries, after)
    if after.entry.get("scrobbled"):
        scope["verified_present"] += 1
    elif is_pending_scrobble_entry(after.entry):
        scope["verified_absent"] += 1
        summary["pending_after"] += 1
    else:
        scope["failed"] += 1
        summary["failed"] += 1


def _scope_counts(scope_summaries: dict[tuple[int, int], dict[str, int]], item: PendingListenEntry) -> dict[str, int]:
    return scope_summaries.setdefault((item.account_id, item.library_id), {
        "attempted": 0, "succeeded": 0, "failed": 0, "verified_present": 0, "verified_absent": 0,
    })


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
        request = _RUNNING[account_id] = _REQUESTS.pop(account_id)
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
        _RUNNING.pop(account_id, None)
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
