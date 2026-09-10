import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerAuthentication } from '../../scripts/playwright-worker-authentication.mjs';

const sessionCookie = { name: '__Host-album_haven_session', value: 'test-session', domain: 'localhost', path: '/' };
const csrfCookie = { name: '__Host-album_haven_csrf', value: 'test-csrf', domain: 'localhost', path: '/' };

function fixture({ cookies = [sessionCookie, csrfCookie], rejectLogin = false } = {}) {
  const calls = [];
  const page = {};
  const context = {
    async newPage() { return page; },
    async storageState() { return { cookies, origins: [{ origin: 'https://localhost', localStorage: [{ name: 'cached-view', value: 'stale' }] }] }; },
    async close() { calls.push('close'); },
  };
  const auth = createWorkerAuthentication({
    browser: { async newContext(options) { calls.push(['context', options]); return context; } },
    baseURL: 'https://localhost',
    viewport: { width: 1280, height: 720 },
    async authenticate(actualPage) {
      assert.equal(actualPage, page);
      calls.push('login');
      if (rejectLogin) throw new Error('login failed');
    },
  });
  return { auth, calls };
}

test('runner authenticates once for concurrent and later context requests', async () => {
  const { auth, calls } = fixture();
  const states = await Promise.all([auth.getStorageState(), auth.getStorageState()]);
  states.push(await auth.getStorageState());
  assert.equal(calls.filter((call) => call === 'login').length, 1);
  assert.equal(calls.filter((call) => call === 'close').length, 1);
  assert.equal(calls.filter((call) => Array.isArray(call)).length, 1);
  for (const state of states) assert.deepEqual(state, { cookies: [sessionCookie, csrfCookie], origins: [] });
  assert.notEqual(states[0], states[1]);
  states[0].cookies[0].value = 'consumer-changed';
  assert.equal((await auth.getStorageState()).cookies[0].value, sessionCookie.value);
});

test('runner restores only auth cookies and never carries application storage into tests', async () => {
  const { auth } = fixture({ cookies: [sessionCookie, csrfCookie, { name: 'unrelated', value: 'cached', domain: 'localhost', path: '/' }] });
  assert.deepEqual(await auth.getStorageState(), { cookies: [sessionCookie, csrfCookie], origins: [] });
});

test('separate runners authenticate independently', async () => {
  const first = fixture();
  const second = fixture();
  await first.auth.getStorageState();
  await second.auth.getStorageState();
  assert.equal(first.calls.filter((call) => call === 'login').length, 1);
  assert.equal(second.calls.filter((call) => call === 'login').length, 1);
});

test('failed authentication closes its context and fails all consumers without repeated login', async () => {
  const { auth, calls } = fixture({ rejectLogin: true });
  await assert.rejects(auth.getStorageState());
  await assert.rejects(auth.getStorageState());
  assert.equal(calls.filter((call) => call === 'login').length, 1);
  assert.equal(calls.filter((call) => call === 'close').length, 1);
});

for (const cookies of [[sessionCookie], [csrfCookie], []]) {
  test(`incomplete authentication state (${cookies.map((cookie) => cookie.name).join(',') || 'empty'}) is rejected`, async () => {
    const { auth, calls } = fixture({ cookies });
    await assert.rejects(auth.getStorageState(), /authentication|cookie|session/i);
    assert.equal(calls.filter((call) => call === 'close').length, 1);
  });
}
