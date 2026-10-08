from __future__ import annotations

import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
from types import SimpleNamespace
import uuid

import pytest

import conftest as pytest_harness


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PROBE_PATH = REPOSITORY_ROOT / "tests" / "py" / "_pytest_harness_probe.py"
PROBE_PREFIX = "PYTEST_HARNESS_PROBE="
PYTEST_ROOT_ENV = "ALBUM_HAVEN_PYTEST_ROOT"


@pytest.mark.skipif(os.name != "nt", reason="Windows extended path syntax")
def test_path_ownership_normalizes_windows_extended_prefixes():
    is_path_within = runpy.run_path(str(PROBE_PATH))["_is_path_within"]

    assert is_path_within(
        Path(r"\\?\D:\album-haven\pytest-root\appdata"),
        Path(r"D:\album-haven\pytest-root"),
    )
    assert is_path_within(
        Path(r"\\?\UNC\server\share\pytest-root\appdata"),
        Path(r"\\server\share\pytest-root"),
    )
    assert not is_path_within(
        Path(r"\\?\UNC\server\share\pytest-root-sibling\appdata"),
        Path(r"\\server\share\pytest-root"),
    )


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
    environment["ALBUM_HAVEN_PYTEST_CLEANUP_DIAGNOSTICS"] = "1"
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
    cleanup_diagnostics = []
    for process in processes:
        stdout, stderr = process.communicate(timeout=60)
        assert process.returncode == 0, stdout + stderr
        results.append(_probe_result(stdout))
        cleanup_diagnostics.append([
            json.loads(line.removeprefix("PYTEST_HARNESS_CLEANUP="))
            for line in stderr.splitlines()
            if line.startswith("PYTEST_HARNESS_CLEANUP=")
        ])

    roots = [Path(str(result["basetemp"])) for result in results]
    appdata_roots = [Path(str(result["appdata"])) for result in results]
    assert roots[0] != roots[1]
    assert appdata_roots[0] != appdata_roots[1]
    assert all(result["generated"] is True for result in results)
    assert all(result["session_temp_exists"] is True for result in results)
    assert all(result["appdata_exists"] is True for result in results)
    assert all(result["appdata_is_session_owned"] is True for result in results), results
    assert all(result["config_data_dir_matches"] is True for result in results)
    assert all(
        set(result["temp_environment"].values()) == {result["session_temp"]}
        for result in results
    )
    assert all(not root.exists() for root in roots), [
        {"survived": root.exists(), "marker_present": (root / ".album-haven-pytest-owner.json").exists(),
         "cleanup": diagnostics}
        for root, diagnostics in zip(roots, cleanup_diagnostics)
    ]


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


def test_pytest_unconfigure_retries_generated_root_cleanup_after_sessionfinish(
    tmp_path, monkeypatch
):
    owned_root = tmp_path / "pytest-444444-acde1234"
    calls = []

    def remove(path, *, expected_owner):
        calls.append((path, expected_owner))
        return len(calls) > 1

    config = SimpleNamespace(
        _album_haven_generated_basetemp=True,
        _album_haven_generated_basetemp_token="acde1234",
        _tmp_path_factory=SimpleNamespace(_basetemp=owned_root),
    )
    monkeypatch.setattr(pytest_harness, "_remove_owned_generated_pytest_root", remove)

    pytest_harness.pytest_sessionfinish(SimpleNamespace(config=config), 0)
    pytest_harness.pytest_unconfigure(config)

    assert calls == [
        (owned_root, (os.getpid(), "acde1234")),
        (owned_root, (os.getpid(), "acde1234")),
    ]


