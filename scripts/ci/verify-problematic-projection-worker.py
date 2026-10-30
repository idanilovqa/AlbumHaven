"""Verify a fresh durable worker's Problematic Files capability lifecycle."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
from typing import Any, Callable, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _arguments(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True)
    parser.add_argument("--worker-script", required=True)
    parser.add_argument("--ready-timeout-seconds", required=True, type=float)
    parser.add_argument("--stop-timeout-seconds", required=True, type=float)
    parser.add_argument("--evidence-directory", required=True)
    values = parser.parse_args(argv)
    if values.ready_timeout_seconds <= 0 or values.stop_timeout_seconds <= 0:
        parser.error("timeouts must be positive")
    return values


def _redacted_text(value: object, secrets: Sequence[str]) -> str:
    result = str(value or "")
    for secret in secrets:
        if secret:
            result = result.replace(secret, "<redacted>")
    return result[-8192:]


def _read_log_tail(path: Path, limit: int = 8192) -> str:
    with path.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        stream.seek(max(0, stream.tell() - limit))
        return stream.read(limit).decode("utf-8", errors="replace")


def _query_capability(connection: Any, fingerprint: str) -> bool:
    row = connection.execute(
        "select ops.problematic_projection_worker_ready(%s)", (fingerprint,)
    ).fetchone()
    return row is not None and row[0] is True


def _fresh_worker_id(connection: Any, fingerprint: str, started_after: object) -> str | None:
    row = connection.execute(
        """
        select instance_id
        from ops.worker_instances
        where registered_handler_fingerprint = %s
          and started_at >= %s
          and compatible_schema_version = 1
          and lifecycle_state = 'running'
          and drain_state = 'none'
          and last_heartbeat_at >= pg_catalog.clock_timestamp() - interval '90 seconds'
        order by started_at desc, instance_id
        limit 1
        """,
        (fingerprint, started_after),
    ).fetchone()
    return None if row is None else str(row[0])


def _worker_stopped(connection: Any, worker_id: str) -> bool:
    row = connection.execute(
        """
        select lifecycle_state = 'stopped' and stopped_at is not null
        from ops.worker_instances where instance_id = %s
        """,
        (worker_id,),
    ).fetchone()
    return row is not None and row[0] is True


def _windows_process_rows() -> tuple[tuple[int, int, str], ...]:
    command = (
        "Get-CimInstance Win32_Process | ForEach-Object { "
        "'{0}|{1}|{2}' -f $_.ProcessId,$_.ParentProcessId,"
        "$_.CreationDate.ToFileTimeUtc().ToString() }"
    )
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-Command", command],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
        startupinfo=_hidden_startup_info(),
    )
    if completed.returncode != 0:
        raise RuntimeError("worker descendant audit failed")
    rows: list[tuple[int, int, str]] = []
    for line in completed.stdout.splitlines():
        value = line.strip()
        if not value:
            continue
        parts = value.split("|", 2)
        if len(parts) != 3 or not all(part.isdigit() for part in parts):
            raise RuntimeError("worker descendant audit returned a malformed process row")
        rows.append((int(parts[0]), int(parts[1]), parts[2]))
    return tuple(rows)


def _record_owned_descendants(
    parent_pid: int,
    owned: dict[tuple[int, str], tuple[int, str]],
) -> None:
    rows = _windows_process_rows()
    known_parents = {parent_pid}
    while True:
        added = False
        for process_id, process_parent_id, process_start_time in rows:
            if process_parent_id not in known_parents or process_id in known_parents:
                continue
            known_parents.add(process_id)
            owned[(process_id, process_start_time)] = (process_id, process_start_time)
            added = True
        if not added:
            return


def _exact_process_alive(identity: tuple[int, str]) -> bool:
    process_id, process_start_time = identity
    return any(
        row_pid == process_id and row_start_time == process_start_time
        for row_pid, _row_parent, row_start_time in _windows_process_rows()
    )


def _stop_exact_process(identity: tuple[int, str]) -> None:
    process_id, process_start_time = identity
    command = (
        f"try {{ $process=[Diagnostics.Process]::GetProcessById({process_id}); "
        "try { $started=$process.StartTime.ToFileTimeUtc().ToString(); "
        f"if ($started -ceq '{process_start_time}') {{ $process.Kill(); "
        "[void]$process.WaitForExit(10000) } } finally { $process.Dispose() } } "
        "catch [ArgumentException] { }"
    )
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-Command", command],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
        startupinfo=_hidden_startup_info(),
    )
    if completed.returncode != 0:
        raise RuntimeError(f"worker exact descendant PID {process_id} cleanup failed")


def _monitor_owned_descendants(
    process: subprocess.Popen[str],
    owned: dict[tuple[int, str], tuple[int, str]],
    stopped: threading.Event,
    failures: list[Exception],
) -> None:
    while process.poll() is None and not stopped.is_set():
        try:
            _record_owned_descendants(process.pid, owned)
        except Exception as exc:
            failures.append(exc)
            return
        stopped.wait(0.1)


def _hidden_startup_info() -> subprocess.STARTUPINFO | None:
    if os.name != "nt":
        return None
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    return startup


def _verify_worker_lifecycle(
    *,
    python: str,
    worker_script: str,
    ready_timeout_seconds: float,
    stop_timeout_seconds: float,
    evidence_directory: Path,
    environ: Mapping[str, str],
    connect: Callable[[str], Any],
    fingerprint: str,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, object]:
    migrator_url = str(environ.get("DATABASE_MIGRATOR_URL") or "").strip()
    worker_url = str(environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "").strip()
    if not migrator_url or not worker_url:
        raise RuntimeError("Task 9 worker and migrator database URLs are required")
    evidence_directory.mkdir(parents=True, exist_ok=True)
    stdout_path = evidence_directory / "worker.stdout.log"
    stderr_path = evidence_directory / "worker.stderr.log"
    worker_environ = dict(environ)
    worker_environ["ALBUM_HAVEN_WORKER_DATABASE_URL"] = worker_url
    worker_environ.setdefault("ALBUM_HAVEN_WORKER_HEARTBEAT_SECONDS", "1")
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    started_after: object
    with connect(migrator_url) as connection:
        started_after = connection.execute(
            "select pg_catalog.clock_timestamp()"
        ).fetchone()[0]
    process: subprocess.Popen[str] | None = None
    worker_id: str | None = None
    forced_cleanup = False
    ready = False
    lifecycle_failure: Exception | None = None
    owned_processes: dict[tuple[int, str], tuple[int, str]] = {}
    monitor_failures: list[Exception] = []
    monitor_stopped = threading.Event()
    monitor: threading.Thread | None = None
    with stdout_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open(
        "w", encoding="utf-8"
    ) as stderr_file:
        try:
            process = subprocess.Popen(
                [python, worker_script],
                cwd=str(Path(worker_script).resolve().parents[1]),
                env=worker_environ,
                stdout=stdout_file,
                stderr=stderr_file,
                text=True,
                creationflags=creationflags,
                startupinfo=_hidden_startup_info(),
            )
            monitor = threading.Thread(
                target=_monitor_owned_descendants,
                args=(process, owned_processes, monitor_stopped, monitor_failures),
                daemon=True,
            )
            monitor.start()
            deadline = clock() + ready_timeout_seconds
            while clock() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("durable worker exited before readiness")
                with connect(migrator_url) as connection:
                    candidate = _fresh_worker_id(connection, fingerprint, started_after)
                    ready = _query_capability(connection, fingerprint)
                if candidate is not None:
                    worker_id = candidate
                if ready and worker_id is not None:
                    break
                sleep(0.25)
            if not ready or worker_id is None:
                raise RuntimeError("durable worker capability readiness timed out")
        except Exception as exc:
            lifecycle_failure = exc
        finally:
            if process is not None and process.poll() is None:
                if os.name == "nt":
                    process.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=stop_timeout_seconds)
                except subprocess.TimeoutExpired:
                    forced_cleanup = True
                    process.kill()
                    process.wait(timeout=10)
            monitor_stopped.set()
            if monitor is not None:
                monitor.join(timeout=10)
            stdout_file.flush()
            stderr_file.flush()
    cleanup_failures: list[str] = []
    if process is None:
        cleanup_failures.append("durable worker was not started")
    else:
        if monitor is not None and monitor.is_alive():
            cleanup_failures.append("durable worker descendant monitor did not stop")
        cleanup_failures.extend(str(failure) for failure in monitor_failures)
        for identity in reversed(tuple(owned_processes.values())):
            if not _exact_process_alive(identity):
                continue
            forced_cleanup = True
            try:
                _stop_exact_process(identity)
            except Exception as exc:
                cleanup_failures.append(str(exc))
        descendants = tuple(
            identity for identity in owned_processes.values() if _exact_process_alive(identity)
        )
        if descendants:
            cleanup_failures.append(f"durable worker descendants leaked: {descendants}")
        if forced_cleanup:
            cleanup_failures.append("durable worker required forced cleanup")
        if process.returncode != 0:
            cleanup_failures.append(
                f"durable worker stopped with exit code {process.returncode}"
            )
    if worker_id is None:
        cleanup_failures.append("fresh durable worker row was not identified")
    else:
        with connect(migrator_url) as connection:
            if not _worker_stopped(connection, worker_id):
                cleanup_failures.append("fresh durable worker row was not stopped")
    failures = ([str(lifecycle_failure)] if lifecycle_failure is not None else [])
    failures.extend(cleanup_failures)
    secrets = (migrator_url, worker_url)
    result: dict[str, object] = {
        "ready": ready and worker_id is not None,
        "worker_id": worker_id,
        "process_id": None if process is None else process.pid,
        "exit_code": None if process is None else process.returncode,
        "owned_descendants": [
            {"process_id": process_id, "process_start_time": process_start_time}
            for process_id, process_start_time in sorted(owned_processes.values())[-8:]
        ],
        "stdout": _redacted_text(
            _read_log_tail(stdout_path), secrets
        )[-384:],
        "stderr": _redacted_text(
            _read_log_tail(stderr_path), secrets
        )[-384:],
    }
    if failures:
        result["failure"] = _redacted_text("; ".join(failures), secrets)[-384:]
    (evidence_directory / "worker-lifecycle.json").write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    if failures:
        raise RuntimeError("; ".join(failures))
    return result


def verify_worker_lifecycle(
    *,
    python: str,
    worker_script: str,
    ready_timeout_seconds: float,
    stop_timeout_seconds: float,
    evidence_directory: Path,
    environ: Mapping[str, str],
    connect: Callable[[str], Any],
    fingerprint: str,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, object]:
    try:
        return _verify_worker_lifecycle(
            python=python,
            worker_script=worker_script,
            ready_timeout_seconds=ready_timeout_seconds,
            stop_timeout_seconds=stop_timeout_seconds,
            evidence_directory=evidence_directory,
            environ=environ,
            connect=connect,
            fingerprint=fingerprint,
            clock=clock,
            sleep=sleep,
        )
    finally:
        (evidence_directory / "worker.stdout.log").unlink(missing_ok=True)
        (evidence_directory / "worker.stderr.log").unlink(missing_ok=True)


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    connect: Callable[[str], Any] | None = None,
) -> int:
    values = _arguments(argv)
    environment = os.environ if environ is None else environ
    try:
        from music_app.services.jobs.registry import (
            expected_registered_handler_fingerprint,
        )
        if connect is None:
            import psycopg

            connect = psycopg.connect
        verify_worker_lifecycle(
            python=values.python,
            worker_script=values.worker_script,
            ready_timeout_seconds=values.ready_timeout_seconds,
            stop_timeout_seconds=values.stop_timeout_seconds,
            evidence_directory=Path(values.evidence_directory),
            environ=environment,
            connect=connect,
            fingerprint=expected_registered_handler_fingerprint(),
        )
    except Exception as exc:
        secrets = (
            str(environment.get("DATABASE_MIGRATOR_URL") or ""),
            str(environment.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or ""),
        )
        print(_redacted_text(exc, secrets), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
