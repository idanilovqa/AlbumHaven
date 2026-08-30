const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const authorityPath = path.join(repoRoot, 'scripts', 'performance-threshold-classification.cjs');

let authority = null;
let authorityLoadError = null;
try {
  authority = require(authorityPath);
} catch (error) {
  authorityLoadError = error;
}

test('a shared CommonJS authority owns performance threshold classification', () => {
  assert.equal(
    authorityLoadError,
    null,
    `Expected ${path.relative(repoRoot, authorityPath)} to load: ${authorityLoadError?.message}`,
  );
  assert.equal(typeof authority?.classifyPerformanceThreshold, 'function');
  assert.deepEqual(authority?.PERFORMANCE_THRESHOLD_STATUS, {
    TARGET_MET: 'target-met',
    GRACE_USED: 'grace-used',
    HARD_FAIL: 'hard-fail',
    UNCALIBRATED: 'uncalibrated',
  });
});

test('millisecond observations classify exact target and hard-ceiling boundaries', {
  skip: !authority,
}, () => {
  const classify = authority.classifyPerformanceThreshold;
  const contract = { units: 'ms', targetMaximum: 350, hardCeiling: 550 };

  assert.equal(classify({ ...contract, actual: 350 }).performanceStatus, 'target-met');
  assert.equal(classify({ ...contract, actual: 350 }).passed, true);
  assert.equal(classify({ ...contract, actual: 350.01 }).performanceStatus, 'grace-used');
  assert.equal(classify({ ...contract, actual: 550 }).performanceStatus, 'grace-used');
  assert.equal(classify({ ...contract, actual: 550 }).passed, true);
  assert.equal(classify({ ...contract, actual: 550.01 }).performanceStatus, 'hard-fail');
  assert.equal(classify({ ...contract, actual: 550.01 }).passed, false);
});

