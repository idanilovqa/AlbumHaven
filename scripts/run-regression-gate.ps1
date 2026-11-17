[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('search', 'problematic-files', 'html-reload', 'edit-tags', 'bounded-interactions')]
    [string]$Gate,
    [switch]$ListFixtureProfiles,
    [string]$FixtureDistribution = $env:ALBUM_HAVEN_FIXTURE_DISTRIBUTION,
    [string]$PythonPath = $env:PLAYWRIGHT_PYTHON,
    [string]$Pgbin = $env:PGBIN,
    [string]$ChromeExecutable = $env:PLAYWRIGHT_CHROME_EXECUTABLE,
    [ValidateSet('17', '18')][string]$PostgresMajor = '18',
    [ValidateRange(1025, 65000)][int]$PerformanceBasePort = 4810
)

# One entry point for the mandatory regression gates in AGENTS.md. Stages run serially.
# The search gate delegates to scripts/run-search-regressions.ps1, its single owner.
# Python stages fail on unexpected skips: a skipped database case does not satisfy a gate.

$ErrorActionPreference = 'Stop'
$env:PGCLIENTENCODING = 'UTF8'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Pgbin)) { $Pgbin = "C:\PostgreSQL\$PostgresMajor\bin" }

$gates = @{
    'search' = @{ FixtureProfiles = @('functional-core', 'synthetic-large-library') }
    'problematic-files' = @{
        FixtureProfiles = @('functional-core', 'utility-problematic-files')
        RequiredEnvironment = @('ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL')
        Pytest = @(
            @('tests/py/test_library_browse_postgres.py', 'tests/py/test_api_read_asgi_routes.py', '-k', 'problematic'),
            @('tests/py/test_multi_root_duplicates.py', 'tests/py/test_problematic_albums.py',
                'tests/py/test_problematic_detail_identity.py', 'tests/py/test_problematic_physical_files_postgres.py',
                'tests/py/test_problematic_file_projection_migration_postgres.py')
        )
        Node = @('tests/js/runtime/utility-problematic-load-diagnostics.test.js',
            'tests/js/runtime/utility-problematic-tab.test.js', 'tests/js/runtime/problematic-files-virtual-list.test.js',
            'tests/js/runtime/utility-problematic-focused-track-render.test.js',
            'tests/js/runtime/problem-exclusion-mutations.test.js', 'tests/js/problematic-payload-evidence.test.js',
            'tests/js/performance-change-impact.test.js', 'tests/js/e2e-performance-helper-guards.test.js')
        Components = @('problematicFilesVirtualFocus.spec.js')
        FunctionalArea = 'problematic-files'
        Performance = @{ Profile = 'utility-problematic-files'; Targets = 'utility-problematic-files,problematic-files-focused' }
    }
    'html-reload' = @{
        FixtureProfiles = @('synthetic-large-library')
        Pytest = @(, @('tests/py/test_web_bootstrap.py', 'tests/py/test_runtime_asset_versions.py',
                'tests/py/test_runtime_shutdown.py'))
        Performance = @{ Profile = 'synthetic-large-library'; Targets = 'artist-tree-scroll-navigation' }
    }
    'edit-tags' = @{
        FixtureProfiles = @('functional-core', 'synthetic-large-library')
        Pytest = @(, @('tests/py/test_edit_workflows.py', 'tests/py/test_save_tasks.py', 'tests/py/test_edit_state.py',
                'tests/py/test_tag_edit_recovery.py', 'tests/py/test_tag_edit_intents_postgres.py',
                'tests/py/test_postgres_structural_tag_edit.py'))
        Node = @('tests/js/runtime/tag-editor-*.test.js', 'tests/js/runtime/utility-tag-edit-optimistic.test.js')
        FunctionalShard = 'metadata-mutations'
        Performance = @{ Profile = 'synthetic-large-library'; Targets = 'edit-tags-post-edit' }
    }
    'bounded-interactions' = @{ FixtureProfiles = @() }
}
$definition = $gates[$Gate]

if ($ListFixtureProfiles) {
    $definition.FixtureProfiles | ForEach-Object { Write-Output $_ }
    exit 0
}

# Every stage runs even after an earlier failure so one run reports the complete failure set.
$failedStages = [System.Collections.Generic.List[string]]::new()
function Invoke-Checked([scriptblock]$Command, [string]$Label) {
    Write-Host "::group::$Gate gate: $Label"
    try {
        $global:LASTEXITCODE = 0
        & $Command
        if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
    } catch {
        $failedStages.Add("$Label ($($_.Exception.Message))")
    } finally {
        Write-Host '::endgroup::'
    }
}

function Complete-Gate {
    if ($failedStages.Count -gt 0) {
        $failedStages | ForEach-Object { Write-Host "::error::$Gate gate stage failed: $_" }
        exit 1
    }
    Write-Host "$Gate gate passed."
    exit 0
}

function Get-ProfileRoot([string]$FixtureProfile) {
    return Join-Path ([IO.Path]::GetFullPath($FixtureDistribution)) "profiles\$FixtureProfile"
}

