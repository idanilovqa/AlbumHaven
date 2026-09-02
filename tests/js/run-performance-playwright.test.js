const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const performanceRunner = require('../../scripts/run-performance-playwright.cjs');
const { _private } = performanceRunner;
const REAL_APP_ENV = {
  ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE: 'postgres',
};
const BROAD_UTILITY_PROBLEMATIC_FILES_REAL_APP_ENV = {
  ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE: 'postgres',
  ALBUM_HAVEN_E2E_FIXTURE_PROFILE: 'utility-problematic-files',
  ALBUM_HAVEN_UTILITY_PROJECTION_PREWARM_ENABLED: '0',
  PLAYWRIGHT_ISOLATED_LIBRARY_APP: '1',
};
const FOCUSED_PROBLEMATIC_FILES_REAL_APP_ENV = {
  ...REAL_APP_ENV,
  ALBUM_HAVEN_E2E_FIXTURE_PROFILE: 'utility-problematic-files',
  PLAYWRIGHT_ISOLATED_LIBRARY_APP: '1',
};
const REAL_APP_TARGETS = [
  'all-artists',
  'artist-family',
  'search-all-artists',
  'utility-problematic-files',
  'utility-rules',
  'selected-artist',
  'search-browse',
  'root-album-browse',
  'app-open-all-artists',
  'problematic-files-focused',
  'rules-focused',
];
const FAKE_PERFORMANCE_PYTHON = 'C:\\Python\\python.exe';

function usePreloadedFixtureEnv(t, targetName) {
  const target = performanceRunner.PERFORMANCE_TARGETS[targetName];
  const fixtureRoot = path.join(
    path.resolve(__dirname, '..', '..'),
    '.tmp',
    `performance-runner-contract-${target.fixtureProfile}`,
  );
  const overrides = {
    PLAYWRIGHT_PYTHON: FAKE_PERFORMANCE_PYTHON,
    ALBUM_HAVEN_FIXTURE_PROFILE: target.fixtureProfile,
    ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
    ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
    DATABASE_MIGRATOR_URL: 'postgresql://album_haven_migrator_runner_contract@127.0.0.1:5432/album_haven_ci_runner_contract',
  };
  const original = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return target;
}

function selectNextPreloadedProfileAfter(targetName) {
  const targets = _private.listDefaultPerformanceTargets();
  const currentIndex = targets.findIndex((target) => target.aliasNames[0] === targetName);
  const nextTarget = targets.slice(currentIndex + 1).find(
    (target) => target.fixtureMode === 'preloaded-release',
  );
  if (nextTarget) process.env.ALBUM_HAVEN_FIXTURE_PROFILE = nextTarget.fixtureProfile;
}

function installFinalizedPassingPerformanceEvidence(t) {
  const originalReadFileSync = fs.readFileSync;
  let activeEnv = {};

  fs.readFileSync = (filePath, encoding) => {
    const normalizedPath = String(filePath).replace(/\\/g, '/');
    const targetName = String(activeEnv.PLAYWRIGHT_PERF_VERIFICATION_GROUP_LABEL || '')
      .split('+')
      .at(-1);
    const target = performanceRunner.PERFORMANCE_TARGETS[targetName];
    if (normalizedPath.endsWith('/.last-run.json')) {
      return JSON.stringify({ status: 'passed', failedTests: [] });
    }
    if (target?.reportId && normalizedPath.endsWith(`/${target.reportId}/index.json`)) {
      return JSON.stringify({
        runs: [{
          metricsPath: 'latest-run.json',
          reportPath: 'latest-report/index.html',
          verificationRunGroup: {
            id: activeEnv.PLAYWRIGHT_PERF_VERIFICATION_GROUP_ID,
            attempt: Number(activeEnv.PLAYWRIGHT_PERF_VERIFICATION_ATTEMPT),
          },
        }],
      });
    }
    if (target?.reportId && normalizedPath.endsWith(`/${target.reportId}/latest-run.json`)) {
      return JSON.stringify({
        runId: `${targetName}-passing-run`,
        caseId: (target.casePatterns || [target.casePattern || target.grep])[0],
        rawMetrics: {
          benchmarkValidation: {
            selectedContract: 'local',
            functionalChecksComplete: true,
            nonTimingChecksComplete: true,
            results: [{
              key: 'contractBytes',
              units: 'bytes',
              actual: 1,
              hardCeiling: 2,
              allowedMaximum: 2,
              passed: true,
            }],
          },
        },
      });
    }
    return originalReadFileSync(filePath, encoding);
  };
  t.after(() => {
    fs.readFileSync = originalReadFileSync;
  });

  return (options) => {
    activeEnv = options.env;
    const targetName = String(activeEnv.PLAYWRIGHT_PERF_VERIFICATION_GROUP_LABEL || '')
      .split('+')
      .at(-1);
    const target = performanceRunner.PERFORMANCE_TARGETS[targetName];
    const patterns = target?.casePatterns || [target?.casePattern || target?.grep || targetName];
    const listLines = patterns.map((pattern, index) => (
      `ok ${index + 1} [chromium] > ${target.specPath}:1:1 > policy fixture > ${pattern}`
    ));
    return `${listLines.join('\n')}\n[playwright-performance-reporter] flush-complete\n`;
  };
}

test('scan database configuration preflight fails before launch when dedicated URLs are missing', () => {
  const scanTargets = _private.listGroupedPerformanceTargets('scan');

  assert.throws(
    () => _private.assertScanPerformanceDatabaseConfiguration(scanTargets, {}),
    (error) => {
      assert.match(error.message, /ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL/);
      assert.match(error.message, /ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL/);
      assert.match(error.message, /album_haven_scan_e2e/);
      assert.match(error.message, /\.env\.example/);
      return true;
    },
  );
});

test('scan database configuration preflight ignores target sets without scan benchmarks', () => {
  assert.doesNotThrow(() => {
    _private.assertScanPerformanceDatabaseConfiguration(
      _private.listGroupedPerformanceTargets('real-app'),
      {},
    );
  });
});

test('scan database configuration preflight rejects core and non-isolated database names', () => {
  const scanTargets = _private.listGroupedPerformanceTargets('scan');
  const runtimeUrl = 'postgresql://album_haven_app@localhost:5432/album_haven_scan_e2e';

  for (const [databaseName, expectedMessage] of [
    ['album_haven_core', /not album_haven_core/],
    ['album_haven_contest', /album_haven_scan_e2e/],
  ]) {
    assert.throws(
      () => _private.assertScanPerformanceDatabaseConfiguration(scanTargets, {
        ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL:
          `postgresql://album_haven_migrator@localhost:5432/${databaseName}`,
        ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL: runtimeUrl,
      }),
      expectedMessage,
    );
  }
});

test('scan database configuration preflight requires both credentials to target the same database', () => {
  const scanTargets = _private.listGroupedPerformanceTargets('scan');

  assert.throws(
    () => _private.assertScanPerformanceDatabaseConfiguration(scanTargets, {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL:
        'postgresql://album_haven_migrator@localhost:5432/album_haven_scan_e2e',
      ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL:
        'postgresql://album_haven_app@localhost:5432/album_haven_other_scan_e2e',
    }),
    /must target the same isolated database/,
  );
});

test('scan database configuration preflight rejects the setup role as the runtime role', () => {
  const scanTargets = _private.listGroupedPerformanceTargets('scan');

  assert.throws(
    () => _private.assertScanPerformanceDatabaseConfiguration(scanTargets, {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL:
        'postgresql://album_haven_migrator@localhost:5432/album_haven_scan_e2e',
      ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL:
        'postgresql://album_haven_migrator@localhost:5432/album_haven_scan_e2e',
    }),
    /album_haven_app/,
  );
});

test('scan database configuration preflight requires documented least-privilege roles', () => {
  const scanTargets = _private.listGroupedPerformanceTargets('scan');

  assert.throws(
    () => _private.assertScanPerformanceDatabaseConfiguration(scanTargets, {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL:
        'postgresql://postgres@localhost:5432/album_haven_scan_e2e',
      ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL:
        'postgresql://runtime@localhost:5432/album_haven_scan_e2e',
    }),
    /album_haven_migrator/,
  );
});

test('configured suite stops before Playwright when read-only scan connectivity preflight fails', () => {
  const env = {
    ALBUM_HAVEN_FIXTURE_PROFILE: 'scan-library',
    ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL:
      'postgresql://album_haven_migrator@localhost:5432/album_haven_scan_e2e',
    ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL:
      'postgresql://album_haven_app@localhost:5432/album_haven_scan_e2e',
  };
  const calls = [];

  assert.throws(
    () => _private.runConfiguredPerformanceSuite(
      { group: 'scan', targetInput: '', headless: true },
      env,
      {
        loadEnv: (baseEnv) => baseEnv,
        runDatabasePreflight: (_targets, childEnv) => {
          calls.push(['preflight', childEnv]);
          throw new Error('read-only connectivity failed');
        },
        runSuite: () => calls.push(['suite']),
      },
    ),
    /read-only connectivity failed/,
  );
  assert.deepEqual(calls.map(([kind]) => kind), ['preflight']);
});

test('configured suite rejects mixed preloaded fixture profiles before setup or Playwright', () => {
  const calls = [];
  assert.throws(
    () => _private.runConfiguredPerformanceSuite(
      { group: 'real-app', targetInput: '', headless: true },
      {},
      {
        loadEnv: () => {
          calls.push('load-env');
          return {};
        },
        runDatabasePreflight: () => calls.push('preflight'),
        runSuite: () => calls.push('suite'),
      },
    ),
    /cannot combine preloaded fixture profiles.*synthetic-large-library.*utility-problematic-files.*without reloading PostgreSQL/i,
  );
  assert.deepEqual(calls, []);
});

