const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  PLAYWRIGHT_PERFORMANCE_REPORTER_FLUSH_MARKER,
} = require('./playwright-performance-constants.cjs');
const {
  classifyPerformanceThreshold,
} = require('./performance-threshold-classification.cjs');

const HISTORY_RETENTION_DAYS = 30;
const TRACE_RETENTION_RUNS = 7;
const HISTORY_ROOT = path.join(__dirname, '..', 'test-results', 'playwrightPerformanceHistory');
const OPEN_REPORT_SCRIPT = path.join(__dirname, 'open-playwright-performance-report.cjs');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeBuffer(filePath, buffer) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, buffer);
}

function formatRunId(isoText) {
  return String(isoText || new Date().toISOString())
    .replace(/[:.]/g, '-')
    .replace(/Z$/, 'Z');
}

function formatMs(value) {
  return `${Math.round(Number(value || 0))} ms`;
}

function formatMb(bytes) {
  return `${(Number(bytes || 0) / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serializeForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function extractAttachmentJson(attachment) {
  if (!attachment) return null;
  if (attachment.body) {
    return JSON.parse(Buffer.isBuffer(attachment.body) ? attachment.body.toString('utf8') : String(attachment.body));
  }
  if (attachment.path) {
    return JSON.parse(fs.readFileSync(attachment.path, 'utf8'));
  }
  return null;
}

function summarizeCheckpoints(checkpoints = []) {
  return checkpoints.map((checkpoint) => ({
    key: checkpoint.key,
    label: checkpoint.label,
    timingMs: checkpoint.timingMs ?? null,
    memoryBytes: checkpoint.memoryBytes ?? null,
    memorySource: checkpoint.memorySource ?? null,
    valueText: checkpoint.valueText || '',
    recordedAt: checkpoint.recordedAt || null,
    details: checkpoint.details || null,
  }));
}

function summarizeStepEvents(stepEvents = []) {
  return stepEvents
    .filter((event) => event.type === 'step' && event.status === 'passed')
    .map((event) => ({
      level: event.level,
      label: event.label,
      durationMs: Number(event.durationMs || 0),
      recordedAt: event.recordedAt || null,
    }));
}

function sanitizeArtifactFileName(fileName, fallback = 'artifact.bin') {
  const normalized = String(fileName || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-');
  return normalized || fallback;
}

function buildRetainedArtifactEntries(attachments = []) {
  return attachments
    .filter((attachment) => attachment?.name !== 'performance-report-metrics')
    .map((attachment, index) => ({
      key: `${sanitizeArtifactFileName(attachment.name, `artifact-${index + 1}`)}-${index + 1}`,
      name: attachment.name || `artifact-${index + 1}`,
      contentType: attachment.contentType || 'application/octet-stream',
      path: attachment.path || null,
      body: attachment.body || null,
    }));
}

function materializeRetainedArtifacts(artifacts, runDir) {
  if (!artifacts.length) {
    return [];
  }

  const artifactDir = path.join(runDir, 'artifacts');
  ensureDir(artifactDir);

  return artifacts.map((artifact) => {
    const fileName = sanitizeArtifactFileName(artifact.name, `${artifact.key}.bin`);
    const filePath = path.join(artifactDir, fileName);
    let textBody = null;
    if (artifact.body) {
      const buffer = Buffer.isBuffer(artifact.body) ? artifact.body : Buffer.from(String(artifact.body), 'utf8');
      writeBuffer(
        filePath,
        buffer,
      );
      if (String(artifact.contentType || '').startsWith('text/')) {
        textBody = buffer.toString('utf8');
      }
    } else if (artifact.path && fs.existsSync(artifact.path)) {
      fs.copyFileSync(artifact.path, filePath);
      if (String(artifact.contentType || '').startsWith('text/')) {
        textBody = fs.readFileSync(filePath, 'utf8');
      }
    } else {
      return null;
    }

    return {
      key: artifact.key,
      name: artifact.name,
      contentType: artifact.contentType,
      fileName,
      relativePath: path.join('artifacts', fileName).replace(/\\/g, '/'),
      textBody,
      kind: artifact.contentType === 'image/png'
        ? 'image'
        : artifact.contentType === 'application/zip'
          ? 'trace'
          : 'file',
    };
  }).filter(Boolean);
}

function pruneTraceArtifactsForRun(runMetrics, runDir, keepTraceArtifacts) {
  if (!runMetrics || !Array.isArray(runMetrics.retainedArtifacts)) {
    return false;
  }

  let didChange = false;
  const filteredArtifacts = [];
  for (const artifact of runMetrics.retainedArtifacts) {
    if (artifact?.kind === 'trace' && !keepTraceArtifacts) {
      didChange = true;
      if (artifact.relativePath) {
        const artifactPath = path.join(runDir, artifact.relativePath);
        if (fs.existsSync(artifactPath)) {
          fs.rmSync(artifactPath, { force: true });
        }
      }
      continue;
    }
    filteredArtifacts.push(artifact);
  }

  if (didChange) {
    runMetrics.retainedArtifacts = filteredArtifacts;
  }
  return didChange;
}

function pruneRetainedTraceArtifacts(manifestRuns = [], suiteDir, traceRetentionRuns = TRACE_RETENTION_RUNS) {
  const keepRunIds = new Set(
    manifestRuns
      .slice(0, Math.max(0, Number(traceRetentionRuns) || 0))
      .map((entry) => entry?.runId)
      .filter(Boolean),
  );
  const updatedRunMetrics = new Map();

  for (const entry of manifestRuns) {
    if (!entry?.runId || !entry?.metricsPath) {
      continue;
    }
    const metricsPath = path.join(suiteDir, entry.metricsPath);
    if (!fs.existsSync(metricsPath)) {
      continue;
    }
    const runMetrics = readJson(metricsPath, null);
    if (!runMetrics) {
      continue;
    }
    const runDir = path.dirname(metricsPath);
    const didChange = pruneTraceArtifactsForRun(runMetrics, runDir, keepRunIds.has(entry.runId));
    if (didChange) {
      writeText(metricsPath, JSON.stringify(runMetrics, null, 2));
    }
    updatedRunMetrics.set(entry.runId, runMetrics);
  }

  return updatedRunMetrics;
}

function buildRunMetricsCacheKey(suiteDir, runId) {
  return `${path.resolve(suiteDir)}::${runId}`;
}

function compareManifestRunRecency(left, right) {
  const leftStartedAt = Date.parse(left?.startedAt || '');
  const rightStartedAt = Date.parse(right?.startedAt || '');
  const leftComparable = Number.isFinite(leftStartedAt) ? leftStartedAt : Number.NEGATIVE_INFINITY;
  const rightComparable = Number.isFinite(rightStartedAt) ? rightStartedAt : Number.NEGATIVE_INFINITY;
  if (leftComparable !== rightComparable) {
    return rightComparable - leftComparable;
  }
  return String(right?.runId || '').localeCompare(String(left?.runId || ''));
}

function pruneGlobalRetainedTraceArtifacts(historyRoot = HISTORY_ROOT, traceRetentionRuns = TRACE_RETENTION_RUNS) {
  if (!fs.existsSync(historyRoot)) {
    return new Map();
  }

  const suiteDirs = fs.readdirSync(historyRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(historyRoot, entry.name));
  const retentionWindow = Math.max(0, Number(traceRetentionRuns) || 0);
  const candidateRuns = [];

  for (const suiteDir of suiteDirs) {
    const manifestPath = path.join(suiteDir, 'index.json');
    const manifest = readJson(manifestPath, null);
    if (!manifest || !Array.isArray(manifest.runs)) {
      continue;
    }
    for (const entry of manifest.runs) {
      if (!entry?.runId || !entry?.metricsPath) {
        continue;
      }
      candidateRuns.push({
        ...entry,
        suiteDir,
      });
    }
  }

  const keepRunKeys = new Set(
    candidateRuns
      .slice()
      .sort(compareManifestRunRecency)
      .slice(0, retentionWindow)
      .map((entry) => buildRunMetricsCacheKey(entry.suiteDir, entry.runId)),
  );
  const updatedRunMetrics = new Map();

  for (const entry of candidateRuns) {
    const metricsPath = path.join(entry.suiteDir, entry.metricsPath);
    if (!fs.existsSync(metricsPath)) {
      continue;
    }
    const runMetrics = readJson(metricsPath, null);
    if (!runMetrics) {
      continue;
    }
    const runDir = path.dirname(metricsPath);
    const didChange = pruneTraceArtifactsForRun(
      runMetrics,
      runDir,
      keepRunKeys.has(buildRunMetricsCacheKey(entry.suiteDir, entry.runId)),
    );
    if (didChange) {
      writeText(metricsPath, JSON.stringify(runMetrics, null, 2));
    }
    updatedRunMetrics.set(buildRunMetricsCacheKey(entry.suiteDir, entry.runId), runMetrics);
  }

  return updatedRunMetrics;
}

function buildRunMetrics(testRecord, metricsPayload) {
  const checkpoints = summarizeCheckpoints(metricsPayload.checkpoints || []);
  const timingCheckpoints = checkpoints.filter((checkpoint) => checkpoint.timingMs !== null);
  const memoryCheckpoints = checkpoints.filter((checkpoint) => checkpoint.memoryBytes !== null);
  const stepEvents = summarizeStepEvents(metricsPayload.stepEvents || []);
  const stepTimingSeries = stepEvents
    .filter((event) => event.level === 1)
    .map((event, index) => ({
      key: `step-${index + 1}`,
      label: event.label,
      value: event.durationMs,
    }));
  const timingSeries = timingCheckpoints.length
    ? timingCheckpoints.map((checkpoint) => ({
      key: checkpoint.key,
      label: checkpoint.label,
      value: checkpoint.timingMs,
    }))
    : stepTimingSeries;
  const memorySeries = memoryCheckpoints.map((checkpoint) => ({
    key: checkpoint.key,
    label: checkpoint.label,
    value: checkpoint.memoryBytes,
  }));
  const peakMemoryBytes = memoryCheckpoints.reduce(
    (maxValue, checkpoint) => Math.max(maxValue, Number(checkpoint.memoryBytes || 0)),
    0,
  );

  return normalizeRunMetrics({
    runId: testRecord.runId,
    reportId: metricsPayload.reportId,
    reportTitle: metricsPayload.title,
    intro: metricsPayload.intro,
    status: testRecord.status,
    title: testRecord.title,
    caseId: metricsPayload.caseId,
    startedAt: testRecord.startedAt,
    finishedAt: testRecord.finishedAt,
    durationMs: testRecord.durationMs,
    environment: testRecord.environment,
    verificationRunGroup: testRecord.verificationRunGroup || null,
    summaryCards: metricsPayload.summaryCards || [],
    rawMetrics: metricsPayload.rawMetrics || {},
    stepEvents,
    stepTranscript: metricsPayload.stepTranscript || [],
    checkpoints,
    timingCheckpoints,
    memoryCheckpoints,
    timingSeries,
    memorySeries,
    peakMemoryBytes,
    retainedArtifacts: testRecord.retainedArtifacts || [],
  });
}

function textArtifactText(runMetrics, fileName) {
  const artifact = (runMetrics?.retainedArtifacts || []).find((entry) => entry?.name === fileName);
  if (!artifact) return '';
  if (artifact.textBody) {
    return String(artifact.textBody);
  }
  if (artifact.body) {
    return Buffer.isBuffer(artifact.body) ? artifact.body.toString('utf8') : String(artifact.body);
  }
  return '';
}

function toSuiteRelativePath(suiteDir, absoluteFilePath) {
  return path.relative(suiteDir, absoluteFilePath).replace(/\\/g, '/');
}

function buildManifestEntry(runMetrics, suiteDir, reportFilePath, metricsFilePath) {
  return {
    runId: runMetrics.runId,
    caseId: runMetrics.caseId,
    reportId: runMetrics.reportId,
    title: runMetrics.title,
    reportTitle: runMetrics.reportTitle,
    status: runMetrics.status,
    startedAt: runMetrics.startedAt,
    finishedAt: runMetrics.finishedAt,
    durationMs: runMetrics.durationMs,
    peakMemoryBytes: runMetrics.peakMemoryBytes,
    checkpointCount: runMetrics.checkpoints.length,
    reportPath: toSuiteRelativePath(suiteDir, reportFilePath),
    metricsPath: toSuiteRelativePath(suiteDir, metricsFilePath),
    environment: runMetrics.environment,
    verificationRunGroup: runMetrics.verificationRunGroup || null,
    checkpoints: runMetrics.checkpoints,
    benchmarkValidation: summarizeBenchmarkValidation(
      runMetrics.rawMetrics?.benchmarkValidation,
      processPassedFromPlaywrightStatus(runMetrics.status),
    ),
  };
}

function optionalFiniteNumber(value) {
  return value !== null
    && value !== undefined
    && !(typeof value === 'string' && value.trim() === '')
    && Number.isFinite(Number(value))
    ? Number(value)
    : null;
}

function processPassedFromPlaywrightStatus(status) {
  return status === undefined || status === null ? undefined : status === 'passed';
}

function resolveEffectiveCeiling(result = {}) {
  const isDeclared = (value) => value !== null
    && value !== undefined
    && !(typeof value === 'string' && value.trim() === '');
  const hardCeilingDeclared = isDeclared(result.hardCeiling);
  const allowedMaximumDeclared = isDeclared(result.allowedMaximum);
  const hardCeiling = optionalFiniteNumber(result.hardCeiling);
  const allowedMaximum = optionalFiniteNumber(result.allowedMaximum);
  const consistent = (!hardCeilingDeclared || hardCeiling !== null)
    && (!allowedMaximumDeclared || allowedMaximum !== null)
    && !(hardCeilingDeclared && allowedMaximumDeclared && hardCeiling !== allowedMaximum);
  return {
    consistent,
    value: consistent ? (hardCeiling ?? allowedMaximum) : null,
  };
}

function summarizeBenchmarkValidation(benchmarkValidation, processPassed) {
  const results = Array.isArray(benchmarkValidation?.results)
    ? benchmarkValidation.results
      .filter((result) => result && result.checkpointKey)
      .map((result) => {
        const actual = optionalFiniteNumber(result.actual);
        const targetMaximum = optionalFiniteNumber(result.targetMaximum);
        const hardCeiling = resolveEffectiveCeiling(result).value;
        const classification = classifyPerformanceThreshold({
          units: result.units,
          actual,
          targetMaximum,
          graceMs: result.graceMs,
          hardCeiling,
          calibrationState: result.calibrationState,
          blocking: result.blocking,
          processPassed,
          reportedPassed: result.passed,
          reportedStatus: result.performanceStatus,
          classificationPolicy: result.classificationPolicy,
          sampleCount: result.sampleCount,
          overThresholdCount: result.overThresholdCount,
          failingSampleCount: result.failingSampleCount,
        });
        return {
        key: result.key || '',
        checkpointKey: String(result.checkpointKey),
        description: result.description || '',
        units: result.units || '',
        actual,
        actualText: result.actualText || '',
        observedBaseline: Number(result.observedBaseline || 0),
        observedRange: result.observedRange || null,
        targetMaximum,
        graceMs: optionalFiniteNumber(result.graceMs),
        hardCeiling,
        allowedMaximum: optionalFiniteNumber(result.allowedMaximum),
        allowedText: result.allowedText || '',
        performanceStatus: classification.performanceStatus,
        targetMet: result.targetMet === null || result.targetMet === undefined ? null : Boolean(result.targetMet),
        graceUsed: Boolean(result.graceUsed),
        ...((result.classificationPolicy || result.calibrationState === 'uncalibrated') ? {
          classificationPolicy: result.classificationPolicy,
          sampleCount: result.sampleCount,
          overThresholdCount: result.overThresholdCount,
          failingSampleCount: result.failingSampleCount,
          thresholdPassed: classification.thresholdPassed,
          policyPassed: classification.policyPassed,
        } : {}),
        passed: classification.passed,
        };
      })
    : [];

  if (!results.length) {
    return null;
  }

  return {
    benchmarkId: benchmarkValidation?.benchmarkId || '',
    benchmarkVersion: benchmarkValidation?.benchmarkVersion || '',
    results,
  };
}

function resolveBenchmarkValidationForReport(runMetrics, historyEntries = []) {
  const currentRunValidation = summarizeBenchmarkValidation(
    runMetrics?.rawMetrics?.benchmarkValidation,
    processPassedFromPlaywrightStatus(runMetrics?.status),
  );
  if (currentRunValidation) {
    return currentRunValidation;
  }

  for (const entry of historyEntries) {
    const retainedValidation = summarizeBenchmarkValidation(
      entry?.benchmarkValidation,
      processPassedFromPlaywrightStatus(entry?.status),
    );
    if (retainedValidation) {
      return retainedValidation;
    }
  }

  return null;
}

function buildProjectEnvironment(configUse = {}, project = {}) {
  const projectUse = project.use || {};
  return {
    projectName: project.name || '',
    baseURL: projectUse.baseURL || configUse.baseURL || '',
    browserName: projectUse.browserName || configUse.browserName || '',
    channel: projectUse.channel || configUse.channel || '',
    headless: Boolean(projectUse.headless ?? configUse.headless),
  };
}

function resolveTestProjectName(test, result = {}) {
  const project = typeof test?.parent?.project === 'function'
    ? test.parent.project()
    : null;
  return project?.name || result.projectName || '';
}

function summarizeVerificationRunGroup(verificationRunGroup) {
  if (!verificationRunGroup?.id) {
    return null;
  }
  return {
    id: String(verificationRunGroup.id),
    label: verificationRunGroup.label || '',
    policy: verificationRunGroup.policy || '',
    maxAttempts: Number(verificationRunGroup.maxAttempts || 0) || 0,
    attempt: Number(verificationRunGroup.attempt || 0) || 0,
  };
}

function groupRunsByVerificationId(runs = []) {
  const groups = new Map();
  for (const run of runs) {
    const groupId = run?.verificationRunGroup?.id;
    if (!groupId) {
      continue;
    }
    const existing = groups.get(groupId) || [];
    existing.push(run);
    groups.set(groupId, existing);
  }
  return groups;
}

function buildVerificationMetricSummary(entries = []) {
  const resultMap = new Map();
  for (const entry of entries) {
    const results = Array.isArray(entry?.benchmarkValidation?.results)
      ? entry.benchmarkValidation.results
      : [];
    for (const result of results) {
      const existing = resultMap.get(result.key) || {
        key: result.key || '',
        checkpointKey: result.checkpointKey || '',
        description: result.description || '',
        units: result.units || '',
        targetMaximum: optionalFiniteNumber(result.targetMaximum),
        graceMs: optionalFiniteNumber(result.graceMs),
        allowedMaximum: optionalFiniteNumber(result.allowedMaximum),
        allowedText: result.allowedText || '',
        actuals: [],
        passCount: 0,
        classificationPolicy: result.classificationPolicy || null,
        calibrationState: result.calibrationState || null,
        blocking: result.blocking,
        failingSampleCount: result.failingSampleCount,
        effectiveCeiling: resolveEffectiveCeiling(result).value,
        contractConsistent: true,
      };
      const resultTargetMaximum = optionalFiniteNumber(result.targetMaximum);
      const resultGraceMs = optionalFiniteNumber(result.graceMs);
      const resultAllowedMaximum = optionalFiniteNumber(result.allowedMaximum);
      const effectiveCeiling = resolveEffectiveCeiling(result);
      existing.contractConsistent = existing.contractConsistent
        && existing.units === (result.units || '')
        && existing.targetMaximum === resultTargetMaximum
        && existing.graceMs === resultGraceMs
        && existing.allowedMaximum === resultAllowedMaximum
        && effectiveCeiling.consistent
        && existing.effectiveCeiling === effectiveCeiling.value
        && existing.classificationPolicy === (result.classificationPolicy || null)
        && existing.calibrationState === (result.calibrationState || null)
        && existing.blocking === result.blocking
        && existing.failingSampleCount === result.failingSampleCount;
      const actual = optionalFiniteNumber(result.actual);
      if (actual !== null && actual >= 0) {
        existing.actuals.push(actual);
      }
      const rawClassification = classifyPerformanceThreshold({
        units: result.units,
        actual,
        targetMaximum: result.targetMaximum,
        graceMs: result.graceMs,
        hardCeiling: effectiveCeiling.value,
        calibrationState: result.calibrationState,
        blocking: result.blocking,
        processPassed: processPassedFromPlaywrightStatus(entry?.status),
        reportedPassed: result.passed,
        reportedStatus: result.performanceStatus,
        classificationPolicy: result.classificationPolicy,
        sampleCount: result.sampleCount,
        overThresholdCount: result.overThresholdCount,
        failingSampleCount: result.failingSampleCount,
      });
      if (rawClassification.passed) {
        existing.passCount += 1;
      }
      resultMap.set(existing.key, existing);
    }
  }

  const totalRuns = entries.length;
  const requiredPassCount = Math.floor(totalRuns / 2) + 1;
  const metrics = [...resultMap.values()].map((metric) => {
    const medianActual = median(metric.actuals);
    const averageActual = average(metric.actuals);
    const medianClassification = classifyPerformanceThreshold({
      units: metric.units,
      actual: medianActual,
      targetMaximum: metric.targetMaximum,
      graceMs: metric.graceMs,
      hardCeiling: metric.effectiveCeiling,
      calibrationState: metric.calibrationState,
      blocking: metric.blocking,
      processPassed: true,
    });
    const passed = medianClassification.passed
      && metric.contractConsistent
      && metric.passCount >= requiredPassCount;
    const performanceStatus = medianClassification.performanceStatus;
    return {
      ...metric,
      medianActual,
      averageActual,
      totalRuns,
      requiredPassCount,
      performanceStatus,
      thresholdPassed: medianClassification.thresholdPassed,
      policyPassed: medianClassification.policyPassed,
      graceUsed: performanceStatus === 'grace-used',
      passed,
    };
  });

  return {
    totalRuns,
    requiredPassCount,
    metrics,
    passed: metrics.every((metric) => metric.passed),
  };
}

function buildLatestVerificationSummary(manifestRuns = []) {
  const latestEntry = manifestRuns[0];
  const groupId = latestEntry?.verificationRunGroup?.id;
  if (!groupId) {
    return null;
  }
  const groupedRuns = groupRunsByVerificationId(manifestRuns);
  const entries = (groupedRuns.get(groupId) || []).slice()
    .sort((left, right) => String(left.startedAt || '').localeCompare(String(right.startedAt || '')));
  if (!entries.length) {
    return null;
  }
  const verificationRunGroup = summarizeVerificationRunGroup(entries[entries.length - 1].verificationRunGroup);
  const hasBenchmarkValidation = entries.every((entry) => Array.isArray(entry?.benchmarkValidation?.results) && entry.benchmarkValidation.results.length > 0);
  return {
    verificationRunGroup,
    entries,
    aggregate: hasBenchmarkValidation && entries.length > 1
      ? buildVerificationMetricSummary(entries)
      : null,
  };
}

function buildPerformanceSummaryCardsFromMetrics(runMetrics) {
  const checkpoints = Array.isArray(runMetrics?.checkpoints) ? runMetrics.checkpoints : [];
  const rawMetrics = runMetrics?.rawMetrics || {};
  const checkpointByKey = new Map(checkpoints.map((checkpoint) => [checkpoint?.key, checkpoint]));
  const peakMemoryBytes = checkpoints.reduce(
    (maxValue, checkpoint) => Math.max(maxValue, Number(checkpoint?.memoryBytes || 0)),
    0,
  );
  const memoryCheckpointCount = checkpoints.filter((checkpoint) => checkpoint?.memoryBytes !== null).length;
  const startupMs = Number(
    rawMetrics?.startupSidebarHydration?.coversMs
    ?? rawMetrics?.startupVisibleCoversMs
    ?? checkpointByKey.get('startup-visible-covers')?.timingMs
    ?? 0
  );
  const returnMs = Number(
    rawMetrics?.allArtistsCoversMs
    ?? rawMetrics?.allArtistsReturn?.coversMs
    ?? checkpointByKey.get('all-artists-visible-covers')?.timingMs
    ?? 0
  );
  const modalOpenMs = Number(
    rawMetrics?.albumDetailsOpenMs
    ?? rawMetrics?.albumDetails?.openMs
    ?? checkpointByKey.get('album-details-open')?.timingMs
    ?? 0
  );

  return [
    {
      label: 'Startup Covers Ready',
      value: `${Math.round(startupMs)} ms`,
      note: 'Initial All Artists visible covers',
    },
    {
      label: 'Return Covers Ready',
      value: `${Math.round(returnMs)} ms`,
      note: 'After the artist round-trip',
    },
    {
      label: 'Peak Idle Memory',
      value: formatMb(peakMemoryBytes),
      note: `${memoryCheckpointCount} memory checkpoints`,
    },
    {
      label: 'Album Details Open',
      value: `${Math.round(modalOpenMs)} ms`,
      note: 'Visible album modal open latency',
    },
  ];
}

function normalizeRunMetrics(runMetrics) {
  if (!runMetrics || typeof runMetrics !== 'object') {
    return runMetrics;
  }

  if (runMetrics.reportId === 'allArtistsLocal') {
    return {
      ...runMetrics,
      summaryCards: buildPerformanceSummaryCardsFromMetrics(runMetrics),
    };
  }

  return runMetrics;
}

function average(values = []) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function median(values = []) {
  if (!values.length) return null;
  const sorted = values
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function trimRunsToRetentionWindow(runs = [], retentionDays = HISTORY_RETENTION_DAYS, nowIso = null) {
  const nowValue = nowIso ? Date.parse(nowIso) : Date.now();
  if (!Number.isFinite(nowValue)) {
    return runs.slice();
  }
  const cutoff = nowValue - (retentionDays * 24 * 60 * 60 * 1000);
  return runs.filter((entry) => {
    const startedAtValue = Date.parse(entry?.startedAt || '');
    return !Number.isFinite(startedAtValue) || startedAtValue >= cutoff;
  });
}

function buildHistoricalTimingData(manifestRuns = []) {
  const chronologicalRuns = manifestRuns
    .slice()
    .reverse()
    .map((entry, index) => {
      const timedCheckpoints = (entry.checkpoints || []).filter((checkpoint) => checkpoint.timingMs !== null);
      return {
        index,
        runId: entry.runId,
        startedAt: entry.startedAt,
        status: entry.status,
        durationMs: Number(entry.durationMs || 0),
        peakMemoryBytes: Number(entry.peakMemoryBytes || 0),
        averageTimingMs: average(timedCheckpoints.map((checkpoint) => checkpoint.timingMs)),
        medianTimingMs: median(timedCheckpoints.map((checkpoint) => checkpoint.timingMs)),
        timedCheckpoints,
      };
    });

  const actionMap = new Map();
  for (const run of chronologicalRuns) {
    for (const checkpoint of run.timedCheckpoints) {
      const existing = actionMap.get(checkpoint.key) || {
        key: checkpoint.key,
        label: checkpoint.label,
        points: [],
      };
      existing.label = checkpoint.label || existing.label;
      existing.points.push({
        runIndex: run.index,
        runId: run.runId,
        startedAt: run.startedAt,
        status: run.status,
        value: Number(checkpoint.timingMs || 0),
      });
      actionMap.set(checkpoint.key, existing);
    }
  }

  const actions = [...actionMap.values()]
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((action) => ({
      ...action,
      latestValue: action.points.length ? action.points[action.points.length - 1].value : null,
    }));

  return {
    runCount: chronologicalRuns.length,
    runs: chronologicalRuns.map((run) => ({
      index: run.index,
      runId: run.runId,
      startedAt: run.startedAt,
      status: run.status,
      durationMs: run.durationMs,
      peakMemoryBytes: run.peakMemoryBytes,
      averageTimingMs: run.averageTimingMs,
    })),
    actions,
    overlays: {
      duration: chronologicalRuns.map((run) => ({
        runIndex: run.index,
        runId: run.runId,
        startedAt: run.startedAt,
        status: run.status,
        value: run.durationMs,
      })),
      averageTiming: chronologicalRuns
        .filter((run) => run.averageTimingMs !== null)
        .map((run) => ({
          runIndex: run.index,
          runId: run.runId,
          startedAt: run.startedAt,
          status: run.status,
          value: run.averageTimingMs,
        })),
      medianTiming: chronologicalRuns
        .filter((run) => run.medianTimingMs !== null)
        .map((run) => ({
          runIndex: run.index,
          runId: run.runId,
          startedAt: run.startedAt,
          status: run.status,
          value: run.medianTimingMs,
        })),
      peakMemory: chronologicalRuns.map((run) => ({
        runIndex: run.index,
        runId: run.runId,
        startedAt: run.startedAt,
        status: run.status,
        value: run.peakMemoryBytes,
      })),
    },
  };
}

function renderShell(title, heading, intro, data, bodyScript, links = []) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f1e8;
      --panel: rgba(255, 255, 255, 0.84);
      --panel-strong: #fffdf8;
      --ink: #1f1f1f;
      --muted: #5f5a52;
      --line: rgba(31, 31, 31, 0.12);
      --accent: #15616d;
      --accent-soft: rgba(21, 97, 109, 0.14);
      --accent-alt: #ff7d00;
      --ok: #2a7f62;
      --warn: #c05621;
      --bad: #b42318;
      --shadow: 0 18px 50px rgba(38, 35, 28, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Aptos", system-ui, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(255, 125, 0, 0.10), transparent 28rem),
        radial-gradient(circle at top right, rgba(21, 97, 109, 0.10), transparent 30rem),
        linear-gradient(180deg, #fbf7ef 0%, var(--bg) 100%);
      color: var(--ink);
    }
    .page {
      width: min(1280px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 40px;
    }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 24px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
    }
    .hero {
      padding: 28px;
      margin-bottom: 18px;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    h1 {
      margin: 14px 0 8px;
      font-size: clamp(28px, 4vw, 46px);
      line-height: 1.05;
    }
    .intro {
      margin: 0;
      color: var(--muted);
      font-size: 16px;
      max-width: 78ch;
    }
    .grid {
      display: grid;
      gap: 18px;
    }
    .cards {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      margin-bottom: 18px;
    }
    .panel {
      padding: 20px;
    }
    .card-label {
      color: var(--muted);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 10px;
    }
    .card-value {
      font-size: 28px;
      font-weight: 700;
    }
    .card-note {
      color: var(--muted);
      font-size: 13px;
      margin-top: 8px;
    }
    .section-title {
      margin: 0 0 14px;
      font-size: 20px;
    }
    .section-note {
      margin: 0 0 18px;
      color: var(--muted);
    }
    .two-up {
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      margin-bottom: 18px;
    }
    .chart {
      min-height: 280px;
      min-width: 0;
      width: 100%;
    }
    .chart-shell {
      position: relative;
      min-width: 0;
      width: 100%;
    }
    .chart-scroll {
      width: 100%;
      min-width: 0;
      overflow-x: auto;
      overflow-y: hidden;
      padding-bottom: 10px;
      margin: 0 -2px;
      scrollbar-width: thin;
      scrollbar-color: rgba(21, 97, 109, 0.35) transparent;
    }
    .chart-scroll::-webkit-scrollbar {
      height: 10px;
    }
    .chart-scroll::-webkit-scrollbar-track {
      background: transparent;
    }
    .chart-scroll::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: rgba(21, 97, 109, 0.28);
    }
    .chart[data-chart-expandable="1"] svg {
      cursor: zoom-in;
    }
    .chart svg {
      width: auto;
      min-width: 100%;
      max-width: none;
      height: 240px;
      display: block;
    }
    .chart-axis-grid {
      stroke: rgba(31, 31, 31, 0.10);
      stroke-dasharray: 4 6;
    }
    .chart-axis-label {
      font-size: 11px;
      fill: #5f5a52;
    }
    .chart-axis-title {
      font-size: 11px;
      fill: #5f5a52;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .chart-point {
      opacity: 0.38;
      transition: opacity 90ms ease, transform 90ms ease, stroke-width 90ms ease;
      transform-origin: center;
    }
    .chart-point.is-hovered,
    .chart-point:focus-visible {
      opacity: 1;
      stroke: rgba(255, 255, 255, 0.98);
      stroke-width: 2.5;
    }
    .chart-hover-area {
      cursor: crosshair;
    }
    .chart-hover-line {
      opacity: 0;
      transition: opacity 90ms ease;
      pointer-events: none;
    }
    .chart-hover-line.visible {
      opacity: 1;
    }
    .chart-reference-line {
      opacity: 1;
      stroke-linecap: round;
      pointer-events: auto;
    }
    .chart-reference-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .chart-reference-chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .chart-reference-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid rgba(31, 31, 31, 0.10);
      background: rgba(255, 253, 248, 0.92);
      color: var(--muted);
      font-size: 12px;
    }
    .chart-reference-chip-line {
      width: 18px;
      height: 0;
      border-top-width: 2px;
      border-top-style: dashed;
      flex: 0 0 auto;
    }
    .chart-hover-marker {
      opacity: 0;
      transition: opacity 90ms ease;
      pointer-events: none;
    }
    .chart-hover-marker.visible {
      opacity: 1;
    }
    .table {
      width: 100%;
      border-collapse: collapse;
    }
    .table th,
    .table td {
      border-top: 1px solid var(--line);
      padding: 12px 10px;
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }
    .table th {
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      border-top: none;
      padding-top: 0;
    }
    .metric-bars {
      display: grid;
      gap: 8px;
      min-width: 220px;
    }
    .bar-row {
      display: grid;
      gap: 6px;
    }
    .bar-track {
      position: relative;
      height: 10px;
      border-radius: 999px;
      background: rgba(21, 97, 109, 0.10);
      overflow: hidden;
    }
    .bar-fill {
      position: absolute;
      inset: 0 auto 0 0;
      border-radius: 999px;
    }
    .bar-fill.time { background: linear-gradient(90deg, var(--accent), #1f8a70); }
    .bar-fill.memory { background: linear-gradient(90deg, var(--accent-alt), #ffb703); }
    .muted {
      color: var(--muted);
    }
    .run-links {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 14px;
    }
    .run-links a {
      color: var(--accent);
      text-decoration: none;
      font-weight: 600;
    }
    .collapsible-panel {
      overflow: hidden;
    }
    .collapsible-panel summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .collapsible-panel summary::-webkit-details-marker {
      display: none;
    }
    .collapsible-title-wrap {
      min-width: 0;
    }
    .collapsible-chevron {
      color: var(--accent);
      font-size: 18px;
      font-weight: 700;
      transition: transform 120ms ease;
      flex: 0 0 auto;
    }
    .collapsible-panel[open] .collapsible-chevron {
      transform: rotate(90deg);
    }
    .stacktrace-shell {
      margin-top: 16px;
      border-radius: 18px;
      border: 1px solid rgba(180, 35, 24, 0.14);
      background:
        linear-gradient(180deg, rgba(255, 247, 245, 0.98) 0%, rgba(255, 252, 250, 0.98) 100%);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
      overflow: hidden;
    }
    .stacktrace-header {
      padding: 14px 18px;
      border-bottom: 1px solid rgba(180, 35, 24, 0.10);
      background:
        linear-gradient(90deg, rgba(180, 35, 24, 0.10) 0%, rgba(180, 35, 24, 0.03) 100%);
      color: #7a2018;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .stacktrace-body {
      margin: 0;
      padding: 18px;
      max-height: min(46vh, 520px);
      overflow: auto;
      background: rgba(255, 253, 250, 0.92);
      color: #2f241c;
      border-top: 1px solid rgba(180, 35, 24, 0.08);
    }
    .stacktrace-block {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .stacktrace-line {
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr);
      gap: 12px;
      align-items: start;
      padding: 3px 0;
      border-radius: 10px;
    }
    .stacktrace-line:hover {
      background: rgba(180, 35, 24, 0.04);
    }
    .stacktrace-line-number {
      color: rgba(122, 32, 24, 0.62);
      font-size: 12px;
      text-align: right;
      user-select: none;
    }
    .stacktrace-line code {
      color: inherit;
      font-family: Consolas, "Cascadia Code", monospace;
      font-size: 12.5px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .stacktrace-line.is-heading code {
      color: #7a2018;
      font-weight: 700;
    }
    .stacktrace-line.is-alert code {
      color: #8f2d1f;
      font-weight: 600;
    }
    .stacktrace-line.is-compare code {
      color: #7c5c3b;
      font-weight: 600;
    }
    .stacktrace-line.is-frame code {
      color: #5f5a52;
    }
    .failure-summary-shell {
      display: grid;
      gap: 12px;
    }
    .failure-summary-list {
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .failure-summary-item {
      padding: 12px 14px;
      border-radius: 16px;
      border: 1px solid rgba(180, 35, 24, 0.12);
      background: linear-gradient(180deg, rgba(255, 248, 246, 0.98) 0%, rgba(255, 253, 250, 0.96) 100%);
      color: #5a2b24;
      font-size: 14px;
      line-height: 1.45;
    }
    .failure-summary-source {
      display: block;
      margin-bottom: 6px;
      color: #7a2018;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .stack {
      display: grid;
      gap: 18px;
      margin-bottom: 18px;
    }
    .chart-grid {
      display: grid;
      gap: 18px;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
    .chart-controls {
      display: grid;
      gap: 10px;
      margin: 14px 0 18px;
    }
    .control-group {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .control-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.68);
      font-size: 13px;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 12px;
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--muted);
    }
    .chart-tooltip {
      position: fixed;
      z-index: 999;
      max-width: min(320px, calc(100vw - 24px));
      padding: 10px 12px;
      border-radius: 14px;
      border: 1px solid rgba(31, 31, 31, 0.12);
      background: rgba(31, 31, 31, 0.92);
      color: #fffdf8;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.2);
      font-size: 13px;
      line-height: 1.4;
      pointer-events: none;
      opacity: 0;
      transform: translate3d(0, 0, 0);
      transition: opacity 120ms ease;
    }
    .chart-tooltip.visible {
      opacity: 1;
    }
    .chart-lightbox {
      position: fixed;
      inset: 0;
      z-index: 1100;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(19, 18, 16, 0.72);
      backdrop-filter: blur(12px);
    }
    .chart-lightbox.visible {
      display: flex;
    }
    .chart-lightbox-backdrop {
      position: absolute;
      inset: 0;
    }
    .chart-lightbox-panel {
      position: relative;
      z-index: 1;
      width: min(1200px, calc(100vw - 40px));
      max-height: calc(100vh - 40px);
      overflow: auto;
      padding: 22px;
      border-radius: 24px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 253, 248, 0.98);
      box-shadow: 0 28px 80px rgba(0, 0, 0, 0.30);
    }
    .chart-lightbox-panel svg {
      width: auto;
      min-width: 100%;
      max-width: none;
      height: min(76vh, 920px);
      display: block;
    }
    .chart-lightbox-close {
      position: sticky;
      top: 0;
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      border: 1px solid rgba(31, 31, 31, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.90);
      color: var(--ink);
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
    }
    .legend-swatch {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      flex: 0 0 auto;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .pill.passed { background: rgba(42, 127, 98, 0.12); color: var(--ok); }
    .pill.failed { background: rgba(180, 35, 24, 0.12); color: var(--bad); }
    .pill.timedOut, .pill.interrupted { background: rgba(192, 86, 33, 0.12); color: var(--warn); }
    .step-header {
      display: grid;
      gap: 8px;
      margin-bottom: 12px;
    }
    .step-header-label {
      color: var(--accent);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .step-header-title {
      font-size: 16px;
      font-weight: 700;
      line-height: 1.4;
    }
    .step-timeline {
      display: grid;
      gap: 8px;
      margin-bottom: 18px;
    }
    .step-timeline-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: baseline;
      padding: 0;
    }
    .step-timeline-row.is-substep {
      margin-left: 18px;
    }
    .step-check {
      color: var(--ok);
      font-size: 16px;
      font-weight: 800;
      line-height: 1;
    }
    .step-duration {
      color: var(--ok);
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
    }
    .step-label {
      font-size: 14px;
      font-weight: 400;
      line-height: 1.45;
      flex: 1 1 360px;
    }
    .step-transcript {
      margin: 0;
      padding: 18px;
      border-radius: 18px;
      border: 1px solid rgba(31, 31, 31, 0.10);
      background: rgba(31, 31, 31, 0.94);
      color: #f8f4ec;
      overflow-x: auto;
    }
    .small {
      font-size: 12px;
    }
    code {
      font-family: Consolas, "Cascadia Code", monospace;
      background: rgba(31, 31, 31, 0.05);
      padding: 2px 6px;
      border-radius: 6px;
    }
    @media (max-width: 700px) {
      .page { width: min(100vw - 20px, 1280px); padding-top: 18px; }
      .hero, .panel { border-radius: 18px; }
      .table th, .table td { padding-left: 6px; padding-right: 6px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div class="eyebrow">Playwright Performance Report</div>
      <h1>${escapeHtml(heading)}</h1>
      <p class="intro">${escapeHtml(intro)}</p>
      <div class="run-links">
        ${links.map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join('')}
      </div>
    </section>
    <div id="app"></div>
  </div>
  <script id="report-data" type="application/json">${serializeForScript(data)}</script>
  <script>
    const data = JSON.parse(document.getElementById('report-data').textContent);
    const app = document.getElementById('app');

    function formatMs(value) {
      return Math.round(Number(value || 0)) + ' ms';
    }

    function formatMb(bytes) {
      return (Number(bytes || 0) / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function statusClass(status) {
      if (status === 'passed') return 'passed';
      if (status === 'failed') return 'failed';
      if (status === 'timedOut') return 'timedOut';
      return 'interrupted';
    }

    function buildCards(cards) {
      return '<section class="grid cards">' + cards.map((card) => (
        '<div class="panel">' +
          '<div class="card-label">' + escapeHtml(card.label) + '</div>' +
          '<div class="card-value">' + escapeHtml(card.value) + '</div>' +
          (card.note ? '<div class="card-note">' + escapeHtml(card.note) + '</div>' : '') +
        '</div>'
      )).join('') + '</section>';
    }

    const chartPalette = [
      '#15616d',
      '#ff7d00',
      '#0b6e4f',
      '#8f2d56',
      '#3d348b',
      '#6a994e',
      '#bc4749',
      '#4361ee',
      '#c1121f',
      '#2a9d8f',
    ];

    const chartTooltip = document.createElement('div');
    chartTooltip.className = 'chart-tooltip';
    chartTooltip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(chartTooltip);

    const chartLightbox = document.createElement('div');
    chartLightbox.className = 'chart-lightbox';
    chartLightbox.setAttribute('aria-hidden', 'true');
    chartLightbox.innerHTML =
      '<div class="chart-lightbox-backdrop" data-chart-lightbox-close="1"></div>' +
      '<div class="chart-lightbox-panel">' +
        '<button class="chart-lightbox-close" type="button" aria-label="Close enlarged chart" data-chart-lightbox-close="1">&times;</button>' +
        '<div data-chart-lightbox-body></div>' +
      '</div>';
    document.body.appendChild(chartLightbox);

    function hideChartTooltip() {
      chartTooltip.classList.remove('visible');
      chartTooltip.setAttribute('aria-hidden', 'true');
    }

    function showChartTooltip(text, event) {
      if (!text) {
        hideChartTooltip();
        return;
      }
      chartTooltip.innerHTML = escapeHtml(text).replace(/\\n/g, '<br>');
      chartTooltip.classList.add('visible');
      chartTooltip.setAttribute('aria-hidden', 'false');
      const x = Number(event?.clientX || 0);
      const y = Number(event?.clientY || 0);
      const offset = 14;
      const tooltipWidth = chartTooltip.offsetWidth || 220;
      const tooltipHeight = chartTooltip.offsetHeight || 64;
      const maxLeft = Math.max(12, window.innerWidth - tooltipWidth - 12);
      const maxTop = Math.max(12, window.innerHeight - tooltipHeight - 12);
      chartTooltip.style.left = Math.min(Math.max(12, x + offset), maxLeft) + 'px';
      chartTooltip.style.top = Math.min(Math.max(12, y - tooltipHeight - offset), maxTop) + 'px';
    }

    function ghostColor(color, alpha = 0.5) {
      const match = String(color || '').trim().match(/^#([0-9a-f]{6})$/i);
      if (!match) {
        return color || 'rgba(31, 31, 31, ' + String(alpha) + ')';
      }
      const hex = match[1];
      const red = parseInt(hex.slice(0, 2), 16);
      const green = parseInt(hex.slice(2, 4), 16);
      const blue = parseInt(hex.slice(4, 6), 16);
      return 'rgba(' + red + ', ' + green + ', ' + blue + ', ' + String(alpha) + ')';
    }

    function attachChartTooltips(root = document) {
      for (const node of root.querySelectorAll('[data-chart-tooltip]')) {
        node.addEventListener('pointerenter', (event) => {
          showChartTooltip(node.getAttribute('data-chart-tooltip'), event);
        });
        node.addEventListener('pointermove', (event) => {
          showChartTooltip(node.getAttribute('data-chart-tooltip'), event);
        });
        node.addEventListener('pointerleave', hideChartTooltip);
        node.addEventListener('focus', () => {
          const rect = node.getBoundingClientRect();
          showChartTooltip(node.getAttribute('data-chart-tooltip'), {
            clientX: rect.left + (rect.width / 2),
            clientY: rect.top,
          });
        });
        node.addEventListener('blur', hideChartTooltip);
      }
    }

    function setHoveredChartPoints(svg, activePoints) {
      const activeIds = new Set((activePoints || []).map((point) => String(point.id)));
      for (const node of svg.querySelectorAll('[data-chart-point-id]')) {
        node.classList.toggle('is-hovered', activeIds.has(String(node.getAttribute('data-chart-point-id'))));
      }
    }

    function clearChartHover(svg) {
      const hoverLine = svg.querySelector('[data-chart-hover-line]');
      const hoverMarkers = svg.querySelector('[data-chart-hover-markers]');
      if (hoverLine) {
        hoverLine.classList.remove('visible');
      }
      if (hoverMarkers) {
        hoverMarkers.innerHTML = '';
      }
      setHoveredChartPoints(svg, []);
    }

    function renderChartHover(svg, activePoints, hoverX) {
      const hoverLine = svg.querySelector('[data-chart-hover-line]');
      const hoverMarkers = svg.querySelector('[data-chart-hover-markers]');
      if (!hoverLine || !hoverMarkers || !activePoints.length) {
        clearChartHover(svg);
        return;
      }
      hoverLine.setAttribute('x1', hoverX.toFixed(2));
      hoverLine.setAttribute('x2', hoverX.toFixed(2));
      hoverLine.classList.add('visible');
      hoverMarkers.innerHTML = activePoints.map((point) => (
        '<g class="chart-hover-marker visible" transform="translate(' + point.x.toFixed(2) + ' ' + point.y.toFixed(2) + ')">' +
          '<circle r="11" fill="' + point.color + '" opacity="0.18"></circle>' +
          '<circle r="7" fill="' + point.color + '" stroke="rgba(255,255,255,0.96)" stroke-width="2.5"></circle>' +
          '<circle r="2.6" fill="#fffdf8"></circle>' +
        '</g>'
      )).join('');
      setHoveredChartPoints(svg, activePoints);
    }

    function chartSvgXFromEvent(overlay, svg, event) {
      const rect = overlay.getBoundingClientRect();
      const viewBoxWidth = svg.viewBox?.baseVal?.width || rect.width || 1;
      const relativeX = Math.min(Math.max(0, Number(event?.clientX || rect.left) - rect.left), Math.max(rect.width, 1));
      return (relativeX / Math.max(rect.width, 1)) * viewBoxWidth;
    }

    function chartHoverPayloadForX(definition, svgX) {
      if (!definition) return null;
      if (definition.mode === 'multi') {
        const groups = Array.isArray(definition.groups) ? definition.groups : [];
        if (!groups.length) return null;
        const nearestGroup = groups.reduce((best, group) => {
          if (!best) return group;
          return Math.abs(group.x - svgX) < Math.abs(best.x - svgX) ? group : best;
        }, null);
        if (!nearestGroup) return null;
        return {
          hoverX: nearestGroup.x,
          tooltipText: [nearestGroup.header, ...nearestGroup.points.map((point) => point.tooltip)].filter(Boolean).join('\\n'),
          activePoints: nearestGroup.points.map((point) => ({
            id: point.id,
            x: nearestGroup.x,
            y: point.y,
            color: point.color,
          })),
        };
      }
      const points = Array.isArray(definition.points) ? definition.points : [];
      if (!points.length) return null;
      const nearestPoint = points.reduce((best, point) => {
        if (!best) return point;
        return Math.abs(point.x - svgX) < Math.abs(best.x - svgX) ? point : best;
      }, null);
      if (!nearestPoint) return null;
      return {
        hoverX: nearestPoint.x,
        tooltipText: nearestPoint.tooltip,
        activePoints: [{
          id: nearestPoint.id,
          x: nearestPoint.x,
          y: nearestPoint.y,
          color: nearestPoint.color,
        }],
      };
    }

    function attachChartHoverRegions(root = document) {
      for (const overlay of root.querySelectorAll('[data-chart-hover-area]')) {
        const svg = overlay.closest('svg');
        if (!svg) continue;
        let definition = null;
        try {
          definition = JSON.parse(overlay.getAttribute('data-chart-hover-definition') || 'null');
        } catch (_error) {
          definition = null;
        }
        if (!definition) continue;

        const updateHover = (event) => {
          const payload = chartHoverPayloadForX(definition, chartSvgXFromEvent(overlay, svg, event));
          if (!payload) {
            clearChartHover(svg);
            hideChartTooltip();
            return;
          }
          renderChartHover(svg, payload.activePoints, payload.hoverX);
          showChartTooltip(payload.tooltipText, event);
        };

        overlay.addEventListener('pointerenter', updateHover);
        overlay.addEventListener('pointermove', updateHover);
        overlay.addEventListener('pointerleave', () => {
          clearChartHover(svg);
          hideChartTooltip();
        });
      }
    }

    function scrollChartContainersToLatest(root = document) {
      const chartScrollEls = Array.from(root.querySelectorAll('.chart-scroll'));
      if (!chartScrollEls.length) return;
      const applyScroll = () => {
        for (const scrollEl of chartScrollEls) {
          if (!scrollEl?.isConnected) continue;
          const maxScrollLeft = Math.max(
            0,
            Number(scrollEl.scrollWidth || 0) - Number(scrollEl.clientWidth || 0),
          );
          scrollEl.scrollLeft = maxScrollLeft;
        }
      };
      window.requestAnimationFrame(() => {
        applyScroll();
        window.requestAnimationFrame(applyScroll);
      });
    }

    function buildYAxisMarkup(width, height, padding, formatter, maxValue, axisTitle) {
      const tickCount = 5;
      const ticks = Array.from({ length: tickCount }, (_, index) => {
        const ratio = index / (tickCount - 1);
        const value = maxValue * (1 - ratio);
        const y = padding + ((height - (padding * 2)) * ratio);
        return { value, y };
      });
      const gridLines = ticks.map((tick) => (
        '<line class="chart-axis-grid" x1="' + padding + '" y1="' + tick.y.toFixed(2) + '" x2="' + (width - padding) + '" y2="' + tick.y.toFixed(2) + '"></line>'
      )).join('');
      const labels = ticks.map((tick) => (
        '<text class="chart-axis-label" x="' + (padding - 8) + '" y="' + (tick.y + 4).toFixed(2) + '" text-anchor="end">' + escapeHtml(formatter(tick.value)) + '</text>'
      )).join('');
      const title = axisTitle
        ? '<text class="chart-axis-title" x="16" y="' + (height / 2).toFixed(2) + '" text-anchor="middle" transform="rotate(-90 16 ' + (height / 2).toFixed(2) + ')">' + escapeHtml(axisTitle) + '</text>'
        : '';
      return gridLines + labels + title;
    }

    function stripAnsi(value) {
      return String(value ?? '').replace(/\\u001b\\[[0-9;]*m/g, '');
    }

    function normalizeReportText(value) {
      return stripAnsi(value).replace(/\\r/g, '');
    }

    function chartLogicalWidth(pointCount, padding, options = {}) {
      const minWidth = Number(options.minWidth || 760);
      const pointSpacing = Math.max(Number(options.pointSpacing || 28), 18);
      if (pointCount <= 1) {
        return minWidth;
      }
      return Math.max(minWidth, (padding * 2) + ((pointCount - 1) * pointSpacing));
    }

    function buildReferenceChipMarkup(referenceLines, formatter) {
      if (!referenceLines.length) {
        return '';
      }
      return (
        '<div class="chart-reference-chip-row">' +
          referenceLines.map((entry) => (
            '<span class="chart-reference-chip">' +
              '<span class="chart-reference-chip-line" style="border-top-color:' + escapeHtml(entry.color) + ';"></span>' +
              '<span>' + escapeHtml((entry.label || 'Acceptable baseline') + ': ' + formatter(entry.value)) + '</span>' +
            '</span>'
          )).join('') +
        '</div>'
      );
    }

    function classifyStacktraceLine(line) {
      const trimmed = String(line || '').trim();
      if (!trimmed) return 'stacktrace-line';
      if (/^Error \\d+$/u.test(trimmed)) return 'stacktrace-line is-heading';
      if (/^at\\s+/u.test(trimmed)) return 'stacktrace-line is-frame';
      if (/^(Expected:|Received:|- Expected|\\+ Received|Array \\[|expect\\()/u.test(trimmed)) {
        return 'stacktrace-line is-compare';
      }
      if (/exceeded|TimeoutError|AssertionError|TypeError|ReferenceError|Error:|failed/iu.test(trimmed)) {
        return 'stacktrace-line is-alert';
      }
      return 'stacktrace-line';
    }

    function buildFormattedStacktrace(text) {
      const normalized = normalizeReportText(text);
      if (!normalized.trim()) {
        return '';
      }
      return (
        '<div class="stacktrace-shell">' +
          '<div class="stacktrace-header">Captured Failure Stacktrace</div>' +
          '<div class="stacktrace-body">' +
            '<div class="stacktrace-block">' +
              normalized.split('\\n').map((line, index) => (
                '<div class="' + classifyStacktraceLine(line) + '">' +
                  '<span class="stacktrace-line-number">' + escapeHtml(String(index + 1)) + '</span>' +
                  '<code>' + escapeHtml(line || ' ') + '</code>' +
                '</div>'
              )).join('') +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }

    function summarizeFailureReasons(run, stacktraceText) {
      const reasons = [];
      const seen = new Set();
      const failedEvents = Array.isArray(run?.stepEvents)
        ? run.stepEvents.filter((event) => event?.type === 'step' && event.status === 'failed')
        : [];

      for (const event of failedEvents) {
        const message = normalizeReportText(event?.message || '').trim();
        if (!message) continue;
        const entry = {
          source: event.label || 'Failed step',
          text: message,
        };
        const dedupeKey = entry.source + '::' + entry.text;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          reasons.push(entry);
        }
      }

      const stackLines = normalizeReportText(stacktraceText)
        .split('\\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^Error \\d+$/u.test(line));

      for (const line of stackLines) {
        if (/^at\\s+/u.test(line)) break;
        if (/^expect\\(/u.test(line)) break;
        const source = /Expected:|Received:|- Expected|\\+ Received/u.test(line)
          ? 'Assertion details'
          : 'Captured failure';
        const dedupeKey = source + '::' + line;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          reasons.push({ source, text: line });
        }
        if (reasons.length >= 6) break;
      }

      return reasons.slice(0, 6);
    }

    function buildFailureSummarySection(run, stacktraceText) {
      if (run?.status !== 'failed') {
        return '';
      }
      const reasons = summarizeFailureReasons(run, stacktraceText);
      if (!reasons.length) {
        return '';
      }
      return (
        '<section class="panel">' +
          '<h2 class="section-title">Failure Reason</h2>' +
          '<div class="failure-summary-shell">' +
            '<p class="section-note">The clearest failure signals from the failed step log and captured stacktrace are surfaced here first so you do not need to scan the raw transcript to understand the break.</p>' +
            '<ul class="failure-summary-list">' +
              reasons.map((reason) => (
                '<li class="failure-summary-item">' +
                  '<span class="failure-summary-source">' + escapeHtml(reason.source) + '</span>' +
                  escapeHtml(reason.text) +
                '</li>'
              )).join('') +
            '</ul>' +
          '</div>' +
        '</section>'
      );
    }

    function closeChartLightbox() {
      chartLightbox.classList.remove('visible');
      chartLightbox.setAttribute('aria-hidden', 'true');
      const body = chartLightbox.querySelector('[data-chart-lightbox-body]');
      if (body) {
        body.innerHTML = '';
      }
    }

    function openChartLightbox(panel) {
      const body = chartLightbox.querySelector('[data-chart-lightbox-body]');
      const chartShell = panel?.querySelector('.chart-shell');
      const svg = panel?.querySelector('svg');
      if (!body || (!chartShell && !svg)) return;
      const title = panel.querySelector('.section-title')?.textContent || 'Expanded chart';
      const note = panel.querySelector('.section-note')?.textContent || '';
      body.innerHTML =
        '<h2 class="section-title">' + escapeHtml(title) + '</h2>' +
        (note ? '<p class="section-note">' + escapeHtml(note) + '</p>' : '') +
        (chartShell ? chartShell.outerHTML : svg.outerHTML);
      attachChartTooltips(body);
      attachChartHoverRegions(body);
      scrollChartContainersToLatest(body);
      chartLightbox.classList.add('visible');
      chartLightbox.setAttribute('aria-hidden', 'false');
    }

    function attachExpandableCharts(root = document) {
      for (const panel of root.querySelectorAll('[data-chart-expandable="1"]')) {
        if (panel.dataset.chartExpandBound === '1') continue;
        panel.dataset.chartExpandBound = '1';
        panel.addEventListener('dblclick', (event) => {
          if (event.target?.closest?.('a, button, input, label')) return;
          openChartLightbox(panel);
        });
      }
    }

    for (const node of chartLightbox.querySelectorAll('[data-chart-lightbox-close]')) {
      node.addEventListener('click', closeChartLightbox);
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && chartLightbox.classList.contains('visible')) {
        closeChartLightbox();
      }
    });

    function buildLineChart(title, points, formatter, color, options = {}) {
      if (!points.length) {
        return (
          '<div class="panel chart" data-chart-expandable="1">' +
            '<h2 class="section-title">' + escapeHtml(title) + '</h2>' +
            '<p class="section-note">No data captured for this chart on this run.</p>' +
          '</div>'
        );
      }

      const height = 220;
      const padding = 58;
      const strokeWidth = Number(options.strokeWidth || 4);
      const values = points.map((point) => Number(point.value || 0));
      const referenceLines = Array.isArray(options.referenceLines)
        ? options.referenceLines
          .map((entry) => ({
            ...entry,
            value: Number(entry?.value || 0),
            color: entry?.color || ghostColor(color),
            dashArray: entry?.dashArray || '8 8',
          }))
          .filter((entry) => Number.isFinite(entry.value) && entry.value >= 0)
        : [];
      const maxValue = Math.max(
        ...values,
        ...referenceLines.map((entry) => entry.value),
        1,
      );
      const totalPointCount = Math.max(...points.map((point, index) => (
        Number.isFinite(point.totalCount) ? Number(point.totalCount) : index + 1
      )), points.length, 1);
      const width = chartLogicalWidth(totalPointCount, padding, options);
      const yForValue = (value) => (
        height - padding - ((height - (padding * 2)) * (Number(value || 0) / maxValue))
      );
      const xForPoint = (point, index) => {
        if (totalPointCount <= 1) {
          return padding + ((width - (padding * 2)) * 0.5);
        }
        const logicalIndex = Number.isFinite(point.runIndex) ? Number(point.runIndex) : index;
        return padding + ((width - (padding * 2)) * (logicalIndex / (totalPointCount - 1)));
      };
      const polyline = points.map((point, index) => {
        const x = xForPoint(point, index);
        const y = yForValue(point.value);
        return x.toFixed(2) + ',' + y.toFixed(2);
      }).join(' ');
      const hoverDefinition = {
        mode: 'single',
        points: points.map((point, index) => {
          const x = xForPoint(point, index);
          const y = yForValue(point.value);
          const pointLabel = point.label || point.runId || ('Point ' + String(index + 1));
          const pointRunLabel = point.runId && point.runId !== pointLabel ? ' (' + point.runId + ')' : '';
          const tooltipText = [pointLabel + ': ' + formatter(point.value) + pointRunLabel, point.startedAt || ''].filter(Boolean).join('\\n');
          return {
            id: title + '-' + String(index),
            x,
            y,
            color,
            tooltip: tooltipText,
          };
        }),
      };
      const markers = points.map((point, index) => {
        const x = xForPoint(point, index);
        const y = yForValue(point.value);
        const pointLabel = point.label || point.runId || ('Point ' + String(index + 1));
        const pointRunLabel = point.runId && point.runId !== pointLabel ? ' (' + point.runId + ')' : '';
        const tooltipText = [pointLabel + ': ' + formatter(point.value) + pointRunLabel, point.startedAt || ''].filter(Boolean).join('\\n');
        return (
          '<circle class="chart-point" cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="4.5" fill="' + color + '" stroke="rgba(255,255,255,0.82)" stroke-width="1.5" tabindex="0" data-chart-point-id="' + escapeHtml(title + '-' + String(index)) + '" data-chart-tooltip="' + escapeHtml(tooltipText) + '">' +
            '<title>' + escapeHtml(pointLabel + ': ' + formatter(point.value) + pointRunLabel) + '</title>' +
          '</circle>'
        );
      }).join('');
      const labels = Array.from({ length: totalPointCount }, (_, index) => {
        const x = totalPointCount === 1
          ? padding + ((width - (padding * 2)) * 0.5)
          : padding + ((width - (padding * 2)) * (index / (totalPointCount - 1)));
        return '<text x="' + x.toFixed(2) + '" y="' + (height - 8) + '" text-anchor="middle" font-size="11" fill="#5f5a52">' + escapeHtml(String(index + 1)) + '</text>';
      }).join('');
      const yAxisMarkup = buildYAxisMarkup(width, height, padding, formatter, maxValue, options.yAxisTitle || '');
      const referenceLineMarkup = referenceLines.map((entry) => {
        const y = yForValue(entry.value);
        const tooltipText = [
          (entry.label || 'Acceptable baseline') + ': ' + formatter(entry.value),
          entry.note || '',
        ].filter(Boolean).join('\\n');
        return (
          '<line class="chart-reference-line" x1="' + padding + '" y1="' + y.toFixed(2) + '" x2="' + (width - padding) + '" y2="' + y.toFixed(2) + '" stroke="' + escapeHtml(entry.color) + '" stroke-width="2" stroke-dasharray="' + escapeHtml(entry.dashArray) + '" data-chart-tooltip="' + escapeHtml(tooltipText) + '">' +
            '<title>' + escapeHtml((entry.label || 'Acceptable baseline') + ': ' + formatter(entry.value)) + '</title>' +
          '</line>' +
          '<text class="chart-reference-label" x="' + (width - padding - 8) + '" y="' + Math.max(y - 8, padding + 10).toFixed(2) + '" text-anchor="end" fill="' + escapeHtml(entry.color) + '">' + escapeHtml(entry.label || 'Acceptable baseline') + '</text>'
        );
      }).join('');
      const latest = points[points.length - 1];
      return (
        '<div class="panel chart" data-chart-expandable="1">' +
          '<h2 class="section-title">' + escapeHtml(title) + '</h2>' +
          '<p class="section-note">' + escapeHtml(options.note || ('Latest: ' + formatter(latest?.value || 0))) + '</p>' +
          '<div class="chart-shell">' +
            '<div class="chart-scroll">' +
              '<svg style="width:' + width + 'px;min-width:' + width + 'px" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + escapeHtml(title) + '">' +
                yAxisMarkup +
                '<line x1="' + padding + '" y1="' + (height - padding) + '" x2="' + (width - padding) + '" y2="' + (height - padding) + '" stroke="rgba(31,31,31,0.16)"></line>' +
                '<line x1="' + padding + '" y1="' + padding + '" x2="' + padding + '" y2="' + (height - padding) + '" stroke="rgba(31,31,31,0.16)"></line>' +
                '<polyline fill="none" stroke="' + color + '" stroke-width="' + strokeWidth + '" stroke-linecap="round" stroke-linejoin="round" points="' + polyline + '"></polyline>' +
                referenceLineMarkup +
                markers +
                '<line data-chart-hover-line class="chart-hover-line" x1="' + padding + '" y1="' + padding + '" x2="' + padding + '" y2="' + (height - padding) + '" stroke="rgba(31,31,31,0.24)" stroke-width="2" stroke-dasharray="5 5"></line>' +
                '<g data-chart-hover-markers></g>' +
                '<rect class="chart-hover-area" data-chart-hover-area="1" data-chart-hover-definition="' + escapeHtml(JSON.stringify(hoverDefinition)) + '" x="' + padding + '" y="' + padding + '" width="' + (width - (padding * 2)) + '" height="' + (height - (padding * 2)) + '" fill="transparent"></rect>' +
                labels +
              '</svg>' +
            '</div>' +
            buildReferenceChipMarkup(referenceLines, formatter) +
          '</div>' +
        '</div>'
      );
    }

    function buildStepTimeline(stepEvents, testTitle) {
      if (!stepEvents.length) {
        return (
          '<section class="panel">' +
            '<h2 class="section-title">Test-Owned Step Timeline</h2>' +
            '<p class="section-note">No passed Playwright steps were captured for this run.</p>' +
          '</section>'
        );
      }

      const rows = stepEvents.map((event) => {
        const rowClass = event.level > 1 ? 'step-timeline-row is-substep' : 'step-timeline-row';
        return (
          '<div class="' + rowClass + '">' +
            '<span class="step-check" aria-hidden="true">&#10003;</span>' +
            '<span class="step-label">' + escapeHtml(event.label) + '</span>' +
            '<span class="step-duration">' + escapeHtml(formatMs(event.durationMs)) + '</span>' +
          '</div>'
        );
      }).join('');

      return (
        '<section class="panel">' +
          '<h2 class="section-title">Test-Owned Step Timeline</h2>' +
          '<p class="section-note">These timings belong to the Playwright test run for <code>' + escapeHtml(testTitle) + '</code>.</p>' +
          '<div class="step-timeline">' + rows + '</div>' +
        '</section>'
      );
    }

    function buildMultiLineChart(title, series, formatter, note, totalPointCount) {
      if (!series.length) {
        return (
          '<div class="panel chart" data-chart-expandable="1">' +
            '<h2 class="section-title">' + escapeHtml(title) + '</h2>' +
            '<p class="section-note">Select at least one series to render this chart.</p>' +
          '</div>'
        );
      }

      const height = 240;
      const padding = 58;
      const values = series.flatMap((entry) => entry.points.map((point) => Number(point.value || 0)));
      const referenceLines = series
        .flatMap((entry) => (
          Array.isArray(entry.referenceLines)
            ? entry.referenceLines.map((referenceLine) => ({
              ...referenceLine,
              seriesKey: entry.key,
              value: Number(referenceLine?.value || 0),
              color: referenceLine?.color || ghostColor(entry.color),
              dashArray: referenceLine?.dashArray || '8 8',
            }))
            : []
        ))
        .filter((entry) => Number.isFinite(entry.value) && entry.value >= 0);
      const maxValue = Math.max(
        ...values,
        ...referenceLines.map((entry) => entry.value),
        1,
      );
      const width = chartLogicalWidth(totalPointCount, padding, { minWidth: 760, pointSpacing: 28 });
      const yForValue = (value) => (
        height - padding - ((height - (padding * 2)) * (Number(value || 0) / maxValue))
      );
      const xForIndex = (index) => (
        padding + ((width - (padding * 2)) * (totalPointCount <= 1 ? 0.5 : index / (totalPointCount - 1)))
      );
      const labels = Array.from({ length: totalPointCount }, (_, index) => {
        const x = xForIndex(index);
        return '<text x="' + x.toFixed(2) + '" y="' + (height - 8) + '" text-anchor="middle" font-size="11" fill="#5f5a52">' + escapeHtml(String(index + 1)) + '</text>';
      }).join('');
      const yAxisMarkup = buildYAxisMarkup(width, height, padding, formatter, maxValue, 'Time (ms)');
      const hoverGroups = Array.from({ length: totalPointCount }, (_, index) => {
        const runMeta = series.flatMap((entry) => entry.points).find((point) => point.runIndex === index) || null;
        return {
          runIndex: index,
          x: xForIndex(index),
          header: [runMeta ? ('Run ' + String(index + 1) + ' (' + runMeta.runId + ')') : ('Run ' + String(index + 1)), runMeta?.startedAt || ''].filter(Boolean).join('\\n'),
          points: [],
        };
      });
      const trendLines = series.map((entry) => {
        const polyline = entry.points.map((point) => (
          xForIndex(point.runIndex).toFixed(2) + ',' + yForValue(point.value).toFixed(2)
        )).join(' ');
        const markers = entry.points.map((point) => {
          const x = xForIndex(point.runIndex);
          const y = yForValue(point.value);
          const tooltipText = entry.label + ': ' + formatter(point.value) + ' (' + point.runId + ')';
          hoverGroups[point.runIndex]?.points.push({
            id: entry.key + '-' + String(point.runIndex),
            y,
            color: entry.color,
            tooltip: tooltipText,
          });
          return '<circle class="chart-point" cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="4.5" fill="' + entry.color + '" stroke="rgba(255,255,255,0.82)" stroke-width="1.5" tabindex="0" data-chart-point-id="' + escapeHtml(entry.key + '-' + String(point.runIndex)) + '" data-chart-tooltip="' + escapeHtml([tooltipText, point.startedAt || ''].filter(Boolean).join('\\n')) + '"><title>' + escapeHtml(entry.label + ': ' + formatter(point.value) + ' (' + point.runId + ')') + '</title></circle>';
        }).join('');
        return (
          '<polyline fill="none" stroke="' + entry.color + '" stroke-width="3.5" points="' + polyline + '"></polyline>' +
          markers
        );
      }).join('');
      const referenceLineMarkup = referenceLines.map((entry) => {
        const y = yForValue(entry.value);
        const tooltipText = [
          (entry.label || 'Acceptable baseline') + ': ' + formatter(entry.value),
          entry.note || '',
        ].filter(Boolean).join('\\n');
        return (
          '<line class="chart-reference-line" x1="' + padding + '" y1="' + y.toFixed(2) + '" x2="' + (width - padding) + '" y2="' + y.toFixed(2) + '" stroke="' + escapeHtml(entry.color) + '" stroke-width="2" stroke-dasharray="' + escapeHtml(entry.dashArray) + '" data-chart-tooltip="' + escapeHtml(tooltipText) + '">' +
            '<title>' + escapeHtml((entry.label || 'Acceptable baseline') + ': ' + formatter(entry.value)) + '</title>' +
          '</line>' +
          '<text class="chart-reference-label" x="' + (width - padding - 8) + '" y="' + Math.max(y - 8, padding + 10).toFixed(2) + '" text-anchor="end" fill="' + escapeHtml(entry.color) + '">' + escapeHtml(entry.label || 'Acceptable baseline') + '</text>'
        );
      }).join('');
      const legend = '<div class="legend">' + series.map((entry) => (
        '<span class="legend-item"><span class="legend-swatch" style="background:' + entry.color + '"></span>' +
        escapeHtml(entry.label) + '</span>'
      )).join('') + '</div>';
      return (
        '<div class="panel chart" data-chart-expandable="1">' +
          '<h2 class="section-title">' + escapeHtml(title) + '</h2>' +
          '<p class="section-note">' + escapeHtml(note || ('Retained runs shown oldest to latest. Latest visible value: ' + formatter(series[0]?.points?.at(-1)?.value || 0))) + '</p>' +
          '<div class="chart-shell">' +
            '<div class="chart-scroll">' +
              '<svg style="width:' + width + 'px;min-width:' + width + 'px" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + escapeHtml(title) + '">' +
                yAxisMarkup +
                '<line x1="' + padding + '" y1="' + (height - padding) + '" x2="' + (width - padding) + '" y2="' + (height - padding) + '" stroke="rgba(31,31,31,0.16)"></line>' +
                '<line x1="' + padding + '" y1="' + padding + '" x2="' + padding + '" y2="' + (height - padding) + '" stroke="rgba(31,31,31,0.16)"></line>' +
                trendLines +
                referenceLineMarkup +
                '<line data-chart-hover-line class="chart-hover-line" x1="' + padding + '" y1="' + padding + '" x2="' + padding + '" y2="' + (height - padding) + '" stroke="rgba(31,31,31,0.24)" stroke-width="2" stroke-dasharray="5 5"></line>' +
                '<g data-chart-hover-markers></g>' +
                '<rect class="chart-hover-area" data-chart-hover-area="1" data-chart-hover-definition="' + escapeHtml(JSON.stringify({ mode: 'multi', groups: hoverGroups.filter((group) => group.points.length) })) + '" x="' + padding + '" y="' + padding + '" width="' + (width - (padding * 2)) + '" height="' + (height - (padding * 2)) + '" fill="transparent"></rect>' +
                labels +
              '</svg>' +
            '</div>' +
            buildReferenceChipMarkup(referenceLines, formatter) +
            legend +
          '</div>' +
        '</div>'
      );
    }

    function renderSeriesSelector(targetId, config) {
      const target = document.getElementById(targetId);
      if (!target) return;

      const visibleKeys = new Set(config.series.filter((series) => series.defaultVisible !== false).map((series) => series.key));

      function render() {
        const selectedSeries = config.series.filter((series) => visibleKeys.has(series.key));
        target.innerHTML =
          '<section class="panel">' +
            '<h2 class="section-title">' + escapeHtml(config.title) + '</h2>' +
            '<p class="section-note">' + escapeHtml(config.note) + '</p>' +
            '<div class="chart-controls">' +
              '<div class="control-group">' + config.series.map((series) => (
                '<label class="control-chip">' +
                  '<input type="checkbox" data-series-key="' + escapeHtml(series.key) + '"' + (visibleKeys.has(series.key) ? ' checked' : '') + '>' +
                  '<span style="color:' + series.color + '; font-weight:700;">' + escapeHtml(series.label) + '</span>' +
                '</label>'
              )).join('') + '</div>' +
            '</div>' +
            buildMultiLineChart(config.chartTitle, selectedSeries, config.formatter, config.chartNote, config.totalPointCount) +
          '</section>';

        for (const input of target.querySelectorAll('input[data-series-key]')) {
          input.addEventListener('change', () => {
            const key = input.getAttribute('data-series-key');
            if (input.checked) {
              visibleKeys.add(key);
            } else {
              visibleKeys.delete(key);
            }
            render();
          });
        }
        attachChartTooltips(target);
        attachChartHoverRegions(target);
        attachExpandableCharts(target);
        scrollChartContainersToLatest(target);
      }

      render();
    }

    function buildCheckpointRows(checkpoints) {
      const timingMax = Math.max(...checkpoints.map((checkpoint) => Number(checkpoint.timingMs || 0)), 1);
      const memoryMax = Math.max(...checkpoints.map((checkpoint) => Number(checkpoint.memoryBytes || 0)), 1);
      return checkpoints.map((checkpoint) => {
        const timingWidth = checkpoint.timingMs === null ? 0 : Math.max(4, Math.round((Number(checkpoint.timingMs || 0) / timingMax) * 100));
        const memoryWidth = checkpoint.memoryBytes === null ? 0 : Math.max(4, Math.round((Number(checkpoint.memoryBytes || 0) / memoryMax) * 100));
        return (
          '<tr>' +
            '<td><strong>' + escapeHtml(checkpoint.label) + '</strong><div class="muted small">' + escapeHtml(checkpoint.key) + '</div></td>' +
            '<td>' + (checkpoint.timingMs === null ? '<span class="muted">n/a</span>' : escapeHtml(formatMs(checkpoint.timingMs))) + '</td>' +
            '<td>' + (checkpoint.memoryBytes === null ? '<span class="muted">n/a</span>' : escapeHtml(formatMb(checkpoint.memoryBytes))) + '</td>' +
            '<td class="metric-bars">' +
              '<div class="bar-row">' +
                '<div class="small muted">Time</div>' +
                '<div class="bar-track"><div class="bar-fill time" style="width:' + timingWidth + '%"></div></div>' +
              '</div>' +
              '<div class="bar-row">' +
                '<div class="small muted">Memory</div>' +
                '<div class="bar-track"><div class="bar-fill memory" style="width:' + memoryWidth + '%"></div></div>' +
              '</div>' +
            '</td>' +
            '<td>' + escapeHtml(checkpoint.valueText || checkpoint.memorySource || '') + '</td>' +
          '</tr>'
        );
      }).join('');
    }

    ${bodyScript}
  </script>
</body>
</html>`;
}

