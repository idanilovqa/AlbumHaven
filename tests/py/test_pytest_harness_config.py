from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

import pytest

import conftest as pytest_harness


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PROBE_PATH = REPOSITORY_ROOT / "tests" / "py" / "_pytest_harness_probe.py"
PROBE_PREFIX = "PYTEST_HARNESS_PROBE="
PYTEST_ROOT_ENV = "ALBUM_HAVEN_PYTEST_ROOT"


def _probe_command(*, basetemp: Path | None = None) -> list[str]:
    command = [sys.executable, "-m", "pytest", "-q", "-s", str(PROBE_PATH)]
    if basetemp is not None:
        command.extend(["--basetemp", str(basetemp)])
    return command


def _probe_result(output: str) -> dict[str, object]:
    payloads = [
        line.removeprefix(PROBE_PREFIX)
        for line in output.splitlines()
        if line.startswith(PROBE_PREFIX)
    ]
    assert len(payloads) == 1, output
    payload = json.loads(payloads[0])
    assert isinstance(payload, dict)
    return payload


def _probe_environment(*, generated_root: Path) -> dict[str, str]:
    environment = os.environ.copy()
    environment[PYTEST_ROOT_ENV] = str(generated_root.resolve())
    return environment


def _run_probe(
    *,
    generated_root: Path,
    basetemp: Path | None = None,
) -> tuple[subprocess.CompletedProcess[str], dict[str, object]]:
    completed = subprocess.run(
        _probe_command(basetemp=basetemp),
        cwd=REPOSITORY_ROOT,
        env=_probe_environment(generated_root=generated_root),
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    return completed, _probe_result(completed.stdout)


def test_current_pytest_basetemp_records_generated_or_explicit_ownership(pytestconfig):
    pytest_ini = (REPOSITORY_ROOT / "pytest.ini").read_text(encoding="utf-8")
    assert "--basetemp" not in pytest_ini

    base_temp = Path(pytestconfig.option.basetemp).resolve()
    generated = bool(pytestconfig._album_haven_generated_basetemp)
    assert base_temp.is_dir()
    assert Path(os.environ["MUSIC_APP_DATA_DIR"]).resolve().is_relative_to(base_temp)
    assert Path(pytestconfig._album_haven_test_appdata).resolve() == Path(
        os.environ["MUSIC_APP_DATA_DIR"]
    ).resolve()
    assert Path(os.environ["TMP"]).resolve() == base_temp / "session-temp"
    assert Path(os.environ["TEMP"]).resolve() == base_temp / "session-temp"
    if generated:
        configured_root = os.environ.get(PYTEST_ROOT_ENV, "").strip()
        expected_root = (
            Path(configured_root).resolve()
            if configured_root
            else (REPOSITORY_ROOT / ".tmp").resolve()
        )
        assert base_temp.parent == expected_root
        assert base_temp.name.startswith(f"pytest-{os.getpid()}-")
        assert (base_temp / ".album-haven-pytest-owner.json").is_file()
    else:
        assert pytestconfig._album_haven_generated_basetemp_token is None


def test_default_generated_basetemp_exists_during_probe_and_is_removed_after_session(tmp_path):
    generated_root = tmp_path / "generated-probes"
    _completed, payload = _run_probe(generated_root=generated_root)
    base_temp = Path(str(payload["basetemp"]))

    assert payload["generated"] is True
    assert base_temp.parent == generated_root.resolve()
    assert payload["basetemp_exists"] is True
    assert payload["session_temp_exists"] is True
    assert payload["appdata_exists"] is True
    assert payload["appdata_is_session_owned"] is True
    assert payload["config_data_dir_matches"] is True
    assert payload["owner_marker_exists"] is True
    assert set(payload["temp_environment"].values()) == {payload["session_temp"]}
    assert payload["tempfile_tempdir"] == payload["session_temp"]
    assert not base_temp.exists()


def test_explicit_basetemp_is_preserved_and_not_claimed_by_generated_cleanup(tmp_path):
    generated_root = tmp_path / "generated-probes"
    explicit_root = (tmp_path / f"pytest-explicit-probe-{uuid.uuid4().hex[:8]}").resolve()
    try:
        _completed, payload = _run_probe(
            generated_root=generated_root,
            basetemp=explicit_root,
        )

        assert Path(str(payload["basetemp"])) == explicit_root
        assert payload["generated"] is False
        assert payload["basetemp_exists"] is True
        assert payload["session_temp_exists"] is True
        assert payload["owner_marker_exists"] is False
        assert set(payload["temp_environment"].values()) == {payload["session_temp"]}
        assert explicit_root.is_dir()
    finally:
        shutil.rmtree(explicit_root, ignore_errors=True)


def test_two_concurrent_default_pytest_processes_use_isolated_roots_and_cleanup_both(tmp_path):
    generated_root = tmp_path / "generated-probes"
    processes = [
        subprocess.Popen(
            _probe_command(),
            cwd=REPOSITORY_ROOT,
            env=_probe_environment(generated_root=generated_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for _ in range(2)
    ]
    results = []
    for process in processes:
        stdout, stderr = process.communicate(timeout=60)
        assert process.returncode == 0, stdout + stderr
        results.append(_probe_result(stdout))

    roots = [Path(str(result["basetemp"])) for result in results]
    appdata_roots = [Path(str(result["appdata"])) for result in results]
    assert roots[0] != roots[1]
    assert appdata_roots[0] != appdata_roots[1]
    assert all(result["generated"] is True for result in results)
    assert all(result["session_temp_exists"] is True for result in results)
    assert all(result["appdata_exists"] is True for result in results)
    assert all(result["appdata_is_session_owned"] is True for result in results)
    assert all(result["config_data_dir_matches"] is True for result in results)
    assert all(
        set(result["temp_environment"].values()) == {result["session_temp"]}
        for result in results
    )
    assert all(not root.exists() for root in roots)


@pytest.mark.skipif(os.name != "nt", reason="Windows process liveness regression")
def test_windows_liveness_probe_does_not_terminate_live_child():
    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        cwd=REPOSITORY_ROOT,
    )
    try:
        assert pytest_harness._process_is_running(process.pid)
        assert process.poll() is None
    finally:
        process.terminate()
        process.wait(timeout=10)


@pytest.mark.skipif(os.name != "nt", reason="Windows process liveness regression")
def test_windows_liveness_probe_reports_exited_child_as_stopped():
    process = subprocess.Popen(
        [sys.executable, "-c", "pass"],
        cwd=REPOSITORY_ROOT,
    )

    assert process.wait(timeout=10) == 0
    assert not pytest_harness._process_is_running(process.pid)


def _write_owner_marker(root: Path, *, pid: int, token: str) -> None:
    root.mkdir(parents=True)
    (root / ".album-haven-pytest-owner.json").write_text(
        json.dumps(
            {
                "kind": "album-haven-pytest-basetemp",
                "pid": pid,
                "token": token,
            }
        ),
        encoding="utf-8",
    )


def test_stale_cleanup_removes_only_owned_dead_process_roots(tmp_path, monkeypatch):
    workspace_temp = tmp_path / "workspace-temp"
    dead_root = workspace_temp / "pytest-111111-deadbeef"
    live_root = workspace_temp / "pytest-222222-cafebabe"
    unowned_root = workspace_temp / "pytest-333333-1234abcd"
    _write_owner_marker(dead_root, pid=111111, token="deadbeef")
    _write_owner_marker(live_root, pid=222222, token="cafebabe")
    unowned_root.mkdir(parents=True)

    monkeypatch.setattr(pytest_harness, "_workspace_pytest_temp_root", lambda: workspace_temp.resolve())
    monkeypatch.setattr(pytest_harness, "_process_is_running", lambda pid: pid == 222222)

    pytest_harness._cleanup_stale_generated_pytest_roots()

    assert not dead_root.exists()
    assert live_root.is_dir()
    assert unowned_root.is_dir()


def test_owned_root_cleanup_retries_a_transient_filesystem_lock(tmp_path, monkeypatch):
    workspace_temp = tmp_path / "workspace-temp"
    owned_root = workspace_temp / "pytest-444444-deadbeef"
    _write_owner_marker(owned_root, pid=444444, token="deadbeef")
    real_rmtree = shutil.rmtree
    attempts = []

    def transient_rmtree(path):
        attempts.append(Path(path))
        if len(attempts) < 3:
            raise PermissionError("transient Windows file lock")
        real_rmtree(path)

    monkeypatch.setattr(
        pytest_harness,
        "_workspace_pytest_temp_root",
        lambda: workspace_temp.resolve(),
    )
    monkeypatch.setattr(pytest_harness.shutil, "rmtree", transient_rmtree)
    monkeypatch.setattr(pytest_harness.time, "sleep", lambda _seconds: None)

    assert pytest_harness._remove_owned_generated_pytest_root(
        owned_root,
        expected_owner=(444444, "deadbeef"),
    )
    assert attempts == [owned_root, owned_root, owned_root]


def test_unrelated_workspace_entries_do_not_starve_owned_stale_root_cleanup(tmp_path, monkeypatch):
    workspace_temp = tmp_path / "workspace-temp"
    unrelated_roots = [workspace_temp / f"unrelated-{index:03d}" for index in range(65)]
    for root in unrelated_roots:
        root.mkdir(parents=True)
    dead_root = workspace_temp / "pytest-555555-abcdef12"
    _write_owner_marker(dead_root, pid=555555, token="abcdef12")
    ordered_entries = [*unrelated_roots, dead_root]
    real_iterdir = Path.iterdir

    def ordered_iterdir(path: Path):
        if path.resolve() == workspace_temp.resolve():
            return iter(ordered_entries)
        return real_iterdir(path)

    monkeypatch.setattr(pytest_harness, "_workspace_pytest_temp_root", lambda: workspace_temp.resolve())
    monkeypatch.setattr(pytest_harness, "_process_is_running", lambda _pid: False)
    monkeypatch.setattr(Path, "iterdir", ordered_iterdir)

    pytest_harness._cleanup_stale_generated_pytest_roots()

    assert not dead_root.exists()
    assert all(root.is_dir() for root in unrelated_roots)


def test_owned_cleanup_tolerates_a_windows_style_lock(tmp_path, monkeypatch):
    workspace_temp = tmp_path / "workspace-temp"
    locked_root = workspace_temp / "pytest-444444-acde1234"
    _write_owner_marker(locked_root, pid=444444, token="acde1234")
    monkeypatch.setattr(pytest_harness, "_workspace_pytest_temp_root", lambda: workspace_temp.resolve())
    monkeypatch.setattr(
        pytest_harness.shutil,
        "rmtree",
        lambda _path: (_ for _ in ()).throw(PermissionError("locked")),
    )

    assert not pytest_harness._remove_owned_generated_pytest_root(
        locked_root,
        expected_owner=(444444, "acde1234"),
    )
    assert locked_root.is_dir()
