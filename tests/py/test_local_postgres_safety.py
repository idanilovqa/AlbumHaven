"""Outside GitHub Actions no test or test script reaches port 5432, or prints a secret.

On a developer machine 5432 is the installed Postgres, which can be production's. These tests never
open a connection: the bootstrap is pointed at a PGBIN that does not exist, and the driver is faked.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = ROOT / "scripts" / "ci" / "bootstrap-windows-postgres.ps1"
SENTINEL = "sentinel-admin-secret-never-printed"
windows_only = pytest.mark.skipif(os.name != "nt", reason="the bootstrap is Windows-only")


def _run_bootstrap(tmp_path: Path, *, mode: str, port: int, actions: bool) -> subprocess.CompletedProcess:
    env = {**os.environ, "POSTGRESQL_ADMIN_PASSWORD": SENTINEL, "PGPORT": "1", "PGPASSFILE": "NUL"}
    env.pop("GITHUB_ACTIONS", None)
    if actions:
        env["GITHUB_ACTIONS"] = "true"
    return subprocess.run(
        [
            shutil.which("pwsh") or shutil.which("powershell") or "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(BOOTSTRAP),
            "-Mode", mode,
            # No executables here: provisioning stops before it could connect.
            "-Pgbin", str(tmp_path / "17" / "bin"),
            "-RepositoryRoot", str(ROOT),
            "-DatabaseSuffix", "safety_contract",
            "-RunnerTemp", str(tmp_path / "runner"),
            "-GithubEnv", str(tmp_path / "github.env"),
            "-Port", str(port),
        ],
        env=env, capture_output=True, text=True, timeout=120,
    )


def _assert_reached_preflight(result: subprocess.CompletedProcess) -> None:
    """The mask comes just before the preflight, so a check of it counts only once that was reached."""
    output = (result.stdout + result.stderr).replace(SENTINEL, "<admin secret>")
    reached = "PGBIN executable is missing" in " ".join(output.split())
    assert reached, f"the bootstrap stopped before its preflight: {output[-1500:]}"


@windows_only
@pytest.mark.parametrize("mode", ["Provision", "Teardown"])
def test_the_bootstrap_refuses_the_installed_server_outside_github_actions(tmp_path, mode):
    result = _run_bootstrap(tmp_path, mode=mode, port=5432, actions=False)

    assert result.returncode != 0
    assert "refuses port 5432 outside GitHub Actions" in " ".join((result.stdout + result.stderr).split())


@windows_only
def test_the_bootstrap_prints_no_secret_outside_github_actions(tmp_path):
    result = _run_bootstrap(tmp_path, mode="Provision", port=54329, actions=False)

    # Never echo the captured output: on failure it would hold the secret.
    leaked = SENTINEL in result.stdout or SENTINEL in result.stderr
    assert not leaked, "the bootstrap printed the admin secret"
    _assert_reached_preflight(result)


@windows_only
def test_the_bootstrap_still_masks_the_secret_on_github_actions(tmp_path):
    result = _run_bootstrap(tmp_path, mode="Provision", port=54329, actions=True)

    _assert_reached_preflight(result)
    masked = f"::add-mask::{SENTINEL}" in result.stdout
    assert masked, "GitHub Actions needs the masking command"


class _Driver:
    opened: list = []

    @classmethod
    def connect(cls, conninfo: str = "", **kwargs):
        cls.opened.append((conninfo, kwargs))
        return "connected"


@pytest.fixture
def guarded_driver(monkeypatch):
    from tests.e2e.support import localPostgresGuard

    class Driver(_Driver):
        opened: list = []

    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.delenv("PGPORT", raising=False)
    monkeypatch.delenv("PGSERVICE", raising=False)
    localPostgresGuard.guard_connect(Driver)
    return Driver


@pytest.mark.parametrize(
    "conninfo, kwargs",
    [
        ("", {}),
        ("postgresql://album_haven_app@localhost/album_haven_test", {}),
        ("postgresql://album_haven_app@127.0.0.1:5432/album_haven_ci_x", {}),
        ("host=localhost port=54329,5432 dbname=x", {}),
        ("dbname=x", {"port": 5432}),
        ("service=production", {}),
        ("host=localhost port=1 dbname=x", {}),
        ("host=localhost port=05432 dbname=x", {}),
        ("host=localhost port=+5432 dbname=x", {}),
    ],
)
def test_a_local_test_connection_to_the_installed_server_is_refused_before_it_opens(guarded_driver, conninfo, kwargs):
    import psycopg

    with pytest.raises(psycopg.OperationalError, match="local tests never connect"):
        guarded_driver.connect(conninfo, **kwargs)

    assert guarded_driver.opened == []


def test_a_named_throwaway_cluster_is_still_reachable(guarded_driver):
    url = "postgresql://album_haven_app@127.0.0.1:54329/album_haven_ci_x"

    assert guarded_driver.connect(url) == "connected"
    assert guarded_driver.opened == [(url, {})]


def test_github_actions_keeps_its_own_server(guarded_driver, monkeypatch):
    monkeypatch.setenv("GITHUB_ACTIONS", "true")

    assert guarded_driver.connect("postgresql://album_haven_app@localhost/album_haven_ci_x") == "connected"


def test_the_pytest_session_guards_the_real_driver_only_outside_github_actions():
    import psycopg

    # On GitHub Actions the runner's own disposable server is the test server, so nothing is guarded.
    expected = os.environ.get("GITHUB_ACTIONS") != "true"
    for connect in (psycopg.connect, psycopg.Connection.connect, psycopg.AsyncConnection.connect):
        assert getattr(connect, "refuses_installed_server", False) is expected, connect


@pytest.mark.parametrize("script", ["load-fixture-profile.py", "functional-fixture-checkpoint.py"])
def test_a_fixture_script_installs_the_guard_in_its_own_process(script):
    env = {**os.environ, "PGPORT": "1", "PGPASSFILE": "NUL"}
    env.pop("GITHUB_ACTIONS", None)
    # Loads the script without its main(): nothing connects.
    probe = (
        "import runpy, sys, psycopg; runpy.run_path(sys.argv[1], run_name='probe'); "
        "print(getattr(psycopg.connect, 'refuses_installed_server', False))"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe, str(ROOT / "scripts" / "ci" / script)],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=120,
    )

    assert result.returncode == 0, result.stderr[-1500:]
    assert result.stdout.strip() == "True"
