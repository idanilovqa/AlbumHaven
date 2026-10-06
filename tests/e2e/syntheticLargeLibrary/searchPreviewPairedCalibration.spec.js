import { expect, test } from '../support/baseFixtures.js';
import { expectTimingBudget, performanceTimingBudget } from '../helpers/index.js';
const SEARCH_BROWSE_BUDGET = Object.freeze(performanceTimingBudget('search-preview.syntheticFirstVisibleMs'));

const CASE_ID = 'FTC-GALLERY-STARTUP-005U';
const SEARCHES = Object.freeze([
  { query: 'Devin', expectedArtist: 'Devin Townsend' },
  { query: 'Neal Morse', expectedArtist: 'Neal Morse' },
]);

test.describe(`${CASE_ID} synthetic paired search calibration`, () => {
  for (const scenario of SEARCHES) {
    test(`${scenario.query} submit to first expected album visible`, async ({
      galleryActions,
      page,
      searchToolbarActions,
    }, testInfo) => {
      await galleryActions.goto('/?surface=albums');
      await searchToolbarActions.waitForVisible({ timeout: 120000 });
      await galleryActions.waitForGalleryReady({ timeout: 120000 });

      const result = await galleryActions.measureSyntheticSearchPreviewFirstVisible(
        searchToolbarActions,
        scenario.query,
        { expectedArtist: scenario.expectedArtist, timeout: 120000 },
      );

      expect(result.directPreviewMatch, `${scenario.query} must be a direct search-preview match.`)
        .toBe(true);
      expect(result.generationAfter.requestGeneration)
        .toBeGreaterThan(result.generationBefore.requestGeneration);
      expect(result.generationAfter.renderGeneration)
        .toBeGreaterThan(result.generationBefore.renderGeneration);
      await testInfo.attach('synthetic-paired-search-metrics', {
        body: Buffer.from(JSON.stringify({
          caseId: CASE_ID,
          query: scenario.query,
          expectedArtist: scenario.expectedArtist,
          submitToFirstVisibleMs: result.elapsedMs,
        })),
        contentType: 'application/json',
      });
      await expect(page).not.toHaveURL(/\/login(?:\?|$)/u);
    });
  }
});
