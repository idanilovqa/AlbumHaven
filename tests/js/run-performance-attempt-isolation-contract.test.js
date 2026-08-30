const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const performanceRunner = require('../../scripts/run-performance-playwright.cjs');

const { _private } = performanceRunner;
const repoRoot = path.resolve(__dirname, '..', '..');
const artifactBaseRoot = path.join(repoRoot, 'test-results', 'playwright-performance-targets');

function withProcessEnv(t, overrides) {
  const originals = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    originals.set(key, process.env[key]);
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function withMissingProcessEnv(t, defaults) {
  const missingDefaults = Object.fromEntries(
    Object.entries(defaults).filter(([key]) => !String(process.env[key] || '').trim()),
  );
  withProcessEnv(t, missingDefaults);
}

function runThreeExplicitDiagnosticAttempts(t, targetName, onSpawn = () => {}, calls = []) {
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, options) => {
    const call = { command, args: [...args], options };
    calls.push(call);
    return onSpawn(call, calls.length) || {
      error: null,
      status: command === process.execPath ? 1 : 0,
      stdout: '',
      stderr: '',
    };
  };
  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
  });

  const target = performanceRunner.PERFORMANCE_TARGETS[targetName];
  if (target.fixtureMode === 'preloaded-release') {
    const fixtureRoot = path.join(repoRoot, '.tmp', 'performance-attempt-contract-fixture');
    withMissingProcessEnv(t, {
      PLAYWRIGHT_PYTHON: 'C:\\Python\\python.exe',
      ALBUM_HAVEN_FIXTURE_PROFILE: target.fixtureProfile,
      ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
      ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
      DATABASE_MIGRATOR_URL: 'postgresql://album_haven_migrator_attempts@127.0.0.1:5432/album_haven_ci_attempts',
    });
  }
  const result = _private.runTargetWithPolicy(target, {
    browser: 'chrome',
    headless: true,
    repeatCount: 3,
    testTimeoutMs: 120000,
  }, {
    realAppPort: 5001,
    scanAppPort: 4174,
  });
  return { calls, result };
}

function runPreloadedPolicyWithDatabaseUrl(t, databaseUrl, calls = []) {
  const target = performanceRunner.PERFORMANCE_TARGETS['all-artists'];
  const fixtureRoot = path.join(repoRoot, '.tmp', 'performance-database-safety-fixture');
  const python = 'C:\\Python\\python.exe';
  withProcessEnv(t, {
    PLAYWRIGHT_PYTHON: python,
    ALBUM_HAVEN_FIXTURE_PROFILE: target.fixtureProfile,
    ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
    ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
    DATABASE_MIGRATOR_URL: databaseUrl,
  });

  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    return { error: null, status: 0, stdout: '', stderr: '' };
  };
  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
  });

  return _private.runTargetWithPolicy(target, {
    browser: 'chrome',
    headless: true,
    repeatCount: 1,
    testTimeoutMs: 120000,
  }, {
    realAppPort: 5001,
    scanAppPort: 4174,
  });
}

test('target artifacts use one deterministic root with a sanitized target id', () => {
  assert.equal(typeof _private.resolvePerformanceTargetArtifactRoot, 'function');

  const target = { aliasNames: ['Scan Page / cancellation?'] };
  assert.equal(
    _private.resolvePerformanceTargetArtifactRoot(target),
    path.join(artifactBaseRoot, 'scan-page-cancellation'),
  );
  assert.equal(
    _private.resolvePerformanceTargetArtifactRoot(target),
    _private.resolvePerformanceTargetArtifactRoot(target),
  );
});

test('attempts one through three receive distinct output directories and explicit last-run files', () => {
  assert.equal(typeof _private.resolvePerformanceAttemptArtifactDir, 'function');

  const targetRoot = path.join(artifactBaseRoot, 'all-artists');
  const outputDirs = Array.from(
    { length: 3 },
    (_unused, index) => _private.resolvePerformanceAttemptArtifactDir(targetRoot, index + 1),
  );
  assert.deepEqual(outputDirs, [1, 2, 3].map(
    (attempt) => path.join(targetRoot, `attempt-${attempt}`),
  ));

  for (const outputDir of outputDirs) {
    const args = ['test', 'example.spec.js', `--output=${outputDir}`];
    assert.equal(
      _private.resolvePlaywrightLastRunPath(args),
      path.join(outputDir, '.last-run.json'),
    );
  }
});

