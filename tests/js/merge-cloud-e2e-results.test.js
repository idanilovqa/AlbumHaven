const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const mergerPath = path.join(repoRoot, 'scripts', 'ci', 'merge-cloud-e2e-results.cjs');
const materializerPath = path.join(repoRoot, 'scripts', 'ci', 'materialize-cloud-e2e-report.cjs');
const validatorPath = path.join(repoRoot, 'scripts', 'ci', 'validate-cloud-test-report.cjs');
const functionalContract = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'tests', 'ci', 'functional-shards.json'),
  'utf8',
));
const performanceContract = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'tests', 'ci', 'performance-targets.json'),
  'utf8',
));
const mergerExists = fs.existsSync(mergerPath);
const mergerTest = mergerExists ? test : test.skip;

const RUN_ID = '32837431728';
const RUN_ATTEMPT = '2';
const GENERATED_AT = '2026-08-25T19:00:00.000Z';
const SAFE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function exactInventory() {
  return {
    functional: functionalContract.shards.map((shard) => ({
      childId: `functional:${shard.name}`,
      artifactName: `functional-blob-${shard.name}-${RUN_ATTEMPT}`,
      shard: shard.name,
    })),
    performance: performanceContract.targets.map((target) => ({
      childId: `performance:${target.name}`,
      artifactName: `performance-result-${target.name}-${RUN_ATTEMPT}`,
      target: target.name,
      measurementExpected: target.measurementExpected !== false,
      fixtureMode: target.fixtureMode,
    })),
  };
}

function fingerprint(overrides = {}) {
  return {
    runnerImage: 'windows-2025',
    chromeVersion: '151.0.7922.138',
    fixtureRelease: 'fixtures-v1.0.19',
    fixtureSchemaVersion: 1,
    postgresMajor: 17,
    measurementContract: 'performance-v1',
    ...overrides,
  };
}

function functionalArtifact(row, index) {
  const failed = index === 0;
  return {
    name: row.artifactName,
    category: 'structured-report',
    retentionDays: 14,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    childId: row.childId,
    payload: {
      schemaVersion: 1,
      shard: row.shard,
      conclusion: failed ? 'failure' : 'success',
      cases: [{
        testId: `FTC-FUNCTIONAL-${index + 1}`,
        name: failed ? 'renders a safe synthetic failure' : `passes ${row.shard}`,
        status: failed ? 'failed' : 'passed',
        durationMs: 100 + index,
        steps: [{ title: 'Open synthetic fixture', durationMs: 25 }],
        stackSummary: failed ? 'Expected the synthetic album card at assertion line 42' : null,
        finalScreenshot: failed ? {
          status: 'validated',
          publicPath: `screenshots/${row.shard}-final.png`,
          width: 1,
          height: 1,
          sha256: crypto.createHash('sha256').update(SAFE_PNG).digest('hex'),
          bytes: SAFE_PNG,
        } : null,
      }],
    },
  };
}

function performanceAttempt(attempt, overrides = {}) {
  return {
    attempt,
    primary: attempt === 1,
    status: attempt === 1 ? 'failed' : 'passed',
    classification: 'uncalibrated',
    actualValue: 1000 + attempt,
    units: 'ms',
    startedAt: GENERATED_AT,
    retainedArtifacts: [
      { kind: 'trace', path: 'C:\\runner\\trace.zip' },
      { kind: 'log', path: 'C:\\runner\\runtime.log' },
    ],
    baseURL: 'http://127.0.0.1:5001',
    stack: 'at privateCall (C:\\Users\\owner\\private.js:42:1)',
    ...overrides,
  };
}

function performanceArtifact(row, index) {
  const diagnosticTarget = index === 0;
  const coverageOnly = row.measurementExpected === false;
  return {
    name: row.artifactName,
    category: 'structured-report',
    retentionDays: 14,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    childId: row.childId,
    payload: {
      schemaVersion: 1,
      target: row.target,
      conclusion: coverageOnly ? 'success' : (diagnosticTarget ? 'failure' : 'success'),
      blocking: false,
      fingerprint: fingerprint(),
      ...(coverageOnly ? {
        measurementAvailable: false, coverageOnly: true, attemptCount: 1,
        attempts: [], series: [], testCount: 2,
        cases: ['FTC-OPS-003C', 'FTC-OPS-003E'].map((testId, caseIndex) => ({
          testId, name: `${testId} scan-page coverage`, status: 'passed', durationMs: 100 + caseIndex,
          steps: [{ title: 'Exercise Scan Page contract', status: 'passed', durationMs: 20 }],
          stackSummary: '', finalScreenshot: null,
        })),
      } : {
        selectedContract: 'local',
        attemptCount: diagnosticTarget ? 3 : 1,
        finalStatus: diagnosticTarget ? 'failed' : 'passed',
        recoveryUsed: diagnosticTarget,
        primaryAttempt: diagnosticTarget ? null : 1,
        attempts: diagnosticTarget
          ? [1, 2, 3].map((attempt) => performanceAttempt(attempt, {
            status: 'failed', classification: 'hard-fail',
          }))
          : [performanceAttempt(1, { status: 'passed' })],
      }),
    },
  };
}

