const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyProfile, resolveMobileGalleryGeometry, createStore } = require('../../music_app/static/js/client-device-preferences.js');

test('phones share one profile; wide mobile tablets keep mobile preferences, not desktop preferences', () => {
  assert.equal(classifyProfile({ viewportWidth: 390 }), 'mobile');
  assert.equal(classifyProfile({ viewportWidth: 1440 }), 'web_desktop');
  assert.equal(classifyProfile({ viewportWidth: 1280, userAgent: 'Android Tablet' }), 'mobile');
  assert.equal(classifyProfile({ viewportWidth: 1024, platform: 'MacIntel', maxTouchPoints: 5 }), 'mobile');
  assert.equal(classifyProfile({ viewportWidth: 1920, clientSurfaceClass: 'tv' }), 'tv');
});

test('phone geometry is two or three columns; rows fill the width and covers stay square', () => {
  const two = resolveMobileGalleryGeometry({ availableWidth: 360, viewportWidth: 390, columns: 2, mode: 'cards', gap: 14 });
  assert.equal(two.columns, 2);
  assert.equal(two.cardTrackWidth, 173);
  const three = resolveMobileGalleryGeometry({ availableWidth: 360, viewportWidth: 390, columns: 3, mode: 'covers', gap: 14 });
  assert.equal(three.columns, 3);
  assert.equal(three.estimatedRowHeight, three.cardTrackWidth);
  assert.equal(resolveMobileGalleryGeometry({ availableWidth: 360, viewportWidth: 390, columns: 3, mode: 'list' }).columns, 1);
  assert.equal(resolveMobileGalleryGeometry({ availableWidth: 1000, viewportWidth: 1280, mode: 'cards' }), null);
});

function fixture(fetch) {
  const window = { innerWidth: 390, navigator: {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {} };
  const bootstrap = { account_id: 12, profiles: {
    mobile: { mobileGridColumns: 2, albumOpenMode: 'page' },
    web_desktop: { mobileGridColumns: 3, albumOpenMode: 'modal' },
  } };
  return { window, store: createStore({ window, bootstrap, fetch }) };
}

test('durable preferences are profile-scoped and do not read a previous account localStorage', async () => {
  const writes = [];
  const { store, window } = fixture(async (_url, options) => { writes.push(JSON.parse(options.body)); return { ok: true }; });
  assert.equal(store.getItem('albumhaven.albumOpenMode.v1'), 'page');
  store.write('mobileGridColumns', 3);
  window.innerWidth = 1440;
  assert.equal(store.getItem('albumhaven.albumOpenMode.v1'), 'modal');
  await store.flush();
  assert.deepEqual(writes, [{ profile: 'mobile', changes: { mobileGridColumns: 3 } }]);
  assert.equal(store.syncState, 'saved');
});

test('an unsuccessful save remains unsaved and can be retried without losing the newer value', async () => {
  let fail = true;
  const { store } = fixture(async () => ({ ok: !fail }));
  store.write('mobileGridColumns', 3);
  await store.flush();
  assert.equal(store.syncState, 'unsaved');
  store.write('mobileGridColumns', 2);
  fail = false;
  await store.flush();
  assert.equal(store.read('mobileGridColumns'), 2);
  assert.equal(store.syncState, 'saved');
});

test('anonymous contexts never claim an account preference namespace', () => {
  const store = createStore({ bootstrap: {}, window: { innerWidth: 390, navigator: {} } });
  assert.equal(store.handles('albumhaven.albumOpenMode.v1'), false);
  assert.equal(store.write('mobileGridColumns', 3), false);
});
