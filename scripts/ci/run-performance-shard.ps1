param(
    [Parameter(Mandatory = $true)][string]$Targets,
    [Parameter(Mandatory = $true)][string]$FixtureProfile,
    [Parameter(Mandatory = $true)][ValidateSet('preloaded-release', 'generated-isolated')][string]$FixtureMode,
    [Parameter(Mandatory = $true)][ValidateRange(1025, 65000)][int]$BasePort,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]+(?:_[a-z0-9]+)*$')][string]$DatabaseSuffixBase,
    [ValidatePattern('^\d+$')][string]$ExpectedPostgresMajor = '17',
    [ValidateRange(1, 65535)][int]$PostgresPort = 5432,
    [string]$RepositoryRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [string]$RunnerTemp = $env:RUNNER_TEMP,
    [string]$GithubEnv = $env:GITHUB_ENV,
    [string]$Pgbin = $env:PGBIN,
    [string]$PythonPath = $env:PLAYWRIGHT_PYTHON,
    [string]$RunAttempt = $env:GITHUB_RUN_ATTEMPT,
    [string]$ShardName = 'performance-shard',
    [ValidateSet('chrome')][string]$Browser = 'chrome',
    [ValidateSet('local', 'ci')][string]$PerformanceContract = 'local'
)

$ErrorActionPreference = 'Stop'
$targetNames = @($Targets.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($targetNames.Count -lt 1 -or $targetNames.Count -gt 10) {
    throw 'Performance profile runner must own between one and ten targets.'
}
if ((@($targetNames | Select-Object -Unique)).Count -ne $targetNames.Count) {
    throw 'Performance shard target list contains a duplicate.'
}
if ([string]::IsNullOrWhiteSpace($RunnerTemp)) { throw 'RUNNER_TEMP is required.' }
if ([string]::IsNullOrWhiteSpace($GithubEnv)) { throw 'GITHUB_ENV is required.' }
if ([string]::IsNullOrWhiteSpace($Pgbin)) { throw 'PGBIN is required.' }
if ([string]::IsNullOrWhiteSpace($PythonPath)) { throw 'PLAYWRIGHT_PYTHON is required.' }

$bootstrap = Join-Path $RepositoryRoot 'scripts\ci\bootstrap-windows-postgres.ps1'
$performanceRunner = Join-Path $RepositoryRoot 'scripts\run-performance-playwright.cjs'
$foundationWriter = Join-Path $RepositoryRoot 'scripts\ci\write-foundation-version-manifest.cjs'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$stateRoot = Join-Path $RunnerTemp "album-haven-performance-shard-$ShardName"
$profileSessionRoot = Join-Path $stateRoot 'prepared-profile'
$foundationRoot = Join-Path $RunnerTemp 'album-haven-performance-foundations'
$resultRoot = Join-Path $RepositoryRoot 'test-results\playwright-performance-targets'
$failedTargets = [System.Collections.Generic.List[string]]::new()
$targetIndex = 0
$postgresServiceName = "postgresql-x64-$ExpectedPostgresMajor"
New-Item -ItemType Directory -Path $stateRoot, $foundationRoot, $resultRoot -Force | Out-Null

function Write-CiJob([string]$Target, [string]$Conclusion) {
    $targetRoot = Join-Path $resultRoot $Target
    New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
    [ordered]@{
        target = $Target
        shard = $ShardName
        fixtureProfile = $FixtureProfile
        fixtureMode = $FixtureMode
        blocking = $false
        runAttempt = $RunAttempt
        conclusion = $Conclusion
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $targetRoot 'ci-job.json') -Encoding utf8
}

function Set-ClearedRuntimeSelectors {
    foreach ($key in @(
        'MUSIC_DIR',
        'MUSIC_APP_DATA_DIR',
        'MUSIC_CACHE_PATH',
        'MUSIC_COVER_CACHE_PATH',
        'MUSIC_LIBRARY_ROOTS_PATH',
        'PLAYWRIGHT_REAL_APP_URL'
    )) {
        Set-Item -LiteralPath "Env:$key" -Value ' '
    }
}

function Wait-TargetPortsClear([int]$AppPort) {
    $ports = @(0..6 | ForEach-Object { $AppPort + $_ })
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        $active = @($ports | ForEach-Object {
            Get-NetTCPConnection -LocalPort $_ -ErrorAction SilentlyContinue |
                Where-Object { $_.State -ne 'TimeWait' -and $_.OwningProcess -ne 0 }
        })
        if ($active.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "Performance target teardown left an owned listener in the $($ports -join ', ') port set."
}

function Test-TargetPortBlockSafe([int]$AppPort) {
    $browserUnsafePorts = @(
        1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
        6665, 6666, 6667, 6668, 6669, 6697, 10080
    )
    if ($AppPort -lt 1025 -or ($AppPort + 6) -gt 65535) { return $false }
    return -not @(0..6 | Where-Object { $browserUnsafePorts -contains ($AppPort + $_) }).Count
}

function Get-SafeTargetPort([int]$SequenceIndex) {
    $candidatePort = $BasePort
    $safeSequenceIndex = 0
    while ($candidatePort -le 65529) {
        if (Test-TargetPortBlockSafe $candidatePort) {
            if ($safeSequenceIndex -eq $SequenceIndex) { return $candidatePort }
            $safeSequenceIndex += 1
        }
        $candidatePort += 8
    }
    throw "Performance target port allocation exceeds the available browser-safe range from base port $BasePort."
}

function Prepare-PerformanceFixture {
    New-Item -ItemType Directory -Path $profileSessionRoot -Force | Out-Null
    $env:ALBUM_HAVEN_PERFORMANCE_PROFILE_SESSION = '1'
    $env:ALBUM_HAVEN_E2E_TEMP_ROOT = $profileSessionRoot
    $env:ALBUM_HAVEN_E2E_PRESERVE_ON_SHUTDOWN = '1'
    $env:ALBUM_HAVEN_E2E_REUSE_STATE = $null

    if ($FixtureMode -eq 'preloaded-release') {
        $loader = Join-Path $RepositoryRoot 'scripts\ci\load-fixture-profile.py'
        & $PythonPath $loader `
            --fixture-root $env:ALBUM_HAVEN_FIXTURE_ROOT `
            --profile $FixtureProfile `
            --database-url $env:DATABASE_MIGRATOR_URL `
            --replace-existing
        if ($LASTEXITCODE -ne 0) { throw "Fixture preparation failed for $FixtureProfile." }
        $env:ALBUM_HAVEN_E2E_REUSE_STATE = '1'
        return
    }

    if ($FixtureProfile -eq 'playback-media') {
        $isolatedApp = Join-Path $RepositoryRoot 'tests\e2e\support\isolatedLibraryApp.py'
        & $PythonPath $isolatedApp --prepare-only --provider-port ($BasePort + 2)
    } elseif ($FixtureProfile -eq 'scan-library') {
        $env:ALBUM_HAVEN_COVER_PROVIDER_GROUPS = 'offline'
        $scanApp = Join-Path $RepositoryRoot 'tests\e2e\support\scanPerformanceApp.py'
        & $PythonPath $scanApp --prepare-only
    } else {
        throw "Unsupported generated performance fixture profile: $FixtureProfile"
    }
    if ($LASTEXITCODE -ne 0) { throw "Fixture preparation failed for $FixtureProfile." }
    $env:ALBUM_HAVEN_E2E_REUSE_STATE = '1'
}

Set-Location $RepositoryRoot
if ($DatabaseSuffixBase.Length -gt 39) { throw 'Database suffix is too long for the performance shard.' }
$statePath = Join-Path $stateRoot "$ShardName.state.json"
$setupFailure = $null
$teardownFailure = $null
foreach ($target in $targetNames) { Write-CiJob $target 'initialized' }

try {
    $provisionArguments = @{
        Mode = 'Provision'
        ServiceName = $postgresServiceName
        ExpectedMajorVersion = $ExpectedPostgresMajor
        Port = $PostgresPort
        Pgbin = $Pgbin
        HostName = '127.0.0.1'
        DatabaseSuffix = $DatabaseSuffixBase
        RepositoryRoot = $RepositoryRoot
        RunnerTemp = $RunnerTemp
        GithubEnv = $GithubEnv
        StatePath = $statePath
        PythonPath = $PythonPath
    }
    & $bootstrap @provisionArguments -SkipFixtureLoad

    $env:PGPASSWORD = $null
    $env:PLAYWRIGHT_PYTHON = $PythonPath
    $env:ALBUM_HAVEN_FIXTURE_PROFILE = $FixtureProfile
    Set-ClearedRuntimeSelectors
    if ($FixtureMode -eq 'generated-isolated') {
        Set-Item -LiteralPath 'Env:ALBUM_HAVEN_FIXTURE_ROOT' -Value ' '
        Set-Item -LiteralPath 'Env:ALBUM_HAVEN_MEDIA_ROOT' -Value ' '
    }
    if ($FixtureProfile -eq 'scan-library') {
        $env:ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL = $env:DATABASE_MIGRATOR_URL
        $env:ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL = $env:DATABASE_APP_URL
    } else {
        $env:ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL = $null
        $env:ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL = $null
    }

    Prepare-PerformanceFixture

    foreach ($target in $targetNames) {
        $targetIndex += 1
        $targetPort = Get-SafeTargetPort -SequenceIndex ($targetIndex - 1)
        $targetFailure = $null
        $targetPortFailure = $null
        $targetExitCode = 1
        try {
            $env:PLAYWRIGHT_PORT = [string]$targetPort
            $env:PLAYWRIGHT_REAL_APP_PORT = [string]$targetPort
            $env:PLAYWRIGHT_PROVIDER_PORT = [string]($targetPort + 2)

            $foundationPath = Join-Path $foundationRoot "foundation-version-manifest-performance-$target.json"
            & $nodePath $foundationWriter --profile=windows "--postgres-major=$ExpectedPostgresMajor" "--output=$foundationPath"
            if ($LASTEXITCODE -ne 0) { throw "Foundation manifest failed for $target." }

            & $nodePath $performanceRunner "--test=$target" --headless "--browser=$Browser" --prepared-fixture "--performance-contract=$PerformanceContract"
            $targetExitCode = $LASTEXITCODE
            if ($targetExitCode -ne 0) { [void]$failedTargets.Add($target) }
        } catch {
            $targetFailure = $_
            if (-not $failedTargets.Contains($target)) { [void]$failedTargets.Add($target) }
        } finally {
            try {
                Wait-TargetPortsClear $targetPort
            } catch {
                $targetPortFailure = "target port audit: $($_.Exception.Message)"
                if (-not $failedTargets.Contains($target)) { [void]$failedTargets.Add($target) }
            }
            $conclusion = if ($targetFailure -or $targetExitCode -ne 0 -or $targetPortFailure) { 'failure' } else { 'success' }
            Write-CiJob $target $conclusion
        }
        if ($targetPortFailure) { throw "Performance target $target cleanup failed; shard continuation is unsafe: $targetPortFailure" }
    }
} catch {
    $setupFailure = $_
    foreach ($target in $targetNames) {
        if (-not $failedTargets.Contains($target)) {
            [void]$failedTargets.Add($target)
            Write-CiJob $target 'failure'
        }
    }
} finally {
    if (Test-Path -LiteralPath $profileSessionRoot) {
        try {
            Remove-Item -LiteralPath $profileSessionRoot -Recurse -Force
        } catch {
            $teardownFailure = "profile fixture teardown: $($_.Exception.Message)"
        }
    }
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try {
            & $bootstrap `
                -Mode Teardown `
                -ServiceName $postgresServiceName `
                -ExpectedMajorVersion $ExpectedPostgresMajor `
                -Port $PostgresPort `
                -Pgbin $Pgbin `
                -HostName 127.0.0.1 `
                -DatabaseSuffix $DatabaseSuffixBase `
                -RepositoryRoot $RepositoryRoot `
                -RunnerTemp $RunnerTemp `
                -GithubEnv $GithubEnv `
                -StatePath $statePath `
                -PythonPath $PythonPath
        } catch {
            $databaseTeardownFailure = "database teardown: $($_.Exception.Message)"
            $teardownFailure = if ($teardownFailure) {
                "$teardownFailure; $databaseTeardownFailure"
            } else {
                $databaseTeardownFailure
            }
        }
    }
}

if ($teardownFailure) { throw "Performance shard teardown failed: $teardownFailure" }
if ($setupFailure) { throw "Performance shard setup or continuation failed: $setupFailure" }

if ($failedTargets.Count -gt 0) {
    Write-Error "Performance shard completed with failed targets: $($failedTargets -join ', ')"
    exit 1
}
exit 0
