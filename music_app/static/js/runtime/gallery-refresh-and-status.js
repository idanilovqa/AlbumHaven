// Root browsing has authoritative navigation and totals but only a bounded page
// of albums. Continuations never own the foreground/search request slot.
let rootGalleryPageRequest = null;

function isPagedRootGallery(view = state.view) {
  const surface = typeof resolveViewSurface === 'function'
    ? resolveViewSurface(view)
    : String(view?.surface?.active || view?.surface_request || 'albums');
  return Boolean(view?.gallery_page
    && !String(view.query || '').trim()
    && !String(view.selected_artist || '').trim()
    && surface === 'albums');
}

function cancelRootGalleryPageRequest() {
  rootGalleryPageRequest?.controller.abort();
  rootGalleryPageRequest = null;
}

function mergeRootGalleryPageGroups(existing, incoming) {
  const groups = (existing || []).map(group => ({ ...group, albums: [...(group.albums || [])] }));
  const byArtist = new Map(groups.map(group => [String(group.display_artist_key || group.artist || ''), group]));
  for (const incomingGroup of incoming || []) {
    const artistKey = String(incomingGroup.display_artist_key || incomingGroup.artist || '');
    let group = byArtist.get(artistKey);
    if (!group) {
      group = { ...incomingGroup, albums: [] };
      groups.push(group);
      byArtist.set(artistKey, group);
    }
    const identities = new Set(group.albums.map(album => String(album.key || '')));
    for (const album of incomingGroup.albums || []) {
      const identity = String(album.key || '');
      if (!identity || identities.has(identity)) continue;
      identities.add(identity);
      group.albums.push(album);
    }
  }
  return groups;
}

function buildRootGalleryPageUrl(view) {
  return buildApiUrl({ ...view, ...(view.gallery_page_scope || {}) });
}

async function loadNextRootGalleryPage() {
  const view = state.view;
  const page = view?.gallery_page;
  const scroll = document.getElementById('albums-scroll');
  const prefetchViewportCount = 4;
  if (!isPagedRootGallery(view) || !page.has_more || !page.next_cursor
    || rootGalleryPageRequest || state.busy || hasPendingSidebarNavigation()
    || !scroll || scroll.clientHeight <= 0
    || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight
      > prefetchViewportCount * scroll.clientHeight) return false;
  const request = {
    controller: new AbortController(),
    viewRevision: readViewStateRevision(),
    url: buildRootGalleryPageUrl(view),
    cursor: page.next_cursor,
    revision: page.revision,
  };
  rootGalleryPageRequest = request;
  const ownsResponse = () => rootGalleryPageRequest === request
    && !request.controller.signal.aborted
    && readViewStateRevision() === request.viewRevision
    && isPagedRootGallery()
    && buildRootGalleryPageUrl(state.view) === request.url
    && state.view.gallery_page.next_cursor === request.cursor
    && state.view.gallery_page.revision === request.revision;
  const ownsRootBrowseIdentity = () => rootGalleryPageRequest === request
    && !request.controller.signal.aborted
    && isPagedRootGallery()
    && buildRootGalleryPageUrl(state.view) === request.url;
  const url = new URL(request.url, window.location.href);
  url.searchParams.set('gallery_page_size', '50');
  url.searchParams.set('gallery_cursor', request.cursor);
  url.searchParams.set('omit_sidebar', '1');
  try {
    let response = await fetch(`${url.pathname}${url.search}`, {
      headers: { Accept: 'application/json' }, signal: request.controller.signal,
    });
    let restarted = false;
    if (response.status === 409) {
      const conflict = await response.json();
      if (!ownsRootBrowseIdentity() || conflict?.restart_required !== true) return false;
      // Catalog changes invalidate the cursor. Replace atomically with one fresh
      // bounded page; keep the old cards visible until that response arrives.
      url.searchParams.delete('gallery_cursor');
      url.searchParams.delete('omit_sidebar');
      response = await fetch(`${url.pathname}${url.search}`, {
        headers: { Accept: 'application/json' }, signal: request.controller.signal,
      });
      restarted = true;
    }
    const ownsDataResponse = restarted ? ownsRootBrowseIdentity : ownsResponse;
    const data = await readGalleryResponse(response, ownsDataResponse);
    if (!ownsDataResponse()) return false;
    if (!data.gallery_page || !data.gallery_page.revision
      || (!restarted && data.gallery_page.revision !== request.revision)
      || (data.gallery_page.has_more && (!data.gallery_page.next_cursor
        || (!restarted && data.gallery_page.next_cursor === request.cursor)))
      || !Array.isArray(data.artist_groups)) return false;
    const artistGroups = restarted
      ? data.artist_groups
      : mergeRootGalleryPageGroups(state.view.artist_groups, data.artist_groups);
    applyViewPayload({
      ...state.view,
      ...(restarted ? {
        ...data,
        gallery_page_scope: {
          ...(state.view.gallery_page_scope || {}),
          gallery_scope: data.gallery_scope,
          visible_library_categories: data.visible_library_categories,
        },
      } : {}),
      artist_groups: artistGroups,
      gallery_page: data.gallery_page,
      initial_view_partial: false,
    }, {
      trackSidebarReveal: false,
      preserveSidebarState: !restarted || state.view.gallery_page_scope?.preserve_sidebar === true,
      preserveGalleryBrowseLocationState: true,
      rootGalleryContinuation: true,
    });
    const renderOptions = { preserveScroll: true, preserveMountedGalleryChildren: true };
    if (restarted) renderView(renderOptions);
    else renderArtistGroups(renderOptions);
    // Fill only the visible buffer, including a short initial page. Rechecking
    // geometry after rendering prevents an idle timer from draining the library.
    scheduleBrowserAnimationFrame(() => { void loadNextRootGalleryPage(); });
    return true;
  } catch (error) {
    if (ownsResponse() && error?.name !== 'AbortError') {
      showToast('Unable to load more albums. Scroll to retry.', 'error', 3200);
    }
    return false;
  } finally {
    if (rootGalleryPageRequest === request) rootGalleryPageRequest = null;
  }
}