def test_partial_cleanup_preserves_ownership_for_unconfigure_retry(tmp_path, monkeypatch):
    workspace_temp = tmp_path / 'workspace-temp'
    owned_root = workspace_temp / 'pytest-444444-deadbeef'
    _write_owner_marker(owned_root, pid=444444, token='deadbeef')
    (owned_root / 'locked.log').write_text('held until logging teardown', encoding='utf-8')
    real_rmtree = shutil.rmtree
    attempts = []

    def partially_locked_rmtree(path):
        attempts.append(Path(path))
        # Windows may delete early entries before encountering an open log file.
        (path / '.album-haven-pytest-owner.json').unlink()
        raise PermissionError('log handler still owns locked.log')

    monkeypatch.setattr(pytest_harness, '_workspace_pytest_temp_root', lambda: workspace_temp.resolve())
    monkeypatch.setattr(pytest_harness.shutil, 'rmtree', partially_locked_rmtree)
    monkeypatch.setattr(pytest_harness.time, 'sleep', lambda _seconds: None)
    assert not pytest_harness._remove_owned_generated_pytest_root(
        owned_root, expected_owner=(444444, 'deadbeef'),
    )
    assert len(attempts) == pytest_harness._PYTEST_ROOT_REMOVAL_ATTEMPTS
    assert pytest_harness._owned_generated_pytest_root(owned_root) is not None
    assert (owned_root / 'locked.log').read_text(encoding='utf-8') == 'held until logging teardown'

    # Once the plugin closes the file, the final hook must still recognize its root.
    monkeypatch.setattr(pytest_harness.shutil, 'rmtree', real_rmtree)
    assert pytest_harness._remove_owned_generated_pytest_root(
        owned_root, expected_owner=(444444, 'deadbeef'),
    )
    assert not owned_root.exists()


def test_partial_cleanup_does_not_claim_a_replacement_directory(tmp_path, monkeypatch):
    workspace_temp = tmp_path / 'workspace-temp'
    owned_root = workspace_temp / 'pytest-444444-deadbeef'
    displaced_root = workspace_temp / 'preserved-original'
    _write_owner_marker(owned_root, pid=444444, token='deadbeef')
    attempts = []

    def replaced_rmtree(path):
        attempts.append(Path(path))
        path.rename(displaced_root)
        path.mkdir()
        (path / 'unowned.txt').write_text('must survive', encoding='utf-8')
        raise PermissionError('directory was replaced')

    monkeypatch.setattr(pytest_harness, '_workspace_pytest_temp_root', lambda: workspace_temp.resolve())
    monkeypatch.setattr(pytest_harness.shutil, 'rmtree', replaced_rmtree)
    monkeypatch.setattr(pytest_harness.time, 'sleep', lambda _seconds: None)
    assert not pytest_harness._remove_owned_generated_pytest_root(
        owned_root, expected_owner=(444444, 'deadbeef'),
    )
    assert attempts == [owned_root]
    assert not (owned_root / '.album-haven-pytest-owner.json').exists()
    assert (owned_root / 'unowned.txt').read_text(encoding='utf-8') == 'must survive'
    assert displaced_root.is_dir()


@pytest.mark.parametrize("replacement", ["directory", "marker"])
def test_cleanup_revalidates_ownership_after_retry_backoff(tmp_path, monkeypatch, replacement):
    workspace_temp = tmp_path / "workspace-temp"
    owned_root = workspace_temp / "pytest-444444-deadbeef"
    displaced_root = workspace_temp / "preserved-original"
    _write_owner_marker(owned_root, pid=444444, token="deadbeef")
    real_rmtree = shutil.rmtree
    attempts = []

    def locked_once(path):
        attempts.append(Path(path))
        if len(attempts) == 1:
            raise PermissionError("temporary lock")
        real_rmtree(path)

    def replace_during_backoff(_seconds):
        if replacement == "directory":
            owned_root.rename(displaced_root)
            owned_root.mkdir()
        else:
            (owned_root / ".album-haven-pytest-owner.json").unlink()
        (owned_root / "unowned.txt").write_text("must survive", encoding="utf-8")

    monkeypatch.setattr(pytest_harness, "_workspace_pytest_temp_root", lambda: workspace_temp.resolve())
    monkeypatch.setattr(pytest_harness.shutil, "rmtree", locked_once)
    monkeypatch.setattr(pytest_harness.time, "sleep", replace_during_backoff)
    assert not pytest_harness._remove_owned_generated_pytest_root(
        owned_root, expected_owner=(444444, "deadbeef"),
    )
    assert attempts == [owned_root]
    assert (owned_root / "unowned.txt").read_text(encoding="utf-8") == "must survive"


