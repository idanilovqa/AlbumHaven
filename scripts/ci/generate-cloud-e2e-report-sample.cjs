const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildExpectedCloudE2EInventory, mergeCloudE2EResults } = require('./merge-cloud-e2e-results.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const outputRoot = path.join(repoRoot, 'test-results', 'cloud-test-report-sample', 'public-pages');
const runId = '32837431728';
const runAttempt = '2';
const generatedAt = '2026-08-25T19:00:00.000Z';
const screenshotBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const inventory = buildExpectedCloudE2EInventory({ runAttempt });
const fingerprint = {
  runnerImage: 'windows-2025', chromeVersion: '151.0.7922.138', fixtureRelease: 'fixtures-v1.0.19',
  fixtureSchemaVersion: 1, postgresMajor: 17, measurementContract: 'performance-v1',
};

const resultArtifacts = [
  ...inventory.functional.map((row, index) => ({
    name: row.artifactName, category: 'structured-report', retentionDays: 14,
    runId, runAttempt, childId: row.childId,
    payload: {
      schemaVersion: 1, shard: row.shard, conclusion: index === 0 ? 'failure' : 'success',
      cases: [{
        testId: `FTC-SAMPLE-${index + 1}`,
        name: index === 0 ? 'Sample failed synthetic E2E test' : `Sample passing ${row.shard} test`,
        status: index === 0 ? 'failed' : 'passed', durationMs: 240 + index,
        steps: [
          { title: 'Open the synthetic gallery', status: 'passed', durationMs: 90 },
          { title: 'Verify the album card', status: index === 0 ? 'failed' : 'passed', durationMs: 150 },
        ],
        stackSummary: index === 0 ? 'Expected the synthetic album card to be visible at assertion line 42.' : '',
        finalScreenshot: index === 0 ? {
          status: 'validated', publicPath: 'screenshots/sample-final-failure.png',
          width: 1, height: 1, sha256: crypto.createHash('sha256').update(screenshotBytes).digest('hex'),
          bytes: screenshotBytes,
        } : null,
      }],
    },
  })),
  ...inventory.performance.map((row, index) => ({
    name: row.artifactName, category: 'structured-report', retentionDays: 14,
    runId, runAttempt, childId: row.childId,
    payload: {
      schemaVersion: 1, target: row.target, conclusion: 'success', blocking: false, fingerprint,
      ...(row.measurementExpected ? {
        attempts: [{
          attempt: 1, status: 'passed', classification: 'uncalibrated', actualValue: 800 + index * 25,
          units: 'ms', startedAt: generatedAt,
        }],
      } : {
        measurementAvailable: false, coverageOnly: true, attemptCount: 1,
        attempts: [], series: [], testCount: 2,
        cases: ['FTC-OPS-003C', 'FTC-OPS-003E'].map((testId, caseIndex) => ({
          testId, name: `${testId} scan-page coverage`, status: 'passed', durationMs: 100 + caseIndex,
          steps: [{ title: 'Exercise Scan Page contract', status: 'passed', durationMs: 20 }],
          stackSummary: '', finalScreenshot: null,
        })),
      }),
    },
  })),
];

const report = mergeCloudE2EResults({
  run: {
    repository: 'idanilovqa/AlbumHaven', commitSha: '0123456789abcdef0123456789abcdef01234567',
    pullRequest: 47, runId, runAttempt, event: 'pull_request', generatedAt,
    actionsUrl: `https://github.com/idanilovqa/AlbumHaven/actions/runs/${runId}`,
  },
  fixture: {
    release: 'fixtures-v1.0.19',
    manifestSha256: 'cb9ed982ec5afd191e77c99f90cc42ecaec228086d9147df4fdd6b1b621b8d51',
    schemaVersion: 1,
  },
  resultArtifacts, previousPerformanceHistory: [], now: new Date('2026-08-25T20:00:00.000Z'),
});

for (const [relativePath, content] of Object.entries(report.pagesFiles)) {
  const target = path.join(outputRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
process.stdout.write(`${outputRoot}\n`);
