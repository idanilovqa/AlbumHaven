const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRuntime() {
  const context = {
    appBootstrap: { getInitialView: () => ({ visible_library_categories: ['main_library'] }) },
    state: { view: {}, ui: {}, gallery: {} },
  };
  vm.createContext(context);
  for (const file of ['response-state-helpers.js', 'gallery-main-state.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime', file), 'utf8'), context);
  }
  return context;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('source hydration replaces loaded coverage without changing the URL selection', () => {
  const runtime = loadRuntime();
  const applySources = (categories, preserve = false) => runtime.applyViewPayload({
    selected_artist: 'Source test artist',
    visible_library_categories: categories,
    artist_groups: [{ artist: 'Source test artist', albums: categories.map((source) => ({ key: source, source })) }],
  }, { preserveGalleryBrowseLocationState: preserve, retainFullAlbums: true });
  applySources(['main_library']);
  let filters = runtime.createGalleryMainState({ sources: { main_library: true, new_arrivals: false, hoard: false } });
  const toggle = (source) => {
    const action = { type: 'toggle-source', source };
    filters = runtime.reduceGalleryMainState(filters, action);
    return runtime.resolveGallerySourceHydrationRequest({
      currentCategories: runtime.state.view.loaded_library_categories ?? runtime.state.view.visible_library_categories,
      nextState: filters,
      action,
    });
  };
  assert.deepEqual(plain(toggle('new_arrivals')), ['main_library', 'new_arrivals']);
  applySources(['main_library', 'new_arrivals'], true);
  assert.equal(toggle('main_library'), null);
  assert.deepEqual(plain(toggle('hoard')), ['new_arrivals', 'hoard']);
  applySources(['new_arrivals', 'hoard'], true);
  assert.deepEqual(plain(toggle('main_library')), ['main_library', 'new_arrivals', 'hoard']);
  assert.deepEqual(plain(runtime.state.view.visible_library_categories), ['main_library']);
  applySources(['main_library', 'new_arrivals', 'hoard'], true);
  assert.equal(runtime.state.view.artist_groups[0].albums.length, 3);
});

test('local view patches preserve loaded coverage and navigation replaces it', () => {
  const runtime = loadRuntime();
  runtime.applyViewPayload({ visible_library_categories: ['main_library'] });
  runtime.applyViewPayload({ visible_library_categories: ['new_arrivals', 'hoard'] }, { preserveGalleryBrowseLocationState: true });
  runtime.mergeViewPayload({ album_count: 7 });
  assert.deepEqual(plain(runtime.state.view.loaded_library_categories), ['new_arrivals', 'hoard']);
  runtime.applyViewPayload({ selected_artist: 'Other artist', visible_library_categories: ['main_library'] });
  assert.deepEqual(plain(runtime.state.view.loaded_library_categories), ['main_library']);
});
