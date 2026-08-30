const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'gallery-refresh-and-status.js');
const helperSource = fs.readFileSync(helperPath, 'utf8');
const responseStateHelperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'response-state-helpers.js');
const responseStateHelperSource = fs.readFileSync(responseStateHelperPath, 'utf8');
const viewValueHelperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'view-value-helpers.js');
const viewValueHelperSource = fs.readFileSync(viewValueHelperPath, 'utf8');

function createContext() {
  const calls = {
    applyViewPayload: [],
    fetchRequests: [],
    renderView: [],
    renderLibraryLoader: [],
    renderLibraryLoaderOptions: [],
    renderSidebar: 0,
    renderArtistGroups: 0,
    renderRelated: 0,
    animationFrames: [],
    cancelledAnimationFrames: [],
    pushBrowserViewState: [],
    showToast: [],
    startupMarks: [],
    updateStatusIndicator: [],
    consoleErrors: [],
    clearedTimeouts: [],
    familyPrefetchBegins: [],
    familyPrefetchCancels: [],
    familyPrefetchPending: false,
    familyForegroundIdleChecks: [],
    speculativeDetailPrewarmCancels: 0,
    waveformPeakLoadSuspensions: [],
    waveformPeakLoadResumptions: [],
    prependUtilityLogHistoryEntries: [],
    syncUtilityLogHistoryRevision: [],
  };
  const pendingRequests = [];
  const searchInput = { value: '' };
  const lastError = {
    style: { display: 'none' },
    textContent: '',
  };
  const hiddenInputs = [];
  let transitionImage = null;
  const artistGroups = {
    innerHTML: '<section class="artist-section"></section>',
    querySelectorAll(selector) {
      return selector === 'img' && transitionImage ? [transitionImage] : [];
    },
  };
  const topSpacer = { style: { height: '120px' } };
  const bottomSpacer = { style: { height: '120px' } };
  const scanIndicator = {
    title: '',
    classList: {
      values: new Set(['is-done']),
      add(...names) {
        names.forEach((name) => this.values.add(name));
      },
      remove(...names) {
        names.forEach((name) => this.values.delete(name));
      },
      contains(name) {
        return this.values.has(name);
      },
    },
  };

  const context = {
    AbortController,
    HTMLFormElement: function HTMLFormElement() {},
    HTMLImageElement: function HTMLImageElement() {},
    Promise,
    console: {
      error(...args) {
        calls.consoleErrors.push(args);
      },
    },
    document: {
      getElementById(id) {
        if (id === 'search-input') return searchInput;
        if (id === 'search-form') return searchForm;
        if (id === 'scan-indicator') return scanIndicator;
        if (id === 'last-error') return lastError;
        if (id === 'artist-groups') return artistGroups;
        if (id === 'albums-spacer-top') return topSpacer;
        if (id === 'albums-spacer-bottom') return bottomSpacer;
        return null;
      },
      querySelectorAll() {
        return [];
      },
      createElement(tagName) {
        return {
          tagName: String(tagName || '').toUpperCase(),
          type: '',
          name: '',
          value: '',
          remove() {
            const index = hiddenInputs.indexOf(this);
            if (index >= 0) {
              hiddenInputs.splice(index, 1);
            }
          },
        };
      },
    },
    cssEscape(value) {
      return String(value || '');
    },
    escapeHtml(value) {
      return String(value ?? '');
    },
    getAlbumCardRenderKey(album) {
      return JSON.stringify([
        String(album?.key || ''),
        String(album?.name || ''),
        String(album?.album_artist || ''),
        String(album?.year || ''),
        Number(album?.album_preference?.rating || 0),
        Number(album?.track_count_preview || album?.tracks?.length || 0),
        String(album?.total_duration_display || ''),
        String(album?.cover_url || ''),
      ]);
    },
    state: {
      busy: false,
      view: {
        query: '',
        selected_artist: '',
      },
      utility: {
        loaded: false,
        logHistoryRevision: '',
        logHistoryTargetRevision: '',
        logHistorySyncPromise: null,
      },
      ui: {
        forceScanPageVisible: false,
        activeViewRequestController: null,
        activeViewRequestId: 0,
        activeViewRequestUrl: '',
        activeViewRequestPush: false,
        activeViewRequestStartupRefresh: false,
        activeViewRequestStartupHydrationTier: '',
        viewStateRevision: 0,
        pendingViewRequest: null,
        searchDraftQuery: '',
      },
    },
    cancelTrackModalAlbumDetailsPrewarms() {
      calls.speculativeDetailPrewarmCancels += 1;
    },
    suspendPlayerWaveformPeakLoadsForForegroundView() {
      const suspension = { id: calls.waveformPeakLoadSuspensions.length + 1 };
      calls.waveformPeakLoadSuspensions.push(suspension);
      return suspension;
    },
    resumePlayerWaveformPeakLoadsAfterForegroundView(suspension) {
      calls.waveformPeakLoadResumptions.push(suspension);
      return Promise.resolve(null);
    },
    hideGalleryOptionsMenu() {},
    buildApiUrl(value) {
      return typeof value === 'string' ? value : `/view-data?artist=${encodeURIComponent(String(value?.selected_artist || ''))}`;
    },
    parseBrowserUrlState(value) {
      return value;
    },
    fetch(url, options = {}) {
      calls.fetchRequests.push({ url, options });
      return new Promise((resolve, reject) => {
        const request = {
          url,
          options,
          resolveWith(payload) {
            resolve({
              ok: payload?.ok !== false,
              status: payload?.status || 200,
              async json() {
                return payload;
              },
            });
          },
          rejectWith(error) {
            reject(error);
          },
        };
        if (options.signal && typeof options.signal.addEventListener === 'function') {
          options.signal.addEventListener('abort', () => {
            const abortError = new Error('aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          }, { once: true });
        }
        pendingRequests.push(request);
      });
    },
    applyViewPayload(payload) {
      calls.applyViewPayload.push(payload);
      context.state.view = {
        ...context.state.view,
        ...payload,
      };
    },
    attachModalEvents() {},
    renderRelated() {
      calls.renderRelated += 1;
    },
    renderArtistGroups() {
      calls.renderArtistGroups += 1;
    },
    renderLibraryLoader(payload, options = {}) {
      calls.renderLibraryLoader.push(payload);
      calls.renderLibraryLoaderOptions.push(options);
    },
    renderView(options) {
      calls.renderView.push(options);
    },
    startupMetrics: {
      completed: 0,
      visibleCompleted: 0,
      visibleCompletions: [],
      markOnce(name, detail) {
        calls.startupMarks.push({ name, detail });
      },
      schedulePaintMark(name, readDetail) {
        calls.startupMarks.push({
          name,
          detail: typeof readDetail === 'function' ? readDetail() : {},
        });
      },
      completeVisibleInitialRefresh(view, detail) {
        this.visibleCompleted += 1;
        this.visibleCompletions.push({ view, detail });
      },
      completeInitialRefresh() {
        this.completed += 1;
      },
    },
    pushBrowserViewState(view) {
      calls.pushBrowserViewState.push(view);
    },
    clearPendingSidebarSelection() {},
    renderSidebar() {
      calls.renderSidebar += 1;
    },
    isEffectivelyEmptyView() {
      return false;
    },
    async loadProblematicFiles() {},
    async prependUtilityLogHistoryEntry(entry) {
      calls.prependUtilityLogHistoryEntries.push(entry);
    },
    async syncUtilityLogHistoryRevision(revision) {
      calls.syncUtilityLogHistoryRevision.push(revision);
      context.state.utility.logHistoryRevision = revision;
      return { revision };
    },
    showToast(message, level, durationMs) {
      calls.showToast.push({ message, level, durationMs });
    },
    updateStatusIndicator(payload) {
      calls.updateStatusIndicator.push(payload);
      context.state.status = {
        ...(context.state.status || {}),
        ...payload,
      };
    },
    startStatusIndicatorImmediately() {},
    scheduleBrowserTimeout() {},
    clearBrowserTimeout(timeoutId) {
      calls.clearedTimeouts.push(timeoutId);
      return true;
    },
    galleryCoverLoadScheduler: {
      beginFamilyPrefetchReconciliation() {
        const generation = calls.familyPrefetchBegins.length + 1;
        calls.familyPrefetchBegins.push(generation);
        calls.familyPrefetchPending = true;
        return generation;
      },
      cancelFamilyPrefetchReconciliation(generation) {
        calls.familyPrefetchCancels.push(generation);
        calls.familyPrefetchPending = false;
        return true;
      },
      async whenForegroundIdle() {
        calls.familyForegroundIdleChecks.push(calls.familyPrefetchPending);
        return { familyPrefetchPending: calls.familyPrefetchPending };
      },
    },
    scheduleBrowserAnimationFrame(callback) {
      calls.animationFrames.push(callback);
      return calls.animationFrames.length;
    },
    cancelBrowserAnimationFrame(frameId) {
      calls.cancelledAnimationFrames.push(frameId);
      return true;
    },
    buildApiUrlForTests(value) {
      return context.buildApiUrl(value);
    },
  };
  transitionImage = Object.create(context.HTMLImageElement.prototype);
  transitionImage.loading = 'lazy';
  transitionImage.attributes = new Map([['src', '/cover?path=old']]);
  transitionImage.removeAttribute = function removeAttribute(name) {
    this.attributes.delete(name);
  };
  const searchForm = Object.create(context.HTMLFormElement.prototype);
  searchForm.querySelectorAll = (selector) => {
    const match = /\[name="([^"]+)"\]/.exec(String(selector || ''));
    const name = match ? match[1] : '';
    return hiddenInputs.filter((input) => input.type === 'hidden' && input.name === name);
  };
  searchForm.appendChild = (input) => {
    hiddenInputs.push(input);
    return input;
  };

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  const runtimeRenderView = context.renderView;
  context.renderView = function renderViewStub(options) {
    calls.renderView.push(options);
  };
  return {
    context,
    calls,
    pendingRequests,
    runtimeRenderView,
    searchInput,
    lastError,
    hiddenInputs,
    artistGroups,
    transitionImage,
    topSpacer,
    bottomSpacer,
    scanIndicator,
  };
}

function createArtistFamilyOwnershipContext() {
  const fixture = createContext();
  fixture.context.state.gallery = {
    relatedFilterBaseArtist: '',
    relatedFilterBaseQuery: '',
    relatedFilterBasePrimaryGroups: [],
    relatedFilterBaseFamilyGroups: [],
    mainGalleryVisibleCategories: ['main_library', 'hoard', 'new_arrivals'],
    reusableRootBrowseView: null,
    reusableRootBrowseViewSignature: '',
    reusableSelectedArtistBrowseViews: {},
    reusableSelectedArtistBrowseViewOrder: [],
  };
  fixture.context.appBootstrap = {
    getInitialView() {
      return {};
    },
    getBootstrap() {
      return {};
    },
  };
  vm.runInContext(responseStateHelperSource, fixture.context, {
    filename: responseStateHelperPath,
  });
  return fixture;
}

function seedMorseArtistFamily(context) {
  const primaryGroup = {
    artist: 'Morse Portnoy George',
    albums: [{ key: 'cover-to-cover', name: 'Cover to Cover' }],
  };
  const nealGroup = {
    artist: 'Neal Morse',
    albums: [{ key: 'sola-scriptura', name: 'Sola Scriptura' }],
  };
  context.state.view = {
    ...context.state.view,
    selected_artist: 'Morse Portnoy George',
    query: '',
    related_artists: ['Neal Morse'],
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [primaryGroup],
    family_artist_groups: [nealGroup],
    artist_groups: [primaryGroup, nealGroup],
    artist_count: 2,
    album_count: 2,
  };
  context.state.gallery.relatedFilterBaseArtist = 'Morse Portnoy George';
  context.state.gallery.relatedFilterBaseQuery = '';
  context.state.gallery.relatedFilterBasePrimaryGroups = [primaryGroup];
  context.state.gallery.relatedFilterBaseFamilyGroups = [nealGroup];
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test('selected-family view fetch opens prefetch reconciliation before the replacement payload arrives', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.state.view.selected_artist = 'Neal Morse';

  const request = context.fetchAndRender('/view-data?artist=Neal%20Morse&q=', false);

  assert.equal(calls.speculativeDetailPrewarmCancels, 1);
  assert.deepEqual(calls.waveformPeakLoadSuspensions, [{ id: 1 }]);
  assert.deepEqual(calls.waveformPeakLoadResumptions, []);
  assert.deepEqual(calls.familyPrefetchBegins, [1]);
  assert.deepEqual(calls.familyPrefetchCancels, []);
  assert.equal(pendingRequests.length, 1);

  pendingRequests[0].resolveWith({ selected_artist: 'Neal Morse', query: '' });
  await request;

  await flushMicrotasks();
  assert.deepEqual(calls.waveformPeakLoadResumptions, [{ id: 1 }]);

  assert.deepEqual(
    calls.familyPrefetchCancels,
    [],
    'a rendered payload hands lifecycle completion to the production virtual-grid reconciliation',
  );
});

test('fetchAndRender releases only the search-intent prewarm suspension generation it captured', async () => {
  const { context, pendingRequests } = createContext();
  context.state.ui.albumDetailPrewarmSearchGeneration = 1;
  context.state.ui.albumDetailPrewarmSearchSuspended = true;

  const firstRequest = context.fetchAndRender('/view-data?surface=albums&q=Joseph', false);
  context.state.ui.albumDetailPrewarmSearchGeneration = 2;
  context.state.ui.albumDetailPrewarmSearchSuspended = true;
  pendingRequests[0].resolveWith({ query: 'Joseph', artist_groups: [] });
  await firstRequest;

  assert.equal(
    context.state.ui.albumDetailPrewarmSearchSuspended,
    true,
    'an older request must not release a newer search-intent suspension',
  );

  const secondRequest = context.fetchAndRender('/view-data?surface=albums&q=Joseph+Part+One', false);
  pendingRequests[1].resolveWith({ query: 'Joseph Part One', artist_groups: [] });
  await secondRequest;

  assert.equal(context.state.ui.albumDetailPrewarmSearchSuspended, false);
});

test('fetchAndRender claims the pending search-intent waveform suspension without nesting another', async () => {
  const { context, calls, pendingRequests } = createContext();
  const pendingSuspension = { id: 41 };
  context.state.ui.pendingSearchWaveformPeakLoadSuspension = pendingSuspension;

  const request = context.fetchAndRender('/view-data?surface=albums&q=Joseph', false);

  assert.deepEqual(calls.waveformPeakLoadSuspensions, []);
  assert.equal(context.state.ui.pendingSearchWaveformPeakLoadSuspension, null);
  pendingRequests[0].resolveWith({ query: 'Joseph', artist_groups: [] });
  await request;
  await flushMicrotasks();

  assert.deepEqual(calls.waveformPeakLoadResumptions, [pendingSuspension]);
});

test('failed selected-family view fetch releases only its pending prefetch reconciliation', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.state.view.selected_artist = 'Neal Morse';

  const request = context.fetchAndRender('/view-data?artist=Neal%20Morse&q=failed', false);
  pendingRequests[0].rejectWith(new Error('network failed'));

  await assert.rejects(request, /network failed/);
  assert.deepEqual(calls.familyPrefetchBegins, [1]);
  assert.deepEqual(calls.familyPrefetchCancels, [1]);
});

test('successful retained-sidebar clear releases prefetch reconciliation before foreground idle', async () => {
  const { context, calls, pendingRequests } = createContext();
  const primaryGroups = [{
    artist: 'Signal',
    albums: [{ key: 'signal::primary', name: 'Signal Primary' }],
  }];
  const familyGroups = [{
    artist: 'Signal Family',
    albums: [{ key: 'signal::family', name: 'Signal Family Album' }],
  }];
  const relatedArtists = ['Signal Family'];
  context.state.view = {
    ...context.state.view,
    query: 'Signal',
    selected_artist: 'Signal',
    primary_artist_groups: primaryGroups,
    family_artist_groups: familyGroups,
    artist_groups: [...primaryGroups, ...familyGroups],
    related_artists: relatedArtists,
  };
  const retainedSelectedView = {
    ...context.state.view,
    query: '',
  };

  const request = context.fetchAndRender(
    '/view-data?surface=albums&payload_tier=sidebar',
    false,
    {
      preserveScroll: true,
      retainMountedGalleryIfEquivalent: true,
      retainMountedSelectedViewState: retainedSelectedView,
      skipPendingViewTransition: true,
    },
  );
  assert.deepEqual(calls.familyPrefetchBegins, [1]);
  assert.equal(calls.familyPrefetchPending, true);

  pendingRequests[0].resolveWith({
    payload_tier: 'sidebar',
    artists_sidebar: [
      { artist: 'Signal', count: 1 },
      { artist: 'Signal Family', count: 1 },
    ],
    artist_count: 2,
  });
  assert.equal(await request, true);

  assert.deepEqual(
    calls.familyPrefetchCancels,
    [1],
    'A retained-sidebar render has no replacement grid to finish its prefetch reconciliation.',
  );
  assert.equal(calls.familyPrefetchPending, false);
  assert.deepEqual(
    await context.galleryCoverLoadScheduler.whenForegroundIdle(),
    { familyPrefetchPending: false },
  );
  assert.deepEqual(calls.familyForegroundIdleChecks, [false]);
  assert.equal(calls.renderRelated, 0);
  assert.equal(context.state.view.primary_artist_groups, primaryGroups);
  assert.equal(context.state.view.family_artist_groups, familyGroups);
  assert.equal(context.state.view.related_artists, relatedArtists);
});

test('failed retained-sidebar clear cleans request ownership without rerendering mounted family state', async () => {
  const { context, calls, pendingRequests } = createContext();
  const primaryGroups = [{ artist: 'Signal', albums: [{ key: 'signal::primary' }] }];
  const familyGroups = [{ artist: 'Signal Family', albums: [{ key: 'signal::family' }] }];
  const relatedArtists = ['Signal Family'];
  context.state.view = {
    ...context.state.view,
    query: 'Signal',
    selected_artist: 'Signal',
    primary_artist_groups: primaryGroups,
    family_artist_groups: familyGroups,
    artist_groups: [...primaryGroups, ...familyGroups],
    related_artists: relatedArtists,
  };

  const request = context.fetchAndRender(
    '/view-data?surface=albums&payload_tier=sidebar',
    false,
    {
      preserveScroll: true,
      retainMountedSelectedViewState: { ...context.state.view, query: '' },
      skipPendingViewTransition: true,
    },
  );
  pendingRequests[0].rejectWith(new Error('sidebar failed'));

  await assert.rejects(request, /sidebar failed/);
  assert.deepEqual(calls.familyPrefetchBegins, [1]);
  assert.deepEqual(calls.familyPrefetchCancels, [1]);
  assert.equal(calls.familyPrefetchPending, false);
  assert.equal(
    calls.renderRelated,
    0,
    'A retained clear failure must leave the mounted family nodes untouched.',
  );
  assert.equal(context.state.view.primary_artist_groups, primaryGroups);
  assert.equal(context.state.view.family_artist_groups, familyGroups);
  assert.equal(context.state.view.related_artists, relatedArtists);
  assert.equal(context.state.busy, false);
  assert.equal(context.state.ui.activeViewRequestController, null);
  assert.equal(context.state.ui.activeViewRequestUrl, '');
});

test('aborted retained-sidebar clear cleans request ownership without rerendering mounted family state', async () => {
  const { context, calls } = createContext();
  const primaryGroups = [{ artist: 'Signal', albums: [{ key: 'signal::primary' }] }];
  const familyGroups = [{ artist: 'Signal Family', albums: [{ key: 'signal::family' }] }];
  const relatedArtists = ['Signal Family'];
  context.state.view = {
    ...context.state.view,
    query: 'Signal',
    selected_artist: 'Signal',
    primary_artist_groups: primaryGroups,
    family_artist_groups: familyGroups,
    artist_groups: [...primaryGroups, ...familyGroups],
    related_artists: relatedArtists,
  };

  const request = context.fetchAndRender(
    '/view-data?surface=albums&payload_tier=sidebar',
    false,
    {
      preserveScroll: true,
      retainMountedSelectedViewState: { ...context.state.view, query: '' },
      skipPendingViewTransition: true,
    },
  );
  context.state.ui.activeViewRequestController.abort();

  assert.equal(await request, false);
  assert.deepEqual(calls.familyPrefetchBegins, [1]);
  assert.deepEqual(calls.familyPrefetchCancels, [1]);
  assert.equal(calls.familyPrefetchPending, false);
  assert.equal(
    calls.renderRelated,
    0,
    'An aborted retained clear must leave the mounted family nodes untouched.',
  );
  assert.equal(context.state.view.primary_artist_groups, primaryGroups);
  assert.equal(context.state.view.family_artist_groups, familyGroups);
  assert.equal(context.state.view.related_artists, relatedArtists);
  assert.equal(context.state.busy, false);
  assert.equal(context.state.ui.activeViewRequestController, null);
  assert.equal(context.state.ui.activeViewRequestUrl, '');
});

test('normal selected-artist requests retain existing family reconciliation and renderRelated behavior', async () => {
  const {
    context,
    runtimeRenderView,
    calls,
    pendingRequests,
  } = createContext();
  context.state.view = {
    ...context.state.view,
    selected_artist: 'Neal Morse',
    related_artists: ['The Neal Morse Band'],
  };
  context.renderView = runtimeRenderView;

  const request = context.fetchAndRender(
    '/view-data?surface=albums&artist=Neal%20Morse',
    true,
  );
  assert.deepEqual(calls.familyPrefetchBegins, [1]);
  assert.deepEqual(calls.familyPrefetchCancels, []);
  assert.equal(calls.renderRelated, 1);

  pendingRequests[0].resolveWith({
    query: '',
    selected_artist: 'Neal Morse',
    related_artists: ['The Neal Morse Band'],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
  });
  assert.equal(await request, true);

  assert.deepEqual(calls.familyPrefetchCancels, []);
  assert.equal(calls.renderRelated, 2);
});

test('fetchAndRender lets a newer tree request supersede startup hydration work', async () => {
  const { context, calls, pendingRequests } = createContext();

  const firstPromise = context.fetchAndRender('/view-data?artist=First', false, { startupRefresh: true });
  assert.equal(pendingRequests.length, 1);

  const secondPromise = context.fetchAndRender('/view-data?artist=Second', true, { startupRefresh: false });
  assert.equal(pendingRequests.length, 2);
  assert.equal(pendingRequests[0].options.signal.aborted, true);

  await flushMicrotasks();
  assert.equal(context.state.ui.pendingViewTransition, true, 'the aborted request must not clear the newer transition');
  assert.equal(context.state.ui.pendingViewTransitionRequestId, 2);

  pendingRequests[1].resolveWith({ selected_artist: 'Second' });
  await secondPromise;
  await flushMicrotasks();

  assert.deepEqual(calls.applyViewPayload, [{ selected_artist: 'Second' }]);
  assert.equal(context.state.view.selected_artist, 'Second');
  assert.equal(context.state.busy, false);
  assert.equal(context.state.ui.activeViewRequestController, null);
  assert.deepEqual(calls.pushBrowserViewState, [context.state.view]);

  await firstPromise;
});

test('fetchAndRender cannot overwrite a newer locally filtered artist-family view', async () => {
  const { context, calls, pendingRequests } = createContext();

  const olderRequest = context.fetchAndRender('/view-data?artist=Morse%20Portnoy%20George', false, {
    preserveScroll: true,
  });
  assert.equal(pendingRequests.length, 1);

  context.state.view = {
    ...context.state.view,
    selected_artist: 'Morse Portnoy George',
    related_filter_artists: ['Neal Morse'],
    primary_filter_active: false,
    artist_groups: [{ artist: 'Neal Morse' }],
  };
  context.state.ui.viewStateRevision += 1;
  const familyRendersBeforeStaleResponse = calls.renderRelated;

  pendingRequests[0].resolveWith({
    selected_artist: 'Morse Portnoy George',
    related_filter_artists: [],
    primary_filter_active: false,
    artist_groups: [{ artist: 'Morse Portnoy George' }],
  });

  assert.equal(await olderRequest, false);
  assert.deepEqual(calls.applyViewPayload, []);
  assert.deepEqual(context.state.view.related_filter_artists, ['Neal Morse']);
  assert.deepEqual(context.state.view.artist_groups, [{ artist: 'Neal Morse' }]);
  assert.equal(
    calls.renderRelated,
    familyRendersBeforeStaleResponse,
    'a response from an obsolete revision must not rebuild current family controls during cleanup',
  );
  assert.equal(context.state.busy, false);
});

test('fetchAndRender does not apply a deferred response after shouldApplyResponse becomes false', async () => {
  const { context, calls, pendingRequests } = createContext();
  const originalView = {
    ...context.state.view,
    selected_artist: 'Current Artist',
    artist_groups: [{
      artist: 'Current Artist',
      albums: [{ key: 'current-album', name: 'Current Album' }],
    }],
  };
  context.state.view = originalView;
  let responseStillApplies = true;

  const request = context.fetchAndRender(
    '/view-data?surface=albums&artist=Stale%20Artist',
    false,
    {
      preserveScroll: true,
      shouldApplyResponse: () => responseStillApplies,
    },
  );
  assert.equal(pendingRequests.length, 1);
  responseStillApplies = false;
  pendingRequests[0].resolveWith({
    selected_artist: 'Stale Artist',
    artist_groups: [{
      artist: 'Stale Artist',
      albums: [{ key: 'stale-album', name: 'Stale Album' }],
    }],
  });

  assert.equal(await request, false);
  assert.deepEqual(calls.applyViewPayload, []);
  assert.deepEqual(calls.renderView, []);
  assert.deepEqual(context.state.view, originalView);
});

test('fetchAndRender applies a deferred response while shouldApplyResponse remains true', async () => {
  const { context, calls, pendingRequests } = createContext();
  const canonicalPayload = {
    selected_artist: 'Canonical Artist',
    artist_groups: [{
      artist: 'Canonical Artist',
      albums: [{ key: 'canonical-album', name: 'Canonical Album' }],
    }],
  };

  const request = context.fetchAndRender(
    '/view-data?surface=albums&artist=Canonical%20Artist',
    false,
    {
      preserveScroll: true,
      shouldApplyResponse: () => true,
    },
  );
  assert.equal(pendingRequests.length, 1);
  pendingRequests[0].resolveWith(canonicalPayload);

  assert.equal(await request, true);
  assert.deepEqual(calls.applyViewPayload, [canonicalPayload]);
  assert.equal(calls.renderView.length, 1);
  assert.equal(context.state.view.selected_artist, 'Canonical Artist');
  assert.deepEqual(context.state.view.artist_groups, canonicalPayload.artist_groups);
});

test('fetchAndRender fails closed when shouldApplyResponse throws', async () => {
  const { context, calls, pendingRequests } = createContext();
  const originalView = {
    ...context.state.view,
    selected_artist: 'Current Artist',
    artist_groups: [{
      artist: 'Current Artist',
      albums: [{ key: 'current-album', name: 'Current Album' }],
    }],
  };
  context.state.view = originalView;

  const request = context.fetchAndRender(
    '/view-data?surface=albums&artist=Rejected%20Artist',
    false,
    {
      preserveScroll: true,
      shouldApplyResponse() {
        throw new Error('mutation ownership check failed');
      },
    },
  );
  assert.equal(pendingRequests.length, 1);
  pendingRequests[0].resolveWith({
    selected_artist: 'Rejected Artist',
    artist_groups: [{
      artist: 'Rejected Artist',
      albums: [{ key: 'rejected-album', name: 'Rejected Album' }],
    }],
  });

  assert.equal(await request, false);
  assert.deepEqual(calls.applyViewPayload, []);
  assert.deepEqual(calls.renderView, []);
  assert.deepEqual(context.state.view, originalView);
  assert.equal(context.state.busy, false);
  assert.equal(context.state.ui.activeViewRequestController, null);
  assert.equal(context.state.ui.activeViewRequestUrl, '');
});

test('a guard-rejected response releases the active slot and dispatches a queued eligible request', async () => {
  const { context, calls, pendingRequests } = createContext();
  let firstResponseStillApplies = true;
  const firstRequest = context.fetchAndRender(
    '/view-data?surface=albums&artist=First%20Artist',
    false,
    {
      preserveScroll: true,
      shouldApplyResponse: () => firstResponseStillApplies,
    },
  );
  const queuedRequest = context.fetchAndRender(
    '/view-data?surface=albums&artist=Second%20Artist',
    false,
    {
      preserveScroll: true,
      interruptCurrent: false,
    },
  );
  assert.equal(await queuedRequest, false);
  assert.equal(pendingRequests.length, 1);

  firstResponseStillApplies = false;
  pendingRequests[0].resolveWith({
    selected_artist: 'First Artist',
    artist_groups: [{
      artist: 'First Artist',
      albums: [{ key: 'first-album', name: 'First Album' }],
    }],
  });
  assert.equal(await firstRequest, false);
  await flushMicrotasks();

  assert.equal(pendingRequests.length, 2);
  assert.equal(
    pendingRequests[1].url,
    '/view-data?surface=albums&artist=Second%20Artist',
  );
  assert.deepEqual(calls.applyViewPayload, []);
  const secondPayload = {
    selected_artist: 'Second Artist',
    artist_groups: [{
      artist: 'Second Artist',
      albums: [{ key: 'second-album', name: 'Second Album' }],
    }],
  };
  pendingRequests[1].resolveWith(secondPayload);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(calls.applyViewPayload, [secondPayload]);
  assert.equal(calls.renderView.length, 1);
  assert.equal(context.state.view.selected_artist, 'Second Artist');
  assert.deepEqual(context.state.view.artist_groups, secondPayload.artist_groups);
  assert.equal(context.state.busy, false);
});

test('a real local artist-family filter drops active and queued responses from its previous revision', async () => {
  const { context, pendingRequests } = createArtistFamilyOwnershipContext();
  seedMorseArtistFamily(context);

  const activeRequest = context.fetchAndRender('/view-data?artist=Morse%20Portnoy%20George', false, {
    preserveScroll: true,
  });
  const queuedRequest = context.fetchAndRender(
    '/view-data?artist=Morse%20Portnoy%20George&family_display=chronological',
    false,
    { preserveScroll: true, interruptCurrent: false },
  );
  assert.equal(pendingRequests.length, 1);
  assert.equal(context.state.ui.pendingViewRequest.originatingViewStateRevision, 0);

  const filteredView = context.applyLocalRelatedFilterState(['Neal Morse']);
  assert.ok(filteredView);
  assert.equal(context.state.ui.viewStateRevision, 1);
  assert.deepEqual(
    Array.from(context.state.view.artist_groups, (group) => group.artist),
    ['Neal Morse'],
  );

  pendingRequests[0].resolveWith({
    selected_artist: 'Morse Portnoy George',
    related_filter_artists: [],
    primary_filter_active: false,
    artist_groups: [{ artist: 'Morse Portnoy George', albums: [] }],
  });

  assert.equal(await activeRequest, false);
  assert.equal(await queuedRequest, false);
  await flushMicrotasks();
  assert.equal(pendingRequests.length, 1, 'the pre-filter queued URL must not relaunch');
  assert.equal(context.state.ui.pendingViewRequest, null);
  assert.deepEqual(Array.from(context.state.view.related_filter_artists), ['Neal Morse']);
  assert.deepEqual(
    Array.from(context.state.view.artist_groups, (group) => group.artist),
    ['Neal Morse'],
  );
});

test('dropping a stale queued family request still dispatches pending scan reconciliation for the current filter', async () => {
  const { context, pendingRequests } = createArtistFamilyOwnershipContext();
  seedMorseArtistFamily(context);
  context.buildApiUrl = (view) => {
    const relatedArtist = Array.isArray(view?.related_filter_artists)
      ? String(view.related_filter_artists[0] || '')
      : '';
    return `/view-data?artist=Morse%20Portnoy%20George${relatedArtist ? `&related_artist=${encodeURIComponent(relatedArtist)}` : ''}`;
  };
  context.state.ui.pendingScanCompletionViewRefresh = true;

  const activeRequest = context.fetchAndRender('/view-data?artist=Morse%20Portnoy%20George', false, {
    preserveScroll: true,
  });
  context.fetchAndRender(
    '/view-data?artist=Morse%20Portnoy%20George&family_display=chronological',
    false,
    { preserveScroll: true, interruptCurrent: false },
  );
  context.applyLocalRelatedFilterState(['Neal Morse']);
  pendingRequests[0].resolveWith({
    selected_artist: 'Morse Portnoy George',
    related_filter_artists: [],
    artist_groups: [{ artist: 'Morse Portnoy George', albums: [] }],
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 2; attempt += 1) {
    await flushMicrotasks();
  }

  assert.equal(pendingRequests.length, 2);
  assert.equal(
    pendingRequests[1].url,
    '/view-data?artist=Morse%20Portnoy%20George&related_artist=Neal%20Morse',
  );
  pendingRequests[1].resolveWith({
    selected_artist: 'Morse Portnoy George',
    related_artists: ['Neal Morse'],
    related_filter_artists: ['Neal Morse'],
    primary_filter_active: false,
    primary_artist_groups: [],
    family_artist_groups: [{ artist: 'Neal Morse', albums: [{ key: 'sola-scriptura' }] }],
    artist_groups: [{ artist: 'Neal Morse', albums: [{ key: 'sola-scriptura' }] }],
    artist_count: 1,
    album_count: 1,
  });

  assert.equal(await activeRequest, false);
  assert.equal(context.state.ui.pendingViewRequest, null);
  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, false);
  assert.deepEqual(Array.from(context.state.view.related_filter_artists), ['Neal Morse']);
});

test('an obsolete failed view request cannot clear or report against a newer local family filter', async () => {
  const { context, calls, pendingRequests } = createArtistFamilyOwnershipContext();
  seedMorseArtistFamily(context);
  let clearedPendingSidebarSelections = 0;
  context.clearPendingSidebarSelection = () => {
    clearedPendingSidebarSelections += 1;
  };

  const activeRequest = context.fetchAndRender('/view-data?artist=Morse%20Portnoy%20George', false, {
    preserveScroll: true,
  });
  context.applyLocalRelatedFilterState(['Neal Morse']);
  const clearCountAfterLocalFilter = clearedPendingSidebarSelections;
  pendingRequests[0].rejectWith(new Error('obsolete request failed'));

  assert.equal(await activeRequest, false);
  assert.equal(clearedPendingSidebarSelections, clearCountAfterLocalFilter);
  assert.equal(calls.renderSidebar, 0);
  assert.equal(calls.consoleErrors.length, 0);
  assert.deepEqual(Array.from(context.state.view.related_filter_artists), ['Neal Morse']);
  assert.deepEqual(
    Array.from(context.state.view.artist_groups, (group) => group.artist),
    ['Neal Morse'],
  );
});

test('fetchAndRender restores the preserved gallery loader state after a terminal request failure', async () => {
  const { context, calls, pendingRequests } = createContext();
  const requestPromise = context.fetchAndRender('/view-data?artist=Failure', true, {});
  assert.equal(context.state.ui.pendingViewTransition, true);
  assert.equal(context.state.ui.pendingViewTransitionRequestId, 1);

  pendingRequests[0].rejectWith(new Error('network failed'));
  await assert.rejects(requestPromise, /network failed/);

  assert.equal(context.state.ui.pendingViewTransition, false);
  assert.equal(context.state.ui.pendingViewTransitionRequestId, 0);
  assert.equal(calls.renderLibraryLoader.at(-1).transition_in_progress, false);
});

test('renderView renders gallery work before scheduling the sidebar rebuild', () => {
  const { runtimeRenderView, calls } = createContext();

  runtimeRenderView({});

  assert.equal(
    calls.renderRelated,
    1,
    'A direct render paints the canonical family controls once.',
  );
  assert.equal(calls.renderArtistGroups, 1);
  assert.equal(calls.renderLibraryLoader.length, 1);
  assert.equal(calls.renderSidebar, 0);
  assert.equal(calls.animationFrames.length, 1);

  calls.animationFrames[0]();

  assert.equal(calls.renderSidebar, 1);
});

test('gallery render equivalence requires the same ordered artist groups and rendered album data', () => {
  const { context } = createContext();
  assert.equal(
    typeof context.hasEquivalentGalleryRenderTopology,
    'function',
    'The response path needs one pure topology predicate before it can preserve mounted gallery nodes safely.',
  );
  const retained = [{
    artist: 'Neal Morse',
    artist_display: 'Neal Morse',
    albums: [
      { key: 'neal-morse::sola-scriptura', name: 'Sola Scriptura', rating: 7 },
      { key: 'neal-morse::question-mark', name: '?', rating: 9 },
    ],
  }, {
    artist: 'The Neal Morse Band',
    albums: [
      { key: 'nmb::innocence-and-danger', name: 'Innocence & Danger' },
    ],
  }];
  const equivalentCanonical = [{
    artist: 'Neal Morse',
    artist_display: 'Neal Morse',
    albums: [
      { key: 'neal-morse::sola-scriptura', name: 'Sola Scriptura', rating: 7 },
      { key: 'neal-morse::question-mark', name: '?', rating: 9 },
    ],
  }, {
    artist: 'The Neal Morse Band',
    albums: [
      { key: 'nmb::innocence-and-danger', name: 'Innocence & Danger' },
    ],
  }];

  assert.equal(context.hasEquivalentGalleryRenderTopology(retained, equivalentCanonical), true);
  assert.equal(context.hasEquivalentGalleryRenderTopology(retained, [{
    ...equivalentCanonical[0],
    membership_source: 'postgres',
    albums: [
      {
        ...equivalentCanonical[0].albums[0],
        release_date: '2007-05-15',
        internal_revision: 2,
      },
      equivalentCanonical[0].albums[1],
    ],
  }, equivalentCanonical[1]]), true, 'Non-rendered canonical metadata must not rebuild mounted gallery nodes.');
  assert.equal(context.hasEquivalentGalleryRenderTopology(retained, [{
    ...equivalentCanonical[0],
    albums: [
      { ...equivalentCanonical[0].albums[0], name: 'Sola Scriptura (Remastered)' },
      equivalentCanonical[0].albums[1],
    ],
  }, equivalentCanonical[1]]), false, 'Changed album titles must rerender the mounted card.');
  assert.equal(context.hasEquivalentGalleryRenderTopology(retained, [{
    ...equivalentCanonical[0],
    albums: [
      { ...equivalentCanonical[0].albums[0], cover_url: '/cover?path=updated' },
      equivalentCanonical[0].albums[1],
    ],
  }, equivalentCanonical[1]]), false, 'Changed cover state must rerender the mounted card.');
  assert.equal(context.hasEquivalentGalleryRenderTopology(retained, [{
    ...equivalentCanonical[0],
    albums: [
      { ...equivalentCanonical[0].albums[0], album_preference: { rating: 8 } },
      equivalentCanonical[0].albums[1],
    ],
  }, equivalentCanonical[1]]), false, 'Changed rating data must rerender the mounted card.');
  assert.equal(context.hasEquivalentGalleryRenderTopology(retained, [
    equivalentCanonical[1],
    equivalentCanonical[0],
  ]), false, 'Artist-group order is render topology.');
  assert.equal(context.hasEquivalentGalleryRenderTopology(retained, [{
    ...equivalentCanonical[0],
    artist: 'Morse Portnoy George',
  }, equivalentCanonical[1]]), false, 'Artist identity is render topology.');
  assert.equal(context.hasEquivalentGalleryRenderTopology(retained, [{
    ...equivalentCanonical[0],
    albums: [...equivalentCanonical[0].albums].reverse(),
  }, equivalentCanonical[1]]), false, 'Album order is render topology.');
  assert.equal(context.hasEquivalentGalleryRenderTopology(retained, [{
    ...equivalentCanonical[0],
    albums: [
      { ...equivalentCanonical[0].albums[0], key: 'neal-morse::lifeline' },
      equivalentCanonical[0].albums[1],
    ],
  }, equivalentCanonical[1]]), false, 'Album identity is render topology.');
  assert.equal(context.hasEquivalentGalleryRenderTopology(retained, [{
    ...equivalentCanonical[0],
    albums: [
      ...equivalentCanonical[0].albums,
      equivalentCanonical[1].albums[0],
    ],
  }]), false, 'Moving an album between groups changes render topology.');
});

test('fetchAndRender preserves mounted gallery nodes when canonical save data changes only non-rendered metadata', async () => {
  const {
    context,
    runtimeRenderView,
    calls,
    pendingRequests,
  } = createContext();
  const retainedGroups = [{
    artist: 'Neal Morse',
    artist_display: 'Neal Morse',
    membership_source: 'optimistic',
    albums: [{
      key: 'neal-morse::sola-scriptura',
      name: 'Sola Scriptura',
      album_artist: 'Neal Morse',
      year: 2007,
      release_date: '2007',
      internal_revision: 1,
      track_count_preview: 12,
    }],
  }];
  context.state.view = {
    ...context.state.view,
    selected_artist: 'Neal Morse',
    primary_artist_groups: retainedGroups,
    family_artist_groups: [],
    artist_groups: retainedGroups,
    album_count: 1,
  };
  context.renderView = runtimeRenderView;

  const requestPromise = context.fetchAndRender(
    '/view-data?surface=albums&artist=Neal%20Morse',
    false,
    {
      preserveScroll: true,
      retainMountedGalleryIfEquivalent: true,
    },
  );
  pendingRequests[0].resolveWith({
    selected_artist: 'Neal Morse',
    primary_artist_groups: [{
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      membership_source: 'postgres',
      albums: [{
        ...retainedGroups[0].albums[0],
        release_date: '2007-05-15',
        internal_revision: 2,
      }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      membership_source: 'postgres',
      albums: [{
        ...retainedGroups[0].albums[0],
        release_date: '2007-05-15',
        internal_revision: 2,
      }],
    }],
    album_count: 1,
  });
  await requestPromise;

  assert.equal(context.state.view.artist_groups[0].albums[0].internal_revision, 2);
  assert.equal(calls.renderArtistGroups, 0);
});

test('fetchAndRender keeps an open gallery options menu through a background reconciliation', async () => {
  const { context, pendingRequests } = createContext();
  let hideCount = 0;
  let menuRenderCount = 0;
  context.state.gallery = { menuOpen: true };
  context.hideGalleryOptionsMenu = () => {
    hideCount += 1;
    context.state.gallery.menuOpen = false;
  };
  context.renderGalleryOptionsMenu = () => {
    menuRenderCount += 1;
  };

  const requestPromise = context.fetchAndRender(
    '/view-data?surface=albums&artist=Neal%20Morse',
    false,
    { preserveGalleryOptionsMenu: true },
  );
  pendingRequests[0].resolveWith({
    selected_artist: 'Neal Morse',
    artist_groups: [],
    album_count: 0,
  });

  await requestPromise;

  assert.equal(hideCount, 0);
  assert.equal(context.state.gallery.menuOpen, true);
  assert.equal(menuRenderCount, 1);
});

test('fetchAndRender rerenders mounted gallery nodes when canonical save data changes a card render key', async () => {
  const {
    context,
    runtimeRenderView,
    calls,
    pendingRequests,
  } = createContext();
  const retainedGroups = [{
    artist: 'Neal Morse',
    albums: [{
      key: 'neal-morse::sola-scriptura',
      name: 'Sola Scriptura',
      album_artist: 'Neal Morse',
      year: 2007,
      track_count_preview: 12,
    }],
  }];
  context.state.view = {
    ...context.state.view,
    selected_artist: 'Neal Morse',
    primary_artist_groups: retainedGroups,
    family_artist_groups: [],
    artist_groups: retainedGroups,
    album_count: 1,
  };
  context.renderView = runtimeRenderView;

  const requestPromise = context.fetchAndRender(
    '/view-data?surface=albums&artist=Neal%20Morse',
    false,
    {
      preserveScroll: true,
      retainMountedGalleryIfEquivalent: true,
    },
  );
  const renamedGroups = [{
    artist: 'Neal Morse',
    albums: [{
      ...retainedGroups[0].albums[0],
      name: 'Sola Scriptura (Remastered)',
    }],
  }];
  pendingRequests[0].resolveWith({
    selected_artist: 'Neal Morse',
    primary_artist_groups: renamedGroups,
    family_artist_groups: [],
    artist_groups: renamedGroups,
    album_count: 1,
  });
  await requestPromise;

  assert.equal(calls.renderArtistGroups, 1);
});

test('fetchAndRender applies equivalent committed-search state without rebuilding mounted selected-gallery nodes', async () => {
  const {
    context,
    runtimeRenderView,
    calls,
    pendingRequests,
  } = createContext();
  const retainedGroups = [{
    artist: 'Neal Morse',
    albums: [
      { key: 'neal-morse::sola-scriptura', name: 'Sola Scriptura', rating: 7 },
      { key: 'neal-morse::question-mark', name: '?', rating: 9 },
    ],
  }];
  context.state.view = {
    ...context.state.view,
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    related_artists: ['The Neal Morse Band'],
    primary_artist_groups: retainedGroups,
    family_artist_groups: [],
    artist_groups: retainedGroups,
    artists_sidebar: [{ artist: 'Neal Morse', count: 2 }],
    album_count: 2,
    artist_count: 1,
  };
  context.renderView = runtimeRenderView;

  const requestPromise = context.fetchAndRender(
    '/view-data?surface=albums&q=Neal%20Morse',
    true,
    { preserveScroll: true },
  );
  pendingRequests[0].resolveWith({
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    related_artists: ['The Neal Morse Band', 'Transatlantic'],
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [
        { key: 'neal-morse::sola-scriptura', name: 'Sola Scriptura', rating: 7 },
        { key: 'neal-morse::question-mark', name: '?', rating: 9 },
      ],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [
        { key: 'neal-morse::sola-scriptura', name: 'Sola Scriptura', rating: 7 },
        { key: 'neal-morse::question-mark', name: '?', rating: 9 },
      ],
    }],
    artists_sidebar: [
      { artist: 'Neal Morse', count: 2 },
      { artist: 'The Neal Morse Band', count: 1 },
    ],
    album_count: 2,
    artist_count: 2,
  });
  await requestPromise;
  await flushMicrotasks();

  assert.equal(context.state.view.artist_count, 2);
  assert.equal(context.state.view.artist_groups[0].albums[0].rating, 7);
  assert.deepEqual(
    Array.from(context.state.view.related_artists),
    ['The Neal Morse Band', 'Transatlantic'],
  );
  assert.equal(
    calls.renderRelated,
    2,
    'A changed response still hides the prior family controls before rendering the new view.',
  );
  assert.equal(
    calls.renderArtistGroups,
    0,
    'Equivalent canonical state must preserve the already-decoded mounted gallery nodes.',
  );
  assert.equal(calls.renderLibraryLoader.length, 1);
  assert.equal(calls.animationFrames.length, 1);
  calls.animationFrames[0]();
  assert.equal(calls.renderSidebar, 1);
});

