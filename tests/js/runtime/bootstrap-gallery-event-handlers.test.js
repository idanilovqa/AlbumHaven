const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'bootstrap-gallery-event-handlers.js');
const helperSource = fs.readFileSync(helperPath, 'utf8');
const viewStateHelperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'view-state-helpers.js');
const viewStateHelperSource = fs.readFileSync(viewStateHelperPath, 'utf8');
const modalHelperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'modal-and-overlay-helpers.js');
const modalHelperSource = fs.readFileSync(modalHelperPath, 'utf8');

function createContext(options = {}) {
  const productionUrlContext = {
    URLSearchParams,
  };
  vm.createContext(productionUrlContext);
  vm.runInContext(viewStateHelperSource, productionUrlContext, { filename: viewStateHelperPath });
  let nextCoverLoadSuspensionToken = 8;
  const calls = {
    applyViewPayload: [],
    renderView: [],
    renderSidebar: 0,
    renderRelated: 0,
    renderLibraryLoader: [],
    renderArtistGroups: [],
    scheduleBrowserAnimationFrame: 0,
    pushBrowserViewState: [],
    fetchAndRender: [],
    buildApiUrl: [],
    buildApiUrlOptions: [],
    openAlbumInExplorer: [],
    resolveTrackModalDuplicateSourceAlbum: [],
    scheduledSearchCommits: [],
    closeArtistsDrawer: [],
    suspendSelectedArtistCoverLoadsForUserAction: 0,
    resumeSelectedArtistCoverLoadsAfterUserAction: [],
    deepCloneJson: 0,
    sequence: [],
    hideVersionContextMenu: 0,
    hideStatusContextMenu: 0,
    hideGalleryOptionsMenu: 0,
    renderGalleryOptionsMenu: 0,
    setCombineSimilarArtistsPreference: [],
    openNonAlbumTagEditor: 0,
    renderUtilityModalContent: 0,
    renderCoverLookupDrawer: 0,
    stopCoverLookupPollingIfIdle: 0,
    getSessionStorageItem: [],
    setSessionStorageItem: [],
    getReusableRootBrowseView: [],
    abandonScanPageForNavigation: [],
    committedSearchOperationOrder: [],
    triggerLibraryRefresh: [],
    cancelTrackModalAlbumDetailsPrewarms: 0,
    waveformPeakLoadSuspensions: [],
    waveformPeakLoadResumptions: [],
    albumDetailPrewarms: [],
    galleryFocusGlows: [],
  };
  const cachedRootView = options.cachedRootView || null;
  const cachedSelectedArtistView = options.cachedSelectedArtistView || null;
  const searchInput = {
    value: options.searchInputValue ?? '',
  };
  const trackModal = {
    hidden: options.trackModalHidden ?? true,
  };
  const context = {
    window: {
      location: new URL(options.currentUrl || 'http://localhost/?surface=albums&artist=A.C.T'),
    },
    document: {
      getElementById(id) {
        if (id === 'search-input') return searchInput;
        if (id === 'track-modal') return trackModal;
        return null;
      },
      querySelectorAll(selector) {
        return selector === '.utility-loop-speed-menu'
          ? (options.utilityLoopSpeedMenus || [])
          : [];
      },
    },
    state: {
      status: options.status || {},
      view: {
        query: '',
        selected_artist: 'A.C.T',
        all_artists_active: false,
        gallery_scope: 'all',
        visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
        related_filter_artists: ['A.C.T'],
        primary_filter_active: true,
      },
      ui: {
        pendingSidebarSelectedArtist: '',
        pendingSidebarAllArtistsActive: false,
        pendingSearchCommitTimer: 0,
        pendingSearchClearOnBlur: false,
        searchDraftQuery: options.searchInputValue ?? '',
      },
      gallery: {
        menuOpen: Boolean(options.galleryMenuOpen),
        sidebarArtistsOverride: [{ artist: 'A.C.T', count: 1 }],
        sidebarShowAllArtistsOverride: true,
      },
      utility: {
        problemDropdownOpen: Boolean(options.problemDropdownOpen),
      },
      coverLookup: {
        drawerOpen: Boolean(options.coverLookupDrawerOpen),
      },
    },
    hideVersionContextMenu() {
      calls.hideVersionContextMenu += 1;
    },
    hideStatusContextMenu() {
      calls.hideStatusContextMenu += 1;
    },
    triggerLibraryRefresh(fullRescan) {
      calls.triggerLibraryRefresh.push(Boolean(fullRescan));
    },
    cancelTrackModalAlbumDetailsPrewarms() {
      calls.cancelTrackModalAlbumDetailsPrewarms += 1;
    },
    queueTrackModalAlbumDetailsPrewarm(albumKey) {
      calls.albumDetailPrewarms.push(albumKey);
    },
    scheduleGalleryFocusGlow(albumCard) {
      calls.galleryFocusGlows.push(albumCard);
    },
    updateLightboxDrag() {},
    hideGalleryFocusGlow() {},
    suspendPlayerWaveformPeakLoadsForForegroundView() {
      const suspension = { id: calls.waveformPeakLoadSuspensions.length + 1 };
      calls.waveformPeakLoadSuspensions.push(suspension);
      return suspension;
    },
    resumePlayerWaveformPeakLoadsAfterForegroundView(suspension) {
      calls.waveformPeakLoadResumptions.push(suspension);
      return Promise.resolve(null);
    },
    hideGalleryOptionsMenu() {
      calls.hideGalleryOptionsMenu += 1;
      context.state.gallery.menuOpen = false;
    },
    getCurrentGalleryPreferenceArtist() {
      return context.state.view.selected_artist;
    },
    getCombineSimilarArtistsPreference() {
      return context.combineSimilarArtistsPreference;
    },
    setCombineSimilarArtistsPreference(artist, enabled) {
      calls.setCombineSimilarArtistsPreference.push({ artist, enabled });
      context.combineSimilarArtistsPreference = enabled;
    },
    openNonAlbumTagEditor() {
      calls.openNonAlbumTagEditor += 1;
    },
    renderGalleryOptionsMenu() {
      calls.renderGalleryOptionsMenu += 1;
    },
    renderUtilityModalContent() {
      calls.renderUtilityModalContent += 1;
    },
    renderCoverLookupDrawer() {
      calls.renderCoverLookupDrawer += 1;
    },
    stopCoverLookupPollingIfIdle() {
      calls.stopCoverLookupPollingIfIdle += 1;
    },
    getSessionStorageItem(key, fallback = '') {
      calls.getSessionStorageItem.push({ key, fallback });
      return context.sessionStorageItems.has(key)
        ? context.sessionStorageItems.get(key)
        : fallback;
    },
    setSessionStorageItem(key, value) {
      const result = options.sessionStorageWriteSucceeds !== false;
      calls.setSessionStorageItem.push({ key, value, result });
      if (result) context.sessionStorageItems.set(key, value);
      return result;
    },
    abandonScanPageForNavigation(runtimeOptions = {}) {
      const normalizedOptions = JSON.parse(JSON.stringify(runtimeOptions));
      calls.abandonScanPageForNavigation.push(normalizedOptions);
      calls.sequence.push('abandonScanPageForNavigation');
      const scanPageWasVisible = Boolean(
        context.state.ui.scanPageReturnContext
        || context.state.ui.forceScanPageVisible
      );
      context.state.ui.scanPageReturnContext = null;
      context.state.ui.forceScanPageVisible = false;
      if (runtimeOptions.clearSelection) {
        context.state.view = {
          ...context.state.view,
          selected_artist: '',
          all_artists_active: false,
          related_filter_artists: [],
          primary_filter_active: false,
          related_artists: [],
          primary_artist_groups: [],
          family_artist_groups: [],
        };
      }
      return scanPageWasVisible;
    },
    closeArtistsDrawer(options) {
      calls.closeArtistsDrawer.push(options || {});
    },
    overlayClickStartedOnOverlay() {
      return false;
    },
    renderSidebar() {
      calls.renderSidebar += 1;
      calls.sequence.push('renderSidebar');
    },
    renderRelated() {
      calls.renderRelated += 1;
    },
    renderLibraryLoader(status) {
      calls.renderLibraryLoader.push(status);
    },
    renderArtistGroups(runtimeOptions) {
      calls.renderArtistGroups.push(runtimeOptions);
    },
    scheduleBrowserAnimationFrame(callback) {
      calls.scheduleBrowserAnimationFrame += 1;
      if (typeof callback === 'function') callback();
      return 1;
    },
    applyViewPayload(payload, runtimeOptions) {
      calls.committedSearchOperationOrder.push('applyViewPayload');
      calls.applyViewPayload.push({ payload, runtimeOptions });
      context.state.view = {
        ...context.state.view,
        ...payload,
      };
    },
    renderView(runtimeOptions) {
      calls.renderView.push(runtimeOptions);
    },
    pushBrowserViewState(view) {
      calls.pushBrowserViewState.push(view);
    },
    getReusableRootBrowseView(view) {
      calls.getReusableRootBrowseView.push(JSON.parse(JSON.stringify(view)));
      return cachedRootView ? { ...cachedRootView } : null;
    },
    getReusableSelectedArtistBrowseView() {
      return cachedSelectedArtistView ? JSON.parse(JSON.stringify(cachedSelectedArtistView)) : null;
    },
    virtualGrid: {
      suspendSelectedArtistCoverLoadsForUserAction() {
        calls.committedSearchOperationOrder.push('suspendCoverLoads');
        calls.suspendSelectedArtistCoverLoadsForUserAction += 1;
        nextCoverLoadSuspensionToken += 1;
        return nextCoverLoadSuspensionToken;
      },
      resumeSelectedArtistCoverLoadsAfterUserAction(token) {
        calls.resumeSelectedArtistCoverLoadsAfterUserAction.push(token);
      },
    },
    buildApiUrl(view, runtimeOptions = {}) {
      calls.buildApiUrl.push(JSON.parse(JSON.stringify(view)));
      calls.buildApiUrlOptions.push(JSON.parse(JSON.stringify(runtimeOptions)));
      if (options.useProductionBuildApiUrl) {
        return productionUrlContext.buildApiUrl(view, runtimeOptions);
      }
      return '/view-data?artist=&gallery_scope=all&omit_sidebar=1';
    },
    buildSelectedArtistRuntimeArtistGroups(view, primaryGroups, familyGroups) {
      return [...(Array.isArray(primaryGroups) ? primaryGroups : []), ...(Array.isArray(familyGroups) ? familyGroups : [])];
    },
    resolveSidebarArtists(view, override) {
      if (Array.isArray(override) && override.length) return override;
      return Array.isArray(view?.artists_sidebar) ? view.artists_sidebar : [];
    },
    deepCloneJson(value) {
      calls.deepCloneJson += 1;
      return JSON.parse(JSON.stringify(value));
    },
    resolveTrackModalDuplicateSourceAlbum(button) {
      calls.resolveTrackModalDuplicateSourceAlbum.push(button);
      return { key: 'duplicate-source-album' };
    },
    openAlbumInExplorer(album) {
      calls.openAlbumInExplorer.push(album);
    },
    fetchAndRender(url, push, runtimeOptions) {
      calls.fetchAndRender.push({ url, push, runtimeOptions });
      calls.sequence.push('fetchAndRender');
      return typeof options.fetchAndRenderResult === 'function'
        ? options.fetchAndRenderResult(calls.fetchAndRender.length)
        : options.fetchAndRenderResult;
    },
    scheduleBrowserTimeout(callback, delay) {
      const timer = {
        id: calls.scheduledSearchCommits.length + 1,
        callback,
        delay,
        cleared: false,
      };
      calls.scheduledSearchCommits.push(timer);
      return timer.id;
    },
    clearBrowserTimeout(timeoutId) {
      const timer = calls.scheduledSearchCommits.find((entry) => entry.id === timeoutId);
      if (timer) timer.cleared = true;
    },
    sessionStorageItems: new Map(),
    combineSimilarArtistsPreference: options.combineSimilarArtistsPreference ?? true,
  };

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, calls };
}

test('album-card prewarm requires pointer movement instead of incidental layout hover', () => {
  const { context, calls } = createContext();
  const detailsButton = {
    getAttribute(name) {
      return name === 'data-album-key' ? 'hovered-album-key' : null;
    },
  };
  const albumCard = {
    querySelector(selector) {
      return selector === '.album-title-button[data-open-tracklist="1"][data-album-key]'
        ? detailsButton
        : null;
    },
  };

  const target = {
    closest(selector) {
      return selector === '.album-card' ? albumCard : null;
    },
  };

  context.handleGalleryBootstrapMouseOver({ target });

  assert.deepEqual(calls.albumDetailPrewarms, []);
  assert.deepEqual(calls.galleryFocusGlows, [albumCard]);

  context.handleGalleryBootstrapPointerMove({
    pointerType: 'mouse',
    target,
  });

  assert.deepEqual(calls.albumDetailPrewarms, ['hovered-album-key']);
});

test('touch movement never starts speculative album-detail hydration', () => {
  const { context, calls } = createContext();
  const detailsButton = {
    getAttribute(name) {
      return name === 'data-album-key' ? 'touch-album-key' : null;
    },
  };
  const albumCard = {
    querySelector() {
      return detailsButton;
    },
  };

  context.handleGalleryBootstrapPointerMove({
    pointerType: 'touch',
    target: {
      closest(selector) {
        return selector === '.album-card' ? albumCard : null;
      },
    },
  });

  assert.deepEqual(calls.albumDetailPrewarms, []);
});

