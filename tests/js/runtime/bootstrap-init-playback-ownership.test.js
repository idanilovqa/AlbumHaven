const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'bootstrap-init.js');
const accountMenuPath = path.join(path.dirname(helperPath), 'account-menu.js');
const helperSource = `${fs.readFileSync(accountMenuPath, 'utf8')}\n${fs.readFileSync(helperPath, 'utf8')}`;
const loaderHelperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'loader-status-helpers.js');
const loaderHelperSource = fs.readFileSync(loaderHelperPath, 'utf8');
const viewValueHelperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'view-value-helpers.js');
const viewValueHelperSource = fs.readFileSync(viewValueHelperPath, 'utf8');

test('bootstrap init prepares streaming and observes preparation rejection without native restore retries', async () => {
  const unloadOrder = [];
  const calls = {
    initPlaybackOwnershipCoordinator: 0,
    prepareStreamingPlaybackEngine: 0,
    visibilitychange: null,
    loopExpiryReconciles: 0,
    persistPlayerStateForUnload: [],
    resetPlayerUnloadPersistence: 0,
    setLoopActive: [],
    stopStreamingPlayback: [],
  };
  const windowListeners = {};
  const documentListeners = {};
  const preparationFailure = new Error('worklet preparation rejected');
  const observedErrors = [];
  let initialLoaderState = null;
  const context = {
    window: {
      location: { href: 'http://localhost:5000/' },
      addEventListener(name, handler) {
        windowListeners[name] = handler;
      },
    },
    document: {
      visibilityState: 'visible',
      addEventListener(name, handler) {
        documentListeners[name] = handler;
        if (name === 'visibilitychange') {
          calls.visibilitychange = handler;
        }
      },
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
    },
    URL,
    state: {
      player: {
        loopActive: true,
      },
      ui: {},
      view: {
        selected_artist: '',
        query: '',
      },
    },
    appBootstrap: {
      getBootstrap() {
        return { scanInProgress: true, scanPhase: 'discovering' };
      },
      releasePayloadViewState() {},
    },
    normalizeBootstrapRuntimeStatePayload(payload) {
      return {
        view: payload.initial_view,
        bootstrap: payload.bootstrap,
      };
    },
    resolveGalleryDisplayPreferenceViewState(view) {
      return view;
    },
    applyViewPayload() {},
    suppressRefocusViewportInteraction() {},
    suppressRefocusViewportClick() {},
    noteViewportRefocusHoverIntent() {},
    noteViewportRefocusWheelIntent() {},
    shouldRunImmediateStartupHydration() {
      return false;
    },
    restorePlayerAppearance() {},
    startupMetrics: {
      beginInitialRefresh() {},
      markInitialRender() {},
    },
    renderView() {},
    updateStatusIndicator() {},
    renderLibraryLoader(data) {
      initialLoaderState = data;
    },
    scheduleBrowserTimeout() {
      return 0;
    },
    pollStatus() {},
    fetchAndRender() {},
    isEffectivelyEmptyView() {
      return false;
    },
    hideVersionContextMenu() {},
    hideStatusContextMenu() {},
    showVersionContextMenu() {},
    showStatusContextMenu() {},
    hideAlbumCardContextMenu() {},
    showAlbumCardContextMenu() {},
    getIndexedAlbum() {
      return null;
    },
    handleViewportRefocusVisibilityChange() {},
    persistPlayerState() {},
    persistPlayerStateForUnload(reason) {
      unloadOrder.push(`persist:${reason}`);
      calls.persistPlayerStateForUnload.push(reason);
    },
    resetPlayerUnloadPersistence() {
      calls.resetPlayerUnloadPersistence += 1;
    },
    loopEditSessionExpiryController: {
      reconcile() {
        calls.loopExpiryReconciles += 1;
      },
    },
    setLoopActive(active) {
      calls.setLoopActive.push(active);
      context.state.player.loopActive = active;
    },
    flushListenSessionOnUnload() {},
    stopStreamingPlayback(reason) {
      unloadOrder.push(`stop:${reason}`);
      calls.stopStreamingPlayback.push(reason);
      return Promise.resolve();
    },
    armViewportRefocusSuppression() {},
    initPlaybackOwnershipCoordinator() {
      calls.initPlaybackOwnershipCoordinator += 1;
    },
    prepareStreamingPlaybackEngine() {
      calls.prepareStreamingPlaybackEngine += 1;
      return Promise.reject(preparationFailure);
    },
    attachModalEvents() {},
    attachCoverLookupModalEvents() {},
    attachCoverLookupDeleteConfirmEvents() {},
    attachUtilityModalEvents() {},
    attachRepairConfirmEvents() {},
    attachPlayerEvents() {},
    showToast() {},
    updatePlayerUi() {},
    console: {
      ...console,
      error(...args) {
        observedErrors.push(args);
      },
    },
  };

  vm.createContext(context);
  vm.runInContext(loaderHelperSource, context, { filename: loaderHelperPath });
  vm.runInContext(helperSource, context, { filename: helperPath });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.initPlaybackOwnershipCoordinator, 1);
  assert.equal(calls.prepareStreamingPlaybackEngine, 1);
  assert.equal(observedErrors.length, 1);
  assert.equal(observedErrors[0].includes(preparationFailure), true);
  assert.equal(typeof calls.visibilitychange, 'function');
  calls.visibilitychange();
  assert.ok(windowListeners.focus);
  windowListeners.focus();
  documentListeners.pointerdown();
  documentListeners.keydown({});
  assert.equal(
    calls.loopExpiryReconciles,
    4,
    'visible, focus, pointer, and keyboard re-entry all reconcile wall-clock expiry',
  );
  assert.ok(documentListeners.contextmenu);
  assert.equal(initialLoaderState.scan_phase, 'discovering');
  assert.equal(context.buildLoaderStatusLines(initialLoaderState)[0].title, 'Discovering music files');

  assert.ok(windowListeners.pageshow);
  windowListeners.pageshow();
  assert.deepEqual(calls.setLoopActive, [false]);
  assert.equal(context.state.player.loopActive, false);
  windowListeners.pageshow();
  assert.deepEqual(calls.setLoopActive, [false], 'pageshow is a no-op after loop edit mode is cleared');

  windowListeners.pagehide();
  windowListeners.pageshow({ persisted: true });
  windowListeners.beforeunload();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.persistPlayerStateForUnload, ['pagehide', 'beforeunload']);
  assert.equal(calls.resetPlayerUnloadPersistence, 1);
  assert.deepEqual(
    calls.stopStreamingPlayback,
    ['unload', 'unload'],
    'a BFCache restore re-arms streaming cleanup for the next real unload',
  );
  assert.deepEqual(
    unloadOrder,
    ['persist:pagehide', 'stop:unload', 'persist:beforeunload', 'stop:unload'],
    'each restored page lifecycle persists before its streaming cleanup',
  );
});

