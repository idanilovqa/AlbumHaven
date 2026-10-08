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
  assert.equal(calls[2][1].absoluteScrollPosition,position);
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