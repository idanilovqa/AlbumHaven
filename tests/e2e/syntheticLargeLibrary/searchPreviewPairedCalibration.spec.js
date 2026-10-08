import { expect, test } from '../support/performanceFixtures.js';
import { evaluateTimingBudget, expectTimingBudgetOutcome, performanceTimingBudget } from '../helpers/index.js';
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
      performanceReport,
      searchToolbarActions,
      syntheticSearchInventory,
    }, testInfo) => {
      await galleryActions.goto('/?surface=albums');
      await searchToolbarActions.waitForVisible({ timeout: 120000 });
      await galleryActions.waitForGalleryReady({ timeout: 120000 });

      const result = await galleryActions.measureSyntheticSearchFirstVisible(
        searchToolbarActions,
        scenario.query,
        {
          expectedArtist: scenario.expectedArtist,
          expectedAlbumKeys: syntheticSearchInventory[scenario.query],
          timeout: 120000,
        },
      );

      expect(result.directSearchMatch, `${scenario.query} must be a direct search match.`)
        .toBe(true);
      expect(result.generationAfter.requestGeneration)
        .toBeGreaterThan(result.generationBefore.requestGeneration);
      expect(result.generationAfter.renderGeneration)
        .toBeGreaterThan(result.generationBefore.renderGeneration);
      await expect(page).not.toHaveURL(/\/login(?:\?|$)/u);
      const outcome = evaluateTimingBudget(result.elapsedMs, SEARCH_BROWSE_BUDGET);
      performanceReport.publishRun({
        reportId: 'pairedSearchCalibrationLocal',
        caseId: CASE_ID,
        title: `${scenario.query} paired search calibration`,
        rawMetrics: {
          benchmarkValidation: {
            selectedContract: outcome.contractName,
            functionalChecksComplete: true,
            nonTimingChecksComplete: true,
            expectedMetricIds: [outcome.metricId],
            results: [{
              key: scenario.query,
              metricId: outcome.metricId,
              contractName: outcome.contractName,
              units: 'ms',
              actual: outcome.actualMs,
              targetMaximum: outcome.targetMaximum,
              graceMs: outcome.graceMs,
              hardCeiling: outcome.hardCeiling,
              allowedMaximum: outcome.hardCeiling,
              performanceStatus: outcome.status,
              passed: outcome.passed,
            }],
          },
        },
      });
      await testInfo.attach('synthetic-paired-search-metrics', {
        body: Buffer.from(JSON.stringify({
          caseId: CASE_ID,
          query: scenario.query,
          expectedArtist: scenario.expectedArtist,
          submitToFirstVisibleMs: result.elapsedMs,
        })),
        contentType: 'application/json',
      });
      expectTimingBudgetOutcome(expect, outcome,
        `${scenario.query} submit to first expected album visible`);
    });
  }
});