test('bootstrap init rebuilds startup hydration endpoint from resolved gallery preferences', () => {
  let fetchedEndpoint = null;
  const context = {
    window: {
      location: { href: 'http://localhost:5000/?artist=Broadcast' },
      addEventListener() {},
    },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
    },
    URL,
    state: {
      ui: {},
      view: {
        selected_artist: 'Broadcast',
        query: '',
      },
    },
    appBootstrap: {
      getBootstrap() {
        return {
          startupHydration: {
            required: true,
            endpoint: '/view-data?artist=Broadcast',
            followupEndpoint: '',
            tier: 'full',
          },
        };
      },
      releasePayloadViewState() {},
    },
    normalizeBootstrapRuntimeStatePayload(payload) {
      return {
        view: payload.initial_view,
        bootstrap: payload.bootstrap,
      };
    },
    resolveGalleryDisplayPreferenceViewState(view) {
      return {
        ...view,
        gallery_display_mode: 'covers',
        gallery_scale_percent: 135,
      };
    },
    applyViewPayload(view) {
      context.state.view = {
        ...context.state.view,
        ...view,
      };
    },
    buildApiUrl(view) {
      return `/view-data?artist=${encodeURIComponent(view.selected_artist)}&gallery_display=${view.gallery_display_mode}&gallery_scale_percent=${view.gallery_scale_percent}`;
    },
    suppressRefocusViewportInteraction() {},
    suppressRefocusViewportClick() {},
    noteViewportRefocusHoverIntent() {},
    noteViewportRefocusWheelIntent() {},
    shouldRunImmediateStartupHydration() {
      return true;
    },
    restorePlayerAppearance() {},
    startupMetrics: {
      beginInitialRefresh() {},
      markInitialRender() {},
    },
    renderView() {},
    updateStatusIndicator() {},
    renderLibraryLoader() {},
    scheduleBrowserTimeout() {
      return 0;
    },
    pollStatus() {},
    fetchAndRender(endpoint) {
      fetchedEndpoint = endpoint;
    },
    isEffectivelyEmptyView() {
      return false;
    },
    hideVersionContextMenu() {},
    hideStatusContextMenu() {},
    showVersionContextMenu() {},
    showStatusContextMenu() {},
    hideAlbumCardContextMenu() {},
    showAlbumCardContextMenu() {},
    getIndexedAlbum() {
      return null;
    },
    handleViewportRefocusVisibilityChange() {},
    persistPlayerState() {},
    flushListenSessionOnUnload() {},
    armViewportRefocusSuppression() {},
    initPlaybackOwnershipCoordinator() {},
    attachModalEvents() {},
    attachCoverLookupModalEvents() {},
    attachCoverLookupDeleteConfirmEvents() {},
    attachUtilityModalEvents() {},
    attachRepairConfirmEvents() {},
    attachPlayerEvents() {},
    showToast() {},
    updatePlayerUi() {},
    console,
  };

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });

  assert.equal(
    fetchedEndpoint,
    '/view-data?artist=Broadcast&gallery_display=covers&gallery_scale_percent=135',
  );
});