function sampleInput() {
  const inventory = exactInventory();
  return {
    repoRoot,
    run: {
      repository: 'idanilovqa/AlbumHaven',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      pullRequest: 47,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
      event: 'pull_request',
      generatedAt: GENERATED_AT,
      actionsUrl: `https://github.com/idanilovqa/AlbumHaven/actions/runs/${RUN_ID}`,
    },
    fixture: {
      release: 'fixtures-v1.0.19',
      manifestSha256: 'cb9ed982ec5afd191e77c99f90cc42ecaec228086d9147df4fdd6b1b621b8d51',
      schemaVersion: 1,
    },
    resultArtifacts: [
      ...inventory.functional.map(functionalArtifact),
      ...inventory.performance.map(performanceArtifact),
    ],
    debugArtifacts: [
      {
        name: `functional-debug-${inventory.functional[0].shard}-${RUN_ATTEMPT}`,
        childId: inventory.functional[0].childId,
        category: 'debug',
        retentionDays: 7,
      },
      {
        name: `performance-diagnostics-${inventory.performance[0].target}-${RUN_ATTEMPT}`,
        childId: inventory.performance[0].childId,
        category: 'debug',
        retentionDays: 7,
      },
    ],
    previousPerformanceHistory: [],
    now: new Date('2026-08-25T20:00:00.000Z'),
  };
}

function clone(value) {
  return structuredClone(value);
}

function scanPageRow() {
  return {
    target: 'scan-page', artifactName: `performance-result-scan-page-${RUN_ATTEMPT}`,
    childId: 'performance:scan-page', measurementExpected: false, fixtureMode: 'generated-isolated',
  };
}

function scanPagePlaywrightReport({ caseIds = ['FTC-OPS-003C', 'FTC-OPS-003E'], failedIds = [] } = {}) {
  return {
    suites: [{
      title: 'scanPerformance.spec.js',
      specs: caseIds.map((caseId, index) => {
        const failed = failedIds.includes(caseId);
        return {
          title: `${caseId} ${index === 0 ? 'preserves browse context' : 'cancels scans'}`,
          file: 'tests/e2e/scanPerformance/scanPerformance.spec.js',
          tests: [{
            status: failed ? 'unexpected' : 'expected',
            results: [{
              status: failed ? 'failed' : 'passed',
              duration: 100 + index,
              steps: [
                { title: 'Open Scan Page', duration: 20 },
                {
                  title: index === 0 ? 'Restore the prior gallery' : 'Cancel the active scan',
                  duration: 30,
                  ...(failed ? { error: { message: `failed ${caseId} step` } } : {}),
                },
              ],
              ...(failed ? {
                error: {
                  message: `${caseId} expected the retained gallery contract`,
                  stack: `Error: ${caseId} expected the retained gallery contract\n    at scanPerformance.spec.js:42:1`,
                },
                attachments: [
                  { name: 'intermediate', contentType: 'image/png', body: SAFE_PNG.toString('base64') },
                  { name: 'final', contentType: 'image/png', body: SAFE_PNG.toString('base64') },
                ],
              } : { attachments: [] }),
            }],
          }],
        };
      }),
    }],
    errors: [],
    stats: { unexpected: failedIds.length },
  };
}

function writeCoverageTarget(root, {
  conclusion = 'success',
  report = scanPagePlaywrightReport(),
  createAttempt = true,
  writeReport = true,
} = {}) {
  const targetRoot = path.join(root, 'scan-page');
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'ci-job.json'), JSON.stringify({
    target: 'scan-page', runAttempt: RUN_ATTEMPT, conclusion, blocking: false,
  }));
  if (createAttempt) {
    const attemptRoot = path.join(targetRoot, 'attempt-1');
    fs.mkdirSync(attemptRoot, { recursive: true });
    if (writeReport) fs.writeFileSync(path.join(attemptRoot, 'report.json'), JSON.stringify(report));
  }
  return targetRoot;
}

test('cloud E2E merger module exists', () => {
  assert.equal(mergerExists, true, 'Missing scripts/ci/merge-cloud-e2e-results.cjs');
});

mergerTest('expected child inventory is exactly four functional shards and 19 performance targets', () => {
  const { buildExpectedCloudE2EInventory } = require(mergerPath);
  const expected = exactInventory();
  const actual = buildExpectedCloudE2EInventory({
    functionalContract,
    performanceContract,
    runAttempt: RUN_ATTEMPT,
  });

  assert.equal(actual.functional.length, 4);
  assert.equal(actual.performance.length, 19);
  assert.deepEqual(actual, expected);
  assert.equal(new Set([
    ...actual.functional.map((row) => row.childId),
    ...actual.performance.map((row) => row.childId),
  ]).size, 23);
  assert.deepEqual(actual.performance.filter((row) => !row.measurementExpected).map((row) => row.target), ['scan-page']);

  const driftedContract = clone(performanceContract);
  driftedContract.targets.find((target) => target.name === 'idle-memory').measurementExpected = false;
  assert.throws(() => buildExpectedCloudE2EInventory({
    functionalContract, performanceContract: driftedContract, runAttempt: RUN_ATTEMPT,
  }), /only scan-page as coverage-only/i);
});