test('handleGalleryBootstrapClick opens all loose tracks in the tag editor', () => {
  const { context, calls } = createContext();
  let prevented = false;

  context.handleGalleryBootstrapClick({
    target: {
      closest(selector) {
        return selector === '[data-open-non-album-tag-editor="1"]' ? {} : null;
      },
    },
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.equal(calls.openNonAlbumTagEditor, 1);
});

test('selecting a related artist clears an active primary-only family filter', () => {
  const { context, calls } = createContext();
  const localFilterCalls = [];
  context.state.view = {
    ...context.state.view,
    related_filter_artists: [],
    primary_filter_active: true,
  };
  context.applyLocalRelatedArtistFilter = (relatedArtists, options) => {
    localFilterCalls.push({
      relatedArtists: [...relatedArtists],
      options: { ...(options || {}) },
    });
    return false;
  };
  context.buildUrl = context.buildApiUrl;
  const chip = {
    getAttribute(name) {
      return name === 'data-related-artist' ? 'Vitaliy Dubinin' : '';
    },
  };

  context.handleGalleryBootstrapClick({
    target: {
      closest(selector) {
        return selector === '[data-related-artist]' ? chip : null;
      },
    },
    preventDefault() {},
  });

  assert.deepEqual(localFilterCalls, [{
    relatedArtists: ['Vitaliy Dubinin'],
    options: { primary_filter_active: false },
  }]);
  assert.equal(calls.buildApiUrl[0].primary_filter_active, false);
  assert.deepEqual(calls.buildApiUrl[0].related_filter_artists, ['Vitaliy Dubinin']);
});

test('unselecting the last related artist leaves primary-filter ownership to local view state', () => {
  const { context } = createContext();
  const localFilterCalls = [];
  context.state.view = {
    ...context.state.view,
    related_filter_artists: ['Vitaliy Dubinin'],
    primary_filter_active: false,
  };
  context.applyLocalRelatedArtistFilter = (relatedArtists, options) => {
    localFilterCalls.push({
      relatedArtists: [...relatedArtists],
      options: { ...(options || {}) },
    });
    return true;
  };
  const chip = {
    getAttribute(name) {
      return name === 'data-related-artist' ? 'Vitaliy Dubinin' : '';
    },
  };

  context.handleGalleryBootstrapClick({
    target: {
      closest(selector) {
        return selector === '[data-related-artist]' ? chip : null;
      },
    },
    preventDefault() {},
  });

  assert.deepEqual(localFilterCalls, [{
    relatedArtists: [],
    options: {},
  }]);
});

test('openNonAlbumTagEditor hands every displayed loose track to Edit Tags', () => {
  const { context } = createContext();
  const tracks = [
    { path: 'C:/Music/A/one.mp3', title: 'One', exception_type: 'Non-album rarity' },
    { path: 'C:/Music/A/two.mp3', title: 'Two', exception_type: 'Interview' },
  ];
  const calls = [];
  context.state.view.non_album_tracks = tracks;
  context.state.view.selected_artist = 'A';
  vm.runInContext(modalHelperSource, context, { filename: modalHelperPath });
  context.closeNonAlbumModal = () => calls.push({ name: 'close' });
  context.openTagEditor = (album, options) => calls.push({ name: 'open', album, options });

  context.openNonAlbumTagEditor();

  assert.equal(calls[0].name, 'close');
  assert.equal(calls[1].name, 'open');
  assert.deepEqual(Array.from(calls[1].album.tracks), tracks);
  assert.equal(calls[1].album.name, '');
  assert.equal(calls[1].album.album_artist, '');
  assert.equal(calls[1].album.tag_editor_title, 'Non-album tracks');
  assert.equal(calls[1].album.tag_editor_collection, true);
  assert.deepEqual({ ...calls[1].options }, { tracksMode: 'all' });
});

function createAllArtistsEvent() {
  const button = {};
  let prevented = false;
  const event = {
    target: {
      closest(selector) {
        return selector === '[data-sidebar-all-artists="1"]' ? button : null;
      },
    },
    preventDefault() {
      prevented = true;
    },
  };
  return {
    event,
    wasPrevented() {
      return prevented;
    },
  };
}

test('busy scan indicator click stays inert while status polling catches up', () => {
  const { context, calls } = createContext({ status: {} });
  const indicator = {
    classList: {
      contains(className) {
        return className === 'is-busy';
      },
    },
  };

  context.handleGalleryBootstrapClick({
    target: {
      closest(selector) {
        return selector === '#scan-indicator' ? indicator : null;
      },
    },
    preventDefault() {},
  });

  assert.equal(calls.hideStatusContextMenu, 1);
  assert.deepEqual(calls.triggerLibraryRefresh, []);
});

function createHomeEvent() {
  const button = {};
  let prevented = false;
  return {
    event: {
      target: {
        closest(selector) {
          return selector === '[data-sidebar-home="1"]' ? button : null;
        },
      },
      preventDefault() {
        prevented = true;
      },
    },
    wasPrevented() {
      return prevented;
    },
  };
}

test('rapid lightbox wheel input keeps one stable untransformed zoom origin', () => {
  const { context } = createContext();
  const zoomCalls = [];
  let rectReads = 0;
  const image = {
    style: {},
    dataset: {},
    classList: {
      toggle() {},
    },
    getBoundingClientRect() {
      rectReads += 1;
      return rectReads === 1
        ? { left: 100, top: 100, width: 200, height: 200 }
        : { left: 60, top: 70, width: 360, height: 340 };
    },
  };
  context.state.lightbox = {
    zoom: 1,
    panX: 0,
    panY: 0,
    dragging: false,
    zoomBasisRect: null,
    zoomOriginX: 50,
    zoomOriginY: 50,
  };
  context.document.getElementById = (id) => (
    id === 'image-lightbox' ? { hidden: false } : null
  );
  vm.runInContext(modalHelperSource, context, { filename: modalHelperPath });
  context.getLightboxElements = () => ({ image });
  const setProductionLightboxZoom = context.setLightboxZoom;
  context.setLightboxZoom = (zoom, options) => {
    setProductionLightboxZoom(zoom, options);
    zoomCalls.push({ zoom: context.state.lightbox.zoom, ...options });
  };
  const event = {
    target: {
      closest(selector) {
        return selector === '#image-lightbox-image' ? image : null;
      },
    },
    clientX: 200,
    clientY: 200,
    deltaY: -120,
    preventDefault() {},
  };

  for (let index = 0; index < 4; index += 1) {
    context.handleGalleryBootstrapWheel(event);
  }

  assert.equal(rectReads, 1, 'in-flight transformed rectangles must not alter later wheel anchors');
  assert.deepEqual(JSON.parse(JSON.stringify(zoomCalls)), [
    { zoom: 1.2, originX: 50, originY: 50 },
    { zoom: 1.4, originX: 50, originY: 50 },
    { zoom: 1.6, originX: 50, originY: 50 },
    { zoom: 1.8, originX: 50, originY: 50 },
  ]);
  assert.equal(image.dataset.lightboxZoom, '1.8');
  assert.equal(image.dataset.lightboxTargetTransform, 'translate(0px, 0px) scale(1.8)');
  assert.equal(image.dataset.lightboxTargetOrigin, '50% 50%');

  context.state.lightbox.panX = 20;
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.getStableLightboxZoomOrigin(image, 200, 200))),
    { originX: 44.444444, originY: 50 },
    'the deterministic target rectangle must retain cursor-relative zoom after panning',
  );
  assert.equal(rectReads, 1);
});

function createSidebarArtistEvent(artist = 'Broadcast') {
  const button = {
    getAttribute(name) {
      return name === 'data-sidebar-artist' ? artist : null;
    },
  };
  let prevented = false;
  return {
    event: {
      target: {
        closest(selector) {
          return selector === '[data-sidebar-artist]' ? button : null;
        },
      },
      preventDefault() {
        prevented = true;
      },
    },
    wasPrevented() {
      return prevented;
    },
  };
}

function createImmediateSidebarArtistEvent(sidebarArtists, artist = 'Broadcast', options = {}) {
  const mutations = [];
  const createLink = (name, active = false) => ({
    active,
    ariaCurrent: active ? 'true' : '',
    classList: {
      add(className) {
        mutations.push(`${name}:add:${className}`);
        if (className === 'active') this.owner.active = true;
      },
      remove(className) {
        mutations.push(`${name}:remove:${className}`);
        if (className === 'active') this.owner.active = false;
      },
      owner: null,
    },
    getAttribute(attributeName) {
      return attributeName === 'data-sidebar-artist' ? name : null;
    },
    setAttribute(attributeName, value) {
      if (attributeName === 'aria-current') this.ariaCurrent = value;
    },
    removeAttribute(attributeName) {
      if (attributeName === 'aria-current') this.ariaCurrent = '';
    },
  });
  const previousLink = createLink(options.previousArtist || 'A.C.T', true);
  const selectedLink = createLink(artist, false);
  previousLink.classList.owner = previousLink;
  selectedLink.classList.owner = selectedLink;
  const sidebarList = {
    albumHavenSidebarArtistsSource: options.renderedSource || sidebarArtists,
    albumHavenSidebarShowAllArtists: options.renderedShowAllArtists ?? true,
    albumHavenActiveSidebarLink: previousLink,
  };
  selectedLink.closest = (selector) => (selector === '#sidebar-list' ? sidebarList : null);
  let prevented = false;
  return {
    event: {
      target: {
        closest(selector) {
          return selector === '[data-sidebar-artist]' ? selectedLink : null;
        },
      },
      preventDefault() {
        prevented = true;
      },
    },
    mutations,
    previousLink,
    selectedLink,
    sidebarList,
    wasPrevented() {
      return prevented;
    },
  };
}

function createSubmitEvent() {
  let prevented = false;
  return {
    preventDefault() {
      prevented = true;
    },
    wasPrevented() {
      return prevented;
    },
  };
}

test('handleGalleryBootstrapClick restores the cached root browse view before refreshing all artists', () => {
  const cachedRootView = {
    query: '',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    artist_groups: [{ artist: 'Broadcast' }],
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
  };
  const { context, calls } = createContext({ cachedRootView });
  const { event, wasPrevented } = createAllArtistsEvent();

  context.handleGalleryBootstrapClick(event);

  assert.equal(wasPrevented(), true);
  assert.equal(calls.renderSidebar, 1);
  assert.equal(calls.renderRelated, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.applyViewPayload)), [{
    payload: cachedRootView,
    runtimeOptions: { trackSidebarReveal: false },
  }]);
  assert.deepEqual(calls.renderView, []);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.renderArtistGroups)), [{ preserveScroll: true }]);
  assert.equal(calls.scheduleBrowserAnimationFrame, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.pushBrowserViewState)), [{
    query: '',
    selected_artist: '',
    all_artists_active: true,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.fetchAndRender)), [{
    url: '/view-data?artist=&gallery_scope=all&omit_sidebar=1',
    push: false,
    runtimeOptions: { preserveScroll: true },
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.closeArtistsDrawer)), [{
    restoreFocus: false,
  }]);
  assert.equal(calls.suspendSelectedArtistCoverLoadsForUserAction, 1);
  assert.equal(context.state.gallery.sidebarArtistsOverride, null);
  assert.equal(context.state.ui.pendingSidebarAllArtistsActive, true);
});

test('handleGalleryBootstrapClick preserves the artist scroll anchor when toggling similar artists', () => {
  const { context, calls } = createContext({ combineSimilarArtistsPreference: true });
  const button = { disabled: false };
  let prevented = false;

  context.handleGalleryBootstrapClick({
    target: {
      closest(selector) {
        return selector === '[data-toggle-combine-similar-artists="1"]' ? button : null;
      },
    },
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.setCombineSimilarArtistsPreference)),
    [{ artist: 'A.C.T', enabled: false }],
  );
  assert.equal(context.getCombineSimilarArtistsPreference('A.C.T'), false);
  assert.equal(calls.renderGalleryOptionsMenu, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.renderArtistGroups)), [{ preserveScroll: true }]);
});

test('handleGalleryBootstrapClick falls back to the server round-trip when no cached root browse view is available', () => {
  const { context, calls } = createContext();
  const { event, wasPrevented } = createAllArtistsEvent();

  context.handleGalleryBootstrapClick(event);

  assert.equal(wasPrevented(), true);
  assert.equal(calls.renderSidebar, 1);
  assert.deepEqual(calls.applyViewPayload, []);
  assert.deepEqual(calls.pushBrowserViewState, []);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.fetchAndRender)), [{
    url: '/view-data?artist=&gallery_scope=all&omit_sidebar=1',
    push: true,
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.closeArtistsDrawer)), [{
    restoreFocus: false,
  }]);
  assert.equal(calls.suspendSelectedArtistCoverLoadsForUserAction, 1);
});

test('handleGalleryBootstrapClick ignores the retired Home sidebar target', () => {
  const { context, calls } = createContext();
  const { event, wasPrevented } = createHomeEvent();

  context.handleGalleryBootstrapClick(event);

  assert.equal(wasPrevented(), false);
  assert.deepEqual(calls.fetchAndRender, []);
  assert.deepEqual(calls.closeArtistsDrawer, []);
  assert.equal(calls.renderSidebar, 0);
});

test('handleSidebarArtistSelectionClick closes the mobile drawer before loading a selected artist', () => {
  const { context, calls } = createContext();
  const { event, wasPrevented } = createSidebarArtistEvent('Broadcast');

  context.handleSidebarArtistSelectionClick(event);

  assert.equal(wasPrevented(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.closeArtistsDrawer)), [{
    restoreFocus: false,
  }]);
  assert.equal(context.state.ui.pendingSidebarSelectedArtist, 'Broadcast');
  assert.equal(context.state.ui.pendingSidebarAllArtistsActive, false);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.fetchAndRender)), [{
    url: '/view-data?artist=&gallery_scope=all&omit_sidebar=1',
    push: true,
  }]);
});

test('all-artists cover suspension survives a queued production view request', async () => {
  const { context, calls } = createContext({ fetchAndRenderResult: false });
  const { event } = createAllArtistsEvent();
  context.state.ui.activeViewRequestController = {};
  context.state.ui.pendingViewRequest = { url: '/view-data?queued=1' };

  context.handleGalleryBootstrapClick(event);
  await Promise.resolve();

  assert.deepEqual(calls.resumeSelectedArtistCoverLoadsAfterUserAction, []);
  const resumeTimer = calls.scheduledSearchCommits.find((entry) => entry.delay === 16);
  assert.ok(resumeTimer, 'queued navigation should retain scheduler suspension until the request lifecycle settles');
  context.state.ui.activeViewRequestController = null;
  context.state.ui.pendingViewRequest = null;
  resumeTimer.callback();

  assert.deepEqual(calls.resumeSelectedArtistCoverLoadsAfterUserAction, [9]);
});

for (const completionOrder of [[2, 1], [1, 2]]) {
  test(`overlapping all-artists navigations release their own cover tokens in ${completionOrder.join('-')} completion order`, async () => {
    const pendingRequests = new Map();
    const { context, calls } = createContext({
      fetchAndRenderResult(callNumber) {
        return new Promise((resolve) => pendingRequests.set(callNumber, resolve));
      },
    });

    context.handleGalleryBootstrapClick(createAllArtistsEvent().event);
    context.handleGalleryBootstrapClick(createAllArtistsEvent().event);

    assert.equal(calls.suspendSelectedArtistCoverLoadsForUserAction, 2);
    assert.deepEqual(calls.resumeSelectedArtistCoverLoadsAfterUserAction, []);

    pendingRequests.get(completionOrder[0])(true);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      JSON.parse(JSON.stringify(calls.resumeSelectedArtistCoverLoadsAfterUserAction)),
      [completionOrder[0] === 1 ? 9 : 10],
    );

    pendingRequests.get(completionOrder[1])(true);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      JSON.parse(JSON.stringify(calls.resumeSelectedArtistCoverLoadsAfterUserAction)),
      completionOrder.map((requestNumber) => (requestNumber === 1 ? 9 : 10)),
    );
  });
}

test('sidebar artist selection reuses the rendered sidebar and updates only previous and clicked links before fetch', () => {
  const { context, calls } = createContext();
  const sidebarArtists = [
    { artist: 'A.C.T', count: 1 },
    { artist: 'Broadcast', count: 2 },
  ];
  context.state.view.artists_sidebar = sidebarArtists;
  context.state.view.show_all_artists_sidebar_link = true;
  context.state.gallery.sidebarArtistsOverride = null;
  const selection = createImmediateSidebarArtistEvent(sidebarArtists);

  const handled = context.handleSidebarArtistSelectionClick(selection.event);

  assert.equal(handled, true);
  assert.equal(selection.wasPrevented(), true);
  assert.equal(context.state.gallery.sidebarArtistsOverride, sidebarArtists);
  assert.equal(calls.deepCloneJson, 0);
  assert.equal(calls.renderSidebar, 0);
  assert.deepEqual(calls.sequence, ['fetchAndRender']);
  assert.equal(selection.previousLink.active, false);
  assert.equal(selection.previousLink.ariaCurrent, '');
  assert.equal(selection.selectedLink.active, true);
  assert.equal(selection.selectedLink.ariaCurrent, 'true');
  assert.equal(selection.sidebarList.albumHavenActiveSidebarLink, selection.selectedLink);
  assert.deepEqual(selection.mutations, [
    'A.C.T:remove:active',
    'Broadcast:add:active',
  ]);
});

test('sidebar artist selection dispatches before a full sidebar fallback when rendered structure changed', () => {
  const { context, calls } = createContext();
  const sidebarArtists = [
    { artist: 'A.C.T', count: 1 },
    { artist: 'Broadcast', count: 2 },
  ];
  context.state.view.artists_sidebar = sidebarArtists;
  context.state.view.show_all_artists_sidebar_link = true;
  context.state.gallery.sidebarArtistsOverride = null;
  const selection = createImmediateSidebarArtistEvent(sidebarArtists, 'Broadcast', {
    renderedSource: [{ artist: 'Stale artist', count: 1 }],
  });

  const handled = context.handleSidebarArtistSelectionClick(selection.event);

  assert.equal(handled, true);
  assert.equal(calls.deepCloneJson, 0);
  assert.deepEqual(calls.sequence, ['fetchAndRender', 'renderSidebar']);
  assert.equal(selection.previousLink.active, true);
  assert.equal(selection.selectedLink.active, false);
});

