'use strict';
// Node routing unit controls only. Never launch a browser/server, import product
// modules, execute delivered JavaScript, or substitute product success owners.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ROOT = path.resolve(__dirname, '../../..');
const ORIGIN = 'https://albumhaven.test';
const ENTRY = '/__album_tops_fixture__/fixture-entry.mjs';
const FIXTURES = ["capacity", "full5000", "real-owner-ui", "shared-search", "create"];
const MODULES_BY_FIXTURE = {
  "capacity": [
    "/music_app/static/js/album-tops/builder.mjs",
    "/music_app/static/js/album-tops/draft.mjs",
    "/music_app/static/js/album-tops/model.mjs",
    "/music_app/static/js/album-tops/mutation-notice.mjs",
    "/music_app/static/js/album-tops/progress.mjs",
    "/music_app/static/js/home-friends/native-controls.mjs",
    "/music_app/static/js/home-friends/native-dialog.mjs",
    "/music_app/static/js/playlists/native-creation.mjs",
    "/music_app/static/js/playlists/native-mutation-status.mjs",
    "/music_app/static/js/playlists/reorder.mjs"
  ],
  "full5000": [
    "/music_app/static/js/album-tops/builder.mjs",
    "/music_app/static/js/album-tops/draft.mjs",
    "/music_app/static/js/album-tops/model.mjs",
    "/music_app/static/js/album-tops/mutation-notice.mjs",
    "/music_app/static/js/album-tops/progress.mjs",
    "/music_app/static/js/home-friends/native-controls.mjs",
    "/music_app/static/js/home-friends/native-dialog.mjs",
    "/music_app/static/js/playlists/native-creation.mjs",
    "/music_app/static/js/playlists/native-mutation-status.mjs",
    "/music_app/static/js/playlists/reorder.mjs"
  ],
  "real-owner-ui": [
    "/music_app/static/js/album-tops/app.mjs",
    "/music_app/static/js/album-tops/builder.mjs",
    "/music_app/static/js/album-tops/draft.mjs",
    "/music_app/static/js/album-tops/model.mjs",
    "/music_app/static/js/album-tops/mutation-notice.mjs",
    "/music_app/static/js/album-tops/progress.mjs",
    "/music_app/static/js/album-tops/sharing.mjs",
    "/music_app/static/js/home-friends/header-layout.mjs",
    "/music_app/static/js/home-friends/model.mjs",
    "/music_app/static/js/home-friends/native-controls.mjs",
    "/music_app/static/js/home-friends/native-dialog.mjs",
    "/music_app/static/js/home-friends/resource-sharing.mjs",
    "/music_app/static/js/home-friends/resource-target.mjs",
    "/music_app/static/js/home-friends/shared-header.mjs",
    "/music_app/static/js/playlists/native-creation.mjs",
    "/music_app/static/js/playlists/native-mutation-status.mjs",
    "/music_app/static/js/playlists/reorder.mjs"
  ],
  "shared-search": [
    "/music_app/static/js/album-tops/app.mjs",
    "/music_app/static/js/album-tops/builder.mjs",
    "/music_app/static/js/album-tops/draft.mjs",
    "/music_app/static/js/album-tops/model.mjs",
    "/music_app/static/js/album-tops/mutation-notice.mjs",
    "/music_app/static/js/album-tops/progress.mjs",
    "/music_app/static/js/album-tops/sharing.mjs",
    "/music_app/static/js/home-friends/artist-selection.mjs",
    "/music_app/static/js/home-friends/detail-projection-ui.mjs",
    "/music_app/static/js/home-friends/detail-projection.mjs",
    "/music_app/static/js/home-friends/header-layout.mjs",
    "/music_app/static/js/home-friends/model.mjs",
    "/music_app/static/js/home-friends/native-controls.mjs",
    "/music_app/static/js/home-friends/native-dialog.mjs",
    "/music_app/static/js/home-friends/resource-detail.mjs",
    "/music_app/static/js/home-friends/resource-sharing.mjs",
    "/music_app/static/js/home-friends/resource-target.mjs",
    "/music_app/static/js/home-friends/shared-header.mjs",
    "/music_app/static/js/home-friends/track-preference-ui.mjs",
    "/music_app/static/js/home-friends/track-preference.mjs",
    "/music_app/static/js/playlists/creation.mjs",
    "/music_app/static/js/playlists/filters.mjs",
    "/music_app/static/js/playlists/native-creation-form.mjs",
    "/music_app/static/js/playlists/native-creation.mjs",
    "/music_app/static/js/playlists/native-mutation-status.mjs",
    "/music_app/static/js/playlists/native-owner-scope.mjs",
    "/music_app/static/js/playlists/native-selection.mjs",
    "/music_app/static/js/playlists/reorder.mjs",
    "/music_app/static/js/playlists/selection.mjs",
    "/music_app/static/js/playtables/native-editor-selection.mjs",
    "/music_app/static/js/playtables/native-selection.mjs",
    "/music_app/static/js/playtables/native-track-table-presentation.mjs",
    "/music_app/static/js/playtables/selection.mjs",
    "/music_app/static/js/playtables/track-table-presentation.mjs"
  ],
  "create": [
    "/music_app/static/js/album-tops/builder.mjs",
    "/music_app/static/js/album-tops/draft.mjs",
    "/music_app/static/js/album-tops/model.mjs",
    "/music_app/static/js/album-tops/mutation-notice.mjs",
    "/music_app/static/js/album-tops/progress.mjs",
    "/music_app/static/js/home-friends/native-controls.mjs",
    "/music_app/static/js/home-friends/native-dialog.mjs",
    "/music_app/static/js/playlists/native-creation.mjs",
    "/music_app/static/js/playlists/native-mutation-status.mjs",
    "/music_app/static/js/playlists/reorder.mjs"
  ]
};

