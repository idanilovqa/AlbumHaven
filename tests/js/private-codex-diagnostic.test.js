const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const test = require('node:test');
const usage = require('../../scripts/ci/private-review-usage.cjs');
const helperPath = path.resolve(__dirname, '../../scripts/ci/private-codex-diagnostic.cjs');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const context = { repository: 'example/repository', pullRequestNumber: 1, runId: '123', runAttempt: 2,
  headSha: 'a'.repeat(40), reviewer: 'codex', reviewUnitId: 'batch-001', manifestDigest: 'b'.repeat(64) };
const env = { ...process.env, GITHUB_REPOSITORY: context.repository, GITHUB_RUN_ID: context.runId,
  GITHUB_RUN_ATTEMPT: String(context.runAttempt), REVIEW_USAGE_HEAD_SHA: context.headSha,
  REVIEW_USAGE_PR_NUMBER: '1', REVIEW_USAGE_UNIT_ID: context.reviewUnitId,
  REVIEW_USAGE_MANIFEST_DIGEST: context.manifestDigest, REVIEW_USAGE_ACTION_OUTCOME: 'failure' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'album-haven-diagnostic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const capture = path.join(root, 'album-haven-codex-output.fixture');
  fs.writeFileSync(capture, 'PRIVATE_TRANSCRIPT tokens 123\n', { mode: 0o600 });
  const publicKey = path.join(root, 'public.pem'), privateKey = path.join(root, 'private.pem');
  fs.writeFileSync(publicKey, keys.publicKey); fs.writeFileSync(privateKey, keys.privateKey, { mode: 0o600 });
  return { root, capture, publicKey, privateKey, output: path.join(root, 'diagnostic.enc.json'),
    state: path.join(root, 'album-haven-codex-diagnostic.json') };
}
function invoke(args, overrides = {}) {
  assert.ok(fs.existsSync(helperPath), 'approved encrypted diagnostic helper must exist');
  return cp.spawnSync(process.execPath, [helperPath, ...args], { env: { ...env, ...overrides },
    encoding: 'utf8', windowsHide: true, timeout: 10000 });
}
function start(f) { assert.equal(invoke(['start', '--runner-temp', f.root, '--capture', f.capture]).status, 0); }
function seal(f, overrides) { return invoke(['seal', '--runner-temp', f.root, '--public-key', f.publicKey, '--output', f.output], overrides); }
function readEnvelope(f) { return JSON.parse(fs.readFileSync(f.output, 'utf8')); }
for (const exitCode of [0, 37]) test(`encrypted capture retains exact exit ${exitCode} and raw bytes only in ciphertext`, t => {
  const f = fixture(t); start(f);
  assert.equal(invoke(['finish', '--runner-temp', f.root, '--exit-code', String(exitCode)]).status, 0);
  const result = seal(f, { REVIEW_USAGE_ACTION_OUTCOME: exitCode ? 'failure' : 'success' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /PRIVATE|123/);
  assert.doesNotMatch(fs.readFileSync(f.output, 'utf8'), /PRIVATE_TRANSCRIPT|consoleBase64|capturePath|exitCode/);
  const report = usage.openDiagnostic(readEnvelope(f), keys.privateKey, context);
  assert.equal(report.type, 'codex-execution-diagnostic');
  assert.deepEqual(report.context, context);
  assert.equal(report.execution.exitCode, exitCode); assert.equal(report.execution.status, 'complete');
  assert.deepEqual(Buffer.from(report.consoleBase64, 'base64'), fs.readFileSync(f.capture));
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.state).mode & 0o777, 0o600);
});
test('cancelled capture without completion remains incomplete with unknown exit', t => {
  const f = fixture(t); start(f); assert.equal(seal(f, { REVIEW_USAGE_ACTION_OUTCOME: 'cancelled' }).status, 0);
  const report = usage.openDiagnostic(readEnvelope(f), keys.privateKey, context);
  assert.deepEqual(report.execution, { status: 'incomplete', exitCode: null, actionOutcome: 'cancelled' });
});
test('diagnostic context, key, ciphertext tampering and usage type confusion are rejected', t => {
  const f = fixture(t); start(f); assert.equal(seal(f).status, 0);
  const envelope = readEnvelope(f);
  for (const [key, value] of Object.entries({ repository: 'other/repo', pullRequestNumber: 2, runId: '124',
    runAttempt: 3, headSha: 'c'.repeat(40), reviewer: 'pr-agent', reviewUnitId: 'integration', manifestDigest: 'd'.repeat(64) })) {
    assert.throws(() => usage.openDiagnostic(envelope, keys.privateKey, { ...context, [key]: value }));
  }
  assert.throws(() => usage.openDiagnostic(envelope, keys.privateKey, {}));
  const wrong = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => usage.openDiagnostic(envelope, wrong, context));
  const bytes = Buffer.from(envelope.ciphertext, 'base64'); bytes[0] ^= 1;
  assert.throws(() => usage.openDiagnostic({ ...envelope, ciphertext: bytes.toString('base64') }, keys.privateKey, context));
  assert.throws(() => usage.openReport(envelope, keys.privateKey));
  const legacy = { schemaVersion: 1, context: { runId: '123', runAttempt: 2, headSha: context.headSha, reviewer: 'codex' }, telemetryStatus: 'unavailable', records: [] };
  const sealedLegacy = usage.sealReport(legacy, keys.publicKey);
  assert.deepEqual(usage.openReport(sealedLegacy, keys.privateKey), legacy);
  assert.throws(() => usage.openDiagnostic(sealedLegacy, keys.privateKey, context));
});
test('capture beyond 16 MiB fails explicitly without truncation or output', t => {
  const f = fixture(t); start(f); fs.truncateSync(f.capture, 16 * 1024 * 1024 + 1);
  const result = seal(f); assert.notEqual(result.status, 0); assert.ok(!fs.existsSync(f.output));
  assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /PRIVATE|123/);
});

