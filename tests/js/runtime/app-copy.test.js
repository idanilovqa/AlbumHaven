// The page side of the Android app's copy: registration only inside a shell that offers it, saving the
// view when the app leaves the screen, server confirmation, the offline read-only state and deletion.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createAppCopyClient } = require(path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'app-copy.js'));

function setup({ marker = null, account = 'acct-a', answer = async () => ({ ok: true, status: 200, type: 'basic', json: async () => ({ account }) }) } = {}) {
  const listeners = new Map();
  const notice = { hidden: true };
  const timers = [];
  const posted = [];
  const reported = [];
  const registration = {
    active: {
      postMessage(message, [port]) {
        posted.push(message);
        port.postMessage({ stored: message.type === 'save' });
        port.close();
      },
      scriptURL: 'https://sandbox9.albumhaven.org/app-copy-worker.js',
    },
    unregistered: false,
    async unregister() { this.unregistered = true; return true; },
  };
  const env = {
    readOnlyCalls: [],
    registered: [],
    reloads: 0,
    probes: 0,
  };
  const document = {
    visibilityState: 'visible',
    querySelector: selector => (selector === 'meta[name="album-haven-app-copy"]' && marker
      ? { getAttribute: name => ({ content: marker, 'data-account': 'acct-a' })[name] } : null),
    getElementById: id => (id === 'app-copy-offline-notice' ? notice : null),
    addEventListener: (name, listener) => listeners.set(`document:${name}`, listener),
  };
  const client = createAppCopyClient({
    document,
    window: { addEventListener: (name, listener) => listeners.set(`window:${name}`, listener) },
    navigator: {
      serviceWorker: {
        async register(url, options) { env.registered.push({ url, options }); return registration; },
        async getRegistration() { return env.registered.length || env.hadRegistration ? registration : undefined; },
      },
    },
    location: { href: 'https://sandbox9.albumhaven.org/?artist=Broadcast', reload: () => { env.reloads += 1; } },
    fetch: async (url, options) => { env.probes += 1; env.lastProbe = { url, options }; return answer(); },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
    capabilities: () => ({ setReadOnly: on => env.readOnlyCalls.push(on) }),
    MessageChannel,
  });
  const shell = { report: async stored => { reported.push(stored); } };
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  return { client, env, listeners, notice, timers, posted, reported, registration, shell, document, settle };
}

test('a page loaded from the network is not a copy and asks nothing of the server', async () => {
  const { client, env, settle } = setup({ marker: 'network' });
  await settle();
  assert.equal(client.startedFromCopy, false);
  assert.equal(env.probes, 0);
  assert.equal(client.isReadOnly(), false);
});

test('inside a shell that offers app copies the worker is registered at the origin root', async () => {
  const { client, env, shell, posted, reported, settle } = setup();
  client.adoptShell({ forget: false }, shell);
  await settle();
  assert.deepEqual(env.registered, [{ url: '/app-copy-worker.js', options: { scope: '/', updateViaCache: 'none' } }]);
  assert.deepEqual(posted, [{ type: 'status' }]);
  assert.deepEqual(reported, [false]);
});

test('a shell without app copies gets no worker, and one left from before is removed with its copy', async () => {
  const { client, env, posted, registration, settle } = setup();
  env.hadRegistration = true;
  client.adoptShell(null);
  await settle();
  assert.deepEqual(env.registered, []);
  assert.deepEqual(posted, [{ type: 'forget' }]);
  assert.equal(registration.unregistered, true);
});

test('leaving the screen keeps the current view in the copy and tells the shell', async () => {
  const { client, listeners, document, shell, posted, reported, settle } = setup({ marker: 'network' });
  client.adoptShell({}, shell);
  await settle();
  document.visibilityState = 'hidden';
  listeners.get('document:visibilitychange')();
  await settle();
  assert.deepEqual(posted.at(-1), { type: 'save', url: 'https://sandbox9.albumhaven.org/?artist=Broadcast' });
  assert.deepEqual(reported.at(-1), true);
});

