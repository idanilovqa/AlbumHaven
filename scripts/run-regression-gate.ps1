[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('search', 'problematic-files', 'html-reload', 'edit-tags', 'bounded-interactions', 'focused')]
    [string]$Gate,
    # Focused gate only: functional cases (FTC ids or exact approved titles) and measured target names,
    # separated by commas or new lines. It runs just those, to reproduce or verify one failure quickly.
    [string]$Cases = '',
    [string]$Targets = '',
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
    # synthetic-production-library is the synthetic-large-library profile at the owner's library size.
    'search' = @{ FixtureProfiles = @('functional-core', 'synthetic-production-library') }
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
        FixtureProfiles = @('synthetic-production-library')
        Pytest = @(, @('tests/py/test_web_bootstrap.py', 'tests/py/test_runtime_asset_versions.py',
                'tests/py/test_runtime_shutdown.py'))
        Performance = @{ Profile = 'synthetic-production-library'; Targets = 'artist-tree-scroll-navigation' }
    }
    'edit-tags' = @{
        FixtureProfiles = @('functional-core', 'synthetic-large-library', 'synthetic-production-library')
        Pytest = @(, @('tests/py/test_edit_workflows.py', 'tests/py/test_save_tasks.py', 'tests/py/test_edit_state.py',
                'tests/py/test_tag_edit_recovery.py', 'tests/py/test_tag_edit_intents_postgres.py',
                'tests/py/test_postgres_structural_tag_edit.py'))
        Node = @('tests/js/runtime/tag-editor-*.test.js', 'tests/js/runtime/utility-tag-edit-optimistic.test.js')
        FunctionalShard = 'metadata-mutations'
        Performance = @{ Profile = 'synthetic-production-library'; Targets = 'edit-tags-post-edit' }
    }
    'bounded-interactions' = @{ FixtureProfiles = @() }
    'focused' = @{ FixtureProfiles = @() }
}
$definition = $gates[$Gate]