test('root sidebar selection keeps the current gallery mounted when no optimistic artist view is available', () => {
  const { context, calls } = createContext();
  const sidebarArtists = [
    { artist: 'A.C.T', count: 1 },
    { artist: 'Broadcast', count: 2 },
  ];
  context.state.view = {
    query: '',
    selected_artist: '',
    all_artists_active: true,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    related_artists: [],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'A.C.T',
      albums: [{ key: 'act-one' }],
    }, {
      artist: 'Broadcast',
      albums: [{ key: 'broadcast-one' }, { key: 'broadcast-two' }],
    }],
    artists_sidebar: sidebarArtists,
    show_all_artists_sidebar_link: true,
  };
  context.state.gallery.sidebarArtistsOverride = null;
  const selection = createImmediateSidebarArtistEvent(sidebarArtists, 'Broadcast');

  const handled = context.handleSidebarArtistSelectionClick(selection.event);

  assert.equal(handled, true);
  assert.deepEqual(calls.applyViewPayload, []);
  assert.deepEqual(calls.renderView, []);
  assert.equal(context.state.view.selected_artist, '');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.artist_groups)), [{
    artist: 'A.C.T',
    albums: [{ key: 'act-one' }],
  }, {
    artist: 'Broadcast',
    albums: [{ key: 'broadcast-one' }, { key: 'broadcast-two' }],
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.fetchAndRender)), [{
    url: '/view-data?artist=&gallery_scope=all&omit_sidebar=1',
    push: true,
  }]);
});

test('unrelated sidebar artist selection clears the stale family panel while its view request loads', () => {
  const { context, calls } = createContext();
  const sidebarArtists = [
    { artist: 'Neal Morse', count: 3 },
    { artist: 'Broadcast', count: 2 },
  ];
  context.state.view = {
    query: 'progressive',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library'],
    related_filter_artists: ['The Neal Morse Band'],
    primary_filter_active: false,
    related_artists: ['The Neal Morse Band'],
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-one' }],
    }],
    family_artist_groups: [{
      artist: 'The Neal Morse Band',
      albums: [{ key: 'nmb-one' }],
    }],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-one' }],
    }, {
      artist: 'The Neal Morse Band',
      albums: [{ key: 'nmb-one' }],
    }],
    artists_sidebar: sidebarArtists,
    show_all_artists_sidebar_link: true,
  };
  context.state.gallery.sidebarArtistsOverride = null;
  const selection = createImmediateSidebarArtistEvent(sidebarArtists, 'Broadcast');

  const handled = context.handleSidebarArtistSelectionClick(selection.event);

  assert.equal(handled, true);
  assert.equal(context.state.view.selected_artist, 'Broadcast');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.related_artists)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.primary_artist_groups)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.family_artist_groups)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.artist_groups)), []);
  assert.deepEqual(calls.sequence, ['fetchAndRender']);
});

test('handleSidebarArtistSelectionClick renders an optimistic selected-artist search view before the canonical fetch returns', () => {
  const { context, calls } = createContext();
  context.state.view = {
    query: 'bi2',
    selected_artist: '',
    all_artists_active: true,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    show_all_artists_sidebar_link: true,
    artists_sidebar: [
      { artist: 'БИ-2', count: 2 },
      { artist: 'Broadcast', count: 1 },
    ],
    primary_artist_groups: [{
      artist: 'БИ-2',
      albums: [{ key: 'bi2-1' }, { key: 'bi2-2' }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'БИ-2',
      albums: [{ key: 'bi2-1' }, { key: 'bi2-2' }],
    }],
  };
  context.state.gallery.sidebarArtistsOverride = null;
  const { event, wasPrevented } = createSidebarArtistEvent('БИ-2');

  context.handleSidebarArtistSelectionClick(event);

  assert.equal(wasPrevented(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.applyViewPayload)), [{
    payload: {
      query: 'bi2',
      selected_artist: 'БИ-2',
      all_artists_active: false,
      gallery_scope: 'all',
      visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
      related_filter_artists: [],
      primary_filter_active: false,
      search_context: {
        selected_artist: 'БИ-2',
        selected_artist_source: 'requested_artist',
      },
      show_all_artists_sidebar_link: true,
      artists_sidebar: [
        { artist: 'БИ-2', count: 2 },
        { artist: 'Broadcast', count: 1 },
      ],
      primary_artist_groups: [{
        artist: 'БИ-2',
        albums: [{ key: 'bi2-1' }, { key: 'bi2-2' }],
      }],
      family_artist_groups: [],
      artist_groups: [{
        artist: 'БИ-2',
        albums: [{ key: 'bi2-1' }, { key: 'bi2-2' }],
      }],
      related_artists: [],
      artist_count: 1,
      album_count: 2,
    },
    runtimeOptions: { trackSidebarReveal: false },
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.renderView)), [{
    preserveScroll: true,
    resetScrollForUserArtistSelection: true,
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.pushBrowserViewState)), [{
    query: 'bi2',
    selected_artist: 'БИ-2',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'БИ-2',
      selected_artist_source: 'requested_artist',
    },
    show_all_artists_sidebar_link: true,
    artists_sidebar: [
      { artist: 'БИ-2', count: 2 },
      { artist: 'Broadcast', count: 1 },
    ],
    primary_artist_groups: [{
      artist: 'БИ-2',
      albums: [{ key: 'bi2-1' }, { key: 'bi2-2' }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'БИ-2',
      albums: [{ key: 'bi2-1' }, { key: 'bi2-2' }],
    }],
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.fetchAndRender)), [{
    url: '/view-data?artist=&gallery_scope=all&omit_sidebar=1',
    push: false,
    runtimeOptions: {
      preserveScroll: true,
      skipPendingViewTransition: true,
    },
  }]);
});

test('handleSidebarArtistSelectionClick renders an optimistic selected artist view from current search results before reconciling', () => {
  const { context, calls } = createContext();
  context.state.view = {
    ...context.state.view,
    query: 'Ария',
    selected_artist: '',
    all_artists_active: true,
    artist_groups: [
      {
        artist: 'Broadcast',
        albums: [{ key: 'broadcast-tender-buttons' }, { key: 'broadcast-work-and-non-work' }],
      },
      {
        artist: 'БИ-2',
        albums: [{ key: 'bi-2-moloko' }],
      },
    ],
    artists_sidebar: [
      { artist: 'Broadcast', count: 2 },
      { artist: 'БИ-2', count: 1 },
    ],
  };
  const initialView = JSON.parse(JSON.stringify(context.state.view));
  const { event, wasPrevented } = createSidebarArtistEvent('БИ-2');

  context.handleSidebarArtistSelectionClick(event);

  assert.equal(wasPrevented(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.applyViewPayload)), [{
    payload: {
      ...initialView,
      selected_artist: 'БИ-2',
      all_artists_active: false,
      related_filter_artists: [],
      primary_filter_active: false,
      search_context: {
        selected_artist: 'БИ-2',
        selected_artist_source: 'requested_artist',
      },
      related_artists: [],
      primary_artist_groups: [{
        artist: 'БИ-2',
        albums: [{ key: 'bi-2-moloko' }],
      }],
      family_artist_groups: [],
      artist_groups: [{
        artist: 'БИ-2',
        albums: [{ key: 'bi-2-moloko' }],
      }],
      artist_count: 1,
      album_count: 1,
    },
    runtimeOptions: {
      trackSidebarReveal: false,
    },
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.renderView)), [{
    preserveScroll: true,
    resetScrollForUserArtistSelection: true,
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.pushBrowserViewState)), [{
    ...initialView,
    selected_artist: 'БИ-2',
    all_artists_active: false,
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'БИ-2',
      selected_artist_source: 'requested_artist',
    },
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.fetchAndRender)), [{
    url: '/view-data?artist=&gallery_scope=all&omit_sidebar=1',
    push: false,
    runtimeOptions: {
      preserveScroll: true,
      skipPendingViewTransition: true,
    },
  }]);
});

test('handleSidebarArtistSelectionClick restores a cached selected artist search view before reconciling when current groups no longer contain that artist', () => {
  const cachedSelectedArtistView = {
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    related_artists: ['Cosmic Cathedral', 'The Neal Morse Band'],
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-one', preview_only: true }],
    }],
    family_artist_groups: [{
      artist: 'Cosmic Cathedral',
      albums: [{ key: 'cosmic-cathedral-deep-water', preview_only: true }],
    }],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-one', preview_only: true }],
    }, {
      artist: 'Cosmic Cathedral',
      albums: [{ key: 'cosmic-cathedral-deep-water', preview_only: true }],
    }],
    artist_count: 2,
    album_count: 2,
  };
  const { context, calls } = createContext({
    cachedSelectedArtistView,
  });
  context.state.view = {
    ...context.state.view,
    query: 'Neal Morse',
    selected_artist: 'Cosmic Cathedral',
    all_artists_active: false,
    related_filter_artists: [],
    primary_filter_active: true,
    artist_groups: [{
      artist: 'Cosmic Cathedral',
      albums: [{ key: 'cosmic-cathedral-deep-water' }],
    }],
    primary_artist_groups: [{
      artist: 'Cosmic Cathedral',
      albums: [{ key: 'cosmic-cathedral-deep-water' }],
    }],
    family_artist_groups: [],
    artists_sidebar: [
      { artist: 'Neal Morse', count: 12 },
      { artist: 'Cosmic Cathedral', count: 1 },
    ],
  };
  const { event, wasPrevented } = createSidebarArtistEvent('Neal Morse');
  const expectedNextView = {
    ...context.state.view,
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'Neal Morse',
      selected_artist_source: 'requested_artist',
    },
  };
  const originalViewStateRevision = 11;
  context.state.ui.viewStateRevision = originalViewStateRevision;

  context.handleSidebarArtistSelectionClick(event);

  assert.equal(wasPrevented(), true);
  assert.equal(
    context.state.ui.viewStateRevision,
    originalViewStateRevision + 1,
    'the cached artist transition must invalidate older completion-refresh ownership',
  );
  assert.equal(calls.applyViewPayload.length, 1);
  assert.equal(calls.applyViewPayload[0].runtimeOptions.trackSidebarReveal, false);
  assert.equal(calls.applyViewPayload[0].payload.selected_artist, 'Neal Morse');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.applyViewPayload[0].payload.related_artists)), ['Cosmic Cathedral', 'The Neal Morse Band']);
  assert.equal(calls.applyViewPayload[0].payload.primary_artist_groups[0].artist, 'Neal Morse');
  assert.equal(calls.applyViewPayload[0].payload.family_artist_groups[0].artist, 'Cosmic Cathedral');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.renderView)), [{
    preserveScroll: true,
    resetScrollForUserArtistSelection: true,
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.pushBrowserViewState)), [{
    ...expectedNextView,
  }]);
  assert.equal(calls.fetchAndRender.length, 0);
  assert.equal(calls.scheduledSearchCommits.length, 1);
  assert.equal(calls.scheduledSearchCommits[0].delay, 1200);
  calls.scheduledSearchCommits[0].callback();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.fetchAndRender)), [{
    url: '/view-data?artist=&gallery_scope=all&omit_sidebar=1',
    push: false,
    runtimeOptions: {
      preserveScroll: true,
      skipPendingViewTransition: true,
    },
  }]);
});

test('handleSidebarArtistSelectionClick does not reconcile a complete cached selected artist gallery', () => {
  const completeAlbums = Array.from({ length: 10 }, (_, index) => ({
    key: `neal-morse-${index + 1}`,
  }));
  const cachedSelectedArtistView = {
    query: 'The Neal Morse Band',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [{ artist: 'Neal Morse', albums: completeAlbums }],
    family_artist_groups: [],
    artist_groups: [{ artist: 'Neal Morse', albums: completeAlbums }],
    artists_sidebar: [{ artist: 'Neal Morse', count: 10 }],
    artist_count: 1,
    album_count: 10,
  };
  const { context, calls } = createContext({ cachedSelectedArtistView });
  context.state.view = {
    ...context.state.view,
    query: 'The Neal Morse Band',
    selected_artist: 'The Neal Morse Band',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    artist_groups: [{ artist: 'The Neal Morse Band', albums: [{ key: 'nmb-one' }] }],
    primary_artist_groups: [{ artist: 'The Neal Morse Band', albums: [{ key: 'nmb-one' }] }],
    family_artist_groups: [],
    artists_sidebar: [
      { artist: 'Neal Morse', count: 10 },
      { artist: 'The Neal Morse Band', count: 10 },
    ],
  };
  const { event } = createSidebarArtistEvent('Neal Morse');

  context.handleSidebarArtistSelectionClick(event);

  assert.equal(context.state.view.selected_artist, 'Neal Morse');
  assert.equal(context.state.view.primary_artist_groups[0].albums.length, 10);
  assert.deepEqual(calls.fetchAndRender, []);
  assert.deepEqual(calls.scheduledSearchCommits, []);
});

test('handleSidebarArtistSelectionClick promotes an already visible family group into the primary selected-artist view before the fetch returns', () => {
  const speedMenu = { hidden: false };
  const { context, calls } = createContext({
    galleryMenuOpen: true,
    problemDropdownOpen: true,
    coverLookupDrawerOpen: true,
    utilityLoopSpeedMenus: [speedMenu],
  });
  context.state.view = {
    ...context.state.view,
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    related_filter_artists: ['Cosmic Cathedral', 'The Neal Morse Band'],
    primary_filter_active: false,
    related_artists: ['Cosmic Cathedral', 'The Neal Morse Band'],
    primary_artist_groups: [{
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      albums: [{ key: 'neal-morse-one', preview_only: true }],
    }],
    family_artist_groups: [{
      artist: 'Cosmic Cathedral',
      artist_display: 'Cosmic Cathedral',
      albums: [{ key: 'cosmic-cathedral-deep-water', preview_only: true }],
    }, {
      artist: 'The Neal Morse Band',
      artist_display: 'The Neal Morse Band',
      albums: [{ key: 'the-neal-morse-band-innocence', preview_only: true }],
    }],
    artist_groups: [{
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      albums: [{ key: 'neal-morse-one', preview_only: true }],
    }, {
      artist: 'Cosmic Cathedral',
      artist_display: 'Cosmic Cathedral',
      albums: [{ key: 'cosmic-cathedral-deep-water', preview_only: true }],
    }, {
      artist: 'The Neal Morse Band',
      artist_display: 'The Neal Morse Band',
      albums: [{ key: 'the-neal-morse-band-innocence', preview_only: true }],
    }],
    artists_sidebar: [
      { artist: 'Neal Morse', count: 12 },
      { artist: 'Cosmic Cathedral', count: 1 },
      { artist: 'The Neal Morse Band', count: 2 },
    ],
  };
  const initialView = JSON.parse(JSON.stringify(context.state.view));
  const { event, wasPrevented } = createSidebarArtistEvent('Cosmic Cathedral');

  context.handleSidebarArtistSelectionClick(event);

  assert.equal(wasPrevented(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.applyViewPayload)), [{
    payload: {
      ...initialView,
      selected_artist: 'Cosmic Cathedral',
      all_artists_active: false,
      related_filter_artists: [],
      primary_filter_active: false,
      search_context: {
        selected_artist: 'Cosmic Cathedral',
        selected_artist_source: 'requested_artist',
      },
      related_artists: ['Neal Morse', 'The Neal Morse Band'],
      primary_artist_groups: [{
        artist: 'Cosmic Cathedral',
        artist_display: 'Cosmic Cathedral',
        albums: [{ key: 'cosmic-cathedral-deep-water', preview_only: true }],
      }],
      related_filter_base_primary_groups: [{
        artist: 'Cosmic Cathedral',
        artist_display: 'Cosmic Cathedral',
        albums: [{ key: 'cosmic-cathedral-deep-water', preview_only: true }],
      }],
      family_artist_groups: [{
        artist: 'Neal Morse',
        artist_display: 'Neal Morse',
        albums: [{ key: 'neal-morse-one', preview_only: true }],
      }, {
        artist: 'The Neal Morse Band',
        artist_display: 'The Neal Morse Band',
        albums: [{ key: 'the-neal-morse-band-innocence', preview_only: true }],
      }],
      related_filter_base_family_groups: [{
        artist: 'Neal Morse',
        artist_display: 'Neal Morse',
        albums: [{ key: 'neal-morse-one', preview_only: true }],
      }, {
        artist: 'The Neal Morse Band',
        artist_display: 'The Neal Morse Band',
        albums: [{ key: 'the-neal-morse-band-innocence', preview_only: true }],
      }],
      artist_groups: [{
        artist: 'Cosmic Cathedral',
        artist_display: 'Cosmic Cathedral',
        albums: [{ key: 'cosmic-cathedral-deep-water', preview_only: true }],
      }, {
        artist: 'Neal Morse',
        artist_display: 'Neal Morse',
        albums: [{ key: 'neal-morse-one', preview_only: true }],
      }, {
        artist: 'The Neal Morse Band',
        artist_display: 'The Neal Morse Band',
        albums: [{ key: 'the-neal-morse-band-innocence', preview_only: true }],
      }],
      artist_count: 3,
      album_count: 3,
    },
    runtimeOptions: {
      trackSidebarReveal: false,
    },
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.renderView)), [{
    preserveScroll: true,
    resetScrollForUserArtistSelection: true,
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.pushBrowserViewState)), [{
    ...initialView,
    selected_artist: 'Cosmic Cathedral',
    all_artists_active: false,
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'Cosmic Cathedral',
      selected_artist_source: 'requested_artist',
    },
  }]);
  assert.equal(calls.fetchAndRender.length, 0);
  assert.equal(calls.scheduledSearchCommits.length, 0);
  assert.equal(calls.hideVersionContextMenu, 1);
  assert.equal(calls.hideGalleryOptionsMenu, 1);
  assert.equal(speedMenu.hidden, true);
  assert.equal(context.state.utility.problemDropdownOpen, false);
  assert.equal(calls.renderUtilityModalContent, 1);
  assert.equal(context.state.coverLookup.drawerOpen, false);
  assert.equal(calls.renderCoverLookupDrawer, 1);
  assert.equal(calls.stopCoverLookupPollingIfIdle, 1);
});

