const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

const runtimeRoot = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const STAMP_A = 'a'.repeat(64), STAMP_B = 'b'.repeat(64), STAMP_C = 'c'.repeat(64);
const LEGACY_KEY = 'albumhaven.recentSearches.v1';
const plain = value => JSON.parse(JSON.stringify(value));

function harness({storage = new Map(), actor = 'account:a', library = 'library:a', stamp = STAMP_A} = {}) {
  const native = createNativeHomeRuntime(), {context, document} = native;
  const add = (tag, id) => {const node = document.createElement(tag); node.id = id; document.body.appendChild(node); return node;};
  const shell = add('div', 'app-shell');
  Object.assign(shell.dataset, {nativeAccountId: actor, nativeLibraryId: library, privateUiContext: stamp});
  const input = add('input', 'search-input'); input.value = '';
  const popover = add('div', 'recent-search-popover'); popover.hidden = true;
  const callbacks = [], requests = [], writes = [], observers = [];
  Object.assign(context, {
    state: {ui: {}, view: {query: 'existing query', context_ref: stamp}, gallery: {}},
    sessionStorage: {getItem: key => storage.get(key) ?? null,
      setItem(key, value) {writes.push([key, value]); storage.set(key, value);}, removeItem: key => storage.delete(key)},
    MutationObserver: class {constructor(callback) {observers.push(callback);} observe() {} disconnect() {}},
    clearBrowserTimeout() {},
    scheduleBrowserTimeout(callback) {callbacks.push(callback); return callbacks.length;},
    withActiveGallerySources: view => ({...view}),
    buildApiUrl: view => `/view-data?q=${encodeURIComponent(view.query)}`,
    fetchAndRender(url) {requests.push(url); return Promise.resolve();},
  });
  for (const file of ['private-ui-transport.js', 'browser-storage-helpers.js', 'bootstrap-gallery-event-handlers.js']) {
    vm.runInContext(fs.readFileSync(path.join(runtimeRoot, file), 'utf8'), context, {filename: file});
  }
  const transport = context.AlbumHavenPrivateUITransport;
  const move = (nextActor = actor, nextLibrary = library, nextStamp = STAMP_B) => {
    Object.assign(shell.dataset, {nativeAccountId: nextActor, nativeLibraryId: nextLibrary, privateUiContext: nextStamp});
    for (const notify of observers) notify();
    transport.generation();
  };
  const read = () => plain(context.readRecentSearchQueries());
  const click = node => context.handleGalleryBootstrapSearchClick(native.event('click', node));
  return {...native, shell, input, popover, storage, writes, callbacks, requests, transport, move, read, click,
    record: value => context.recordRecentSearchQuery(value), open: () => context.openRecentSearchPopover()};
}

for (const [name, actor, library] of [
  ['actor', 'account:b', 'library:a'], ['library', 'account:a', 'library:b'],
]) {
  test(`recent queries do not cross a same-tab ${name} switch`, () => {
    const h = harness(); h.record('Private alpha'); h.open();
    assert.match(h.popover.textContent, /Private alpha/);
    h.move(actor, library);
    assert.deepEqual(h.read(), []);
    assert.equal(h.popover.hidden, true);
    assert.doesNotMatch(h.popover.textContent, /Private alpha/);
    assert.equal(h.input.getAttribute('aria-expanded'), 'false');
    h.record('Private beta');
    assert.deepEqual(h.read(), ['Private beta']);
  });
}

test('legacy unscoped session history is never exposed or reassigned to a signed-in account', () => {
  const storage = new Map([[LEGACY_KEY, JSON.stringify(['Legacy private query'])]]), h = harness({storage});
  assert.deepEqual(h.read(), []);
  assert.equal(h.open(), false);
  assert.doesNotMatch(h.popover.textContent, /Legacy private query/);
  h.record('Current scoped query');
  assert.deepEqual(h.read(), ['Current scoped query']);
  assert.equal(h.writes.some(([key]) => key === LEGACY_KEY), false);
  h.move('account:b', 'library:a');
  assert.deepEqual(h.read(), []);
});