test('q-empty retained-artist reconciliation preserves mounted nodes only for equivalent canonical groups', async () => {
  const retainedGroups = [{
    artist: 'Neal Morse',
    albums: [{ key: 'neal-morse::sola-scriptura', name: 'Sola Scriptura', rating: 7 }],
  }];
  const equivalent = createContext();
  equivalent.context.state.view = {
    ...equivalent.context.state.view,
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    search_context: {
      selected_artist: 'Neal Morse',
      selected_artist_source: 'auto_top_match',
    },
    related_filter_artists: ['The Neal Morse Band'],
    primary_filter_active: true,
    search_filters: {
      genre: ['Progressive Rock'],
      mood: [],
      style: [],
      duration: {
        min_seconds: 300,
        max_seconds: null,
      },
    },
    primary_artist_groups: retainedGroups,
    family_artist_groups: [],
    artist_groups: retainedGroups,
  };
  equivalent.context.renderView = equivalent.runtimeRenderView;
  const equivalentRequest = equivalent.context.fetchAndRender(
    '/view-data?surface=albums&payload_tier=sidebar',
    true,
    {
      preserveScroll: true,
      retainMountedGalleryIfEquivalent: true,
      retainMountedSelectedViewState: {
        ...equivalent.context.state.view,
        query: '',
        related_filter_artists: [],
        primary_filter_active: false,
        search_context: null,
        search_filters: {
          genre: [],
          mood: [],
          style: [],
          duration: {
            min_seconds: null,
            max_seconds: null,
          },
        },
      },
      skipPendingViewTransition: true,
    },
  );
  equivalent.pendingRequests[0].resolveWith({
    payload_tier: 'sidebar',
    query: '',
    selected_artist: '',
    artists_sidebar: [
      { artist: 'Neal Morse', count: 1 },
      { artist: 'The Neal Morse Band', count: 1 },
    ],
    primary_artist_groups: [{
      artist: 'Root Preview',
      albums: [{ key: 'root-preview::different', name: 'Different root preview' }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Root Preview',
      albums: [{ key: 'root-preview::different', name: 'Different root preview' }],
    }],
  });
  await equivalentRequest;
  assert.equal(equivalent.context.state.view.query, '');
  assert.equal(equivalent.context.state.view.selected_artist, 'Neal Morse');
  assert.equal(equivalent.context.state.view.search_context, null);
  assert.deepEqual(
    Array.from(equivalent.context.state.view.related_filter_artists),
    [],
  );
  assert.equal(equivalent.context.state.view.primary_filter_active, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(equivalent.context.state.view.search_filters)),
    {
      genre: [],
      mood: [],
      style: [],
      duration: {
        min_seconds: null,
        max_seconds: null,
      },
    },
  );
  assert.equal(equivalent.context.state.view.artist_groups, retainedGroups);
  assert.equal(equivalent.context.state.view.artists_sidebar.length, 2);
  assert.equal(
    equivalent.calls.renderArtistGroups,
    0,
    'A root-sidebar reconciliation must keep the selected artist gallery nodes mounted.',
  );

  const changed = createContext();
  changed.context.state.view = {
    ...changed.context.state.view,
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    primary_artist_groups: retainedGroups,
    family_artist_groups: [],
    artist_groups: retainedGroups,
  };
  changed.context.renderView = changed.runtimeRenderView;
  const changedRequest = changed.context.fetchAndRender(
    '/view-data?surface=albums&artist=Neal%20Morse',
    true,
    {
      preserveScroll: true,
      retainMountedGalleryIfEquivalent: true,
      skipPendingViewTransition: true,
    },
  );
  changed.pendingRequests[0].resolveWith({
    query: '',
    selected_artist: 'Neal Morse',
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse::sola-scriptura', name: 'Sola Scriptura (Remastered)', rating: 7 }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse::sola-scriptura', name: 'Sola Scriptura (Remastered)', rating: 7 }],
    }],
  });
  await changedRequest;
  assert.equal(
    changed.calls.renderArtistGroups,
    1,
    'A changed q-empty response must reconcile the mounted gallery normally.',
  );
});