test('no-query sidebar family selection reuses the complete mounted family without fetch or reconcile', () => {
  const { context, calls } = createContext();
  const sidebarArtists = [
    { artist: 'Neal Morse', count: 12 },
    { artist: 'Cosmic Cathedral', count: 1 },
    { artist: 'The Neal Morse Band', count: 2 },
  ];
  context.state.view = {
    ...context.state.view,
    query: '',
    payload_tier: 'full',
    initial_view_partial: false,
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    related_filter_artists: [],
    primary_filter_active: false,
    related_artists: ['Cosmic Cathedral', 'The Neal Morse Band'],
    primary_artist_groups: [{
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      albums: [{ key: 'neal-morse-one' }],
    }],
    family_artist_groups: [{
      artist: 'Cosmic Cathedral',
      artist_display: 'Cosmic Cathedral',
      albums: [{ key: 'cosmic-cathedral-deep-water', preview_only: true }],
    }, {
      artist: 'The Neal Morse Band',
      artist_display: 'The Neal Morse Band',
      albums: [{ key: 'the-neal-morse-band-innocence', preview_only: true }],
    }],
    artist_groups: [{
      artist: 'Chronological',
      artist_display: 'Chronological',
      albums: [
        { key: 'neal-morse-one' },
        { key: 'cosmic-cathedral-deep-water' },
        { key: 'the-neal-morse-band-innocence' },
      ],
    }],
    artists_sidebar: sidebarArtists,
  };
  context.state.gallery.sidebarArtistsOverride = sidebarArtists;
  const selection = createImmediateSidebarArtistEvent(
    sidebarArtists,
    'Cosmic Cathedral',
    { previousArtist: 'Neal Morse' },
  );

  const handled = context.handleSidebarArtistSelectionClick(selection.event);

  assert.equal(handled, true);
  assert.equal(selection.wasPrevented(), true);
  assert.equal(context.state.view.selected_artist, 'Cosmic Cathedral');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.view.primary_artist_groups)),
    [{
      artist: 'Cosmic Cathedral',
      artist_display: 'Cosmic Cathedral',
      albums: [{ key: 'cosmic-cathedral-deep-water', preview_only: true }],
    }],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.view.family_artist_groups)),
    [{
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      albums: [{ key: 'neal-morse-one' }],
    }, {
      artist: 'The Neal Morse Band',
      artist_display: 'The Neal Morse Band',
      albums: [{ key: 'the-neal-morse-band-innocence', preview_only: true }],
    }],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.view.related_artists)),
    ['Neal Morse', 'The Neal Morse Band'],
  );
  assert.equal(calls.fetchAndRender.length, 0);
  assert.equal(calls.scheduledSearchCommits.length, 0);
  assert.deepEqual(calls.renderLibraryLoader, []);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.renderView)), [{
    preserveScroll: true,
    resetScrollForUserArtistSelection: true,
    preserveMountedGalleryChildren: true,
  }]);
  assert.equal(calls.pushBrowserViewState.length, 1);
  assert.equal(calls.pushBrowserViewState[0].selected_artist, 'Cosmic Cathedral');
  assert.equal(selection.previousLink.active, false);
  assert.equal(selection.selectedLink.active, true);
});

test('no-query sidebar family selection fetches when the mounted family payload is partial', () => {
  const { context, calls } = createContext();
  context.state.view = {
    ...context.state.view,
    query: '',
    payload_tier: 'sidebar',
    initial_view_partial: true,
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    related_filter_artists: [],
    primary_filter_active: false,
    related_artists: ['Cosmic Cathedral'],
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-preview', preview_only: true }],
    }],
    family_artist_groups: [{
      artist: 'Cosmic Cathedral',
      albums: [{ key: 'cosmic-cathedral-preview', preview_only: true }],
    }],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-preview', preview_only: true }],
    }, {
      artist: 'Cosmic Cathedral',
      albums: [{ key: 'cosmic-cathedral-preview', preview_only: true }],
    }],
  };

  context.handleSidebarArtistSelectionClick(
    createSidebarArtistEvent('Cosmic Cathedral').event,
  );

  assert.equal(calls.applyViewPayload.length, 0);
  assert.equal(calls.fetchAndRender.length, 1);
  assert.equal(calls.scheduledSearchCommits.length, 0);
});

test('no-query sidebar selection fetches for an artist outside the complete mounted family', () => {
  const { context, calls } = createContext();
  context.state.view = {
    ...context.state.view,
    query: '',
    payload_tier: 'full',
    initial_view_partial: false,
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    related_filter_artists: [],
    primary_filter_active: false,
    related_artists: ['Cosmic Cathedral'],
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-one' }],
    }],
    family_artist_groups: [{
      artist: 'Cosmic Cathedral',
      albums: [{ key: 'cosmic-cathedral-one' }],
    }],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-one' }],
    }, {
      artist: 'Cosmic Cathedral',
      albums: [{ key: 'cosmic-cathedral-one' }],
    }],
  };

  context.handleSidebarArtistSelectionClick(
    createSidebarArtistEvent('Broadcast').event,
  );

  assert.equal(context.state.view.selected_artist, 'Broadcast');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.artist_groups)), []);
  assert.equal(calls.fetchAndRender.length, 1);
  assert.equal(calls.scheduledSearchCommits.length, 0);
});

test('handleGalleryBootstrapClick resolves duplicate-folder actions from the current modal album state', () => {
  const { context, calls } = createContext();
  const duplicateFolderButton = {};
  let prevented = false;

  context.handleGalleryBootstrapClick({
    target: {
      closest(selector) {
        return selector === '[data-open-track-modal-duplicate-folder="1"]' ? duplicateFolderButton : null;
      },
    },
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls.resolveTrackModalDuplicateSourceAlbum, [duplicateFolderButton]);
  assert.deepEqual(calls.openAlbumInExplorer, [{ key: 'duplicate-source-album' }]);
});

test('search submit abandons Scan Page before dispatching an unfiltered query request', () => {
  const unresolvedRequest = new Promise(() => {});
  const { context, calls } = createContext({
    searchInputValue: 'Broadcast',
    fetchAndRenderResult: unresolvedRequest,
  });
  context.state.view = {
    ...context.state.view,
    query: '',
    selected_artist: 'Neal Morse',
    all_artists_active: true,
    related_filter_artists: ['The Neal Morse Band'],
    primary_filter_active: true,
    related_artists: ['The Neal Morse Band'],
    primary_artist_groups: [{ artist: 'Neal Morse' }],
    family_artist_groups: [{ artist: 'The Neal Morse Band' }],
  };
  context.state.ui.scanPageReturnContext = {
    view: JSON.parse(JSON.stringify(context.state.view)),
    searchDraftQuery: '',
    url: 'http://localhost/?surface=albums&artist=Neal+Morse',
  };
  context.state.ui.forceScanPageVisible = true;

  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.equal(context.state.view.selected_artist, '');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.related_artists)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.primary_artist_groups)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.family_artist_groups)), []);

  assert.deepEqual(JSON.parse(JSON.stringify(calls.abandonScanPageForNavigation)), [{
    clearSelection: true,
  }]);
  assert.deepEqual(calls.sequence, [
    'abandonScanPageForNavigation',
    'fetchAndRender',
  ]);
  assert.equal(calls.buildApiUrl.length, 1);
  assert.equal(calls.buildApiUrl[0].query, 'Broadcast');
  assert.equal(calls.buildApiUrl[0].selected_artist, '');
  assert.equal(calls.buildApiUrl[0].all_artists_active, false);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.buildApiUrl[0].related_filter_artists)), []);
  assert.equal(calls.buildApiUrl[0].primary_filter_active, false);
  assert.equal(calls.fetchAndRender.length, 1);
});

test('committed search suspends gallery cover downloads until its view request settles', async () => {
  let resolveRequest;
  const request = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const { context, calls } = createContext({
    searchInputValue: 'Joseph',
    fetchAndRenderResult: request,
  });

  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.equal(calls.suspendSelectedArtistCoverLoadsForUserAction, 1);
  assert.deepEqual(
    calls.committedSearchOperationOrder.slice(-2),
    ['suspendCoverLoads', 'applyViewPayload'],
    'cover requests must be suspended before the optimistic search render can enqueue new images',
  );
  assert.deepEqual(calls.resumeSelectedArtistCoverLoadsAfterUserAction, []);

  resolveRequest(true);
  await request;
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.resumeSelectedArtistCoverLoadsAfterUserAction, [9]);
});

test('different committed search hides the mounted artist family before its view request settles', () => {
  const unresolvedRequest = new Promise(() => {});
  const { context, calls } = createContext({
    searchInputValue: 'The Flower Kings',
    fetchAndRenderResult: unresolvedRequest,
  });
  context.state.view = {
    ...context.state.view,
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    related_filter_artists: ['The Neal Morse Band'],
    primary_filter_active: true,
    related_artists: ['The Neal Morse Band'],
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-one' }],
    }],
    family_artist_groups: [{
      artist: 'The Neal Morse Band',
      albums: [{ key: 'nmb-one' }],
    }],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-one', name: 'Sola Scriptura' }],
    }, {
      artist: 'The Neal Morse Band',
      albums: [{ key: 'nmb-one', name: 'Innocence & Danger' }],
    }],
  };
  const mountedGalleryBeforeSearch = JSON.parse(JSON.stringify(context.state.view.artist_groups));

  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.equal(calls.fetchAndRender.length, 1);
  assert.equal(calls.buildApiUrl.at(-1).query, 'The Flower Kings');
  assert.equal(context.state.view.selected_artist, '');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.related_filter_artists)), []);
  assert.equal(context.state.view.primary_filter_active, false);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.related_artists)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.primary_artist_groups)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.family_artist_groups)), []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.view.artist_groups)),
    mountedGalleryBeforeSearch,
    'The complete mounted gallery must remain usable until the committed-search response replaces it.',
  );
  assert.deepEqual(calls.renderView, []);
  assert.deepEqual(calls.renderLibraryLoader, []);
});

test('same-query commit cancels cached selected-artist reconcile before its stale callback can issue a duplicate q-plus-artist fetch', () => {
  const unresolvedRequest = new Promise(() => {});
  const { context, calls } = createContext({
    searchInputValue: 'Neal Morse',
    fetchAndRenderResult: unresolvedRequest,
  });
  const selectedArtist = 'The Neal Morse Band';
  context.state.view = {
    ...context.state.view,
    query: 'Neal Morse',
    selected_artist: selectedArtist,
    all_artists_active: false,
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      committed_query: 'Neal Morse',
      selected_artist: selectedArtist,
      selected_artist_source: 'requested_artist',
    },
    primary_artist_groups: [{
      artist: selectedArtist,
      albums: [{ key: 'innocence-and-danger' }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: selectedArtist,
      albums: [{ key: 'innocence-and-danger' }],
    }],
  };
  const reconcileView = {
    ...context.state.view,
    selected_artist: selectedArtist,
  };
  context.scheduleCachedSelectedArtistReconcile(reconcileView);
  const staleReconcile = calls.scheduledSearchCommits.at(-1);
  assert.equal(staleReconcile.delay, 1200);
  assert.equal(context.state.ui.pendingSelectedArtistReconcileTimer, staleReconcile.id);

  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.equal(calls.fetchAndRender.length, 1);
  assert.equal(calls.buildApiUrl[0].query, 'Neal Morse');
  assert.equal(calls.buildApiUrl[0].selected_artist, '');
  assert.equal(staleReconcile.cleared, true);
  assert.equal(context.state.ui.pendingSelectedArtistReconcileTimer, 0);

  context.state.view = {
    ...context.state.view,
    query: 'Neal Morse',
    selected_artist: selectedArtist,
  };
  if (!staleReconcile.cleared) staleReconcile.callback();
  assert.equal(
    calls.fetchAndRender.length,
    1,
    'The canceled reconcile must not add a serial q-plus-artist request after q-only selection settles.',
  );
});

