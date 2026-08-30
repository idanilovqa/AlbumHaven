const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const EXPECTED_TARGET_COUNT = 19;
const DEFAULT_PERFORMANCE_CONTRACT = path.resolve(
  __dirname, '..', '..', 'tests', 'ci', 'performance-targets.json',
);
const FINGERPRINT_FIELDS = [
  'runnerImage', 'chromeVersion', 'fixtureRelease',
  'fixtureSchemaVersion', 'postgresMajor', 'measurementContract',
];
const ATTEMPT_STATUSES = new Set(['passed', 'failed', 'timedOut', 'interrupted']);
const EXCLUSION_REASONS = new Set([
  'no-runner', 'premeasurement-setup-failure', 'missing-measurement',
  'measurement-contract-changed',
]);
const OFFLINE_AUTHENTICITY_NOTE = 'offline authenticity depends on authenticated artifact retrieval; '
  + 'offline JSON validation does not authenticate artifact retrieval';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateExpectedRepository(value) {
  const repository = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('expectedRepository must be an externally supplied owner/repo identity');
  }
  return repository;
}

function validateContract(contract) {
  const checkedIn = readJson(DEFAULT_PERFORMANCE_CONTRACT);
  if (!isDeepStrictEqual(contract, checkedIn)
    || contract?.schemaVersion !== 1
    || contract.targets?.length !== EXPECTED_TARGET_COUNT) {
    throw new Error('calibration requires the exact checked-in 19-target performance registry schema and inventory');
  }
  return contract.targets.map((target) => target.name);
}

function validateFingerprint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('malformed environment fingerprint');
  }
  const result = {};
  for (const field of FINGERPRINT_FIELDS) {
    const candidate = value[field];
    if (field === 'fixtureSchemaVersion' || field === 'postgresMajor') {
      if (!Number.isSafeInteger(candidate) || candidate <= 0) {
        throw new Error(`malformed environment fingerprint field ${field}`);
      }
    } else if (typeof candidate !== 'string' || !/^[A-Za-z0-9._+-]{1,100}$/.test(candidate)) {
      throw new Error(`malformed environment fingerprint field ${field}`);
    }
    result[field] = candidate;
  }
  return result;
}

function fingerprintKey(value) {
  return JSON.stringify(FINGERPRINT_FIELDS.map((field) => value[field]));
}

function untrusted(reason) {
  throw new Error(`untrusted calibration evidence (${reason}); ${OFFLINE_AUTHENTICITY_NOTE}`);
}

function validateGithubProvenance(evidence, target, sequence, expectedRepository) {
  if (evidence.workflow !== 'PR Gates' || evidence.event !== 'pull_request') {
    untrusted('expected a same-repository PR Gates pull_request artifact');
  }
  const runId = String(evidence.runId || '');
  const runAttempt = String(evidence.runAttempt || '');
  const commitSha = String(evidence.commitSha || '');
  const repository = String(evidence.repository || '');
  const childId = `performance:${target}`;
  const artifactName = `performance-result-${target}-${runAttempt}`;
  if (repository !== expectedRepository || !/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt)
    || !/^[a-f0-9]{40}$/.test(commitSha) || evidence.target !== target
    || evidence.sequence !== sequence || evidence.childId !== childId
    || evidence.artifactName !== artifactName) {
    untrusted('run, repository, commit, target child, or artifact identity mismatch');
  }
  const verification = evidence.verificationEvidence;
  if (!verification || verification.schemaVersion !== 1
    || verification.repository !== repository || verification.commitSha !== commitSha
    || String(verification.runId) !== runId || String(verification.runAttempt) !== runAttempt
    || verification.event !== 'pull_request'
    || !verification.children?.some((child) => child?.id === childId)
    || !verification.performance?.some((entry) => entry?.target === target)) {
    untrusted('verification-evidence identity mismatch');
  }
  const inventory = evidence.authenticatedInventory;
  if (!inventory || inventory.schemaVersion !== 1
    || !inventory.structuredReports?.some((artifact) => (
      artifact?.name === artifactName && artifact.retentionDays === 14
    ))) {
    untrusted('authenticated artifact inventory identity mismatch');
  }
  return {
    source: evidence.source,
    sourceId: `${runId}:${runAttempt}`,
    runId,
    runAttempt,
    commitSha,
    authenticity: 'authenticated-github-actions-artifact',
  };
}