mergerTest('Playwright JSON materialization keeps steps and only the final failed PNG', () => {
  const { flattenSuites } = require(materializerPath);
  const cases = flattenSuites([{ title: 'Gallery', specs: [{
    title: 'FTC-GALLERY-001 opens an album', file: 'gallery.spec.js', tests: [{
      status: 'unexpected', results: [{
        status: 'failed', duration: 42, error: { message: 'expected card' },
        steps: [{ title: 'Open album', duration: 12 }],
        attachments: [
          { name: 'first', contentType: 'image/png', body: SAFE_PNG.toString('base64') },
          { name: 'final', contentType: 'image/png', body: SAFE_PNG.toString('base64') },
          { name: 'trace', contentType: 'application/zip', body: 'private' },
        ],
      }],
    }],
  }]}]);

  assert.equal(cases.length, 1);
  assert.equal(cases[0].status, 'failed');
  assert.deepEqual(cases[0].steps, [{ title: 'Open album', status: 'passed', durationMs: 12 }]);
  assert.deepEqual(cases[0].finalScreenshot.bytes, SAFE_PNG);
  assert.equal('attachments' in cases[0], false);

  const timedOut = flattenSuites([{ specs: [{ title: 'FTC-TIMEOUT-001', tests: [{
    results: [{ status: 'timedOut', duration: 10, attachments: [
      { contentType: 'image/png', body: SAFE_PNG.toString('base64') },
    ] }],
  }] }] }]);
  assert.deepEqual(timedOut[0].finalScreenshot.bytes, SAFE_PNG);
});