test('edited search draft invalidates cached selected-artist reconcile before debounce commits', () => {
  const { context, calls } = createContext();
  const selectedArtist = 'Neal Morse';
  context.state.view = {
    ...context.state.view,
    query: 'The Neal Morse Band',
    selected_artist: selectedArtist,
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.searchDraftQuery = 'The Neal Morse Band';
  context.scheduleCachedSelectedArtistReconcile({
    ...context.state.view,
  });
  const staleReconcile = calls.scheduledSearchCommits.at(-1);
  assert.equal(staleReconcile.delay, 1200);

  context.handleGalleryBootstrapSearchInput('');
  if (!staleReconcile.cleared) staleReconcile.callback();

  assert.equal(staleReconcile.cleared, true);
  assert.equal(context.state.ui.pendingSelectedArtistReconcileTimer, 0);
  assert.equal(calls.fetchAndRender.length, 0);
});

test('search focus cancels cached selected-artist reconcile before browser input dispatch can race it', () => {
  const { context, calls } = createContext();
  context.state.view = {
    ...context.state.view,
    query: 'The Neal Morse Band',
    selected_artist: 'Neal Morse',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.searchDraftQuery = 'The Neal Morse Band';
  context.scheduleCachedSelectedArtistReconcile({
    ...context.state.view,
  });
  const staleReconcile = calls.scheduledSearchCommits.at(-1);
  assert.equal(staleReconcile.delay, 1200);

  context.handleGalleryBootstrapSearchFocus();
  if (!staleReconcile.cleared) staleReconcile.callback();

  assert.equal(staleReconcile.cleared, true);
  assert.equal(context.state.ui.pendingSelectedArtistReconcileTimer, 0);
  assert.equal(calls.fetchAndRender.length, 0);
});

test('new committed search that abandons Scan Page invalidates cached selected-artist reconcile', () => {
  const unresolvedRequest = new Promise(() => {});
  const { context, calls } = createContext({
    searchInputValue: 'Broadcast',
    fetchAndRenderResult: unresolvedRequest,
  });
  context.state.view = {
    ...context.state.view,
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'sola-scriptura' }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'sola-scriptura' }],
    }],
  };
  context.scheduleCachedSelectedArtistReconcile({
    ...context.state.view,
    selected_artist: 'Neal Morse',
  });
  const staleReconcile = calls.scheduledSearchCommits.at(-1);
  assert.equal(staleReconcile.delay, 1200);
  context.state.ui.scanPageReturnContext = {
    view: JSON.parse(JSON.stringify(context.state.view)),
    searchDraftQuery: '',
    url: 'http://localhost/?surface=albums&q=Neal+Morse&artist=Neal+Morse',
  };
  context.state.ui.forceScanPageVisible = true;

  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.deepEqual(JSON.parse(JSON.stringify(calls.abandonScanPageForNavigation)), [{
    clearSelection: true,
  }]);
  assert.equal(staleReconcile.cleared, true);
  assert.equal(context.state.ui.pendingSelectedArtistReconcileTimer, 0);
  assert.equal(calls.fetchAndRender.length, 1);
  assert.equal(calls.buildApiUrl.at(-1).query, 'Broadcast');
  assert.equal(calls.buildApiUrl.at(-1).selected_artist, '');
});

test('same committed query abandons Scan Page and renders the current gallery once without fetching', () => {
  const { context, calls } = createContext({ searchInputValue: 'Broadcast' });
  context.state.view = {
    ...context.state.view,
    query: 'Broadcast',
    selected_artist: 'Broadcast',
    all_artists_active: true,
    related_filter_artists: ['The Neal Morse Band'],
    primary_filter_active: true,
  };
  context.state.ui.scanPageReturnContext = {
    view: JSON.parse(JSON.stringify(context.state.view)),
    searchDraftQuery: 'Broadcast',
    url: 'http://localhost/?surface=albums&q=Broadcast&artist=Neal+Morse',
  };
  context.state.ui.forceScanPageVisible = true;

  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.deepEqual(JSON.parse(JSON.stringify(calls.abandonScanPageForNavigation)), [{}]);
  assert.equal(context.state.view.selected_artist, 'Broadcast');
  assert.deepEqual(calls.renderView, [undefined]);
  assert.deepEqual(calls.buildApiUrl, []);
  assert.deepEqual(calls.fetchAndRender, []);
});

test('same committed query after manual tree selection requests a query-only best match again', () => {
  const unresolvedRequest = new Promise(() => {});
  const { context, calls } = createContext({
    searchInputValue: 'Neal Morse',
    fetchAndRenderResult: unresolvedRequest,
  });
  context.state.view = {
    ...context.state.view,
    query: 'Neal Morse',
    selected_artist: 'The Neal Morse Band',
    all_artists_active: false,
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      committed_query: 'Neal Morse',
      selected_artist: 'The Neal Morse Band',
      selected_artist_source: 'requested_artist',
    },
    primary_artist_groups: [{
      artist: 'The Neal Morse Band',
      albums: [{ key: 'innocence-and-danger' }],
    }],
    family_artist_groups: [],
  };

  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.equal(calls.fetchAndRender.length, 1);
  assert.equal(calls.buildApiUrl.at(-1).query, 'Neal Morse');
  assert.equal(calls.buildApiUrl.at(-1).selected_artist, '');
  assert.equal(calls.buildApiUrl.at(-1).all_artists_active, false);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.buildApiUrl.at(-1).related_filter_artists)), []);
  assert.equal(calls.buildApiUrl.at(-1).primary_filter_active, false);
});

test('filtered artist-tree selection abandons Scan Page before optimistic selection and fetch', () => {
  const { context, calls } = createContext();
  context.state.view = {
    ...context.state.view,
    query: 'progressive',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    related_filter_artists: ['The Neal Morse Band'],
    primary_filter_active: true,
    related_artists: ['The Neal Morse Band'],
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-one' }],
    }],
    family_artist_groups: [{
      artist: 'The Neal Morse Band',
      albums: [{ key: 'nmb-one' }],
    }],
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast-one' }],
    }],
  };
  context.state.ui.scanPageReturnContext = {
    view: JSON.parse(JSON.stringify(context.state.view)),
    searchDraftQuery: 'progressive',
    url: 'http://localhost/?surface=albums&q=progressive&artist=Neal+Morse',
  };
  context.state.ui.forceScanPageVisible = true;
  const applyViewPayload = context.applyViewPayload;
  context.applyViewPayload = (...args) => {
    calls.sequence.push('applyViewPayload');
    return applyViewPayload(...args);
  };
  const renderView = context.renderView;
  context.renderView = (...args) => {
    calls.sequence.push('renderView');
    return renderView(...args);
  };

  context.handleSidebarArtistSelectionClick(createSidebarArtistEvent('Broadcast').event);

  assert.deepEqual(JSON.parse(JSON.stringify(calls.abandonScanPageForNavigation)), [{}]);
  assert.deepEqual(calls.sequence, [
    'abandonScanPageForNavigation',
    'applyViewPayload',
    'renderView',
    'fetchAndRender',
    'renderSidebar',
  ]);
  assert.equal(context.state.view.selected_artist, 'Broadcast');
  assert.equal(calls.buildApiUrl.at(-1).selected_artist, 'Broadcast');
});

test('handleGalleryBootstrapSearchSubmit does not infer a selection from a sole primary group when clearing a search', () => {
  const { context, calls } = createContext({ searchInputValue: '' });
  context.state.view = {
    surface: { active: 'albums' },
    query: 'Neal Morse',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [{ artist: 'Neal Morse', artist_display: 'Neal Morse' }],
  };
  context.state.ui.pendingSidebarSelectedArtist = '';
  context.state.ui.pendingSidebarAllArtistsActive = false;
  const event = createSubmitEvent();

  context.handleGalleryBootstrapSearchSubmit(event);

  assert.equal(event.wasPrevented(), true);
  assert.equal(calls.buildApiUrl.length, 1);
  assert.equal(calls.buildApiUrl[0].surface.active, 'albums');
  assert.equal(calls.buildApiUrl[0].surface_request, 'albums');
  assert.equal(calls.buildApiUrl[0].query, '');
  assert.equal(calls.buildApiUrl[0].selected_artist, '');
  assert.equal(calls.buildApiUrl[0].gallery_scope, '');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.buildApiUrl[0].visible_library_categories)), []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.fetchAndRender[0].runtimeOptions)),
    { completePageEntryBrowseContext: true },
  );
  assert.equal(context.state.ui.searchDraftQuery, '');
});

test('clearing an interactive canonical-root search reloads the full auto-selected artist gallery', () => {
  const queryFilteredPrimaryGroup = {
    artist: 'The Neal Morse Band',
    artist_display: 'The Neal Morse Band',
    albums: [{ key: 'the-neal-morse-band-joseph' }],
  };
  const { context, calls } = createContext({
    cachedRootView: {
      query: '',
      selected_artist: '',
      all_artists_active: true,
      gallery_scope: 'all',
      visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
      artists_sidebar: [
        { artist: 'Earlier Artist', count: 2 },
        { artist: 'The Neal Morse Band', count: 10 },
      ],
      artist_count: 2,
      show_all_artists_sidebar_link: true,
    },
    searchInputValue: '',
    useProductionBuildApiUrl: true,
  });
  context.state.view = {
    surface: { active: 'albums' },
    query: 'The Neal Morse Band',
    selected_artist: 'The Neal Morse Band',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'The Neal Morse Band',
      selected_artist_source: 'auto_top_match',
    },
    primary_artist_groups: [queryFilteredPrimaryGroup],
    family_artist_groups: [],
    artist_groups: [queryFilteredPrimaryGroup],
    artists_sidebar: [{ artist: 'The Neal Morse Band', count: 1 }],
    album_count: 1,
  };
  context.state.ui.preSearchView = {
    selected_artist: 'Previously Selected Artist',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'canonical_root';
  const event = createSubmitEvent();

  context.handleGalleryBootstrapSearchSubmit(event);

  assert.equal(event.wasPrevented(), true);
  assert.equal(calls.buildApiUrl.length, 1);
  assert.equal(calls.buildApiUrl[0].surface.active, 'albums');
  assert.equal(calls.buildApiUrl[0].query, '');
  assert.equal(calls.buildApiUrl[0].selected_artist, 'The Neal Morse Band');
  assert.deepEqual(calls.buildApiUrlOptions[0], {});
  assert.equal(calls.fetchAndRender.length, 1);
  const requestUrl = new URL(calls.fetchAndRender[0].url, 'http://localhost');
  assert.equal(requestUrl.searchParams.get('artist'), 'The Neal Morse Band');
  assert.equal(requestUrl.searchParams.has('payload_tier'), false);
  assert.equal(calls.fetchAndRender[0].runtimeOptions, undefined);
});

test('interactive-origin no-match clear restores Home with a full albums request without restoring a pre-search artist', () => {
  const { context, calls } = createContext({
    searchInputValue: '',
    useProductionBuildApiUrl: true,
  });
  context.state.view = {
    surface: { active: 'albums' },
    surface_request: 'albums',
    query: 'Album Haven deterministic no-match 7f4c29',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
    artists_sidebar: [],
  };
  context.state.ui.preSearchView = {
    selected_artist: 'Previously Selected Artist',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'interactive';

  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.equal(calls.buildApiUrl.length, 1);
  assert.equal(calls.buildApiUrl[0].surface.active, 'albums');
  assert.equal(calls.buildApiUrl[0].surface_request, 'albums');
  assert.equal(calls.buildApiUrl[0].query, '');
  assert.equal(calls.buildApiUrl[0].selected_artist, '');
  assert.equal(calls.buildApiUrl[0].gallery_scope, '');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.buildApiUrl[0].visible_library_categories)), []);
  assert.equal(calls.fetchAndRender[0].url, '/view-data?surface=albums');
  assert.equal(context.state.view.surface.active, 'home');
  assert.equal(context.state.view.surface_request, 'home');
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.fetchAndRender[0].runtimeOptions)),
    { completePageEntryBrowseContext: true },
  );
});

test('canonical no-match clear requests a full albums projection for the Home completion', () => {
  const { context, calls } = createContext({ searchInputValue: '' });
  context.state.view = {
    surface: { active: 'albums' },
    query: 'Album Haven deterministic no-match 7f4c29',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
    artists_sidebar: [],
  };
  context.state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'canonical_root';

  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.equal(calls.buildApiUrl.length, 1);
  assert.equal(calls.buildApiUrl[0].surface.active, 'albums');
  assert.equal(calls.buildApiUrl[0].query, '');
  assert.equal(calls.buildApiUrl[0].selected_artist, '');
  assert.equal(calls.buildApiUrl[0].gallery_scope, '');
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.fetchAndRender[0].runtimeOptions)),
    { completePageEntryBrowseContext: true },
  );
});

test('cold direct-loaded Signal 1/1 clear requests only the root sidebar while retaining the complete mounted gallery', () => {
  const { context, calls } = createContext({ searchInputValue: '' });
  context.state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'canonical_root';
  context.state.view = {
    surface: { active: 'albums' },
    query: 'Signal',
    selected_artist: 'Signal',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [{
      artist: 'Signal',
      artist_display: 'Signal',
      albums: [{ key: 'signal-signal' }],
    }],
    listen_through_scope_candidates: {
      artist: {
        artist_ref: 'Signal',
        local_completion_denominator: {
          album_count: 1,
        },
      },
    },
    artists_sidebar: [{ artist: 'Signal', count: 1 }],
    search_context: {
      selected_artist: 'Signal',
      selected_artist_source: 'auto_match',
    },
  };
  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.equal(calls.getReusableRootBrowseView.length, 1);
  assert.equal(calls.buildApiUrl.at(-1).selected_artist, '');
  assert.deepEqual(calls.buildApiUrlOptions.at(-1), { payloadTier: 'sidebar' });
  assert.equal(calls.fetchAndRender.length, 1);
  const runtimeOptions = JSON.parse(
    JSON.stringify(calls.fetchAndRender[0].runtimeOptions || {}),
  );
  const retainedSelectedViewState = runtimeOptions.retainMountedSelectedViewState;
  delete runtimeOptions.retainMountedSelectedViewState;
  assert.equal(retainedSelectedViewState.query, '');
  assert.equal(retainedSelectedViewState.selected_artist, 'Signal');
  assert.equal(retainedSelectedViewState.search_context, null);
  assert.deepEqual(
    runtimeOptions,
    {
      preserveScroll: true,
      retainMountedGalleryIfEquivalent: true,
      skipPendingViewTransition: true,
    },
  );
});

test('explicit sidebar selection replaces auto-match provenance before an immediate search clear', () => {
  const autoSelectedView = {
    query: 'Joseph',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'Neal Morse',
      selected_artist_source: 'auto_top_match',
    },
    artists_sidebar: [{ artist: 'Neal Morse', count: 1 }],
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-joseph' }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-joseph' }],
    }],
  };
  const { context, calls } = createContext({
    cachedSelectedArtistView: autoSelectedView,
    searchInputValue: '',
  });
  context.state.view = JSON.parse(JSON.stringify(autoSelectedView));
  context.state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'interactive';

  context.handleSidebarArtistSelectionClick(createSidebarArtistEvent('Neal Morse').event);
  context.state.ui.pendingSidebarSelectedArtist = '';
  context.state.ui.pendingSidebarAllArtistsActive = false;
  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.equal(context.state.view.search_context.selected_artist_source, 'requested_artist');
  assert.equal(calls.buildApiUrl.at(-1).query, '');
  assert.equal(calls.buildApiUrl.at(-1).selected_artist, 'Neal Morse');
  assert.deepEqual(calls.buildApiUrlOptions.at(-1), {});
  assert.equal(calls.fetchAndRender.at(-1).runtimeOptions, undefined);
});

test('pending uncached sidebar selection survives an immediate search clear without optimistic groups', () => {
  const { context, calls } = createContext({ searchInputValue: '' });
  context.state.view = {
    query: 'Joseph',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'Neal Morse',
      selected_artist_source: 'auto_top_match',
    },
    artists_sidebar: [{ artist: 'Uncached Artist', count: 1 }],
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-joseph' }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse-joseph' }],
    }],
  };
  context.state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'interactive';

  context.handleSidebarArtistSelectionClick(createSidebarArtistEvent('Uncached Artist').event);
  assert.deepEqual(calls.applyViewPayload, []);
  assert.equal(context.state.ui.pendingSidebarSelectedArtist, 'Uncached Artist');

  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.equal(calls.buildApiUrl.at(-1).query, '');
  assert.equal(calls.buildApiUrl.at(-1).selected_artist, 'Uncached Artist');
  assert.deepEqual(calls.buildApiUrlOptions.at(-1), {});
  assert.equal(calls.fetchAndRender.at(-1).runtimeOptions, undefined);
});

