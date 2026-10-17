const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

const repoRoot = path.resolve(__dirname, '../../..');
const runtimeRoot = path.join(repoRoot, 'music_app/static/js/runtime');
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const plain = value => JSON.parse(JSON.stringify(value));

function boot({productionOrder = false} = {}) {
  const native = createNativeHomeRuntime(), {context, document} = native;
  const add = (tag, id) => {const node = document.createElement(tag); node.id = id; document.body.appendChild(node); return node;};
  const shell = add('div', 'app-shell');
  Object.assign(shell.dataset, {nativeAccountId: 'account:a', nativeLibraryId: 'library:a', privateUiContext: A});
  const input = add('input', 'search-input'); input.value = '';
  const popover = add('div', 'recent-search-popover'); popover.hidden = true;
  const observers = [], callbacks = [], requests = [], storage = new Map(), writes = [];
  class BatchedObserver {
    constructor(callback) {this.callback = callback; this.records = []; observers.push(this);}
    observe(target, options) {this.target = target; this.options = options;}
    disconnect() {this.target = null; this.records = [];}
    takeRecords() {return this.records.splice(0);}
  }
  const originalSet = shell.setAttribute.bind(shell);
  shell.setAttribute = (name, value) => {
    const oldValue = shell.getAttribute(name);
    originalSet(name, value);
    for (const observer of observers) {
      if (observer.target !== shell || !observer.options.attributes
          || observer.options.attributeFilter && !observer.options.attributeFilter.includes(name)) continue;
      observer.records.push({type: 'attributes', target: shell, attributeName: name,
        oldValue: observer.options.attributeOldValue ? oldValue : null});
    }
  };
  Object.assign(context, {
    state: {ui: {}, view: {query: 'existing query', context_ref: A}, gallery: {}},
    sessionStorage: {getItem: key => storage.get(key) ?? null,
      setItem(key, value) {writes.push([key, value]); storage.set(key, value);}, removeItem: key => storage.delete(key)},
    MutationObserver: BatchedObserver,
    clearBrowserTimeout() {}, scheduleBrowserTimeout(callback) {callbacks.push(callback); return callbacks.length;},
    withActiveGallerySources: view => ({...view}), buildApiUrl: view => `/view-data?q=${encodeURIComponent(view.query)}`,
    fetchAndRender(url) {requests.push(url); return Promise.resolve();},
  });
  let files = ['private-ui-transport.js', 'browser-storage-helpers.js', 'bootstrap-gallery-event-handlers.js'];
  if (productionOrder) {
    // Read the actual build manifest without running the builder. Whole relevant
    // modules share one Script lexical environment, just as its concatenation does.
    const manifest = fs.readFileSync(path.join(repoRoot, 'scripts/build-runtime-bundle.cjs'), 'utf8');
    const declaration = manifest.match(/const RUNTIME_SCRIPT_PATHS = \[([\s\S]*?)\];/);
    assert.ok(declaration, 'the production runtime manifest is present');
    const listed = [...declaration[1].matchAll(/'js\/runtime\/([^']+)'/g)].map(match => match[1]);
    files = listed.filter(file => files.includes(file));
    assert.deepEqual(files, ['browser-storage-helpers.js', 'bootstrap-gallery-event-handlers.js', 'private-ui-transport.js']);
  }
  const chunks = files.map(file => fs.readFileSync(path.join(runtimeRoot, file), 'utf8'));
  if (productionOrder) vm.runInContext(chunks.join('\n\n'), context, {filename: 'production-search-owner-concatenation.js'});
  else files.forEach((file, index) => vm.runInContext(chunks[index], context, {filename: file}));
  const flush = () => {
    // One mutation-observer delivery checkpoint. Nothing observes intermediate
    // shell values; each callback receives the complete pending mutation list.
    for (const observer of observers) {
      const records = observer.takeRecords();
      if (records.length) observer.callback(records, observer);
    }
  };
  const roundTrip = () => {
    Object.assign(shell.dataset, {nativeAccountId: 'account:b', nativeLibraryId: 'library:b', privateUiContext: B});
    Object.assign(shell.dataset, {nativeAccountId: 'account:a', nativeLibraryId: 'library:a', privateUiContext: A});
    flush();
  };
  return {...native, shell, input, popover, callbacks, requests, writes, flush, roundTrip,
    transport: context.AlbumHavenPrivateUITransport,
    read: () => plain(context.readRecentSearchQueries()),
    record: query => context.recordRecentSearchQuery(query), open: () => context.openRecentSearchPopover()};
}