test('maximum supported diagnostic capture round-trips without regexp stack exhaustion', () => {
  const raw = Buffer.alloc(usage.DIAGNOSTIC_MAX_BYTES, 0x61);
  const report = { schemaVersion: 1, type: 'codex-execution-diagnostic', context,
    execution: { status: 'complete', exitCode: 0, actionOutcome: 'success' },
    consoleBase64: raw.toString('base64') };
  const envelope = usage.sealDiagnostic(report, keys.publicKey);
  const opened = usage.openDiagnostic(envelope, keys.privateKey, context);
  assert.deepEqual(Buffer.from(opened.consoleBase64, 'base64'), raw);
  assert.deepEqual(opened.context, context);
  assert.deepEqual(opened.execution, report.execution);
});
test('missing malformed duplicate and cross-context sidecars fail closed', t => {
  const f = fixture(t); assert.notEqual(seal(f).status, 0); start(f);
  assert.notEqual(invoke(['start', '--runner-temp', f.root, '--capture', f.capture]).status, 0);
  assert.notEqual(seal(f, { GITHUB_RUN_ATTEMPT: '3' }).status, 0);
  fs.writeFileSync(f.state, '{malformed'); assert.notEqual(seal(f).status, 0);
  assert.ok(!fs.existsSync(f.output));
});
test('capture and sidecar parent redirection are rejected', t => {
  const f = fixture(t), outside = fixture(t);
  assert.notEqual(invoke(['start', '--runner-temp', f.root, '--capture', outside.capture]).status, 0);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(outside.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual(invoke(['start', '--runner-temp', alias, '--capture', path.join(alias, path.basename(outside.capture))]).status, 0);
  start(f); fs.unlinkSync(f.capture); fs.symlinkSync(outside.capture, f.capture);
  assert.notEqual(seal(f).status, 0); assert.ok(!fs.existsSync(f.output));
});
test('opening requires canonical existing private output parent and never overwrites', t => {
  const f = fixture(t), outside = fixture(t); start(f); assert.equal(seal(f).status, 0);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(outside.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const args = ['open', '--input', f.output, '--private-key', f.privateKey, '--output'];
  const escaped = invoke([...args, path.join(alias, 'plaintext.json')]);
  assert.notEqual(escaped.status, 0); assert.ok(!fs.existsSync(path.join(outside.root, 'plaintext.json')));
  const target = path.join(f.root, 'plaintext.json');
  assert.equal(invoke([...args, target]).status, 0);
  assert.equal(Buffer.from(JSON.parse(fs.readFileSync(target)).consoleBase64, 'base64').toString(), 'PRIVATE_TRANSCRIPT tokens 123\n');
  assert.notEqual(invoke([...args, target]).status, 0);
});
