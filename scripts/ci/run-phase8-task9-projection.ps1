[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet(
        'job-red', 'storage-red', 'task9a-green', 'capability', 'reader-red',
        'task9b-green', 'reader-explain', 'pf-database', 'pf-javascript',
        'pf-functional', 'pf-performance', 'edit-tags'
    )]
    [string[]]$Stage,
    [string]$FixtureRoot = $env:ALBUM_HAVEN_FIXTURE_ROOT
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$python = 'C:\Users\Rendref\.cache\album-haven\python-3.11\python.exe'
$adminPgpass = 'C:\Users\Rendref\AppData\Roaming\postgresql\pgpass.conf'
$task9FixtureRelease = 'fixtures-v1.0.27'
$task9FixtureProfile = 'utility-problematic-files'
$task9FixtureManifestSha256 = '1EBFCAD153AF13CA077CA2B443EB47162C5582994C58BBED8F79332B098DDBFA'
$runId = '{0}_{1}' -f ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')),
    ([guid]::NewGuid().ToString('N').Substring(0, 12))
$runRoot = Join-Path $repositoryRoot ".tmp/phase8-problematic-projection/$runId"
$runnerTemp = Join-Path ([IO.Path]::GetTempPath()) "album-haven-task9-$runId"
$githubEnv = Join-Path $runnerTemp 'database.env'
$statePath = Join-Path $runnerTemp 'database.state.json'
$suffix = "phase8_task9_$($runId.Substring($runId.Length - 12))"

if (Test-Path -LiteralPath $runRoot) { throw "Task 9 run root already exists: $runRoot" }
New-Item -ItemType Directory -Path $runRoot -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path $runnerTemp -ErrorAction Stop | Out-Null
Set-Location $repositoryRoot

function Resolve-Task9FixtureRoot([string]$RequestedRoot) {
    if ([string]::IsNullOrWhiteSpace($RequestedRoot)) {
        throw 'FixtureRoot is required for Task 9A EXPLAIN evidence.'
    }
    $resolved = [IO.Path]::GetFullPath($RequestedRoot)
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        throw "Task 9 fixture root does not exist: $resolved"
    }
    $manifestPath = Join-Path $resolved 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Task 9 fixture manifest does not exist: $manifestPath"
    }
    $stream = [IO.File]::OpenRead($manifestPath)
    try {
        $hasher = [Security.Cryptography.SHA256]::Create()
        try {
            $manifestSha256 = ([BitConverter]::ToString(
                $hasher.ComputeHash($stream)
            )).Replace('-', '')
        } finally {
            $hasher.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
    if ($manifestSha256 -cne $task9FixtureManifestSha256) {
        throw "Task 9 fixture manifest checksum mismatch: $manifestPath"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([string]$manifest.release -cne $task9FixtureRelease) {
        throw "Task 9 fixture release must be $task9FixtureRelease."
    }
    $profile = $manifest.profiles.PSObject.Properties[$task9FixtureProfile]
    if ($null -eq $profile) {
        throw "Task 9 fixture manifest does not define $task9FixtureProfile."
    }
    foreach ($requiredPath in @(
        (Join-Path $resolved ([string]$profile.Value.databaseSeed)),
        (Join-Path $resolved ([string]$profile.Value.mediaRoot))
    )) {
        if (-not (Test-Path -LiteralPath $requiredPath)) {
            throw "Task 9 fixture path does not exist: $requiredPath"
        }
    }
    return $resolved
}

function Import-DatabaseEnvironment([string]$Path) {
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        $separator = $line.IndexOf('=')
        if ($separator -le 0) { continue }
        [Environment]::SetEnvironmentVariable(
            $line.Substring(0, $separator), $line.Substring($separator + 1), 'Process'
        )
    }
}

function Get-PostgresAdminPassword([string]$PgpassPath) {
    foreach ($line in (Get-Content -LiteralPath $PgpassPath)) {
        if ($line -match '^localhost:5432:(?:\*|postgres):postgres:(.+)$') {
            return $Matches[1].Replace('\:', ':').Replace('\\', '\')
        }
    }
    throw "PGPASSFILE has no localhost:5432 entry for postgres: $PgpassPath"
}

function New-Task9StageEvidence([string]$Name) {
    $path = Join-Path $runRoot $Name
    if (Test-Path -LiteralPath $path) { throw "Task 9 stage already has evidence: $path" }
    return (New-Item -ItemType Directory -Path $path -ErrorAction Stop).FullName
}

function Assert-JunitExecuted([string]$Path, [switch]$RequireGreen) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "JUnit was not created: $Path" }
    [xml]$report = Get-Content -LiteralPath $Path -Raw
    $suites = @($report.SelectNodes('//testsuite'))
    $tests = ($suites | Measure-Object -Property tests -Sum).Sum
    $failures = ($suites | Measure-Object -Property failures -Sum).Sum
    $errors = ($suites | Measure-Object -Property errors -Sum).Sum
    $skipped = ($suites | Measure-Object -Property skipped -Sum).Sum
    if ($tests -lt 1) { throw "JUnit recorded no tests: $Path" }
    if ($skipped -ne 0) { throw "JUnit recorded $skipped skipped tests: $Path" }
    if ($RequireGreen -and ($failures -ne 0 -or $errors -ne 0)) {
        throw "JUnit is not green: $Path"
    }
}

