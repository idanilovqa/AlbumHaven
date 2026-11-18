const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'shell-navigation-drawer.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function createClassList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    toggle(value, force) {
      if (force === undefined) {
        if (values.has(value)) values.delete(value);
        else values.add(value);
        return values.has(value);
      }
      if (force) values.add(value);
      else values.delete(value);
      return values.has(value);
    },
    contains(value) { return values.has(value); },
  };
}

{
  const { context } = loadHelper({ isMobile: false });
  let closeReturnFocus = null;
  context.galleryMainSurfaceController = {
    current: () => ({ key: 'artist:Neal Morse' }),
  };
  context.closeGalleryMainSurface = (returnFocus) => {
    closeReturnFocus = returnFocus;
  };

  context.toggleArtistTreeFold();

  assert.equal(closeReturnFocus, false);
}

function createElement() {
  const attributes = new Map();
  const listeners = new Map();
  return {
    hidden: false,
    dataset: {},
    classList: createClassList(),
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    focus() {},
    contains(target) {
      return target === this;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatchEvent(event) {
      listeners.get(event.type)?.(event);
    },
  };
}

function loadHelper({ isMobile = false, artistTreeFolded = false, savedArtistTreeFolded = null } = {}) {
  const drawerRail = createElement();
  const modeRail = createElement();
  const modeRailAnchor = createElement();
  const drawerBackdrop = createElement();
  const foldButton = createElement();
  const navigationButton = createElement();
  const expandedTree = createElement();
  const compactNavigation = createElement();
  const artistList = createElement();
  const navigationHeading = createElement();
  const appShell = createElement();
  const documentElement = createElement();
  const rootStyles = new Map();
  documentElement.style = {
    setProperty(name, value) { rootStyles.set(name, value); },
  };
  const body = createElement();
  const documentListeners = new Map();
  const document = {
    body,
    documentElement,
    activeElement: null,
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (documentListeners.get(type) === listener) documentListeners.delete(type);
    },
    dispatchEvent(event) {
      documentListeners.get(event.type)?.(event);
    },
    getElementById(id) {
      return {
        'app-shell': appShell,
        'shell-navigation-rail': drawerRail,
        'mobile-tree-edge-anchor': modeRailAnchor,
        'shell-navigation-rail-backdrop': drawerBackdrop,
        'artist-tree-fold-button': foldButton,
        'artist-tree-navigation-button': navigationButton,
        'artist-tree-expanded': expandedTree,
        'shell-navigation-compact': compactNavigation,
        'sidebar-list': artistList,
        'library-navigation-heading': navigationHeading,
      }[id] || null;
    },
    querySelector(selector) {
      return selector === '.library-navigation-mode-rail' ? modeRail : null;
    },
    querySelectorAll() { return []; },
  };
  const pendingTimers = new Map();
  let nextTimerId = 0;
  const resizeEvents = [];
  const startingEvents = [];
  const settledEvents = [];
  const context = {
    state: {
      view: {
        shell_layout: {
          slots: {
            navigation_rail: {
              content_kind: 'artists_sidebar',
            },
          },
        },
      },
      ui: {
        artistsDrawerOpen: false,
        artistTreeFolded,
        shellLayoutPreferences: {
          contextualPaneWidthPx: 320,
          infoDrawerWidthPx: 360,
          artistTreeFolded: savedArtistTreeFolded,
        },
      },
    },
    document,
    window: {
      matchMedia: () => ({
        matches: isMobile,
      }),
      innerWidth: isMobile ? 480 : 1200,
      dispatchEvent(event) {
        this.lastEvent = event;
        if (event.type === 'resize') resizeEvents.push(event);
        if (event.type === 'album-haven:artist-tree-toggle-starting') {
          startingEvents.push({ event, folded: appShell.classList.contains('is-artist-tree-folded') });
        }
        if (event.type === 'album-haven:artist-tree-settled') settledEvents.push(event);
      },
      getComputedStyle: () => ({
        getPropertyValue: name => name === '--compact-motion-duration' ? '420ms' : '',
      }),
    },
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      callback.delay = delay;
      pendingTimers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      pendingTimers.delete(id);
    },
    Event: class Event { constructor(type) { this.type = type; } },
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    console,
    persistShellLayoutPreferences() {
      context.persistShellLayoutPreferencesCallCount += 1;
    },
    persistShellLayoutPreferencesCallCount: 0,
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return {
    context,
    drawerRail,
    modeRail,
    modeRailAnchor,
    drawerBackdrop,
    foldButton,
    navigationButton,
    expandedTree,
    compactNavigation,
    artistList,
    navigationHeading,
    appShell,
    body,
    documentElement,
    rootStyles,
    pendingTimers,
    resizeEvents,
    startingEvents,
    settledEvents,
  };
}

function stubCollectionTree(context) {
  const renderedOptions = [];
  context.window.NavigationTree = {
    renderSeparator: ({ label }) => `<div class="navigation-tree-separator" role="separator" aria-label="${label}"></div>`,
    renderSkeleton: ({ count }) => `<div data-navigation-tree-skeleton="${count}"></div>`,
    renderItem: (options) => {
      renderedOptions.push(options);
      const collection = options.attributes['data-open-custom-collection'];
      return collection
        ? `<button data-open-custom-collection="${collection}">${options.label}:${options.count}</button>`
        : '<button data-open-loose-tracks="1">All Loose Tracks</button>';
    },
  };
  context.hydrateDeferredNonAlbumTracks = () => {
    throw new Error('the Custom Collections tree must not load Loose Tracks');
  };
  return renderedOptions;
}

function stubCatalogFetch(context) {
  const requests = [];
  context.URL = URL;
  context.fetch = (path) => new Promise((resolve) => {
    requests.push({ path, respond: (collections, status = 200) => resolve({
      ok: status < 400, status, json: async () => (status < 400 ? { custom_collections: collections } : { ok: false, error: 'boom' }),
    }) });
  });
  return requests;
}

