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