// Test-only CJS instrumentation. Append exports for lexical mount/data already
// present in the unchanged helper; never rewrite/replace its route function.
// No Playwright runner/browser executes. Only its declaration surface is used.
function routingFixture(name, dir) {
  const file = path.join(dir, name === 'create' ? 'builder-fixture.cjs' : 'browser-fixture.cjs');
  const registrations = [];
  const playwright = {
    test: {extend(definition) {registrations.push(definition); return Object.freeze({routingOnly: true});}},
    expect() {assert.fail('Playwright assertion executed beyond routing boundary');},
  };
  const source = fs.readFileSync(file, 'utf8');
  let addition = '';
  if (name === 'full5000') {
    addition = "\nmodule.exports.__routingUnit={mount,root,html:fixtureHtml(),entry:fs.readFileSync(path.join(__dirname,'fixture-entry.jsx'),'utf8').replace('__PICKER_INITIAL_STATE__',JSON.stringify(F.state({editing:true,data:dataFixture.data})))};";
  } else if (name === 'create' || name === 'shared-search') {
    // Exact lexical HTML expression, evaluated only as the helper's static data.
    const expression = source.match(/const html=\(([^]*?)\);/);
    assert.ok(expression, 'one explicit local HTML expression');
    addition = '\nmodule.exports.__routingUnit={mount,root,html:(' + expression[1] + ')' +
      (name === 'create' ? ',entry' : '') + '};';
  }
  function loadCjs(filename, suffix = '') {
    const localRequire = Module.createRequire(filename), loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded.require = request => {
      if (request === '@playwright/test') return playwright;
      const resolved = localRequire.resolve(request);
      assert.ok(!resolved.includes(path.sep + 'music_app' + path.sep), 'no product module may be required');
      assert.ok(!resolved.endsWith('.mjs'), 'no product ES module may be imported');
      if (resolved === path.join(dir, 'picker-page.cjs')) return loadCjs(resolved);
      return localRequire(request);
    };
    loaded._compile(fs.readFileSync(filename, 'utf8') + suffix, filename);
    return loaded.exports;
  }
  const exported = loadCjs(file, addition), fixture = exported.__routingUnit || exported;
  assert.equal(registrations.length, name === 'full5000' ? 1 : 0);
  if (name === 'full5000') {
    assert.equal(typeof registrations[0].picker, 'function', 'actual Playwright fixture registered but never invoked');
    assert.ok(!fixture.entry.includes('__PICKER_INITIAL_STATE__'));
    assert.ok(fixture.entry.includes('Retained 24'));
    assert.ok(!fixture.entry.includes('Retained 25'));
  }
  return fixture;
}

async function captureRoute(fixture, name) {
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
  const events=name==='full5000'?[]:name==='create'||name==='shared-search'?[['on','pageerror']]:[['on','pageerror'],['on','console']];
  assert.deepEqual(calls,[...events,['route',ORIGIN+'/**'],['goto',ORIGIN+'/']]);
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
    const fixture = routingFixture(name, dir), MODULES = MODULES_BY_FIXTURE[name];
    assert.equal(fs.realpathSync(fixture.root), fs.realpathSync(ROOT));
    const route = await captureRoute(fixture, name);

    await t.test('fixed virtual entry returns exact native entry text and JavaScript MIME', async () => {
      assertJavaScript(await route(ORIGIN + ENTRY), fixture.entry ?? fs.readFileSync(path.join(dir, 'fixture-entry.jsx'), 'utf8'));
    });
    await t.test('reviewed reachable native module URLs return exact source bytes and JavaScript MIME', async () => {
      for (const url of MODULES) {
        assertJavaScript(await route(ORIGIN + url), fs.readFileSync(path.join(ROOT, url.slice(1)), 'utf8'));
      }
    });
    await t.test('existing native modules outside this entry graph stay inaccessible',async()=>{
      assert.ok(fs.statSync(path.join(ROOT, 'music_app/static/js/album-tops/index.mjs')).isFile(), 'unreachable native module exists in the staged repository');
      for(const resourceType of ['script','document'])assertRejected(await route(ORIGIN+'/music_app/static/js/album-tops/index.mjs',{resourceType}));
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
