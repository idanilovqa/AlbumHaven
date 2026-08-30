const STARTUP_FOLLOWUP_RETRY_DELAY_MS = 100;
const STARTUP_FOLLOWUP_VISIBLE_READY_DELAY_MS = 350;
const STARTUP_FOLLOWUP_MAX_AGE_MS = 1000;
const BROWSE_SCANNED_RETRY_DELAY_MS = 500;
const BROWSE_SCANNED_MAX_RETRIES = 90;
const SCAN_COMPLETION_VIEW_REFRESH_RETRY_DELAYS_MS = Object.freeze([1000, 3000]);
const COVER_COMPLETION_VIEW_REFRESH_RETRY_DELAYS_MS = Object.freeze([1000, 3000]);
const BACKGROUND_COMPLETION_VIEW_OWNERSHIP_RETRY_LIMIT = 2;
const STATUS_POLL_FOREGROUND_IDLE_RETRY_DELAY_MS = 25;
const STATUS_POLL_VISIBLE_MENU_BUSY_DELAY_MS = 100;
let pendingSidebarRenderFrameId = 0;

function readViewStateRevision() {
  return Number(state.ui?.viewStateRevision || 0);
}

function requestOwnsCurrentViewState(requestId, requestViewStateRevision) {
  return (
    Number(state.ui?.activeViewRequestId || 0) === Number(requestId || 0)
    && readViewStateRevision() === Number(requestViewStateRevision || 0)
  );
}

function shouldAutoRefreshViewAfterCoverCompletion() {
  const query = String(state.view?.query || '').trim();
  if (query) return true;
  const selectedArtist = String(state.view?.selected_artist || '').trim();
  if (selectedArtist) return true;
  if (String(state.ui?.pendingSidebarSelectedArtist || '').trim()) return true;
  const activeRequestUrl = String(state.ui?.activeViewRequestUrl || '').trim();
  if (/(?:[?&])(?:artist|q)=[^&]+/.test(activeRequestUrl)) return true;
  return false;
}

function beginPendingViewTransition(requestId) {
  state.ui.pendingViewTransition = true;
  state.ui.pendingViewTransitionRequestId = Number(requestId || 0);
  // Keep the current gallery mounted while the replacement payload is loading.
  // Removing image sources here forced already-decoded covers to be requested and
  // decoded again after every search or artist-family transition.
  renderLibraryLoader({
    ...(state.status || {}),
    transition_in_progress: true,
    transition_detail: 'Updating the current artist view...',
  });
}

function finishPendingViewTransition(requestId, options = {}) {
  const normalizedRequestId = Number(requestId || 0);
  if (
    !normalizedRequestId
    || Number(state.ui.pendingViewTransitionRequestId || 0) !== normalizedRequestId
  ) {
    return false;
  }
  state.ui.pendingViewTransition = false;
  state.ui.pendingViewTransitionRequestId = 0;
  if (options.restoreCurrentGallery === true) {
    renderLibraryLoader({
      ...(state.status || {}),
      transition_in_progress: false,
    });
  }
  return true;
}

function hasPendingSidebarNavigation() {
  return Boolean(
    String(state.ui?.pendingSidebarSelectedArtist || '').trim()
    || state.ui?.pendingSidebarAllArtistsActive,
  );
}

function readActiveScanCompletionPreviewRequestId() {
  if (!state.busy) return 0;
  const requestId = Number(state.ui?.activeViewRequestId || 0);
  const requestUrl = String(state.ui?.activeViewRequestUrl || '').trim();
  const startupHydrationTier = String(
    state.ui?.activeViewRequestStartupHydrationTier || '',
  ).trim().toLowerCase();
  if (
    !requestId
    || !requestUrl.startsWith('/view-data')
    || state.ui?.activeViewRequestStartupRefresh
    || startupHydrationTier === 'sidebar'
    || /(?:[?&])payload_tier=sidebar(?:&|$)/i.test(requestUrl)
  ) {
    return 0;
  }
  return requestId;
}

function isCanonicalFullViewPayload(data, requestOptions = {}) {
  const payloadTier = String(data?.payload_tier || '').trim().toLowerCase();
  const startupHydrationTier = String(
    requestOptions.startupHydrationTier || '',
  ).trim().toLowerCase();
  return (
    requestOptions.startupRefresh !== true
    && data?.initial_view_partial !== true
    && payloadTier !== 'sidebar'
    && startupHydrationTier !== 'sidebar'
    && Array.isArray(data?.artist_groups)
  );
}

function recordSuccessfulStatusObservation() {
  const observationSequence = (
    Number(state.ui.successfulStatusObservationSequence || 0) + 1
  );
  state.ui.successfulStatusObservationSequence = observationSequence;
  return observationSequence;
}

function recordSuccessfulCanonicalFullViewApply(data, requestOptions = {}) {
  const scanGeneration = Number(state.status?.scan_generation || 0);
  if (
    !state.status?.scan_in_progress
    || scanGeneration <= 0
    || !isCanonicalFullViewPayload(data, requestOptions)
  ) {
    return false;
  }
  state.ui.lastSuccessfulCanonicalFullViewApply = {
    scanGeneration,
    viewStateRevision: readViewStateRevision(),
    statusObservationSequence: Number(
      state.ui.successfulStatusObservationSequence || 0,
    ),
  };
  return true;
}

function settledCanonicalFullViewApplySatisfiesFinalizing(
  scanGeneration,
  statusObservationSequence,
) {
  const lastApply = state.ui.lastSuccessfulCanonicalFullViewApply;
  return Boolean(
    lastApply
    && !state.busy
    && Number(scanGeneration || 0) > 0
    && Number(lastApply.scanGeneration || 0) === Number(scanGeneration || 0)
    && Number(lastApply.viewStateRevision || 0) === readViewStateRevision()
    && Number(lastApply.statusObservationSequence || 0)
      === Number(statusObservationSequence || 0) - 1
  );
}

function clearPendingScanCompletionViewRefresh() {
  if (state.ui.pendingScanCompletionViewRefreshRetryScheduled) {
    clearBrowserTimeout(state.ui.pendingScanCompletionViewRefreshRetryTimerId);
  }
  state.ui.pendingScanCompletionViewRefreshRetryToken = (
    Number(state.ui.pendingScanCompletionViewRefreshRetryToken || 0) + 1
  );
  state.ui.pendingScanCompletionViewRefreshRetryScheduled = false;
  state.ui.pendingScanCompletionViewRefreshRetryTimerId = 0;
  state.ui.pendingScanCompletionViewRefreshRetryCount = 0;
  state.ui.pendingScanCompletionViewRefreshRetryExhausted = false;
  state.ui.pendingScanCompletionViewRefresh = false;
  state.ui.pendingScanCompletionViewRefreshEligibleRequestId = 0;
  state.ui.lastSuccessfulCanonicalFullViewApply = null;
}

function consumePendingScanCompletionViewRefresh(requestId, data, requestOptions = {}) {
  if (
    !state.ui.pendingScanCompletionViewRefresh
    || Number(state.ui.pendingScanCompletionViewRefreshEligibleRequestId || 0)
      !== Number(requestId || 0)
    || !isCanonicalFullViewPayload(data, requestOptions)
  ) {
    return false;
  }
  clearPendingScanCompletionViewRefresh();
  return true;
}

