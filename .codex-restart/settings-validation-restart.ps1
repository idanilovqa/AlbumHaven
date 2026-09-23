param([int]$Port = 0)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sessionPath = Join-Path $PSScriptRoot 'settings-validation-session.json'
$session = Get-Content -Raw -LiteralPath $sessionPath | ConvertFrom-Json
$previousPort = [int]$session.port
if ($Port -eq 0) { $Port = $previousPort }
if ($Port -lt 1024 -or $Port -gt 65533) { throw 'Invalid validation port' }
$providerPort = $Port + 2
if ($Port -ne $previousPort -and (Get-NetTCPConnection -State Listen -LocalPort $Port,$providerPort -ErrorAction SilentlyContinue)) { throw 'Requested ports are occupied' }
$owned = Get-CimInstance Win32_Process -Filter "ProcessId = $($session.serverPid)"
if ($owned) {
  if ($owned.CommandLine -notmatch ("isolatedLibraryApp.py.+--port\s+" + $previousPort + "(?:\s|$)")) { throw 'Owned PID identity mismatch' }
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($session.serverPid)")
  if (@($children | Where-Object Name -ne 'conhost.exe').Count) { $children | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json; throw 'Inspect owned descendants before restart' }
  Stop-Process -Id $session.serverPid
  Wait-Process -Id $session.serverPid -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Wait-Process -Id $child.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    if (Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue) { throw 'Owned console host has not exited' }
  }
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port,$providerPort -ErrorAction SilentlyContinue) { throw 'Validation ports still occupied' }
foreach ($line in Get-Content -LiteralPath $session.envPath) {
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) { [Environment]::SetEnvironmentVariable($line.Substring(0,$separator),$line.Substring($separator+1),'Process') }
}
$env:ALBUM_HAVEN_FIXTURE_PROFILE = 'functional-core'
$env:ALBUM_HAVEN_FIXTURE_ROOT = $session.fixtureRoot
$env:ALBUM_HAVEN_MEDIA_ROOT = Join-Path $session.fixtureRoot 'media'
$env:ALBUM_HAVEN_E2E_TEMP_ROOT = Join-Path $session.runRoot 'album-haven-e2e-settings'
$env:ALBUM_HAVEN_E2E_PRESERVE_ON_SHUTDOWN = '1'
$env:ALBUM_HAVEN_E2E_REUSE_STATE = '1'
$env:ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL = $env:DATABASE_MIGRATOR_URL
$env:ALBUM_HAVEN_FAKE_E2E_DATABASE_URL = $env:DATABASE_APP_URL
$env:ALBUM_HAVEN_APP_DATABASE_URL = $env:DATABASE_APP_URL
$browseBase = Join-Path $session.runRoot 'settings-browse'
foreach ($folderName in @('main-a','main-b','hoard','incoming')) {
  New-Item -ItemType Directory -Path (Join-Path $browseBase $folderName) -Force | Out-Null
}
$env:ALBUM_HAVEN_LIBRARY_BROWSE_BASES = ConvertTo-Json -InputObject @($browseBase) -Compress
$env:PLAYWRIGHT_PROVIDER_PORT = [string]$providerPort
$env:ALBUM_HAVEN_FAKE_E2E_PROVIDER_BASE_URL = "http://127.0.0.1:$providerPort"
foreach ($name in @('MUSIC_DIR','MUSIC_APP_DATA_DIR','MUSIC_CACHE_PATH','MUSIC_COVER_CACHE_PATH','MUSIC_LIBRARY_ROOTS_PATH','PLAYWRIGHT_REAL_APP_URL')) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
$stamp = Get-Date -Format yyyyMMdd-HHmmss
$stdout = Join-Path $session.runRoot "server-$stamp.stdout.log"
$stderr = Join-Path $session.runRoot "server-$stamp.stderr.log"
$server = Start-Process -FilePath $session.python -ArgumentList @('tests/e2e/support/isolatedLibraryApp.py','--port',[string]$Port,'--provider-port',[string]$providerPort) -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$session.serverPid = $server.Id
$session.port = $Port
$session | Add-Member -NotePropertyName stdout -NotePropertyValue $stdout -Force
$session | Add-Member -NotePropertyName stderr -NotePropertyValue $stderr -Force
$session | ConvertTo-Json | Set-Content -LiteralPath $sessionPath
$session | Select-Object serverPid,port,stdout,stderr | ConvertTo-Json -Compress
