"""Privacy boundary for legacy pipelines executed by the durable worker."""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from typing import Any


_SAFE_ACTIONS = {
    "Cover lookup task started": "lookup_started",
    "Cover lookup service candidates collected": "service_candidates_collected",
    "Cover lookup Bandcamp search completed": "bandcamp_search_completed",
    "Cover lookup CAA search completed": "caa_search_completed",
    "Cover lookup Discogs search completed": "discogs_search_completed",
    "Cover lookup artist website search completed": "artist_website_search_completed",
    "Cover lookup provider deadline reached": "provider_deadline_reached",
    "Cover lookup task failed": "lookup_failed",
}
_SAFE_NUMERIC_FIELDS = frozenset(
    {
        "candidate_count",
        "downloaded",
        "downloaded_count",
        "failed",
        "failed_count",
        "manual_candidate_count",
        "processed",
        "processed_count",
        "skipped",
        "track_count",
    }
)
_SAFE_WORKER_LOGGER_PREFIXES = (
    "album_haven.jobs.",
    "music_app.jobs.",
    "scripts.run_jobs_worker",
)


class DurablePipelineLogger:
    """Expose a logger-shaped sink without forwarding legacy private fields."""

    def __init__(self, logger: Any, *, domain: str) -> None:
        self._logger = logger
        self._domain = str(domain).strip().casefold() or "pipeline"

    @property
    def handlers(self):
        return tuple(getattr(self._logger, "handlers", ()) or ())

    @property
    def propagate(self) -> bool:
        return bool(getattr(self._logger, "propagate", False))

    @property
    def parent(self):
        return getattr(self._logger, "parent", None)

    def isEnabledFor(self, level: int) -> bool:  # noqa: N802 - logging API shape
        enabled = getattr(self._logger, "isEnabledFor", None)
        return bool(enabled(level)) if callable(enabled) else True

    def log(self, level: int, message: object, *args: object, **kwargs: object) -> None:
        del args, kwargs
        payload: dict[str, object] = {
            "action": f"durable_{self._domain}_pipeline_event",
            "source_action": "legacy_event",
        }
        try:
            candidate = json.loads(str(message))
        except (TypeError, ValueError, json.JSONDecodeError):
            candidate = None
        if isinstance(candidate, Mapping):
            payload["source_action"] = _SAFE_ACTIONS.get(
                str(candidate.get("action") or ""), "legacy_event"
            )
            for key in _SAFE_NUMERIC_FIELDS:
                value = candidate.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    payload[key] = value
        emit = getattr(self._logger, "log", None)
        if callable(emit):
            emit(int(level), json.dumps(payload, sort_keys=True))

    def debug(self, message: object, *args: object, **kwargs: object) -> None:
        self.log(logging.DEBUG, message, *args, **kwargs)

    def verbose(self, message: object, *args: object, **kwargs: object) -> None:
        self.log(int(getattr(logging, "VERBOSE", logging.DEBUG)), message, *args, **kwargs)

    def info(self, message: object, *args: object, **kwargs: object) -> None:
        self.log(logging.INFO, message, *args, **kwargs)

    def warning(self, message: object, *args: object, **kwargs: object) -> None:
        self.log(logging.WARNING, message, *args, **kwargs)

    def error(self, message: object, *args: object, **kwargs: object) -> None:
        self.log(logging.ERROR, message, *args, **kwargs)

    def critical(self, message: object, *args: object, **kwargs: object) -> None:
        self.log(logging.CRITICAL, message, *args, **kwargs)

    def exception(self, message: object, *args: object, **kwargs: object) -> None:
        self.log(logging.ERROR, message, *args, **kwargs)


def install_durable_worker_logging_boundary():
    """Sanitize every non-worker LogRecord at creation, including child threads."""

    previous_factory = logging.getLogRecordFactory()
    if getattr(previous_factory, "_album_haven_durable_boundary", False):
        return previous_factory

    def safe_factory(*args: object, **kwargs: object):
        record = previous_factory(*args, **kwargs)
        if str(record.name).startswith(_SAFE_WORKER_LOGGER_PREFIXES):
            return record
        logger_name = str(record.name).casefold()
        logger_group = (
            "cover"
            if "cover" in logger_name
            else "scan"
            if "scan" in logger_name or "library" in logger_name
            else "dependency"
        )
        record.msg = "durable_legacy_pipeline_event logger_group=%s level=%s"
        record.args = (logger_group, str(record.levelname).casefold())
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        return record

    safe_factory._album_haven_durable_boundary = True  # type: ignore[attr-defined]
    logging.setLogRecordFactory(safe_factory)
    return previous_factory


__all__ = ["DurablePipelineLogger", "install_durable_worker_logging_boundary"]
