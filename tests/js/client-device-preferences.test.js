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
  assert.equal(resolveMobileGalleryGeometry({ availableWidth: 360, viewportWidth: 390, mode: 'cards' }).columns, 3);
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


test('an appearance save targets its edited profile even after the viewport changes', async () => {
  const writes = [];
  const { store, window } = fixture(async (_url, options) => { writes.push(JSON.parse(options.body)); return { ok: true }; });
  window.innerWidth = 1440;
  assert.equal(store.write('playerAppearance', { seekbarMode: 'waveform' }, 'mobile'), true);
  assert.deepEqual(store.read('playerAppearance', null, 'mobile'), { seekbarMode: 'waveform' });
  assert.equal(store.read('playerAppearance', null), null);
  assert.equal(store.write('playerAppearance', {}, 'invalid'), false);
  await store.flush();
  assert.deepEqual(writes, [{ profile: 'mobile', changes: { playerAppearance: { seekbarMode: 'waveform' } } }]);
});

test('each Artist Tree write synchronously replaces prior saved status until its server response completes', async () => {
  const status = new Map([['data-preferences-sync', 'saved']]);
  const requests = [];
  let acknowledge;
  const window = {
    innerWidth: 1440, navigator: {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
    document: { documentElement: { setAttribute: (name, value) => status.set(name, value) } },
  };
  const shell = { contextualPaneWidthPx: 320, infoDrawerWidthPx: 360, artistTreeFolded: false };
  const store = createStore({
    window,
    bootstrap: { account_id: 42, profiles: { web_desktop: { shellLayoutPreferences: shell } } },
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Promise(resolve => { acknowledge = () => resolve({ ok: true }); });
    },
  });
  for (const folded of [true, false]) {
    assert.equal(status.get('data-preferences-sync'), 'saved');
    store.setItem('albumhaven.shellLayoutPreferences.v1', JSON.stringify({ ...shell, artistTreeFolded: folded }));
    assert.equal(status.get('data-preferences-sync'), 'pending');
    const saving = store.flush();
    assert.equal(status.get('data-preferences-sync'), 'pending');
    assert.deepEqual(requests.at(-1), { profile: 'web_desktop', changes: {
      shellLayoutPreferences: { ...shell, artistTreeFolded: folded },
    } });
    acknowledge();
    await saving;
    assert.equal(status.get('data-preferences-sync'), 'saved');
  }
});


test('flush acknowledges its finite profile revisions while preserving newer queued writes', async () => {
  const requests = [], acknowledgements = [];
  let markSecondRequest;
  const secondRequest = new Promise(resolve => { markSecondRequest = resolve; });
  const { store } = fixture((_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 2) markSecondRequest('request-started');
    return new Promise(resolve => acknowledgements.push(resolve));
  });
  store.write('albumOpenMode', 'page', 'web_desktop');
  const first = store.flush();
  store.write('playerAppearance', { seekbarMode: 'waveform' }, 'mobile');
  let saved = false;
  const appearanceSave = store.flush().then(result => { saved = result; return result; });
  store.write('albumOpenMode', 'modal', 'web_desktop');
  acknowledgements[0]({ ok: true });
  assert.equal(await Promise.race([secondRequest, appearanceSave.then(() => 'save-acknowledged')]), 'request-started');
  assert.equal(saved, false);
  assert.equal(store.syncState, 'pending');
  assert.deepEqual(requests[1], { profile: 'mobile', changes: { playerAppearance: { seekbarMode: 'waveform' } } });
  acknowledgements[1]({ ok: true });
  await Promise.resolve();
  assert.equal(await first, true);
  assert.equal(await appearanceSave, true);
  assert.equal(requests.length, 2, 'A completed Save must not wait for unrelated future edits');
  assert.equal(store.syncState, 'pending');
  const newerSave = store.flush();
  assert.deepEqual(requests[2], { profile: 'web_desktop', changes: { albumOpenMode: 'modal' } });
  acknowledgements[2]({ ok: true });
  assert.equal(await newerSave, true);
  assert.equal(store.syncState, 'saved');
  assert.equal(store.read('albumOpenMode', null, 'web_desktop'), 'modal');
  assert.deepEqual(store.read('playerAppearance', null, 'mobile'), { seekbarMode: 'waveform' });
});

test('failed flush reports failure and retry persists the newer profile edit', async () => {
  const requests = [];
  let rejectRequest;
  const { store } = fixture((_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return new Promise((_resolve, reject) => { rejectRequest = reject; });
    return Promise.resolve({ ok: true });
  });
  store.write('playerAppearance', { seekbarMode: 'waveform' }, 'mobile');
  const saving = store.flush();
  store.write('playerAppearance', { seekbarMode: 'thin' }, 'mobile');
  rejectRequest(new Error('offline'));
  assert.equal(await saving, false);
  assert.equal(requests.length, 1, 'A failed request must not create an unbounded retry loop');
  assert.equal(store.syncState, 'unsaved');
  assert.equal(await store.flush(), true);
  assert.deepEqual(requests[1], { profile: 'mobile', changes: { playerAppearance: { seekbarMode: 'thin' } } });
  assert.equal(store.syncState, 'saved');
});
