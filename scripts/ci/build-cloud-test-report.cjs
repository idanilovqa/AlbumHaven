const E2E_CHILD_PATTERN = /^(?:functional|performance):[a-z0-9][a-z0-9-]*$/;
const CHILD_FIELDS = ['id', 'conclusion', 'passed', 'failed', 'skipped'];
const CASE_STATUSES = new Set(['passed', 'failed', 'skipped', 'timedOut', 'interrupted']);
const STEP_STATUSES = new Set(['passed', 'failed', 'skipped']);
const PERFORMANCE_CLASSIFICATIONS = new Set(['uncalibrated', 'pass', 'target-met', 'grace-used', 'hard-fail', 'coverage-only']);

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validCounts(value) {
  return value && isNonNegativeInteger(value.passed) && isNonNegativeInteger(value.failed)
    && isNonNegativeInteger(value.skipped);
}

function validFunctionalCase(value) {
  return value && typeof value.id === 'string' && value.id.length > 0
    && typeof value.title === 'string' && value.title.length > 0
    && CASE_STATUSES.has(value.status) && Number.isFinite(value.durationMs) && value.durationMs >= 0
    && Array.isArray(value.steps) && value.steps.every((step) => step && typeof step.title === 'string'
      && STEP_STATUSES.has(step.status) && Number.isFinite(step.durationMs) && step.durationMs >= 0)
    && typeof value.stackSummary === 'string'
    && (value.screenshot === null || value.screenshot === undefined || (
      value.screenshot && /^screenshots\/[a-z0-9][a-z0-9-]*\.png$/.test(value.screenshot.path)
      && /^[a-f0-9]{64}$/.test(value.screenshot.sha256)
      && isNonNegativeInteger(value.screenshot.width) && value.screenshot.width > 0
      && isNonNegativeInteger(value.screenshot.height) && value.screenshot.height > 0
    ));
}

function validPerformance(value) {
  if (!value || typeof value.target !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value.target)
    || !PERFORMANCE_CLASSIFICATIONS.has(value.classification) || typeof value.blocking !== 'boolean'
    || value.historyPath !== `performance/${value.target}/`) return false;
  if (value.measurementAvailable === false) {
    return value.classification === 'coverage-only' && ['success', 'failure'].includes(value.coverageStatus)
      && value.actualValue === null && value.units === '' && value.primaryAttempt === null
      && value.testCount === 2 && isNonNegativeInteger(value.failed) && value.failed <= value.testCount
      && ((value.coverageStatus === 'success' && value.failed === 0)
        || (value.coverageStatus === 'failure' && value.failed > 0));
  }
  const policyFieldsPresent = ['selectedContract', 'attemptCount', 'finalStatus', 'recoveryUsed']
    .some((field) => value[field] !== undefined);
  const validPolicy = !policyFieldsPresent || (
    ['local', 'ci'].includes(value.selectedContract)
    && Number.isSafeInteger(value.attemptCount) && value.attemptCount >= 1 && value.attemptCount <= 3
    && ['passed', 'failed'].includes(value.finalStatus)
    && typeof value.recoveryUsed === 'boolean'
    && value.recoveryUsed === (value.attemptCount > 1)
    && (value.finalStatus === 'passed'
      ? Number.isSafeInteger(value.primaryAttempt) && value.primaryAttempt >= 1
        && value.primaryAttempt <= value.attemptCount
      : value.primaryAttempt === null)
  );
  return value.classification !== 'coverage-only' && validPolicy
    && Number.isFinite(value.actualValue) && value.actualValue >= 0
    && typeof value.units === 'string' && value.units.length > 0
    && (policyFieldsPresent || (
      Number.isSafeInteger(value.primaryAttempt) && value.primaryAttempt >= 1 && value.primaryAttempt <= 3
    ));
}

