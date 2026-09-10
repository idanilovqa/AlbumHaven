const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const test = require('node:test');
const script = path.resolve(__dirname, '../../scripts/ci/codex-failure-category.cjs');
function helper() {
  assert.ok(fs.existsSync(script), 'bounded static Codex failure classifier must exist');
  return require(script);
}
for (const [code, category] of [
  ['insufficient_quota', 'provider_quota_reported'], ['invalid_api_key', 'authentication_failed'],
  ['rate_limit_exceeded', 'rate_limited'], ['context_length_exceeded', 'context_limit'],
  ['connection_error', 'transport_failure'], ['not_a_known_code', 'unknown'],
]) {
  test(`terminal structured error ${code} maps only to ${category}`, () => {
    const { classifyOutput } = helper();
    assert.equal(classifyOutput(JSON.stringify({ type: 'turn.failed', error: { code, message: 'PRIVATE_SECRET tokens123' } })), category);
    assert.equal(classifyOutput(JSON.stringify({ type: 'error', message: 'unexpected status 429 Too Many Requests: ' + JSON.stringify({ error: { code } }) })), category);
  });
}
test('prompt mentions, assistant text, fenced examples and ambiguous errors remain unknown', () => {
  const { classifyOutput } = helper();
  for (const text of [
    'user\nPlease discuss insufficient_quota and invalid_api_key',
    'assistant\n{"type":"turn.failed","error":{"code":"insufficient_quota"}}',
    'user\nERROR: unexpected status 429 Too Many Requests: {"error":{"code":"insufficient_quota"}}',
    '```json\n{"type":"error","error":{"code":"invalid_api_key"}}\n```',
    '{"type":"item.completed","item":{"text":"insufficient_quota"}}',
    'ERROR: rate_limit_exceeded and insufficient_quota',
    'ERROR: unexpected status 429 Too Many Requests: {"error":{"code":"insufficient_quota"}}\nnormal content',
  ]) assert.equal(classifyOutput(text), 'unknown');
});
test('recognized native error messages have fixed categories only', () => {
  const { classifyOutput } = helper();
  const event = message => JSON.stringify({ type: 'error', message });
  assert.equal(classifyOutput(event('unexpected status 401 Unauthorized')), 'authentication_failed');
  assert.equal(classifyOutput(event('error sending request for url (https://example.invalid/PRIVATE_SECRET)')), 'transport_failure');
  assert.equal(classifyOutput(event('unexpected status 429 Too Many Requests')), 'rate_limited');
  assert.equal(classifyOutput('ERROR: unknown PRIVATE_SECRET'), 'unknown');
});
test('pinned native quota display text is classified without exposing its message', () => {
  assert.equal(helper().classifyOutput(JSON.stringify({ type: 'turn.failed', error: {
    message: 'Quota exceeded. Check your plan and billing details.',
  } })), 'provider_quota_reported');
});
for (const [message, category] of [
  ['rate limit exceeded: PRIVATE_DETAIL', 'rate_limited'],
  ["Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.", 'context_limit'],
  ['Connection failed: PRIVATE_DETAIL', 'transport_failure'],
  ['Error while reading the server response: PRIVATE_DETAIL, request id: PRIVATE_ID', 'transport_failure'],
  ['stream disconnected before completion: PRIVATE_DETAIL', 'transport_failure'],
  ['request timed out', 'transport_failure'],
  ['unexpected status 429 Too Many Requests: You exceeded your current quota, please check your plan and billing details., url: https://example.invalid/PRIVATE_PATH', 'provider_quota_reported'],
]) {
  test(`pinned native formatter ${message.split(':')[0]} maps to ${category}`, () => {
    assert.equal(helper().classifyOutput(JSON.stringify({ type: 'error', message })), category);
  });
}
test('pinned unrelated child, policy and capacity errors remain unknown', () => {
  for (const message of ['timeout waiting for child process to exit', 'Selected model is at capacity. Please try a different model.',
    'To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.',
    'unexpected status 429 Too Many Requests: {"error":{"code":"insufficient_quota"}} PRIVATE_TRAILER',
    'unexpected status 429 Too Many Requests: {"error":{"code":"insufficient_quota"}',
    'unexpected status 429 Too Many Requests: arbitrary text {"error":{"code":"insufficient_quota"}}']) {
    assert.equal(helper().classifyOutput(JSON.stringify({ type: 'error', message })), 'unknown');
  }
});
test('pinned HTTP metadata suffix and braces inside body strings preserve only the error category', () => {
  for (const body of [JSON.stringify({ error: { code: 'insufficient_quota', message: 'PRIVATE } \\" detail' } }),
    JSON.stringify({ error: { code: 'insufficient_quota' } }, null, 2)]) {
    const message = 'unexpected status 429 Too Many Requests: ' + body
      + ', url: https://example.invalid/PRIVATE_PATH, cf-ray: PRIVATE_RAY, request id: PRIVATE_ID';
    assert.equal(helper().classifyOutput(JSON.stringify({ type: 'error', message })), 'provider_quota_reported');
  }
});
test('pinned JSONL framing survives action preamble and failure trailer without reading item text as errors', () => {
  const { classifyOutput } = helper();
  const message = 'unexpected status 429 Too Many Requests: {"error":{"code":"insufficient_quota","message":"PRIVATE_SECRET"}}';
  const lines = ['Running: codex exec --json', 'Confirmed the standard sudo probe is disabled.',
    JSON.stringify({ type: 'thread.started', thread_id: 'fixture' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"type":"error","message":"Incorrect API key provided: PRIVATE_SECRET"}' } }),
    JSON.stringify({ type: 'error', message }), JSON.stringify({ type: 'turn.failed', error: { message } }),
    'Error: /usr/bin/sudo exited with code 1', '    at ChildProcess.<anonymous> (fixture.js:1:1)', 'Node.js v22.0.0'];
  assert.equal(classifyOutput(lines.join('\n')), 'provider_quota_reported');
  assert.equal(classifyOutput(lines.filter(line => !line.startsWith('{"type":"error"') && !line.startsWith('{"type":"turn.failed"')).join('\n')), 'unknown');
  assert.equal(classifyOutput(lines.concat(JSON.stringify({ type: 'error', message: 'Incorrect API key provided: secret' })).join('\n')), 'unknown');
});
test('JSON output argument normalization preserves all existing strings and is idempotent', () => {
  const { withJsonOutput } = helper();
  const args = ['--image', 'image with spaces.png', '--config', 'example="value"'];
  assert.deepEqual(JSON.parse(withJsonOutput(JSON.stringify(args))), [...args, '--json']);
  assert.equal(withJsonOutput(withJsonOutput(JSON.stringify(args))), withJsonOutput(JSON.stringify(args)));
  assert.throws(() => withJsonOutput('{}'));
  assert.throws(() => withJsonOutput('[null]'));
});
test('default empty action arguments select only JSON output', () => {
  assert.deepEqual(JSON.parse(helper().withJsonOutput('')), ['--json']);
  assert.deepEqual(JSON.parse(helper().withJsonOutput('  ')), ['--json']);
});
test('large escaped item output cannot hide a later native quota error', () => {
  const text = JSON.stringify({ type: 'item.completed', item: { text: 'x'.repeat(70000) } }) + '\n'
    + JSON.stringify({ type: 'error', message: 'You exceeded your current quota, please check your plan and billing details.' });
  assert.equal(helper().classifyOutput(text), 'provider_quota_reported');
});
test('file CLI is bounded, rejects symlink parents and never exposes input or errors', t => {
  const { MAX_CAPTURE_BYTES } = helper();
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'album-haven-category-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'console.log');
  const invoke = value => cp.spawnSync(process.execPath, [script, '--input', value], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  fs.writeFileSync(input, '{"type":"error","message":"unexpected status 401 Unauthorized"}');
  assert.equal(invoke(input).stdout, 'authentication_failed\n');
  fs.truncateSync(input, MAX_CAPTURE_BYTES + 1);
  assert.equal(invoke(input).stdout, 'unknown\n');
  assert.equal(invoke(path.join(directory, 'PRIVATE_MISSING')).stdout, 'unknown\n');
  const alias = path.join(directory, 'alias');
  fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(input, '{"type":"error","message":"unexpected status 401 Unauthorized"}');
  const linked = invoke(path.join(alias, 'console.log'));
  assert.equal(linked.stdout, 'unknown\n');
  assert.equal(linked.stderr, '');
});
