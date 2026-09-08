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
  downloadUsage({ ...selection, staging }, args => { calls.push(args); writeArtifact(args); });
  assert.equal(calls.length, 2);
  for (const [index, reviewer] of ['codex', 'pr-agent'].entries()) {
    assert.deepEqual(calls[index].slice(0, 7), ['run', 'download', '42', '--repo', 'owner/repo', '--name', `private-review-usage-${reviewer}-42-2`]);
    assert.equal(fs.readdirSync(path.join(staging, reviewer)).length, 1);
  }
});
test('unavailable downloads produce private unknown rows, never zero dollar claims', (t) => {
  const staging = sandbox(t);
  downloadUsage({ ...selection, staging }, () => { throw new Error('network or missing artifact'); });
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
      writeArtifact(args, mode === 'head' ? { headSha: 'b'.repeat(40) } : mode === 'attempt' ? { runAttempt: 1 } : {});
      if (mode === 'partial') throw new Error('interrupted extraction');
    }), mode === 'partial' ? /ambiguous-review-artifact/ : /context-mismatch/);
  }
});
