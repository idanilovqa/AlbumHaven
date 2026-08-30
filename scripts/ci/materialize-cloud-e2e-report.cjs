const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { mergeCloudE2EResults } = require('./merge-cloud-e2e-results.cjs');
const { sanitizePublicFailureScreenshot } = require('./sanitize-public-failure-screenshot.cjs');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function filesNamed(root, name) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesNamed(child, name));
    else if (entry.isFile() && entry.name === name) found.push(child);
  }
  return found;
}

function coverageAttemptEvidence(targetRoot, row, run, job) {
  const attemptRoots = fs.readdirSync(targetRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^attempt-\d+$/.test(entry.name))
    .map((entry) => ({ name: entry.name, number: Number(entry.name.slice('attempt-'.length)) }))
    .sort((left, right) => left.number - right.number);
  if (attemptRoots.length !== 1 || attemptRoots[0].number !== 1) {
    throw new Error(`coverage-only target ${row.target} requires exactly one Playwright attempt`);
  }
  const reportPath = path.join(targetRoot, attemptRoots[0].name, 'report.json');
  if (!fs.existsSync(reportPath)) {
    throw new Error(`missing structured Playwright report for coverage-only target ${row.target}`);
  }
  let report;
  try {
    report = readJson(reportPath);
  } catch (error) {
    throw new Error(`malformed Playwright report for coverage-only target ${row.target}: ${error.message}`);
  }
  if (!report || !Array.isArray(report.suites) || !Array.isArray(report.errors)) {
    throw new Error(`malformed Playwright report for coverage-only target ${row.target}`);
  }
  const cases = flattenSuites(report.suites);
  const expectedCaseIds = ['FTC-OPS-003C', 'FTC-OPS-003E'];
  const actualCaseIds = cases.map((entry) => entry.testId).sort();
  if (cases.length !== expectedCaseIds.length
    || actualCaseIds.some((caseId, index) => caseId !== expectedCaseIds[index])) {
    throw new Error(`incomplete scan-page Playwright evidence; expected ${expectedCaseIds.join(', ')}`);
  }
  const reportFailed = report.errors.length > 0
    || Number(report.stats?.unexpected || 0) > 0
    || cases.some((entry) => !['passed', 'skipped'].includes(entry.status));
  const derivedConclusion = reportFailed ? 'failure' : 'success';
  if (derivedConclusion !== job.conclusion) {
    throw new Error(`coverage-only conclusion mismatch for ${row.target}`);
  }
  const sanitizedCases = cases.map((entry) => {
    if (!entry.finalScreenshot) return entry;
    const sanitized = sanitizePublicFailureScreenshot(entry.finalScreenshot.bytes, {
      trustedSameRepository: true, fixtureMode: 'synthetic',
      sourceRunId: run.runId, sourceRunAttempt: run.runAttempt,
      reportRunId: run.runId, reportRunAttempt: run.runAttempt,
    });
    return {
      ...entry,
      finalScreenshot: {
        status: 'validated',
        publicPath: `screenshots/performance-${row.target}-${entry.testId.toLowerCase()}-final.png`,
        bytes: sanitized.bytes,
        sha256: sanitized.sha256,
        width: sanitized.width,
        height: sanitized.height,
      },
    };
  });
  return { attemptCount: 1, cases: sanitizedCases };
}

function flattenSuites(suites, inherited = []) {
  const cases = [];
  for (const suite of suites || []) {
    const titles = [...inherited, suite.title].filter(Boolean);
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const result = (test.results || []).at(-1) || {};
        const status = result.status === 'passed' && test.status !== 'skipped'
          ? 'passed'
          : (test.status === 'skipped' || result.status === 'skipped' ? 'skipped' : (result.status || 'failed'));
        const title = [...titles, spec.title].filter(Boolean).join(' › ');
        const attachments = (result.attachments || []).filter((entry) => entry.contentType === 'image/png');
        const finalAttachment = ['failed', 'timedOut', 'interrupted'].includes(status) ? attachments.at(-1) : null;
        let finalScreenshot = null;
        if (finalAttachment) {
          const bytes = finalAttachment.body
            ? Buffer.from(finalAttachment.body, 'base64')
            : (finalAttachment.path && fs.existsSync(finalAttachment.path) ? fs.readFileSync(finalAttachment.path) : null);
          if (bytes) {
            const safeName = crypto.createHash('sha256').update(`${spec.file || ''}:${title}`).digest('hex').slice(0, 20);
            finalScreenshot = {
              status: 'validated', publicPath: `screenshots/${safeName}.png`, bytes,
              sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            };
          }
        }
        cases.push({
          testId: (title.match(/FTC-[A-Z0-9-]+/) || [crypto.createHash('sha256').update(title).digest('hex').slice(0, 16)])[0],
          name: title, status, durationMs: Number(result.duration || 0),
          steps: (result.steps || []).map((step) => ({
            title: step.title || step.category || 'Playwright step', status: step.error ? 'failed' : 'passed',
            durationMs: Number(step.duration || 0),
          })),
          stackSummary: result.error?.message || result.error?.stack || '', finalScreenshot,
        });
      }
    }
    cases.push(...flattenSuites(suite.suites, titles));
  }
  return cases;
}