@pytest.mark.parametrize("factory_removed", [False, True])
def test_generated_root_cleanup_runs_after_late_configuration_resources_close(tmp_path, monkeypatch, factory_removed):
    """Config cleanups run after unconfigure and may still own Windows handles."""
    callbacks = []
    workspace = tmp_path / 'workspace-temp'
    config = SimpleNamespace(
        option=SimpleNamespace(basetemp=None),
        addinivalue_line=lambda *_args: None,
        add_cleanup=callbacks.append,
    )
    monkeypatch.setattr(pytest_harness, '_workspace_pytest_temp_root', lambda: workspace.resolve())
    monkeypatch.setattr(pytest_harness, '_activate_pytest_app_paths', lambda root: root / 'appdata')
    pytest_harness.pytest_configure(config)
    root = Path(config.option.basetemp)
    token = config._album_haven_generated_basetemp_token
    _write_owner_marker(root, pid=os.getpid(), token=token)
    config._tmp_path_factory = SimpleNamespace(_basetemp=root)
    held = [True]
    callbacks.append(lambda: held.__setitem__(0, False))
    if factory_removed:
        # Mirror pytest.tmpdir's registered MonkeyPatch.undo cleanup.
        callbacks.append(lambda: delattr(config, "_tmp_path_factory"))
    real_rmtree = shutil.rmtree

    def remove_after_handle_close(path):
        if held[0]:
            raise PermissionError('configuration cleanup still owns a Windows handle')
        real_rmtree(path)

    monkeypatch.setattr(pytest_harness.shutil, 'rmtree', remove_after_handle_close)
    monkeypatch.setattr(pytest_harness.time, 'sleep', lambda _seconds: None)
    pytest_harness.pytest_sessionfinish(SimpleNamespace(config=config), 0)
    pytest_harness.pytest_unconfigure(config)
    assert root.exists(), 'the resource stays open through unconfigure'
    for callback in reversed(callbacks):
        callback()
    assert held == [False]
    assert not root.exists(), 'the final config cleanup must remove its own root after resources close'


def test_explicit_root_does_not_register_a_final_generated_cleanup(tmp_path, monkeypatch):
    callbacks = []
    root = tmp_path / 'explicit-root'
    root.mkdir()
    config = SimpleNamespace(
        option=SimpleNamespace(basetemp=str(root)),
        addinivalue_line=lambda *_args: None,
        add_cleanup=callbacks.append,
    )
    monkeypatch.setattr(pytest_harness, '_activate_pytest_app_paths', lambda base: base / 'appdata')
    pytest_harness.pytest_configure(config)
    for callback in reversed(callbacks):
        callback()
    assert callbacks == []
    assert root.is_dir()


def test_cleanup_diagnostics_exclude_paths_and_error_messages(monkeypatch, capsys):
    error = PermissionError(13, "private error content", "/private/owned-root/file.log")
    error.winerror = 32
    monkeypatch.delenv("ALBUM_HAVEN_PYTEST_CLEANUP_DIAGNOSTICS", raising=False)
    pytest_harness._report_pytest_cleanup("remove-failed", error=error)
    assert capsys.readouterr().err == ""
    monkeypatch.setenv("ALBUM_HAVEN_PYTEST_CLEANUP_DIAGNOSTICS", "1")
    pytest_harness._report_pytest_cleanup("remove-failed", error=error)
    output = capsys.readouterr().err
    assert "private" not in output
    assert json.loads(output.removeprefix("PYTEST_HARNESS_CLEANUP=")) == {
        "stage": "remove-failed", "pid": os.getpid(), "error_type": "PermissionError",
        "errno": 13, "winerror": 32,
    }