test('same-scope reload retains normalized recent queries and the established eight-query bound', () => {
  const h = harness();
  for (let index = 0; index < 10; index++) h.record(`Query ${index}`);
  h.record('  QUERY 9  ');
  const expected = ['QUERY 9', 'Query 8', 'Query 7', 'Query 6', 'Query 5', 'Query 4', 'Query 3', 'Query 2'];
  assert.deepEqual(h.read(), expected);
  const reload = harness({storage: h.storage});
  assert.deepEqual(reload.read(), expected);
  assert.equal(reload.open(), true);
  assert.match(reload.popover.textContent, /QUERY 9/);
});

for (const [name, values] of [
  ['missing account', {actor: ''}], ['missing library', {library: ''}],
  ['missing context', {stamp: ''}], ['malformed context', {stamp: 'untrusted'}],
]) {
  test(`${name} fails closed for history reads, writes and rendering`, () => {
    const h = harness(values);
    assert.deepEqual(h.read(), []);
    assert.equal(h.record('Must not persist'), false);
    assert.equal(h.writes.length, 0);
    assert.equal(h.open(), false);
    assert.equal(h.popover.hidden, true);
  });
}

test('history also fails closed when the shared private transport is unavailable', () => {
  const h = harness();
  // A separate VM deliberately loads the real owner without the transport script.
  const isolated = vm.createContext({state: {ui: {}}, document: h.document, window: {},
    getSessionStorageItem: () => JSON.stringify(['Untrusted legacy']), setSessionStorageItem: () => {throw new Error('unauthenticated write');}});
  vm.runInContext(fs.readFileSync(path.join(runtimeRoot, 'bootstrap-gallery-event-handlers.js'), 'utf8'), isolated);
  assert.deepEqual(plain(isolated.readRecentSearchQueries()), []);
  assert.equal(isolated.recordRecentSearchQuery('No session'), false);
});

test('logout immediately retires visible history and its active descendant', () => {
  const h = harness(); h.record('Secret before logout'); h.open();
  h.context.state.ui.recentSearchActiveIndex = 0;
  h.input.setAttribute('aria-activedescendant', 'recent-search-option-0');
  h.move('', '', '');
  assert.equal(h.popover.hidden, true);
  assert.equal(h.popover.textContent, '');
  assert.equal(h.input.getAttribute('aria-activedescendant'), null);
  assert.equal(h.context.state.ui.recentSearchActiveIndex, -1);
  assert.deepEqual(h.read(), []);
  assert.equal(h.record('Logged out query'), false);
});

test('shared transport context rejection retires history without another search interaction', () => {
  const h = harness(); h.record('Denied scope secret'); h.open();
  assert.throws(() => h.transport.accept({context_ref: STAMP_B}, STAMP_A), /Reload to restore/);
  assert.equal(h.popover.hidden, true);
  assert.equal(h.popover.textContent, '');
  assert.deepEqual(h.read(), []);
  assert.equal(h.record('Denied query'), false);
});

test('a detached option from the previous actor cannot select an index belonging to the next actor', () => {
  const h = harness(); h.record('Actor A private'); h.open();
  const oldOption = h.popover.querySelector('[data-recent-search-index]');
  assert.ok(oldOption);
  h.move('account:b', 'library:a'); h.record('Actor B private'); h.open();
  assert.equal(oldOption.isConnected, false);
  const before = h.input.value;
  h.click(oldOption);
  assert.equal(h.input.value, before);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.read(), ['Actor B private']);
});

for (const roundTrip of [false, true]) {
  test(`a queued history commit cannot replay across ${roundTrip ? 'A to B to A generations' : 'an actor switch'}`, () => {
    const h = harness(); h.record('Initial A');
    h.context.scheduleGallerySearchCommit('Delayed A secret', {recordRecentSearch: true});
    assert.equal(h.callbacks.length, 1);
    const late = h.callbacks[0];
    h.move('account:b', 'library:a'); h.record('Current B');
    if (roundTrip) h.move('account:a', 'library:a', STAMP_C);
    const before = h.read();
    late();
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.read(), before);
    assert.equal(h.read().includes('Delayed A secret'), false);
  });
}