test('bootstrap init does not hydrate discovery center page from empty gallery fallback', () => {
  let fetchedEndpoint = null;
  const context = {
    window: {
      location: { href: 'http://localhost:5000/news?tab=history' },
      addEventListener() {},
    },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
    },
    URL,
    state: {
      ui: {},
      view: {
        query: '',
        selected_artist: '',
        shell_layout: {
          slots: {
            main_content: {
              content_kind: 'discovery_center_page',
            },
          },
        },
      },
    },
    appBootstrap: {
      getBootstrap() {
        return {
          partialView: false,
          startupHydration: {
            required: false,
            endpoint: '',
            followupEndpoint: '',
            tier: 'full',
          },
        };
      },
      releasePayloadViewState() {},
    },
    normalizeBootstrapRuntimeStatePayload(payload) {
      return {
        view: payload.initial_view,
        bootstrap: payload.bootstrap,
      };
    },
    resolveGalleryDisplayPreferenceViewState(view) {
      return view;
    },
    applyViewPayload(view) {
      context.state.view = {
        ...context.state.view,
        ...view,
      };
    },
    buildApiUrl() {
      return '/home-data';
    },
    suppressRefocusViewportInteraction() {},
    suppressRefocusViewportClick() {},
    noteViewportRefocusHoverIntent() {},
    noteViewportRefocusWheelIntent() {},
    shouldRunImmediateStartupHydration() {
      return true;
    },
    restorePlayerAppearance() {},
    startupMetrics: {
      beginInitialRefresh() {},
      markInitialRender() {},
    },
    renderView() {},
    updateStatusIndicator() {},
    renderLibraryLoader() {},
    scheduleBrowserTimeout() {
      return 0;
    },
    pollStatus() {},
    fetchAndRender(endpoint) {
      fetchedEndpoint = endpoint;
    },
    isEffectivelyEmptyView() {
      return true;
    },
    hideVersionContextMenu() {},
    hideStatusContextMenu() {},
    showVersionContextMenu() {},
    showStatusContextMenu() {},
    hideAlbumCardContextMenu() {},
    showAlbumCardContextMenu() {},
    getIndexedAlbum() {
      return null;
    },
    handleViewportRefocusVisibilityChange() {},
    persistPlayerState() {},
    flushListenSessionOnUnload() {},
    armViewportRefocusSuppression() {},
    initPlaybackOwnershipCoordinator() {},
    attachModalEvents() {},
    attachCoverLookupModalEvents() {},
    attachCoverLookupDeleteConfirmEvents() {},
    attachUtilityModalEvents() {},
    attachRepairConfirmEvents() {},
    attachPlayerEvents() {},
    showToast() {},
    updatePlayerUi() {},
    console,
  };

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });

  assert.equal(fetchedEndpoint, null);
});

