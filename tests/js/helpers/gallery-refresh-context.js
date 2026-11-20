'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadPendingProjectionFetch } = require('./pending-projection-fetch');

const helperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'gallery-refresh-and-status.js');
const helperSource = fs.readFileSync(helperPath, 'utf8');

// The real gallery refresh runtime (fetchAndRender and its request owners) in a vm context whose
// collaborators record their calls; `fetch` holds each request until the test resolves it.
function createGalleryRefreshContext() {
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
    startupFailures: 0,
    updateStatusIndicator: [],
    consoleErrors: [],
    clearedTimeouts: [],
    familyPrefetchBegins: [],
    familyPrefetchCancels: [],
    familyPrefetchPending: false,
    familyForegroundIdleChecks: [],
    speculativeDetailPrewarmCancels: 0,
    hydratedAlbumDetailInvalidations: 0,
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
    querySelector(selector) {
      return selector === '.artist-section, .album-card'
        && this.innerHTML.includes('artist-section')
        ? { className: 'artist-section' }
        : null;
    },
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
    URL,
    window: {
      AlbumHavenStartupProgress: {
        fail() { calls.startupFailures += 1; },
      },
    },
    AbortController,
    URL,
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
    invalidateAllHydratedTrackModalAlbumDetails() {
      calls.hydratedAlbumDetailInvalidations += 1;
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
              ok: payload?.responseOk ?? (payload?.ok !== false),
              status: payload?.status || 200,
              clone() {
                return { json: async () => payload };
              },
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
  transitionImage.attributes = new Map([['src', '/cover/old']]);
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
  loadPendingProjectionFetch(context);
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

// Replaces the URL stubs with the real view-state and browser-navigation helpers, so page URLs
// resolve to their real API endpoints (Home to /home-data, other views to /view-data). History
// pushes stay recorded.
function useRealViewUrls(context, origin = 'http://localhost') {
  const { pushBrowserViewState } = context;
  Object.assign(context, { URLSearchParams });
  context.window.location = { origin, href: `${origin}/`, pathname: '/', search: '', assign() {} };
  for (const name of ['view-state-helpers.js', 'browser-navigation-helpers.js']) {
    const sourcePath = path.join(path.dirname(helperPath), name);
    vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }
  context.pushBrowserViewState = pushBrowserViewState;
  return context;
}

module.exports = { createGalleryRefreshContext, useRealViewUrls };
