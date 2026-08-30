const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const performanceContract = require('../ci/performance-targets.json');
const performanceRunner = require('../../scripts/run-performance-playwright.cjs');

const { _private } = performanceRunner;
const fixtureRoot = path.resolve(__dirname, '..', '..', 'test-results', 'performance-fixture-contract');

const GENERATED_ISOLATED_TARGETS = new Set([
  'playback-start',
  'gapless-playback',
  'scan-cold',
  'scan-cached',
  'scan-add-album',
  'scan-metadata',
  'scan-page',
]);

const OWNER_RUNTIME_ENV_KEYS = [
  'MUSIC_DIR',
  'MUSIC_APP_DATA_DIR',
  'MUSIC_CACHE_PATH',
  'MUSIC_COVER_CACHE_PATH',
  'MUSIC_LIBRARY_ROOTS_PATH',
  'PLAYWRIGHT_REAL_APP_URL',
];

function expectedFixtureMode(targetName) {
  return GENERATED_ISOLATED_TARGETS.has(targetName)
    ? 'generated-isolated'
    : 'preloaded-release';
}

function approvedTargetEnv(targetName) {
  const target = performanceRunner.PERFORMANCE_TARGETS[targetName];
  const env = {
    ALBUM_HAVEN_FIXTURE_PROFILE: target.fixtureProfile,
  };
  if (expectedFixtureMode(targetName) === 'preloaded-release') {
    env.ALBUM_HAVEN_FIXTURE_ROOT = fixtureRoot;
    env.ALBUM_HAVEN_MEDIA_ROOT = path.join(fixtureRoot, 'media');
  }
  return env;
}

function runConfiguredTarget(targetName, env) {
  let spawnCount = 0;
  const result = _private.runConfiguredPerformanceSuite(
    {
      group: 'all',
      targetInput: targetName,
      headless: true,
    },
    env,
    {
      loadEnv: (baseEnv) => baseEnv,
      runDatabasePreflight: () => {},
      runSuite: () => {
        spawnCount += 1;
        return 0;
      },
    },
  );
  return { result, spawnCount };
}

test('registry and runner declare the frozen fixture mode for every performance target', () => {
  const registryTargets = new Map(
    performanceContract.targets.map((target) => [target.name, target]),
  );
  assert.deepEqual(
    [...registryTargets.keys()].sort(),
    Object.keys(performanceRunner.PERFORMANCE_TARGETS).sort(),
  );

  for (const [name, runnerTarget] of Object.entries(performanceRunner.PERFORMANCE_TARGETS)) {
    const fixtureMode = expectedFixtureMode(name);
    assert.equal(runnerTarget.fixtureMode, fixtureMode, `runner ${name}`);
    assert.equal(registryTargets.get(name).fixtureMode, fixtureMode, `registry ${name}`);
    assert.equal(
      registryTargets.get(name).fixtureMode,
      runnerTarget.fixtureMode,
      `registry/runner ${name}`,
    );
  }
});

test('target fixture preflight accepts each approved fixture profile and mode', () => {
  for (const targetName of ['idle-memory', 'playback-start', 'all-artists']) {
    const run = runConfiguredTarget(targetName, approvedTargetEnv(targetName));
    assert.equal(run.result, 0, targetName);
    assert.equal(run.spawnCount, 1, targetName);
  }
});

test('target fixture preflight rejects a mismatched profile before spawning', () => {
  for (const targetName of ['idle-memory', 'playback-start', 'all-artists']) {
    let spawned = false;
    assert.throws(
      () => _private.runConfiguredPerformanceSuite(
        { group: 'all', targetInput: targetName, headless: true },
        {
          ...approvedTargetEnv(targetName),
          ALBUM_HAVEN_FIXTURE_PROFILE: 'functional-core',
        },
        {
          loadEnv: (baseEnv) => baseEnv,
          runDatabasePreflight: () => {},
          runSuite: () => {
            spawned = true;
            return 0;
          },
        },
      ),
      /ALBUM_HAVEN_FIXTURE_PROFILE|fixture profile/i,
      targetName,
    );
    assert.equal(spawned, false, targetName);
  }
});

