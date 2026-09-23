const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  const drawerBackdrop = createElement();
  const foldButton = createElement();
  const navigationButton = createElement();
  const expandedTree = createElement();
  const compactNavigation = createElement();
  const artistList = createElement();
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
        'shell-navigation-rail-backdrop': drawerBackdrop,
        'artist-tree-fold-button': foldButton,
        'artist-tree-navigation-button': navigationButton,
        'artist-tree-expanded': expandedTree,
        'shell-navigation-compact': compactNavigation,
        'sidebar-list': artistList,
      }[id] || null;
    },
  };
  const pendingTimers = new Map();
  let nextTimerId = 0;
  const resizeEvents = [];
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
    drawerBackdrop,
    foldButton,
    navigationButton,
    expandedTree,
    compactNavigation,
    artistList,
    appShell,
    body,
    documentElement,
    pendingTimers,
    resizeEvents,
    settledEvents,
  };
}

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

{
  const {
    context, drawerRail, foldButton, navigationButton, expandedTree, compactNavigation, artistList, appShell,
    documentElement, resizeEvents, settledEvents,
  } = loadHelper({ isMobile: false });
  drawerRail.contains = target => target === foldButton;
  context.document.activeElement = foldButton;
  navigationButton.focus = () => { context.document.activeElement = navigationButton; };

  const folded = context.toggleArtistTreeFold();

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
