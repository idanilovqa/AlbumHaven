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
  documentElement.style = { setProperty() {} };
  const body = createElement();
  const document = {
    body,
    documentElement,
    activeElement: null,
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
    setTimeout(callback) {
      const id = ++nextTimerId;
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
    pendingTimers,
    resizeEvents,
    startingEvents,
    settledEvents,
  };
}

test('custom collections mode hydrates the library scope and reuses NavigationTree rows', async () => {
  const { context, artistList, navigationHeading } = loadHelper();
  artistList.dataset.sidebarStructureSignature = 'cached-artists';
  context.renderSidebar = () => { throw new Error('Artists must not render in collection mode'); };
  context.hydrateDeferredNonAlbumTracks = async ({ libraryWide }) => {
    assert.equal(libraryWide, true);
    context.state.view.library_non_album_tracks = [{ custom_collection_name: 'Night' }];
  };
  context.buildCustomCollectionIndex = () => [{ name: 'Night', count: 2 }];
  let renderedOptions = null;
  context.window.NavigationTree = {
    renderItem: (options) => {
      renderedOptions = options;
      const { label, count, attributes } = options;
      return (
      `<button data-open-custom-collection="${attributes['data-open-custom-collection']}">${label}:${count}</button>`
      );
    },
  };

  await context.setLibraryNavigationMode('custom-collections');

  assert.equal(context.state.ui.libraryNavigationMode, 'custom-collections');
  assert.equal(navigationHeading.textContent, 'Custom Collections');
  assert.equal(artistList.innerHTML, '<button data-open-custom-collection="Night">Night:2</button>');
  assert.equal(renderedOptions.variant, 'panel');
  assert.equal(renderedOptions.key, 'Night');
  assert.equal(renderedOptions.selected, false);
  assert.equal(artistList.dataset.sidebarStructureSignature, undefined);
});

test('custom collections mode marks the open collection selected', async () => {
  const { context } = loadHelper();
  context.state.ui.nonAlbumCollectionName = 'Night';
  context.hydrateDeferredNonAlbumTracks = async () => {};
  context.buildCustomCollectionIndex = () => [{ name: 'Night', count: 2 }];
  let renderedOptions = null;
  context.window.NavigationTree = {
    renderItem(options) { renderedOptions = options; return '<button>Night</button>'; },
  };

  await context.setLibraryNavigationMode('custom-collections');

  assert.equal(renderedOptions.selected, true);
});

test('library navigation delegates modes and exact collection detail without per-row listeners', () => {
  const { context } = loadHelper();
  const calls = [];
  context.setLibraryNavigationMode = mode => { calls.push(['mode', mode]); };
  context.openNonAlbumModal = options => { calls.push(['collection', options]); };
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
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['mode', 'custom-collections'],
    ['selection', null, 'Night'],
    ['collection', { libraryWide: true, collectionName: 'Night' }],
    ['close', { restoreFocus: false }],
  ]);
  assert.equal(prevented, 2);
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
});

test('library navigation uses the approved collection glyph and generic mobile close label', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'index.html'), 'utf8');
  const collectionActions = template.match(/action_button\('Custom Collections'[\s\S]*?<\/svg>\{% endcall %\}/g) || [];

  assert.equal(collectionActions.length, 2);
  for (const action of collectionActions) {
    assert.match(action, /M16 16l4 4M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z/);
    assert.match(action, /M9 13V7l5-1v5/);
    assert.doesNotMatch(action, /M4 5h6l2 2h8v12H4z/);
  }
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

test('mobile mode rail hides to a tappable anchor and reveals from an intentional edge swipe', () => {
  const { context, drawerRail, modeRailAnchor } = loadHelper({ isMobile: true });
  context.state.ui.artistsDrawerOpen = true;
  context.setMobileLibraryModeRailVisible(false);

  assert.equal(drawerRail.classList.contains('is-mobile-mode-rail-hidden'), true);
  assert.equal(modeRailAnchor.hidden, false);

  context.installMobileLibraryModeRailGestures();
  drawerRail.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', pointerId: 7, clientX: 4, clientY: 80 });
  drawerRail.dispatchEvent({ type: 'pointermove', pointerType: 'touch', pointerId: 7, clientX: 42, clientY: 84, preventDefault() {} });

  assert.equal(context.state.ui.mobileLibraryModeRailVisible, true);
  assert.equal(drawerRail.classList.contains('is-mobile-mode-rail-hidden'), false);
  assert.equal(modeRailAnchor.hidden, true);
});

test('pointer mode selection releases focus so the mobile rail can hide', () => {
  const { context, pendingTimers } = loadHelper({ isMobile: true });
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
  assert.equal(pendingTimers.size, 1);
});

test('navigation tree rows stay on one line and expose the edge anchor chevron', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'app-chrome.css'), 'utf8');
  const template = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'index.html'), 'utf8');

  assert.match(css, /\.shell-navigation-rail \.artist-link \.artist-name-label\s*\{[^}]*white-space:\s*nowrap;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s);
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
  assert.equal(expandedTree.hidden, true);
  assert.equal(compactNavigation.hidden, false);
  assert.equal(artistList.hidden, true);
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

  assert.equal(pendingTimers.size, 1);
  documentElement.dispatchEvent({
    type: 'transitionend',
    target: documentElement,
    propertyName: '--compact-rail-width',
  });
  assert.equal(resizeEvents.length, 0);
  assert.equal(settledEvents.length, 1);
  assert.equal(pendingTimers.size, 0);
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
