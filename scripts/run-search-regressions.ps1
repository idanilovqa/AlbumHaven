[CmdletBinding()]
param(
    [string]$PythonPath = $env:PLAYWRIGHT_PYTHON,
    [string]$FixtureRoot = $env:ALBUM_HAVEN_FIXTURE_ROOT,
    [string]$FunctionalFixtureDistribution,
    [ValidateSet('', 'production-calibration')][string]$SyntheticScalePreset = $env:ALBUM_HAVEN_SYNTHETIC_SCALE_PRESET,
    [string]$Pgbin = $env:PGBIN,
    [string]$ChromeExecutable = $env:PLAYWRIGHT_CHROME_EXECUTABLE,
    [ValidateSet('17', '18')][string]$PostgresMajor = '18',
    [ValidateRange(1025, 65000)][int]$PerformanceBasePort = 4710
)

$ErrorActionPreference = 'Stop'
$env:PGCLIENTENCODING = 'UTF8'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$windowsPowerShellModules = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules'
if (Test-Path -LiteralPath $windowsPowerShellModules) {
    $env:PSModulePath = "$windowsPowerShellModules;$env:PSModulePath"
}

function Invoke-Checked([scriptblock]$Command, [string]$Label) {
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

foreach ($required in @(
    @{ Name = 'PLAYWRIGHT_PYTHON'; Value = $PythonPath },
    @{ Name = 'ALBUM_HAVEN_FIXTURE_ROOT'; Value = $FixtureRoot },
    @{ Name = 'PGBIN'; Value = $Pgbin },
    @{ Name = 'PLAYWRIGHT_CHROME_EXECUTABLE'; Value = $ChromeExecutable },
    @{ Name = 'POSTGRESQL_ADMIN_PASSWORD'; Value = $env:POSTGRESQL_ADMIN_PASSWORD }
)) {
    if ([string]::IsNullOrWhiteSpace([string]$required.Value)) {
        throw "$($required.Name) is required for the complete search regression gate."
    }
}

foreach ($path in @($PythonPath, $FixtureRoot, $Pgbin, $ChromeExecutable)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Search regression dependency does not exist: $path"
    }
}

$node = (Get-Command node -ErrorAction Stop).Source
$playwright = Join-Path $repositoryRoot 'node_modules\.bin\playwright.cmd'
$functionalRunner = Join-Path $repositoryRoot 'scripts\run-functional-e2e-local.ps1'
$performanceRunner = Join-Path $repositoryRoot 'scripts\ci\run-performance-shard.ps1'
$fixtureDistributionRoot = Split-Path -Parent (Split-Path -Parent ([IO.Path]::GetFullPath($FixtureRoot)))
if (-not [string]::IsNullOrWhiteSpace($FunctionalFixtureDistribution)) {
    $fixtureDistributionRoot = [IO.Path]::GetFullPath($FunctionalFixtureDistribution)
}
$performanceTemp = Join-Path ([IO.Path]::GetTempPath()) "album-haven-search-regressions-$PID"
$githubEnv = Join-Path $performanceTemp 'database.env'

$env:PLAYWRIGHT_PYTHON = $PythonPath
$env:ALBUM_HAVEN_FIXTURE_ROOT = $FixtureRoot
$env:ALBUM_HAVEN_MEDIA_ROOT = Join-Path $FixtureRoot 'media'
$env:ALBUM_HAVEN_FIXTURE_PROFILE = 'synthetic-large-library'
$env:ALBUM_HAVEN_SYNTHETIC_SCALE_PRESET = $SyntheticScalePreset
$env:PLAYWRIGHT_CHROME_EXECUTABLE = $ChromeExecutable
$env:PGBIN = $Pgbin

Set-Location $repositoryRoot

Invoke-Checked {
    & $PythonPath -m pytest tests\py\test_library_browse_postgres.py `
        tests\py\test_api_read_asgi_routes.py tests\py\test_web_asgi_routes.py `
        tests\py\test_gallery_album_capability_projection.py `
        -k 'search or selected_artist or test_duplicate_source_attachment_defers_global_index_cache_miss or duplicate_absence or gallery_summary_projects_request_edit_permission' -q
} 'Search API and PostgreSQL contracts'

Invoke-Checked {
    & $PythonPath -m pytest tests\py\test_multi_root_duplicates.py -q
} 'Shared browse membership and duplicate contracts'

Invoke-Checked {
    & $node --test --test-concurrency=1 `
        tests\js\gallery-search-clear-continuity.test.js `
        tests\js\search-toolbar-query-state.test.js `
        tests\js\search-toolbar-anchor-geometry.test.js `
        tests\js\runtime\search-input-clear.test.js `
        tests\js\runtime\gallery-tree-selection-performance.test.js `
        tests\js\runtime\root-gallery-pagination.test.js `
        tests\js\runtime\gallery-refresh-and-status.test.js `
        tests\js\runtime\sidebar-selection-visibility.test.js `
        tests\js\runtime\sidebar-virtualization.test.js `
        tests\js\runtime\view-state-helpers.test.js `
        tests\js\runtime\bootstrap-gallery-event-handlers.test.js `
        tests\js\synthetic-performance-benchmark.test.js `
        tests\js\performance-change-impact.test.js `
        tests\js\performance-traffic-observer.test.js `
        tests\js\navigation-panel-actions.test.js `
        tests\js\search-regression-gate.test.js
} 'Search JavaScript contracts'

Invoke-Checked {
    & $playwright test searchInput.spec.js `
        --config=playwright.component.config.js --workers=1
} 'Search component tests'

Invoke-Checked {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $functionalRunner `
        -Shard gallery-search-visual -PythonPath $PythonPath `
        -FixtureDistribution $fixtureDistributionRoot
} 'Search functional E2E shard'

New-Item -ItemType Directory -Force -Path $performanceTemp | Out-Null
try {
    Invoke-Checked {
        & $performanceRunner `
            -Targets 'artist-family,search-all-artists,search-browse' `
            -FixtureProfile synthetic-large-library `
            -FixtureMode preloaded-release `
            -BasePort $PerformanceBasePort `
            -DatabaseSuffixBase "searchreg_$PID" `
            -ExpectedPostgresMajor $PostgresMajor `
            -Pgbin $Pgbin `
            -RepositoryRoot $repositoryRoot `
            -RunnerTemp $performanceTemp `
            -GithubEnv $githubEnv `
            -PythonPath $PythonPath `
            -ShardName search-regressions `
            -PerformanceContract local
    } 'Measured search performance targets'
} finally {
    $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $resolvedPerformanceTemp = [IO.Path]::GetFullPath($performanceTemp)
    if (-not $resolvedPerformanceTemp.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove search regression artifacts outside the temp root: $resolvedPerformanceTemp"
    }
    if (Test-Path -LiteralPath $resolvedPerformanceTemp) {
        Remove-Item -LiteralPath $resolvedPerformanceTemp -Recurse -Force
    }
}
