const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../music_app/static/js/runtime/gallery-main-interactions.js'), 'utf8');

function setup({ selectedArtist = 'Ария', query = 'Ария', mobile = false } = {}) {
  const hiddenWrites = [];
  const bar = { set hidden(value) { hiddenWrites.push(value); } };
  const state = { view: { selected_artist: selectedArtist, query }, ui: { searchDraftQuery: query } };
  const context = vm.createContext({ state, usesMobilePageLayout: () => mobile,
    document: { querySelector: () => bar } });
  vm.runInContext(source, context);
  return { state, hiddenWrites, sync: () => context.syncGalleryBarSearchVisibility() };
}

test('clearing a selected-artist query retains the GalleryBar through the draft and committed boundaries', () => {
  const { state, hiddenWrites, sync } = setup();
  sync();
  state.ui.searchDraftQuery = '';
  sync();
  state.view.query = '';
  sync();
  assert.deepEqual(hiddenWrites, [false, false, false]);
});

test('a different nonempty query still hides the stale selected-artist GalleryBar', () => {
  const { state, hiddenWrites, sync } = setup();
  state.ui.searchDraftQuery = 'Neal Morse';
  sync();
  state.view.query = 'Neal Morse';
  state.view.selected_artist = 'Neal Morse';
  sync();
  assert.deepEqual(hiddenWrites, [true, false]);
});

test('root searches remain hidden until both draft and committed queries clear', () => {
  const { state, hiddenWrites, sync } = setup({ selectedArtist: '' });
  sync();
  state.ui.searchDraftQuery = '';
  sync();
  state.view.query = '';
  sync();
  assert.deepEqual(hiddenWrites, [true, true, false]);
});

test('mobile GalleryBar remains mounted through query transitions', () => {
  const { state, hiddenWrites, sync } = setup({ mobile: true });
  state.ui.searchDraftQuery = 'Neal Morse';
  sync();
  state.ui.searchDraftQuery = '';
  sync();
  assert.deepEqual(hiddenWrites, [false, false]);
});
