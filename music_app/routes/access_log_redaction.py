"""Keeps credentials carried in URL paths out of the server's access log."""

from __future__ import annotations

import logging


class _RedactPathCredentials(logging.Filter):
    """Records a path under a registered prefix as that prefix and ``[redacted]``."""

    def __init__(self):
        super().__init__()
        self.prefixes: set[str] = set()

    def _redact(self, arg):
        if isinstance(arg, str):
            for prefix in self.prefixes:
                if prefix in arg:
                    return f"{arg.split(prefix, 1)[0]}{prefix}[redacted]"
        return arg

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(self._redact(arg) for arg in record.args)
        return True


_ACCESS_LOGGER = logging.getLogger("uvicorn.access")


def redact_access_log_paths(prefix: str) -> None:
    """Every access-log path starting with ``prefix`` hides the rest, which is a credential."""
    redaction = next((item for item in _ACCESS_LOGGER.filters if isinstance(item, _RedactPathCredentials)), None)
    if redaction is None:
        redaction = _RedactPathCredentials()
        _ACCESS_LOGGER.addFilter(redaction)
    redaction.prefixes.add(prefix)