function validateLocalProvenance(evidence, target, sequence, expectedRepository) {
  const repository = String(evidence.repository || '');
  const reportId = String(evidence.reportId || '');
  const commitSha = String(evidence.commitSha || '');
  if (repository !== expectedRepository || evidence.target !== target || evidence.sequence !== sequence
    || !/^[A-Za-z0-9._-]{1,120}$/.test(reportId)
    || !/^[a-f0-9]{64}$/.test(String(evidence.artifactSha256 || ''))
    || !/^[a-f0-9]{40}$/.test(commitSha)) {
    untrusted('retained local report identity or digest mismatch');
  }
  return {
    source: evidence.source,
    sourceId: reportId,
    reportId,
    commitSha,
    artifactSha256: evidence.artifactSha256,
    authenticity: 'locally-hashed-retained-report',
  };
}

function validateProvenance(evidence, target, sequence, expectedRepository) {
  if (!evidence || evidence.schemaVersion !== 1) untrusted('malformed evidence envelope');
  let provenance;
  if (evidence.source === 'github-actions-artifact') {
    provenance = validateGithubProvenance(evidence, target, sequence, expectedRepository);
  } else if (evidence.source === 'retained-local-report') {
    provenance = validateLocalProvenance(evidence, target, sequence, expectedRepository);
  } else {
    untrusted('unknown evidence source');
  }
  if (!Array.isArray(evidence.resourceNotes) || evidence.resourceNotes.length === 0
    || !evidence.resourceNotes.every((note) => typeof note === 'string' && note.trim())) {
    untrusted('missing resource notes');
  }
  return { ...provenance, resourceNotes: evidence.resourceNotes.map((note) => note.trim()) };
}

function validateAttempts(attempts, target) {
  if (!Array.isArray(attempts) || attempts.length < 1 || attempts.length > 5) {
    throw new Error(`malformed performance sample ${target}`);
  }
  let units = null;
  return attempts.map((attempt, index) => {
    if (!attempt || attempt.attempt !== index + 1 || !ATTEMPT_STATUSES.has(attempt.status)
      || typeof attempt.classification !== 'string' || !attempt.classification.trim()
      || !Number.isFinite(attempt.actualValue) || attempt.actualValue < 0
      || !['ms', 'bytes'].includes(attempt.units)
      || !Number.isFinite(Date.parse(attempt.startedAt))) {
      throw new Error(`malformed performance sample ${target}`);
    }
    if (units !== null && units !== attempt.units) {
      throw new Error(`malformed performance sample units ${target}`);
    }
    units = attempt.units;
    return {
      attempt: attempt.attempt,
      status: attempt.status,
      classification: attempt.classification.trim(),
      actualValue: attempt.actualValue,
      units: attempt.units,
      startedAt: attempt.startedAt,
    };
  });
}

function validateSeries(result) {
  if (!Array.isArray(result.series) || result.series.length === 0) {
    throw new Error(`malformed performance result series ${result.target}`);
  }
  const ids = new Set();
  const series = result.series.map((entry) => {
    if (!entry || !/^[a-f0-9]{16}$/.test(String(entry.id || ''))
      || typeof entry.title !== 'string' || !entry.title.trim() || ids.has(entry.id)) {
      throw new Error(`malformed performance result series ${result.target}`);
    }
    ids.add(entry.id);
    const attempts = validateAttempts(entry.attempts, result.target);
    return { id: entry.id, title: entry.title.trim(), units: attempts[0].units, attempts };
  });
  const topAttempts = validateAttempts(result.attempts, result.target);
  if (!isDeepStrictEqual(topAttempts, series[0].attempts)) {
    throw new Error(`stable complete series inventory projection drift for ${result.target}`);
  }
  return series;
}