function validateEvidence(input) {
  const errors = [];
  if (!input || input.schemaVersion !== 1 || !input.run || !input.fixture
    || !Array.isArray(input.expectedChildIds) || !Array.isArray(input.children)
    || !Array.isArray(input.functional) || !Array.isArray(input.performance)
    || !Array.isArray(input.artifacts)) {
    return ['malformed verification evidence'];
  }
  const repository = String(input.run.repository || '');
  const runId = String(input.run.runId || '');
  const runAttempt = String(input.run.runAttempt || '');
  const expectedActionsUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !/^[a-f0-9]{40}$/.test(String(input.run.commitSha || ''))
    || !Number.isSafeInteger(input.run.pullRequest) || input.run.pullRequest <= 0
    || !/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt)
    || input.run.event !== 'pull_request' || !Number.isFinite(Date.parse(input.run.generatedAt))
    || input.run.actionsUrl !== expectedActionsUrl) {
    errors.push('malformed run identity');
  }
  if (!/^fixtures-v\d+\.\d+\.\d+$/.test(String(input.fixture.release || ''))
    || !/^[a-f0-9]{64}$/.test(String(input.fixture.manifestSha256 || ''))
    || !Array.isArray(input.fixture.profiles) || !input.fixture.profiles.length
    || !input.fixture.profiles.every((profile) => typeof profile === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(profile))) {
    errors.push('malformed fixture identity');
  }
  const expectedCounts = new Map();
  for (const id of input.expectedChildIds) {
    expectedCounts.set(id, (expectedCounts.get(id) || 0) + 1);
    if (!E2E_CHILD_PATTERN.test(String(id))) errors.push(`non-E2E child ${id}`);
  }
  for (const [id, count] of expectedCounts) {
    if (count > 1) errors.push(`duplicate expected child ${id}`);
  }

  const childCounts = new Map();
  for (const child of input.children) {
    if (!child || typeof child.id !== 'string') {
      errors.push('malformed child evidence');
      continue;
    }
    childCounts.set(child.id, (childCounts.get(child.id) || 0) + 1);
    if (!E2E_CHILD_PATTERN.test(child.id)) errors.push(`non-E2E child ${child.id}`);
    if (child.runId !== undefined || child.runAttempt !== undefined) {
      if (String(child.runId) !== String(input.run.runId) || String(child.runAttempt) !== String(input.run.runAttempt)) {
        errors.push(`run and attempt mismatch for child ${child.id}`);
      }
    }
    if (!['success', 'failure', 'cancelled'].includes(child.conclusion) || !validCounts(child)) {
      errors.push(`malformed child ${child.id}`);
    }
  }
  for (const id of expectedCounts.keys()) {
    const count = childCounts.get(id) || 0;
    if (count === 0) errors.push(`missing child ${id}`);
    if (count > 1) errors.push(`duplicate child ${id}`);
  }
  for (const id of childCounts.keys()) {
    if (!expectedCounts.has(id)) errors.push(`unexpected child ${id}`);
  }

  const artifactNames = new Set();
  for (const artifact of input.artifacts) {
    if (!artifact || typeof artifact.name !== 'string' || !artifact.name.trim()) {
      errors.push('malformed artifact inventory');
      continue;
    }
    if (artifactNames.has(artifact.name)) errors.push(`duplicate artifact ${artifact.name}`);
    artifactNames.add(artifact.name);
  }

  const functionalShards = new Set();
  for (const summary of input.functional) {
    if (!summary || typeof summary.shard !== 'string' || !validCounts(summary)
      || !Array.isArray(summary.cases) || !summary.cases.every(validFunctionalCase)) {
      errors.push(`malformed functional summary ${summary?.shard || ''}`.trim());
      continue;
    }
    if (functionalShards.has(summary.shard)) errors.push(`duplicate functional shard ${summary.shard}`);
    functionalShards.add(summary.shard);
  }

  const performanceTargets = new Set();
  for (const summary of input.performance) {
    if (!validPerformance(summary)) {
      errors.push(`malformed performance summary ${summary?.target || ''}`.trim());
      continue;
    }
    if (performanceTargets.has(summary.target)) errors.push(`duplicate performance target ${summary.target}`);
    performanceTargets.add(summary.target);
  }
  return errors;
}

function parseFunctionalSummary(summary) {
  if (!summary || !validCounts(summary) || !Array.isArray(summary.cases) || !summary.cases.every(validFunctionalCase)) {
    throw new Error('malformed functional summary');
  }
  return {
    shard: String(summary.shard), passed: summary.passed, failed: summary.failed, skipped: summary.skipped,
    cases: summary.cases.map((entry) => ({
      id: entry.id, title: entry.title, status: entry.status, durationMs: entry.durationMs,
      steps: entry.steps.map((step) => ({ title: step.title, status: step.status, durationMs: step.durationMs })),
      stackSummary: entry.stackSummary,
      screenshot: entry.screenshot ? { ...entry.screenshot } : null,
    })),
  };
}

