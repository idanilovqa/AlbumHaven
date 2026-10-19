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
  }) => {
    test.setTimeout(180000);
    requirePostgresRuntimeEnv('the album-title search benchmark');

    await stepLogger.step('Open the production app and wait for root readiness', async () => {
      await galleryActions.goto('/');
      await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions);
    });

    let submittedAt = 0;
    const albumVisibleMs = await stepLogger.step('Search the exact album title and wait for its visible card', async () => {
      await searchToolbarActions.search(ALBUM, {
        recordSubmissionBoundary() {
          submittedAt = performance.now();
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

    const view = await readRuntimeView(page);
    expect(view, 'Expected the album search runtime view.').toBeTruthy();
    expectPostgresLibraryBrowseTelemetry(view, 'full');
    expect(String(view.query || '').trim()).toBe(ALBUM);

    await albumTitleSearchLocalReport.recordTimingCheckpoint({
      key: 'album-title-search-visible',
      label: 'Exact album search to visible matching card',
      timingMs: albumVisibleMs,
      details: { album: ALBUM },
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