async function dispatchPendingScanCompletionViewRefresh() {
  if (
    !state.ui?.pendingScanCompletionViewRefresh
    || state.ui?.pendingScanCompletionViewRefreshRetryExhausted
    || state.ui?.pendingScanCompletionViewRefreshRetryScheduled
    || state.busy
    || hasPendingSidebarNavigation()
  ) {
    return false;
  }
  const completionToken = Number(state.ui.pendingScanCompletionViewRefreshRetryToken || 0);
  state.ui.pendingScanCompletionViewRefresh = false;
  state.ui.pendingScanCompletionViewRefreshEligibleRequestId = 0;
  state.ui.lastSuccessfulCanonicalFullViewApply = null;
  state.awaitingInitialDataRefresh = false;
  try {
    const refreshApplied = await refreshCurrentViewAfterBackgroundCompletion({
      preserveScroll: true,
      restartIfSameUrl: true,
    });
    if (!refreshApplied) {
      throw new Error('The post-scan gallery refresh lost view-state ownership before it could apply.');
    }
    if (Number(state.ui.pendingScanCompletionViewRefreshRetryToken || 0) !== completionToken) {
      return true;
    }
    state.ui.pendingScanCompletionViewRefreshRetryCount = 0;
    state.ui.pendingScanCompletionViewRefreshRetryExhausted = false;
  } catch (error) {
    if (Number(state.ui.pendingScanCompletionViewRefreshRetryToken || 0) !== completionToken) {
      return true;
    }
    state.ui.pendingScanCompletionViewRefresh = true;
    const retryIndex = Math.max(
      0,
      Number(state.ui.pendingScanCompletionViewRefreshRetryCount || 0),
    );
    const retryDelayMs = SCAN_COMPLETION_VIEW_REFRESH_RETRY_DELAYS_MS[retryIndex];
    if (Number.isFinite(retryDelayMs)) {
      state.ui.pendingScanCompletionViewRefreshRetryCount = retryIndex + 1;
      const retryToken = Number(state.ui.pendingScanCompletionViewRefreshRetryToken || 0) + 1;
      state.ui.pendingScanCompletionViewRefreshRetryToken = retryToken;
      state.ui.pendingScanCompletionViewRefreshRetryScheduled = true;
      state.ui.pendingScanCompletionViewRefreshRetryTimerId = scheduleBrowserTimeout(
        () => {
          if (state.ui.pendingScanCompletionViewRefreshRetryToken !== retryToken) {
            return false;
          }
          state.ui.pendingScanCompletionViewRefreshRetryScheduled = false;
          state.ui.pendingScanCompletionViewRefreshRetryTimerId = 0;
          return dispatchPendingScanCompletionViewRefresh().catch(() => {});
        },
        retryDelayMs,
      );
    } else if (!state.ui.pendingScanCompletionViewRefreshRetryExhausted) {
      state.ui.pendingScanCompletionViewRefreshRetryExhausted = true;
      console.error('[AlbumHaven][Scan] Failed to refresh the gallery after scan completion.', error);
      showToast('Unable to refresh the gallery after the library scan.', 'error', 3200);
    }
  }
  return true;
}

async function dispatchPendingCoverCompletionViewRefresh() {
  if (
    !state.ui?.pendingCoverCompletionViewRefresh
    || state.ui?.pendingCoverCompletionViewRefreshRetryExhausted
    || state.ui?.pendingCoverCompletionViewRefreshRetryScheduled
    || state.busy
    || hasPendingSidebarNavigation()
  ) {
    return false;
  }
  const completionToken = Number(state.ui.pendingCoverCompletionViewRefreshRetryToken || 0);
  state.ui.pendingCoverCompletionViewRefresh = false;
  try {
    const refreshApplied = await refreshCurrentViewAfterBackgroundCompletion({
      preserveScroll: true,
    });
    if (!refreshApplied) {
      throw new Error('The post-cover gallery refresh lost view-state ownership before it could apply.');
    }
    if (Number(state.ui.pendingCoverCompletionViewRefreshRetryToken || 0) !== completionToken) {
      return true;
    }
    state.ui.pendingCoverCompletionViewRefreshRetryCount = 0;
    state.ui.pendingCoverCompletionViewRefreshRetryExhausted = false;
  } catch (error) {
    if (Number(state.ui.pendingCoverCompletionViewRefreshRetryToken || 0) !== completionToken) {
      return true;
    }
    state.ui.pendingCoverCompletionViewRefresh = true;
    const retryIndex = Math.max(
      0,
      Number(state.ui.pendingCoverCompletionViewRefreshRetryCount || 0),
    );
    const retryDelayMs = COVER_COMPLETION_VIEW_REFRESH_RETRY_DELAYS_MS[retryIndex];
    if (Number.isFinite(retryDelayMs)) {
      state.ui.pendingCoverCompletionViewRefreshRetryCount = retryIndex + 1;
      const retryToken = Number(state.ui.pendingCoverCompletionViewRefreshRetryToken || 0) + 1;
      state.ui.pendingCoverCompletionViewRefreshRetryToken = retryToken;
      state.ui.pendingCoverCompletionViewRefreshRetryScheduled = true;
      state.ui.pendingCoverCompletionViewRefreshRetryTimerId = scheduleBrowserTimeout(
        () => {
          if (state.ui.pendingCoverCompletionViewRefreshRetryToken !== retryToken) {
            return false;
          }
          state.ui.pendingCoverCompletionViewRefreshRetryScheduled = false;
          state.ui.pendingCoverCompletionViewRefreshRetryTimerId = 0;
          return dispatchPendingCoverCompletionViewRefresh().catch(() => {});
        },
        retryDelayMs,
      );
    } else if (!state.ui.pendingCoverCompletionViewRefreshRetryExhausted) {
      state.ui.pendingCoverCompletionViewRefreshRetryExhausted = true;
      console.error('[AlbumHaven][Covers] Failed to reconcile the gallery after cover completion.', error);
      showToast('Unable to refresh the gallery after album covers updated.', 'error', 3200);
    }
  }
  return true;
}

async function refreshCurrentViewAfterBackgroundCompletion(options = {}) {
  for (
    let attempt = 0;
    attempt <= BACKGROUND_COMPLETION_VIEW_OWNERSHIP_RETRY_LIMIT;
    attempt += 1
  ) {
    if (state.busy || hasPendingSidebarNavigation()) return false;
    const originatingRevision = readViewStateRevision();
    const refreshApplied = await fetchAndRender(buildApiUrl(state.view), false, {
      preserveGalleryOptionsMenu: true,
      ...options,
    });
    if (refreshApplied) return true;
    if (
      readViewStateRevision() === originatingRevision
      || state.busy
      || hasPendingSidebarNavigation()
    ) {
      return false;
    }
  }
  return false;
}

function readStartupHydrationTier(requestOptions = {}) {
  return String(requestOptions.startupHydrationTier || 'full').trim() || 'full';
}

function markStartupFollowup(name, requestOptions = {}, detail = {}) {
  if (
    !requestOptions.startupRefresh
    || !startupMetrics
    || typeof startupMetrics.markOnce !== 'function'
  ) {
    return;
  }
  const hydrationTier = readStartupHydrationTier(requestOptions);
  const markDetail = {
    ...(detail && typeof detail === 'object' ? detail : {}),
    hydrationTier,
  };
  startupMetrics.markOnce(`startup_followup_${name}`, markDetail);
  startupMetrics.markOnce(`startup_followup_${hydrationTier}_${name}`, markDetail);
}

