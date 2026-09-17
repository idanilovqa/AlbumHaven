param([switch]$Run)
$ErrorActionPreference = 'Stop'
$taskNode = 'C:\Program Files\nodejs\node.exe'
if ((& $taskNode --version) -ne 'v22.22.2') { throw 'Pinned Node 22.22.2 is required.' }
$env:PATH = (Split-Path $taskNode) + ';' + $env:PATH
function Get-PostgresAdminPassword([string]$PgpassPath) {
    foreach ($line in (Get-Content -LiteralPath $PgpassPath)) {
        if ($line -match '^localhost:5432:(?:\*|postgres):postgres:(.+)$') {
            return $Matches[1].Replace('\:', ':').Replace('\\', '\')
        }
    }
    throw "PGPASSFILE has no localhost:5432 entry for the postgres role: $PgpassPath"
}

$env:POSTGRESQL_ADMIN_PASSWORD = Get-PostgresAdminPassword (Join-Path $env:APPDATA 'postgresql\pgpass.conf')
$env:PLAYWRIGHT_CHROME_EXECUTABLE = 'C:\Users\Rendref\.cache\album-haven\chrome-for-testing-151.0.7922.138\chrome.exe'
$taskRepo = (Resolve-Path -LiteralPath '.').Path
$taskFixture = 'C:\Repositories\album-haven-test-data-gallery-refactor\dist'
$env:ALBUM_HAVEN_APPROVED_COVER_ROOT = Join-Path $taskFixture 'profiles\utility-problematic-files\media\covers\approved'
$taskToken = [guid]::NewGuid().ToString('N').Substring(0,8)
$taskTemp = [IO.Path]::GetFullPath((Join-Path $taskRepo ".tmp\task9-performance-$taskToken"))
if (-not $taskTemp.StartsWith($taskRepo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid task root' }
if (Test-Path -LiteralPath $taskTemp) { throw 'Performance task root already exists' }
$taskGroups = @(
    @{Name='playback'; Profile='playback-media'; Mode='generated-isolated'; Port=5660; Targets='playback-start,gapless-playback'},
    @{Name='library'; Profile='synthetic-large-library'; Mode='preloaded-release'; Port=5520; Targets='idle-memory,all-artists,artist-family,search-all-artists,utility-rules,selected-artist,search-browse,root-album-browse,app-open-all-artists,rules-focused'},
    @{Name='problems'; Profile='utility-problematic-files'; Mode='preloaded-release'; Port=5620; Targets='utility-problematic-files,problematic-files-focused'},
    @{Name='scan'; Profile='scan-library'; Mode='generated-isolated'; Port=5700; Targets='scan-cold,scan-cached,scan-add-album,scan-metadata,scan-page'}
)
if (-not $Run) { $taskGroups | ConvertTo-Json -Depth 4; return }
New-Item -ItemType Directory -Path $taskTemp | Out-Null
$taskResults = @()
foreach ($taskGroup in $taskGroups) {
    $taskProfileCopy = Join-Path $taskTemp ('fixture-' + $taskGroup.Name)
    if ($taskGroup.Mode -eq 'preloaded-release') {
        New-Item -ItemType Directory -Path $taskProfileCopy | Out-Null
        Get-ChildItem -LiteralPath (Join-Path $taskFixture ('profiles\' + $taskGroup.Profile)) -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $taskProfileCopy -Recurse -Force
        }
        Copy-Item -LiteralPath (Join-Path $taskFixture 'manifest.json') -Destination $taskProfileCopy
    }
    $env:ALBUM_HAVEN_FIXTURE_ROOT = $taskProfileCopy
    $env:ALBUM_HAVEN_MEDIA_ROOT = Join-Path $taskProfileCopy 'media' 
    $taskLog = Join-Path $taskRepo ('.codex-restart\task9-performance-' + $taskGroup.Name + '.log')
    $taskEnv = Join-Path $taskTemp ($taskGroup.Name + '.env')
    $taskArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $taskRepo 'scripts\ci\run-performance-shard.ps1'),
        '-Targets',$taskGroup.Targets,'-FixtureProfile',$taskGroup.Profile,'-FixtureMode',$taskGroup.Mode,
        '-BasePort',[string]$taskGroup.Port,'-DatabaseSuffixBase',("settings_perf_" + $taskToken + '_' + $taskGroup.Name),
        '-ExpectedPostgresMajor','18','-PostgresPort','5432','-RepositoryRoot',$taskRepo,
        '-RunnerTemp',$taskTemp,'-GithubEnv',$taskEnv,'-Pgbin','C:\PostgreSQL\18\bin',
        '-PythonPath','C:\Users\Rendref\.cache\album-haven\python-3.11\python.exe','-ShardName',("settings-" + $taskGroup.Name),
        '-Browser','chrome','-PerformanceContract','local')
    @{RunnerPid=$PID; Group=$taskGroup.Name; TempRoot=$taskTemp; Log=$taskLog; Started=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRepo '.codex-restart\task9-performance-active.json')
    Write-Output ($taskGroup.Name + ' started under wrapper PID ' + $PID)
    $taskPreviousErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & powershell.exe @taskArgs *> $taskLog
    $taskCode = $LASTEXITCODE
    $ErrorActionPreference = $taskPreviousErrorPreference
    $taskResults += @{Profile=$taskGroup.Profile; ExitCode=$taskCode; Log=$taskLog}
    $taskResults | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskRepo '.codex-restart\task9-performance-results.json')
    Write-Output ($taskGroup.Name + ' exited ' + $taskCode)
    $taskPorts = $taskGroup.Port..($taskGroup.Port + 86)
    $taskListeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $taskPorts -contains $_.LocalPort })
    if ($taskListeners.Count) { throw 'Owned performance port block still has listeners; continuation paused for exact-tree audit' }
    if ($taskGroup.Name -eq 'playback' -and $taskCode -ne 0 -and
        (Select-String -LiteralPath $taskLog -Pattern 'DuplicateColumn|column .+ already exists' -Quiet)) {
        throw 'Generated playback startup proved a migration prerequisite failure; inventory paused for the authorized minimal harness repair'
    }
}
if (@($taskResults | Where-Object { $_.ExitCode -ne 0 }).Count) { exit 1 }
