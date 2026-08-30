const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'scripts', 'ci', 'run-performance-shard.ps1');
const targetRunnerPath = path.join(repoRoot, 'scripts', 'run-performance-playwright.cjs');

test('performance profile runner prepares one isolated fixture before compatible sequential targets', () => {
  assert.equal(fs.existsSync(runnerPath), true, 'missing run-performance-shard.ps1');
  const source = fs.readFileSync(runnerPath, 'utf8');

  for (const parameter of [
    'Targets',
    'FixtureProfile',
    'FixtureMode',
    'BasePort',
    'DatabaseSuffixBase',
    'ExpectedPostgresMajor',
    'PostgresPort',
  ]) {
    assert.match(source, new RegExp(`\\$${parameter}\\b`));
  }
  assert.match(source, /\[string\]\$ExpectedPostgresMajor\s*=\s*['"]17['"]/);
  assert.match(source, /foreach\s*\(\$target\s+in\s+\$targetNames\)/i);
  assert.match(source, /\$targetIndex\s*\+=\s*1/);
  assert.doesNotMatch(source, /targetSuffix/i);
  assert.match(source, /PLAYWRIGHT_PORT[^\n]*targetPort/);
  assert.match(source, /PLAYWRIGHT_REAL_APP_PORT[^\n]*targetPort/);
  assert.match(
    source,
    /\$targetPort\s*=\s*Get-SafeTargetPort\s+-SequenceIndex\s*\(\$targetIndex\s*-\s*1\)/i,
    'sequential targets need non-overlapping browser-safe diagnostic port blocks',
  );
  assert.match(source, /function\s+Test-TargetPortBlockSafe/i);
  assert.match(source, /6665[\s\S]*6669/, 'the allocator must reject the browser-forbidden IRC port range');
  assert.match(source, /bootstrap-windows-postgres\.ps1/);
  assert.match(source, /Mode\s*=\s*['"]Provision['"]/i);
  assert.match(source, /ExpectedMajorVersion\s*=\s*\$ExpectedPostgresMajor/);
  assert.match(source, /Port\s*=\s*\$PostgresPort/);
  assert.match(source, /\$postgresServiceName\s*=\s*["']postgresql-x64-\$ExpectedPostgresMajor["']/);
  assert.match(source, /ServiceName\s*=\s*\$postgresServiceName/);
  assert.match(source, /finally\s*\{/i);
  assert.match(source, /&\s*\$bootstrap\s+`[\s\S]*-Mode\s+Teardown/i);
  assert.match(source, /-ExpectedMajorVersion\s+\$ExpectedPostgresMajor/);
  assert.match(source, /-Port\s+\$PostgresPort/);
  assert.match(source, /run-performance-playwright\.cjs[\s\S]*--test=/i);
  assert.match(source, /write-foundation-version-manifest\.cjs/);
  assert.match(
    source,
    /&\s*\$nodePath\s+\$foundationWriter\s+--profile=windows\s+["']--postgres-major=\$ExpectedPostgresMajor["']/i,
    'the foundation manifest must validate the same PostgreSQL major selected for provisioning',
  );
  assert.match(source, /ci-job\.json/);
  assert.match(source, /Get-NetTCPConnection/);
  assert.match(source, /0\.\.6/, 'teardown must audit every app/provider diagnostic port in the target block');
  assert.match(source, /&\s*\$bootstrap\s+@provisionArguments\s+-SkipFixtureLoad/, 'database provisioning must not also prepare the profile fixture');
  const targetLoopIndex = source.search(/foreach\s*\(\$target\s+in\s+\$targetNames\)\s*\{\s*\$targetIndex\s*\+=\s*1/i);
  const provisionIndex = source.search(/&\s*\$bootstrap\s+@provisionArguments\s+-SkipFixtureLoad/i);
  const teardownIndex = source.search(/&\s*\$bootstrap\s+`[\s\S]*-Mode\s+Teardown/i);
  assert.ok(provisionIndex >= 0 && provisionIndex < targetLoopIndex, 'provision once before the target loop');
  assert.ok(teardownIndex > targetLoopIndex, 'teardown once after the target loop');
  assert.equal((source.match(/Mode\s*=\s*['"]Provision['"]/gi) || []).length, 1);
  assert.equal((source.match(/-Mode\s+Teardown/gi) || []).length, 1);
  assert.match(source, /target port audit:[\s\S]*database teardown:/i, 'database teardown must still run after a target port-audit failure');
  assert.match(source, /throw[^\n]*teardown/i);
  assert.match(source, /\$failedTargets/);

  for (const key of [
    'MUSIC_DIR',
    'MUSIC_APP_DATA_DIR',
    'MUSIC_CACHE_PATH',
    'MUSIC_COVER_CACHE_PATH',
    'MUSIC_LIBRARY_ROOTS_PATH',
    'PLAYWRIGHT_REAL_APP_URL',
  ]) {
    assert.match(source, new RegExp(`['"]${key}['"]`));
  }
  assert.match(source, /Set-Item\s+-LiteralPath\s+["']Env:\$key["']/i);
});

test('performance profile runner accepts the ten-target synthetic profile', () => {
  const source = fs.readFileSync(runnerPath, 'utf8');
  assert.doesNotMatch(
    source,
    /\$targetNames\.Count\s+-gt\s+[1-9]\b/,
    'the synthetic profile runner must accept all ten targets',
  );
});

test('performance profile runner prepares its fixture exactly once before the target loop', () => {
  const source = fs.readFileSync(runnerPath, 'utf8');
  const targetLoopIndex = source.search(/foreach\s*\(\$target\s+in\s+\$targetNames\)\s*\{\s*\$targetIndex\s*\+=\s*1/i);
  const provisionIndex = source.search(/&\s*\$bootstrap\s+@provisionArguments\s+-SkipFixtureLoad/i);
  const preparationCalls = source.match(/(?:^|\r?\n)\s*Prepare-PerformanceFixture\b/gi) || [];
  const prepareIndex = source.search(/(?:^|\r?\n)\s*Prepare-PerformanceFixture\b/i);

  assert.equal(preparationCalls.length, 1, 'profile preparation must be invoked exactly once');
  assert.ok(prepareIndex > provisionIndex && prepareIndex < targetLoopIndex, 'prepare after provisioning and before targets');
});

test('performance profile runner explicitly marks every sequential target as fixture-prepared', () => {
  const source = fs.readFileSync(runnerPath, 'utf8');
  assert.match(
    source,
    /&\s*\$nodePath\s+\$performanceRunner\s+["']--test=\$target["'][^\r\n]*--prepared-fixture/i,
    'every sequential target must explicitly consume the already prepared fixture',
  );
});

test('performance profile runner defaults local imitation to local and propagates an explicit contract selector', () => {
  const source = fs.readFileSync(runnerPath, 'utf8');
  assert.match(
    source,
    /\[ValidateSet\(['"]local['"],\s*['"]ci['"]\)\]\[string\]\$PerformanceContract\s*=\s*['"]local['"]/i,
    'local shared-setup imitation must retain the local timing contract by default',
  );
  assert.match(
    source,
    /&\s*\$nodePath\s+\$performanceRunner\s+["']--test=\$target["'][^\r\n]*--performance-contract=\$PerformanceContract/i,
    'every shard target must propagate the validated local-or-CI timing contract',
  );
});

test('performance shard runner never parallelizes targets or hides the one-worker runner contract', () => {
  const source = fs.existsSync(runnerPath) ? fs.readFileSync(runnerPath, 'utf8') : '';
  assert.doesNotMatch(source, /Start-Job|ForEach-Object\s+-Parallel|Start-ThreadJob/i);
  assert.match(source, /--headless/);
  assert.match(source, /ValidateSet\(['"]chrome['"]\)/);
  assert.match(source, /--browser=\$Browser/);
});

test('prepared-fixture target mode validates identity but suppresses target-level fixture reloads', () => {
  const source = fs.readFileSync(targetRunnerPath, 'utf8');
  const runnerModule = require('../../scripts/run-performance-playwright.cjs');
  const options = runnerModule._private.parseCliArgs(['--test=all-artists', '--prepared-fixture']);

  assert.equal(options.preparedFixture, true);
  assert.match(source, /preparedFixture\s*:\s*false/);
  assert.match(
    source,
    /if\s*\(\s*!\s*(?:options\.)?preparedFixture\s*\)\s*\{\s*reloadPreloadedFixtureForAttempt\(/s,
    'standalone runs reload normally while prepared profile runs skip the target-level reload',
  );
  assert.match(
    source,
    /assertPerformanceTargetFixtureConfiguration\([^;]+\);[\s\S]{0,500}preparedFixture/s,
    'prepared mode must retain the normal fixture-profile and owner-database identity preflight',
  );
});