function scheduleStartupFollowupPaintMark(name, requestOptions = {}, readDetail) {
  if (
    !requestOptions.startupRefresh
    || !startupMetrics
    || typeof startupMetrics.schedulePaintMark !== 'function'
  ) {
    return;
  }
  const hydrationTier = readStartupHydrationTier(requestOptions);
  const detailReader = typeof readDetail === 'function' ? readDetail : () => ({});
  const readMarkDetail = () => ({
    ...detailReader(),
    hydrationTier,
  });
  startupMetrics.schedulePaintMark(`startup_followup_${name}`, readMarkDetail);
  startupMetrics.schedulePaintMark(`startup_followup_${hydrationTier}_${name}`, readMarkDetail);
}

function scheduleSidebarRender() {
  if (pendingSidebarRenderFrameId && typeof cancelBrowserAnimationFrame === 'function') {
    cancelBrowserAnimationFrame(pendingSidebarRenderFrameId);
  }
  const renderSidebarOnNextFrame = () => {
    pendingSidebarRenderFrameId = 0;
    renderSidebar();
  };
  if (typeof scheduleBrowserAnimationFrame === 'function') {
    pendingSidebarRenderFrameId = scheduleBrowserAnimationFrame(renderSidebarOnNextFrame);
    return;
  }
  renderSidebarOnNextFrame();
}

function renderView(options = {}) {
  const preserveMountedSelectedViewNodes = Boolean(
    options.preserveMountedGalleryChildren === true
    && options.retainMountedSelectedViewState
    && typeof options.retainMountedSelectedViewState === 'object'
  );
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.value = String(state.ui?.searchDraftQuery ?? state.view.query ?? '');
  }
  const searchForm = document.getElementById('search-form');
  const ensureHiddenInput = (name, values) => {
    if (!(searchForm instanceof HTMLFormElement)) return;
    searchForm.querySelectorAll(`input[type="hidden"][name="${cssEscape(name)}"]`).forEach((input) => input.remove());
    values
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .forEach((value) => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        searchForm.appendChild(input);
      });
  };
  ensureHiddenInput('artist', state.view.selected_artist ? [state.view.selected_artist] : []);
  ensureHiddenInput('gallery_scope', state.view.gallery_scope ? [state.view.gallery_scope] : []);
  ensureHiddenInput(
    'gallery_display',
    state.view.gallery_display_mode && state.view.gallery_display_mode !== 'cards'
      ? [state.view.gallery_display_mode]
      : [],
  );
  ensureHiddenInput(
    'gallery_scale_percent',
    Number.isInteger(Number(state.view.gallery_scale_percent)) && Number(state.view.gallery_scale_percent) !== 100
      ? [String(state.view.gallery_scale_percent)]
      : [],
  );
  ensureHiddenInput('category', state.view.visible_library_categories || []);
  if (!preserveMountedSelectedViewNodes) {
    renderRelated();
  }
  if (options.preserveMountedGallery !== true && !preserveMountedSelectedViewNodes) {
    renderArtistGroups(options);
  }
  renderLibraryLoader(state.status);
  scheduleSidebarRender();
}

function hasEquivalentGalleryRenderTopology(retainedGroups, canonicalGroups) {
  const retained = Array.isArray(retainedGroups) ? retainedGroups : [];
  const canonical = Array.isArray(canonicalGroups) ? canonicalGroups : [];
  if (!retained.length || retained.length !== canonical.length) return false;
  try {
    const buildSignature = (groups) => JSON.stringify(groups.map((group) => {
      const albums = Array.isArray(group?.albums) ? group.albums : [];
      return [
        String(group?.display_artist_key || group?.artist || ''),
        String(group?.artist_display || group?.artist || 'Artist'),
        albums.map((album) => getAlbumCardRenderKey(album)),
      ];
    }));
    return buildSignature(retained) === buildSignature(canonical);
  } catch (_error) {
    return false;
  }
}

function queueStartupHydrationFollowup(endpoint, options = {}) {
  const normalizedEndpoint = String(endpoint || '').trim();
  if (!normalizedEndpoint) {
    state.ui.pendingStartupHydrationFollowup = null;
    return;
  }
  const requestedQueuedAtMs = Number(options?.queuedAtMs || 0);
  const queuedAtMs = requestedQueuedAtMs > 0 ? requestedQueuedAtMs : Date.now();
  const {
    queuedAtMs: _ignoredQueuedAtMs,
    originatingViewStateRevision: _ignoredOriginatingViewStateRevision,
    ...normalizedOptions
  } = (options && typeof options === 'object') ? options : {};
  state.ui.pendingStartupHydrationFollowup = {
    endpoint: normalizedEndpoint,
    queuedAtMs,
    originatingViewStateRevision: Number(
      options?.originatingViewStateRevision ?? readViewStateRevision(),
    ),
    options: {
      startupRefresh: true,
      preserveScroll: true,
      startupHydrationTier: 'full',
      ...normalizedOptions,
    },
  };
}

function clearStartupHydrationFollowup() {
  const pendingFollowup = state.ui.pendingStartupHydrationFollowup;
  state.ui.pendingStartupHydrationFollowup = null;
  return pendingFollowup && typeof pendingFollowup === 'object'
    ? pendingFollowup
    : null;
}

function dispatchStartupHydrationFollowup(followup, delayMs = 0) {
  const normalizedFollowup = followup && typeof followup === 'object'
    ? followup
    : null;
  if (!normalizedFollowup?.endpoint) {
    return;
  }
  const runDispatch = () => {
    const rootViewStillOwnsStartupHydration = Boolean(
      !String(state.view.query || '').trim()
      && !String(state.view.selected_artist || '').trim()
    );
    const userNavigationOwnsRequestSlot = Boolean(
      state.ui.pendingViewRequest
      || hasPendingSidebarNavigation()
      || (
        String(state.ui.activeViewRequestUrl || '').trim()
        && state.ui.activeViewRequestStartupRefresh !== true
      )
    );
    const requiredCurrentGeneration = Boolean(
      state.awaitingInitialDataRefresh
      && rootViewStillOwnsStartupHydration
      && !userNavigationOwnsRequestSlot
      && normalizedFollowup.options?.startupRefresh === true
      && String(normalizedFollowup.options?.startupHydrationTier || '') === 'full'
      && Number(normalizedFollowup.originatingViewStateRevision || 0) === readViewStateRevision()
    );
    const followupAgeMs = Math.max(
      0,
      Date.now() - Number(normalizedFollowup.queuedAtMs || Date.now()),
    );
    if (followupAgeMs > STARTUP_FOLLOWUP_MAX_AGE_MS && !requiredCurrentGeneration) {
      clearStartupHydrationFollowup();
      state.awaitingInitialDataRefresh = false;
      return;
    }
    if (String(state.view.query || '').trim() || String(state.view.selected_artist || '').trim()) {
      clearStartupHydrationFollowup();
      state.awaitingInitialDataRefresh = false;
      return;
    }
    if (
      Number(normalizedFollowup.originatingViewStateRevision || 0)
      !== readViewStateRevision()
    ) {
      clearStartupHydrationFollowup();
      state.awaitingInitialDataRefresh = false;
      return;
    }
    const utilityModal = document.getElementById('utility-modal');
    const utilityModalOpen = Boolean(utilityModal && !utilityModal.hidden);
    if (utilityModalOpen) {
      const deferredFollowup = clearStartupHydrationFollowup() || normalizedFollowup;
      state.ui.deferredUtilityViewRequest = {
        url: deferredFollowup.endpoint,
        push: false,
        options: deferredFollowup.options,
        originatingViewStateRevision: Number(
          deferredFollowup.originatingViewStateRevision || 0,
        ),
      };
      return;
    }
    if (state.busy) {
      queueStartupHydrationFollowup(normalizedFollowup.endpoint, {
        ...(normalizedFollowup.options || {}),
        queuedAtMs: normalizedFollowup.queuedAtMs,
        originatingViewStateRevision: normalizedFollowup.originatingViewStateRevision,
      });
      scheduleBrowserTimeout(() => {
        const retryFollowup = state.ui.pendingStartupHydrationFollowup;
        if (!retryFollowup?.endpoint) return;
        dispatchStartupHydrationFollowup(retryFollowup);
      }, STARTUP_FOLLOWUP_RETRY_DELAY_MS);
      return;
    }
    const nextFollowup = clearStartupHydrationFollowup() || normalizedFollowup;
    fetchAndRender(
      nextFollowup.endpoint,
      false,
      nextFollowup.options,
    );
  };
  if (delayMs > 0) {
    scheduleBrowserTimeout(runDispatch, delayMs);
    return;
  }
  Promise.resolve().then(runDispatch);
}

