// Failure-only evidence for gallery refresh and scroll cases. Everything here
// observes: no request is intercepted, delayed or changed, and nothing waits.

const OBSERVED_PATHS = new Set(['/view-data', '/home-data', '/status']);

function summarizeBody(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const groups = Array.isArray(payload.artist_groups) ? payload.artist_groups : null;
  return {
    inventoryRevision: payload.inventory_mutation_revision ?? null,
    projectionPending: payload.projection_pending ?? payload.gallery_projection_pending ?? null,
    albumCount: payload.album_count ?? null,
    groupAlbumCount: groups ? groups.reduce((count, group) => count + (group.albums || []).length, 0) : null,
    hasMore: payload.gallery_page?.has_more ?? null,
    scanInProgress: payload.scan_in_progress ?? null,
    relationsInProgress: payload.relations_in_progress ?? null,
    coversInProgress: payload.covers_in_progress ?? null,
  };
}

// Every gallery, totals and status exchange while the case runs, with the
// fields that decide whether the open page refreshes.
export function observeGalleryTraffic(page) {
  const startedAt = Date.now();
  const entries = [];
  const bodyReads = [];
  const observed = (url) => {
    const parsed = new URL(url);
    return OBSERVED_PATHS.has(parsed.pathname) ? `${parsed.pathname}${parsed.search}` : null;
  };
  const onRequest = (request) => {
    const url = observed(request.url());
    if (url) entries.push({ atMs: Date.now() - startedAt, kind: 'request', url });
  };
  const onResponse = (response) => {
    const url = observed(response.url());
    if (!url) return;
    const entry = { atMs: Date.now() - startedAt, kind: 'response', url, status: response.status() };
    entries.push(entry);
    bodyReads.push(response.json()
      .then((payload) => Object.assign(entry, summarizeBody(payload)))
      .catch((error) => { entry.bodyError = String(error?.message || error); }));
  };
  const onRequestFailed = (request) => {
    const url = observed(request.url());
    if (url) {
      entries.push({
        atMs: Date.now() - startedAt, kind: 'failed', url, failure: request.failure()?.errorText || '',
      });
    }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  return {
    startedAt,
    async finish() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
      await Promise.allSettled(bodyReads);
      return entries;
    },
  };
}

// The page's own refresh, paging and scroll ownership at the moment a case fails.
export async function readGalleryRuntimeState(page) {
  // parity-check: allow-read-only-measurement-evaluate -- failure-only snapshot of refresh, paging and scroll ownership
  return page.evaluate(() => {
    const scroll = document.getElementById('albums-scroll');
    const rect = scroll?.getBoundingClientRect();
    const centerElement = rect
      ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      : null;
    const grid = typeof virtualGrid === 'undefined' ? null : virtualGrid;
    const pageRequest = typeof rootGalleryPageRequest === 'undefined' ? null : rootGalleryPageRequest;
    const view = typeof state === 'undefined' ? null : state.view;
    const ui = typeof state === 'undefined' ? {} : state.ui || {};
    return {
      busy: typeof state === 'undefined' ? null : Boolean(state.busy),
      activeViewRequestUrl: String(ui.activeViewRequestUrl || ''),
      pendingViewTransition: Boolean(ui.pendingViewTransition),
      pendingInventoryMutationViewRefresh: Boolean(ui.pendingInventoryMutationViewRefresh),
      pendingArtistTreeRefresh: Boolean(ui.pendingArtistTreeRefresh),
      appliedViewInventoryMutationRevision: ui.appliedViewInventoryMutationRevision ?? null,
      staleProjectionViewRefreshCount: ui.staleProjectionViewRefreshCount ?? null,
      statusInventoryRevision: typeof state === 'undefined' ? null : state.status?.inventory_mutation_revision ?? null,
      statusBusy: typeof state === 'undefined' ? null : {
        scan: Boolean(state.status?.scan_in_progress),
        relations: Boolean(state.status?.relations_in_progress),
        covers: Boolean(state.status?.covers_in_progress),
      },
      pendingSidebarNavigation: typeof hasPendingSidebarNavigation === 'function'
        ? hasPendingSidebarNavigation() : null,
      pendingTagEditViewMutations: typeof hasPendingTagEditViewMutations === 'function'
        ? hasPendingTagEditViewMutations() : null,
      query: String(view?.query || ''),
      galleryPage: view?.gallery_page ? {
        hasMore: Boolean(view.gallery_page.has_more),
        hasNextCursor: Boolean(view.gallery_page.next_cursor),
        revision: view.gallery_page.revision ?? null,
      } : null,
      rootGalleryPageRequest: pageRequest ? { url: pageRequest.url, cursor: pageRequest.cursor } : null,
      scroll: scroll ? {
        scrollTop: scroll.scrollTop,
        scrollHeight: scroll.scrollHeight,
        clientHeight: scroll.clientHeight,
        overflowY: getComputedStyle(scroll).overflowY,
        centerElementInside: Boolean(centerElement && scroll.contains(centerElement)),
        centerElement: centerElement
          ? `${centerElement.tagName.toLowerCase()}#${centerElement.id}.${String(centerElement.className || '').slice(0, 80)}`
          : null,
      } : null,
      grid: grid ? {
        isScrollSettled: Boolean(grid.isScrollSettled),
        touchGestureActive: Boolean(grid._touchScrollGestureActive),
        absoluteScrollRestore: grid._absoluteScrollRestore || null,
        renderGeneration: grid._renderGeneration ?? null,
        pendingStabilizationScroll: grid._pendingStabilizationScroll || null,
        deferredSetGroups: Boolean(grid._deferredSetGroups),
        deferredAppends: Array.isArray(grid._deferredAppends) ? grid._deferredAppends.length : null,
        heldTrailingSpace: grid.heldTrailingSpace ?? null,
        leadingExtent: grid.leadingExtent ?? null,
      } : null,
      bodyClass: document.body.className,
      virtualGridDiagnostics: JSON.parse(JSON.stringify(globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__ || null)),
    };
  });
}
