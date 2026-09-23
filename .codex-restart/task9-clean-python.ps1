param(
    [Parameter(Mandatory=$true)][string]$RepositoryRoot,
    [Parameter(Mandatory=$true)][string]$EvidenceRoot,
    [switch]$Run
)
$ErrorActionPreference = 'Stop'
if (-not $Run) { Write-Output 'Prepared only. Requires an owned clean checkout, exclusive test slot, and -Run.'; return }
$taskRepo = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$taskEvidence = [IO.Path]::GetFullPath($EvidenceRoot)
if ($taskEvidence.StartsWith($taskRepo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must be outside the clean checkout.' }
if (Test-Path -LiteralPath $taskEvidence) { throw 'Choose a new uniquely owned evidence directory.' }
Set-Location -LiteralPath $taskRepo
if (@(& git status --porcelain).Count) { throw 'Final verification requires a clean committed checkout.' }
$taskHead = (& git rev-parse HEAD).Trim()
New-Item -ItemType Directory -Path $taskEvidence | Out-Null
$taskPython = 'C:\Users\Rendref\.cache\album-haven\python-3.11\python.exe'
$taskNodeBin = 'C:\Program Files\nodejs'
if ((& (Join-Path $taskNodeBin 'node.exe') --version) -ne 'v22.22.2') { throw 'Pinned Node 22.22.2 is required.' }
$env:PATH = (Split-Path $taskPython) + ';' + $taskNodeBin + ';' + $env:PATH
$env:PLAYWRIGHT_PYTHON = $taskPython
$env:PLAYWRIGHT_CHROME_EXECUTABLE = 'C:\Users\Rendref\.cache\album-haven\chrome-for-testing-151.0.7922.138\chrome.exe'
$env:ALBUM_HAVEN_APPROVED_COVER_ROOT = 'C:\Repositories\album-haven-test-data-gallery-refactor\dist\profiles\utility-problematic-files\media\covers\approved'
$env:PGPASSWORD = $null
$env:ALBUM_HAVEN_PYTEST_TIMEOUT_SECONDS = '600'
foreach ($taskLine in (Get-Content -LiteralPath (Join-Path $env:APPDATA 'postgresql\pgpass.conf'))) {
    if ($taskLine -match '^localhost:5432:(?:\*|postgres):postgres:(.+)$') {
        $env:POSTGRESQL_ADMIN_PASSWORD = $Matches[1].Replace('\:', ':').Replace('\\', '\')
        break
    }
}
if (-not $env:POSTGRESQL_ADMIN_PASSWORD) { throw 'Protected local administrator credential unavailable.' }
$taskBootstrap = Join-Path $taskRepo 'scripts\ci\bootstrap-windows-postgres.ps1'
$taskToken = [guid]::NewGuid().ToString('N').Substring(0,8)
$taskContexts = @{}
$taskTracked = @{}
$taskCode = 1
function Invoke-OwnedBootstrap($mode, $parameters, $log) {
    $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$taskBootstrap,'-Mode',$mode)
    foreach ($key in $parameters.Keys) { $arguments += @('-' + $key, [string]$parameters[$key]) }
    if ($mode -eq 'Provision') { $arguments += '-SkipFixtureLoad' }
    & powershell.exe @arguments *> $log
    if ($LASTEXITCODE -ne 0) { throw "Owned database $mode failed; inspect protected evidence." }
}
try {
    foreach ($taskKind in @('destructive','contract')) {
        $taskDir = Join-Path $taskEvidence $taskKind
        New-Item -ItemType Directory -Path $taskDir | Out-Null
        $taskParameters = @{ServiceName='postgresql-x64-18';ExpectedMajorVersion='18';Pgbin='C:\PostgreSQL\18\bin';HostName='127.0.0.1';Port=5432;DatabaseSuffix=('settings_final_' + $taskToken + '_' + $taskKind);RepositoryRoot=$taskRepo;RunnerTemp=$taskDir;GithubEnv=(Join-Path $taskDir 'postgres.env');StatePath=(Join-Path $taskDir 'postgres.state.json');PythonPath=$taskPython;AppPrivilegeMode='Inherited'}
        $taskContexts[$taskKind] = @{Parameters=$taskParameters;Values=@{}}
        Invoke-OwnedBootstrap 'Provision' $taskParameters (Join-Path $taskDir 'provision.log')
        foreach ($line in Get-Content -LiteralPath $taskParameters.GithubEnv) {
            $separator = $line.IndexOf('=')
            if ($separator -gt 0) { $taskContexts[$taskKind].Values[$line.Substring(0,$separator)] = $line.Substring($separator+1) }
        }
    }
    foreach ($pair in $taskContexts.contract.Values.GetEnumerator()) { [Environment]::SetEnvironmentVariable($pair.Key,$pair.Value,'Process') }
    $taskPgpass = Join-Path $taskEvidence 'combined.pgpass'
    [IO.File]::WriteAllLines($taskPgpass,@((Get-Content -LiteralPath $taskContexts.destructive.Values.PGPASSFILE)+(Get-Content -LiteralPath $taskContexts.contract.Values.PGPASSFILE)),[Text.UTF8Encoding]::new($false))
    $env:PGPASSFILE = $taskPgpass
    $env:ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL = $taskContexts.destructive.Values.DATABASE_MIGRATOR_URL
    $env:ALBUM_HAVEN_FAKE_E2E_DATABASE_URL = $taskContexts.destructive.Values.DATABASE_APP_URL
    $env:ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL = $env:ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL
    $env:ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL = $env:ALBUM_HAVEN_FAKE_E2E_DATABASE_URL
    $env:ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL = $env:DATABASE_APP_URL
    $taskJunit = Join-Path $taskEvidence 'pytest-results.xml'
    $taskArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + (Join-Path $taskRepo 'scripts\test.ps1') + '"'),'-q',('"--junitxml=' + $taskJunit + '"'))
    $taskProcess = Start-Process powershell.exe -ArgumentList $taskArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskEvidence 'pytest.stdout.log') -RedirectStandardError (Join-Path $taskEvidence 'pytest.stderr.log')
    $null = $taskProcess.Handle
    $taskIds = @($taskProcess.Id)
    do {
        $taskProcesses = @(Get-CimInstance Win32_Process)
        do {
            $taskNew = @($taskProcesses | Where-Object { $_.ParentProcessId -in $taskIds -and $_.ProcessId -notin $taskIds } | ForEach-Object ProcessId)
            $taskIds += $taskNew
        } while ($taskNew.Count)
        foreach ($entry in $taskProcesses | Where-Object ProcessId -in $taskIds) { $taskTracked[[string]$entry.ProcessId] = $entry.CreationDate }
        @{head=$taskHead;wrapper=$PID;owned=$taskTracked;updated=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $taskEvidence 'active.json')
        if (-not $taskProcess.WaitForExit(30000)) {
            Write-Output ('Python suite active: ' + [DateTime]::UtcNow.ToString('o'))
        }
    } while (-not $taskProcess.HasExited)
    $taskProcess.WaitForExit()
    $taskCode = $taskProcess.ExitCode
    if (Test-Path -LiteralPath $taskJunit) {
        & node scripts/ci/validate-foundation-gates.cjs ('--pytest-junit=' + $taskJunit) --allowed-skips=tests/ci/pytest-allowed-skips.json *> (Join-Path $taskEvidence 'skip-policy.log')
        if ($LASTEXITCODE -ne 0 -and $taskCode -eq 0) { $taskCode = $LASTEXITCODE }
    }
} finally {
    $taskRemaining = @(Get-CimInstance Win32_Process | Where-Object { $taskTracked.ContainsKey([string]$_.ProcessId) -and $_.CreationDate -eq $taskTracked[[string]$_.ProcessId] })
    @{remaining=@($taskRemaining | Select-Object ProcessId,ParentProcessId,Name);head=$taskHead;finished=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $taskEvidence 'cleanup.json')
    if ($taskRemaining.Count) { throw 'Owned descendants remain: preserve databases and inspect exact tree before teardown or rerun.' }
    foreach ($taskKind in @('contract','destructive')) {
        if ($taskContexts.ContainsKey($taskKind) -and (Test-Path -LiteralPath $taskContexts[$taskKind].Parameters.StatePath)) {
            Invoke-OwnedBootstrap 'Teardown' $taskContexts[$taskKind].Parameters (Join-Path $taskEvidence ($taskKind + '-teardown.log'))
        }
    }
    if ($taskPgpass -and (Test-Path -LiteralPath $taskPgpass)) { Remove-Item -LiteralPath $taskPgpass }
    if ((& git rev-parse HEAD).Trim() -ne $taskHead -or @(& git status --porcelain).Count) { throw 'Clean checkout changed during verification.' }
}
exit $taskCode