function functionalArtifact(root, row, run) {
  const reportPath = path.join(root, row.shard, 'report.json');
  const report = readJson(reportPath);
  const cases = flattenSuites(report.suites).map((entry) => {
    if (!entry.finalScreenshot) return entry;
    const sanitized = sanitizePublicFailureScreenshot(entry.finalScreenshot.bytes, {
      trustedSameRepository: true, fixtureMode: 'synthetic',
      sourceRunId: run.runId, sourceRunAttempt: run.runAttempt,
      reportRunId: run.runId, reportRunAttempt: run.runAttempt,
    });
    return {
      ...entry,
      finalScreenshot: {
        ...entry.finalScreenshot, bytes: sanitized.bytes, sha256: sanitized.sha256,
        width: sanitized.width, height: sanitized.height,
      },
    };
  });
  const shardFailed = (report.errors || []).length > 0
    || Number(report.stats?.unexpected || 0) > 0
    || cases.some((entry) => !['passed', 'skipped'].includes(entry.status));
  return {
    name: row.artifactName, category: 'structured-report', retentionDays: 14,
    runId: run.runId, runAttempt: run.runAttempt, childId: row.childId,
    payload: {
      schemaVersion: 1, shard: row.shard,
      conclusion: shardFailed ? 'failure' : 'success', cases,
    },
  };
}

function performanceSeries(metrics) {
  const groups = new Map();
  for (const entry of metrics) {
    const title = String(entry.title || entry.reportTitle || entry.caseId || entry.reportId || 'Performance test');
    const sourceId = String(entry.reportId || entry.caseId || title);
    const benchmarkResults = (entry?.rawMetrics?.benchmarkValidation?.results || [])
      .filter((result) => Number.isFinite(Number(result?.actual)) && String(result?.units || '').trim());
    const points = benchmarkResults.length ? benchmarkResults.map((result) => ({
      key: String(result.checkpointKey || result.description || result.units),
      title: `${title} — ${String(result.description || result.checkpointKey || result.units)}`,
      actualValue: Number(result.actual), units: String(result.units),
      targetMs: Number.isFinite(Number(result.targetMaximum)) ? Number(result.targetMaximum) : null,
      graceMs: Number.isFinite(Number(result.graceMs)) ? Number(result.graceMs) : null,
      hardCeilingMs: Number.isFinite(Number(result.hardCeiling ?? result.allowedMaximum))
        ? Number(result.hardCeiling ?? result.allowedMaximum) : null,
      classification: result.performanceStatus
        || (result.calibrationState === 'uncalibrated' ? 'uncalibrated' : (result.passed ? 'pass' : 'hard-fail')),
    })) : [{
      key: 'duration', title, actualValue: Number(entry?.durationMs || 0), units: 'ms', classification: 'uncalibrated',
    }];
    for (const point of points) {
      const id = crypto.createHash('sha256').update(`${sourceId}:${point.key}`).digest('hex').slice(0, 16);
      const group = groups.get(id) || { id, title: point.title, entries: [] };
      group.entries.push({ entry, point });
      groups.set(id, group);
    }
  }
  return [...groups.values()].map((group) => {
    const attemptsByNumber = new Map();
    for (const item of group.entries) {
      const { entry } = item;
      const attempt = Number(entry.verificationRunGroup?.attempt || 1);
      const existing = attemptsByNumber.get(attempt) || [];
      existing.push(item);
      attemptsByNumber.set(attempt, existing);
    }
    const attempts = [...attemptsByNumber.entries()].sort(([left], [right]) => left - right).map(([attempt, items]) => {
      const selected = items[0];
      const { entry, point } = selected;
      return {
        attempt, status: items.every((item) => item.entry.status === 'passed') ? 'passed' : 'failed',
        classification: ['uncalibrated', 'pass', 'target-met', 'grace-used', 'hard-fail'].includes(point.classification)
          ? point.classification : 'uncalibrated',
        actualValue: point.actualValue, units: point.units, startedAt: entry.startedAt,
        targetMs: point.targetMs, graceMs: point.graceMs, hardCeilingMs: point.hardCeilingMs,
      };
    });
    return { id: group.id, title: group.title, attempts };
  });
}

