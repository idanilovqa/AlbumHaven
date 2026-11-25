"""Background reconciliation of the scoped relation index (FTC-GALLERY-STARTUP-005Q).

When start-up readiness finds the index needs reconciliation, browsing serves the stored relation rows and tag
edits refuse with a readable message. This owner then replays the journaled albums one album at a time through
``prepare_relation_compatibility`` and, once that holds, runs start-up readiness again so edits work.

It runs only from the start-up owner path, never from a request, and never makes a whole-library pass: a missing
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


class RelationReconciliationOwner:
    def __init__(
        self,
        config: Mapping[str, object],
        *,
        reconciled: Callable[[], None],
        prepare: Callable[..., object] | None = None,
        logger: logging.Logger | None = None,
        backoff: Sequence[float] = RETRY_BACKOFF_SECONDS,
    ) -> None:
        self._config = config
        self._reconciled = reconciled
        self._prepare = prepare
        self._logger = logger or _LOGGER
        self._backoff = tuple(backoff) or (30.0,)
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def request(self) -> bool:
        """Start the replay once (start-up owner path only). Returns whether this call started it."""
        with self._lock:
            if self._thread is not None or self._stop.is_set():
                return False
            self._thread = threading.Thread(target=self._run, name="albumhaven-relation-reconciliation", daemon=True)
            self._thread.start()
            return True

    def stop(self, timeout: float = 30.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout)

    def run_once(self) -> bool:
        """One replay. True when the index no longer needs reconciliation; parked cases raise."""
        from music_app.services import scoped_relation_projection as scoped

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
            except RelationInitializationRequired as parked:
                self._logger.warning("Relation reconciliation needs the explicit initialization: %s", parked)
                return
            except Exception:
                wait = self._backoff[min(attempt, len(self._backoff) - 1)]
                attempt += 1
                self._logger.exception("Relation reconciliation failed; retrying in %.0f s.", wait)
                if self._stop.wait(wait):
                    return
                continue
            self._logger.info("Relation reconciliation replayed the journaled albums; tag edits may resume.")
            if not self._stop.is_set():
                self._reconciled()
            return
