const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(view, search = '') {
  const context = { state: { view, gallery: {} }, URL, window: { location: { href: `https://localhost/${search}` } } };
  vm.createContext(context);
  for (const file of ['gallery-main-state.js', 'gallery-main-interactions.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime', file), 'utf8'), context);
  }
  return context;
}
function directView() {
  const group = artist => ({ artist, albums: [{ key: artist }] });
  return { selected_artist: 'Neal Morse', related_filter_artists: ['Cosmic Cathedral'], primary_filter_active: false,
    related_artists: ['Cosmic Cathedral', 'The Neal Morse Band'], primary_artist_groups: [],
    family_artist_groups: [group('Cosmic Cathedral')], artist_groups: [group('Cosmic Cathedral')],
    related_filter_base_primary_groups: [group('Neal Morse')],
    related_filter_base_family_groups: [group('Cosmic Cathedral'), group('The Neal Morse Band')] };
}
test('direct filtered view initializes selected identities and can restore every family album', () => {
  const c = load(directView());
  const state = c.ensureGalleryMainState();
  assert.deepEqual(Array.from(state.familyArtists), ['Cosmic Cathedral']);
  assert.equal(state.familySelectionExplicit, true);
  const availableArtists = Array.from(c.getGalleryFamilyPanelGroups(), g => g.artist);
  for (const artist of ['The Neal Morse Band', 'Neal Morse']) {
    c.state.gallery.mainState = c.reduceGalleryMainState(c.state.gallery.mainState, { type: 'toggle-family-artist', artist, availableArtists });
  }
  assert.equal(c.getFilteredGalleryMainModel().totals.albumCount, 3);
});
test('browser navigation restores related and primary filters, including primary only', () => {
  const c = load(directView(), '?artist=Neal+Morse&related_artist=Cosmic+Cathedral&primary_filter=1');
  c.syncGalleryMainStateFromLocation();
  assert.deepEqual(Array.from(c.state.gallery.mainState.familyArtists), ['Neal Morse', 'Cosmic Cathedral']);
  c.window.location.href = 'https://localhost/?artist=Neal+Morse&primary_filter=1';
  c.syncGalleryMainStateFromLocation();
  assert.deepEqual(Array.from(c.state.gallery.mainState.familyArtists), ['Neal Morse']);
});
test('navigation to another primary artist initializes that view selection', () => {
  const c = load(directView());
  c.ensureGalleryMainState();
  const next = { selected_artist: 'Devin Townsend', related_filter_artists: ['Casualties of Cool'] };
  c.syncGalleryMainStateFromView(c.state.view, next);
  assert.deepEqual(Array.from(c.state.gallery.mainState.familyArtists), ['Casualties of Cool']);
});
