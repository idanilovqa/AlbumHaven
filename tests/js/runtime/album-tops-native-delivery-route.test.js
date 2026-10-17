'use strict';
// Node routing unit controls only. Never launch a browser/server, import product
// modules, execute delivered JavaScript, or substitute product success owners.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../../..');
const ORIGIN = 'https://albumhaven.test';
const ENTRY = '/__album_tops_fixture__/fixture-entry.mjs';
const FIXTURES = ['actual-request', 'direct-retirement', 'navigation', 'queued-completion'];
// Reviewed route allowlist probes; graph discovery remains solely in the real
// fixture handler. These are response-body comparisons, not fixed source hashes.
const MODULES = [
  '/music_app/static/js/album-tops/app.mjs',
  '/music_app/static/js/album-tops/builder.mjs',
  '/music_app/static/js/album-tops/draft.mjs',
  '/music_app/static/js/album-tops/index.mjs',
  '/music_app/static/js/album-tops/model.mjs',
  '/music_app/static/js/album-tops/mutation-notice.mjs',
  '/music_app/static/js/album-tops/progress.mjs',
  '/music_app/static/js/album-tops/sharing.mjs',
  '/music_app/static/js/home-friends/edit-request-notifications.mjs',
  '/music_app/static/js/home-friends/header-layout.mjs',
  '/music_app/static/js/home-friends/model.mjs',
  '/music_app/static/js/home-friends/native-controls.mjs',
  '/music_app/static/js/home-friends/native-dialog.mjs',
  '/music_app/static/js/home-friends/resource-sharing.mjs',
  '/music_app/static/js/home-friends/resource-target.mjs',
  '/music_app/static/js/home-friends/shared-header.mjs',
  '/music_app/static/js/playlists/native-creation.mjs',
  '/music_app/static/js/playlists/native-mutation-status.mjs',
  '/music_app/static/js/playlists/reorder.mjs',
];

async function captureRoute(fixture) {
  const stop = new Error('Intentional unit-test stop before browser execution');
  const calls = [];
  let handler;
  const page = new Proxy({
    on(event, listener) {
      assert.ok(['pageerror', 'console'].includes(event));
      assert.equal(typeof listener, 'function');
      calls.push(['on', event]);
    },
    async route(pattern, callback) {
      assert.equal(pattern, ORIGIN + '/**');
      assert.equal(handler, undefined, 'exactly one route registration');
      assert.equal(typeof callback, 'function');
      handler = callback;
      calls.push(['route', pattern]);
    },
    async goto(url) {
      assert.equal(url, ORIGIN + '/');
      assert.equal(typeof handler, 'function');
      calls.push(['goto', url]);
      throw stop;
    },
  }, {
    get(target, key) {
      if (Object.hasOwn(target, key)) return target[key];
      assert.fail('Forbidden browser API reached: ' + String(key));
    },
  });
  await assert.rejects(() => fixture.mount(page), error => error === stop);
  assert.deepEqual(calls, [
    ['on', 'pageerror'], ['on', 'console'],
    ['route', ORIGIN + '/**'], ['goto', ORIGIN + '/'],
  ]);
  return async function response(url, {method = 'GET', resourceType = 'script'} = {}) {
    const fulfilled = [];
    await handler({
      request: () => ({url: () => url, method: () => method, resourceType: () => resourceType}),
      fulfill: async result => { fulfilled.push(result); },
    });
    assert.equal(fulfilled.length, 1, 'request must fulfill exactly once: ' + url);
    return fulfilled[0];
  };
}

function assertJavaScript(result, expected) {
  assert.equal(result.status ?? 200, 200);
  assert.equal(result.contentType, 'text/javascript; charset=utf-8');
  assert.equal(result.body, expected, 'deliver exact file text without transformation');
}
function assertRejected(result) {
  assert.deepEqual(result, {status: 404, contentType: 'text/plain', body: 'Unknown fixture resource'});
}

