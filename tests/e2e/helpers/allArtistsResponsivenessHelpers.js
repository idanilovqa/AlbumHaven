import { measureActionTime } from './performanceHelpers.js';
import {
  readRuntimeView,
  waitForLibraryStartupEntryVisible,
} from './realAppBenchmarkHelpers.js';

function classifyViewDataRequest(urlText, expectedArtist = '') {
  if (!URL.canParse(urlText)) return null;
  const url = new URL(urlText);
  if (url.pathname !== '/view-data') return null;
  const artist = String(url.searchParams.get('artist') || '').trim();
  const query = String(url.searchParams.get('q') || '').trim();
  const normalizedExpectedArtist = String(expectedArtist || '').trim().toLowerCase();
  let scope = 'other-view-data';
  if (!artist && !query) scope = 'root-all-artists';
  else if (artist.toLowerCase() === normalizedExpectedArtist) scope = 'selected-artist';
  return {
    artist,
    omitSidebar: String(url.searchParams.get('omit_sidebar') || '').trim(),
    payloadTier: String(url.searchParams.get('payload_tier') || '').trim(),
    query,
    scope,
    surface: String(url.searchParams.get('surface') || '').trim(),
    url: url.toString(),
  };
}

async function readSelectedArtistLifecycleSnapshot(page, galleryActions, navigationPanelActions) {
  const runtimeHandle = await page.waitForFunction(() => ({
    activeViewRequestUrl: String(state?.ui?.activeViewRequestUrl || '').trim(),
    busy: Boolean(state?.busy),
    persistenceBackend: String(state?.view?.persistence_backend || '').trim(),
    selectedArtist: String(state?.view?.selected_artist || '').trim(),
    viewDataSource: String(state?.view?.view_data_source || '').trim(),
  }));
  const [runtime, activeSidebarText, artistHeadings] = await Promise.all([
    runtimeHandle.jsonValue(),
    navigationPanelActions.navigationPanel.activeSidebarLink.textContent(),
    galleryActions.readArtistHeadings(),
  ]);
  return {
    ...runtime,
    activeSidebarText: String(activeSidebarText || '').trim(),
    artistHeadings: artistHeadings.map((heading) => String(heading || '').trim()).filter(Boolean),
    locationSearch: new URL(page.url()).search,
  };
}

export function pickSearchFollowUpArtist(sidebarArtists, expectedArtist) {
  const artists = Array.isArray(sidebarArtists)
    ? sidebarArtists.map((artist) => String(artist || '').trim()).filter(Boolean)
    : [];
  return artists.includes(expectedArtist) ? expectedArtist : '';
}

export function summarizeSelectedArtistRequestLifecycle(lifecycle) {
  const selectedArtistEvents = lifecycle.events.filter((event) => event.scope === 'selected-artist');
  const sentCount = selectedArtistEvents.filter((event) => event.event === 'request').length;
  const finishedEvent = [...selectedArtistEvents].reverse().find((event) => event.event === 'requestfinished');
  const failedEvent = [...selectedArtistEvents].reverse().find((event) => event.event === 'requestfailed');
  if (!sentCount) {
    return `selected artist request not observed; active sidebar "${lifecycle.runtimeSnapshot.activeSidebarText}" search "${lifecycle.runtimeSnapshot.locationSearch}"`;
  }
  if (finishedEvent) {
    const responseSummary = lifecycle.responseSummaries.find((entry) => entry.requestId === finishedEvent.requestId);
    const returnedArtist = String(responseSummary?.selectedArtist || '').trim();
    const source = String(responseSummary?.viewDataSource || '').trim();
    return `selected artist request finished ${finishedEvent.status || 'unknown'} for "${returnedArtist || lifecycle.artistName}" via ${source || 'unknown source'}`;
  }
  if (failedEvent) return `selected artist request failed with ${failedEvent.errorText || 'unknown error'}`;
  return 'selected artist request sent but no terminal event was observed';
}

