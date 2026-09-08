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