function readPerformancePolicyResult(targetRoot, row) {
  const resolvedTargetRoot = path.resolve(targetRoot);
  const policyPath = path.join(targetRoot, 'policy-result.json');
  if (!fs.existsSync(policyPath)) throw new Error(`missing performance policy result ${row.target}`);
  const policy = readJson(policyPath);
  if (!policy || policy.schemaVersion !== 1 || policy.target !== row.target
    || !['local', 'ci'].includes(policy.selectedContract)
    || !Number.isSafeInteger(policy.attemptCount) || policy.attemptCount < 1 || policy.attemptCount > 3
    || !['passed', 'failed'].includes(policy.finalStatus)
    || typeof policy.recoveryUsed !== 'boolean' || !Array.isArray(policy.attemptRecords)
    || policy.attemptRecords.length !== policy.attemptCount) {
    throw new Error(`malformed performance policy result ${row.target}`);
  }
  const attemptRecords = policy.attemptRecords.map((record, index) => {
    if (!record || record.attemptNumber !== index + 1
      || !['passed', 'hard-fail', 'failed'].includes(record.outcome)
      || typeof record.eligibleForRecovery !== 'boolean'
      || !(record.failureCategory === null || typeof record.failureCategory === 'string')
      || !Number.isInteger(record.processStatus)
      || typeof record.reporterFinalized !== 'boolean'
      || typeof record.metricsComplete !== 'boolean'
      || typeof record.functionalChecksComplete !== 'boolean'
      || typeof record.nonTimingChecksComplete !== 'boolean'
      || typeof record.runId !== 'string' || !record.runId
      || typeof record.metricsPath !== 'string' || !record.metricsPath
      || typeof record.reportPath !== 'string' || !record.reportPath) {
      throw new Error(`malformed performance policy attempt ${row.target}`);
    }
    for (const evidencePath of [record.metricsPath, record.reportPath]) {
      const resolved = path.resolve(resolvedTargetRoot, evidencePath);
      if (resolved !== resolvedTargetRoot && !resolved.startsWith(`${resolvedTargetRoot}${path.sep}`)) {
        throw new Error(`unsafe performance policy evidence path ${row.target}`);
      }
      if (!fs.existsSync(resolved)) throw new Error(`missing performance policy evidence ${row.target}`);
    }
    return { ...record };
  });
  const firstPassing = attemptRecords.find((record) => record.outcome === 'passed')?.attemptNumber ?? null;
  if (policy.primaryAttempt !== firstPassing
    || (policy.finalStatus === 'passed') !== (firstPassing !== null)
    || policy.recoveryUsed !== (policy.attemptCount > 1)) {
    throw new Error(`inconsistent performance policy result ${row.target}`);
  }
  return { ...policy, attemptRecords };
}