function renderRunReport(runMetrics, manifest, suitePathFromRun) {
  const normalizedRunMetrics = normalizeRunMetrics(runMetrics);
  const historicalTiming = buildHistoricalTimingData(manifest.runs);
  const stacktraceText = textArtifactText(normalizedRunMetrics, 'stacktrace.txt');
  const reportBenchmarkValidation = resolveBenchmarkValidationForReport(normalizedRunMetrics, manifest.runs);
  const latestVerificationSummary = buildLatestVerificationSummary(manifest.runs);
  const data = {
    run: normalizedRunMetrics,
    history: manifest.runs,
    historicalTiming,
    benchmarkValidation: reportBenchmarkValidation,
    latestVerificationSummary,
  };
  return renderShell(
    `${normalizedRunMetrics.caseId} - ${normalizedRunMetrics.runId}`,
    `${normalizedRunMetrics.caseId} Historical Report`,
    normalizedRunMetrics.intro,
    data,
    `
    const run = data.run;
    const history = data.history.slice().reverse();
    const historicalTiming = data.historicalTiming;
    const latestVerificationSummary = data.latestVerificationSummary;
    const benchmarkResults = Array.isArray(data.benchmarkValidation?.results)
      ? data.benchmarkValidation.results
      : [];
    const optionalFiniteNumber = (value) => value !== null
      && value !== undefined
      && !(typeof value === 'string' && value.trim() === '')
      && Number.isFinite(Number(value))
      ? Number(value)
      : null;
    const acceptableBaselineByCheckpointKey = new Map(
      benchmarkResults
        .filter((result) => result && result.checkpointKey && optionalFiniteNumber(result.allowedMaximum) !== null)
        .map((result) => [
          String(result.checkpointKey),
          [
            ...(optionalFiniteNumber(result.targetMaximum) !== null ? [{
              value: Number(result.targetMaximum),
              label: 'Target',
              note: result.description || '',
            }] : []),
            {
              value: Number(result.allowedMaximum),
              label: optionalFiniteNumber(result.targetMaximum) !== null ? 'Hard ceiling' : 'Budget ceiling',
              note: result.description || '',
            },
          ],
        ]),
    );
    function acceptableBaselineForCheckpoint(checkpointKey) {
      if (!checkpointKey) return [];
      const baseline = acceptableBaselineByCheckpointKey.get(String(checkpointKey));
      return baseline || [];
    }
    const baseCards = [
      { label: 'Run Status', value: run.status.toUpperCase(), note: run.environment.projectName },
      { label: 'Total Duration', value: formatMs(run.durationMs), note: run.startedAt },
      { label: 'Peak Memory', value: formatMb(run.peakMemoryBytes), note: run.memoryCheckpoints.length + ' memory checkpoints' },
      { label: 'Checkpoint Count', value: String(run.checkpoints.length), note: run.caseId },
    ];
    const cards = run.summaryCards.length ? run.summaryCards.concat(baseCards) : baseCards;
    const runTrendPoints = history.map((entry, index) => ({ label: String(index + 1), value: entry.durationMs, runId: entry.runId, startedAt: entry.startedAt }));
    const memoryTrendPoints = history.map((entry, index) => ({ label: String(index + 1), value: entry.peakMemoryBytes, runId: entry.runId, startedAt: entry.startedAt }));
    const medianTimingTrendPoints = historicalTiming.overlays.medianTiming.map((entry, index) => ({ label: String(index + 1), value: entry.value, runId: entry.runId, startedAt: entry.startedAt }));
    const isIdleMemoryReport = run.reportId === 'idleMemory';
    const perActionCharts = historicalTiming.actions.length
      ? historicalTiming.actions.map((action, index) => buildLineChart(
        action.label + ' Trend',
        action.points.map((point) => ({
          label: point.runId,
          value: point.value,
          runIndex: point.runIndex,
          totalCount: historicalTiming.runCount,
          startedAt: point.startedAt,
        })),
        formatMs,
        chartPalette[index % chartPalette.length],
        {
          referenceLines: acceptableBaselineForCheckpoint(action.key),
        },
      )).join('')
      : '<div class="panel"><h2 class="section-title">Timed Action Trends</h2><p class="section-note">No timed checkpoint history is available yet for this benchmark suite.</p></div>';
    const combinedTimingSeries = historicalTiming.actions.map((action, index) => ({
      key: 'action-' + action.key,
      label: action.label,
      color: chartPalette[index % chartPalette.length],
      defaultVisible: historicalTiming.actions.length <= 4 ? true : index < 4,
      points: action.points,
    })).concat([
      {
        key: 'overlay-median-timing',
        label: 'Median Timed Action',
        color: '#9c6644',
        defaultVisible: true,
        points: historicalTiming.overlays.medianTiming,
      },
    ]).map((series) => ({
      ...series,
      referenceLines: series.key.startsWith('action-')
        ? acceptableBaselineForCheckpoint(series.key.slice('action-'.length))
        : [],
    })).filter((series) => series.points.length);
    const environmentSummary = [
      run.environment.baseURL,
      run.environment.browserName,
      run.environment.channel || '',
      run.environment.headless ? 'headless' : 'headed',
    ].filter(Boolean).join(' | ');
    const runOwnedTitle = run.stepTranscript[0] || ('[TEST] ' + run.title);
    const currentRunChartsSection = isIdleMemoryReport
      ? (
        '<section class="stack">' +
          buildLineChart('Current Run Memory Sequence', run.memorySeries, formatMb, '#ff7d00') +
        '</section>'
      )
      : (
        '<section class="grid two-up">' +
          buildLineChart(
            'Current Run Timing Sequence',
            run.timingSeries,
            formatMs,
            '#15616d',
            {
              note: 'Primary step/checkpoint timings for ' + runOwnedTitle,
              strokeWidth: 6,
            },
          ) +
          buildLineChart('Current Run Memory Sequence', run.memorySeries, formatMb, '#ff7d00') +
        '</section>'
      );
    const retainedTrendSection = isIdleMemoryReport
      ? (
        '<section class="stack">' +
          buildLineChart('30-Day Peak Memory Trend', memoryTrendPoints, formatMb, '#c05621') +
        '</section>'
      )
      : (
        '<section class="grid two-up">' +
          buildLineChart('30-Day Duration Trend', runTrendPoints, formatMs, '#0b6e4f') +
          buildLineChart('30-Day Peak Memory Trend', memoryTrendPoints, formatMb, '#c05621') +
        '</section>'
      );
    const retainedTimingSection = isIdleMemoryReport
      ? ''
      : (
        '<div id="combined-timing-history"></div>' +
        '<section class="stack">' +
          buildLineChart('Median Timed Action Trend', medianTimingTrendPoints, formatMs, '#7c5c3b') +
        '</section>' +
        '<section class="stack">' +
          '<div class="panel"><h2 class="section-title">Timed Action Trends</h2><p class="section-note">Each timed checkpoint now plots its retained historical points across the latest ' + historicalTiming.runCount + ' run(s), oldest to latest.</p></div>' +
          '<div class="chart-grid">' + perActionCharts + '</div>' +
        '</section>'
      );
    const screenshotArtifact = run.retainedArtifacts.find((artifact) => artifact.kind === 'image');
    const traceArtifact = run.retainedArtifacts.find((artifact) => artifact.kind === 'trace');
    const stacktraceArtifact = run.retainedArtifacts.find((artifact) => artifact.name === 'stacktrace.txt');
    const extraArtifacts = run.retainedArtifacts.filter((artifact) => (
      artifact !== screenshotArtifact
      && artifact !== traceArtifact
      && artifact !== stacktraceArtifact
    ));
    const stacktraceText = normalizeReportText(${serializeForScript(stacktraceText)});
    const failureSummarySection = buildFailureSummarySection(run, stacktraceText);
    const verificationSummarySection = latestVerificationSummary
      ? (
        '<section class="panel">' +
          '<h2 class="section-title">Latest Verification Set</h2>' +
          '<p class="section-note">' +
            escapeHtml(
              latestVerificationSummary.aggregate
                ? ('Verification group ' + (latestVerificationSummary.verificationRunGroup?.label || run.caseId)
                  + ' collected ' + latestVerificationSummary.aggregate.totalRuns
                  + ' run(s) after an initial threshold miss. The suite passes only when each metric stays within its acceptable median and also passes a majority of runs.')
                : ('Verification group ' + (latestVerificationSummary.verificationRunGroup?.label || run.caseId)
                  + ' completed in a single run without needing aggregate threshold retries.')
            ) +
          '</p>' +
          (
            latestVerificationSummary.aggregate
              ? (
                '<table class="table">' +
                  '<thead><tr><th>Metric</th><th>Median</th><th>Mean</th><th>Pass Count</th><th>Ceiling</th><th>Verdict</th></tr></thead>' +
                  '<tbody>' +
                    latestVerificationSummary.aggregate.metrics.map((metric) => (
                      '<tr>' +
                        '<td><strong>' + escapeHtml(metric.description || metric.key) + '</strong><div class="muted small">' + escapeHtml(metric.key) + '</div></td>' +
                        '<td>' + escapeHtml(metric.units === 'bytes' ? formatMb(metric.medianActual) : formatMs(metric.medianActual)) + '</td>' +
                        '<td>' + escapeHtml(metric.units === 'bytes' ? formatMb(metric.averageActual) : formatMs(metric.averageActual)) + '</td>' +
                        '<td>' + escapeHtml(metric.passCount + '/' + metric.totalRuns) + '</td>' +
                        '<td>' + escapeHtml(metric.allowedText || (metric.units === 'bytes' ? formatMb(metric.allowedMaximum) : formatMs(metric.allowedMaximum))) + '</td>' +
                        '<td><span class="pill ' + statusClass(metric.passed ? 'passed' : 'failed') + '">' + escapeHtml(metric.passed ? 'PASS' : 'FAIL') + '</span></td>' +
                      '</tr>'
                    )).join('') +
                  '</tbody>' +
                '</table>'
              )
              : '<div class="run-links"><span class="pill ' + statusClass(run.status) + '">' + escapeHtml(run.status.toUpperCase()) + '</span></div>'
          ) +
        '</section>'
      )
      : '';
    const timingBudgetSection = benchmarkResults.length
      ? (
        '<section class="panel">' +
          '<h2 class="section-title">Performance Contracts</h2>' +
          '<p class="section-note">Timing targets remain separate from bounded grace and hard ceilings. Grace usage passes the guard without counting as target attainment.</p>' +
          '<table class="table">' +
            '<thead><tr><th>Metric</th><th>Actual</th><th>Target</th><th>Grace</th><th>Hard Ceiling</th><th>Classification</th></tr></thead>' +
            '<tbody>' + benchmarkResults.map((result) => (
              '<tr>' +
                '<td><strong>' + escapeHtml(result.description || result.key) + '</strong><div class="muted small">' + escapeHtml(result.key) + '</div></td>' +
                '<td>' + escapeHtml(result.actualText || (result.units === 'bytes' ? formatMb(result.actual) : formatMs(result.actual))) + '</td>' +
                '<td>' + escapeHtml(Number.isFinite(result.targetMaximum) ? formatMs(result.targetMaximum) : 'n/a') + '</td>' +
                '<td>' + escapeHtml(Number.isFinite(result.graceMs) ? formatMs(result.graceMs) : 'n/a') + '</td>' +
                '<td>' + escapeHtml(result.allowedText || (result.units === 'bytes' ? formatMb(result.allowedMaximum) : formatMs(result.allowedMaximum))) + '</td>' +
                '<td><span class="pill ' + statusClass(result.passed ? 'passed' : 'failed') + '">' + escapeHtml(String(result.performanceStatus || (result.passed ? 'target-met' : 'hard-fail')).toUpperCase()) + '</span></td>' +
              '</tr>'
            )).join('') + '</tbody>' +
          '</table>' +
        '</section>'
      )
      : '';
    const stacktraceSection = stacktraceText
      ? (
        '<details class="panel collapsible-panel">' +
          '<summary>' +
            '<div class="collapsible-title-wrap">' +
              '<h2 class="section-title">Failure Stacktrace</h2>' +
              '<p class="section-note">Captured Playwright failure stacktrace for this run, reformatted for easier scanning and kept downloadable in the retained artifact bundle.</p>' +
            '</div>' +
            '<span class="collapsible-chevron" aria-hidden="true">&#8250;</span>' +
          '</summary>' +
          buildFormattedStacktrace(stacktraceText) +
        '</details>'
      )
      : '';
    const failureArtifactsSection = run.retainedArtifacts.length
      ? (
        '<section class="panel">' +
          '<h2 class="section-title">Failure Artifacts</h2>' +
          '<p class="section-note">Failed runs keep their captured screenshot and Playwright trace inside the retained report bundle for later debugging.</p>' +
          (screenshotArtifact
            ? '<div class="stack"><a href="./' + escapeHtml(screenshotArtifact.relativePath) + '"><img src="./' + escapeHtml(screenshotArtifact.relativePath) + '" alt="Failure screenshot preview" style="width:100%;height:auto;border-radius:16px;border:1px solid rgba(31,31,31,0.12);"></a></div>'
            : '<p class="section-note">No retained screenshot was available for this run.</p>') +
          '<div class="run-links">' +
            (traceArtifact ? '<a href="./' + escapeHtml(traceArtifact.relativePath) + '">Download Playwright Trace</a>' : '') +
            (stacktraceArtifact ? '<a href="./' + escapeHtml(stacktraceArtifact.relativePath) + '">Download Stacktrace</a>' : '') +
            extraArtifacts.map((artifact) => '<a href="./' + escapeHtml(artifact.relativePath) + '">' + escapeHtml(artifact.name) + '</a>').join('') +
          '</div>' +
        '</section>'
      )
      : '';
    app.innerHTML =
      buildCards(cards) +
      failureSummarySection +
      verificationSummarySection +
      timingBudgetSection +
      currentRunChartsSection +
      retainedTrendSection +
      retainedTimingSection +
      '<section class="panel">' +
        '<h2 class="section-title">Run Environment</h2>' +
        '<p class="section-note">' + escapeHtml(environmentSummary) + '</p>' +
        '<div class="run-links"><a href="../index.html">Suite overview</a><a href="../../index.html">All performance suites</a><a href="./metrics.json">Raw metrics JSON</a></div>' +
      '</section>' +
      stacktraceSection +
      '<section class="panel">' +
        '<h2 class="section-title">Checkpoint Breakdown</h2>' +
        '<table class="table">' +
          '<thead><tr><th>Checkpoint</th><th>Time</th><th>Memory</th><th>Relative Shape</th><th>Extra</th></tr></thead>' +
          '<tbody>' + buildCheckpointRows(run.checkpoints) + '</tbody>' +
        '</table>' +
      '</section>' +
      '<section class="panel">' +
        '<div class="step-header">' +
          '<div class="step-header-label">Playwright Test Run</div>' +
          '<div class="step-header-title">' + escapeHtml(runOwnedTitle) + '</div>' +
          '<div class="section-note">Captured benchmark steps stay grouped under the owning test name for quick console-to-report scanning.</div>' +
        '</div>' +
        buildStepTimeline(run.stepEvents, runOwnedTitle) +
      '</section>' +
      '<section class="panel">' +
        '<h2 class="section-title">Step Transcript</h2>' +
        '<pre class="step-transcript"><code>' + escapeHtml(run.stepTranscript.join('\\n')) + '</code></pre>' +
      '</section>' +
      failureArtifactsSection;
    if (!isIdleMemoryReport) {
      renderSeriesSelector('combined-timing-history', {
        title: 'Combined Timed Action History',
        note: 'Toggle individual actions plus the median overlay to compare how each timed checkpoint moves across the retained 30-day window.',
        chartTitle: 'Timed Actions Across Retained Runs',
        chartNote: 'Runs are plotted oldest to latest. The overlay here is the median timed checkpoint value for each retained run.',
        series: combinedTimingSeries,
        formatter: formatMs,
        totalPointCount: historicalTiming.runCount,
      });
    }
    attachChartTooltips(app);
    attachChartHoverRegions(app);
    attachExpandableCharts(app);
    scrollChartContainersToLatest(app);
    `,
    [
      { label: 'Suite Overview', href: `${suitePathFromRun}/index.html` },
      { label: 'Latest Suite Run', href: `${suitePathFromRun}/latest.html` },
      { label: 'All Performance Suites', href: '../../index.html' },
    ],
  );
}