async function loadPreviousRootGalleryPage() {
  const view = state.view;
  const page = view?.gallery_page;
  const scroll = document.getElementById('albums-scroll');
  if (!isPagedRootGallery(view) || !page?.has_previous || !page.previous_cursor
    || rootGalleryPageRequest || state.busy || hasPendingSidebarNavigation()
    || !scroll || scroll.clientHeight <= 0 || scroll.scrollTop > scroll.clientHeight * 2) return false;

  const request = {
    controller: new AbortController(),
    cursor: page.previous_cursor,
    revision: page.revision,
    viewRevision: Number(state.ui.viewStateRevision || 0),
    url: buildRootGalleryPageUrl(view),
  };
  rootGalleryPageRequest = request;
  const ownsResponse = () => (
    rootGalleryPageRequest === request
    && !request.controller.signal.aborted
    && Number(state.ui.viewStateRevision || 0) === request.viewRevision
    && buildRootGalleryPageUrl(state.view) === request.url
    && state.view.gallery_page?.previous_cursor === request.cursor
    && state.view.gallery_page?.revision === request.revision
  );

  try {
    const url = new URL(request.url, window.location.href);
    url.searchParams.set('gallery_page_size', '50');
    url.searchParams.set('gallery_cursor', request.cursor);
    url.searchParams.set('gallery_page_direction', 'previous');
    url.searchParams.set('omit_sidebar', '1');
    const response = await fetch(`${url.pathname}${url.search}`, {
      headers: { Accept: 'application/json' },
      signal: request.controller.signal,
    });
    if (response.status === 409 || !ownsResponse()) return false;
    const data = await readGalleryResponse(response, ownsResponse);
    if (!ownsResponse() || !Array.isArray(data.artist_groups)
      || data.gallery_page?.revision !== request.revision
      || (data.gallery_page?.has_previous && !data.gallery_page.previous_cursor)
      || data.gallery_page?.previous_cursor === request.cursor) return false;

    const currentPage = state.view.gallery_page;
    applyViewPayload({
      ...state.view,
      artist_groups: mergeRootGalleryPageGroups(data.artist_groups, state.view.artist_groups),
      gallery_page: {
        ...currentPage,
        previous_cursor: data.gallery_page.previous_cursor || null,
        has_previous: Boolean(data.gallery_page.has_previous),
      },
      initial_view_partial: false,
    }, {
      trackSidebarReveal: false,
      preserveSidebarState: true,
      preserveGalleryBrowseLocationState: true,
      rootGalleryContinuation: true,
    });
    renderArtistGroups({ preserveScroll: true, preserveMountedGalleryChildren: true });
    return true;
  } catch (error) {
    if (error?.name !== 'AbortError') {
      showToast(error.message || 'Unable to load earlier albums.', 'error', 3200);
    }
    return false;
  } finally {
    if (rootGalleryPageRequest === request) rootGalleryPageRequest = null;
  }
}

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
let libraryStatusAction = null;
let statusReadRevision = 0;
let statusPollSequence = 0;
let statusPollTimer = null;

function scheduleStatusPoll(delay) {
  const dueAt = Date.now() + delay;
  // Keep the earliest read, especially the 150/250ms action acknowledgement read.
  if (statusPollTimer && statusPollTimer.dueAt <= dueAt) return;
  if (statusPollTimer) clearBrowserTimeout(statusPollTimer.id);
  const scheduled = { dueAt, id: null };
  statusPollTimer = scheduled;
  scheduled.id = scheduleBrowserTimeout(() => {
    if (statusPollTimer !== scheduled) return;
    statusPollTimer = null;
    return pollStatus();
  }, delay);
}

