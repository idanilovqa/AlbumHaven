from __future__ import annotations

import json
import logging
import re
import threading
import time
from pathlib import Path

from music_app.services.log_history import append_log_history

VERBOSE_LEVEL = 15
_FLUSH_LOCK = threading.Lock()
_LAST_FLUSH_AT = 0.0
_SECRET_CONFIG_KEY_PATTERN = re.compile(
    r"(?:password|secret|token|credential|authorization|cookie|api[_-]?key|database_url)",
    re.IGNORECASE,
)
_CREDENTIAL_URL_PATTERN = re.compile(
    r"\b(?P<scheme>[a-z][a-z0-9+.-]*://)(?P<credentials>[^@\s/]+)@",
    re.IGNORECASE,
)
_SECRET_ASSIGNMENT_PATTERN = re.compile(
    r"\b(?P<key>password|secret|token|credential|authorization|cookie|api[_-]?key)"
    r"\s*[:=]\s*(?P<value>[^\s,;]+)",
    re.IGNORECASE,
)


def ensure_verbose_logging_level() -> None:
    if getattr(logging, "VERBOSE", None) == VERBOSE_LEVEL:
        return
    logging.VERBOSE = VERBOSE_LEVEL  # type: ignore[attr-defined]
    logging.addLevelName(VERBOSE_LEVEL, "VERBOSE")

    def verbose(self, message, *args, **kwargs):
        if self.isEnabledFor(VERBOSE_LEVEL):
            self._log(VERBOSE_LEVEL, message, args, **kwargs)

    logging.Logger.verbose = verbose  # type: ignore[attr-defined]


def configure_app_logging(app) -> None:
    ensure_verbose_logging_level()

    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    root_logger = logging.getLogger()
    root_logger.setLevel(VERBOSE_LEVEL)

    has_console_handler = any(
        isinstance(handler, logging.StreamHandler)
        and not isinstance(handler, logging.FileHandler)
        for handler in root_logger.handlers
    )
    if not has_console_handler:
        console_handler = logging.StreamHandler()
        console_handler.setLevel(VERBOSE_LEVEL)
        console_handler.setFormatter(formatter)
        root_logger.addHandler(console_handler)

    app.logger.handlers.clear()
    app.logger.setLevel(VERBOSE_LEVEL)
    app.logger.propagate = True


def flush_log_handlers(logger: logging.Logger | None = None) -> None:
    target_logger = logger or logging.getLogger()
    seen_handlers: set[int] = set()
    current: logging.Logger | None = target_logger
    while current is not None:
        for handler in current.handlers:
            handler_id = id(handler)
            if handler_id in seen_handlers:
                continue
            seen_handlers.add(handler_id)
            try:
                handler.flush()
            except Exception:
                pass
        if not current.propagate:
            break
        current = current.parent


def flush_log_handlers_debounced(logger: logging.Logger | None = None, *, min_interval_seconds: float = 2.0) -> None:
    global _LAST_FLUSH_AT
    interval = max(0.1, float(min_interval_seconds or 2.0))
    now = time.monotonic()
    with _FLUSH_LOCK:
        if now - _LAST_FLUSH_AT < interval:
            return
        flush_log_handlers(logger)
        _LAST_FLUSH_AT = now


def _normalize_log_value(value: object) -> object:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (list, tuple, set)):
        return [_normalize_log_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _normalize_log_value(item) for key, item in value.items()}
    return str(value)


def _safe_history_write_error_message(exc: Exception, config: dict) -> str:
    message = str(exc)
    for key, value in config.items():
        if not _SECRET_CONFIG_KEY_PATTERN.search(str(key)):
            continue
        secret_value = str(value or "")
        if secret_value:
            message = message.replace(secret_value, "[redacted]")
    message = _CREDENTIAL_URL_PATTERN.sub(
        lambda match: f"{match.group('scheme')}[redacted]@",
        message,
    )
    return _SECRET_ASSIGNMENT_PATTERN.sub(
        lambda match: f"{match.group('key')}=[redacted]",
        message,
    )


def log_app_event(
    config: dict,
    logger: logging.Logger,
    action: str,
    *,
    level: str = "info",
    history: bool = False,
    **fields,
) -> None:
    payload = {"action": action}
    for key, value in fields.items():
        payload[str(key)] = _normalize_log_value(value)

    message = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    level_name = str(level or "info").upper()
    level_number = int(getattr(logging, level_name, logging.INFO))
    logger.log(level_number, message)

    if history:
        try:
            append_log_history(config, payload)
        except Exception as exc:
            logging.getLogger(__name__).warning(
                "Log history write failed action=%r error_type=%s error=%s; "
                "primary event retained without transient history capture.",
                action,
                type(exc).__name__,
                _safe_history_write_error_message(exc, config),
            )