test('active view requests hide family controls immediately and restore them after success or failure', async () => {
  const successful = createContext();
  successful.context.state.view = {
    ...successful.context.state.view,
    selected_artist: 'Neal Morse',
    related_artists: ['The Neal Morse Band'],
  };
  successful.context.renderView = successful.runtimeRenderView;
  const successfulRequest = successful.context.fetchAndRender(
    '/view-data?surface=albums&artist=Neal%20Morse',
    true,
  );
  assert.equal(
    successful.calls.renderRelated,
    1,
    'The mounted family controls must be hidden at the active-request boundary.',
  );
  successful.pendingRequests[0].resolveWith({
    query: '',
    selected_artist: 'Neal Morse',
    related_artists: ['The Neal Morse Band'],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
  });
  await successfulRequest;
  assert.equal(successful.calls.renderRelated, 2);

  const failed = createContext();
  failed.context.state.view = {
    ...failed.context.state.view,
    selected_artist: 'Neal Morse',
    related_artists: ['The Neal Morse Band'],
  };
  const failedRequest = failed.context.fetchAndRender(
    '/view-data?surface=albums&artist=Neal%20Morse',
    true,
  );
  assert.equal(
    failed.calls.renderRelated,
    1,
    'The mounted family controls must be hidden before a failing request settles.',
  );
  failed.pendingRequests[0].rejectWith(new Error('network failed'));
  await assert.rejects(failedRequest, /network failed/);
  assert.equal(
    failed.calls.renderRelated,
    2,
    'A terminal failure must restore the current family controls.',
  );
});

test('fetchAndRender rerenders same-key cards when canonical title and cover data change', async () => {
  const {
    context,
    runtimeRenderView,
    calls,
    pendingRequests,
  } = createContext();
  context.state.view = {
    ...context.state.view,
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{
        key: 'neal-morse::sola-scriptura',
        name: 'Sola Scriptura',
        cover_url: '/cover?path=old',
      }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{
        key: 'neal-morse::sola-scriptura',
        name: 'Sola Scriptura',
        cover_url: '/cover?path=old',
      }],
    }],
    album_count: 1,
  };
  context.renderView = runtimeRenderView;

  const requestPromise = context.fetchAndRender(
    '/view-data?surface=albums&q=Neal%20Morse',
    true,
    { preserveScroll: true },
  );
  pendingRequests[0].resolveWith({
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{
        key: 'neal-morse::sola-scriptura',
        name: 'Sola Scriptura (Remastered)',
        cover_url: '/cover?path=new',
      }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{
        key: 'neal-morse::sola-scriptura',
        name: 'Sola Scriptura (Remastered)',
        cover_url: '/cover?path=new',
      }],
    }],
    album_count: 1,
  });
  await requestPromise;
  await flushMicrotasks();

  assert.equal(context.state.view.artist_groups[0].albums[0].name, 'Sola Scriptura (Remastered)');
  assert.equal(context.state.view.artist_groups[0].albums[0].cover_url, '/cover?path=new');
  assert.equal(calls.renderArtistGroups, 1);
});

test('fetchAndRender fully renders a non-equivalent selected-gallery response', async () => {
  const {
    context,
    runtimeRenderView,
    calls,
    pendingRequests,
  } = createContext();
  context.state.view = {
    ...context.state.view,
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse::sola-scriptura' }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse::sola-scriptura' }],
    }],
    album_count: 1,
  };
  context.renderView = runtimeRenderView;

  const requestPromise = context.fetchAndRender(
    '/view-data?surface=albums&q=Neal%20Morse',
    true,
    { preserveScroll: true },
  );
  pendingRequests[0].resolveWith({
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse::question-mark' }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse::question-mark' }],
    }],
    album_count: 1,
  });
  await requestPromise;
  await flushMicrotasks();

  assert.equal(
    calls.renderRelated,
    2,
    'The request hides the mounted family controls before rendering the canonical family.',
  );
  assert.equal(calls.renderArtistGroups, 1);
  assert.equal(calls.renderLibraryLoader.length, 1);
  assert.equal(calls.animationFrames.length, 1);
});

test('fetchAndRender preserves decoded gallery nodes while showing a pending transition loader for artist navigation', async () => {
  const {
    context,
    calls,
    pendingRequests,
    artistGroups,
    transitionImage,
    topSpacer,
    bottomSpacer,
  } = createContext();

  const requestPromise = context.fetchAndRender('/view-data?artist=%D0%91%D0%98-2', true, {});

  assert.equal(context.state.ui.pendingViewTransition, true);
  assert.equal(artistGroups.innerHTML, '<section class="artist-section"></section>');
  assert.equal(transitionImage.attributes.get('src'), '/cover?path=old');
  assert.equal(topSpacer.style.height, '120px');
  assert.equal(bottomSpacer.style.height, '120px');
  assert.equal(calls.renderLibraryLoader.length, 1);
  assert.equal(calls.renderLibraryLoader[0].transition_in_progress, true);

  pendingRequests[0].resolveWith({ selected_artist: 'БИ-2' });
  await requestPromise;
  await flushMicrotasks();

  assert.equal(context.state.ui.pendingViewTransition, false);
  assert.equal(context.state.view.selected_artist, 'БИ-2');
});

test('fetchAndRender keeps the current gallery visible when a request skips the pending transition blanking step', async () => {
  const {
    context,
    calls,
    pendingRequests,
    artistGroups,
    transitionImage,
    topSpacer,
    bottomSpacer,
  } = createContext();

  const requestPromise = context.fetchAndRender('/view-data?artist=%D0%91%D0%98-2', false, {
    preserveScroll: true,
    skipPendingViewTransition: true,
  });

  assert.equal(context.state.ui.pendingViewTransition, undefined);
  assert.equal(artistGroups.innerHTML, '<section class="artist-section"></section>');
  assert.equal(transitionImage.attributes.get('src'), '/cover?path=old');
  assert.equal(topSpacer.style.height, '120px');
  assert.equal(bottomSpacer.style.height, '120px');
  assert.equal(calls.renderLibraryLoader.length, 0);

  pendingRequests[0].resolveWith({ selected_artist: 'Р‘Р-2' });
  await requestPromise;
  await flushMicrotasks();

  assert.equal(context.state.view.selected_artist, 'Р‘Р-2');
});

test('fetchAndRender ignores an identical in-flight request instead of issuing a duplicate fetch', async () => {
  const { context, calls, pendingRequests } = createContext();

  const firstPromise = context.fetchAndRender('/view-data?surface=albums&q=3+Mice', false, {});
  assert.equal(pendingRequests.length, 1);
  assert.equal(context.state.ui.activeViewRequestUrl, '/view-data?surface=albums&q=3+Mice');

  const duplicatePromise = context.fetchAndRender('/view-data?surface=albums&q=3+Mice', true, {});
  assert.equal(pendingRequests.length, 1);
  assert.equal(context.state.ui.activeViewRequestPush, true);

  pendingRequests[0].resolveWith({ query: '3 Mice', artist_groups: [{ artist: '3 Mice' }] });
  await firstPromise;
  await duplicatePromise;
  await flushMicrotasks();

  assert.equal(calls.fetchRequests.length, 1);
  assert.deepEqual(calls.applyViewPayload, [{ query: '3 Mice', artist_groups: [{ artist: '3 Mice' }] }]);
  assert.equal(calls.pushBrowserViewState.length, 1);
  assert.equal(context.state.ui.activeViewRequestUrl, '');
  assert.equal(context.state.ui.activeViewRequestPush, false);
});

test('fetchAndRender schedules a full startup followup after sidebar-only hydration', async () => {
  const { context, calls, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.isEffectivelyEmptyView = () => true;

  const sidebarPromise = context.fetchAndRender('/view-data?payload_tier=sidebar', false, {
    startupRefresh: true,
    startupHydrationTier: 'sidebar',
    startupHydrationFollowupEndpoint: '/view-data',
  });
  assert.equal(pendingRequests.length, 1);
  pendingRequests[0].resolveWith({
    artists_sidebar: [{ artist: 'Broadcast', count: 3 }],
    payload_tier: 'sidebar',
  });
  await sidebarPromise;
  await flushMicrotasks();

  assert.equal(context.startupMetrics.completed, 0);
  assert.equal(pendingRequests.length, 1);
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(scheduledTimeouts[0].delayMs, 350);
  scheduledTimeouts[0].callback();
  await flushMicrotasks();
  assert.equal(pendingRequests.length, 2);
  assert.equal(pendingRequests[1].url, '/view-data');
  pendingRequests[1].resolveWith({ artist_groups: [{ artist: 'Broadcast' }], album_count: 1 });
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(context.startupMetrics.completed, 1);
  const markNames = calls.startupMarks.map((mark) => mark.name);
  assert.ok(markNames.includes('startup_followup_sidebar_payload_received'));
  assert.ok(markNames.includes('startup_followup_full_payload_received'));
  assert.ok(markNames.includes('startup_followup_sidebar_render_complete'));
  assert.ok(markNames.includes('startup_followup_full_render_complete'));
  assert.deepEqual(calls.applyViewPayload, [
    {
      artists_sidebar: [{ artist: 'Broadcast', count: 3 }],
      payload_tier: 'sidebar',
    },
    {
      artist_groups: [{ artist: 'Broadcast' }],
      album_count: 1,
    },
  ]);
});

test('fetchAndRender still schedules the full startup followup when sidebar hydration leaves a non-empty root view', async () => {
  const { context, calls, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.state.view = {
    ...context.state.view,
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'tender-buttons' }] }],
    artist_count: 1,
    album_count: 1,
  };
  context.state.awaitingInitialDataRefresh = true;

  const sidebarPromise = context.fetchAndRender('/view-data?payload_tier=sidebar', false, {
    startupRefresh: true,
    startupHydrationTier: 'sidebar',
    startupHydrationFollowupEndpoint: '/view-data',
  });
  assert.equal(pendingRequests.length, 1);
  pendingRequests[0].resolveWith({
    artists_sidebar: [{ artist: 'Broadcast', count: 3 }],
    payload_tier: 'sidebar',
  });
  await sidebarPromise;
  await flushMicrotasks();

  assert.equal(context.startupMetrics.completed, 0);
  assert.equal(context.state.awaitingInitialDataRefresh, true);
  assert.equal(pendingRequests.length, 1);
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(scheduledTimeouts[0].delayMs, 350);
  scheduledTimeouts[0].callback();
  await flushMicrotasks();
  assert.equal(pendingRequests.length, 2);
  assert.equal(pendingRequests[1].url, '/view-data');

  pendingRequests[1].resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'tender-buttons' }] }],
    artist_count: 1,
    album_count: 1,
  });
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(context.startupMetrics.completed, 1);
  assert.equal(context.state.awaitingInitialDataRefresh, false);
  assert.deepEqual(calls.applyViewPayload, [
    {
      artists_sidebar: [{ artist: 'Broadcast', count: 3 }],
      payload_tier: 'sidebar',
    },
    {
      artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'tender-buttons' }] }],
      artist_count: 1,
      album_count: 1,
    },
  ]);
});

test('fetchAndRender marks visible startup readiness after sidebar hydration without completing the full refresh', async () => {
  const { context, pendingRequests } = createContext();
  context.isEffectivelyEmptyView = () => true;
  context.scheduleBrowserTimeout = () => {};

  const sidebarPromise = context.fetchAndRender('/view-data?payload_tier=sidebar', false, {
    startupRefresh: true,
    startupHydrationTier: 'sidebar',
    startupHydrationFollowupEndpoint: '/view-data',
  });
  assert.equal(pendingRequests.length, 1);
  pendingRequests[0].resolveWith({
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    artist_count: 123,
    payload_tier: 'sidebar',
  });
  await sidebarPromise;
  await flushMicrotasks();

  assert.equal(context.startupMetrics.visibleCompleted, 1);
  assert.equal(context.startupMetrics.completed, 0);
  assert.equal(context.startupMetrics.visibleCompletions[0].view.artist_count, 123);
  assert.deepEqual(JSON.parse(JSON.stringify(context.startupMetrics.visibleCompletions[0].detail)), {
    hydrationTier: 'sidebar',
  });
});

test('fetchAndRender completes startup refresh after sidebar hydration when no followup endpoint is present', async () => {
  const { context, pendingRequests } = createContext();

  const sidebarPromise = context.fetchAndRender('/view-data?payload_tier=sidebar', false, {
    startupRefresh: true,
    startupHydrationTier: 'sidebar',
    startupHydrationFollowupEndpoint: '',
  });
  assert.equal(pendingRequests.length, 1);
  pendingRequests[0].resolveWith({
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    payload_tier: 'sidebar',
  });
  await sidebarPromise;
  await flushMicrotasks();

  assert.equal(context.startupMetrics.visibleCompleted, 1);
  assert.equal(context.startupMetrics.completed, 1);
});

test('fetchAndRender drops a queued startup followup when a user request is already pending', async () => {
  const { context, pendingRequests } = createContext();

  const sidebarPromise = context.fetchAndRender('/view-data?payload_tier=sidebar', false, {
    startupRefresh: true,
    startupHydrationTier: 'sidebar',
    startupHydrationFollowupEndpoint: '/view-data',
  });
  assert.equal(pendingRequests.length, 1);
  context.state.ui.pendingViewRequest = {
    url: '/view-data?artist=Broadcast',
    push: true,
    options: { preserveScroll: true },
  };
  pendingRequests[0].resolveWith({
    artists_sidebar: [{ artist: 'Broadcast', count: 3 }],
    payload_tier: 'sidebar',
  });
  await sidebarPromise;
  await flushMicrotasks();

  assert.equal(pendingRequests.length, 2);
  assert.equal(pendingRequests[1].url, '/view-data?artist=Broadcast');
});

test('fetchAndRender clears queued startup followup state before a user request begins', async () => {
  const { context, pendingRequests } = createContext();
  context.state.awaitingInitialDataRefresh = true;
  context.state.ui.pendingStartupHydrationFollowup = {
    endpoint: '/view-data?surface=albums',
    options: {
      startupRefresh: true,
      startupHydrationTier: 'full',
    },
  };

  const requestPromise = context.fetchAndRender('/view-data?artist=Broadcast', true, {});

  assert.equal(context.state.awaitingInitialDataRefresh, false);
  assert.equal(context.state.ui.pendingStartupHydrationFollowup, null);
  assert.equal(pendingRequests.length, 1);
  assert.equal(pendingRequests[0].url, '/view-data?artist=Broadcast');

  pendingRequests[0].resolveWith({
    selected_artist: 'Broadcast',
    artist_groups: [{ artist: 'Broadcast' }],
  });
  await requestPromise;
});