function renderSuiteOverview(manifest, latestEntry) {
  const latestVerificationSummary = buildLatestVerificationSummary(manifest.runs);
  const data = {
    manifest,
    latestEntry,
    latestVerificationSummary,
  };
  return renderShell(
    `${manifest.title} History`,
    `${manifest.title} History`,
    manifest.intro,
    data,
    `
    const history = data.manifest.runs.slice().reverse();
    const latestEntry = data.latestEntry;
    const latestVerificationSummary = data.latestVerificationSummary;
    const cards = [
      { label: 'Retained Runs', value: String(data.manifest.runs.length), note: 'Retained automatically for the latest 30 days' },
      { label: 'Latest Status', value: latestEntry ? latestEntry.status.toUpperCase() : 'NONE', note: latestEntry ? latestEntry.startedAt : 'No runs yet' },
      { label: 'Latest Duration', value: latestEntry ? formatMs(latestEntry.durationMs) : 'n/a', note: latestEntry ? latestEntry.environment.projectName : '' },
      { label: 'Latest Peak Memory', value: latestEntry ? formatMb(latestEntry.peakMemoryBytes) : 'n/a', note: latestEntry ? latestEntry.checkpointCount + ' checkpoints' : '' },
    ];
    if (latestVerificationSummary?.aggregate) {
      cards.push({
        label: 'Latest Verification Verdict',
        value: latestVerificationSummary.aggregate.passed ? 'PASS' : 'FAIL',
        note: latestVerificationSummary.aggregate.totalRuns + ' run aggregate',
      });
    }
    const durationTrend = history.map((entry, index) => ({ label: String(index + 1), value: entry.durationMs, runId: entry.runId, startedAt: entry.startedAt }));
    const memoryTrend = history.map((entry, index) => ({ label: String(index + 1), value: entry.peakMemoryBytes, runId: entry.runId, startedAt: entry.startedAt }));
    const latestVerificationSection = latestVerificationSummary
      ? (
        '<section class="panel">' +
          '<h2 class="section-title">Latest Verification Set</h2>' +
          '<p class="section-note">' +
            escapeHtml(
              latestVerificationSummary.aggregate
                ? ('Latest threshold verification used ' + latestVerificationSummary.aggregate.totalRuns
                  + ' run(s). Metrics pass only when their median stays within bounds and at least '
                  + latestVerificationSummary.aggregate.requiredPassCount + ' of those runs stay green.')
                : 'The latest verification set completed in one run and did not need aggregate threshold retries.'
            ) +
          '</p>' +
          (
            latestVerificationSummary.aggregate
              ? (
                '<table class="table">' +
                  '<thead><tr><th>Metric</th><th>Median</th><th>Pass Count</th><th>Ceiling</th><th>Verdict</th></tr></thead>' +
                  '<tbody>' +
                    latestVerificationSummary.aggregate.metrics.map((metric) => (
                      '<tr>' +
                        '<td><strong>' + escapeHtml(metric.description || metric.key) + '</strong><div class="muted small">' + escapeHtml(metric.key) + '</div></td>' +
                        '<td>' + escapeHtml(metric.units === 'bytes' ? formatMb(metric.medianActual) : formatMs(metric.medianActual)) + '</td>' +
                        '<td>' + escapeHtml(metric.passCount + '/' + metric.totalRuns) + '</td>' +
                        '<td>' + escapeHtml(metric.allowedText || (metric.units === 'bytes' ? formatMb(metric.allowedMaximum) : formatMs(metric.allowedMaximum))) + '</td>' +
                        '<td><span class="pill ' + statusClass(metric.passed ? 'passed' : 'failed') + '">' + escapeHtml(metric.passed ? 'PASS' : 'FAIL') + '</span></td>' +
                      '</tr>'
                    )).join('') +
                  '</tbody>' +
                '</table>'
              )
              : '<div class="run-links"><a href="' + escapeHtml(latestEntry ? latestEntry.reportPath : 'latest.html') + '">Open latest run</a></div>'
          ) +
        '</section>'
      )
      : '';
    const rows = data.manifest.runs.map((entry) => (
      '<tr>' +
        '<td><a href="' + escapeHtml(entry.reportPath) + '">' + escapeHtml(entry.runId) + '</a></td>' +
        '<td><span class="pill ' + statusClass(entry.status) + '">' + escapeHtml(entry.status) + '</span></td>' +
        '<td>' + escapeHtml(formatMs(entry.durationMs)) + '</td>' +
        '<td>' + escapeHtml(formatMb(entry.peakMemoryBytes)) + '</td>' +
        '<td>' + escapeHtml(entry.startedAt) + '</td>' +
      '</tr>'
    )).join('');
    app.innerHTML =
      buildCards(cards) +
      latestVerificationSection +
      '<section class="grid two-up">' +
        buildLineChart('Run Duration Trend', durationTrend, formatMs, '#15616d') +
        buildLineChart('Peak Memory Trend', memoryTrend, formatMb, '#ff7d00') +
      '</section>' +
      '<section class="panel">' +
        '<h2 class="section-title">Recent Runs</h2>' +
        '<table class="table">' +
          '<thead><tr><th>Run</th><th>Status</th><th>Duration</th><th>Peak Memory</th><th>Started</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</section>';
    attachChartTooltips(app);
    attachChartHoverRegions(app);
    attachExpandableCharts(app);
    scrollChartContainersToLatest(app);
    `,
    [
      { label: 'Latest Run', href: 'latest.html' },
      { label: 'All Performance Suites', href: '../index.html' },
    ],
  );
}