test('custom collections tree loads its bounded catalog, not Loose Tracks, and ignores the selected artist', async () => {
  const { context, artistList, navigationHeading } = loadHelper();
  artistList.dataset.sidebarStructureSignature = 'cached-artists';
  context.renderSidebar = () => { throw new Error('Artists must not render in collection mode'); };
  context.state.view.selected_artist = '3 Mice';
  context.state.view.visible_library_categories = ['main_library', 'hoard'];
  const renderedOptions = stubCollectionTree(context);
  const requests = stubCatalogFetch(context);

  const pending = context.setLibraryNavigationMode('custom-collections');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/library/custom-collections?category=main_library&category=hoard');
  assert.equal(navigationHeading.textContent, 'Custom Collections');
  assert.match(artistList.innerHTML, /^<button data-open-loose-tracks="1">All Loose Tracks<\/button><div class="navigation-tree-separator"[^>]*><\/div><div data-navigation-tree-skeleton="3"><\/div>$/);
  requests[0].respond([{ name: 'Night', count: 2 }, { name: 'Женя машина', count: 85 }]);
  await pending;

  assert.equal(context.state.ui.libraryNavigationMode, 'custom-collections');
  assert.match(artistList.innerHTML, /<button data-open-custom-collection="Night">Night:2<\/button><button data-open-custom-collection="Женя машина">Женя машина:85<\/button>$/);
  assert.doesNotMatch(artistList.innerHTML, /skeleton/);
  assert.deepEqual(renderedOptions.filter(({ key }) => key !== 'all-loose-tracks').map(({ selected }) => selected), [false, false]);
  assert.equal(artistList.dataset.sidebarStructureSignature, undefined);
});

test('a search narrows the collections tree and dots the Custom Collections button', async () => {
  // Owner 2026-11-17: searching also searches Custom Collections: a blue dot on the button, only matching
  // collections in the tree, and their tables filtered to the matches.
  const { context, artistList } = loadHelper();
  stubCollectionTree(context);
  const buttons = [{ attributes: new Map() }, { attributes: new Map() }].map((button) => Object.assign(button, {
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  }));
  context.document.querySelectorAll = selector => (
    selector === '[data-library-navigation-mode="custom-collections"]' ? buttons : []
  );
  const requests = [];
  context.URL = URL;
  context.fetch = (path) => {
    requests.push(path);
    const matches = path.includes('q=night');
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      custom_collections: matches ? [{ name: 'Night', count: 1 }] : [],
      loose_tracks_count: matches ? 3 : 0,
    }) });
  };
  context.escapeHtml = value => String(value);
  context.state.view.query = 'night';
  // An artist matches too, so the search keeps its artist rather than opening a collection.
  context.state.view.artists_sidebar = [{ artist: 'Night Ranger' }];

  await context.syncCustomCollectionSearchIndicator();
  assert.equal(requests.at(-1), '/library/custom-collections?q=night');
  assert.deepEqual(buttons.map(button => button.attributes.get('data-search-results')), ['true', 'true']);
  // Owner 2026-11-17: every sidebar redraw during a search refetched the catalog and all its artwork.
  await context.syncCustomCollectionSearchIndicator();
  await context.syncCustomCollectionSearchIndicator();
  assert.equal(requests.length, 1, 'redraws reuse the loaded catalog');
  await context.setLibraryNavigationMode('custom-collections');
  assert.match(artistList.innerHTML, /<button data-open-custom-collection="Night">Night:1<\/button>$/);
  assert.equal(artistList.dataset.customCollectionsSearch, '?q=night');

  context.state.view.query = 'nothing';
  await context.syncCustomCollectionSearchIndicator();
  assert.deepEqual(buttons.map(button => button.attributes.has('data-search-results')), [false, false]);
  await context.setLibraryNavigationMode('custom-collections');
  assert.match(artistList.innerHTML, /No collection matches “nothing”\./);

  context.state.view.query = '';
  await context.syncCustomCollectionSearchIndicator();
  assert.deepEqual(buttons.map(button => button.attributes.has('data-search-results')), [false, false]);
});

test('reopening custom collections paints the cached catalog at once and refreshes it in place', async () => {
  const { context, artistList } = loadHelper();
  stubCollectionTree(context);
  const requests = stubCatalogFetch(context);
  const first = context.setLibraryNavigationMode('custom-collections');
  requests[0].respond([{ name: 'Cached', count: 1 }]);
  await first;
  await context.setLibraryNavigationMode('artists').catch?.(() => {});

  const second = context.setLibraryNavigationMode('custom-collections');

  assert.match(artistList.innerHTML, /data-open-custom-collection="Cached"/);
  assert.doesNotMatch(artistList.innerHTML, /skeleton/);
  requests[1].respond([{ name: 'Cached', count: 1 }, { name: 'New', count: 4 }]);
  await second;
  assert.match(artistList.innerHTML, /data-open-custom-collection="New">New:4/);
});

test('a failed catalog request keeps a cached tree and explains an empty one', async () => {
  const { context, artistList } = loadHelper();
  stubCollectionTree(context);
  const requests = stubCatalogFetch(context);
  context.escapeHtml = value => String(value);
  const failing = context.setLibraryNavigationMode('custom-collections');
  requests[0].respond([], 502);
  await failing;
  assert.match(artistList.innerHTML, /Unable to load Custom Collections|boom/);
  assert.match(artistList.innerHTML, /data-open-loose-tracks="1"/, 'All Loose Tracks stays usable without the catalog');
});