@pytest.mark.parametrize("relation", ["self", "other", "unrecognized"])
def test_cleanup_diagnostics_report_only_sanitized_root_relation(monkeypatch, capsys, relation):
    name = {
        "self": f"pytest-{os.getpid()}-deadbeef",
        "other": f"pytest-{os.getpid() + 1}-deadbeef",
        "unrecognized": "private-root-name",
    }[relation]
    root = Path("private-parent") / name
    error = PermissionError(13, "private error payload", str(root / "private-file"))
    monkeypatch.delenv("ALBUM_HAVEN_PYTEST_CLEANUP_DIAGNOSTICS", raising=False)
    pytest_harness._report_pytest_cleanup("initial-stat-failed", error=error, path=root)
    assert capsys.readouterr().err == ""
    monkeypatch.setenv("ALBUM_HAVEN_PYTEST_CLEANUP_DIAGNOSTICS", "1")
    pytest_harness._report_pytest_cleanup("initial-stat-failed", error=error, path=root)
    output = capsys.readouterr().err
    assert "private" not in output
    assert "deadbeef" not in output
    assert json.loads(output.removeprefix("PYTEST_HARNESS_CLEANUP=")) == {
        "stage": "initial-stat-failed", "pid": os.getpid(), "root_relation": relation,
        "error_type": "PermissionError", "errno": 13, "winerror": None,
    }


@pytest.mark.parametrize("reason", [
    "name", "symlink", "parent", "payload-type", "kind", "pid", "token",
])
def test_cleanup_guard_diagnostics_preserve_rejected_root(tmp_path, monkeypatch, capsys, reason):
    workspace = tmp_path / "private-workspace"
    root = workspace / f"pytest-{os.getpid()}-deadbeef"
    if reason == "name":
        root = workspace / "private-unrecognized-name"
    _write_owner_marker(root, pid=os.getpid(), token="deadbeef")
    marker = root / ".album-haven-pytest-owner.json"
    payload = json.loads(marker.read_text(encoding="utf-8"))
    if reason == "payload-type":
        payload = ["private-payload"]
    elif reason == "kind":
        payload["kind"] = "private-kind"
    elif reason == "pid":
        payload["pid"] = os.getpid() + 1
    elif reason == "token":
        payload["token"] = "private-token"
    marker.write_text(json.dumps(payload), encoding="utf-8")
    original = marker.read_bytes()
    monkeypatch.setenv("ALBUM_HAVEN_PYTEST_CLEANUP_DIAGNOSTICS", "1")
    allowed_parent = tmp_path / "different-parent" if reason == "parent" else workspace
    monkeypatch.setattr(pytest_harness, "_workspace_pytest_temp_root", lambda: allowed_parent.resolve())
    real_is_symlink = Path.is_symlink
    if reason == "symlink":
        monkeypatch.setattr(Path, "is_symlink", lambda path: path == root or real_is_symlink(path))
    removals = []
    monkeypatch.setattr(pytest_harness.shutil, "rmtree", removals.append)
    assert not pytest_harness._remove_owned_generated_pytest_root(
        root, expected_owner=(os.getpid(), "deadbeef"),
    )
    assert removals == []
    assert root.is_dir()
    assert marker.read_bytes() == original
    output = capsys.readouterr().err
    assert "private" not in output
    assert "deadbeef" not in output
    assert json.loads(output.removeprefix("PYTEST_HARNESS_CLEANUP="))["stage"] == f"owner-{reason}-rejected"


@pytest.mark.parametrize("mode", ["expected-owner", "live-owner", "initial-stat", "retry-stat"])
def test_cleanup_decision_diagnostics_preserve_owned_root(tmp_path, monkeypatch, capsys, mode):
    root = tmp_path / f"pytest-{os.getpid()}-deadbeef"
    _write_owner_marker(root, pid=os.getpid(), token="deadbeef")
    marker = root / ".album-haven-pytest-owner.json"
    owner = json.loads(marker.read_text(encoding="utf-8"))
    original = marker.read_bytes()
    initial_stat = root.stat()
    expected = (os.getpid() + 1, "deadbeef") if mode == "expected-owner" else (os.getpid(), "deadbeef")
    if mode == "live-owner":
        expected = None
    removals = []
    with monkeypatch.context() as patch:
        patch.setenv("ALBUM_HAVEN_PYTEST_CLEANUP_DIAGNOSTICS", "1")
        patch.setattr(pytest_harness, "_owned_generated_pytest_root", lambda path: owner)
        patch.setattr(pytest_harness, "_process_is_running", lambda pid: True)
        patch.setattr(pytest_harness.shutil, "rmtree", removals.append)
        if mode.endswith("stat"):
            def stat(path, *, follow_symlinks=True):
                if mode == "initial-stat" or not follow_symlinks:
                    raise PermissionError(13, "private error", "private-path")
                return initial_stat
            patch.setattr(Path, "stat", stat)
        assert not pytest_harness._remove_owned_generated_pytest_root(root, expected_owner=expected)
    assert removals == []
    assert root.is_dir()
    assert marker.read_bytes() == original
    output = capsys.readouterr().err
    assert "private" not in output
    assert "deadbeef" not in output
    event = json.loads(output.removeprefix("PYTEST_HARNESS_CLEANUP="))
    assert event["stage"] == {
        "expected-owner": "expected-owner-rejected", "live-owner": "stale-owner-live",
        "initial-stat": "initial-stat-failed", "retry-stat": "retry-stat-failed",
    }[mode]
    assert event["root_relation"] == "self"


