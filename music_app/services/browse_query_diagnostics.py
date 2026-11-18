"""TEMPORARY CI diagnostics for FTC-OPS-016 (browse stalls after a scan). Remove before PR 80 merges.

Off unless GITHUB_ACTIONS=true or ALBUM_HAVEN_BROWSE_QUERY_DIAGNOSTICS=1. When on, a browse
statement slower than one second is logged with its wall time, the request thread's own
CPU and the whole process's CPU over the same span (a busy other thread holding the GIL
shows as process CPU the request thread did not spend), a once-a-second watchdog report of
the backend's wait event and blockers, what every other Python thread was running, and an
EXPLAIN (ANALYZE, BUFFERS) of the statement. Parameters are never logged.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
import traceback
from typing import Any

_logger = logging.getLogger("music_app.browse_query_diagnostics")
_SLOW_SECONDS = 1.0


def enabled() -> bool:
    # The app under CI's browser tests only; never inside the Python test suite.
    if "pytest" in sys.modules:
        return False
    return (os.environ.get("ALBUM_HAVEN_BROWSE_QUERY_DIAGNOSTICS") == "1"
            or os.environ.get("GITHUB_ACTIONS") == "true")


def _statement_name(sql: str) -> str:
    text = " ".join(str(sql).split())
    return text[:160]


def _other_threads() -> list[str]:
    me = threading.get_ident()
    names = {thread.ident: thread.name for thread in threading.enumerate()}
    lines = []
    for ident, frame in sys._current_frames().items():
        if ident == me:
            continue
        stack = traceback.extract_stack(frame)[-4:]
        where = " < ".join(f"{os.path.basename(item.filename)}:{item.lineno}:{item.name}" for item in reversed(stack))
        lines.append(f"{names.get(ident, ident)}: {where}")
    return lines


class _Watchdog:
    """Reports, once a second while a statement runs, what its backend waits on."""

    def __init__(self, database_url: str, backend_pid: int | None, name: str):
        self._url, self._pid, self._name = database_url, backend_pid, name
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name="browse-query-watchdog")

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *_exc):
        self._done.set()

    def _run(self) -> None:
        # One probe connection for the whole statement, opened only if it runs past a second.
        if self._done.wait(_SLOW_SECONDS):
            return
        try:
            import psycopg

            probe = psycopg.connect(self._url, connect_timeout=5, autocommit=True)
        except Exception as error:  # noqa: BLE001 - diagnostics never fail a request
            _logger.warning("BROWSE-DIAG probe unavailable: %r", error)
            return
        with probe:
            tick = 1
            while True:
                self._report(probe, tick)
                if self._done.wait(_SLOW_SECONDS):
                    return
                tick += 1

    def _report(self, probe: Any, tick: int) -> None:
        report: dict[str, Any] = {"statement": self._name, "seconds": tick, "threads": _other_threads()}
        try:
            row = probe.execute(
                "select state, wait_event_type, wait_event, pg_blocking_pids(pid)"
                " from pg_stat_activity where pid = %s", (self._pid,)).fetchone()
            report["backend"] = row
            blockers = list(row[3] or []) if row else []
            if blockers:
                report["blockers"] = probe.execute(
                    "select pid, state, wait_event_type, wait_event, left(query, 200)"
                    " from pg_stat_activity where pid = any(%s)", (blockers,)).fetchall()
            report["active"] = probe.execute(
                "select pid, state, wait_event_type, wait_event, round(extract(epoch from now() - query_start)::numeric, 1),"
                " left(regexp_replace(query, '\\s+', ' ', 'g'), 160)"
                " from pg_stat_activity where state <> 'idle' and pid <> pg_backend_pid()").fetchall()
        except Exception as error:  # noqa: BLE001
            report["probe_error"] = repr(error)
        _logger.warning("BROWSE-DIAG still running %s", report)


class DiagnosedConnection:
    """Wraps a browse connection; times each statement and explains slow ones."""

    def __init__(self, connection: Any, database_url: str):
        self._connection, self._url = connection, database_url

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql: Any, params: Any = None, *args: Any, **kwargs: Any) -> Any:
        name = _statement_name(sql)
        pid = getattr(getattr(self._connection, "info", None), "backend_pid", None)
        wall, thread_cpu, process_cpu = time.perf_counter(), time.thread_time(), time.process_time()
        with _Watchdog(self._url, pid, name):
            result = self._connection.execute(sql, params, *args, **kwargs)
        elapsed = time.perf_counter() - wall
        if elapsed >= _SLOW_SECONDS and isinstance(sql, str) and sql.lstrip().lower().startswith(("select", "with")):
            _logger.warning(
                "BROWSE-DIAG slow statement %.0f ms (request thread cpu %.0f ms, process cpu %.0f ms): %s",
                elapsed * 1000, (time.thread_time() - thread_cpu) * 1000, (time.process_time() - process_cpu) * 1000, name)
            self._explain(sql, params)
        return result

    def _explain(self, sql: str, params: Any) -> None:
        try:
            rows = self._connection.execute("explain (analyze, buffers, format text) " + sql, params).fetchall()
            plan = [str(next(iter(row.values())) if isinstance(row, dict) else row[0]) for row in rows]
            _logger.warning("BROWSE-DIAG plan (%d lines):\n%s", len(plan), "\n".join(plan[:220]))
        except Exception as error:  # noqa: BLE001
            _logger.warning("BROWSE-DIAG explain failed: %r", error)