test('IAR-003: a copy confirms its account with the server and then brings the view up to date', async () => {
  const { client, env, settle } = setup({ marker: 'cache' });
  let reconciled = 0;
  assert.equal(client.startedFromCopy, true);
  await settle();
  assert.equal(env.lastProbe.url, '/app-copy/account');
  assert.equal(env.lastProbe.options.cache, 'no-store');
  assert.equal(env.lastProbe.options.redirect, 'manual');
  // The runtime may register after the server answered; it still reconciles once.
  client.onServerAnswer(() => { reconciled += 1; });
  assert.equal(reconciled, 1);
  assert.equal(client.isReadOnly(), false);
});

test('IAR-005: unreachable, the copy is read-only with its notice until the server answers', async () => {
  let online = false;
  const { client, env, notice, timers, listeners, settle } = setup({
    marker: 'cache',
    answer: async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, type: 'basic', json: async () => ({ account: 'acct-a' }) };
    },
  });
  let reconciled = 0;
  client.onServerAnswer(() => { reconciled += 1; });
  await settle();
  assert.equal(client.isReadOnly(), true);
  assert.equal(notice.hidden, false);
  assert.deepEqual(env.readOnlyCalls, [true]);
  assert.equal(reconciled, 0);
  assert.ok(timers.length >= 1);

  // A retry that still fails waits longer; the next one succeeds without a reload.
  await timers.at(-1).callback();
  const delays = timers.map(timer => timer.delay);
  assert.ok(delays[1] > delays[0]);
  online = true;
  listeners.get('window:online')();
  await settle();
  assert.equal(client.isReadOnly(), false);
  assert.equal(notice.hidden, true);
  assert.deepEqual(env.readOnlyCalls, [true, false]);
  assert.equal(reconciled, 1);
  assert.equal(env.reloads, 0);
});

test('a server error is treated as not answering yet', async () => {
  const { client, settle } = setup({ marker: 'cache', answer: async () => ({ ok: false, status: 503, type: 'basic' }) });
  await settle();
  assert.equal(client.isReadOnly(), true);
});

test('IAR-006: a copy for a signed-out session or another account is deleted and the page reloads', async () => {
  for (const answer of [
    async () => ({ ok: false, status: 0, type: 'opaqueredirect' }),
    async () => ({ ok: false, status: 401, type: 'basic' }),
    async () => ({ ok: true, status: 200, type: 'basic', json: async () => ({ account: 'acct-b' }) }),
  ]) {
    const { env, posted, settle } = setup({ marker: 'cache', answer });
    env.hadRegistration = true;
    await settle();
    assert.deepEqual(posted, [{ type: 'forget' }]);
    assert.equal(env.reloads, 1);
  }
});

test('IAR-006: the shell asks to forget after a sandbox switch it could not announce', async () => {
  const { client, shell, posted, reported, env, settle } = setup({ marker: 'cache' });
  await settle();
  client.adoptShell({ forget: true }, shell);
  await settle();
  assert.deepEqual(posted.at(-1), { type: 'forget' });
  assert.deepEqual(reported.at(-1), false);
  assert.equal(env.reloads, 1);
});

test('the shell\'s forget command deletes the copy before it switches sandbox', async () => {
  const { client, shell, posted, reported, settle } = setup({ marker: 'network' });
  client.adoptShell({}, shell);
  await settle();
  assert.deepEqual(await client.forget(), {});
  assert.deepEqual(posted.at(-1), { type: 'forget' });
  assert.deepEqual(reported.at(-1), false);
});

test('nothing is saved while the copy is read-only', async () => {
  const { client, listeners, document, shell, posted, settle } = setup({ marker: 'cache', answer: async () => { throw new TypeError('offline'); } });
  client.adoptShell({}, shell);
  await settle();
  document.visibilityState = 'hidden';
  listeners.get('document:visibilitychange')();
  await settle();
  assert.ok(!posted.some(message => message.type === 'save'));
});