function renderRootOverview(suites) {
  const data = { suites };
  return renderShell(
    'Playwright Performance Reports',
    'Playwright Performance Reports',
    'Successful and failed performance runs both publish chart-first HTML reports with timing and memory history, then open the latest served report automatically for local review.',
    data,
    `
    const cards = data.suites.map((suite) => ({
      label: suite.title,
      value: suite.latestRun ? suite.latestRun.status.toUpperCase() : 'NO RUNS',
      note: suite.latestRun ? (formatMs(suite.latestRun.durationMs) + ' | ' + formatMb(suite.latestRun.peakMemoryBytes)) : suite.reportId,
    }));
    const rows = data.suites.map((suite) => (
      '<tr>' +
        '<td><a href="' + escapeHtml(suite.reportId + '/latest.html') + '">' + escapeHtml(suite.title) + '</a></td>' +
        '<td>' + escapeHtml(suite.caseId) + '</td>' +
        '<td>' + escapeHtml(suite.latestRun ? suite.latestRun.runId : 'n/a') + '</td>' +
        '<td>' + escapeHtml(suite.latestRun ? formatMs(suite.latestRun.durationMs) : 'n/a') + '</td>' +
        '<td>' + escapeHtml(suite.latestRun ? formatMb(suite.latestRun.peakMemoryBytes) : 'n/a') + '</td>' +
      '</tr>'
    )).join('');
    app.innerHTML =
      buildCards(cards) +
      '<section class="panel">' +
        '<h2 class="section-title">Available Benchmark Suites</h2>' +
        '<table class="table">' +
          '<thead><tr><th>Suite</th><th>Case</th><th>Latest Run</th><th>Duration</th><th>Peak Memory</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</section>';
    attachChartTooltips(app);
    attachChartHoverRegions(app);
    attachExpandableCharts(app);
    scrollChartContainersToLatest(app);
    `,
    suites.map((suite) => ({
      label: `${suite.title} Latest`,
      href: `${suite.reportId}/latest.html`,
    })),
  );
}

