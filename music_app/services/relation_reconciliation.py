"""Background reconciliation of the scoped relation index (FTC-GALLERY-STARTUP-005Q).

When start-up readiness finds the index needs reconciliation, browsing serves the stored relation rows and tag
edits refuse with a readable message. This owner then runs start-up readiness again once it holds.

Start-up readiness starts it, and a save's failed journal replay hands it over (never a request's own work).
With the compatibility evidence current it replays the journaled albums by key, and retries a failure with
backoff. Only missing or outdated evidence runs the whole-library compatibility backfill, once per evidence
state with its progress in /status; a failed backfill parks (no retry). One owner across processes: both take
the relation projection advisory lock. It is cancellable at shutdown.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Mapping, Sequence

from music_app.services.app_logging import log_app_event
from music_app.services.log_history import resolve_media_host_history_scope

_LOGGER = logging.getLogger("music_app")
RETRY_BACKOFF_SECONDS: Sequence[float] = (30.0, 60.0, 120.0, 300.0, 600.0)
_OWNERS: dict[str, "RelationReconciliationOwner"] = {}
_OWNERS_LOCK = threading.Lock()


def request_relation_reconciliation(config: Mapping[str, object]) -> bool:
    """Hand a failed journal replay to this process's owner (it retries with its backoff)."""
    with _OWNERS_LOCK:
        owner = _OWNERS.get(str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""))
    return owner.request() if owner is not None else False


class RelationReconciliationOwner:
    def __init__(
        self,
        config: Mapping[str, object],
        *,
        reconciled: Callable[[], None],
        failed: Callable[[str], None] | None = None,
        parked: Callable[[str], None] | None = None,
        progress: Callable[[Mapping[str, object]], None] | None = None,
        history: Callable[[str, str], None] | None = None,
        logger: logging.Logger | None = None,
        backoff: Sequence[float] = RETRY_BACKOFF_SECONDS,
    ) -> None:
        self._config = config
        self._reconciled = reconciled
        self._failed = failed
        self._parked = parked
        self._progress = progress
        # Log History (owner, 11-25): one entry per failing streak or park, and one when it works again.
        self._history = history
        self._needs_recovery_entry = False
        self._logger = logger or _LOGGER
        self._backoff = tuple(backoff) or (30.0,)
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        # Set once a refusal only the explicit initialization reconciles was logged: no further run in this
        # process (no timer, no re-request from saves or readiness). A restart parks again with one log line.
        self._parked_reason: str | None = None
        with _OWNERS_LOCK:
            _OWNERS[str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "")] = self

    def request(self) -> bool:
        """Start a replay unless one is running or the owner stopped. Returns whether this call started it."""
        with self._lock:
            if (self._thread is not None and self._thread.is_alive()) or self._stop.is_set() or self._parked_reason:
                return False
            self._thread = threading.Thread(target=self._run, name="albumhaven-relation-reconciliation", daemon=True)
            self._thread.start()
            return True

    def retry(self) -> bool:
        """The owner's retry from a catch-up's Log History entry: run again now, including a parked backfill for
        the same evidence state. Never a second concurrent run."""
        from music_app.services import scoped_relation_projection as scoped

        with self._lock:
            if (self._thread is not None and self._thread.is_alive()) or self._stop.is_set():
                return False
            self._parked_reason = None
        scoped.forget_compatibility_backfill_attempt(self._config)
        return self.request()

    def stop(self, timeout: float = 30.0) -> None:
        self._stop.set()
        with _OWNERS_LOCK:
            key = str(self._config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "")
            if _OWNERS.get(key) is self:
                _OWNERS.pop(key)
        thread = self._thread
        if thread is not None:
            thread.join(timeout)

    def run_once(self) -> bool:
        """One pass. True when the index no longer needs reconciliation; parked cases raise.

        Deciding costs keyed reads only. Current evidence replays the journaled albums by key (no snapshot
        decode, no compatibility views); only missing or outdated evidence runs the one-time backfill.
        """
        from music_app.services import scoped_relation_projection as scoped

        plan = scoped.relation_reconciliation_plan(self._config)
        if plan["action"] == "replay":
            scoped.ensure_pending_relation_projection_ready(self._config, cancel_requested=self._stop, keyed_only=True)
        elif plan["action"] == "backfill":
            scoped.run_relation_compatibility_backfill(
                self._config, plan["evidence"], attempted=plan["attempted"], cancel_requested=self._stop,
                progress=self._progress)
        return True

    def _run(self) -> None:
        from music_app.services.relation_projection_postgres import RelationInitializationRequired

        attempt = 0
        while not self._stop.is_set():
            try:
                self.run_once()
            except InterruptedError:
                return
            except RelationInitializationRequired as refusal:
                # Parked, not retried: only the explicit initialization (the owner's decision) reconciles it.
                self._logger.warning("Relation reconciliation needs the explicit initialization: %s", refusal)
                self._parked_reason = str(refusal)
                if self._parked is not None:
                    self._parked(str(refusal))
                self._record("parked", str(refusal))
                return
            except Exception as error:
                wait = self._backoff[min(attempt, len(self._backoff) - 1)]
                attempt += 1
                self._logger.exception("Relation reconciliation failed; retrying in %.0f s.", wait)
                if self._failed is not None:
                    self._failed(f"Library relationships are still being reconciled (attempt {attempt} failed: "
                                 f"{type(error).__name__}); retrying in {wait:.0f} s.")
                if attempt == 1:
                    self._record("failed", f"{type(error).__name__}: {error}")
                if self._stop.wait(wait):
                    return
                continue
            self._logger.info("Relation reconciliation replayed the journaled albums; tag edits may resume.")
            if self._needs_recovery_entry:
                self._record("recovered", "")
            if not self._stop.is_set():
                self._reconciled()
            return

    def _record(self, event: str, message: str) -> None:
        self._needs_recovery_entry = event != "recovered"
        if self._history is None:
            return
        try:
            self._history(event, message)
        except Exception:
            self._logger.exception("Relation catch-up Log History entry could not be written.")


_HISTORY_ENTRIES = {
    "failed": ("Relation catch-up failed", "error"),
    "parked": ("Relation catch-up needs initialization", "error"),
    "recovered": ("Relation catch-up recovered", "success"),
}


def history_writer(config: Mapping[str, object], logger: logging.Logger) -> Callable[[str, str], None]:
    """The owner's Log History entries for the background relation catch-up (owner-only, like Log History)."""

    def write(event: str, message: str) -> None:
        action, level = _HISTORY_ENTRIES[event]
        fields = {"error": message, "retryable": True} if event != "recovered" else {}
        log_app_event(dict(config), logger, action, level=level, history=True,
                      history_scope=resolve_media_host_history_scope(config), source="relations",
                      event_type="relation_catch_up", **fields)

    return write