export async function runWithSelectedArtistRequestLifecycle(
  page,
  galleryActions,
  navigationPanelActions,
  artistName,
  action,
) {
  const events = [];
  const responseReads = [];
  const requestIds = new Map();
  const startedAt = Date.now();
  let nextRequestId = 1;
  const getRequestId = (request) => {
    if (!requestIds.has(request)) {
      requestIds.set(request, nextRequestId);
      nextRequestId += 1;
    }
    return requestIds.get(request);
  };
  const pushEvent = (request, event, extra = {}) => {
    const classification = classifyViewDataRequest(request.url(), artistName);
    if (!classification) return;
    events.push({
      atMs: Date.now() - startedAt,
      event,
      method: request.method(),
      requestId: getRequestId(request),
      ...classification,
      ...extra,
    });
  };
  const onRequest = (request) => pushEvent(request, 'request');
  const onRequestFinished = (request) => {
    const classification = classifyViewDataRequest(request.url(), artistName);
    if (!classification) return;
    const requestId = getRequestId(request);
    responseReads.push((async () => {
      const response = await request.response();
      if (!response) throw new Error(`Expected a response for completed request ${request.url()}.`);
      pushEvent(request, 'requestfinished', { status: response.status() });
      if (classification.scope !== 'selected-artist') return null;
      const payload = await response.json();
      return {
        albumCount: Number(payload?.album_count || 0),
        payloadTier: String(payload?.payload_tier || '').trim(),
        persistenceBackend: String(payload?.persistence_backend || '').trim(),
        requestId,
        selectedArtist: String(payload?.selected_artist || '').trim(),
        viewDataSource: String(payload?.view_data_source || '').trim(),
      };
    })());
  };
  const onRequestFailed = (request) => pushEvent(request, 'requestfailed', {
    errorText: request.failure()?.errorText || 'requestfailed',
  });

  page.on('request', onRequest);
  page.on('requestfinished', onRequestFinished);
  page.on('requestfailed', onRequestFailed);
  try {
    await action();
  } finally {
    page.off('request', onRequest);
    page.off('requestfinished', onRequestFinished);
    page.off('requestfailed', onRequestFailed);
  }
  const responseSummaries = (await Promise.all(responseReads)).filter(Boolean);
  return {
    artistName,
    events,
    responseSummaries,
    runtimeSnapshot: await readSelectedArtistLifecycleSnapshot(
      page,
      galleryActions,
      navigationPanelActions,
    ),
  };
}

export async function selectSidebarArtistAtAndVerify(
  navigationPanelActions,
  index,
  expectedArtistName,
  options = {},
) {
  const selectedArtist = String(expectedArtistName || '').trim();
  if (!selectedArtist) throw new Error('Expected a non-empty sidebar artist name for indexed selection.');
  const clickedArtistName = String(
    await navigationPanelActions.selectSidebarArtistAt(index, options) || '',
  ).trim();
  if (clickedArtistName !== selectedArtist) {
    throw new Error(`Expected sidebar artist index ${index + 1} to resolve to "${selectedArtist}", but clicked "${clickedArtistName}".`);
  }
}

export async function waitForRootStartupSignal(galleryActions, navigationPanelActions, options = {}) {
  const loaderState = await waitForLibraryStartupEntryVisible(
    galleryActions.galleryPage.page,
    galleryActions,
    navigationPanelActions,
    { timeout: Number(options.timeout || 60000) },
  );
  return String(loaderState?.startupMode || 'unknown');
}

export async function measureStartupSidebarHydration(galleryActions, navigationPanelActions) {
  await galleryActions.goto('/');
  const previewSidebarStart = Date.now();
  const startupMode = await waitForRootStartupSignal(galleryActions, navigationPanelActions);
  const previewSidebarMs = Date.now() - previewSidebarStart;
  const previewSidebarCount = await navigationPanelActions.readSidebarArtistCount();
  const previewVisibleAllArtistsCount = await navigationPanelActions.readAllArtistsVisibleCount();
  const fullSidebarMsPromise = measureActionTime(
    async () => {},
    async () => navigationPanelActions.waitForSidebarFullyHydrated(),
  );
  const fullCountSynchronizedMsPromise = measureActionTime(
    async () => {},
    async () => navigationPanelActions.waitForSidebarAndAllArtistsCountSynchronized(),
  );
  const [fullSidebarMs, fullCountSynchronizedMs] = await Promise.all([
    fullSidebarMsPromise,
    fullCountSynchronizedMsPromise,
  ]);
  const fullSidebarCount = await navigationPanelActions.readSidebarArtistCount();
  const fullVisibleAllArtistsCount = await navigationPanelActions.readAllArtistsVisibleCount();
  const firstAlbumsReadinessBefore = await galleryActions.readInitialAllArtistsReadinessSnapshot();
  const firstAlbumsMs = await measureActionTime(
    async () => {},
    async () => galleryActions.waitForInitialAllArtistsSections(),
  );
  const firstAlbumsReadinessAfter = await galleryActions.readInitialAllArtistsReadinessSnapshot();
  const coversMs = await measureActionTime(
    async () => {},
    async () => galleryActions.waitForVisibleGalleryCoversLoaded({
      minimumCount: 2,
      timeout: 30000,
    }),
  );
  return {
    startupMode,
    previewSidebarMs,
    previewSidebarCount,
    previewVisibleAllArtistsCount,
    fullSidebarMs,
    fullSidebarCount,
    fullCountSynchronizedMs,
    fullVisibleAllArtistsCount,
    firstAlbumsMs,
    firstAlbumsReadinessBefore,
    firstAlbumsReadinessAfter,
    coversMs,
  };
}