test('explicit All artists selection clears captured family filters before an immediate search clear', () => {
  const { context, calls } = createContext({ searchInputValue: '' });
  context.state.view = {
    query: 'Joseph',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: ['Cosmic Cathedral'],
    primary_filter_active: true,
    search_context: {
      selected_artist: 'Neal Morse',
      selected_artist_source: 'requested_artist',
    },
  };
  context.state.ui.preSearchView = {
    selected_artist: 'Neal Morse',
    related_filter_artists: ['Cosmic Cathedral'],
    primary_filter_active: true,
  };
  context.state.ui.preSearchViewOrigin = 'interactive';

  context.handleGalleryBootstrapClick(createAllArtistsEvent().event);
  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  const clearedView = calls.buildApiUrl.at(-1);
  assert.equal(clearedView.query, '');
  assert.equal(clearedView.selected_artist, '');
  assert.deepEqual(JSON.parse(JSON.stringify(clearedView.related_filter_artists)), []);
  assert.equal(clearedView.primary_filter_active, false);
});

test('handleGalleryBootstrapSearchSubmit retains a requested artist selected during an interactive search begun from root', () => {
  const { context, calls } = createContext({
    searchInputValue: '',
    useProductionBuildApiUrl: true,
  });
  context.state.view = {
    query: 'Morse',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'Neal Morse',
      selected_artist_source: 'requested_artist',
    },
  };
  context.state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'interactive';
  const event = createSubmitEvent();

  context.handleGalleryBootstrapSearchSubmit(event);

  assert.equal(event.wasPrevented(), true);
  assert.equal(calls.buildApiUrl.length, 1);
  assert.equal(calls.buildApiUrl[0].query, '');
  assert.equal(calls.buildApiUrl[0].selected_artist, 'Neal Morse');
  assert.deepEqual(calls.buildApiUrlOptions[0], {});
  assert.equal(calls.fetchAndRender.length, 1);
  const requestUrl = new URL(calls.fetchAndRender[0].url, 'http://localhost');
  assert.equal(requestUrl.pathname, '/view-data');
  assert.equal(requestUrl.searchParams.get('surface'), 'albums');
  assert.equal(requestUrl.searchParams.get('artist'), 'Neal Morse');
  assert.equal(requestUrl.searchParams.get('gallery_scope'), 'all');
  assert.deepEqual(requestUrl.searchParams.getAll('category'), [
    'main_library',
    'hoard',
    'new_arrivals',
  ]);
  assert.equal(requestUrl.searchParams.has('q'), false);
  assert.equal(requestUrl.searchParams.has('payload_tier'), false);
  assert.equal(calls.fetchAndRender[0].push, true);
  assert.equal(calls.fetchAndRender[0].runtimeOptions, undefined);
});

test('clearing an interactive search retains its current explicitly requested artist instead of the captured artist', () => {
  const { context, calls } = createContext({ searchInputValue: '' });
  context.state.view = {
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'Neal Morse',
      selected_artist_source: 'requested_artist',
    },
  };
  context.state.ui.preSearchView = {
    selected_artist: '3',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'interactive';

  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.equal(calls.buildApiUrl.at(-1).query, '');
  assert.equal(calls.buildApiUrl.at(-1).selected_artist, 'Neal Morse');
  assert.deepEqual(calls.buildApiUrlOptions.at(-1), {});
  assert.equal(calls.fetchAndRender.at(-1).runtimeOptions, undefined);
});

test('direct artist category search captures its origin but an unselected result clears to canonical Home', () => {
  const { context, calls } = createContext();
  context.state.view = {
    surface: { active: 'albums' },
    query: '',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library'],
    related_filter_artists: [],
    primary_filter_active: false,
    search_filters: {
      genre: [],
      mood: [],
      style: [],
      duration: { min_seconds: null, max_seconds: null },
    },
  };
  context.state.ui.pageEntryBrowseContextPending = true;

  context.handleGalleryBootstrapSearchInput('Joseph');
  calls.scheduledSearchCommits.at(-1).callback();

  assert.equal(context.state.ui.preSearchViewOrigin, 'interactive');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.ui.preSearchView)), {
    selected_artist: 'Neal Morse',
    related_filter_artists: [],
    primary_filter_active: false,
  });

  context.state.view = {
    ...context.state.view,
    query: 'Joseph',
    selected_artist: '',
    all_artists_active: false,
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'joseph-part-one' }],
    }],
  };
  context.handleGalleryBootstrapSearchInput('');
  calls.scheduledSearchCommits.at(-1).callback();

  assert.equal(calls.buildApiUrl.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.buildApiUrl[0].visible_library_categories)),
    ['main_library'],
  );
  assert.equal(calls.buildApiUrl[1].surface.active, 'albums');
  assert.equal(calls.buildApiUrl[1].surface_request, 'albums');
  assert.equal(calls.buildApiUrl[1].query, '');
  assert.equal(calls.buildApiUrl[1].selected_artist, '');
  assert.equal(calls.buildApiUrl[1].gallery_scope, '');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.buildApiUrl[1].visible_library_categories)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.fetchAndRender.at(-1))), {
    url: '/view-data?artist=&gallery_scope=all&omit_sidebar=1',
    push: true,
    runtimeOptions: {
      completePageEntryBrowseContext: true,
    },
  });
});

test('handleGalleryBootstrapSearchInput commits the debounced draft without persisting recent history', () => {
  const { context, calls } = createContext({ searchInputValue: 'Neal Morse' });

  context.handleGalleryBootstrapSearchInput('Neal Morse');

  assert.equal(calls.cancelTrackModalAlbumDetailsPrewarms, 1);
  assert.equal(context.state.ui.albumDetailPrewarmSearchSuspended, true);
  assert.equal(context.state.ui.searchDraftQuery, 'Neal Morse');
  assert.deepEqual(calls.fetchAndRender, []);
  assert.equal(calls.scheduledSearchCommits.length, 1);
  assert.equal(calls.scheduledSearchCommits[0].delay, 150);
  assert.deepEqual(calls.setSessionStorageItem, []);

  calls.scheduledSearchCommits[0].callback();

  assert.deepEqual(calls.buildApiUrl, [{
    query: 'Neal Morse',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.fetchAndRender)), [{
    url: '/view-data?artist=&gallery_scope=all&omit_sidebar=1',
    push: true,
  }]);
  assert.deepEqual(calls.setSessionStorageItem, []);
});

test('search input suspends optional waveform work through debounce and reuses one pending token', () => {
  const { context, calls } = createContext();

  context.handleGalleryBootstrapSearchInput('Neal');
  context.handleGalleryBootstrapSearchInput('Neal Morse');

  assert.deepEqual(calls.waveformPeakLoadSuspensions, [{ id: 1 }]);
  assert.deepEqual(calls.waveformPeakLoadResumptions, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.ui.pendingSearchWaveformPeakLoadSuspension)),
    { id: 1 },
  );
});

test('same-query search input immediately releases its waveform intent suspension', async () => {
  const { context, calls } = createContext();
  context.state.view.query = 'Neal Morse';

  context.handleGalleryBootstrapSearchInput('Neal Morse');
  await Promise.resolve();

  assert.deepEqual(calls.waveformPeakLoadSuspensions, [{ id: 1 }]);
  assert.deepEqual(calls.waveformPeakLoadResumptions, [{ id: 1 }]);
  assert.equal(context.state.ui.pendingSearchWaveformPeakLoadSuspension, null);
});

test('handleGalleryBootstrapSearchSubmit persists an explicitly submitted query in recent history', () => {
  const { context, calls } = createContext({ searchInputValue: 'Neal Morse' });

  context.handleGalleryBootstrapSearchSubmit(createSubmitEvent());

  assert.equal(calls.setSessionStorageItem.length, 1);
  assert.deepEqual(JSON.parse(calls.setSessionStorageItem[0].value), ['Neal Morse']);
});

test('debounced search abandons Scan Page only when the pending commit dispatches', () => {
  const { context, calls } = createContext({ searchInputValue: 'Broadcast' });
  context.state.view = {
    ...context.state.view,
    query: '',
    selected_artist: 'Neal Morse',
    all_artists_active: true,
    related_filter_artists: ['The Neal Morse Band'],
    primary_filter_active: true,
    related_artists: ['The Neal Morse Band'],
    primary_artist_groups: [{ artist: 'Neal Morse' }],
    family_artist_groups: [{ artist: 'The Neal Morse Band' }],
  };
  context.state.ui.scanPageReturnContext = {
    view: JSON.parse(JSON.stringify(context.state.view)),
    searchDraftQuery: '',
    url: 'http://localhost/?surface=albums&artist=Neal+Morse',
  };
  context.state.ui.forceScanPageVisible = true;

  context.handleGalleryBootstrapSearchInput('Broadcast');

  assert.deepEqual(calls.abandonScanPageForNavigation, []);
  assert.equal(calls.scheduledSearchCommits.length, 1);
  assert.equal(context.state.ui.scanPageReturnContext !== null, true);

  calls.scheduledSearchCommits[0].callback();

  assert.deepEqual(JSON.parse(JSON.stringify(calls.abandonScanPageForNavigation)), [{
    clearSelection: true,
  }]);
  assert.equal(context.state.ui.scanPageReturnContext, null);
  assert.equal(context.state.ui.forceScanPageVisible, false);
  assert.equal(context.state.view.selected_artist, '');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.related_artists)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.primary_artist_groups)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.family_artist_groups)), []);
  assert.deepEqual(calls.sequence.slice(-2), [
    'abandonScanPageForNavigation',
    'fetchAndRender',
  ]);
});
test('search begun at the canonical root records that origin for an exact-search clear', () => {
  const { context, calls } = createContext({ currentUrl: 'http://localhost/' });
  context.state.view = {
    surface: { active: 'albums' },
    query: '',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
  };

  context.handleGalleryBootstrapSearchInput('The Neal Morse Band');
  calls.scheduledSearchCommits.at(-1).callback();

  assert.equal(context.state.ui.preSearchViewOrigin, 'canonical_root');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.ui.preSearchView)), {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  });
});

test('recordRecentSearchQuery keeps eight nonblank queries in newest-first order', () => {
  const { context, calls } = createContext();

  for (const query of [
    'First',
    'Second',
    'Third',
    'Fourth',
    'Fifth',
    'Sixth',
    'Seventh',
    'Eighth',
    'Ninth',
  ]) {
    context.recordRecentSearchQuery(query);
  }

  assert.deepEqual(JSON.parse(JSON.stringify(context.readRecentSearchQueries())), [
    'Ninth',
    'Eighth',
    'Seventh',
    'Sixth',
    'Fifth',
    'Fourth',
    'Third',
    'Second',
  ]);
  assert.equal(calls.setSessionStorageItem.length, 9);
});

test('readRecentSearchQueries rehydrates and normalizes a valid session storage value', () => {
  const { context, calls } = createContext();
  context.sessionStorageItems.set('albumhaven.recentSearches.v1', JSON.stringify([
    '  Joseph  ',
    'The Neal Morse Band',
    'joseph',
    '',
    'Third',
    'Fourth',
    'Fifth',
    'Sixth',
    'Seventh',
    'Eighth',
    'Ninth',
  ]));

  assert.deepEqual(JSON.parse(JSON.stringify(context.readRecentSearchQueries())), [
    'Joseph',
    'The Neal Morse Band',
    'Third',
    'Fourth',
    'Fifth',
    'Sixth',
    'Seventh',
    'Eighth',
  ]);
  assert.deepEqual(calls.getSessionStorageItem, [{
    key: 'albumhaven.recentSearches.v1',
    fallback: '',
  }]);
});

test('recordRecentSearchQuery rejects blanks and moves a case-insensitive match using its newest spelling', () => {
  const { context, calls } = createContext();

  context.recordRecentSearchQuery('The Neal Morse Band');
  context.recordRecentSearchQuery('Joseph');
  context.recordRecentSearchQuery('  THE NEAL MORSE BAND  ');
  context.recordRecentSearchQuery('   ');

  assert.deepEqual(JSON.parse(JSON.stringify(context.readRecentSearchQueries())), [
    'THE NEAL MORSE BAND',
    'Joseph',
  ]);
  assert.equal(calls.setSessionStorageItem.length, 3);
});

test('recordRecentSearchQuery keeps the new query in memory when session storage rejects the write', () => {
  const { context, calls } = createContext({ sessionStorageWriteSucceeds: false });

  context.recordRecentSearchQuery('Joseph');

  assert.equal(calls.setSessionStorageItem.length, 1);
  assert.equal(calls.setSessionStorageItem[0].result, false);
  assert.deepEqual(JSON.parse(JSON.stringify(context.readRecentSearchQueries())), ['Joseph']);
});

test('search Enter owns submission before gallery focus can activate an album card', () => {
  const { context } = createContext({ searchInputValue: 'Featured Signal Collection' });
  let prevented = 0;
  let stopped = 0;
  let submitted = 0;

  const handled = context.handleGalleryBootstrapSearchKeyDown({
    key: 'Enter',
    currentTarget: {
      form: {
        requestSubmit() {
          submitted += 1;
        },
      },
    },
    preventDefault() {
      prevented += 1;
    },
    stopPropagation() {
      stopped += 1;
    },
  });

  assert.equal(handled, true);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(submitted, 1);
});

test('handleGalleryBootstrapSearchInput does not capture a blank query when its debounce commits', () => {
  const { context, calls } = createContext({ searchInputValue: '   ' });

  context.handleGalleryBootstrapSearchInput('   ');

  assert.equal(calls.scheduledSearchCommits.length, 1);
  assert.deepEqual(calls.setSessionStorageItem, []);

  calls.scheduledSearchCommits[0].callback();

  assert.deepEqual(calls.setSessionStorageItem, []);
});

test('debounced interactive-origin no-match clear restores the cached root and refreshes it from the full albums endpoint', () => {
  const cachedRootGroups = [{
    artist: 'A.C.T',
    albums: [{ key: 'last-epic' }],
  }];
  const { context, calls } = createContext({
    searchInputValue: '',
    useProductionBuildApiUrl: true,
    cachedRootView: {
      surface: { active: 'home' },
      query: '',
      selected_artist: '',
      all_artists_active: false,
      gallery_scope: '',
      visible_library_categories: [],
      artists_sidebar: [{ artist: 'A.C.T', count: 1 }],
      artist_groups: cachedRootGroups,
      primary_artist_groups: cachedRootGroups,
      family_artist_groups: [],
      show_all_artists_sidebar_link: true,
    },
  });
  context.state.view = {
    surface: { active: 'albums' },
    surface_request: 'albums',
    query: 'Album Haven deterministic no-match 7f4c29',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
    artists_sidebar: [],
  };
  context.state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'interactive';
  context.state.ui.recentSearchPopoverOpen = true;
  context.state.ui.recentSearchActiveIndex = -1;
  context.state.ui.recentSearchQueries = ['Album Haven deterministic no-match 7f4c29'];
  context.state.ui.recentSearchesLoaded = true;

  context.handleGalleryBootstrapSearchInput('');

  assert.equal(context.state.ui.recentSearchPopoverOpen, false);
  assert.equal(calls.scheduledSearchCommits.length, 1);
  calls.scheduledSearchCommits[0].callback();

  assert.equal(calls.applyViewPayload.length, 1);
  assert.equal(context.state.view.query, '');
  assert.equal(context.state.view.surface.active, 'home');
  assert.equal(context.state.view.surface_request, 'home');
  assert.equal(context.state.view.artist_groups.length > 0, true);
  assert.equal(calls.renderView.length > 0, true);
  assert.equal(calls.fetchAndRender.length, 1);
  assert.equal(calls.fetchAndRender[0].url, '/view-data?surface=albums&omit_sidebar=1');
  assert.equal(calls.fetchAndRender[0].runtimeOptions.restartIfSameUrl, true);
  assert.equal(
    calls.buildApiUrl.at(-1).surface.active,
    'albums',
    'cached canonical Home clear must refresh with the full albums projection',
  );
  assert.equal(
    calls.fetchAndRender[0].runtimeOptions.completePageEntryBrowseContext,
    true,
  );
});

