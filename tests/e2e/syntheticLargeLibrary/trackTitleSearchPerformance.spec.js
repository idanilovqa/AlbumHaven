import { performance } from 'node:perf_hooks';

import { expect, test } from '../support/performanceFixtures.js';
import {
  expectPostgresLibraryBrowseTelemetry,
  expectTimingBudget,
  performanceTimingBudget,
} from '../helpers/index.js';
import {
  readRuntimeView,
  requirePostgresRuntimeEnv,
  waitForPostgresBrowseWarmRoot,
} from '../helpers/realAppBenchmarkHelpers.js';

const CASE_ID = 'FTC-SEARCH-NAV-030P';
const TRACK = 'Фонограммщик';
const ALBUM = 'Ремиксы';
const SEARCH_BUDGET = Object.freeze(performanceTimingBudget('track-title-search.albumVisibleMs'));
const HIGHLIGHT_BUDGET = Object.freeze(
  performanceTimingBudget('track-title-search.matchingTrackVisibleMs'),
);
const ALBUM_DETAILS_PHASE_BUDGETS = Object.freeze(Object.fromEntries([
  'albumDetailsShellMs',
  'albumDetailsCoverMs',
].map((key) => [key, Object.freeze(performanceTimingBudget(`track-title-search.${key}`))])));

