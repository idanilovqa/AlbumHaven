const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const performanceRunner = require('../../scripts/run-performance-playwright.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const performanceContract = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'tests', 'ci', 'performance-targets.json'),
  'utf8',
));
const testDataMatrix = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'tests', 'ci', 'test-data-matrix.json'),
  'utf8',
));
const performanceConfigs = new Set([
  'playwright.synthetic-large-library.config.cjs',
  'playwright.utility-problematic-files.config.cjs',
  'playwright.performance.config.cjs',
  'playwright.scan-performance.config.cjs',
]);

function usePreloadedFixtureEnv(t, targetName) {
  const target = performanceRunner.PERFORMANCE_TARGETS[targetName];
  const fixtureRoot = path.join(repoRoot, '.tmp', `performance-cloud-contract-${target.fixtureProfile}`);
  const overrides = {
    PLAYWRIGHT_PYTHON: 'C:\\Python\\python.exe',
    ALBUM_HAVEN_FIXTURE_PROFILE: target.fixtureProfile,
    ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
    ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
    DATABASE_MIGRATOR_URL: 'postgresql://album_haven_migrator_cloud_contract@127.0.0.1:5432/album_haven_ci_cloud_contract',
  };
  const original = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function caseIdentity(entry) {
  return [entry.config, entry.project, entry.test, entry.case].join('::');
}

function runnerTargetSelector(target) {
  return new RegExp(target.grep || target.casePattern || 'a^');
}

function runArtistFamilyCiPolicy(t, attempts) {
  usePreloadedFixtureEnv(t, 'artist-family');
  const originalSpawnSync = childProcess.spawnSync;
  const originalReadFileSync = fs.readFileSync;
  const originalDateNow = Date.now;
  let activeAttempt = 0;

  Date.now = () => 1700000000000;
  childProcess.spawnSync = (command, _args, options) => {
    if (command !== process.execPath) {
      return { error: null, status: 0, stdout: '', stderr: '' };
    }
    activeAttempt = Number(options.env.PLAYWRIGHT_PERF_VERIFICATION_ATTEMPT);
    const attempt = attempts[activeAttempt - 1] || attempts.at(-1);
    const target = performanceRunner.PERFORMANCE_TARGETS['artist-family'];
    const [siblingCase, metricCase] = target.casePatterns;
    return {
      error: null,
      status: attempt.processStatus,
      stdout: [
        `ok 1 [chromium] > ${target.specPath}:1:1 > policy fixture > ${siblingCase}`,
        `${attempt.processStatus === 0 ? 'ok' : 'not ok'} 2 [chromium] > ${target.specPath}:1:1 > policy fixture > ${metricCase}`,
        '[playwright-performance-reporter] flush-complete',
        '',
      ].join('\n'),
      stderr: '',
    };
  };
  fs.readFileSync = (filePath, encoding) => {
    const normalizedPath = String(filePath).replace(/\\/g, '/');
    const attempt = attempts[activeAttempt - 1] || attempts.at(-1);
    if (normalizedPath.endsWith('/.last-run.json')) {
      return JSON.stringify({
        status: attempt.processStatus === 0 ? 'passed' : 'failed',
        failedTests: attempt.processStatus === 0 ? [] : ['artist-family-timing-budget'],
      });
    }
    if (normalizedPath.endsWith('/artistFamilyLocal/index.json')) {
      return JSON.stringify({
        runs: [{
          metricsPath: 'latest-run.json',
          verificationRunGroup: {
            id: 'artist-family-1700000000000',
            label: 'artist-family',
            attempt: activeAttempt,
            maxAttempts: 3,
          },
        }],
      });
    }
    if (normalizedPath.endsWith('/artistFamilyLocal/latest-run.json')) {
      const passed = attempt.actual <= 850;
      return JSON.stringify({
        runId: `artist-family-attempt-${activeAttempt}`,
        caseId: performanceRunner.PERFORMANCE_TARGETS['artist-family'].metricCasePattern,
        selectedContract: 'ci',
        rawMetrics: {
          benchmarkValidation: {
            selectedContract: 'ci',
            functionalChecksComplete: true,
            nonTimingChecksComplete: true,
            results: [{
              key: 'treeNealSelectionMs',
              metricId: 'artist-family.treeNealSelectionMs',
              contractName: 'ci',
              units: 'ms',
              actual: attempt.actual,
              targetMaximum: 650,
              graceMs: 200,
              hardCeiling: 850,
              allowedMaximum: 850,
              passed,
              performanceStatus: passed
                ? (attempt.actual <= 650 ? 'target-met' : 'grace-used')
                : 'hard-fail',
            }],
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

  return performanceRunner._private.runTargetWithPolicy(
    performanceRunner.PERFORMANCE_TARGETS['artist-family'],
    {
      browser: 'chrome',
      headless: true,
      repeatCount: 1,
      targetInput: 'artist-family',
      preparedFixture: true,
      selectedContract: 'ci',
      trustedCi: true,
    },
    { realAppPort: 5001, scanAppPort: 4174 },
  );
}

test('performance runner mirrors the reviewed target inventory and approved fixture profiles', () => {
  const contractTargets = new Map(performanceContract.targets.map((target) => [target.name, target]));
  const runnerTargets = new Map(Object.entries(performanceRunner.PERFORMANCE_TARGETS));

  assert.deepEqual([...runnerTargets.keys()].sort(), [...contractTargets.keys()].sort());
  for (const [name, contractTarget] of contractTargets) {
    const runnerTarget = runnerTargets.get(name);
    assert.equal(runnerTarget.fixtureProfile, contractTarget.fixtureProfile, name);
    assert.equal(runnerTarget.specPath, contractTarget.cases[0].test, name);
  }
});

test('every discovered performance case has reviewed ownership selected by its runner target', () => {
  const discoveredCases = new Set(
    testDataMatrix
      .filter((entry) => performanceConfigs.has(entry.config))
      .map(caseIdentity),
  );
  const ownedCases = new Set();
  const unselectedCases = [];
  const unreportedCases = [];

  for (const contractTarget of performanceContract.targets) {
    const runnerTarget = performanceRunner.PERFORMANCE_TARGETS[contractTarget.name];
    assert.ok(runnerTarget, contractTarget.name);
    const selector = runnerTargetSelector(runnerTarget);
    for (const ownedCase of contractTarget.cases) {
      const identity = caseIdentity(ownedCase);
      assert.equal(ownedCases.has(identity), false, `duplicate ownership: ${identity}`);
      ownedCases.add(identity);
      if (!selector.test(ownedCase.case)) unselectedCases.push(`${contractTarget.name}: ${identity}`);
      const reportedStatus = performanceRunner._private.resolveBatchTargetStatus(
        runnerTarget,
        [{
          status: 'failed',
          suiteName: '',
          testName: ownedCase.case,
          fullName: ownedCase.case,
        }],
        0,
      );
      if (reportedStatus !== 1) unreportedCases.push(`${contractTarget.name}: ${identity}`);
    }
  }

  assert.deepEqual([...ownedCases].sort(), [...discoveredCases].sort());
  assert.deepEqual({ unselectedCases, unreportedCases }, {
    unselectedCases: [],
    unreportedCases: [],
  });
});

test('the default performance group contains every reviewed target', () => {
  const reviewedNames = performanceContract.targets.map((target) => target.name);
  const contractDefaultNames = performanceContract.targets
    .filter((target) => target.defaultMember)
    .map((target) => target.name);
  const runnerDefaultNames = performanceRunner._private
    .listDefaultPerformanceTargets()
    .map((target) => target.aliasNames[0]);

  assert.deepEqual(contractDefaultNames, reviewedNames);
  assert.deepEqual(runnerDefaultNames, contractDefaultNames);
});

test('every reviewed performance target invokes Playwright with one worker', () => {
  for (const contractTarget of performanceContract.targets) {
    const runnerArgs = performanceRunner._private.buildRunnerArgs({
      browser: 'chrome',
      grep: '',
      group: 'all',
      headless: true,
      repeatCount: 1,
      targetInput: contractTarget.name,
    });

    assert.equal(runnerArgs.filter((argument) => argument === '--workers=1').length, 1, contractTarget.name);
  }
});

test('a passing first performance run completes without recovery', (t) => {
  const result = runArtistFamilyCiPolicy(t, [
    { processStatus: 0, actual: 800 },
  ]);

  assert.deepEqual(result.attemptRecords.map((record) => record.attemptNumber), [1]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.finalStatus, 'passed');
  assert.equal(result.recoveryUsed, false);
  assert.equal(result.selectedContract, 'ci');
});

test('a missing-metrics failure is authoritative and does not trigger timing recovery', (t) => {
  usePreloadedFixtureEnv(t, 'idle-memory');
  const originalSpawnSync = childProcess.spawnSync;
  const attempts = [];
  childProcess.spawnSync = (command, _args, options) => {
    if (command !== process.execPath) {
      return { error: null, status: 0, stdout: '', stderr: '' };
    }
    attempts.push(Number(options.env.PLAYWRIGHT_PERF_VERIFICATION_ATTEMPT));
    return {
      error: null,
      status: attempts.length === 1 ? 1 : 0,
      stdout: '',
      stderr: '',
    };
  };
  t.after(() => {
    childProcess.spawnSync = originalSpawnSync;
  });

  const result = performanceRunner._private.runTargetWithPolicy(
    performanceRunner.PERFORMANCE_TARGETS['idle-memory'],
    {
      browser: 'chrome',
      grep: '',
      group: 'all',
      headless: true,
      repeatCount: 1,
      targetInput: 'idle-memory',
    },
    { realAppPort: 5001, scanAppPort: 4174 },
  );

  assert.deepEqual(attempts, [1]);
  assert.deepEqual(result.attemptRecords.map((record) => record.status), [1]);
  assert.equal(result.exitCode, 1);
});

test('a valid CI timing hard failure recovers on attempt two and retains both attempts', (t) => {
  const result = runArtistFamilyCiPolicy(t, [
    { processStatus: 1, actual: 851 },
    { processStatus: 0, actual: 800 },
  ]);

  assert.deepEqual(result.attemptRecords.map((record) => record.attemptNumber), [1, 2]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.finalStatus, 'passed');
  assert.equal(result.recoveryUsed, true);
  assert.equal(result.selectedContract, 'ci');
});

test('a valid CI timing hard failure may recover on the final third attempt', (t) => {
  const result = runArtistFamilyCiPolicy(t, [
    { processStatus: 1, actual: 851 },
    { processStatus: 1, actual: 900 },
    { processStatus: 0, actual: 650 },
  ]);

  assert.deepEqual(result.attemptRecords.map((record) => record.attemptNumber), [1, 2, 3]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.attemptCount, 3);
  assert.equal(result.finalStatus, 'passed');
  assert.equal(result.recoveryUsed, true);
});

test('three valid CI timing hard failures are terminal', (t) => {
  const result = runArtistFamilyCiPolicy(t, [
    { processStatus: 1, actual: 851 },
    { processStatus: 1, actual: 900 },
    { processStatus: 1, actual: 1000 },
  ]);

  assert.deepEqual(result.attemptRecords.map((record) => record.attemptNumber), [1, 2, 3]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.attemptCount, 3);
  assert.equal(result.finalStatus, 'failed');
  assert.equal(result.recoveryUsed, true);
});
