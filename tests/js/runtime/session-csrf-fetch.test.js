const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const sourcePath = path.join(
  repoRoot,
  'music_app',
  'static',
  'js',
  'runtime',
  'session-csrf-fetch.js',
);

function load(cookie = '__Host-album_haven_csrf=csrf-value') {
  const calls = [];
  const window = {
    location: { href: 'https://music.test/albums', origin: 'https://music.test' },
    fetch: async (...args) => {
      calls.push(args);
      return { ok: true };
    },
  };
  const context = { window, document: { cookie }, URL, Headers };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return { window, calls };
}

test('same-origin unsafe fetch receives the readable session CSRF cookie as a header', async () => {
  const { window, calls } = load();

  await window.fetch('/refresh-api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].headers.get('Content-Type'), 'application/json');
  assert.equal(calls[0][1].headers.get('X-Album-Haven-CSRF'), 'csrf-value');
  assert.equal(calls[0][1].credentials, 'same-origin');
});

test('safe or cross-origin fetches never receive the CSRF header', async () => {
  const { window, calls } = load();

  await window.fetch('/status');
  await window.fetch('https://example.test/write', { method: 'POST' });

  assert.equal(calls[0][1], undefined);
  assert.equal(calls[1][1].headers, undefined);
});

test('missing CSRF cookie does not synthesize a credential', async () => {
  const { window, calls } = load('other=value');

  await window.fetch('/refresh-api', { method: 'POST' });

  assert.equal(calls[0][1].headers, undefined);
});

test('URL object mutation inputs never disclose CSRF across origins', async () => {
  const { window, calls } = load();
  const external = new URL('https://external.test/write');
  const local = new URL('https://music.test/write');
  await window.fetch(external, { method: 'POST' });
  await window.fetch(local, { method: 'POST' });
  assert.equal(calls[0][0], external);
  assert.equal(calls[0][1].headers, undefined);
  assert.equal(calls[1][1].headers.get('X-Album-Haven-CSRF'), 'csrf-value');
});

for (const credentials of ['omit', 'include', 'same-origin']) {
  test(`Request mutation retains its ${credentials} credentials policy`, async () => {
    const { window, calls } = load();
    const request = new Request('https://music.test/write', { method: 'POST', credentials });
    await window.fetch(request);
    assert.equal(calls[0][0], request);
    assert.equal(calls[0][1].credentials, credentials);
    assert.equal(calls[0][1].headers.get('X-Album-Haven-CSRF'), 'csrf-value');
    await window.fetch(request, { credentials: 'omit' });
    assert.equal(calls[1][1].credentials, 'omit');
  });
}

test('external Request preserves all original credentials and headers', async () => {
  const { window, calls } = load();
  const request = new Request('https://external.test/write', {
    method: 'POST', credentials: 'omit', headers: { 'X-Caller': 'value' },
  });
  await window.fetch(request);
  assert.equal(calls[0][0], request);
  assert.equal(calls[0][1], undefined);
  assert.equal(request.headers.has('X-Album-Haven-CSRF'), false);
});