async function fetchAndRender(url, push = true, options = {}) {
  const requestOptions = (options && typeof options === 'object') ? options : {};
  const albumDetailPrewarmSearchGeneration = state.ui?.albumDetailPrewarmSearchSuspended
    ? Number(state.ui.albumDetailPrewarmSearchGeneration || 0)
    : 0;
  let waveformPeakLoadSuspension = null;
  if (typeof cancelTrackModalAlbumDetailsPrewarms === 'function') {
    cancelTrackModalAlbumDetailsPrewarms();
  }
  const canInterruptCurrent = requestOptions.interruptCurrent !== false;
  const restartIfSameUrl = requestOptions.restartIfSameUrl === true;
  const apiUrl = url.startsWith('/view-data') || url.startsWith('/home-data')
    ? url
    : buildApiUrl(parseBrowserUrlState(url));
  const encodedCommittedQuery = String(
    apiUrl.match(/(?:[?&])q=([^&]*)/)?.[1] || ''
  ).replace(/\+/g, ' ');
  let committedQuery = encodedCommittedQuery;
  try {
    committedQuery = decodeURIComponent(encodedCommittedQuery);
  } catch (_error) {
    // A malformed query is not eligible for mounted-gallery preservation.
    committedQuery = '';
  }
  const retainedCommittedSearchGallery = (
    apiUrl.startsWith('/view-data')
    && (
      String(committedQuery || '').trim()
      || requestOptions.retainMountedGalleryIfEquivalent === true
    )
    && Array.isArray(state.view?.artist_groups)
    && state.view.artist_groups.some((group) => (
      Array.isArray(group?.albums) && group.albums.length > 0
    ))
  )
    ? state.view.artist_groups
    : null;
  if (!requestOptions.startupRefresh) {
    clearStartupHydrationFollowup();
    state.awaitingInitialDataRefresh = false;
  }
  if (state.busy) {
    if (String(state.ui.activeViewRequestUrl || '') === apiUrl) {
      const activeController = state.ui.activeViewRequestController;
      if (
        restartIfSameUrl
        && activeController
        && typeof activeController.abort === 'function'
      ) {
        activeController.abort();
      } else {
        state.ui.activeViewRequestPush = Boolean(state.ui.activeViewRequestPush || push);
        return false;
      }
    }
    const activeController = state.ui.activeViewRequestController;
    if (canInterruptCurrent && activeController && typeof activeController.abort === 'function') {
      activeController.abort();
    } else {
      state.ui.pendingViewRequest = {
        url,
        push,
        options: requestOptions,
        originatingViewStateRevision: readViewStateRevision(),
      };
      return false;
    }
  }
  if (typeof suspendPlayerWaveformPeakLoadsForForegroundView === 'function') {
    waveformPeakLoadSuspension = state.ui?.pendingSearchWaveformPeakLoadSuspension || null;
    if (waveformPeakLoadSuspension) {
      state.ui.pendingSearchWaveformPeakLoadSuspension = null;
    } else {
      waveformPeakLoadSuspension = suspendPlayerWaveformPeakLoadsForForegroundView();
    }
  }
  const shouldReconcileFamilyPrefetch = Boolean(
    String(state.view?.selected_artist || '').trim()
    || String(state.ui?.pendingSidebarSelectedArtist || '').trim(),
  );
  const familyPrefetchReconciliationGeneration = (
    shouldReconcileFamilyPrefetch
    && typeof galleryCoverLoadScheduler !== 'undefined'
    && typeof galleryCoverLoadScheduler.beginFamilyPrefetchReconciliation === 'function'
  )
    ? galleryCoverLoadScheduler.beginFamilyPrefetchReconciliation()
    : 0;
  let viewRendered = false;
  const requestId = Number(state.ui.activeViewRequestId || 0) + 1;
  const requestViewStateRevision = readViewStateRevision();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  state.ui.activeViewRequestId = requestId;
  state.ui.activeViewRequestUrl = apiUrl;
  state.ui.activeViewRequestPush = Boolean(push);
  state.ui.activeViewRequestStartupRefresh = Boolean(requestOptions.startupRefresh);
  state.ui.activeViewRequestStartupHydrationTier = state.ui.activeViewRequestStartupRefresh
    ? String(requestOptions.startupHydrationTier || 'full')
    : '';
  state.ui.activeViewRequestController = controller;
  state.ui.pendingViewRequest = null;
  state.busy = true;
  state.ui.activeViewPayloadReady = false;
  const retainsMountedSelectedViewState = Boolean(
    requestOptions.retainMountedSelectedViewState
    && typeof requestOptions.retainMountedSelectedViewState === 'object'
  );
  if (!retainsMountedSelectedViewState) {
    renderRelated();
  }
  if (!requestOptions.preserveScroll && requestOptions.skipPendingViewTransition !== true) {
    beginPendingViewTransition(requestId);
  }
  if (!requestOptions.preserveScanPage && !state.ui.scanPageReturnContext) {
    state.ui.forceScanPageVisible = false;
  }
  if (requestOptions.preserveGalleryOptionsMenu !== true) {
    hideGalleryOptionsMenu();
  }
  try {
    markStartupFollowup('fetch_started', requestOptions, {
      endpoint: apiUrl,
    });
    const response = await fetch(apiUrl, {
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
    const data = await response.json();
    markStartupFollowup('payload_received', requestOptions, {
      endpoint: apiUrl,
      artistCount: Number(data?.artist_count || 0),
      albumCount: Number(data?.album_count || 0),
      payloadTier: String(data?.payload_tier || ''),
    });
    if (!requestOwnsCurrentViewState(requestId, requestViewStateRevision)) {
      return false;
    }
    if (typeof requestOptions.shouldApplyResponse === 'function') {
      let shouldApplyResponse = false;
      try {
        shouldApplyResponse = requestOptions.shouldApplyResponse(data) === true;
      } catch (_error) {
        return false;
      }
      if (!shouldApplyResponse) return false;
    }
    const startupHydrationTier = String(requestOptions.startupHydrationTier || 'full');
    if (
      requestOptions.startupRefresh
      && startupHydrationTier !== 'sidebar'
      && typeof isEffectivelyEmptyView === 'function'
    ) {
      try {
        if (!isEffectivelyEmptyView(data)) {
          state.awaitingInitialDataRefresh = false;
        }
      } catch (_error) {
        // Leave the flag unchanged when the current payload cannot be classified safely.
      }
    }
    markStartupFollowup('apply_started', requestOptions);
    const retainedMountedSelectedViewState = (
      requestOptions.retainMountedSelectedViewState
      && typeof requestOptions.retainMountedSelectedViewState === 'object'
    )
      ? requestOptions.retainMountedSelectedViewState
      : null;
    const payloadToApply = retainedMountedSelectedViewState
      ? {
        ...state.view,
        ...retainedMountedSelectedViewState,
        ...(
          Object.prototype.hasOwnProperty.call(data || {}, 'artists_sidebar')
            ? { artists_sidebar: data.artists_sidebar }
            : {}
        ),
        ...(
          Object.prototype.hasOwnProperty.call(data || {}, 'artist_count')
            ? { artist_count: data.artist_count }
            : {}
        ),
        ...(
          Object.prototype.hasOwnProperty.call(data || {}, 'show_all_artists_sidebar_link')
            ? { show_all_artists_sidebar_link: data.show_all_artists_sidebar_link }
            : {}
        ),
      }
      : data;
    const responseApplyOptions = retainedMountedSelectedViewState
      ? {
        ...requestOptions,
        preserveMountedGalleryChildren: true,
      }
      : requestOptions;
    applyViewPayload(payloadToApply, responseApplyOptions);
    finishPendingViewTransition(requestId);
    markStartupFollowup('apply_complete', requestOptions, {
      artistCount: Number(state.view?.artist_count || 0),
      albumCount: Number(state.view?.album_count || 0),
    });
    markStartupFollowup('render_started', requestOptions);
    attachModalEvents();
    state.ui.activeViewPayloadReady = true;
    const preserveMountedGallery = Boolean(
      retainedCommittedSearchGallery
      && hasEquivalentGalleryRenderTopology(
        retainedCommittedSearchGallery,
        state.view?.artist_groups,
      )
    );
    renderView({
      ...responseApplyOptions,
      ...(preserveMountedGallery ? { preserveMountedGallery: true } : {}),
    });
    if (
      requestOptions.preserveGalleryOptionsMenu === true
      && state.gallery?.menuOpen
      && typeof renderGalleryOptionsMenu === 'function'
    ) {
      renderGalleryOptionsMenu();
    }
    viewRendered = true;
    markStartupFollowup('render_complete', requestOptions, {
      artistHeadingCount: document.querySelectorAll('#artist-groups .artist-section').length,
      sidebarArtistCount: document.querySelectorAll('#sidebar-list [data-sidebar-artist]').length,
    });
    scheduleStartupFollowupPaintMark('first_post_render_paint', requestOptions, () => ({
      artistHeadingCount: document.querySelectorAll('#artist-groups .artist-section').length,
      splitLabelCount: document.querySelectorAll('#artist-groups .section-split-label').length,
    }));
    if (
      requestOptions.startupRefresh
      && startupMetrics
      && typeof startupMetrics.completeVisibleInitialRefresh === 'function'
    ) {
      startupMetrics.completeVisibleInitialRefresh(state.view, {
        hydrationTier: startupHydrationTier,
      });
    }
    if (
      requestOptions.startupRefresh
      && (
        startupHydrationTier !== 'sidebar'
        || !String(requestOptions.startupHydrationFollowupEndpoint || '').trim()
      )
    ) {
      startupMetrics.completeInitialRefresh(state.view);
    }
    if (
      requestOptions.startupRefresh
      && startupHydrationTier === 'sidebar'
      && String(requestOptions.startupHydrationFollowupEndpoint || '').trim()
    ) {
      queueStartupHydrationFollowup(
        requestOptions.startupHydrationFollowupEndpoint,
        {
          startupHydrationTier: 'full',
        },
      );
    }
    if (state.ui.activeViewRequestPush) pushBrowserViewState(state.view);
    recordSuccessfulCanonicalFullViewApply(data, requestOptions);
    consumePendingScanCompletionViewRefresh(requestId, data, requestOptions);
    return true;
  } catch (error) {
    if (!requestOwnsCurrentViewState(requestId, requestViewStateRevision)) {
      return false;
    }
    finishPendingViewTransition(requestId, { restoreCurrentGallery: true });
    const deferredUtilityRequest = state.ui.deferredUtilityViewRequest;
    const sameGenerationUtilityDeferralOwnsRetry = Boolean(
      deferredUtilityRequest?.url === apiUrl
      && Number(deferredUtilityRequest.originatingViewStateRevision || 0)
        === requestViewStateRevision
      && deferredUtilityRequest.options?.startupRefresh === true
      && String(deferredUtilityRequest.options?.startupHydrationTier || '') === 'full'
    );
    const terminalFullStartupHydration = Boolean(
      requestOptions.startupRefresh === true
      && String(requestOptions.startupHydrationTier || 'full') === 'full'
    );
    if (terminalFullStartupHydration && !sameGenerationUtilityDeferralOwnsRetry) {
      state.awaitingInitialDataRefresh = false;
    }
    if (error?.name === 'AbortError') {
      clearStartupHydrationFollowup();
      return false;
    }
    clearStartupHydrationFollowup();
    if (typeof clearPendingSidebarSelection === 'function') {
      clearPendingSidebarSelection();
      renderSidebar();
    }
    throw error;
  } finally {
    if (
      albumDetailPrewarmSearchGeneration > 0
      && Number(state.ui?.albumDetailPrewarmSearchGeneration || 0)
        === albumDetailPrewarmSearchGeneration
    ) {
      state.ui.albumDetailPrewarmSearchSuspended = false;
    }
    if (
      (!viewRendered || retainsMountedSelectedViewState)
      && familyPrefetchReconciliationGeneration
      && typeof galleryCoverLoadScheduler !== 'undefined'
      && typeof galleryCoverLoadScheduler.cancelFamilyPrefetchReconciliation === 'function'
    ) {
      galleryCoverLoadScheduler.cancelFamilyPrefetchReconciliation(
        familyPrefetchReconciliationGeneration,
      );
    }
    if (requestOwnsCurrentViewState(requestId, requestViewStateRevision)) {
      finishPendingViewTransition(requestId, { restoreCurrentGallery: true });
    }
    if (state.ui.activeViewRequestId === requestId) {
      state.ui.activeViewRequestController = null;
      state.ui.activeViewRequestUrl = '';
      state.ui.activeViewRequestPush = false;
      state.ui.activeViewRequestStartupRefresh = false;
      state.ui.activeViewRequestStartupHydrationTier = '';
      state.busy = false;
      state.ui.activeViewPayloadReady = false;
      if (
        !viewRendered
        && !retainsMountedSelectedViewState
        && requestOwnsCurrentViewState(requestId, requestViewStateRevision)
      ) {
        renderRelated();
      }
      const pendingRequest = state.ui.pendingViewRequest;
      const pendingStartupHydrationFollowup = state.ui.pendingStartupHydrationFollowup;
      let pendingViewRequestDispatched = false;
      if (pendingRequest) {
        state.ui.pendingViewRequest = null;
        const pendingOriginatingRevision = Number(
          pendingRequest.originatingViewStateRevision || 0,
        );
        if (pendingOriginatingRevision === readViewStateRevision()) {
          clearStartupHydrationFollowup();
          pendingViewRequestDispatched = true;
          fetchAndRender(
            pendingRequest.url,
            pendingRequest.push,
            pendingRequest.options,
          );
        }
      }
      if (pendingViewRequestDispatched) {
        // The current queued request owns the active slot.
      } else if (await dispatchPendingScanCompletionViewRefresh()) {
        // The one-shot post-scan refresh now owns the active request slot.
      } else if (await dispatchPendingCoverCompletionViewRefresh()) {
        // The one-shot post-cover refresh now owns the active request slot.
      } else if (
        pendingStartupHydrationFollowup
        && !String(state.view.query || '').trim()
        && !String(state.view.selected_artist || '').trim()
      ) {
        dispatchStartupHydrationFollowup(
          pendingStartupHydrationFollowup,
          STARTUP_FOLLOWUP_VISIBLE_READY_DELAY_MS,
        );
      }
      const utilityModal = document.getElementById('utility-modal');
      if (
        state.ui.deferredUtilityViewRequest?.url
        && Boolean(!utilityModal || utilityModal.hidden)
        && typeof resumeDeferredUtilityViewRequest === 'function'
      ) {
        Promise.resolve().then(() => resumeDeferredUtilityViewRequest());
      }
    }
    if (
      waveformPeakLoadSuspension
      && typeof resumePlayerWaveformPeakLoadsAfterForegroundView === 'function'
    ) {
      void Promise.resolve(
        resumePlayerWaveformPeakLoadsAfterForegroundView(waveformPeakLoadSuspension),
      ).catch(() => {});
    }
  }
}

async function triggerLibraryRefresh(fullRescan = false) {
  const indicator = document.getElementById('scan-indicator');
  if (!indicator) return;
  if (state.status?.scan_in_progress || state.status?.relations_in_progress) {
    showToast('Library scan is already running.', 'info', 2200);
    return false;
  }
  if (state.status?.covers_in_progress) {
    return false;
  }
  const previousStatus = { ...state.status };
  state.ui.scanCancellationAcknowledged = false;
  indicator.classList.remove('is-done', 'is-idle');
  indicator.classList.add('is-busy');
  indicator.title = 'Starting library scan...';
  startStatusIndicatorImmediately({
    scan_in_progress: true,
    scan_processed: 0,
    scan_total: 0,
    relations_in_progress: false,
    relations_processed: 0,
    relations_total: 0,
  });
  try {
    const response = await fetch('/refresh-api', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_rescan: Boolean(fullRescan) }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data?.already_running) {
      updateStatusIndicator(previousStatus);
      showToast('Library scan is already running.', 'info', 2200);
      scheduleBrowserTimeout(pollStatus, 250);
      return false;
    }
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.error || `Refresh failed: ${response.status}`);
    }
    if (fullRescan) {
      state.status = {
        ...state.status,
        scan_in_progress: true,
        scan_mode: 'manual_full_rescan',
      };
    }
    state.wasPollingBusy = true;
    showToast('Library scan started.', 'success', 2200);
    scheduleBrowserTimeout(pollStatus, 250);
    return true;
  } catch (error) {
    updateStatusIndicator(previousStatus);
    indicator.classList.remove('is-busy');
    indicator.classList.add('is-done');
    indicator.title = 'Unable to start library scan';
    showToast('Unable to start library scan.', 'error', 3200);
    return false;
  }
}
function claimLocalViewStateNavigation() {
  state.ui.viewStateRevision = Number(state.ui.viewStateRevision || 0) + 1;
  state.ui.pendingViewRequest = null;
  state.ui.pendingViewTransition = false;
  state.ui.pendingViewTransitionRequestId = 0;
  const activeController = state.ui.activeViewRequestController;
  if (activeController && typeof activeController.abort === 'function') {
    activeController.abort();
  }
}