test('dispatchStartupHydrationFollowup retries a queued startup followup when the first dispatch sees the app still busy', async () => {
  const { context, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.state.busy = true;

  context.dispatchStartupHydrationFollowup({
    endpoint: '/view-data',
    options: {
      startupRefresh: true,
      startupHydrationTier: 'full',
    },
  });
  await flushMicrotasks();

  assert.equal(pendingRequests.length, 0);
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(scheduledTimeouts[0].delayMs, 100);
  assert.equal(context.state.ui.pendingStartupHydrationFollowup.endpoint, '/view-data');

  context.state.busy = false;
  scheduledTimeouts[0].callback();
  await flushMicrotasks();

  assert.equal(pendingRequests.length, 1);
  assert.equal(pendingRequests[0].url, '/view-data');
});

test('dispatchStartupHydrationFollowup keeps the queued startup followup visible until the full fetch begins', async () => {
  const { context, pendingRequests } = createContext();
  context.state.ui.pendingStartupHydrationFollowup = {
    endpoint: '/view-data',
    options: {
      startupRefresh: true,
      startupHydrationTier: 'full',
    },
  };

  context.dispatchStartupHydrationFollowup(context.state.ui.pendingStartupHydrationFollowup);

  assert.equal(context.state.ui.pendingStartupHydrationFollowup.endpoint, '/view-data');
  assert.equal(pendingRequests.length, 0);

  await flushMicrotasks();

  assert.equal(context.state.ui.pendingStartupHydrationFollowup, null);
  assert.equal(pendingRequests.length, 1);
  assert.equal(pendingRequests[0].url, '/view-data');
});

test('dispatchStartupHydrationFollowup does not age out a required current-generation full hydration', async () => {
  const { context, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  let nowMs = 100;
  context.Date = { now: () => nowMs };
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.state.awaitingInitialDataRefresh = true;
  context.state.ui.viewStateRevision = 7;
  context.state.ui.pendingStartupHydrationFollowup = {
    endpoint: '/view-data',
    queuedAtMs: nowMs,
    originatingViewStateRevision: 7,
    options: {
      startupRefresh: true,
      startupHydrationTier: 'full',
    },
  };

  context.dispatchStartupHydrationFollowup(
    context.state.ui.pendingStartupHydrationFollowup,
    350,
  );
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(scheduledTimeouts[0].delayMs, 350);

  nowMs = 1201;
  scheduledTimeouts[0].callback();
  await flushMicrotasks();

  assert.equal(pendingRequests.length, 1);
  assert.equal(pendingRequests[0].url, '/view-data');
  assert.equal(context.state.awaitingInitialDataRefresh, true);

  pendingRequests[0].resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'tender-buttons' }] }],
    artist_count: 1,
    album_count: 1,
  });
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(context.state.awaitingInitialDataRefresh, false);
  assert.equal(context.startupMetrics.completed, 1);
});

function dispatchAgedStartupFollowup(context, overrides = {}) {
  const scheduledTimeouts = [];
  context.Date = { now: () => 1201 };
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.state.awaitingInitialDataRefresh = true;
  context.state.ui.viewStateRevision = overrides.currentRevision ?? 7;
  context.state.ui.pendingStartupHydrationFollowup = {
    endpoint: '/view-data',
    queuedAtMs: 100,
    originatingViewStateRevision: overrides.originatingRevision ?? 7,
    options: {
      startupRefresh: true,
      startupHydrationTier: 'full',
    },
  };
  context.dispatchStartupHydrationFollowup(
    context.state.ui.pendingStartupHydrationFollowup,
    350,
  );
  return scheduledTimeouts;
}

test('aged startup hydration expires after stale revision or query and artist navigation', async () => {
  const scenarios = [
    { name: 'stale revision', configure: (context) => { context.state.ui.viewStateRevision = 8; } },
    { name: 'query navigation', configure: (context) => { context.state.view.query = 'Broadcast'; } },
    { name: 'artist navigation', configure: (context) => { context.state.view.selected_artist = 'Broadcast'; } },
  ];

  for (const scenario of scenarios) {
    const { context, pendingRequests } = createContext();
    const scheduledTimeouts = dispatchAgedStartupFollowup(context);
    scenario.configure(context);
    scheduledTimeouts[0].callback();
    await flushMicrotasks();

    assert.equal(pendingRequests.length, 0, scenario.name);
    assert.equal(scheduledTimeouts.length, 1, scenario.name);
    assert.equal(context.state.ui.pendingStartupHydrationFollowup, null, scenario.name);
    assert.equal(context.state.awaitingInitialDataRefresh, false, scenario.name);
  }
});

test('aged startup hydration yields to a busy queued user request without retrying', async () => {
  const { context, pendingRequests } = createContext();
  context.state.busy = true;
  context.state.ui.activeViewRequestUrl = '/view-data?artist=Broadcast';
  context.state.ui.activeViewRequestStartupRefresh = false;
  context.state.ui.pendingViewRequest = {
    url: '/view-data?artist=Broadcast',
    push: true,
    options: {},
    originatingViewStateRevision: 7,
  };

  const scheduledTimeouts = dispatchAgedStartupFollowup(context);
  scheduledTimeouts[0].callback();
  await flushMicrotasks();

  assert.equal(pendingRequests.length, 0);
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(context.state.ui.pendingStartupHydrationFollowup, null);
  assert.equal(context.state.awaitingInitialDataRefresh, false);
  assert.equal(context.state.ui.pendingViewRequest.url, '/view-data?artist=Broadcast');
});

test('aged startup hydration preserves same-generation utility deferral through successful resume', async () => {
  const { context, pendingRequests } = createContext();
  let utilityModalOpen = true;
  const originalGetElementById = context.document.getElementById;
  context.document.getElementById = (id) => (
    id === 'utility-modal' ? { hidden: !utilityModalOpen } : originalGetElementById(id)
  );

  const scheduledTimeouts = dispatchAgedStartupFollowup(context);
  scheduledTimeouts[0].callback();
  await flushMicrotasks();

  assert.equal(pendingRequests.length, 0);
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(context.state.awaitingInitialDataRefresh, true);
  const deferred = context.state.ui.deferredUtilityViewRequest;
  assert.equal(deferred.originatingViewStateRevision, 7);

  utilityModalOpen = false;
  context.state.ui.deferredUtilityViewRequest = null;
  const resumePromise = context.fetchAndRender(deferred.url, deferred.push, deferred.options);
  pendingRequests[0].resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'tender-buttons' }] }],
    artist_count: 1,
    album_count: 1,
  });
  await resumePromise;

  assert.equal(context.state.awaitingInitialDataRefresh, false);
  assert.equal(context.startupMetrics.completed, 1);
});

test('terminal full startup hydration rejection and cancellation clear the awaiting state', async () => {
  const rejected = createContext();
  rejected.context.state.awaitingInitialDataRefresh = true;
  const rejectedPromise = rejected.context.fetchAndRender('/view-data', false, {
    startupRefresh: true,
    startupHydrationTier: 'full',
  });
  rejected.pendingRequests[0].rejectWith(new Error('aged hydration failed'));
  await assert.rejects(rejectedPromise, /aged hydration failed/);
  assert.equal(rejected.context.state.awaitingInitialDataRefresh, false);
  assert.equal(rejected.context.state.ui.pendingStartupHydrationFollowup, null);

  const cancelled = createContext();
  cancelled.context.state.awaitingInitialDataRefresh = true;
  const cancelledPromise = cancelled.context.fetchAndRender('/view-data', false, {
    startupRefresh: true,
    startupHydrationTier: 'full',
  });
  cancelled.context.state.ui.activeViewRequestController.abort();
  assert.equal(await cancelledPromise, false);
  assert.equal(cancelled.context.state.awaitingInitialDataRefresh, false);
  assert.equal(cancelled.context.state.ui.pendingStartupHydrationFollowup, null);
});

test('dispatchStartupHydrationFollowup defers full gallery work while the utility modal is open', async () => {
  const { context, pendingRequests } = createContext();
  const originalGetElementById = context.document.getElementById;
  context.document.getElementById = (id) => (
    id === 'utility-modal' ? { hidden: false } : originalGetElementById(id)
  );
  context.state.ui.pendingStartupHydrationFollowup = {
    endpoint: '/view-data?surface=albums&omit_sidebar=1',
    options: {
      startupRefresh: true,
      startupHydrationTier: 'full',
      preserveScroll: true,
    },
  };

  context.dispatchStartupHydrationFollowup(context.state.ui.pendingStartupHydrationFollowup);
  await flushMicrotasks();

  assert.equal(pendingRequests.length, 0);
  assert.equal(context.state.ui.pendingStartupHydrationFollowup, null);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.ui.deferredUtilityViewRequest)), {
    url: '/view-data?surface=albums&omit_sidebar=1',
    push: false,
    originatingViewStateRevision: 0,
    options: {
      startupRefresh: true,
      startupHydrationTier: 'full',
      preserveScroll: true,
    },
  });
});

test('fetchAndRender clears awaitingInitialDataRefresh after a successful full startup hydration payload', async () => {
  const { context, pendingRequests } = createContext();
  context.state.awaitingInitialDataRefresh = true;

  const startupPromise = context.fetchAndRender('/view-data?surface=albums', false, {
    startupRefresh: true,
    startupHydrationTier: 'full',
  });
  assert.equal(pendingRequests.length, 1);
  pendingRequests[0].resolveWith({
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'broadcast-tender-buttons' }] }],
    artist_count: 1,
    album_count: 1,
  });
  await startupPromise;
  await flushMicrotasks();

  assert.equal(context.state.awaitingInitialDataRefresh, false);
});

test('browseScannedLibrarySnapshot requests the albums surface when the root shell is on Home', async () => {
  const { context, pendingRequests } = createContext();
  context.state.view = {
    ...context.state.view,
    surface: {
      active: 'home',
      default: 'home',
    },
  };
  context.buildApiUrl = (value) => {
    if (value?.surface?.active === 'albums' || value?.surface_request === 'albums') {
      return '/view-data?surface=albums';
    }
    return '/home-data';
  };
  context.isEffectivelyEmptyView = () => false;

  const browsePromise = context.browseScannedLibrarySnapshot();
  assert.equal(pendingRequests.length, 1);
  assert.equal(pendingRequests[0].url, '/view-data?surface=albums');

  pendingRequests[0].resolveWith({
    surface: {
      active: 'albums',
      default: 'home',
    },
    artist_groups: [{ artist: 'Broadcast', albums: [] }],
  });
  await browsePromise;
});

test('browseScannedLibrarySnapshot restarts an in-flight identical browse request when the user explicitly asks to browse scanned results', async () => {
  const { context, pendingRequests } = createContext();
  context.buildApiUrl = () => '/view-data?surface=albums';

  const startupPromise = context.fetchAndRender('/view-data?surface=albums', false, {
    startupRefresh: true,
  });
  assert.equal(pendingRequests.length, 1);

  const browsePromise = context.browseScannedLibrarySnapshot();

  assert.equal(pendingRequests.length, 2);
  assert.equal(pendingRequests[0].options.signal.aborted, true);
  assert.equal(pendingRequests[1].url, '/view-data?surface=albums');

  pendingRequests[1].resolveWith({
    surface: {
      active: 'albums',
      default: 'albums',
    },
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'tender-buttons' }] }],
    album_count: 1,
  });
  await browsePromise;
  await flushMicrotasks();
  await startupPromise;
});

test('browseScannedLibrarySnapshot leaves the loader as soon as a snapshot is returned', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.ui.browseScannedResultsLoading = false;

  const browsePromise = context.browseScannedLibrarySnapshot();
  assert.equal(context.state.ui.browseScannedResultsLoading, true);
  assert.equal(pendingRequests.length, 1);

  pendingRequests[0].resolveWith({
    surface: { active: 'albums', default: 'albums' },
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    album_count: 1,
  });
  await browsePromise;

  assert.equal(context.state.ui.browseScannedResultsLoading, false);
  assert.equal(pendingRequests.length, 1);
  assert.equal(calls.renderLibraryLoader.length, 2);
});

test('browseScannedLibrarySnapshot consumes Scan Page return context only after a nonempty browse payload', async () => {
  const errorFixture = createContext();
  const errorReturnContext = {
    view: { query: 'missing album', selected_artist: '' },
    searchDraftQuery: 'missing album',
    url: '',
  };
  errorFixture.context.state.ui.forceScanPageVisible = true;
  errorFixture.context.state.ui.scanPageReturnContext = errorReturnContext;
  errorFixture.context.buildApiUrl = () => '/view-data?surface=albums';

  const errorBrowsePromise = errorFixture.context.browseScannedLibrarySnapshot();
  errorFixture.pendingRequests[0].rejectWith(new Error('browse failed'));
  await errorBrowsePromise;

  assert.equal(errorFixture.context.state.ui.scanPageReturnContext, errorReturnContext);
  assert.equal(errorFixture.context.state.ui.forceScanPageVisible, true);

  const emptyFixture = createContext();
  const emptyReturnContext = {
    view: { query: 'missing album', selected_artist: '' },
    searchDraftQuery: 'missing album',
    url: '',
  };
  let emptyChecks = 0;
  emptyFixture.context.state.ui.forceScanPageVisible = true;
  emptyFixture.context.state.ui.scanPageReturnContext = emptyReturnContext;
  emptyFixture.context.buildApiUrl = () => '/view-data?surface=albums';
  emptyFixture.context.isEffectivelyEmptyView = () => {
    emptyChecks += 1;
    return emptyChecks > 1;
  };

  const emptyBrowsePromise = emptyFixture.context.browseScannedLibrarySnapshot();
  emptyFixture.pendingRequests[0].resolveWith({
    surface: { active: 'albums', default: 'albums' },
    artist_groups: [],
    album_count: 0,
  });
  await emptyBrowsePromise;

  assert.equal(emptyFixture.context.state.ui.scanPageReturnContext, emptyReturnContext);
  assert.equal(emptyFixture.context.state.ui.forceScanPageVisible, true);

  const { context, calls, pendingRequests, searchInput } = createContext();
  const savedReturnContext = {
    view: { query: 'missing album', selected_artist: '' },
    searchDraftQuery: 'missing album',
    url: '',
  };
  context.state.ui.forceScanPageVisible = true;
  context.state.ui.scanPageReturnContext = savedReturnContext;
  context.state.ui.searchDraftQuery = 'missing album';
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.isEffectivelyEmptyView = (view) => Number(view?.album_count || 0) === 0;

  const browsePromise = context.browseScannedLibrarySnapshot();
  pendingRequests[0].resolveWith({
    surface: { active: 'albums', default: 'albums' },
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    album_count: 1,
  });
  await browsePromise;

  assert.deepEqual({
    scanPageReturnContext: context.state.ui.scanPageReturnContext,
    forceScanPageVisible: context.state.ui.forceScanPageVisible,
    searchDraftQuery: context.state.ui.searchDraftQuery,
    searchInputValue: searchInput.value,
    pushedViewCount: calls.pushBrowserViewState.length,
    normalGalleryRenderCount: calls.renderView.length,
  }, {
    scanPageReturnContext: null,
    forceScanPageVisible: false,
    searchDraftQuery: '',
    searchInputValue: '',
    pushedViewCount: 1,
    normalGalleryRenderCount: 2,
  });
});
test('browseScannedLibrarySnapshot renders a reusable root snapshot before its refresh returns', async () => {
  const {
    context,
    calls,
    pendingRequests,
    searchInput,
  } = createContext();
  context.state.ui.forceScanPageVisible = true;
  context.state.ui.scanPageReturnContext = {
    view: { query: 'old query', selected_artist: 'Old Artist' },
    searchDraftQuery: 'old query',
    url: '',
  };
  context.state.ui.searchDraftQuery = 'old query';
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.isEffectivelyEmptyView = (view) => Number(view?.album_count || 0) === 0;
  context.getReusableRootBrowseView = () => ({
    query: '',
    selected_artist: '',
    all_artists_active: true,
    surface: { active: 'albums', default: 'albums' },
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    album_count: 1,
  });

  const browsePromise = context.browseScannedLibrarySnapshot();

  assert.equal(context.state.ui.scanPageReturnContext, null);
  assert.equal(context.state.ui.forceScanPageVisible, false);
  assert.equal(context.state.ui.searchDraftQuery, '');
  assert.equal(searchInput.value, '');
  assert.equal(context.state.view.album_count, 1);
  assert.equal(calls.renderView.length, 1);
  assert.equal(pendingRequests.length, 1);

  pendingRequests[0].resolveWith({
    surface: { active: 'albums', default: 'albums' },
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons-refreshed' }],
    }],
    album_count: 1,
  });
  await browsePromise;
});

test('browseScannedLibrarySnapshot preserves mounted album-card children while resetting the root gallery', async () => {
  const {
    context,
    calls,
    pendingRequests,
  } = createContext();
  context.state.ui.forceScanPageVisible = true;
  context.state.ui.scanPageReturnContext = {
    view: { query: '', selected_artist: '' },
    searchDraftQuery: '',
    url: '',
  };
  context.state.view = {
    query: '',
    selected_artist: '',
    all_artists_active: true,
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    album_count: 1,
  };
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.getReusableRootBrowseView = () => ({
    query: '',
    selected_artist: '',
    all_artists_active: true,
    surface: { active: 'albums', default: 'albums' },
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    album_count: 1,
  });
  context.document.getElementById('artist-groups').querySelectorAll = (selector) => (
    selector === '.album-card' ? [{ dataset: { albumKey: 'broadcast::tender-buttons' } }] : []
  );

  const browsePromise = context.browseScannedLibrarySnapshot();

  assert.equal(calls.renderView[0]?.preserveMountedGalleryChildren, true);
  assert.equal(calls.renderView[0]?.preserveMountedGallery, undefined);
  pendingRequests[0].resolveWith({
    surface: { active: 'albums', default: 'albums' },
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    album_count: 1,
  });
  await browsePromise;
});

test('browseScannedLibrarySnapshot replaces a mounted gallery whose identity differs from the reusable root snapshot', async () => {
  const {
    context,
    calls,
    pendingRequests,
  } = createContext();
  context.state.view = {
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse::sola-scriptura' }],
    }],
    album_count: 1,
  };
  context.state.ui.forceScanPageVisible = true;
  context.state.ui.scanPageReturnContext = {
    view: structuredClone(context.state.view),
    searchDraftQuery: 'Neal Morse',
    url: '',
  };
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.getReusableRootBrowseView = () => ({
    query: '',
    selected_artist: '',
    all_artists_active: true,
    surface: { active: 'albums', default: 'albums' },
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    album_count: 1,
  });
  context.document.getElementById('artist-groups').querySelectorAll = (selector) => (
    selector === '.album-card' ? [{ dataset: { albumKey: 'neal-morse::sola-scriptura' } }] : []
  );

  const browsePromise = context.browseScannedLibrarySnapshot();

  assert.equal(
    calls.renderView[0]?.preserveMountedGallery,
    undefined,
    'a selected-artist gallery must be replaced when Browse switches state to the reusable root snapshot',
  );
  pendingRequests[0].resolveWith({
    surface: { active: 'albums', default: 'albums' },
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    album_count: 1,
  });
  await browsePromise;
});

test('browseScannedLibrarySnapshot defers its root refresh while an incremental scan is active', async () => {
  const { context, pendingRequests } = createContext();
  context.state.status = { scan_in_progress: true };
  context.state.ui.forceScanPageVisible = true;
  context.state.ui.scanPageReturnContext = {
    view: { query: '', selected_artist: '' },
    searchDraftQuery: '',
    url: '',
  };
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.isEffectivelyEmptyView = (view) => Number(view?.album_count || 0) === 0;
  context.getReusableRootBrowseView = () => ({
    query: '',
    selected_artist: '',
    all_artists_active: true,
    surface: { active: 'albums', default: 'albums' },
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    album_count: 1,
  });

  const browsePromise = context.browseScannedLibrarySnapshot();
  const refreshRequestCount = pendingRequests.length;
  pendingRequests[0]?.resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [] }],
    album_count: 1,
  });
  await browsePromise;

  assert.equal(refreshRequestCount, 0);
  assert.equal(context.state.view.album_count, 1);
  assert.equal(context.state.ui.forceScanPageVisible, false);
});

test('browseScannedLibrarySnapshot immediately restores the retained root gallery when current and cached views are empty', async () => {
  const {
    context,
    calls,
    pendingRequests,
  } = createArtistFamilyOwnershipContext();
  const retainedRootView = {
    surface: { active: 'albums', default: 'albums' },
    query: '',
    selected_artist: '',
    all_artists_active: true,
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{
        key: 'broadcast::tender-buttons',
        name: 'Tender Buttons',
        album_artist: 'Broadcast',
      }],
    }],
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    album_count: 1,
    artist_count: 1,
    gallery_scope: 'all',
  };
  context.state.status = { scan_in_progress: true };
  context.state.view = {
    surface: { active: 'albums', default: 'albums' },
    query: '',
    selected_artist: '',
    artist_groups: [],
    artists_sidebar: [],
    album_count: 0,
    artist_count: 0,
    gallery_scope: 'all',
  };
  context.state.gallery.reusableRootBrowseView = null;
  context.state.gallery.reusableRootBrowseViewSignature = '';
  context.state.ui.forceScanPageVisible = true;
  context.state.ui.scanPageReturnContext = {
    view: retainedRootView,
    searchDraftQuery: '',
    url: '',
  };

  const browsePromise = context.browseScannedLibrarySnapshot();
  const immediateState = {
    scanPageReturnContextCleared: context.state.ui.scanPageReturnContext === null,
    forceScanPageVisible: context.state.ui.forceScanPageVisible,
    pendingRequestCount: pendingRequests.length,
    renderViewCount: calls.renderView.length,
    renderViewOptions: calls.renderView[0],
  };
  if (pendingRequests[0]) {
    pendingRequests[0].resolveWith(retainedRootView);
  }
  await browsePromise;

  assert.deepEqual(immediateState, {
    scanPageReturnContextCleared: true,
    forceScanPageVisible: false,
    pendingRequestCount: 0,
    renderViewCount: 1,
    renderViewOptions: undefined,
  });
});

