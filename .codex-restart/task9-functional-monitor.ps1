param([ValidateSet('native','export','integration-roots','integration-help','appearance-touch','loop-journey','all','component')][string]$Phase)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$env:PLAYWRIGHT_CHROME_EXECUTABLE = 'C:\Users\Rendref\.cache\album-haven\chrome-for-testing-151.0.7922.138\chrome.exe'
$env:PLAYWRIGHT_PYTHON = 'C:\Users\Rendref\.cache\album-haven\python-3.11\python.exe'
$env:PGPASSFILE = 'C:\Users\Rendref\AppData\Roaming\postgresql\pgpass.conf'
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repository
$runner = Join-Path $repository 'scripts/run-functional-e2e-local.ps1'
$distribution = 'C:/Repositories/album-haven-test-data-gallery-refactor/dist'
$resultPath = Join-Path $PSScriptRoot "task9-functional-$Phase-result.json"
$started = [DateTime]::UtcNow.ToString('o')
$resultCode = 1
try {
  if ($Phase -eq 'native') {
    & $runner -FixtureDistribution $distribution -Case 'FTC-SETTINGS-L02 native panel drag persists order while another loop retains playback and its pending range'
  } elseif ($Phase -eq 'export') {
    & $runner -FixtureDistribution $distribution -Case 'FTC-SETTINGS-H03 real log download matches the displayed captured snapshot'
  } elseif ($Phase -eq 'integration-roots') {
    & $runner -FixtureDistribution $distribution -Case 'FTC-SETTINGS-I01 real folder picking preserves Cancel and validates saved root membership'
  } elseif ($Phase -eq 'integration-help') {
    & $runner -FixtureDistribution $distribution -Case 'FTC-SETTINGS-I02 Scrobbling statistics and readable Foobar help retain disabled playlist import'
  } elseif ($Phase -eq 'appearance-touch') {
    & $runner -FixtureDistribution $distribution -Case 'FTC-SETTINGS-A01 shared search preserves the staged loop style and Save hydrates it before Settings opens'
  } elseif ($Phase -eq 'loop-journey') {
    & $runner -FixtureDistribution $distribution -Case 'FTC-UTIL-LOOPS-021 / FTC-UTIL-LOOPS-023 / FTC-UTIL-LOOPS-024 / FTC-UTIL-LOOPS-026 / FTC-PLAYER-017 / FTC-PLAYER-011 fake-data bottom-player loop save and Utility Loops playback stay grouped under one track'
  } elseif ($Phase -eq 'component') {
    & 'C:/Program Files/nodejs/node.exe' (Join-Path $repository 'node_modules/@playwright/test/cli.js') test --config=playwright.component.config.js
  } else {
    & $runner -FixtureDistribution $distribution -All
  }
  $resultCode = $LASTEXITCODE
} catch {
  Write-Error $_ -ErrorAction Continue
} finally {
  @{phase=$Phase;pid=$PID;started=$started;finished=[DateTime]::UtcNow.ToString('o');exitCode=$resultCode} | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
}
exit $resultCode