function Split-FocusedSelection([string]$Value) {
    return @($Value -split '[,\r\n]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

$focusedCases = @()
$focusedTargets = @()
if ($Gate -eq 'focused') {
    $focusedCases = Split-FocusedSelection $Cases
    $focusedTargets = Split-FocusedSelection $Targets
    if ($focusedCases.Count -eq 0 -and $focusedTargets.Count -eq 0) {
        throw 'The focused gate needs -Cases, -Targets, or both.'
    }
    # The trusted copy of this script lists fixtures before the tested ref runs; it reads the tested ref's
    # registry as data from the working directory.
    $dataRoot = if (Test-Path -LiteralPath (Join-Path $repositoryRoot 'tests\ci\performance-targets.json')) {
        $repositoryRoot
    } else {
        (Get-Location).Path
    }
    $registry = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $dataRoot 'tests\ci\performance-targets.json') | ConvertFrom-Json
    $targetProfiles = [ordered]@{}
    foreach ($targetName in $focusedTargets) {
        $target = @($registry.targets | Where-Object { $_.name -ceq $targetName })
        if ($target.Count -ne 1) { throw "Unknown measured target: $targetName" }
        $targetProfiles[$targetName] = if ($target[0].fixtureScale -eq 'production-calibration') {
            'synthetic-production-library'
        } else {
            [string]$target[0].fixtureProfile
        }
    }
    $definition.FixtureProfiles = @(@($(if ($focusedCases.Count) { 'functional-core' })) + @($targetProfiles.Values) |
        Where-Object { $_ } | Select-Object -Unique)
}

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
            -FixtureRoot (Get-ProfileRoot 'synthetic-production-library') `
            -SyntheticScalePreset production-calibration `
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
function Invoke-MeasuredTargets([string]$TargetList, [string]$FixtureProfile, [string]$ShardName) {
    $performanceTemp = Join-Path ([IO.Path]::GetTempPath()) "album-haven-$ShardName-performance-$PID"
    New-Item -ItemType Directory -Force -Path $performanceTemp | Out-Null
    $loaderProfile = if ($FixtureProfile -eq 'synthetic-production-library') { 'synthetic-large-library' } else { $FixtureProfile }
    $env:ALBUM_HAVEN_SYNTHETIC_SCALE_PRESET = if ($loaderProfile -ne $FixtureProfile) { 'production-calibration' } else { '' }
    $env:ALBUM_HAVEN_FIXTURE_PROFILE = $loaderProfile
    $env:ALBUM_HAVEN_FIXTURE_ROOT = Get-ProfileRoot $FixtureProfile
    $env:ALBUM_HAVEN_MEDIA_ROOT = Join-Path $env:ALBUM_HAVEN_FIXTURE_ROOT 'media'
    Invoke-Checked {
        & (Join-Path $PSScriptRoot 'ci\run-performance-shard.ps1') `
            -Targets $TargetList `
            -FixtureProfile $loaderProfile `
            -FixtureMode preloaded-release `
            -BasePort $PerformanceBasePort `
            -DatabaseSuffixBase "$($ShardName.Replace('-', '_'))_$PID" `
            -ExpectedPostgresMajor $PostgresMajor `
            -Pgbin $Pgbin `
            -RepositoryRoot $repositoryRoot `
            -RunnerTemp $performanceTemp `
            -GithubEnv (Join-Path $performanceTemp 'database.env') `
            -PythonPath $PythonPath `
            -ShardName $ShardName `
            -PerformanceContract local
    } "Measured targets $TargetList"
}

if ($Gate -eq 'focused') {
    # Each case runs in the shard that owns it, with that shard's isolated setup, exactly as in a full gate.
    $contract = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repositoryRoot 'tests\ci\functional-shards.json') | ConvertFrom-Json
    $owned = @(foreach ($shard in $contract.shards) {
        foreach ($ownedCase in @($shard.invocations | ForEach-Object { $_.cases })) {
            [pscustomobject]@{ Shard = $shard.name; Title = [string]$ownedCase.case }
        }
    })
    $selected = @(foreach ($selector in $focusedCases) {
        $found = @($owned | Where-Object { $_.Title -ceq $selector -or $_.Title.StartsWith("$selector ", [StringComparison]::Ordinal) })
        if ($found.Count -eq 0) { throw "No approved functional case matches: $selector" }
        $found
    })
    foreach ($group in @($selected | Group-Object Shard)) {
        $titles = @($group.Group | ForEach-Object { $_.Title } | Select-Object -Unique)
        Invoke-Checked { & $functionalRunner -Shard $group.Name -Cases $titles @functionalCommon } "Functional cases in $($group.Name)"
    }
    foreach ($group in @($focusedTargets | Group-Object { $targetProfiles[$_] })) {
        Invoke-MeasuredTargets ($group.Group -join ',') $group.Name "focused-$($group.Name)"
    }
    Complete-Gate
}

if ($definition.FunctionalShard) {
    Invoke-Checked { & $functionalRunner -Shard $definition.FunctionalShard @functionalCommon } "Functional shard $($definition.FunctionalShard)"
}
if ($definition.FunctionalArea) {
    $contract = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repositoryRoot 'tests\ci\functional-shards.json') | ConvertFrom-Json
    foreach ($shard in $contract.shards) {
        # Not $cases: variable names ignore case, so that would assign to the [string]$Cases parameter.
        $areaCases = @($shard.invocations | ForEach-Object { $_.cases } | Where-Object {
            @($_.areas) + @($_.area) -contains $definition.FunctionalArea
        } | ForEach-Object { $_.case })
        if ($areaCases.Count -eq 0) { continue }
        Invoke-Checked {
            & $functionalRunner -Shard $shard.name -Cases $areaCases @functionalCommon
        } "Functional $($definition.FunctionalArea) cases in $($shard.name)"
    }
}

if ($definition.Performance) {
    Invoke-MeasuredTargets $definition.Performance.Targets $definition.Performance.Profile "$Gate-gate"
}

Complete-Gate