function validateSample(sample, targetNames, expectedRepository) {
  if (!sample || !Number.isSafeInteger(sample.sequence) || sample.sequence < 1) {
    throw new Error('malformed calibration sample sequence');
  }
  const result = sample.result;
  if (!result || result.schemaVersion !== 1 || !targetNames.has(result.target)) {
    throw new Error('performance target inventory drift');
  }
  if (!['success', 'failure'].includes(result.conclusion) || result.blocking !== false) {
    throw new Error(`malformed performance sample ${result.target}`);
  }
  const provenance = validateProvenance(sample.evidence, result.target, sample.sequence, expectedRepository);
  const evidenceFingerprint = validateFingerprint(sample.evidence.fingerprint);
  const resultFingerprint = validateFingerprint(result.fingerprint);
  if (fingerprintKey(evidenceFingerprint) !== fingerprintKey(resultFingerprint)) {
    throw new Error('evidence and result environment fingerprint mismatch');
  }
  const series = validateSeries(result);
  const computedConclusion = series.every((item) => item.attempts.every((attempt) => attempt.status === 'passed'))
    ? 'success' : 'failure';
  if (computedConclusion !== result.conclusion) {
    throw new Error(`malformed performance sample conclusion ${result.target}`);
  }
  return {
    target: result.target,
    sequence: sample.sequence,
    fingerprint: evidenceFingerprint,
    fingerprintKey: fingerprintKey(evidenceFingerprint),
    cohortKey: `${fingerprintKey(evidenceFingerprint)}:${provenance.commitSha}`,
    resourceNotes: provenance.resourceNotes,
    failed: result.conclusion === 'failure',
    series,
    ...provenance,
  };
}

function rounded(value) {
  return Number(value.toFixed(6));
}

