const assert = require('node:assert/strict');
const test = require('node:test');
const { prepareUsageReport } = require('../../scripts/ci/seal-review-usage.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const context = { runId: '42', runAttempt: 1, headSha: 'a'.repeat(40) };
function mockFiles(files) { return { readFileSync(name) { if (!(name in files)) throw new Error('absent'); return files[name]; } }; }
const record = { schemaVersion: 1, reviewer: 'pr-agent', status: 'success', usage: { inputTokens: 10 } };
test('missing records and registered but empty capture remain unavailable', () => {
  for (const files of [{}, { 'usage.status.json': '{"schemaVersion":1,"state":"registered"}', usage: '' }]) {
    const result = prepareUsageReport({ reviewer: 'pr-agent', inputPath: 'usage', context }, mockFiles(files));
    assert.equal(result.telemetryStatus, 'unavailable');
    assert.deepEqual(result.records, []);
  }
});
test('PR Agent records retain evidence but mark missing registration or truncated output partial', () => {
  const usage = JSON.stringify(record) + '\n';
  const registered = '{"schemaVersion":1,"state":"registered"}';
  for (const [files, expected] of [
    [{ usage, 'usage.status.json': registered }, 'available'],
    [{ usage }, 'partial'],
    [{ usage: usage + '{', 'usage.status.json': registered }, 'partial'],
  ]) {
    const result = prepareUsageReport({ reviewer: 'pr-agent', inputPath: 'usage', context }, mockFiles(files));
    assert.equal(result.telemetryStatus, expected);
    assert.deepEqual(result.records, [record]);
  }
});
test('failed action retains recorded usage while marking coverage partial', () => {
  const input = JSON.stringify({ records: [{ ...record, reviewer: 'codex' }], coverage: 'observed' });
  const result = prepareUsageReport({ reviewer: 'codex', inputPath: 'usage', context, actionOutcome: 'failure' }, mockFiles({ usage: input }));
  assert.equal(result.telemetryStatus, 'partial');
  assert.equal(result.records.length, 1);
  assert.equal(result.context.reviewer, 'codex');
});
test('malformed or empty Codex collector output is unavailable', () => {
  for (const usage of ['{', '{}', '{"coverage":"observed","records":[]}']) {
    assert.equal(prepareUsageReport({ reviewer: 'codex', inputPath: 'usage', context }, mockFiles({ usage })).telemetryStatus, 'unavailable');
  }
});

test('CI sealing command emits only ciphertext and preserves each reviewer\'s actual normalized usage', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-private-seal-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const publicKey = path.join(directory, 'public.pem');
  fs.writeFileSync(publicKey, keys.publicKey);
  const usage = { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0,
    outputTokens: 15, reasoningOutputTokens: 5, totalTokens: 115 };
  for (const reviewer of ['codex', 'pr-agent']) {
    const input = path.join(directory, reviewer + '.jsonl');
    const output = path.join(directory, reviewer + '.enc.json');
    const normalized = { schemaVersion: 1, reviewer, responseId: 'response-fixture', callId: null,
      status: 'success', model: 'gpt-5.6', modelAttribution: 'response', serviceTier: 'default', usage,
      providerEstimatedCostUsd: null, prompt: 'never-retain-this-private-content' };
    fs.writeFileSync(input, JSON.stringify(reviewer === 'codex'
      ? { records: [normalized], coverage: 'observed' } : normalized));
    if (reviewer === 'pr-agent') fs.writeFileSync(input + '.status.json', '{"schemaVersion":1,"state":"registered"}');
    const result = cp.spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/ci/seal-review-usage.cjs'),
      '--reviewer', reviewer, '--input', input, '--public-key', publicKey, '--output', output], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: { ...process.env, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: 'owner/repo', REVIEW_USAGE_HEAD_SHA: 'a'.repeat(40), REVIEW_USAGE_ACTION_OUTCOME: 'success',
        REVIEW_USAGE_UNIT_ID: reviewer === 'codex' ? 'batch-001' : '',
        REVIEW_USAGE_MANIFEST_DIGEST: reviewer === 'codex' ? 'd'.repeat(64) : '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, '');
    const serialized = fs.readFileSync(output, 'utf8');
    assert.doesNotMatch(serialized, /never-retain|gpt-5\.6|inputTokens|response-fixture/);
    const opened = require('../../scripts/ci/private-review-usage.cjs').openReport(JSON.parse(serialized), keys.privateKey);
    assert.equal(opened.telemetryStatus, 'available');
    assert.deepEqual(opened.records[0].usage, usage);
    assert.equal(Object.hasOwn(opened.records[0], 'prompt'), false);
    if (reviewer === 'codex') {
      assert.equal(opened.context.reviewUnitId, 'batch-001');
      assert.equal(opened.context.manifestDigest, 'd'.repeat(64));
    } else {
      assert.equal(Object.hasOwn(opened.context, 'reviewUnitId'), false);
      assert.equal(Object.hasOwn(opened.context, 'manifestDigest'), false);
    }
  }
});

test('review unit capture keeps cancelled integration identity without inventing usage', () => {
  const unitContext = { ...context, reviewUnitId: 'integration', manifestDigest: 'd'.repeat(64) };
  const report = prepareUsageReport({ reviewer: 'codex', inputPath: 'absent',
    context: unitContext, actionOutcome: 'cancelled' }, mockFiles({}));
  assert.deepEqual(report.context, { ...unitContext, reviewer: 'codex' });
  assert.equal(report.telemetryStatus, 'unavailable');
  assert.deepEqual(report.records, []);
});
