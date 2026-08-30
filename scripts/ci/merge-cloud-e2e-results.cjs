const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildCloudTestReport } = require('./build-cloud-test-report.cjs');
const { sanitizePublicFailureScreenshot } = require('./sanitize-public-failure-screenshot.cjs');
const { validateCloudTestReport } = require('./validate-cloud-test-report.cjs');
const performanceReporter = require('../playwright-performance-reporter.cjs');

const DEFAULT_FUNCTIONAL_CONTRACT = path.resolve(__dirname, '..', '..', 'tests', 'ci', 'functional-shards.json');
const DEFAULT_PERFORMANCE_CONTRACT = path.resolve(__dirname, '..', '..', 'tests', 'ci', 'performance-targets.json');
const FINGERPRINT_FIELDS = [
  'runnerImage', 'chromeVersion', 'fixtureRelease', 'fixtureSchemaVersion', 'postgresMajor', 'measurementContract',
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildExpectedCloudE2EInventory({
  functionalContract = readJson(DEFAULT_FUNCTIONAL_CONTRACT),
  performanceContract = readJson(DEFAULT_PERFORMANCE_CONTRACT),
  runAttempt,
} = {}) {
  const attempt = String(runAttempt || '');
  if (!/^\d+$/.test(attempt)) throw new Error('runAttempt must be numeric');
  const functional = (functionalContract.shards || []).map((shard) => ({
    childId: `functional:${shard.name}`,
    artifactName: `functional-blob-${shard.name}-${attempt}`,
    shard: shard.name,
  }));
  const performance = (performanceContract.targets || []).map((target) => ({
    childId: `performance:${target.name}`,
    artifactName: `performance-result-${target.name}-${attempt}`,
    target: target.name,
    measurementExpected: target.measurementExpected !== false,
    fixtureMode: target.fixtureMode,
  }));
  const coverageOnlyTargets = performance.filter((target) => !target.measurementExpected).map((target) => target.target);
  if (coverageOnlyTargets.length !== 1 || coverageOnlyTargets[0] !== 'scan-page') {
    throw new Error('cloud E2E inventory must declare only scan-page as coverage-only');
  }
  if (functional.length !== 4 || performance.length !== 19) {
    throw new Error(`cloud E2E inventory mismatch: expected 4 functional and 19 performance, got ${functional.length} and ${performance.length}`);
  }
  const ids = [...functional, ...performance].map((entry) => entry.childId);
  const names = [...functional, ...performance].map((entry) => entry.artifactName);
  if (new Set(ids).size !== ids.length || new Set(names).size !== names.length) {
    throw new Error('cloud E2E inventory contains duplicate identities');
  }
  return { functional, performance };
}

function sanitizePublicText(value, maxLength = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[A-Za-z]:\\[^\r\n]*/g, '[redacted path]')
    .replace(/\/(?:home\/runner\/work|Users\/[^/]+|private\/var|var\/folders|tmp)\/[^\r\n]*/gi, '[redacted path]')
    .replace(/https?:\/\/[^\s]+/gi, '[redacted URL]')
    .replace(/(?:ALBUM_HAVEN_FIXTURES_TOKEN|DATABASE_APP_URL|PGPASSWORD)\s*=\s*\S+/gi, '[redacted secret]')
    .trim().slice(0, maxLength);
}

function validateFingerprint(value) {
  if (!value || typeof value !== 'object') throw new Error('malformed performance fingerprint');
  const fingerprint = {};
  for (const field of FINGERPRINT_FIELDS) {
    const fieldValue = value[field];
    if ((field === 'fixtureSchemaVersion' || field === 'postgresMajor')
      ? !Number.isSafeInteger(fieldValue) || fieldValue <= 0
      : typeof fieldValue !== 'string' || !fieldValue.trim()) {
      throw new Error(`malformed performance fingerprint field ${field}`);
    }
    fingerprint[field] = fieldValue;
  }
  return fingerprint;
}

