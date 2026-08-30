const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const builderPath = path.join(repoRoot, 'scripts', 'ci', 'build-cloud-test-report.cjs');
const validatorPath = path.join(repoRoot, 'scripts', 'ci', 'validate-cloud-test-report.cjs');

function sampleInput() {
  return {
    schemaVersion: 1,
    run: {
      repository: 'idanilovqa/AlbumHaven', commitSha: '0123456789abcdef0123456789abcdef01234567',
      pullRequest: 47, runId: '32837431728', runAttempt: '2', event: 'pull_request',
      generatedAt: '2026-08-25T19:00:00.000Z',
      actionsUrl: 'https://github.com/idanilovqa/AlbumHaven/actions/runs/32837431728',
    },
    expectedChildIds: ['functional:gallery-search-visual', 'performance:idle-memory'],
    children: [
      { id: 'functional:gallery-search-visual', conclusion: 'success', passed: 35, failed: 0, skipped: 0 },
      { id: 'performance:idle-memory', conclusion: 'success', passed: 2, failed: 0, skipped: 0 },
    ],
    fixture: {
      release: 'fixtures-v1.0.19',
      manifestSha256: 'cb9ed982ec5afd191e77c99f90cc42ecaec228086d9147df4fdd6b1b621b8d51',
      profiles: ['functional-core', 'synthetic-large-library'],
    },
    environment: {
      runner: 'windows-2025', node: '22.20.0', python: '3.11', chrome: '151.0.7922.138',
      postgres: '17', imageioFfmpeg: '0.6.0', ffmpeg: '7.1-essentials_build-www.gyan.dev',
    },
    functional: [{
      shard: 'gallery-search-visual', passed: 35, failed: 0, skipped: 0,
      cases: [{
        id: 'FTC-GALLERY-001', title: 'opens an album from the synthetic gallery', status: 'passed', durationMs: 2180,
        steps: [{ title: 'Open Album Details', status: 'passed', durationMs: 410 }], stackSummary: '', screenshot: null,
      }],
    }],
    performance: [{
      target: 'idle-memory', classification: 'uncalibrated', blocking: false, actualValue: 210_000_000,
      units: 'bytes', primaryAttempt: 1, historyPath: 'performance/idle-memory/',
    }],
    artifacts: [
      { name: 'cloud-test-report-32837431728-2', category: 'structured-report', retentionDays: 14 },
      { name: 'functional-debug-gallery-search-visual-2', category: 'debug', retentionDays: 7 },
    ],
  };
}

test('cloud report modules exist', () => {
  assert.equal(fs.existsSync(builderPath), true, 'Missing cloud report builder');
  assert.equal(fs.existsSync(validatorPath), true, 'Missing cloud report validator');
});

test('public evidence accepts only functional and performance E2E children', () => {
  const { validateEvidence } = require(builderPath);
  assert.deepEqual(validateEvidence(sampleInput()), []);
  for (const foundationId of ['test_js', 'test_python', 'production_parity', 'components', 'windows_node_contracts']) {
    const input = sampleInput();
    input.expectedChildIds.push(foundationId);
    input.children.push({ id: foundationId, conclusion: 'success', passed: 1, failed: 0, skipped: 0 });
    assert.match(validateEvidence(input).join('\n'), /non-E2E child/i, foundationId);
  }
});

test('evidence rejects missing, duplicate, mismatched, malformed, and duplicate artifact inputs', () => {
  const { validateEvidence } = require(builderPath);
  const missing = sampleInput();
  missing.children.pop();
  assert.match(validateEvidence(missing).join('\n'), /missing child.*performance:idle-memory/i);
  const duplicate = sampleInput();
  duplicate.children.push({ ...duplicate.children[0] });
  assert.match(validateEvidence(duplicate).join('\n'), /duplicate child.*functional:gallery-search-visual/i);
  const mismatch = sampleInput();
  mismatch.children[0].runId = 'other-run';
  mismatch.children[0].runAttempt = '9';
  assert.match(validateEvidence(mismatch).join('\n'), /run.*attempt.*mismatch/i);
  const duplicateArtifact = sampleInput();
  duplicateArtifact.artifacts.push({ ...duplicateArtifact.artifacts[0] });
  assert.match(validateEvidence(duplicateArtifact).join('\n'), /duplicate artifact/i);
  const malformedFunctional = sampleInput();
  malformedFunctional.functional[0].cases[0].steps = 'not-an-array';
  assert.match(validateEvidence(malformedFunctional).join('\n'), /malformed functional/i);
  const malformedPerformance = sampleInput();
  malformedPerformance.performance[0].actualValue = Number.NaN;
  assert.match(validateEvidence(malformedPerformance).join('\n'), /malformed performance/i);

  const unsafeRunLink = sampleInput();
  unsafeRunLink.run.actionsUrl = 'javascript:alert(1)';
  assert.match(validateEvidence(unsafeRunLink).join('\n'), /malformed run identity/i);
});

