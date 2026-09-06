from __future__ import annotations

from typing import Any

from music_app.services.listen_history import load_pending_scrobble_entries


def pending_scrobble_count(config: dict[str, Any]) -> int:
    return len(load_pending_scrobble_entries(config, limit=1_000_000))


def start_lastfm_retry_worker(_app: object) -> None:
    """Fail closed for callers that have not migrated to the durable worker."""

    raise RuntimeError("the process-local Last.fm retry daemon has been retired")


def stop_lastfm_retry_worker(
    _app: object | None = None, *, wait: bool = False, timeout: float = 5.0
) -> bool:
    """Report that no process-local retry daemon exists."""

    del wait, timeout
    return False


__all__ = ["pending_scrobble_count"]
