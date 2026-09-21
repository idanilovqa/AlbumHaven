$ErrorActionPreference = 'Stop'
$taskRepo = (Resolve-Path -LiteralPath '.').Path
$taskToken = [guid]::NewGuid().ToString('N').Substring(0,8)
$taskTemp = Join-Path $taskRepo ('.tmp\task9-scan-metadata-repair-' + $taskToken)
$taskLog = Join-Path $taskRepo '.codex-restart\task9-scan-metadata-repair.log'
$taskPort = 5760
if (@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge $taskPort -and $_.LocalPort -le ($taskPort + 24) }).Count) { throw 'Focused scan ports are occupied' }
foreach ($taskLine in (Get-Content -LiteralPath (Join-Path $env:APPDATA 'postgresql\pgpass.conf'))) {
    if ($taskLine -match '^localhost:5432:(?:\*|postgres):postgres:(.+)$') {
        $env:POSTGRESQL_ADMIN_PASSWORD = $Matches[1].Replace('\:', ':').Replace('\\', '\')
        break
    }
}
if (-not $env:POSTGRESQL_ADMIN_PASSWORD) { throw 'Postgres setup credential unavailable' }
$env:PLAYWRIGHT_CHROME_EXECUTABLE = 'C:\Users\Rendref\.cache\album-haven\chrome-for-testing-151.0.7922.138\chrome.exe'
$env:ALBUM_HAVEN_APPROVED_COVER_ROOT = 'C:\Repositories\album-haven-test-data-gallery-refactor\dist\profiles\utility-problematic-files\media\covers\approved'
New-Item -ItemType Directory -Path $taskTemp | Out-Null
$taskArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $taskRepo 'scripts\ci\run-performance-shard.ps1'),
    '-Targets','scan-metadata','-FixtureProfile','scan-library','-FixtureMode','generated-isolated',
    '-BasePort',[string]$taskPort,'-DatabaseSuffixBase',('settings_scanfix_' + $taskToken),
    '-ExpectedPostgresMajor','18','-PostgresPort','5432','-RepositoryRoot',$taskRepo,
    '-RunnerTemp',$taskTemp,'-GithubEnv',(Join-Path $taskTemp 'scan.env'),'-Pgbin','C:\PostgreSQL\18\bin',
    '-PythonPath','C:\Users\Rendref\.cache\album-haven\python-3.11\python.exe','-ShardName','settings-scan-focused',
    '-Browser','chrome','-PerformanceContract','local')
@{ RunnerPid=$PID; Started=[DateTime]::UtcNow.ToString('o'); TempRoot=$taskTemp; Log=$taskLog; Ports=@($taskPort..($taskPort+24)) } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskRepo '.codex-restart\task9-scan-metadata-repair-active.json')
$ErrorActionPreference = 'Continue'
& powershell.exe @taskArgs *> $taskLog
$taskExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
@{ ExitCode=$taskExit; Finished=[DateTime]::UtcNow.ToString('o'); TempRoot=$taskTemp; Log=$taskLog } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRepo '.codex-restart\task9-scan-metadata-repair-result.json')
Write-Output ('Focused scan targets exited ' + $taskExit)
exit $taskExit