function Invoke-PytestStage(
    [string]$EvidenceName,
    [string[]]$Arguments,
    [switch]$ExpectFailure
) {
    $evidence = New-Task9StageEvidence $EvidenceName
    $junit = Join-Path $evidence "$EvidenceName.xml"
    $log = Join-Path $evidence "$EvidenceName.log"
    & $python -m pytest @Arguments --junitxml $junit *> $log
    $code = $LASTEXITCODE
    Assert-JunitExecuted $junit -RequireGreen:(-not $ExpectFailure)
    if ($ExpectFailure -and $code -eq 0) { throw "$EvidenceName unexpectedly passed." }
    if (-not $ExpectFailure -and $code -ne 0) { throw "$EvidenceName failed." }
}

function Invoke-Task9Bootstrap([ValidateSet('Provision', 'Teardown')][string]$Mode) {
    $saved = $env:POSTGRESQL_ADMIN_PASSWORD
    $log = Join-Path $runRoot "bootstrap-$($Mode.ToLowerInvariant()).log"
    try {
        $env:POSTGRESQL_ADMIN_PASSWORD = Get-PostgresAdminPassword $adminPgpass
        & pwsh -NoProfile -ExecutionPolicy Bypass `
            -File (Join-Path $repositoryRoot 'scripts/ci/bootstrap-windows-postgres.ps1') `
            -Mode $Mode -ServiceName postgresql-x64-18 -ExpectedMajorVersion 18 `
            -Pgbin 'C:\PostgreSQL\18\bin' -HostName localhost `
            -DatabaseSuffix $suffix -RepositoryRoot $repositoryRoot `
            -RunnerTemp $runnerTemp -GithubEnv $githubEnv -StatePath $statePath `
            -PythonPath $python -SkipFixtureLoad *> $log
        if ($LASTEXITCODE -ne 0) { throw "Task 9 PostgreSQL $Mode failed." }
    } finally {
        $env:POSTGRESQL_ADMIN_PASSWORD = $saved
    }
}

function Invoke-Task9PsqlScalar([string]$Sql, [int]$TimeoutSeconds = 15) {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'C:\PostgreSQL\18\bin\psql.exe'
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $startInfo.Arguments = '-X -tA -v ON_ERROR_STOP=1 -h localhost -p 5432 -U postgres -d postgres'
    $startInfo.Environment['PGPASSFILE'] = $adminPgpass

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $started = $false
    try {
        if (-not $process.Start()) {
            throw 'Task 9 cleanup psql failed to start.'
        }
        $started = $true
        $psqlProcessId = $process.Id
        $process.StandardInput.WriteLine($Sql)
        $process.StandardInput.Close()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            if (-not $process.WaitForExit(5000)) {
                throw "Task 9 cleanup psql PID $psqlProcessId did not exit after termination."
            }
            [void]$stdoutTask.GetAwaiter().GetResult()
            $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
            throw "Task 9 cleanup psql PID $psqlProcessId timed out after $TimeoutSeconds seconds: $stderr"
        }

        $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
        $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
        if ($process.ExitCode -ne 0) {
            throw "Task 9 cleanup psql PID $psqlProcessId failed with exit code $($process.ExitCode): $stderr"
        }
        return $stdout
    }
    finally {
        if ($started -and -not $process.HasExited) {
            $process.Kill()
            [void]$process.WaitForExit(5000)
        }
        $process.Dispose()
    }
}

function Assert-Task9PostgresRemoved {
    $database = "album_haven_ci_$suffix"
    $roles = @('migrator', 'app', 'readonly', 'worker') |
        ForEach-Object { "album_haven_$($_)_$suffix" }
    $roleList = ($roles | ForEach-Object { "'$_'" }) -join ','
    $sql = "select not exists(select 1 from pg_database where datname='$database')" +
        " and not exists(select 1 from pg_roles where rolname in ($roleList))" +
        " and not exists(select 1 from pg_stat_activity where datname='$database');"
    $removed = Invoke-Task9PsqlScalar -Sql $sql
    if ($removed -ne 't') {
        throw 'Task 9 PostgreSQL database, roles or sessions leaked.'
    }
    if (Test-Path -LiteralPath $statePath) { throw "Task 9 state leaked: $statePath" }
    $generatedPgpass = Join-Path $runnerTemp "album-haven-postgres-$suffix.pgpass"
    if (Test-Path -LiteralPath $generatedPgpass) { throw "Task 9 generated pgpass leaked: $generatedPgpass" }
}

function Invoke-Task9JobRed {
    Invoke-PytestStage 'task9a-job-red' @(
        'tests/py/test_postgres_migrations.py', 'tests/py/test_job_contract.py',
        'tests/py/test_jobs_repository_postgres.py', 'tests/py/test_job_authorization.py',
        'tests/py/test_job_worker.py', 'tests/py/test_job_worker_config.py',
        'tests/py/test_run_jobs_worker_script.py', 'tests/py/test_problematic_projection_handlers.py',
        'tests/py/test_isolated_postgres_live.py', '-k',
        'problematic_projection or startup_preflight or registered_kinds or heartbeat', '-q'
    ) -ExpectFailure
}