function fingerprintId(fingerprint) {
  return crypto.createHash('sha256').update(JSON.stringify(FINGERPRINT_FIELDS.map((field) => fingerprint[field]))).digest('hex');
}

function sanitizeAttempt(attempt) {
  if (!attempt || !Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1 || attempt.attempt > 3
    || !['passed', 'failed', 'timedOut', 'interrupted'].includes(attempt.status)
    || !['uncalibrated', 'pass', 'target-met', 'grace-used', 'hard-fail'].includes(attempt.classification)
    || !Number.isFinite(attempt.actualValue) || attempt.actualValue < 0
    || typeof attempt.units !== 'string' || !attempt.units.trim()
    || !Number.isFinite(Date.parse(attempt.startedAt))
    || !(attempt.failureCategory === undefined || attempt.failureCategory === null
      || typeof attempt.failureCategory === 'string')) {
    throw new Error('malformed performance attempt');
  }
  const optionalBudget = (value) => (value === null || value === undefined ? null : Number(value));
  const targetMs = optionalBudget(attempt.targetMs);
  const graceMs = optionalBudget(attempt.graceMs);
  const hardCeilingMs = optionalBudget(attempt.hardCeilingMs);
  if ([targetMs, graceMs, hardCeilingMs].some((value) => value !== null && (!Number.isFinite(value) || value < 0))) {
    throw new Error('malformed performance attempt budget');
  }
  return {
    attempt: attempt.attempt,
    diagnostic: attempt.attempt > 1,
    status: attempt.status,
    classification: attempt.classification,
    actualValue: attempt.actualValue,
    units: attempt.units,
    startedAt: attempt.startedAt,
    targetMs, graceMs, hardCeilingMs,
    failureCategory: attempt.failureCategory ?? null,
  };
}

function mergePerformanceHistory(entries, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const maxRuns = options.maxRuns ?? 20;
  const maxAgeDays = options.maxAgeDays ?? 14;
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const partitions = new Map();
  const seenRuns = new Set();
  for (const entry of entries || []) {
    if (!entry || typeof entry.target !== 'string' || !/^\d+$/.test(String(entry.runId || ''))
      || !/^\d+$/.test(String(entry.runAttempt || '')) || !Number.isFinite(Date.parse(entry.generatedAt))
      || !Array.isArray(entry.attempts)) {
      throw new Error('malformed performance history entry');
    }
    if (Date.parse(entry.generatedAt) < cutoff) continue;
    const runKey = `${entry.target}:${entry.runId}:${entry.runAttempt}`;
    if (seenRuns.has(runKey)) throw new Error(`duplicate performance history entry ${runKey}`);
    seenRuns.add(runKey);
    const fingerprint = validateFingerprint(entry.fingerprint);
    const partitionKey = `${entry.target}:${fingerprintId(fingerprint)}`;
    const attempts = entry.attempts.map(sanitizeAttempt).sort((left, right) => left.attempt - right.attempt);
    if (attempts.filter((attempt) => attempt.attempt === 1).length !== 1
      || new Set(attempts.map((attempt) => attempt.attempt)).size !== attempts.length
      || attempts.some((attempt, index) => attempt.attempt !== index + 1)) {
      throw new Error('malformed performance attempt sequence');
    }
    const run = {
      target: entry.target, runId: String(entry.runId), runAttempt: String(entry.runAttempt),
      generatedAt: entry.generatedAt, fingerprint, attempts,
      selectedContract: entry.selectedContract || null,
      finalStatus: entry.finalStatus || null,
      recoveryUsed: entry.recoveryUsed === true,
      primaryAttempt: entry.primaryAttempt ?? null,
    };
    if (!partitions.has(partitionKey)) partitions.set(partitionKey, { fingerprintId: partitionKey.split(':').at(-1), fingerprint, runs: [] });
    partitions.get(partitionKey).runs.push(run);
  }
  return {
    schemaVersion: 1,
    partitions: [...partitions.values()].map((partition) => {
      partition.runs.sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt));
      partition.runs = partition.runs.slice(0, maxRuns);
      partition.trend = partition.runs.map((run) => {
        const inferredPrimary = run.attempts.find((attempt) => attempt.status === 'passed') || run.attempts[0];
        const selectedAttempt = run.primaryAttempt ?? inferredPrimary.attempt;
        const primary = run.attempts.find((attempt) => attempt.attempt === selectedAttempt);
        if (!primary) throw new Error('malformed performance primary attempt');
        return {
          runId: run.runId, runAttempt: run.runAttempt, generatedAt: run.generatedAt,
          attempt: primary.attempt, status: primary.status, classification: primary.classification,
          actualValue: primary.actualValue, units: primary.units,
        };
      });
      return partition;
    }),
  };
}