test('bootstrap init preserves startup hydration tier while applying resolved gallery preferences', () => {
  let fetchedEndpoint = null;
  let fetchedOptions = null;
  const context = {
    window: {
      location: { href: 'http://localhost:5000/' },
      addEventListener() {},
    },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
    },
    URL,
    state: {
      ui: {},
      view: {
        selected_artist: '',
        query: '',
      },
    },
    appBootstrap: {
      getBootstrap() {
        return {
          startupHydration: {
            required: true,
            endpoint: '/view-data?payload_tier=sidebar',
            followupEndpoint: '/view-data',
            tier: 'sidebar',
          },
        };
      },
      releasePayloadViewState() {},
    },
    normalizeBootstrapRuntimeStatePayload(payload) {
      return {
        view: payload.initial_view,
        bootstrap: payload.bootstrap,
      };
    },
    resolveGalleryDisplayPreferenceViewState(view) {
      return {
        ...view,
        gallery_display_mode: 'covers',
        gallery_scale_percent: 135,
      };
    },
    applyViewPayload(view) {
      context.state.view = {
        ...context.state.view,
        ...view,
      };
    },
    buildApiUrl(view) {
      const params = new URLSearchParams();
      if (view.gallery_display_mode !== 'cards') {
        params.set('gallery_display', view.gallery_display_mode);
      }
      if (view.gallery_scale_percent !== 100) {
        params.set('gallery_scale_percent', String(view.gallery_scale_percent));
      }
      const qs = params.toString();
      return `/view-data${qs ? `?${qs}` : ''}`;
    },
    suppressRefocusViewportInteraction() {},
    suppressRefocusViewportClick() {},
    noteViewportRefocusHoverIntent() {},
    noteViewportRefocusWheelIntent() {},
    shouldRunImmediateStartupHydration() {
      return true;
    },
    restorePlayerAppearance() {},
    startupMetrics: {
      beginInitialRefresh() {},
      markInitialRender() {},
    },
    renderView() {},
    updateStatusIndicator() {},
    renderLibraryLoader() {},
    scheduleBrowserTimeout() {
      return 0;
    },
    pollStatus() {},
    fetchAndRender(endpoint, push, options) {
      fetchedEndpoint = endpoint;
      fetchedOptions = options;
    },
    isEffectivelyEmptyView() {
      return false;
    },
    hideVersionContextMenu() {},
    hideStatusContextMenu() {},
    showVersionContextMenu() {},
    showStatusContextMenu() {},
    hideAlbumCardContextMenu() {},
    showAlbumCardContextMenu() {},
    getIndexedAlbum() {
      return null;
    },
    handleViewportRefocusVisibilityChange() {},
    persistPlayerState() {},
    flushListenSessionOnUnload() {},
    armViewportRefocusSuppression() {},
    initPlaybackOwnershipCoordinator() {},
    attachModalEvents() {},
    attachCoverLookupModalEvents() {},
    attachCoverLookupDeleteConfirmEvents() {},
    attachUtilityModalEvents() {},
    attachRepairConfirmEvents() {},
    attachPlayerEvents() {},
    showToast() {},
    updatePlayerUi() {},
    console,
  };

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });

  assert.equal(
    fetchedEndpoint,
    '/view-data?payload_tier=sidebar&gallery_display=covers&gallery_scale_percent=135',
  );
  assert.equal(fetchedOptions.startupHydrationTier, 'sidebar');
  assert.equal(
    fetchedOptions.startupHydrationFollowupEndpoint,
    '/view-data?gallery_display=covers&gallery_scale_percent=135',
  );
});