function Invoke-Task9StorageRed {
    Invoke-PytestStage 'task9a-storage-red' @(
        'tests/py/test_problematic_files_projection.py',
        'tests/py/test_problematic_projection_postgres.py', '-q'
    ) -ExpectFailure
}

function Invoke-Task9AGreen {
    Invoke-PytestStage 'task9a-job-green' @(
        'tests/py/test_postgres_migrations.py', 'tests/py/test_job_contract.py',
        'tests/py/test_jobs_repository_postgres.py', 'tests/py/test_job_authorization.py',
        'tests/py/test_job_worker.py', 'tests/py/test_job_worker_config.py',
        'tests/py/test_run_jobs_worker_script.py', 'tests/py/test_problematic_projection_handlers.py',
        'tests/py/test_isolated_postgres_live.py', '-k',
        'problematic_projection or startup_preflight or registered_kinds or heartbeat or terminal_failure or terminal_recovery or reason_fact_staging or compact_metadata or ownership_moves', '-q'
    )
    Invoke-PytestStage 'task9a-storage-green' @(
        'tests/py/test_problematic_files_projection.py',
        'tests/py/test_problematic_projection_postgres.py',
        'tests/py/test_problematic_projection_integrity.py',
        'tests/py/test_library_browse_postgres.py::test_live_problematic_candidates_prefer_valid_canonical_track_number',
        'tests/py/test_library_browse_postgres.py::test_live_problematic_candidates_report_blank_scan_without_incomplete_order',
        'tests/py/test_library_browse_postgres.py::test_live_problematic_candidates_reject_oversized_numeric_scan_without_expansion',
        '-k', 'not explain', '-q'
    )
    $evidence = New-Task9StageEvidence 'task9a-impact-green'
    & node --test tests/js/performance-change-impact.test.js *> (Join-Path $evidence 'task9a-impact-green.log')
    if ($LASTEXITCODE -ne 0) { throw 'Task 9A impact mapping test failed.' }
}

function Invoke-Task9Capability {
    $evidence = New-Task9StageEvidence 'task9a-capability'
    $fixtureRoot = Resolve-Task9FixtureRoot $FixtureRoot
    if ([string]::IsNullOrWhiteSpace($env:DATABASE_MIGRATOR_URL)) {
        throw 'Task 9 bootstrap did not export DATABASE_MIGRATOR_URL.'
    }
    & $python scripts/ci/verify-problematic-projection-worker.py `
        --python $python --worker-script scripts/run_jobs_worker.py `
        --ready-timeout-seconds 30 --stop-timeout-seconds 30 `
        --evidence-directory $evidence
    if ($LASTEXITCODE -ne 0) { throw 'Fresh worker capability lifecycle failed.' }
    & $python scripts/ci/load-fixture-profile.py `
        --fixture-root $fixtureRoot `
        --profile $task9FixtureProfile `
        --database-url $env:DATABASE_MIGRATOR_URL `
        --replace-existing *> (Join-Path $evidence 'task9a-fixture-load.log')
    if ($LASTEXITCODE -ne 0) { throw 'Task 9A fixture load failed.' }
    $junit = Join-Path $evidence 'task9a-explain.xml'
    & $python -m pytest tests/py/test_problematic_projection_postgres.py `
        -k 'explain_source_page or explain_stage_publication or explain_integrity_keyset' -q -s `
        --junitxml $junit *> (Join-Path $evidence 'task9a-explain.log')
    if ($LASTEXITCODE -ne 0) { throw 'Task 9A EXPLAIN selection failed.' }
    Assert-JunitExecuted $junit -RequireGreen
}

function Invoke-Task9ReaderRed {
    Invoke-PytestStage 'task9b-reader-red' @(
        'tests/py/test_problematic_detail_identity.py',
        'tests/py/test_problematic_physical_files_postgres.py',
        'tests/py/test_api_read_asgi_routes.py',
        'tests/py/test_asgi_utility_read_concurrency.py',
        '-k', 'problematic', '-q'
    ) -ExpectFailure
}

function Invoke-Task9BGreen {
    Invoke-PytestStage 'task9b-reader-green' @(
        'tests/py/test_problematic_detail_identity.py',
        'tests/py/test_problematic_physical_files_postgres.py',
        'tests/py/test_api_read_asgi_routes.py',
        'tests/py/test_asgi_utility_read_concurrency.py',
        '-k', 'problematic', '-q'
    )
    $evidence = New-Task9StageEvidence 'task9b-client-green'
    & node --test tests/js/runtime/bootstrap-utility-event-handlers.test.js `
        tests/js/runtime/problematic-files-virtual-list.test.js `
        tests/js/runtime/settings-appearance-search.test.js `
        tests/js/runtime/utility-list-builders.test.js `
        tests/js/runtime/utility-problematic-focused-track-render.test.js `
        tests/js/runtime/utility-problematic-load-diagnostics.test.js `
        tests/js/runtime/utility-suggested-edits.test.js `
        *> (Join-Path $evidence 'task9b-client-green.log')
    if ($LASTEXITCODE -ne 0) { throw 'Task 9B client GREEN selection failed.' }
    & npm run build:runtime *> (Join-Path $evidence 'task9b-runtime-build.log')
    if ($LASTEXITCODE -ne 0) { throw 'Runtime bundle build failed.' }
    & node --test tests/js/runtime/app-loader-bundle.test.js *> (Join-Path $evidence 'task9b-bundle-green.log')
    if ($LASTEXITCODE -ne 0) { throw 'Runtime bundle parity test failed.' }
}