export async function measureAllArtistsReturn(galleryActions, navigationPanelActions) {
  const selectionMs = await measureActionTime(
    async () => navigationPanelActions.clickAllArtists(),
    async () => navigationPanelActions.waitForSidebarSelection('All artists'),
  );
  const firstAlbumsMs = selectionMs + await measureActionTime(
    async () => {},
    async () => galleryActions.waitForAllArtistsStructure(),
  );
  const coversMs = selectionMs + await measureActionTime(
    async () => {},
    async () => galleryActions.waitForVisibleGalleryCoversLoaded({
      minimumCount: 2,
      timeout: 30000,
    }),
  );
  return { selectionMs, firstAlbumsMs, coversMs };
}

export async function jumpGalleryToMiddle(galleryActions) {
  let jumpState;
  const jumpSettledMs = await measureActionTime(async () => {
    jumpState = await galleryActions.jumpGalleryToMiddle({ settleMs: 250 });
  });
  return {
    jumpSettledMs,
    visibleArtists: jumpState.visibleArtists,
    scrollTop: jumpState.scrollTop,
    maxScrollTop: jumpState.maxScrollTop,
    visibleArtistCount: jumpState.visibleArtists.length,
  };
}

export async function waitForBrowseIdle(page, timeout = 30000) {
  await page.waitForFunction(() => (
    typeof state !== 'undefined'
    && !state.busy
    && !String(state.ui?.activeViewRequestUrl || '')
  ), null, { timeout });
}

export async function waitForActiveBrowseRequestClear(page, timeout = 15000) {
  await page.waitForFunction(() => (
    typeof state !== 'undefined'
    && !String(state.ui?.activeViewRequestUrl || '').trim()
  ), null, { timeout });
}

export async function readBrowseTelemetry(page) {
  const view = await readRuntimeView(page);
  return {
    persistenceBackend: String(view?.persistence_backend || '').trim(),
    viewDataSource: String(view?.view_data_source || '').trim(),
  };
}

export async function measureSearchAllArtistsLoad(
  galleryActions,
  navigationPanelActions,
  expectedQuery,
) {
  const selectionMs = await measureActionTime(
    async () => navigationPanelActions.clickAllArtists(),
    async () => navigationPanelActions.waitForSidebarSelection('All artists', { timeout: 60000 }),
  );
  const galleryReadyMs = selectionMs + await measureActionTime(
    async () => {},
    async () => {
      await galleryActions.waitForAllArtistsStructure({
        timeout: 60000,
        expectedQuery,
        minimumHeadingCount: 1,
        requireScrollable: false,
      });
      await galleryActions.galleryPage.waitForDecodedProductionCardWindow({
        minimumDecodedCount: 2,
        timeout: 60000,
      });
    },
  );
  return { selectionMs, galleryReadyMs };
}

export async function waitForSearchBenchmarkWarmRoot(
  galleryActions,
  navigationPanelActions,
  timeout,
) {
  await navigationPanelActions.waitForSidebarFullyHydrated({ timeout });
  await galleryActions.waitForInitialAllArtistsSections({ timeout });
  await galleryActions.waitForInitialRefreshCompleted({ timeout });
  await galleryActions.waitForVisibleGalleryCoversLoaded({
    minimumCount: 2,
    timeout,
  });
}