def test_probe_diagnostics_distinguish_startup_and_all_teardown_phases(tmp_path):
    completed, payload = _run_probe(generated_root=tmp_path / "generated-probes")
    events = [
        json.loads(line.removeprefix("PYTEST_HARNESS_CLEANUP="))
        for line in completed.stderr.splitlines()
        if line.startswith("PYTEST_HARNESS_CLEANUP=")
    ]
    phases = [event["stage"] for event in events if event["stage"].startswith("phase-")]
    assert phases == [
        "phase-stale-start", "phase-stale-end",
        "phase-sessionfinish-start", "phase-sessionfinish-end",
        "phase-unconfigure-start", "phase-unconfigure-end",
        "phase-config-cleanup-start", "phase-config-cleanup-end",
    ]
    assert not Path(str(payload["basetemp"])).exists()
    assert all(set(event) <= {"stage", "pid", "root_relation", "error_type", "errno", "winerror"} for event in events)


def test_stale_diagnostics_distinguish_unmarked_self_from_live_peer(tmp_path, monkeypatch, capsys):
    self_root = tmp_path / f"pytest-{os.getpid()}-deadbeef"
    self_root.mkdir()
    peer_root = tmp_path / f"pytest-{os.getpid() + 1}-cafebabe"
    _write_owner_marker(peer_root, pid=os.getpid() + 1, token="cafebabe")
    peer_marker = peer_root / ".album-haven-pytest-owner.json"
    original = peer_marker.read_bytes()
    monkeypatch.setenv("ALBUM_HAVEN_PYTEST_CLEANUP_DIAGNOSTICS", "1")
    monkeypatch.setattr(pytest_harness, "_workspace_pytest_temp_root", lambda: tmp_path.resolve())
    monkeypatch.setattr(pytest_harness, "_process_is_running", lambda pid: True)
    removals = []
    monkeypatch.setattr(pytest_harness.shutil, "rmtree", removals.append)
    pytest_harness._cleanup_stale_generated_pytest_roots()
    assert removals == []
    assert self_root.is_dir()
    assert peer_marker.read_bytes() == original
    events = [json.loads(line.removeprefix("PYTEST_HARNESS_CLEANUP=")) for line in capsys.readouterr().err.splitlines()]
    assert events[0]["stage"] == "phase-stale-start"
    assert events[-1]["stage"] == "phase-stale-end"
    assert {(event["stage"], event["root_relation"]) for event in events if "root_relation" in event} == {
        ("owner-read-failed", "self"), ("stale-owner-live", "other"),
    }


