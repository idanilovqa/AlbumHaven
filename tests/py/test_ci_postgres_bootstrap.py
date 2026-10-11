from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
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
    assert exports["ALBUM_HAVEN_FAKE_E2E_WORKER_DATABASE_URL"] == exports[
        "ALBUM_HAVEN_WORKER_DATABASE_URL"
    ]


def test_bootstrap_hashes_migrations_without_powershell_module_commands(
    bootstrap_contract,
):
    source = BOOTSTRAP_PATH.read_text(encoding="utf-8")
    source_casefold = source.casefold()

    assert "get-filehash" not in source_casefold
    assert re.search(
        r"(?im)^function\s+[a-z0-9_-]*sha256[a-z0-9_-]*\s*\{",
        source,
    )
    assert "[System.Security.Cryptography.SHA256]::Create()" in source
    assert "[System.IO.File]::OpenRead(" in source

    migration = bootstrap_contract["migrations"][0]
    digest = migration["sha256"]
    migration_path = REPO_ROOT / "migrations" / "postgres" / migration["name"]

    assert re.fullmatch(r"[0-9a-f]{64}", digest)
    assert digest == hashlib.sha256(migration_path.read_bytes()).hexdigest()


def test_python_ci_restores_worker_url_for_destructive_database():
    workflow = (REPO_ROOT / ".github" / "workflows" / "pr-gates.yml").read_text(
        encoding="utf-8"
    )
    capture = workflow.split("- name: Capture destructive Python database contracts", 1)[1]
    capture = capture.split("- name:", 1)[0]
    export = workflow.split("- name: Export isolated Python database contracts", 1)[1]
    export = export.split("- name:", 1)[0]

    assert (
        "PYTEST_DESTRUCTIVE_WORKER_DATABASE_URL=$env:ALBUM_HAVEN_WORKER_DATABASE_URL"
        in capture
    )
    for name in (
        "ALBUM_HAVEN_WORKER_DATABASE_URL",
        "ALBUM_HAVEN_FAKE_E2E_WORKER_DATABASE_URL",
    ):
        assert f"{name}=$env:PYTEST_DESTRUCTIVE_WORKER_DATABASE_URL" in export
    assert "ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL=$env:DATABASE_APP_URL" in export


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


def test_bootstrap_worker_probe_requires_every_table_and_column_privilege():
    source = BOOTSTRAP_PATH.read_text(encoding="utf-8").casefold()

    assert "has_table_privilege(current_user,'ops.jobs','select,update')" not in source
    for table, privilege in (
        ("ops.jobs", "select"),
        ("ops.job_transitions", "select"),
        ("ops.job_transitions", "insert"),
        ("ops.worker_instances", "select"),
        ("ops.worker_instances", "insert"),
        ("ops.worker_instances", "update"),
    ):
        assert f"has_table_privilege(current_user,'{table}','{privilege}')" in source
    for column in (
        "state",
        "scheduled_at",
        "attempt_count",
        "lease_owner",
        "lease_token",
        "lease_expires_at",
        "heartbeat_at",
        "started_at",
        "completed_at",
        "outcome_code",
        "updated_at",
    ):
        assert (
            f"has_column_privilege(current_user,'ops.jobs','{column}','update')"
            in source
        )


def test_direct_app_login_copies_inherited_column_privileges():
    source = BOOTSTRAP_PATH.read_text(encoding="utf-8").casefold()

    assert "pg_attribute" in source
    assert "has_column_privilege(" in source
    assert "'album_haven_app', relation.oid, attribute.attnum" in source
    assert "grant %s (%i) on table %s to %i" in source
