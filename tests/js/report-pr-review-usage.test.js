const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateSelection, verifyContext, downloadUsage } = require('../../scripts/report-pr-review-usage.cjs');
const { sealReport, openReport, summarizeReports } = require('../../scripts/ci/private-review-usage.cjs');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const selection = { repository: 'owner/repo', runId: '42', attempt: 2, headSha: 'a'.repeat(40), privateKey: keys.privateKey };
function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-private-usage-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function writeArtifact(args, overrides = {}) {
  const reviewer = args[args.indexOf('--name') + 1].includes('-pr-agent-') ? 'pr-agent' : 'codex';
  const context = { repository: selection.repository, runId: selection.runId, runAttempt: selection.attempt,
    headSha: selection.headSha, reviewer, ...overrides };
  const report = { schemaVersion: 1, context, telemetryStatus: 'unavailable', records: [] };
  fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], 'usage.enc.json'), JSON.stringify(sealReport(report, keys.publicKey)));
}
function inventory(names = ['private-review-usage-codex-42-2', 'private-review-usage-pr-agent-42-2']) {
  return JSON.stringify([{ artifacts: names.map((name, index) => ({ id: index + 1, name, expired: false })) }]);
}
function expectedUnits() {
  return { schemaVersion: 1, repository: selection.repository, runId: selection.runId,
    runAttempt: selection.attempt, headSha: selection.headSha, pullRequestNumber: 1,
    manifestDigest: 'd'.repeat(64), units: [
      ...['batch-001', 'batch-002', 'integration'].map(reviewUnitId => ({ reviewer: 'codex', reviewUnitId,
        artifactName: `private-review-usage-codex-42-2-${reviewUnitId}` })),
      { reviewer: 'pr-agent', artifactName: 'private-review-usage-pr-agent-42-2' },
    ] };
}
function filesBelow(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? filesBelow(path.join(root, entry.name)) : [path.join(root, entry.name)]);
}
test('exact run and attempt selection rejects malformed arguments and artifact context drift', () => {
  validateSelection(selection);
  for (const overrides of [{ runId: '--help' }, { repository: '../../x' }, { attempt: 0 }, { attempt: 1.5 }]) {
    assert.throws(() => validateSelection({ ...selection, ...overrides }), /invalid-run-selection/);
  }
  const context = { runId: '42', runAttempt: 2, headSha: selection.headSha, reviewer: 'codex', repository: 'owner/repo' };
  verifyContext({ context }, context);
  for (const key of Object.keys(context)) assert.throws(() => verifyContext({ context: { ...context, [key]: 'wrong' } }, context), /context-mismatch/);
});
test('downloader selects only the two encrypted artifacts for the requested attempt', (t) => {
  const staging = sandbox(t);
  const calls = [];
  downloadUsage({ ...selection, staging }, args => { calls.push(args); if (args[0] === 'api') return inventory(); writeArtifact(args); });
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], 'api');
  for (const [index, reviewer] of ['codex', 'pr-agent'].entries()) {
    assert.deepEqual(calls[index + 1].slice(0, 7), ['run', 'download', '42', '--repo', 'owner/repo', '--name', `private-review-usage-${reviewer}-42-2`]);
    assert.equal(fs.readdirSync(path.join(staging, reviewer)).length, 1);
  }
});
test('unavailable downloads produce private unknown rows, never zero dollar claims', (t) => {
  const staging = sandbox(t);
  downloadUsage({ ...selection, staging }, args => { if (args[0] === 'api') return inventory(); throw new Error('network or missing artifact'); });
  const reports = ['codex', 'pr-agent'].map(reviewer => openReport(JSON.parse(fs.readFileSync(
    path.join(staging, reviewer, 'unavailable.enc.json'), 'utf8')), keys.privateKey));
  for (const row of summarizeReports(reports).groups) {
    assert.equal(row.telemetryStatus, 'unavailable');
    assert.equal(row.estimatedCostUsd, null);
    assert.equal(row.tokens.inputTokens.knownTotal, null);
  }
});
test('downloader fails closed for wrong head, mixed attempts, or partially extracted downloads', (t) => {
  for (const mode of ['head', 'attempt', 'partial']) {
    const staging = sandbox(t);
    assert.throws(() => downloadUsage({ ...selection, staging }, args => {
      if (args[0] === 'api') return inventory();
      writeArtifact(args, mode === 'head' ? { headSha: 'b'.repeat(40) } : mode === 'attempt' ? { runAttempt: 1 } : {});
      if (mode === 'partial') throw new Error('interrupted extraction');
    }), mode === 'partial' ? /ambiguous-review-artifact/ : /context-mismatch/);
  }
});