for (const name of FIXTURES) {
  test(name + ': unchanged native delivery handler, routing only', async t => {
    assert.equal(path.resolve(process.env.ALBUM_TOP_TEST_ROOT || ROOT), ROOT,
      'ALBUM_TOP_TEST_ROOT must be unset or match the staged repository');
    const dir = path.join(ROOT, 'tests/components/album-tops-membership', name);
    const fixture = require(path.join(dir, 'browser-fixture.cjs'));
    assert.equal(fs.realpathSync(fixture.root), fs.realpathSync(ROOT));
    const route = await captureRoute(fixture);

    await t.test('fixed virtual entry returns exact entry bytes and JavaScript MIME', async () => {
      assertJavaScript(await route(ORIGIN + ENTRY), fs.readFileSync(path.join(dir, 'fixture-entry.jsx'), 'utf8'));
    });
    await t.test('reviewed reachable native module URLs return exact source bytes and JavaScript MIME', async () => {
      for (const url of MODULES) {
        assertJavaScript(await route(ORIGIN + url), fs.readFileSync(path.join(ROOT, url.slice(1)), 'utf8'));
      }
    });
    await t.test('unknown modules and reserved paths reject even document requests', async () => {
      for (const url of [
        '/music_app/static/js/album-tops/not-a-module.mjs',
        '/music_app/static/js/album-tops/index.js',
        '/music_app/static/js/album-tops/index.mjs/extra',
        '/music_app/static/js/album-tops/index.mjs.map',
        '/music_app/static/js/runtime/album-tops-react-bridge.js',
        '/__album_tops_fixture__/fixture-entry.jsx',
        '/__album_tops_fixture__/unknown', '/music_app/unknown',
        '/unknown.mjs', '/unknown.js', '/unknown.jsx', '/unknown.cjs',
        '/UNKNOWN.MJS', '/unknown.mjs/extra',
      ]) for (const resourceType of ['script', 'document']) {
        assertRejected(await route(ORIGIN + url, {resourceType}));
      }
    });
    await t.test('query-bearing entry and module URLs reject, never HTML', async () => {
      for (const url of [ENTRY, ...MODULES]) for (const resourceType of ['script', 'document']) {
        assertRejected(await route(ORIGIN + url + '?v=1', {resourceType}));
      }
    });
    await t.test('encoded, malformed, and backslash paths reject before fallback', async () => {
      for (const url of [
        ORIGIN + '/%61ccount', ORIGIN + '/%', ORIGIN + '/%ZZ',
        ORIGIN + '/music_app/static/js/album-tops/%69ndex.mjs',
        ORIGIN + '/__album_tops_fixture__/%66ixture-entry.mjs',
        ORIGIN + '/music_app%2fstatic%2fjs%2falbum-tops%2findex.mjs',
        ORIGIN + '/%252e%252e/account', ORIGIN + '/account\\settings',
        'not an absolute URL',
      ]) for (const resourceType of ['document', 'script']) {
        assertRejected(await route(url, {resourceType}));
      }
    });
    await t.test('GET-only enforcement applies to entry, modules, and document fallback', async () => {
      for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get']) {
        for (const url of [ENTRY, ...MODULES, '/', '/account?tab=profile']) {
          for (const resourceType of ['document', 'script']) {
            assertRejected(await route(ORIGIN + url, {method, resourceType}));
          }
        }
      }
    });
    await t.test('ordinary GET document navigation preserves exact HTML including queries', async () => {
      for (const url of ['/', '/account', '/account?tab=profile', '/tops/a/b?view=detail']) {
        const result = await route(ORIGIN + url, {resourceType: 'document'});
        assert.equal(result.status ?? 200, 200);
        assert.equal(result.contentType, 'text/html');
        assert.equal(result.body, fixture.html);
      }
    });
    await t.test('non-document resources never receive HTML fallback', async () => {
      for (const resourceType of ['script', 'fetch', 'xhr', 'stylesheet', 'image', 'other']) {
        for (const url of ['/', '/account', '/account?tab=profile', '/unknown']) {
          assertRejected(await route(ORIGIN + url, {resourceType}));
        }
      }
    });
  });
}