test('syncSearchClear waits for blur before committing a native search clear', () => {
  const { context, calls } = createContext({ searchInputValue: '' });
  context.state.view = {
    query: 'Neal Morse',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [{ artist: 'Neal Morse', artist_display: 'Neal Morse' }],
  };

  context.syncSearchClear();

  assert.equal(context.state.ui.pendingSearchClearOnBlur, true);
  assert.deepEqual(calls.buildApiUrl, []);
  assert.deepEqual(calls.fetchAndRender, []);
});

test('handleGalleryBootstrapSearchBlur commits the same cleared-search view as Apply', () => {
  const { context, calls } = createContext({ searchInputValue: '' });
  context.state.view = {
    surface: { active: 'albums' },
    query: 'Neal Morse',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [{ artist: 'Neal Morse', artist_display: 'Neal Morse' }],
  };
  context.state.ui.pendingSearchClearOnBlur = true;

  context.handleGalleryBootstrapSearchBlur();

  assert.equal(calls.buildApiUrl.length, 1);
  assert.equal(calls.buildApiUrl[0].surface.active, 'albums');
  assert.equal(calls.buildApiUrl[0].surface_request, 'albums');
  assert.equal(calls.buildApiUrl[0].query, '');
  assert.equal(calls.buildApiUrl[0].selected_artist, '');
  assert.equal(calls.buildApiUrl[0].gallery_scope, '');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.buildApiUrl[0].visible_library_categories)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.fetchAndRender)), [{
    url: '/view-data?artist=&gallery_scope=all&omit_sidebar=1',
    push: true,
    runtimeOptions: {
      completePageEntryBrowseContext: true,
    },
  }]);
  assert.equal(context.state.ui.pendingSearchClearOnBlur, false);
});

test('native clear reloads the full selected-artist gallery when the search has captured origin state', () => {
  const cachedRootView = {
    query: '',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    artists_sidebar: Array.from({ length: 120 }, (_, index) => ({
      artist: `Artist ${index}`,
      count: index + 1,
    })),
    show_all_artists_sidebar_link: true,
  };
  const { context, calls } = createContext({
    searchInputValue: '',
    cachedRootView,
  });
  const mountedGalleryGroups = [{
    artist: 'Neal Morse',
    artist_display: 'Neal Morse',
    albums: [{ key: 'neal-morse-album' }],
  }];
  context.state.view = {
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [{ artist: 'Neal Morse', artist_display: 'Neal Morse' }],
    artist_groups: mountedGalleryGroups,
    artists_sidebar: [{ artist: 'Neal Morse', count: 7 }],
  };

  const originalViewStateRevision = 17;
  const olderQueuedViewRequest = {
    url: '/view-data?surface=albums&q=Neal+Morse&artist=Neal+Morse',
    push: false,
    options: {
      preserveScroll: true,
      interruptCurrent: false,
    },
    originatingViewStateRevision: originalViewStateRevision,
  };
  context.state.ui.viewStateRevision = originalViewStateRevision;
  context.state.ui.pendingViewRequest = olderQueuedViewRequest;
  context.state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'canonical_root';
  context.state.ui.pendingSearchClearOnBlur = true;
  context.handleGalleryBootstrapSearchBlur();

  assert.deepEqual(calls.applyViewPayload, []);
  assert.equal(context.state.view.artist_groups, mountedGalleryGroups);
  assert.equal(calls.renderSidebar, 0);
  assert.deepEqual(calls.renderView, []);
  assert.deepEqual(calls.pushBrowserViewState, []);
  assert.equal(calls.buildApiUrl.length, 1);
  assert.equal(calls.buildApiUrl[0].query, '');
  assert.equal(calls.buildApiUrl[0].selected_artist, 'Neal Morse');
  assert.equal(calls.fetchAndRender.length, 1);
  assert.equal(calls.fetchAndRender[0].runtimeOptions, undefined);
  assert.deepEqual(calls.renderLibraryLoader, []);
  assert.equal(context.state.ui.pendingViewRequest, olderQueuedViewRequest);
  assert.equal(context.state.ui.viewStateRevision, originalViewStateRevision);
  assert.equal(context.state.gallery.sidebarArtistsOverride, null);
  assert.equal(context.state.gallery.sidebarShowAllArtistsOverride, null);
});

test('canonical search clear keeps browse scope for a retained artist request but resets it without selection', () => {
  const visibleLibraryCategories = ['main_library', 'hoard', 'new_arrivals'];
  const cachedRootView = {
    query: '',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: visibleLibraryCategories,
    artists_sidebar: [
      { artist: 'Earlier Artist', count: 4 },
      { artist: 'The Neal Morse Band', count: 10 },
      { artist: 'Zebra Artist', count: 2 },
    ],
    artist_count: 3,
    show_all_artists_sidebar_link: true,
  };
  const blankClear = createContext({
    searchInputValue: '',
    cachedRootView,
  });
  blankClear.context.state.view = {
    surface: { active: 'albums' },
    query: 'No exact artist',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: visibleLibraryCategories,
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [],
    artists_sidebar: [],
  };
  blankClear.context.state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  blankClear.context.state.ui.preSearchViewOrigin = 'canonical_root';
  blankClear.context.state.ui.pendingSearchClearOnBlur = true;

  blankClear.context.handleGalleryBootstrapSearchBlur();

  assert.deepEqual(blankClear.calls.getReusableRootBrowseView, [{
    query: '',
    selected_artist: '',
    all_artists_active: true,
    gallery_scope: '',
    visible_library_categories: [],
    related_filter_artists: [],
    primary_filter_active: false,
  }]);
  assert.equal(blankClear.calls.buildApiUrl[0].surface.active, 'albums');
  assert.equal(blankClear.calls.buildApiUrl[0].gallery_scope, '');
  assert.deepEqual(blankClear.calls.buildApiUrl[0].visible_library_categories, []);
  assert.equal(
    blankClear.calls.fetchAndRender.at(-1).runtimeOptions.completePageEntryBrowseContext,
    true,
  );

  const retainedArtistClear = createContext({
    searchInputValue: '',
    cachedRootView,
  });
  retainedArtistClear.context.state.view = {
    surface: { active: 'albums' },
    query: 'The Neal Morse Band',
    selected_artist: 'The Neal Morse Band',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: visibleLibraryCategories,
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'The Neal Morse Band',
      selected_artist_source: 'auto_top_match',
    },
    primary_artist_groups: [{
      artist: 'The Neal Morse Band',
      artist_display: 'The Neal Morse Band',
      albums: [{ key: 'the-neal-morse-band-album' }],
    }],
    artists_sidebar: [
      { artist: 'Neal Morse', count: 10 },
      { artist: 'The Neal Morse Band', count: 10 },
    ],
  };
  retainedArtistClear.context.state.ui.preSearchView = {
    selected_artist: 'Previously Selected Artist',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  retainedArtistClear.context.state.ui.preSearchViewOrigin = 'canonical_root';
  retainedArtistClear.context.state.ui.pendingSearchClearOnBlur = true;

  retainedArtistClear.context.handleGalleryBootstrapSearchBlur();

  assert.deepEqual(retainedArtistClear.calls.getReusableRootBrowseView, [{
    query: '',
    selected_artist: '',
    all_artists_active: true,
    gallery_scope: 'all',
    visible_library_categories: visibleLibraryCategories,
    related_filter_artists: [],
    primary_filter_active: false,
  }]);
  assert.equal(retainedArtistClear.calls.buildApiUrl[0].surface.active, 'albums');
  assert.equal(retainedArtistClear.calls.buildApiUrl[0].selected_artist, 'The Neal Morse Band');
  assert.equal(retainedArtistClear.calls.buildApiUrl[0].gallery_scope, 'all');
  assert.deepEqual(
    retainedArtistClear.calls.buildApiUrl[0].visible_library_categories,
    visibleLibraryCategories,
  );
});

test('native exact-artist 10/10 clear restores the cached root around the complete mounted gallery', () => {
  const cachedRootSidebar = [
    { artist: 'Earlier Artist', count: 4 },
    { artist: 'The Neal Morse Band', count: 10 },
    { artist: 'Zebra Artist', count: 2 },
  ];
  const cachedRootView = {
    query: '',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    artists_sidebar: cachedRootSidebar,
    artist_count: cachedRootSidebar.length,
    show_all_artists_sidebar_link: true,
  };
  const { context, calls } = createContext({
    searchInputValue: '',
    cachedRootView,
  });
  const completeSelectedAlbums = Array.from({ length: 10 }, (_, index) => ({
    key: `the-neal-morse-band-album-${index + 1}`,
  }));
  const mountedPrimaryGroup = {
    artist: 'The Neal Morse Band',
    artist_display: 'The Neal Morse Band',
    albums: completeSelectedAlbums,
  };
  const mountedGalleryGroups = [{
    ...mountedPrimaryGroup,
  }];
  context.state.view = {
    surface: { active: 'albums' },
    query: 'The Neal Morse Band',
    selected_artist: 'The Neal Morse Band',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'The Neal Morse Band',
      selected_artist_source: 'auto_top_match',
    },
    primary_artist_groups: [mountedPrimaryGroup],
    family_artist_groups: [],
    artist_groups: mountedGalleryGroups,
    artists_sidebar: [
      { artist: 'Morse Portnoy George', count: 2 },
      { artist: 'Neal Morse', count: 10 },
      { artist: 'The Neal Morse Band', count: 10 },
    ],
    artist_count: 3,
  };
  context.state.ui.preSearchView = {
    selected_artist: 'Previously Selected Artist',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'canonical_root';
  context.state.ui.pendingSearchClearOnBlur = true;
  context.handleGalleryBootstrapSearchBlur();

  assert.equal(calls.applyViewPayload.length, 1);
  assert.equal(calls.applyViewPayload[0].payload.query, '');
  assert.equal(calls.applyViewPayload[0].payload.selected_artist, 'The Neal Morse Band');
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.applyViewPayload[0].payload.artists_sidebar)),
    cachedRootSidebar,
  );
  assert.equal(context.state.view.artist_groups, mountedGalleryGroups);
  assert.equal(calls.renderSidebar, 1);
  assert.deepEqual(calls.renderView, []);
  assert.deepEqual(calls.buildApiUrl, []);
  assert.deepEqual(calls.fetchAndRender, []);
  assert.deepEqual(calls.renderLibraryLoader, []);
});

test('native exact-artist clear uses the selected-gallery completion denominator before the grouped root sidebar count', () => {
  const cachedRootSidebar = [
    { artist: 'Earlier Artist', count: 4 },
    { artist: 'Neal Morse', count: 10 },
    { artist: 'Zebra Artist', count: 2 },
  ];
  const { context, calls } = createContext({
    searchInputValue: '',
    cachedRootView: {
      query: '',
      selected_artist: '',
      all_artists_active: false,
      gallery_scope: 'all',
      visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
      artists_sidebar: cachedRootSidebar,
      artist_count: cachedRootSidebar.length,
      show_all_artists_sidebar_link: true,
    },
  });
  const completeSelectedAlbums = Array.from({ length: 20 }, (_, index) => ({
    key: `neal-morse-album-${index + 1}`,
  }));
  const mountedPrimaryGroup = {
    artist: 'Neal Morse',
    artist_display: 'Neal Morse',
    albums: completeSelectedAlbums,
  };
  const mountedGalleryGroups = [mountedPrimaryGroup];
  context.state.view = {
    surface: { active: 'albums' },
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'Neal Morse',
      selected_artist_source: 'auto_top_match',
    },
    primary_artist_groups: [mountedPrimaryGroup],
    family_artist_groups: [],
    artist_groups: mountedGalleryGroups,
    artists_sidebar: [{ artist: 'Neal Morse', count: 20 }],
    artist_count: 1,
    listen_through_scope_candidates: {
      artist: {
        artist_ref: 'Neal Morse',
        local_completion_denominator: {
          album_count: 20,
        },
      },
    },
  };
  context.state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'canonical_root';
  context.state.ui.pendingSearchClearOnBlur = true;

  context.handleGalleryBootstrapSearchBlur();

  assert.equal(calls.applyViewPayload.length, 1);
  assert.equal(calls.applyViewPayload[0].payload.query, '');
  assert.equal(calls.applyViewPayload[0].payload.selected_artist, 'Neal Morse');
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.applyViewPayload[0].payload.artists_sidebar)),
    cachedRootSidebar,
  );
  assert.equal(context.state.view.artist_groups, mountedGalleryGroups);
  assert.equal(calls.renderSidebar, 1);
  assert.deepEqual(calls.renderView, []);
  assert.deepEqual(calls.buildApiUrl, []);
  assert.deepEqual(calls.fetchAndRender, []);
  assert.deepEqual(calls.renderLibraryLoader, []);
});

test('native exact-artist clear restores the captured sidebar preview instead of an expanded reusable root', () => {
  const capturedSidebarPreview = [
    { artist: 'Selected Artist', count: 2 },
    { artist: 'Preview Artist', count: 4 },
  ];
  const expandedReusableRoot = [
    { artist: 'Expanded Artist 1', count: 7 },
    { artist: 'Expanded Artist 2', count: 8 },
    { artist: 'Selected Artist', count: 2 },
  ];
  const { context, calls } = createContext({
    searchInputValue: '',
    cachedRootView: {
      query: '',
      selected_artist: '',
      all_artists_active: false,
      gallery_scope: 'all',
      visible_library_categories: ['main_library'],
      artists_sidebar: expandedReusableRoot,
      artist_count: expandedReusableRoot.length,
      show_all_artists_sidebar_link: true,
    },
  });
  const mountedPrimaryGroup = {
    artist: 'Selected Artist',
    artist_display: 'Selected Artist',
    albums: [
      { key: 'selected-album-1' },
      { key: 'selected-album-2' },
    ],
  };
  const mountedGalleryGroups = [mountedPrimaryGroup];
  context.state.view = {
    surface: { active: 'albums' },
    query: 'Selected Artist',
    selected_artist: 'Selected Artist',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library'],
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'Selected Artist',
      selected_artist_source: 'auto_top_match',
    },
    primary_artist_groups: [mountedPrimaryGroup],
    family_artist_groups: [],
    artist_groups: mountedGalleryGroups,
    artists_sidebar: [{ artist: 'Selected Artist', count: 2 }],
    artist_count: 1,
  };
  context.state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
    artists_sidebar: capturedSidebarPreview,
    artist_count: capturedSidebarPreview.length,
    show_all_artists_sidebar_link: true,
  };
  context.state.ui.preSearchViewOrigin = 'canonical_root';
  context.state.ui.pendingSearchClearOnBlur = true;

  context.handleGalleryBootstrapSearchBlur();

  assert.equal(calls.applyViewPayload.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.applyViewPayload[0].payload.artists_sidebar)),
    [
      { artist: 'Selected Artist', count: 2 },
      { artist: 'Preview Artist', count: 4 },
    ],
  );
  assert.equal(calls.applyViewPayload[0].payload.artist_count, capturedSidebarPreview.length);
  assert.equal(context.state.view.artist_groups, mountedGalleryGroups);
  assert.deepEqual(calls.fetchAndRender, []);
});