test('browseScannedLibrarySnapshot paints a reusable active-scan gallery before any loading state', async () => {
  const {
    context,
    pendingRequests,
  } = createArtistFamilyOwnershipContext();
  const rootView = {
    surface: { active: 'albums', default: 'albums' },
    query: '',
    selected_artist: '',
    all_artists_active: true,
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{
        key: 'broadcast::tender-buttons',
        name: 'Tender Buttons',
        album_artist: 'Broadcast',
      }],
    }],
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    album_count: 1,
    artist_count: 1,
    gallery_scope: 'all',
  };
  context.state.status = {
    scan_in_progress: true,
    scan_phase: 'indexing',
  };
  context.state.view = JSON.parse(JSON.stringify(rootView));
  context.state.ui.forceScanPageVisible = true;
  context.state.ui.scanPageReturnContext = {
    view: JSON.parse(JSON.stringify(rootView)),
    searchDraftQuery: '',
    url: '',
  };
  const paintTimeline = [];
  context.renderView = () => {
    paintTimeline.push({
      kind: 'gallery',
      browseLoading: Boolean(context.state.ui.browseScannedResultsLoading),
    });
  };
  context.renderLibraryLoader = () => {
    paintTimeline.push({
      kind: 'loader',
      browseLoading: Boolean(context.state.ui.browseScannedResultsLoading),
    });
  };

  await context.browseScannedLibrarySnapshot();

  assert.equal(pendingRequests.length, 0);
  assert.equal(paintTimeline[0]?.kind, 'gallery');
  assert.equal(
    paintTimeline.some((paint) => paint.kind === 'loader' && paint.browseLoading),
    false,
    'A reusable root gallery must replace Scan Page without painting a browse-loading frame.',
  );
});

test('Scan Page Back aborts an in-flight Browse refresh and rejects its late payload', async () => {
  const { context, calls, pendingRequests } = createContext();
  const savedView = {
    query: 'Neal',
    selected_artist: 'Neal Morse',
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal::sola-scriptura' }],
    }],
    album_count: 1,
  };
  context.state.view = JSON.parse(JSON.stringify(savedView));
  context.state.ui.forceScanPageVisible = true;
  context.state.ui.scanPageReturnContext = {
    view: JSON.parse(JSON.stringify(savedView)),
    searchDraftQuery: 'Neal',
    url: '',
  };
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.isEffectivelyEmptyView = () => false;

  const browsePromise = context.browseScannedLibrarySnapshot();
  assert.equal(pendingRequests.length, 1);

  context.closeScanPage();
  const browseRequestWasAborted = pendingRequests[0].options.signal.aborted;
  if (!browseRequestWasAborted) {
    pendingRequests[0].resolveWith({
      query: '',
      selected_artist: '',
      artist_groups: [{
        artist: 'Late Artist',
        albums: [{ key: 'late::payload' }],
      }],
      album_count: 1,
    });
  }
  await browsePromise;

  assert.equal(browseRequestWasAborted, true);
  assert.equal(context.state.ui.scanPageReturnContext, null);
  assert.equal(context.state.view.selected_artist, savedView.selected_artist);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'neal::sola-scriptura');
  assert.equal(calls.applyViewPayload.length, 0);
});


test('browseScannedLibrarySnapshot clears stale search and artist filters before requesting the root albums snapshot', async () => {
  const { context, pendingRequests } = createContext();
  let requestedView = null;
  context.state.view = {
    ...context.state.view,
    query: 'missing album',
    selected_artist: 'Missing Artist',
    all_artists_active: false,
    related_filter_artists: ['Related Artist'],
    primary_filter_active: true,
    surface: { active: 'albums', default: 'albums' },
  };
  context.buildApiUrl = (value) => {
    requestedView = value;
    return '/view-data?surface=albums';
  };
  context.isEffectivelyEmptyView = () => false;

  const browsePromise = context.browseScannedLibrarySnapshot();
  pendingRequests[0].resolveWith({
    surface: { active: 'albums', default: 'albums' },
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'tender-buttons' }] }],
    album_count: 1,
  });
  await browsePromise;

  assert.equal(requestedView.query, '');
  assert.equal(requestedView.selected_artist, '');
  assert.equal(requestedView.all_artists_active, true);
  assert.equal(Array.isArray(requestedView.related_filter_artists), true);
  assert.equal(requestedView.related_filter_artists.length, 0);
  assert.equal(requestedView.primary_filter_active, false);
});

test('idle pollStatus waits for real foreground cover idle and retries immediately afterward', async () => {
  const { context, calls, pendingRequests } = createContext();
  const scheduled = [];
  let releaseForegroundIdle;
  const foregroundIdle = new Promise((resolve) => { releaseForegroundIdle = resolve; });
  context.state.status = {
    scan_in_progress: false,
    relations_in_progress: false,
    covers_in_progress: false,
  };
  context.galleryCoverLoadScheduler = {
    isForegroundIdle() { return false; },
    whenForegroundIdle() { return foregroundIdle; },
  };
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduled.push({ callback, delayMs });
    return scheduled.length;
  };

  const deferredPoll = context.pollStatus();
  await flushMicrotasks();
  assert.equal(pendingRequests.length, 0, 'non-urgent status traffic must not compete with foreground covers');

  releaseForegroundIdle();
  await deferredPoll;
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 25);
  assert.equal(calls.updateStatusIndicator.length, 0);

  context.galleryCoverLoadScheduler.isForegroundIdle = () => true;
  scheduled[0].callback();
  assert.equal(pendingRequests.length, 1);
  assert.equal(pendingRequests[0].url, '/status');
  pendingRequests[0].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  await flushMicrotasks();
});

test('busy pollStatus is never delayed by foreground cover activity', async () => {
  const { context, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.state.status = {
    scan_in_progress: true,
    relations_in_progress: false,
    covers_in_progress: false,
  };
  context.galleryCoverLoadScheduler = {
    isForegroundIdle() { return false; },
    whenForegroundIdle() { throw new Error('busy status polling must not wait for foreground idle'); },
  };

  const statusPromise = context.pollStatus();
  assert.equal(pendingRequests.length, 1);
  assert.equal(pendingRequests[0].url, '/status');
  pendingRequests[0].resolveWith({
    covers_in_progress: false,
    scan_in_progress: true,
    relations_in_progress: false,
  });
  await statusPromise;
});

test('busy pollStatus samples quickly while the status context menu is visible', async () => {
  const { context, pendingRequests } = createContext();
  const scheduled = [];
  const originalGetElementById = context.document.getElementById.bind(context.document);
  context.document.getElementById = (id) => (
    id === 'status-context-menu' ? { hidden: false } : originalGetElementById(id)
  );
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduled.push({ callback, delayMs });
    return scheduled.length;
  };
  context.state.status = {
    scan_in_progress: true,
    relations_in_progress: false,
    covers_in_progress: false,
  };

  const statusPromise = context.pollStatus();
  pendingRequests[0].resolveWith({
    covers_in_progress: true,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  await statusPromise;

  assert.equal(scheduled.at(-1).delayMs, 100);
});

test('pollStatus does not refresh the populated root browse when cover work finishes', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.state.view = {
    ...context.state.view,
    query: '',
    selected_artist: '',
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'tender-buttons' }] }],
  };
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.wasCoverPollingBusy = true;
  context.state.wasPollingBusy = false;

  const statusPromise = context.pollStatus();
  assert.equal(pendingRequests.length, 1);
  pendingRequests[0].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  await statusPromise;
  await flushMicrotasks();

  assert.equal(pendingRequests.length, 1);
  assert.deepEqual(calls.fetchRequests.map((request) => request.url), ['/status']);
  assert.deepEqual(calls.showToast, [{
    message: 'Album covers updated.',
    level: 'success',
    durationMs: 3200,
  }]);
});

test('pollStatus defers cover reconciliation until an in-flight selected-artist request settles', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.state.view = {
    ...context.state.view,
    query: '',
    selected_artist: '',
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'tender-buttons' }] }],
  };
  context.state.wasCoverPollingBusy = true;
  context.state.wasPollingBusy = false;

  const selectedArtistPromise = context.fetchAndRender('/view-data?artist=A.C.T&omit_sidebar=1', true);
  assert.equal(pendingRequests.length, 1);
  assert.equal(pendingRequests[0].url, '/view-data?artist=A.C.T&omit_sidebar=1');

  const statusPromise = context.pollStatus();
  assert.equal(pendingRequests.length, 2);
  assert.equal(pendingRequests[1].url, '/status');
  pendingRequests[1].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await flushMicrotasks();
  }

  assert.equal(pendingRequests.length, 2);
  assert.equal(pendingRequests[0].options.signal.aborted, false);

  pendingRequests[0].resolveWith({
    selected_artist: 'A.C.T',
    artist_groups: [{ artist: 'A.C.T', albums: [{ key: 'silence' }] }],
    album_count: 1,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 3; attempt += 1) {
    await flushMicrotasks();
  }
  assert.equal(pendingRequests.length, 3);
  assert.equal(pendingRequests[2].url, '/view-data?artist=A.C.T');
  pendingRequests[2].resolveWith({
    selected_artist: 'A.C.T',
    artist_groups: [{ artist: 'A.C.T', albums: [{ key: 'silence-with-cover' }] }],
    album_count: 1,
  });
  await selectedArtistPromise;
  await statusPromise;
  await flushMicrotasks();

  assert.deepEqual(calls.fetchRequests.map((request) => request.url), [
    '/view-data?artist=A.C.T&omit_sidebar=1',
    '/status',
    '/view-data?artist=A.C.T',
  ]);
  assert.deepEqual(calls.showToast, [{
    message: 'Album covers updated.',
    level: 'success',
    durationMs: 3200,
  }]);
});

test('pollStatus refreshes the current loaded gallery when a background scan completes', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.view = {
    ...context.state.view,
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'tender-buttons' }] }],
  };
  context.state.awaitingInitialDataRefresh = false;
  context.state.wasPollingBusy = true;
  context.state.wasCoverPollingBusy = false;

  const inFlightViewPromise = context.fetchAndRender('/view-data?surface=albums', false);
  assert.equal(pendingRequests.length, 1);

  const statusPromise = context.pollStatus();
  assert.equal(pendingRequests.length, 2);
  assert.equal(pendingRequests[1].url, '/status');
  pendingRequests[1].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  await statusPromise;
  assert.equal(pendingRequests.length, 2);
  assert.equal(pendingRequests[0].options.signal.aborted, false);
  pendingRequests[0].resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'stale-pre-commit' }] }],
    album_count: 1,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 3; attempt += 1) {
    await flushMicrotasks();
  }

  assert.equal(pendingRequests.length, 3);
  assert.equal(pendingRequests[2].url, '/view-data?surface=albums');
  pendingRequests[2].resolveWith({
    artist_groups: [
      { artist: 'Broadcast', albums: [{ key: 'tender-buttons' }, { key: 'spell-blanket' }] },
    ],
    album_count: 2,
  });

  await inFlightViewPromise;
  await flushMicrotasks();

  assert.equal(context.state.awaitingInitialDataRefresh, false);
  assert.equal(context.state.view.album_count, 2);
  assert.deepEqual(calls.fetchRequests.map((request) => request.url), [
    '/view-data?surface=albums',
    '/status',
    '/view-data?surface=albums',
  ]);
  assert.deepEqual(calls.showToast, [{
    message: 'Library scan complete.',
    level: 'success',
    durationMs: 3200,
  }]);
});

test('pollStatus does not launch the awaited root refresh while a sidebar selection is pending', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.awaitingInitialDataRefresh = true;
  context.state.wasPollingBusy = true;
  context.state.wasCoverPollingBusy = false;
  context.state.ui.pendingSidebarSelectedArtist = 'A.C.T';

  const statusPromise = context.pollStatus();
  assert.equal(pendingRequests.length, 1);
  assert.equal(pendingRequests[0].url, '/status');
  pendingRequests[0].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  await statusPromise;
  await flushMicrotasks();

  assert.equal(context.state.awaitingInitialDataRefresh, true);
  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, true);
  assert.deepEqual(calls.fetchRequests.map((request) => request.url), ['/status']);
});

test('pollStatus refreshes a selected artist after pending sidebar navigation settles', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.state.awaitingInitialDataRefresh = true;
  context.state.wasPollingBusy = true;
  context.state.wasCoverPollingBusy = false;
  context.state.ui.pendingSidebarSelectedArtist = 'A.C.T';
  context.buildApiUrl = (view) => `/view-data?artist=${encodeURIComponent(String(view?.selected_artist || ''))}`;
  context.applyViewPayload = (payload) => {
    calls.applyViewPayload.push(payload);
    context.state.view = {
      ...context.state.view,
      ...payload,
    };
    context.state.ui.pendingSidebarSelectedArtist = '';
    context.state.ui.pendingSidebarAllArtistsActive = false;
  };

  const sidebarPromise = context.fetchAndRender('/view-data?artist=A.C.T', true);
  assert.equal(pendingRequests.length, 1);

  const statusPromise = context.pollStatus();
  assert.equal(pendingRequests.length, 2);
  pendingRequests[1].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  await statusPromise;
  await flushMicrotasks();

  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, true);
  assert.equal(pendingRequests.length, 2);

  pendingRequests[0].resolveWith({
    selected_artist: 'A.C.T',
    artist_groups: [{ artist: 'A.C.T', albums: [{ key: 'stale-pre-commit' }] }],
    album_count: 1,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 3; attempt += 1) {
    await flushMicrotasks();
  }

  assert.equal(pendingRequests.length, 3);
  assert.equal(pendingRequests[2].url, '/view-data?artist=A.C.T');
  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, false);
  pendingRequests[2].resolveWith({
    selected_artist: 'A.C.T',
    artist_groups: [{
      artist: 'A.C.T',
      albums: [{ key: 'stale-pre-commit' }, { key: 'durable-post-scan' }],
    }],
    album_count: 2,
  });
  await sidebarPromise;
  for (let attempt = 0; attempt < 5 && context.state.view.album_count !== 2; attempt += 1) {
    await flushMicrotasks();
  }

  assert.equal(context.state.view.album_count, 2);
  assert.deepEqual(calls.fetchRequests.map((request) => request.url), [
    '/view-data?artist=A.C.T',
    '/status',
    '/view-data?artist=A.C.T',
  ]);
});

test('scan completion reissues against the current family filter when the first refresh loses revision ownership', async () => {
  const { context, pendingRequests } = createArtistFamilyOwnershipContext();
  seedMorseArtistFamily(context);
  context.buildApiUrl = (view) => {
    const relatedArtist = Array.isArray(view?.related_filter_artists)
      ? String(view.related_filter_artists[0] || '')
      : '';
    return `/view-data?artist=Morse%20Portnoy%20George${relatedArtist ? `&related_artist=${encodeURIComponent(relatedArtist)}` : ''}`;
  };
  context.state.ui.pendingScanCompletionViewRefresh = true;

  const refreshPromise = context.dispatchPendingScanCompletionViewRefresh();
  assert.equal(pendingRequests[0].url, '/view-data?artist=Morse%20Portnoy%20George');

  context.applyLocalRelatedFilterState(['Neal Morse']);
  pendingRequests[0].resolveWith({
    selected_artist: 'Morse Portnoy George',
    related_filter_artists: [],
    artist_groups: [{ artist: 'Morse Portnoy George', albums: [] }],
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 2; attempt += 1) {
    await flushMicrotasks();
  }

  assert.equal(
    pendingRequests[1].url,
    '/view-data?artist=Morse%20Portnoy%20George&related_artist=Neal%20Morse',
  );
  pendingRequests[1].resolveWith({
    selected_artist: 'Morse Portnoy George',
    related_artists: ['Neal Morse'],
    related_filter_artists: ['Neal Morse'],
    primary_filter_active: false,
    primary_artist_groups: [],
    family_artist_groups: [{ artist: 'Neal Morse', albums: [{ key: 'sola-scriptura' }] }],
    artist_groups: [{ artist: 'Neal Morse', albums: [{ key: 'sola-scriptura' }] }],
    artist_count: 1,
    album_count: 1,
  });

  assert.equal(await refreshPromise, true);
  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryCount, 0);
  assert.deepEqual(Array.from(context.state.view.related_filter_artists), ['Neal Morse']);
  assert.deepEqual(
    Array.from(context.state.view.artist_groups, (group) => group.artist),
    ['Neal Morse'],
  );
});

test('cover completion reissues against the current family filter when a local click supersedes its first refresh', async () => {
  const { context, pendingRequests } = createArtistFamilyOwnershipContext();
  seedMorseArtistFamily(context);
  context.scheduleBrowserTimeout = () => 0;
  context.buildApiUrl = (view) => {
    const relatedArtist = Array.isArray(view?.related_filter_artists)
      ? String(view.related_filter_artists[0] || '')
      : '';
    return `/view-data?artist=Morse%20Portnoy%20George${relatedArtist ? `&related_artist=${encodeURIComponent(relatedArtist)}` : ''}`;
  };
  context.state.wasPollingBusy = false;
  context.state.wasCoverPollingBusy = true;

  const pollPromise = context.pollStatus();
  pendingRequests[0].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 2; attempt += 1) {
    await flushMicrotasks();
  }
  assert.equal(pendingRequests[1].url, '/view-data?artist=Morse%20Portnoy%20George');

  context.applyLocalRelatedFilterState(['Neal Morse']);
  pendingRequests[1].resolveWith({
    selected_artist: 'Morse Portnoy George',
    related_filter_artists: [],
    artist_groups: [{ artist: 'Morse Portnoy George', albums: [] }],
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 3; attempt += 1) {
    await flushMicrotasks();
  }

  assert.equal(
    pendingRequests[2].url,
    '/view-data?artist=Morse%20Portnoy%20George&related_artist=Neal%20Morse',
  );
  pendingRequests[2].resolveWith({
    selected_artist: 'Morse Portnoy George',
    related_artists: ['Neal Morse'],
    related_filter_artists: ['Neal Morse'],
    primary_filter_active: false,
    primary_artist_groups: [],
    family_artist_groups: [{ artist: 'Neal Morse', albums: [{ key: 'sola-scriptura' }] }],
    artist_groups: [{ artist: 'Neal Morse', albums: [{ key: 'sola-scriptura' }] }],
    artist_count: 1,
    album_count: 1,
  });

  await pollPromise;
  assert.deepEqual(Array.from(context.state.view.related_filter_artists), ['Neal Morse']);
  assert.deepEqual(
    Array.from(context.state.view.artist_groups, (group) => group.artist),
    ['Neal Morse'],
  );
});

test('cover reconciliation remains pending after ownership retries exhaust and recovers on its bounded timer', async () => {
  const { context, pendingRequests } = createArtistFamilyOwnershipContext();
  const scheduledTimeouts = [];
  seedMorseArtistFamily(context);
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.buildApiUrl = (view) => {
    const relatedArtist = Array.isArray(view?.related_filter_artists)
      ? String(view.related_filter_artists[0] || '')
      : '';
    return `/view-data?artist=Morse%20Portnoy%20George${relatedArtist ? `&related_artist=${encodeURIComponent(relatedArtist)}` : ''}`;
  };
  context.state.ui.pendingCoverCompletionViewRefresh = true;

  const dispatchPromise = context.dispatchPendingCoverCompletionViewRefresh();
  const successiveFilters = [['Neal Morse'], [], ['Neal Morse']];
  for (let index = 0; index < successiveFilters.length; index += 1) {
    context.applyLocalRelatedFilterState(successiveFilters[index]);
    pendingRequests[index].resolveWith({
      selected_artist: 'Morse Portnoy George',
      related_filter_artists: [],
      artist_groups: [{ artist: 'Morse Portnoy George', albums: [] }],
    });
    if (index < successiveFilters.length - 1) {
      for (let attempt = 0; attempt < 5 && pendingRequests.length < index + 2; attempt += 1) {
        await flushMicrotasks();
      }
    }
  }

  assert.equal(await dispatchPromise, true);
  assert.equal(context.state.ui.pendingCoverCompletionViewRefresh, true);
  assert.equal(context.state.ui.pendingCoverCompletionViewRefreshRetryScheduled, true);
  assert.equal(context.state.ui.pendingCoverCompletionViewRefreshRetryCount, 1);
  assert.deepEqual(scheduledTimeouts.map((entry) => entry.delayMs), [1000]);

  const retryPromise = scheduledTimeouts[0].callback();
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 4; attempt += 1) {
    await flushMicrotasks();
  }
  assert.equal(
    pendingRequests[3].url,
    '/view-data?artist=Morse%20Portnoy%20George&related_artist=Neal%20Morse',
  );
  pendingRequests[3].resolveWith({
    selected_artist: 'Morse Portnoy George',
    related_artists: ['Neal Morse'],
    related_filter_artists: ['Neal Morse'],
    primary_filter_active: false,
    primary_artist_groups: [],
    family_artist_groups: [{ artist: 'Neal Morse', albums: [{ key: 'sola-scriptura' }] }],
    artist_groups: [{ artist: 'Neal Morse', albums: [{ key: 'sola-scriptura' }] }],
    artist_count: 1,
    album_count: 1,
  });
  await retryPromise;

  assert.equal(context.state.ui.pendingCoverCompletionViewRefresh, false);
  assert.equal(context.state.ui.pendingCoverCompletionViewRefreshRetryScheduled, false);
  assert.equal(context.state.ui.pendingCoverCompletionViewRefreshRetryCount, 0);
  assert.equal(context.state.ui.pendingCoverCompletionViewRefreshRetryExhausted, false);
});

