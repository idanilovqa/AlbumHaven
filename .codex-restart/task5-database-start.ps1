$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$token = [guid]::NewGuid().ToString('N').Substring(0, 10)
$runRoot = Join-Path ([IO.Path]::GetTempPath()) "album-haven-task5-tests-$token"
New-Item -ItemType Directory -Path $runRoot | Out-Null
$env:PGPASSFILE = 'C:\Users\Rendref\AppData\Roaming\postgresql\pgpass.conf'
foreach ($line in Get-Content -LiteralPath $env:PGPASSFILE) {
  if ($line -match '^localhost:5432:(?:\*|postgres):postgres:(.+)$') {
    $env:POSTGRESQL_ADMIN_PASSWORD = $Matches[1].Replace('\:', ':').Replace('\\', '\')
    break
  }
}
if (-not $env:POSTGRESQL_ADMIN_PASSWORD) { throw 'No configured local Postgres administrator credential' }
$envFile = Join-Path $runRoot 'postgres.env'
$stateFile = Join-Path $runRoot 'postgres.state.json'
$pythonExe = (Get-Command python.exe).Source
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\ci\bootstrap-windows-postgres.ps1') -Mode Provision -ServiceName postgresql-x64-18 -ExpectedMajorVersion 18 -Pgbin 'C:\PostgreSQL\18\bin' -HostName localhost -DatabaseSuffix "settings_loops_${token}_e2e" -RepositoryRoot $repo -RunnerTemp $runRoot -GithubEnv $envFile -StatePath $stateFile -PythonPath $pythonExe -Port 5432 -SkipFixtureLoad | Where-Object { $_ -notmatch '^::add-mask::' }
if ($LASTEXITCODE -ne 0) { throw 'Isolated database provisioning failed' }
Remove-Item Env:POSTGRESQL_ADMIN_PASSWORD

@{runRoot=$runRoot;envPath=$envFile;statePath=$stateFile;databaseSuffix="settings_loops_${token}_e2e"} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repo '.codex-restart/task5-database-session.json')
