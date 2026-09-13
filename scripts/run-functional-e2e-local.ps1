[CmdletBinding(DefaultParameterSetName = 'All')]
param(
    [Parameter(ParameterSetName = 'List', Mandatory = $true)][switch]$List,
    [Parameter(ParameterSetName = 'All')][switch]$All,
    [Parameter(ParameterSetName = 'Shard', Mandatory = $true)][string]$Shard,
    [Parameter(ParameterSetName = 'All')][Parameter(ParameterSetName = 'Shard')][string]$Case,
    [string]$FixtureDistribution,
    [string]$PythonPath = $env:PLAYWRIGHT_PYTHON
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$expectedRelease = 'fixtures-v1.0.23'
$fixtureProfile = 'functional-core'
$repositoryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$contractPath = Join-Path $repositoryRoot 'tests\ci\functional-shards.json'
$contract = Get-Content -Raw -Encoding UTF8 -LiteralPath $contractPath | ConvertFrom-Json

function Get-OwnedCases([object]$OwnedShard) {
    return @($OwnedShard.invocations | ForEach-Object { $_.cases } | ForEach-Object { $_ })
}

if ($List) {
    foreach ($ownedShard in $contract.shards) {
        Write-Output $ownedShard.name
        foreach ($ownedCase in (Get-OwnedCases $ownedShard)) {
            Write-Output "  $($ownedCase.case)"
        }
    }
    exit 0
}

Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop

if ($All -and -not [string]::IsNullOrWhiteSpace($Case)) {
    throw '-All cannot be combined with -Case. Omit -All to resolve the exact case automatically.'
}

$selectedShards = @()
if (-not [string]::IsNullOrWhiteSpace($Case)) {
    $caseMatches = @(
        foreach ($ownedShard in $contract.shards) {
            foreach ($ownedCase in (Get-OwnedCases $ownedShard)) {
                if ([string]$ownedCase.case -ceq $Case) {
                    [pscustomobject]@{ Shard = $ownedShard; Case = $ownedCase }
                }
            }
        }
    )
    if ($caseMatches.Count -ne 1) {
        throw "Functional case must match one exact approved title; found $($caseMatches.Count): $Case"
    }
    if (-not [string]::IsNullOrWhiteSpace($Shard) -and $caseMatches[0].Shard.name -cne $Shard) {
        throw "Functional case is owned by shard $($caseMatches[0].Shard.name), not $Shard."
    }
    $selectedShards = @($caseMatches[0].Shard)
} elseif (-not [string]::IsNullOrWhiteSpace($Shard)) {
    $selectedShards = @($contract.shards | Where-Object { $_.name -ceq $Shard })
    if ($selectedShards.Count -ne 1) { throw "Unknown functional shard: $Shard" }
} else {
    $selectedShards = @($contract.shards)
}

function Resolve-Executable([string]$Requested, [string[]]$Fallbacks, [string]$Label) {
    if (-not [string]::IsNullOrWhiteSpace($Requested)) {
        $requestedCommand = Get-Command $Requested -ErrorAction SilentlyContinue
        if ($requestedCommand) { return $requestedCommand.Source }
        if (Test-Path -LiteralPath $Requested -PathType Leaf) {
            return [IO.Path]::GetFullPath($Requested)
        }
    }
    foreach ($fallback in $Fallbacks) {
        $command = Get-Command $fallback -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
        if (Test-Path -LiteralPath $fallback -PathType Leaf) {
            return [IO.Path]::GetFullPath($fallback)
        }
    }
    throw "$Label executable was not found."
}

function Get-FreePortBase {
    for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
        $candidate = Get-Random -Minimum 20000 -Maximum 60000
        $ports = @($candidate, ($candidate + 2))
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
            $_.LocalPort -in $ports
        })
        if ($listeners.Count -ne 0) { continue }
        $portProbes = @()
        try {
            foreach ($port in $ports) {
                $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
                $probe.Server.ExclusiveAddressUse = $true
                $portProbes += $probe
                $probe.Start()
            }
            return $candidate
        } catch [System.Net.Sockets.SocketException] {
            # An empty listener snapshot does not guarantee bindable ports.
            continue
        } finally {
            foreach ($probe in $portProbes) { $probe.Stop() }
        }
    }
    throw 'Unable to allocate an unused local E2E port base.'
}

function Copy-FixtureProfile([string]$ProfileRoot, [string]$ManifestPath, [string]$Destination) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Get-ChildItem -LiteralPath $ProfileRoot -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
    Copy-Item -LiteralPath $ManifestPath -Destination (Join-Path $Destination 'manifest.json') -Force
}