function performanceArtifact(root, row, run, fingerprint) {
  const targetRoot = path.join(root, row.target);
  const job = readJson(path.join(targetRoot, 'ci-job.json'));
  if (job.target !== row.target || String(job.runAttempt) !== String(run.runAttempt)
    || !['success', 'failure'].includes(job.conclusion) || typeof job.blocking !== 'boolean') {
    throw new Error(`malformed performance job evidence ${row.target}`);
  }
  const metrics = filesNamed(path.join(targetRoot, 'history'), 'metrics.json').map(readJson);
  if (!metrics.length) {
    if (row.measurementExpected !== false) throw new Error(`missing performance metrics ${row.target}`);
    const coverage = coverageAttemptEvidence(targetRoot, row, run, job);
    return {
      name: row.artifactName, category: 'structured-report', retentionDays: 14,
      runId: run.runId, runAttempt: run.runAttempt, childId: row.childId,
      payload: {
        schemaVersion: 1, target: row.target, conclusion: job.conclusion, blocking: job.blocking,
        fingerprint, measurementAvailable: false, coverageOnly: true,
        attemptCount: coverage.attemptCount, attempts: [], series: [],
        testCount: coverage.cases.length, cases: coverage.cases,
      },
    };
  }
  if (row.measurementExpected === false) {
    throw new Error(`unexpected performance metrics for coverage-only target ${row.target}`);
  }
  const policy = readPerformancePolicyResult(targetRoot, row);
  const policyMetrics = policy.attemptRecords.map((record) => {
    const metricsPath = path.resolve(targetRoot, record.metricsPath);
    const metricsRecord = readJson(metricsPath);
    if (String(metricsRecord.runId || '') !== record.runId) {
      throw new Error(`performance policy metrics identity mismatch ${row.target}`);
    }
    return metricsRecord;
  });
  const series = performanceSeries(policyMetrics).map((item) => ({
    ...item,
    attempts: item.attempts.map((attempt) => {
      const policyAttempt = policy.attemptRecords[attempt.attempt - 1];
      return {
        ...attempt,
        status: policyAttempt.outcome === 'passed' ? 'passed' : 'failed',
        failureCategory: policyAttempt.failureCategory,
      };
    }),
  }));
  if (!series.length || series.some((item) => item.attempts.length !== policy.attemptCount)) {
    throw new Error(`performance policy metrics incomplete ${row.target}`);
  }
  const policyConclusion = policy.finalStatus === 'passed' ? 'success' : 'failure';
  if (job.conclusion !== policyConclusion) throw new Error(`performance policy conclusion mismatch ${row.target}`);
  const attempts = series[0].attempts;
  return {
    name: row.artifactName, category: 'structured-report', retentionDays: 14,
    runId: run.runId, runAttempt: run.runAttempt, childId: row.childId,
    payload: {
      schemaVersion: 1, target: row.target,
      conclusion: policyConclusion,
      blocking: Boolean(job.blocking), fingerprint,
      selectedContract: policy.selectedContract, attemptCount: policy.attemptCount,
      finalStatus: policy.finalStatus, recoveryUsed: policy.recoveryUsed,
      primaryAttempt: policy.primaryAttempt, attempts, series,
    },
  };
}

function writeReportFiles(report, outputRoot) {
  for (const [relativePath, content] of Object.entries(report.pagesFiles)) {
    const target = path.join(outputRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.writeFileSync(path.join(outputRoot, 'verification-evidence.json'), `${JSON.stringify(report.verificationEvidence, null, 2)}\n`);
  fs.writeFileSync(path.join(outputRoot, 'artifact-inventory.json'), `${JSON.stringify(report.authenticatedInventory, null, 2)}\n`);
}

function materializeCloudE2EReport(input) {
  const { buildExpectedCloudE2EInventory } = require('./merge-cloud-e2e-results.cjs');
  const inventory = buildExpectedCloudE2EInventory({ runAttempt: input.run.runAttempt });
  const resultArtifacts = [
    ...inventory.functional.map((row) => functionalArtifact(input.functionalRoot, row, input.run)),
    ...inventory.performance.map((row) => performanceArtifact(input.performanceRoot, row, input.run, input.fingerprint)),
  ];
  const generatedArtifacts = [
    {
      name: `cloud-playwright-report-${input.run.runId}-${input.run.runAttempt}`,
      category: 'structured-report', retentionDays: 14,
    },
    {
      name: `cloud-test-report-${input.run.runId}-${input.run.runAttempt}`,
      category: 'structured-report', retentionDays: 14,
    },
    ...resultArtifacts.filter((artifact) => artifact.payload.conclusion === 'failure').map((artifact) => ({
      name: artifact.childId.startsWith('functional:')
        ? `functional-debug-${artifact.childId.slice('functional:'.length)}-${input.run.runAttempt}`
        : `performance-diagnostics-${artifact.childId.slice('performance:'.length)}-${input.run.runAttempt}`,
      category: 'debug', retentionDays: 7,
    })),
  ];
  const report = mergeCloudE2EResults({
    run: input.run, fixture: input.fixture, resultArtifacts,
    previousPerformanceHistory: input.previousPerformanceHistory || [], previousRunIndex: input.previousRunIndex || [],
    debugArtifacts: [...generatedArtifacts, ...(input.debugArtifacts || [])],
    upstreamConclusions: input.upstreamConclusions || {}, now: input.now,
  });
  writeReportFiles(report, input.outputRoot);
  return report;
}

function cli() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('Usage: materialize-cloud-e2e-report.cjs <input.json>');
  const input = readJson(path.resolve(inputPath));
  const report = materializeCloudE2EReport(input);
  process.stdout.write(`${report.verificationEvidence.overallConclusion}\n`);
}

if (require.main === module) cli();

module.exports = {
  flattenSuites, functionalArtifact, materializeCloudE2EReport, performanceArtifact, performanceSeries,
};
