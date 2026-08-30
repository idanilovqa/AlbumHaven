const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const contractPath = path.join(repoRoot, 'tests', 'ci', 'performance-targets.json');
const scriptPath = path.join(repoRoot, 'scripts', 'ci', 'summarize-performance-calibration.cjs');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const { summarizePerformanceCalibration } = require(scriptPath);
const target = contract.targets[0].name;

function fingerprint(environment, overrides = {}) {
  return {
    runnerImage: environment === 'ci' ? 'windows-2025' : 'windows-local',
    chromeVersion: '151.0.7922.138',
    fixtureRelease: 'fixtures-v1.0.19',
    fixtureSchemaVersion: 1,
    postgresMajor: environment === 'ci' ? 17 : 18,
    measurementContract: 'performance-v1',
    ...overrides,
  };
}

function attempts(value, sequence, status = 'passed') {
  return [{
    attempt: 1, status, classification: 'uncalibrated', actualValue: value, units: 'ms',
    startedAt: new Date(Date.UTC(2026, 7, sequence, 0, 0)).toISOString(),
  }];
}

function sampleFor(environment, sequence, value, options = {}) {
  const currentFingerprint = fingerprint(environment, options.fingerprint);
  const status = options.status || 'passed';
  const series = [{ id: 'aaaaaaaaaaaaaaaa', title: 'Visible duration', attempts: attempts(value, sequence, status) }];
  const commitSha = options.commitSha || 'a'.repeat(40);
  const result = {
    schemaVersion: 1, target, conclusion: status === 'passed' ? 'success' : 'failure',
    blocking: false, fingerprint: currentFingerprint,
    attempts: structuredClone(series[0].attempts), series,
  };
  if (environment === 'ci') {
    const runId = String(32930000000 + sequence);
    const runAttempt = '1';
    const childId = `performance:${target}`;
    const artifactName = `performance-result-${target}-${runAttempt}`;
    return {
      sequence,
      evidence: {
        schemaVersion: 1, source: 'github-actions-artifact', workflow: 'PR Gates',
        repository: 'example/AlbumHaven', event: 'pull_request', target, sequence,
        childId, artifactName, runId, runAttempt, commitSha, fingerprint: currentFingerprint,
        resourceNotes: ['windows-2025 hosted runner'],
        verificationEvidence: {
          schemaVersion: 1, repository: 'example/AlbumHaven', commitSha, runId, runAttempt,
          event: 'pull_request', children: [{ id: childId }], performance: [{ target }],
        },
        authenticatedInventory: {
          schemaVersion: 1, structuredReports: [{ name: artifactName, retentionDays: 14 }],
        },
      },
      result,
    };
  }
  return {
    sequence,
    evidence: {
      schemaVersion: 1, source: 'retained-local-report', repository: 'example/AlbumHaven',
      target, sequence, reportId: `local-${sequence}`,
      artifactSha256: String(sequence).padStart(2, '0') + 'b'.repeat(62),
      commitSha, fingerprint: currentFingerprint, resourceNotes: ['retained local report'],
    },
    result,
  };
}

function input(samples, excludedEvidence = []) {
  return {
    expectedRepository: 'example/AlbumHaven', performanceContract: structuredClone(contract),
    samples, excludedEvidence,
  };
}

test('uses every retained sample, groups local and CI fingerprints, and reports supported statistics only', () => {
  const local = [sampleFor('local', 1, 743), sampleFor('local', 2, 786)];
  const ci = Array.from({ length: 12 }, (_, index) => sampleFor(
    'ci', index + 1, index === 4 ? 2961.9 : 1500 + (index * 10),
    { status: index === 4 ? 'failed' : 'passed' },
  ));
  const summary = summarizePerformanceCalibration(input([...local, ...ci], [
    { target: 'scan-cold', reason: 'no-runner', count: 1, note: 'zero steps; no measurement' },
    { target: 'rules-focused', reason: 'premeasurement-setup-failure', count: 1, note: 'database identity guard' },
  ]));
  assert.equal(summary.totalSampleCount, 14);
  assert.equal(summary.thresholdDecision.policy, 'shared-local-and-ci-existing-metric-contracts');
  assert.equal(summary.thresholdDecision.action, 'retain-unchanged');
  assert.equal(summary.thresholdDecision.exceptionsRequireOwnerApproval, true);
  assert.equal(summary.excludedEvidenceCount, 2);
  assert.equal(summary.targets.length, 19);

  const observed = summary.targets.find((entry) => entry.name === target);
  assert.equal(observed.calibrationState, 'reset-by-fingerprint-or-source-revision');
  assert.equal(observed.comparison.blended, false);
  assert.equal(observed.cohorts.length, 2);
  const localCohort = observed.cohorts.find((cohort) => cohort.environmentFingerprint.runnerImage === 'windows-local');
  const ciCohort = observed.cohorts.find((cohort) => cohort.environmentFingerprint.runnerImage === 'windows-2025');
  assert.equal(localCohort.sampleCount, 2);
  assert.deepEqual(localCohort.series[0].statistics, {
    median: 764.5, p90: null, p95: null, variance: 462.25, failureCount: 0,
  });
  assert.deepEqual(localCohort.series[0].unsupportedStatistics, ['p90 requires 10 samples', 'p95 requires 20 samples']);
  assert.equal(ciCohort.sampleCount, 12);
  assert.equal(ciCohort.series[0].statistics.p90, 1610);
  assert.equal(ciCohort.series[0].statistics.p95, null);
  assert.equal(ciCohort.series[0].statistics.failureCount, 1);
  assert.equal(ciCohort.series[0].observations.find((entry) => entry.sequence === 5).actualValue, 2961.9);
  assert.equal(ciCohort.series[0].observations.find((entry) => entry.sequence === 5).status, 'failed');
  const missing = summary.targets.find((entry) => entry.name === 'scan-page');
  assert.equal(missing.calibrationState, 'insufficient-retained-evidence');
  assert.deepEqual(missing.cohorts, []);
});