test('a delayed mobile-leave confirmation cannot record or dispatch an old-scope query', () => {
  const h = harness(); h.record('Initial A'); let resume;
  h.context.prepareMobileGallerySearch = (callback, confirmed) => {
    if (confirmed) return true;
    resume = callback; return false;
  };
  h.context.commitGallerySearchQuery('Mobile A secret', {recordRecentSearch: true});
  assert.equal(typeof resume, 'function');
  h.move('account:b', 'library:a'); h.record('Current B');
  resume();
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.read(), ['Current B']);
});

test('a current-scope scheduled commit still records and dispatches exactly once', () => {
  const h = harness();
  h.context.scheduleGallerySearchCommit('Current search', {recordRecentSearch: true});
  assert.equal(h.callbacks.length, 1);
  h.callbacks[0]();
  assert.deepEqual(h.read(), ['Current search']);
  assert.deepEqual(h.requests, ['/view-data?q=Current%20search']);
});

test('ordinary typed search still dispatches without private history context', () => {
  const h = harness({actor: '', library: '', stamp: ''});
  h.context.scheduleGallerySearchCommit('Public typed search', {immediate: true, recordRecentSearch: true});
  assert.deepEqual(h.requests, ['/view-data?q=Public%20typed%20search']);
  assert.deepEqual(h.read(), []);
  assert.equal(h.writes.length, 0);
});

test('history selection fails closed after shared context denial', () => {
  const h = harness(); h.record('Former private selection'); h.open();
  assert.throws(() => h.transport.accept({context_ref: STAMP_B}, STAMP_A), /Reload to restore/);
  const before = h.input.value;
  assert.equal(h.context.selectRecentSearchQuery('Former private selection'), false);
  assert.equal(h.input.value, before);
  assert.deepEqual(h.requests, []);
});

test('a deferred callback cannot revive when the original actor, library and opaque context all return', () => {
  const h = harness(); h.record('Original A');
  h.context.scheduleGallerySearchCommit('Superseded A callback', {recordRecentSearch: true});
  assert.equal(h.callbacks.length, 1);
  const late = h.callbacks[0], originalGeneration = h.transport.generation();
  h.move('account:b', 'library:a', STAMP_B);
  h.record('Intervening B');
  h.move('account:a', 'library:a', STAMP_A);
  assert.ok(h.transport.generation() > originalGeneration);
  const before = h.read(), writesBefore = h.writes.length;
  late();
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.read(), before);
  assert.equal(h.writes.length, writesBefore);
  assert.equal(h.read().includes('Superseded A callback'), false);
});

for (const [name, actor, library] of [
  ['account', 'account:b', 'library:a'], ['library', 'account:a', 'library:b'],
]) {
  test(`a ${name}-only shell mutation retires history and old callbacks even before the opaque stamp changes`, () => {
    const h = harness(); h.record('Old shell private query'); h.open();
    const oldOption = h.popover.querySelector('[data-recent-search-index]');
    assert.ok(oldOption);
    h.context.scheduleGallerySearchCommit('Old shell queued query', {recordRecentSearch: true});
    assert.equal(h.callbacks.length, 1);
    const late = h.callbacks[0], originalGeneration = h.transport.generation();
    h.move(actor, library, STAMP_A);
    assert.equal(h.transport.generation(), originalGeneration, 'the shared transport stamp has not changed');
    assert.deepEqual(h.read(), [], 'shell identity independently partitions history');
    assert.equal(h.popover.hidden, true);
    assert.doesNotMatch(h.popover.textContent, /Old shell private query/);
    assert.equal(h.input.getAttribute('aria-expanded'), 'false');
    h.record('New shell query'); h.open();
    assert.equal(oldOption.isConnected, false);
    const before = h.input.value, writesBefore = h.writes.length;
    h.click(oldOption);
    late();
    assert.equal(h.input.value, before);
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.read(), ['New shell query']);
    assert.equal(h.writes.length, writesBefore);
  });
}
