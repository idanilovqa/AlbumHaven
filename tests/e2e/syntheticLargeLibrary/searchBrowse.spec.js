import { expect, test as performanceTest } from '../support/performanceFixtures.js';

import {
  expectPostgresLibraryBrowseTelemetry,
  expectTimingBudget,
  performanceTimingBudget,
} from '../helpers/index.js';
import {
  flattenAlbums,
  pickSearchableArtistName,
  readRuntimeView,
  requirePostgresRuntimeEnv,
  waitForPostgresBrowseWarmRoot,
} from '../helpers/realAppBenchmarkHelpers.js';

// Passive diagnostics only; the measured user flow and budgets remain unchanged.
const test = performanceTest.extend({
  searchRequestTimings: async ({ page }, use, testInfo) => {
    const requests = [];
    const records = new WeakMap();
    const paths = new Set(['/view-data', '/home-data', '/album-details', '/cover']);
    const queryKeys = ['q', 'artist', 'payload_tier', 'gallery_offset', 'gallery_cursor',
      'omit_sidebar', 'surface', 'album_key', 'path', 'size'];
    let searchSubmittedAt = null;
    let origin = null;
    let droppedRequests = 0;
    const onRequest = (request) => {
      if (searchSubmittedAt === null) return;
      const url = new URL(request.url());
      if (url.origin !== origin) return;
      const pathname = paths.has(url.pathname) ? url.pathname
        : request.resourceType() === 'image' ? '[same-origin-image]' : null;
      if (!pathname) return;
      if (requests.length >= 250) { droppedRequests += 1; return; }
      const record = {
        id: requests.length + 1, pathname, method: request.method(),
        queryKeys: queryKeys.filter(key => url.searchParams.has(key)),
        startedAtMs: Date.now() - searchSubmittedAt, status: null, state: 'pending',
      };
      records.set(request, record);
      requests.push(record);
    };
    const onResponse = (response) => {
      const record = records.get(response.request());
      if (record) record.status = response.status();
    };
    const finish = (request, state) => {
      const record = records.get(request);
      if (!record) return;
      const timing = request.timing();
      Object.assign(record, {
        state, endedAtMs: Date.now() - searchSubmittedAt,
        networkStartEpochMs: timing.startTime, requestStartMs: timing.requestStart,
        responseStartMs: timing.responseStart, responseEndMs: timing.responseEnd,
      });
      if (state === 'failed') {
        const error = request.failure()?.errorText || '';
        record.failure = /^net::ERR_[A-Z_]+$/u.test(error) ? error : 'requestfailed';
      }
      records.delete(request);
    };
    const onFinished = request => finish(request, 'finished');
    const onFailed = request => finish(request, 'failed');
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfinished', onFinished);
    page.on('requestfailed', onFailed);
    try {
      await use({ start(at) { searchSubmittedAt = at; origin = new URL(page.url()).origin; } });
    } finally {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
      await testInfo.attach('search-request-timings', {
        body: Buffer.from(JSON.stringify({ searchSubmittedAt, droppedRequests, requests }, null, 2)),
        contentType: 'application/json',
      });
    }
  },
});

const CASE_ID = 'FTC-GALLERY-STARTUP-005R';
const SEARCH_BROWSE_BUDGET = Object.freeze(
  performanceTimingBudget('search-browse.searchBrowseReadyMs'),
);
const SEARCH_POPULATED_BUDGET = Object.freeze(
  performanceTimingBudget('search-browse.searchPopulatedReadyMs'),
);