function suspendScanPageGalleryCoverLoads() {
  if (Number(state.ui.scanPageCoverLoadSuspensionToken || 0)) return;
  if (
    typeof virtualGrid === 'undefined'
    || !virtualGrid
    || typeof virtualGrid.suspendSelectedArtistCoverLoadsForUserAction !== 'function'
  ) return;
  state.ui.scanPageCoverLoadSuspensionToken = Number(
    virtualGrid.suspendSelectedArtistCoverLoadsForUserAction() || 0,
  );
}

function resumeScanPageGalleryCoverLoads() {
  const token = Number(state.ui.scanPageCoverLoadSuspensionToken || 0);
  state.ui.scanPageCoverLoadSuspensionToken = 0;
  if (
    !token
    || typeof virtualGrid === 'undefined'
    || !virtualGrid
    || typeof virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction !== 'function'
  ) return;
  virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(token);
}


function openScanPage() {
  if (!state.ui.scanPageReturnContext) {
    state.ui.scanPageReturnContext = {
      view: JSON.parse(JSON.stringify(state.view || {})),
      searchDraftQuery: String(state.ui.searchDraftQuery ?? state.view?.query ?? ''),
      url: typeof window !== 'undefined' ? String(window.location?.href || '') : '',
    };
  }
  suspendScanPageGalleryCoverLoads();
  state.ui.forceScanPageVisible = true;
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';
  renderSidebar();
  renderRelated();
  renderLibraryLoader(state.status, { scanPageVisible: true });
}