test('native exact-artist clear fetches when a query-scoped denominator understates the cached root album count', () => {
  const cachedRootSidebar = [
    { artist: 'Earlier Artist', count: 4 },
    { artist: 'Neal Morse', count: 10 },
    { artist: 'Zebra Artist', count: 2 },
  ];
  const { context, calls } = createContext({
    searchInputValue: '',
    cachedRootView: {
      query: '',
      selected_artist: '',
      all_artists_active: false,
      gallery_scope: 'all',
      visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
      artists_sidebar: cachedRootSidebar,
      artist_count: cachedRootSidebar.length,
      show_all_artists_sidebar_link: true,
    },
  });
  const mountedPrimaryGroup = {
    artist: 'Neal Morse',
    artist_display: 'Neal Morse',
    albums: [{ key: 'neal-morse-query-match' }],
  };
  const mountedGalleryGroups = [mountedPrimaryGroup];
  context.state.view = {
    surface: { active: 'albums' },
    query: 'query match',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'Neal Morse',
      selected_artist_source: 'requested_artist',
    },
    primary_artist_groups: [mountedPrimaryGroup],
    family_artist_groups: [],
    artist_groups: mountedGalleryGroups,
    artists_sidebar: [{ artist: 'Neal Morse', count: 1 }],
    artist_count: 1,
    listen_through_scope_candidates: {
      artist: {
        artist_ref: 'Neal Morse',
        local_completion_denominator: {
          album_count: 1,
        },
      },
    },
  };
  context.state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'canonical_root';
  context.state.ui.pendingSearchClearOnBlur = true;

  context.handleGalleryBootstrapSearchBlur();

  assert.deepEqual(calls.applyViewPayload, []);
  assert.equal(context.state.view.query, 'query match');
  assert.equal(context.state.view.selected_artist, 'Neal Morse');
  assert.equal(context.state.view.artist_groups, mountedGalleryGroups);
  assert.equal(calls.buildApiUrl.length, 1);
  assert.equal(calls.buildApiUrl[0].query, '');
  assert.equal(calls.buildApiUrl[0].selected_artist, 'Neal Morse');
  assert.equal(calls.fetchAndRender.length, 1);
  assert.equal(calls.fetchAndRender[0].runtimeOptions, undefined);
  assert.deepEqual(calls.renderLibraryLoader, []);
});

test('native clear does not retain a query-filtered selected-artist group over the full response', () => {
  const cachedRootView = {
    query: '',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    artists_sidebar: [
      { artist: 'Neal Morse', count: 10 },
      { artist: 'Neal Morse & The Resonance', count: 8 },
    ],
    artist_groups: [{
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      albums: [
        { key: 'neal-morse-joseph', name: 'Joseph' },
        { key: 'neal-morse-sola-scriptura', name: 'Sola Scriptura' },
        { key: 'neal-morse-testimony', name: 'Testimony' },
      ],
    }],
    artist_count: 2,
    show_all_artists_sidebar_link: true,
  };
  const { context, calls } = createContext({
    searchInputValue: '',
    cachedRootView,
  });
  const retainedFamilyGroup = {
    artist: 'Neal Morse & The Resonance',
    artist_display: 'Neal Morse & The Resonance',
    albums: [{ key: 'resonance-no-hill-for-a-climber' }],
  };
  const mountedPrimaryGroup = {
    artist: 'Neal Morse',
    artist_display: 'Neal Morse',
    albums: [{ key: 'neal-morse-joseph', name: 'Joseph' }],
  };
  const mountedGalleryGroups = [
    mountedPrimaryGroup,
    retainedFamilyGroup,
  ];
  context.state.view = {
    surface: { active: 'albums' },
    query: 'Joseph',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: {
      selected_artist: 'Neal Morse',
      selected_artist_source: 'requested_artist',
    },
    primary_artist_groups: [mountedPrimaryGroup],
    family_artist_groups: [retainedFamilyGroup],
    artist_groups: mountedGalleryGroups,
    artists_sidebar: [{ artist: 'Neal Morse', count: 1 }],
    artist_count: 2,
  };
  context.state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'canonical_root';
  context.state.ui.pendingSearchClearOnBlur = true;

  context.handleGalleryBootstrapSearchBlur();

  assert.equal(context.state.view.query, 'Joseph');
  assert.equal(context.state.view.selected_artist, 'Neal Morse');
  assert.equal(context.state.view.primary_artist_groups[0], mountedPrimaryGroup);
  assert.equal(context.state.view.family_artist_groups[0], retainedFamilyGroup);
  assert.equal(context.state.view.artist_groups, mountedGalleryGroups);
  assert.equal(calls.renderSidebar, 0);
  assert.deepEqual(calls.renderView, []);
  assert.equal(calls.buildApiUrl.length, 1);
  assert.equal(calls.buildApiUrl[0].query, '');
  assert.equal(calls.buildApiUrl[0].selected_artist, 'Neal Morse');
  assert.equal(calls.fetchAndRender.length, 1);
  assert.equal(calls.fetchAndRender[0].runtimeOptions, undefined);
  assert.deepEqual(calls.renderLibraryLoader, []);
});

test('cold direct-loaded Signal 1/1 clear preserves a complete cached root and mounted gallery without a request', () => {
  const cachedRootSidebar = [
    { artist: 'Earlier Artist', count: 4 },
    { artist: 'Signal', count: 1 },
    { artist: 'Zebra Artist', count: 2 },
  ];
  const cachedRootView = {
    query: '',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    artists_sidebar: cachedRootSidebar,
    artist_count: cachedRootSidebar.length,
    show_all_artists_sidebar_link: true,
    payload_tier: 'sidebar',
    initial_view_partial: true,
  };
  const { context, calls } = createContext({
    searchInputValue: '',
    cachedRootView,
  });
  const mountedGalleryGroups = [{
    artist: 'Signal',
    artist_display: 'Signal',
    albums: [{ key: 'signal-signal' }],
  }];
  const mountedFamilyGroups = [{
    artist: 'Signal Family',
    artist_display: 'Signal Family',
    albums: [{ key: 'signal-family-album' }],
  }];
  const mountedRelatedArtists = ['Signal Family'];
  const mountedRelatedFilterArtists = ['Signal Family'];
  const mountedArtistGroups = [...mountedGalleryGroups, ...mountedFamilyGroups];
  context.state.view = {
    surface: { active: 'albums' },
    query: 'Signal',
    selected_artist: 'Signal',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: mountedRelatedFilterArtists,
    primary_filter_active: true,
    search_context: {
      selected_artist: 'Signal',
      selected_artist_source: 'auto_top_match',
    },
    related_artists: mountedRelatedArtists,
    primary_artist_groups: mountedGalleryGroups,
    family_artist_groups: mountedFamilyGroups,
    artist_groups: mountedArtistGroups,
    artists_sidebar: [{ artist: 'Signal', count: 1 }],
    artist_count: 1,
  };
  context.buildApiUrl = (view, options = {}) => {
    calls.buildApiUrl.push({
      view: JSON.parse(JSON.stringify(view)),
      options: JSON.parse(JSON.stringify(options)),
    });
    return options.omitSidebar
      ? '/view-data?artist=Signal&gallery_scope=all&omit_sidebar=1'
      : '/view-data?artist=Signal&gallery_scope=all';
  };

  context.syncSearchClear();

  assert.equal(context.state.ui.pendingSearchClearOnBlur, true);

  context.handleGalleryBootstrapSearchBlur();

  assert.equal(calls.applyViewPayload.length, 1);
  const restoredPayload = calls.applyViewPayload[0].payload;
  assert.equal(restoredPayload.surface.active, 'albums');
  assert.equal(restoredPayload.query, '');
  assert.equal(restoredPayload.selected_artist, 'Signal');
  assert.deepEqual(
    JSON.parse(JSON.stringify(restoredPayload.artists_sidebar)),
    cachedRootSidebar,
  );
  assert.equal(restoredPayload.artist_count, cachedRootSidebar.length);
  assert.equal(context.state.view.artist_groups, mountedArtistGroups);
  assert.equal(context.state.view.primary_artist_groups, mountedGalleryGroups);
  assert.equal(context.state.view.family_artist_groups, mountedFamilyGroups);
  assert.equal(context.state.view.related_artists, mountedRelatedArtists);
  assert.equal(context.state.view.related_filter_artists, mountedRelatedFilterArtists);
  assert.equal(context.state.view.primary_filter_active, true);
  assert.equal(
    calls.applyViewPayload[0].runtimeOptions.preserveMountedGalleryChildren,
    true,
  );
  assert.equal(calls.renderSidebar, 1);
  assert.equal(calls.renderRelated, 0);
  assert.deepEqual(calls.renderView, []);
  assert.deepEqual(calls.buildApiUrl, []);
  assert.deepEqual(calls.fetchAndRender, []);
  assert.deepEqual(calls.renderLibraryLoader, []);
  assert.equal(context.state.ui.pendingSearchClearOnBlur, false);
});

test('native clear preserves an intentionally family-filtered mounted gallery and the complete family controls', () => {
  const cachedRootSidebar = [
    { artist: 'Earlier Artist', count: 4 },
    { artist: 'Ария', count: 24 },
    { artist: 'Zebra Artist', count: 2 },
  ];
  const { context, calls } = createContext({
    searchInputValue: '',
    cachedRootView: {
      query: '',
      selected_artist: '',
      all_artists_active: false,
      gallery_scope: 'all',
      visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
      artists_sidebar: cachedRootSidebar,
      artist_count: cachedRootSidebar.length,
      show_all_artists_sidebar_link: true,
    },
  });
  const mountedFamilyGroups = [{
    artist: 'Виталий Дубинин',
    artist_display: 'Виталий Дубинин',
    albums: [
      { key: 'vitaliy-dubinin-autumn' },
      { key: 'vitaliy-dubinin-masquerade' },
    ],
  }];
  const mountedRelatedArtists = [
    'Ария',
    'Кипелов',
    'Виталий Дубинин',
    'Дубинин & Холстинин',
  ];
  const mountedRelatedFilterArtists = ['Виталий Дубинин'];
  context.state.view = {
    surface: { active: 'albums' },
    query: 'Ария',
    selected_artist: 'Ария',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: mountedRelatedFilterArtists,
    primary_filter_active: false,
    search_context: {
      selected_artist: 'Ария',
      selected_artist_source: 'auto_top_match',
    },
    related_artists: mountedRelatedArtists,
    primary_artist_groups: [],
    family_artist_groups: mountedFamilyGroups,
    artist_groups: mountedFamilyGroups,
    artists_sidebar: [{ artist: 'Ария', count: 24 }],
    artist_count: 1,
    listen_through_scope_candidates: {
      artist: {
        artist_ref: 'Ария',
        local_completion_denominator: {
          album_count: 24,
        },
      },
    },
  };
  context.state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchViewOrigin = 'canonical_root';

  context.syncSearchClear();
  context.handleGalleryBootstrapSearchBlur();

  assert.equal(calls.applyViewPayload.length, 1);
  assert.equal(calls.applyViewPayload[0].payload.query, '');
  assert.equal(calls.applyViewPayload[0].payload.selected_artist, 'Ария');
  assert.equal(context.state.view.artist_groups, mountedFamilyGroups);
  assert.equal(context.state.view.family_artist_groups, mountedFamilyGroups);
  assert.equal(context.state.view.related_artists, mountedRelatedArtists);
  assert.equal(context.state.view.related_filter_artists, mountedRelatedFilterArtists);
  assert.equal(context.state.view.primary_filter_active, false);
  assert.equal(
    calls.applyViewPayload[0].runtimeOptions.preserveMountedGalleryChildren,
    true,
  );
  assert.equal(calls.renderSidebar, 1);
  assert.equal(calls.renderRelated, 0);
  assert.deepEqual(calls.renderView, []);
  assert.deepEqual(calls.buildApiUrl, []);
  assert.deepEqual(calls.fetchAndRender, []);
  assert.deepEqual(calls.renderLibraryLoader, []);
});

test('native clear restores the captured pre-search artist tree when no reusable root cache exists', () => {
  const { context, calls } = createContext({
    currentUrl: 'http://localhost/',
    searchInputValue: '',
  });
  const preSearchSidebar = [
    { artist: 'Earlier Artist', count: 4 },
    { artist: 'Middle Artist', count: 6 },
    { artist: 'Zebra Artist', count: 2 },
  ];
  context.state.view = {
    surface: { active: 'albums' },
    query: '',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    artists_sidebar: preSearchSidebar,
    artist_count: 1986,
    show_all_artists_sidebar_link: true,
  };

  context.handleGalleryBootstrapSearchInput('Aria');
  calls.scheduledSearchCommits.at(-1).callback();

  const mountedFamilyGroups = [{
    artist: 'Vitaliy Dubinin',
    albums: [{ key: 'vitaliy-dubinin-autumn' }],
  }];
  context.state.view = {
    ...context.state.view,
    query: 'Aria',
    selected_artist: 'Aria',
    related_filter_artists: ['Vitaliy Dubinin'],
    primary_filter_active: false,
    related_artists: ['Aria', 'Vitaliy Dubinin'],
    primary_artist_groups: [],
    family_artist_groups: mountedFamilyGroups,
    artist_groups: mountedFamilyGroups,
    artists_sidebar: [{ artist: 'Aria', count: 24 }],
    artist_count: 1,
  };
  calls.applyViewPayload.length = 0;
  calls.buildApiUrl.length = 0;
  calls.buildApiUrlOptions.length = 0;
  calls.fetchAndRender.length = 0;

  context.syncSearchClear();
  context.handleGalleryBootstrapSearchBlur();

  assert.equal(context.state.view.query, '');
  assert.equal(context.state.view.selected_artist, 'Aria');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.view.artists_sidebar)),
    [
      { artist: 'Aria', count: 24 },
      ...preSearchSidebar,
    ],
  );
  assert.equal(context.state.view.artist_count, 1986);
  assert.equal(context.state.view.show_all_artists_sidebar_link, true);
  assert.equal(context.state.view.artist_groups, mountedFamilyGroups);
  assert.equal(context.state.view.family_artist_groups, mountedFamilyGroups);
  assert.deepEqual(calls.buildApiUrl, []);
  assert.deepEqual(calls.fetchAndRender, []);
  assert.deepEqual(calls.renderLibraryLoader, []);
});

test('syncSearchClear injects the selected artist into a cached preview sidebar after blur when the preview tree does not include it', () => {
  const cachedRootView = {
    query: '',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    artists_sidebar: [
      { artist: '3', count: 1 },
      { artist: '3 Mice', count: 1 },
    ],
    show_all_artists_sidebar_link: true,
    payload_tier: 'sidebar',
    initial_view_partial: true,
  };
  const { context, calls } = createContext({
    searchInputValue: '',
    cachedRootView,
  });
  context.state.view = {
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [{
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      albums: Array.from({ length: 12 }, (_, index) => ({
        key: `neal-morse-album-${index + 1}`,
      })),
    }],
    artists_sidebar: [{ artist: 'Neal Morse', artist_display: 'Neal Morse', count: 12 }],
  };

  context.syncSearchClear();

  assert.equal(context.state.ui.pendingSearchClearOnBlur, true);

  context.handleGalleryBootstrapSearchBlur();

  assert.deepEqual(JSON.parse(JSON.stringify(calls.applyViewPayload)), [{
    payload: {
      query: '',
      selected_artist: 'Neal Morse',
      all_artists_active: false,
      gallery_scope: 'all',
      visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
      related_filter_artists: [],
      primary_filter_active: false,
      search_context: null,
      primary_artist_groups: [{
        artist: 'Neal Morse',
        artist_display: 'Neal Morse',
        albums: Array.from({ length: 12 }, (_, index) => ({
          key: `neal-morse-album-${index + 1}`,
        })),
      }],
      artists_sidebar: [
        { artist: 'Neal Morse', artist_display: 'Neal Morse', count: 12 },
        { artist: '3', count: 1 },
        { artist: '3 Mice', count: 1 },
      ],
      show_all_artists_sidebar_link: true,
    },
  }]);
});

test('handleGalleryBootstrapSearchSubmit is a no-op for an already-cleared empty search with the same selected artist', () => {
  const { context, calls } = createContext({ searchInputValue: '' });
  context.state.view = {
    query: '',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [{ artist: 'Neal Morse', artist_display: 'Neal Morse' }],
  };
  let prevented = false;

  context.handleGalleryBootstrapSearchSubmit({
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls.buildApiUrl, []);
  assert.deepEqual(calls.fetchAndRender, []);
  assert.deepEqual(calls.setSessionStorageItem, []);
});