test('bootstrap init restores a root albums follow-up hydration endpoint when the server leaves it blank', () => {
  let fetchedEndpoint = null;
  let fetchedOptions = null;
  const context = {
    window: {
      location: { href: 'http://localhost:5000/?gallery_display=covers&gallery_scale_percent=135' },
      addEventListener() {},
    },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
    },
    URL,
    state: {
      ui: {},
      view: {
        selected_artist: '',
        query: '',
      },
    },
    appBootstrap: {
      getBootstrap() {
        return {
          startupHydration: {
            required: true,
            endpoint: '/view-data?payload_tier=sidebar',
            followupEndpoint: '',
            tier: 'sidebar',
          },
        };
      },
      releasePayloadViewState() {},
    },
    normalizeBootstrapRuntimeStatePayload(payload) {
      return {
        view: payload.initial_view,
        bootstrap: payload.bootstrap,
      };
    },
    resolveGalleryDisplayPreferenceViewState(view) {
      return {
        ...view,
        gallery_display_mode: 'covers',
        gallery_scale_percent: 135,
      };
    },
    applyViewPayload(view) {
      context.state.view = {
        ...context.state.view,
        ...view,
      };
    },
    buildApiUrl(view) {
      const params = new URLSearchParams();
      if (view.gallery_display_mode !== 'cards') {
        params.set('gallery_display', view.gallery_display_mode);
      }
      if (view.gallery_scale_percent !== 100) {
        params.set('gallery_scale_percent', String(view.gallery_scale_percent));
      }
      const qs = params.toString();
      return `/view-data${qs ? `?${qs}` : ''}`;
    },
    suppressRefocusViewportInteraction() {},
    suppressRefocusViewportClick() {},
    noteViewportRefocusHoverIntent() {},
    noteViewportRefocusWheelIntent() {},
    shouldRunImmediateStartupHydration() {
      return true;
    },
    restorePlayerAppearance() {},
    startupMetrics: {
      beginInitialRefresh() {},
      markInitialRender() {},
    },
    renderView() {},
    updateStatusIndicator() {},
    renderLibraryLoader() {},
    scheduleBrowserTimeout() {
      return 0;
    },
    pollStatus() {},
    fetchAndRender(endpoint, push, options) {
      fetchedEndpoint = endpoint;
      fetchedOptions = options;
    },
    isEffectivelyEmptyView() {
      return false;
    },
    hideVersionContextMenu() {},
    hideStatusContextMenu() {},
    showVersionContextMenu() {},
    showStatusContextMenu() {},
    hideAlbumCardContextMenu() {},
    showAlbumCardContextMenu() {},
    getIndexedAlbum() {
      return null;
    },
    handleViewportRefocusVisibilityChange() {},
    persistPlayerState() {},
    flushListenSessionOnUnload() {},
    armViewportRefocusSuppression() {},
    initPlaybackOwnershipCoordinator() {},
    attachModalEvents() {},
    attachCoverLookupModalEvents() {},
    attachCoverLookupDeleteConfirmEvents() {},
    attachUtilityModalEvents() {},
    attachRepairConfirmEvents() {},
    attachPlayerEvents() {},
    showToast() {},
    updatePlayerUi() {},
    console,
  };

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });

  assert.equal(
    fetchedEndpoint,
    '/view-data?payload_tier=sidebar&gallery_display=covers&gallery_scale_percent=135',
  );
  assert.equal(fetchedOptions.startupHydrationTier, 'sidebar');
  assert.equal(
    fetchedOptions.startupHydrationFollowupEndpoint,
    '/view-data?gallery_display=covers&gallery_scale_percent=135',
  );
});

