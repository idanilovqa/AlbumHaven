from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest


SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "scripts"
    / "ci"
    / "verify-problematic-projection-worker.py"
)


def test_verifier_continuously_records_exact_descendant_identities():
    source = SCRIPT.read_text(encoding="utf-8")

    assert "_descendant_process_ids" not in source
    assert "CreationDate" in source
    assert "process_start_time" in source
    assert "_record_owned_descendants" in source
    assert "_exact_process_alive" in source
    assert "_stop_exact_process" in source
    assert "while process.poll() is None" in source
    assert "taskkill" not in source.casefold()


def test_descendant_snapshot_tracks_transitive_pid_start_identities(monkeypatch):
    module = _module()
    monkeypatch.setattr(
        module,
        "_windows_process_rows",
        lambda: (
            (41001, 41000, "2026-10-28T01:00:00.0000000Z"),
            (41002, 41001, "2026-10-28T01:00:01.0000000Z"),
            (51001, 51000, "2026-10-28T01:00:02.0000000Z"),
        ),
    )
    owned = {}

    module._record_owned_descendants(41000, owned)

    assert owned == {
        (41001, "2026-10-28T01:00:00.0000000Z"): (
            41001,
            "2026-10-28T01:00:00.0000000Z",
        ),
        (41002, "2026-10-28T01:00:01.0000000Z"): (
            41002,
            "2026-10-28T01:00:01.0000000Z",
        ),
    }


def test_exact_descendant_cleanup_validates_and_kills_through_same_process_handle(
    monkeypatch,
):
    module = _module()
    commands = []

    class _Completed:
        returncode = 0

    def run(arguments, **_kwargs):
        commands.append(arguments[-1])
        return _Completed()

    monkeypatch.setattr(module, "_exact_process_alive", lambda _identity: True)
    monkeypatch.setattr(module.subprocess, "run", run)

    module._stop_exact_process((42001, "2026-10-28T01:00:00.0000000Z"))

    assert len(commands) == 1
    command = commands[0]
    assert "[Diagnostics.Process]::GetProcessById(42001)" in command
    assert ".StartTime.ToFileTimeUtc().ToString()" in command
    assert ".Kill()" in command
    assert ".Kill($true)" not in command
    assert "$process.Dispose()" in command
    assert "Stop-Process" not in command


def test_windows_process_snapshot_uses_matching_file_time_identity(monkeypatch):
    module = _module()
    commands = []

    class _Completed:
        returncode = 0
        stdout = "43001|43000|134218080000000000\n"

    def run(arguments, **_kwargs):
        commands.append(arguments[-1])
        return _Completed()

    monkeypatch.setattr(module.subprocess, "run", run)

    assert module._windows_process_rows() == (
        (43001, 43000, "134218080000000000"),
    )
    assert "CreationDate.ToFileTimeUtc().ToString()" in commands[0]


def test_windows_process_snapshot_rejects_malformed_nonempty_rows(monkeypatch):
    module = _module()

    class _Completed:
        returncode = 0
        stdout = "43001|43000|134218080000000000\nmalformed\n"

    monkeypatch.setattr(module.subprocess, "run", lambda *_args, **_kwargs: _Completed())

    with pytest.raises(RuntimeError, match="malformed"):
        module._windows_process_rows()


def _module():
    spec = importlib.util.spec_from_file_location("verify_problematic_worker", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_script_adds_repository_root_to_import_path(monkeypatch):
    repository_root = SCRIPT.parents[2]
    monkeypatch.setattr(
        sys,
        "path",
        [entry for entry in sys.path if Path(entry or ".").resolve() != repository_root],
    )

    _module()

    assert sys.path[0] == str(repository_root)


def test_fresh_worker_query_requires_exact_ready_row():
    module = _module()

    class RecordingConnection:
        def __init__(self):
            self.sql = ""

        def execute(self, sql, _params):
            self.sql = sql
            return _Cursor(("worker-1",))

    connection = RecordingConnection()

    assert module._fresh_worker_id(connection, "fingerprint", object()) == "worker-1"
    assert "compatible_schema_version = 1" in connection.sql
    assert "lifecycle_state = 'running'" in connection.sql
    assert "drain_state = 'none'" in connection.sql
    assert "last_heartbeat_at >= pg_catalog.clock_timestamp() - interval '90 seconds'" in connection.sql


class _Cursor:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class _Connection:
    def __init__(self, state):
        self._state = state

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, _params=None):
        if sql.strip() == "select pg_catalog.clock_timestamp()":
            return _Cursor((self._state["started_after"],))
        if "problematic_projection_worker_ready" in sql:
            values = self._state["ready"]
            value = values.pop(0) if len(values) > 1 else values[0]
            return _Cursor((value,))
        if "select instance_id" in sql:
            return _Cursor((self._state["worker_id"],))
        if "lifecycle_state = 'stopped'" in sql:
            return _Cursor((self._state["stopped"],))
        raise AssertionError(sql)