test('a failed child builds a failed public report with safe failure detail', () => {
  const { buildCloudTestReport, validateEvidence } = require(builderPath);
  const input = sampleInput();
  input.children[0] = { ...input.children[0], conclusion: 'failure', passed: 34, failed: 1 };
  input.functional[0] = {
    ...input.functional[0], passed: 34, failed: 1,
    cases: [{
      id: 'FTC-GALLERY-099', title: 'shows the expected synthetic album', status: 'failed', durationMs: 3200,
      steps: [
        { title: 'Open synthetic gallery', status: 'passed', durationMs: 500 },
        { title: 'Select expected album', status: 'failed', durationMs: 2700 },
      ],
      stackSummary: 'Expected album card to be visible',
      screenshot: { path: 'screenshots/abc123.png', sha256: 'a'.repeat(64), width: 1440, height: 960 },
    }],
  };
  assert.deepEqual(validateEvidence(input), []);
  const report = buildCloudTestReport(input);
  const html = report.pagesFiles['runs/32837431728/2/index.html'];
  assert.equal(report.verificationEvidence.overallConclusion, 'failure');
  assert.match(html, /FTC-GALLERY-099/);
  assert.match(html, /Open synthetic gallery/);
  assert.match(html, /Expected album card to be visible/);
  assert.match(html, /screenshots\/abc123\.png/);
  assert.match(html, /Download full failure evidence/);
});

test('sanitized report contains no foundation gates and passes the public validator', () => {
  const { buildCloudTestReport } = require(builderPath);
  const { validateCloudTestReport } = require(validatorPath);
  const report = buildCloudTestReport(sampleInput());
  const publicText = JSON.stringify(report.pagesFiles);
  assert.equal(report.pagesPath, '/runs/32837431728/2/');
  assert.equal(report.verificationEvidence.overallConclusion, 'success');
  assert.deepEqual(validateCloudTestReport(report), []);
  assert.match(report.pagesFiles['runs/32837431728/2/index.html'], /Functional E2E/);
  assert.match(report.pagesFiles['runs/32837431728/2/index.html'], /Performance E2E/);
  assert.match(report.pagesFiles['runs/32837431728/2/index.html'], /performance\/idle-memory/);
  assert.doesNotMatch(publicText, /test_js|test_python|production_parity|components|windows_node_contracts/i);
});

test('authenticated inventory separates 14-day structured reports from 7-day raw diagnostics', () => {
  const { buildAuthenticatedInventory } = require(builderPath);
  const inventory = buildAuthenticatedInventory(sampleInput());
  assert.deepEqual(inventory.structuredReports.map((entry) => entry.name), ['cloud-test-report-32837431728-2']);
  assert.deepEqual(inventory.debugArtifacts.map((entry) => entry.name), ['functional-debug-gallery-search-visual-2']);
  const invalid = sampleInput();
  invalid.artifacts[1].retentionDays = 14;
  assert.throws(() => buildAuthenticatedInventory(invalid), /debug.*7 days/i);
});