function parsePerformanceSummary(summary) {
  if (!validPerformance(summary)) throw new Error('malformed performance summary');
  return {
    target: summary.target, classification: summary.classification, blocking: summary.blocking,
    measurementAvailable: summary.measurementAvailable !== false,
    actualValue: summary.actualValue, units: summary.units, primaryAttempt: summary.primaryAttempt,
    historyPath: summary.historyPath,
    ...(summary.selectedContract ? {
      selectedContract: summary.selectedContract,
      attemptCount: summary.attemptCount,
      finalStatus: summary.finalStatus,
      recoveryUsed: summary.recoveryUsed,
    } : {}),
    ...(summary.measurementAvailable === false
      ? { coverageStatus: summary.coverageStatus, testCount: summary.testCount, failed: summary.failed }
      : {}),
  };
}

function buildAuthenticatedInventory(input) {
  const structuredReports = [];
  const debugArtifacts = [];
  const names = new Set();
  for (const artifact of input.artifacts || []) {
    if (!artifact || typeof artifact.name !== 'string' || !artifact.name.trim()) throw new Error('malformed artifact inventory');
    if (names.has(artifact.name)) throw new Error(`duplicate artifact ${artifact.name}`);
    names.add(artifact.name);
    if (artifact.category === 'structured-report') {
      if (artifact.retentionDays !== 14) throw new Error('structured reports must be retained for 14 days');
      structuredReports.push({ name: artifact.name, retentionDays: 14 });
    } else if (artifact.category === 'debug') {
      if (artifact.retentionDays !== 7) throw new Error('debug artifacts must be retained for 7 days');
      debugArtifacts.push({ name: artifact.name, retentionDays: 7 });
    } else {
      throw new Error(`unsupported artifact category: ${artifact.category}`);
    }
  }
  return { schemaVersion: 1, structuredReports, debugArtifacts };
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function pruneRunIndex(entries, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const maxEntries = options.maxEntries ?? 20;
  const maxAgeDays = options.maxAgeDays ?? 14;
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const seen = new Set();
  return (entries || []).filter((entry) => Number.isFinite(Date.parse(entry.generatedAt)) && Date.parse(entry.generatedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))
    .filter((entry) => {
      const key = `${entry.runId}:${entry.runAttempt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, maxEntries)
    .map((entry) => ({
      runId: String(entry.runId), runAttempt: String(entry.runAttempt), generatedAt: entry.generatedAt,
      overallConclusion: ['success', 'failure'].includes(entry.overallConclusion) ? entry.overallConclusion : 'failure',
    }));
}

function renderFunctional(functional, actionsUrl) {
  return functional.map((shard) => {
    const cases = shard.cases.map((entry) => {
      const steps = entry.steps.map((step) => `<li><strong>${escapeHtml(step.status)}</strong> ${escapeHtml(step.title)} <span>${Math.round(step.durationMs)} ms</span></li>`).join('');
      const failure = entry.status === 'failed' || entry.status === 'timedOut' || entry.status === 'interrupted';
      const screenshot = failure && entry.screenshot
        ? `<img src="${escapeHtml(entry.screenshot.path)}" width="${entry.screenshot.width}" height="${entry.screenshot.height}" alt="Final synthetic failure screenshot for ${escapeHtml(entry.id)}">`
        : (failure ? '<p>Screenshot unavailable</p>' : '');
      const detail = failure ? `<details open><summary>Failure details</summary><ol>${steps}</ol><p>${escapeHtml(entry.stackSummary)}</p>${screenshot}<p><a href="${escapeHtml(actionsUrl)}">Download full failure evidence</a></p></details>` : '';
      return `<article><h3>${escapeHtml(entry.id)} — ${escapeHtml(entry.title)}</h3><p>${escapeHtml(entry.status)} · ${Math.round(entry.durationMs)} ms</p>${detail}</article>`;
    }).join('');
    return `<section><h2>Functional E2E: ${escapeHtml(shard.shard)}</h2><p>${shard.passed} passed · ${shard.failed} failed · ${shard.skipped} skipped</p>${cases}</section>`;
  }).join('');
}

function renderPerformance(performance) {
  const rows = performance.map((entry) => {
    const value = entry.measurementAvailable === false
      ? `${escapeHtml(entry.coverageStatus)} — coverage only`
      : `${escapeHtml(entry.actualValue)} ${escapeHtml(entry.units)}`;
    return `<tr><td><a href="./${escapeHtml(entry.historyPath)}">${escapeHtml(entry.target)}</a></td><td>${escapeHtml(entry.classification)}</td><td>${value}</td></tr>`;
  }).join('');
  return `<section><h2>Performance E2E</h2><table><thead><tr><th>Target</th><th>Classification</th><th>Primary value</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function buildCloudTestReport(input) {
  const errors = validateEvidence(input);
  if (errors.length) throw new Error(errors.join('\n'));
  const runId = String(input.run.runId);
  const runAttempt = String(input.run.runAttempt);
  const children = input.children.map((child) => ({
    ...Object.fromEntries(CHILD_FIELDS.map((field) => [field, child[field]])),
    kind: child.id.startsWith('functional:') ? 'functional' : 'performance',
  }));
  const functional = input.functional.map(parseFunctionalSummary);
  const performance = input.performance.map(parsePerformanceSummary);
  const upstreamConclusions = Object.fromEntries(Object.entries(input.upstreamConclusions || {}).map(([name, conclusion]) => {
    if (!['success', 'failure', 'cancelled', 'skipped'].includes(conclusion)) throw new Error(`malformed upstream conclusion ${name}`);
    return [name, conclusion];
  }));
  const overallConclusion = children.every((child) => child.conclusion === 'success' && child.failed === 0)
    && Object.values(upstreamConclusions).every((conclusion) => conclusion === 'success') ? 'success' : 'failure';
  const verificationEvidence = {
    schemaVersion: 1, repository: String(input.run.repository), commitSha: String(input.run.commitSha),
    pullRequest: Number(input.run.pullRequest), runId, runAttempt, event: String(input.run.event),
    generatedAt: String(input.run.generatedAt), overallConclusion, upstreamConclusions, children,
    fixture: {
      release: String(input.fixture.release), manifestSha256: String(input.fixture.manifestSha256),
      profiles: (input.fixture.profiles || []).map(String),
    },
    functional, performance,
  };
  const publicScreenshots = functional.flatMap((shard) => shard.cases)
    .filter((entry) => entry.screenshot).map((entry) => ({ ...entry.screenshot }));
  const runPath = `runs/${runId}/${runAttempt}`;
  const runHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><title>E2E Report</title><h1>E2E Report</h1><p>Run ${escapeHtml(runId)}, attempt ${escapeHtml(runAttempt)} · ${escapeHtml(overallConclusion)}</p>${renderFunctional(functional, input.run.actionsUrl)}${renderPerformance(performance)}</html>`;
  const runIndex = pruneRunIndex([
    { runId, runAttempt, generatedAt: input.run.generatedAt, overallConclusion }, ...(input.previousRunIndex || []),
  ]);
  const indexLinks = runIndex.map((entry) => {
    const href = entry.runId === runId && entry.runAttempt === runAttempt
      ? `./runs/${entry.runId}/${entry.runAttempt}/`
      : `https://github.com/${escapeHtml(input.run.repository)}/actions/runs/${entry.runId}`;
    return `<li><a href="${href}">Run ${escapeHtml(entry.runId)}, attempt ${escapeHtml(entry.runAttempt)} — ${escapeHtml(entry.overallConclusion)}</a></li>`;
  }).join('');
  const indexHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><title>E2E Runs</title><h1>E2E Runs</h1><ul>${indexLinks}</ul></html>`;
  return {
    schemaVersion: 1, pagesPath: `/${runPath}/`, verificationEvidence,
    authenticatedInventory: buildAuthenticatedInventory(input), publicScreenshots,
    pagesFiles: {
      'index.html': indexHtml,
      'run-index.json': `${JSON.stringify(runIndex, null, 2)}\n`,
      [`${runPath}/index.html`]: runHtml,
      [`${runPath}/report.json`]: `${JSON.stringify(verificationEvidence, null, 2)}\n`,
    },
  };
}

module.exports = {
  buildAuthenticatedInventory, buildCloudTestReport, parseFunctionalSummary,
  parsePerformanceSummary, pruneRunIndex, validateEvidence,
};
