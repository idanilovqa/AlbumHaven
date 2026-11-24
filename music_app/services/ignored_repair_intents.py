"""Applies the ignored-repair intents a held publication kept back (deadlock part 3).

An Ignore or Unignore that cannot take the inventory publication lock within its bound keeps a durable
intent and answers at once (rule_state_postgres). This drain waits for the publication to end, then applies
the kept intents in order under the lock, one transaction, and drops them. Its work is the pending intents
only; with none it reads one indexed, empty range and stops.
"""
from __future__ import annotations

import logging
from collections.abc import Mapping
from threading import Lock, Timer

from music_app.services.runtime_shutdown import create_daemon_executor

_LOGGER = logging.getLogger(__name__)
# Passes a drain may fail as a whole before the intents it could not apply are failed (6.5: never pending forever).
DRAIN_ATTEMPTS = 3
# An intent still pending this long after a drain was due with the lock free is failed as 'stuck' (config:
# ALBUM_HAVEN_IGNORE_INTENT_STALL_SECONDS).
STALL_SECONDS = 600
# A failed pass is tried again after this long, so pending intents never wait on the next write or restart.
DRAIN_RETRY_SECONDS = 60
_EXECUTOR = create_daemon_executor(max_workers=1, thread_name_prefix="albumhaven-ignored-repair-intents")
_QUEUED: set[str] = set()
_QUEUED_LOCK = Lock()


def drain(config: Mapping[str, object]) -> int:
    """Wait for the inventory publication lock, then apply every kept intent. Returns how many it applied."""
    from music_app.services.postgres_connections import session_connection
    from music_app.services.relation_projection_postgres import inventory_publication_advisory_lock_sql
    from music_app.services.rule_state_postgres import apply_pending_ignored_repair_intents

    from music_app.services.library_browse_postgres import invalidate_postgres_utility_projection_cache

    database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "")
    # A publication can hold the lock for minutes: this waits on a connection no request will reuse.
    with session_connection(database_url) as connection:
        with connection.transaction():
            _report_stuck(connection, config)
        with connection.transaction():
            connection.execute(inventory_publication_advisory_lock_sql())
            applied = apply_pending_ignored_repair_intents(connection)
    # The Rules showed these as pending; now they are stored, or failed (as after a direct write).
    invalidate_postgres_utility_projection_cache(database_url=database_url, kinds=("rules",))
    return applied


def _stall_seconds(config: Mapping[str, object]) -> float:
    try:
        return max(0.0, float(config.get("ALBUM_HAVEN_IGNORE_INTENT_STALL_SECONDS", STALL_SECONDS)))
    except (TypeError, ValueError):
        return float(STALL_SECONDS)


def _report_stuck(connection, config: Mapping[str, object]) -> None:
    from music_app.services.rule_state_postgres import fail_stuck_ignored_repair_intents

    from music_app.services.library_browse_postgres import invalidate_postgres_utility_projection_cache

    stuck = fail_stuck_ignored_repair_intents(connection, _stall_seconds(config))
    if stuck:
        _LOGGER.warning("Ignored-repair intents were still waiting after the library finished updating and were "
                        "not applied (rules %s).", ", ".join(stuck))
        invalidate_postgres_utility_projection_cache(
            database_url=str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""), kinds=("rules",))


def _schedule_retry(config: Mapping[str, object]) -> None:
    timer = Timer(DRAIN_RETRY_SECONDS, queue_drain, args=(dict(config),))
    timer.daemon = True
    timer.start()


def queue_drain(config: Mapping[str, object]) -> None:
    """Drain in the background (after a write kept an intent, and at startup for intents left over)."""
    database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "")
    if not database_url:
        return
    with _QUEUED_LOCK:
        if database_url in _QUEUED:
            return
        _QUEUED.add(database_url)
    _EXECUTOR.submit(_drain_queued, dict(config), database_url)


def _drain_queued(config: dict[str, object], database_url: str) -> None:
    with _QUEUED_LOCK:
        # An intent kept from now on queues another pass.
        _QUEUED.discard(database_url)
    try:
        drain(config)
    except Exception as error:
        _LOGGER.warning(f"Applying kept ignored-repair intents failed; trying again in {DRAIN_RETRY_SECONDS} s.",
                        exc_info=True)
        _count_failed_attempt(config, database_url, error)
        _schedule_retry(config)


def _count_failed_attempt(config: Mapping[str, object], database_url: str, error: Exception) -> None:
    """One failed pass counts against every pending intent; after DRAIN_ATTEMPTS they are failed and logged."""
    from music_app.services.library_browse_postgres import invalidate_postgres_utility_projection_cache
    from music_app.services.postgres_connections import leased_connection
    from music_app.services.rule_state_postgres import fail_ignored_repair_intents_after_a_failed_drain

    try:
        with leased_connection(database_url) as connection:
            # The drain's failed end: the stuck check too, and the clock for intents now due.
            _report_stuck(connection, config)
            failed = fail_ignored_repair_intents_after_a_failed_drain(connection, error, DRAIN_ATTEMPTS)
    except Exception as counting_error:  # the pass's own traceback is already logged
        _LOGGER.warning("Counting a failed ignored-repair drain failed too: %s", counting_error)
        return
    if failed:
        _LOGGER.warning("Ignored-repair intents failed after %d drain attempts and were not applied (rules %s).",
                        DRAIN_ATTEMPTS, ", ".join(failed))
        invalidate_postgres_utility_projection_cache(database_url=database_url, kinds=("rules",))


def wait_for_background_work(timeout: float = 120) -> None:
    """Tests: wait until queued drains have finished."""
    _EXECUTOR.submit(lambda: None).result(timeout=timeout)
