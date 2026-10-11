const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateEnvironment, permittedRequest, sanitizeTiming, TARGET } = require('../e2e/support/sandbox3ReadOnlyGuard.cjs');
const env = { ALBUM_HAVEN_SANDBOX3_BENCHMARK_USERNAME: 'account', ALBUM_HAVEN_SANDBOX3_BENCHMARK_PASSWORD: 'secret' };
test('requires explicit credentials and rejects CI or a different target', () => {
  assert.equal(validateEnvironment(env).baseURL, TARGET);
  assert.throws(() => validateEnvironment({ ...env, CI: 'true' }));
  assert.throws(() => validateEnvironment({}));
  for (const baseURL of ['http://sandbox3.albumhaven.org', TARGET + '/path', 'https://sandbox1.albumhaven.org', TARGET + '.evil.test']) {
    assert.throws(() => validateEnvironment(env, baseURL));
  }
});
test('blocks writes and foreign origins; login POST is narrowly scoped', () => {
  for (const method of ['GET', 'HEAD']) assert.equal(permittedRequest(TARGET + '/view-data', method, false), true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(permittedRequest(TARGET + '/view-data', method, false), false);
  assert.equal(permittedRequest(TARGET + '/login', 'POST', true), true);
  assert.equal(permittedRequest(TARGET + '/login', 'POST', false), false);
  assert.equal(permittedRequest(TARGET + '/scan', 'POST', true), false);
  assert.equal(permittedRequest('https://foreign.test/', 'GET', true), false);
  assert.equal(permittedRequest('invalid', 'GET', false), false);
});
test('timing record drops all private strings and unknown fields', () => {
  assert.deepEqual(sanitizeTiming({ scenario: 'search', durationMs: 12.345, passed: true, query: 'private', payload: { secret: true } }), { scenario: 'search', durationMs: 12.3, passed: true, budgetMs: null });
  assert.throws(() => sanitizeTiming({ scenario: 'private artist', durationMs: 2 }));
  assert.throws(() => sanitizeTiming({ scenario: 'search', durationMs: Infinity }));
});
test('installed guard aborts writes and closes login exception', async () => {
  const { installReadOnlyGuard } = require('../e2e/support/sandbox3ReadOnlyGuard.cjs');
  let handler;
  const guard = await installReadOnlyGuard({ route: async (_, callback) => { handler = callback; } }, true);
  let continued = 0;
  let aborted = 0;
  const request = method => ({ request: () => ({ url: () => TARGET + '/login', method: () => method }), continue: async () => { continued += 1; }, abort: async () => { aborted += 1; } });
  await handler(request('POST'));
  guard.finishAuthentication();
  await handler(request('POST'));
  assert.equal(continued, 1);
  assert.equal(aborted, 1);
  assert.throws(() => guard.assertClean());
});
test('benchmark config fixes one worker and disables captured media', () => {
  const originalUsername = process.env.ALBUM_HAVEN_SANDBOX3_BENCHMARK_USERNAME;
  const originalPassword = process.env.ALBUM_HAVEN_SANDBOX3_BENCHMARK_PASSWORD;
  const originalCI = process.env.CI;
  Object.assign(process.env, env);
  delete process.env.CI;
  try {
    const config = require('../../playwright.sandbox3-read-only-benchmark.config.cjs');
    assert.equal(config.workers, 1);
    assert.equal(config.use.baseURL, TARGET);
    for (const field of ['screenshot', 'trace', 'video']) assert.equal(config.use[field], 'off');
    assert.equal(config.use.serviceWorkers, 'block');
    assert.equal(config.outputDir, './test-results/sandbox3-read-only');
  } finally {
    for (const [key, value] of Object.entries({ ALBUM_HAVEN_SANDBOX3_BENCHMARK_USERNAME: originalUsername, ALBUM_HAVEN_SANDBOX3_BENCHMARK_PASSWORD: originalPassword, CI: originalCI })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