function renderPublicPerformanceHistory(target, series, options = {}) {
  const coverageOnly = options.coverageOnly === true;
  const renderShell = performanceReporter._private?.renderShell;
  if (typeof renderShell !== 'function') throw new Error('performance reporter public rendering seam is unavailable');
  return renderShell(
    `${target} cloud performance history`,
    `${target} Performance History`,
    coverageOnly
      ? 'This coverage-only target validates behavior and does not produce a performance measurement or history sample.'
      : 'Trusted synthetic cloud measurements. The primary attempt contributes to the trend; diagnostics remain in run detail.',
    { series, coverageOnly, coverageStatus: options.coverageStatus, coverageCases: options.coverageCases,
      actionsUrl: options.actionsUrl },
    `
      if (data.coverageOnly) {
        const coverageCases = Array.isArray(data.coverageCases) ? data.coverageCases : [];
        const caseDetails = coverageCases.map((entry) => {
          const failure = ['failed', 'timedOut', 'interrupted'].includes(entry.status);
          const steps = entry.steps.map((step) => '<li><strong>' + escapeHtml(step.status) + '</strong> '
            + escapeHtml(step.title) + ' <span>' + Math.round(step.durationMs) + ' ms</span></li>').join('');
          const screenshot = failure && entry.screenshot
            ? '<img src="../../' + escapeHtml(entry.screenshot.path) + '" width="' + entry.screenshot.width
              + '" height="' + entry.screenshot.height + '" alt="Final sanitized failure screenshot for '
              + escapeHtml(entry.id) + '">' : (failure ? '<p>Screenshot unavailable</p>' : '');
          const evidence = failure
            ? '<p><a href="' + escapeHtml(data.actionsUrl)
              + '">Download authenticated steps, stacktrace, trace, and full failure evidence</a></p>' : '';
          const detail = failure ? '<details open><summary>Failure details</summary><ol>' + steps + '</ol><p>'
            + escapeHtml(entry.stackSummary) + '</p>' + screenshot + evidence + '</details>' : '';
          return '<article><h3>' + escapeHtml(entry.id) + ' — ' + escapeHtml(entry.title) + '</h3><p>'
            + escapeHtml(entry.status) + ' · ' + Math.round(entry.durationMs) + ' ms</p>' + detail + '</article>';
        }).join('');
        app.innerHTML = '<section><h2>Coverage-only result</h2><p>Status: <strong>'
          + escapeHtml(data.coverageStatus) + '</strong></p>' + caseDetails + '</section>';
      } else {
        app.innerHTML = data.series.map((item, seriesIndex) => {
        const partition = item.history.partitions[0] || { trend: [], runs: [] };
        const points = partition.trend.slice().reverse().map((point, index, all) => ({
          label: 'Run ' + String(index + 1), value: point.actualValue, runId: point.runId,
          startedAt: point.generatedAt, runIndex: index, totalCount: all.length,
        }));
        const units = partition.trend[0]?.units || '';
        const formatter = (value) => String(Math.round(Number(value || 0) * 100) / 100) + (units ? ' ' + units : '');
        const classification = partition.trend[0]?.classification || 'uncalibrated';
        const label = classification === 'uncalibrated' ? 'Uncalibrated' : classification;
        const latestRun = partition.runs[0] || {};
        const latestAttempts = latestRun.attempts || [];
        const recoveredLabel = latestRun.finalStatus === 'passed' && latestRun.recoveryUsed
          ? '<p><strong>Passed after retry</strong></p>' : '';
        const attemptRows = latestAttempts.map((attempt) => '<tr><td>' + attempt.attempt + '</td><td>'
          + escapeHtml(attempt.status) + '</td><td>' + escapeHtml(attempt.classification) + '</td><td>'
          + escapeHtml(formatter(attempt.actualValue)) + '</td><td>'
          + escapeHtml(attempt.targetMs === null ? 'n/a' : formatter(attempt.targetMs)) + '</td><td>'
          + escapeHtml(attempt.graceMs === null ? 'n/a' : formatter(attempt.graceMs)) + '</td><td>'
          + escapeHtml(attempt.hardCeilingMs === null ? 'n/a' : formatter(attempt.hardCeilingMs)) + '</td><td>'
          + escapeHtml(attempt.failureCategory || '') + '</td></tr>').join('');
        return '<section><h2>' + escapeHtml(item.title) + '</h2>' + recoveredLabel + buildCards([
          { label: 'Contract', value: latestRun.selectedContract || label, note: 'Owner-approved timing contract.' },
          { label: 'Retained Runs', value: String(partition.runs.length), note: 'Maximum 20 runs or 14 days.' },
        ]) + buildLineChart('Primary Attempt History', points, formatter, chartPalette[seriesIndex % chartPalette.length], {
          note: 'The outcome-determining attempt contributes to the trend; all attempts remain in run detail.',
        }) + '<table><thead><tr><th>Attempt</th><th>Status</th><th>Classification</th><th>Value</th>'
          + '<th>Target</th><th>Grace</th><th>Hard ceiling</th><th>Failure category</th></tr></thead><tbody>'
          + attemptRows + '</tbody></table></section>';
        }).join('');
        attachChartTooltips(app);
        attachChartHoverRegions(app);
        attachExpandableCharts(app);
        scrollChartContainersToLatest(app);
      }
    `,
    [{ label: 'Back to E2E run', href: '../../' }],
  );
}

