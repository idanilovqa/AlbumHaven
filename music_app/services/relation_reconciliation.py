"""Background reconciliation of the scoped relation index (FTC-GALLERY-STARTUP-005Q).

When start-up readiness finds the index needs reconciliation, browsing serves the stored relation rows and tag
edits refuse with a readable message. This owner then replays the journaled albums one album at a time through
``prepare_relation_compatibility`` and, once that holds, runs start-up readiness again so edits work.

Start-up readiness starts it, and a save's failed journal replay hands it over (never a request's own work).
It never makes a whole-library pass: a missing
projection with nothing journaled needs the explicit initialization, which stays with the owner. One owner across
processes: the preparation takes the relation projection advisory lock. It is cancellable at shutdown and
retries a failure with backoff.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Mapping, Sequence

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
        prepare: Callable[..., object] | None = None,
        logger: logging.Logger | None = None,
        backoff: Sequence[float] = RETRY_BACKOFF_SECONDS,
    ) -> None:
        self._config = config
        self._reconciled = reconciled
        self._failed = failed
        self._parked = parked
        self._prepare = prepare
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
        """One replay. True when the index no longer needs reconciliation; parked cases raise.

        Nothing due (a start-up replay already caught up) costs three keyed reads. Proving missing or changed
        compatibility evidence reads the published relation snapshot once; journaled albums replay by key.
        """
        from music_app.services import scoped_relation_projection as scoped

        if self._prepare is None and not scoped.relation_reconciliation_due(self._config):
            return True
        prepare = self._prepare or scoped.prepare_relation_compatibility
        prepare(self._config, cancel_requested=self._stop)
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
                return
            except Exception as error:
                wait = self._backoff[min(attempt, len(self._backoff) - 1)]
                attempt += 1
                self._logger.exception("Relation reconciliation failed; retrying in %.0f s.", wait)
                if self._failed is not None:
                    self._failed(f"Library relationships are still being reconciled (attempt {attempt} failed: "
                                 f"{type(error).__name__}); retrying in {wait:.0f} s.")
                if self._stop.wait(wait):
                    return
                continue
            self._logger.info("Relation reconciliation replayed the journaled albums; tag edits may resume.")
            if not self._stop.is_set():
                self._reconciled()
            return
