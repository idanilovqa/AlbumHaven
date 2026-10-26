const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveTimingBudget } = require('../../scripts/performance-times-contract.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const helperPath = path.join(
  repoRoot,
  'tests',
  'e2e',
  'helpers',
  'performanceAttemptTerminalEvidence.js',
);

async function loadHelper() {
  assert.equal(
    fs.existsSync(helperPath),
    true,
    'missing fixture-owned performance attempt terminal-evidence helper',
  );
  return import(`${pathToFileURL(helperPath).href}?red=${Date.now()}`);
}

function timingResult(overrides = {}) {
  const metricId = overrides.metricId || 'all-artists-local-managed-chrome.selectedArtistSelectionMs';
  const contractName = overrides.contractName || 'ci';
  let budget;
  try {
    budget = resolveTimingBudget(metricId, contractName);
  } catch {
    budget = resolveTimingBudget('all-artists-local-managed-chrome.selectedArtistSelectionMs', 'ci');
  }
  const actual = overrides.actual ?? budget.hardCeiling + 1;
  const performanceStatus = actual <= budget.targetMaximum
    ? 'target-met'
    : actual <= budget.hardCeiling ? 'grace-used' : 'hard-fail';
  return {
    metricId,
    key: 'selectedArtistSelectionMs',
    contractName,
    units: 'ms',
    actual,
    targetMaximum: budget.targetMaximum,
    graceMs: budget.graceMs,
    hardCeiling: budget.hardCeiling,
    performanceStatus,
    passed: performanceStatus !== 'hard-fail',
    ...overrides,
  };
}

function completeAttempt(overrides = {}) {
  return {
    selectedContract: 'ci',
    reporterFinalized: true,
    functionalChecksComplete: true,
    nonTimingChecksComplete: true,
    expectedMetricIds: [
      'all-artists-local-managed-chrome.selectedArtistSelectionMs',
    ],
    results: [timingResult()],
    failureCategory: 'timing-hard-ceiling',
    ...overrides,
  };
}

test('fixture helper emits no terminal timing evidence before functional and non-timing checks complete', async () => {
  const { buildPerformanceAttemptTerminalEvidence } = await loadHelper();

  for (const completion of [
    { functionalChecksComplete: false, nonTimingChecksComplete: true },
    { functionalChecksComplete: true, nonTimingChecksComplete: false },
    { functionalChecksComplete: false, nonTimingChecksComplete: false },
  ]) {
    assert.equal(buildPerformanceAttemptTerminalEvidence({
      ...completeAttempt(),
      ...completion,
    }), null);
  }
});

test('fixture helper retains the selected CI contract and exact timing classifications', async () => {
  const { buildPerformanceAttemptTerminalEvidence } = await loadHelper();
  const evidence = buildPerformanceAttemptTerminalEvidence(completeAttempt({
    results: [
      timingResult({
        metricId: 'all-artists.startupPreviewSidebarMs',
        key: 'startupPreviewSidebarMs',
        actual: 800,
      }),
      timingResult({
        metricId: 'artist-family.treeNealSelectionMs',
        key: 'treeNealSelectionMs',
        actual: 200,
      }),
      timingResult(),
    ],
    expectedMetricIds: [
      'all-artists-local-managed-chrome.selectedArtistSelectionMs',
      'all-artists.startupPreviewSidebarMs',
      'artist-family.treeNealSelectionMs',
    ],
    failureCategory: 'timing-hard-ceiling',
  }));

  assert.equal(evidence.selectedContract, 'ci');
  assert.deepEqual(
    evidence.results.map((result) => ({
      metricId: result.metricId,
      contractName: result.contractName,
      actual: result.actual,
      targetMaximum: result.targetMaximum,
      graceMs: result.graceMs,
      hardCeiling: result.hardCeiling,
      performanceStatus: result.performanceStatus,
    })),
    [
      {
        metricId: 'all-artists.startupPreviewSidebarMs',
        contractName: 'ci',
        actual: 800,
        targetMaximum: 800,
        graceMs: 400,
        hardCeiling: 1200,
        performanceStatus: 'target-met',
      },
      {
        metricId: 'artist-family.treeNealSelectionMs',
        contractName: 'ci',
        actual: 200,
        targetMaximum: 100,
        graceMs: 200,
        hardCeiling: 300,
        performanceStatus: 'grace-used',
      },
      {
        metricId: 'all-artists-local-managed-chrome.selectedArtistSelectionMs',
        contractName: 'ci',
        actual: 301,
        targetMaximum: 100,
        graceMs: 200,
        hardCeiling: 300,
        performanceStatus: 'hard-fail',
      },
    ],
  );
  assert.equal(evidence.eligibleForRecovery, true);
});

test('fixture helper retains local classification but never marks local timing failure recoverable', async () => {
  const { buildPerformanceAttemptTerminalEvidence } = await loadHelper();
  const evidence = buildPerformanceAttemptTerminalEvidence(completeAttempt({
    selectedContract: 'local',
    results: [timingResult({
      contractName: 'local',
      actual: 301,
    })],
  }));

  assert.equal(evidence.selectedContract, 'local');
  assert.equal(evidence.results[0].contractName, 'local');
  assert.equal(evidence.results[0].performanceStatus, 'hard-fail');
  assert.equal(evidence.eligibleForRecovery, false);
});

test('fixture helper keeps functional and assertion failures authoritative', async () => {
  const { buildPerformanceAttemptTerminalEvidence } = await loadHelper();

  for (const failureCategory of ['functional-contract', 'assertion']) {
    const evidence = buildPerformanceAttemptTerminalEvidence(completeAttempt({ failureCategory }));
    assert.equal(evidence.failureCategory, failureCategory);
    assert.equal(evidence.eligibleForRecovery, false);
  }
});

test('fixture helper rejects missing, malformed, and contract-mismatched timing metrics', async () => {
  const { buildPerformanceAttemptTerminalEvidence } = await loadHelper();
  const cases = [
    completeAttempt({ results: [] }),
    completeAttempt({ results: [timingResult({ actual: Number.NaN })] }),
    completeAttempt({ results: [timingResult({ hardCeiling: 301 })] }),
    completeAttempt({ results: [timingResult({ contractName: 'local' })] }),
    completeAttempt({
      expectedMetricIds: ['unknown-performance.metricMs'],
      results: [timingResult({ metricId: 'unknown-performance.metricMs' })],
    }),
    completeAttempt({ results: [
      timingResult(),
      timingResult({
        metricId: 'artist-family.treeNealSelectionMs',
        key: 'treeNealSelectionMs',
        actual: 301,
      }),
    ] }),
  ];

  for (const input of cases) {
    const evidence = buildPerformanceAttemptTerminalEvidence(input);
    assert.equal(evidence.eligibleForRecovery, false);
    assert.match(evidence.failureCategory, /missing|malformed|contract/i);
  }
});