if ([string]::IsNullOrWhiteSpace($PythonPath)) { throw "PLAYWRIGHT_PYTHON is required for the $Gate gate." }
foreach ($name in @($definition.RequiredEnvironment)) {
    if ($name -and [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
        throw "$name must name an isolated database for the $Gate gate."
    }
}
if ($definition.FixtureProfiles.Count -gt 0) {
    if ([string]::IsNullOrWhiteSpace($FixtureDistribution)) { throw "FixtureDistribution is required for the $Gate gate." }
    if ([string]::IsNullOrWhiteSpace($ChromeExecutable)) { throw "PLAYWRIGHT_CHROME_EXECUTABLE is required for the $Gate gate." }
    foreach ($fixtureProfile in $definition.FixtureProfiles) {
        if (-not (Test-Path -LiteralPath (Get-ProfileRoot $fixtureProfile) -PathType Container)) {
            throw "Fixture profile is missing: $(Get-ProfileRoot $fixtureProfile)"
        }
    }
}

Set-Location $repositoryRoot
$env:PLAYWRIGHT_PYTHON = $PythonPath
$env:PLAYWRIGHT_CHROME_EXECUTABLE = $ChromeExecutable
$env:PGBIN = $Pgbin

if ($Gate -eq 'search') {
    Invoke-Checked {
        & (Join-Path $PSScriptRoot 'run-search-regressions.ps1') `
            -PythonPath $PythonPath `
            -FixtureRoot (Get-ProfileRoot 'synthetic-large-library') `
            -FunctionalFixtureDistribution $FixtureDistribution `
            -Pgbin $Pgbin `
            -ChromeExecutable $ChromeExecutable `
            -PostgresMajor $PostgresMajor `
            -PerformanceBasePort $PerformanceBasePort
    } 'npm run test:search-regressions'
    Complete-Gate
}

if ($Gate -eq 'bounded-interactions') {
    $packageScripts = (Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'package.json') | ConvertFrom-Json).scripts
    if (-not $packageScripts.'test:bounded-interactions') {
        throw 'This ref has no test:bounded-interactions script; the bounded-interaction gate is not available here.'
    }
    Invoke-Checked { & npm run test:bounded-interactions } 'npm run test:bounded-interactions'
    Complete-Gate
}

$junitRoot = Join-Path $repositoryRoot "test-results\regression-gates\$Gate"
New-Item -ItemType Directory -Force -Path $junitRoot | Out-Null
$index = 0
foreach ($selection in @($definition.Pytest)) {
    if (-not $selection) { continue }
    $index += 1
    $junit = Join-Path $junitRoot "pytest-$index.xml"
    Invoke-Checked { & $PythonPath -m pytest @selection -q "--junitxml=$junit" } "Python stage $index"
    Invoke-Checked {
        & node scripts/ci/validate-foundation-gates.cjs "--pytest-junit=$junit" '--allowed-skips=tests/ci/pytest-allowed-skips.json'
    } "Python stage $index skip policy"
}

if ($definition.Node) {
    $nodeTests = @($definition.Node | ForEach-Object {
        Get-ChildItem -Path (Join-Path $repositoryRoot $_) -File | ForEach-Object { $_.FullName }
    })
    Invoke-Checked { & node --test --test-concurrency=1 @nodeTests } 'JavaScript stage'
}

if ($definition.Components) {
    $playwright = Join-Path $repositoryRoot 'node_modules\.bin\playwright.cmd'
    Invoke-Checked {
        & $playwright test @($definition.Components) --config=playwright.component.config.js --workers=1
    } 'Component stage'
}

$functionalRunner = Join-Path $PSScriptRoot 'run-functional-e2e-local.ps1'
$functionalCommon = @{
    PythonPath = $PythonPath
    FixtureDistribution = $FixtureDistribution
    PostgresMajor = $PostgresMajor
    Pgbin = $Pgbin
}
if ($definition.FunctionalShard) {
    Invoke-Checked { & $functionalRunner -Shard $definition.FunctionalShard @functionalCommon } "Functional shard $($definition.FunctionalShard)"
}
if ($definition.FunctionalArea) {
    $contract = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repositoryRoot 'tests\ci\functional-shards.json') | ConvertFrom-Json
    foreach ($shard in $contract.shards) {
        $cases = @($shard.invocations | ForEach-Object { $_.cases } | Where-Object {
            @($_.areas) + @($_.area) -contains $definition.FunctionalArea
        } | ForEach-Object { $_.case })
        if ($cases.Count -eq 0) { continue }
        Invoke-Checked {
            & $functionalRunner -Shard $shard.name -Cases $cases @functionalCommon
        } "Functional $($definition.FunctionalArea) cases in $($shard.name)"
    }
}

if ($definition.Performance) {
    $performanceTemp = Join-Path ([IO.Path]::GetTempPath()) "album-haven-$Gate-performance-$PID"
    New-Item -ItemType Directory -Force -Path $performanceTemp | Out-Null
    $env:ALBUM_HAVEN_FIXTURE_PROFILE = $definition.Performance.Profile
    $env:ALBUM_HAVEN_FIXTURE_ROOT = Get-ProfileRoot $definition.Performance.Profile
    $env:ALBUM_HAVEN_MEDIA_ROOT = Join-Path $env:ALBUM_HAVEN_FIXTURE_ROOT 'media'
    Invoke-Checked {
        & (Join-Path $PSScriptRoot 'ci\run-performance-shard.ps1') `
            -Targets $definition.Performance.Targets `
            -FixtureProfile $definition.Performance.Profile `
            -FixtureMode preloaded-release `
            -BasePort $PerformanceBasePort `
            -DatabaseSuffixBase "$($Gate.Replace('-', '_'))_$PID" `
            -ExpectedPostgresMajor $PostgresMajor `
            -Pgbin $Pgbin `
            -RepositoryRoot $repositoryRoot `
            -RunnerTemp $performanceTemp `
            -GithubEnv (Join-Path $performanceTemp 'database.env') `
            -PythonPath $PythonPath `
            -ShardName "$Gate-gate" `
            -PerformanceContract local
    } "Measured targets $($definition.Performance.Targets)"
}

Complete-Gate
