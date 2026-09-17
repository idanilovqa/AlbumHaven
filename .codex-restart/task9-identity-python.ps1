param([Parameter(Mandatory=$true)][ValidateSet('red','green','related')][string]$Phase)
$ErrorActionPreference='Stop'
$taskRepo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $taskRepo
if ((git branch --show-current) -ne '2026-09-08-settings-refactor') { throw 'Expected Settings branch.' }
$taskPython='C:/Users/Rendref/.cache/album-haven/python-3.11/python.exe'
$taskRoot=Join-Path $env:TEMP ('album-haven-identity-python-' + [guid]::NewGuid().ToString('N').Substring(0,10))
New-Item -ItemType Directory -Path $taskRoot | Out-Null
foreach($taskLine in Get-Content -LiteralPath (Join-Path $env:APPDATA 'postgresql/pgpass.conf')) {
  if($taskLine -match '^localhost:5432:(?:\*|postgres):postgres:(.+)$') {
    $env:POSTGRESQL_ADMIN_PASSWORD=$Matches[1].Replace('\:',':').Replace('\\','\'); break
  }
}
if(-not $env:POSTGRESQL_ADMIN_PASSWORD){throw 'Protected administrator credential unavailable.'}
$taskBootstrap=Join-Path $taskRepo 'scripts/ci/bootstrap-windows-postgres.ps1'
$taskParameters=@{ServiceName='postgresql-x64-18';ExpectedMajorVersion='18';Pgbin='C:/PostgreSQL/18/bin';HostName='127.0.0.1';Port=5432;DatabaseSuffix=('identity_' + [guid]::NewGuid().ToString('N').Substring(0,8));RepositoryRoot=$taskRepo;RunnerTemp=$taskRoot;GithubEnv=(Join-Path $taskRoot 'postgres.env');StatePath=(Join-Path $taskRoot 'postgres.state.json');PythonPath=$taskPython;AppPrivilegeMode='Inherited'}
$taskCode=1
function Invoke-IdentityBootstrap([string]$Mode) {
  $taskArgs=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$taskBootstrap,'-Mode',$Mode)
  foreach($taskKey in $taskParameters.Keys){$taskArgs+=@('-'+$taskKey,[string]$taskParameters[$taskKey])}
  if($Mode -eq 'Provision'){$taskArgs+='-SkipFixtureLoad'}
  $taskChild=Start-Process powershell.exe -ArgumentList $taskArgs -WindowStyle Hidden -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $taskRoot "$Mode.stdout.log") `
    -RedirectStandardError (Join-Path $taskRoot "$Mode.stderr.log")
  if($taskChild.ExitCode -ne 0){throw "Isolated identity database $Mode failed."}
}
try {
  Invoke-IdentityBootstrap 'Provision'
  foreach($taskLine in Get-Content -LiteralPath $taskParameters.GithubEnv){
    $taskParts=$taskLine.Split('=',2)
    if($taskParts.Count -eq 2){[Environment]::SetEnvironmentVariable($taskParts[0],$taskParts[1],'Process')}
  }
  $env:ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL=$env:DATABASE_MIGRATOR_URL
  $env:ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL=$env:DATABASE_APP_URL
  $taskPytestArgs=@('-m','pytest','tests/py/test_postgres_structural_tag_edit.py','-q')
  if($Phase -ne 'related'){$taskPytestArgs+=@('-k','explicit_separate_release_consolidates_same_year_identity')}
  & $taskPython @taskPytestArgs *> (Join-Path $PSScriptRoot "task9-identity-python-$Phase.log")
  $taskCode=$LASTEXITCODE
} finally {
  if(Test-Path -LiteralPath $taskParameters.StatePath){
    Invoke-IdentityBootstrap 'Teardown'
    if(Test-Path -LiteralPath $taskParameters.GithubEnv){Remove-Item -LiteralPath $taskParameters.GithubEnv}
  }
  @{phase=$Phase;exitCode=$taskCode;pid=$PID;evidenceRoot=$taskRoot;finished=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot "task9-identity-python-$Phase-$PID-result.json")
}
exit $taskCode