test('scan database configuration preflight honors dotenv values with process env precedence', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-scan-preflight-'));
  const dotenvPath = path.join(tempRoot, '.env');
  fs.writeFileSync(
    dotenvPath,
    [
      'ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL=postgresql://album_haven_migrator@localhost:5432/album_haven_scan_e2e',
      'ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL=postgresql://dotenv_app@localhost:5432/album_haven_scan_e2e',
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    const env = _private.loadDotEnvFile({
      ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL: 'postgresql://album_haven_app@localhost:5432/album_haven_scan_e2e',
    }, dotenvPath);

    assert.equal(
      env.ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL,
      'postgresql://album_haven_migrator@localhost:5432/album_haven_scan_e2e',
    );
    assert.equal(
      env.ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL,
      'postgresql://album_haven_app@localhost:5432/album_haven_scan_e2e',
    );
    assert.doesNotThrow(() => {
      _private.assertScanPerformanceDatabaseConfiguration(
        _private.listGroupedPerformanceTargets('scan'),
        env,
      );
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parseCliArgs accepts a named target with repeat count and headless mode', () => {
  const parsed = _private.parseCliArgs([
    '--test',
    'artist-family',
    '--repeat-count',
    '5',
    '--headless',
  ]);

  assert.deepEqual(parsed, {
    browser: 'chromium',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 5,
    targetInput: 'artist-family',
  });
});

test('parseCliArgs leaves targetInput empty when no performance target was provided', () => {
  const parsed = _private.parseCliArgs([
    '--repeat-count',
    '2',
  ]);

  assert.deepEqual(parsed, {
    browser: 'chromium',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 2,
    targetInput: '',
  });
});

test('parseCliArgs defaults the performance runner to headless mode', () => {
  const parsed = _private.parseCliArgs([]);

  assert.deepEqual(parsed, {
    browser: 'chromium',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: '',
  });
});

test('parseCliArgs preserves explicit managed Chromium, Chrome, and Edge selections', () => {
  for (const browser of ['chromium', 'chrome', 'edge']) {
    const parsed = _private.parseCliArgs([`--browser=${browser}`]);

    assert.equal(parsed.browser, browser);
  }
});

test('parseCliArgs accepts a named performance group', () => {
  const parsed = _private.parseCliArgs([
    '--group',
    'real-app',
    '--headed',
  ]);

  assert.deepEqual(parsed, {
    browser: 'chromium',
    grep: '',
    group: 'real-app',
    headless: false,
    repeatCount: 1,
    targetInput: '',
  });
});

test('resolveRequestedTargets defaults to the approved performance suite when no target is provided', () => {
  const targets = _private.resolveRequestedTargets({
    browser: null,
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: '',
  });

  assert.deepEqual(
    targets.map((target) => target.aliasNames[0]),
    [
      'idle-memory',
      'playback-start',
      'gapless-playback',
      'all-artists',
      'artist-family',
      'search-all-artists',
      'utility-problematic-files',
      'utility-rules',
      'selected-artist',
      'search-browse',
      'root-album-browse',
      'app-open-all-artists',
      'problematic-files-focused',
      'rules-focused',
      'scan-cold',
      'scan-cached',
      'scan-add-album',
      'scan-metadata',
      'scan-page',
    ]
  );
  assert.equal(targets.length, 19);
});
test('resolveRequestedTargets rejects an unknown performance group', () => {
  assert.throws(() => _private.resolveRequestedTargets({
    browser: null,
    grep: '',
    group: 'unknown-group',
    headless: true,
    repeatCount: 1,
    targetInput: '',
  }), /Unsupported performance group: unknown-group/);
});

test('resolveRequestedTargets can limit the run to the scan group', () => {
  const targets = _private.resolveRequestedTargets({
    browser: null,
    grep: '',
    group: 'scan',
    headless: true,
    repeatCount: 1,
    targetInput: '',
  });

  assert.deepEqual(
    targets.map((target) => target.aliasNames[0]),
    ['scan-cold', 'scan-cached', 'scan-add-album', 'scan-metadata', 'scan-page']
  );
  assert.equal(targets.length, 5);
});

test('resolveRequestedTargets rejects the removed scanner-index-cache group alias', () => {
  assert.throws(() => _private.resolveRequestedTargets({
    browser: null,
    grep: '',
    group: 'scanner-index-cache',
    headless: true,
    repeatCount: 1,
    targetInput: '',
  }), /Unsupported performance group: scanner-index-cache/);
});

test('resolvePerformanceTarget rejects the removed scan-performance single-target alias', () => {
  assert.throws(
    () => _private.resolvePerformanceTarget('scan-performance'),
    /Unsupported performance spec path: scan-performance/
  );
});

test('resolveRequestedTargets can limit the run to the real-app group', () => {
  const targets = _private.resolveRequestedTargets({
    browser: null,
    grep: '',
    group: 'real-app',
    headless: true,
    repeatCount: 1,
    targetInput: '',
  });

  assert.deepEqual(
    targets.map((target) => target.aliasNames[0]),
    [
      'all-artists',
      'artist-family',
      'search-all-artists',
      'utility-problematic-files',
      'utility-rules',
      'selected-artist',
      'search-browse',
      'root-album-browse',
      'app-open-all-artists',
      'problematic-files-focused',
      'rules-focused',
    ]
  );
  assert.equal(targets.length, 11);
});

test('resolveRequestedTargets can limit the run to the idle-memory group', () => {
  const targets = _private.resolveRequestedTargets({
    browser: null,
    grep: '',
    group: 'idle-memory',
    headless: true,
    repeatCount: 1,
    targetInput: '',
  });

  assert.deepEqual(
    targets.map((target) => target.aliasNames[0]),
    ['idle-memory']
  );
});

test('resolveRequestedTargets can limit the run to the playback-start group', () => {
  const targets = _private.resolveRequestedTargets({
    browser: null,
    grep: '',
    group: 'playback-start',
    headless: true,
    repeatCount: 1,
    targetInput: '',
  });

  assert.deepEqual(targets.map((target) => target.aliasNames[0]), ['playback-start']);
});

test('resolveRequestedTargets can limit the run to the gapless-playback group', () => {
  const targets = _private.resolveRequestedTargets({
    browser: null,
    grep: '',
    group: 'gapless-playback',
    headless: true,
    repeatCount: 1,
    targetInput: '',
  });

  assert.deepEqual(targets.map((target) => target.aliasNames[0]), ['gapless-playback']);
});

test('printUsage advertises the playback-start target, group, and coverage class', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    _private.printUsage();
  } finally {
    console.log = originalLog;
  }
  const output = lines.join('\n');
  assert.match(output, /--group all\|idle-memory\|playback-start\|gapless-playback\|real-app\|scan/);
  assert.match(output, /Known names: idle-memory, playback-start, gapless-playback,/);
  assert.match(output, /Known groups: all, idle-memory, playback-start, gapless-playback, real-app, scan/);
  assert.match(output, /real-app-isolated-postgres-playback/);
});

test('summarizePerformanceTargets exposes the Phase 6 coverage classifications', () => {
  const summary = _private.summarizePerformanceTargets(
    Object.values(performanceRunner.PERFORMANCE_TARGETS)
  );
  const classesByTarget = Object.fromEntries(
    summary.map((target) => [target.name, target.coverageClass])
  );

  assert.equal(classesByTarget['idle-memory'], 'real-app-isolated-postgres-memory');
  assert.equal(classesByTarget['playback-start'], 'real-app-isolated-postgres-playback');
  assert.equal(classesByTarget['gapless-playback'], 'real-app-isolated-postgres-playback');
  assert.equal(classesByTarget['all-artists'], 'real-app-library-browse-load');
  assert.equal(classesByTarget['artist-family'], 'real-app-library-browse-load');
  assert.equal(classesByTarget['search-all-artists'], 'real-app-library-browse-load');
  assert.equal(classesByTarget['utility-problematic-files'], 'real-app-library-browse-load');
  assert.equal(classesByTarget['utility-rules'], 'real-app-library-browse-load');
  assert.equal(classesByTarget['selected-artist'], 'real-app-library-browse-load');
  assert.equal(classesByTarget['search-browse'], 'real-app-library-browse-load');
  assert.equal(classesByTarget['root-album-browse'], 'real-app-library-browse-load');
  assert.equal(classesByTarget['app-open-all-artists'], 'real-app-library-browse-load');
  assert.equal(classesByTarget['problematic-files-focused'], 'real-app-library-browse-load');
  assert.equal(classesByTarget['rules-focused'], 'real-app-library-browse-load');
  assert.equal(classesByTarget['scan-cold'], 'scanner-index-cache');
  assert.equal(classesByTarget['scan-cached'], 'scanner-index-cache');
  assert.equal(classesByTarget['scan-add-album'], 'scanner-index-cache');
  assert.equal(classesByTarget['scan-metadata'], 'scanner-index-cache');
  assert.equal(classesByTarget['scan-page'], 'scanner-index-cache');
  assert.equal(summary.filter((target) => target.coverageClass === 'real-app-library-browse-load').length, 11);
});

test('idle-memory preserves its report contract while using the isolated Postgres target class', () => {
  const target = performanceRunner.PERFORMANCE_TARGETS['idle-memory'];

  assert.equal(target.kind, 'isolated');
  assert.equal(target.coverageClass, 'real-app-isolated-postgres-memory');
  assert.equal(target.reportId, 'idleMemory');
  assert.equal(target.casePattern, 'FTC-GALLERY-STARTUP-005');
  assert.deepEqual(target.aliasNames, ['idle-memory', 'idle', 'memory']);
  assert.equal(target.specPath, 'tests/e2e/performance/idleMemory.spec.js');
  assert.deepEqual(
    _private.groupBatchesForFullSuiteBudgets([target]).map((group) => group.key),
    ['idle-memory'],
  );
});

test('performance runner help advertises the isolated Postgres memory class', () => {
  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, '..', '..', 'scripts', 'run-performance-playwright.cjs'), '--group', 'unsupported'],
    { encoding: 'utf8' },
  );
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;

  assert.equal(result.status, 1);
  assert.match(output, /real-app-isolated-postgres-memory/);
  assert.doesNotMatch(output, /fake-library-memory/);
});

test('playback-start preserves its generated-media isolated Postgres contract', () => {
  const target = performanceRunner.PERFORMANCE_TARGETS['playback-start'];

  assert.equal(target.kind, 'isolated');
  assert.equal(target.coverageClass, 'real-app-isolated-postgres-playback');
  assert.equal(target.reportId, 'playbackStart');
  assert.equal(target.casePattern, 'FTC-PLAYER-013');
  assert.equal(target.specPath, 'tests/e2e/performance/playbackStart.spec.js');
});

test('gapless-playback preserves its generated-media isolated Postgres contract', () => {
  const target = performanceRunner.PERFORMANCE_TARGETS['gapless-playback'];

  assert.equal(target.kind, 'isolated');
  assert.equal(target.coverageClass, 'real-app-isolated-postgres-playback');
  assert.equal(target.reportId, 'gaplessPlayback');
  assert.equal(target.casePattern, 'FTC-PLAYER-016');
  assert.equal(target.specPath, 'tests/e2e/performance/gaplessPlayback.spec.js');
});

test('performance runner help documents managed Chromium as the browser default', () => {
  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, '..', '..', 'scripts', 'run-performance-playwright.cjs'), '--help'],
    { encoding: 'utf8' },
  );
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /--browser chromium\|chrome\|edge/);
  assert.match(output, /defaults? to Playwright-managed Chromium/i);
});

test('performance runner forwards managed Chromium by default without changing worker or timeout contracts', () => {
  for (const targetInput of ['all-artists', 'scan-cold']) {
    const args = _private.buildRunnerArgs({
      browser: 'chromium',
      grep: '',
      group: 'all',
      headless: true,
      repeatCount: 1,
      targetInput,
    });

    assert.equal(args.includes('--browser=chromium'), true, targetInput);
    assert.equal(args.includes('--workers=1'), true, targetInput);
    assert.equal(args.includes('--timeout=240000'), true, targetInput);
  }
});