test('desktop library mode rail hides after 30 seconds idle, then reveals at the left edge', () => {
  const {
    context, drawerRail, modeRailAnchor, artistList, pendingTimers, rootStyles,
  } = loadHelper({ isMobile: false });
  context.syncArtistsDrawerVisibility();

  drawerRail.dispatchEvent({ type: 'pointerenter', target: drawerRail });

  const idleTimer = [...pendingTimers.values()].find(callback => callback.delay === 30000);
  assert.ok(idleTimer, 'a stationary cursor must not cancel the inactivity timer');
  idleTimer();
  assert.equal(drawerRail.classList.contains('is-library-mode-rail-hidden'), true);
  assert.equal(modeRailAnchor.hidden, false);
  assert.equal(rootStyles.get('--compact-rail-width'), '261px');

  modeRailAnchor.dispatchEvent({ type: 'pointerenter', target: modeRailAnchor });
  assert.equal(
    drawerRail.classList.contains('is-library-mode-rail-hidden'),
    true,
    'showing the anchor under a stationary cursor must not reopen the rail',
  );
  context.document.dispatchEvent({ type: 'pointermove', clientX: 2, clientY: 700 });
  assert.equal(
    drawerRail.classList.contains('is-library-mode-rail-hidden'),
    true,
    'near the edge must not reveal the rail',
  );
  context.document.dispatchEvent({ type: 'pointermove', clientX: 1, clientY: 700 });
  assert.equal(drawerRail.classList.contains('is-library-mode-rail-hidden'), false);
  assert.equal(modeRailAnchor.hidden, true);
  assert.equal(rootStyles.get('--compact-rail-width'), '320px');

  const nextIdleTimer = [...pendingTimers.values()].find(callback => callback.delay === 30000);
  nextIdleTimer();
  context.handleArtistsDrawerClick({
    target: {
      closest: selector => selector === '[data-reveal-library-mode-rail="1"]' ? modeRailAnchor : null,
    },
    preventDefault() {},
  });
  assert.equal(drawerRail.classList.contains('is-library-mode-rail-hidden'), false);

  artistList.dispatchEvent({ type: 'scroll', target: artistList });
  assert.ok(
    [...pendingTimers.values()].some(callback => callback.delay === 30000),
    'tree scrolling must reset the desktop idle timer',
  );
});

test('a modal over the gallery keeps the left edge from expanding the side panel', () => {
  // Owner 2026-11-16: "when some kind of modal opened ... moving a mouse/cursor to the left side of the
  // screen SHOULD NOT trigger side bar expanding".
  const { context, drawerRail, modeRailAnchor, pendingTimers, rootStyles, body } = loadHelper({ isMobile: false });
  context.syncArtistsDrawerVisibility();
  drawerRail.dispatchEvent({ type: 'pointerenter', target: drawerRail });
  [...pendingTimers.values()].find(callback => callback.delay === 30000)();
  assert.equal(drawerRail.classList.contains('is-library-mode-rail-hidden'), true);

  body.classList.add('modal-open');
  context.document.dispatchEvent({ type: 'pointermove', clientX: 0, clientY: 400 });
  context.document.dispatchEvent({ type: 'pointermove', clientX: 1, clientY: 700 });
  assert.equal(drawerRail.classList.contains('is-library-mode-rail-hidden'), true);
  assert.equal(modeRailAnchor.hidden, false);
  assert.equal(rootStyles.get('--compact-rail-width'), '261px');

  body.classList.remove('modal-open');
  context.document.dispatchEvent({ type: 'pointermove', clientX: 1, clientY: 700 });
  assert.equal(drawerRail.classList.contains('is-library-mode-rail-hidden'), false, 'without a modal the edge still reveals');
  assert.equal(rootStyles.get('--compact-rail-width'), '320px');
});

test('folded desktop navigation keeps the library mode rail visible', () => {
  const { context, drawerRail, modeRailAnchor, pendingTimers } = loadHelper({
    isMobile: false, artistTreeFolded: true,
  });
  context.syncArtistsDrawerVisibility();

  for (const callback of pendingTimers.values()) callback();
  assert.equal(drawerRail.classList.contains('is-library-mode-rail-hidden'), false);
  assert.equal(modeRailAnchor.hidden, true);
});

test('custom collections mode ignores a stale prior collection when its page is closed', async () => {
  const { context } = loadHelper();
  context.state.ui.nonAlbumCollectionName = 'Night';
  const requests = stubCatalogFetch(context);
  let renderedOptions = null;
  context.window.NavigationTree = {
    renderSeparator: ({ label }) => `<div class="navigation-tree-separator" role="separator" aria-label="${label}"></div>`,
    renderSkeleton: () => '',
    renderItem(options) { renderedOptions = options; return '<button>Night</button>'; },
  };

  const pending = context.setLibraryNavigationMode('custom-collections');
  requests[0].respond([{ name: 'Night', count: 2 }]);
  await pending;

  assert.equal(renderedOptions.selected, false);
});

test('custom collections mode selects the collection whose page is open', async () => {
  const { context } = loadHelper();
  context.state.ui.nonAlbumCollectionName = 'Night';
  context.state.ui.nonAlbumLibraryWide = true;
  const requests = stubCatalogFetch(context);
  const originalQuerySelector = context.document.querySelector.bind(context.document);
  context.document.querySelector = selector => (
    selector === '#non-album-modal:not([hidden])'
      ? { hidden: false }
      : originalQuerySelector(selector)
  );
  const renderedOptions = [];
  context.window.NavigationTree = {
    renderSeparator: ({ label }) => `<div role="separator" aria-label="${label}"></div>`,
    renderSkeleton: () => '',
    renderItem(options) { renderedOptions.push(options); return '<button></button>'; },
  };

  const pending = context.setLibraryNavigationMode('custom-collections');
  requests[0].respond([{ name: 'Night', count: 119 }]);
  await pending;

  assert.equal(renderedOptions.find(option => option.key === 'all-loose-tracks').selected, false);
  assert.equal(renderedOptions.find(option => option.key === 'Night').selected, true);
});

test('library navigation delegates modes and routes Loose Tracks without per-row listeners', () => {
  const { context } = loadHelper();
  const calls = [];
  context.setLibraryNavigationMode = mode => { calls.push(['mode', mode]); };
  context.openLooseTracksPage = options => { calls.push(['loose-tracks', options]); };
  context.closeArtistsDrawer = options => { calls.push(['close', options]); };
  context.window.NavigationTree = { setSelection: (list, key) => calls.push(['selection', list?.id, key]) };
  context.isArtistsDrawerMobileViewport = () => true;
  let prevented = 0;
  const event = target => ({ target, preventDefault() { prevented += 1; } });
  const mode = { getAttribute: () => 'custom-collections' };
  assert.equal(context.handleLibraryNavigationClick(event({
    closest: selector => selector === '[data-library-navigation-mode]' ? mode : null,
  })), true);
  const collection = { getAttribute: () => 'Night' };
  assert.equal(context.handleLibraryNavigationClick(event({
    closest: selector => selector === '[data-open-custom-collection]' ? collection : null,
  })), true);
  const allLooseTracks = { getAttribute: () => '1' };
  assert.equal(context.handleLibraryNavigationClick(event({
    closest: selector => selector === '[data-open-loose-tracks]' ? allLooseTracks : null,
  })), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['mode', 'custom-collections'],
    ['loose-tracks', { collectionName: 'Night' }],
    ['close', { restoreFocus: false }],
    ['loose-tracks', { collectionName: '' }],
    ['close', { restoreFocus: false }],
  ]);
  assert.equal(prevented, 3);
});