function artifactMapForExpected(resultArtifacts, expectedRows, run) {
  if (!Array.isArray(resultArtifacts)) throw new Error('resultArtifacts must be an array');
  const byName = new Map();
  for (const artifact of resultArtifacts) {
    if (!artifact || typeof artifact.name !== 'string') throw new Error('malformed result artifact');
    if (byName.has(artifact.name)) throw new Error(`duplicate result artifact ${artifact.name}`);
    byName.set(artifact.name, artifact);
  }
  for (const row of expectedRows) {
    if (!byName.has(row.artifactName)) throw new Error(`missing result artifact ${row.artifactName}`);
  }
  for (const name of byName.keys()) {
    if (!expectedRows.some((row) => row.artifactName === name)) throw new Error(`unexpected result artifact ${name}`);
  }
  for (const row of expectedRows) {
    const artifact = byName.get(row.artifactName);
    if (artifact.childId !== row.childId || String(artifact.runId) !== String(run.runId)
      || String(artifact.runAttempt) !== String(run.runAttempt)) {
      throw new Error(`run and attempt mismatch for result artifact ${row.artifactName}`);
    }
    if (artifact.category !== 'structured-report' || artifact.retentionDays !== 14 || artifact.payload?.schemaVersion !== 1) {
      throw new Error(`malformed result artifact ${row.artifactName}`);
    }
  }
  return byName;
}