test('bootstrap init preserves the sidebar hydration request when an embedded startup sidebar patch is present', () => {
  const scheduledTimeouts = [];
  const appliedViews = [];
  let fetchedEndpoint = null;
  let fetchedOptions = null;
  const runtimeBootstrap = {
    startupPayloadTiers: {
      hydration: {
        embeddedViewPatch: {
          artists_sidebar: [{ artist: 'Stereolab', count: 2 }],
        },
      },
    },
    startupHydration: {
      required: true,
      endpoint: '/view-data?payload_tier=sidebar',
      followupEndpoint: '/view-data',
      tier: 'sidebar',
      embeddedViewPatch: {
        artists_sidebar: [
          { artist: 'Broadcast', count: 1 },
          { artist: 'Stereolab', count: 2 },
        ],
        artist_count: 2,
        payload_tier: 'sidebar',
      },
    },
  };
  const context = {
    window: {
      location: { href: 'http://localhost:5000/' },
      addEventListener() {},
    },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
    },
    URL,
    state: {
      busy: false,
      ui: {},
      view: {
        selected_artist: '',
        query: '',
      },
    },
    appBootstrap: {
      getBootstrap() {
        return runtimeBootstrap;
      },
      releasePayloadViewState() {},
    },
    normalizeBootstrapRuntimeStatePayload(payload) {
      return {
        view: payload.initial_view,
        bootstrap: payload.bootstrap,
      };
    },
    resolveGalleryDisplayPreferenceViewState(view) {
      return view;
    },
    applyViewPayload(view) {
      appliedViews.push(view);
      context.state.view = {
        ...context.state.view,
        ...view,
      };
    },
    suppressRefocusViewportInteraction() {},
    suppressRefocusViewportClick() {},
    noteViewportRefocusHoverIntent() {},
    noteViewportRefocusWheelIntent() {},
    shouldRunImmediateStartupHydration() {
      return true;
    },
    restorePlayerAppearance() {},
    startupMetrics: {
      beginInitialRefresh() {},
      markInitialRender() {},
    },
    renderView() {},
    updateStatusIndicator() {},
    renderLibraryLoader() {},
    scheduleBrowserTimeout(callback, delayMs) {
      scheduledTimeouts.push({ callback, delayMs });
      return delayMs;
    },
    pollStatus() {},
    fetchAndRender(endpoint, push, options) {
      fetchedEndpoint = endpoint;
      fetchedOptions = options;
    },
    isEffectivelyEmptyView() {
      return false;
    },
    hideVersionContextMenu() {},
    hideStatusContextMenu() {},
    showVersionContextMenu() {},
    showStatusContextMenu() {},
    hideAlbumCardContextMenu() {},
    showAlbumCardContextMenu() {},
    getIndexedAlbum() {
      return null;
    },
    handleViewportRefocusVisibilityChange() {},
    persistPlayerState() {},
    flushListenSessionOnUnload() {},
    armViewportRefocusSuppression() {},
    initPlaybackOwnershipCoordinator() {},
    attachModalEvents() {},
    attachCoverLookupModalEvents() {},
    attachCoverLookupDeleteConfirmEvents() {},
    attachUtilityModalEvents() {},
    attachRepairConfirmEvents() {},
    attachPlayerEvents() {},
    showToast() {},
    updatePlayerUi() {},
    console,
  };

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });

  assert.deepEqual(appliedViews, [
    {
      selected_artist: '',
      query: '',
    },
    {
      artists_sidebar: [
        { artist: 'Broadcast', count: 1 },
        { artist: 'Stereolab', count: 2 },
      ],
      artist_count: 2,
      payload_tier: 'sidebar',
    },
  ]);
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(scheduledTimeouts[0].delayMs, 500);
  assert.equal(runtimeBootstrap.startupHydration.embeddedViewPatch, null);
  assert.equal(runtimeBootstrap.startupPayloadTiers.hydration.embeddedViewPatch, null);
  assert.equal(fetchedEndpoint, '/view-data?payload_tier=sidebar');
  assert.deepEqual(JSON.parse(JSON.stringify(fetchedOptions)), {
    startupRefresh: true,
    preserveScroll: true,
    startupHydrationTier: 'sidebar',
    startupHydrationFollowupEndpoint: '/view-data',
  });
});

test('bootstrap init still queues the embedded sidebar-first hydration request while busy', () => {
  let fetchedEndpoint = null;
  let fetchedOptions = null;
  const context = {
    window: {
      location: { href: 'http://localhost:5000/' },
      addEventListener() {},
    },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
    },
    URL,
    state: {
      busy: true,
      ui: {},
      view: {
        selected_artist: '',
        query: '',
      },
    },
    appBootstrap: {
      getBootstrap() {
        return {
          startupHydration: {
            required: true,
            endpoint: '/view-data?payload_tier=sidebar',
            followupEndpoint: '/view-data',
            tier: 'sidebar',
            embeddedViewPatch: {
              artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
              artist_count: 1,
              payload_tier: 'sidebar',
            },
          },
        };
      },
      releasePayloadViewState() {},
    },
    normalizeBootstrapRuntimeStatePayload(payload) {
      return {
        view: payload.initial_view,
        bootstrap: payload.bootstrap,
      };
    },
    resolveGalleryDisplayPreferenceViewState(view) {
      return view;
    },
    applyViewPayload(view) {
      context.state.view = {
        ...context.state.view,
        ...view,
      };
    },
    suppressRefocusViewportInteraction() {},
    suppressRefocusViewportClick() {},
    noteViewportRefocusHoverIntent() {},
    noteViewportRefocusWheelIntent() {},
    shouldRunImmediateStartupHydration() {
      return true;
    },
    restorePlayerAppearance() {},
    startupMetrics: {
      beginInitialRefresh() {},
      markInitialRender() {},
    },
    renderView() {},
    updateStatusIndicator() {},
    renderLibraryLoader() {},
    scheduleBrowserTimeout() {
      return 0;
    },
    pollStatus() {},
    fetchAndRender(endpoint, push, options) {
      fetchedEndpoint = endpoint;
      fetchedOptions = options;
    },
    isEffectivelyEmptyView() {
      return false;
    },
    hideVersionContextMenu() {},
    hideStatusContextMenu() {},
    showVersionContextMenu() {},
    showStatusContextMenu() {},
    hideAlbumCardContextMenu() {},
    showAlbumCardContextMenu() {},
    getIndexedAlbum() {
      return null;
    },
    handleViewportRefocusVisibilityChange() {},
    persistPlayerState() {},
    flushListenSessionOnUnload() {},
    armViewportRefocusSuppression() {},
    initPlaybackOwnershipCoordinator() {},
    attachModalEvents() {},
    attachCoverLookupModalEvents() {},
    attachCoverLookupDeleteConfirmEvents() {},
    attachUtilityModalEvents() {},
    attachRepairConfirmEvents() {},
    attachPlayerEvents() {},
    showToast() {},
    updatePlayerUi() {},
    console,
  };

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });

  assert.equal(fetchedEndpoint, '/view-data?payload_tier=sidebar');
  assert.deepEqual(JSON.parse(JSON.stringify(fetchedOptions)), {
    startupRefresh: true,
    preserveScroll: true,
    startupHydrationTier: 'sidebar',
    startupHydrationFollowupEndpoint: '/view-data',
  });
});

