const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../e2e/helpers/layoutPreferenceIsolation.js')).href);

const copy = value => JSON.parse(JSON.stringify(value));
function fixture() {
  let account = 7, session = 'owned-session', listener, pendingSave = null;
  const state = { web_desktop: { combineSimilarArtists: {}, albumOpenMode: 'modal' }, mobile: { mobileGridColumns: 3 } };
  const requests = [];
  const page = {
    url: () => 'http://127.0.0.1:6210/',
    context: () => ({ cookies: async () => [
      { name: '__Host-album_haven_session', value: session, domain: '127.0.0.1', path: '/' },
      { name: '__Host-album_haven_csrf', value: 'csrf-token', domain: '127.0.0.1', path: '/' },
    ] }),
    on(event, callback) { assert.equal(event, 'response'); listener = callback; },
    off(event, callback) { assert.equal(callback, listener); listener = null; },
    async waitForFunction(predicate) {
      assert.match(predicate.toString(), /syncState === 'saved'/);
      if (pendingSave) { pendingSave(); pendingSave = null; }
    },
    request: {
      async get(_url, options) { assert.equal(options.timeout, 10000); return { ok: () => true, json: async () => ({ account_id: account, profiles: copy(state), load_failed: false }) }; },
      async put(url, options) {
        assert.equal(options.timeout, 10000);
        requests.push({ url, ...options });
        Object.assign(state[options.data.profile], copy(options.data.changes));
        return { ok: () => true, json: async () => ({ profile: options.data.profile, preferences: copy(state[options.data.profile]) }) };
      },
    },
  };
  function save(profile, changes, { pending = false } = {}) {
    const finish = () => {
      Object.assign(state[profile], copy(changes));
      listener({ url: () => `${page.url()}account/layout-preferences`, ok: () => true,
        request: () => ({ method: () => 'PUT', postDataJSON: () => ({ profile, changes }) }),
        json: async () => { throw new Error('A browser keepalive response body must not be read'); },
      });
    };
    if (pending) pendingSave = finish;
    else finish();
  }
  return { page, state, requests, save, changeAccount: () => { account += 1; }, changeSession: () => { session = 'different-session'; }, hasListener: () => Boolean(listener) };
}

test('layout teardown settles a pending Combine save and restores it after a primary failure', async () => {
  const { createLayoutPreferenceIsolation, restoreLayoutPreferencesAfterTest } = await load();
  const f = fixture();
  const isolation = createLayoutPreferenceIsolation(f.page);
  await isolation.capture();
  const primary = new Error('Original Combine assertion failed');
  await assert.rejects(async () => {
    try {
      f.save('web_desktop', { combineSimilarArtists: { 'Neal Morse': true } }, { pending: true });
      throw primary;
    } finally { await restoreLayoutPreferencesAfterTest(isolation, [primary]); }
  }, error => error === primary);
  assert.deepEqual(f.state.web_desktop.combineSimilarArtists, {});
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].headers['X-Album-Haven-Account'], '7');
  assert.equal(f.requests[0].headers['X-Album-Haven-CSRF'], 'csrf-token');
  assert.equal(f.requests[0].headers.Origin, 'http://127.0.0.1:6210');
  assert.deepEqual(f.requests[0].data, { profile: 'web_desktop', changes: { combineSimilarArtists: {} } });
  assert.equal(f.hasListener(), false);
  const next = createLayoutPreferenceIsolation(f.page);
  await next.capture();
  await next.restore();
  assert.equal(f.requests.length, 1, 'a fresh next test starts without the failed test’s Combine preference');
});

test('layout restoration preserves unrelated saved fields and other client profiles', async () => {
  const { createLayoutPreferenceIsolation } = await load();
  const f = fixture(), isolation = createLayoutPreferenceIsolation(f.page);
  await isolation.capture();
  f.save('web_desktop', { combineSimilarArtists: { 'Neal Morse': true } });
  f.state.web_desktop.albumOpenMode = 'page';
  f.state.mobile.mobileGridColumns = 2;
  await isolation.restore();
  assert.deepEqual(f.state.web_desktop, { combineSimilarArtists: {}, albumOpenMode: 'page' });
  assert.equal(f.state.mobile.mobileGridColumns, 2);
});

for (const change of ['changeAccount', 'changeSession']) {
  test(`layout restoration rejects ${change} without writing`, async () => {
    const { createLayoutPreferenceIsolation } = await load();
    const f = fixture(), isolation = createLayoutPreferenceIsolation(f.page);
    await isolation.capture();
    f.save('web_desktop', { combineSimilarArtists: { 'Neal Morse': true } });
    f[change]();
    await assert.rejects(isolation.restore(), /account.*changed/i);
    assert.equal(f.requests.length, 0);
    assert.equal(f.hasListener(), false);
  });
}

test('layout restoration rejects an overlapping preference write', async () => {
  const { createLayoutPreferenceIsolation } = await load();
  const f = fixture(), isolation = createLayoutPreferenceIsolation(f.page);
  await isolation.capture();
  f.save('web_desktop', { combineSimilarArtists: { 'Neal Morse': true } });
  f.state.web_desktop.combineSimilarArtists = { 'Another Artist': true };
  await assert.rejects(isolation.restore(), /outside this test/);
  assert.equal(f.requests.length, 0);
});

test('layout cleanup aggregates its failure without losing the primary error', async () => {
  const { restoreLayoutPreferencesAfterTest } = await load();
  const primary = new Error('Original assertion'), cleanup = new Error('Restore failed');
  const isolation = { async restore() { throw cleanup; } };
  await assert.rejects(restoreLayoutPreferencesAfterTest(isolation, [primary]), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, cleanup]);
    return true;
  });
  await assert.rejects(restoreLayoutPreferencesAfterTest(isolation), error => error === cleanup);
});

test('layout restore changes are limited to observed changed preference families', async () => {
  const { buildLayoutRestoreChanges } = await load();
  assert.deepEqual(buildLayoutRestoreChanges({ albumOpenMode: 'modal' }, {}, { albumOpenMode: 'page' }), {});
  assert.deepEqual(buildLayoutRestoreChanges({ albumOpenMode: 'modal' }, { albumOpenMode: 'modal' }, { albumOpenMode: 'page' }), {});
});

test('canonical JSON object key order does not masquerade as a concurrent preference change', async () => {
  const { buildLayoutRestoreChanges } = await load();
  const original = { combineSimilarArtists: { 'Neal Morse': false, 'Cosmic Cathedral': false } };
  const owned = { combineSimilarArtists: { 'Neal Morse': true, 'Cosmic Cathedral': false } };
  const current = { combineSimilarArtists: { 'Cosmic Cathedral': false, 'Neal Morse': true } };
  assert.deepEqual(buildLayoutRestoreChanges(original, owned, current), original);
  assert.throws(() => buildLayoutRestoreChanges(original, owned, {
    combineSimilarArtists: { 'Cosmic Cathedral': true, 'Neal Morse': true },
  }), /outside this test/);
});