function normalizeFunctional(row, artifact, run) {
  const payload = artifact.payload;
  if (payload.shard !== row.shard || !['success', 'failure'].includes(payload.conclusion) || !Array.isArray(payload.cases)) {
    throw new Error(`malformed functional Playwright result ${row.shard}`);
  }
  const screenshotFiles = [];
  const cases = payload.cases.map((entry) => {
    if (!entry || typeof entry.testId !== 'string' || typeof entry.name !== 'string'
      || !['passed', 'failed', 'skipped', 'timedOut', 'interrupted'].includes(entry.status)
      || !Number.isFinite(entry.durationMs) || entry.durationMs < 0 || !Array.isArray(entry.steps)) {
      throw new Error(`malformed functional Playwright case ${row.shard}`);
    }
    const steps = entry.steps.map((step) => {
      if (!step || typeof step.title !== 'string' || !Number.isFinite(step.durationMs) || step.durationMs < 0) {
        throw new Error(`malformed functional Playwright step ${row.shard}`);
      }
      return { title: sanitizePublicText(step.title, 200), status: step.status || 'passed', durationMs: step.durationMs };
    });
    let screenshot = null;
    if (entry.finalScreenshot) {
      const supplied = entry.finalScreenshot;
      if (supplied.status !== 'validated' || !Buffer.isBuffer(supplied.bytes)
        || typeof supplied.publicPath !== 'string' || !/^screenshots\/[a-z0-9][a-z0-9-]*\.png$/.test(supplied.publicPath)) {
        throw new Error(`malformed functional screenshot ${entry.testId}`);
      }
      const sanitized = sanitizePublicFailureScreenshot(supplied.bytes, {
        trustedSameRepository: true, fixtureMode: 'synthetic',
        sourceRunId: artifact.runId, sourceRunAttempt: artifact.runAttempt,
        reportRunId: run.runId, reportRunAttempt: run.runAttempt,
      });
      if (sanitized.sha256 !== supplied.sha256 || sanitized.width !== supplied.width || sanitized.height !== supplied.height) {
        throw new Error(`functional screenshot identity mismatch ${entry.testId}`);
      }
      screenshot = { path: supplied.publicPath, sha256: sanitized.sha256, width: sanitized.width, height: sanitized.height };
      screenshotFiles.push({
        path: supplied.publicPath, bytes: sanitized.bytes, sha256: sanitized.sha256,
        width: sanitized.width, height: sanitized.height,
      });
    }
    return {
      id: entry.testId, title: sanitizePublicText(entry.name, 300), status: entry.status,
      durationMs: entry.durationMs, steps, stackSummary: sanitizePublicText(entry.stackSummary || '', 500), screenshot,
    };
  });
  const passed = cases.filter((entry) => entry.status === 'passed').length;
  const skipped = cases.filter((entry) => entry.status === 'skipped').length;
  const failed = cases.length - passed - skipped;
  return { summary: { shard: row.shard, passed, failed, skipped, cases }, screenshotFiles, conclusion: payload.conclusion };
}