function claimLibraryStatusAction(pendingStart) {
  libraryStatusAction = { pendingStart };
  state.ui.scanCancellationPending = false;
  statusReadRevision += 1;
  // Completion retries belong to the scan that produced them, not a later intent.
  clearPendingScanCompletionViewRefresh();
  state.ui.pendingScanCompletionViewRefreshPromise = null;
  state.ui.pendingCoverCompletionViewRefreshPromise = null;
  clearPendingCoverCompletionViewRefresh();
  return libraryStatusAction;
}

function clearPendingCoverCompletionViewRefresh() {
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
  state.ui.pendingCoverCompletionViewRefresh = false;
}

function settleLibraryStatusAction(action) {
  if (libraryStatusAction !== action) return false;
  action.pendingStart = false;
  statusReadRevision += 1;
  return true;
}

function currentStatusPollDelay() {
  const status = state.status || {};
  const busy = status.scan_in_progress || status.relations_in_progress || status.covers_in_progress;
  const statusMenu = document.getElementById('status-context-menu');
  return busy && statusMenu && !statusMenu.hidden
    ? STATUS_POLL_VISIBLE_MENU_BUSY_DELAY_MS
    : (busy ? 1000 : 3000);
}

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

function beginPendingViewTransition(requestId, options = {}) {
  state.ui.pendingGallerySearch = options.showSearchProgress === true;
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
  const wasSearching = state.ui.pendingGallerySearch === true;
  state.ui.pendingViewTransition = false;
  state.ui.pendingGallerySearch = false;
  state.ui.pendingViewTransitionRequestId = 0;
  if (wasSearching || options.restoreCurrentGallery === true) {
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

function dispatchPendingScanCompletionViewRefresh(shareStatusCompletion = false) {
  if (!shareStatusCompletion) return performPendingScanCompletionViewRefresh();
  if (!state.ui.pendingScanCompletionViewRefreshPromise) {
    const pending = performPendingScanCompletionViewRefresh().catch(error => {
      if (state.ui.pendingScanCompletionViewRefreshPromise === pending) state.ui.pendingScanCompletionViewRefreshPromise = null;
      throw error;
    });
    state.ui.pendingScanCompletionViewRefreshPromise = pending;
  }
  return state.ui.pendingScanCompletionViewRefreshPromise;
}

async function performPendingScanCompletionViewRefresh() {
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

function dispatchPendingCoverCompletionViewRefresh(shareStatusCompletion = false) {
  if (!shareStatusCompletion) return performPendingCoverCompletionViewRefresh();
  if (!state.ui.pendingCoverCompletionViewRefreshPromise) {
    const pending = performPendingCoverCompletionViewRefresh().catch(error => {
      if (state.ui.pendingCoverCompletionViewRefreshPromise === pending) state.ui.pendingCoverCompletionViewRefreshPromise = null;
      throw error;
    });
    state.ui.pendingCoverCompletionViewRefreshPromise = pending;
  }
  return state.ui.pendingCoverCompletionViewRefreshPromise;
}

async function performPendingCoverCompletionViewRefresh() {
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
    const tagEditOwnsGalleryResources = Boolean(
      typeof hasPendingTagEditViewMutations === 'function'
      && hasPendingTagEditViewMutations()
    );
    if (state.busy || hasPendingSidebarNavigation() || tagEditOwnsGalleryResources) {
      return false;
    }
    const originatingRevision = readViewStateRevision();
    const refreshApplied = await fetchAndRender(buildApiUrl(state.view, { rootFullPayload: true }), false, {
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
  const renderOptions = { ...options };
  const requestedScroll = options.absoluteScrollPosition;
  const galleryScroll = document.getElementById('albums-scroll');
  if (
    options.preserveAbsoluteScroll === true
    && options.absoluteScrollPositionApplied === true
    && Number.isFinite(Number(requestedScroll?.scrollTop))
    && Number.isFinite(Number(requestedScroll?.scrollLeft))
    && galleryScroll
    && (
      Math.abs(Number(galleryScroll.scrollTop || 0) - Number(requestedScroll.scrollTop)) > 1
      || Math.abs(Number(galleryScroll.scrollLeft || 0) - Number(requestedScroll.scrollLeft)) > 1
    )
  ) {
    renderOptions.preserveAbsoluteScroll = false;
    delete renderOptions.absoluteScrollPosition;
    delete renderOptions.absoluteScrollPositionApplied;
  }
  const preserveMountedSelectedViewNodes = Boolean(
    options.preserveMountedGalleryChildren === true
    && options.retainMountedSelectedViewState
    && typeof options.retainMountedSelectedViewState === 'object'
  );
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.value = String(state.ui?.searchDraftQuery ?? state.view.query ?? '');
    if (typeof updateSearchClearAction === 'function') updateSearchClearAction(searchInput);
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
    renderArtistGroups(renderOptions);
  } else if (typeof updateGalleryMainChrome === 'function') {
    // Retained cards do not imply that search or artist context is unchanged.
    updateGalleryMainChrome();
  }
  renderLibraryLoader(state.status);
  scheduleSidebarRender();
  if (typeof syncMobileHome === 'function') syncMobileHome();
  if (typeof syncMobileGalleryControls === 'function') syncMobileGalleryControls();
  if (isPagedRootGallery()) {
    scheduleBrowserAnimationFrame(() => {
      scheduleBrowserAnimationFrame(() => { void loadNextRootGalleryPage(); });
    });
  }
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

async function readGalleryResponse(response, ownsResponse) {
  if (response.status === 401) {
    if (ownsResponse()) window.location.assign('/login');
    throw new Error('Sign in again to continue.');
  }
  const data = await response.json();
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `View request failed: ${response.status}`);
  }
  return data;
}

function rootGalleryRefreshCoverage(apiUrl, options) {
  if (!options.preserveScroll || options.startupRefresh || !isPagedRootGallery()) return 0;
  const url = new URL(apiUrl, 'http://localhost');
  if (url.pathname !== '/view-data' || url.searchParams.get('surface') !== 'albums'
    || !url.searchParams.has('gallery_page_size')
    || ['q', 'artist', 'genre', 'mood', 'style', 'duration_min', 'duration_max',
      'related_artist', 'primary_filter', 'gallery_cursor', 'payload_tier', 'root_sidebar']
      .some(key => url.searchParams.has(key))) return 0;
  const scope = state.view.gallery_page_scope || state.view;
  if (String(scope.gallery_scope || '') !== String(url.searchParams.get('gallery_scope') || '')) return 0;
  const categories = [...(scope.visible_library_categories || [])].sort();
  const requestedCategories = url.searchParams.getAll('category').sort();
  if (JSON.stringify(categories) !== JSON.stringify(requestedCategories)) return 0;
  return (state.view.artist_groups || []).reduce((count, group) => count + (group.albums || []).length, 0);
}

async function collectRootGalleryRefresh(data, apiUrl, coverage, controller, ownsResponse) {
  let payload = data;
  let restarted = false;
  const cursors = new Set();
  let remainingPages = Math.ceil(coverage / 50);
  while (ownsResponse()) {
    const page = payload?.gallery_page;
    const count = (payload?.artist_groups || []).reduce((sum, group) => sum + (group.albums || []).length, 0);
    if (!page?.has_more || count >= coverage) return payload;
    const cursor = String(page.next_cursor || '');
    if (!cursor || cursors.has(cursor) || remainingPages-- <= 0) {
      throw new Error('Root gallery refresh did not advance within its loaded coverage.');
    }
    cursors.add(cursor);
    const url = new URL(apiUrl, 'http://localhost');
    url.searchParams.set('gallery_page_size', '50');
    url.searchParams.set('gallery_cursor', cursor);
    url.searchParams.set('omit_sidebar', '1');
    const response = await fetch(`${url.pathname}${url.search}`, {
      headers: { Accept: 'application/json' }, signal: controller?.signal,
    });
    if (!ownsResponse()) return null;
    const next = response.status === 409 ? null : await readGalleryResponse(response, ownsResponse);
    if (!ownsResponse()) return null;
    if (response.status === 409 || String(next?.gallery_page?.revision || '') !== String(page.revision || '')) {
      if (restarted) throw new Error('Root gallery changed again while refreshing loaded albums.');
      restarted = true;
      cursors.clear();
      remainingPages = Math.ceil(coverage / 50);
      url.searchParams.delete('gallery_cursor');
      url.searchParams.delete('omit_sidebar');
      const restartResponse = await fetch(`${url.pathname}${url.search}`, {
        headers: { Accept: 'application/json' }, signal: controller?.signal,
      });
      payload = await readGalleryResponse(restartResponse, ownsResponse);
      continue;
    }
    if (next.gallery_page.has_more && cursors.has(String(next.gallery_page.next_cursor || ''))) {
      throw new Error('Root gallery refresh returned a repeated cursor.');
    }
    payload = {
      ...payload,
      artist_groups: mergeRootGalleryPageGroups(payload.artist_groups, next.artist_groups),
      gallery_page: next.gallery_page,
    };
  }
  return null;
}

async function fetchAndRender(url, push = true, options = {}) {
  cancelRootGalleryPageRequest();
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
  const rootRefreshCoverage = rootGalleryRefreshCoverage(apiUrl, requestOptions);
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
    // Foreground navigation supersedes a Home hydration deferred by Settings,
    // including a resumed request that was just interrupted by this search.
    state.ui.deferredUtilityViewRequest = null;
    state.awaitingInitialDataRefresh = false;
  }
  if (state.busy) {
    if (
      String(state.ui.activeViewRequestUrl || '') === apiUrl
      && Number(state.ui.activeViewRequestTagEditMutationRevision || 0)
        === Number(state.ui.tagEditOptimisticMutationRevision || 0)
      && Number(state.ui.activeViewRequestCoverMutationRevision || 0)
        === Number(state.ui.albumCoverMutationRevision || 0)
    ) {
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
  const requestTagEditMutationRevision = Number(state.ui.tagEditOptimisticMutationRevision || 0);
  const requestCoverMutationRevision = Number(state.ui.albumCoverMutationRevision || 0);
  const requestModalAlbum = state.modalReleases?.[state.modalReleaseIndex] || null;
  const requestModalCoverAuthority = requestModalAlbum ? { ...requestModalAlbum } : null;
  const requestVisibleAlbums = typeof flattenVisibleAlbums === 'function' ? flattenVisibleAlbums() : [];
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  state.ui.activeViewRequestId = requestId;
  state.ui.activeViewRequestTagEditMutationRevision = requestTagEditMutationRevision;
  state.ui.activeViewRequestCoverMutationRevision = requestCoverMutationRevision;
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
  if (requestOptions.showSearchProgress || state.ui.pendingViewTransition
    || (!requestOptions.preserveScroll && requestOptions.skipPendingViewTransition !== true)) {
    beginPendingViewTransition(requestId, requestOptions);
  }
  if (!requestOptions.preserveScanPage && !state.ui.scanPageReturnContext) {
    state.ui.forceScanPageVisible = false;
  }
  if (requestOptions.preserveGalleryOptionsMenu !== true && !requestOptions.startupRefresh) {
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
    let data = await readGalleryResponse(response, () => requestOwnsCurrentViewState(requestId, requestViewStateRevision));
    if (rootRefreshCoverage > 0) {
      const ownsRefresh = () => {
        if (!requestOwnsCurrentViewState(requestId, requestViewStateRevision)
          || requestTagEditMutationRevision !== Number(state.ui.tagEditOptimisticMutationRevision || 0)) return false;
        try {
          return typeof requestOptions.shouldApplyResponse !== 'function' || requestOptions.shouldApplyResponse(data) === true;
        } catch (_error) {
          return false;
        }
      };
      data = await collectRootGalleryRefresh(data, apiUrl, rootRefreshCoverage, controller, ownsRefresh);
      if (!data || !ownsRefresh()) return false;
    }
    markStartupFollowup('payload_received', requestOptions, {
      endpoint: apiUrl,
      artistCount: Number(data?.artist_count || 0),
      albumCount: Number(data?.album_count || 0),
      payloadTier: String(data?.payload_tier || ''),
    });
    if (!requestOwnsCurrentViewState(requestId, requestViewStateRevision)) {
      return false;
    }
    // A response dispatched before a tag edit must not replace its optimistic view.
    if (requestTagEditMutationRevision !== Number(state.ui.tagEditOptimisticMutationRevision || 0)) {
      return false;
    }
    // Artwork published after this request started owns the album cover state.
    if (requestCoverMutationRevision !== Number(state.ui.albumCoverMutationRevision || 0)) {
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
    if (data.gallery_page && !requestOptions.startupRefresh) state.awaitingInitialDataRefresh = false;
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
    const responseModalAlbum = state.modalReleases?.[state.modalReleaseIndex] || null;
    const requestKnownAlbum = requestVisibleAlbums.find((album) => album.key === responseModalAlbum?.key);
    const responseModalCoverAuthority = requestModalCoverAuthority || requestKnownAlbum;
    // Save replaces the known album object even when its selected bytes and
    // legacy selection fields are unchanged. Check before applying this view.
    const responseOwnsModalAlbum = Boolean(responseModalAlbum?.key && responseModalCoverAuthority
      && (!requestModalAlbum || responseModalAlbum === requestModalAlbum)
      && ['cover_path', 'cover_revision', 'cover_selection_origin', 'cover_selection_provenance',
        'remote_cover_url', 'remote_cover_thumbnail_url', 'remote_cover_source'].every(
        (field) => responseModalAlbum[field] === responseModalCoverAuthority[field],
      ));
    applyViewPayload(payloadToApply, responseApplyOptions);
    finishPendingViewTransition(requestId);
    markStartupFollowup('apply_complete', requestOptions, {
      artistCount: Number(state.view?.artist_count || 0),
      albumCount: Number(state.view?.album_count || 0),
    });
    markStartupFollowup('render_started', requestOptions);
    attachModalEvents();
    state.ui.activeViewPayloadReady = true;
    const mountedGalleryContainer = document.getElementById('artist-groups');
    const hasMountedGalleryContent = Boolean(
      mountedGalleryContainer?.querySelector('.artist-section, .album-card'),
    );
    const preserveMountedGallery = Boolean(
      retainedCommittedSearchGallery
      && requestOptions.preserveScroll !== false
      && hasMountedGalleryContent
      && hasEquivalentGalleryRenderTopology(
        retainedCommittedSearchGallery,
        state.view?.artist_groups,
      )
    );
    renderView({
      ...responseApplyOptions,
      ...(preserveMountedGallery ? { preserveMountedGallery: true } : {}),
    });
    const currentModalAlbum = state.modalReleases?.[state.modalReleaseIndex] || null;
    if (responseOwnsModalAlbum && currentModalAlbum === responseModalAlbum
        && typeof refreshOpenTrackModalVersionState === 'function'
        && typeof flattenVisibleAlbums === 'function'
        && typeof albumRequiresHydration === 'function') {
      const canonicalAlbum = [data.primary_artist_groups, data.family_artist_groups, data.artist_groups]
        .flatMap((groups) => (Array.isArray(groups) ? groups : []))
        .flatMap((group) => (Array.isArray(group?.albums) ? group.albums : []))
        .find((album) => (
          album.key === currentModalAlbum.key && !albumRequiresHydration(album)
          && (Object.prototype.hasOwnProperty.call(album, 'cover_path')
            || Object.prototype.hasOwnProperty.call(album, 'remote_cover_url'))
        ));
      if (canonicalAlbum && !retainedMountedSelectedViewState) {
        refreshOpenTrackModalVersionState(currentModalAlbum.key, canonicalAlbum);
      }
    }
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
      response.ok
      && data?.ok !== false
      && (
        (requestOptions.startupRefresh
          && !String(requestOptions.startupHydrationFollowupEndpoint || '').trim())
        || isCanonicalFullViewPayload(data, requestOptions)
      )
    ) {
      startupMetrics.completeInitialRefresh(state.view);
    }
    if (
      requestOptions.startupRefresh
      && String(requestOptions.startupHydrationFollowupEndpoint || '').trim()
    ) {
      const followupHydrationTier = startupHydrationTier === 'sidebar' ? 'full' : 'sidebar';
      queueStartupHydrationFollowup(
        requestOptions.startupHydrationFollowupEndpoint,
        {
          startupHydrationTier: followupHydrationTier,
          ...(followupHydrationTier === 'sidebar'
            ? {
              retainMountedSelectedViewState: { ...state.view },
              skipPendingViewTransition: true,
            }
            : {}),
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
    if (requestOptions.startupRefresh) window.AlbumHavenStartupProgress?.fail();
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
      state.ui.activeViewRequestTagEditMutationRevision = null;
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
    if (
      !state.busy
      && !state.ui.pendingViewRequest
      && !state.ui.scanPageReturnContext
      && !state.ui.forceScanPageVisible
    ) {
      resumeScanPageGalleryCoverLoads();
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
  const action = claimLibraryStatusAction(true);
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
    // Reads taken before HTTP acceptance may still contain the pre-start snapshot.
    if (!settleLibraryStatusAction(action)) return false;
    if (response.status === 409 && data?.already_running) {
      updateStatusIndicator(previousStatus);
      showToast('Library scan is already running.', 'info', 2200);
      scheduleStatusPoll(250);
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
    scheduleStatusPoll(250);
    return true;
  } catch (error) {
    if (!settleLibraryStatusAction(action)) return false;
    updateStatusIndicator(previousStatus);
    indicator.classList.remove('is-busy');
    indicator.classList.add('is-done');
    indicator.title = 'Unable to start library scan';
    showToast('Unable to start library scan.', 'error', 3200);
    return false;
  }
}
function claimLocalViewStateNavigation() {
  cancelRootGalleryPageRequest();
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
  if (searchInput) {
    searchInput.value = '';
    if (typeof updateSearchClearAction === 'function') updateSearchClearAction(searchInput);
  }
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
  if (typeof unmountLibraryStatusBar === 'function') unmountLibraryStatusBar();
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
  if (typeof unmountLibraryStatusBar === 'function') unmountLibraryStatusBar();
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.value = state.ui.searchDraftQuery;
    if (typeof updateSearchClearAction === 'function') updateSearchClearAction(searchInput);
  }
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
  const action = claimLibraryStatusAction(false);
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
    if (!settleLibraryStatusAction(action)) return false;
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
    scheduleStatusPoll(150);
    return Boolean(data.cancelled);
  } catch (error) {
    if (!settleLibraryStatusAction(action)) return false;
    showToast(error?.message || `Failed to cancel ${scanLabel}.`, 'error', 3200);
    return false;
  } finally {
    if (libraryStatusAction === action) {
      state.ui.scanCancellationPending = false;
      renderLibraryLoader(state.status, {
        scanPageVisible: Boolean(state.ui.scanPageReturnContext),
      });
    }
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
    if (typeof unmountLibraryStatusBar === 'function') unmountLibraryStatusBar();
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
      if (typeof unmountLibraryStatusBar === 'function') unmountLibraryStatusBar();
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

function watcherHealthRefreshSignature(status) {
  const health = status?.watcher_health || {};
  const problems = Array.isArray(health.problems) ? health.problems : [];
  return JSON.stringify([
    String(health.state || ''),
    problems.map(problem => [
      String(problem?.root_key || ''),
      String(problem?.state || ''),
      String(problem?.detected_at || ''),
      String(problem?.message || ''),
      Object.entries(problem?.allowed_actions || {}).sort(([left], [right]) => left.localeCompare(right)),
    ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  ]);
}

async function pollStatus() {
  const sequence = ++statusPollSequence;
  const readRevision = statusReadRevision;
  const startedDuringPendingStart = Boolean(libraryStatusAction?.pendingStart);
  const ownsStatus = () => sequence === statusPollSequence
    && readRevision === statusReadRevision
    && !startedDuringPendingStart;
  let nextPollDelay = null;
  const knownStatus = state.status || {};
  const knownWatcherHealth = watcherHealthRefreshSignature(knownStatus);
  const hadKnownInventoryRevision = Object.prototype.hasOwnProperty.call(
    knownStatus,
    'inventory_mutation_revision',
  );
  const knownInventoryRevision = Number(knownStatus.inventory_mutation_revision || 0);
  const knownBusy = Boolean(
    knownStatus.scan_in_progress
    || knownStatus.relations_in_progress
    || knownStatus.covers_in_progress
  );
  const coverScheduler = typeof galleryCoverLoadScheduler !== 'undefined'
    ? galleryCoverLoadScheduler
    : null;
  try {
    if (
      !knownBusy
      && coverScheduler?.isForegroundIdle?.() === false
      && typeof coverScheduler.whenForegroundIdle === 'function'
    ) {
      await coverScheduler.whenForegroundIdle();
      if (ownsStatus()) nextPollDelay = STATUS_POLL_FOREGROUND_IDLE_RETRY_DELAY_MS;
      return;
    }
    const response = await fetch('/status');
    const data = await readGalleryResponse(response, ownsStatus);
    if (startedDuringPendingStart && sequence === statusPollSequence
        && readRevision === statusReadRevision && libraryStatusAction?.coverPreparation
        && data.covers_in_progress && data.covers_phase === 'preparing'
        && data.covers_run_mode === 'manual-bulk'
        && data.scan_generation === knownStatus.scan_generation
        && !data.scan_in_progress && !data.relations_in_progress) {
      updateStatusIndicator({ ...state.status,
        covers_elapsed_seconds: data.covers_elapsed_seconds,
        status_connection_lost: false });
      return;
    }
    if (!ownsStatus()) return;
    updateStatusIndicator({ ...data, status_connection_lost: false });
    const normalizedStatus = state.status;
    const currentInventoryRevision = Number(
      normalizedStatus.inventory_mutation_revision || 0,
    );
    const inventoryAdvanced = hadKnownInventoryRevision
      && currentInventoryRevision > knownInventoryRevision;
    if (inventoryAdvanced) {
      if (typeof invalidateAllHydratedTrackModalAlbumDetails === 'function') {
        invalidateAllHydratedTrackModalAlbumDetails();
      }
      state.ui.pendingInventoryMutationViewRefresh = true;
    }
    const utility = state.utility;
    const healthChanged = knownWatcherHealth !== watcherHealthRefreshSignature(normalizedStatus);
    if ((utility.loaded || utility.loading) && (inventoryAdvanced || healthChanged)) {
      utility.problematicStatusRefreshRevision = Number(utility.problematicStatusRefreshRevision || 0) + 1;
    }
    const requestedRefreshRevision = Number(utility.problematicStatusRefreshRevision || 0);
    if (!utility.loading && requestedRefreshRevision > Number(utility.problematicStatusSyncedRevision || 0)) {
      try {
        // An earlier in-flight summary cannot satisfy a later status change.
        // Failed/superseded loads return null; keep the change pending for the next poll.
        const refreshedItems = await loadProblematicFiles(true, { preserveSelectedDetail: true });
        if (!ownsStatus()) return;
        if (state.utility === utility && Array.isArray(refreshedItems)) {
          utility.problematicStatusSyncedRevision = requestedRefreshRevision;
        }
      } catch (problematicFilesError) {
        if (!ownsStatus()) return;
        console.error(
          '[AlbumHaven][Watcher] Failed to refresh Problematic Files after a status change.',
          problematicFilesError,
        );
      }
    }
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
    if (lastErrorText) {
      if (state.ui.lastStatusErrorToastIdentity !== lastErrorText) {
        state.ui.lastStatusErrorToastIdentity = lastErrorText;
      showToast(`Last scan error: ${lastErrorText}`, 'error', 4800);
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
    if (busyNow && state.ui.pendingScanCompletionViewRefreshPromise) {
      clearPendingScanCompletionViewRefresh();
      state.ui.pendingScanCompletionViewRefreshPromise = null;
    }
    if (coverBusyNow && state.ui.pendingCoverCompletionViewRefreshPromise) {
      clearPendingCoverCompletionViewRefresh();
      state.ui.pendingCoverCompletionViewRefreshPromise = null;
    }
    // Keep a terminal transition pending until its owned async effects finish.
    // A newer idle observation can then finish it instead of losing completion.
    if (busyNow) state.wasPollingBusy = true;
    state.wasScanFinalizing = scanFinalizing;
    if (coverBusyNow) state.wasCoverPollingBusy = true;
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
        if (!ownsStatus()) return;
      }
    }
    if (wasPollingBusy && !busyNow) {
      const scanWasCancelled = (
        Boolean(state.ui.scanCancellationAcknowledged)
        || String(normalizedStatus.scan_outcome || '').trim().toLowerCase() === 'cancelled'
      );
      if (!state.ui.pendingScanCompletionViewRefreshPromise) {
        clearPendingScanCompletionViewRefresh();
        state.ui.pendingScanCompletionViewRefresh = true;
      }
      if (!hasPendingSidebarNavigation()) {
        await dispatchPendingScanCompletionViewRefresh(true);
        if (!ownsStatus()) return;
      }
      state.ui.scanCancellationAcknowledged = false;
      if (!normalizedStatus.last_error && !scanWasCancelled) {
        showToast('Library scan complete.', 'success', 3200);
      }
      state.ui.pendingInventoryMutationViewRefresh = false;
    }
    state.wasPollingBusy = busyNow;
    state.ui.pendingScanCompletionViewRefreshPromise = null;
    if (wasCoverPollingBusy && !coverBusyNow) {
      if (shouldAutoRefreshViewAfterCoverCompletion()) {
        if (!state.ui.pendingCoverCompletionViewRefreshPromise) {
          clearPendingCoverCompletionViewRefresh();
          state.ui.pendingCoverCompletionViewRefresh = true;
        }
        await dispatchPendingCoverCompletionViewRefresh(true);
        if (!ownsStatus()) return;
      }
      if (state.utility.loaded) {
        await loadProblematicFiles(true);
        if (!ownsStatus()) return;
      }
      const coverOutcome = String(normalizedStatus.covers_outcome || '').trim().toLowerCase();
      if (!['completed', 'cancelled', 'failed'].includes(coverOutcome)) {
        showToast('Cover search was interrupted.', 'warning', 4800);
      }
    }
    state.wasCoverPollingBusy = coverBusyNow;
    state.ui.pendingCoverCompletionViewRefreshPromise = null;
    if (
      state.ui.pendingInventoryMutationViewRefresh
      && !busyNow
      && !coverBusyNow
      && !state.busy
      && !hasPendingSidebarNavigation()
    ) {
      state.ui.pendingInventoryMutationViewRefresh = false;
      try {
        const refreshApplied = await refreshCurrentViewAfterBackgroundCompletion({
          preserveScroll: true,
          restartIfSameUrl: true,
        });
        if (!ownsStatus()) return;
        if (!refreshApplied) {
          state.ui.pendingInventoryMutationViewRefresh = true;
        } else if (typeof invalidateAllHydratedTrackModalAlbumDetails === 'function') {
          invalidateAllHydratedTrackModalAlbumDetails();
        }
      } catch (inventoryRefreshError) {
        if (!ownsStatus()) return;
        state.ui.pendingInventoryMutationViewRefresh = true;
        console.error(
          '[AlbumHaven][Watcher] Failed to refresh the gallery after an inventory change.',
          inventoryRefreshError,
        );
      }
    }
    nextPollDelay = currentStatusPollDelay();
  } catch (error) {
    if (ownsStatus()) {
      nextPollDelay = 3000;
      state.status = { ...state.status, status_connection_lost: true };
      if (typeof invalidateStatusIndicatorPresentation === 'function') {
        invalidateStatusIndicatorPresentation();
      }
      if (typeof renderLibraryLoader === 'function') {
        renderLibraryLoader(state.status);
      }
    }
  } finally {
    // A newer poll owns its continuation. Discarded work must not stop polling
    // or postpone an earlier action read that is already scheduled.
    if (sequence === statusPollSequence && (ownsStatus() || !statusPollTimer)) {
      scheduleStatusPoll(nextPollDelay ?? currentStatusPollDelay());
    }
  }
}
