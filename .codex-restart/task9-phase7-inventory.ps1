param([switch]$Run, [ValidateSet('auth','admin')][string[]]$Kinds = @('auth','admin'), [ValidatePattern('^$|^FTC-[A-Z0-9-]+$')][string]$CaseId = '', [ValidatePattern('^[a-z0-9-]*$')][string]$LogSuffix = '')
$ErrorActionPreference = 'Stop'
function Invoke-TaskBootstrap([string]$Mode, [hashtable]$Parameters, [string]$LogPath) {
    $taskBootstrapArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$taskBootstrap,'-Mode',$Mode)
    foreach ($taskKey in $Parameters.Keys) { $taskBootstrapArgs += @(('-' + $taskKey), [string]$Parameters[$taskKey]) }
    if ($Mode -eq 'Provision') { $taskBootstrapArgs += '-SkipFixtureLoad' }
    $taskPreviousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & powershell.exe @taskBootstrapArgs *>> $LogPath
    $taskBootstrapCode = $LASTEXITCODE
    $ErrorActionPreference = $taskPreviousPreference
    if ($taskBootstrapCode -ne 0) { throw ('Owned bootstrap failed: ' + $Mode) }
}

if (-not $Run) { Write-Output 'Sequential isolated auth6200-6203 then admin6210-6212'; return }
$taskRepo = (Resolve-Path '.').Path
$taskToken = [guid]::NewGuid().ToString('N').Substring(0,8)
$taskRoot = Join-Path $taskRepo ('.tmp\task9-phase7-' + $taskToken)
New-Item -ItemType Directory -Path $taskRoot | Out-Null
$taskBootstrap = Join-Path $taskRepo 'scripts\ci\bootstrap-windows-postgres.ps1'
foreach ($taskLine in (Get-Content -LiteralPath (Join-Path $env:APPDATA 'postgresql\pgpass.conf'))) {
    if ($taskLine -match '^localhost:5432:(?:\*|postgres):postgres:(.+)$') {
        $env:POSTGRESQL_ADMIN_PASSWORD = $Matches[1].Replace('\:', ':').Replace('\\', '\')
        break
    }
}
if (-not $env:POSTGRESQL_ADMIN_PASSWORD) { throw 'Protected admin credential unavailable' }
$env:PLAYWRIGHT_CHROME_EXECUTABLE = 'C:\Users\Rendref\.cache\album-haven\chrome-for-testing-151.0.7922.138\chrome.exe'
$env:PLAYWRIGHT_BROWSER = 'chrome'
$env:PLAYWRIGHT_PYTHON = 'C:\Users\Rendref\.cache\album-haven\python-3.11\python.exe'
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
$env:ALBUM_HAVEN_APPROVED_COVER_ROOT = 'C:\Repositories\album-haven-test-data-gallery-refactor\dist\profiles\utility-problematic-files\media\covers\approved'
$taskResults = @()
foreach ($taskKind in $Kinds) {
    $taskTemp = Join-Path $taskRoot $taskKind
    New-Item -ItemType Directory -Path $taskTemp | Out-Null
    $taskState = Join-Path $taskTemp 'postgres.state.json'
    $taskEnv = Join-Path $taskTemp 'postgres.env'
    $taskLog = Join-Path $taskRepo ('.codex-restart\task9-phase7-' + $taskKind + $LogSuffix + '.log')
    $taskArgs = @{ServiceName='postgresql-x64-18'; ExpectedMajorVersion='18'; Pgbin='C:\PostgreSQL\18\bin'; HostName='127.0.0.1'; Port=5432; DatabaseSuffix=('settings_p7' + $taskKind + '_' + $taskToken); RepositoryRoot=$taskRepo; RunnerTemp=$taskTemp; GithubEnv=$taskEnv; StatePath=$taskState; PythonPath=$env:PLAYWRIGHT_PYTHON; AppPrivilegeMode='Inherited'}
    $taskCode = 1
    $taskOwned = @{}
    $taskPreflight = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 6200 -and $_.LocalPort -le 6212 })
    if ($taskPreflight.Count) { throw 'Phase7 preflight ports occupied; no process displaced' }
    try {
        Invoke-TaskBootstrap 'Provision' $taskArgs $taskLog
        foreach ($taskEntry in (Get-Content -LiteralPath $taskEnv)) {
            $taskSeparator = $taskEntry.IndexOf('=')
            if ($taskSeparator -gt 0) { [Environment]::SetEnvironmentVariable($taskEntry.Substring(0,$taskSeparator),$taskEntry.Substring($taskSeparator+1),'Process') }
        }
        $env:PGPASSWORD = $null
        $env:ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL = $env:DATABASE_MIGRATOR_URL
        $env:ALBUM_HAVEN_FAKE_E2E_DATABASE_URL = $env:DATABASE_APP_URL
        $taskPort = if ($taskKind -eq 'auth') { 6200 } else { 6210 }
        $taskPrefix = 'PHASE7_' + $taskKind.ToUpper()
        [Environment]::SetEnvironmentVariable($taskPrefix + '_PORT',[string]$taskPort,'Process')
        [Environment]::SetEnvironmentVariable($taskPrefix + '_SMTP_PORT',[string]($taskPort+1),'Process')
        [Environment]::SetEnvironmentVariable($taskPrefix + '_CONTROL_PORT',[string]($taskPort+2),'Process')
        if ($taskKind -eq 'auth') { $env:PHASE7_AUTH_WORKER_PORT = '6203' }
        @{RunnerPid=$PID; Kind=$taskKind; State=$taskState; Port=$taskPort} | ConvertTo-Json | Set-Content .codex-restart/task9-phase7-active.json
        $taskStdout = $taskLog + '.stdout'
        $taskStderr = $taskLog + '.stderr'
        $taskNodeArguments = @((Join-Path $taskRepo 'node_modules\@playwright\test\cli.js'),'test',('--config=playwright.phase7-' + $taskKind + '.config.js'))
        if ($CaseId) { $taskNodeArguments += @('--grep', $CaseId) }
        $taskNode = Start-Process -FilePath (Get-Command node).Source -ArgumentList $taskNodeArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $taskStdout -RedirectStandardError $taskStderr
        $taskTrackedIds = @($taskNode.Id)
        do {
            $taskProcesses = @(Get-CimInstance Win32_Process)
            do {
                $taskNew = @($taskProcesses | Where-Object { $taskTrackedIds -contains $_.ParentProcessId -and $taskTrackedIds -notcontains $_.ProcessId } | ForEach-Object ProcessId)
                $taskTrackedIds += $taskNew
            } while ($taskNew.Count)
            foreach ($taskProcess in ($taskProcesses | Where-Object { $taskTrackedIds -contains $_.ProcessId })) {
                $taskOwned[[string]$taskProcess.ProcessId] = $taskProcess.CreationDate
            }
        } while (-not $taskNode.WaitForExit(1000))
        $taskNode.WaitForExit()
        $taskCode = $taskNode.ExitCode
        Get-Content -LiteralPath $taskStdout,$taskStderr | Add-Content -LiteralPath $taskLog
    } finally {
        $taskRemaining = @(Get-CimInstance Win32_Process | Where-Object { $taskOwned.ContainsKey([string]$_.ProcessId) -and $taskOwned[[string]$_.ProcessId] -eq $_.CreationDate })
        $taskAuditListeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 6200 -and $_.LocalPort -le 6212 })
        @{Processes=$taskRemaining | Select-Object ProcessId,ParentProcessId,Name; Ports=$taskAuditListeners | Select-Object LocalPort,OwningProcess} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $taskRepo ('.codex-restart\task9-phase7-' + $taskKind + $LogSuffix + '-cleanup.json'))
        if ($taskRemaining.Count -or $taskAuditListeners.Count) { throw 'Phase7 exact owned resources remain; teardown and continuation paused' }
        Invoke-TaskBootstrap 'Teardown' $taskArgs $taskLog
    }
    $taskResults += @{Suite=$taskKind; ExitCode=$taskCode; Log=$taskLog}
    $taskResults | ConvertTo-Json | Set-Content (Join-Path $taskRepo ('.codex-restart/task9-phase7-results' + $LogSuffix + '.json'))
    Write-Output ($taskKind + ' exited ' + $taskCode)
    $taskListeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 6200 -and $_.LocalPort -le 6212 })
    if ($taskListeners.Count) { throw 'Phase7 scoped ports not clear; audit required' }
}