function normalizePerformance(row, artifact, run, previousEntries, now) {
  const payload = artifact.payload;
  if (payload.target !== row.target || !['success', 'failure'].includes(payload.conclusion)
    || typeof payload.blocking !== 'boolean' || !Array.isArray(payload.attempts)) {
    throw new Error(`malformed performance result ${row.target}`);
  }
  if (payload.measurementAvailable === false) {
    if (row.measurementExpected !== false || payload.coverageOnly !== true
      || payload.attempts.length !== 0
      || (payload.series !== undefined && (!Array.isArray(payload.series) || payload.series.length !== 0))
      || payload.attemptCount !== 1 || payload.testCount !== 2 || !Array.isArray(payload.cases)) {
      throw new Error(`malformed coverage-only performance result ${row.target}`);
    }
    const screenshotFiles = [];
    const expectedCaseIds = ['FTC-OPS-003C', 'FTC-OPS-003E'];
    const cases = payload.cases.map((entry) => {
      if (!entry || !expectedCaseIds.includes(entry.testId) || typeof entry.name !== 'string'
        || !['passed', 'failed', 'skipped', 'timedOut', 'interrupted'].includes(entry.status)
        || !Number.isFinite(entry.durationMs) || entry.durationMs < 0 || !Array.isArray(entry.steps)) {
        throw new Error(`malformed coverage-only Playwright case ${row.target}`);
      }
      const steps = entry.steps.map((step) => {
        if (!step || typeof step.title !== 'string'
          || !['passed', 'failed', 'skipped'].includes(step.status || 'passed')
          || !Number.isFinite(step.durationMs) || step.durationMs < 0) {
          throw new Error(`malformed coverage-only Playwright step ${row.target}`);
        }
        return {
          title: sanitizePublicText(step.title, 200),
          status: step.status || 'passed',
          durationMs: step.durationMs,
        };
      });
      let screenshot = null;
      if (entry.finalScreenshot) {
        const supplied = entry.finalScreenshot;
        if (!['failed', 'timedOut', 'interrupted'].includes(entry.status)
          || supplied.status !== 'validated' || !Buffer.isBuffer(supplied.bytes)
          || supplied.publicPath !== `screenshots/performance-${row.target}-${entry.testId.toLowerCase()}-final.png`) {
          throw new Error(`malformed coverage-only screenshot ${entry.testId}`);
        }
        const sanitized = sanitizePublicFailureScreenshot(supplied.bytes, {
          trustedSameRepository: true, fixtureMode: 'synthetic',
          sourceRunId: artifact.runId, sourceRunAttempt: artifact.runAttempt,
          reportRunId: run.runId, reportRunAttempt: run.runAttempt,
        });
        if (sanitized.sha256 !== supplied.sha256 || sanitized.width !== supplied.width
          || sanitized.height !== supplied.height) {
          throw new Error(`coverage-only screenshot identity mismatch ${entry.testId}`);
        }
        screenshot = {
          path: supplied.publicPath, sha256: sanitized.sha256,
          width: sanitized.width, height: sanitized.height,
        };
        screenshotFiles.push({
          path: supplied.publicPath, bytes: sanitized.bytes, sha256: sanitized.sha256,
          width: sanitized.width, height: sanitized.height,
        });
      }
      return {
        id: entry.testId,
        title: sanitizePublicText(entry.name, 300),
        status: entry.status,
        durationMs: entry.durationMs,
        steps,
        stackSummary: sanitizePublicText(entry.stackSummary || '', 500),
        screenshot,
      };
    });
    if (cases.length !== expectedCaseIds.length
      || cases.map((entry) => entry.id).sort().some((caseId, index) => caseId !== expectedCaseIds[index])) {
      throw new Error(`incomplete coverage-only Playwright evidence ${row.target}`);
    }
    const failed = cases.filter((entry) => !['passed', 'skipped'].includes(entry.status)).length;
    const derivedConclusion = failed > 0 ? 'failure' : 'success';
    if (derivedConclusion !== payload.conclusion) throw new Error(`coverage-only conclusion mismatch ${row.target}`);
    return {
      summary: {
        target: row.target, classification: 'coverage-only', blocking: payload.blocking,
        measurementAvailable: false, coverageStatus: payload.conclusion,
        actualValue: null, units: '', primaryAttempt: null,
        historyPath: `performance/${row.target}/`, testCount: cases.length, failed,
      },
      series: [], screenshotFiles,
      conclusion: payload.conclusion,
      testCount: cases.length,
      coverageOnly: true,
      coverageCases: cases,
    };
  }
  if (row.measurementExpected === false) {
    throw new Error(`coverage-only target produced metric-bearing report ${row.target}`);
  }
  const attemptCount = payload.attemptCount;
  const selectedContract = payload.selectedContract;
  const inferredPrimaryAttempt = payload.attempts.find((attempt) => attempt.status === 'passed')?.attempt ?? null;
  const primaryAttempt = payload.primaryAttempt;
  const finalStatus = payload.finalStatus;
  const recoveryUsed = payload.recoveryUsed;
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1 || attemptCount > 3
    || attemptCount !== payload.attempts.length || !['local', 'ci'].includes(selectedContract)
    || !['passed', 'failed'].includes(finalStatus) || typeof recoveryUsed !== 'boolean'
    || !(primaryAttempt === null || (Number.isSafeInteger(primaryAttempt)
      && primaryAttempt >= 1 && primaryAttempt <= attemptCount))
    || primaryAttempt !== inferredPrimaryAttempt
    || (finalStatus === 'passed') !== (primaryAttempt !== null)
    || recoveryUsed !== (attemptCount > 1)) {
    throw new Error(`malformed performance policy result ${row.target}`);
  }
  const declaredSeries = Array.isArray(payload.series) && payload.series.length
    ? payload.series
    : [{ id: 'primary', title: row.target, attempts: payload.attempts }];
  const seenSeries = new Set();
  const series = declaredSeries.map((item) => {
    if (!item || !/^[a-f0-9]{16}$|^primary$/.test(String(item.id || ''))
      || typeof item.title !== 'string' || !item.title.trim() || seenSeries.has(item.id)) {
      throw new Error(`malformed performance series ${row.target}`);
    }
    seenSeries.add(item.id);
    const historyTarget = item.id === 'primary' ? row.target : `${row.target}--${item.id}`;
    const currentEntry = {
      target: historyTarget, runId: String(run.runId), runAttempt: String(run.runAttempt),
      generatedAt: run.generatedAt, fingerprint: payload.fingerprint, attempts: item.attempts,
      selectedContract, finalStatus, recoveryUsed, primaryAttempt,
    };
    const history = mergePerformanceHistory([
      ...(previousEntries || []).filter((entry) => entry?.target === historyTarget), currentEntry,
    ], { now });
    const currentPartitionIndex = history.partitions.findIndex((partition) => (
      partition.runs.some((entry) => entry.runId === String(run.runId) && entry.runAttempt === String(run.runAttempt))
    ));
    if (currentPartitionIndex > 0) history.partitions.unshift(history.partitions.splice(currentPartitionIndex, 1)[0]);
    return { id: item.id, title: sanitizePublicText(item.title, 300), history };
  });
  const computedConclusion = finalStatus === 'passed' ? 'success' : 'failure';
  if (computedConclusion !== payload.conclusion) throw new Error(`performance conclusion mismatch ${row.target}`);
  const history = series[0].history;
  const currentRun = history.partitions.find((partition) => partition.runs.some((entry) => entry.runId === String(run.runId)))
    ?.runs.find((entry) => entry.runId === String(run.runId));
  const displayAttempt = primaryAttempt ?? 1;
  const primary = currentRun?.attempts.find((attempt) => attempt.attempt === displayAttempt);
  if (!primary) throw new Error(`malformed performance primary attempt ${row.target}`);
  return {
    summary: {
      target: row.target, classification: primary.classification, blocking: payload.blocking,
      actualValue: primary.actualValue, units: primary.units, primaryAttempt,
      historyPath: `performance/${row.target}/`,
      selectedContract, attemptCount, finalStatus, recoveryUsed,
    },
    history, series,
    conclusion: payload.conclusion,
    testCount: payload.attempts.length,
  };
}