test('cover reconciliation reports one terminal error after its bounded retry schedule exhausts', async () => {
  const { context, calls, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.buildApiUrl = () => '/view-data?artist=A.C.T';
  context.state.view.selected_artist = 'A.C.T';
  context.state.ui.pendingCoverCompletionViewRefresh = true;

  const firstAttempt = context.dispatchPendingCoverCompletionViewRefresh();
  pendingRequests[0].rejectWith(new Error('cover reconcile failure 1'));
  await firstAttempt;

  const firstRetry = scheduledTimeouts[0].callback();
  pendingRequests[1].rejectWith(new Error('cover reconcile failure 2'));
  await firstRetry;

  const secondRetry = scheduledTimeouts[1].callback();
  pendingRequests[2].rejectWith(new Error('cover reconcile failure 3'));
  await secondRetry;

  assert.deepEqual(scheduledTimeouts.map((entry) => entry.delayMs), [1000, 3000]);
  assert.equal(context.state.ui.pendingCoverCompletionViewRefresh, true);
  assert.equal(context.state.ui.pendingCoverCompletionViewRefreshRetryCount, 2);
  assert.equal(context.state.ui.pendingCoverCompletionViewRefreshRetryExhausted, true);
  assert.equal(context.state.ui.pendingCoverCompletionViewRefreshRetryScheduled, false);
  assert.equal(calls.consoleErrors.length, 1);
  assert.match(String(calls.consoleErrors[0][0]), /Failed to reconcile the gallery after cover completion/);
  assert.deepEqual(calls.showToast, [{
    message: 'Unable to refresh the gallery after album covers updated.',
    level: 'error',
    durationMs: 3200,
  }]);
});

test('an older scan dispatcher failure cannot schedule a retry after a newer completion reconciles', async () => {
  const { context, calls, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.ui.pendingScanCompletionViewRefresh = true;
  context.state.ui.pendingScanCompletionViewRefreshRetryToken = 10;

  const olderDispatch = context.dispatchPendingScanCompletionViewRefresh();
  assert.equal(pendingRequests[0].url, '/view-data?surface=albums');

  context.state.wasPollingBusy = true;
  context.state.wasCoverPollingBusy = false;
  const newerCompletionPoll = context.pollStatus();
  pendingRequests[1].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  await newerCompletionPoll;
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryToken, 11);
  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, true);

  pendingRequests[0].rejectWith(new Error('older scan dispatcher failed'));
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 3; attempt += 1) {
    await flushMicrotasks();
  }
  assert.equal(pendingRequests[2].url, '/view-data?surface=albums');
  pendingRequests[2].resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'newer-scan-result' }] }],
    album_count: 1,
  });
  await olderDispatch;

  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryCount, 0);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryExhausted, false);
  assert.equal(scheduledTimeouts.some((entry) => entry.delayMs === 1000), false);
  assert.equal(calls.consoleErrors.length, 0);
  assert.equal(calls.showToast.filter((entry) => entry.level === 'error').length, 0);
});

test('an older cover dispatcher failure cannot schedule a retry after a newer completion reconciles', async () => {
  const { context, calls, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.buildApiUrl = () => '/view-data?artist=A.C.T';
  context.state.view.selected_artist = 'A.C.T';
  context.state.ui.pendingCoverCompletionViewRefresh = true;
  context.state.ui.pendingCoverCompletionViewRefreshRetryToken = 20;

  const olderDispatch = context.dispatchPendingCoverCompletionViewRefresh();
  assert.equal(pendingRequests[0].url, '/view-data?artist=A.C.T');

  context.state.wasPollingBusy = false;
  context.state.wasCoverPollingBusy = true;
  const newerCompletionPoll = context.pollStatus();
  pendingRequests[1].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  await newerCompletionPoll;
  assert.equal(context.state.ui.pendingCoverCompletionViewRefreshRetryToken, 21);
  assert.equal(context.state.ui.pendingCoverCompletionViewRefresh, true);

  pendingRequests[0].rejectWith(new Error('older cover dispatcher failed'));
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 3; attempt += 1) {
    await flushMicrotasks();
  }
  assert.equal(pendingRequests[2].url, '/view-data?artist=A.C.T');
  pendingRequests[2].resolveWith({
    selected_artist: 'A.C.T',
    artist_groups: [{ artist: 'A.C.T', albums: [{ key: 'newer-cover-result' }] }],
    album_count: 1,
  });
  await olderDispatch;

  assert.equal(context.state.ui.pendingCoverCompletionViewRefresh, false);
  assert.equal(context.state.ui.pendingCoverCompletionViewRefreshRetryCount, 0);
  assert.equal(context.state.ui.pendingCoverCompletionViewRefreshRetryExhausted, false);
  assert.equal(scheduledTimeouts.some((entry) => entry.delayMs === 1000), false);
  assert.equal(calls.consoleErrors.length, 0);
  assert.equal(calls.showToast.filter((entry) => entry.level === 'error').length, 0);
});

test('deferred scan completion refresh handles rejection and retries without losing the signal', async () => {
  const { context, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.state.awaitingInitialDataRefresh = true;
  context.state.wasPollingBusy = true;
  context.state.wasCoverPollingBusy = false;
  context.state.ui.pendingSidebarSelectedArtist = 'A.C.T';
  context.buildApiUrl = (view) => `/view-data?artist=${encodeURIComponent(String(view?.selected_artist || ''))}`;
  context.applyViewPayload = (payload) => {
    context.state.view = {
      ...context.state.view,
      ...payload,
    };
    context.state.ui.pendingSidebarSelectedArtist = '';
    context.state.ui.pendingSidebarAllArtistsActive = false;
  };

  const sidebarPromise = context.fetchAndRender('/view-data?artist=A.C.T', true);
  const statusPromise = context.pollStatus();
  pendingRequests[1].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  await statusPromise;

  pendingRequests[0].resolveWith({
    selected_artist: 'A.C.T',
    artist_groups: [{ artist: 'A.C.T', albums: [{ key: 'stale-pre-commit' }] }],
    album_count: 1,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 3; attempt += 1) {
    await flushMicrotasks();
  }
  assert.equal(pendingRequests[2].url, '/view-data?artist=A.C.T');
  pendingRequests[2].rejectWith(new Error('temporary refresh failure'));

  await assert.doesNotReject(sidebarPromise);
  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, true);
  const retry = scheduledTimeouts.find((entry) => entry.delayMs === 1000);
  assert.ok(retry);

  const unrelatedPromise = context.fetchAndRender('/view-data?artist=A.C.T&unrelated=1', false);
  assert.equal(pendingRequests.length, 4);
  pendingRequests[3].resolveWith({
    selected_artist: 'A.C.T',
    artist_groups: [{ artist: 'A.C.T', albums: [{ key: 'unrelated-stale-view' }] }],
    album_count: 1,
  });
  await unrelatedPromise;
  assert.equal(pendingRequests.length, 4);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryScheduled, true);

  const retryPromise = retry.callback();
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 5; attempt += 1) {
    await flushMicrotasks();
  }
  assert.equal(pendingRequests[4].url, '/view-data?artist=A.C.T');
  pendingRequests[4].resolveWith({
    selected_artist: 'A.C.T',
    artist_groups: [{ artist: 'A.C.T', albums: [{ key: 'durable-post-scan' }] }],
    album_count: 1,
  });
  await retryPromise;

  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryCount, 0);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryExhausted, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryScheduled, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryTimerId, 0);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'durable-post-scan');
});

test('deferred scan completion refresh stops after its retry cap and reports one error', async () => {
  const { context, calls, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.state.ui.pendingScanCompletionViewRefresh = true;
  context.buildApiUrl = () => '/view-data?surface=albums';

  const firstAttempt = context.dispatchPendingScanCompletionViewRefresh();
  assert.equal(pendingRequests.length, 1);
  pendingRequests[0].rejectWith(new Error('refresh failure 1'));
  await assert.doesNotReject(firstAttempt);

  const firstRetry = scheduledTimeouts[0].callback();
  assert.equal(pendingRequests.length, 2);
  pendingRequests[1].rejectWith(new Error('refresh failure 2'));
  await assert.doesNotReject(firstRetry);

  const secondRetry = scheduledTimeouts[1].callback();
  assert.equal(pendingRequests.length, 3);
  pendingRequests[2].rejectWith(new Error('refresh failure 3'));
  await assert.doesNotReject(secondRetry);
  await flushMicrotasks();

  assert.deepEqual(scheduledTimeouts.map((entry) => entry.delayMs), [1000, 3000]);
  assert.equal(pendingRequests.length, 3);
  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, true);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryCount, 2);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryExhausted, true);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryScheduled, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryTimerId, 0);
  assert.equal(calls.consoleErrors.length, 1);
  assert.match(String(calls.consoleErrors[0][0]), /Failed to refresh the gallery/);
  assert.deepEqual(calls.showToast, [{
    message: 'Unable to refresh the gallery after the library scan.',
    level: 'error',
    durationMs: 3200,
  }]);

  const exhaustedAttempt = await context.dispatchPendingScanCompletionViewRefresh();
  assert.equal(exhaustedAttempt, false);
  assert.equal(pendingRequests.length, 3);
  assert.equal(scheduledTimeouts.length, 2);
  assert.equal(calls.consoleErrors.length, 1);
  assert.equal(calls.showToast.length, 1);
});

test('a future scan cancels a live retry and its stale callback cannot dispatch', async () => {
  const { context, calls, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.ui.pendingScanCompletionViewRefresh = true;

  const failedRefresh = context.dispatchPendingScanCompletionViewRefresh();
  pendingRequests[0].rejectWith(new Error('first scan refresh failed'));
  await failedRefresh;
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryScheduled, true);
  const staleRetry = scheduledTimeouts[0];

  context.state.wasPollingBusy = true;
  context.state.wasCoverPollingBusy = false;
  const futureScanStatus = context.pollStatus();
  pendingRequests[1].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 3; attempt += 1) {
    await flushMicrotasks();
  }

  assert.deepEqual(calls.clearedTimeouts, [1]);
  const staleResult = await staleRetry.callback();
  assert.equal(staleResult, false);
  assert.equal(pendingRequests.length, 3);
  pendingRequests[2].resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'future-scan-result' }] }],
    album_count: 1,
  });
  await futureScanStatus;

  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'future-scan-result');
  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryScheduled, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryCount, 0);
});

test('retry timer waits for an unrelated active request to settle without aborting it', async () => {
  const { context, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.ui.pendingScanCompletionViewRefresh = true;

  const failedRefresh = context.dispatchPendingScanCompletionViewRefresh();
  pendingRequests[0].rejectWith(new Error('initial refresh failure'));
  await failedRefresh;
  const retry = scheduledTimeouts[0];

  const unrelatedRequest = context.fetchAndRender('/view-data?artist=Unrelated', true);
  assert.equal(pendingRequests.length, 2);
  const retryResult = await retry.callback();
  assert.equal(retryResult, false);
  assert.equal(pendingRequests.length, 2);
  assert.equal(pendingRequests[1].options.signal.aborted, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, true);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryScheduled, false);

  pendingRequests[1].resolveWith({
    selected_artist: 'Unrelated',
    artist_groups: [{ artist: 'Unrelated', albums: [{ key: 'unrelated-result' }] }],
    album_count: 1,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 3; attempt += 1) {
    await flushMicrotasks();
  }
  assert.equal(pendingRequests.length, 3);
  assert.equal(pendingRequests[2].url, '/view-data?surface=albums');
  pendingRequests[2].resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'post-scan-result' }] }],
    album_count: 1,
  });
  await unrelatedRequest;

  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'post-scan-result');
  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryCount, 0);
});

test('failed recovery refresh stays bounded and later idle polls do not restart it', async () => {
  const { context, calls, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.wasPollingBusy = true;
  context.state.wasCoverPollingBusy = false;

  const transitionPoll = context.pollStatus();
  pendingRequests[0].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 2; attempt += 1) {
    await flushMicrotasks();
  }
  pendingRequests[1].rejectWith(new Error('recovery refresh failure 1'));
  await transitionPoll;
  assert.equal(context.state.wasPollingBusy, false);
  assert.equal(scheduledTimeouts[0].delayMs, 1000);

  const repeatedIdlePoll = context.pollStatus();
  pendingRequests[2].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  await repeatedIdlePoll;
  assert.equal(pendingRequests.length, 3);

  const firstRetry = scheduledTimeouts[0].callback();
  assert.equal(pendingRequests.length, 4);
  pendingRequests[3].rejectWith(new Error('recovery refresh failure 2'));
  await firstRetry;
  const secondRetry = scheduledTimeouts[scheduledTimeouts.length - 1];
  assert.equal(secondRetry.delayMs, 3000);
  const secondRetryPromise = secondRetry.callback();
  assert.equal(pendingRequests.length, 5);
  pendingRequests[4].rejectWith(new Error('recovery refresh failure 3'));
  await secondRetryPromise;

  const idleAfterExhaustion = context.pollStatus();
  pendingRequests[5].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  await idleAfterExhaustion;

  assert.equal(pendingRequests.length, 6);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryExhausted, true);
  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, true);
  assert.equal(calls.consoleErrors.length, 1);
  assert.equal(calls.showToast.filter((entry) => entry.level === 'error').length, 1);
});

test('a later scan completion recovers an exhausted deferred gallery refresh', async () => {
  const { context, calls, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.wasPollingBusy = true;
  context.state.wasCoverPollingBusy = false;
  context.state.ui.pendingScanCompletionViewRefresh = true;
  context.state.ui.pendingScanCompletionViewRefreshRetryCount = 2;
  context.state.ui.pendingScanCompletionViewRefreshRetryExhausted = true;
  context.state.ui.pendingScanCompletionViewRefreshRetryScheduled = false;
  context.state.ui.pendingScanCompletionViewRefreshRetryToken = 7;

  const statusPromise = context.pollStatus();
  pendingRequests[0].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 2; attempt += 1) {
    await flushMicrotasks();
  }
  assert.equal(pendingRequests[1].url, '/view-data?surface=albums');
  pendingRequests[1].resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'durable-after-later-scan' }] }],
    album_count: 1,
  });
  await statusPromise;

  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryCount, 0);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryExhausted, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryScheduled, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryToken, 8);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'durable-after-later-scan');
  assert.equal(calls.consoleErrors.length, 0);
  assert.equal(scheduledTimeouts.filter((entry) => entry.delayMs === 1000).length, 0);
});

test('pollStatus replaces queued startup hydration with the current view after scan completion', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.awaitingInitialDataRefresh = true;
  context.state.wasPollingBusy = true;
  context.state.wasCoverPollingBusy = false;
  context.state.ui.pendingStartupHydrationFollowup = {
    endpoint: '/view-data?surface=albums&omit_sidebar=1',
    options: {
      startupRefresh: true,
      startupHydrationTier: 'full',
    },
  };

  const statusPromise = context.pollStatus();
  assert.equal(pendingRequests.length, 1);
  assert.equal(pendingRequests[0].url, '/status');
  pendingRequests[0].resolveWith({
    covers_in_progress: false,
    scan_in_progress: false,
    relations_in_progress: false,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 2; attempt += 1) {
    await flushMicrotasks();
  }

  assert.equal(pendingRequests.length, 2);
  assert.equal(pendingRequests[1].url, '/view-data?surface=albums');
  pendingRequests[1].resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'spell-blanket' }] }],
    album_count: 1,
  });
  await statusPromise;
  await flushMicrotasks();

  assert.equal(context.state.awaitingInitialDataRefresh, false);
  assert.equal(context.state.ui.pendingStartupHydrationFollowup, null);
  assert.equal(context.state.view.album_count, 1);
  assert.deepEqual(calls.fetchRequests.map((request) => request.url), [
    '/status',
    '/view-data?surface=albums',
  ]);
});

test('renderView preserves the local draft query instead of overwriting it from the committed view', () => {
  const { context, runtimeRenderView, searchInput } = createContext();
  context.state.view.query = 'Broadcast';
  context.state.ui.searchDraftQuery = 'Broad';

  runtimeRenderView();

  assert.equal(searchInput.value, 'Broad');
});

test('renderView preserves gallery display and scale through search form hidden inputs', () => {
  const { context, runtimeRenderView, hiddenInputs } = createContext();
  context.state.view = {
    ...context.state.view,
    selected_artist: 'Broadcast',
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'new_arrivals'],
    gallery_display_mode: 'covers',
    gallery_scale_percent: 135,
  };

  runtimeRenderView();

  assert.deepEqual(
    hiddenInputs.map((input) => [input.name, input.value]),
    [
      ['artist', 'Broadcast'],
      ['gallery_scope', 'all'],
      ['gallery_display', 'covers'],
      ['gallery_scale_percent', '135'],
      ['category', 'main_library'],
      ['category', 'new_arrivals'],
    ],
  );
});

test('triggerLibraryRefresh still posts a full rescan when the indicator class is stale busy but state is idle', async () => {
  const { context, calls, pendingRequests, scanIndicator } = createContext();
  scanIndicator.classList.add('is-busy');
  scanIndicator.classList.remove('is-done');
  context.state.status = {
    scan_in_progress: false,
    relations_in_progress: false,
    covers_in_progress: false,
  };
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return delayMs;
  };

  const refreshPromise = context.triggerLibraryRefresh(true);
  assert.equal(pendingRequests.length, 1);
  assert.equal(calls.fetchRequests[0].url, '/refresh-api');
  assert.equal(calls.fetchRequests[0].options.method, 'POST');

  pendingRequests[0].resolveWith({ ok: true, full_rescan: true });
  await refreshPromise;
  await flushMicrotasks();

  assert.equal(context.state.ui.forceScanPageVisible, false);
  assert.deepEqual(calls.renderLibraryLoader, []);
  assert.deepEqual(calls.showToast, [
    { message: 'Library scan started.', level: 'success', durationMs: 2200 },
  ]);
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(scheduledTimeouts[0].delayMs, 250);
});

test('triggerLibraryRefresh still posts a full rescan while view data is busy', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.state.busy = true;
  context.state.status = {
    scan_in_progress: false,
    relations_in_progress: false,
    covers_in_progress: false,
  };
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return delayMs;
  };

  const refreshPromise = context.triggerLibraryRefresh(true);

  assert.equal(pendingRequests.length, 1);
  assert.equal(calls.fetchRequests[0].url, '/refresh-api');
  assert.equal(calls.fetchRequests[0].options.method, 'POST');

  pendingRequests[0].resolveWith({ ok: true, full_rescan: true });
  await refreshPromise;
  await flushMicrotasks();

  assert.deepEqual(calls.renderLibraryLoader, []);
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(scheduledTimeouts[0].delayMs, 250);
});

test('triggerLibraryRefresh posts an incremental refresh while view data is busy', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.state.busy = true;
  context.state.status = {
    scan_in_progress: false,
    relations_in_progress: false,
    covers_in_progress: false,
  };
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return delayMs;
  };

  const refreshPromise = context.triggerLibraryRefresh(false);

  assert.equal(pendingRequests.length, 1);
  assert.equal(calls.fetchRequests[0].url, '/refresh-api');
  assert.equal(calls.fetchRequests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls.fetchRequests[0].options.body), { full_rescan: false });
  assert.equal(context.state.ui.forceScanPageVisible, false);

  pendingRequests[0].resolveWith({ ok: true, full_rescan: false });
  await refreshPromise;
  await flushMicrotasks();

  assert.deepEqual(calls.renderLibraryLoader, []);
  assert.deepEqual(calls.showToast, [
    { message: 'Library scan started.', level: 'success', durationMs: 2200 },
  ]);
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(scheduledTimeouts[0].delayMs, 250);
});

for (const fullRescan of [false, true]) {
  test(`triggerLibraryRefresh does not auto-open Scan Page for ${fullRescan ? 'full' : 'incremental'} scan`, async () => {
    const { context, pendingRequests } = createContext();
    context.state.status = {
      scan_in_progress: false,
      relations_in_progress: false,
      covers_in_progress: false,
    };

    const refreshPromise = context.triggerLibraryRefresh(fullRescan);
    assert.equal(pendingRequests.length, 1);
    pendingRequests[0].resolveWith({ ok: true, full_rescan: fullRescan });
    await refreshPromise;
    await flushMicrotasks();

    assert.equal(context.state.ui.forceScanPageVisible, false);
  });
}

test('triggerLibraryRefresh reports an already-running scan without posting another request', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.state.status = {
    scan_in_progress: true,
    relations_in_progress: false,
    covers_in_progress: false,
  };

  await context.triggerLibraryRefresh(false);

  assert.equal(pendingRequests.length, 0);
  assert.deepEqual(calls.fetchRequests, []);
  assert.deepEqual(calls.showToast, [{
    message: 'Library scan is already running.',
    level: 'info',
    durationMs: 2200,
  }]);
});

for (const [busyField, label] of [
  ['scan_in_progress', 'scan'],
  ['relations_in_progress', 'relation'],
  ['covers_in_progress', 'cover'],
]) {
  test(`triggerLibraryRefresh keeps a busy ${label} indicator left-click inert`, async () => {
    const { context, calls, pendingRequests } = createContext();
    context.state.status = {
      scan_in_progress: false,
      relations_in_progress: false,
      covers_in_progress: false,
      [busyField]: true,
    };

    const refreshPromise = context.triggerLibraryRefresh(false);
    const requestCount = pendingRequests.length;
    if (pendingRequests[0]) {
      pendingRequests[0].resolveWith({ ok: true, full_rescan: false });
    }
    const result = await refreshPromise;

    assert.equal(result, false);
    assert.equal(requestCount, 0);
    assert.deepEqual(calls.fetchRequests, []);
  });
}

