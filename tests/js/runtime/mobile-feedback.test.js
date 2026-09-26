const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const runtime = path.join(__dirname, '../../../music_app/static/js/runtime');
const preferences = require('../../../music_app/static/js/client-device-preferences.js');
function load(name, globals = {}) {
  const context = vm.createContext({ window: { innerWidth: 390 }, console, ...globals });
  vm.runInContext(fs.readFileSync(path.join(runtime, name), 'utf8'), context);
  return context;
}

test('Rows normalizes only the active wide presentation; 1/2/3 column cards remain distinct', () => {
  for (const width of [320, 390, 900]) assert.equal(preferences.resolveGalleryViewForWidth('list', width), 'list');
  for (const width of [901, 1180, 1440]) assert.equal(preferences.resolveGalleryViewForWidth('list', width), 'cards');
  for (const columns of [1, 2, 3]) {
    const result = preferences.resolveMobileGalleryGeometry({ availableWidth: 366, viewportWidth: 390, columns, gap: 12 });
    assert.equal(result.columns, columns);
    assert.ok(result.cardTrackWidth * columns + 12 * (columns - 1) <= 366);
  }
  assert.equal(preferences.resolveMobileGalleryGeometry({ viewportWidth: 1180 }), null);
});

test('wide mobile tablet read does not rewrite the narrow Rows preference', () => {
  const window = { innerWidth: 1180, navigator: { userAgent: 'Android tablet' }, setTimeout() {}, clearTimeout() {} };
  const store = preferences.createStore({ window, bootstrap: { account_id: 1, profiles: {
    mobile: { galleryDisplayPreferences: { defaultGalleryDisplayMode: 'list' } },
  } } });
  assert.equal(store.read('galleryDisplayPreferences', {}).defaultGalleryDisplayMode, 'cards');
  window.innerWidth = 390;
  assert.equal(store.read('galleryDisplayPreferences', {}).defaultGalleryDisplayMode, 'list');
});

test('mobile Settings consumes only server-authorized section actions', () => {
  const context = load('mobile-navigation.js');
  assert.equal(context.mobileUtilityTabAllowed('appearance', {}), true);
  assert.equal(context.mobileUtilityTabAllowed('rules', {}), false);
  assert.equal(context.mobileUtilityTabAllowed('rules', { 'library.rules.read': true }), true);
  assert.equal(context.mobileUtilityTabAllowed('loops', { 'library.loops.read': true }), true);
  assert.equal(context.mobileUtilityTabAllowed('problematic-files', { 'library.problems.read': true }), false);
  assert.equal(context.mobileUtilityTabAllowed('__proto__', {}), false);
});

test('single mobile track-body activation uses the real play control and excludes nested actions', () => {
  const calls = [];
  const button = { disabled: false, dataset: { trackPath: '/generated/track.mp3' }, click() { calls.push('play'); } };
  const row = { querySelector: () => button, contains: () => false, dataset: {}, ownerDocument: { getSelection: () => ({ removeAllRanges() {} }) } };
  const context = load('album-track-table.js', { usesMobilePageLayout: () => true,
    window: { getSelection: () => ({ removeAllRanges() {} }) }, state: { player: { current: null } },
    triggerAlbumTrackPlayActivation: () => calls.push('pulse'),
  });
  // The table event uses the component's existing click route, never a second player.
  const event = { target: { closest: () => null }, currentTarget: row, detail: 1, preventDefault() {} };
  context.handleAlbumTrackRowClick(event);
  assert.equal(calls.filter(x => x === 'play').length, 1);
  context.handleAlbumTrackRowClick({ ...event, target: { closest: () => button } });
  context.handleAlbumTrackRowClick({ ...event, detail: 2 });
  context.handleAlbumTrackRowDoubleClick(event);
  assert.equal(calls.filter(x => x === 'play').length, 1);
});

test('personal Home is distinct from the explicit All Artists route', () => {
  const context = load('mobile-home.js', { URL, usesMobilePageLayout: () => true,
    window: { location: { href: 'https://example.test/' } }, state: { view: { query: '', selected_artist: '' } } });
  assert.equal(context.shouldShowMobileHome(), true);
  context.window.location.href = 'https://example.test/?all_artists=1';
  assert.equal(context.shouldShowMobileHome(), false);
  context.window.location.href = 'https://example.test/';
  context.state.view.query = 'Northlight';
  assert.equal(context.shouldShowMobileHome(), false);
});

test('mobile player metadata separates artist from track and album without changing desktop copy', () => {
  let mobile = true;
  const context = load('player-loop-playback.js', { usesMobilePageLayout: () => mobile });
  const elements = { artist: {}, title: {}, albumLink: {} };
  const track = { artist: 'Northlight', title: 'Open Water', album: 'After the Rain' };
  context.renderGlobalPlayerMetadata(elements, track);
  assert.equal(elements.artist.textContent, 'Northlight');
  assert.equal(elements.artist.hidden, false);
  assert.equal(elements.title.textContent, 'Open Water');
  assert.equal(elements.albumLink.textContent, 'After the Rain');
  mobile = false;
  context.renderGlobalPlayerMetadata(elements, track);
  assert.equal(elements.artist.hidden, true);
  assert.equal(elements.title.textContent, 'Northlight - Open Water /');
});


test('mobile play/pause uses the shared SVG without rebuilding it every playback tick', () => {
  let mobile = true, writes = 0;
  const attributes = new Map();
  const button = { textContent: '', getAttribute: key => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    set innerHTML(value) { this.markup = value; writes += 1; },
  };
  const context = load('player-loop-playback.js', {
    usesMobilePageLayout: () => mobile,
    ButtonComponent: require('../../../music_app/static/js/button-component.js'),
  });
  context.renderGlobalPlayerPlayGlyph(button, false);
  assert.match(button.markup, /<svg/);
  assert.match(button.markup, /M7.5 6.5/);
  context.renderGlobalPlayerPlayGlyph(button, false);
  assert.equal(writes, 1);
  context.renderGlobalPlayerPlayGlyph(button, true);
  assert.match(button.markup, /M9 6.4/);
  assert.equal(writes, 2);
  mobile = false;
  context.renderGlobalPlayerPlayGlyph(button, true);
  assert.equal(button.textContent, '\u25B6');
  mobile = true;
  context.renderGlobalPlayerPlayGlyph(button, true);
  assert.equal(writes, 3);
});