test('three explicit diagnostic attempts pass their own Playwright output directory and shared history root', (t) => {
  const targetRoot = path.join(artifactBaseRoot, 'all-artists');
  const { calls, result } = runThreeExplicitDiagnosticAttempts(t, 'all-artists');
  const playwrightCalls = calls.filter((call) => call.command === process.execPath);

  assert.equal(result.exitCode, 1);
  assert.equal(playwrightCalls.length, 3);
  assert.deepEqual(
    playwrightCalls.map((call) => call.args.find((arg) => String(arg).startsWith('--output='))),
    [1, 2, 3].map(
      (attempt) => `--output=${path.join(targetRoot, `attempt-${attempt}`)}`,
    ),
  );
  assert.deepEqual(
    playwrightCalls.map((call) => call.options.env.PLAYWRIGHT_PERFORMANCE_HISTORY_ROOT),
    new Array(3).fill(path.join(targetRoot, 'history')),
  );
  assert.equal(
    playwrightCalls.every((call) => call.args.includes('--workers=1')),
    true,
  );
});

test('coverage-only scan-page owns a contained JSON report while measured targets clear inherited output', (t) => {
  const inheritedOutput = path.join(repoRoot, 'outside-runner-owned-report.json');
  withProcessEnv(t, { PLAYWRIGHT_JSON_OUTPUT_FILE: inheritedOutput });

  const scanCalls = [];
  runThreeExplicitDiagnosticAttempts(t, 'scan-page', () => ({
    error: null, status: 1, stdout: '', stderr: '',
  }), scanCalls);
  const scanPlaywrightCalls = scanCalls.filter((call) => call.command === process.execPath);
  assert.equal(
    scanPlaywrightCalls[0].options.env.PLAYWRIGHT_JSON_OUTPUT_FILE,
    path.join(artifactBaseRoot, 'scan-page', 'attempt-1', 'report.json'),
  );
  assert.deepEqual(
    scanPlaywrightCalls.map((call) => call.options.env.PLAYWRIGHT_JSON_OUTPUT_FILE),
    [1, 2, 3].map((attempt) => path.join(
      artifactBaseRoot,
      'scan-page',
      `attempt-${attempt}`,
      'report.json',
    )),
  );

  const measuredCalls = [];
  runThreeExplicitDiagnosticAttempts(t, 'all-artists', (call) => ({
    error: null,
    status: call.command === process.execPath ? 1 : 0,
    stdout: '',
    stderr: '',
  }), measuredCalls);
  assert.equal(
    measuredCalls
      .filter((call) => call.command === process.execPath)
      .every((call) => call.options.env.PLAYWRIGHT_JSON_OUTPUT_FILE === undefined),
    true,
  );
});

test('the target artifact root is cleared once before attempt one and not between retries', (t) => {
  const targetRoot = path.join(artifactBaseRoot, 'all-artists');
  const originalRmSync = fs.rmSync;
  const clears = [];
  fs.rmSync = (filePath, options) => {
    if (path.resolve(filePath) === path.resolve(targetRoot) && options?.recursive === true) {
      clears.push({ filePath, options });
      return;
    }
    return originalRmSync(filePath, options);
  };
  t.after(() => {
    fs.rmSync = originalRmSync;
  });

  const { result } = runThreeExplicitDiagnosticAttempts(t, 'all-artists');

  assert.equal(result.exitCode, 1);
  assert.equal(clears.length, 1);
  assert.equal(clears[0].options.force, true);
});

test('preloaded targets reload the released fixture before every Playwright attempt', (t) => {
  const python = 'C:\\Python\\python.exe';
  const fixtureRoot = 'C:\\runner-temp\\performance-fixture';
  const databaseUrl = 'postgresql://album_haven_migrator_attempts@127.0.0.1:5432/album_haven_ci_attempts';
  withProcessEnv(t, {
    PLAYWRIGHT_PYTHON: python,
    ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
    ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
    ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
    DATABASE_MIGRATOR_URL: databaseUrl,
  });

  const { calls, result } = runThreeExplicitDiagnosticAttempts(t, 'all-artists');
  const loaderCalls = calls.filter((call) => call.command === python);
  const playwrightCalls = calls.filter((call) => call.command === process.execPath);
  const expectedArgs = [
    path.join(repoRoot, 'scripts', 'ci', 'load-fixture-profile.py'),
    '--fixture-root', fixtureRoot,
    '--profile', 'synthetic-large-library',
    '--database-url', databaseUrl,
    '--replace-existing',
  ];

  assert.equal(result.exitCode, 1);
  assert.equal(loaderCalls.length, 3);
  assert.equal(playwrightCalls.length, 3);
  assert.deepEqual(loaderCalls.map((call) => call.args), new Array(3).fill(expectedArgs));
  assert.deepEqual(
    calls.map((call) => call.command),
    [python, process.execPath, python, process.execPath, python, process.execPath],
  );
});