test('compact Artists and Custom Collections actions restore the selected expanded view', () => {
  for (const mode of ['artists', 'custom-collections']) {
    const { context } = loadHelper({ artistTreeFolded: true });
    const calls = [];
    context.setLibraryNavigationMode = selectedMode => { calls.push(selectedMode); };
    context.toggleArtistTreeFold = () => { calls.push('expand'); };
    const button = {
      getAttribute: name => name === 'data-library-navigation-mode' ? mode : '',
    };

    const handled = context.handleArtistsDrawerClick({
      target: { closest: selector => selector === '[data-toggle-artist-tree-fold="1"]' ? button : null },
      preventDefault() {},
    });

    assert.equal(handled, true);
    assert.deepEqual(calls, [mode, 'expand']);
  }
});

test('compact Artists and Custom Collections template actions route and expand together', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'index.html'), 'utf8');
  const compactNavigation = template.slice(
    template.indexOf('<nav class="shell-navigation-compact"'),
    template.indexOf('</nav>', template.indexOf('<nav class="shell-navigation-compact"')),
  );

  assert.match(compactNavigation, /Artist Tree[\s\S]*data-toggle-artist-tree-fold[\s\S]*data-library-navigation-mode[^}]*artists/);
  assert.match(compactNavigation, /Custom Collections[\s\S]*data-toggle-artist-tree-fold[\s\S]*data-library-navigation-mode[^}]*custom-collections/);
  assert.doesNotMatch(compactNavigation, /data-library-navigation-mode[^}]*loose-tracks/);
});