test('public validation rejects private paths, URLs, secrets, logs, traces, and unvalidated screenshots', () => {
  const { buildCloudTestReport } = require(builderPath);
  const { validateCloudTestReport } = require(validatorPath);
  const forbidden = [
    'C:\\Users\\owner\\Music\\private.mp3', '\\\\server\\private-library', 'file:///C:/private/cover.jpg',
    'postgresql://album_haven_app@127.0.0.1/private', 'http://127.0.0.1:4173/view-data',
    'https://api.spotify.com/private-result', 'ALBUM_HAVEN_FIXTURES_TOKEN=secret-value',
    'DATABASE_APP_URL=postgresql://hidden', 'runtime.log', 'trace.zip',
  ];
  for (const value of forbidden) {
    const report = buildCloudTestReport(sampleInput());
    report.pagesFiles['runs/32837431728/2/report.json'] += value;
    assert.match(validateCloudTestReport(report).join('\n'), /forbidden public content/i, value);
  }
  const report = buildCloudTestReport(sampleInput());
  report.pagesFiles['runs/32837431728/2/index.html'] += '<img src="failure-screenshot.png">';
  assert.match(validateCloudTestReport(report).join('\n'), /unvalidated public screenshot/i);

  for (const unsafeText of ['/srv/private/AlbumHaven/private.mp3', 'https://example.invalid/private']) {
    const unsafeReport = buildCloudTestReport(sampleInput());
    unsafeReport.pagesFiles['runs/32837431728/2/report.json'] += unsafeText;
    assert.match(validateCloudTestReport(unsafeReport).join('\n'), /forbidden public content/i, unsafeText);
  }
});

test('retained public index keeps at most 20 runs and no entry older than 14 days', () => {
  const { pruneRunIndex } = require(builderPath);
  const now = new Date('2026-08-25T20:00:00.000Z');
  const entries = Array.from({ length: 25 }, (_, index) => ({
    runId: String(100 + index), runAttempt: index % 2 ? '2' : '1',
    generatedAt: new Date(now.getTime() - index * 24 * 60 * 60 * 1000).toISOString(),
  }));
  const pruned = pruneRunIndex(entries, { now, maxEntries: 20, maxAgeDays: 14 });
  assert.equal(pruned.length, 15);
  assert.equal(pruned[0].runId, '100');
  assert.equal(pruned.at(-1).runId, '114');
  assert.equal(pruned.every((entry) => entry.overallConclusion === 'failure'), true);
});

test('public run index links retained prior runs to authenticated Actions evidence', () => {
  const { buildCloudTestReport } = require(builderPath);
  const input = sampleInput();
  input.previousRunIndex = [{
    runId: '32837430000', runAttempt: '1', generatedAt: '2026-08-24T19:00:00.000Z', overallConclusion: 'success',
  }];
  const report = buildCloudTestReport(input);
  assert.match(report.pagesFiles['index.html'], /actions\/runs\/32837430000/);
  assert.equal(JSON.parse(report.pagesFiles['run-index.json']).length, 2);
  assert.deepEqual(require(validatorPath).validateCloudTestReport(report), []);
});

test('failed upstream E2E matrix jobs remain authoritative when result payloads pass', () => {
  const { buildCloudTestReport } = require(builderPath);
  const input = sampleInput();
  input.children = input.children.map((child) => ({ ...child, conclusion: 'success', failed: 0 }));
  input.upstreamConclusions = { functional: 'success', performance: 'failure' };
  assert.equal(buildCloudTestReport(input).verificationEvidence.overallConclusion, 'failure');
});

test('workflow remains pull-request-only', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'pr-gates.yml'), 'utf8');
  assert.match(workflow, /^on:\r?\n\s+pull_request:/m);
  assert.doesNotMatch(workflow, /^\s{2}(?:push|schedule|workflow_dispatch|pull_request_target):/m);
});

test('PR workflow omits merged reporting and GitHub Pages deployment', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'pr-gates.yml'), 'utf8');
  assert.doesNotMatch(workflow, /^  merge_cloud_reports:/m);
  assert.doesNotMatch(workflow, /^  deploy_cloud_reports:/m);
  assert.doesNotMatch(workflow, /actions\/(?:upload-pages-artifact|deploy-pages)@/);
  assert.doesNotMatch(workflow, /^\s+pages:\s*write\s*$/m);
  assert.doesNotMatch(workflow, /^\s+name:\s*github-pages\s*$/m);
});
