// Root browsing has authoritative navigation and totals but only a bounded page
// of albums. Continuations never own the foreground/search request slot.
let rootGalleryPageRequest = null;

function captureLooseTrackPreferenceRead(apiUrl, options) {
  if (typeof captureTrackModalPreferenceRead !== 'function') return null;
  const url = new URL(apiUrl, 'http://localhost');
  if (url.pathname !== '/view-data' || (url.searchParams.get('surface') || 'albums') !== 'albums') return null;
  // Pagination, hydration and presentation are projections of one population.
  // Preserve search, artist and filter scope, including unknown future filters.
  for (const key of ['gallery_page_size', 'gallery_cursor', 'omit_sidebar', 'payload_tier', 'root_sidebar',
    'gallery_display', 'gallery_display_mode', 'gallery_scale_percent', 'family_display', 'selected_artist_family_display_mode']) {
    url.searchParams.delete(key);
  }
  // Repeated population selectors are sets; selection order is not a source.
  for (const key of ['category', 'related_artist', 'genre', 'mood', 'style']) {
    const values = [...new Set(url.searchParams.getAll(key))].sort();
    url.searchParams.delete(key);
    for (const value of values) url.searchParams.append(key, value);
  }
  // The server startup URL omits these verified gallery_scope.py defaults;
  // buildApiUrl emits them from the resolved response. They are one population.
  const scopes = url.searchParams.getAll('gallery_scope');
  if (scopes.length <= 1 && (!scopes[0] || scopes[0] === 'all')) {
    url.searchParams.delete('gallery_scope');
    const categories = url.searchParams.getAll('category');
    const defaultCategories = ['main_library', 'hoard', 'new_arrivals'];
    if (categories.length === defaultCategories.length
      && defaultCategories.every(category => categories.includes(category))) {
      url.searchParams.delete('category');
    }
  }
  url.searchParams.set('surface', 'albums');
  url.searchParams.sort();
  return captureTrackModalPreferenceRead('loose', `${url.pathname}${url.search}`, options);
}

function isPagedRootGallery(view = state.view) {
  const surface = typeof resolveViewSurface === 'function'
    ? resolveViewSurface(view)
    : String(view?.surface?.active || view?.surface_request || 'albums');
  return Boolean(view?.gallery_page
    && !String(view.query || '').trim()
    && !String(view.selected_artist || '').trim()
    && surface === 'albums');
}

function cancelRootGalleryPageRequest(expectedOwner = rootGalleryPageRequest) {
  // Detach only this owner before abort observers can install a successor.
  if (rootGalleryPageRequest === expectedOwner) rootGalleryPageRequest = null;
  expectedOwner?.controller.abort();
}