test('environment and source drift creates separate reset cohorts instead of blending', () => {
  const samples = [
    sampleFor('ci', 1, 700),
    sampleFor('ci', 2, 800, { fingerprint: { chromeVersion: '152.0.0.0' } }),
    sampleFor('ci', 3, 900, { fingerprint: { fixtureSchemaVersion: 2 } }),
    sampleFor('ci', 4, 1000, { commitSha: 'c'.repeat(40) }),
  ];
  const observed = summarizePerformanceCalibration(input(samples)).targets[0];
  assert.equal(observed.cohorts.length, 4);
  assert.equal(observed.calibrationState, 'reset-by-fingerprint-or-source-revision');
  assert.equal(observed.comparison.blended, false);
  assert.equal(observed.cohorts.every((cohort) => cohort.sampleCount === 1), true);
  assert.equal(observed.cohorts.every((cohort) => cohort.series[0].statistics.variance === null), true);
});

test('does not require 20 samples per target or a 380-sample paid campaign', () => {
  const summary = summarizePerformanceCalibration(input([sampleFor('local', 1, 786)]));
  assert.equal(summary.totalSampleCount, 1);
  assert.equal(summary.targets[0].cohorts[0].sampleCount, 1);
  assert.equal(summary.targets[0].cohorts[0].series[0].statistics.median, 786);
  assert.equal(summary.targets[0].cohorts[0].series[0].statistics.variance, null);
  assert.equal(Object.hasOwn(summary, 'sampleCountPerTarget'), false);
});

test('fails closed on invented registries, malformed measurements, and untrusted provenance', () => {
  const partial = input([sampleFor('local', 1, 786)]);
  partial.performanceContract.targets.pop();
  assert.throws(() => summarizePerformanceCalibration(partial), /exact checked-in 19-target/i);
  const malformed = input([sampleFor('local', 1, 786)]);
  malformed.samples[0].result.series[0].attempts[0].actualValue = Number.NaN;
  assert.throws(() => summarizePerformanceCalibration(malformed), /malformed performance sample/i);
  const foreign = input([sampleFor('ci', 1, 786)]);
  foreign.samples[0].evidence.repository = 'foreign/MusicApp';
  foreign.samples[0].evidence.verificationEvidence.repository = 'foreign/MusicApp';
  assert.throws(() => summarizePerformanceCalibration(foreign), /untrusted calibration evidence/i);
});

test('CLI writes deterministic retained-evidence JSON without modifying the threshold registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-calibration-'));
  try {
    const targetsPath = path.join(root, 'targets.json');
    const inputPath = path.join(root, 'samples.json');
    const outputPath = path.join(root, 'summary.json');
    fs.copyFileSync(contractPath, targetsPath);
    const original = fs.readFileSync(targetsPath, 'utf8');
    fs.writeFileSync(inputPath, `${JSON.stringify({
      schemaVersion: 1, samples: [sampleFor('local', 1, 786)], excludedEvidence: [],
    })}\n`);
    const result = spawnSync(process.execPath, [
      scriptPath, '--targets', targetsPath, '--input', inputPath, '--output', outputPath,
      '--repository', 'example/AlbumHaven',
    ], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(targetsPath, 'utf8'), original);
    const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(parsed.totalSampleCount, 1);
    assert.equal(parsed.thresholdDecision.action, 'retain-unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