mergerTest('Playwright top-level errors fail a functional shard even when it has no test cases', () => {
  const { functionalArtifact: materializeFunctional } = require(materializerPath);
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cloud-functional-'));
  try {
    const shardRoot = path.join(root, 'gallery-search-visual');
    fs.mkdirSync(shardRoot, { recursive: true });
    fs.writeFileSync(path.join(shardRoot, 'report.json'), JSON.stringify({
      suites: [], errors: [{ message: 'global setup failed' }], stats: { unexpected: 0 },
    }));
    const artifact = materializeFunctional(root, {
      shard: 'gallery-search-visual', artifactName: 'functional-blob-gallery-search-visual-2',
      childId: 'functional:gallery-search-visual',
    }, { runId: RUN_ID, runAttempt: RUN_ATTEMPT });
    assert.equal(artifact.payload.conclusion, 'failure');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

mergerTest('performance materialization keeps separate history series for every test metric', () => {
  const { performanceSeries } = require(materializerPath);
  const rawMetric = (reportId, title, checkpointKey, description, actual, units) => ({
    reportId, title, status: 'passed', startedAt: GENERATED_AT,
    rawMetrics: { benchmarkValidation: { results: [{
      checkpointKey, description, actual, units, calibrationState: 'uncalibrated',
    }] } },
  });
  const series = performanceSeries([
    {
      ...rawMetric('startup-test', 'Startup test', 'visible', 'Visible covers', 320, 'ms'),
      rawMetrics: { benchmarkValidation: { results: [
        { checkpointKey: 'visible', description: 'Visible covers', actual: 320, units: 'ms', calibrationState: 'uncalibrated' },
        { checkpointKey: 'memory', description: 'Peak memory', actual: 50000000, units: 'bytes', calibrationState: 'uncalibrated' },
      ] } },
    },
    rawMetric('scroll-test', 'Scroll test', 'complete', 'Scroll complete', 810, 'ms'),
  ]);
  assert.equal(series.length, 3);
  assert.deepEqual(series.map((entry) => entry.title).sort(), [
    'Scroll test — Scroll complete', 'Startup test — Peak memory', 'Startup test — Visible covers',
  ]);
  assert.deepEqual(series.map((entry) => entry.attempts[0].units).sort(), ['bytes', 'ms', 'ms']);
});

mergerTest('performance materialization consumes the strict policy result and preserves target-met classification', () => {
  const { performanceArtifact: materializePerformance } = require(materializerPath);
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cloud-policy-result-'));
  try {
    const targetRoot = path.join(root, 'playback-start');
    const historyRoot = path.join(targetRoot, 'history', 'playbackStartLocal', 'runs');
    const records = [
      { attemptNumber: 1, outcome: 'hard-fail', classification: 'hard-fail', actual: 2050, runId: 'policy-run-1' },
      { attemptNumber: 2, outcome: 'passed', classification: 'target-met', actual: 1750, runId: 'policy-run-2' },
    ];
    for (const record of records) {
      const runRoot = path.join(historyRoot, record.runId);
      const attemptRoot = path.join(targetRoot, `attempt-${record.attemptNumber}`);
      fs.mkdirSync(runRoot, { recursive: true });
      fs.mkdirSync(attemptRoot, { recursive: true });
      fs.writeFileSync(path.join(attemptRoot, 'report.json'), JSON.stringify({ status: record.outcome }));
      fs.writeFileSync(path.join(runRoot, 'metrics.json'), JSON.stringify({
        runId: record.runId,
        reportId: 'playbackStartLocal',
        title: 'Playback start',
        status: record.outcome === 'passed' ? 'passed' : 'failed',
        startedAt: GENERATED_AT,
        verificationRunGroup: { attempt: record.attemptNumber },
        rawMetrics: { benchmarkValidation: { results: [{
          checkpointKey: 'maximum-playback-start',
          description: 'Maximum playback start',
          actual: record.actual,
          units: 'ms',
          targetMaximum: 1800,
          graceMs: 200,
          hardCeiling: 2000,
          performanceStatus: record.classification,
          passed: record.outcome === 'passed',
        }] } },
      }));
    }
    fs.writeFileSync(path.join(targetRoot, 'ci-job.json'), JSON.stringify({
      target: 'playback-start', runAttempt: RUN_ATTEMPT, conclusion: 'success', blocking: false,
    }));
    fs.writeFileSync(path.join(targetRoot, 'policy-result.json'), JSON.stringify({
      schemaVersion: 1,
      target: 'playback-start',
      selectedContract: 'ci',
      attemptCount: 2,
      finalStatus: 'passed',
      recoveryUsed: true,
      primaryAttempt: 2,
      attemptRecords: records.map((record) => ({
        attemptNumber: record.attemptNumber,
        outcome: record.outcome,
        eligibleForRecovery: record.outcome === 'hard-fail',
        failureCategory: record.outcome === 'hard-fail' ? 'timing-hard-ceiling' : null,
        processStatus: record.outcome === 'passed' ? 0 : 1,
        reporterFinalized: true,
        metricsComplete: true,
        functionalChecksComplete: true,
        nonTimingChecksComplete: true,
        runId: record.runId,
        metricsPath: path.relative(targetRoot, path.join(historyRoot, record.runId, 'metrics.json')),
        reportPath: path.relative(targetRoot, path.join(targetRoot, `attempt-${record.attemptNumber}`, 'report.json')),
      })),
    }));

    const artifact = materializePerformance(root, {
      target: 'playback-start', artifactName: `performance-result-playback-start-${RUN_ATTEMPT}`,
      childId: 'performance:playback-start', measurementExpected: true, fixtureMode: 'generated-isolated',
    }, { runId: RUN_ID, runAttempt: RUN_ATTEMPT, generatedAt: GENERATED_AT }, fingerprint());

    assert.equal(artifact.payload.conclusion, 'success');
    assert.equal(artifact.payload.selectedContract, 'ci');
    assert.equal(artifact.payload.attemptCount, 2);
    assert.equal(artifact.payload.primaryAttempt, 2);
    assert.deepEqual(
      artifact.payload.attempts.map((attempt) => attempt.classification),
      ['hard-fail', 'target-met'],
    );
    assert.deepEqual(
      artifact.payload.attempts.map((attempt) => attempt.failureCategory),
      ['timing-hard-ceiling', null],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

mergerTest('coverage-only materialization derives both scan-page cases from structured Playwright evidence', () => {
  const { performanceArtifact: materializePerformance } = require(materializerPath);
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cloud-performance-'));
  try {
    writeCoverageTarget(root);
    const artifact = materializePerformance(root, scanPageRow(), {
      runId: RUN_ID, runAttempt: RUN_ATTEMPT, generatedAt: GENERATED_AT,
    }, fingerprint());

    assert.equal(artifact.payload.conclusion, 'success');
    assert.equal(artifact.payload.measurementAvailable, false);
    assert.equal(artifact.payload.coverageOnly, true);
    assert.equal(artifact.payload.attemptCount, 1);
    assert.deepEqual(artifact.payload.attempts, []);
    assert.equal(artifact.payload.testCount, 2);
    assert.deepEqual(artifact.payload.cases.map((entry) => entry.testId), ['FTC-OPS-003C', 'FTC-OPS-003E']);
    assert.equal(artifact.payload.cases.every((entry) => entry.status === 'passed'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

mergerTest('coverage-only materialization rejects zero attempts and missing structured Playwright evidence', () => {
  const { performanceArtifact: materializePerformance } = require(materializerPath);
  const run = { runId: RUN_ID, runAttempt: RUN_ATTEMPT, generatedAt: GENERATED_AT };
  const zeroRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cloud-performance-zero-'));
  const missingRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cloud-performance-missing-'));
  try {
    writeCoverageTarget(zeroRoot, { createAttempt: false });
    assert.throws(
      () => materializePerformance(zeroRoot, scanPageRow(), run, fingerprint()),
      /missing.*attempt|attempt.*required|requires.*attempt/i,
    );

    writeCoverageTarget(missingRoot, { writeReport: false });
    assert.throws(
      () => materializePerformance(missingRoot, scanPageRow(), run, fingerprint()),
      /missing.*playwright|missing.*report|structured.*evidence/i,
    );
  } finally {
    fs.rmSync(zeroRoot, { recursive: true, force: true });
    fs.rmSync(missingRoot, { recursive: true, force: true });
  }
});

mergerTest('coverage-only materialization rejects malformed, incomplete, and conclusion-inconsistent evidence', () => {
  const { performanceArtifact: materializePerformance } = require(materializerPath);
  const run = { runId: RUN_ID, runAttempt: RUN_ATTEMPT, generatedAt: GENERATED_AT };
  const malformedRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cloud-performance-malformed-'));
  const incompleteRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cloud-performance-incomplete-'));
  const inconsistentRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cloud-performance-inconsistent-'));
  try {
    const malformedTarget = writeCoverageTarget(malformedRoot);
    fs.writeFileSync(path.join(malformedTarget, 'attempt-1', 'report.json'), '{broken json');
    assert.throws(
      () => materializePerformance(malformedRoot, scanPageRow(), run, fingerprint()),
      /json|malformed.*playwright|malformed.*report/i,
    );

    writeCoverageTarget(incompleteRoot, {
      report: scanPagePlaywrightReport({ caseIds: ['FTC-OPS-003C'] }),
    });
    assert.throws(
      () => materializePerformance(incompleteRoot, scanPageRow(), run, fingerprint()),
      /FTC-OPS-003E|expected.*scan-page|incomplete/i,
    );

    writeCoverageTarget(inconsistentRoot, {
      conclusion: 'success',
      report: scanPagePlaywrightReport({ failedIds: ['FTC-OPS-003C'] }),
    });
    assert.throws(
      () => materializePerformance(inconsistentRoot, scanPageRow(), run, fingerprint()),
      /conclusion.*mismatch|inconsistent.*conclusion/i,
    );
  } finally {
    fs.rmSync(malformedRoot, { recursive: true, force: true });
    fs.rmSync(incompleteRoot, { recursive: true, force: true });
    fs.rmSync(inconsistentRoot, { recursive: true, force: true });
  }
});

mergerTest('a failed coverage-only target renders per-test steps, stacks, and correctly mapped final screenshots without graph samples', () => {
  const { mergeCloudE2EResults } = require(mergerPath);
  const input = sampleInput();
  const artifact = input.resultArtifacts.find((entry) => entry.childId === 'performance:scan-page');
  artifact.payload = {
    schemaVersion: 1,
    target: 'scan-page',
    conclusion: 'failure',
    blocking: false,
    fingerprint: fingerprint(),
    measurementAvailable: false,
    coverageOnly: true,
    attemptCount: 1,
    attempts: [],
    series: [],
    testCount: 2,
    cases: ['FTC-OPS-003C', 'FTC-OPS-003E'].map((testId, index) => ({
      testId,
      name: `${testId} ${index === 0 ? 'preserves browse context' : 'cancels scans'}`,
      status: 'failed',
      durationMs: 100 + index,
      steps: [
        { title: 'Open Scan Page', status: 'passed', durationMs: 20 },
        { title: index === 0 ? 'Restore the prior gallery' : 'Cancel the active scan', status: 'failed', durationMs: 30 },
      ],
      stackSummary: `${testId} expected the retained gallery contract at scanPerformance.spec.js:42:1`,
      finalScreenshot: {
        status: 'validated',
        publicPath: `screenshots/performance-scan-page-${testId.toLowerCase()}-final.png`,
        width: 1,
        height: 1,
        sha256: crypto.createHash('sha256').update(SAFE_PNG).digest('hex'),
        bytes: SAFE_PNG,
      },
    })),
  };

  const report = mergeCloudE2EResults(input);
  const summary = report.verificationEvidence.performance.find((entry) => entry.target === 'scan-page');
  const page = report.pagesFiles[`runs/${RUN_ID}/${RUN_ATTEMPT}/performance/scan-page/index.html`];
  const history = JSON.parse(report.pagesFiles['performance-history.json']);

  assert.deepEqual(summary, {
    target: 'scan-page', classification: 'coverage-only', blocking: false,
    measurementAvailable: false, coverageStatus: 'failure', actualValue: null, units: '', primaryAttempt: null,
    historyPath: 'performance/scan-page/',
    testCount: 2,
    failed: 2,
  });
  assert.match(page, /coverage-only target validates behavior/i);
  assert.match(page, /Coverage-only result/i);
  for (const testId of ['FTC-OPS-003C', 'FTC-OPS-003E']) {
    assert.match(page, new RegExp(testId));
    assert.match(page, new RegExp(`${testId} expected the retained gallery contract`));
    assert.match(page, new RegExp(`performance-scan-page-${testId.toLowerCase()}-final\\.png`));
    assert.deepEqual(
      report.pagesFiles[`runs/${RUN_ID}/${RUN_ATTEMPT}/screenshots/performance-scan-page-${testId.toLowerCase()}-final.png`],
      SAFE_PNG,
    );
  }
  assert.match(page, /Restore the prior gallery/);
  assert.match(page, /Cancel the active scan/);
  assert.match(page, /authenticated steps, stacktrace, trace, and full failure evidence/i);
  assert.match(page, /"coverageOnly":true/);
  assert.match(page, /"series":\[\]/);
  assert.equal(history.some((entry) => entry.target === 'scan-page' && entry.runId === RUN_ID), false);
  assert.equal(report.verificationEvidence.overallConclusion, 'failure');
});

mergerTest('missing, duplicate, malformed, and mismatched result artifacts fail closed', () => {
  const { mergeCloudE2EResults } = require(mergerPath);

  const missing = sampleInput();
  const missingName = missing.resultArtifacts.pop().name;
  assert.throws(
    () => mergeCloudE2EResults(missing),
    new RegExp(`missing result artifact.*${missingName}`, 'i'),
  );

  const duplicate = sampleInput();
  duplicate.resultArtifacts.push(clone(duplicate.resultArtifacts[0]));
  assert.throws(
    () => mergeCloudE2EResults(duplicate),
    /duplicate result artifact.*functional-blob/i,
  );

  const malformedFunctional = sampleInput();
  malformedFunctional.resultArtifacts[0].payload.cases[0].durationMs = -1;
  assert.throws(
    () => mergeCloudE2EResults(malformedFunctional),
    /malformed functional|Playwright/i,
  );

  const missingMeasuredPolicy = sampleInput();
  const measuredArtifact = missingMeasuredPolicy.resultArtifacts.find(
    (entry) => entry.childId === 'performance:playback-start',
  );
  delete measuredArtifact.payload.selectedContract;
  assert.throws(
    () => mergeCloudE2EResults(missingMeasuredPolicy),
    /malformed performance policy result playback-start/i,
  );

  const malformedPerformance = sampleInput();
  const performance = malformedPerformance.resultArtifacts.find((artifact) => (
    artifact.childId.startsWith('performance:')
  ));
  performance.payload.attempts[0].actualValue = Number.NaN;
  assert.throws(
    () => mergeCloudE2EResults(malformedPerformance),
    /malformed performance/i,
  );

  const mismatch = sampleInput();
  mismatch.resultArtifacts[0].runAttempt = '9';
  assert.throws(
    () => mergeCloudE2EResults(mismatch),
    /run.*attempt.*mismatch/i,
  );
});

mergerTest('genuine E2E failures produce a failure report with one sanitized screenshot', () => {
  const { mergeCloudE2EResults } = require(mergerPath);
  const report = mergeCloudE2EResults(sampleInput());
  const runRoot = `runs/${RUN_ID}/${RUN_ATTEMPT}`;
  const html = report.pagesFiles[`${runRoot}/index.html`];
  const failedMeasurement = report.verificationEvidence.performance.find((entry) => entry.target === 'idle-memory');
  const failedHistory = JSON.parse(report.pagesFiles['performance-history.json'])
    .find((entry) => entry.target === 'idle-memory' && entry.runId === RUN_ID);
  const pngFiles = Object.entries(report.pagesFiles).filter(([name, bytes]) => (
    name.endsWith('.png') && Buffer.isBuffer(bytes)
  ));

  assert.equal(report.verificationEvidence.overallConclusion, 'failure');
  assert.equal(failedMeasurement.primaryAttempt, null);
  assert.equal(failedMeasurement.actualValue, 1001);
  assert.equal(failedMeasurement.classification, 'hard-fail');
  assert.deepEqual(failedHistory.attempts.map((attempt) => attempt.attempt), [1, 2, 3]);
  assert.match(html, /Functional E2E/);
  assert.match(html, /Performance E2E/);
  assert.match(html, /renders a safe synthetic failure/);
  assert.match(html, /Expected the synthetic album card at assertion line 42/);
  assert.match(html, /screenshots\/gallery-search-visual-final\.png/);
  assert.equal(pngFiles.length, 1);
  assert.deepEqual(pngFiles[0][1], SAFE_PNG);
});

mergerTest('history partitions on every approved environment fingerprint field', () => {
  const { mergePerformanceHistory } = require(mergerPath);
  const baseEntry = {
    target: 'idle-memory',
    runId: '100',
    runAttempt: '1',
    generatedAt: '2026-08-25T12:00:00.000Z',
    fingerprint: fingerprint(),
    attempts: [performanceAttempt(1)],
  };
  const variants = [
    { runnerImage: 'windows-2028' },
    { chromeVersion: '152.0.0.0' },
    { fixtureRelease: 'fixtures-v1.0.20' },
    { fixtureSchemaVersion: 2 },
    { postgresMajor: 18 },
    { measurementContract: 'performance-v2' },
  ].map((change, index) => ({
    ...clone(baseEntry),
    runId: String(101 + index),
    fingerprint: fingerprint(change),
  }));

  const history = mergePerformanceHistory([baseEntry, ...variants], {
    now: new Date('2026-08-25T20:00:00.000Z'),
  });
  assert.equal(history.partitions.length, 7);
  assert.ok(history.partitions.every((partition) => partition.trend.length === 1));
});

mergerTest('the current fingerprint partition renders first after an environment change', () => {
  const { mergeCloudE2EResults } = require(mergerPath);
  const input = sampleInput();
  input.previousPerformanceHistory = performanceContract.targets.map((target, index) => ({
    target: target.name, runId: String(9000 + index), runAttempt: '1',
    generatedAt: '2026-08-24T19:00:00.000Z', fingerprint: fingerprint({ chromeVersion: '150.0.0.0' }),
    attempts: [performanceAttempt(1, { status: 'passed' })],
  }));
  const report = mergeCloudE2EResults(input);
  const page = report.pagesFiles[`runs/${RUN_ID}/${RUN_ATTEMPT}/performance/idle-memory/index.html`];
  assert.ok(page.indexOf('151.0.7922.138') < page.indexOf('150.0.0.0'));
});

mergerTest('recovered history retains every attempt and uses the first passing attempt as the primary trend point', () => {
  const { mergePerformanceHistory } = require(mergerPath);
  const entry = {
    target: 'idle-memory',
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    generatedAt: GENERATED_AT,
    fingerprint: fingerprint(),
    finalStatus: 'passed',
    recoveryUsed: true,
    selectedContract: 'ci',
    attempts: [
      performanceAttempt(1, {
        status: 'failed', classification: 'hard-fail', actualValue: 2600,
        targetMs: 2000, graceMs: 400, hardCeilingMs: 2400,
        failureCategory: 'timing-hard-ceiling',
      }),
      performanceAttempt(2, {
        status: 'passed', classification: 'grace-used', actualValue: 2250,
        targetMs: 2000, graceMs: 400, hardCeilingMs: 2400,
        failureCategory: null,
      }),
    ],
  };
  const history = mergePerformanceHistory([entry], {
    now: new Date('2026-08-25T20:00:00.000Z'),
  });

  assert.deepEqual(history.partitions[0].trend.map((point) => point.attempt), [2]);
  assert.deepEqual(history.partitions[0].trend.map((point) => point.actualValue), [2250]);
  assert.deepEqual(history.partitions[0].runs[0].attempts.map((attempt) => attempt.attempt), [1, 2]);
  assert.deepEqual(
    history.partitions[0].runs[0].attempts.map((attempt) => attempt.classification),
    ['hard-fail', 'grace-used'],
  );
});

mergerTest('performance history rejects a fourth target attempt', () => {
  const { mergePerformanceHistory } = require(mergerPath);
  const entry = {
    target: 'idle-memory', runId: RUN_ID, runAttempt: RUN_ATTEMPT,
    generatedAt: GENERATED_AT, fingerprint: fingerprint(),
    attempts: [1, 2, 3, 4].map((attempt) => performanceAttempt(attempt)),
  };

  assert.throws(
    () => mergePerformanceHistory([entry], { now: new Date('2026-08-25T20:00:00.000Z') }),
    /attempt.*(?:three|3)|maximum.*3|malformed performance attempt/i,
  );
});

mergerTest('a timing-only recovered target publishes passed-after-retry status and attempt two as primary', () => {
  const { mergeCloudE2EResults } = require(mergerPath);
  const input = sampleInput();
  const artifact = input.resultArtifacts.find((entry) => entry.childId === 'performance:playback-start');
  artifact.payload = {
    schemaVersion: 1,
    target: 'playback-start',
    conclusion: 'success',
    blocking: false,
    fingerprint: fingerprint({ measurementContract: 'performance-ci-v1' }),
    selectedContract: 'ci',
    attemptCount: 2,
    finalStatus: 'passed',
    recoveryUsed: true,
    primaryAttempt: 2,
    attempts: [
      performanceAttempt(1, {
        status: 'failed', classification: 'hard-fail', actualValue: 2050,
        targetMs: 1800, graceMs: 200, hardCeilingMs: 2000,
        failureCategory: 'timing-hard-ceiling',
      }),
      performanceAttempt(2, {
        status: 'passed', classification: 'grace-used', actualValue: 1950,
        targetMs: 1800, graceMs: 200, hardCeilingMs: 2000,
        failureCategory: null,
      }),
    ],
  };

  const report = mergeCloudE2EResults(input);
  const summary = report.verificationEvidence.performance.find((entry) => entry.target === 'playback-start');
  const page = report.pagesFiles[`runs/${RUN_ID}/${RUN_ATTEMPT}/performance/playback-start/index.html`];

  assert.equal(summary.finalStatus, 'passed');
  assert.equal(summary.recoveryUsed, true);
  assert.equal(summary.selectedContract, 'ci');
  assert.equal(summary.attemptCount, 2);
  assert.equal(summary.primaryAttempt, 2);
  assert.equal(summary.actualValue, 1950);
  assert.equal(summary.classification, 'grace-used');
  assert.match(page, /passed after retry/i);
  assert.doesNotMatch(page, /two through five|2 through 5/i);
  assert.match(page, /"attempt":1[\s\S]*"classification":"hard-fail"[\s\S]*"actualValue":2050/);
  assert.match(page, /"attempt":2[\s\S]*"classification":"grace-used"[\s\S]*"actualValue":1950/);
  assert.match(page, /<th>Classification<\/th>[\s\S]*<th>Hard ceiling<\/th>/);
});

mergerTest('history retains at most 20 runs and removes entries older than 14 days', () => {
  const { mergePerformanceHistory } = require(mergerPath);
  const now = new Date('2026-08-25T20:00:00.000Z');
  const entries = Array.from({ length: 25 }, (_, index) => ({
    target: 'idle-memory',
    runId: String(100 + index),
    runAttempt: '1',
    generatedAt: new Date(now.getTime() - index * 24 * 60 * 60 * 1000).toISOString(),
    fingerprint: fingerprint(),
    attempts: [performanceAttempt(1)],
  }));
  const history = mergePerformanceHistory(entries, { now, maxRuns: 20, maxAgeDays: 14 });

  assert.equal(history.partitions.length, 1);
  assert.equal(history.partitions[0].runs.length, 15);
  assert.equal(history.partitions[0].runs[0].runId, '100');
  assert.equal(history.partitions[0].runs.at(-1).runId, '114');
  assert.equal(history.partitions[0].trend.length, 15);
});

mergerTest('public merger output drops raw reporter internals and validates as a cloud report', () => {
  const { mergeCloudE2EResults } = require(mergerPath);
  const { validateCloudTestReport } = require(validatorPath);
  const report = mergeCloudE2EResults(sampleInput());
  const targetPage = report.pagesFiles[
    `runs/${RUN_ID}/${RUN_ATTEMPT}/performance/idle-memory/index.html`
  ];
  const serializedPublic = JSON.stringify(report.pagesFiles, (key, value) => (
    Buffer.isBuffer(value) ? '<png>' : value
  ));

  assert.equal(typeof targetPage, 'string');
  assert.match(targetPage, /<svg\b/i);
  assert.match(targetPage, /Uncalibrated/);
  assert.match(targetPage, /1001/);
  assert.doesNotMatch(serializedPublic, /retainedArtifacts|baseURL|privateCall|runtime\.log|trace\.zip/i);
  assert.doesNotMatch(serializedPublic, /C:\\Users|C:\\runner|127\.0\.0\.1:5001/i);
  const retainedHistory = JSON.parse(report.pagesFiles['performance-history.json']);
  assert.equal(retainedHistory.length, 18);
  assert.equal(retainedHistory.every((entry) => entry.attempts[0].attempt === 1), true);
  assert.deepEqual(validateCloudTestReport(report), []);
  assert.equal(report.verificationEvidence.children.length, 23);
  assert.equal(report.verificationEvidence.children.every((child) => (
    child.kind === 'functional' || child.kind === 'performance'
  )), true);

  const injectedPage = clone(report);
  const injectedPath = `runs/${RUN_ID}/${RUN_ATTEMPT}/performance/not-a-contract-target/index.html`;
  injectedPage.pagesFiles[injectedPath] = '<!doctype html><title>Injected</title>';
  injectedPage.publicPerformancePages.push(injectedPath);
  assert.match(validateCloudTestReport(injectedPage).join('\n'), /unexpected public performance page/i);
});

mergerTest('authenticated inventory retains structured E2E results for 14 days and debug evidence for 7', () => {
  const { mergeCloudE2EResults } = require(mergerPath);
  const report = mergeCloudE2EResults(sampleInput());
  const inventory = report.authenticatedInventory;

  assert.equal(inventory.structuredReports.length, 23);
  assert.equal(inventory.debugArtifacts.length, 2);
  assert.equal(inventory.structuredReports.every((entry) => entry.retentionDays === 14), true);
  assert.equal(inventory.debugArtifacts.every((entry) => entry.retentionDays === 7), true);
  assert.equal(new Set([
    ...inventory.structuredReports.map((entry) => entry.name),
    ...inventory.debugArtifacts.map((entry) => entry.name),
  ]).size, 25);
});
