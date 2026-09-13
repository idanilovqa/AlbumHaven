const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../e2e/helpers/appearancePreferenceIsolation.js')).href;

test('Appearance isolation retains secure loopback sessions and excludes another host cookie', async () => {
  const { createAppearancePreferenceIsolation } = await import(moduleUrl);
  let otherSession = 'unrelated';
  const page = {
    url: () => 'http://127.0.0.1:5001/',
    context: () => ({ cookies: async (...args) => args.length ? [] : [
      { name: '__Host-album_haven_session', value: otherSession, domain: 'another.example', path: '/', secure: true },
      { name: '__Host-album_haven_session', value: 'owned', domain: '127.0.0.1', path: '/', secure: true },
    ] }),
    request: { get: async () => ({ ok: () => true, json: async () => ({ revision: 1, csrf_token: 'token' }) }) },
    on() {}, off() {},
  };
  const isolation = createAppearancePreferenceIsolation(page);
  await isolation.capture();
  otherSession = 'changed-unrelated';
  await isolation.restore();
});

test('Appearance cleanup restores only test-changed values using the current revision', async () => {
  const { buildAppearanceRestorePayload } = await import(moduleUrl);
  const original = { palette_id: 'navy', album_details_layout: 'classic_bar' };
  const owned = { ...original, palette_id: 'harbor-mint', revision: 2 };
  const current = { ...owned, album_details_layout: 'stacked_bar', revision: 3, csrf_token: 'fresh-token' };
  const payload = buildAppearanceRestorePayload(original, owned, current);
  assert.equal(payload.palette_id, 'navy');
  assert.equal(payload.album_details_layout, 'stacked_bar');
  assert.equal(payload.expected_revision, 3);
  assert.equal(Object.hasOwn(payload, 'csrf_token'), false);
});

test('Appearance cleanup is a no-op without a test-owned saved change', async () => {
  const { buildAppearanceRestorePayload } = await import(moduleUrl);
  const original = { palette_id: 'navy' };
  assert.equal(buildAppearanceRestorePayload(original, original, { ...original, revision: 4, csrf_token: 'token' }), null);
});

test('Appearance cleanup rejects overlapping later changes and missing CAS or CSRF', async () => {
  const { buildAppearanceRestorePayload } = await import(moduleUrl);
  const original = { palette_id: 'navy' }, owned = { palette_id: 'harbor-mint' };
  assert.throws(() => buildAppearanceRestorePayload(original, owned, { palette_id: 'paper', revision: 3, csrf_token: 'token' }), /outside this test/);
  assert.throws(() => buildAppearanceRestorePayload(original, owned, { ...owned, csrf_token: 'token' }), /revision and CSRF/);
  assert.throws(() => buildAppearanceRestorePayload(original, owned, { ...owned, revision: 3 }), /revision and CSRF/);
});

test('Appearance cleanup refuses a changed authenticated session without a PUT', async () => {
  const { createAppearancePreferenceIsolation } = await import(moduleUrl);
  let session = 'original';
  let puts = 0;
  const page = {
    url: () => 'http://127.0.0.1:5001/',
    context: () => ({ cookies: async () => [{ name: '__Host-album_haven_session', value: session, domain: '127.0.0.1', path: '/' }] }),
    request: { get: async () => ({ ok: () => true, json: async () => ({ revision: 0, csrf_token: 'token' }) }), put: async () => { puts += 1; } },
    on() {}, off() {},
  };
  const isolation = createAppearancePreferenceIsolation(page);
  await isolation.capture();
  session = 'another-account';
  await assert.rejects(isolation.restore(), /account\/session changed/);
  assert.equal(puts, 0);
});

test('Appearance cleanup sends fresh CSRF and revision and verifies the restored server result', async () => {
  const { createAppearancePreferenceIsolation } = await import(moduleUrl);
  const original = { palette_id: 'navy', revision: 1, csrf_token: 'old-token' };
  const saved = { ...original, palette_id: 'harbor-mint', revision: 2 };
  const current = { ...saved, album_details_layout: 'stacked_bar', revision: 3, csrf_token: 'fresh-token' };
  let reads = 0, observe, sent;
  const page = {
    url: () => 'http://127.0.0.1:5001/',
    context: () => ({ cookies: async () => [{ name: '__Host-album_haven_session', value: 'owned-session', domain: '127.0.0.1', path: '/' }] }),
    request: {
      get: async () => ({ ok: () => true, json: async () => (++reads === 1 ? original : current) }),
      put: async (url, options) => {
        sent = { url, ...options };
        return { ok: () => true, json: async () => ({ ...options.data, revision: 4 }) };
      },
    },
    on(_event, listener) { observe = listener; }, off() {},
  };
  const isolation = createAppearancePreferenceIsolation(page);
  await isolation.capture();
  observe({ request: () => ({ method: () => 'PUT' }), url: () => `${page.url()}account/appearance`, ok: () => true, json: async () => saved });
  await isolation.restore();
  assert.equal(sent.url, 'http://127.0.0.1:5001/account/appearance');
  assert.equal(sent.headers['X-Album-Haven-CSRF'], 'fresh-token');
  assert.equal(sent.headers.Origin, 'http://127.0.0.1:5001');
  assert.equal(sent.headers.Cookie, '__Host-album_haven_session=owned-session');
  assert.equal(sent.data.expected_revision, 3);
  assert.equal(sent.data.palette_id, 'navy');
  assert.equal(sent.data.album_details_layout, 'stacked_bar');
});