test('batched downloader reads the expected-unit manifest first and preserves missing telemetry as unknown', t => {
  const staging = sandbox(t);
  const expected = expectedUnits();
  const manifestName = 'private-review-usage-units-42-2';
  const names = [manifestName, ...expected.units.filter(unit => unit.reviewUnitId !== 'batch-002').map(unit => unit.artifactName)];
  const calls = [];
  downloadUsage({ ...selection, staging }, args => {
    calls.push(args);
    if (args[0] === 'api') return inventory(names);
    const name = args[args.indexOf('--name') + 1];
    if (name === manifestName) {
      fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], 'usage-units.json'), JSON.stringify(expected));
      return;
    }
    const unit = expected.units.find(row => row.artifactName === name);
    assert.ok(unit, 'download must only select a manifest-owned artifact');
    if (unit.reviewUnitId === 'batch-002') throw new Error('missing artifact');
    writeArtifact(args, unit.reviewer === 'codex'
      ? { reviewUnitId: unit.reviewUnitId, manifestDigest: expected.manifestDigest } : {});
  });
  assert.equal(calls[0][0], 'api');
  assert.equal(calls[1][calls[1].indexOf('--name') + 1], manifestName);
  const files = filesBelow(staging);
  assert.equal(files.filter(file => path.basename(file) === 'usage-units.json').length, 1);
  const reports = files.filter(file => file.endsWith('.enc.json')).map(file => openReport(JSON.parse(fs.readFileSync(file)), keys.privateKey));
  assert.equal(reports.length, expected.units.length);
  const missing = reports.find(report => report.context.reviewUnitId === 'batch-002');
  assert.equal(missing.telemetryStatus, 'unavailable');
  assert.deepEqual(missing.records, []);
  assert.equal(summarizeReports(reports, { expectedUnits: expected }).coverage.billingComplete, false);
});

test('batched downloader rejects unmanifested unit artifacts and unavailable artifact inventories', t => {
  for (const names of [
    ['private-review-usage-codex-42-2-batch-001'],
    ['private-review-usage-units-42-2', 'private-review-usage-codex-42-2-batch-999'],
  ]) {
    const staging = sandbox(t);
    assert.throws(() => downloadUsage({ ...selection, staging }, args => {
      if (args[0] === 'api') return inventory(names);
      fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], 'usage-units.json'), JSON.stringify(expectedUnits()));
    }));
  }
  assert.throws(() => downloadUsage({ ...selection, staging: sandbox(t) }, () => { throw new Error('inventory unavailable'); }));
});

test('batched downloader rejects stale manifests and duplicate artifacts before accepting any unit report', t => {
  for (const mode of ['stale', 'duplicate', 'mismatched-unit']) {
    const staging = sandbox(t);
    const expected = expectedUnits();
    const names = ['private-review-usage-units-42-2', ...expected.units.map(unit => unit.artifactName)];
    if (mode === 'duplicate') names.push(names[1]);
    if (mode === 'stale') expected.headSha = 'b'.repeat(40);
    assert.throws(() => downloadUsage({ ...selection, staging }, args => {
      if (args[0] === 'api') return inventory(names);
      const name = args[args.indexOf('--name') + 1];
      if (name === names[0]) {
        fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], 'usage-units.json'), JSON.stringify(expected));
      } else {
        writeArtifact(args, { reviewUnitId: 'batch-999', manifestDigest: expected.manifestDigest });
      }
    }));
  }
});