function abandonScanPageForNavigation(options = {}) {
  const scanPageWasVisible = Boolean(
    state.ui.scanPageReturnContext
    || state.ui.forceScanPageVisible
  );
  if (!scanPageWasVisible) return false;

  claimLocalViewStateNavigation();
  state.ui.scanPageReturnContext = null;
  state.ui.forceScanPageVisible = false;
  resumeScanPageGalleryCoverLoads();
  if (options.clearSelection === true) {
    state.view = {
      ...state.view,
      selected_artist: '',
      all_artists_active: false,
      related_filter_artists: [],
      primary_filter_active: false,
      related_artists: [],
      primary_artist_groups: [],
      family_artist_groups: [],
    };
    state.ui.pendingSidebarSelectedArtist = '';
    state.ui.pendingSidebarAllArtistsActive = false;
    renderSidebar();
    renderRelated();
  }
  return true;
}

function closeScanPage() {
  const returnContext = state.ui.scanPageReturnContext;
  state.ui.forceScanPageVisible = false;
  if (!returnContext) {
    resumeScanPageGalleryCoverLoads();
    renderLibraryLoader(state.status);
    return;
  }
  claimLocalViewStateNavigation();
  const currentViewUsable = typeof isEffectivelyEmptyView !== 'function'
    || !isEffectivelyEmptyView(state.view);
  const retainedViewUsable = returnContext.view
    && (
      typeof isEffectivelyEmptyView !== 'function'
      || !isEffectivelyEmptyView(returnContext.view)
    );
  const restoreRetainedCancelledView = Boolean(
    returnContext.scanCancelled === true
    && retainedViewUsable
  );
  if (
    retainedViewUsable
    && (
      !currentViewUsable
      || restoreRetainedCancelledView
    )
  ) {
    state.view = JSON.parse(JSON.stringify(returnContext.view));
  }
  state.ui.searchDraftQuery = String(returnContext.searchDraftQuery ?? state.view?.query ?? '');
  state.ui.scanPageReturnContext = null;
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = state.ui.searchDraftQuery;
  if (
    returnContext.url
    && typeof window !== 'undefined'
    && window.history?.replaceState
    && String(window.location?.href || '') !== returnContext.url
  ) {
    window.history.replaceState(window.history.state, '', returnContext.url);
  }
  const mountedGallery = document.getElementById('artist-groups');
  const retainedGalleryCardsRemainMounted = Boolean(
    returnContext.view
    && typeof hasEquivalentGalleryRenderTopology === 'function'
    && hasEquivalentGalleryRenderTopology(
      returnContext.view.artist_groups,
      state.view?.artist_groups,
    )
    && mountedGallery
    && typeof mountedGallery.querySelectorAll === 'function'
    && mountedGallery.querySelectorAll('.album-card').length > 0
  );
  if (retainedGalleryCardsRemainMounted) {
    renderView({ preserveMountedGallery: true });
  } else {
    renderView();
  }
  resumeScanPageGalleryCoverLoads();
}