function median(sortedValues) {
  const middle = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2
    ? sortedValues[middle]
    : (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}

function percentile(sortedValues, percentage) {
  return sortedValues[Math.ceil(sortedValues.length * percentage) - 1];
}

function statisticsFor(observations) {
  const values = observations.map((entry) => entry.actualValue).sort((left, right) => left - right);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  return {
    median: rounded(median(values)),
    p90: values.length >= 10 ? rounded(percentile(values, 0.90)) : null,
    p95: values.length >= 20 ? rounded(percentile(values, 0.95)) : null,
    variance: values.length >= 2
      ? rounded(values.reduce((total, value) => total + ((value - mean) ** 2), 0) / values.length)
      : null,
    failureCount: observations.filter((entry) => entry.failed).length,
  };
}

function unsupportedStatistics(sampleCount) {
  const unsupported = [];
  if (sampleCount < 2) unsupported.push('variance requires 2 samples');
  if (sampleCount < 10) unsupported.push('p90 requires 10 samples');
  if (sampleCount < 20) unsupported.push('p95 requires 20 samples');
  return unsupported;
}

function summarizeCohort(samples) {
  const ordered = [...samples].sort((left, right) => left.sequence - right.sequence);
  const identities = ordered[0].series.map(({ id, title, units }) => ({ id, title, units }));
  for (const sample of ordered.slice(1)) {
    const candidate = sample.series.map(({ id, title, units }) => ({ id, title, units }));
    if (!isDeepStrictEqual(candidate, identities)) {
      throw new Error(`stable complete series inventory drift for ${sample.target}`);
    }
  }
  const sequenceKeys = new Set();
  for (const sample of ordered) {
    const key = `${sample.source}:${sample.sourceId}:${sample.sequence}`;
    if (sequenceKeys.has(key)) throw new Error(`duplicate calibration sample ${sample.target}`);
    sequenceKeys.add(key);
  }
  const series = identities.map((identity, seriesIndex) => {
    const observations = ordered.map((sample) => {
      const current = sample.series[seriesIndex];
      const primary = current.attempts[0];
      const observation = {
        sequence: sample.sequence,
        source: sample.source,
        sourceId: sample.sourceId,
        commitSha: sample.commitSha,
        actualValue: primary.actualValue,
        status: primary.status,
        failed: current.attempts.some((attempt) => attempt.status !== 'passed'),
      };
      if (current.attempts.length > 1) {
        observation.detailAttempts = current.attempts.slice(1).map((attempt) => ({
          attempt: attempt.attempt,
          status: attempt.status,
          actualValue: attempt.actualValue,
        }));
      }
      return observation;
    });
    return {
      ...identity,
      sampleCount: observations.length,
      statistics: statisticsFor(observations),
      unsupportedStatistics: unsupportedStatistics(observations.length),
      observations,
    };
  });
  const environmentFingerprint = ordered[0].fingerprint;
  return {
    cohortId: crypto.createHash('sha256').update(ordered[0].cohortKey).digest('hex').slice(0, 16),
    sampleCount: ordered.length,
    environmentFingerprint,
    sourceRevision: ordered[0].commitSha,
    sources: [...new Set(ordered.map((sample) => sample.source))].sort(),
    resourceNotes: [...new Set(ordered.flatMap((sample) => sample.resourceNotes))].sort(),
    series,
  };
}

function validateExcludedEvidence(entries, targetNames) {
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new Error('malformed excluded performance evidence');
  return entries.map((entry) => {
    if (!entry || !targetNames.has(entry.target) || !EXCLUSION_REASONS.has(entry.reason)
      || !Number.isSafeInteger(entry.count) || entry.count < 1
      || typeof entry.note !== 'string' || !entry.note.trim()) {
      throw new Error('malformed excluded performance evidence');
    }
    return { target: entry.target, reason: entry.reason, count: entry.count, note: entry.note.trim() };
  });
}

function summarizePerformanceCalibration({
  expectedRepository, performanceContract, samples, excludedEvidence,
} = {}) {
  const repository = validateExpectedRepository(expectedRepository);
  const inventory = validateContract(performanceContract);
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('missing retained calibration samples');
  }
  const targetNames = new Set(inventory);
  const normalized = samples.map((sample) => validateSample(sample, targetNames, repository));
  const duplicateKeys = new Set();
  for (const sample of normalized) {
    const key = `${sample.target}:${sample.source}:${sample.sourceId}`;
    if (duplicateKeys.has(key)) throw new Error(`duplicate calibration sample ${sample.target}`);
    duplicateKeys.add(key);
  }
  const exclusions = validateExcludedEvidence(excludedEvidence, targetNames);
  const targets = inventory.map((name) => {
    const targetSamples = normalized.filter((sample) => sample.target === name);
    const groups = new Map();
    for (const sample of targetSamples) {
      const group = groups.get(sample.cohortKey) || [];
      group.push(sample);
      groups.set(sample.cohortKey, group);
    }
    const cohorts = [...groups.values()].map(summarizeCohort)
      .sort((left, right) => left.cohortId.localeCompare(right.cohortId));
    return {
      name,
      sampleCount: targetSamples.length,
      calibrationState: cohorts.length === 0
        ? 'insufficient-retained-evidence'
        : (cohorts.length === 1 ? 'retained-single-fingerprint-and-source' : 'reset-by-fingerprint-or-source-revision'),
      comparison: {
        blended: false,
        status: cohorts.length < 2 ? 'single-or-missing-cohort' : 'separate-fingerprint-cohorts',
      },
      cohorts,
    };
  });
  return {
    schemaVersion: 2,
    repository,
    totalSampleCount: normalized.length,
    excludedEvidenceCount: exclusions.reduce((total, entry) => total + entry.count, 0),
    excludedEvidence: exclusions,
    thresholdDecision: {
      policy: 'shared-local-and-ci-existing-metric-contracts',
      action: 'retain-unchanged',
      localAndCiUseSameThresholds: true,
      exceptionsRequireOwnerApproval: true,
      appliedByThisSummary: false,
    },
    targets,
  };
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--targets', '--input', '--output', '--repository'].includes(flag) || !value || options[flag]) {
      throw new Error('usage: summarize-performance-calibration.cjs --targets <file> --input <file> --output <file> --repository <owner/repo>');
    }
    options[flag] = value;
  }
  if (Object.keys(options).length !== 4) {
    throw new Error('usage: summarize-performance-calibration.cjs --targets <file> --input <file> --output <file> --repository <owner/repo>');
  }
  return options;
}

function runCli(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const targetsPath = path.resolve(options['--targets']);
  const inputPath = path.resolve(options['--input']);
  const outputPath = path.resolve(options['--output']);
  if (outputPath === targetsPath || outputPath === inputPath) {
    throw new Error('output must not overwrite calibration inputs or the performance target contract');
  }
  const input = readJson(inputPath);
  if (!input || input.schemaVersion !== 1) throw new Error('malformed calibration input');
  const summary = summarizePerformanceCalibration({
    expectedRepository: options['--repository'],
    performanceContract: readJson(targetsPath),
    samples: input.samples,
    excludedEvidence: input.excludedEvidence,
  });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  return summary;
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`performance calibration summary failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { runCli, summarizePerformanceCalibration };