test('target fixture preflight rejects roots inconsistent with the approved fixture mode', () => {
  const cases = [
    {
      targetName: 'idle-memory',
      env: {
        ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
      },
    },
    {
      targetName: 'playback-start',
      env: {
        ...approvedTargetEnv('playback-start'),
        ALBUM_HAVEN_FIXTURE_ROOT: path.resolve(__dirname, 'inherited-release'),
        ALBUM_HAVEN_MEDIA_ROOT: path.resolve(__dirname, 'inherited-release', 'media'),
      },
    },
  ];

  for (const { targetName, env } of cases) {
    let spawned = false;
    assert.throws(
      () => _private.runConfiguredPerformanceSuite(
        { group: 'all', targetInput: targetName, headless: true },
        env,
        {
          loadEnv: (baseEnv) => baseEnv,
          runDatabasePreflight: () => {},
          runSuite: () => {
            spawned = true;
            return 0;
          },
        },
      ),
      /fixture mode|preloaded-release|generated-isolated|ALBUM_HAVEN_(FIXTURE|MEDIA)_ROOT/i,
      targetName,
    );
    assert.equal(spawned, false, targetName);
  }
});

test('target fixture preflight rejects every inherited owner runtime root before spawning', () => {
  for (const targetName of ['idle-memory', 'playback-start', 'all-artists']) {
    for (const envName of OWNER_RUNTIME_ENV_KEYS) {
      let spawned = false;
      assert.throws(
        () => _private.runConfiguredPerformanceSuite(
          { group: 'all', targetInput: targetName, headless: true },
          {
            ...approvedTargetEnv(targetName),
            [envName]: `C:\\Users\\owner\\${envName}`,
          },
          {
            loadEnv: (baseEnv) => baseEnv,
            runDatabasePreflight: () => {},
            runSuite: () => {
              spawned = true;
              return 0;
            },
          },
        ),
        new RegExp(`${envName}|owner|runtime root`, 'i'),
        `${targetName}:${envName}`,
      );
      assert.equal(spawned, false, `${targetName}:${envName}`);
    }
  }
});

test('scan database preflight accepts the dedicated local identity and exact CI suffixed triple', () => {
  const scanTargets = _private.listGroupedPerformanceTargets('scan');
  const acceptedEnvironments = [
    {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL:
        'postgresql://album_haven_migrator@localhost:5432/album_haven_scan_e2e',
      ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL:
        'postgresql://album_haven_app@localhost:5432/album_haven_scan_e2e',
    },
    {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL:
        'postgresql://album_haven_migrator_perf_123@localhost:5432/album_haven_ci_perf_123',
      ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL:
        'postgresql://album_haven_app_perf_123@localhost:5432/album_haven_ci_perf_123',
    },
  ];

  for (const env of acceptedEnvironments) {
    assert.doesNotThrow(
      () => _private.assertScanPerformanceDatabaseConfiguration(scanTargets, env),
    );
  }
});

test('scan database preflight rejects mismatched CI suffixes', () => {
  const scanTargets = _private.listGroupedPerformanceTargets('scan');
  assert.throws(
    () => _private.assertScanPerformanceDatabaseConfiguration(scanTargets, {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL:
        'postgresql://album_haven_migrator_perf_123@localhost:5432/album_haven_ci_perf_123',
      ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL:
        'postgresql://album_haven_app_perf_456@localhost:5432/album_haven_ci_perf_123',
    }),
    /suffix|album_haven_app_perf_123|matching/i,
  );
});

test('scan database preflight rejects broad shared-database bypass and album_haven_core', () => {
  const scanTargets = _private.listGroupedPerformanceTargets('scan');
  for (const env of [
    {
      ALBUM_HAVEN_SCAN_PERFORMANCE_ALLOW_SHARED_DATABASE: '1',
      ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL:
        'postgresql://album_haven_migrator@localhost:5432/album_haven_shared',
      ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL:
        'postgresql://album_haven_app@localhost:5432/album_haven_shared',
    },
    {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL:
        'postgresql://album_haven_migrator@localhost:5432/album_haven_core',
      ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL:
        'postgresql://album_haven_app@localhost:5432/album_haven_core',
    },
  ]) {
    assert.throws(
      () => _private.assertScanPerformanceDatabaseConfiguration(scanTargets, env),
      /isolated|dedicated|album_haven_core|shared/i,
    );
  }
});