function mergeCloudE2EResults(input) {
  if (!input || !input.run || !input.fixture) throw new Error('malformed cloud E2E merge input');
  const inventory = buildExpectedCloudE2EInventory({
    functionalContract: input.functionalContract || readJson(DEFAULT_FUNCTIONAL_CONTRACT),
    performanceContract: input.performanceContract || readJson(DEFAULT_PERFORMANCE_CONTRACT),
    runAttempt: input.run.runAttempt,
  });
  const expectedRows = [...inventory.functional, ...inventory.performance];
  const artifactByName = artifactMapForExpected(input.resultArtifacts, expectedRows, input.run);
  const functional = [];
  const performance = [];
  const children = [];
  const screenshotFiles = [];
  const performancePages = [];
  const publicPerformanceHistory = [];
  for (const row of inventory.functional) {
    const normalized = normalizeFunctional(row, artifactByName.get(row.artifactName), input.run);
    functional.push(normalized.summary);
    screenshotFiles.push(...normalized.screenshotFiles);
    children.push({
      id: row.childId, conclusion: normalized.conclusion,
      passed: normalized.summary.passed, failed: normalized.summary.failed, skipped: normalized.summary.skipped,
    });
  }
  for (const row of inventory.performance) {
    const normalized = normalizePerformance(
      row, artifactByName.get(row.artifactName), input.run, input.previousPerformanceHistory, input.now,
    );
    performance.push(normalized.summary);
    screenshotFiles.push(...(normalized.screenshotFiles || []));
    for (const item of normalized.series) {
      for (const partition of item.history.partitions) publicPerformanceHistory.push(...partition.runs);
    }
    children.push({
      id: row.childId, conclusion: normalized.conclusion,
      passed: normalized.coverageOnly
        ? normalized.testCount - normalized.summary.failed
        : (normalized.conclusion === 'success' ? normalized.testCount : Math.max(0, normalized.testCount - 1)),
      failed: normalized.coverageOnly
        ? normalized.summary.failed
        : (normalized.conclusion === 'failure' ? 1 : 0),
      skipped: 0,
    });
    performancePages.push({
      path: `runs/${input.run.runId}/${input.run.runAttempt}/performance/${row.target}/index.html`,
      html: renderPublicPerformanceHistory(row.target, normalized.series, {
        coverageOnly: normalized.coverageOnly === true,
        coverageStatus: normalized.summary.coverageStatus,
        failureScreenshot: normalized.summary.screenshot,
        coverageCases: normalized.coverageCases,
        actionsUrl: input.run.actionsUrl,
      }),
    });
  }
  const artifacts = [...input.resultArtifacts, ...(input.debugArtifacts || [])].map((artifact) => ({
    name: artifact.name, category: artifact.category, retentionDays: artifact.retentionDays,
  }));
  const fixtureProfiles = [...new Set([
    ...(input.functionalContract || readJson(DEFAULT_FUNCTIONAL_CONTRACT)).shards.map((entry) => entry.fixtureProfile),
    ...(input.performanceContract || readJson(DEFAULT_PERFORMANCE_CONTRACT)).targets.map((entry) => entry.fixtureProfile),
  ])];
  const report = buildCloudTestReport({
    schemaVersion: 1, run: input.run, previousRunIndex: input.previousRunIndex || [],
    upstreamConclusions: input.upstreamConclusions || {},
    fixture: {
      release: input.fixture.release, manifestSha256: input.fixture.manifestSha256, profiles: fixtureProfiles,
    },
    expectedChildIds: expectedRows.map((entry) => entry.childId), children, functional, performance, artifacts,
  });
  const runRoot = `runs/${input.run.runId}/${input.run.runAttempt}`;
  for (const screenshot of screenshotFiles) {
    report.pagesFiles[`${runRoot}/${screenshot.path}`] = screenshot.bytes;
    if (!report.publicScreenshots.some((entry) => entry.path === screenshot.path)) {
      report.publicScreenshots.push({
        path: screenshot.path,
        sha256: screenshot.sha256,
        width: screenshot.width,
        height: screenshot.height,
      });
    }
  }
  for (const page of performancePages) report.pagesFiles[page.path] = page.html;
  report.pagesFiles['performance-history.json'] = `${JSON.stringify(publicPerformanceHistory, null, 2)}\n`;
  report.publicPerformanceHistoryPath = 'performance-history.json';
  report.publicPerformancePages = performancePages.map((entry) => entry.path);
  const validationErrors = validateCloudTestReport(report);
  if (validationErrors.length) throw new Error(validationErrors.join('\n'));
  return report;
}

module.exports = {
  buildExpectedCloudE2EInventory,
  mergeCloudE2EResults,
  mergePerformanceHistory,
  renderPublicPerformanceHistory,
};