function Import-EnvironmentFile([string]$Path) {
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        $separator = $line.IndexOf('=')
        if ($separator -le 0) { continue }
        $name = $line.Substring(0, $separator)
        $value = $line.Substring($separator + 1)
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

function Get-PostgresAdminPassword([string]$PgpassPath) {
    foreach ($line in (Get-Content -LiteralPath $PgpassPath)) {
        if ($line -match '^localhost:5432:(?:\*|postgres):postgres:(.+)$') {
            return $Matches[1].Replace('\:', ':').Replace('\\', '\')
        }
    }
    throw "PGPASSFILE has no localhost:5432 entry for the postgres role: $PgpassPath"
}

function Assert-OwnedTempRoot([string]$Candidate) {
    $systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $resolved = [IO.Path]::GetFullPath($Candidate)
    $prefix = $systemTemp + 'album-haven-functional-local-'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing unexpected local E2E temp root: $resolved"
    }
    return $resolved
}

$node = Resolve-Executable '' @('node.exe', 'C:\Program Files\nodejs\node.exe') 'Node.js'
$python = Resolve-Executable $PythonPath @('python.exe', 'python') 'Python'
$postgresBin = 'C:\PostgreSQL\18\bin'
foreach ($executable in @('psql.exe', 'pg_isready.exe', 'postgres.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $postgresBin $executable) -PathType Leaf)) {
        throw "PostgreSQL 18 executable is missing: $executable"
    }
}

if ([string]::IsNullOrWhiteSpace($FixtureDistribution)) {
    $FixtureDistribution = Join-Path (Split-Path -Parent $repositoryRoot) 'album-haven-test-data\dist'
}
$fixtureDistributionRoot = [IO.Path]::GetFullPath($FixtureDistribution)
$manifestPath = Join-Path $fixtureDistributionRoot 'manifest.json'
$profileRoot = Join-Path $fixtureDistributionRoot "profiles\$fixtureProfile"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Fixture manifest was not found: $manifestPath"
}
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.release -cne $expectedRelease) {
    throw "Local fixture release must be $expectedRelease; found $($manifest.release)."
}
foreach ($requiredPath in @(
    $profileRoot,
    (Join-Path $profileRoot 'database'),
    (Join-Path $profileRoot 'media'),
    (Join-Path $profileRoot 'loopback')
)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Container)) {
        throw "Expanded $fixtureProfile fixture path is missing: $requiredPath"
    }
}

$configuredPgpass = [Environment]::GetEnvironmentVariable('PGPASSFILE', 'Process')
if ([string]::IsNullOrWhiteSpace($configuredPgpass)) {
    $applicationData = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::ApplicationData
    )
    if ([string]::IsNullOrWhiteSpace($applicationData)) {
        throw 'Set PGPASSFILE because the current application-data directory could not be resolved.'
    }
    $configuredPgpass = Join-Path $applicationData 'postgresql\pgpass.conf'
}
if (-not (Test-Path -LiteralPath $configuredPgpass -PathType Leaf)) {
    throw "PostgreSQL password file was not found. Set PGPASSFILE or create: $configuredPgpass"
}
$configuredPgpass = [IO.Path]::GetFullPath($configuredPgpass)
$postgresAdminPassword = [Environment]::GetEnvironmentVariable(
    'POSTGRESQL_ADMIN_PASSWORD',
    'Process'
)
if ([string]::IsNullOrWhiteSpace($postgresAdminPassword)) {
    $postgresAdminPassword = Get-PostgresAdminPassword $configuredPgpass
}

$bootstrap = Join-Path $repositoryRoot 'scripts\ci\bootstrap-windows-postgres.ps1'
$loader = Join-Path $repositoryRoot 'scripts\ci\load-fixture-profile.py'
$validator = Join-Path $repositoryRoot 'scripts\ci\validate-functional-shards.cjs'
$windowsPowerShell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
    throw "Windows PowerShell was not found: $windowsPowerShell"
}

function Invoke-PostgresBootstrap(
    [ValidateSet('Provision', 'Teardown')][string]$Mode,
    [string]$DatabaseSuffix,
    [string]$RunnerTemp,
    [string]$GithubEnv,
    [string]$StatePath
) {
    $bootstrapArguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $bootstrap,
        '-Mode', $Mode,
        '-ServiceName', 'postgresql-x64-18',
        '-ExpectedMajorVersion', '18',
        '-Pgbin', $postgresBin,
        '-HostName', 'localhost',
        '-DatabaseSuffix', $DatabaseSuffix,
        '-RepositoryRoot', $repositoryRoot,
        '-RunnerTemp', $RunnerTemp,
        '-GithubEnv', $GithubEnv,
        '-StatePath', $StatePath,
        '-PythonPath', $python,
        '-Port', '5432',
        '-SkipFixtureLoad'
    )
    & $windowsPowerShell @bootstrapArguments | Where-Object { $_ -notmatch '^::add-mask::' }
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL $($Mode.ToLowerInvariant()) failed." }
}