test('production concatenation order boots and subscribes to later shared-transport denial', () => {
  const h = boot({productionOrder: true});
  h.record('Postboot private query'); assert.equal(h.open(), true);
  assert.match(h.popover.textContent, /Postboot private query/);
  assert.throws(() => h.transport.accept({context_ref: B}, A), /Reload to restore/);
  // No follow-up Search read or render may be necessary for retirement.
  assert.equal(h.popover.hidden, true);
  assert.equal(h.popover.textContent, '');
  assert.equal(h.input.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(h.read(), []);
});

for (const mode of ['queued', 'mobile']) {
  test(`batched exact-scope A to B to A retires the ${mode} callback and visible history`, () => {
    const h = boot(); h.record('Before batched boundary'); h.open();
    const oldOption = h.popover.querySelector('[data-recent-search-index]');
    assert.ok(oldOption);
    let resume;
    if (mode === 'queued') {
      h.context.scheduleGallerySearchCommit('Old batched callback', {recordRecentSearch: true});
      assert.equal(h.callbacks.length, 1); resume = h.callbacks[0];
    } else {
      h.context.prepareMobileGallerySearch = (callback, confirmed) => {
        if (confirmed) return true;
        resume = callback; return false;
      };
      h.context.commitGallerySearchQuery('Old batched callback', {recordRecentSearch: true});
      assert.equal(typeof resume, 'function');
    }
    const generation = h.transport.generation();
    h.roundTrip();
    assert.equal(h.transport.generation(), generation, 'final opaque stamp alone cannot detect this boundary');
    assert.equal(h.popover.hidden, true);
    assert.equal(h.popover.textContent, '');
    assert.equal(h.input.getAttribute('aria-expanded'), 'false');
    assert.equal(oldOption.isConnected, false);
    const before = h.read(), writesBefore = h.writes.length;
    resume();
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.read(), before);
    assert.equal(h.writes.length, writesBefore);
    assert.equal(h.read().includes('Old batched callback'), false);
  });
}

test('same-value mutation records retain the current visible history and usable queued search', () => {
  const h = boot(); h.record('Retained current history'); h.open();
  h.context.scheduleGallerySearchCommit('Current queued query', {recordRecentSearch: true});
  assert.equal(h.callbacks.length, 1);
  Object.assign(h.shell.dataset, {nativeAccountId: 'account:a', nativeLibraryId: 'library:a', privateUiContext: A});
  h.flush();
  assert.equal(h.popover.hidden, false);
  assert.match(h.popover.textContent, /Retained current history/);
  assert.deepEqual(h.read(), ['Retained current history']);
  h.callbacks[0]();
  assert.deepEqual(h.requests, ['/view-data?q=Current%20queued%20query']);
  assert.deepEqual(h.read(), ['Current queued query', 'Retained current history']);
});

test('a current B search admitted before old A-to-B mutation delivery remains usable', () => {
  const h = boot(); h.record('Original A history'); h.open();
  Object.assign(h.shell.dataset, {nativeAccountId: 'account:b', nativeLibraryId: 'library:b', privateUiContext: B});
  assert.deepEqual(h.read(), []);
  h.record('Admitted B history'); h.open();
  h.context.scheduleGallerySearchCommit('Admitted B query', {recordRecentSearch: true});
  assert.equal(h.callbacks.length, 1);
  h.flush();
  assert.equal(h.popover.hidden, false);
  assert.match(h.popover.textContent, /Admitted B history/);
  h.callbacks[0]();
  assert.deepEqual(h.requests, ['/view-data?q=Admitted%20B%20query']);
  assert.deepEqual(h.read(), ['Admitted B query', 'Admitted B history']);
});