function Invoke-Task9ReaderExplain {
    Invoke-PytestStage 'task9b-reader-explain' @(
        'tests/py/test_problematic_projection_postgres.py', '-k',
        'explain_unfiltered_keyset or explain_reason_filter or explain_search_filter or explain_continuation',
        '-q', '-s'
    )
}

function Invoke-Task9PfDatabase {
    Invoke-PytestStage 'pf-database-api-1' @(
        'tests/py/test_library_browse_postgres.py', 'tests/py/test_api_read_asgi_routes.py',
        '-k', 'problematic', '-q'
    )
    Invoke-PytestStage 'pf-database-api-2' @(
        'tests/py/test_multi_root_duplicates.py', 'tests/py/test_problematic_albums.py',
        'tests/py/test_problematic_detail_identity.py',
        'tests/py/test_problematic_physical_files_postgres.py',
        'tests/py/test_problematic_file_projection_migration_postgres.py', '-q'
    )
}

function Invoke-Task9PfJavascript {
    $evidence = New-Task9StageEvidence 'pf-javascript-component'
    & node --test --test-concurrency=1 `
        tests/js/runtime/utility-problematic-load-diagnostics.test.js `
        tests/js/runtime/utility-problematic-tab.test.js `
        tests/js/runtime/problematic-files-virtual-list.test.js `
        tests/js/runtime/utility-problematic-focused-track-render.test.js `
        tests/js/runtime/problem-exclusion-mutations.test.js `
        tests/js/problematic-payload-evidence.test.js `
        tests/js/performance-change-impact.test.js `
        tests/js/e2e-performance-helper-guards.test.js `
        *> (Join-Path $evidence 'pf-javascript.log')
    if ($LASTEXITCODE -ne 0) { throw 'Problematic Files JavaScript gate failed.' }
    & npx playwright test problematicFilesVirtualFocus.spec.js `
        --config=playwright.component.config.js --workers=1 `
        *> (Join-Path $evidence 'pf-component.log')
    if ($LASTEXITCODE -ne 0) { throw 'Problematic Files component gate failed.' }
}

function Invoke-Task9PfFunctional {
    $evidence = New-Task9StageEvidence 'pf-search-functional'
    & npm run test:search-regressions *> (Join-Path $evidence 'search-regressions.log')
    if ($LASTEXITCODE -ne 0) { throw 'Mandatory search regression gate failed.' }
    $contract = Get-Content 'tests/ci/functional-shards.json' -Raw | ConvertFrom-Json
    $extraCaseIds = @('FTC-SETTINGS-S03', 'FTC-SETTINGS-S04', 'FTC-NON-ALBUM-014', 'FTC-NON-ALBUM-011')
    $selectedCases = @($contract.shards | ForEach-Object {
        $shard = $_
        $_.invocations | ForEach-Object {
            $_.cases | Where-Object {
                $_.area -eq 'problematic-files' -or
                $_.relatedAreas -contains 'problematic-files' -or
                $extraCaseIds -contains ([string]$_.case -split ' ', 2)[0]
            } | ForEach-Object {
                [pscustomobject]@{ Shard = [string]$shard.name; Case = [string]$_.case }
            }
        }
    })
    if ($selectedCases.Count -ne 11 -or @($selectedCases.Case | Select-Object -Unique).Count -ne 11) {
        throw "Expected 11 exact Problematic Files cases, found $($selectedCases.Count)."
    }
    if (@($selectedCases | Group-Object Shard).Count -ne 5) {
        throw 'Expected exactly five Problematic Files owning shards.'
    }
    foreach ($group in @($selectedCases | Group-Object Shard)) {
        $safeShard = $group.Name.Replace('-', '_')
        & .\scripts\run-functional-e2e-local.ps1 -Shard $group.Name `
            -Cases @($group.Group.Case) -PythonPath $python `
            *> (Join-Path $evidence "pf-functional-$safeShard.log")
        if ($LASTEXITCODE -ne 0) { throw "Problematic Files functional cases failed in $($group.Name)." }
    }
}

$portLeaseRoot = Join-Path $repositoryRoot '.tmp/phase8-performance-port-leases'
$portLeaseRegistry = Join-Path $portLeaseRoot 'leases.json'
$portLeaseLock = Join-Path $portLeaseRoot 'leases.lock'
$ownerStartTimeUtc = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O')

function Invoke-WithTask9PortLeaseLock([scriptblock]$Action) {
    New-Item -ItemType Directory -Path $portLeaseRoot -Force | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $lock = $null
    while ($null -eq $lock -and [DateTime]::UtcNow -lt $deadline) {
        try {
            $lock = [IO.File]::Open(
                $portLeaseLock, [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite, [IO.FileShare]::None
            )
        } catch [IO.IOException] {
            Start-Sleep -Milliseconds 100
        }
    }
    if ($null -eq $lock) { throw 'Timed out acquiring Task 9 port lease lock.' }
    try { & $Action } finally { $lock.Dispose() }
}

function Read-Task9PortLeases {
    if (-not (Test-Path -LiteralPath $portLeaseRegistry -PathType Leaf)) { return @() }
    try {
        $document = Get-Content -LiteralPath $portLeaseRegistry -Raw | ConvertFrom-Json
        if ([int]$document.schemaVersion -ne 1) { throw 'unsupported schema' }
        return @($document.leases)
    } catch {
        throw "Task 9 port lease registry is invalid: $portLeaseRegistry"
    }
}

function Write-Task9PortLeases([object[]]$Leases) {
    $temporary = "$portLeaseRegistry.$runId.tmp"
    @{ schemaVersion = 1; leases = @($Leases) } |
        ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath $temporary -Encoding utf8
    if (Test-Path -LiteralPath $portLeaseRegistry -PathType Leaf) {
        [IO.File]::Replace($temporary, $portLeaseRegistry, $null)
    } else {
        [IO.File]::Move($temporary, $portLeaseRegistry)
    }
}

function Test-Task9PortLeaseOwner([object]$Lease) {
    $process = $null
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$Lease.pid)
        return $process.StartTime.ToUniversalTime().ToString('O') -ceq
            [string]$Lease.processStartTimeUtc
    } catch [ArgumentException] {
        return $false
    } catch {
        throw "Cannot read Task 9 port lease owner PID $($Lease.pid) start time."
    } finally {
        if ($null -ne $process) { $process.Dispose() }
    }
}

function Test-Task9PortBlockOverlap(
    [int]$LeftBase, [int]$LeftCount, [int]$RightBase, [int]$RightCount
) {
    return $LeftBase -lt ($RightBase + $RightCount) -and
        $RightBase -lt ($LeftBase + $LeftCount)
}

function New-Task9PortProbes([int]$BasePort, [int]$BlockSize) {
    $probes = [Collections.Generic.List[System.Net.Sockets.TcpListener]]::new()
    try {
        for ($offset = 0; $offset -lt $BlockSize; $offset += 1) {
            $probe = [Net.Sockets.TcpListener]::new(
                [Net.IPAddress]::Loopback, $BasePort + $offset
            )
            $probe.Server.ExclusiveAddressUse = $true
            $probe.Start()
            $probes.Add($probe)
        }
        return @($probes)
    } catch {
        foreach ($probe in $probes) { $probe.Stop() }
        return @()
    }
}

function Acquire-Task9PerformancePortLease([int]$BlockSize = 16) {
    Invoke-WithTask9PortLeaseLock {
        $active = @(Read-Task9PortLeases | Where-Object { Test-Task9PortLeaseOwner $_ })
        for ($candidate = 20000; $candidate -le 59984; $candidate += $BlockSize) {
            $overlap = @($active | Where-Object {
                Test-Task9PortBlockOverlap $candidate $BlockSize `
                    ([int]$_.basePort) ([int]$_.portCount)
            })
            if ($overlap.Count -ne 0) { continue }
            $probes = @(New-Task9PortProbes $candidate $BlockSize)
            if ($probes.Count -ne $BlockSize) { continue }
            try {
                $lease = [pscustomobject]@{
                    runId = $runId
                    basePort = $candidate
                    portCount = $BlockSize
                    pid = $PID
                    processStartTimeUtc = $ownerStartTimeUtc
                }
                Write-Task9PortLeases @($active + $lease)
                return $lease
            } finally {
                foreach ($probe in $probes) { $probe.Stop() }
            }
        }
        throw 'Unable to lease a nonoverlapping 16-port Task 9 performance block.'
    }
}