function regenerateHistoricalReports(historyRoot = HISTORY_ROOT) {
  if (!fs.existsSync(historyRoot)) {
    return { suites: [] };
  }

  const globallyUpdatedRunMetrics = pruneGlobalRetainedTraceArtifacts(historyRoot, TRACE_RETENTION_RUNS);
  const suiteDirs = fs.readdirSync(historyRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const rootSuites = [];

  for (const reportId of suiteDirs) {
    const suiteDir = path.join(historyRoot, reportId);
    const manifestPath = path.join(suiteDir, 'index.json');
    const manifest = readJson(manifestPath, null);
    if (!manifest || !Array.isArray(manifest.runs)) {
      continue;
    }

    for (const entry of manifest.runs) {
      if (!entry?.runId || !entry?.metricsPath || !entry?.reportPath) {
        continue;
      }
      const metricsPath = path.join(suiteDir, entry.metricsPath);
      const runMetrics = globallyUpdatedRunMetrics.get(buildRunMetricsCacheKey(suiteDir, entry.runId))
        || (fs.existsSync(metricsPath) ? readJson(metricsPath, null) : null);
      if (!runMetrics) {
        continue;
      }
      entry.benchmarkValidation = summarizeBenchmarkValidation(
        runMetrics.rawMetrics?.benchmarkValidation,
        processPassedFromPlaywrightStatus(runMetrics.status),
      );
      entry.verificationRunGroup = summarizeVerificationRunGroup(runMetrics.verificationRunGroup);
      const reportFilePath = path.join(suiteDir, entry.reportPath);
      writeText(reportFilePath, renderRunReport(runMetrics, manifest, '..'));
    }

    const latestEntry = manifest.runs[0] || null;
    writeText(path.join(suiteDir, 'index.html'), renderSuiteOverview(manifest, latestEntry));
    if (latestEntry) {
      writeText(
        path.join(suiteDir, 'latest.html'),
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${escapeHtml(latestEntry.reportPath)}"><title>Latest ${escapeHtml(manifest.title)} Report</title></head><body><p><a href="${escapeHtml(latestEntry.reportPath)}">Open the latest run report</a>.</p></body></html>`,
      );
      writeText(path.join(suiteDir, 'latest.json'), JSON.stringify({
        latestRunId: latestEntry.runId,
        reportPath: latestEntry.reportPath,
        reportAbsolutePath: path.join(suiteDir, latestEntry.reportPath),
        generatedAt: manifest.generatedAt || new Date().toISOString(),
      }, null, 2));
    }

    rootSuites.push({
      reportId,
      title: manifest.title,
      caseId: manifest.caseId,
      latestRun: latestEntry,
    });
  }

  writeText(path.join(historyRoot, 'index.html'), renderRootOverview(rootSuites));
  writeText(path.join(historyRoot, 'index.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    suites: rootSuites,
  }, null, 2));

  return { suites: rootSuites };
}