test('library navigation uses the approved collection glyph and generic mobile close label', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'index.html'), 'utf8');
  const collectionActions = template.match(/action_button\('Custom Collections'[\s\S]*?<\/svg>\{% endcall %\}/g) || [];

  assert.equal(collectionActions.length, 2);
  for (const action of collectionActions) {
    assert.match(action, /M6 14V3\.5c2\.7 2\.2 5\.3 3\.4 8\.5 4\.6V14/);
    assert.match(action, /ellipse cx="3\.5" cy="15" rx="3" ry="2\.2"/);
    assert.match(action, /ellipse cx="11\.8" cy="15\.5" rx="3" ry="2\.2"/);
    assert.match(action, /circle cx="15\.5" cy="15" r="5\.2"/);
    assert.match(action, /m19\.2 18\.7 3\.3 3\.3/);
  }
  assert.doesNotMatch(template, /action_button\('Loose Tracks'[\s\S]*data-library-navigation-mode/);
  assert.match(template, /action_button\('Close library navigation'/);
  assert.doesNotMatch(template, /Back from Artists/);
});

{
  const { context, drawerRail } = loadHelper({
    artistTreeFolded: null,
    savedArtistTreeFolded: true,
  });
  drawerRail.dataset.shellDefaultCollapsed = 'false';

  const folded = context.syncArtistTreeFoldVisibility();

  assert.equal(folded, true);
  assert.equal(context.state.ui.artistTreeFolded, true);
}

{
  const { context, drawerRail, drawerBackdrop, body } = loadHelper({ isMobile: true });

  const opened = context.openArtistsDrawer();

  assert.equal(opened, true);
  assert.equal(context.state.ui.artistsDrawerOpen, true);
  assert.equal(drawerRail.getAttribute('aria-hidden'), 'false');
  assert.equal(drawerBackdrop.hidden, false);
  assert.equal(drawerRail.classList.contains('is-mobile-drawer-open'), true);
  assert.equal(body.classList.contains('artists-drawer-open'), true);
}

test('mobile mode rail stays visible and never exposes the edge anchor', () => {
  const { context, drawerRail, modeRailAnchor } = loadHelper({ isMobile: true });
  context.state.ui.artistsDrawerOpen = true;
  const visible = context.setMobileLibraryModeRailVisible(false);

  assert.equal(visible, true);
  assert.equal(context.state.ui.mobileLibraryModeRailVisible, true);
  assert.equal(drawerRail.classList.contains('is-mobile-mode-rail-hidden'), false);
  assert.equal(modeRailAnchor.hidden, true);
});

test('first drawer open selects the button for the tree already displayed', () => {
  const { context, artistList, navigationHeading } = loadHelper({ isMobile: true });
  const artistsButton = createElement();
  artistsButton.setAttribute('data-library-navigation-mode', 'artists');
  const collectionsButton = createElement();
  collectionsButton.setAttribute('data-library-navigation-mode', 'custom-collections');
  context.document.querySelectorAll = selector => selector === '[data-library-navigation-mode]'
    ? [artistsButton, collectionsButton]
    : [];
  artistList.dataset.navigationTree = 'custom-collections';

  context.openArtistsDrawer();

  assert.equal(artistsButton.getAttribute('aria-pressed'), 'false');
  assert.equal(artistsButton.classList.contains('is-active'), false);
  assert.equal(collectionsButton.getAttribute('aria-pressed'), 'true');
  assert.equal(collectionsButton.classList.contains('is-active'), true);
  assert.equal(navigationHeading.textContent, 'Custom Collections');
});

test('drawer hamburgers open their owning tree mode', () => {
  const { context } = loadHelper({ isMobile: true });
  const modes = [];
  let toggles = 0;
  context.setLibraryNavigationMode = async mode => { modes.push(mode); };
  context.toggleArtistsDrawer = () => { toggles += 1; };

  for (const mode of ['custom-collections', 'artists']) {
    const trigger = {
      getAttribute: name => name === 'data-library-navigation-mode' ? mode : null,
    };
    context.handleArtistsDrawerClick({
      target: { closest: selector => selector === '[data-toggle-artists-drawer="1"]' ? trigger : null },
      preventDefault() {},
    });
  }

  assert.deepEqual(modes, ['custom-collections', 'artists']);
  assert.equal(toggles, 2);
});

test('drawer hamburger selects the mode of the tree already displayed', () => {
  const { context, artistList } = loadHelper({ isMobile: true });
  const modes = [];
  context.setLibraryNavigationMode = async mode => { modes.push(mode); };
  context.toggleArtistsDrawer = () => {};

  for (const [displayedMode, staleTriggerMode] of [
    ['artists', 'custom-collections'],
    ['custom-collections', 'artists'],
  ]) {
    artistList.dataset.navigationTree = displayedMode;
    const trigger = {
      getAttribute: name => name === 'data-library-navigation-mode' ? staleTriggerMode : null,
    };
    context.handleArtistsDrawerClick({
      target: { closest: selector => selector === '[data-toggle-artists-drawer="1"]' ? trigger : null },
      preventDefault() {},
    });
  }

  assert.deepEqual(modes, ['artists', 'custom-collections']);
});

for (const isMobile of [true, false]) {
  test(`${isMobile ? 'phone' : 'desktop'}: switching from library Loose Tracks to Artists leaves every artist row unselected`, async () => {
    // Owner 2026-11-15: on a collection page, the Artists tree must not select All artists.
    const { context } = loadHelper({ isMobile });
    context.state.ui.libraryNavigationMode = 'custom-collections';
    context.state.ui.nonAlbumLibraryWide = true;
    const originalQuerySelector = context.document.querySelector.bind(context.document);
    context.document.querySelector = selector => (
      selector === '#non-album-modal:not([hidden])'
        ? {}
        : originalQuerySelector(selector)
    );
    let suppressedDuringRender = false;
    context.renderSidebar = () => {
      suppressedDuringRender = context.state.ui.suppressSidebarSelection === true;
    };

    await context.setLibraryNavigationMode('artists');

    assert.equal(suppressedDuringRender, true);
  });
}

test('an artist Loose Tracks page keeps that artist selected in the Artists tree', async () => {
  const { context } = loadHelper({ isMobile: false });
  context.state.ui.libraryNavigationMode = 'custom-collections';
  context.state.ui.nonAlbumLibraryWide = false;
  const originalQuerySelector = context.document.querySelector.bind(context.document);
  context.document.querySelector = selector => (
    selector === '#non-album-modal:not([hidden])' ? {} : originalQuerySelector(selector)
  );
  context.renderSidebar = () => {};

  await context.setLibraryNavigationMode('artists');

  assert.equal(context.state.ui.suppressSidebarSelection, false);
});

test('mobile artist-tree scrolling does not schedule a mode-rail hide', () => {
  const { context, artistList, pendingTimers } = loadHelper({ isMobile: true });
  context.state.ui.artistsDrawerOpen = true;
  context.setMobileLibraryModeRailVisible(true);
  context.installMobileLibraryModeRailGestures();

  artistList.dispatchEvent({ type: 'scroll' });

  assert.equal(pendingTimers.size, 0);
});

test('returning to desktop clears every mobile-only tree rail state', () => {
  const { context, drawerRail, modeRailAnchor, expandedTree, compactNavigation } = loadHelper({ isMobile: true });
  context.state.ui.artistsDrawerOpen = true;
  context.setMobileLibraryModeRailVisible(false);
  context.syncArtistsDrawerVisibility();
  context.isArtistsDrawerMobileViewport = () => false;

  context.syncArtistsDrawerVisibility();

  assert.equal(drawerRail.classList.contains('is-mobile-mode-rail-hidden'), false);
  assert.equal(drawerRail.classList.contains('is-mobile-drawer'), false);
  assert.equal(drawerRail.classList.contains('is-mobile-drawer-open'), false);
  assert.equal(drawerRail.classList.contains('is-transitioning'), false);
  assert.equal(modeRailAnchor.hidden, true);
  assert.equal(expandedTree.hidden, false);
  assert.equal(compactNavigation.hidden, true);
});

test('pointer mode selection releases focus while the mobile rail stays visible', () => {
  const { context, drawerRail, modeRailAnchor, pendingTimers } = loadHelper({ isMobile: true });
  context.state.ui.artistsDrawerOpen = true;
  context.setLibraryNavigationMode = async () => 'artists';
  let blurred = 0;
  const mode = { getAttribute: () => 'artists', blur() { blurred += 1; } };

  context.handleLibraryNavigationClick({
    detail: 1,
    target: { closest: selector => selector === '[data-library-navigation-mode]' ? mode : null },
    preventDefault() {},
  });

  assert.equal(blurred, 1);
  assert.equal([...pendingTimers.values()].filter(callback => callback.delay === 3500).length, 0);
  assert.equal(drawerRail.classList.contains('is-mobile-mode-rail-hidden'), false);
  assert.equal(modeRailAnchor.hidden, true);
});

test('navigation tree rows stay on one line and expose the edge anchor chevron', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'app-chrome.css'), 'utf8');
  const template = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'index.html'), 'utf8');

  assert.doesNotMatch(css, /\.shell-navigation-rail \.artist-link \.artist-name-label\s*\{/s);
  assert.match(css, /--app-sidebar-width:\s*320px/);
  assert.match(template, /mobile-tree-edge-anchor[\s\S]*&rsaquo;/);
});

