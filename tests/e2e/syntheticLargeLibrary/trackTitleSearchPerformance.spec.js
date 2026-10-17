import { performance } from 'node:perf_hooks';

import { expect, test as performanceTest } from '../support/performanceFixtures.js';
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

performanceTest.describe(`${CASE_ID} synthetic-large track-title search performance`, () => {
  performanceTest('correct album and highlighted track become visible within approved budgets', async ({
    galleryActions,
    navigationPanelActions,
    page,
    searchToolbarActions,
    stepLogger,
    trackModalActions,
    trackTitleSearchLocalReport,
  }) => {
    performanceTest.setTimeout(180000);
    requirePostgresRuntimeEnv('the track-title search benchmark');

    await stepLogger.step('Open the production app and wait for root readiness', async () => {
      await galleryActions.goto('/');
      await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions);
    });

    let submittedAt = 0;
    const albumVisibleMs = await stepLogger.step('Search the exact track title and wait for its album card', async () => {
      await searchToolbarActions.search(TRACK, {
        recordSubmissionBoundary() {
          submittedAt = performance.now();
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

    const view = await readRuntimeView(page);
    expect(view, 'Expected the track search runtime view.').toBeTruthy();
    expectPostgresLibraryBrowseTelemetry(view, 'full');
    expect(String(view.query || '').trim()).toBe(TRACK);

    const matchingTrackVisibleMs = await stepLogger.step('Open Album Details and wait for the visible matching-track accent', async () => {
      const openedAt = performance.now();
      await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
      await trackModalActions.waitForReady();
      const matchingRow = trackModalActions.trackModal.albumTrackTable.rows
        .filter({ hasText: TRACK })
        .first();
      await expect(matchingRow).toBeVisible({ timeout: 120000 });
      await expect(matchingRow).toHaveAttribute('data-track-search-match', 'true', {
        timeout: 120000,
      });
      return performance.now() - openedAt;
    });

    await trackTitleSearchLocalReport.recordTimingCheckpoint({
      key: 'track-title-search-album-visible',
      label: 'Exact track search to visible matching album card',
      timingMs: albumVisibleMs,
      details: { album: ALBUM, track: TRACK },
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
    trackTitleSearchLocalReport.setMetricsPayload({ album: ALBUM, track: TRACK });
    trackTitleSearchLocalReport.recordContractCompletion();
  });
});