test.describe(`${CASE_ID} synthetic-large track-title search performance`, () => {
  test('correct album and highlighted track become visible within approved budgets', async ({
    appBarActions,
    galleryActions,
    navigationPanelActions,
    page,
    searchToolbarActions,
    stepLogger,
    trackModalActions,
    trackTitleSearchLocalReport,
  }) => {
    test.setTimeout(180000);
    requirePostgresRuntimeEnv('the track-title search benchmark');

    await stepLogger.step('Open the production app and wait for root readiness', async () => {
      await galleryActions.goto('/');
      await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions);
    });
    const rootSidebarArtistNames = await navigationPanelActions.readHydratedSidebarArtistNames();
    const rootArtistCount = await navigationPanelActions.readAllArtistsVisibleCount();

    let submittedAt = 0;
    let submittedEpochMs = 0;
    const responsePromise = page.waitForResponse((response) => {
      if (response.request().method() !== 'GET' || !response.ok()) return false;
      const url = new URL(response.url());
      return url.pathname === '/view-data'
        && String(url.searchParams.get('q') || '').trim() === TRACK
        && String(url.searchParams.get('payload_tier') || 'full').trim() === 'full';
    }, { timeout: 120000 });
    const albumVisibleMs = await stepLogger.step('Search the exact track title and wait for its album card', async () => {
      await searchToolbarActions.search(TRACK, {
        recordSubmissionBoundary() {
          submittedAt = performance.now();
          submittedEpochMs = Date.now();
        },
      });
      await searchToolbarActions.waitForQuery(TRACK, { timeout: 120000 });
      await galleryActions.waitForAlbumVisible(ALBUM, { timeout: 120000 });
      await expect(
        galleryActions.galleryPage.albumCard.cardByAlbumName(ALBUM).first(),
      ).toBeVisible({ timeout: 120000 });
      expect(submittedAt, 'Search submission boundary must be recorded.').toBeGreaterThan(0);
      return performance.now() - submittedAt;
    });
    const response = await responsePromise;
    await response.finished();
    const requestTiming = response.request().timing();
    const responseEndElapsedMs = requestTiming.startTime + requestTiming.responseEnd - submittedEpochMs;
    const browserProcessingMs = albumVisibleMs - responseEndElapsedMs;
    await test.info().attach('track-search-request-timing', {
      body: Buffer.from(JSON.stringify({
        albumVisibleMs,
        browserProcessingMs,
        requestTiming,
        responseEndElapsedMs,
        responseUrl: response.url(),
      }, null, 2)),
      contentType: 'application/json',
    });

    const view = await readRuntimeView(page);
    expect(view, 'Expected the track search runtime view.').toBeTruthy();
    expectPostgresLibraryBrowseTelemetry(view, 'full');
    expect(String(view.query || '').trim()).toBe(TRACK);

    let albumDetailsShellMs = 0;
    let albumDetailsCoverMs = 0;
    const matchingTrackVisibleMs = await stepLogger.step('Open Album Details and wait for the visible matching-track accent', async () => {
      const openedAt = performance.now();
      await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
      await expect(trackModalActions.trackModal.dialog).toBeVisible({ timeout: 120000 });
      albumDetailsShellMs = performance.now() - openedAt;
      await trackModalActions.waitForReady();
      const matchingRow = trackModalActions.trackModal.albumTrackTable.rows
        .filter({ hasText: TRACK })
        .first();
      await expect(matchingRow).toBeVisible({ timeout: 120000 });
      await expect(matchingRow).toHaveAttribute('data-track-search-match', 'true', {
        timeout: 120000,
      });
      const contentMs = performance.now() - openedAt;
      await trackModalActions.waitForDetailedCoverImageCheckpoint({ timeout: 120000 });
      albumDetailsCoverMs = performance.now() - openedAt;
      return contentMs;
    });

    await trackTitleSearchLocalReport.recordTimingCheckpoint({
      key: 'track-title-search-album-visible',
      label: 'Exact track search to visible matching album card',
      timingMs: albumVisibleMs,
      details: { album: ALBUM, browserProcessingMs, responseEndElapsedMs, track: TRACK },
    });
    trackTitleSearchLocalReport.recordTerminalTimingOutcome(
      SEARCH_BUDGET.metricId,
      'albumVisibleMs',
      expectTimingBudget(
        expect.soft,
        albumVisibleMs,
        SEARCH_BUDGET,
        'Exact track search visible album content',
      ),
    );
    await trackTitleSearchLocalReport.recordTimingCheckpoint({
      key: 'track-title-search-highlight-visible',
      label: 'Album Details activation to visible highlighted matching track',
      timingMs: matchingTrackVisibleMs,
      details: { album: ALBUM, track: TRACK },
    });
    await trackTitleSearchLocalReport.recordTimingCheckpoint({
      key: 'track-title-search-album-details-shell',
      label: 'Track search Album Details shell visible',
      timingMs: albumDetailsShellMs,
    });
    await trackTitleSearchLocalReport.recordTimingCheckpoint({
      key: 'track-title-search-album-details-cover',
      label: 'Track search Album Details decoded cover visible',
      timingMs: albumDetailsCoverMs,
    });
    for (const [key, label, timingMs] of [
      ['albumDetailsShellMs', 'Track search Album Details shell visible', albumDetailsShellMs],
      ['albumDetailsCoverMs', 'Track search Album Details decoded cover visible', albumDetailsCoverMs],
    ]) {
      trackTitleSearchLocalReport.recordTerminalTimingOutcome(
        ALBUM_DETAILS_PHASE_BUDGETS[key].metricId,
        key,
        expectTimingBudget(expect.soft, timingMs, ALBUM_DETAILS_PHASE_BUDGETS[key], label),
      );
    }
    trackTitleSearchLocalReport.recordTerminalTimingOutcome(
      HIGHLIGHT_BUDGET.metricId,
      'matchingTrackVisibleMs',
      expectTimingBudget(
        expect.soft,
        matchingTrackVisibleMs,
        HIGHLIGHT_BUDGET,
        'Album Details matching-track highlight',
      ),
    );
    await stepLogger.step('Restore the complete root gallery and Artist Tree through Home', async () => {
      await trackModalActions.close();
      await appBarActions.openLibraryHome();
      await searchToolbarActions.waitForQuery('', { timeout: 120000 });
      await navigationPanelActions.waitForAllArtistsVisibility(true, { timeout: 120000 });
      await galleryActions.waitForGalleryReady({ timeout: 120000 });
      await expect.poll(
        () => navigationPanelActions.readHydratedSidebarArtistNames(),
        { timeout: 120000 },
      ).toEqual(rootSidebarArtistNames);
      expect(await navigationPanelActions.readAllArtistsVisibleCount()).toBe(rootArtistCount);
      const restoredView = await readRuntimeView(page);
      expect(String(restoredView?.query || '').trim()).toBe('');
      expect(String(restoredView?.selected_artist || '').trim()).toBe('');
    });

    trackTitleSearchLocalReport.setMetricsPayload({ album: ALBUM, track: TRACK });
    trackTitleSearchLocalReport.recordContractCompletion();
  });
});