test('generated-isolated targets never invoke the released fixture loader', (t) => {
  const python = 'C:\\Python\\python.exe';
  withProcessEnv(t, {
    PLAYWRIGHT_PYTHON: python,
    ALBUM_HAVEN_FIXTURE_PROFILE: 'playback-media',
    DATABASE_MIGRATOR_URL: 'postgresql://album_haven_migrator_attempts@127.0.0.1:5432/album_haven_ci_attempts',
  });

  const { calls, result } = runThreeExplicitDiagnosticAttempts(t, 'playback-start');

  assert.equal(result.exitCode, 1);
  assert.equal(calls.filter((call) => call.command === python).length, 0);
  assert.equal(calls.filter((call) => call.command === process.execPath).length, 3);
});

test('a released fixture loader failure prevents Playwright from starting', (t) => {
  const python = 'C:\\Python\\python.exe';
  const fixtureRoot = 'C:\\runner-temp\\performance-fixture';
  withProcessEnv(t, {
    PLAYWRIGHT_PYTHON: python,
    ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
    ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
    ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
    DATABASE_MIGRATOR_URL: 'postgresql://album_haven_migrator_attempts@127.0.0.1:5432/album_haven_ci_attempts',
  });

  let thrown = null;
  let runResult = null;
  const calls = [];
  try {
    const run = runThreeExplicitDiagnosticAttempts(t, 'all-artists', (call) => {
      if (call.command === python) {
        return { error: null, status: 1, stdout: '', stderr: 'fixture load failed' };
      }
      return { error: null, status: 0, stdout: '', stderr: '' };
    }, calls);
    runResult = run.result;
  } catch (error) {
    thrown = error;
  }

  assert.equal(calls.filter((call) => call.command === process.execPath).length, 0);
  assert.equal(calls.filter((call) => call.command === python).length, 1);
  assert.ok(thrown || runResult?.exitCode !== 0);
});

test('preloaded policy accepts an exact suffix-coupled passwordless loopback migrator identity', (t) => {
  const calls = [];
  const result = runPreloadedPolicyWithDatabaseUrl(
    t,
    'postgresql://album_haven_migrator_safety@127.0.0.1:5432/album_haven_ci_safety',
    calls,
  );

  assert.equal(result.exitCode, 1, 'metric-bearing mocks without finalized metrics fail closed');
  assert.deepEqual(
    calls.map((call) => call.command),
    ['C:\\Python\\python.exe', process.execPath],
  );
});

for (const [label, databaseUrl] of [
  [
    'album_haven_core',
    'postgresql://album_haven_migrator_safety@127.0.0.1:5432/album_haven_core',
  ],
  [
    'a non-CI shared database',
    'postgresql://album_haven_migrator_safety@127.0.0.1:5432/album_haven_shared',
  ],
  [
    'a remote host',
    'postgresql://album_haven_migrator_safety@database.example.test:5432/album_haven_ci_safety',
  ],
  [
    'an embedded password',
    'postgresql://album_haven_migrator_safety:secret@127.0.0.1:5432/album_haven_ci_safety',
  ],
  [
    'a query-string override',
    'postgresql://album_haven_migrator_safety@127.0.0.1:5432/album_haven_ci_safety?options=-csearch_path%3Dpublic',
  ],
  [
    'a fragment override',
    'postgresql://album_haven_migrator_safety@127.0.0.1:5432/album_haven_ci_safety#override',
  ],
  [
    'a mismatched migrator suffix',
    'postgresql://album_haven_migrator_other@127.0.0.1:5432/album_haven_ci_safety',
  ],
  [
    'an app runtime role',
    'postgresql://album_haven_app_safety@127.0.0.1:5432/album_haven_ci_safety',
  ],
]) {
  test(`preloaded policy rejects ${label} before any child spawn`, (t) => {
    const calls = [];
    let thrown = null;
    try {
      runPreloadedPolicyWithDatabaseUrl(t, databaseUrl, calls);
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof Error, `expected ${label} to fail loudly`);
    assert.match(thrown.message, /DATABASE_MIGRATOR_URL|database|migrator|loopback|password|query|fragment/i);
    assert.equal(calls.length, 0);
  });
}