test('openScanPage visually clears search, selection, and family context while retaining it for Back', () => {
  const { context, calls, searchInput } = createContext();
  const originalView = {
    ...context.state.view,
    query: 'Neal',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse::sola-scriptura' }],
    }],
    family_artist_groups: [{
      artist: 'The Neal Morse Band',
      albums: [{ key: 'the-neal-morse-band::innocence-and-danger' }],
    }],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse::sola-scriptura' }],
    }],
    related_filter_artists: ['The Neal Morse Band'],
    primary_filter_active: true,
  };
  context.state.view = JSON.parse(JSON.stringify(originalView));
  context.state.status = {
    scan_in_progress: false,
    relations_in_progress: false,
    covers_in_progress: false,
  };
  context.state.ui.searchDraftQuery = 'Neal';
  searchInput.value = 'Neal';

  context.openScanPage();

  assert.equal(context.state.ui.forceScanPageVisible, true);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view)), originalView);
  assert.ok(context.state.ui.scanPageReturnContext);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.ui.scanPageReturnContext.view)),
    originalView,
  );
  assert.equal(context.state.ui.scanPageReturnContext.searchDraftQuery, 'Neal');
  assert.equal(searchInput.value, '');
  assert.equal(calls.renderLibraryLoader.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.renderLibraryLoaderOptions)),
    [{ scanPageVisible: true }],
  );

  assert.equal(typeof context.closeScanPage, 'function');
  context.closeScanPage();

  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view)), originalView);
  assert.equal(context.state.ui.searchDraftQuery, 'Neal');
  assert.equal(searchInput.value, 'Neal');
  assert.equal(context.state.ui.forceScanPageVisible, false);
  assert.equal(context.state.ui.scanPageReturnContext ?? null, null);
});

test('Scan Page suspends hidden gallery cover work until the user leaves it', () => {
  const { context } = createContext();
  const coverLoadCalls = [];
  context.virtualGrid = {
    suspendSelectedArtistCoverLoadsForUserAction() {
      coverLoadCalls.push(['suspend']);
      return 41;
    },
    resumeSelectedArtistCoverLoadsAfterUserAction(token) {
      coverLoadCalls.push(['resume', token]);
      return true;
    },
  };

  context.openScanPage();

  assert.equal(context.state.ui.scanPageCoverLoadSuspensionToken, 41);
  assert.deepEqual(coverLoadCalls, [['suspend']]);

  context.closeScanPage();

  assert.equal(context.state.ui.scanPageCoverLoadSuspensionToken, 0);
  assert.deepEqual(coverLoadCalls, [['suspend'], ['resume', 41]]);
});

test('abandonScanPageForNavigation discards Back restoration and neutralizes selection state before navigation', () => {
  const { context, calls, searchInput } = createContext();
  const aborts = [];
  const historyReplacements = [];
  context.window = {
    location: {
      href: 'http://localhost/?surface=home&q=Navigation',
    },
    history: {
      state: { source: 'navigation' },
      replaceState(...args) {
        historyReplacements.push(args);
      },
    },
  };
  context.state.view = {
    ...context.state.view,
    query: 'Navigation',
    selected_artist: 'Stale Artist',
    all_artists_active: true,
    related_filter_artists: ['Stale Relative'],
    primary_filter_active: true,
    related_artists: ['Stale Relative'],
    primary_artist_groups: [{
      artist: 'Stale Artist',
      albums: [{ key: 'stale-primary' }],
    }],
    family_artist_groups: [{
      artist: 'Stale Relative',
      albums: [{ key: 'stale-family' }],
    }],
    navigation_marker: 'current-view',
  };
  context.state.ui.scanPageReturnContext = {
    view: {
      query: 'Saved query',
      selected_artist: 'Saved Artist',
      navigation_marker: 'saved-view',
    },
    searchDraftQuery: 'Saved draft',
    url: 'http://localhost/?surface=albums&q=Saved+query&artist=Saved+Artist',
  };
  context.state.ui.forceScanPageVisible = true;
  context.state.ui.searchDraftQuery = 'Navigation draft';
  context.state.ui.viewStateRevision = 7;
  context.state.ui.activeViewRequestController = {
    abort() {
      aborts.push('abort');
    },
  };
  searchInput.value = 'Navigation draft';

  context.abandonScanPageForNavigation({ clearSelection: true });

  assert.equal(context.state.ui.scanPageReturnContext, null);
  assert.equal(context.state.ui.forceScanPageVisible, false);
  assert.equal(context.state.ui.viewStateRevision, 8);
  assert.deepEqual(aborts, ['abort']);
  assert.equal(context.state.ui.searchDraftQuery, 'Navigation draft');
  assert.equal(searchInput.value, 'Navigation draft');
  assert.equal(context.window.location.href, 'http://localhost/?surface=home&q=Navigation');
  assert.deepEqual(historyReplacements, []);
  assert.equal(context.state.view.query, 'Navigation');
  assert.equal(context.state.view.navigation_marker, 'current-view');
  assert.equal(context.state.view.selected_artist, '');
  assert.equal(context.state.view.all_artists_active, false);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.related_filter_artists)), []);
  assert.equal(context.state.view.primary_filter_active, false);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.related_artists)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.primary_artist_groups)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.family_artist_groups)), []);
  assert.deepEqual(calls.fetchRequests, []);
});
test('closeScanPage preserves a canonical view refreshed while Scan Page is open', () => {
  const { context, searchInput } = createContext();
  context.state.view = {
    ...context.state.view,
    query: 'Neal',
    selected_artist: 'Neal Morse',
    album_count: 1,
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse::sola-scriptura', title: 'Sola Scriptura' }],
    }],
  };
  context.state.ui.searchDraftQuery = 'Neal';
  searchInput.value = 'Neal';

  context.openScanPage();

  context.state.view = JSON.parse(JSON.stringify({
    ...context.state.view,
    album_count: 2,
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'neal-morse::question-mark', title: '?' }],
    }],
  }));

  context.closeScanPage();

  assert.equal(context.state.view.album_count, 2);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'neal-morse::question-mark');
  assert.equal(context.state.ui.searchDraftQuery, 'Neal');
  assert.equal(searchInput.value, 'Neal');
  assert.equal(context.state.ui.forceScanPageVisible, false);
  assert.equal(context.state.ui.scanPageReturnContext ?? null, null);
});

test('closeScanPage retains mounted gallery nodes when Back restores the same active-scan topology', () => {
  const {
    context,
    calls,
    artistGroups,
  } = createContext();
  const retainedView = {
    ...context.state.view,
    query: '',
    selected_artist: '',
    album_count: 1,
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons', name: 'Tender Buttons' }],
    }],
  };
  context.state.view = JSON.parse(JSON.stringify(retainedView));
  artistGroups.querySelectorAll = (selector) => (
    selector === '.album-card' ? [{ dataset: { albumKey: 'broadcast::tender-buttons' } }] : []
  );

  context.openScanPage();
  context.closeScanPage();

  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.renderView[0])),
    { preserveMountedGallery: true },
  );
});

test('closeScanPage rejects a structurally blank in-flight gallery and restores the retained usable view', () => {
  const { context, searchInput } = createContext();
  vm.runInContext(viewValueHelperSource, context, { filename: viewValueHelperPath });
  const retainedView = {
    ...context.state.view,
    query: 'Neal',
    selected_artist: 'Neal Morse',
    album_count: 1,
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{
        key: 'neal-morse::sola-scriptura',
        name: 'Sola Scriptura',
      }],
    }],
  };
  context.state.view = JSON.parse(JSON.stringify(retainedView));
  context.state.ui.searchDraftQuery = 'Neal';
  searchInput.value = 'Neal';

  context.openScanPage();
  context.state.view = {
    ...context.state.view,
    album_count: 1,
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{}],
    }],
  };

  context.closeScanPage();

  assert.equal(context.state.view.album_count, 1);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'neal-morse::sola-scriptura');
  assert.equal(context.state.view.artist_groups[0].albums[0].name, 'Sola Scriptura');
  assert.equal(context.state.ui.searchDraftQuery, 'Neal');
  assert.equal(searchInput.value, 'Neal');
  assert.equal(context.state.ui.forceScanPageVisible, false);
  assert.equal(context.state.ui.scanPageReturnContext ?? null, null);
});

test('closeScanPage restores the retained cover-complete gallery when cancellation leaves a cover-incomplete current view', () => {
  const {
    context,
    calls,
    searchInput,
    artistGroups,
  } = createContext();
  vm.runInContext(viewValueHelperSource, context, { filename: viewValueHelperPath });
  artistGroups.querySelectorAll = (selector) => (
    selector === '.album-card' ? [{ dataset: { albumKey: 'neal-morse::sola-scriptura' } }] : []
  );
  const retainedView = {
    ...context.state.view,
    query: 'Neal',
    selected_artist: 'Neal Morse',
    album_count: 2,
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [
        {
          key: 'neal-morse::sola-scriptura',
          name: 'Sola Scriptura',
          cover_path: 'C:\\Music\\Neal Morse\\Sola Scriptura\\cover.jpg',
        },
        {
          key: 'neal-morse::question-mark',
          name: '?',
          cover_path: 'C:\\Music\\Neal Morse\\Question Mark\\cover.jpg',
        },
      ],
    }],
  };
  context.state.view = JSON.parse(JSON.stringify(retainedView));
  context.state.ui.searchDraftQuery = 'Neal';
  searchInput.value = 'Neal';

  context.openScanPage();
  context.state.ui.scanPageReturnContext.scanCancelled = true;
  context.state.view = {
    ...context.state.view,
    album_count: 2,
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [
        {
          key: 'neal-morse::sola-scriptura',
          name: 'Sola Scriptura',
          cover_path: 'C:\\Music\\Neal Morse\\Sola Scriptura\\cover.jpg',
        },
        {
          key: 'neal-morse::question-mark',
          name: '?',
          cover_path: '',
        },
      ],
    }],
  };

  context.closeScanPage();

  const normalizedCloseResult = JSON.parse(JSON.stringify({
    albums: context.state.view.artist_groups[0].albums,
    renderViewOptions: calls.renderView[0],
  }));
  assert.deepEqual(normalizedCloseResult, {
    albums: retainedView.artist_groups[0].albums,
    renderViewOptions: { preserveMountedGallery: true },
  }, 'Cancellation Back must restore all retained cover authority without remounting decoded gallery images.');
  assert.equal(context.state.ui.searchDraftQuery, 'Neal');
  assert.equal(searchInput.value, 'Neal');
});

test('closeScanPage remounts a retained cancelled gallery when no album cards remain mounted', () => {
  const {
    context,
    calls,
    searchInput,
    artistGroups,
  } = createContext();
  vm.runInContext(viewValueHelperSource, context, { filename: viewValueHelperPath });
  artistGroups.innerHTML = '<section class="artist-section"></section>';
  artistGroups.querySelectorAll = () => [];
  const retainedView = {
    ...context.state.view,
    query: 'ДДТ',
    selected_artist: 'Андрей Васильев и "Дубы-Колдуны"',
    album_count: 1,
    artist_groups: [{
      artist: 'Андрей Васильев и "Дубы-Колдуны"',
      albums: [{
        key: 'дубы-колдуны::там-за-окном',
        name: 'Там, за окном',
        cover_path: 'C:\\Music\\ДДТ\\Там, за окном\\cover.jpg',
      }],
    }],
  };
  context.state.view = JSON.parse(JSON.stringify(retainedView));
  context.state.ui.searchDraftQuery = 'ДДТ';
  searchInput.value = 'ДДТ';

  context.openScanPage();
  context.state.ui.scanPageReturnContext.scanCancelled = true;
  context.closeScanPage();

  assert.equal(calls.renderView.length, 1);
  assert.equal(
    calls.renderView[0],
    undefined,
    'Cancellation Back must remount a usable retained view when the gallery DOM has no album cards.',
  );
  assert.equal(context.state.view.album_count, 1);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'дубы-колдуны::там-за-окном');
  assert.equal(context.state.ui.searchDraftQuery, 'ДДТ');
  assert.equal(searchInput.value, 'ДДТ');
});

test('cancelLibraryScan records regular scan cancellation so the next idle poll cannot report scan success', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.state.status = {
    ...context.state.status,
    scan_in_progress: true,
    scan_mode: 'background',
  };
  context.state.ui.scanPageReturnContext = {
    view: JSON.parse(JSON.stringify(context.state.view)),
  };

  const cancelPromise = context.cancelLibraryScan();
  pendingRequests[0].resolveWith({
    ok: true,
    cancelled: true,
  });
  await cancelPromise;

  assert.equal(context.state.ui.scanCancellationAcknowledged, true);
  assert.equal(context.state.ui.scanPageReturnContext.scanCancelled, true);
  assert.equal(context.state.status.scan_in_progress, false);
  assert.deepEqual(calls.showToast, [{
    message: 'Scan cancelled.',
    level: 'success',
    durationMs: 2600,
  }]);
});

test('cancelLibraryScan reports full-rescan failures with mode-aware language and allows retry', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.state.status = {
    ...context.state.status,
    scan_in_progress: true,
    scan_mode: 'manual_full_rescan',
  };

  const firstCancelPromise = context.cancelLibraryScan();
  const duplicateCancelPromise = context.cancelLibraryScan();
  assert.equal(pendingRequests.length, 1);
  assert.equal(await duplicateCancelPromise, false);
  pendingRequests[0].rejectWith(new Error('Cancel transport failed.'));
  assert.equal(await firstCancelPromise, false);
  assert.deepEqual(calls.showToast, [{
    message: 'Cancel transport failed.',
    level: 'error',
    durationMs: 3200,
  }]);

  const retryPromise = context.cancelLibraryScan();
  assert.equal(pendingRequests.length, 2);
  pendingRequests[1].resolveWith({
    ok: false,
    status: 503,
  });
  assert.equal(await retryPromise, false);
  assert.deepEqual(calls.showToast.at(-1), {
    message: 'Failed to cancel full rescan (503).',
    level: 'error',
    durationMs: 3200,
  });
});

test('cancelLibraryScan confirms full-rescan cancellation with full-rescan language', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.state.status = {
    ...context.state.status,
    scan_in_progress: true,
    scan_mode: 'manual_full_rescan',
  };

  const cancelPromise = context.cancelLibraryScan();
  pendingRequests[0].resolveWith({
    ok: true,
    cancelled: true,
  });
  await cancelPromise;

  assert.deepEqual(calls.showToast, [{
    message: 'Full rescan cancelled.',
    level: 'success',
    durationMs: 2600,
  }]);
});

test('scan completion releases the scan page while cover follow-up continues', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.ui.forceScanPageVisible = true;
  context.state.wasPollingBusy = true;
  context.state.wasCoverPollingBusy = false;
  context.state.view = {
    ...context.state.view,
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'existing' }] }],
    album_count: 1,
  };

  const statusPromise = context.pollStatus();
  pendingRequests[0].resolveWith({
    scan_in_progress: false,
    scan_processed: 10,
    scan_total: 10,
    relations_in_progress: false,
    covers_in_progress: true,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 2; attempt += 1) {
    await flushMicrotasks();
  }
  pendingRequests[1].resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'completed' }] }],
    album_count: 1,
  });
  await statusPromise;

  assert.equal(context.state.ui.forceScanPageVisible, false);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'completed');
  assert.deepEqual(calls.showToast, [{
    message: 'Library scan complete.',
    level: 'success',
    durationMs: 3200,
  }]);
});

test('scan finalization releases and previews the gallery without reporting backend completion', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.ui.forceScanPageVisible = true;
  context.state.wasPollingBusy = true;
  context.state.view = {
    ...context.state.view,
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'existing' }] }],
    album_count: 1,
  };

  const statusPromise = context.pollStatus();
  pendingRequests[0].resolveWith({
    scan_in_progress: true,
    scan_phase: 'finalizing',
    scan_processed: 3000,
    scan_total: 3000,
    relations_in_progress: false,
    covers_in_progress: false,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 2; attempt += 1) {
    await flushMicrotasks();
  }
  assert.equal(
    context.state.ui.pendingScanCompletionViewRefreshEligibleRequestId || 0,
    0,
    'Without an active full foreground request, finalization must not wait for coalescing.',
  );
  assert.deepEqual(
    pendingRequests.map((request) => request.url),
    ['/status', '/view-data?surface=albums'],
    'An idle finalization edge must dispatch its gallery preview immediately.',
  );
  pendingRequests[1].resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'finalized' }] }],
    album_count: 1,
  });
  await statusPromise;

  assert.equal(context.state.status.scan_in_progress, true);
  assert.equal(context.state.ui.forceScanPageVisible, false);
  assert.equal(context.state.wasPollingBusy, true);
  assert.equal(context.state.wasScanFinalizing, true);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'finalized');
  assert.deepEqual(calls.showToast, []);
});

async function createSettledCanonicalSearchDuringScan({
  scanGeneration = 41,
  viewStateRevision = 7,
} = {}) {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => 0;
  context.buildApiUrl = () => (
    '/view-data?surface=albums&q=Scan%20Artist%2000&artist=Scan%20Artist%20001'
  );
  context.state.ui.viewStateRevision = viewStateRevision;
  context.state.view = {
    ...context.state.view,
    query: '',
    selected_artist: '',
    artist_groups: [{
      artist: 'Scan Artist 001',
      albums: [{ key: 'before-canonical-search' }],
    }],
    album_count: 1,
  };

  const indexingPoll = context.pollStatus();
  pendingRequests[0].resolveWith({
    scan_in_progress: true,
    scan_phase: 'indexing',
    scan_generation: scanGeneration,
    scan_processed: 3000,
    scan_total: 3000,
    relations_in_progress: false,
    covers_in_progress: false,
  });
  await indexingPoll;

  const searchPromise = context.fetchAndRender(
    '/view-data?surface=albums&q=Scan%20Artist%2000',
    true,
    { preserveScroll: true },
  );
  pendingRequests[1].resolveWith({
    payload_tier: 'full',
    initial_view_partial: false,
    query: 'Scan Artist 00',
    selected_artist: 'Scan Artist 001',
    primary_artist_groups: [{
      artist: 'Scan Artist 001',
      albums: [{ key: 'canonical-search-result' }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Scan Artist 001',
      albums: [{ key: 'canonical-search-result' }],
    }],
    album_count: 1,
    artist_count: 1,
  });
  assert.equal(await searchPromise, true);
  assert.equal(context.state.busy, false);
  assert.equal(context.state.ui.viewStateRevision, viewStateRevision);
  assert.equal(context.state.view.selected_artist, 'Scan Artist 001');
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'canonical-search-result');

  return {
    calls,
    context,
    pendingRequests,
    scanGeneration,
    viewStateRevision,
  };
}

async function observeFinalizingAfterSettledCanonicalSearch(
  scenario,
  {
    scanGeneration = scenario.scanGeneration,
    serialResultKey = 'serial-finalizing-refresh',
  } = {},
) {
  const {
    context,
    pendingRequests,
  } = scenario;
  const requestCountBeforePoll = pendingRequests.length;
  const statusPromise = context.pollStatus();
  assert.equal(pendingRequests[requestCountBeforePoll].url, '/status');
  pendingRequests[requestCountBeforePoll].resolveWith({
    scan_in_progress: true,
    scan_phase: 'finalizing',
    scan_generation: scanGeneration,
    scan_processed: 3000,
    scan_total: 3000,
    relations_in_progress: false,
    covers_in_progress: false,
  });
  for (
    let attempt = 0;
    attempt < 5 && pendingRequests.length < requestCountBeforePoll + 2;
    attempt += 1
  ) {
    await flushMicrotasks();
  }
  const serialRefresh = pendingRequests[requestCountBeforePoll + 1] || null;
  if (serialRefresh) {
    serialRefresh.resolveWith({
      payload_tier: 'full',
      initial_view_partial: false,
      query: 'Scan Artist 00',
      selected_artist: 'Scan Artist 001',
      primary_artist_groups: [{
        artist: 'Scan Artist 001',
        albums: [{ key: serialResultKey }],
      }],
      family_artist_groups: [],
      artist_groups: [{
        artist: 'Scan Artist 001',
        albums: [{ key: serialResultKey }],
      }],
      album_count: 1,
      artist_count: 1,
    });
  }
  await statusPromise;
  return serialRefresh;
}

test('a canonical full search settled after the prior status observation satisfies same-generation finalization', async () => {
  const scenario = await createSettledCanonicalSearchDuringScan();
  scenario.context.state.ui.pendingScanCompletionViewRefreshRetryCount = 2;
  scenario.context.state.ui.pendingScanCompletionViewRefreshRetryExhausted = true;

  const serialRefresh = await observeFinalizingAfterSettledCanonicalSearch(scenario);

  assert.equal(
    serialRefresh,
    null,
    'The same-generation canonical apply is newer than the prior status observation and must suppress q-plus-artist refresh.',
  );
  assert.deepEqual(
    scenario.calls.fetchRequests.map((request) => request.url),
    [
      '/status',
      '/view-data?surface=albums&q=Scan%20Artist%2000',
      '/status',
    ],
  );
  assert.equal(scenario.context.state.ui.pendingScanCompletionViewRefresh, false);
  assert.equal(scenario.context.state.ui.pendingScanCompletionViewRefreshRetryCount, 0);
  assert.equal(scenario.context.state.ui.pendingScanCompletionViewRefreshRetryExhausted, false);
  assert.equal(scenario.context.state.ui.pendingScanCompletionViewRefreshRetryScheduled, false);
  assert.equal(scenario.context.state.ui.pendingScanCompletionViewRefreshRetryTimerId || 0, 0);
  assert.equal(scenario.context.state.view.artist_groups[0].albums[0].key, 'canonical-search-result');
});

