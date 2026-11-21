import ast
from pathlib import Path
import re
import shutil
import subprocess

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
RUNNER_PATH = REPO_ROOT / "scripts" / "ci" / "run-phase8-task9-projection.ps1"


@pytest.fixture(params=["pwsh", "powershell"])
def lease_shell(request):
    executable = shutil.which(request.param)
    if executable is None:
        pytest.skip(f"{request.param} is not installed")
    return executable


def _run_port_lease_case(lease_shell, tmp_path, case):
    harness = tmp_path / "port-lease-case.ps1"
    harness.write_text(
        r"""
param([string]$RunnerPath, [string]$RegistryRoot)
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    $RunnerPath, [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count) { throw 'Runner did not parse' }
$functionNames = @(
    'Invoke-WithTask9PortLeaseLock', 'Read-Task9PortLeases',
    'Write-Task9PortLeases', 'Test-Task9PortLeaseOwner',
    'Test-Task9PortBlockOverlap', 'Acquire-Task9PerformancePortLease',
    'Release-Task9PerformancePortLease'
)
foreach ($name in $functionNames) {
    $definition = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $name
    }, $true))
    if ($definition.Count -ne 1) { throw "Missing or ambiguous function: $name" }
    Invoke-Expression $definition[0].Extent.Text
}
$portLeaseRoot = $RegistryRoot
$portLeaseRegistry = Join-Path $portLeaseRoot 'leases.json'
$portLeaseLock = Join-Path $portLeaseRoot 'leases.lock'
$runId = 'owned-test-run'
$ownerStartTimeUtc = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('O')
New-Item -ItemType Directory -Path $portLeaseRoot -Force | Out-Null
$unrelated = [pscustomobject]@{
    runId = 'unrelated-live-run'; pid = $PID; basePort = 20000; portCount = 16
    processStartTimeUtc = $ownerStartTimeUtc
}
"""
        + case,
        encoding="utf-8-sig",
    )
    result = subprocess.run(
        [lease_shell, "-NoProfile", "-NonInteractive", "-File", str(harness),
         str(RUNNER_PATH), str(tmp_path / "registry")],
        capture_output=True,
        text=True,
        timeout=30,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_port_lease_json_roundtrip_preserves_live_owner(lease_shell, tmp_path):
    _run_port_lease_case(lease_shell, tmp_path, r"""
Write-Task9PortLeases @($unrelated)
$loaded = @(Read-Task9PortLeases)
if ($loaded.Count -ne 1 -or -not (Test-Task9PortLeaseOwner $loaded[0])) {
    throw 'JSON roundtrip rejected a live lease owner'
}
if ($loaded[0].processStartTimeUtc -isnot [string] -or
    $loaded[0].processStartTimeUtc -cne $ownerStartTimeUtc) {
    throw 'JSON roundtrip changed the canonical UTC start time'
}
""")


def test_port_lease_replaces_existing_registry(lease_shell, tmp_path):
    _run_port_lease_case(lease_shell, tmp_path, r"""
Write-Task9PortLeases @($unrelated)
Write-Task9PortLeases @()
if (@(Read-Task9PortLeases).Count -ne 0) {
    throw 'Replacing the registry did not persist the empty lease set'
}
""")


def test_port_lease_acquire_release_preserves_other_live_owner(lease_shell, tmp_path):
    _run_port_lease_case(lease_shell, tmp_path, r"""
function New-Task9PortProbes([int]$BasePort, [int]$BlockSize) {
    for ($index = 0; $index -lt $BlockSize; $index++) {
        $probe = [pscustomobject]@{}
        $probe | Add-Member ScriptMethod Stop { $script:probeStops++ }
        $probe
    }
}
$script:probeStops = 0
$dead = [pscustomobject]@{
    runId = 'dead-run'; pid = [int]::MaxValue; basePort = 20016; portCount = 16
    processStartTimeUtc = $ownerStartTimeUtc
}
$reused = [pscustomobject]@{
    runId = 'reused-pid-run'; pid = $PID; basePort = 20032; portCount = 16
    processStartTimeUtc = ([datetime]$ownerStartTimeUtc).AddSeconds(-1).ToString('O')
}
Write-Task9PortLeases @($unrelated, $dead, $reused)
$owned = Acquire-Task9PerformancePortLease
$loaded = @(Read-Task9PortLeases)
if ($owned.basePort -ne 20016 -or $loaded.Count -ne 2 -or
    $script:probeStops -ne 16) {
    throw 'Acquisition lost a live lease or retained a dead/reused owner'
}
Release-Task9PerformancePortLease $owned
$remaining = @(Read-Task9PortLeases)
if ($remaining.Count -ne 1 -or
    $remaining[0].runId -cne $unrelated.runId -or
    -not (Test-Task9PortLeaseOwner $remaining[0])) {
    throw 'Release changed an unrelated live lease'
}
""")


def test_hard_coded_pytest_node_ids_reference_existing_test_symbols():
    source = RUNNER_PATH.read_text(encoding="utf-8")
    node_ids = re.findall(r"['\"](tests/py/[^'\"]+\.py::[^'\"]+)['\"]", source)

    assert node_ids
    for node_id in node_ids:
        test_path_text, _, symbol_text = node_id.partition("::")
        test_path = REPO_ROOT / test_path_text
        assert test_path.is_file(), f"pytest node ID references missing file: {node_id}"

        symbol_path = symbol_text.split("[", 1)[0].split("::")
        scope = ast.parse(test_path.read_text(encoding="utf-8")).body
        for symbol in symbol_path:
            definition = next(
                (
                    node
                    for node in scope
                    if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
                    and node.name == symbol
                ),
                None,
            )
            assert definition is not None, f"pytest node ID references missing symbol: {node_id}"
            scope = definition.body


def test_capability_fixture_root_is_explicit_and_checksum_verified():
    source = RUNNER_PATH.read_text(encoding="utf-8")
    resolver_start = source.index("function Resolve-Task9FixtureRoot")
    resolver_end = source.index("function Import-DatabaseEnvironment")
    resolver = source[resolver_start:resolver_end]
    capability_start = source.index("function Invoke-Task9Capability")
    capability_end = source.index("function Invoke-Task9ReaderRed")
    capability = source[capability_start:capability_end]

    assert "[string]$FixtureRoot = $env:ALBUM_HAVEN_FIXTURE_ROOT" in source
    assert "$task9FixtureRelease = 'fixtures-v1.0.27'" in source
    assert "$task9FixtureProfile = 'utility-problematic-files'" in source
    assert (
        "$task9FixtureManifestSha256 = "
        "'1EBFCAD153AF13CA077CA2B443EB47162C5582994C58BBED8F79332B098DDBFA'"
    ) in source
    assert "[IO.Path]::GetFullPath($RequestedRoot)" in resolver
    assert "[Security.Cryptography.SHA256]::Create()" in resolver
    assert "ConvertFrom-Json" in resolver
    assert ".databaseSeed" in resolver
    assert ".mediaRoot" in resolver
    assert "$fixtureRoot = Resolve-Task9FixtureRoot $FixtureRoot" in capability
    assert "--fixture-root $fixtureRoot" in capability
    assert "ALBUM_HAVEN_FIXTURE_ROOT is required" not in capability


def test_cleanup_audit_owns_and_bounds_direct_psql_process():
    source = RUNNER_PATH.read_text(encoding="utf-8")
    helper_start = source.index("function Invoke-Task9PsqlScalar")
    assertion_start = source.index("function Assert-Task9PostgresRemoved")
    helper = source[helper_start:assertion_start]
    assertion = source[assertion_start:]

    assert "[Diagnostics.ProcessStartInfo]::new()" in helper
    assert ".FileName = 'C:\\PostgreSQL\\18\\bin\\psql.exe'" in helper
    assert ".UseShellExecute = $false" in helper
    assert ".RedirectStandardInput = $true" in helper
    assert ".Arguments = '-X -tA -v ON_ERROR_STOP=1 " in helper
    assert ".Environment['PGPASSFILE'] = $adminPgpass" in helper
    assert ".StandardInput.WriteLine($Sql)" in helper
    assert ".WaitForExit($TimeoutSeconds * 1000)" in helper
    assert ".Kill()" in helper
    assert ".ArgumentList" not in helper
    assert ".Kill($true)" not in helper
    assert "Invoke-Task9PsqlScalar -Sql $sql" in assertion
    assert "& 'C:\\PostgreSQL\\18\\bin\\psql.exe'" not in assertion
    assert "rtk" not in helper.casefold()


def test_performance_stage_uses_locked_16_port_lease_and_hidden_child():
    source = RUNNER_PATH.read_text(encoding="utf-8")
    performance_start = source.index("function Invoke-Task9PfPerformance")
    performance = source[performance_start:]

    assert "[IO.FileShare]::None" in source
    assert "Acquire-Task9PerformancePortLease" in performance
    assert "$performancePortCount = 16" in performance
    assert "processStartTimeUtc" in source
    assert "New-Task9PortProbes" in source
    assert "[Diagnostics.ProcessStartInfo]::new()" in performance
    assert ".UseShellExecute = $false" in performance
    assert ".CreateNoWindow = $true" in performance
    assert ".WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden" in performance
    assert ".RedirectStandardOutput = $true" in performance
    assert ".RedirectStandardError = $true" in performance
    assert "Get-Task9PerformanceBasePort" not in source
    assert "& .\\scripts\\ci\\run-performance-shard.ps1" not in performance


def test_performance_stage_cleans_only_exact_owned_tree_before_recovery():
    source = RUNNER_PATH.read_text(encoding="utf-8")
    performance_start = source.index("function Invoke-Task9PfPerformance")
    performance = source[performance_start:]

    assert "Add-Task9OwnedProcessSnapshot" in source
    assert "Test-Task9ExactProcessAlive" in source
    assert "Stop-AndAssertTask9ProcessTree" in source
    assert "CreationDate" in source
    assert "Invoke-Task9PerformanceTakeoverTeardown" in source
    assert "Assert-Task9PerformancePostgresRemoved" in source
    assert "Wait-Task9PerformancePortsClear" in source
    assert "Release-Task9PerformancePortLease" in source
    assert performance.index("Stop-AndAssertTask9ProcessTree") < performance.index(
        "Invoke-Task9PerformanceTakeoverTeardown"
    )
    assert performance.index("Wait-Task9PerformancePortsClear") < performance.index(
        "Release-Task9PerformancePortLease"
    )
    assert "taskkill" not in performance.casefold()


def test_storage_green_excludes_explain_cases_owned_by_fixture_loaded_stages():
    source = RUNNER_PATH.read_text(encoding="utf-8")
    storage_start = source.index("Invoke-PytestStage 'task9a-storage-green'")
    storage_end = source.index("$evidence = New-Task9StageEvidence 'task9a-impact-green'")
    capability_start = source.index("function Invoke-Task9Capability")
    capability_end = source.index("function Invoke-Task9ReaderRed")
    reader_explain_start = source.index("function Invoke-Task9ReaderExplain")
    reader_explain_end = source.index("function Invoke-Task9PfDatabase")

    assert "'-k', 'not explain'" in source[storage_start:storage_end]
    assert "explain_source_page or explain_stage_publication" in source[
        capability_start:capability_end
    ]
    assert "explain_integrity_keyset" in source[capability_start:capability_end]
    assert "explain_unfiltered_keyset or explain_reason_filter" in source[
        reader_explain_start:reader_explain_end
    ]


def test_task9a_green_selects_every_exact_reason_recovery_regression():
    source = RUNNER_PATH.read_text(encoding="utf-8")
    job_start = source.index("Invoke-PytestStage 'task9a-job-green'")
    storage_start = source.index("Invoke-PytestStage 'task9a-storage-green'")
    impact_start = source.index("$evidence = New-Task9StageEvidence 'task9a-impact-green'")
    job = source[job_start:storage_start]
    storage = source[storage_start:impact_start]

    for selection in (
        "terminal_failure",
        "terminal_recovery",
        "reason_fact_staging",
        "compact_metadata",
        "ownership_moves",
    ):
        assert selection in job

    for test_file in (
        "tests/py/test_problematic_files_projection.py",
        "tests/py/test_problematic_projection_postgres.py",
        "tests/py/test_problematic_projection_integrity.py",
    ):
        assert test_file in storage
    assert "'-k', 'not explain'" in storage

    junit_start = source.index("function Assert-JunitExecuted")
    junit_end = source.index("function Invoke-PytestStage")
    junit = source[junit_start:junit_end]
    assert "if ($skipped -ne 0)" in junit


def test_problematic_functional_gate_requires_exactly_five_owning_shard_groups():
    source = RUNNER_PATH.read_text(encoding="utf-8")
    functional_start = source.index("function Invoke-Task9PfFunctional")
    functional_end = source.index("$portLeaseRoot", functional_start)
    functional = source[functional_start:functional_end]

    assert "@($selectedCases | Group-Object Shard).Count -ne 5" in functional
    assert "Expected exactly five Problematic Files owning shards" in functional


def test_port_lease_owner_uses_recorded_start_time_representation_and_fails_closed():
    source = RUNNER_PATH.read_text(encoding="utf-8")
    helper_start = source.index("function Test-Task9PortLeaseOwner")
    helper_end = source.index("function Test-Task9PortBlockOverlap")
    helper = source[helper_start:helper_end]

    assert "[Diagnostics.Process]::GetProcessById" in helper
    assert ".StartTime.ToUniversalTime().ToString('O')" in helper
    assert "Get-CimInstance" not in helper
    assert "CreationDate" not in helper
    assert "catch [ArgumentException]" in helper
    assert "return $false" in helper
    assert "Cannot read Task 9 port lease owner" in helper


def test_port_audit_and_recovery_retention_fail_closed():
    source = RUNNER_PATH.read_text(encoding="utf-8")
    audit_start = source.index("function Wait-Task9PerformancePortsClear")
    audit_end = source.index("function Add-Task9OwnedProcessSnapshot")
    audit = source[audit_start:audit_end]
    performance_start = source.index("function Invoke-Task9PfPerformance")
    performance = source[performance_start:]

    assert "Get-NetTCPConnection" in audit
    assert "-ErrorAction Stop" in audit
    assert "SilentlyContinue" not in audit
    assert "Task 9 performance recovery state retained at $performanceTemp" in performance
    removal_start = performance.index("Remove-Item -LiteralPath $performanceTemp")
    retained_path = performance.index(
        "Task 9 performance recovery state retained at $performanceTemp",
        removal_start,
    )
    assert removal_start < retained_path


def test_port_audit_enumerates_once_then_filters_the_leased_range():
    source = RUNNER_PATH.read_text(encoding="utf-8")
    audit_start = source.index("function Wait-Task9PerformancePortsClear")
    audit_end = source.index("function Add-Task9OwnedProcessSnapshot")
    audit = source[audit_start:audit_end]

    assert audit.count("Get-NetTCPConnection") == 1
    assert "Get-NetTCPConnection -ErrorAction Stop" in audit
    assert "Get-NetTCPConnection -LocalPort" not in audit
    assert "$_.LocalPort -ge $BasePort" in audit
    assert "$_.LocalPort -lt ($BasePort + $BlockSize)" in audit


def test_process_helpers_dispose_handles_and_persist_takeover_timeout_output():
    source = RUNNER_PATH.read_text(encoding="utf-8")
    lease_start = source.index("function Test-Task9PortLeaseOwner")
    lease_end = source.index("function Test-Task9PortBlockOverlap")
    cleanup_start = source.index("function Stop-AndAssertTask9ProcessTree")
    cleanup_end = source.index("function Assert-Task9PerformancePostgresRemoved")
    takeover_start = source.index("function Invoke-Task9PerformanceTakeoverTeardown")
    takeover_end = source.index("function Invoke-Task9PfPerformance")
    lease = source[lease_start:lease_end]
    cleanup = source[cleanup_start:cleanup_end]
    takeover = source[takeover_start:takeover_end]

    assert "$process.Dispose()" in lease
    assert "$process.Dispose()" in cleanup
    stdout_log = takeover.index("takeover-teardown.stdout.log")
    stderr_log = takeover.index("takeover-teardown.stderr.log")
    timeout_failure = takeover.index("Task 9 takeover teardown timed out")
    assert stdout_log < timeout_failure
    assert stderr_log < timeout_failure


def test_failed_performance_start_cleans_with_null_root_then_releases_lease():
    source = RUNNER_PATH.read_text(encoding="utf-8")
    performance_start = source.index("function Invoke-Task9PfPerformance")
    performance = source[performance_start:]

    initialized = performance.index("$performanceProcessStarted = $false")
    started = performance.index("$performanceProcessStarted = $true")
    cleanup_root = performance.index(
        "$cleanupRoot = if ($performanceProcessStarted) { $performanceProcess } else { $null }"
    )
    cleanup = performance.index("Stop-AndAssertTask9ProcessTree $cleanupRoot")
    database_audit = performance.index("Assert-Task9PerformancePostgresRemoved")
    port_audit = performance.index("Wait-Task9PerformancePortsClear")
    release = performance.index("Release-Task9PerformancePortLease")

    assert initialized < started < cleanup_root < cleanup
    assert cleanup < database_audit < port_audit < release
