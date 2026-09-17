$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$token = [guid]::NewGuid().ToString('N').Substring(0, 10)
$runRoot = Join-Path ([IO.Path]::GetTempPath()) "album-haven-functional-local-settings-$token"
New-Item -ItemType Directory -Path $runRoot | Out-Null
$fixtureRoot = Join-Path $runRoot 'fixture'
$distribution = 'C:\Repositories\album-haven-test-data-gallery-refactor\dist'
$manifest = Get-Content -Raw (Join-Path $distribution 'manifest.json') | ConvertFrom-Json
if ($manifest.release -ne 'fixtures-v1.0.19') { throw 'Unexpected fixture release' }
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
Get-ChildItem -LiteralPath (Join-Path $distribution 'profiles\functional-core') -Force | Copy-Item -Destination $fixtureRoot -Recurse
Copy-Item -LiteralPath (Join-Path $distribution 'manifest.json') -Destination $fixtureRoot
Write-Output 'Copied isolated functional fixture.'
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
& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\ci\bootstrap-windows-postgres.ps1') -Mode Provision -ServiceName postgresql-x64-18 -ExpectedMajorVersion 18 -Pgbin 'C:\PostgreSQL\18\bin' -HostName localhost -DatabaseSuffix "local_settings_$token" -RepositoryRoot $repo -RunnerTemp $runRoot -GithubEnv $envFile -StatePath $stateFile -PythonPath $pythonExe -Port 5432 -SkipFixtureLoad | Where-Object { $_ -notmatch '^::add-mask::' }
if ($LASTEXITCODE -ne 0) { throw 'Isolated database provisioning failed' }
Remove-Item Env:POSTGRESQL_ADMIN_PASSWORD
foreach ($line in Get-Content -LiteralPath $envFile) {
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) { [Environment]::SetEnvironmentVariable($line.Substring(0,$separator),$line.Substring($separator+1),'Process') }
}
$env:ALBUM_HAVEN_FIXTURE_PROFILE = 'functional-core'
$env:ALBUM_HAVEN_FIXTURE_ROOT = $fixtureRoot
$env:ALBUM_HAVEN_MEDIA_ROOT = Join-Path $fixtureRoot 'media'
$env:ALBUM_HAVEN_E2E_TEMP_ROOT = Join-Path $runRoot 'album-haven-e2e-settings'
$env:ALBUM_HAVEN_E2E_PRESERVE_ON_SHUTDOWN = '1'
$env:ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL = $env:DATABASE_MIGRATOR_URL
$env:ALBUM_HAVEN_FAKE_E2E_DATABASE_URL = $env:DATABASE_APP_URL
$env:ALBUM_HAVEN_APP_DATABASE_URL = $env:DATABASE_APP_URL
$env:PLAYWRIGHT_PROVIDER_PORT = '5415'
$env:ALBUM_HAVEN_FAKE_E2E_PROVIDER_BASE_URL = 'http://127.0.0.1:5415'
foreach ($name in @('MUSIC_DIR','MUSIC_APP_DATA_DIR','MUSIC_CACHE_PATH','MUSIC_COVER_CACHE_PATH','MUSIC_LIBRARY_ROOTS_PATH','PLAYWRIGHT_REAL_APP_URL')) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
& $pythonExe (Join-Path $repo 'scripts\ci\load-fixture-profile.py') --fixture-root $fixtureRoot --profile functional-core --database-url $env:DATABASE_MIGRATOR_URL --replace-existing
if ($LASTEXITCODE -ne 0) { throw 'Fixture database load failed' }
if (Get-NetTCPConnection -State Listen -LocalPort 5413,5415 -ErrorAction SilentlyContinue) { throw 'Validation ports occupied' }
$server = Start-Process -FilePath $pythonExe -ArgumentList @('tests/e2e/support/isolatedLibraryApp.py','--port','5413','--provider-port','5415') -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runRoot 'server.stdout.log') -RedirectStandardError (Join-Path $runRoot 'server.stderr.log') -PassThru
$record = @{runRoot=$runRoot;fixtureRoot=$fixtureRoot;serverPid=$server.Id;port=5413;providerPort=5415;databaseSuffix="local_settings_$token";statePath=$stateFile;envPath=$envFile;python=$pythonExe}
$record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repo '.codex-restart\settings-validation-session.json')
$record | Select-Object runRoot,serverPid,port,providerPort | ConvertTo-Json -Compress