{
  const {
    context, drawerRail, foldButton, navigationButton, expandedTree, compactNavigation, artistList, appShell,
    documentElement, resizeEvents, startingEvents, settledEvents,
  } = loadHelper({ isMobile: false });
  drawerRail.contains = target => target === foldButton;
  context.document.activeElement = foldButton;
  navigationButton.focus = () => { context.document.activeElement = navigationButton; };

  const folded = context.toggleArtistTreeFold();

  assert.equal(startingEvents.length, 1);
  assert.equal(startingEvents[0].folded, false, 'The gallery anchor must be captured before folded layout begins');
  assert.equal(folded, true);
  assert.equal(context.state.ui.artistTreeFolded, true);
  assert.equal(context.state.ui.shellLayoutPreferences.artistTreeFolded, true);
  assert.equal(context.persistShellLayoutPreferencesCallCount, 1);
  assert.equal(appShell.classList.contains('is-artist-tree-folded'), true);
  assert.equal(drawerRail.classList.contains('is-folded'), true);
  // Owner 2026-11-16: while the edge moves, the expanded text stays and fades instead of vanishing.
  assert.equal(drawerRail.classList.contains('is-collapsing'), true);
  assert.equal(expandedTree.hidden, false);
  assert.equal(compactNavigation.hidden, false);
  assert.equal(artistList.hidden, false);
  assert.equal(foldButton.hidden, true);
  assert.equal(navigationButton.hidden, false);
  assert.equal(navigationButton.getAttribute('aria-expanded'), 'false');
  assert.equal(foldButton.getAttribute('aria-expanded'), 'false');
  assert.equal(context.document.activeElement, navigationButton);
  assert.equal(resizeEvents.length, 0);
  documentElement.dispatchEvent({
    type: 'transitionend',
    target: documentElement,
    propertyName: '--compact-player-width',
  });
  assert.equal(resizeEvents.length, 0);
  documentElement.dispatchEvent({
    type: 'transitionend',
    target: documentElement,
    propertyName: '--compact-rail-width',
  });
  assert.equal(resizeEvents.length, 0);
  assert.equal(settledEvents.length, 1);
  assert.equal(drawerRail.classList.contains('is-collapsing'), false);
  assert.equal(expandedTree.hidden, true);
  assert.equal(artistList.hidden, true);
  documentElement.dispatchEvent({
    type: 'transitionend',
    target: documentElement,
    propertyName: '--compact-rail-width',
  });
  assert.equal(resizeEvents.length, 0);
  assert.equal(settledEvents.length, 1);
}

{
  const { context, documentElement, pendingTimers, resizeEvents, settledEvents } = loadHelper({ isMobile: false });

  context.toggleArtistTreeFold();
  context.toggleArtistTreeFold();

  assert.equal([...pendingTimers.values()].filter(callback => callback.delay === 470).length, 1);
  documentElement.dispatchEvent({
    type: 'transitionend',
    target: documentElement,
    propertyName: '--compact-rail-width',
  });
  assert.equal(resizeEvents.length, 0);
  assert.equal(settledEvents.length, 1);
  assert.equal([...pendingTimers.values()].filter(callback => callback.delay === 470).length, 0);
}

{
  const { context, documentElement, pendingTimers, resizeEvents, settledEvents } = loadHelper({ isMobile: false });

  context.toggleArtistTreeFold();
  const [finishAfterMissingTransition] = pendingTimers.values();
  finishAfterMissingTransition();

  assert.equal(resizeEvents.length, 0);
  assert.equal(settledEvents.length, 1);
  assert.equal(pendingTimers.size, 0);
  documentElement.dispatchEvent({
    type: 'transitionend',
    target: documentElement,
    propertyName: '--compact-rail-width',
  });
  assert.equal(resizeEvents.length, 0);
  assert.equal(settledEvents.length, 1);
}

{
  const {
    context, drawerRail, foldButton, navigationButton, expandedTree, compactNavigation, artistList, appShell,
    documentElement,
  } = loadHelper({ isMobile: false });
  context.state.ui.artistTreeFolded = true;
  context.syncArtistTreeFoldVisibility();
  context.document.activeElement = navigationButton;
  context.document.getElementById('shell-navigation-rail').contains = target => target === navigationButton;
  foldButton.focus = () => { context.document.activeElement = foldButton; };

  const folded = context.toggleArtistTreeFold();

  assert.equal(folded, false);
  assert.equal(expandedTree.hidden, false);
  assert.equal(artistList.hidden, false);
  assert.equal(foldButton.hidden, false);
  assert.equal(compactNavigation.hidden, false);
  assert.equal(drawerRail.classList.contains('is-expanding'), true);
  assert.equal(drawerRail.classList.contains('is-transitioning'), true);
  assert.equal(context.document.activeElement, navigationButton);
  documentElement.dispatchEvent({
    type: 'transitionend',
    target: documentElement,
    propertyName: '--compact-rail-width',
  });
  assert.equal(expandedTree.hidden, false);
  assert.equal(compactNavigation.hidden, true);
  assert.equal(artistList.hidden, false);
  assert.equal(foldButton.hidden, false);
  assert.equal(navigationButton.hidden, true);
  assert.equal(foldButton.getAttribute('aria-expanded'), 'true');
  assert.equal(appShell.classList.contains('is-artist-tree-folded'), false);
  assert.equal(drawerRail.classList.contains('is-expanding'), false);
  assert.equal(drawerRail.classList.contains('is-transitioning'), false);
  assert.equal(context.document.activeElement, foldButton);
}

{
  const { context, foldButton, artistList, appShell } = loadHelper({ isMobile: true });
  context.state.ui.artistTreeFolded = true;

  context.syncArtistTreeFoldVisibility();

  assert.equal(context.state.ui.artistTreeFolded, true);
  assert.equal(foldButton.hidden, true);
  assert.equal(artistList.hidden, false);
  assert.equal(appShell.classList.contains('is-artist-tree-folded'), false);
}

{
  const { context, drawerRail, drawerBackdrop, body } = loadHelper({ isMobile: false });
  context.state.ui.artistsDrawerOpen = true;

  context.syncArtistsDrawerVisibility();

  assert.equal(context.state.ui.artistsDrawerOpen, false);
  assert.equal(drawerRail.classList.contains('is-mobile-drawer'), false);
  assert.equal(drawerBackdrop.hidden, true);
  assert.equal(body.classList.contains('artists-drawer-open'), false);
}