async function cancelLibraryScan() {
  if (state.ui.scanCancellationPending) return false;
  const isFullRescan = String(state.status?.scan_mode || '') === 'manual_full_rescan';
  const scanLabel = isFullRescan ? 'full rescan' : 'scan';
  state.ui.scanCancellationPending = true;
  renderLibraryLoader(state.status, {
    scanPageVisible: Boolean(state.ui.scanPageReturnContext),
  });
  try {
    const response = await fetch('/cancel-refresh-api', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json();
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `Failed to cancel ${scanLabel} (${response.status}).`);
    }
    if (!state.ui.scanPageReturnContext) {
      state.ui.forceScanPageVisible = false;
    }
    if (data.cancelled && state.ui.scanPageReturnContext) {
      state.ui.scanPageReturnContext.scanCancelled = true;
    }
    state.ui.scanCancellationAcknowledged = Boolean(data.cancelled);
    state.status = {
      ...state.status,
      scan_in_progress: false,
      scan_mode: 'idle',
    };
    renderLibraryLoader(state.status);
    showToast(
      data.cancelled
        ? `${isFullRescan ? 'Full rescan' : 'Scan'} cancelled.`
        : 'No scan was running.',
      'success',
      2600,
    );
    scheduleBrowserTimeout(pollStatus, 150);
    return Boolean(data.cancelled);
  } catch (error) {
    showToast(error?.message || `Failed to cancel ${scanLabel}.`, 'error', 3200);
    return false;
  } finally {
    state.ui.scanCancellationPending = false;
    renderLibraryLoader(state.status, {
      scanPageVisible: Boolean(state.ui.scanPageReturnContext),
    });
  }
}

async function browseScannedLibrarySnapshot() {
  if (state.ui.browseScannedResultsLoading) return;
  const browseReturnContext = state.ui.scanPageReturnContext;
  const mountedGalleryViewBeforeBrowse = state.view;
  const browseView = {
    ...state.view,
    query: '',
    selected_artist: '',
    all_artists_active: true,
    related_filter_artists: [],
    primary_filter_active: false,
    surface: {
      ...(state.view?.surface || {}),
      active: 'albums',
    },
    surface_request: 'albums',
  };
  const browseUrl = buildApiUrl(browseView);
  const reusableRootBrowseView = typeof getReusableRootBrowseView === 'function'
    ? getReusableRootBrowseView(browseView, browseReturnContext?.view)
    : null;
  const reusableRootBrowseAvailable = Boolean(
    reusableRootBrowseView
    && !isEffectivelyEmptyView(reusableRootBrowseView),
  );
  if (reusableRootBrowseAvailable) {
    claimLocalViewStateNavigation();
    applyViewPayload({
      ...reusableRootBrowseView,
      query: '',
      selected_artist: '',
      all_artists_active: true,
      related_filter_artists: [],
      primary_filter_active: false,
      surface: browseView.surface,
      surface_request: 'albums',
    }, {
      trackSidebarReveal: false,
    });
    state.ui.scanPageReturnContext = null;
    state.ui.forceScanPageVisible = false;
    state.ui.searchDraftQuery = '';
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = '';
    pushBrowserViewState(state.view);
    const mountedGallery = document.getElementById('artist-groups');
    const reusableGalleryRemainsMounted = Boolean(
      mountedGallery
      && typeof mountedGallery.querySelectorAll === 'function'
      && mountedGallery.querySelectorAll('.album-card').length > 0
      && hasEquivalentGalleryRenderTopology(
        mountedGalleryViewBeforeBrowse?.artist_groups,
        reusableRootBrowseView?.artist_groups,
      )
    );
    renderView(reusableGalleryRemainsMounted ? { preserveMountedGalleryChildren: true } : undefined);
    resumeScanPageGalleryCoverLoads();
    const scanRelatedWorkActive = Boolean(
      state.status?.scan_in_progress
      || state.status?.relations_in_progress
      || state.status?.covers_in_progress
    );
    if (scanRelatedWorkActive) {
      return;
    }
  }
  state.ui.browseScannedResultsLoading = true;
  renderLibraryLoader(state.status);
  try {
    if (reusableRootBrowseAvailable) {
      await fetchAndRender(browseUrl, false, {
        preserveScroll: true,
        restartIfSameUrl: true,
        skipPendingViewTransition: true,
      });
      return;
    }
    let browseRendered = await fetchAndRender(browseUrl, false, {
      preserveScroll: true,
      restartIfSameUrl: true,
    });
    let retryCount = 0;
    while (
      browseReturnContext
      && state.ui.scanPageReturnContext === browseReturnContext
      && isEffectivelyEmptyView(state.view)
      && retryCount < BROWSE_SCANNED_MAX_RETRIES
    ) {
      retryCount += 1;
      await new Promise((resolve) => {
        scheduleBrowserTimeout(resolve, BROWSE_SCANNED_RETRY_DELAY_MS);
      });
      browseRendered = await fetchAndRender(browseUrl, false, {
        preserveScroll: true,
        restartIfSameUrl: true,
      });
    }
    if (isEffectivelyEmptyView(state.view)) {
      showToast('No scanned albums are ready to browse yet.', 'info', 2600);
    } else if (
      browseRendered
      && browseReturnContext
      && state.ui.scanPageReturnContext === browseReturnContext
    ) {
      state.ui.scanPageReturnContext = null;
      state.ui.forceScanPageVisible = false;
      state.ui.searchDraftQuery = '';
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.value = '';
      pushBrowserViewState(state.view);
      renderView();
      resumeScanPageGalleryCoverLoads();
    }
  } catch (error) {
    showToast(error?.message || 'Unable to load scanned albums yet.', 'error', 3200);
  } finally {
    state.ui.browseScannedResultsLoading = false;
    renderLibraryLoader(state.status);
  }
}