test('buildRunnerArgs maps idle-memory to the isolated Playwright performance run', () => {
  const args = _private.buildRunnerArgs({
    browser: null,
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'idle-memory',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/performance/idleMemory.spec.js',
    '-c',
    'playwright.performance.config.cjs',
    '--project=idle-memory',
    '--browser=chromium',
    '--headless',
    '--grep=(FTC-OPS-019|FTC-GALLERY-STARTUP-005)',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs maps playback-start to the isolated Playwright performance run', () => {
  const args = _private.buildRunnerArgs({
    browser: null,
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'playback-start',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/performance/playbackStart.spec.js',
    '-c',
    'playwright.performance.config.cjs',
    '--project=idle-memory',
    '--browser=chromium',
    '--headless',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs maps gapless-playback to the isolated Playwright performance run', () => {
  const args = _private.buildRunnerArgs({
    browser: null,
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'gapless-playback',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/performance/gaplessPlayback.spec.js',
    '-c',
    'playwright.performance.config.cjs',
    '--project=idle-memory',
    '--browser=chromium',
    '--headless',
    '--grep=(FTC-PLAYER-016|FTC-PLAYER-013 immediate Album Details replacement)',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs maps a real-data target path to the managed real-app contract', () => {
  const args = _private.buildRunnerArgs({
    browser: 'edge',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'tests/e2e/syntheticLargeLibrary/artistFamilyResponsiveness.spec.js',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/syntheticLargeLibrary/artistFamilyResponsiveness.spec.js',
    '-c',
    'playwright.synthetic-large-library.config.cjs',
    '--real-app-port=5001',
    '--browser=edge',
    '--headless',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs maps the broad All Artists target to the real app runner', () => {
  const args = _private.buildRunnerArgs({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'all-artists',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/syntheticLargeLibrary/allArtistsResponsiveness.spec.js',
    '-c',
    'playwright.synthetic-large-library.config.cjs',
    '--real-app-port=5001',
    '--browser=chrome',
    '--headless',
    '--grep=FTC-GALLERY-STARTUP-005A',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs maps the selected-artist target to the real app runner', () => {
  const args = _private.buildRunnerArgs({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'selected-artist',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/syntheticLargeLibrary/selectedArtist.spec.js',
    '-c',
    'playwright.synthetic-large-library.config.cjs',
    '--real-app-port=5001',
    '--browser=chrome',
    '--headless',
    '--grep=FTC-GALLERY-STARTUP-005Q',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs maps the search browse target to the real app runner', () => {
  const args = _private.buildRunnerArgs({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'search-browse',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/syntheticLargeLibrary/searchBrowse.spec.js',
    '-c',
    'playwright.synthetic-large-library.config.cjs',
    '--real-app-port=5001',
    '--browser=chrome',
    '--headless',
    '--grep=FTC-GALLERY-STARTUP-005R',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs maps the broad search-scoped All Artists target to the real app runner', () => {
  const args = _private.buildRunnerArgs({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'search-all-artists',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/syntheticLargeLibrary/allArtistsResponsiveness.spec.js',
    '-c',
    'playwright.synthetic-large-library.config.cjs',
    '--real-app-port=5001',
    '--browser=chrome',
    '--headless',
    '--grep=FTC-SEARCH-NAV-003A',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs maps the root album browse target to the real app runner', () => {
  const args = _private.buildRunnerArgs({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'root-album-browse',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/syntheticLargeLibrary/rootAlbumBrowse.spec.js',
    '-c',
    'playwright.synthetic-large-library.config.cjs',
    '--real-app-port=5001',
    '--browser=chrome',
    '--headless',
    '--grep=FTC-GALLERY-STARTUP-005S',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs maps the app-open All Artists target to the real app runner', () => {
  const args = _private.buildRunnerArgs({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'app-open-all-artists',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/syntheticLargeLibrary/appOpenAllArtists.spec.js',
    '-c',
    'playwright.synthetic-large-library.config.cjs',
    '--real-app-port=5001',
    '--browser=chrome',
    '--headless',
    '--grep=FTC-GALLERY-STARTUP-005T',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs maps the broad utility problematic-files target to the real app runner', () => {
  const args = _private.buildRunnerArgs({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'utility-problematic-files',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/utilityProblematicFiles/utilitiesResponsiveness.spec.js',
    '-c',
    'playwright.utility-problematic-files.config.cjs',
    '--real-app-port=5001',
    '--browser=chrome',
    '--headless',
    '--grep=FTC-UTIL-PROBLEMS-009',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs maps the focused utility problematic-files target to the real app runner', () => {
  const args = _private.buildRunnerArgs({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'problematic-files-focused',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/utilityProblematicFiles/utilityProblematicFiles.spec.js',
    '-c',
    'playwright.utility-problematic-files.config.cjs',
    '--real-app-port=5001',
    '--browser=chrome',
    '--headless',
    '--grep=FTC-UTIL-PROBLEMS-010',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs maps the broad utility rules target to the real app runner', () => {
  const args = _private.buildRunnerArgs({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'utility-rules',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/syntheticLargeLibrary/utilitiesResponsiveness.spec.js',
    '-c',
    'playwright.synthetic-large-library.config.cjs',
    '--real-app-port=5001',
    '--browser=chrome',
    '--headless',
    '--grep=FTC-UTIL-RULES-002',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs maps the focused utility rules target to the real app runner', () => {
  const args = _private.buildRunnerArgs({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'rules-focused',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/syntheticLargeLibrary/utilityRules.spec.js',
    '-c',
    'playwright.synthetic-large-library.config.cjs',
    '--real-app-port=5001',
    '--browser=chrome',
    '--headless',
    '--grep=FTC-UTIL-RULES-002P',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildRunnerArgs preserves search browse target metadata when selected by spec path', () => {
  const target = _private.resolvePerformanceTarget('tests/e2e/syntheticLargeLibrary/searchBrowse.spec.js');

  assert.equal(target.aliasNames[0], 'search-browse');
  assert.deepEqual(target.env, REAL_APP_ENV);
});

test('buildRunnerArgs preserves artist-family target metadata when selected by spec path', () => {
  const target = _private.resolvePerformanceTarget('tests/e2e/syntheticLargeLibrary/artistFamilyResponsiveness.spec.js');

  assert.equal(target.aliasNames[0], 'artist-family');
  assert.deepEqual(target.env, REAL_APP_ENV);
});

test('buildRunnerArgs preserves selected-artist target metadata when selected by spec path', () => {
  const target = _private.resolvePerformanceTarget('tests/e2e/syntheticLargeLibrary/selectedArtist.spec.js');

  assert.equal(target.aliasNames[0], 'selected-artist');
  assert.deepEqual(target.env, REAL_APP_ENV);
  assert.deepEqual(target.casePatterns, [
    'Selected artist UI reports library_browse telemetry and timing',
    'FTC-ARTIST-FAMILY-004 keeps the IR8 / Sexoturica split release in the Devin Townsend family',
  ]);
  assert.equal(target.metricCasePattern, 'Selected artist UI reports library_browse telemetry and timing');
});

test('buildRunnerArgs preserves root album browse target metadata when selected by spec path', () => {
  const target = _private.resolvePerformanceTarget('tests/e2e/syntheticLargeLibrary/rootAlbumBrowse.spec.js');

  assert.equal(target.aliasNames[0], 'root-album-browse');
  assert.deepEqual(target.env, REAL_APP_ENV);
});

test('buildRunnerArgs preserves app-open All Artists target metadata when selected by spec path', () => {
  const target = _private.resolvePerformanceTarget('tests/e2e/syntheticLargeLibrary/appOpenAllArtists.spec.js');

  assert.equal(target.aliasNames[0], 'app-open-all-artists');
  assert.deepEqual(target.env, REAL_APP_ENV);
});

test('buildRunnerArgs preserves focused utility problematic-files target metadata when selected by spec path', () => {
  const target = _private.resolvePerformanceTarget('tests/e2e/utilityProblematicFiles/utilityProblematicFiles.spec.js');

  assert.equal(target.aliasNames[0], 'problematic-files-focused');
  assert.deepEqual(target.env, FOCUSED_PROBLEMATIC_FILES_REAL_APP_ENV);
});

test('buildRunnerArgs preserves focused utility rules target metadata when selected by spec path', () => {
  const target = _private.resolvePerformanceTarget('tests/e2e/syntheticLargeLibrary/utilityRules.spec.js');

  assert.equal(target.aliasNames[0], 'rules-focused');
  assert.deepEqual(target.env, REAL_APP_ENV);
});

test('every real-app target forces the browse selector', () => {
  for (const targetName of REAL_APP_TARGETS) {
    const target = performanceRunner.PERFORMANCE_TARGETS[targetName];
    assert.equal(target.coverageClass, 'real-app-library-browse-load');
    assert.deepEqual(
      target.env,
      targetName === 'problematic-files-focused'
        ? FOCUSED_PROBLEMATIC_FILES_REAL_APP_ENV
        : targetName === 'utility-problematic-files'
          ? BROAD_UTILITY_PROBLEMATIC_FILES_REAL_APP_ENV
          : REAL_APP_ENV
    );
  }
});

test('broad All Artists target forces the Postgres browse selector', () => {
  assert.deepEqual(
    performanceRunner.PERFORMANCE_TARGETS['all-artists'].env,
    REAL_APP_ENV
  );
});

test('broad search All Artists target forces the Postgres browse selector', () => {
  assert.deepEqual(
    performanceRunner.PERFORMANCE_TARGETS['search-all-artists'].env,
    REAL_APP_ENV
  );
});

test('artist-family target forces Postgres browse without pre-app artist-family seed setup', () => {
  assert.deepEqual(
    performanceRunner.PERFORMANCE_TARGETS['artist-family'].env,
    REAL_APP_ENV
  );
});

test('broad utility problematic-files target forces the Postgres browse selector', () => {
  assert.deepEqual(
    performanceRunner.PERFORMANCE_TARGETS['utility-problematic-files'].env,
    BROAD_UTILITY_PROBLEMATIC_FILES_REAL_APP_ENV
  );
});

test('both Problematic Files targets select the dedicated fixture profile', () => {
  const profiledTargets = Object.entries(performanceRunner.PERFORMANCE_TARGETS)
    .filter(([, target]) => target.env?.ALBUM_HAVEN_E2E_FIXTURE_PROFILE)
    .map(([targetName, target]) => [
      targetName,
      target.env.ALBUM_HAVEN_E2E_FIXTURE_PROFILE,
    ]);

  assert.deepEqual(profiledTargets, [
    ['utility-problematic-files', 'utility-problematic-files'],
    ['problematic-files-focused', 'utility-problematic-files'],
  ]);
});

test('broad utility rules target forces the Postgres browse selector', () => {
  assert.deepEqual(
    performanceRunner.PERFORMANCE_TARGETS['utility-rules'].env,
    REAL_APP_ENV
  );
});

test('selected-artist target forces the browse selector', () => {
  assert.deepEqual(
    performanceRunner.PERFORMANCE_TARGETS['selected-artist'].env,
    REAL_APP_ENV
  );
});

test('search browse target forces the browse selector', () => {
  assert.deepEqual(
    performanceRunner.PERFORMANCE_TARGETS['search-browse'].env,
    REAL_APP_ENV
  );
});

test('root album browse target forces the browse selector', () => {
  assert.deepEqual(
    performanceRunner.PERFORMANCE_TARGETS['root-album-browse'].env,
    REAL_APP_ENV
  );
});

test('app-open All Artists target forces the browse selector', () => {
  assert.deepEqual(
    performanceRunner.PERFORMANCE_TARGETS['app-open-all-artists'].env,
    REAL_APP_ENV
  );
});

test('focused utility problematic-files target forces the browse selector', () => {
  assert.deepEqual(
    performanceRunner.PERFORMANCE_TARGETS['problematic-files-focused'].env,
    FOCUSED_PROBLEMATIC_FILES_REAL_APP_ENV
  );
});

test('focused utility rules target forces the browse selector', () => {
  assert.deepEqual(
    performanceRunner.PERFORMANCE_TARGETS['rules-focused'].env,
    REAL_APP_ENV
  );
});

test('applyTargetEnvOverrides merges the target-specific env overrides', () => {
  const merged = _private.applyTargetEnvOverrides(
    {
      KEEP_ME: '1',
    },
    FOCUSED_PROBLEMATIC_FILES_REAL_APP_ENV,
  );

  assert.equal(merged.ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE, 'postgres');
  assert.equal(merged.PLAYWRIGHT_ISOLATED_LIBRARY_APP, '1');
  assert.equal(merged.ALBUM_HAVEN_E2E_PROBLEMATIC_SEED_KEY, undefined);
  assert.equal(merged.KEEP_ME, '1');
});

test('synthetic targets keep inherited owner runtime selectors explicitly blank through nested dotenv loading', () => {
  const overrides = _private.buildSyntheticFixtureIsolationEnv(
    performanceRunner.PERFORMANCE_TARGETS['app-open-all-artists'],
  );
  const env = _private.applyTargetEnvOverrides({
    MUSIC_DIR: 'C:\\Users\\owner\\Music',
    MUSIC_APP_DATA_DIR: 'C:\\Users\\owner\\AppData',
    MUSIC_CACHE_PATH: 'C:\\Users\\owner\\library-cache.json',
    MUSIC_COVER_CACHE_PATH: 'C:\\Users\\owner\\cover-cache.json',
    MUSIC_LIBRARY_ROOTS_PATH: 'C:\\Users\\owner\\library-roots.json',
    PLAYWRIGHT_REAL_APP_URL: 'https://owner-library.example.test',
  }, overrides);

  for (const name of [
    'MUSIC_DIR',
    'MUSIC_APP_DATA_DIR',
    'MUSIC_CACHE_PATH',
    'MUSIC_COVER_CACHE_PATH',
    'MUSIC_LIBRARY_ROOTS_PATH',
    'PLAYWRIGHT_REAL_APP_URL',
  ]) {
    assert.equal(env[name], '', name);
  }
});

test('one-off synthetic performance launch strips owner paths before spawning the managed runner', (t) => {
  usePreloadedFixtureEnv(t, 'app-open-all-artists');
  assert.equal(typeof _private.runSinglePerformanceAttempt, 'function');

  const inheritedNames = [
    'MUSIC_DIR',
    'MUSIC_APP_DATA_DIR',
    'MUSIC_CACHE_PATH',
    'MUSIC_COVER_CACHE_PATH',
    'MUSIC_LIBRARY_ROOTS_PATH',
    'PLAYWRIGHT_REAL_APP_URL',
  ];
  const previousEnvironment = new Map(
    inheritedNames.map((name) => [name, process.env[name]]),
  );
  for (const name of inheritedNames) {
    process.env[name] = `C:\\Users\\owner\\${name}`;
  }

  const originalSpawnSync = childProcess.spawnSync;
  let launched = null;
  childProcess.spawnSync = (command, args, options) => {
    if (command === FAKE_PERFORMANCE_PYTHON) {
      return { error: null, status: 0, stdout: '', stderr: '' };
    }
    launched = { command, args, options };
    return { error: null, status: 1, stdout: '', stderr: '' };
  };
  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const target = performanceRunner.PERFORMANCE_TARGETS['app-open-all-artists'];
  const verificationGroup = _private.buildVerificationGroup(target, {
    repeatCount: 1,
  });
  _private.runSinglePerformanceAttempt(
    target,
    {
      browser: 'chrome',
      headless: true,
      realAppPort: 5123,
      testTimeoutMs: 120000,
    },
    verificationGroup,
    1,
    { realAppPort: 5123, scanAppPort: 4174 },
  );

  assert.ok(launched, 'expected the one-off target to spawn run-playwright');
  assert.ok(launched.args.includes('--real-app-port=5123'));
  for (const name of inheritedNames) {
    assert.equal(launched.options.env[name], '', name);
  }
});

test('parseCliArgs rejects the CI timing contract outside trusted PR Actions provenance', (t) => {
  const originalActions = process.env.GITHUB_ACTIONS;
  const originalEvent = process.env.GITHUB_EVENT_NAME;
  t.after(() => {
    if (originalActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalActions;
    if (originalEvent === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = originalEvent;
  });

  delete process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_EVENT_NAME;
  assert.throws(
    () => _private.parseCliArgs(['--performance-contract=ci']),
    /trusted GitHub Actions pull_request run/i,
  );

  process.env.GITHUB_ACTIONS = 'true';
  process.env.GITHUB_EVENT_NAME = 'pull_request';
  const parsed = _private.parseCliArgs(['--performance-contract=ci']);
  assert.equal(parsed.selectedContract, 'ci');
  assert.equal(parsed.trustedCi, true);
});

test('configured suite forwards shard-owned real-app and scan base ports after dotenv loading', () => {
  let receivedOptions = null;
  const exitCode = _private.runConfiguredPerformanceSuite(
    {
      browser: 'chrome',
      group: 'all',
      headless: true,
      repeatCount: 1,
      targetInput: 'playback-start',
    },
    {
      ALBUM_HAVEN_FIXTURE_PROFILE: 'playback-media',
      PLAYWRIGHT_REAL_APP_PORT: '4333',
      PLAYWRIGHT_PORT: '4334',
    },
    {
      loadEnv: (baseEnv) => baseEnv,
      runDatabasePreflight: () => {},
      runSuite: (options) => {
        receivedOptions = options;
        return 0;
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(receivedOptions.realAppBasePort, 4333);
  assert.equal(receivedOptions.scanAppBasePort, 4334);
});

test('configured suite preserves non-enumerable trusted CI timing policy fields', () => {
  let receivedOptions = null;
  const args = {
    browser: 'chrome',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'playback-start',
  };
  Object.defineProperty(args, 'selectedContract', {
    value: 'ci',
    enumerable: false,
  });
  Object.defineProperty(args, 'trustedCi', {
    value: true,
    enumerable: false,
  });

  const exitCode = _private.runConfiguredPerformanceSuite(
    args,
    { ALBUM_HAVEN_FIXTURE_PROFILE: 'playback-media' },
    {
      loadEnv: (baseEnv) => baseEnv,
      runDatabasePreflight: () => {},
      runSuite: (options) => {
        receivedOptions = options;
        return 0;
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(receivedOptions.selectedContract, 'ci');
  assert.equal(receivedOptions.trustedCi, true);
});

test('buildScanStatusSamplesEnv uses a cross-process nonce for identical attempt coordinates', () => {
  const target = performanceRunner.PERFORMANCE_TARGETS['scan-cold'];
  const first = _private.buildScanStatusSamplesEnv(target, 4174, 1).ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH;
  const second = _private.buildScanStatusSamplesEnv(target, 4174, 1).ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH;
  try {
    assert.notEqual(first, second);
    assert.match(first, /attempt-1-[0-9a-f-]{36}\.jsonl$/);
    assert.match(second, /attempt-1-[0-9a-f-]{36}\.jsonl$/);
  } finally {
    fs.rmSync(first, { force: true });
    fs.rmSync(second, { force: true });
  }
});

test('scan status sample file is removed when the Playwright attempt throws', (t) => {
  const originalSpawnSync = childProcess.spawnSync;
  let samplesPath = '';
  childProcess.spawnSync = (_command, _args, options) => {
    samplesPath = options.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH;
    fs.writeFileSync(samplesPath, '{"status":{}}\n', 'utf8');
    return { error: new Error('spawn failed'), status: null };
  };
  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
  });

  assert.throws(
    () => _private.runSequentialPerformanceSuite({
      browser: 'chrome',
      grep: '',
      group: 'all',
      headless: true,
      repeatCount: 1,
      targetInput: 'scan-cold',
    }),
    /spawn failed/,
  );
  assert.ok(samplesPath);
  assert.equal(fs.existsSync(samplesPath), false);
});

test('non-scan single-target runs preserve an inherited scan status sample path', (t) => {
  usePreloadedFixtureEnv(t, 'idle-memory');
  const originalSpawnSync = childProcess.spawnSync;
  const originalSamplesPath = process.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH;
  const finalizedOutput = installFinalizedPassingPerformanceEvidence(t);
  const inheritedPath = path.join(__dirname, '..', '..', '.tmp', 'inherited-single-scan-status.jsonl');
  fs.mkdirSync(path.dirname(inheritedPath), { recursive: true });
  fs.writeFileSync(inheritedPath, '{"inherited":true}\n', 'utf8');
  process.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH = inheritedPath;
  childProcess.spawnSync = (command, _args, options) => {
    assert.equal(options.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH, inheritedPath);
    if (command === FAKE_PERFORMANCE_PYTHON) {
      return { error: null, status: 0, stdout: '', stderr: '' };
    }
    return { error: null, status: 0, stdout: finalizedOutput(options), stderr: '' };
  };
  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
    if (originalSamplesPath === undefined) {
      delete process.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH;
    } else {
      process.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH = originalSamplesPath;
    }
    fs.rmSync(inheritedPath, { force: true });
  });

  const exitCode = _private.runSequentialPerformanceSuite({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'idle-memory',
  });

  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(inheritedPath), true);
});

test('non-scan batch runs preserve an inherited scan status sample path', (t) => {
  usePreloadedFixtureEnv(t, 'idle-memory');
  const originalSpawnSync = childProcess.spawnSync;
  const originalSamplesPath = process.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH;
  const finalizedOutput = installFinalizedPassingPerformanceEvidence(t);
  const inheritedPath = path.join(__dirname, '..', '..', '.tmp', 'inherited-batch-scan-status.jsonl');
  fs.mkdirSync(path.dirname(inheritedPath), { recursive: true });
  fs.writeFileSync(inheritedPath, '{"inherited":true}\n', 'utf8');
  process.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH = inheritedPath;
  childProcess.spawnSync = (command, _args, options) => {
    assert.equal(options.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH, inheritedPath);
    if (command === FAKE_PERFORMANCE_PYTHON) {
      return { error: null, status: 0, stdout: '', stderr: '' };
    }
    return { error: null, status: 0, stdout: finalizedOutput(options), stderr: '' };
  };
  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
    if (originalSamplesPath === undefined) {
      delete process.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH;
    } else {
      process.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH = originalSamplesPath;
    }
    fs.rmSync(inheritedPath, { force: true });
  });

  const exitCode = _private.runSequentialPerformanceSuite({
    browser: 'chrome',
    grep: '',
    group: 'idle-memory',
    headless: true,
    repeatCount: 1,
    targetInput: '',
  });

  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(inheritedPath), true);
});

test('managed batch scan status sample file is removed when the Playwright attempt throws', (t) => {
  const originalSpawnSync = childProcess.spawnSync;
  let samplesPath = '';
  childProcess.spawnSync = (_command, _args, options) => {
    samplesPath = options.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH;
    fs.writeFileSync(samplesPath, '{"status":{}}\n', 'utf8');
    return { error: new Error('batch spawn failed'), status: null };
  };
  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
  });

  assert.throws(
    () => _private.runSequentialPerformanceSuite({
      browser: 'chrome',
      grep: '',
      group: 'scan',
      headless: true,
      repeatCount: 1,
      targetInput: '',
    }),
    /batch spawn failed/,
  );
  assert.ok(samplesPath);
  assert.equal(fs.existsSync(samplesPath), false);
});

test('scan status cleanup refuses paths outside its managed root', () => {
  const outsidePath = path.join(__dirname, '..', '..', '.tmp', 'unmanaged-scan-status.jsonl');
  fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
  fs.writeFileSync(outsidePath, '{"managed":false}\n', 'utf8');
  try {
    _private.cleanupManagedScanStatusSamples({
      ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH: outsidePath,
    });
    assert.equal(fs.existsSync(outsidePath), true);
  } finally {
    fs.rmSync(outsidePath, { force: true });
  }
});

test('resolveManagedRealAppAttemptPort keeps retries inside a target-specific real-app port block', () => {
  assert.equal(_private.resolveManagedRealAppAttemptPort(5001, 1), 5001);
  assert.equal(_private.resolveManagedRealAppAttemptPort(5001, 2), 5002);
  assert.equal(_private.resolveManagedRealAppAttemptPort(5011, 3), 5013);
});

test('managed real-app port blocks skip browser-unsafe ports', () => {
  assert.equal(_private.isKnownUnsafeBrowserPort(5061), true);
  assert.equal(_private.isKnownUnsafeBrowserPort(5071), false);
  assert.equal(_private.managedRealAppPortBlockHasUnsafeBrowserPort(5051), true);
  assert.equal(_private.managedRealAppPortBlockHasUnsafeBrowserPort(5061), true);
  assert.equal(_private.managedRealAppPortBlockHasUnsafeBrowserPort(5071), false);
});

test('buildRunnerArgs keeps repeat-count orchestration in the performance runner instead of Playwright repeat-each', () => {
  const args = _private.buildRunnerArgs({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 3,
    targetInput: 'search-browse',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/syntheticLargeLibrary/searchBrowse.spec.js',
    '-c',
    'playwright.synthetic-large-library.config.cjs',
    '--real-app-port=5001',
    '--browser=chrome',
    '--headless',
    '--grep=FTC-GALLERY-STARTUP-005R',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('buildAggregatedThresholdEvaluation fails repeated evidence when any attempt misses its threshold', () => {
  const summary = _private.buildAggregatedThresholdEvaluation([
    {
      status: 0,
      validationResults: [
        { key: 'selectedArtistGalleryMs', units: 'ms', actual: 1800, allowedMaximum: 3200, allowedText: '3200 ms', passed: true },
      ],
    },
    {
      validationResults: [
        { key: 'selectedArtistGalleryMs', units: 'ms', actual: 1900, allowedMaximum: 3200, allowedText: '3200 ms', passed: true },
      ],
    },
    {
      validationResults: [
        { key: 'selectedArtistGalleryMs', units: 'ms', actual: 5000, allowedMaximum: 3200, allowedText: '3200 ms', passed: false },
      ],
    },
    {
      validationResults: [
        { key: 'selectedArtistGalleryMs', units: 'ms', actual: 2000, allowedMaximum: 3200, allowedText: '3200 ms', passed: true },
      ],
    },
    {
      validationResults: [
        { key: 'selectedArtistGalleryMs', units: 'ms', actual: 2100, allowedMaximum: 3200, allowedText: '3200 ms', passed: true },
      ],
    },
  ].map((record, index) => ({ ...record, status: index === 2 ? 1 : 0 })));

  assert.equal(summary.passed, false);
  assert.equal(summary.metrics[0].medianActual, 2000);
  assert.equal(summary.metrics[0].passCount, 0);
  assert.equal(summary.metrics[0].reportedPassCount, 4);
  assert.equal(summary.metrics[0].requiredPassCount, 5);
});

test('buildAggregatedThresholdEvaluation fails when the median stays outside the allowed bound', () => {
  const summary = _private.buildAggregatedThresholdEvaluation([
    {
      validationResults: [
        { key: 'rulesReadyMs', units: 'ms', actual: 5200, allowedMaximum: 5000, allowedText: '5000 ms', passed: false },
      ],
    },
    {
      validationResults: [
        { key: 'rulesReadyMs', units: 'ms', actual: 5300, allowedMaximum: 5000, allowedText: '5000 ms', passed: false },
      ],
    },
    {
      validationResults: [
        { key: 'rulesReadyMs', units: 'ms', actual: 5100, allowedMaximum: 5000, allowedText: '5000 ms', passed: false },
      ],
    },
    {
      validationResults: [
        { key: 'rulesReadyMs', units: 'ms', actual: 4900, allowedMaximum: 5000, allowedText: '5000 ms', passed: true },
      ],
    },
    {
      validationResults: [
        { key: 'rulesReadyMs', units: 'ms', actual: 4800, allowedMaximum: 5000, allowedText: '5000 ms', passed: true },
      ],
    },
  ]);

  assert.equal(summary.passed, false);
  assert.equal(summary.failedMetrics.length, 1);
  assert.equal(summary.failedMetrics[0].medianActual, 5100);
});

test('buildAggregatedThresholdEvaluation reports grace use without relabeling the target', () => {
  const summary = _private.buildAggregatedThresholdEvaluation([1, 2, 3].map(() => ({
    status: 0,
    validationResults: [{
      key: 'selectedArtistSelectionMs',
      units: 'ms',
      actual: 399,
      targetMaximum: 350,
      graceMs: 200,
      allowedMaximum: 550,
      passed: true,
    }],
  })));

  assert.equal(summary.passed, true);
  assert.equal(summary.metrics[0].medianActual, 399);
  assert.equal(summary.metrics[0].targetMaximum, 350);
  assert.equal(summary.metrics[0].allowedMaximum, 550);
  assert.equal(summary.metrics[0].performanceStatus, 'grace-used');
  assert.equal(summary.metrics[0].graceUsed, true);
});

test('buildAggregatedThresholdEvaluation fails closed for missing and non-finite observations', () => {
  for (const invalidActual of [undefined, null, '', Number.NaN, Number.POSITIVE_INFINITY]) {
    const summary = _private.buildAggregatedThresholdEvaluation([
      {
        status: 0,
        validationResults: [
          { key: 'problematicReadyMs', units: 'ms', actual: 700, allowedMaximum: 1200, passed: true },
        ],
      },
      {
        status: 0,
        validationResults: [
          { key: 'problematicReadyMs', units: 'ms', actual: invalidActual, allowedMaximum: 1200, passed: true },
        ],
      },
    ]);
    assert.equal(summary.passed, false);
    assert.equal(summary.metrics[0].actuals.length, 1);
    assert.equal(summary.metrics[0].passCount, 0);
    assert.equal(summary.metrics[0].reportedPassCount, 1);
  }

  const emptySummary = _private.buildAggregatedThresholdEvaluation([
    { status: 0, validationResults: [] },
    { status: 0, validationResults: [] },
  ]);
  assert.equal(emptySummary.passed, false);
  assert.deepEqual(emptySummary.metrics, []);
});

test('buildAggregatedThresholdEvaluation fails closed on effective-ceiling and sample-window policy drift', () => {
  const timingResult = (overrides = {}) => ({
    key: 'selectionMs',
    units: 'ms',
    actual: 300,
    targetMaximum: 350,
    graceMs: 200,
    hardCeiling: 550,
    allowedMaximum: 550,
    passed: true,
    performanceStatus: 'target-met',
    ...overrides,
  });
  const aggregate = (results) => _private.buildAggregatedThresholdEvaluation(
    results.map((result) => ({ status: 0, validationResults: [result] })),
  );

  const ceilingDrift = aggregate([
    timingResult(),
    timingResult({ hardCeiling: 600, allowedMaximum: 600 }),
  ]);
  const ceilingDisagreement = aggregate([
    timingResult({ hardCeiling: 550, allowedMaximum: 600 }),
    timingResult({ hardCeiling: 550, allowedMaximum: 600 }),
  ]);
  const graceDrift = aggregate([
    timingResult(),
    timingResult({ graceMs: 250 }),
  ]);
  const invalidGraceContract = aggregate([
    timingResult({ graceMs: 100 }),
    timingResult({ graceMs: 100 }),
  ]);
  const memoryResult = (failingSampleCount) => ({
    key: 'allArtistsReturnMemoryBytes',
    units: 'bytes',
    actual: 1025,
    hardCeiling: 1024,
    allowedMaximum: 1024,
    passed: true,
    performanceStatus: 'hard-fail',
    classificationPolicy: 'all-artists-return-memory-sample-window',
    sampleCount: 3,
    overThresholdCount: 1,
    failingSampleCount,
  });
  const policyDrift = aggregate([memoryResult(2), memoryResult(3)]);
  assert.deepEqual({
    ceilingDrift: {
      passed: ceilingDrift.passed,
      contractConsistent: ceilingDrift.metrics[0].contractConsistent,
    },
    ceilingDisagreement: {
      passed: ceilingDisagreement.passed,
      passCount: ceilingDisagreement.metrics[0].passCount,
    },
    graceDrift: {
      passed: graceDrift.passed,
      contractConsistent: graceDrift.metrics[0].contractConsistent,
    },
    invalidGraceContract: {
      passed: invalidGraceContract.passed,
      passCount: invalidGraceContract.metrics[0].passCount,
    },
    policyDrift: {
      passed: policyDrift.passed,
      contractConsistent: policyDrift.metrics[0].contractConsistent,
    },
  }, {
    ceilingDrift: { passed: false, contractConsistent: false },
    ceilingDisagreement: { passed: false, passCount: 0 },
    graceDrift: { passed: false, contractConsistent: false },
    invalidGraceContract: { passed: false, passCount: 0 },
    policyDrift: { passed: false, contractConsistent: false },
  });
});

test('aggregate terminal output uses validated passCount and keeps declarations diagnostic-only', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'run-performance-playwright.cjs'), 'utf8');
  assert.match(source, /passes \$\{metric\.passCount\}\/\$\{metric\.totalRuns\}/);
  assert.doesNotMatch(source, /passes \$\{metric\.reportedPassCount\}/);
});

test('summarizeTargetRun produces a grouped suite summary entry for a passing target', () => {
  const target = performanceRunner.PERFORMANCE_TARGETS['artist-family'];
  const metricCaseTitle = target.metricCasePattern;
  const summary = _private.summarizeTargetRun(target, {
    exitCode: 0,
    attemptRecords: [
      {
        status: 0,
        parsedTestResults: [
          {
            status: 'passed',
            suiteName: 'FTC-SEARCH-NAV-005A local real-build artist family responsiveness',
            testName: metricCaseTitle,
            fullName: `FTC-SEARCH-NAV-005A local real-build artist family responsiveness > ${metricCaseTitle}`,
          },
        ],
      },
    ],
    aggregateSummary: null,
  });

  assert.deepEqual(summary, {
    suiteName: 'Artist Family Navigation',
    status: 'passed',
    tests: [
      {
        status: 'passed',
        testName: metricCaseTitle,
        fullName: `Artist Family Navigation > ${metricCaseTitle}`,
      },
    ],
    failedTests: [],
  });
});

test('summarizeTargetRun keeps app-open All Artists results under a distinct suite label', () => {
  const target = performanceRunner.PERFORMANCE_TARGETS['app-open-all-artists'];
  const summary = _private.summarizeTargetRun(target, {
    exitCode: 1,
    attemptRecords: [
      {
        status: 1,
        parsedTestResults: [
          {
            status: 'failed',
            suiteName: 'FTC-GALLERY-STARTUP-005T local real-app app-open All Artists UI',
            testName: 'App open renders All Artists UI and explicit full root browse uses library_browse',
            fullName: 'FTC-GALLERY-STARTUP-005T local real-app app-open All Artists UI > App open renders All Artists UI and explicit full root browse uses library_browse',
          },
        ],
      },
    ],
    aggregateSummary: null,
  });

  assert.deepEqual(summary, {
    suiteName: 'App Open All Artists',
    status: 'failed',
    tests: [
      {
        status: 'failed',
        testName: 'App open renders All Artists UI and explicit full root browse uses library_browse',
        fullName: 'App Open All Artists > App open renders All Artists UI and explicit full root browse uses library_browse',
      },
    ],
    failedTests: ['App Open All Artists > App open renders All Artists UI and explicit full root browse uses library_browse'],
  });
});

test('formatSuiteTerminalSummary prints overall pass counts and a flat failed-test list', () => {
  const text = _private.formatSuiteTerminalSummary([
    {
      suiteName: 'Artist Family Navigation',
      status: 'passed',
      tests: [
        { status: 'passed', testName: 'Neal Morse family search stays responsive', fullName: 'Artist Family Navigation > Neal Morse family search stays responsive' },
      ],
      failedTests: [],
    },
    {
      suiteName: 'Utilities',
      status: 'failed',
      tests: [
        { status: 'failed', testName: 'Rules UI reports library_browse telemetry and timing', fullName: 'Utilities > Rules UI reports library_browse telemetry and timing' },
      ],
      failedTests: ['Utilities > Rules UI reports library_browse telemetry and timing'],
    },
  ]);

  const plainText = text.replace(/\u001b\[[0-9;]*m/g, '');

  assert.match(plainText, /=== Playwright Summary ===/);
  assert.match(plainText, /\[✓\] Artist Family Navigation/);
  assert.match(plainText, /\[x\] Utilities/);
  assert.match(plainText, /Overall: 1\/2 passed/);
  assert.match(plainText, /Failed tests:/);
  assert.match(plainText, /- Utilities > Rules UI reports library_browse telemetry and timing/);
});

function validTimingValidation(overrides = {}) {
  return {
    key: 'treeNealSelectionMs',
    metricId: 'artist-family.treeNealSelectionMs',
    contractName: 'ci',
    units: 'ms',
    actual: 851,
    targetMaximum: 650,
    graceMs: 200,
    hardCeiling: 850,
    allowedMaximum: 850,
    passed: false,
    performanceStatus: 'hard-fail',
    ...overrides,
  };
}

test('classifyPerformanceAttempt permits recovery only for complete CI timing hard failures', () => {
  assert.equal(typeof _private.classifyPerformanceAttempt, 'function');

  assert.deepEqual(_private.classifyPerformanceAttempt({
    status: 1,
    reporterFinalized: true,
    metricsComplete: true,
    functionalChecksComplete: true,
    nonTimingChecksComplete: true,
    validationResults: [validTimingValidation()],
  }, 'ci'), {
    outcome: 'hard-fail',
    eligibleForRecovery: true,
    failureCategory: 'timing-hard-ceiling',
  });

  assert.deepEqual(_private.classifyPerformanceAttempt({
    status: 1,
    reporterFinalized: true,
    metricsComplete: true,
    functionalChecksComplete: true,
    nonTimingChecksComplete: true,
    validationResults: [
      validTimingValidation(),
      validTimingValidation({
        key: 'treeCosmicSelectionMs',
        metricId: 'artist-family.treeCosmicSelectionMs',
        actual: 901,
        targetMaximum: 700,
        hardCeiling: 900,
        allowedMaximum: 900,
      }),
    ],
  }, 'ci'), {
    outcome: 'hard-fail',
    eligibleForRecovery: true,
    failureCategory: 'timing-hard-ceiling',
  });
});

test('classifyPerformanceAttempt treats target-met and grace-used as terminal passes', () => {
  for (const timing of [
    validTimingValidation({ actual: 640, passed: true, performanceStatus: 'target-met' }),
    validTimingValidation({ actual: 800, passed: true, performanceStatus: 'grace-used' }),
  ]) {
    assert.deepEqual(_private.classifyPerformanceAttempt({
      status: 0,
      reporterFinalized: true,
      metricsComplete: true,
      functionalChecksComplete: true,
      nonTimingChecksComplete: true,
      validationResults: [timing],
    }, 'ci'), {
      outcome: 'passed',
      eligibleForRecovery: false,
      failureCategory: null,
    });
  }
});

test('classifyPerformanceAttempt accepts complete passing non-timing measurements without recovery', () => {
  assert.deepEqual(_private.classifyPerformanceAttempt({
    status: 0,
    reporterFinalized: true,
    metricsComplete: true,
    functionalChecksComplete: true,
    nonTimingChecksComplete: true,
    validationResults: [
      { key: 'peakBytes', units: 'bytes', actual: 100, hardCeiling: 200, passed: true },
      { key: 'driftBytes', units: 'bytes', actual: 10, allowedMaximum: 20, passed: true },
    ],
  }, 'ci'), {
    outcome: 'passed',
    eligibleForRecovery: false,
    failureCategory: null,
  });
});

test('classifyPerformanceAttempt never recovers forbidden failure categories', () => {
  for (const failureCategory of [
    'assertion',
    'crash',
    'socket',
    'setup',
    'missing-metrics',
    'reporter-finalization',
    'fixture',
    'postgres',
    'provider-traffic',
    'functional-contract',
  ]) {
    const classification = _private.classifyPerformanceAttempt({
      status: 1,
      reporterFinalized: failureCategory !== 'reporter-finalization',
      metricsComplete: failureCategory !== 'missing-metrics',
      functionalChecksComplete: failureCategory !== 'functional-contract',
      nonTimingChecksComplete: failureCategory !== 'assertion',
      failureCategory,
      validationResults: [validTimingValidation()],
    }, 'ci');
    assert.deepEqual(classification, {
      outcome: 'failed',
      eligibleForRecovery: false,
      failureCategory,
    }, failureCategory);
  }
});

test('local timing hard failures remain single-attempt failures', () => {
  assert.deepEqual(_private.classifyPerformanceAttempt({
    status: 1,
    reporterFinalized: true,
    metricsComplete: true,
    functionalChecksComplete: true,
    nonTimingChecksComplete: true,
    validationResults: [validTimingValidation({
      contractName: 'local', actual: 651, targetMaximum: 450, hardCeiling: 650,
    })],
  }, 'local'), {
    outcome: 'hard-fail',
    eligibleForRecovery: false,
    failureCategory: 'timing-hard-ceiling',
  });
});

test('timing metrics without explicit completed non-timing and functional evidence are not recoverable', () => {
  for (const incompleteEvidence of [
    { functionalChecksComplete: false, nonTimingChecksComplete: true },
    { functionalChecksComplete: true, nonTimingChecksComplete: false },
    { functionalChecksComplete: undefined, nonTimingChecksComplete: undefined },
  ]) {
    const classification = _private.classifyPerformanceAttempt({
      status: 1,
      reporterFinalized: true,
      metricsComplete: true,
      validationResults: [validTimingValidation()],
      ...incompleteEvidence,
    }, 'ci');
    assert.equal(classification.eligibleForRecovery, false);
    assert.equal(classification.outcome, 'failed');
  }
});

test('multi-case timing recovery identifies the exact metric-owning test rather than a shared case id', () => {
  const metricCasePattern = performanceRunner.PERFORMANCE_TARGETS['artist-family'].metricCasePattern;
  const baseAttempt = {
    status: 1,
    reporterFinalized: true,
    metricsComplete: true,
    functionalChecksComplete: true,
    nonTimingChecksComplete: true,
    expectedCasePatterns: performanceRunner.PERFORMANCE_TARGETS['artist-family'].casePatterns,
    metricCaseId: 'FTC-SEARCH-NAV-005A',
    metricCasePattern,
    validationResults: [validTimingValidation()],
  };
  const metricFailure = {
    ...baseAttempt,
    parsedTestResults: [
      { status: 'passed', testName: 'Neal Morse scrolling keeps each displayed artist heading unique before and after filtering' },
      { status: 'failed', testName: metricCasePattern },
    ],
  };
  assert.equal(_private.classifyPerformanceAttempt(metricFailure, 'ci').eligibleForRecovery, true);

  const siblingFailure = {
    ...baseAttempt,
    parsedTestResults: [
      { status: 'failed', testName: 'Neal Morse scrolling keeps each displayed artist heading unique before and after filtering' },
      { status: 'passed', testName: metricCasePattern },
    ],
  };
  assert.equal(_private.classifyPerformanceAttempt(siblingFailure, 'ci').eligibleForRecovery, false);
});

test('selected-artist timing recovery cannot clear a sibling functional failure', () => {
  const target = performanceRunner.PERFORMANCE_TARGETS['selected-artist'];
  const baseAttempt = {
    status: 1,
    processStatus: 1,
    structuredStatus: 'failed',
    reporterFinalized: true,
    metricsComplete: true,
    functionalChecksComplete: true,
    nonTimingChecksComplete: true,
    expectedCasePatterns: target.casePatterns,
    metricCaseId: target.casePattern,
    metricCasePattern: target.metricCasePattern,
    validationResults: [validTimingValidation()],
  };
  const timingOnly = {
    ...baseAttempt,
    parsedTestResults: [
      { status: 'failed', testName: target.metricCasePattern },
      { status: 'passed', testName: target.casePatterns[1] },
    ],
  };
  assert.equal(_private.classifyPerformanceAttempt(timingOnly, 'ci').eligibleForRecovery, true);

  const mixedFailure = {
    ...baseAttempt,
    parsedTestResults: [
      { status: 'failed', testName: target.metricCasePattern },
      { status: 'failed', testName: target.casePatterns[1] },
    ],
  };
  assert.equal(_private.classifyPerformanceAttempt(mixedFailure, 'ci').eligibleForRecovery, false);
});

test('buildRunnerArgs maps scan-cold to the isolated scan benchmark config', () => {
  const args = _private.buildRunnerArgs({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'scan-cold',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/scanPerformance/scanPerformance.spec.js',
    '-c',
    'playwright.scan-performance.config.cjs',
    '--browser=chrome',
    '--headless',
    '--grep=FTC-OPS-014',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('scan-add-album explicitly selects the offline production cover-provider group', () => {
  assert.deepEqual(
    performanceRunner.PERFORMANCE_TARGETS['scan-add-album'].env,
    {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO: 'add-album',
      ALBUM_HAVEN_COVER_PROVIDER_GROUPS: 'offline',
    },
  );

  assert.deepEqual(
    performanceRunner.PERFORMANCE_TARGETS['scan-page'].env,
    {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO: 'add-album',
      ALBUM_HAVEN_COVER_PROVIDER_GROUPS: 'offline',
    },
  );
});

test('scan performance output guard rejects live cover-provider domains but permits loopback fixtures', () => {
  const liveProviderUrls = [
    ['itunes.apple.com', 'https://itunes.apple.com/search?term=fixture'],
    ['i.ytimg.com', 'https://i.ytimg.com/vi/fixture/maxresdefault.jpg'],
    ['rr1---sn.example.googlevideo.com', 'https://rr1---sn.example.googlevideo.com/videoplayback?id=fixture'],
    ['image-cdn-ak.spotifycdn.com', 'https://image-cdn-ak.spotifycdn.com/image/fixture'],
    ['f4.bcbits.com', 'https://f4.bcbits.com/img/a1234567890_16.jpg'],
    ['archive.org', 'https://archive.org/download/mbid/cover.jpg'],
  ];
  const undetectedProviderHosts = [];

  for (const [hostname, url] of liveProviderUrls) {
    try {
      _private.assertNoLiveCoverProviderDomains(`[scan] GET ${url}`, 'scan-add-album');
      undetectedProviderHosts.push(hostname);
    } catch (error) {
      assert.match(error.message, new RegExp(`scan-add-album.*${hostname.replaceAll('.', '\\.')}`, 'i'));
    }
  }

  assert.deepEqual(
    undetectedProviderHosts,
    [],
    `expected live provider hosts to be rejected: ${undetectedProviderHosts.join(', ')}`,
  );

  for (const loopbackUrl of [
    'http://127.0.0.1:4175/itunes/search?term=fixture',
    'http://localhost:4175/cover.jpg',
  ]) {
    assert.doesNotThrow(() => _private.assertNoLiveCoverProviderDomains(
      `[scan] GET ${loopbackUrl}`,
      'scan-add-album',
    ));
  }
});

test('buildRunnerArgs maps scan-page to both isolated Scan Page contracts', () => {
  const target = performanceRunner.PERFORMANCE_TARGETS['scan-page'];
  const args = _private.buildRunnerArgs({
    browser: 'chromium',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'scan-page',
  });

  assert.deepEqual(target.aliasNames, ['scan-page', 'scan-page-context']);
  assert.deepEqual(target.env, {
    ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO: 'add-album',
    ALBUM_HAVEN_COVER_PROVIDER_GROUPS: 'offline',
  });
  assert.equal(target.measurementExpected, false);
  assert.deepEqual(target.casePatterns, ['FTC-OPS-003C', 'FTC-OPS-003E']);
  assert.deepEqual(args, [
    'test',
    'tests/e2e/scanPerformance/scanPerformance.spec.js',
    '-c',
    'playwright.scan-performance.config.cjs',
    '--browser=chromium',
    '--headless',
    '--grep=FTC-OPS-003(C|E)',
    '--workers=1',
    '--timeout=240000',
  ]);

  const summary = _private.summarizeTargetRun(target, {
    exitCode: 0,
    attemptRecords: [{
      status: 0,
      parsedTestResults: [
        {
          status: 'passed',
          testName: 'FTC-OPS-003C preserves browse context',
          fullName: 'isolated scan performance benchmarks > FTC-OPS-003C preserves browse context',
        },
        {
          status: 'passed',
          testName: 'FTC-OPS-003E cancels regular and full scans',
          fullName: 'isolated scan performance benchmarks > FTC-OPS-003E cancels regular and full scans',
        },
      ],
    }],
    aggregateSummary: null,
  });
  assert.equal(summary.tests.length, 2);
  assert.deepEqual(
    summary.tests.map((entry) => entry.testName),
    [
      'FTC-OPS-003C preserves browse context',
      'FTC-OPS-003E cancels regular and full scans',
    ],
  );

  assert.deepEqual(_private.classifyPerformanceAttempt({
    status: 0,
    processStatus: 0,
    structuredStatus: 'passed',
    reporterFinalized: true,
    measurementExpected: false,
    expectedCasePatterns: target.casePatterns,
    parsedTestResults: summary.tests,
  }, 'local'), {
    outcome: 'passed',
    eligibleForRecovery: false,
    failureCategory: null,
  });
});

test('coverage-only targets accept a completed Playwright JSON report as reporter finalization', () => {
  assert.equal(_private.isFinalizedPlaywrightJsonReport({
    suites: [{}],
    errors: [],
    stats: {
      expected: 2,
      unexpected: 0,
      skipped: 0,
      flaky: 0,
    },
  }), true);
  assert.equal(_private.isFinalizedPlaywrightJsonReport(null), false);
  assert.equal(_private.isFinalizedPlaywrightJsonReport({ suites: [], stats: {} }), false);
});

test('buildBatchRunnerArgs runs the whole spec file when compatible targets share one batch', () => {
  const args = _private.buildBatchRunnerArgs([
    performanceRunner.PERFORMANCE_TARGETS['scan-cold'],
    performanceRunner.PERFORMANCE_TARGETS['scan-cached'],
  ], {
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    realAppPort: 5001,
    testTimeoutMs: 540000,
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/scanPerformance/scanPerformance.spec.js',
    '-c',
    'playwright.scan-performance.config.cjs',
    '--browser=chrome',
    '--headless',
    '--workers=1',
    '--timeout=540000',
  ]);
});

test('resolvePerformanceTarget does not accept scan as a single-target alias', () => {
  assert.throws(
    () => _private.resolvePerformanceTarget('scan'),
    /Unsupported performance spec path: scan/
  );
});

test('groupBatchesForFullSuiteBudgets keeps expensive suite families on separate budgets', () => {
  const budgetGroups = _private.groupBatchesForFullSuiteBudgets([
    performanceRunner.PERFORMANCE_TARGETS['artist-family'],
    performanceRunner.PERFORMANCE_TARGETS['selected-artist'],
    performanceRunner.PERFORMANCE_TARGETS['search-browse'],
    performanceRunner.PERFORMANCE_TARGETS['scan-cold'],
    performanceRunner.PERFORMANCE_TARGETS['scan-cached'],
  ]);

  assert.deepEqual(
    budgetGroups.map((group) => group.key),
    [
      'real-app:artist-family',
      'real-app:selected-artist',
      'real-app:search-browse',
      'scanner-index-cache',
    ],
  );
  assert.deepEqual(
    budgetGroups.map((group) => group.batches.flat().map((target) => target.aliasNames[0])),
    [
      ['artist-family'],
      ['selected-artist'],
      ['search-browse'],
      ['scan-cold', 'scan-cached'],
    ],
  );
});

test('groupTargetsForFullSuite keeps same-spec targets separate when target env differs', () => {
  const batches = _private.groupTargetsForFullSuite([
    performanceRunner.PERFORMANCE_TARGETS['utility-problematic-files'],
    performanceRunner.PERFORMANCE_TARGETS['utility-rules'],
    performanceRunner.PERFORMANCE_TARGETS['scan-cold'],
    performanceRunner.PERFORMANCE_TARGETS['scan-cached'],
  ]);

  assert.deepEqual(
    batches.map((batch) => batch.map((target) => target.aliasNames[0])),
    [
      ['utility-problematic-files'],
      ['utility-rules'],
      ['scan-cold'],
      ['scan-cached'],
    ],
  );
});

test('groupTargetsForFullSuite keeps incompatible same-spec real-app targets in separate batches', () => {
  const batches = _private.groupTargetsForFullSuite([
    performanceRunner.PERFORMANCE_TARGETS['all-artists'],
    performanceRunner.PERFORMANCE_TARGETS['search-all-artists'],
    performanceRunner.PERFORMANCE_TARGETS['scan-cold'],
    performanceRunner.PERFORMANCE_TARGETS['scan-cached'],
  ]);

  assert.deepEqual(
    batches.map((batch) => batch.map((target) => target.aliasNames[0])),
    [
      ['all-artists'],
      ['search-all-artists'],
      ['scan-cold'],
      ['scan-cached'],
    ],
  );
});

test('buildRunnerArgs treats scan-performance spec paths as isolated scan benchmark runs', () => {
  const args = _private.buildRunnerArgs({
    browser: 'edge',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: 'tests/e2e/scanPerformance/scanPerformance.spec.js',
  });

  assert.deepEqual(args, [
    'test',
    'tests/e2e/scanPerformance/scanPerformance.spec.js',
    '-c',
    'playwright.scan-performance.config.cjs',
    '--browser=edge',
    '--headless',
    '--workers=1',
    '--timeout=240000',
  ]);
});

test('formatDisplayedAttemptTotal shows one planned attempt before auto-retries are triggered', () => {
  const verificationGroup = _private.buildVerificationGroup(
    performanceRunner.PERFORMANCE_TARGETS['problematic-files-focused'],
    { repeatCount: 1 },
  );

  assert.equal(
    _private.formatDisplayedAttemptTotal(verificationGroup),
    1,
  );
});

test('formatDisplayedAttemptTotal keeps the requested total when repeats were explicitly requested', () => {
  const verificationGroup = _private.buildVerificationGroup(
    performanceRunner.PERFORMANCE_TARGETS['artist-family'],
    { repeatCount: 3 },
  );

  assert.equal(
    _private.formatDisplayedAttemptTotal(verificationGroup),
    3,
  );
});

test('resolveBatchTargetStatus honors unicode list-reporter results through the parsed test feed', () => {
  const target = performanceRunner.PERFORMANCE_TARGETS['utility-rules'];
  const parsedTests = [
    {
      status: 'passed',
      suiteName: 'Rules Utility',
      testName: 'FTC-UTIL-RULES-002P',
      fullName: 'Rules Utility > FTC-UTIL-RULES-002P',
    },
  ];

  assert.equal(_private.resolveBatchTargetStatus(target, parsedTests, 1), 0);
  assert.equal(
    _private.resolveBatchTargetStatus(target, [
      {
        status: 'failed',
        suiteName: 'Rules Utility',
        testName: 'FTC-UTIL-RULES-002P',
        fullName: 'Rules Utility > FTC-UTIL-RULES-002P',
      },
    ], 0),
    1,
  );
});

test('runSequentialPerformanceSuite executes one sequential invocation per requested repeat and returns a failing status', (t) => {
  usePreloadedFixtureEnv(t, 'artist-family');
  const originalSpawnSync = childProcess.spawnSync;
  const calls = [];
  childProcess.spawnSync = (command, ...args) => {
    if (command === FAKE_PERFORMANCE_PYTHON) {
      return { error: null, status: 0, stdout: '', stderr: '' };
    }
    calls.push([command, ...args]);
    return {
      error: null,
      status: 1,
    };
  };
  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
  });

  const exitCode = _private.runSequentialPerformanceSuite({
    browser: 'chrome',
    group: 'all',
    headless: true,
    repeatCount: 3,
    targetInput: 'artist-family',
  });

  assert.equal(exitCode, 1);
  assert.equal(calls.length, 3);
});

test('runSequentialPerformanceSuite switches repeated real-data attempts to the safe higher managed port range', (t) => {
  usePreloadedFixtureEnv(t, 'artist-family');
  const originalSpawnSync = childProcess.spawnSync;
  const calls = [];
  childProcess.spawnSync = (command, args) => {
    if (command === FAKE_PERFORMANCE_PYTHON) {
      return { error: null, status: 0, stdout: '', stderr: '' };
    }
    calls.push(args);
    return {
      error: null,
      status: 0,
      stdout: '',
      stderr: '',
    };
  };
  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
  });

  const exitCode = _private.runSequentialPerformanceSuite({
    browser: 'chrome',
    group: 'all',
    headless: true,
    repeatCount: 3,
    targetInput: 'artist-family',
  });

  assert.equal(exitCode, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].includes('--real-app-port=5001'), true);
  assert.equal(calls[1].includes('--real-app-port=5002'), true);
  assert.equal(calls[2].includes('--real-app-port=5003'), true);
});

test('resolveManagedRealAppPortForSequence assigns a dedicated base port block per full-suite real-data target', () => {
  assert.equal(_private.resolveManagedRealAppPortForSequence(0), 5001);
  assert.equal(_private.resolveManagedRealAppPortForSequence(1), 5011);
  assert.equal(_private.resolveManagedRealAppPortForSequence(2), 5021);
  assert.equal(_private.resolveManagedRealAppPortForSequence(3), 5031);
  assert.equal(_private.resolveManagedRealAppPortForSequence(4), 5041);
  assert.equal(_private.resolveManagedRealAppPortForSequence(5), 5071);
  assert.equal(_private.resolveManagedRealAppPortForSequence(6), 5081);
  assert.equal(_private.resolveManagedRealAppPortForSequence(0, 4333), 4333);
  assert.equal(_private.resolveManagedRealAppPortForSequence(1, 4333), 4343);
});

test('runTargetWithPolicy does not treat stale metrics from an earlier attempt as later rerun passes', (t) => {
  usePreloadedFixtureEnv(t, 'artist-family');
  const originalSpawnSync = childProcess.spawnSync;
  const originalReadFileSync = fs.readFileSync;
  const originalDateNow = Date.now;
  const target = performanceRunner.PERFORMANCE_TARGETS['artist-family'];
  const attemptedStatuses = [0, 1, 1];
  const spawnedAttemptNumbers = [];

  childProcess.spawnSync = (command, _args, options) => {
    if (command === FAKE_PERFORMANCE_PYTHON) {
      return { error: null, status: 0, stdout: '', stderr: '' };
    }
    spawnedAttemptNumbers.push(Number(options.env.PLAYWRIGHT_PERF_VERIFICATION_ATTEMPT));
    return {
      error: null,
      status: attemptedStatuses[spawnedAttemptNumbers.length - 1],
      stdout: '',
      stderr: '',
    };
  };

  Date.now = () => 1700000000000;

  fs.readFileSync = (filePath, encoding) => {
    assert.equal(encoding, 'utf8');
    const normalizedPath = String(filePath).replace(/\\/g, '/');
    if (normalizedPath.endsWith('/artistFamilyLocal/index.json')) {
      return JSON.stringify({
        runs: [
          {
            metricsPath: 'latest-run.json',
            verificationRunGroup: {
              id: 'artist-family-1700000000000',
              label: 'artist-family',
              attempt: 1,
              maxAttempts: 3,
            },
          },
        ],
      });
    }
    if (normalizedPath.endsWith('/artistFamilyLocal/latest-run.json')) {
      return JSON.stringify({
        runId: 'artist-family-attempt-1',
        rawMetrics: {
          benchmarkValidation: {
            results: [
              {
                key: 'selectedArtistGalleryMs',
                units: 'ms',
                actual: 2400,
                allowedMaximum: 3200,
                allowedText: '3200 ms',
                passed: true,
              },
            ],
          },
        },
      });
    }
    return originalReadFileSync(filePath, encoding);
  };

  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
    fs.readFileSync = originalReadFileSync;
    Date.now = originalDateNow;
  });

  const result = _private.runTargetWithPolicy(target, {
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 3,
    targetInput: 'artist-family',
  }, {
    realAppPort: 5001,
    scanAppPort: 4174,
  });

  assert.deepEqual(spawnedAttemptNumbers, [1, 2, 3]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.aggregateSummary, null);
  assert.deepEqual(
    result.attemptRecords.map((record) => ({
      attemptNumber: record.attemptNumber,
      status: record.status,
      validationResultsLength: record.validationResults.length,
    })),
    [
      { attemptNumber: 1, status: 0, validationResultsLength: 1 },
      { attemptNumber: 2, status: 1, validationResultsLength: 0 },
      { attemptNumber: 3, status: 1, validationResultsLength: 0 },
    ],
  );
});

test('runSequentialPerformanceSuite executes the default approved performance targets when no target is provided', (t) => {
  usePreloadedFixtureEnv(t, 'idle-memory');
  const originalSpawnSync = childProcess.spawnSync;
  const originalDateNow = Date.now;
  const calls = [];
  const finalizedOutput = installFinalizedPassingPerformanceEvidence(t);
  childProcess.spawnSync = (command, args, options) => {
    if (command === FAKE_PERFORMANCE_PYTHON) {
      return { error: null, status: 0, stdout: '', stderr: '' };
    }
    calls.push({ command, args, options });
    const targetName = String(options.env.PLAYWRIGHT_PERF_VERIFICATION_GROUP_LABEL || '')
      .split('+')
      .at(-1);
    selectNextPreloadedProfileAfter(targetName);
    const samplesPath = options.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH;
    if (samplesPath) fs.writeFileSync(samplesPath, '{"status":{}}\n', 'utf8');
    return {
      error: null,
      status: 0,
      stdout: finalizedOutput(options),
      stderr: '',
    };
  };
  Date.now = () => 1000;
  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
    Date.now = originalDateNow;
  });

  const exitCode = _private.runSequentialPerformanceSuite({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: '',
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 19);
  assert.equal(calls.every((call) => call.options.windowsHide === true), true);
  assert.equal(
    calls.every((call) => call.options.maxBuffer >= 64 * 1024 * 1024),
    true,
  );
  assert.equal(
    calls.every((call) => call.options.env.PLAYWRIGHT_OPEN_PERFORMANCE_REPORT === '0'),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.args[1]),
    new Array(19).fill('test'),
  );
  assert.equal(calls[3].args.includes('--real-app-port=5001'), true);
  assert.equal(calls[4].args.includes('--real-app-port=5011'), true);
  assert.equal(calls[5].args.includes('--real-app-port=5021'), true);
  assert.equal(calls[6].args.includes('--real-app-port=5031'), true);
  assert.equal(calls[7].args.includes('--real-app-port=5041'), true);
  assert.equal(calls[8].args.includes('--real-app-port=5071'), true);
  assert.equal(calls[9].args.includes('--real-app-port=5081'), true);
  assert.equal(calls[10].args.includes('--real-app-port=5091'), true);
  assert.equal(calls[11].args.includes('--real-app-port=5101'), true);
  assert.equal(calls[12].args.includes('--real-app-port=5111'), true);
  assert.equal(calls[13].args.includes('--real-app-port=5121'), true);
  for (const call of calls.slice(3, 14)) {
    assert.deepEqual(call.options.env.ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE, 'postgres');
  }
  assert.equal(calls[6].options.env.ALBUM_HAVEN_E2E_PROBLEMATIC_SEED_KEY, undefined);
  assert.equal(calls[7].options.env.ALBUM_HAVEN_E2E_PROBLEMATIC_SEED_KEY, undefined);
  assert.equal(calls[12].options.env.ALBUM_HAVEN_E2E_PROBLEMATIC_SEED_KEY, undefined);
  assert.equal(calls[12].options.env.PLAYWRIGHT_ISOLATED_LIBRARY_APP, '1');
  assert.equal(calls[3].options.env.ALBUM_HAVEN_E2E_SEED_ARTIST_FAMILY, undefined);
  assert.equal(calls[4].options.env.ALBUM_HAVEN_E2E_SEED_ARTIST_FAMILY, undefined);
  assert.equal(calls[5].options.env.ALBUM_HAVEN_E2E_SEED_ARTIST_FAMILY, undefined);
  assert.equal(calls[14].options.env.PLAYWRIGHT_PORT, '4174');
  assert.equal(calls[15].options.env.PLAYWRIGHT_PORT, '4175');
  assert.equal(calls[16].options.env.PLAYWRIGHT_PORT, '4176');
  assert.equal(calls[17].options.env.PLAYWRIGHT_PORT, '4177');
  assert.equal(calls[18].options.env.PLAYWRIGHT_PORT, '4178');
  assert.equal(calls[14].options.env.ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO, 'cold');
  assert.equal(calls[15].options.env.ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO, 'cached');
  assert.equal(calls[16].options.env.ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO, 'add-album');
  assert.equal(calls[17].options.env.ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO, 'metadata');
  assert.equal(calls[18].options.env.ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO, 'add-album');
  const scanSamplePaths = calls.slice(14, 19).map(
    (call) => call.options.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH,
  );
  assert.equal(new Set(scanSamplePaths).size, 5);
  assert.match(scanSamplePaths[0], /scan-cold-port-4174-attempt-1-[0-9a-f-]{36}\.jsonl$/);
  assert.match(scanSamplePaths[1], /scan-cached-port-4175-attempt-1-[0-9a-f-]{36}\.jsonl$/);
  assert.match(scanSamplePaths[2], /scan-add-album-port-4176-attempt-1-[0-9a-f-]{36}\.jsonl$/);
  assert.match(scanSamplePaths[3], /scan-metadata-port-4177-attempt-1-[0-9a-f-]{36}\.jsonl$/);
  assert.match(scanSamplePaths[4], /scan-page-port-4178-attempt-1-[0-9a-f-]{36}\.jsonl$/);
  for (const samplesPath of scanSamplePaths) assert.equal(fs.existsSync(samplesPath), false);
  for (const call of calls) {
    assert.equal(call.args.some((arg) => String(arg).startsWith('--run-timeout-ms=')), false);
  }
  assert.equal(calls[0].args.includes('--timeout=240000'), true);
  assert.equal(calls[1].args.includes('--timeout=240000'), true);
  assert.equal(calls[2].args.includes('--timeout=240000'), true);
  assert.equal(calls[3].args.includes('--timeout=240000'), true);
  assert.equal(calls[4].args.includes('--timeout=240000'), true);
  assert.equal(calls[5].args.includes('--timeout=240000'), true);
  assert.equal(calls[6].args.includes('--timeout=240000'), true);
  assert.equal(calls[7].args.includes('--timeout=240000'), true);
  assert.equal(calls[8].args.includes('--timeout=240000'), true);
  assert.equal(calls[9].args.includes('--timeout=240000'), true);
  assert.equal(calls[10].args.includes('--timeout=240000'), true);
  assert.equal(calls[11].args.includes('--timeout=240000'), true);
  assert.equal(calls[12].args.includes('--timeout=240000'), true);
  assert.equal(calls[13].args.includes('--timeout=240000'), true);
  assert.equal(calls[14].args.includes('--timeout=240000'), true);
  assert.equal(calls[15].args.includes('--timeout=240000'), true);
  assert.equal(calls[16].args.includes('--timeout=240000'), true);
  assert.equal(calls[17].args.includes('--timeout=240000'), true);
  assert.equal(calls[18].args.includes('--timeout=240000'), true);
  assert.equal(calls[3].args.includes('--grep=FTC-GALLERY-STARTUP-005A'), true);
  assert.equal(calls[4].args.includes('--grep=FTC-SEARCH-NAV-005A'), false);
  assert.equal(calls[5].args.includes('--grep=FTC-SEARCH-NAV-003A'), true);
  assert.equal(calls[6].args.includes('--grep=FTC-UTIL-PROBLEMS-009'), true);
  assert.equal(calls[7].args.includes('--grep=FTC-UTIL-RULES-002'), true);
  assert.equal(calls[8].args.includes('--grep=FTC-GALLERY-STARTUP-005Q'), true);
  assert.equal(calls[9].args.includes('--grep=FTC-GALLERY-STARTUP-005R'), true);
  assert.equal(calls[10].args.includes('--grep=FTC-GALLERY-STARTUP-005S'), true);
  assert.equal(calls[11].args.includes('--grep=FTC-GALLERY-STARTUP-005T'), true);
  assert.equal(calls[12].args.includes('--grep=FTC-UTIL-PROBLEMS-010'), true);
  assert.equal(calls[13].args.includes('--grep=FTC-UTIL-RULES-002P'), true);
  assert.equal(calls[14].args.includes('--grep=FTC-OPS-014'), true);
  assert.equal(calls[15].args.includes('--grep=FTC-OPS-015'), true);
  assert.equal(calls[16].args.includes('--grep=FTC-OPS-016'), true);
  assert.equal(calls[17].args.includes('--grep=FTC-OPS-017'), true);
  assert.equal(calls[18].args.includes('--grep=FTC-OPS-003(C|E)'), true);
});

test('resolvePerformanceAttemptStatus rejects a false-zero child status when Playwright reported a failed test', () => {
  const output = `
Running 1 test using 1 worker

  x  1 [utility-problematic-files] > tests/e2e/utilityProblematicFiles/utilitiesResponsiveness.spec.js:27:3 > FTC-UTIL-PROBLEMS-009 synthetic-large utilities problematic-files responsiveness > immediate Problematic Files stays responsive (2.0m)
[playwright-performance-reporter] flush-complete

  1 failed
`;

  assert.equal(_private.resolvePerformanceAttemptStatus(0, output), 1);
});

test('resolvePerformanceAttemptStatus trusts a failed structured last-run result across split output streams', () => {
  assert.equal(_private.resolvePerformanceAttemptStatus(
    0,
    {
      stdout: 'Running 1 test using 1 worker\n[playwright-performance-reporter] flush-complete\n',
      stderr: '  x  1 [synthetic-large-library] > utilitiesResponsiveness.spec.js:32:3 > timed out\n',
    },
    {
      status: 'failed',
      failedTests: ['cf4aab619f0d79c426c3-cb8c1de4abc3e8aa72b8'],
    },
  ), 1);
});

test('resolvePerformanceAttemptStatus rejects a structured pass with no expected parsed test result', () => {
  assert.equal(_private.resolvePerformanceAttemptStatus(
    0,
    { stdout: 'Running 1 test using 1 worker\n', stderr: '' },
    { status: 'passed', failedTests: [] },
  ), 1);
});

test('resolvePerformanceAttemptStatus rejects a missing required structured result', () => {
  assert.equal(_private.resolvePerformanceAttemptStatus(
    0,
    { stdout: '[playwright-performance-reporter] flush-complete\n', stderr: '' },
    null,
    { structuredResultRequired: true },
  ), 1);
});

test('runTargetWithPolicy propagates a failed structured Playwright result when the child falsely exits zero', (t) => {
  usePreloadedFixtureEnv(t, 'utility-problematic-files');
  const target = performanceRunner.PERFORMANCE_TARGETS['utility-problematic-files'];
  const runnerArgs = _private.buildRunnerArgs({
    targetInput: 'utility-problematic-files',
    headless: true,
    browser: 'chrome',
    realAppPort: 5001,
  });
  const lastRunPath = _private.resolvePlaywrightLastRunPath(runnerArgs);
  const previousLastRun = fs.existsSync(lastRunPath) ? fs.readFileSync(lastRunPath) : null;
  const originalSpawnSync = childProcess.spawnSync;
  const attempts = [];
  childProcess.spawnSync = (command) => {
    if (command === FAKE_PERFORMANCE_PYTHON) {
      return { error: null, status: 0, stdout: '', stderr: '' };
    }
    attempts.push(attempts.length + 1);
    fs.mkdirSync(path.dirname(lastRunPath), { recursive: true });
    fs.writeFileSync(lastRunPath, JSON.stringify({
      status: 'failed',
      failedTests: ['structured-failure-id'],
    }));
    return {
      error: null,
      status: 0,
      stdout: '[playwright-performance-reporter] flush-complete\n',
      stderr: '',
    };
  };
  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
    if (previousLastRun === null) {
      fs.rmSync(lastRunPath, { force: true });
    } else {
      fs.writeFileSync(lastRunPath, previousLastRun);
    }
  });

  const result = _private.runTargetWithPolicy(target, {
    headless: true,
    browser: 'chrome',
    repeatCount: 1,
    testTimeoutMs: 120000,
  }, {
    realAppPort: 5001,
    scanAppPort: 4174,
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(attempts, [1]);
  assert.deepEqual(result.attemptRecords.map((record) => record.status), [1]);
});

test('buildAttemptEnv prevents report auto-open while preserving headed mode', () => {
  const attemptEnv = _private.buildAttemptEnv(
    {
      PLAYWRIGHT_HEADLESS: 'false',
      PLAYWRIGHT_OPEN_PERFORMANCE_REPORT: '1',
    },
    {
      id: 'verification-id',
      label: 'verification-label',
      policy: 'single-run',
      maxAttempts: 1,
    },
    1,
  );

  assert.equal(attemptEnv.PLAYWRIGHT_OPEN_PERFORMANCE_REPORT, '0');
  assert.equal(attemptEnv.PLAYWRIGHT_HEADLESS, 'false');
});

test('runSequentialPerformanceSuite keeps fixed per-invocation timeouts even after earlier batches consume wall clock time', (t) => {
  usePreloadedFixtureEnv(t, 'idle-memory');
  const originalSpawnSync = childProcess.spawnSync;
  const originalDateNow = Date.now;
  const calls = [];
  let nowMs = 1000;
  const finalizedOutput = installFinalizedPassingPerformanceEvidence(t);

  childProcess.spawnSync = (command, args, options) => {
    if (command === FAKE_PERFORMANCE_PYTHON) {
      return { error: null, status: 0, stdout: '', stderr: '' };
    }
    calls.push({ command, args, options });
    const targetName = String(options.env.PLAYWRIGHT_PERF_VERIFICATION_GROUP_LABEL || '')
      .split('+')
      .at(-1);
    selectNextPreloadedProfileAfter(targetName);
    nowMs += 300000;
    return {
      error: null,
      status: 0,
      stdout: finalizedOutput(options),
      stderr: '',
    };
  };
  Date.now = () => nowMs;

  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
    Date.now = originalDateNow;
  });

  const exitCode = _private.runSequentialPerformanceSuite({
    browser: 'chrome',
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: 1,
    targetInput: '',
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 19);
  for (const call of calls) {
    assert.equal(call.args.some((arg) => String(arg).startsWith('--run-timeout-ms=')), false);
  }
  assert.equal(calls[18].options.env.PLAYWRIGHT_PORT, '4178');
  assert.equal(calls[18].args.includes('--timeout=240000'), true);
});