{
  const { context, drawerRail, drawerBackdrop, body } = loadHelper({ isMobile: true });
  context.state.ui.artistsDrawerOpen = true;
  context.state.view.shell_layout.slots.navigation_rail.content_kind = 'playlist_sidebar';

  context.syncArtistsDrawerVisibility();

  assert.equal(context.state.ui.artistsDrawerOpen, false);
  assert.equal(drawerRail.classList.contains('is-mobile-drawer'), false);
  assert.equal(drawerBackdrop.hidden, true);
  assert.equal(body.classList.contains('artists-drawer-open'), false);
}

{
  const { context } = loadHelper({ isMobile: true });
  context.state.view.shell_layout.slots.navigation_rail.content_kind = 'playlist_sidebar';

  const opened = context.openArtistsDrawer();

  assert.equal(opened, false);
  assert.equal(context.state.ui.artistsDrawerOpen, false);
}


{
  const { context } = loadHelper({ isMobile: true });
  context.state.ui.artistsDrawerOpen = true;
  let prevented = false;
  let propagationStopped = false;
  const target = {
    closest(selector) {
      return selector === '#artist-tree-context-menu' ? this : null;
    },
  };

  const handled = context.handleArtistsDrawerClick({
    target,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { propagationStopped = true; },
  });

  assert.equal(handled, false);
  assert.equal(prevented, false);
  assert.equal(propagationStopped, false);
  assert.equal(context.state.ui.artistsDrawerOpen, true);
}

// A pending hidden-tree reveal runs only after expansion settles. Ordinary
// expansion without a reveal must retain the user's existing scroll position.
for (const pendingArtist of ['', 'Latest Artist']) {
  const { context, documentElement } = loadHelper({ isMobile: false, artistTreeFolded: true });
  context.state.ui.pendingSidebarRevealArtist = pendingArtist;
  let renders = 0;
  context.renderSidebar = () => { renders += 1; };
  context.toggleArtistTreeFold();
  assert.equal(renders, 0);
  documentElement.dispatchEvent({ type: 'transitionend', target: documentElement,
    propertyName: '--compact-rail-width' });
  assert.equal(renders, pendingArtist ? 1 : 0);
}

{
  const { context } = loadHelper({ isMobile: true });
  const opener = createElement();
  opener.setAttribute('data-search-results', 'true');
  opener.setAttribute('aria-description', 'Search results available in Artists');
  const originalGetElementById = context.document.getElementById.bind(context.document);
  context.document.getElementById = id => id === 'mobile-library-button' ? opener : originalGetElementById(id);
  context.openArtistsDrawer();
  assert.equal(opener.getAttribute('aria-expanded'), 'true');
  assert.equal(opener.getAttribute('data-search-results'), null);
  assert.equal(opener.getAttribute('aria-description'), null);
}

{
  // Owner 2026-11-15: a search that opens the folded tree must not render results at the
  // folded width and then shift them while the rail animates open.
  const {
    context, drawerRail, expandedTree, compactNavigation, documentElement, pendingTimers, settledEvents,
  } = loadHelper({ isMobile: false });
  const frames = [];
  context.scheduleBrowserAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  context.state.ui.artistTreeFolded = true;
  context.syncArtistTreeFoldVisibility();

  const folded = context.toggleArtistTreeFold({ instant: true });

  assert.equal(folded, false);
  assert.equal(drawerRail.classList.contains('is-transitioning'), false);
  assert.equal(drawerRail.classList.contains('is-expanding'), false);
  assert.equal(expandedTree.hidden, false);
  assert.equal(compactNavigation.hidden, true);
  assert.equal(settledEvents.length, 1, 'The open width is final before the search renders');
  assert.equal([...pendingTimers.values()].filter(callback => callback.delay === 470).length, 0);
  assert.equal(documentElement.getAttribute('data-shell-motion'), 'instant');
  frames.forEach((callback) => callback());
  assert.equal(documentElement.getAttribute('data-shell-motion'), null);
}

test('desktop Collapse button shares the "Artists" heading centre line', () => {
  // Owner 2026-11-16: "the back fold button in navigation tree is not aligned with Artists".
  const css = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'app-chrome.css'), 'utf8');
  const desktop = css.match(/@media \(min-width: 901px\) \{([\s\S]*?)\n\}/)?.[1] || '';
  // Owner 2026-11-17: less dead space under the header; the 32px heading line is unchanged.
  assert.match(desktop, /\.shell-navigation-rail-header\s*\{[^}]*height:\s*44px;[^}]*padding-bottom:\s*12px/);
  assert.doesNotMatch(css, /\.shell-navigation-rail-header h2\s*\{[^}]*padding-bottom/);
});