$environmentKeys = @(
    'RUNNER_TEMP',
    'GITHUB_ENV',
    'PGPASSFILE',
    'POSTGRESQL_ADMIN_PASSWORD',
    'DATABASE_MIGRATOR_URL',
    'DATABASE_APP_URL',
    'DATABASE_READONLY_URL',
    'ALBUM_HAVEN_CI_DATABASE',
    'ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL',
    'ALBUM_HAVEN_FAKE_E2E_DATABASE_URL',
    'ALBUM_HAVEN_APP_DATABASE_URL',
    'ALBUM_HAVEN_FIXTURE_PROFILE',
    'ALBUM_HAVEN_FIXTURE_ROOT',
    'ALBUM_HAVEN_MEDIA_ROOT',
    'ALBUM_HAVEN_FUNCTIONAL_OUTPUT_ROOT',
    'ALBUM_HAVEN_FUNCTIONAL_BLOB_ROOT',
    'ALBUM_HAVEN_FUNCTIONAL_FIXTURE_WORK_ROOT',
    'ALBUM_HAVEN_FUNCTIONAL_SOURCE_FIXTURE_ROOT',
    'ALBUM_HAVEN_FUNCTIONAL_PORT_BASE',
    'PLAYWRIGHT_PROVIDER_PORT',
    'PLAYWRIGHT_PYTHON',
    'MUSIC_DIR',
    'MUSIC_APP_DATA_DIR',
    'MUSIC_CACHE_PATH',
    'MUSIC_COVER_CACHE_PATH',
    'MUSIC_LIBRARY_ROOTS_PATH',
    'PLAYWRIGHT_REAL_APP_URL'
)