function Release-Task9PerformancePortLease([object]$Lease) {
    Invoke-WithTask9PortLeaseLock {
        $leases = @(Read-Task9PortLeases)
        $owned = @($leases | Where-Object {
            $_.runId -ceq $Lease.runId -and
            [int]$_.pid -eq [int]$Lease.pid -and
            $_.processStartTimeUtc -ceq $Lease.processStartTimeUtc
        })
        if ($owned.Count -ne 1) { throw 'Task 9 owned port lease is missing or ambiguous.' }
        Write-Task9PortLeases @($leases | Where-Object {
            -not (
                $_.runId -ceq $Lease.runId -and
                [int]$_.pid -eq [int]$Lease.pid -and
                $_.processStartTimeUtc -ceq $Lease.processStartTimeUtc
            )
        })
    }
}

function Wait-Task9PerformancePortsClear([int]$BasePort, [int]$BlockSize = 16) {
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        $active = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object {
            $_.LocalPort -ge $BasePort -and
            $_.LocalPort -lt ($BasePort + $BlockSize) -and
            $_.State -ne 'TimeWait' -and $_.OwningProcess -ne 0
        })
        if ($active.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "Task 9 performance ports $BasePort-$($BasePort + $BlockSize - 1) remain active."
}

function Add-Task9OwnedProcessSnapshot([int]$RootPid, [hashtable]$Owned) {
    $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $knownParents = [Collections.Generic.HashSet[int]]::new()
    [void]$knownParents.Add($RootPid)
    do {
        $added = $false
        foreach ($row in $rows) {
            $pidValue = [int]$row.ProcessId
            if (-not $knownParents.Contains([int]$row.ParentProcessId) -or
                $knownParents.Contains($pidValue)) { continue }
            [void]$knownParents.Add($pidValue)
            $started = $row.CreationDate.ToUniversalTime().ToString('O')
            $Owned["$pidValue|$started"] = [pscustomobject]@{
                pid = $pidValue
                processStartTimeUtc = $started
            }
            $added = $true
        }
    } while ($added)
}