@pytest.mark.parametrize("reason", ["inode", "symlink", "identity", "stat"])
def test_restoration_guard_diagnostics_preserve_marker(tmp_path, monkeypatch, capsys, reason):
    root = tmp_path / f"pytest-{os.getpid()}-deadbeef"
    _write_owner_marker(root, pid=os.getpid(), token="deadbeef")
    marker = root / ".album-haven-pytest-owner.json"
    original = marker.read_bytes()
    owner = json.loads(original)
    identity = (root.stat().st_dev, root.stat().st_ino)
    fake_stat = SimpleNamespace(st_dev=identity[0], st_ino=identity[1])
    if reason == "inode":
        fake_stat.st_ino = 0
    elif reason == "identity":
        fake_stat.st_ino += 1
    real_stat = Path.stat
    real_is_symlink = Path.is_symlink

    def stat(path, **kwargs):
        if path != root:
            return real_stat(path, **kwargs)
        if reason == "stat":
            raise PermissionError(13, "private message", "private-file")
        return fake_stat

    with monkeypatch.context() as patch:
        patch.setenv("ALBUM_HAVEN_PYTEST_CLEANUP_DIAGNOSTICS", "1")
        patch.setattr(Path, "stat", stat)
        patch.setattr(Path, "is_symlink", lambda path: reason == "symlink" if path == root else real_is_symlink(path))
        assert not pytest_harness._preserve_pytest_owner_after_partial_removal(root, owner, identity)
    assert root.is_dir()
    assert marker.read_bytes() == original
    output = capsys.readouterr().err
    assert "private" not in output
    event = json.loads(output.removeprefix("PYTEST_HARNESS_CLEANUP="))
    assert event["stage"] == {
        "inode": "restoration-inode-unavailable", "symlink": "restoration-symlink-rejected",
        "identity": "restoration-identity-rejected", "stat": "owner-restoration-failed",
    }[reason]


@pytest.mark.parametrize("reason", ["symlink", "identity", "owner"])
def test_revalidation_guard_diagnostics_preserve_owned_root(tmp_path, monkeypatch, capsys, reason):
    root = tmp_path / f"pytest-{os.getpid()}-deadbeef"
    _write_owner_marker(root, pid=os.getpid(), token="deadbeef")
    marker = root / ".album-haven-pytest-owner.json"
    original = marker.read_bytes()
    owner = json.loads(original)
    initial_stat = root.stat()
    real_stat = Path.stat
    real_is_symlink = Path.is_symlink
    reads = []
    removals = []

    def read_owner(path):
        reads.append(path)
        return None if reason == "owner" and len(reads) > 1 else owner

    def stat(path, *, follow_symlinks=True):
        if path != root:
            return real_stat(path, follow_symlinks=follow_symlinks)
        if reason == "identity" and not follow_symlinks:
            return SimpleNamespace(st_dev=initial_stat.st_dev, st_ino=initial_stat.st_ino + 1)
        return initial_stat

    with monkeypatch.context() as patch:
        patch.setenv("ALBUM_HAVEN_PYTEST_CLEANUP_DIAGNOSTICS", "1")
        patch.setattr(pytest_harness, "_owned_generated_pytest_root", read_owner)
        patch.setattr(pytest_harness.shutil, "rmtree", removals.append)
        patch.setattr(Path, "stat", stat)
        patch.setattr(Path, "is_symlink", lambda path: reason == "symlink" if path == root else real_is_symlink(path))
        assert not pytest_harness._remove_owned_generated_pytest_root(root, expected_owner=(os.getpid(), "deadbeef"))
    assert removals == []
    assert root.is_dir()
    assert marker.read_bytes() == original
    event = json.loads(capsys.readouterr().err.removeprefix("PYTEST_HARNESS_CLEANUP="))
    assert event["stage"] == {
        "symlink": "revalidation-symlink-rejected", "identity": "revalidation-identity-rejected",
        "owner": "owner-revalidation-rejected",
    }[reason]


@pytest.mark.parametrize("reason", ["not-generated", "basetemp-unavailable", "token-unavailable"])
def test_config_cleanup_prerequisite_diagnostics_do_not_remove_roots(monkeypatch, capsys, reason):
    config = SimpleNamespace(
        _album_haven_generated_basetemp=reason != "not-generated",
        _album_haven_generated_basetemp_token=None if reason == "token-unavailable" else "deadbeef",
        _tmp_path_factory=SimpleNamespace(
            _basetemp=None if reason == "basetemp-unavailable" else Path(f"pytest-{os.getpid()}-deadbeef"),
        ),
    )
    removals = []
    monkeypatch.setenv("ALBUM_HAVEN_PYTEST_CLEANUP_DIAGNOSTICS", "1")
    monkeypatch.setattr(pytest_harness, "_remove_owned_generated_pytest_root", lambda *args, **kwargs: removals.append(args))
    pytest_harness._cleanup_generated_pytest_root(config)
    assert removals == []
    event = json.loads(capsys.readouterr().err.removeprefix("PYTEST_HARNESS_CLEANUP="))
    assert event["stage"] == f"cleanup-{reason}"