test('the Artist tree runs down to the player with no bottom gap', () => {
  // Owner 2026-11-16: "at the bottom of artist tree there's a black padding above the player".
  const root = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css');
  const chrome = fs.readFileSync(path.join(root, 'app-chrome.css'), 'utf8');
  const player = fs.readFileSync(path.join(root, 'runtime', 'non-album-and-player.css'), 'utf8');
  assert.match(chrome, /\.shell-navigation-rail \{[^}]*padding: var\(--app-page-header-top\) 14px 0;/);
  assert.match(player, /has-docked-compact-player #shell-navigation-rail \{[^}]*padding-bottom: 0;/);
});

test('folding reassembles the panel: buttons travel, the edge moves, text fades', () => {
  // Owner 2026-11-16: "buttons go up, right edge goes left, and text items slowly disappearing. The reverse
  // happening on expansion".
  const css = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'app-chrome.css'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'shell-navigation-drawer.js'), 'utf8');
  assert.match(css, /\.is-collapsing #artist-tree-expanded \{[^}]*animation: artist-tree-content-fade-out/);
  assert.match(css, /\.is-expanding \.library-navigation-mode-rail,\s*\.shell-navigation-rail\.is-collapsing \.library-navigation-mode-rail \{ visibility: hidden; \}/);
  assert.doesNotMatch(css, /\.is-expanding \.shell-navigation-compact \{[^}]*animation:/);
  assert.match(source, /function setLibraryViewButtonTravel\(/);
  // Owner 2026-11-17: the buttons ride the edge's own animated width, not a separate animation.
  assert.match(css, /\.is-collapsing\) \.shell-navigation-compact > \[data-library-navigation-mode\] \{\s*translate: calc\(\(var\(--compact-rail-width\) - 64px\) \* var\(--fold-travel-x, 0\)\)/);
  assert.doesNotMatch(source, /\.animate\(/);
});

{
  // Owner 2026-11-16: unfolding is one movement. The compact view buttons also switch the tree, whose
  // re-render re-synced the panel and cancelled the expanding state, so the buttons vanished mid-motion.
  const { context, drawerRail, compactNavigation, documentElement } = loadHelper({ isMobile: false });
  context.state.ui.artistTreeFolded = true;
  context.syncArtistTreeFoldVisibility();
  context.toggleArtistTreeFold();
  assert.equal(drawerRail.classList.contains('is-expanding'), true);
  context.syncArtistTreeFoldVisibility();
  assert.equal(drawerRail.classList.contains('is-expanding'), true, 'a re-sync keeps the motion');
  assert.equal(compactNavigation.hidden, false);
  documentElement.dispatchEvent({ type: 'transitionend', target: documentElement, propertyName: '--compact-rail-width' });
  assert.equal(drawerRail.classList.contains('is-expanding'), false);
  assert.equal(compactNavigation.hidden, true);
}

test('the desktop side bar waits for an open modal to close before its idle collapse', () => {
  // Owner 2026-11-17: "when modal of any kind open that background overlays, in the background side bar should
  // not collapse on its own. the timer for that will wait until modal is closed. if it was not able to collapse
  // before next modal is open, timer resets".
  const { context, drawerRail, pendingTimers } = loadHelper({ isMobile: false });
  const trackModal = { hidden: true };
  const getElementById = context.document.getElementById;
  context.document.getElementById = id => (id === 'track-modal' ? trackModal : getElementById(id));
  let notifyOverlayChange = null;
  context.MutationObserver = class {
    constructor(callback) { notifyOverlayChange = callback; }
    observe() {}
  };
  const idleTimers = () => [...pendingTimers.values()].filter(callback => callback.delay === 30000);

  context.syncArtistsDrawerVisibility();
  assert.equal(idleTimers().length, 1);

  trackModal.hidden = false;
  notifyOverlayChange();
  assert.equal(idleTimers().length, 0, 'an open modal holds the collapse');

  trackModal.hidden = true;
  notifyOverlayChange();
  assert.equal(idleTimers().length, 1, 'closing the modal starts the full wait again');

  trackModal.hidden = false;
  notifyOverlayChange();
  assert.equal(idleTimers().length, 0, 'the next modal holds it again before it fires');
  assert.equal(drawerRail.classList.contains('is-library-mode-rail-hidden'), false);

  trackModal.hidden = true;
  notifyOverlayChange();
  idleTimers()[0]();
  assert.equal(drawerRail.classList.contains('is-library-mode-rail-hidden'), true, 'it collapses once nothing is open');
});

test('every search-results marker uses the selection accent, falling back to the player colour', () => {
  const cssRoot = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css');
  const chrome = fs.readFileSync(path.join(cssRoot, 'app-chrome.css'), 'utf8');
  const mobile = fs.readFileSync(path.join(cssRoot, 'mobile-layout.css'), 'utf8');
  assert.match(chrome, /--search-results-accent:\s*var\(--navigation-tree-selection-accent-color,\s*var\(--appearance-player-accent,\s*var\(--appearance-play,/);
  assert.match(chrome, /\[data-search-results='true'\]::after\s*\{[^}]*background:\s*var\(--search-results-accent\)/s);
  assert.match(mobile, /#mobile-search-button\[data-has-query="true"\]::before\s*\{[^}]*background:\s*var\(--search-results-accent\)/s);
  assert.match(mobile, /#mobile-library-button\[data-search-results='true'\]\s*\{[^}]*border-color:\s*var\(--search-results-accent\)/s);
  for (const css of [chrome, mobile]) {
    assert.doesNotMatch(css, /search-results='true'\][^{]*\{[^}]*(?:#72baff|#64a8ff|--appearance-info)/s);
  }
});

test('a search with no artist opens the collection holding the most matching tracks, once', async () => {
  // Owner 2026-11-18: the best match in Custom Collections opens the way the best-matching artist does.
  const { context } = loadHelper();
  stubCollectionTree(context);
  context.document.querySelectorAll = () => [];
  context.URL = URL;
  context.escapeHtml = value => String(value);
  let pageOpen = false;
  context.document.querySelector = selector => (selector === '#non-album-modal:not([hidden])' && pageOpen ? {} : null);
  context.isEffectivelyEmptyView = () => true;
  const opened = [];
  context.openLooseTracksPage = ({ collectionName }) => { opened.push(collectionName); pageOpen = true; };
  context.fetch = (path) => Promise.resolve({ ok: true, status: 200, json: async () => ({
    custom_collections: path.includes('q=ace') ? [{ name: 'Car', count: 1 }, { name: 'Disco', count: 4 }] : [],
    loose_tracks_count: path.includes('q=ace') || path.includes('q=solo') ? 5 : 0,
  }) });
  context.state.view.artists_sidebar = [];
  context.state.view.query = 'ace';

  await context.syncCustomCollectionSearchIndicator();
  assert.deepEqual(opened, ['Disco']);
  assert.equal(context.state.ui.libraryNavigationMode, 'custom-collections');
  pageOpen = false;
  await context.syncCustomCollectionSearchIndicator();
  assert.deepEqual(opened, ['Disco'], 'a redraw of the same search does not reopen it');

  // A matching loose track in no collection opens All Loose Tracks.
  context.state.view.query = 'solo';
  await context.syncCustomCollectionSearchIndicator();
  assert.deepEqual(opened, ['Disco', '']);

  // An artist match, or an open page, keeps the search where it is.
  pageOpen = false;
  context.state.view.query = 'ace again';
  context.state.view.artists_sidebar = [{ artist: 'Ace Of Base' }];
  await context.syncCustomCollectionSearchIndicator();
  assert.deepEqual(opened, ['Disco', '']);
});