test('bootstrap init completes a fully rendered startup exactly once after paint without hydration', () => {
  const scheduledAnimationFrames = [];
  const completedViews = [];
  let fetchedEndpoint = null;
  const context = {
    window: {
      location: { href: 'http://localhost:5000/?artist=Broadcast' },
      addEventListener() {},
    },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
    },
    URL,
    state: {
      ui: {},
      view: {
        selected_artist: 'Broadcast',
        query: '',
        artist_count: 3,
        album_count: 1,
        artists_sidebar: [
          { artist: 'Broadcast', count: 1 },
          { artist: 'Mono', count: 1 },
          { artist: 'Stereolab', count: 1 },
        ],
        artist_groups: [{
          artist: 'Broadcast',
          albums: [{ key: 'broadcast-tender-buttons' }],
        }],
      },
    },
    appBootstrap: {
      getBootstrap() {
        return {
          partialView: false,
          startupHydration: {
            required: false,
            endpoint: '/view-data?artist=Broadcast',
            followupEndpoint: '',
            tier: 'full',
          },
        };
      },
      releasePayloadViewState() {},
    },
    normalizeBootstrapRuntimeStatePayload(payload) {
      return {
        view: payload.initial_view,
        bootstrap: payload.bootstrap,
      };
    },
    resolveGalleryDisplayPreferenceViewState(view) {
      return view;
    },
    applyViewPayload(view) {
      context.state.view = {
        ...context.state.view,
        ...view,
      };
    },
    suppressRefocusViewportInteraction() {},
    suppressRefocusViewportClick() {},
    noteViewportRefocusHoverIntent() {},
    noteViewportRefocusWheelIntent() {},
    shouldRunImmediateStartupHydration() {
      return false;
    },
    restorePlayerAppearance() {},
    startupMetrics: {
      beginInitialRefresh() {
        assert.fail('a fully rendered startup must not begin hydration');
      },
      markInitialRender() {},
      completeInitialRefresh(view) {
        completedViews.push(view);
      },
    },
    renderView() {},
    updateStatusIndicator() {},
    renderLibraryLoader() {},
    scheduleBrowserTimeout() {
      return 0;
    },
    scheduleBrowserAnimationFrame(callback) {
      scheduledAnimationFrames.push(callback);
      return scheduledAnimationFrames.length;
    },
    pollStatus() {},
    fetchAndRender(endpoint) {
      fetchedEndpoint = endpoint;
    },
    isEffectivelyEmptyView(view) {
      return !Number(view?.album_count || 0);
    },
    hideVersionContextMenu() {},
    hideStatusContextMenu() {},
    showVersionContextMenu() {},
    showStatusContextMenu() {},
    hideAlbumCardContextMenu() {},
    showAlbumCardContextMenu() {},
    getIndexedAlbum() {
      return null;
    },
    handleViewportRefocusVisibilityChange() {},
    persistPlayerState() {},
    flushListenSessionOnUnload() {},
    armViewportRefocusSuppression() {},
    initPlaybackOwnershipCoordinator() {},
    attachModalEvents() {},
    attachCoverLookupModalEvents() {},
    attachCoverLookupDeleteConfirmEvents() {},
    attachUtilityModalEvents() {},
    attachRepairConfirmEvents() {},
    attachPlayerEvents() {},
    showToast() {},
    updatePlayerUi() {},
    console,
  };

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });

  assert.equal(fetchedEndpoint, null);
  assert.equal(completedViews.length, 0);
  assert.equal(scheduledAnimationFrames.length, 1);

  scheduledAnimationFrames.shift()();
  assert.equal(completedViews.length, 0);
  assert.equal(scheduledAnimationFrames.length, 1);

  scheduledAnimationFrames.shift()();
  assert.equal(completedViews.length, 1);
  assert.equal(completedViews[0], context.state.view);
  assert.equal(scheduledAnimationFrames.length, 0);
});