class _Process:
    def __init__(self, *, early_exit=False, stop_timeout=False, returncode=0):
        self.pid = 43210
        self.returncode = returncode if early_exit else None
        self._stop_timeout = stop_timeout
        self.killed = False
        self.signals = []

    def poll(self):
        return self.returncode

    def send_signal(self, value):
        self.signals.append(value)

    def wait(self, timeout):
        if self._stop_timeout and not self.killed:
            raise subprocess.TimeoutExpired("worker", timeout)
        self.returncode = 0
        return 0

    def kill(self):
        self.killed = True


def _run(
    monkeypatch,
    tmp_path,
    *,
    ready,
    process=None,
    stopped=True,
    stdout_bytes=b"",
    stderr_bytes=b"",
):
    module = _module()
    state = {
        "started_after": object(),
        "ready": list(ready),
        "worker_id": "worker-1",
        "stopped": stopped,
    }
    owned_process = process or _Process()
    def start_process(*_args, **kwargs):
        kwargs["stdout"].buffer.write(stdout_bytes)
        kwargs["stderr"].buffer.write(stderr_bytes)
        return owned_process

    monkeypatch.setattr(module.subprocess, "Popen", start_process)
    monkeypatch.setattr(module, "_record_owned_descendants", lambda _pid, _owned: None)
    ticks = iter((0.0, 0.1, 0.2, 0.3, 0.4, 2.0))
    result = module.verify_worker_lifecycle(
        python="python.exe",
        worker_script=str(Path(__file__).resolve().parents[2] / "scripts" / "run_jobs_worker.py"),
        ready_timeout_seconds=1,
        stop_timeout_seconds=1,
        evidence_directory=tmp_path,
        environ={
            "DATABASE_MIGRATOR_URL": "postgresql://migrator:secret@localhost/db",
            "ALBUM_HAVEN_WORKER_DATABASE_URL": "postgresql://worker:secret@localhost/db",
        },
        connect=lambda _url: _Connection(state),
        fingerprint="fingerprint",
        clock=lambda: next(ticks),
        sleep=lambda _seconds: None,
    )
    return module, owned_process, result


def test_capability_false_then_true_requires_exact_python_true(monkeypatch, tmp_path):
    module, process, result = _run(
        monkeypatch, tmp_path, ready=[False, None, True]
    )

    assert result["ready"] is True
    assert result["worker_id"] == "worker-1"
    expected_signal = (
        module.signal.CTRL_BREAK_EVENT
        if module.os.name == "nt"
        else module.signal.SIGINT
    )
    assert process.signals == [expected_signal]
    assert process.returncode == 0
    assert not (tmp_path / "worker.stdout.log").exists()
    assert not (tmp_path / "worker.stderr.log").exists()
    retained = json.loads((tmp_path / "worker-lifecycle.json").read_text(encoding="utf-8"))
    assert len(retained["stdout"]) <= 8192
    assert len(retained["stderr"]) <= 8192


def test_child_early_exit_fails_and_still_records_no_success(monkeypatch, tmp_path):
    with pytest.raises(RuntimeError, match="exited before readiness"):
        _run(monkeypatch, tmp_path, ready=[False], process=_Process(early_exit=True))


def test_stop_timeout_forces_cleanup_but_fails_stage(monkeypatch, tmp_path):
    process = _Process(stop_timeout=True)
    with pytest.raises(RuntimeError, match="forced cleanup"):
        _run(monkeypatch, tmp_path, ready=[True], process=process)
    assert process.killed is True


def test_stopped_worker_row_is_required(monkeypatch, tmp_path):
    with pytest.raises(RuntimeError, match="row was not stopped"):
        _run(monkeypatch, tmp_path, ready=[True], stopped=False)


def test_secret_redaction_is_bounded():
    module = _module()
    secret = "postgresql://migrator:secret@localhost/db"
    value = module._redacted_text("x" * 9000 + secret, (secret,))

    assert secret not in value
    assert "<redacted>" in value
    assert len(value) <= 8192


def test_invalid_utf8_worker_logs_are_bounded_replaced_and_always_deleted(
    monkeypatch, tmp_path
):
    stdout_bytes = ("é" * 5000).encode("utf-8") + b"\xfftail"
    stderr_bytes = b"failure-\xfe-tail"

    try:
        _module_value, _process, result = _run(
            monkeypatch,
            tmp_path,
            ready=[True],
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
        )
    finally:
        assert not (tmp_path / "worker.stdout.log").exists()
        assert not (tmp_path / "worker.stderr.log").exists()

    assert "\ufffd" in result["stdout"]
    assert "\ufffd" in result["stderr"]
    assert len(result["stdout"].encode("utf-8")) <= 8192
    assert len(result["stderr"].encode("utf-8")) <= 8192
