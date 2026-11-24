"""Applies the ignored-repair intents a held publication kept back (deadlock part 3).

An Ignore or Unignore that cannot take the inventory publication lock within its bound keeps a durable
intent and answers at once (rule_state_postgres). This drain waits for the publication to end, then applies
the kept intents in order under the lock, one transaction, and drops them. Its work is the pending intents
only; with none it reads one indexed, empty range and stops.
"""
from __future__ import annotations

import logging
from collections.abc import Mapping
from threading import Lock

from music_app.services.runtime_shutdown import create_daemon_executor

_LOGGER = logging.getLogger(__name__)
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
            connection.execute(inventory_publication_advisory_lock_sql())
            applied = apply_pending_ignored_repair_intents(connection)
    if applied:
        # The Rules projection showed these as pending; now they are stored (as after a direct write).
        invalidate_postgres_utility_projection_cache(database_url=database_url, kinds=("rules",))
    return applied


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
    except Exception:
        _LOGGER.warning("Applying kept ignored-repair intents failed; the next write or startup retries.",
                        exc_info=True)


def wait_for_background_work(timeout: float = 120) -> None:
    """Tests: wait until queued drains have finished."""
    _EXECUTOR.submit(lambda: None).result(timeout=timeout)
