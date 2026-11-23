// What the browser keeps for the signed-in account (the saved player, the app's saved queue, recent
// searches, the playback claim hand-off) is kept for that account only and goes when signing out
// or signing in. Kept songs are not among them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scripts = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js');
const read = file => fs.readFileSync(path.join(scripts, file), 'utf8');
const helperSource = read('runtime/browser-storage-helpers.js');

const LOCAL_KEYS = ['albumhaven.playerState.v1', 'albumhaven.androidNativeQueue.v1'];
const SESSION_KEYS = ['albumhaven.recentSearches.v1', 'albumhaven.playbackHandoff.v1'];
const OTHER_LOCAL = ['albumhaven.playerAppearance.v1', 'album-haven-playback-device-id', 'albumhaven.compactPlayer.mode.v1'];

function memoryStorage(entries = []) {
  const items = new Map(entries);
  return {
    items,
    getItem: key => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  };
}

function page({ account = 7, local = memoryStorage(), session = memoryStorage() } = {}) {
  const bootstrap = account === undefined ? null : { textContent: JSON.stringify({ account_id: account }) };
  const context = {
    window: { localStorage: local, sessionStorage: session, location: { href: 'https://music.test/' } },
    document: { getElementById: id => (id === 'client-layout-preferences-bootstrap' ? bootstrap : null) },
    URL,
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context);
  return { context, local, session };
}

const forKeys = (keys, storage) => keys.map(key => ({
  key, storage, get: storage === 'local' ? 'getLocalStorageItem' : 'getSessionStorageItem',
  set: storage === 'local' ? 'setLocalStorageItem' : 'setSessionStorageItem',
}));
const accountKeys = [...forKeys(LOCAL_KEYS, 'local'), ...forKeys(SESSION_KEYS, 'session')];

for (const { key, storage, get, set } of accountKeys) {
  test(`${key} is read back by the account that kept it`, () => {
    const { context } = page();
    assert.equal(context[set](key, '{"kept":1}'), true);
    assert.equal(context[get](key), '{"kept":1}');
  });

  test(`${key} kept by another account is never read and is removed`, () => {
    const first = page({ account: 7 });
    first.context[set](key, '{"kept":1}');
    const stores = { local: first.local, session: first.session };
    const other = page({ account: 8, local: first.local, session: first.session });
    assert.equal(other.context[get](key, 'none'), 'none');
    assert.equal(stores[storage].items.has(key), false);
  });

  test(`${key} kept before it had an account is removed once`, () => {
    const stores = { local: memoryStorage(), session: memoryStorage() };
    stores[storage].items.set(key, '{"track":{"path":"Q:/Made Up/01.flac"}}');
    const { context } = page({ local: stores.local, session: stores.session });
    assert.equal(context[get](key, 'none'), 'none');
    assert.equal(stores[storage].items.has(key), false);
  });

  test(`${key} is neither kept nor read on a page without a signed-in account`, () => {
    const stores = { local: memoryStorage(), session: memoryStorage() };
    const { context } = page({ account: null, local: stores.local, session: stores.session });
    assert.equal(context[set](key, '{"kept":1}'), false);
    assert.equal(stores[storage].items.has(key), false);
  });
}

test('signing out removes what the account kept, and the page keeps nothing more until it is gone', () => {
  const { context, local, session } = page();
  for (const { key, set } of accountKeys) context[set](key, '{"kept":1}');
  for (const key of OTHER_LOCAL) local.setItem(key, 'kept');

  context.closeAccountBrowserStorageOnSignOut({ target: { getAttribute: () => '/logout', action: 'https://music.test/logout' } });

  for (const key of LOCAL_KEYS) assert.equal(local.items.has(key), false, key);
  for (const key of SESSION_KEYS) assert.equal(session.items.has(key), false, key);
  for (const key of OTHER_LOCAL) assert.equal(local.getItem(key), 'kept', key);
  // The page saves the player once more as it unloads: that write is refused.
  assert.equal(context.setLocalStorageItem(LOCAL_KEYS[0], '{"kept":2}'), false);
  assert.equal(local.items.has(LOCAL_KEYS[0]), false);
});

test('another form takes nothing', () => {
  const { context, local } = page();
  context.setLocalStorageItem(LOCAL_KEYS[0], '{"kept":1}');
  context.closeAccountBrowserStorageOnSignOut({ target: { getAttribute: () => '/account/password', action: 'https://music.test/account/password' } });
  assert.equal(context.getLocalStorageItem(LOCAL_KEYS[0]), '{"kept":1}');
});

test('the page sends its sign-out submit to the storage owner', () => {
  const source = read('runtime/bootstrap-event-handlers.js');
  const submit = source.match(/document\.addEventListener\('submit', \(event\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(submit, 'the page has its document submit listener');
  assert.match(submit[1], /closeAccountBrowserStorageOnSignOut\(event\)/);
});

test('the sign-in page removes the same keys, and only those', () => {
  const local = memoryStorage([...LOCAL_KEYS, ...OTHER_LOCAL].map(key => [key, 'kept']));
  const session = memoryStorage(SESSION_KEYS.map(key => [key, 'kept']));
  const context = vm.createContext({
    window: { localStorage: local, sessionStorage: session, addEventListener() {} },
    document: { querySelector: () => null },
  });
  vm.runInContext(read('login.js'), context);
  assert.deepEqual([...local.items.keys()], OTHER_LOCAL);
  assert.deepEqual([...session.items.keys()], []);
});

test('the account keys are the ones their owners write', () => {
  const owners = {
    'albumhaven.playerState.v1': 'runtime/core-state-and-helpers.js',
    'albumhaven.androidNativeQueue.v1': 'runtime/android-bridge-client.js',
    'albumhaven.recentSearches.v1': 'runtime/bootstrap-gallery-event-handlers.js',
    'albumhaven.playbackHandoff.v1': 'runtime/playback-ownership-helpers.js',
  };
  for (const [key, file] of Object.entries(owners)) assert.match(read(file), new RegExp(`= '${key.replace(/\./g, '\\.')}'`), key);
  const { context } = page();
  assert.deepEqual([...context.ACCOUNT_LOCAL_STORAGE_KEYS], LOCAL_KEYS);
  assert.deepEqual([...context.ACCOUNT_SESSION_STORAGE_KEYS], SESSION_KEYS);
  // Kept songs stay: they are named by a digest, not kept for an account (owner, 2026-11-22).
  assert.doesNotMatch(helperSource, /album-haven-tracks/);
});
