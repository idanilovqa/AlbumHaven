from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP_PATH = REPO_ROOT / "scripts" / "ci" / "bootstrap-windows-postgres.ps1"


def _run_contract(tmp_path: Path) -> subprocess.CompletedProcess[str]:
    executable = shutil.which("pwsh") or shutil.which("powershell")
    if executable is None:
        pytest.skip("PowerShell is required for the Windows Postgres bootstrap contract")

    pgbin = tmp_path / "PostgreSQL" / "17" / "bin"
    pgbin.mkdir(parents=True)
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    return subprocess.run(
        [
            executable,
            "-NoProfile",
            "-File",
            str(BOOTSTRAP_PATH),
            "-Mode",
            "Contract",
            "-ServiceName",
            "postgresql-x64-17",
            "-ExpectedMajorVersion",
            "17",
            "-Pgbin",
            str(pgbin),
            "-HostName",
            "localhost",
            "-DatabaseSuffix",
            "phase_8_jobs",
            "-RepositoryRoot",
            str(REPO_ROOT),
            "-RunnerTemp",
            str(runner_temp),
            "-GithubEnv",
            str(tmp_path / "github.env"),
            "-StatePath",
            str(tmp_path / "bootstrap-state.json"),
        ],
        capture_output=True,
        encoding="utf-8",
        check=False,
        timeout=30,
    )


@pytest.fixture
def bootstrap_contract(tmp_path: Path) -> dict[str, object]:
    result = _run_contract(tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    assert isinstance(payload, dict)
    return payload


def test_bootstrap_contract_defines_dedicated_worker_login_and_privilege_boundary(
    bootstrap_contract,
):
    assert bootstrap_contract["roles"]["worker"] == "album_haven_worker_phase_8_jobs"
    assert bootstrap_contract["privilegeProbes"]["worker"] == {
        "allow": [
            "connect",
            "schema-usage",
            "select",
            "insert",
            "update",
            "sequence-usage",
        ],
        "deny": [
            "create-schema",
            "temporary-table",
            "delete",
            "truncate",
            "references",
            "trigger",
        ],
    }


def test_bootstrap_contract_exports_passwordless_worker_url(bootstrap_contract):
    exports = bootstrap_contract["githubEnvExports"]
    assert exports["ALBUM_HAVEN_WORKER_DATABASE_URL"] == (
        "postgresql://album_haven_worker_phase_8_jobs@localhost/"
        "album_haven_ci_phase_8_jobs"
    )
    assert "password" not in exports["ALBUM_HAVEN_WORKER_DATABASE_URL"].casefold()


def test_bootstrap_contract_tracks_worker_for_exact_teardown(bootstrap_contract):
    assert bootstrap_contract["teardown"]["dropRoles"] == [
        "album_haven_app_phase_8_jobs",
        "album_haven_readonly_phase_8_jobs",
        "album_haven_worker_phase_8_jobs",
        "album_haven_migrator_phase_8_jobs",
    ]


def test_bootstrap_provisions_worker_base_role_login_secret_and_pgpass_entry():
    source = BOOTSTRAP_PATH.read_text(encoding="utf-8").casefold()

    assert "create role album_haven_worker nologin" in source
    assert "create role $($names.roles.worker) login" in source
    assert "in role album_haven_worker" in source
    assert "worker = new-secret" in source
    assert "$($names.roles.worker)`:$($secrets.worker)" in source
    assert "grant connect on database" in source
    assert "album_haven_worker" in source


def test_bootstrap_executes_worker_denied_delete_probe_with_worker_login():
    source = BOOTSTRAP_PATH.read_text(encoding="utf-8").casefold()

    assert "$workerprobesql = @'" in source
    assert "delete from ops.jobs" in source
    assert "worker unexpectedly deleted ops.jobs" in source
    assert "exception when insufficient_privilege" in source
    assert (
        "invoke-psqltext $psql $names.roles.worker $names.database $workerprobesql"
        in source
    )