test('an active startup sidebar request prevents a settled full search from suppressing finalization reconciliation', async () => {
  const scenario = await createSettledCanonicalSearchDuringScan();
  const partialPromise = scenario.context.fetchAndRender(
    '/view-data?surface=albums&q=Scan%20Artist%2000&payload_tier=sidebar',
    false,
    {
      preserveScroll: true,
      startupRefresh: true,
      startupHydrationTier: 'sidebar',
    },
  );
  const partialRequestId = scenario.context.state.ui.activeViewRequestId;
  assert.equal(scenario.pendingRequests[2].url.includes('payload_tier=sidebar'), true);

  const finalizingPoll = scenario.context.pollStatus();
  scenario.pendingRequests[3].resolveWith({
    scan_in_progress: true,
    scan_phase: 'finalizing',
    scan_generation: scenario.scanGeneration,
    scan_processed: 3000,
    scan_total: 3000,
    relations_in_progress: false,
    covers_in_progress: false,
  });
  await finalizingPoll;
  const pendingAfterFinalizing = scenario.context.state.ui.pendingScanCompletionViewRefresh;
  const eligibleRequestIdAfterFinalizing = Number(
    scenario.context.state.ui.pendingScanCompletionViewRefreshEligibleRequestId || 0,
  );

  scenario.pendingRequests[2].resolveWith({
    payload_tier: 'sidebar',
    initial_view_partial: true,
    query: 'Scan Artist 00',
    selected_artist: 'Scan Artist 001',
    artists_sidebar: [{ artist: 'Scan Artist 001', count: 1 }],
    artist_groups: [],
    album_count: 0,
    artist_count: 1,
  });
  for (let attempt = 0; attempt < 5 && scenario.pendingRequests.length < 5; attempt += 1) {
    await flushMicrotasks();
  }
  const serialRefresh = scenario.pendingRequests[4] || null;
  if (serialRefresh) {
    serialRefresh.resolveWith({
      payload_tier: 'full',
      initial_view_partial: false,
      query: 'Scan Artist 00',
      selected_artist: 'Scan Artist 001',
      primary_artist_groups: [{
        artist: 'Scan Artist 001',
        albums: [{ key: 'authoritative-after-partial' }],
      }],
      family_artist_groups: [],
      artist_groups: [{
        artist: 'Scan Artist 001',
        albums: [{ key: 'authoritative-after-partial' }],
      }],
      album_count: 1,
      artist_count: 1,
    });
  }
  await partialPromise;

  assert.equal(
    pendingAfterFinalizing,
    true,
    'An ineligible active partial request must leave finalization reconciliation pending.',
  );
  assert.equal(
    eligibleRequestIdAfterFinalizing,
    0,
    `Startup sidebar request ${partialRequestId} must not become the eligible preview owner.`,
  );
  assert.ok(serialRefresh, 'The partial request settlement must release a serial authoritative refresh.');
  assert.match(serialRefresh.url, /[?&]artist=Scan%20Artist%20001(?:&|$)/);
  assert.equal(scenario.context.state.ui.pendingScanCompletionViewRefresh, false);
  assert.equal(
    scenario.context.state.view.artist_groups[0].albums[0].key,
    'authoritative-after-partial',
  );
});

test('an intervening indexing observation makes a settled canonical search stale for finalization', async () => {
  const scenario = await createSettledCanonicalSearchDuringScan();
  const interveningPoll = scenario.context.pollStatus();
  scenario.pendingRequests[2].resolveWith({
    scan_in_progress: true,
    scan_phase: 'indexing',
    scan_generation: scenario.scanGeneration,
    scan_processed: 3000,
    scan_total: 3000,
    relations_in_progress: false,
    covers_in_progress: false,
  });
  await interveningPoll;

  const serialRefresh = await observeFinalizingAfterSettledCanonicalSearch(
    scenario,
    { serialResultKey: 'authoritative-after-intervening-status' },
  );

  assert.ok(serialRefresh);
  assert.match(serialRefresh.url, /[?&]artist=Scan%20Artist%20001(?:&|$)/);
  assert.equal(
    scenario.context.state.view.artist_groups[0].albums[0].key,
    'authoritative-after-intervening-status',
  );
});

test('a settled canonical search from another scan generation cannot satisfy finalization', async () => {
  const scenario = await createSettledCanonicalSearchDuringScan();

  const serialRefresh = await observeFinalizingAfterSettledCanonicalSearch(
    scenario,
    {
      scanGeneration: scenario.scanGeneration + 1,
      serialResultKey: 'authoritative-next-generation',
    },
  );

  assert.ok(serialRefresh);
  assert.match(serialRefresh.url, /[?&]artist=Scan%20Artist%20001(?:&|$)/);
  assert.equal(
    scenario.context.state.view.artist_groups[0].albums[0].key,
    'authoritative-next-generation',
  );
});

test('a view-state revision change invalidates a settled canonical search before finalization', async () => {
  const scenario = await createSettledCanonicalSearchDuringScan();
  scenario.context.state.ui.viewStateRevision += 1;

  const serialRefresh = await observeFinalizingAfterSettledCanonicalSearch(
    scenario,
    { serialResultKey: 'authoritative-after-view-revision' },
  );

  assert.ok(serialRefresh);
  assert.match(serialRefresh.url, /[?&]artist=Scan%20Artist%20001(?:&|$)/);
  assert.equal(
    scenario.context.state.view.artist_groups[0].albums[0].key,
    'authoritative-after-view-revision',
  );
});

test('the full foreground request active at first finalizing status consumes its own scan-completion refresh after canonical apply', async () => {
  const { context, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => 0;
  context.buildApiUrl = () => '/view-data?surface=albums&q=Neal%20Morse&artist=Neal%20Morse';
  context.state.view = {
    ...context.state.view,
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'pre-finalizing' }],
    }],
    album_count: 1,
  };

  const foregroundPromise = context.fetchAndRender(
    '/view-data?surface=albums&q=Neal%20Morse',
    false,
    { preserveScroll: true },
  );
  const eligibleRequestId = context.state.ui.activeViewRequestId;
  assert.equal(eligibleRequestId, 1);
  const statusPromise = context.pollStatus();
  assert.equal(pendingRequests.length, 2);
  pendingRequests[1].resolveWith({
    scan_in_progress: true,
    scan_phase: 'finalizing',
    scan_processed: 3000,
    scan_total: 3000,
    relations_in_progress: false,
    covers_in_progress: false,
  });
  await statusPromise;
  assert.equal(context.state.ui.activeViewRequestId, eligibleRequestId);
  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, true);
  assert.equal(
    context.state.ui.pendingScanCompletionViewRefreshEligibleRequestId,
    eligibleRequestId,
    'The first finalizing poll must bind its preview to the exact active full request.',
  );
  context.state.ui.pendingScanCompletionViewRefreshRetryCount = 2;

  pendingRequests[0].resolveWith({
    payload_tier: 'full',
    initial_view_partial: false,
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'canonical-finalizing' }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'canonical-finalizing' }],
    }],
    album_count: 1,
    artist_count: 1,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 3; attempt += 1) {
    await flushMicrotasks();
  }
  const requestCountAfterCanonicalApply = pendingRequests.length;
  if (pendingRequests[2]) {
    pendingRequests[2].resolveWith({
      payload_tier: 'full',
      initial_view_partial: false,
      query: 'Neal Morse',
      selected_artist: 'Neal Morse',
      artist_groups: [{
        artist: 'Neal Morse',
        albums: [{ key: 'redundant-serial-refresh' }],
      }],
      album_count: 1,
      artist_count: 1,
    });
  }
  await foregroundPromise;

  assert.equal(
    requestCountAfterCanonicalApply,
    2,
    'The eligible foreground response must prevent a serial q-plus-artist completion request.',
  );
  assert.deepEqual(
    pendingRequests.map((request) => request.url),
    [
      '/view-data?surface=albums&q=Neal%20Morse',
      '/status',
    ],
    'Canonical q-only apply must satisfy finalization without a follow-up q-plus-artist fetch.',
  );
  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshEligibleRequestId || 0, 0);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryCount, 0);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryExhausted, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryScheduled, false);
  assert.equal(context.state.ui.pendingScanCompletionViewRefreshRetryTimerId || 0, 0);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'canonical-finalizing');
});

test('a sidebar-tier foreground response cannot consume the finalizing scan-completion refresh', async () => {
  const { context, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => 0;
  context.buildApiUrl = () => '/view-data?surface=albums&q=Neal%20Morse&artist=Neal%20Morse';

  const foregroundPromise = context.fetchAndRender(
    '/view-data?surface=albums&q=Neal%20Morse&artist=Neal%20Morse',
    false,
    {
      preserveScroll: true,
      startupRefresh: true,
      startupHydrationTier: 'sidebar',
    },
  );
  const statusPromise = context.pollStatus();
  pendingRequests[1].resolveWith({
    scan_in_progress: true,
    scan_phase: 'finalizing',
    relations_in_progress: false,
    covers_in_progress: false,
  });
  await statusPromise;
  assert.equal(
    context.state.ui.pendingScanCompletionViewRefreshEligibleRequestId || 0,
    0,
    'A sidebar/partial request is not eligible to satisfy the finalization preview.',
  );

  pendingRequests[0].resolveWith({
    payload_tier: 'sidebar',
    initial_view_partial: true,
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    artists_sidebar: [{ artist: 'Neal Morse', count: 1 }],
    artist_groups: [],
    album_count: 0,
    artist_count: 1,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 3; attempt += 1) {
    await flushMicrotasks();
  }
  assert.equal(pendingRequests.length, 3);
  pendingRequests[2].resolveWith({
    payload_tier: 'full',
    initial_view_partial: false,
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'serial-after-sidebar' }],
    }],
    album_count: 1,
    artist_count: 1,
  });
  await foregroundPromise;

  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, false);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'serial-after-sidebar');
});

test('an aborted eligible request cannot let its superseding non-eligible request consume finalizing refresh', async () => {
  const { context, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => 0;
  context.buildApiUrl = () => '/view-data?surface=albums&q=Neal%20Morse&artist=Neal%20Morse';

  const eligiblePromise = context.fetchAndRender(
    '/view-data?surface=albums&q=Neal%20Morse&artist=Neal%20Morse',
    false,
    { preserveScroll: true },
  );
  const eligibleRequestId = context.state.ui.activeViewRequestId;
  const statusPromise = context.pollStatus();
  pendingRequests[1].resolveWith({
    scan_in_progress: true,
    scan_phase: 'finalizing',
    relations_in_progress: false,
    covers_in_progress: false,
  });
  await statusPromise;
  assert.equal(
    context.state.ui.pendingScanCompletionViewRefreshEligibleRequestId,
    eligibleRequestId,
  );

  const supersedingPromise = context.fetchAndRender(
    '/view-data?surface=albums&q=Broadcast',
    false,
    { preserveScroll: true },
  );
  assert.equal(pendingRequests[0].options.signal.aborted, true);
  assert.notEqual(context.state.ui.activeViewRequestId, eligibleRequestId);
  for (let attempt = 0; attempt < 5; attempt += 1) await flushMicrotasks();
  assert.equal(
    context.state.ui.pendingScanCompletionViewRefresh,
    true,
    'Aborting the eligible owner must leave finalization reconciliation pending.',
  );
  pendingRequests[2].resolveWith({
    payload_tier: 'full',
    initial_view_partial: false,
    query: 'Broadcast',
    selected_artist: 'Broadcast',
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'superseding-non-eligible' }],
    }],
    album_count: 1,
    artist_count: 1,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 4; attempt += 1) {
    await flushMicrotasks();
  }
  assert.equal(pendingRequests.length, 4);
  pendingRequests[3].resolveWith({
    payload_tier: 'full',
    initial_view_partial: false,
    query: 'Broadcast',
    selected_artist: 'Broadcast',
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'serial-after-abort' }],
    }],
    album_count: 1,
    artist_count: 1,
  });
  assert.equal(await eligiblePromise, false);
  await supersedingPromise;

  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, false);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'serial-after-abort');
});

test('a failed eligible foreground request retains finalizing refresh for serial recovery', async () => {
  const { context, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => 0;
  context.buildApiUrl = () => '/view-data?surface=albums&q=Neal%20Morse&artist=Neal%20Morse';

  const foregroundPromise = context.fetchAndRender(
    '/view-data?surface=albums&q=Neal%20Morse&artist=Neal%20Morse',
    false,
    { preserveScroll: true },
  );
  const statusPromise = context.pollStatus();
  pendingRequests[1].resolveWith({
    scan_in_progress: true,
    scan_phase: 'finalizing',
    relations_in_progress: false,
    covers_in_progress: false,
  });
  await statusPromise;
  assert.equal(
    context.state.ui.pendingScanCompletionViewRefreshEligibleRequestId,
    context.state.ui.activeViewRequestId,
  );

  pendingRequests[0].rejectWith(new Error('foreground request failed'));
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 3; attempt += 1) {
    await flushMicrotasks();
  }
  assert.equal(pendingRequests.length, 3);
  pendingRequests[2].resolveWith({
    payload_tier: 'full',
    initial_view_partial: false,
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{ key: 'serial-after-failure' }],
    }],
    album_count: 1,
    artist_count: 1,
  });
  await assert.rejects(foregroundPromise, /foreground request failed/);

  assert.equal(context.state.ui.pendingScanCompletionViewRefresh, false);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'serial-after-failure');
});

test('a finalization failure reconciles the authoritative gallery without showing scan success', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.wasPollingBusy = true;
  context.state.wasScanFinalizing = true;
  context.state.view = {
    ...context.state.view,
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'preview' }] }],
    album_count: 1,
  };

  const statusPromise = context.pollStatus();
  pendingRequests[0].resolveWith({
    scan_in_progress: false,
    scan_phase: 'idle',
    scan_processed: 3000,
    scan_total: 3000,
    relations_in_progress: false,
    covers_in_progress: false,
    last_error: 'Relation publication failed.',
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 2; attempt += 1) {
    await flushMicrotasks();
  }
  pendingRequests[1].resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'authoritative' }] }],
    album_count: 1,
  });
  await statusPromise;

  assert.equal(context.state.wasPollingBusy, false);
  assert.equal(context.state.wasScanFinalizing, false);
  assert.equal(context.state.status.last_error, 'Relation publication failed.');
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'authoritative');
  assert.deepEqual(calls.showToast, [{
    message: 'Last scan error: Relation publication failed.',
    level: 'error',
    durationMs: 4800,
  }]);
});

test('pollStatus toasts each observed scan error once and resets deduplication after it clears', async () => {
  const { context, calls, pendingRequests, lastError } = createContext();
  const errorText = 'Relation publication failed.';
  const toastCounts = [];

  async function pollWithLastError(lastErrorValue, scanGeneration) {
    const requestIndex = pendingRequests.length;
    const statusPromise = context.pollStatus();
    pendingRequests[requestIndex].resolveWith({
      scan_in_progress: false,
      scan_phase: 'idle',
      scan_generation: scanGeneration,
      scan_outcome: lastErrorValue ? 'failed' : 'completed',
      relations_in_progress: false,
      covers_in_progress: false,
      last_error: lastErrorValue,
    });
    await statusPromise;
    toastCounts.push(calls.showToast.length);
  }

  await pollWithLastError(errorText, 7);
  assert.equal(lastError.style.display, 'block');
  assert.equal(lastError.textContent, `Last scan error: ${errorText}`);

  await pollWithLastError(errorText, 7);
  assert.equal(lastError.style.display, 'block');
  assert.equal(lastError.textContent, `Last scan error: ${errorText}`);

  await pollWithLastError(null, 7);
  assert.equal(lastError.style.display, 'none');
  assert.equal(lastError.textContent, '');

  await pollWithLastError(errorText, 8);
  assert.equal(lastError.style.display, 'block');
  assert.equal(lastError.textContent, `Last scan error: ${errorText}`);

  assert.deepEqual(toastCounts, [1, 1, 1, 2]);
  assert.deepEqual(
    calls.prependUtilityLogHistoryEntries.map((entry) => ({
      id: entry.id,
      action: entry.action,
      level: entry.level,
      error: entry.error,
      scan_generation: entry.scan_generation,
      scan_phase: entry.scan_phase,
      scan_outcome: entry.scan_outcome,
    })),
    [
      {
        id: 'library-status-error:7',
        action: 'Library status error',
        level: 'error',
        error: errorText,
        scan_generation: 7,
        scan_phase: 'idle',
        scan_outcome: 'failed',
      },
      {
        id: 'library-status-error:8',
        action: 'Library status error',
        level: 'error',
        error: errorText,
        scan_generation: 8,
        scan_phase: 'idle',
        scan_outcome: 'failed',
      },
    ],
  );
  assert.deepEqual(calls.showToast, [
    {
      message: `Last scan error: ${errorText}`,
      level: 'error',
      durationMs: 4800,
    },
    {
      message: `Last scan error: ${errorText}`,
      level: 'error',
      durationMs: 4800,
    },
  ]);
});

test('pollStatus syncs opaque history revisions across counter-equal process restarts and skips unchanged polls', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.syncUtilityLogHistoryRevision = async (revision) => {
    calls.syncUtilityLogHistoryRevision.push(revision);
    context.state.utility.logHistoryRevision = revision;
    return { revision };
  };

  async function pollWithRevision(revision) {
    const requestIndex = pendingRequests.length;
    const statusPromise = context.pollStatus();
    pendingRequests[requestIndex].resolveWith({
      scan_in_progress: false,
      scan_phase: 'idle',
      scan_outcome: 'completed',
      relations_in_progress: false,
      covers_in_progress: false,
      last_error: null,
      log_history_revision: revision,
    });
    await statusPromise;
    await flushMicrotasks();
  }

  await pollWithRevision('process-a:4');
  await pollWithRevision('process-a:4');
  context.state.utility.logHistoryRevision = 'old-process:4';
  await pollWithRevision('new-process:4');
  context.state.utility.logHistoryRevision = 'process-b:9';
  await pollWithRevision('process-c:1');

  assert.deepEqual(calls.syncUtilityLogHistoryRevision, [
    'process-a:4',
    'new-process:4',
    'process-c:1',
  ]);
  assert.equal(context.state.utility.logHistoryRevision, 'process-c:1');
});


test('pollStatus does not duplicate a prior error when a new scan generation is running', async () => {
  const { context, calls, pendingRequests } = createContext();
  const errorText = 'Relation publication failed.';

  const failedStatusPromise = context.pollStatus();
  pendingRequests[0].resolveWith({
    scan_in_progress: false,
    scan_phase: 'idle',
    scan_generation: 7,
    scan_outcome: 'failed',
    relations_in_progress: false,
    covers_in_progress: false,
    last_error: errorText,
  });
  await failedStatusPromise;

  const runningStatusPromise = context.pollStatus();
  pendingRequests[1].resolveWith({
    scan_in_progress: true,
    scan_phase: 'scanning',
    scan_generation: 8,
    scan_outcome: 'running',
    relations_in_progress: false,
    covers_in_progress: false,
    last_error: errorText,
  });
  await runningStatusPromise;

  assert.deepEqual(
    calls.prependUtilityLogHistoryEntries.map((entry) => ({
      id: entry.id,
      scan_generation: entry.scan_generation,
      scan_outcome: entry.scan_outcome,
    })),
    [{
      id: 'library-status-error:7',
      scan_generation: 7,
      scan_outcome: 'failed',
    }],
  );
});

test('pollStatus does not wait for browser history persistence before scheduling the next poll', async () => {
  const { context, pendingRequests } = createContext();
  const scheduledTimeouts = [];
  context.scheduleBrowserTimeout = (callback, delayMs) => {
    scheduledTimeouts.push({ callback, delayMs });
    return scheduledTimeouts.length;
  };
  let releasePersistence;
  context.prependUtilityLogHistoryEntry = () => new Promise((resolve) => {
    releasePersistence = resolve;
  });

  const statusPromise = context.pollStatus();
  pendingRequests[0].resolveWith({
    scan_in_progress: false,
    scan_phase: 'idle',
    scan_generation: 12,
    scan_outcome: 'failed',
    relations_in_progress: false,
    covers_in_progress: false,
    last_error: 'A file could not be read.',
  });

  await statusPromise;
  assert.equal(typeof releasePersistence, 'function');
  assert.equal(scheduledTimeouts.length, 1);
  assert.equal(scheduledTimeouts[0].delayMs, 3000);
  releasePersistence();
});

test('a finalization cancellation reconciles the authoritative gallery without showing scan success', async () => {
  const { context, calls, pendingRequests } = createContext();
  context.scheduleBrowserTimeout = () => {};
  context.buildApiUrl = () => '/view-data?surface=albums';
  context.state.wasPollingBusy = true;
  context.state.wasScanFinalizing = true;
  context.state.view = {
    ...context.state.view,
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'preview' }] }],
    album_count: 1,
  };

  const statusPromise = context.pollStatus();
  pendingRequests[0].resolveWith({
    scan_in_progress: false,
    scan_phase: 'idle',
    scan_outcome: 'cancelled',
    scan_processed: 3000,
    scan_total: 3000,
    relations_in_progress: false,
    covers_in_progress: false,
    last_error: null,
  });
  for (let attempt = 0; attempt < 5 && pendingRequests.length < 2; attempt += 1) {
    await flushMicrotasks();
  }
  pendingRequests[1].resolveWith({
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'authoritative' }] }],
    album_count: 1,
  });
  await statusPromise;

  assert.equal(context.state.status.scan_outcome, 'cancelled');
  assert.equal(context.state.wasPollingBusy, false);
  assert.equal(context.state.wasScanFinalizing, false);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, 'authoritative');
  assert.deepEqual(calls.showToast, []);
});