test('invalid observations and contradictory threshold contracts fail closed', {
  skip: !authority,
}, () => {
  const classify = authority.classifyPerformanceThreshold;
  const base = { units: 'ms', targetMaximum: 350, hardCeiling: 550 };

  for (const actual of [null, undefined, '', -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = classify({ ...base, actual });
    assert.equal(result.performanceStatus, 'hard-fail');
    assert.equal(result.passed, false);
  }

  for (const contract of [
    { units: 'ms', targetMaximum: -1, hardCeiling: 550, actual: 10 },
    { units: 'ms', targetMaximum: 350, hardCeiling: -1, actual: 10 },
    { units: 'ms', targetMaximum: Number.NaN, hardCeiling: 550, actual: 10 },
    { units: 'ms', targetMaximum: 350, hardCeiling: Number.POSITIVE_INFINITY, actual: 10 },
    { units: 'ms', targetMaximum: 551, hardCeiling: 550, actual: 10 },
  ]) {
    const result = classify(contract);
    assert.equal(result.performanceStatus, 'hard-fail');
    assert.equal(result.passed, false);
  }
});

test('contradictory reported pass and status evidence is never trusted', {
  skip: !authority,
}, () => {
  const classify = authority.classifyPerformanceThreshold;
  const base = { units: 'ms', targetMaximum: 350, hardCeiling: 550 };

  for (const evidence of [
    { actual: 551, reportedPassed: true, reportedStatus: 'target-met' },
    { actual: 400, reportedPassed: true, reportedStatus: 'target-met' },
    { actual: 300, reportedPassed: false, reportedStatus: 'hard-fail' },
    { actual: 300, reportedPassed: true, reportedStatus: 'grace-used' },
  ]) {
    const result = classify({ ...base, ...evidence });
    assert.equal(result.performanceStatus, 'hard-fail');
    assert.equal(result.passed, false);
    assert.equal(result.evidenceConsistent, false);
  }
});

test('non-millisecond ceiling contracts remain supported', {
  skip: !authority,
}, () => {
  const classify = authority.classifyPerformanceThreshold;

  assert.equal(classify({ units: 'bytes', actual: 1024, hardCeiling: 1024 }).performanceStatus, 'target-met');
  assert.equal(classify({ units: 'bytes', actual: 1024, hardCeiling: 1024 }).passed, true);
  assert.equal(classify({ units: 'bytes', actual: 1025, hardCeiling: 1024 }).performanceStatus, 'hard-fail');
  assert.equal(classify({ units: 'bytes', actual: 1025, hardCeiling: 1024 }).passed, false);

  const memorySampleWindow = classify({
    units: 'bytes',
    actual: 1025,
    hardCeiling: 1024,
    reportedPassed: true,
    reportedStatus: 'hard-fail',
    classificationPolicy: 'all-artists-return-memory-sample-window',
    sampleCount: 3,
    overThresholdCount: 1,
    failingSampleCount: 2,
  });
  assert.equal(memorySampleWindow.performanceStatus, 'hard-fail');
  assert.equal(memorySampleWindow.thresholdPassed, false);
  assert.equal(memorySampleWindow.policyPassed, true);
  assert.equal(memorySampleWindow.passed, true);
});

test('classification accepts only the current millisecond and byte units', {
  skip: !authority,
}, () => {
  const classify = authority.classifyPerformanceThreshold;
  for (const units of [undefined, null, '', 'seconds', 'kilobytes', 'MS', 'Bytes']) {
    const result = classify({ units, actual: 10, targetMaximum: 10, hardCeiling: 20 });
    assert.equal(result.performanceStatus, 'hard-fail');
    assert.equal(result.passed, false);
    assert.equal(result.evidenceConsistent, false);

    const uncalibrated = classify({
      units,
      actual: 10,
      targetMaximum: null,
      hardCeiling: null,
      calibrationState: 'uncalibrated',
      blocking: false,
      processPassed: true,
    });
    assert.equal(uncalibrated.performanceStatus, 'hard-fail');
    assert.equal(uncalibrated.passed, false);
    assert.equal(uncalibrated.evidenceConsistent, false);
  }

  assert.equal(classify({ units: 'ms', actual: 10, targetMaximum: 10, hardCeiling: 20 }).passed, true);
  assert.equal(classify({ units: 'bytes', actual: 10, hardCeiling: 20 }).passed, true);
});

test('uncalibrated null thresholds are visible and nonblocking only under explicit policy', {
  skip: !authority,
}, () => {
  const classify = authority.classifyPerformanceThreshold;
  const uncalibrated = {
    units: 'ms',
    actual: 123,
    targetMaximum: null,
    graceMs: null,
    hardCeiling: null,
    calibrationState: 'uncalibrated',
  };

  const advisory = classify({ ...uncalibrated, blocking: false, processPassed: true });
  assert.equal(advisory.performanceStatus, 'uncalibrated');
  assert.equal(advisory.thresholdPassed, null);
  assert.equal(advisory.passed, true);

  const declaredGrace = classify({
    ...uncalibrated,
    graceMs: 200,
    blocking: false,
    processPassed: true,
  });
  assert.equal(declaredGrace.performanceStatus, 'hard-fail');
  assert.equal(declaredGrace.passed, false);

  const blocking = classify({ ...uncalibrated, blocking: true, processPassed: true });
  assert.equal(blocking.performanceStatus, 'uncalibrated');
  assert.equal(blocking.thresholdPassed, null);
  assert.equal(blocking.passed, false);

  const failedProcess = classify({ ...uncalibrated, blocking: false, processPassed: false });
  assert.equal(failedProcess.performanceStatus, 'uncalibrated');
  assert.equal(failedProcess.thresholdPassed, null);
  assert.equal(failedProcess.passed, false);
});

test('runner keeps all-attempt aggregation while reporter keeps majority aggregation', () => {
  const runner = require('../../scripts/run-performance-playwright.cjs')._private;
  const reporter = require('../../scripts/playwright-performance-reporter.cjs')._private;
  const results = [500, 500, 551].map((actual) => ({
    key: 'selectionMs',
    checkpointKey: 'selection',
    units: 'ms',
    actual,
    targetMaximum: 350,
    graceMs: 200,
    allowedMaximum: 550,
    passed: actual <= 550,
    performanceStatus: actual <= 550 ? 'grace-used' : 'hard-fail',
  }));
  const runnerSummary = runner.buildAggregatedThresholdEvaluation(results.map((result) => ({
    status: 0,
    validationResults: [result],
  })));
  const reporterSummary = reporter.buildVerificationMetricSummary(results.map((result) => ({
    benchmarkValidation: { results: [result] },
  })));

  assert.equal(runnerSummary.requiredPassCount, 3);
  assert.equal(runnerSummary.metrics[0].passCount, 2);
  assert.equal(runnerSummary.passed, false);
  assert.equal(reporterSummary.requiredPassCount, 2);
  assert.equal(reporterSummary.metrics[0].passCount, 2);
  assert.equal(reporterSummary.passed, true);
});

test('timing helper, runner, and reporter delegate to the shared authority', () => {
  const consumerPaths = [
    'tests/e2e/helpers/timingBudget.js',
    'scripts/run-performance-playwright.cjs',
    'scripts/playwright-performance-reporter.cjs',
  ];
  const sources = Object.fromEntries(consumerPaths.map((relativePath) => [
    relativePath,
    fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'),
  ]));

  for (const [relativePath, source] of Object.entries(sources)) {
    assert.match(
      source,
      /performance-threshold-classification\.cjs/,
      `${relativePath} must import the shared threshold authority`,
    );
    assert.match(
      source,
      /classifyPerformanceThreshold/,
      `${relativePath} must delegate observation classification`,
    );
  }

  const duplicateClassification = /medianActual\s*<=\s*(?:entry|metric)\.(?:targetMaximum|allowedMaximum)/;
  assert.doesNotMatch(sources['scripts/run-performance-playwright.cjs'], duplicateClassification);
  assert.doesNotMatch(sources['scripts/playwright-performance-reporter.cjs'], duplicateClassification);
});

test('the All Artists memory result emits its explicit sample-window policy evidence', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/helpers/syntheticPerformanceBenchmark.js'),
    'utf8',
  );
  for (const field of [
    'all-artists-return-memory-sample-window',
    'sampleCount',
    'overThresholdCount',
    'failingSampleCount',
    'thresholdPassed',
    'policyPassed',
  ]) {
    assert.match(source, new RegExp(field), `All Artists return-memory evidence must include ${field}`);
  }
});