test('bootstrap init hydrates a populated partial startup while scan work continues', () => {
  const scheduledAnimationFrames = [];
  const completedViews = [];
  let initialRefreshBegins = 0;
  let fetchedEndpoint = null;
  const context = {
    window: {
      location: { href: 'http://localhost:5000/?artist=Broadcast' },
      addEventListener() {},
    },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
    },
    URL,
    state: {
      ui: {},
      view: {
        selected_artist: 'Broadcast',
        query: '',
        artist_count: 3,
        album_count: 1,
        initial_view_partial: true,
        artists_sidebar: [
          { artist: 'Broadcast', count: 1 },
          { artist: 'Mono', count: 1 },
          { artist: 'Stereolab', count: 1 },
        ],
        artist_groups: [{
          artist: 'Broadcast',
          albums: [{ key: 'broadcast-tender-buttons' }],
        }],
      },
    },
    appBootstrap: {
      getBootstrap() {
        return {
          partialView: true,
          scanInProgress: true,
          startupHydration: {
            required: true,
            endpoint: '/view-data?artist=Broadcast',
            followupEndpoint: '',
            tier: 'full',
          },
        };
      },
      releasePayloadViewState() {},
    },
    normalizeBootstrapRuntimeStatePayload(payload) {
      return {
        view: payload.initial_view,
        bootstrap: payload.bootstrap,
      };
    },
    resolveGalleryDisplayPreferenceViewState(view) {
      return view;
    },
    applyViewPayload(view) {
      context.state.view = {
        ...context.state.view,
        ...view,
      };
    },
    suppressRefocusViewportInteraction() {},
    suppressRefocusViewportClick() {},
    noteViewportRefocusHoverIntent() {},
    noteViewportRefocusWheelIntent() {},
    restorePlayerAppearance() {},
    startupMetrics: {
      beginInitialRefresh() {
        initialRefreshBegins += 1;
      },
      markInitialRender() {},
      completeInitialRefresh(view) {
        completedViews.push(view);
      },
    },
    renderView() {},
    updateStatusIndicator() {},
    renderLibraryLoader() {},
    scheduleBrowserTimeout() {
      return 0;
    },
    scheduleBrowserAnimationFrame(callback) {
      scheduledAnimationFrames.push(callback);
      return scheduledAnimationFrames.length;
    },
    pollStatus() {},
    fetchAndRender(endpoint) {
      fetchedEndpoint = endpoint;
    },
    hideVersionContextMenu() {},
    hideStatusContextMenu() {},
    showVersionContextMenu() {},
    showStatusContextMenu() {},
    hideAlbumCardContextMenu() {},
    showAlbumCardContextMenu() {},
    getIndexedAlbum() {
      return null;
    },
    handleViewportRefocusVisibilityChange() {},
    persistPlayerState() {},
    flushListenSessionOnUnload() {},
    armViewportRefocusSuppression() {},
    initPlaybackOwnershipCoordinator() {},
    attachModalEvents() {},
    attachCoverLookupModalEvents() {},
    attachCoverLookupDeleteConfirmEvents() {},
    attachUtilityModalEvents() {},
    attachRepairConfirmEvents() {},
    attachPlayerEvents() {},
    showToast() {},
    updatePlayerUi() {},
    console,
  };

  vm.createContext(context);
  vm.runInContext(viewValueHelperSource, context, { filename: viewValueHelperPath });
  vm.runInContext(helperSource, context, { filename: helperPath });

  assert.equal(initialRefreshBegins, 1);
  assert.equal(fetchedEndpoint, '/view-data?artist=Broadcast');
  assert.equal(completedViews.length, 0);
  assert.equal(scheduledAnimationFrames.length, 0);
});
