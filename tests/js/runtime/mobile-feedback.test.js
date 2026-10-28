const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const runtime = path.join(__dirname, '../../../music_app/static/js/runtime');
const preferences = require('../../../music_app/static/js/client-device-preferences.js');
function load(name, globals = {}) {
  const context = vm.createContext({
    window: { innerWidth: 390 },
    console,
    state: { coverLookup: {} },
    ...globals,
  });
  vm.runInContext(fs.readFileSync(path.join(runtime, name), 'utf8'), context);
  return context;
}

const mobileParentFreshnessScenarios = [
  { name: 'unchanged live gallery', refreshes: 0, change() {} },
  { name: 'advanced inventory revision', refreshes: 1, change(state) { state.status.inventory_mutation_revision += 1; } },
  { name: 'same-revision continuation replaced gallery view', refreshes: 0,
    change(state) { state.view = { ...state.view }; } },
  { name: 'same-revision continuation replaced gallery groups', refreshes: 0,
    change(state) { state.view.artist_groups = [...state.view.artist_groups]; } },
  { name: 'deferred hidden-gallery group update', refreshes: 1,
    change(_state, context) {
      context.virtualGrid.hasDeferredMountedGroupUpdate = () => true;
    } },
  { name: 'changed parent route', refreshes: 1, change(state, context) { context.buildUrl = () => '/?surface=home'; } },
  { name: 'unknown inventory freshness', refreshes: 1,
    before(state) { delete state.status.inventory_mutation_revision; }, change() {} },
  { name: 'request active when parent was captured', refreshes: 1,
    before(state) { state.ui.activeViewRequestController = {}; },
    change(state) { state.ui.activeViewRequestController = null; } },
  { name: 'pending inventory reconciliation', refreshes: 1, change(state) { state.ui.pendingInventoryMutationViewRefresh = true; } },
  { name: 'pending view request', refreshes: 1, change(state) { state.ui.pendingViewRequest = { url: '/?surface=albums' }; } },
  { name: 'active view request', refreshes: 1, change(state) { state.ui.activeViewRequestController = {}; } },
  { name: 'active append-only root gallery continuation', refreshes: 0, change(_state, context) {
    vm.runInContext('var rootGalleryPageRequest = { controller: {} };', context);
  } },
  { name: 'reconstructed history descriptor', refreshes: 1, change(_state, context) {
    vm.runInContext('mobilePageState.pages = JSON.parse(JSON.stringify(mobilePageState.pages));', context);
  } },
];

for (const scenario of mobileParentFreshnessScenarios) {
  test(`Back safely aligns an exact jump anchor with ${scenario.name}`, () => {
  const scroll = { scrollTop: 1200, scrollLeft: 0, getBoundingClientRect: () => ({ top: 0, width: 390, height: 600 }) };
  const aligned = [];
    let refreshes = 0;
    let chromeUpdates = 0;
  const outlet = { dataset: {} };
  const context = load('mobile-navigation.js', {
    state: { view: { surface: 'albums', gallery_page: { anchor_artist: 'B', anchor_group_artist: 'B' },
      artist_groups: [{ artist: 'B', albums: [{ key: 'b-album' }] }] },
      ui: {}, status: { inventory_mutation_revision: 3 }, busy: false },
    window: { innerWidth: 390, history: { state: { albumHavenNavigationPosition: 2 } } },
    document: {
      getElementById: id => id === 'mobile-page-outlet' ? outlet : id === 'albums-scroll' ? scroll : id === 'track-modal' ? {} : null,
      querySelectorAll: () => [],
    },
    buildUrl: () => '/?surface=albums',
    virtualGrid: {
      scrollEl: scroll,
      captureScrollAnchor: () => null,
      scrollToArtist: artist => { aligned.push(artist); return true; },
    },
      stabilizeRootGalleryArtistAlignment() {},
      updateGalleryMainChrome() { chromeUpdates += 1; },
    handleGalleryBootstrapPopState: () => { refreshes += 1; },
    closeArtistsDrawer() {}, closeGalleryMainSurface() {}, requestAnimationFrame() {},
  });
  context.syncMobilePageShell = () => {};
  context.writeMobilePageHistory = () => {};
  context.cleanupMobilePage = () => {};
  vm.runInContext("mobilePageState.originals.set('album', {});", context);
  scenario.before?.(context.state);
  assert.equal(context.presentMobilePage({ kind: 'album', albumKey: 'b-album' }), true);
  vm.runInContext("mobilePageState.pages[0].parentGalleryAnchorArtist = 'B';", context);
  scenario.change(context.state, context);
  context.window.history.state = { albumHavenNavigationPosition: 2, mobilePages: [] };
  assert.equal(context.handleMobilePagePopState(), true);
  assert.deepEqual(aligned, ['B']);
    assert.equal(refreshes, scenario.refreshes, 'reuse only a fresh descriptor while reconciling every stale parent');
    assert.equal(chromeUpdates, scenario.refreshes ? 0 : 1,
      'a reused gallery parent must synchronize its chrome before return');
});
}

