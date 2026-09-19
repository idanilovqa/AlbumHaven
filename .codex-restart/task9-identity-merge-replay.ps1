param([string]$RunLabel = 'identity-merge-replay-1')
$ErrorActionPreference = 'Stop'
if ($RunLabel -notmatch '^[a-z0-9-]+$') { throw 'Invalid replay label.' }
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repository
if ((git branch --show-current) -ne '2026-09-08-settings-refactor') { throw 'Expected Settings branch.' }
$env:PLAYWRIGHT_CHROME_EXECUTABLE = 'C:/Users/Rendref/.cache/album-haven/chrome-for-testing-151.0.7922.138/chrome.exe'
$env:PLAYWRIGHT_PYTHON = 'C:/Users/Rendref/.cache/album-haven/python-3.11/python.exe'
$env:PGPASSFILE = 'C:/Users/Rendref/AppData/Roaming/postgresql/pgpass.conf'
$env:PATH = 'C:/Program Files/nodejs;C:/PostgreSQL/18/bin;' + $env:PATH
$resultPath = Join-Path $PSScriptRoot "task9-$RunLabel-result.json"
if (Test-Path -LiteralPath $resultPath) { throw 'Replay result exists; choose a fresh label.' }
$started = [DateTime]::UtcNow.ToString('o')
$resultCode = 1
try {
  & (Join-Path $repository 'scripts/run-functional-e2e-local.ps1') `
    -FixtureDistribution 'C:/Repositories/album-haven-test-data-gallery-refactor/dist' `
    -Case 'FTC-TAGS-021 and FTC-ALBUM-DETAILS-018 consolidate one logical release'
  $resultCode = $LASTEXITCODE
} catch {
  Write-Error $_ -ErrorAction Continue
} finally {
  @{ phase='identity-merge'; pid=$PID; started=$started; finished=[DateTime]::UtcNow.ToString('o'); exitCode=$resultCode } |
    ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
}
exit $resultCode