function mergeRootGalleryPageGroups(existing, incoming, previousStamp = null, incomingStamp = null) {
  const retainLoved = typeof incomingStamp === 'string' && /^[0-9a-f]{64}$/.test(incomingStamp) && previousStamp === incomingStamp;
  const groups = (existing || []).map(group => ({ ...group, artist_loved_launch: retainLoved ? group.artist_loved_launch ?? null : null, albums: [...(group.albums || [])] }));
  const byArtist = new Map(groups.map(group => [String(group.display_artist_key || group.artist || ''), group]));
  for (const incomingGroup of incoming || []) {
    const artistKey = String(incomingGroup.display_artist_key || incomingGroup.artist || '');
    let group = byArtist.get(artistKey);
    if (!group) {
      group = { ...incomingGroup, albums: [] };
      groups.push(group);
      byArtist.set(artistKey, group);
    }
    group.artist_loved_launch = incomingGroup.artist_loved_launch ?? null;
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
  if (!isPagedRootGallery(view) || !page.has_more || !page.next_cursor
    || rootGalleryPageRequest || state.busy || hasPendingSidebarNavigation()
    || !scroll || scroll.clientHeight <= 0
    || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 2 * scroll.clientHeight) return false;
  const request = {
    controller: new AbortController(),
    viewRevision: readViewStateRevision(),
    url: buildRootGalleryPageUrl(view),
    cursor: page.next_cursor,
    revision: page.revision,
    tagEditMutationRevision: Number(state.ui.tagEditOptimisticMutationRevision || 0),
    albumPreferenceScope: captureRuntimeAlbumPreferenceScope(),
  };
  rootGalleryPageRequest = request;
  const ownsPage = () => rootGalleryPageRequest === request
    && !request.controller.signal.aborted
    && readViewStateRevision() === request.viewRevision
    && Number(state.ui.tagEditOptimisticMutationRevision || 0) === request.tagEditMutationRevision
    && isPagedRootGallery()
    && buildRootGalleryPageUrl(state.view) === request.url
    && state.view.gallery_page.next_cursor === request.cursor
    && state.view.gallery_page.revision === request.revision;
  const ownsResponse = () => ownsPage()
    && (!request.albumPreferenceScope || runtimeAlbumPreferenceScopeIsCurrent(request.albumPreferenceScope))
    && ownsPage();
  const url = new URL(request.url, window.location.href);
  url.searchParams.set('gallery_page_size', '50');
  url.searchParams.set('gallery_cursor', request.cursor);
  url.searchParams.set('omit_sidebar', '1');
  try {
    if (!ownsResponse()) return false;
    let preferenceRead = captureLooseTrackPreferenceRead(`${url.pathname}${url.search}`, {
      signal: request.controller.signal, isCurrent: ownsResponse,
    });
    if (!ownsResponse()) return false;
    let response = await fetch(`${url.pathname}${url.search}`, {
      headers: { Accept: 'application/json', ...(request.albumPreferenceScope ? {'X-AlbumHaven-Context': request.albumPreferenceScope.context} : {}) },
      credentials: 'same-origin', cache: 'no-store', signal: request.controller.signal,
    });
    let restarted = false;
    if (response.status === 409) {
      const conflict = await response.json();
      if (!ownsResponse() || conflict?.restart_required !== true) return false;
      // Catalog changes invalidate the cursor. Replace atomically with one fresh
      // bounded page; keep the old cards visible until that response arrives.
      url.searchParams.delete('gallery_cursor');
      url.searchParams.delete('omit_sidebar');
      preferenceRead = captureLooseTrackPreferenceRead(`${url.pathname}${url.search}`, {
        signal: request.controller.signal, isCurrent: ownsResponse,
      });
      if (!ownsResponse()) return false;
      response = await fetch(`${url.pathname}${url.search}`, {
        headers: { Accept: 'application/json', ...(request.albumPreferenceScope ? {'X-AlbumHaven-Context': request.albumPreferenceScope.context} : {}) },
      credentials: 'same-origin', cache: 'no-store', signal: request.controller.signal,
      });
      restarted = true;
    }
    const data = await readGalleryResponse(response, ownsResponse, preferenceRead, null, request.albumPreferenceScope);
    if (!ownsResponse()) return false;
    if (!data.gallery_page || !data.gallery_page.revision
      || (!restarted && data.gallery_page.revision !== request.revision)
      || (data.gallery_page.has_more && (!data.gallery_page.next_cursor
        || (!restarted && data.gallery_page.next_cursor === request.cursor)))
      || !Array.isArray(data.artist_groups)) return false;
    const artistGroups = restarted
      ? data.artist_groups
      : mergeRootGalleryPageGroups(state.view.artist_groups, data.artist_groups, state.view.artist_loved_context_ref, data.artist_loved_context_ref);
    if (restarted && typeof admitLooseTrackPreferenceRows === 'function') {
      admitLooseTrackPreferenceRows(data, preferenceRead);
      // Admission notifies synchronous subscribers that may replace this owner.
      if (!ownsResponse()) return false;
    }
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
      artist_loved_context_ref: data.artist_loved_context_ref ?? null,
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
  if(typeof syncAdvancedSearchAppliedView==='function')syncAdvancedSearchAppliedView();
  const renderedView = state.view, renderedRequestId = Number(state.ui?.activeViewRequestId || 0);
  const renderedRevision = Number(state.ui?.viewStateRevision || 0);
  const ownsRender = () => state.view === renderedView
    && renderedRequestId === Number(state.ui?.activeViewRequestId || 0)
    && renderedRevision === Number(state.ui?.viewStateRevision || 0)
    && (typeof options.isCurrentResponse !== 'function' || options.isCurrentResponse() === true)
    && state.view === renderedView && renderedRequestId === Number(state.ui?.activeViewRequestId || 0)
    && renderedRevision === Number(state.ui?.viewStateRevision || 0);
  if (!ownsRender()) return;
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
  if (!ownsRender()) return;
  const artistReconcile = window.AlbumHavenArtistPageRuntime?.reconcileAdmittedView({
    view: renderedView, requestId: renderedRequestId, revision: renderedRevision, isCurrent: ownsRender, renderOptions: options,
  });
  if (!ownsRender()) return;
  if (artistReconcile?.requiresGalleryRender || options.preserveMountedGallery !== true && !preserveMountedSelectedViewNodes) {
    renderArtistGroups({...options, isCurrentResponse: ownsRender});
  } else if (typeof updateGalleryMainChrome === 'function') {
    // Retained cards do not imply that search or artist context is unchanged.
    updateGalleryMainChrome();
  }
  if (!ownsRender()) return;
  renderLibraryLoader(state.status);
  if (!ownsRender()) return;
  scheduleSidebarRender();
  if (!ownsRender()) return;
  if (typeof syncMobileHome === 'function') syncMobileHome();
  if (!ownsRender()) return;
  if (typeof syncMobileGalleryControls === 'function') syncMobileGalleryControls();
  if (!ownsRender()) return;
  window.AlbumHavenSearchRuntime?.syncVisibility();
  if (!ownsRender()) return;
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

function captureGalleryReadScope() {
  const shell = document.getElementById('app-shell');
  const transport = typeof window === 'undefined' ? null : window.AlbumHavenPrivateUITransport;
  let context = null, generation = null;
  try {
    generation = transport?.generation();
    context = transport?.context() || null;
  } catch (_error) { /* Ordinary Search remains available without continuity. */ }
  const searchRuntime = typeof window === 'undefined' ? null : window.AlbumHavenSearchRuntime;
  // Search records identity transitions the shared final-value transport cannot
  // observe. This is continuity evidence inside the existing native read scope,
  // not a new request or authorization owner. Absent Search keeps native behavior.
  const searchIdentityOwner = typeof searchRuntime?.identityRevision === 'function' ? searchRuntime : null;
  return {
    transport, generation, context, searchIdentityOwner,
    searchIdentityRevision: searchIdentityOwner?.identityRevision() ?? null,
    actor: String(shell?.dataset?.nativeAccountId || ''),
    library: String(shell?.dataset?.nativeLibraryId || ''),
    stamp: String(shell?.dataset?.privateUiContext || ''),
  };
}

// A captured request scope cannot recover from an observed identity boundary.
// Weak identity retention avoids changing caller-visible scope data or keeping
// completed scopes alive. New native captures remain independently usable.
const retiredGalleryReadScopes = new WeakSet();
function galleryReadScopeIsCurrent(scope) {
  if (!scope || typeof scope !== 'object' || retiredGalleryReadScopes.has(scope)) return false;
  const retire = () => {retiredGalleryReadScopes.add(scope); return false;};
  const shell = document.getElementById('app-shell');
  const transport = typeof window === 'undefined' ? null : window.AlbumHavenPrivateUITransport;
  if (scope.transport !== transport
    || scope.actor !== String(shell?.dataset?.nativeAccountId || '')
    || scope.library !== String(shell?.dataset?.nativeLibraryId || '')
    || scope.stamp !== String(shell?.dataset?.privateUiContext || '')) return retire();
  const searchIdentityIsCurrent = () => !scope.searchIdentityOwner
    || scope.searchIdentityOwner === (typeof window === 'undefined' ? null : window.AlbumHavenSearchRuntime)
      && scope.searchIdentityOwner.identityRevision() === scope.searchIdentityRevision;
  try {
    if (!searchIdentityIsCurrent() || scope.transport?.generation() !== scope.generation) return retire();
    // Generation listeners are synchronous and may change identity themselves.
    const valid = searchIdentityIsCurrent()
      && scope.transport === (typeof window === 'undefined' ? null : window.AlbumHavenPrivateUITransport)
      && scope.actor === String(shell?.dataset?.nativeAccountId || '')
      && scope.library === String(shell?.dataset?.nativeLibraryId || '')
      && scope.stamp === String(shell?.dataset?.privateUiContext || '');
    return valid || retire();
  } catch (_error) { return retire(); }
}

function retireNativePrivateSearchView(isCurrent, reason = 'context', {beforeObservers} = {}) {
  if (!isCurrent()) return false;
  const requestId = state.ui.activeViewRequestId, revision = readViewStateRevision();
  const wasPrivate = state.view?.private_search === true;
  // Erase the native DTO projection before source-disposal or UI callbacks.
  if (wasPrivate) {
    state.view = normalizePrivateSearchNavigation({
      private_search: true, query: state.view.query,
      search_presentation: state.view.search_presentation,
      selected_artist: '', all_artists_active: false, artists_sidebar: [],
      show_all_artists_sidebar_link: false,
    }, state.view);
    clearPendingSidebarSelection();
    if (state.gallery) {
      state.gallery.sidebarArtistsOverride = null;
      state.gallery.sidebarShowAllArtistsOverride = null;
    }
  }
  const retiredView = state.view;
  const ownsRetirement = () => requestOwnsCurrentViewState(requestId, revision) && state.view === retiredView;
  // Scope capture belongs inside the bridge's publication transaction: a
  // transport generation read can itself synchronously notify listeners.
  const paint = () => {if (wasPrivate && ownsRetirement()) renderSidebar();};
  const runtime = typeof window === 'undefined' ? null : window.AlbumHavenSearchRuntime;
  if (runtime) runtime.retire(reason, {beforeObservers, beforeNotify: paint});
  else {beforeObservers?.(); paint();}
  return ownsRetirement();
}

function privateSearchPendingProgressIsValid(data, {
  sidebarOnly = false, omitSidebar = false, resultCursor = null, sidebarCursor = null,
} = {}) {
  const usableCursor = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
  if (data?.status !== 'pending' || data.selection_pending !== true
    || data.selection_state !== 'selected' || typeof data.selected_artist !== 'string'
    || !data.selected_artist.trim()) return false;
  if (sidebarOnly) {
    if (data.sidebar_only !== true || ['artist_groups', 'tracks', 'page'].some(key => Object.hasOwn(data, key))) return false;
  } else {
    if (Object.hasOwn(data, 'sidebar_only') || !Array.isArray(data.artist_groups) || data.artist_groups.length
      || !Array.isArray(data.tracks) || data.tracks.length || !isRuntimePlainObject(data.page)
      || !Number.isInteger(data.page.limit) || data.page.limit < 1 || data.page.limit > 100
      || data.page.returned_count !== 0 || data.page.has_more !== true || !usableCursor(data.page.next_cursor)
      || resultCursor !== null && data.page.next_cursor === resultCursor) return false;
  }
  if (omitSidebar) return !sidebarOnly && data.sidebar === null;
  const leaf = data.sidebar;
  return isRuntimePlainObject(leaf) && Array.isArray(leaf.artists) && leaf.artists.length === 0
    && leaf.returned_count === 0 && leaf.has_more === true && usableCursor(leaf.next_cursor)
    && (sidebarCursor === null || leaf.next_cursor !== sidebarCursor);
}

function privateSearchCriteriaIsValid(criteria) {
  const exactKeys = (value, keys) => isRuntimePlainObject(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const tiers = value => Array.isArray(value) && value.length <= 2
    && value.every(tier => tier === 'loved' || tier === 'obsessed') && new Set(value).size === value.length;
  return exactKeys(criteria, ['subject', 'predicate_domain', 'love', 'name_scopes'])
    && criteria.subject === 'self' && criteria.predicate_domain === 'tracks'
    && exactKeys(criteria.love, ['include', 'exclude'])
    && tiers(criteria.love.include) && tiers(criteria.love.exclude)
    && criteria.love.include.length + criteria.love.exclude.length > 0
    && Array.isArray(criteria.name_scopes)
    && JSON.stringify(criteria.name_scopes) === JSON.stringify(['artists', 'albums', 'tracks']);
}

function privateSearchInitialProgressIsValid(data, {resultCursor = null, sidebarCursor = null} = {}) {
  const usableCursor = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
  if (data?.status !== 'ready' || data.selection_state !== 'pending_page' || data.selected_artist !== null
    || Object.hasOwn(data, 'selection_pending') || Object.hasOwn(data, 'sidebar_only')
    || !Array.isArray(data.artist_groups) || data.artist_groups.length
    || !Array.isArray(data.tracks) || data.tracks.length || !isRuntimePlainObject(data.page)
    || !Number.isInteger(data.page.limit) || data.page.limit < 1 || data.page.limit > 100
    || data.page.returned_count !== 0 || typeof data.page.has_more !== 'boolean'
    || (data.page.has_more ? !usableCursor(data.page.next_cursor)
      || resultCursor !== null && data.page.next_cursor === resultCursor : data.page.next_cursor !== null)) return false;
  if (data.sidebar === null) return data.page.has_more === true;
  const sidebar = data.sidebar;
  return isRuntimePlainObject(sidebar) && Array.isArray(sidebar.artists) && sidebar.artists.length === 0
    && sidebar.returned_count === 0 && sidebar.has_more === true && usableCursor(sidebar.next_cursor)
    && (sidebarCursor === null || sidebar.next_cursor !== sidebarCursor);
}

function privateListenerSearchCriteriaIsValid(criteria) {
  const exact = (value, keys) => isRuntimePlainObject(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const tiers = value => Array.isArray(value) && value.length <= 2
    && value.every(tier => tier === 'loved' || tier === 'obsessed')
    && new Set(value).size === value.length
    && JSON.stringify(value) === JSON.stringify(['loved', 'obsessed'].filter(tier => value.includes(tier)));
  return exact(criteria, ['subject', 'predicate_domain', 'history', 'love'])
    && exact(criteria.subject, ['kind', 'username']) && criteria.subject.kind === 'username'
    && typeof criteria.subject.username === 'string' && /^[a-z0-9][a-z0-9._-]{2,63}$/.test(criteria.subject.username)
    && criteria.predicate_domain === 'tracks' && exact(criteria.history, ['period']) && criteria.history.period === 'all'
    && exact(criteria.love, ['include', 'exclude']) && tiers(criteria.love.include) && tiers(criteria.love.exclude);
}

function privateListenerSearchResponseMatchesRequest(data, url) {
  const allowed = new Set(['surface', 'q', 'search_presentation', 'search_page_size', 'search_cursor']);
  const params = url.searchParams, size = params.get('search_page_size') ?? '100';
  return url.pathname === '/view-data' && [...params.keys()].every(key => allowed.has(key) && params.getAll(key).length === 1)
    && (params.get('surface') ?? 'albums') === 'albums' && params.has('q')
    && isListenerSearchExpression(params.get('q')) && data.query === params.get('q')
    && (params.get('search_presentation') ?? 'tracks') === 'tracks' && data.presentation === 'tracks'
    && /^[0-9]{1,3}$/.test(size) && Number(size) >= 1 && Number(size) <= 100 && data.page?.limit === Number(size)
    && (!params.has('search_cursor') || Boolean(params.get('search_cursor')) && params.get('search_cursor').length <= 4096)
    && data.status === 'ready' && data.private_search === true && privateListenerSearchCriteriaIsValid(data.criteria)
    && data.listener?.username === data.criteria.subject.username
    && (!data.page?.has_more || data.page.next_cursor !== params.get('search_cursor'));
}

function privatePopularitySearchCriteriaIsValid(criteria) {
  const exact = (value, keys) => isRuntimePlainObject(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  // Bounds are only wire-shape protection; normalization and matching belong
  // to the server. 400 UTF-16 units admits every 200-code-point query term.
  const terms = value => Array.isArray(value) && value.length <= 200
    && value.every(term => typeof term === 'string' && term.length > 0 && term.length <= 400);
  const predicate = value => exact(value, ['include', 'exclude']) && terms(value.include) && terms(value.exclude);
  return exact(criteria, ['predicate_domain', 'sort', 'artist', 'genre', 'per_artist'])
    && criteria.predicate_domain === 'tracks'
    && exact(criteria.sort, ['provider', 'metric', 'direction'])
    && criteria.sort.provider === 'lastfm' && criteria.sort.metric === 'overall_scrobbles'
    && criteria.sort.direction === 'desc' && predicate(criteria.artist) && predicate(criteria.genre)
    && (criteria.per_artist === null || Number.isInteger(criteria.per_artist)
      && criteria.per_artist >= 1 && criteria.per_artist <= 5000);
}

function privatePopularitySearchResponseMatchesRequest(data, url) {
  if (!(url instanceof URL)) url = new URL(url, 'http://localhost');
  const allowed = new Set(['surface', 'q', 'search_presentation', 'search_page_size', 'search_cursor', 'gallery_scope', 'category']);
  const params = url.searchParams, size = params.get('search_page_size') ?? '100';
  const cursor = params.get('search_cursor');
  const presentation = params.get('search_presentation') ?? 'tracks';
  const categories = params.getAll('category');
  return url.pathname === '/view-data' && [...params].length <= 38
    && [...params.keys()].every(key => allowed.has(key) && (key === 'category' || params.getAll(key).length === 1))
    && (params.get('surface') ?? 'albums') === 'albums' && params.has('q')
    && isPopularitySearchExpression(params.get('q')) && data?.query === params.get('q')
    && ['albums', 'tracks'].includes(presentation) && data.presentation === presentation
    && /^[0-9]{1,3}$/.test(size) && Number(size) >= 1 && Number(size) <= 100 && data.page?.limit === Number(size)
    && (cursor === null || /^[\x00-\x7f]{1,4096}$/.test(cursor) && !cursor.includes('\0'))
    && ['all', 'new_arrivals'].includes(params.get('gallery_scope') ?? 'all')
    && categories.length <= 32 && categories.every(category => DEFAULT_LIBRARY_CATEGORIES.includes(category))
    && data.status === 'ready' && data.private_search === true && data.contract_version === (presentation === 'albums' ? 'popularity-search-albums-v1' : 'popularity-search-v1')
    && privatePopularitySearchCriteriaIsValid(data.criteria)
    && (!data.page?.has_more || data.page.next_cursor !== cursor);
}

// Server messages and middleware detail strings are never rendered. Locations
// are optional original-query UTF-16 offsets, copied only after bounded checks.
function privatePopularitySearchReadError(status, data, query) {
  const messages = {400: 'This popularity search request is malformed.',
    422: 'This popularity search combination is not supported.',
    403: 'Popularity Search is not authorized in this context.',
    409: 'Popularity Search has changed or expired. Restart search from page one.',
    503: 'Popularity Search is temporarily unavailable. Try again.'};
  const value = data?.location;
  const location = isRuntimePlainObject(value) && Object.keys(value).length === 2
    && Number.isInteger(value.start) && Number.isInteger(value.end)
    && value.start >= 0 && value.end >= value.start && value.end <= query.length
    ? {start: value.start, end: value.end} : null;
  return Object.assign(new Error(messages[status] || 'Popularity Search could not be loaded. Try again.'), {
    status, location, popularitySearchFailure: true, privateSearchRetired: true,
  });
}

function privateSearchResponseMatchesRequest(data, apiUrl) {
  const url = new URL(apiUrl, 'http://localhost');
  if (url.searchParams.getAll('q').some(isPopularitySearchExpression)
    && !['popularity-search-v1', 'popularity-search-albums-v1'].includes(data?.contract_version)) return false;
  if (['popularity-search-v1', 'popularity-search-albums-v1'].includes(data?.contract_version)) return privatePopularitySearchResponseMatchesRequest(data, url);
  if (data?.contract_version === 'listener-search-v1') return privateListenerSearchResponseMatchesRequest(data, url);
  const selectedPending = data?.status === 'pending';
  if (url.pathname !== '/view-data' || (url.searchParams.get('surface') || 'albums') !== 'albums'
    || data?.private_search !== true || data.contract_version !== 'own-love-v1'
    || !['ready', 'pending'].includes(data.status)
    || (selectedPending ? data.selection_pending !== true : Object.hasOwn(data, 'selection_pending'))
    || Object.hasOwn(data, 'sidebar_only') || typeof data.query !== 'string'
    || data.query !== (url.searchParams.get('q') || '')
    || !['albums', 'tracks'].includes(data.presentation)
    || data.presentation !== (url.searchParams.get('search_presentation') || 'albums')
    || !privateSearchCriteriaIsValid(data.criteria)
    || !Array.isArray(data.artist_groups) || !Array.isArray(data.tracks)
    || !data.page || typeof data.page !== 'object'
    || data.sidebar !== null && !Array.isArray(data.sidebar?.artists)) return false;
  if (data.sidebar === null && url.searchParams.get('omit_sidebar') !== '1') return false;
  if (data.selection_state === 'selected') {
    if (typeof data.selected_artist !== 'string' || !data.selected_artist.trim()) return false;
  } else if (!['all_artists', 'empty', 'pending_page'].includes(data.selection_state)
    || data.selected_artist !== null) return false;
  const artist = url.searchParams.get('artist');
  // Artist spelling/canonicalization belongs to the server. An explicit Artist
  // can still be proving its first witness (ready pending_page), but can never
  // become an all-artists response or an empty selection.
  if (artist && !['selected', 'pending_page'].includes(data.selection_state)) return false;
  if (url.searchParams.has('all_artists') && !['0', '1'].includes(url.searchParams.get('all_artists'))) return false;
  const allArtists = url.searchParams.get('all_artists') === '1';
  if (allArtists !== (data.selection_state === 'all_artists')) return false;
  if (url.searchParams.has('search_cursor') && data.page.has_more
    && data.page.next_cursor === url.searchParams.get('search_cursor')) return false;
  if (url.searchParams.has('search_sidebar_cursor') && data.sidebar?.has_more
    && data.sidebar.next_cursor === url.searchParams.get('search_sidebar_cursor')) return false;
  if (data.selection_state === 'pending_page' && !privateSearchInitialProgressIsValid(data, {
    resultCursor: url.searchParams.get('search_cursor'), sidebarCursor: url.searchParams.get('search_sidebar_cursor'),
  })) return false;
  if (selectedPending && (!artist || data.selected_artist !== artist || url.searchParams.has('all_artists')
    || !privateSearchPendingProgressIsValid(data, {
      omitSidebar: url.searchParams.get('omit_sidebar') === '1',
      resultCursor: url.searchParams.get('search_cursor'), sidebarCursor: url.searchParams.get('search_sidebar_cursor'),
    }))) return false;
  return true;
}

async function readGalleryResponse(response, ownsResponse, preferenceRead = null, readOwner = null, albumPreferenceScope = null) {
  const assertCurrent = () => {
    if (!ownsResponse() || albumPreferenceScope && !runtimeAlbumPreferenceScopeIsCurrent(albumPreferenceScope)
      || !ownsResponse()) {
      throw Object.assign(new Error('View request was superseded.'), {name: 'AbortError'});
    }
  };
  assertCurrent();
  const deniedStatus = response.status === 401 || response.status === 403;
  if (readOwner?.privateRequest && deniedStatus) {
    readOwner.retire();
    assertCurrent();
    preferenceRead?.revoke();
    assertCurrent();
    if (readOwner.popularityRequest) throw privatePopularitySearchReadError(response.status, null, readOwner.query);
    throw Object.assign(new Error('Private Search is no longer available.'), {
      status: response.status, privateSearchRetired: true,
    });
  }
  // Legacy status/continuation readers retain their existing ordinary path.
  // Foreground raw Search must inspect the server envelope before deciding
  // whether a denial belongs to private Search or ordinary login handling.
  // Foreground receipt authority ends at current denied headers, even if JSON
  // hangs or rejects. Check both stale callers and synchronous subscriber reentry.
  if (deniedStatus) {
    preferenceRead?.revoke();
    assertCurrent();
  }
  if (!readOwner) {
    if (response.status === 401) {
      if (ownsResponse()) window.location.assign('/login');
      throw new Error('Sign in again to continue.');
    }
  }
  let data;
  try { data = await response.json(); }
  catch (error) {
    assertCurrent();
    if (readOwner?.popularityRequest) {
      readOwner.retire();
      assertCurrent();
      throw privatePopularitySearchReadError(response.status, null, readOwner.query);
    }
    if (readOwner?.privateRequest && response.ok) {
      readOwner.retire();
      assertCurrent();
      throw Object.assign(new Error('Private Search is no longer available.'), {
        status: response.status, privateSearchRetired: true,
      });
    }
    if (readOwner && response.status === 401) {
      window.location.assign('/login');
      throw new Error('Sign in again to continue.');
    }
    throw error;
  }
  assertCurrent();
  if (readOwner?.popularityRequest && (!response.ok || data?.ok === false)) {
    readOwner.retire();
    assertCurrent();
    throw privatePopularitySearchReadError(response.status, data, readOwner.query);
  }
  if (readOwner) {
    const code = data?.error_code;
    const privateDenial = ['private_search_forbidden', 'stale_context', 'search_selection_unavailable',
      'search_cursor_restart_required'].includes(code);
    if (privateDenial) {
      readOwner.retire();
      assertCurrent();
      if (!deniedStatus) {
        preferenceRead?.revoke();
        assertCurrent();
      }
      throw Object.assign(new Error('Private Search is no longer available.'), {
        status: response.status, code, privateSearchRetired: true,
      });
    }
    if (response.status === 401) {
      window.location.assign('/login');
      throw new Error('Sign in again to continue.');
    }
  }
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `View request failed: ${response.status}`);
  }
  if (data && !data.read_only_subject
    && String(data.surface?.active || data.surface_request || 'albums') === 'albums'
    && (data.source_readable === false || data.readable === false
      || Object.hasOwn(data.allowed_actions || {}, 'can_read') && data.allowed_actions.can_read !== true)) {
    preferenceRead?.revoke();
    assertCurrent();
  }
  // Only an explicit browse owner can supply its immutable pre-dispatch scope.
  // Generic status/sidebar parsers cannot manufacture preference receipts.
  if (albumPreferenceScope && response.ok && data?.ok !== false) {
    assertCurrent();
    admitRuntimeAlbumPreferenceRead(data, albumPreferenceScope);
    assertCurrent();
  }
  return data;
}

// A Sidebar continuation is a typed native read, not a foreground navigation.
// The admitted Search parent supplies its original scope and child lifetime;
// this existing request owner retains URL, HTTP, response and continuity policy.
function buildPrivateSearchSidebarUrl(view, parent, cursor) {
  const url = new URL(buildApiUrl({
    surface: {active: 'albums'}, surface_request: 'albums', private_search: true,
    query: parent.query, selected_artist: parent.selected_artist || '',
    all_artists_active: parent.selection_state === 'all_artists',
    gallery_scope: view.gallery_scope, gallery_display_mode: view.gallery_display_mode,
    gallery_scale_percent: view.gallery_scale_percent,
    visible_library_categories: view.visible_library_categories,
  }), window.location.href);
  url.searchParams.set('search_presentation', parent.presentation);
  url.searchParams.set('search_sidebar_only', '1');
  url.searchParams.set('search_sidebar_cursor', cursor);
  return `${url.pathname}${url.search}`;
}

function privateSearchSidebarResponseMatchesParent(data, parent, cursor) {
  const selectedPending = data?.status === 'pending';
  if (!isRuntimePlainObject(data) || data.private_search !== true
    || data.contract_version !== 'own-love-v1' || !['ready', 'pending'].includes(data.status)
    || data.sidebar_only !== true
    || (selectedPending ? data.selection_pending !== true : Object.hasOwn(data, 'selection_pending'))
    || ['artist_groups', 'tracks', 'page'].some(key => Object.hasOwn(data, key))
    || data.query !== parent.query || data.presentation !== parent.presentation
    || data.selection_state !== parent.selection_state || data.selected_artist !== parent.selected_artist
    || !privateSearchCriteriaIsValid(data.criteria)
    || JSON.stringify(data.criteria) !== JSON.stringify(parent.criteria)) return false;
  if (selectedPending) return privateSearchPendingProgressIsValid(data, {sidebarOnly: true, sidebarCursor: cursor});
  const leaf = data.sidebar;
  if (!isRuntimePlainObject(leaf) || !Array.isArray(leaf.artists) || leaf.artists.length > 50
    || leaf.returned_count !== leaf.artists.length || typeof leaf.has_more !== 'boolean'
    || leaf.has_more && (typeof leaf.next_cursor !== 'string' || !leaf.next_cursor
      || leaf.next_cursor.length > 4096 || leaf.next_cursor === cursor)
    || !leaf.has_more && leaf.next_cursor !== null) return false;
  return leaf.artists.every(row => isRuntimePlainObject(row)
    && typeof row.artist === 'string' && row.artist.trim() && row.artist.length <= 4096
    && (!Object.hasOwn(row, 'artist_display')
      || typeof row.artist_display === 'string' && row.artist_display.length <= 4096)
    && (!Object.hasOwn(row, 'count') || Number.isInteger(row.count) && row.count >= 0));
}

async function readPrivateSearchSidebarPage({view, parent, cursor, scope, signal, isCurrent, retire}) {
  const ownsResponse = () => !signal?.aborted && isCurrent() === true
    && galleryReadScopeIsCurrent(scope) && !signal?.aborted && isCurrent() === true;
  const assertCurrent = () => {
    if (!ownsResponse()) throw Object.assign(new Error('Sidebar request was superseded.'), {name: 'AbortError'});
  };
  assertCurrent();
  if (!scope.context || typeof scope.transport?.accept !== 'function'
    || !['selected', 'all_artists'].includes(parent.selection_state)
    || typeof cursor !== 'string' || !cursor || cursor.length > 4096) {
    throw new Error('Sidebar continuation is unavailable.');
  }
  const url = buildPrivateSearchSidebarUrl(view, parent, cursor);
  assertCurrent();
  let response;
  try {
    response = await fetch(url, {method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
      headers: {Accept: 'application/json', 'X-AlbumHaven-Context': scope.context}});
  } catch (error) {
    assertCurrent();
    throw error; // A current network failure belongs only to this child.
  }
  assertCurrent();
  let data;
  try {
    data = await readGalleryResponse(response, ownsResponse, null, {
      privateRequest: true,
      retire: () => {if (ownsResponse()) retire('context');},
    });
  } catch (error) {
    assertCurrent();
    // Successful malformed JSON fails closed; retryable HTTP errors do not
    // retire the admitted main page. Denial was already retired by the reader.
    if (response.ok) retire('invalid');
    throw error;
  }
  assertCurrent();
  if (data?.context_ref !== scope.context || !privateSearchSidebarResponseMatchesParent(data, parent, cursor)) {
    // Native projection and sources must disappear before transport listeners
    // or Search subscribers can observe a rejected successful envelope.
    retire(data?.context_ref !== scope.context ? 'context' : 'invalid');
    throw new Error('Sidebar response is no longer available.');
  }
  scope.transport.accept(data, scope.context);
  assertCurrent();
  // Reuse the existing finite projection, but never install its main view.
  return {artists: normalizePrivateSearchNavigation(data, view).artists_sidebar,
    status: data.status,
    hasMore: data.sidebar.has_more, returnedCount: data.sidebar.returned_count,
    cursor: data.sidebar.next_cursor};
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

async function collectRootGalleryRefresh(data, apiUrl, coverage, controller, ownsResponse, preferenceRead, albumPreferenceScope) {
  let payload = data;
  let restarted = false;
  const cursors = new Set();
  let remainingPages = Math.ceil(coverage / 50);
  while (ownsResponse()) {
    const page = payload?.gallery_page;
    const count = (payload?.artist_groups || []).reduce((sum, group) => sum + (group.albums || []).length, 0);
    if (!page?.has_more || count >= coverage) return {payload, preferenceRead};
    const cursor = String(page.next_cursor || '');
    if (!cursor || cursors.has(cursor) || remainingPages-- <= 0) {
      throw new Error('Root gallery refresh did not advance within its loaded coverage.');
    }
    cursors.add(cursor);
    const url = new URL(apiUrl, 'http://localhost');
    url.searchParams.set('gallery_page_size', '50');
    url.searchParams.set('gallery_cursor', cursor);
    url.searchParams.set('omit_sidebar', '1');
    const continuationRead = captureLooseTrackPreferenceRead(`${url.pathname}${url.search}`, {
      signal: controller?.signal, isCurrent: ownsResponse,
    });
    if (!ownsResponse() || albumPreferenceScope && !runtimeAlbumPreferenceScopeIsCurrent(albumPreferenceScope) || !ownsResponse()) return null;
    const response = await fetch(`${url.pathname}${url.search}`, {
      headers: { Accept: 'application/json', ...(albumPreferenceScope ? {'X-AlbumHaven-Context': albumPreferenceScope.context} : {}) },
      credentials: 'same-origin', cache: 'no-store', signal: controller?.signal,
    });
    if (!ownsResponse()) return null;
    const next = response.status === 409 ? null : await readGalleryResponse(response, ownsResponse, continuationRead, null, albumPreferenceScope);
    if (!ownsResponse()) return null;
    if (response.status === 409 || String(next?.gallery_page?.revision || '') !== String(page.revision || '')) {
      if (restarted) throw new Error('Root gallery changed again while refreshing loaded albums.');
      restarted = true;
      cursors.clear();
      remainingPages = Math.ceil(coverage / 50);
      url.searchParams.delete('gallery_cursor');
      url.searchParams.delete('omit_sidebar');
      preferenceRead = captureLooseTrackPreferenceRead(`${url.pathname}${url.search}`, {
        signal: controller?.signal, isCurrent: ownsResponse,
      });
      if (!ownsResponse() || albumPreferenceScope && !runtimeAlbumPreferenceScopeIsCurrent(albumPreferenceScope) || !ownsResponse()) return null;
      const restartResponse = await fetch(`${url.pathname}${url.search}`, {
        headers: { Accept: 'application/json', ...(albumPreferenceScope ? {'X-AlbumHaven-Context': albumPreferenceScope.context} : {}) },
        credentials: 'same-origin', cache: 'no-store', signal: controller?.signal,
      });
      payload = await readGalleryResponse(restartResponse, ownsResponse, preferenceRead, null, albumPreferenceScope);
      continue;
    }
    if (next.gallery_page.has_more && cursors.has(String(next.gallery_page.next_cursor || ''))) {
      throw new Error('Root gallery refresh returned a repeated cursor.');
    }
    payload = {
      ...payload,
      artist_groups: mergeRootGalleryPageGroups(payload.artist_groups, next.artist_groups, payload.artist_loved_context_ref, next.artist_loved_context_ref),
      artist_loved_context_ref: next.artist_loved_context_ref ?? null,
      gallery_page: next.gallery_page,
    };
  }
  return null;
}

async function fetchAndRender(url, push = true, options = {}, originatingOptions = options) {
  if(typeof invalidateAdvancedSearchIntent==='function')invalidateAdvancedSearchIntent('navigation',{preserveRetained:true});
  const suppliedOptions = (options && typeof options === 'object') ? options : {};
  const callbackOptions = (originatingOptions && typeof originatingOptions === 'object') ? originatingOptions : suppliedOptions;
  const nativeWindow = typeof window === 'undefined' ? null : window;
  const navigation = nativeWindow?.AlbumHavenSettingsNavigation?.instance;
  const retainedPlaylistDraft = suppliedOptions.retainedPlaylistDraft || navigation?.retainedPlaylistDraft?.()
    || (!push && nativeWindow?.history?.state?.playlistDraft) || null;
  if (retainedPlaylistDraft && !navigation?.isPlaylistDraftCurrent?.(retainedPlaylistDraft)) return false;
  if (push && !retainedPlaylistDraft && typeof deferAppFormPageReplacement === 'function') {
    const deferred = deferAppFormPageReplacement(() => fetchAndRender(url, push, options, callbackOptions));
    if (deferred) return deferred;
  }
  const requestOptions = retainedPlaylistDraft ? {...suppliedOptions, retainedPlaylistDraft} : suppliedOptions;
  cancelRootGalleryPageRequest();
  const albumDetailPrewarmSearchGeneration = state.ui?.albumDetailPrewarmSearchSuspended
    ? Number(state.ui.albumDetailPrewarmSearchGeneration || 0)
    : 0;
  let waveformPeakLoadSuspension = null;
  if (typeof cancelTrackModalAlbumDetailsPrewarms === 'function') {
    cancelTrackModalAlbumDetailsPrewarms();
  }
  const canInterruptCurrent = requestOptions.interruptCurrent !== false;
  const restartIfSameUrl = requestOptions.restartIfSameUrl === true;
  const navigationUrl = new URL(url, 'http://localhost');
  const privateNavigation = navigationUrl.pathname === '/' && isPrivateSearchRequestUrl(url);
  const apiUrl = url.startsWith('/view-data') || url.startsWith('/home-data')
    ? url
    : privateNavigation ? `/view-data${navigationUrl.search}`
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
    ) {
      const activeController = state.ui.activeViewRequestController;
      if (
        restartIfSameUrl
        && activeController
        && typeof activeController.abort === 'function'
      ) {
        const interruptedId = state.ui.activeViewRequestId, interruptedRevision = readViewStateRevision();
        activeController.abort();
        if (state.ui.activeViewRequestId !== interruptedId || readViewStateRevision() !== interruptedRevision
          || state.ui.activeViewRequestController !== activeController) return false;
      } else {
        state.ui.activeViewRequestPush = Boolean(state.ui.activeViewRequestPush || push);
        return false;
      }
    }
    const activeController = state.ui.activeViewRequestController;
    if (canInterruptCurrent && activeController && typeof activeController.abort === 'function') {
      const interruptedId = state.ui.activeViewRequestId, interruptedRevision = readViewStateRevision();
      activeController.abort();
      if (state.ui.activeViewRequestId !== interruptedId || readViewStateRevision() !== interruptedRevision
        || state.ui.activeViewRequestController !== activeController) return false;
    } else {
      const queuedOwnerId = state.ui.activeViewRequestId;
      const queuedRevision = readViewStateRevision();
      const originatingReadScope = captureGalleryReadScope();
      if (state.ui.activeViewRequestId !== queuedOwnerId || readViewStateRevision() !== queuedRevision) return false;
      state.ui.pendingViewRequest = {
        url,
        push,
        options: requestOptions,
        originatingViewStateRevision: queuedRevision,
        originatingReadScope,
        originatingOptions: callbackOptions,
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
  let requestStarted = false, settledApplied = false, settledError = null;
  let cleanupWorkRetired = false, ownsCatchCleanup = null, artistRequestSettlement = null;
  const artistRequestOriginalView = state.view;
  const requestId = Number(state.ui.activeViewRequestId || 0) + 1;
  const requestViewStateRevision = readViewStateRevision();
  const requestTagEditMutationRevision = Number(state.ui.tagEditOptimisticMutationRevision || 0);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const privateRequest = isPrivateSearchRequestUrl(apiUrl);
  const requestParams = new URL(apiUrl, 'http://localhost').searchParams;
  const popularityRequest = privateRequest && requestParams.getAll('q').some(isPopularitySearchExpression);
  // Capture request visibility before navigation projection or observers can
  // mutate state.view; raw requests retain their original fields for rejection.
  const popularityVisibility = Object.freeze({gallery_scope: requestParams.get('gallery_scope') ?? 'all',
    visible_library_categories: Object.freeze(requestParams.getAll('category'))});
  let readScope = null;
  const ownsRequestSlot = () => state.ui.activeViewRequestId === requestId
    && state.ui.activeViewRequestController === controller
    && state.ui.activeViewRequestUrl === apiUrl;
  const ownsForegroundContext = () => requestOwnsCurrentViewState(requestId, requestViewStateRevision)
    && ownsRequestSlot();
  const ownsForegroundSlot = () => ownsForegroundContext() && !controller?.signal.aborted;
  const ownsPreferenceContext = () => ownsForegroundContext()
    && requestTagEditMutationRevision === Number(state.ui.tagEditOptimisticMutationRevision || 0)
    && (!retainedPlaylistDraft
      || nativeWindow?.AlbumHavenSettingsNavigation?.instance?.isPlaylistDraftCurrent?.(retainedPlaylistDraft) === true)
    && (!readScope || galleryReadScopeIsCurrent(readScope))
    && ownsForegroundContext();
  const ownsPreferenceResponse = () => ownsForegroundSlot()
    && ownsPreferenceContext() && ownsForegroundSlot();
  const albumPreferenceModal = typeof getCurrentTrackModalAlbum === 'function' ? getCurrentTrackModalAlbum() : null;
  const albumPreferenceOwner = typeof getTrackModalAlbumPreferenceLease === 'function' ? getTrackModalAlbumPreferenceLease() : null;
  const albumPreferenceFocus = typeof captureTrackModalAlbumPreferenceFocus === 'function'
    ? captureTrackModalAlbumPreferenceFocus(albumPreferenceModal, albumPreferenceOwner) : null;
  if (typeof disposeTrackModalAlbumPreferences === 'function') disposeTrackModalAlbumPreferences(
    albumPreferenceOwner, {preserveFocus: !!albumPreferenceFocus});
  state.ui.activeViewRequestId = requestId;
  state.ui.activeViewRequestTagEditMutationRevision = requestTagEditMutationRevision;
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
  try {
    artistRequestSettlement = nativeWindow?.AlbumHavenArtistPageRuntime?.captureRequestSettlement({
      view: artistRequestOriginalView, requestId, isCurrent: ownsForegroundContext,
    }) || null;
    if (!ownsForegroundContext()) return false;
    // A claimed foreground replacement revokes the accepted main result before
    // render/onStart subscribers can observe it. Deferral/queue paths above
    // preserve the current result. Reentry still passes through native finally.
    retireNativePrivateSearchView(ownsForegroundSlot, 'replace', {
      beforeObservers: () => {
        if (!ownsForegroundSlot()) return;
        // A fresh dispatch starts after older mutation records. A response must
        // keep this receipt even when it is the first raw private Search read.
        nativeWindow?.AlbumHavenSearchRuntime?.checkpointIdentity?.();
        if (ownsForegroundSlot()) readScope = captureGalleryReadScope();
      },
    });
    if (!ownsPreferenceResponse()) return false;
    if (!retainsMountedSelectedViewState) {
      renderRelated();
      if (!ownsPreferenceResponse()) return false;
    }
    if (requestOptions.showSearchProgress || state.ui.pendingViewTransition
      || (!requestOptions.preserveScroll && requestOptions.skipPendingViewTransition !== true)) {
      beginPendingViewTransition(requestId, requestOptions);
      if (!ownsPreferenceResponse()) return false;
    }
    if (!requestOptions.preserveScanPage && !state.ui.scanPageReturnContext) {
      state.ui.forceScanPageVisible = false;
    }
    if (requestOptions.preserveGalleryOptionsMenu !== true && !requestOptions.startupRefresh) {
      hideGalleryOptionsMenu();
    }
    if (!ownsPreferenceResponse()) return false;
    markStartupFollowup('fetch_started', requestOptions, {
      endpoint: apiUrl,
    });
    if (typeof requestOptions.onStart === 'function') {
      if (!ownsPreferenceResponse() || controller?.signal.aborted
        || requestOptions.onStart({requestId}, callbackOptions) === false
        || !ownsPreferenceResponse() || controller?.signal.aborted) return false;
    }
    let preferenceRead = captureLooseTrackPreferenceRead(apiUrl, {
      signal: controller?.signal, isCurrent: ownsPreferenceResponse,
    });
    if (!ownsPreferenceResponse()) return false;
    const albumPreferenceScope = captureRuntimeAlbumPreferenceScope();
    if (!ownsPreferenceResponse()) return false;
    requestStarted = true;
    // Capture before dispatch, never at response receipt or after JSON parsing.
    // This baseline stays local to this exact foreground request owner.
    const searchRequestTiming = popularityRequest
      ? nativeWindow?.AlbumHavenSearchRuntime?.captureRequestTiming?.() ?? null : null;
    if (!ownsPreferenceResponse()) return false;
    const response = await fetch(apiUrl, {
      headers: { Accept: 'application/json',
        ...(readScope.context ? {'X-AlbumHaven-Context': readScope.context} : {}) },
      ...(readScope.context ? {credentials: 'same-origin', cache: 'no-store'} : {}),
      signal: controller?.signal,
    });
    let data = await readGalleryResponse(response, ownsPreferenceResponse, preferenceRead, {
      privateRequest, popularityRequest, query: requestParams.get('q') || '',
      retire: () => retireNativePrivateSearchView(ownsPreferenceResponse),
    }, albumPreferenceScope);
    if (!ownsPreferenceResponse()) return false;
    if (privateRequest && data?.private_search !== true) {
      retireNativePrivateSearchView(ownsPreferenceResponse, 'invalid');
      throw Object.assign(new Error('Search is no longer available. Start a fresh search.'), {privateSearchRetired: true});
    }
    if (data?.private_search === true || ['own-love-v1', 'listener-history-v1', 'listener-search-v1', 'popularity-search-v1', 'popularity-search-albums-v1'].includes(data?.contract_version)) {
      if (!privateRequest || !readScope.context || !/^[1-9]\d*$/.test(readScope.actor) || !/^[1-9]\d*$/.test(readScope.library)
        || typeof readScope.transport?.accept !== 'function'
        || !privateSearchResponseMatchesRequest(data, apiUrl)
        || nativeWindow?.AlbumHavenSearchRuntime?.validate?.(data, readScope.library) !== true) {
        retireNativePrivateSearchView(ownsPreferenceResponse);
        throw Object.assign(new Error('Search is no longer available. Start a fresh search.'), {privateSearchRetired: true});
      }
      if (data.context_ref !== readScope.context) {
        retireNativePrivateSearchView(ownsPreferenceResponse);
        throw Object.assign(new Error('Search is no longer available. Start a fresh search.'), {privateSearchRetired: true});
      }
      readScope.transport.accept(data, readScope.context);
      if (!ownsPreferenceResponse()) return false;
    }
    if (rootRefreshCoverage > 0) {
      const ownsRefresh = () => {
        if (controller?.signal.aborted || !ownsPreferenceResponse()) return false;
        try {
          return typeof requestOptions.shouldApplyResponse !== 'function' || requestOptions.shouldApplyResponse(data) === true;
        } catch (_error) {
          return false;
        }
      };
      const collected = await collectRootGalleryRefresh(data, apiUrl, rootRefreshCoverage, controller, ownsRefresh, preferenceRead, albumPreferenceScope);
      if (!collected || !ownsRefresh()) return false;
      // Only the initial or restart packet supplies Loose rows. Continuation
      // metadata cannot replace its dispatch epoch with a completion-time read.
      data = collected.payload;
      preferenceRead = collected.preferenceRead;
    }
    markStartupFollowup('payload_received', requestOptions, {
      endpoint: apiUrl,
      artistCount: Number(data?.artist_count || 0),
      albumCount: Number(data?.album_count || 0),
      payloadTier: String(data?.payload_tier || ''),
    });
    if (!ownsPreferenceResponse()) {
      return false;
    }
    if (retainedPlaylistDraft && !nativeWindow?.AlbumHavenSettingsNavigation?.instance?.isPlaylistDraftCurrent?.(retainedPlaylistDraft)) return false;
    // A response dispatched before a tag edit must not replace its optimistic view.
    if (requestTagEditMutationRevision !== Number(state.ui.tagEditOptimisticMutationRevision || 0)) {
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
      if (!ownsPreferenceResponse()) return false;
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
    // Caller response hooks can run arbitrary synchronous native work. Recheck
    // the same bounded projector after them, before even safe navigation writes.
    if (data?.private_search === true
      && (!privateSearchResponseMatchesRequest(data, apiUrl)
        || nativeWindow?.AlbumHavenSearchRuntime?.validate?.(data, readScope.library) !== true)) {
      retireNativePrivateSearchView(ownsPreferenceResponse, 'invalid');
      throw Object.assign(new Error('Search is no longer available. Start a fresh search.'), {privateSearchRetired: true});
    }
    const payloadToApply = data?.private_search === true
      ? normalizePrivateSearchNavigation(data, ['popularity-search-v1', 'popularity-search-albums-v1'].includes(data.contract_version)
        ? {...state.view, ...popularityVisibility} : state.view)
      : retainedMountedSelectedViewState
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
    const responseApplyOptions = {
      ...requestOptions,
      ...(data?.private_search === true ? {preserveSidebarState: false, preserveMountedGalleryChildren: false,
        completePageEntryBrowseContext: false, preserveGalleryBrowseLocationState: false}
        : retainedMountedSelectedViewState ? {preserveMountedGalleryChildren: true} : {}),
      isCurrentResponse: ownsPreferenceResponse,
    };
    if (!retainedMountedSelectedViewState && typeof admitLooseTrackPreferenceRows === 'function') {
      admitLooseTrackPreferenceRows(payloadToApply, preferenceRead);
      // Both preference and receipt subscribers can synchronously navigate or
      // edit. Recheck application permission, then ownership, at the write itself.
      try {
        if (typeof requestOptions.shouldApplyResponse === 'function'
          && requestOptions.shouldApplyResponse(data) !== true) return false;
        if (controller?.signal.aborted || !ownsPreferenceResponse()) return false;
      } catch (_error) {
        return false;
      }
    }
    if (!ownsPreferenceResponse()) return false;
    const appliedView = applyViewPayload(payloadToApply, responseApplyOptions);
    if (!ownsPreferenceResponse() || state.view !== appliedView) return false;
    if (data?.private_search === true && nativeWindow?.AlbumHavenSearchRuntime) {
      // Admission outlives foreground finally. The captured controller's abort
      // bit remains relevant, but the active controller/URL slots are released
      // by finally and therefore cannot be an accepted-result lease.
      const ownsAcceptedIdentity = () => state.view === appliedView
        && appliedView.private_search === true && appliedView.query === data.query
        && appliedView.search_presentation === data.presentation
        && requestOwnsCurrentViewState(requestId, requestViewStateRevision)
        && requestTagEditMutationRevision === Number(state.ui.tagEditOptimisticMutationRevision || 0)
        && !controller?.signal.aborted;
      const ownsAcceptedResult = () => ownsAcceptedIdentity()
        && (!retainedPlaylistDraft
          || nativeWindow?.AlbumHavenSettingsNavigation?.instance?.isPlaylistDraftCurrent?.(retainedPlaylistDraft) === true)
        && galleryReadScopeIsCurrent(readScope) && ownsAcceptedIdentity();
      if (nativeWindow.AlbumHavenSearchRuntime.accept(data, {isCurrent: ownsAcceptedResult, requestUrl: apiUrl, requestTiming: searchRequestTiming}) !== true) {
        if (ownsPreferenceResponse()) retireNativePrivateSearchView(ownsPreferenceResponse, 'invalid');
        throw Object.assign(new Error('Search is no longer available. Start a fresh search.'), {privateSearchRetired: true});
      }
      if (!ownsPreferenceResponse() || state.view !== appliedView) return false;
    }
    finishPendingViewTransition(requestId);
    if (!ownsPreferenceResponse()) return false;
    markStartupFollowup('apply_complete', requestOptions, {
      artistCount: Number(state.view?.artist_count || 0),
      albumCount: Number(state.view?.album_count || 0),
    });
    markStartupFollowup('render_started', requestOptions);
    attachModalEvents();
    if (!ownsPreferenceResponse()) return false;
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
    if (!ownsPreferenceResponse()) return false;
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
          && (
            startupHydrationTier !== 'sidebar'
            || !String(requestOptions.startupHydrationFollowupEndpoint || '').trim()
          ))
        || isCanonicalFullViewPayload(data, requestOptions)
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
    if (!ownsPreferenceResponse()) return false;
    if (state.ui.activeViewRequestPush) {
      // The live native tree contains private server-projected Artist labels.
      // Persist only navigation intent through the existing history owner.
      const historySnapshot = data?.private_search === true ? {
        surface: {active: 'albums'}, surface_request: 'albums',
        private_search: true, search_presentation: state.view.search_presentation,
        query: state.view.query, selected_artist: state.view.selected_artist,
        all_artists_active: state.view.all_artists_active,
        gallery_scope: state.view.gallery_scope,
        gallery_display_mode: state.view.gallery_display_mode,
        gallery_scale_percent: state.view.gallery_scale_percent,
        visible_library_categories: [...state.view.visible_library_categories],
        related_filter_artists: [...state.view.related_filter_artists],
        primary_filter_active: state.view.primary_filter_active,
        search_filters: normalizeRuntimeSearchFilters(state.view.search_filters),
      } : state.view;
      const artistCommittedView = state.view;
      if (!ownsPreferenceResponse()) return false;
      const artistHistoryAccepted = pushBrowserViewState(artistCommittedView, historySnapshot, retainedPlaylistDraft) !== false;
      if (!ownsPreferenceResponse() || state.view !== artistCommittedView) return false;
      nativeWindow?.AlbumHavenArtistPageRuntime?.commitAdmittedNavigation(artistCommittedView, ownsPreferenceResponse, artistHistoryAccepted);
      if (!ownsPreferenceResponse() || state.view !== artistCommittedView) return false;
    } else {
      // A refresh/history restoration has no new history entry to adopt.
      const artistCommittedView = state.view;
      if (!ownsPreferenceResponse()) return false;
      nativeWindow?.AlbumHavenArtistPageRuntime?.commitAdmittedNavigation(artistCommittedView, ownsPreferenceResponse, true);
      if (!ownsPreferenceResponse() || state.view !== artistCommittedView) return false;
    }
    if (!ownsPreferenceResponse()) return false;
    recordSuccessfulCanonicalFullViewApply(data, requestOptions);
    consumePendingScanCompletionViewRefresh(requestId, data, requestOptions);
    settledApplied = true;
    return true;
  } catch (error) {
    // Cancellation cannot admit a payload, but the still-current request must
    // finish its terminal startup bookkeeping. An interrupted old context has
    // no cleanup authority over its successor.
    const cancelled = error?.name === 'AbortError';
    const errorView = state.view;
    const errorViewStateRevision = readViewStateRevision();
    const errorPendingRequest = state.ui.pendingViewRequest;
    let errorStartupFollowup = state.ui.pendingStartupHydrationFollowup;
    const ownsErrorWork = () => state.view === errorView
      && readViewStateRevision() === errorViewStateRevision
      && state.ui.pendingViewRequest === errorPendingRequest
      && state.ui.pendingStartupHydrationFollowup === errorStartupFollowup;
    const ownsErrorCleanup = () => ownsErrorWork()
      && (cancelled ? ownsPreferenceContext() : ownsPreferenceResponse())
      && ownsErrorWork();
    if (!ownsErrorCleanup()) {
      // An already-obsolete request may still release its unchanged current
      // local view. A first-check observer that replaces work may not transfer
      // that replacement to the old finally.
      if (!ownsErrorWork()) cleanupWorkRetired = true;
      return false;
    }
    ownsCatchCleanup = () => {
      if (cleanupWorkRetired) return false;
      if (!ownsErrorCleanup()) cleanupWorkRetired = true;
      return !cleanupWorkRetired;
    };
    if (!cancelled && error?.popularitySearchFailure) {
      settledError = error;
      if (!ownsCatchCleanup()) return false;
      const published = nativeWindow?.AlbumHavenSearchRuntime?.failPopularityRequest?.({
        status: error.status, location: error.location, requestUrl: apiUrl,
      }, {isCurrent: ownsCatchCleanup});
      if (!published && ownsCatchCleanup() && typeof showToast === 'function') showToast(error.message, 'error', 4800);
      return false;
    }
    if (!cancelled && error?.privateSearchRetired) {
      settledError = error;
      if (typeof showToast === 'function') showToast('Search is no longer available. Start a fresh search.', 'error', 4800);
      return false;
    }
    finishPendingViewTransition(requestId, { restoreCurrentGallery: true });
    if (!ownsCatchCleanup()) return false;
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
    if (cancelled) {
      clearStartupHydrationFollowup();
      errorStartupFollowup = null;
      return false;
    }
    clearStartupHydrationFollowup();
    errorStartupFollowup = null;
    if (requestOptions.startupRefresh) window.AlbumHavenStartupProgress?.fail();
    if (!ownsCatchCleanup()) return false;
    if (typeof clearPendingSidebarSelection === 'function') {
      clearPendingSidebarSelection();
      if (!ownsCatchCleanup()) return false;
      renderSidebar();
    }
    if (!ownsCatchCleanup()) return false;
    settledError = error;
    throw error;
  } finally {
    try {
    // A catch that lost work ownership cannot reacquire its replacement merely
    // because finally starts later. Physical slot release remains independent.
    if (ownsCatchCleanup) ownsCatchCleanup();
    // Capture before cleanup/paint callbacks: reentry may replace the view or
    // queued intent without first claiming another network request.
    const releasedView = state.view;
    const releasedViewStateRevision = readViewStateRevision();
    const pendingRequest = state.ui.pendingViewRequest;
    const pendingStartupHydrationFollowup = state.ui.pendingStartupHydrationFollowup;
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
    if (!cleanupWorkRetired && ownsForegroundContext()) {
      finishPendingViewTransition(requestId, { restoreCurrentGallery: true });
    }
    if (ownsRequestSlot()) {
      // Local filtering can retire the response revision while this request
      // still owns the foreground slot. Cleanup follows the view at release,
      // never the obsolete payload revision, and stops on any later reentry.
      state.ui.activeViewRequestController = null;
      state.ui.activeViewRequestTagEditMutationRevision = null;
      state.ui.activeViewRequestUrl = '';
      state.ui.activeViewRequestPush = false;
      state.ui.activeViewRequestStartupRefresh = false;
      state.ui.activeViewRequestStartupHydrationTier = '';
      state.busy = false;
      state.ui.activeViewPayloadReady = false;
      let releasedPendingRequest = pendingRequest;
      let releasedStartupFollowup = pendingStartupHydrationFollowup;
      const ownsReleasedSlot = () => state.ui.activeViewRequestId === requestId && !state.busy
        && state.ui.activeViewRequestController === null
        && state.ui.activeViewRequestUrl === ''
        && state.view === releasedView
        && readViewStateRevision() === releasedViewStateRevision;
      const ownsReleasedWork = () => !cleanupWorkRetired && ownsReleasedSlot()
        && state.ui.pendingViewRequest === releasedPendingRequest
        && state.ui.pendingStartupHydrationFollowup === releasedStartupFollowup;
      const ownsReleasedContext = () => ownsReleasedWork()
        && galleryReadScopeIsCurrent(readScope) && ownsReleasedWork();
      if (
        !viewRendered
        && !retainsMountedSelectedViewState
        && requestOwnsCurrentViewState(requestId, requestViewStateRevision)
        && ownsReleasedContext()
      ) {
        renderRelated();
      }
      if (ownsReleasedWork()) {
        let pendingViewRequestDispatched = false;
        if (pendingRequest) {
          state.ui.pendingViewRequest = null;
          releasedPendingRequest = null;
          const pendingOriginatingRevision = Number(
            pendingRequest.originatingViewStateRevision || 0,
          );
          if (pendingOriginatingRevision === readViewStateRevision()
            && (!pendingRequest.originatingReadScope || galleryReadScopeIsCurrent(pendingRequest.originatingReadScope))
            && ownsReleasedWork()) {
            clearStartupHydrationFollowup();
            releasedStartupFollowup = null;
            pendingViewRequestDispatched = true;
            fetchAndRender(
              pendingRequest.url,
              pendingRequest.push,
              pendingRequest.options,
              pendingRequest.originatingOptions || pendingRequest.options,
            ).catch(() => {});
          }
        }
        if (pendingViewRequestDispatched) {
          // The current queued request owns the active slot.
        } else if (!ownsReleasedContext()) {
          // Cleanup may release this retired slot, but cannot initiate work for
          // the replacement identity or view.
        } else if (await dispatchPendingScanCompletionViewRefresh()) {
          // The one-shot post-scan refresh now owns the active request slot.
        } else if (!ownsReleasedContext()) {
          // Awaited recovery cannot continue after another foreground claim.
        } else if (await dispatchPendingCoverCompletionViewRefresh()) {
          // The one-shot post-cover refresh now owns the active request slot.
        } else if (!ownsReleasedContext()) {
          // The old finally does not schedule a successor's hydration.
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
          ownsReleasedContext()
          && state.ui.deferredUtilityViewRequest?.url
          && Boolean(!utilityModal || utilityModal.hidden)
          && typeof resumeDeferredUtilityViewRequest === 'function'
        ) {
          Promise.resolve().then(() => {
            if (ownsReleasedContext()) resumeDeferredUtilityViewRequest();
          });
        }
      }
      // Failed/cancelled/declined work may leave the exact old admission alive.
      // Settle only after owned cleanup and queued/automatic dispatch decisions;
      // a newer request, navigation or scope cannot be reopened by this finally.
      if (!settledApplied && !viewRendered && ownsReleasedContext()) {
        artistRequestSettlement?.settle(ownsReleasedContext);
      }
      if (ownsReleasedContext() && albumPreferenceModal && !albumPreferenceModal.read_only_subject
        && typeof getCurrentTrackModalAlbum === 'function' && getCurrentTrackModalAlbum() === albumPreferenceModal
        && typeof isTrackModalContentVisible === 'function' && isTrackModalContentVisible()
        && typeof renderTrackModalRelease === 'function') renderTrackModalRelease(albumPreferenceModal, albumPreferenceFocus);
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
      !cleanupWorkRetired && state.ui.activeViewRequestId === requestId
      && !state.busy
      && !state.ui.pendingViewRequest
      && !state.ui.scanPageReturnContext
      && !state.ui.forceScanPageVisible
    ) {
      resumeScanPageGalleryCoverLoads();
    }
    if (!cleanupWorkRetired && requestStarted && state.ui.activeViewRequestId === requestId
      && !controller?.signal.aborted
      && galleryReadScopeIsCurrent(readScope)
      && state.ui.activeViewRequestId === requestId
      && (settledApplied || requestOwnsCurrentViewState(requestId, requestViewStateRevision))) {
      try {requestOptions.onSettled?.({applied: settledApplied, error: settledError, requestId});}
      catch (_error) { /* An observer cannot change the request outcome. */ }
    }
    } finally {
      if (albumPreferenceFocus && albumPreferenceFocus.owner === null) albumPreferenceFocus.dispose();
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
  if(typeof invalidateAdvancedSearchIntent==='function')invalidateAdvancedSearchIntent('local-navigation');
  // Capture before any abort/continuity callback can install another owner.
  const albumPreferenceOwner = typeof getTrackModalAlbumPreferenceLease === 'function' ? getTrackModalAlbumPreferenceLease() : null;
  const rootPageOwner = rootGalleryPageRequest;
  const activeController = state.ui.activeViewRequestController;
  state.ui.viewStateRevision = Number(state.ui.viewStateRevision || 0) + 1;
  state.ui.pendingViewRequest = null;
  state.ui.pendingViewTransition = false;
  state.ui.pendingViewTransitionRequestId = 0;
  // Reentrant successor controls must capture the newly claimed revision.
  if (typeof disposeTrackModalAlbumPreferences === 'function') disposeTrackModalAlbumPreferences(albumPreferenceOwner);
  cancelRootGalleryPageRequest(rootPageOwner);
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
  if(typeof invalidateAdvancedSearchIntent==='function')invalidateAdvancedSearchIntent('query-assignment');
  if(typeof updateGallerySearchDraftQuery==='function')updateGallerySearchDraftQuery(String(returnContext.searchDraftQuery ?? state.view?.query ?? ''));
  else state.ui.searchDraftQuery = String(returnContext.searchDraftQuery ?? state.view?.query ?? '');
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
    if(typeof invalidateAdvancedSearchIntent==='function')invalidateAdvancedSearchIntent('query-assignment');
    if(typeof updateGallerySearchDraftQuery==='function')updateGallerySearchDraftQuery('');
    else state.ui.searchDraftQuery = '';
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
      if(typeof invalidateAdvancedSearchIntent==='function')invalidateAdvancedSearchIntent('query-assignment');
      if(typeof updateGallerySearchDraftQuery==='function')updateGallerySearchDraftQuery('');
      else state.ui.searchDraftQuery = '';
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
    if (!ownsStatus()) return;
    updateStatusIndicator(data);
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
      showToast('Album covers updated.', 'success', 3200);
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
    if (ownsStatus()) nextPollDelay = 3000;
  } finally {
    // A newer poll owns its continuation. Discarded work must not stop polling
    // or postpone an earlier action read that is already scheduled.
    if (sequence === statusPollSequence && (ownsStatus() || !statusPollTimer)) {
      scheduleStatusPoll(nextPollDelay ?? currentStatusPollDelay());
    }
  }
}