for (const scenario of mobileParentFreshnessScenarios) {
  test(`Back restores the departure anchor with ${scenario.name}`, () => {
  const anchor = { scrollTop: 1200, scrollLeft: 0, albumKey: 'b-album', sectionOccurrenceKey: 'artist:B', offsetTop: 16 };
  const scroll = { scrollTop: 1200, scrollLeft: 0, getBoundingClientRect: () => ({ top: 0, width: 390, height: 600 }) };
  const restored = [];
    let refreshes = 0;
    let chromeUpdates = 0;
  const outlet = { dataset: {} };
  const context = load('mobile-navigation.js', {
    state: { view: { surface: 'albums', artist_groups: [{ artist: 'B', albums: [{ key: 'b-album' }] }] },
      ui: {}, status: { inventory_mutation_revision: 3 }, busy: false },
    window: { innerWidth: 390, history: { state: { albumHavenNavigationPosition: 2 } } },
    document: { getElementById: id => id === 'mobile-page-outlet' ? outlet : id === 'albums-scroll' ? scroll : id === 'track-modal' ? {} : null },
    buildUrl: () => '/?surface=albums',
    virtualGrid: {
      scrollEl: scroll,
      captureScrollAnchor: () => anchor,
      restoreOwnedAbsoluteScrollPosition: position => { scroll.scrollTop = position.scrollTop; return true; },
      render() {},
      restoreOwnedScrollAnchor: value => {
        restored.push(value);
        scroll.scrollTop = value.scrollTop;
      },
    },
      updateGalleryMainChrome() { chromeUpdates += 1; },
      handleGalleryBootstrapPopState: () => { refreshes += 1; },
    closeArtistsDrawer() {}, closeGalleryMainSurface() {}, requestAnimationFrame() {},
  });
  context.syncMobilePageShell = () => {};
  context.writeMobilePageHistory = () => {};
  context.cleanupMobilePage = () => {};
  vm.runInContext("mobilePageState.originals.set('album', {});", context);
  scenario.before?.(context.state);
  assert.equal(context.presentMobilePage({ kind: 'album', albumKey: 'b-album' }), true);
  scenario.change(context.state, context);
  scroll.scrollTop = 0;
  context.window.history.state = { albumHavenNavigationPosition: 2, mobilePages: [] };
  assert.equal(context.handleMobilePagePopState(), true);
  assert.equal(scroll.scrollTop, 1200);
  assert.equal(restored.at(-1).albumKey, 'b-album');
    assert.equal(refreshes, scenario.refreshes, 'reuse unchanged content without suppressing required reconciliation');
    assert.equal(chromeUpdates, scenario.refreshes ? 0 : 1,
      'a reused departure anchor must synchronize gallery chrome before return');
});
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

test('submitting an open mobile search with an empty draft still reaches gallery submission', () => {
  const closes = [];
  const context = load('mobile-navigation.js', {
    usesMobilePageLayout: () => true,
    document: {
      getElementById(id) {
        return id === 'search-input' ? { value: '' } : null;
      },
    },
  });
  vm.runInContext('mobilePageState.searchOpen = true', context);
  context.setMobileSearchOpen = (open) => closes.push(open);

  assert.equal(context.handleMobileSearchSubmit(), false);
  assert.deepEqual(closes, [false]);
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
    window: { ButtonComponent: require('../../../music_app/static/js/button-component.js') },
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
  assert.match(button.markup, /M9 6.4/);
  assert.equal(writes, 2);
  mobile = true;
  context.renderGlobalPlayerPlayGlyph(button, true);
  assert.equal(writes, 2);
  context.renderGlobalPlayerPlayGlyph(button, false);
  assert.equal(writes, 3);
  assert.match(button.markup, /M7.5 6.5/);
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

test('breakpoint promotion leaves a notification Cover Lookup sheet above its drawer', () => {
  const calls = [];
  const nodes = Object.fromEntries(['track-modal', 'utility-modal', 'cover-lookup-modal', 'non-album-modal'].map(id => [id, {
    hidden: id !== 'cover-lookup-modal',
    classList: { contains: name => id === 'cover-lookup-modal' && name === 'is-mobile-sheet' },
  }]));
  const context = load('mobile-navigation.js', {
    window: { innerWidth: 390 },
    document: { getElementById: id => nodes[id] },
    state: { coverLookup: { modal: { album: { name: 'Album' } } } },
  });
  context.mobilePageDescriptor = kind => ({ kind });
  context.presentMobilePage = descriptor => calls.push(descriptor);

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

test('reloaded album remains the history parent of a subsequently opened child', () => {
  const history = { state: { albumHavenNavigationPosition: 4 }, replaceState(value) { this.state = value; } };
  const context = load('mobile-navigation.js', {
    URL,
    window: { innerWidth: 390, location: { href: 'https://example.test/?mobile_page=album&mobile_album=one' },
      history, addEventListener() {}, matchMedia: () => ({ addEventListener() {} }) },
    document: { getElementById: id => id === 'mobile-navigation' ? {} : null, createComment: () => ({}), addEventListener() {},
      documentElement: { dataset: {}, style: { setProperty() {} } } },
    state: { utility: { activeTab: 'appearance' } },
  });
  context.promoteVisibleMobileDialogs = () => {};
  context.restoreMobilePage = descriptor => {
    context.restoredDescriptor = descriptor;
    vm.runInContext('mobilePageState.pages.push(restoredDescriptor)', context);
  };
  context.initMobileNavigation();
  assert.equal(history.state.mobilePages.length, 1);
  assert.equal(history.state.mobilePages[0].albumKey, 'one');
  assert.equal(context.resolveMobileParentPosition({ kind: 'cover-lookup', albumKey: 'one' }, null, history.state), 4);
});


test('leaving the last mobile page reconciles its retained gallery parent without resetting scroll', () => {
  const calls = [];
  const context = load('mobile-navigation.js', {
    window: { history: { state: { mobilePages: [] } } },
    handleGalleryBootstrapPopState: options => calls.push(options),
  });
  context.cleanupMobilePage = () => null;
  context.syncMobilePageShell = () => {};
  vm.runInContext("mobilePageState.pages.push({kind:'album',albumKey:'one'});", context);
  assert.equal(context.handleMobilePagePopState(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].preserveScroll, true);
  assert.equal(vm.runInContext('mobilePageState.pages.length', context), 0);
  // An ordinary gallery traversal remains owned by the normal popstate handler.
  assert.equal(context.handleMobilePagePopState(), false);
  assert.equal(calls.length, 1);
});

test('cover gallery presentation refreshes across the shared breakpoint only while open', () => {
  let onBreakpoint, renders = 0;
  const overlay = { hidden: false };
  const context = load('mobile-navigation.js', {
    URL, virtualGrid: null,
    window: { innerWidth: 390, location: { href: 'https://example.test/' },
      history: { state: {} }, addEventListener() {}, matchMedia: () => ({ addEventListener(_event, callback) { onBreakpoint = callback; } }) },
    document: { getElementById: id => id === 'mobile-navigation' ? {} : id === 'cover-lookup-modal' ? overlay : null,
      createComment: () => ({}), addEventListener() {}, documentElement: { dataset: {}, style: { setProperty() {} } } },
    state: { utility: { activeTab: 'appearance' } },
    renderCoverLookupModal: () => { renders += 1; },
    galleryMainSurfaceController: null, syncMobileHome() {}, renderArtistGroups() {}, restorePlayerAppearance() {}, updatePlayerUi() {},
  });
  context.promoteVisibleMobileDialogs = () => {};
  context.initMobileNavigation();
  assert.equal(renders, 1);
  context.window.innerWidth = 1280;
  onBreakpoint();
  assert.equal(renders, 2);
  context.window.innerWidth = 390;
  onBreakpoint();
  assert.equal(renders, 3);
  overlay.hidden = true;
  onBreakpoint();
  assert.equal(renders, 3);
});

test('mobile child-to-parent traversal does not refresh the gallery behind the parent page', () => {
  let refreshes = 0;
  const context = load('mobile-navigation.js', {
    window: { history: { state: { mobilePages: [{kind:'album',albumKey:'one'}] } } },
    handleGalleryBootstrapPopState: () => { refreshes += 1; },
  });
  context.cleanupMobilePage = () => null;
  context.syncMobilePageShell = () => {};
  vm.runInContext("mobilePageState.pages.push({kind:'album',albumKey:'one'}, {kind:'cover-lookup',albumKey:'one'});", context);
  assert.equal(context.handleMobilePagePopState(), true);
  assert.equal(refreshes, 0);
  assert.equal(vm.runInContext('mobilePageState.pages.length', context), 1);
});

test('shared gallery popstate forwards retained-scroll options to the existing request owner', () => {
  const calls = [], options = { preserveScroll: true };
  const context = load('bootstrap-gallery-event-handlers.js', {
    syncGalleryMainStateFromLocation: () => calls.push('location'),
    getBrowserLocationHref: () => 'https://example.test/?q=After+the+Rain',
    fetchAndRender: (...args) => calls.push(args),
  });
  context.handleGalleryBootstrapPopState(options);
  assert.equal(calls[0], 'location');
  assert.equal(calls[1][0], 'https://example.test/?q=After+the+Rain');
  assert.equal(calls[1][1], false);
  assert.equal(calls[1][2], options);
});

test('direct or reloaded mobile Back restores the gallery when there is no traversable parent entry', () => {
  const calls = [];
  const context = load('mobile-navigation.js', {
    window: { history: { state: { albumHavenNavigationPosition: 4 } } },
    handleGalleryBootstrapPopState: options => calls.push(['parent', options.preserveScroll]),
  });
  context.cleanupMobilePage = () => null;
  context.writeMobilePageHistory = mode => calls.push(['history', mode]);
  context.syncMobilePageShell = () => calls.push(['shell']);
  vm.runInContext("mobilePageState.pages.push({kind:'album',albumKey:'one',parentPosition:4});", context);
  assert.equal(context.dismissMobilePage('album'), true);
  assert.deepEqual(calls, [['history', 'replace'], ['shell'], ['parent', true]]);
  assert.equal(vm.runInContext('mobilePageState.pages.length', context), 0);
});

test('fallback Back to another mobile page leaves its background gallery alone', () => {
  let refreshes = 0;
  const context = load('mobile-navigation.js', {
    window: { history: { state: {} } },
    handleGalleryBootstrapPopState: () => { refreshes += 1; },
  });
  context.cleanupMobilePage = () => null;
  context.writeMobilePageHistory = () => {};
  context.syncMobilePageShell = () => {};
  vm.runInContext("mobilePageState.pages.push({kind:'album',albumKey:'one'}, {kind:'cover-lookup',albumKey:'one'});", context);
  assert.equal(context.dismissMobilePage('cover-lookup'), true);
  assert.equal(refreshes, 0);
  assert.equal(vm.runInContext('mobilePageState.pages.length', context), 1);
});


test('mobile parent scroll position is captured once and survives reload and responsive promotion', () => {
  const context = load('mobile-navigation.js');
  const descriptor = {kind:'album', albumKey:'one'};
  const initial = context.resolveMobileParentScrollPosition(descriptor, null, {}, {scrollTop:180, scrollLeft:0});
  assert.equal(initial.scrollTop, 180);
  const previous = {...descriptor, parentScrollPosition:initial};
  const moved = {scrollTop:1400, scrollLeft:0};
  assert.equal(context.resolveMobileParentScrollPosition(descriptor, previous, {}, moved).scrollTop, 180);
  assert.equal(context.resolveMobileParentScrollPosition(descriptor, null, {mobilePages:[previous]}, moved).scrollTop, 180);
  assert.equal(context.resolveMobileParentScrollPosition(descriptor, null, {}, null), null);
  assert.equal(context.resolveMobileParentScrollPosition(descriptor, null, {}, {scrollTop:NaN, scrollLeft:0}), null);
});

test('mobile album navigation retains the first captured semantic gallery anchor', () => {
  const context = load('mobile-navigation.js');
  const descriptor = { kind: 'album', albumKey: 'one' };
  const captured = {
    albumKey: 'visible-album',
    sectionOccurrenceKey: 'artist:visible',
    offsetTop: 16,
    scrollTop: 640,
    scrollLeft: 0,
  };
  const later = { ...captured, albumKey: 'different-album', scrollTop: 1280 };

  assert.deepEqual(
    { ...context.resolveMobileParentScrollAnchor(descriptor, null, {}, captured) },
    captured,
  );
  assert.deepEqual(
    { ...context.resolveMobileParentScrollAnchor(
      descriptor,
      { ...descriptor, parentScrollAnchor: captured },
      {},
      later,
    ) },
    captured,
  );
});

test('mobile gallery return restores saved coordinates before refreshing through the existing request owner', () => {
  const calls = [];
  const position = {scrollTop:0, scrollLeft:0};
  const context = load('mobile-navigation.js', {
    virtualGrid: {restoreOwnedAbsoluteScrollPosition: value => { calls.push(['position',value]); return true; }, render: force => calls.push(['render',force])},
    handleGalleryBootstrapPopState: options => calls.push(['request',options]),
  });
  context.restoreMobileGalleryParent({parentScrollPosition:position});
  assert.equal(calls[0][1], position);
  assert.deepEqual(calls[1], ['render',true]);
  assert.equal(calls[2][1].preserveScroll,true);
  assert.equal(calls[2][1].preserveAbsoluteScroll,true);
  assert.equal(calls[2][1].absoluteScrollPositionApplied,true);
  assert.equal(calls[2][1].absoluteScrollPosition,position);
});

test('mobile album return restores the captured gallery anchor before refreshing', () => {
  const calls = [];
  let queuedAbsoluteRestore = null;
  const position = { scrollTop: 720, scrollLeft: 0 };
  const anchor = {
    albumKey: 'album-at-viewport-top',
    sectionOccurrenceKey: 'artist:example',
    offsetTop: 12,
    scrollTop: 720,
    scrollLeft: 0,
  };
  const context = load('mobile-navigation.js', {
    virtualGrid: {
      restoreOwnedAbsoluteScrollPosition: value => {
        calls.push(['position', value]);
        queuedAbsoluteRestore = () => calls.push(['stale-position', value]);
        return true;
      },
      render: force => calls.push(['render', force]),
      restoreOwnedScrollAnchor: value => calls.push(['anchor', value]),
      getUserScrollIntentGeneration: () => 7,
    },
    handleGalleryBootstrapPopState: options => calls.push(['request', options]),
  });

  context.restoreMobileGalleryParent({
    parentScrollPosition: position,
    parentScrollAnchor: anchor,
  });

  assert.deepEqual(calls.slice(0, 2), [
    ['render', true],
    ['anchor', anchor],
  ]);
  assert.equal(queuedAbsoluteRestore, null, 'semantic restoration must not leave an absolute RAF owner');
  assert.equal(calls[2][0], 'request');
  assert.equal(calls[2][1].semanticScrollAnchor, anchor);
  assert.equal(calls[2][1].semanticScrollOwnerGeneration, 7);
  assert.equal(calls[2][1].preserveMountedGalleryChildren, true);
});

test('mobile album return re-applies the semantic anchor after the gallery layout frame', () => {
  const frames = [];
  const restored = [];
  let chromeUpdates = 0;
  const anchor = {
    albumKey: 'album-at-viewport-top',
    sectionOccurrenceKey: 'artist:example',
    offsetTop: 12.375,
    scrollTop: 720,
    scrollLeft: 0,
  };
  const context = load('mobile-navigation.js', {
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    virtualGrid: {
      render() {},
      restoreOwnedScrollAnchor: value => restored.push(value),
      getUserScrollIntentGeneration: () => 7,
    },
    updateGalleryMainChrome() { chromeUpdates += 1; },
    handleGalleryBootstrapPopState() {},
  });

  context.restoreMobileGalleryParent({ parentScrollAnchor: anchor });

  assert.deepEqual(restored, [anchor]);
  assert.equal(chromeUpdates, 0);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(restored, [anchor, anchor]);
  assert.equal(chromeUpdates, 1,
    'the final semantic-anchor frame must synchronize chrome to the restored artist');
});

test('mobile album return does not re-apply the semantic anchor after user scroll ownership changes', () => {
  const frames = [];
  const restored = [];
  let userScrollGeneration = 7;
  const anchor = {
    albumKey: 'album-at-viewport-top',
    sectionOccurrenceKey: 'artist:example',
    offsetTop: 12.375,
    scrollTop: 720,
    scrollLeft: 0,
  };
  const context = load('mobile-navigation.js', {
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    virtualGrid: {
      render() {},
      restoreOwnedScrollAnchor: value => restored.push(value),
      getUserScrollIntentGeneration: () => userScrollGeneration,
    },
    handleGalleryBootstrapPopState() {},
  });

  context.restoreMobileGalleryParent({ parentScrollAnchor: anchor });
  userScrollGeneration += 1;
  frames.shift()();

  assert.deepEqual(restored, [anchor]);
});

test('mobile album return does not restore a stale anchor at another history position', () => {
  const calls = [];
  const context = load('mobile-navigation.js', {
    window: { history: { state: { albumHavenNavigationPosition: 8 } } },
    virtualGrid: {
      restoreOwnedScrollAnchor: value => calls.push(['anchor', value]),
    },
    handleGalleryBootstrapPopState: options => calls.push(['request', options]),
  });

  context.restoreMobileGalleryParent({
    parentPosition: 7,
    parentScrollAnchor: {
      albumKey: 'stale-album',
      scrollTop: 720,
      scrollLeft: 0,
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'request');
  assert.equal(calls[0][1].preserveScroll, true);
});

test('both history Back and direct Back restore the root page viewport, not a hidden gallery position', () => {
  for (const traversal of [false,true]) {
    const calls = [];
    const position = {scrollTop:64,scrollLeft:0};
    const context = load('mobile-navigation.js', {
      window:{history:{state:{mobilePages:[]}}},
      restorePosition:position,
    });
    context.cleanupMobilePage = () => null;
    context.syncMobilePageShell = () => {};
    context.writeMobilePageHistory = () => {};
    context.restoreMobileGalleryParent = page => calls.push(page.parentScrollPosition);
    vm.runInContext("mobilePageState.pages.push({kind:'album',albumKey:'one',parentScrollPosition:restorePosition});",context);
    if(traversal) context.handleMobilePagePopState();
    else context.dismissMobilePage('album');
    assert.equal(calls.length,1);
    assert.equal(calls[0],position);
  }
});

test('closing mobile Album Details opened from Notifications restores the drawer', () => {
  let renders = 0;
  let restores = 0;
  const context = load('mobile-navigation.js', {
    document: { getElementById: () => null },
    state: {
      coverLookup: {
        drawerOpen: false,
        drawerScrollTop: 384,
        returnToDrawerAfterAlbumDetails: true,
      },
    },
    closeTrackModal() {},
    renderCoverLookupDrawer() { renders += 1; },
    restoreCoverLookupDrawerScroll() { restores += 1; },
  });

  context.cleanupMobilePage({ kind: 'album' });

  assert.equal(context.state.coverLookup.drawerOpen, true);
  assert.equal(context.state.coverLookup.drawerScrollTop, 384);
  assert.equal(context.state.coverLookup.returnToDrawerAfterAlbumDetails, false);
  assert.equal(renders, 1);
  assert.equal(restores, 1);
});

test('mobile page presentation round-trips the same surfaces and parent stack without closing or rewriting history', () => {
  function node(attributes = {}) {
    const classes = new Set();
    return { hidden: false, inert: false, dataset: {}, slot: 'desktop', attributes: { ...attributes },
      classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
        toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
      getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
      setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
      getClientRects() { return this.hidden ? [] : [{}]; },
    };
  }
  const ids = ['shell-main-surface', 'mobile-page-header', 'mobile-page-outlet', 'mobile-back-button',
    'mobile-library-button', 'mobile-page-title', 'mobile-page-summary', 'mobile-settings-actions', 'mobile-settings-button'];
  const nodes = Object.fromEntries(ids.map(id => [id, node()]));
  const album = nodes['track-modal'] = node({ role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Original album' });
  const settings = nodes['utility-modal'] = node({ role: 'dialog', 'aria-modal': 'true' });
  nodes['mobile-page-outlet'].appendChild = surface => { surface.slot = 'mobile'; };
  const body = node();
  // Earlier hidden modal wrappers leave their inner aria-modal dialog in the DOM.
  const hiddenEarlierDialog = node({ role: 'dialog', 'aria-modal': 'true' });
  hiddenEarlierDialog.getClientRects = () => [];
  let closes = 0;
  const context = load('mobile-navigation.js', {
    document: { body, getElementById: id => nodes[id], querySelectorAll: () =>
      [hiddenEarlierDialog, settings, album].filter(surface => surface.getAttribute('aria-modal') === 'true' && !surface.hidden) },
    window: { innerWidth: 390, history: { replaceState() { throw Error('resize must not replace history'); },
      pushState() { throw Error('resize must not push history'); } } },
  });
  // Native Close and Escape both enter this same existing modal owner.
  context.closeTrackModal = () => {
    if (context.dismissMobilePage('album')) return;
    closes++; album.hidden = true;
  };
  context.syncMobileAlbumHeader = context.syncMobileLoopHeader = () => {};
  context.surfaces = { album, utilities: settings };
  vm.runInContext(`
    mobilePageState.pages.push({ kind: 'utilities', title: 'Settings', parentPosition: 2 },
      { kind: 'album', title: 'Album', albumKey: 'one', parentPosition: 3 });
    for (const [kind, dialog] of Object.entries(surfaces)) {
      mobilePageState.originals.set(kind, { dialog, role: dialog.getAttribute('role'),
        modal: dialog.getAttribute('aria-modal'), label: dialog.getAttribute('aria-label'),
        placeholder: { before(element) { element.slot = 'desktop'; }, replaceWith(element) { element.slot = 'desktop'; } } });
    }
  `, context);
  const initialPages = vm.runInContext('mobilePageState.pages', context);
  for (const width of [390, 1440, 390]) {
    context.window.innerWidth = width;
    context.syncMobilePageShell();
    const mobile = width <= 900;
    assert.equal(album.slot, mobile ? 'mobile' : 'desktop');
    assert.equal(settings.slot, mobile ? 'mobile' : 'desktop');
    assert.equal(album.getAttribute('role'), mobile ? 'region' : 'dialog');
    assert.equal(album.getAttribute('aria-modal'), mobile ? null : 'true');
    assert.equal(album.getAttribute('aria-label'), mobile ? 'Album details' : 'Original album');
    assert.equal(settings.getAttribute('aria-label'), mobile ? 'Settings' : null);
    assert.equal(album.classList.contains('is-mobile-page'), mobile);
    assert.equal(album.hidden, false);
    assert.equal(settings.hidden, mobile);
    assert.equal(settings.inert, mobile);
    assert.equal(nodes['mobile-page-header'].hidden, !mobile);
    assert.equal(nodes['shell-main-surface'].classList.contains('has-mobile-page'), mobile);
    assert.equal(body.classList.contains('modal-open'), !mobile);
    assert.equal(vm.runInContext('mobilePageState.pages', context), initialPages);
    assert.equal(vm.runInContext('mobilePageState.pages[1].parentPosition', context), 3);
    assert.equal(closes, 0);
  }
  context.window.innerWidth = 1440;
  context.syncMobilePageShell();
  let dismissalWrites = 0;
  context.writeMobilePageHistory = mode => { assert.equal(mode, 'replace'); dismissalWrites++; };
  context.closeTrackModal();
  assert.equal(closes, 1);
  assert.equal(dismissalWrites, 1);
  assert.equal(album.hidden, true);
  assert.equal(album.slot, 'desktop');
  assert.equal(vm.runInContext("mobilePageState.originals.has('album')", context), false);
  context.window.innerWidth = 390;
  context.syncMobilePageShell();
  assert.equal(album.hidden, true);
  assert.equal(album.slot, 'desktop');
  assert.equal(settings.slot, 'mobile');
  assert.equal(settings.hidden, false);
  assert.equal(vm.runInContext("mobilePageState.pages.some(page => page.kind === 'album')", context), false);
  assert.equal(closes, 1);
  assert.equal(dismissalWrites, 1);
});

test('canonical mobile parent route distinguishes root Gallery, Home and explicit All Artists through history', () => {
  const context = load('mobile-navigation.js');
  vm.runInContext(fs.readFileSync(path.join(runtime, 'view-state-helpers.js'), 'utf8'), context);
  context.URLSearchParams = URLSearchParams;
  const descriptor = { kind: 'album', albumKey: 'one' };
  for (const [view, expected] of [
    [{ surface: { active: 'albums' } }, '/?surface=albums'],
    [{ surface: { active: 'home' } }, '/'],
    [{ surface: { active: 'albums' }, all_artists_active: true }, '/?surface=albums&all_artists=1'],
  ]) {
    const url = context.buildUrl(view);
    assert.equal(url, expected);
    assert.equal(context.resolveMobileParentViewUrl(descriptor, null, {}, url), expected);
    const saved = { ...descriptor, parentViewUrl: expected };
    assert.equal(context.resolveMobileParentViewUrl(descriptor, null, { mobilePages: [saved] }, '/?q=unrelated'), expected);
    assert.equal(context.resolveMobileParentViewUrl(descriptor, saved, {}, '/?q=unrelated'), expected);
  }
  assert.equal(context.resolveMobileParentViewUrl(descriptor, null,
    { mobilePages: [{ kind: 'album', albumKey: 'other', parentViewUrl: '/?q=wrong' }] }, '/'), '/');
});

test('mobile parent restoration retains the transient root gallery anchor outside the canonical URL', () => {
  const descriptor = { kind: 'album', albumKey: 'doombound' };
  const context = load('mobile-navigation.js');

  assert.equal(
    context.resolveMobileParentGalleryAnchorArtist(descriptor, null, {}, 'Battlelore'),
    'Battlelore',
  );
  assert.equal(
    context.resolveMobileParentGalleryAnchorArtist(
      descriptor,
      { ...descriptor, parentGalleryAnchorArtist: 'Battlelore' },
      {},
      '3 Inches of Blood',
    ),
    'Battlelore',
  );

  const calls = [];
  const position = { scrollTop: 320, scrollLeft: 0 };
  const scrollAnchor = {
    albumKey: 'album-below-battlelore',
    sectionOccurrenceKey: 'artist:later',
    offsetTop: 0,
    scrollTop: 320,
    scrollLeft: 0,
  };
  const restoreContext = load('mobile-navigation.js', {
    virtualGrid: {
      restoreOwnedAbsoluteScrollPosition: value => {
        calls.push(['position', value]);
        return true;
      },
      render: force => calls.push(['render', force]),
      restoreOwnedScrollAnchor: value => calls.push(['anchor', value]),
    },
    handleGalleryBootstrapPopState: options => calls.push(options),
  });
  restoreContext.restoreMobileGalleryParent({
    parentViewUrl: '/?surface=albums&all_artists=1',
    parentGalleryAnchorArtist: 'Battlelore',
    parentScrollPosition: position,
    parentScrollAnchor: scrollAnchor,
  });
  assert.deepEqual(calls.slice(0, 2), [
    ['render', true],
    ['anchor', scrollAnchor],
  ]);
  assert.equal(calls[2].parentViewUrl, '/?surface=albums&all_artists=1');
  assert.equal(calls[2].galleryAnchorArtist, 'Battlelore');
  assert.equal(calls[2].preserveScroll, true);
  assert.equal(calls[2].semanticScrollAnchor, scrollAnchor);
  assert.equal(calls[2].preserveAbsoluteScroll, undefined);
  assert.equal(calls[2].absoluteScrollPosition, undefined);
  assert.equal(calls.length, 3);
});

test('mobile album capture drops a transient jump anchor after ordinary gallery scrolling', () => {
  let rowsTop = 98;
  const scroll = {
    clientTop: 2,
    getBoundingClientRect: () => ({ top: 96, bottom: 780 }),
  };
  const section = {
    querySelector: selector => (
      selector === '.artist-rows'
        ? { getBoundingClientRect: () => ({ top: rowsTop }) }
        : { getBoundingClientRect: () => ({ top: rowsTop }) }
    ),
  };
  const header = { getAttribute: () => 'Battlelore', closest: () => section };
  const context = load('mobile-navigation.js', {
    state: {
      view: {
        gallery_page: {
          anchor_artist: 'Battlelore',
          anchor_group_artist: 'Battlelore',
        },
      },
    },
    document: {
      getElementById: id => id === 'albums-scroll' ? scroll : null,
      querySelectorAll: () => [header],
    },
  });

  assert.equal(context.captureMobileParentGalleryAnchorArtist(), 'Battlelore');
  rowsTop = 99;
  assert.equal(context.captureMobileParentGalleryAnchorArtist(), '',
    'one pixel of user-owned movement must end transient jump ownership');
  rowsTop = 240;
  assert.equal(context.captureMobileParentGalleryAnchorArtist(), '');
});

test('mobile Back restores the exact departure anchor after one-pixel movement from a jump', () => {
  const calls = [];
  const departureAnchor = {
    albumKey: 'album-after-one-pixel-scroll',
    sectionOccurrenceKey: 'artist:battlelore',
    offsetTop: 1,
    scrollTop: 321,
    scrollLeft: 0,
  };
  const jumpAnchor = {
    albumKey: 'battlelore-album',
    sectionOccurrenceKey: 'artist:battlelore',
    offsetTop: 0,
    scrollTop: 320,
    scrollLeft: 0,
  };
  const context = load('mobile-navigation.js', {
    state: {
      view: {
        gallery_page: {
          anchor_artist: 'Battlelore',
          anchor_group_artist: 'Battlelore',
        },
      },
    },
    virtualGrid: {
      scrollToArtist: artist => {
        calls.push(['align', artist]);
        return true;
      },
      captureScrollAnchor: () => jumpAnchor,
      render: force => calls.push(['render', force]),
      restoreOwnedScrollAnchor: anchor => calls.push(['anchor', anchor]),
      getUserScrollIntentGeneration: () => 9,
    },
    stabilizeRootGalleryArtistAlignment: artist => calls.push(['stabilize', artist]),
    handleGalleryBootstrapPopState: options => calls.push(['request', options]),
  });

  context.restoreMobileGalleryParent({
    parentViewUrl: '/?surface=albums&all_artists=1',
    parentGalleryAnchorArtist: 'Battlelore',
    parentScrollPosition: { scrollTop: 321, scrollLeft: 0 },
    parentScrollAnchor: departureAnchor,
  });

  const restored = calls.find(call => call[0] === 'anchor');
  const request = calls.find(call => call[0] === 'request');
  assert.equal(restored[1], departureAnchor);
  assert.equal(request[1].semanticScrollAnchor, departureAnchor);
});

test('mobile Back reconciles an unproven transient artist after optimistic alignment', () => {
  const calls = [];
  const jumpAnchor = {
    albumKey: 'battlelore-album',
    sectionOccurrenceKey: 'artist:battlelore',
    offsetTop: 0,
    scrollTop: 320,
    scrollLeft: 0,
  };
  const context = load('mobile-navigation.js', {
    state: {
      view: {
        gallery_page: {
          anchor_artist: 'Battlelore',
          anchor_group_artist: 'Battlelore (canonical)',
        },
      },
    },
    virtualGrid: {
      scrollToArtist: artist => {
        calls.push(['align', artist]);
        return true;
      },
      captureScrollAnchor: () => jumpAnchor,
      getUserScrollIntentGeneration: () => 9,
    },
    stabilizeRootGalleryArtistAlignment: artist => calls.push(['stabilize', artist]),
    handleGalleryBootstrapPopState: options => calls.push(options),
  });

  context.restoreMobileGalleryParent({
    parentViewUrl: '/?surface=albums&all_artists=1',
    parentGalleryAnchorArtist: 'Battlelore',
    parentScrollPosition: { scrollTop: 320, scrollLeft: 0 },
  });

  assert.deepEqual(calls.slice(0, 2), [
    ['align', 'Battlelore (canonical)'],
    ['stabilize', 'Battlelore (canonical)'],
  ]);
  assert.equal(calls[2].preserveScroll, true);
  assert.equal(calls[2].preserveMountedGalleryChildren, true);
  assert.equal(calls[2].semanticScrollAnchor, jumpAnchor);
  assert.equal(calls[2].semanticScrollOwnerGeneration, 9);
  assert.equal(calls[2].parentViewUrl, '/?surface=albums&all_artists=1');
  assert.equal(calls[2].galleryAnchorArtist, 'Battlelore');
  assert.equal(calls.length, 3);
});

test('mobile Back reloads a missing retained artist without pushing gallery history', () => {
  const calls = [];
  const context = load('mobile-navigation.js', {
    state: {
      view: {
        gallery_page: {
          anchor_artist: 'Battlelore',
          anchor_group_artist: 'Battlelore (canonical)',
        },
      },
    },
    virtualGrid: {
      scrollToArtist: artist => {
        calls.push(['align', artist]);
        return false;
      },
    },
    stabilizeRootGalleryArtistAlignment: artist => calls.push(['stabilize', artist]),
    handleGalleryBootstrapPopState: options => calls.push(['reload', options]),
  });

  context.restoreMobileGalleryParent({
    parentViewUrl: '/?surface=albums&all_artists=1',
    parentGalleryAnchorArtist: 'Battlelore',
    parentScrollPosition: { scrollTop: 320, scrollLeft: 0 },
  });

  assert.deepEqual(calls[0], ['align', 'Battlelore (canonical)']);
  assert.equal(calls[1][0], 'reload');
  assert.equal(calls[1][1].preserveScroll, false);
  assert.equal(calls[1][1].parentViewUrl, '/?surface=albums&all_artists=1');
  assert.equal(calls[1][1].galleryAnchorArtist, 'Battlelore');
  assert.equal(calls.length, 2);
});

test('nested mobile presentation inherits the root canonical route without creating another history entry', () => {
  const context = load('mobile-navigation.js', {
    window: { innerWidth: 390, history: { state: { albumHavenNavigationPosition: 3 } } },
    document: { getElementById: () => ({}) }, state: { view: {} },
    buildUrl: () => { throw new Error('Nested pages must inherit the retained root route'); },
  });
  context.syncMobilePageShell = () => {};
  context.writeMobilePageHistory = () => { throw new Error('Same page presentation must not push history'); };
  vm.runInContext("mobilePageState.pages.push({kind:'album',albumKey:'one',parentViewUrl:'/?surface=albums'}, {kind:'cover-lookup',albumKey:'one'});", context);
  assert.equal(context.presentMobilePage({ kind: 'cover-lookup', albumKey: 'one' }), true);
  assert.equal(vm.runInContext('mobilePageState.pages[1].parentViewUrl', context), '/?surface=albums');
});

test('mobile popstate restores canonical route and scroll only at the immediate parent destination', () => {
  for (const destination of [1, 2]) {
    const calls = [], restored = [];
    const context = load('mobile-navigation.js', {
      window: { history: { state: { albumHavenNavigationPosition: destination, mobilePages: [] } } },
      virtualGrid: { restoreOwnedAbsoluteScrollPosition: position => { restored.push(position.scrollTop); return true; }, render() {} },
      syncGalleryMainStateFromLocation() {}, getBrowserLocationHref: () => '/?q=Gallery+A',
      fetchAndRender: (...args) => calls.push(args),
    });
    vm.runInContext(fs.readFileSync(path.join(runtime, 'bootstrap-gallery-event-handlers.js'), 'utf8'), context);
    context.cleanupMobilePage = () => null;
    context.syncMobilePageShell = () => {};
    vm.runInContext("mobilePageState.pages.push({kind:'album',albumKey:'one',parentPosition:2,parentViewUrl:'/?surface=albums&q=Gallery+B',parentScrollPosition:{scrollTop:800,scrollLeft:0}});", context);
    assert.equal(context.handleMobilePagePopState(), true);
    assert.equal(calls[0][0], destination === 2 ? '/?surface=albums&q=Gallery+B' : '/?q=Gallery+A');
    assert.equal(calls[0][1], false);
    assert.deepEqual(restored, destination === 2 ? [800] : []);
  }
});

test('canonical parent restoration uses one route for Gallery controls and its data request', () => {
  const calls = [];
  const context = load('bootstrap-gallery-event-handlers.js', {
    syncGalleryMainStateFromLocation: url => calls.push(['controls', url]),
    getBrowserLocationHref: () => '/?gallery_display=list',
    fetchAndRender: url => calls.push(['data', url]),
  });
  context.handleGalleryBootstrapPopState({ parentViewUrl: '/?surface=albums&artist=Northlight' });
  assert.deepEqual(calls, [['controls', '/?surface=albums&artist=Northlight'], ['data', '/?surface=albums&artist=Northlight']]);
});

test('anchored parent restoration reloads the same root window without exposing the anchor in browser history', () => {
  const calls = [];
  const context = load('bootstrap-gallery-event-handlers.js', {
    URLSearchParams,
    syncGalleryMainStateFromLocation: url => calls.push(['controls', url]),
    getBrowserLocationHref: () => '/?surface=albums&all_artists=1',
    parseBrowserUrlState: () => ({ surface: { active: 'albums' }, all_artists_active: true }),
    buildApiUrl: (_view, options) => `/view-data?surface=albums&all_artists=1&gallery_anchor_artist=${encodeURIComponent(options.galleryAnchorArtist)}`,
    fetchAndRender: (url, push, options) => calls.push(['data', url, push, options]),
  });
  const options = {
    parentViewUrl: '/?surface=albums&all_artists=1',
    galleryAnchorArtist: 'Battlelore',
  };

  context.handleGalleryBootstrapPopState(options);

  assert.deepEqual(calls[0], ['controls', '/?surface=albums&all_artists=1']);
  assert.deepEqual(calls[1].slice(0, 3), [
    'data',
    '/view-data?surface=albums&all_artists=1&gallery_anchor_artist=Battlelore',
    false,
  ]);
  assert.equal(calls[1][3], options);
});

for (const width of [390, 1180]) test(`mobile duplicate Folder action is unavailable at ${width}px while Files browsing stays intact`, () => {
  const captures = [];
  const context = load('mobile-navigation.js', {
    URL,
    window: { innerWidth: width, location: { href: 'https://example.test/?surface=albums' },
      AlbumHavenDevicePreferences: { profile: () => 'mobile', read: (_key, fallback) => fallback },
      addEventListener() {}, matchMedia: () => ({ addEventListener() {} }) },
    document: { getElementById: id => id === 'mobile-navigation' ? {} : null, createComment: () => ({}),
      addEventListener: (name, handler, capture) => { if (name === 'click' && capture) captures.push(handler); },
      documentElement: { dataset: {}, style: { setProperty() {} } } },
    state: { utility: { activeTab: 'appearance' } },
  });
  context.promoteVisibleMobileDialogs = () => {};
  context.initMobileNavigation();
  const click = selector => {
    let prevented = false, stopped = false;
    const event = { target: { closest: selectors => selectors.split(',').map(item => item.trim()).includes(selector) ? {} : null },
      preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } };
    captures.forEach(handler => handler(event));
    return { prevented, stopped };
  };
  assert.deepEqual(click('[data-open-track-modal-duplicate-folder]'), { prevented: true, stopped: true });
  assert.deepEqual(click('[data-track-duplicate-source-index]'), { prevented: false, stopped: false });
  const css = fs.readFileSync(path.join(runtime, '../../css/mobile-layout.css'), 'utf8');
  const hidden = css.match(/html\[data-client-profile="mobile"\] :is\(([^)]+)\) \{ display: none !important; \}/)[1];
  assert.ok(hidden.includes('[data-open-track-modal-duplicate-folder]'));
  assert.equal(hidden.includes('[data-track-duplicate-source-index]'), false);
});

test('mobile action controls preserve a 40px touch target at phone width', () => { const css = fs.readFileSync(path.join(runtime, '../../css/mobile-layout.css'), 'utf8'); const actionRule = css.match(/\.mobile-bar-action\s*\{[^}]*flex:\s*0\s+0\s+40px[^}]*\}/)?.[0] || ''; assert.notEqual(actionRule, ''); }); test('mobile gallery geometry keeps requested one, two, and three-column taps within the viewport', () => {
  for (const [viewportWidth, availableWidth] of [[320, 296], [390, 366], [480, 456]]) {
    for (const columns of [1, 2, 3]) {
      const geometry = preferences.resolveMobileGalleryGeometry({ viewportWidth, availableWidth, columns, gap: 12 });
      assert.equal(geometry.columns, columns);
      assert.ok(geometry.cardTrackWidth >= 0);
      assert.ok(geometry.cardTrackWidth * columns + 12 * (columns - 1) <= availableWidth);
    }
  }
});

test('mobile gallery cards do not move when touch hover or focus changes during scroll', () => {
  const css = fs.readFileSync(path.join(runtime, '../../css/mobile-layout.css'), 'utf8');
  assert.match(
    css,
    /\.album-card:is\(:hover, :focus-within\)\s*\{[^}]*transform:\s*none;/,
  );
});