function shouldOpenLatestReport(options = {}) {
  const ci = String(options.ci ?? process.env.CI ?? '').trim().toLowerCase();
  const reportSetting = String(options.openPerformanceReport ?? process.env.PLAYWRIGHT_OPEN_PERFORMANCE_REPORT ?? '').trim();
  const headlessEnv = String(options.playwrightHeadless ?? process.env.PLAYWRIGHT_HEADLESS ?? '').trim().toLowerCase();
  const headlessRun = typeof options.resolvedHeadless === 'boolean'
    ? options.resolvedHeadless
    : headlessEnv === '1' || headlessEnv === 'true';
  const stdoutIsTTY = typeof options.stdoutIsTTY === 'boolean'
    ? options.stdoutIsTTY
    : Boolean(process.stdout && process.stdout.isTTY);

  if (ci === 'true' || reportSetting === '0' || headlessRun) {
    return false;
  }
  if (reportSetting === '1') {
    return true;
  }

  return stdoutIsTTY;
}

function openLatestReport(relativeTarget, options = {}) {
  if (!shouldOpenLatestReport(options)) {
    return;
  }

  try {
    const historyRoot = typeof options.historyRoot === 'string' && options.historyRoot.trim()
      ? path.resolve(options.historyRoot)
      : HISTORY_ROOT;
    const child = spawn(process.execPath, [OPEN_REPORT_SCRIPT, historyRoot, relativeTarget], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (_error) {
    // Do not fail the test run if report serving could not be launched.
  }
}

function flushPerformanceHistory(testRecords, options = {}) {
  const historyRoot = options.historyRoot || HISTORY_ROOT;
  ensureDir(historyRoot);
  const rootSuites = [];
  const suiteContexts = [];
  const groupedRecords = new Map();
  for (const record of testRecords) {
    const reportId = record.metricsPayload.reportId;
    const group = groupedRecords.get(reportId) || [];
    group.push(record);
    groupedRecords.set(reportId, group);
  }

  let latestRelativeTarget = 'index.html';

  for (const [reportId, records] of groupedRecords.entries()) {
    const suiteDir = path.join(historyRoot, reportId);
    const runsDir = path.join(suiteDir, 'runs');
    const manifestPath = path.join(suiteDir, 'index.json');
    const existingManifest = readJson(manifestPath, {
      reportId,
      title: records[0].metricsPayload.title,
      intro: records[0].metricsPayload.intro,
      caseId: records[0].metricsPayload.caseId,
      retentionDays: HISTORY_RETENTION_DAYS,
      generatedAt: null,
      latestRunId: null,
      runs: [],
    });

    ensureDir(runsDir);

    for (const record of records) {
      const runMetrics = buildRunMetrics(record, record.metricsPayload);
      const runDir = path.join(runsDir, runMetrics.runId);
      ensureDir(runDir);
      runMetrics.retainedArtifacts = materializeRetainedArtifacts(runMetrics.retainedArtifacts, runDir);

      const metricsFilePath = path.join(runDir, 'metrics.json');
      const reportFilePath = path.join(runDir, 'report.html');
      writeText(metricsFilePath, JSON.stringify(runMetrics, null, 2));

      const provisionalManifest = {
        ...existingManifest,
        title: runMetrics.reportTitle,
        intro: runMetrics.intro,
        caseId: runMetrics.caseId,
        runs: trimRunsToRetentionWindow(
          [
            buildManifestEntry(runMetrics, suiteDir, reportFilePath, metricsFilePath),
            ...existingManifest.runs.filter((entry) => entry.runId !== runMetrics.runId),
          ],
          HISTORY_RETENTION_DAYS,
          runMetrics.finishedAt,
        ),
      };
      writeText(reportFilePath, renderRunReport(runMetrics, provisionalManifest, '..'));
      existingManifest.runs = provisionalManifest.runs;
      existingManifest.latestRunId = runMetrics.runId;
      existingManifest.generatedAt = new Date().toISOString();
      existingManifest.title = runMetrics.reportTitle;
      existingManifest.intro = runMetrics.intro;
      existingManifest.caseId = runMetrics.caseId;
    }

    const retainedRunIds = new Set(existingManifest.runs.map((entry) => entry.runId));
    if (fs.existsSync(runsDir)) {
      for (const childName of fs.readdirSync(runsDir)) {
        const childPath = path.join(runsDir, childName);
        if (!retainedRunIds.has(childName)) {
          fs.rmSync(childPath, { recursive: true, force: true });
        }
      }
    }

    existingManifest.runs = trimRunsToRetentionWindow(
      existingManifest.runs,
      HISTORY_RETENTION_DAYS,
      existingManifest.generatedAt || new Date().toISOString(),
    );
    existingManifest.retentionDays = HISTORY_RETENTION_DAYS;
    existingManifest.traceRetentionRuns = TRACE_RETENTION_RUNS;
    delete existingManifest.retentionLimit;
    writeText(manifestPath, JSON.stringify(existingManifest, null, 2));
    suiteContexts.push({
      reportId,
      suiteDir,
      manifest: existingManifest,
    });
  }

  const globallyUpdatedRunMetrics = pruneGlobalRetainedTraceArtifacts(historyRoot, TRACE_RETENTION_RUNS);

  for (const context of suiteContexts) {
    const { reportId, suiteDir, manifest } = context;
    const latestEntry = manifest.runs[0] || null;
    for (const entry of manifest.runs) {
      if (!entry?.runId || !entry?.reportPath) {
        continue;
      }
      const metricsPath = entry.metricsPath ? path.join(suiteDir, entry.metricsPath) : null;
      const runMetrics = globallyUpdatedRunMetrics.get(buildRunMetricsCacheKey(suiteDir, entry.runId))
        || (metricsPath && fs.existsSync(metricsPath) ? readJson(metricsPath, null) : null);
      if (!runMetrics) {
        continue;
      }
      writeText(path.join(suiteDir, entry.reportPath), renderRunReport(runMetrics, manifest, '..'));
    }
    writeText(path.join(suiteDir, 'index.html'), renderSuiteOverview(manifest, latestEntry));
    if (latestEntry) {
      latestRelativeTarget = `${reportId}/latest.html`;
      writeText(
        path.join(suiteDir, 'latest.html'),
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${escapeHtml(latestEntry.reportPath)}"><title>Latest ${escapeHtml(manifest.title)} Report</title></head><body><p><a href="${escapeHtml(latestEntry.reportPath)}">Open the latest run report</a>.</p></body></html>`,
      );
      writeText(path.join(suiteDir, 'latest.json'), JSON.stringify({
        latestRunId: latestEntry.runId,
        reportPath: latestEntry.reportPath,
        reportAbsolutePath: path.join(suiteDir, latestEntry.reportPath),
        generatedAt: manifest.generatedAt,
      }, null, 2));
    }

    rootSuites.push({
      reportId,
      title: manifest.title,
      caseId: manifest.caseId,
      latestRun: latestEntry,
    });
  }

  writeText(path.join(historyRoot, 'index.html'), renderRootOverview(rootSuites));
  writeText(path.join(historyRoot, 'index.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    suites: rootSuites,
  }, null, 2));

  if (rootSuites.length > 1) {
    latestRelativeTarget = 'index.html';
  }

  return latestRelativeTarget;
}

class PlaywrightPerformanceReporter {
  constructor(options = {}) {
    const configuredHistoryRoot = process.env.PLAYWRIGHT_PERFORMANCE_HISTORY_ROOT;
    this.testRecords = [];
    this.projectMap = new Map();
    this.completedTestCount = 0;
    this.expectedTestCount = null;
    this.hasFlushedHistory = false;
    this.historyRoot = options.historyRoot
      || (configuredHistoryRoot?.trim() ? path.resolve(configuredHistoryRoot) : HISTORY_ROOT);
    this.logFn = options.logFn || console.log;
    this.openLatestReportFn = options.openLatestReportFn || openLatestReport;
    this.resolvedHeadless = true;
  }

  onBegin(config, suite) {
    const projectEnvironments = [];
    for (const project of config.projects || []) {
      const environment = buildProjectEnvironment(config.use, project);
      this.projectMap.set(project.name, environment);
      projectEnvironments.push(environment);
    }
    this.resolvedHeadless = projectEnvironments.length > 0
      ? projectEnvironments.every((environment) => environment.headless)
      : Boolean(config.use?.headless);
    if (suite && typeof suite.allTests === 'function') {
      this.expectedTestCount = suite.allTests().length;
    }
  }

  flushHistoryIfReady(force = false) {
    if (this.hasFlushedHistory || !this.testRecords.length) {
      return;
    }
    if (!force && (this.expectedTestCount === null || this.completedTestCount < this.expectedTestCount)) {
      return;
    }
    const latestRelativeTarget = flushPerformanceHistory(this.testRecords, {
      historyRoot: this.historyRoot,
    });
    this.logFn(PLAYWRIGHT_PERFORMANCE_REPORTER_FLUSH_MARKER);
    this.openLatestReportFn(latestRelativeTarget, {
      resolvedHeadless: this.resolvedHeadless,
      historyRoot: this.historyRoot,
    });
    this.hasFlushedHistory = true;
  }

  onTestEnd(test, result) {
    this.completedTestCount += 1;
    const attachment = result.attachments.find((entry) => entry.name === 'performance-report-metrics');
    if (attachment) {
      const metricsPayload = extractAttachmentJson(attachment);
      if (metricsPayload?.reportId && metricsPayload?.caseId) {
        const startedAt = result.startTime instanceof Date
          ? result.startTime.toISOString()
          : new Date().toISOString();
        const finishedAt = new Date(new Date(startedAt).getTime() + Number(result.duration || 0)).toISOString();
        const runId = formatRunId(startedAt);
        const projectName = resolveTestProjectName(test, result);
        this.testRecords.push({
          runId,
          title: test.title,
          status: result.status,
          startedAt,
          finishedAt,
          durationMs: Number(result.duration || 0),
          environment: this.projectMap.get(projectName) || {
            projectName,
            baseURL: '',
            browserName: '',
            channel: '',
            headless: false,
          },
          metricsPayload,
          verificationRunGroup: summarizeVerificationRunGroup({
            id: process.env.PLAYWRIGHT_PERF_VERIFICATION_GROUP_ID,
            label: process.env.PLAYWRIGHT_PERF_VERIFICATION_GROUP_LABEL,
            policy: process.env.PLAYWRIGHT_PERF_VERIFICATION_POLICY,
            maxAttempts: process.env.PLAYWRIGHT_PERF_VERIFICATION_MAX_ATTEMPTS,
            attempt: process.env.PLAYWRIGHT_PERF_VERIFICATION_ATTEMPT,
          }),
          retainedArtifacts: buildRetainedArtifactEntries(result.attachments),
        });
      }
    }

    this.flushHistoryIfReady();
  }

  async onEnd() {
    this.flushHistoryIfReady(true);
  }
}

module.exports = PlaywrightPerformanceReporter;
module.exports._private = {
  PLAYWRIGHT_PERFORMANCE_REPORTER_FLUSH_MARKER,
  buildLatestVerificationSummary,
  buildRetainedArtifactEntries,
  buildVerificationMetricSummary,
  buildHistoricalTimingData,
  buildManifestEntry,
  buildProjectEnvironment,
  flushPerformanceHistory,
  median,
  materializeRetainedArtifacts,
  pruneGlobalRetainedTraceArtifacts,
  pruneRetainedTraceArtifacts,
  pruneTraceArtifactsForRun,
  regenerateHistoricalReports,
  renderRunReport,
  renderRootOverview,
  renderShell,
  renderSuiteOverview,
  sanitizeArtifactFileName,
  shouldOpenLatestReport,
  summarizeBenchmarkValidation,
  trimRunsToRetentionWindow,
  toSuiteRelativePath,
};
