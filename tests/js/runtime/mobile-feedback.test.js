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
  assert.equal(context.mobileUtilityTabAllowed('problematic-files', { 'library.problems.read': true }), true);
  assert.equal(context.mobileUtilityTabAllowed('problematic-files', {}), false);
  assert.equal(context.mobileUtilityTabAllowed('__proto__', {}), false);
});

test('single mobile track-body activation uses the real play control and excludes nested actions', () => {
  const calls = [];
  const button = { disabled: false, dataset: { trackPath: '/generated/track.mp3' }, click() { calls.push('play'); } };
  const row = { querySelector: () => button, contains: () => false, dataset: {}, ownerDocument: { getSelection: () => ({ removeAllRanges() {} }) } };
  const context = load('album-track-table.js', { usesMobilePageLayout: () => true,
    window: { getSelection: () => ({ removeAllRanges() {} }) }, state: { player: { current: null } },
    activateSharedTrackButton: (target, options) => {
      assert.equal(target, button);
      assert.equal(options.restart, true);
      calls.push('restart');
    },
  });
  // The table event uses the component's existing click route, never a second player.
  const event = { target: { closest: () => null }, currentTarget: row, detail: 1, preventDefault() {} };
  context.handleAlbumTrackRowClick(event);
  assert.equal(calls.filter(x => x === 'play').length, 1);
  context.handleAlbumTrackRowClick({ ...event, target: { closest: () => button } });
  assert.deepEqual(calls, ['play']);
  context.handleAlbumTrackRowClick({ ...event, detail: 2 });
  // Mobile handles the second tap above; a native dblclick must not restart twice.
  context.handleAlbumTrackRowDoubleClick(event);
  assert.equal(calls.filter(x => x === 'play').length, 1);
  assert.equal(calls.filter(x => x === 'restart').length, 1);
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


test('hierarchical mobile Back preserves the original parent across album replacements and history restoration', () => {
  const api = load('mobile-navigation.js');
  const descriptor = { kind: 'album', albumKey: 'second' };
  assert.equal(api.resolveMobileParentPosition(descriptor, null, { albumHavenNavigationPosition: 2 }), 2);
  assert.equal(api.resolveMobileParentPosition(descriptor, { parentPosition: 2 }, { albumHavenNavigationPosition: 5 }), 2);
  assert.equal(api.resolveMobileParentPosition(descriptor, null, { albumHavenNavigationPosition: 5,
    mobilePages: [{ ...descriptor, parentPosition: 2 }] }), 2);
  assert.equal(api.mobileParentHistoryDelta(2, 5), -3);
  for (const invalid of [null, undefined, -1, 1.5, NaN, 5, 6]) {
    assert.equal(api.mobileParentHistoryDelta(invalid, 5), null);
  }
  assert.equal(api.mobileParentHistoryDelta(0, 1), -1);
});

test('header Back traverses to its parent without replacing the child history entry before popstate', () => {
  const movements = [];
  const context = load('mobile-navigation.js', { window: { history: {
    state: { albumHavenNavigationPosition: 4 }, go: delta => movements.push(delta),
    replaceState() { throw new Error('Back must retain the child entry for Forward'); },
  } } });
  vm.runInContext("mobilePageState.pages.push({ kind: 'album', albumKey: 'one', parentPosition: 2 });", context);
  assert.equal(context.dismissMobilePage('album'), true);
  assert.deepEqual(movements, [-2]);
  assert.equal(vm.runInContext('mobilePageState.pages.length', context), 1);
});


test('breakpoint promotion retains open surfaces and puts an album above Settings in the same order', () => {
  const calls = [];
  const nodes = Object.fromEntries(['track-modal', 'utility-modal', 'cover-lookup-modal', 'non-album-modal'].map(id => [id, {
    hidden: id === 'non-album-modal', classList: { contains: name => id === 'track-modal' && name === 'is-above-settings' },
  }]));
  const album = { key: 'generated-album', name: 'Generated album' };
  const context = load('mobile-navigation.js', {
    document: { getElementById: id => nodes[id] },
    state: { utility: { activeTab: 'problematic-files' }, coverLookup: { modal: { album } } },
    getCurrentTrackModalAlbum: () => album,
    loadActiveUtilityTab: () => calls.push('load'),
    renderUtilityModalContent: () => calls.push('render'),
  });
  context.mobileUtilityTabAllowed = tab => tab === 'appearance';
  context.setUtilityActiveTab = tab => { context.state.utility.activeTab = tab; };
  context.mobilePageDescriptor = (kind, value) => ({ kind, album: value });
  context.presentMobilePage = descriptor => calls.push(descriptor);
  context.promoteVisibleMobileDialogs();
  assert.deepEqual(calls.map(call => typeof call === 'string' ? call : call.kind), ['load', 'utilities', 'render', 'album', 'cover-lookup']);
  assert.equal(calls[3].album, album);
  assert.equal(context.state.utility.activeTab, 'appearance');
  calls.length = 0;
  context.window.innerWidth = 1280;
  context.promoteVisibleMobileDialogs();
  assert.deepEqual(calls, []);
});

test('utility detail pushes its index parent and Back preserves the Forward entry', () => {
  const writes = [], movements = [];
  const outlet = { scrollTop: 120 }, modal = { dataset: {} };
  const context = load('mobile-navigation.js', {
    window: { innerWidth: 390, history: { state: { albumHavenNavigationPosition: 7 }, go: delta => movements.push(delta) } },
    document: { getElementById: id => id === 'mobile-page-outlet' ? outlet : modal },
  });
  vm.runInContext("mobilePageState.pages.push({kind:'utilities',tab:'problematic-files'})", context);
  context.writeMobilePageHistory = mode => writes.push({ mode: mode || 'push', key: vm.runInContext('mobilePageState.pages.at(-1).utilityDetail', context) });
  context.openMobileUtilityDetail('generated-album');
  assert.deepEqual(writes, [{ mode: 'replace', key: undefined }, { mode: 'push', key: 'generated-album' }]);
  assert.equal(modal.dataset.mobileUtilityView, 'detail');
  assert.equal(outlet.scrollTop, 0);
  context.window.history.state.albumHavenNavigationPosition = 8;
  context.navigateMobileBack();
  assert.deepEqual(movements, [-1]);
  assert.equal(writes.length, 2);
  context.window.innerWidth = 1280;
  context.openMobileUtilityDetail('another-album');
  assert.equal(writes.length, 2);
});