async function pollStatus() {
  const knownStatus = state.status || {};
  const knownBusy = Boolean(
    knownStatus.scan_in_progress
    || knownStatus.relations_in_progress
    || knownStatus.covers_in_progress
  );
  const coverScheduler = typeof galleryCoverLoadScheduler !== 'undefined'
    ? galleryCoverLoadScheduler
    : null;
  if (
    !knownBusy
    && coverScheduler?.isForegroundIdle?.() === false
    && typeof coverScheduler.whenForegroundIdle === 'function'
  ) {
    await coverScheduler.whenForegroundIdle();
    scheduleBrowserTimeout(pollStatus, STATUS_POLL_FOREGROUND_IDLE_RETRY_DELAY_MS);
    return;
  }
  try {
    const response = await fetch('/status');
    const data = await response.json();
    updateStatusIndicator(data);
    const normalizedStatus = state.status;
    const statusObservationSequence = recordSuccessfulStatusObservation();

    const logHistoryRevision = String(
      normalizedStatus.log_history_revision ?? '',
    ).trim();
    if (
      logHistoryRevision
      && logHistoryRevision !== String(state.utility.logHistoryRevision || '')
      && typeof syncUtilityLogHistoryRevision === 'function'
    ) {
      try {
        const historySync = syncUtilityLogHistoryRevision(logHistoryRevision);
        Promise.resolve(historySync).catch((historyError) => {
          console.error(
            '[AlbumHaven][History] Failed to synchronize server-recorded history.',
            historyError,
          );
        });
      } catch (historyError) {
        console.error(
          '[AlbumHaven][History] Failed to synchronize server-recorded history.',
          historyError,
        );
      }
    }

    const scanOutcome = String(normalizedStatus.scan_outcome || '').trim().toLowerCase();
    const lastErrorText = scanOutcome === 'running'
      ? ''
      : String(normalizedStatus.last_error || '').trim();
    const err = document.getElementById('last-error');
    if (err) {
      if (lastErrorText) {
        err.style.display = 'block';
        err.textContent = `Last scan error: ${lastErrorText}`;
      } else {
        err.style.display = 'none';
        err.textContent = '';
      }
    }
    if (lastErrorText) {
      if (state.ui.lastStatusErrorToastIdentity !== lastErrorText) {
        state.ui.lastStatusErrorToastIdentity = lastErrorText;
        showToast(`Last scan error: ${escapeHtml(lastErrorText)}`, 'error', 4800);
      }
      const scanGeneration = Number(normalizedStatus.scan_generation) || 0;
      const historyIdentity = `${scanGeneration}:${lastErrorText}`;
      if (state.ui.lastStatusErrorHistoryIdentity !== historyIdentity) {
        state.ui.lastStatusErrorHistoryIdentity = historyIdentity;
        try {
          const historyPersistence = prependUtilityLogHistoryEntry({
            id: `library-status-error:${scanGeneration}`,
            action: 'Library status error',
            level: 'error',
            error: lastErrorText,
            scan_generation: scanGeneration,
            scan_phase: String(normalizedStatus.scan_phase || ''),
            scan_outcome: scanOutcome,
          });
          Promise.resolve(historyPersistence).catch((historyError) => {
            console.error(
              '[AlbumHaven][History] Failed to persist a library status error.',
              historyError,
            );
          });
        } catch (historyError) {
          console.error(
            '[AlbumHaven][History] Failed to persist a library status error.',
            historyError,
          );
        }
      }
    } else {
      state.ui.lastStatusErrorToastIdentity = '';
      state.ui.lastStatusErrorHistoryIdentity = '';
    }

    const scanFinalizing = Boolean(normalizedStatus.scan_in_progress)
      && String(normalizedStatus.scan_phase || '').trim().toLowerCase() === 'finalizing';
    const busyNow = normalizedStatus.scan_in_progress || normalizedStatus.relations_in_progress;
    const coverBusyNow = Boolean(normalizedStatus.covers_in_progress);
    const wasPollingBusy = Boolean(state.wasPollingBusy);
    const wasScanFinalizing = Boolean(state.wasScanFinalizing);
    const wasCoverPollingBusy = Boolean(state.wasCoverPollingBusy);
    state.wasPollingBusy = busyNow;
    state.wasScanFinalizing = scanFinalizing;
    state.wasCoverPollingBusy = coverBusyNow;
    if ((!busyNow || scanFinalizing) && !state.ui.scanPageReturnContext) {
      state.ui.forceScanPageVisible = false;
    }
    if (scanFinalizing && !wasScanFinalizing) {
      state.ui.pendingScanCompletionViewRefreshRetryCount = 0;
      state.ui.pendingScanCompletionViewRefreshRetryExhausted = false;
      state.ui.pendingScanCompletionViewRefresh = true;
      state.ui.pendingScanCompletionViewRefreshEligibleRequestId = (
        readActiveScanCompletionPreviewRequestId()
      );
      const scanGeneration = Number(normalizedStatus.scan_generation || 0);
      const settledApplySatisfiesFinalizing = (
        !state.ui.pendingScanCompletionViewRefreshEligibleRequestId
        && settledCanonicalFullViewApplySatisfiesFinalizing(
          scanGeneration,
          statusObservationSequence,
        )
      );
      state.ui.lastSuccessfulCanonicalFullViewApply = null;
      if (settledApplySatisfiesFinalizing) {
        clearPendingScanCompletionViewRefresh();
      } else if (!hasPendingSidebarNavigation()) {
        await dispatchPendingScanCompletionViewRefresh();
      }
    }
    if (wasPollingBusy && !busyNow) {
      const scanWasCancelled = (
        Boolean(state.ui.scanCancellationAcknowledged)
        || String(normalizedStatus.scan_outcome || '').trim().toLowerCase() === 'cancelled'
      );
      if (state.ui.pendingScanCompletionViewRefreshRetryScheduled) {
        clearBrowserTimeout(state.ui.pendingScanCompletionViewRefreshRetryTimerId);
      }
      state.ui.pendingScanCompletionViewRefreshRetryToken = (
        Number(state.ui.pendingScanCompletionViewRefreshRetryToken || 0) + 1
      );
      state.ui.pendingScanCompletionViewRefreshRetryScheduled = false;
      state.ui.pendingScanCompletionViewRefreshRetryTimerId = 0;
      state.ui.pendingScanCompletionViewRefreshRetryCount = 0;
      state.ui.pendingScanCompletionViewRefreshRetryExhausted = false;
      state.ui.pendingScanCompletionViewRefresh = true;
      state.ui.pendingScanCompletionViewRefreshEligibleRequestId = 0;
      state.ui.lastSuccessfulCanonicalFullViewApply = null;
      if (!hasPendingSidebarNavigation()) {
        await dispatchPendingScanCompletionViewRefresh();
      }
      state.ui.scanCancellationAcknowledged = false;
      if (!normalizedStatus.last_error && !scanWasCancelled) {
        showToast('Library scan complete.', 'success', 3200);
      }
    }
    if (wasCoverPollingBusy && !coverBusyNow) {
      if (shouldAutoRefreshViewAfterCoverCompletion()) {
        if (state.ui.pendingCoverCompletionViewRefreshRetryScheduled) {
          clearBrowserTimeout(state.ui.pendingCoverCompletionViewRefreshRetryTimerId);
        }
        state.ui.pendingCoverCompletionViewRefreshRetryToken = (
          Number(state.ui.pendingCoverCompletionViewRefreshRetryToken || 0) + 1
        );
        state.ui.pendingCoverCompletionViewRefreshRetryScheduled = false;
        state.ui.pendingCoverCompletionViewRefreshRetryTimerId = 0;
        state.ui.pendingCoverCompletionViewRefreshRetryCount = 0;
        state.ui.pendingCoverCompletionViewRefreshRetryExhausted = false;
        state.ui.pendingCoverCompletionViewRefresh = true;
        await dispatchPendingCoverCompletionViewRefresh();
      }
      if (state.utility.loaded) {
        await loadProblematicFiles(true);
      }
      showToast('Album covers updated.', 'success', 3200);
    }
    const statusMenu = document.getElementById('status-context-menu');
    const visibleStatusMenuNeedsBusySampling = Boolean(
      (busyNow || coverBusyNow) && statusMenu && !statusMenu.hidden,
    );
    scheduleBrowserTimeout(
      pollStatus,
      visibleStatusMenuNeedsBusySampling
        ? STATUS_POLL_VISIBLE_MENU_BUSY_DELAY_MS
        : ((busyNow || coverBusyNow) ? 1000 : 3000),
    );
  } catch (error) {
    scheduleBrowserTimeout(pollStatus, 3000);
  }
}
