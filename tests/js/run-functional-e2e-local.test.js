const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'scripts', 'run-functional-e2e-local.ps1');
const shardContractPath = path.join(repoRoot, 'tests', 'ci', 'functional-shards.json');
const packagePath = path.join(repoRoot, 'package.json');
const guidePath = path.join(repoRoot, 'docs', 'local-functional-e2e.md');
const windowsPowerShell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const powerShellExecutable = process.platform === 'win32' ? windowsPowerShell : 'pwsh';
const testPortPairHelpers = `
function Open-TestListener([int]$Port) {
  $socket = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  $socket.Server.ExclusiveAddressUse = $true
  try { $socket.Start(); return $socket } catch { $socket.Stop(); throw }
}
function Open-TestPair {
  for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
    $first = $second = $null
    try {
      $first = Open-TestListener 0
      $base = $first.LocalEndpoint.Port
      if ($base -gt 65533) { $first.Stop(); continue }
      $second = Open-TestListener ($base + 2)
      return @{ Base = $base; First = $first; Second = $second }
    } catch {
      if ($first) { $first.Stop() }
      if ($second) { $second.Stop() }
    }
  }
  throw 'Unable to establish the test-owned TCP pair.'
}
`;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('local functional runner lists every approved shard and exact case without provisioning', () => {
  assert.equal(fs.existsSync(runnerPath), true, 'Missing scripts/run-functional-e2e-local.ps1');
  const contract = readJson(shardContractPath);
  const result = spawnSync(
    powerShellExecutable,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runnerPath, '-List'],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /Provisioning|PostgreSQL|Copying fixture/i);
  for (const shard of contract.shards) {
    assert.match(result.stdout, new RegExp(`^${shard.name}$`, 'm'));
    for (const invocation of shard.invocations) {
      for (const ownedCase of invocation.cases) {
        assert.match(result.stdout, new RegExp(`^  ${ownedCase.case.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      }
    }
  }
});

test('local functional runner owns safe setup, exact delegation, and teardown', () => {
  assert.equal(fs.existsSync(runnerPath), true, 'Missing scripts/run-functional-e2e-local.ps1');
  const source = fs.readFileSync(runnerPath, 'utf8');

  assert.match(source, /fixtures-v1\.0\.22/);
  assert.match(source, /functional-core/);
  assert.match(source, /manifest\.json/);
  assert.match(source, /Import-Module\s+Microsoft\.PowerShell\.Utility/);
  assert.match(source, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe/);
  assert.match(source, /PGPASSFILE/);
  assert.match(source, /GetFolderPath/);
  assert.match(source, /postgresql[\\\\/]pgpass\.conf/);
  assert.doesNotMatch(source, /C:[\\\\/]Users[\\\\/]/i);
  assert.match(source, /['"]-HostName['"]\s*,\s*['"]localhost['"]/);
  assert.match(source, /['"]-ExpectedMajorVersion['"]\s*,\s*['"]18['"]/);
  assert.match(source, /bootstrap-windows-postgres\.ps1/);
  assert.match(source, /load-fixture-profile\.py/);
  assert.match(source, /validate-functional-shards\.cjs/);
  assert.match(source, /--run-shard=/);
  assert.match(source, /--run-case=/);
  assert.match(source, /album-haven-functional-local-/);
  assert.match(source, /\[guid\]::NewGuid/);
  assert.match(source, /finally\s*\{/i);
  assert.match(source, /-Mode\s+Teardown/);
  assert.match(
    source,
    /POSTGRESQL_ADMIN_PASSWORD\s*=\s*\$postgresAdminPassword[\s\S]*?-Mode\s+Teardown/,
  );
  assert.match(source, /Remove-Item\s+-LiteralPath/);
  for (const key of [
    'MUSIC_DIR',
    'MUSIC_APP_DATA_DIR',
    'MUSIC_CACHE_PATH',
    'MUSIC_COVER_CACHE_PATH',
    'MUSIC_LIBRARY_ROOTS_PATH',
    'PLAYWRIGHT_REAL_APP_URL',
  ]) {
    assert.match(source, new RegExp(`Remove-Item Env:${key}`));
  }
});

test('local functional runner preserves fixtures and stops all shards after process cleanup failure', () => {
  const source = fs.readFileSync(runnerPath, 'utf8');
  const loopStart = source.indexOf('$overallFailed = $false');
  assert.ok(loopStart >= 0);
  const result = spawnSync(powerShellExecutable, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
$ErrorActionPreference = 'Stop'
$selectedShards = @(@{ name = 'first' }, @{ name = 'second' })
$environmentKeys = @()
$expectedRelease = 'test-release'
$fixtureProfile = 'functional-core'
$profileRoot = $manifestPath = $configuredPgpass = $postgresAdminPassword = 'unused'
$Case = ''
$python = 'Invoke-TestPython'
$node = 'Invoke-TestNode'
$loader = $validator = 'unused'
function Assert-OwnedTempRoot { param($Root) return $Root }
function Get-FreePortBase { return 5200 }
function Copy-FixtureProfile {}
function Import-EnvironmentFile {}
function New-Item {}
function Test-Path { return $true }
function Remove-Item {
  if ($args -contains '-LiteralPath') { Write-Output 'FIXTURE_DELETED' }
}
function Invoke-PostgresBootstrap {
  param($Mode)
  Write-Output "BOOTSTRAP:$Mode"
}
function Invoke-TestPython { $global:LASTEXITCODE = 0 }
function Invoke-TestNode {
  Write-Output 'SHARD_EXECUTED'
  $global:LASTEXITCODE = 2
}
${source.slice(loopStart)}
`,
  ], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal((result.stdout.match(/SHARD_EXECUTED/g) || []).length, 1);
  assert.equal((result.stdout.match(/BOOTSTRAP:Provision/g) || []).length, 1);
  assert.doesNotMatch(result.stdout, /BOOTSTRAP:Teardown|FIXTURE_DELETED/);
});

test('npm aliases and local guide expose only the supported runner', () => {
  const packageJson = readJson(packagePath);
  assert.equal(
    packageJson.scripts['test:e2e:functional:local'],
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-functional-e2e-local.ps1',
  );
  assert.equal(
    packageJson.scripts['test:e2e:functional:local:list'],
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-functional-e2e-local.ps1 -List',
  );
  assert.equal(fs.existsSync(guidePath), true, 'Missing docs/local-functional-e2e.md');
  const guide = fs.readFileSync(guidePath, 'utf8');
  assert.match(guide, /npm run test:e2e:functional:local:list/);
  assert.match(guide, /npm run test:e2e:functional:local -- -Shard gallery-search-visual/);
  assert.match(guide, /npm run test:e2e:functional:local -- -Case "FTC-MOBILE-WEB-007/);
  assert.match(guide, /npm run test:e2e:functional:local -- -All/);
  assert.match(guide, /localhost/);
  assert.match(guide, /PGPASSFILE/);
  assert.match(guide, /fixtures-v1\.0\.22/);
  assert.match(guide, /Do not[^.]*run-playwright\.cjs/is);
});

test('port allocation rejects a candidate whose provider port alone is occupied', () => {
  const source = fs.readFileSync(runnerPath, 'utf8');
  const start = source.indexOf('function Get-FreePortBase {');
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  const result = spawnSync(powerShellExecutable, ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
${testPortPairHelpers}
$blocked = $available = $null
try {
  $blocked = Open-TestPair
  $available = Open-TestPair
  # Snapshot rejection must work even after these test sockets are released.
  foreach ($pair in @($blocked, $available)) { $pair.First.Stop(); $pair.Second.Stop() }
  $script:candidates = @($blocked.Base, $available.Base)
  $script:requests = 0
  function Get-Random {
    param($Minimum, $Maximum)
    $value = $script:candidates[[Math]::Min($script:requests, 1)]
    $script:requests += 1
    return $value
  }
  function Get-NetTCPConnection {
    param($State, $ErrorAction)
    [pscustomobject]@{ LocalPort = ($blocked.Base + 2) }
  }
  ${source.slice(start, end)}
  $selected = Get-FreePortBase
  @{ Selected = $selected; Expected = $available.Base; Requests = $script:requests } | ConvertTo-Json -Compress
} finally {
  foreach ($pair in @($blocked, $available)) {
    if ($pair) { $pair.First.Stop(); $pair.Second.Stop() }
  }
}
`], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout.trim());
  assert.equal(observed.Selected, observed.Expected);
  assert.equal(observed.Requests, 2, 'a provider-only listener must reject the first candidate');
});

test('port allocation bind-checks both ports despite an empty listener snapshot', () => {
  const source = fs.readFileSync(runnerPath, 'utf8');
  const start = source.indexOf('function Get-FreePortBase {');
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  const result = spawnSync(powerShellExecutable, ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
${testPortPairHelpers}
$blocked = $available = $null
$rebound = @()
try {
  $blocked = Open-TestPair
  $available = Open-TestPair
  # Leave only the first candidate's second port occupied by a real socket.
  $blocked.First.Stop()
  $available.First.Stop()
  $available.Second.Stop()
  $script:candidates = @($blocked.Base, $available.Base)
  $script:requests = 0
  function Get-Random {
    param($Minimum, $Maximum)
    $value = $script:candidates[[Math]::Min($script:requests, 1)]
    $script:requests += 1
    return $value
  }
  function Get-NetTCPConnection { param($State, $ErrorAction) return @() }
  ${source.slice(start, end)}
  $selected = Get-FreePortBase
  if ($selected -eq $available.Base) {
    # A rejected partial pair and both accepted probes must be released.
    foreach ($port in @($blocked.Base, $available.Base, ($available.Base + 2))) {
      $rebound += Open-TestListener $port
    }
  }
  @{ Selected = $selected; Expected = $available.Base; Requests = $script:requests; Rebound = $rebound.Count } | ConvertTo-Json -Compress
} finally {
  foreach ($listener in $rebound) { $listener.Stop() }
  foreach ($pair in @($blocked, $available)) {
    if ($pair) { $pair.First.Stop(); $pair.Second.Stop() }
  }
}
`], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const observed = JSON.parse(result.stdout.trim());
  assert.equal(observed.Selected, observed.Expected, 'an occupied provider port must reject the entire pair');
  assert.equal(observed.Requests, 2);
  assert.equal(observed.Rebound, 3, 'both accepted probes and the rejected partial probe must be disposed');
});