function Test-Task9ExactProcessAlive([object]$OwnedProcess) {
    $rows = @(Get-CimInstance Win32_Process `
        -Filter "ProcessId=$([int]$OwnedProcess.pid)" -ErrorAction Stop)
    return $rows.Count -eq 1 -and
        $rows[0].CreationDate.ToUniversalTime().ToString('O') -ceq
        [string]$OwnedProcess.processStartTimeUtc
}

function Stop-AndAssertTask9ProcessTree(
    [Diagnostics.Process]$RootProcess, [hashtable]$Owned
) {
    $forced = $false
    if ($null -ne $RootProcess -and -not $RootProcess.HasExited) {
        $gracefulRequested = $RootProcess.CloseMainWindow()
        if ($gracefulRequested) { [void]$RootProcess.WaitForExit(5000) }
        if (-not $RootProcess.HasExited) {
            $forced = $true
            $RootProcess.Kill($true)
            if (-not $RootProcess.WaitForExit(10000)) {
                throw "Owned Task 9 performance root PID $($RootProcess.Id) did not exit."
            }
        }
    }
    foreach ($ownedProcess in @($Owned.Values)) {
        if (-not (Test-Task9ExactProcessAlive $ownedProcess)) { continue }
        $forced = $true
        $process = [Diagnostics.Process]::GetProcessById([int]$ownedProcess.pid)
        try {
            if (-not (Test-Task9ExactProcessAlive $ownedProcess)) { continue }
            $process.Kill($true)
            [void]$process.WaitForExit(10000)
        } finally {
            $process.Dispose()
        }
    }
    $remaining = @($Owned.Values | Where-Object { Test-Task9ExactProcessAlive $_ })
    if ($remaining.Count -ne 0) {
        throw "Owned Task 9 performance descendants remain: $($remaining.pid -join ',')."
    }
    if ($forced) { throw 'Task 9 performance process tree required forced cleanup.' }
}

function Assert-Task9PerformancePostgresRemoved([string]$DatabaseSuffix) {
    $database = "album_haven_ci_$DatabaseSuffix"
    $roles = @('migrator', 'app', 'readonly', 'worker') |
        ForEach-Object { "album_haven_$($_)_$DatabaseSuffix" }
    $roleList = ($roles | ForEach-Object { "'$_'" }) -join ','
    $sql = "select not exists(select 1 from pg_database where datname='$database')" +
        " and not exists(select 1 from pg_roles where rolname in ($roleList))" +
        " and not exists(select 1 from pg_stat_activity where datname='$database');"
    if ((Invoke-Task9PsqlScalar -Sql $sql) -ne 't') {
        throw 'Nested Task 9 performance database, roles or sessions leaked.'
    }
}

function Invoke-Task9PerformanceTakeoverTeardown(
    [string]$PerformanceTemp, [string]$PerformanceEnv,
    [string]$PerformanceState, [string]$PerformanceSuffix, [string]$Evidence
) {
    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        (Join-Path $repositoryRoot 'scripts/ci/bootstrap-windows-postgres.ps1'),
        '-Mode', 'Teardown', '-AppPrivilegeMode', 'Inherited',
        '-ServiceName', 'postgresql-x64-18', '-ExpectedMajorVersion', '18',
        '-Port', '5432', '-Pgbin', 'C:\PostgreSQL\18\bin', '-HostName', 'localhost',
        '-DatabaseSuffix', $PerformanceSuffix, '-RepositoryRoot', $repositoryRoot,
        '-RunnerTemp', $PerformanceTemp, '-GithubEnv', $PerformanceEnv,
        '-StatePath', $PerformanceState, '-PythonPath', $python
    )
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $arguments) { [void]$startInfo.ArgumentList.Add([string]$argument) }
    $startInfo.Environment['PGPASSFILE'] = $adminPgpass
    $startInfo.Environment['POSTGRESQL_ADMIN_PASSWORD'] = Get-PostgresAdminPassword $adminPgpass
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Task 9 takeover teardown failed to start.' }
        [void]$startInfo.Environment.Remove('POSTGRESQL_ADMIN_PASSWORD')
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $timedOut = -not $process.WaitForExit(30000)
        if ($timedOut) {
            $process.Kill($true)
            [void]$process.WaitForExit(10000)
        }
        $stdoutTask.GetAwaiter().GetResult() |
            Set-Content -LiteralPath (Join-Path $Evidence 'takeover-teardown.stdout.log')
        $stderrTask.GetAwaiter().GetResult() |
            Set-Content -LiteralPath (Join-Path $Evidence 'takeover-teardown.stderr.log')
        if ($timedOut) {
            throw 'Task 9 takeover teardown timed out and required forced cleanup.'
        }
        if ($process.ExitCode -ne 0) {
            throw "Task 9 takeover teardown failed with exit code $($process.ExitCode)."
        }
    } finally {
        $process.Dispose()
    }
}

function Invoke-Task9PfPerformance {
    $evidence = New-Task9StageEvidence 'pf-performance'
    $performancePortCount = 16
    $performanceShardName = 'phase8-task9b-problematic-files'
    $performanceSuffix = "phase8_task9b_$($runId.Substring($runId.Length - 12))"
    $performanceTemp = Join-Path ([IO.Path]::GetTempPath()) "album-haven-task9-performance-$runId"
    $performanceEnv = Join-Path $performanceTemp 'database.env'
    $performanceState = Join-Path $performanceTemp `
        "album-haven-performance-shard-$performanceShardName/$performanceShardName.state.json"
    $performanceLease = $null
    $performanceProcess = $null
    $performanceProcessStarted = $false
    $performanceOwned = @{}
    $errors = [Collections.Generic.List[string]]::new()
    $treeClear = $false
    $takeoverClear = $true
    $databaseClear = $false
    $portsClear = $false
    $leaseReleased = $false
    $stdoutTask = $null
    $stderrTask = $null
    try {
        $performanceLease = Acquire-Task9PerformancePortLease $performancePortCount
        New-Item -ItemType Directory -Path $performanceTemp -ErrorAction Stop | Out-Null
        @{
            runId = $runId
            basePort = [int]$performanceLease.basePort
            portCount = $performancePortCount
            pid = $performanceLease.pid
            processStartTimeUtc = $performanceLease.processStartTimeUtc
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'allocation.json')

        $arguments = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            (Join-Path $repositoryRoot 'scripts/ci/run-performance-shard.ps1'),
            '-Targets', 'utility-problematic-files,problematic-files-focused',
            '-FixtureProfile', 'utility-problematic-files', '-FixtureMode', 'preloaded-release',
            '-BasePort', [string]$performanceLease.basePort,
            '-DatabaseSuffixBase', $performanceSuffix, '-ExpectedPostgresMajor', '18',
            '-PostgresPort', '5432', '-RepositoryRoot', $repositoryRoot,
            '-RunnerTemp', $performanceTemp, '-GithubEnv', $performanceEnv,
            '-Pgbin', 'C:\PostgreSQL\18\bin', '-PythonPath', $python,
            '-ShardName', $performanceShardName, '-PerformanceContract', 'local'
        )
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = (Get-Command pwsh.exe -ErrorAction Stop).Source
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        foreach ($argument in $arguments) { [void]$startInfo.ArgumentList.Add([string]$argument) }
        $startInfo.Environment['PGPASSFILE'] = $adminPgpass
        $startInfo.Environment['PLAYWRIGHT_PYTHON'] = $python
        $startInfo.Environment['PGBIN'] = 'C:\PostgreSQL\18\bin'
        $startInfo.Environment['POSTGRESQL_ADMIN_PASSWORD'] = Get-PostgresAdminPassword $adminPgpass
        $performanceProcess = [Diagnostics.Process]::new()
        $performanceProcess.StartInfo = $startInfo
        if (-not $performanceProcess.Start()) { throw 'Task 9 performance child failed to start.' }
        $performanceProcessStarted = $true
        [void]$startInfo.Environment.Remove('POSTGRESQL_ADMIN_PASSWORD')
        @{
            pid = $performanceProcess.Id
            processStartTimeUtc = $performanceProcess.StartTime.ToUniversalTime().ToString('O')
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'child-process.json')
        $stdoutTask = $performanceProcess.StandardOutput.ReadToEndAsync()
        $stderrTask = $performanceProcess.StandardError.ReadToEndAsync()
        while (-not $performanceProcess.WaitForExit(250)) {
            Add-Task9OwnedProcessSnapshot $performanceProcess.Id $performanceOwned
        }
        Add-Task9OwnedProcessSnapshot $performanceProcess.Id $performanceOwned
        if ($performanceProcess.ExitCode -ne 0) {
            throw "Problematic Files performance child failed with exit code $($performanceProcess.ExitCode)."
        }
    } catch {
        $errors.Add($_.Exception.Message)
    } finally {
        try {
            $cleanupRoot = if ($performanceProcessStarted) { $performanceProcess } else { $null }
            Stop-AndAssertTask9ProcessTree $cleanupRoot $performanceOwned
            $treeClear = $true
        } catch { $errors.Add($_.Exception.Message) }
        try {
            if ($null -ne $stdoutTask) {
                $stdoutTask.GetAwaiter().GetResult() |
                    Set-Content -LiteralPath (Join-Path $evidence 'pf-performance.stdout.log')
            }
            if ($null -ne $stderrTask) {
                $stderrTask.GetAwaiter().GetResult() |
                    Set-Content -LiteralPath (Join-Path $evidence 'pf-performance.stderr.log')
            }
        } catch { $errors.Add($_.Exception.Message) }
        if ($treeClear) {
            if (Test-Path -LiteralPath $performanceState -PathType Leaf) {
                $takeoverClear = $false
                try {
                    Invoke-Task9PerformanceTakeoverTeardown `
                        $performanceTemp $performanceEnv $performanceState `
                        $performanceSuffix $evidence
                    $takeoverClear = $true
                } catch { $errors.Add($_.Exception.Message) }
            }
            try {
                Assert-Task9PerformancePostgresRemoved $performanceSuffix
                $databaseClear = $true
            } catch { $errors.Add($_.Exception.Message) }
            if ($null -ne $performanceLease) {
                try {
                    Wait-Task9PerformancePortsClear `
                        ([int]$performanceLease.basePort) $performancePortCount
                    $portsClear = $true
                } catch { $errors.Add($_.Exception.Message) }
                if ($databaseClear -and $portsClear) {
                    try {
                        Release-Task9PerformancePortLease $performanceLease
                        $leaseReleased = $true
                    }
                    catch { $errors.Add($_.Exception.Message) }
                }
            }
        }
        if ($treeClear -and $takeoverClear -and $databaseClear -and
            ($null -eq $performanceLease -or ($portsClear -and $leaseReleased))) {
            try {
                if (Test-Path -LiteralPath $performanceTemp) {
                    Remove-Item -LiteralPath $performanceTemp -Recurse -Force
                }
            } catch {
                $errors.Add($_.Exception.Message)
                $errors.Add("Task 9 performance recovery state retained at $performanceTemp")
            }
        } elseif (Test-Path -LiteralPath $performanceTemp) {
            $errors.Add("Task 9 performance recovery state retained at $performanceTemp")
        }
        if ($null -ne $performanceProcess) { $performanceProcess.Dispose() }
    }
    if ($errors.Count -ne 0) { throw ($errors -join [Environment]::NewLine) }
}

function Invoke-Task9EditTags {
    Invoke-PytestStage 'edit-tags-python' @(
        'tests/py/test_edit_workflows.py', 'tests/py/test_save_tasks.py',
        'tests/py/test_edit_state.py', 'tests/py/test_tag_edit_recovery.py',
        'tests/py/test_tag_edit_intents_postgres.py',
        'tests/py/test_postgres_structural_tag_edit.py', '-q'
    )
    $evidence = New-Task9StageEvidence 'edit-tags-javascript-functional'
    & node --test tests/js/runtime/tag-editor-and-optimistic-updates.test.js `
        tests/js/runtime/tag-editor-autofill-styling.test.js `
        tests/js/runtime/tag-editor-backdrop-ownership.test.js `
        tests/js/runtime/tag-editor-exception-menu.test.js `
        tests/js/runtime/tag-editor-folder-expansion.test.js `
        tests/js/runtime/tag-editor-reorder-boundary.test.js `
        tests/js/runtime/utility-tag-edit-optimistic.test.js `
        *> (Join-Path $evidence 'edit-tags-javascript.log')
    if ($LASTEXITCODE -ne 0) { throw 'Edit Tags JavaScript gate failed.' }
    & .\scripts\run-functional-e2e-local.ps1 -Shard metadata-mutations `
        -PythonPath $python *> (Join-Path $evidence 'metadata-mutations-functional.log')
    if ($LASTEXITCODE -ne 0) { throw 'Metadata-mutations functional shard failed.' }
}

$runFailure = $null
$teardownFailure = $null
$leakFailure = $null
$cleanupFailure = $null
try {
    Invoke-Task9Bootstrap Provision
    Import-DatabaseEnvironment $githubEnv
    foreach ($requiredExport in @(
        'DATABASE_MIGRATOR_URL', 'DATABASE_APP_URL', 'DATABASE_READONLY_URL',
        'ALBUM_HAVEN_WORKER_DATABASE_URL', 'ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL',
        'ALBUM_HAVEN_FAKE_E2E_DATABASE_URL'
    )) {
        if ([string]::IsNullOrWhiteSpace(
            [Environment]::GetEnvironmentVariable($requiredExport, 'Process')
        )) { throw "Task 9 bootstrap export is absent or blank: $requiredExport" }
    }
    $env:ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL = $env:DATABASE_MIGRATOR_URL
    $env:ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL = $env:DATABASE_APP_URL
    foreach ($stageName in $Stage) {
        switch ($stageName) {
            'job-red' { Invoke-Task9JobRed }
            'storage-red' { Invoke-Task9StorageRed }
            'task9a-green' { Invoke-Task9AGreen }
            'capability' { Invoke-Task9Capability }
            'reader-red' { Invoke-Task9ReaderRed }
            'task9b-green' { Invoke-Task9BGreen }
            'reader-explain' { Invoke-Task9ReaderExplain }
            'pf-database' { Invoke-Task9PfDatabase }
            'pf-javascript' { Invoke-Task9PfJavascript }
            'pf-functional' { Invoke-Task9PfFunctional }
            'pf-performance' { Invoke-Task9PfPerformance }
            'edit-tags' { Invoke-Task9EditTags }
        }
    }
} catch {
    $runFailure = $_.Exception
} finally {
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try { Invoke-Task9Bootstrap Teardown } catch { $teardownFailure = $_.Exception }
    }
    try { Assert-Task9PostgresRemoved } catch { $leakFailure = $_.Exception }
    try {
        if (Test-Path -LiteralPath $runnerTemp) {
            Remove-Item -LiteralPath $runnerTemp -Recurse -Force
        }
    } catch { $cleanupFailure = $_.Exception }
    $errors = @($runFailure, $teardownFailure, $leakFailure, $cleanupFailure) |
        Where-Object { $null -ne $_ } | ForEach-Object { $_.Message }
    if ($errors.Count -ne 0) { throw ($errors -join [Environment]::NewLine) }
}
