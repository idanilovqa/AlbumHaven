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

const CASE_ID = 'FTC-SEARCH-NAV-029P';
const ALBUM = 'Студийные записи';
const BUDGET = Object.freeze(performanceTimingBudget('album-title-search.albumVisibleMs'));

test.describe(`${CASE_ID} synthetic-large album-title search performance`, () => {
  test('correct album becomes visible within the approved budget', async ({
    albumTitleSearchLocalReport,
    galleryActions,
    navigationPanelActions,
    page,
    searchToolbarActions,
    stepLogger,
  }, testInfo) => {
    test.setTimeout(180000);
    requirePostgresRuntimeEnv('the album-title search benchmark');

    await stepLogger.step('Open the production app and wait for root readiness', async () => {
      await galleryActions.goto('/');
      await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions);
    });

    let submittedAt = 0;
    let submittedEpochMs = 0;
    const responsePromise = page.waitForResponse((response) => {
      if (response.request().method() !== 'GET' || !response.ok()) return false;
      const url = new URL(response.url());
      return url.pathname === '/view-data'
        && String(url.searchParams.get('q') || '').trim() === ALBUM
        && String(url.searchParams.get('payload_tier') || 'full').trim() === 'full';
    }, { timeout: 120000 });
    const albumVisibleMs = await stepLogger.step('Search the exact album title and wait for its visible card', async () => {
      await searchToolbarActions.search(ALBUM, {
        recordSubmissionBoundary() {
          submittedAt = performance.now();
          submittedEpochMs = Date.now();
        },
      });
      await searchToolbarActions.waitForQuery(ALBUM, { timeout: 120000 });
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
    await testInfo.attach('album-search-request-timing', {
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
    expect(view, 'Expected the album search runtime view.').toBeTruthy();
    expectPostgresLibraryBrowseTelemetry(view, 'full');
    expect(String(view.query || '').trim()).toBe(ALBUM);

    await albumTitleSearchLocalReport.recordTimingCheckpoint({
      key: 'album-title-search-visible',
      label: 'Exact album search to visible matching card',
      timingMs: albumVisibleMs,
      details: { album: ALBUM, browserProcessingMs, responseEndElapsedMs },
    });
    albumTitleSearchLocalReport.setMetricsPayload({ album: ALBUM });
    albumTitleSearchLocalReport.recordTerminalTimingOutcome(
      BUDGET.metricId,
      'albumVisibleMs',
      expectTimingBudget(
        expect.soft,
        albumVisibleMs,
        BUDGET,
        'Exact album search visible content',
      ),
    );
    albumTitleSearchLocalReport.recordContractCompletion();
  });
});