$overallFailed = $false
# Matches PROCESS_CLEANUP_FAILURE_EXIT_CODE in playwright-exit-codes.cjs.
$processCleanupFailureExitCode = 2
$processCleanupFailed = $false
foreach ($selectedShard in $selectedShards) {
    $invocationId = [guid]::NewGuid().ToString('N').Substring(0, 12)
    $safeShard = ([string]$selectedShard.name).Replace('-', '_')
    $databaseSuffix = "local_$($invocationId)"
    $runnerTemp = Assert-OwnedTempRoot (Join-Path ([IO.Path]::GetTempPath()) "album-haven-functional-local-$invocationId-$safeShard")
    $fixtureWorkRoot = Join-Path $runnerTemp 'fixture-work'
    $writableFixtureRoot = Join-Path $fixtureWorkRoot 'shared'
    $immutableFixtureRoot = Join-Path $runnerTemp 'source-fixture'
    $outputRoot = Join-Path $runnerTemp 'output'
    $blobRoot = Join-Path $runnerTemp 'blob'
    $githubEnv = Join-Path $runnerTemp 'postgres.env'
    $statePath = Join-Path $runnerTemp 'postgres.state.json'
    $portBase = Get-FreePortBase
    $savedEnvironment = @{}
    foreach ($key in $environmentKeys) {
        $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    }
    $runFailed = $false
    $provisionAttempted = $false
    $teardownFailed = $false
    try {
        New-Item -ItemType Directory -Path $runnerTemp -Force | Out-Null
        Write-Host "Preparing $expectedRelease/$fixtureProfile for shard $($selectedShard.name)..."
        Copy-FixtureProfile $profileRoot $manifestPath $immutableFixtureRoot
        Copy-FixtureProfile $profileRoot $manifestPath $writableFixtureRoot

        $env:RUNNER_TEMP = $runnerTemp
        $env:GITHUB_ENV = $githubEnv
        $env:PGPASSFILE = $configuredPgpass
        $env:POSTGRESQL_ADMIN_PASSWORD = $postgresAdminPassword
        $env:PLAYWRIGHT_PROVIDER_PORT = [string]($portBase + 2)
        $provisionAttempted = $true
        Invoke-PostgresBootstrap `
            -Mode Provision `
            -DatabaseSuffix $databaseSuffix `
            -RunnerTemp $runnerTemp `
            -GithubEnv $githubEnv `
            -StatePath $statePath
        Remove-Item Env:POSTGRESQL_ADMIN_PASSWORD -ErrorAction SilentlyContinue
        Import-EnvironmentFile $githubEnv

        $env:ALBUM_HAVEN_FIXTURE_PROFILE = $fixtureProfile
        $env:ALBUM_HAVEN_FIXTURE_ROOT = $writableFixtureRoot
        $env:ALBUM_HAVEN_MEDIA_ROOT = Join-Path $writableFixtureRoot 'media'
        $env:ALBUM_HAVEN_FUNCTIONAL_OUTPUT_ROOT = $outputRoot
        $env:ALBUM_HAVEN_FUNCTIONAL_BLOB_ROOT = $blobRoot
        $env:ALBUM_HAVEN_FUNCTIONAL_FIXTURE_WORK_ROOT = $fixtureWorkRoot
        $env:ALBUM_HAVEN_FUNCTIONAL_SOURCE_FIXTURE_ROOT = $immutableFixtureRoot
        $env:ALBUM_HAVEN_FUNCTIONAL_PORT_BASE = [string]$portBase
        $env:PLAYWRIGHT_PROVIDER_PORT = [string]($portBase + 2)
        $env:PLAYWRIGHT_PYTHON = $python
        Remove-Item Env:MUSIC_DIR -ErrorAction SilentlyContinue
        Remove-Item Env:MUSIC_APP_DATA_DIR -ErrorAction SilentlyContinue
        Remove-Item Env:MUSIC_CACHE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:MUSIC_COVER_CACHE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:MUSIC_LIBRARY_ROOTS_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:PLAYWRIGHT_REAL_APP_URL -ErrorAction SilentlyContinue

        Write-Host 'Loading the isolated PostgreSQL fixture projection...'
        & $python $loader `
            --fixture-root $writableFixtureRoot `
            --profile $fixtureProfile `
            --database-url $env:DATABASE_MIGRATOR_URL `
            --replace-existing
        if ($LASTEXITCODE -ne 0) { throw 'Functional fixture loading failed.' }

        $validatorArguments = @($validator, "--run-shard=$($selectedShard.name)")
        if (-not [string]::IsNullOrWhiteSpace($Case)) {
            $validatorArguments += "--run-case=$Case"
        }
        Write-Host "Running shard $($selectedShard.name) on ports $portBase/$($portBase + 2)..."
        & $node @validatorArguments
        $shardExitCode = $LASTEXITCODE
        if ($shardExitCode -eq $processCleanupFailureExitCode) {
            $processCleanupFailed = $true
            throw "Process cleanup is unproven for shard $($selectedShard.name); stopping remaining shards."
        }
        if ($shardExitCode -ne 0) { throw "Functional shard failed: $($selectedShard.name)" }
    } catch {
        $runFailed = $true
        $overallFailed = $true
        Write-Host $_.Exception.Message -ForegroundColor Red
        if (-not [string]::IsNullOrWhiteSpace($_.ScriptStackTrace)) {
            Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
        }
    } finally {
        if (-not $processCleanupFailed -and $provisionAttempted -and (Test-Path -LiteralPath $statePath -PathType Leaf)) {
            try {
                $env:POSTGRESQL_ADMIN_PASSWORD = $postgresAdminPassword
                Invoke-PostgresBootstrap `
                    -Mode Teardown `
                    -DatabaseSuffix $databaseSuffix `
                    -RunnerTemp $runnerTemp `
                    -GithubEnv $githubEnv `
                    -StatePath $statePath
            } catch {
                $teardownFailed = $true
                $runFailed = $true
                $overallFailed = $true
                Write-Host "Teardown error: $($_.Exception.Message)" -ForegroundColor Red
            }
        }
        foreach ($key in $environmentKeys) {
            [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process')
        }

        $ownedRoot = Assert-OwnedTempRoot $runnerTemp
        if ($processCleanupFailed) {
            Write-Host "Database, fixtures, and failure artifacts retained until process shutdown is verified: $ownedRoot"
        } elseif ($runFailed) {
            $disposablePaths = @($immutableFixtureRoot, $fixtureWorkRoot)
            if (-not $teardownFailed) { $disposablePaths += @($githubEnv, $statePath) }
            foreach ($disposable in $disposablePaths) {
                if (Test-Path -LiteralPath $disposable) {
                    Remove-Item -LiteralPath $disposable -Recurse -Force
                }
            }
            Write-Host "Failure artifacts retained at: $ownedRoot"
        } elseif (Test-Path -LiteralPath $ownedRoot) {
            Remove-Item -LiteralPath $ownedRoot -Recurse -Force
        }
    }
    if ($processCleanupFailed) { break }
}

if ($processCleanupFailed) { exit $processCleanupFailureExitCode }
if ($overallFailed) { exit 1 }
exit 0