test.describe(`${CASE_ID} synthetic-large direct search browse`, () => {

  test('Search UI reports direct library_browse telemetry and timing', async ({
    galleryActions,
    navigationPanelActions,
    page,
    searchBrowseFocusedLocalReport,
    searchRequestTimings,
    searchToolbarActions,
    stepLogger,
  }) => {
    requirePostgresRuntimeEnv('the search browse benchmark');

    await stepLogger.step('Warm the real app root before exercising the visible search path', async () => {
      await galleryActions.goto('/');
      await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions);
    });

    const searchQuery = pickSearchableArtistName(await navigationPanelActions.readSidebarArtistNames());
    await galleryActions.waitForDisplayedArtistSections([searchQuery]);
    await galleryActions.waitForFirstAlbumVisibleUnderHeading(searchQuery);
    const expectedAlbums = await galleryActions.readAlbumNamesByHeading(searchQuery);
    expect(expectedAlbums.length, 'The pre-search gallery must provide an independent album identity.').toBeGreaterThan(0);
    let searchSubmittedAt = 0;
    const searchReadyMs = await stepLogger.step('Search from the visible UI and wait for query results', async () => {
      await searchToolbarActions.search(searchQuery, {
        recordSubmissionBoundary() {
          searchSubmittedAt = Date.now();
          searchRequestTimings.start(searchSubmittedAt);
        },
      });
      await searchToolbarActions.waitForQuery(searchQuery, { timeout: 120000 });
      return Date.now() - searchSubmittedAt;
    });

    const searchPopulatedReadyMs = await stepLogger.step('Wait for the filtered gallery and visible covers to settle', async () => {
      await navigationPanelActions.waitForSidebarSelection(searchQuery, { timeout: 120000 });
      await galleryActions.waitForSelectedArtistGallery(searchQuery, {
        timeout: 120000,
        queryValue: searchQuery,
      });
      const albumCard = galleryActions.galleryPage.albumCard;
      const expectedCover = albumCard.cardByArtistAndAlbum(searchQuery, expectedAlbums[0], { visible: true })
        .locator(albumCard.coverImageWithinCardSelector);
      await expect(expectedCover).toBeInViewport({ timeout: 120000 });
      await expect.poll(async () => {
        const cover = await albumCard
          .readCoverImageReadinessByArtistAndAlbum(searchQuery, expectedAlbums[0]);
        return cover.ready;
      }, { timeout: 120000 }).toBe(true);
      await galleryActions.waitForVisibleGalleryCoversLoaded({
        minimumCount: 1,
        timeout: 120000,
      });
      return Date.now() - searchSubmittedAt;
    });
    const searchPayload = await readRuntimeView(page);
    let albums = [];
    await stepLogger.step('Assert the search UI came from library_browse with direct matches', async () => {
      expect(searchPayload, 'Expected the search runtime view to be available after the visible search flow.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(searchPayload, 'full');
      expect(String(searchPayload.query || '').trim()).toBe(searchQuery);
      expect(Array.isArray(searchPayload.artist_groups)).toBe(true);
      expect(Number(searchPayload.album_count || 0)).toBeGreaterThan(0);
      albums = flattenAlbums(searchPayload.artist_groups);
      expect(albums.length).toBeGreaterThan(0);
      const directMatches = searchPayload.search_context?.result_groups?.direct_matches;
      expect(Array.isArray(directMatches)).toBe(true);
      expect(directMatches.length).toBeGreaterThan(0);
    });

    await searchBrowseFocusedLocalReport.recordTimingCheckpoint({
      key: 'search-browse-api',
      label: 'Search query ready',
      timingMs: searchReadyMs,
      details: {
        phase: 'search_browse',
        query: searchQuery,
        albumCount: Number(searchPayload.album_count || 0),
        artistGroupCount: searchPayload.artist_groups.length,
        directMatchCount: searchPayload.search_context.result_groups.direct_matches.length,
        persistenceBackend: searchPayload.persistence_backend,
        persistenceSeam: searchPayload.persistence_seam,
        viewDataSource: searchPayload.view_data_source,
      },
    });

    searchBrowseFocusedLocalReport.setMetricsPayload({
      searchReadyMs,
      searchPopulatedReadyMs,
      expectedAlbum: expectedAlbums[0],
      query: searchQuery,
      albumCount: Number(searchPayload.album_count || 0),
      artistGroupCount: searchPayload.artist_groups.length,
      directMatchCount: searchPayload.search_context.result_groups.direct_matches.length,
      persistenceBackend: searchPayload.persistence_backend,
      persistenceSeam: searchPayload.persistence_seam,
      viewDataSource: searchPayload.view_data_source,
    });

    searchBrowseFocusedLocalReport.recordTerminalTimingOutcome(
      SEARCH_BROWSE_BUDGET.metricId,
      'searchBrowseReadyMs',
      expectTimingBudget(
        expect.soft,
        searchReadyMs,
        SEARCH_BROWSE_BUDGET,
        'Normal search committed-query readiness',
      ),
    );
    await searchBrowseFocusedLocalReport.recordTimingCheckpoint({
      key: 'search-browse-populated',
      label: 'Matching gallery and visible covers ready',
      timingMs: searchPopulatedReadyMs,
      details: { query: searchQuery, expectedAlbum: expectedAlbums[0] },
    });
    searchBrowseFocusedLocalReport.recordTerminalTimingOutcome(
      SEARCH_POPULATED_BUDGET.metricId,
      'searchPopulatedReadyMs',
      expectTimingBudget(
        expect.soft,
        searchPopulatedReadyMs,
        SEARCH_POPULATED_BUDGET,
        'Search matching album and visible artwork readiness',
      ),
    );
    searchBrowseFocusedLocalReport.recordContractCompletion();
  });
});
