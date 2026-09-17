$ErrorActionPreference='Stop'
. "$PSScriptRoot\task9-phase7-inventory.ps1"
$taskRepo=(Resolve-Path '.').Path
$taskBootstrap=Join-Path $taskRepo 'scripts\ci\bootstrap-windows-postgres.ps1'
$taskToken=[guid]::NewGuid().ToString('N').Substring(0,8)
$taskRoot=Join-Path $taskRepo ('.tmp\task9-repair-pg-' + $taskToken)
New-Item -ItemType Directory -Path $taskRoot | Out-Null
foreach ($taskLine in (Get-Content (Join-Path $env:APPDATA 'postgresql\pgpass.conf'))) {
 if ($taskLine -match '^localhost:5432:(?:\*|postgres):postgres:(.+)$') { $env:POSTGRESQL_ADMIN_PASSWORD=$Matches[1].Replace('\:',':').Replace('\\','\'); break }
}
$taskContexts=@{}
foreach ($taskKind in @('destructive','contract')) {
 $taskTemp=Join-Path $taskRoot $taskKind
 New-Item -ItemType Directory -Path $taskTemp | Out-Null
 $taskArgs=@{ServiceName='postgresql-x64-18';ExpectedMajorVersion='18';Pgbin='C:\PostgreSQL\18\bin';HostName='127.0.0.1';Port=5432;DatabaseSuffix=('settings_repair_' + $taskToken + '_' + $taskKind);RepositoryRoot=$taskRepo;RunnerTemp=$taskTemp;GithubEnv=(Join-Path $taskTemp 'postgres.env');StatePath=(Join-Path $taskTemp 'postgres.state.json');PythonPath='C:\Users\Rendref\.cache\album-haven\python-3.11\python.exe';AppPrivilegeMode='Inherited'}
 Invoke-TaskBootstrap 'Provision' $taskArgs (Join-Path $taskTemp 'bootstrap.log')
 $taskValues=@{}
 foreach ($taskLine in (Get-Content -LiteralPath $taskArgs.GithubEnv)) { $taskEq=$taskLine.IndexOf('='); if ($taskEq -gt 0) { $taskValues[$taskLine.Substring(0,$taskEq)]=$taskLine.Substring($taskEq+1) } }
 $taskContexts[$taskKind]=@{Parameters=$taskArgs;Values=$taskValues}
}
$taskCombined=Join-Path $taskRoot 'combined.pgpass'
[IO.File]::WriteAllLines($taskCombined,@((Get-Content -LiteralPath $taskContexts.destructive.Values.PGPASSFILE)+(Get-Content -LiteralPath $taskContexts.contract.Values.PGPASSFILE)),(New-Object Text.UTF8Encoding($false)))
$taskEnv=@{} + $taskContexts.contract.Values
$taskEnv.PGPASSFILE=$taskCombined
$taskEnv.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL=$taskContexts.destructive.Values.DATABASE_MIGRATOR_URL
$taskEnv.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL=$taskContexts.destructive.Values.DATABASE_APP_URL
$taskEnv.ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL=$taskContexts.destructive.Values.DATABASE_MIGRATOR_URL
$taskEnv.ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL=$taskContexts.destructive.Values.DATABASE_APP_URL
$taskEnv.ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL=$taskContexts.contract.Values.DATABASE_APP_URL
$taskEnvPath=Join-Path $taskRoot 'combined.env'
$taskEnv.GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value } | Set-Content -LiteralPath $taskEnvPath
@{envPath=$taskEnvPath;root=$taskRoot;contexts=$taskContexts} | ConvertTo-Json -Depth 6 | Set-Content .codex-restart/task9-repair-databases.json
Write-Output 'Two isolated databases provisioned; scoped environment saved.'
