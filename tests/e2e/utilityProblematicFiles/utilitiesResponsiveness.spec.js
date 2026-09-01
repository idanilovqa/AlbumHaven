import { expect, test } from '../support/performanceFixtures.js';

import {
  buildBenchmarkValidationPayload,
  evaluateProblematicFilesDatasetContract,
  evaluateUtilityProblematicFilesLocalBenchmark,
  evaluateTimingBudget,
  expectTimingBudgetOutcome,
  formatTimingBudgetOutcome,
  logBenchmarkTimingResults,
  expectPostgresLibraryBrowseTelemetry,
  measureActionTime,
  measureProblematicFilesSettingsOpenWithNetworkEvidence,
  summarizeProblematicFilesDiagnostics,
  UTILITY_PROBLEMATIC_FILES_LOCAL_BENCHMARK,
} from '../helpers/index.js';
import { requirePostgresRuntimeEnv } from '../helpers/realAppBenchmarkHelpers.js';

const PROBLEMATIC_CASE_ID = 'FTC-UTIL-PROBLEMS-009';
const PROBLEMATIC_FILES_PATHNAME = '/utilities/problematic-files';
const PROBLEMATIC_FILE_DETAIL_PATHNAME = '/utilities/problematic-files/detail';
const PROBLEMATIC_READY_EXPECTATION = UTILITY_PROBLEMATIC_FILES_LOCAL_BENCHMARK.expectations
  .find((expectation) => expectation.key === 'problematicReadyMs');

test.describe(`${PROBLEMATIC_CASE_ID} utility-problematic-files responsiveness`, () => {

  test(`${PROBLEMATIC_CASE_ID} immediate Problematic Files stays responsive while search and problem filters update the detail view`, async ({
    galleryActions,
    page,
    settingsModalAppBarActions,
    stepLogger,
    utilityProblematicFilesActions,
    utilityProblematicFilesLocalReport,
  }) => {
    requirePostgresRuntimeEnv('the Problematic Files benchmark');

    const {
      coldProblematicApiMs,
      problematicResponseBytes,
    } = await stepLogger.step('Measure the cold Problematic Files API response before app navigation', async () => {
      const coldRequestStartedAt = performance.now();
      const coldResponse = await page.goto(PROBLEMATIC_FILES_PATHNAME, {
        waitUntil: 'commit',
      });
      expect(coldResponse, 'Expected the cold Problematic Files navigation to return a response.').toBeTruthy();
      const coldResponseBody = await coldResponse.text();
      const requestDurationMs = performance.now() - coldRequestStartedAt;
      const responseBytes = new TextEncoder().encode(coldResponseBody).byteLength;

      expect(
        coldResponse.ok(),
        `Expected the cold Problematic Files API request to succeed; received HTTP ${coldResponse.status()}.`,
      ).toBe(true);
      let coldPayload = null;
      expect(() => {
        coldPayload = JSON.parse(coldResponseBody);
      }, 'Expected the cold Problematic Files API response body to contain valid JSON.').not.toThrow();
      expectPostgresLibraryBrowseTelemetry(coldPayload);
      expect(Array.isArray(coldPayload.items), 'Expected the cold Problematic Files payload to expose summary items.').toBe(true);
      expect(coldPayload.projection_cache_status, 'Expected the timed API request to rebuild the projection.').toBe('rebuilt');
      expect(
        evaluateProblematicFilesDatasetContract(
          coldPayload,
          UTILITY_PROBLEMATIC_FILES_LOCAL_BENCHMARK.datasetContract,
        ),
      ).toEqual([]);
      const coldFirstSummaryItem = coldPayload.items[0];
      const coldInitialDetail = coldPayload.initial_detail;
      expect(coldFirstSummaryItem, 'Expected the cold Problematic Files payload to remain populated.').toBeTruthy();
      expect(coldInitialDetail, 'Expected the cold Problematic Files payload to include explicit initial detail.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(coldInitialDetail);
      expect(coldInitialDetail.key).toBe(coldFirstSummaryItem.key);
      expect(coldInitialDetail.detail_loaded).toBe(true);

      await utilityProblematicFilesLocalReport.recordTimingCheckpoint({
        key: 'problematic-files-cold-api',
        label: 'Cold Problematic Files API response ready before app navigation',
        timingMs: requestDurationMs,
        details: {
          phase: 'cold_problematic_files_api',
          responseBytes,
        },
      });
      utilityProblematicFilesLocalReport.recordTextCheckpoint({
        key: 'problematic-files-response-bytes',
        label: 'Cold Problematic Files API response body size',
        valueText: `${responseBytes} bytes`,
      });
      return {
        coldProblematicApiMs: requestDurationMs,
        problematicResponseBytes: responseBytes,
      };
    });

    await galleryActions.goto();

    let problematicFilesPayload = null;
    let initialDetailRequestCount = 0;
    const problematicReadyMs = await stepLogger.step('Open Settings and wait for Problematic Files to become ready', async () => {
      const networkEvidence = await measureProblematicFilesSettingsOpenWithNetworkEvidence(
        page,
        settingsModalAppBarActions,
        utilityProblematicFilesActions,
        {
          timeout: 120000,
          summaryPathname: PROBLEMATIC_FILES_PATHNAME,
          detailPathname: PROBLEMATIC_FILE_DETAIL_PATHNAME,
        },
      );
      const timingMs = networkEvidence.readyMs;
      problematicFilesPayload = await networkEvidence.summaryResponse.json();
      initialDetailRequestCount = networkEvidence.detailRequestCount;
      await utilityProblematicFilesLocalReport.recordTimingCheckpoint({
        key: 'problematic-files-ready',
        label: 'Problematic Files ready after opening Settings',
        timingMs,
      });
      return timingMs;
    });
    const problematicReadyOutcome = evaluateTimingBudget(
      problematicReadyMs,
      PROBLEMATIC_READY_EXPECTATION,
    );
    utilityProblematicFilesLocalReport.recordTextCheckpoint({
      key: 'problematic-files-ready-contract',
      label: 'Problematic Files readiness contract',
      valueText: formatTimingBudgetOutcome('Problematic Files readiness', problematicReadyOutcome),
    });

    const problematicLoadDiagnostics = await stepLogger.step('Capture the Problematic Files summary and first-detail load diagnostics', async () => {
      const diagnostics = await utilityProblematicFilesActions.readLoadDiagnostics();
      utilityProblematicFilesLocalReport.recordTextCheckpoint({
        key: 'problematic-load-diagnostics',
        label: 'Problematic Files load diagnostics',
        valueText: summarizeProblematicFilesDiagnostics(diagnostics),
      });
      return diagnostics;
    });

    const initialSummary = await stepLogger.step('Verify the core Problematic Files layout and first detail state', async () => {
      expect(problematicFilesPayload, 'Expected a live Problematic Files response during the visible Settings flow.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(problematicFilesPayload);
      expect(problematicFilesPayload.projection_cache_status).toBe('hit');
      expect(
        evaluateProblematicFilesDatasetContract(
          problematicFilesPayload,
          UTILITY_PROBLEMATIC_FILES_LOCAL_BENCHMARK.datasetContract,
        ),
      ).toEqual([]);
      const firstSummaryItem = problematicFilesPayload.items[0];
      const initialDetail = problematicFilesPayload.initial_detail;
      expect(firstSummaryItem, 'Expected the live Postgres Problematic Files payload to stay populated.').toBeTruthy();
      expect(firstSummaryItem.detail_loaded, 'Expected summary items to remain compact.').toBe(false);
      expect(firstSummaryItem.track_problem_rows).toBeUndefined();
      expect(firstSummaryItem.repair_preview_rows).toBeUndefined();
      expect(firstSummaryItem.problematic_track_paths).toBeUndefined();
      expect(initialDetail, 'Expected the summary response to carry explicit first-album detail.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(initialDetail);
      expect(initialDetail.key, 'Expected explicit initial detail to match the first sorted summary item.').toBe(firstSummaryItem.key);
      expect(initialDetail.detail_loaded, 'Expected explicit initial detail to be complete.').toBe(true);
      expect(initialDetailRequestCount, 'Expected no redundant detail request during the initial utility-open flow.').toBe(0);
      await utilityProblematicFilesActions.expectCoreLayoutVisible();
      const visibleItems = await utilityProblematicFilesActions.readVisibleListItems();
      const visibleSeedItem = visibleItems.find((item) => item.key === String(initialDetail.key || ''));
      expect(
        visibleSeedItem,
        `Expected the controlled problematic-files snippet item "${initialDetail.key}" to render in the visible list.`,
      ).toBeTruthy();
      const summary = await utilityProblematicFilesActions.readSelectedDetailSummary();
      expect(summary.title, 'Expected the first Problematic Files detail title to match explicit initial detail.').toBe(initialDetail.name);
      expect(summary.problemReasons.length, 'Expected at least one visible detected-problem reason in detail.').toBeGreaterThan(0);
      return summary;
    });

    const problematicIdleMemory = await stepLogger.step('Sample idle memory after Problematic Files finishes loading', async () => (
      utilityProblematicFilesLocalReport.recordPeakMemoryCheckpoint({
        key: 'problematic-files-idle-memory',
        label: 'Problematic Files idle memory after initial load',
        details: {
          phase: 'problematic_files_ready',
        },
      })
    ));

    const searchToken = await stepLogger.step('Choose one representative search term from the current problematic rows', async () => {
      const token = await utilityProblematicFilesActions.readRepresentativeSearchToken();
      expect(token, 'Expected a representative Problematic Files search token.').not.toBe('');
      utilityProblematicFilesLocalReport.recordTextCheckpoint({
        key: 'problematic-search-token',
        label: 'Representative Problematic Files search token',
        valueText: token,
      });
      return token;
    });

    const searchReadyMs = await stepLogger.step('Search Problematic Files by the representative token', async () => {
      const timingMs = await measureActionTime(
        async () => {
          await utilityProblematicFilesActions.search(searchToken);
        },
        async () => {
          await utilityProblematicFilesActions.waitForSearchResults(searchToken, { timeout: 60000 });
        },
      );
      await utilityProblematicFilesLocalReport.recordTimingCheckpoint({
        key: 'problematic-search-ready',
        label: `Problematic Files search ready for "${searchToken}"`,
        timingMs,
      });
      return timingMs;
    });

    const searchResultItems = await stepLogger.step('Confirm the filtered Problematic Files search still shows selectable rows', async () => {
      const items = await utilityProblematicFilesActions.readVisibleListItems();
      expect(items.length, 'Expected at least one Problematic Files result after search.').toBeGreaterThan(0);
      return items;
    });

    await stepLogger.step('Clear the search before the problem-type review so each filter is measured against the full dataset', async () => {
      await utilityProblematicFilesActions.clearSearch();
      const restoredItems = await utilityProblematicFilesActions.readVisibleListItems();
      expect(restoredItems.length, 'Expected Problematic Files rows to return after clearing search.').toBeGreaterThanOrEqual(searchResultItems.length);
    });

    const problemTypes = await stepLogger.step('Read every available problem type filter from the full problematic dataset', async () => {
      const values = await utilityProblematicFilesActions.readProblemFilterValues();
      const normalizeStringSet = (items) => (
        [...new Set(items.map((item) => String(item).trim()).filter(Boolean))]
          .sort((left, right) => left.localeCompare(right))
      );
      expect(
        normalizeStringSet(values),
        'Expected the visible Problematic Files filters to match the isolated generated-data contract exactly.',
      ).toEqual(normalizeStringSet(
        UTILITY_PROBLEMATIC_FILES_LOCAL_BENCHMARK.datasetContract.expectedProblemTypes,
      ));
      utilityProblematicFilesLocalReport.recordTextCheckpoint({
        key: 'problem-filter-types',
        label: 'Problem type filters under test',
        valueText: values.join(' | '),
      });
      return values;
    });

    const perFilterTimings = [];
    await stepLogger.step('Apply every problem type filter and validate the right-side detail updates with the selected row', async () => {
      for (const [index, problemType] of problemTypes.entries()) {
        const filterTimingMs = await measureActionTime(
          async () => {
            await utilityProblematicFilesActions.applySingleProblemFilter(problemType);
          },
          async () => {},
        );
        perFilterTimings.push(filterTimingMs);
        await utilityProblematicFilesLocalReport.recordTimingCheckpoint({
          key: `problem-filter-${index + 1}`,
          label: `Problem filter "${problemType}" applied`,
          timingMs: filterTimingMs,
          details: {
            phase: 'problem_filter_review',
            problemType,
          },
        });

        const visibleItems = await utilityProblematicFilesActions.readVisibleListItems();
        expect(visibleItems.length, `Expected at least one row for problem filter "${problemType}".`).toBeGreaterThan(0);

        const firstExpected = visibleItems[0];
        await utilityProblematicFilesActions.selectListItemByIndex(0);
        const firstSummary = await utilityProblematicFilesActions.readSelectedDetailSummary();
        expect(firstSummary.title, 'Expected the selected Problematic Files detail title to render.').not.toBe('');
        expect(firstSummary.artist, 'Expected the Problematic Files detail artist line to render.').not.toBe('');
        expect(firstSummary.problemReasons.length, 'Expected the selected Problematic Files detail to show at least one problem reason.').toBeGreaterThan(0);

        if (visibleItems.length > 1) {
          await utilityProblematicFilesActions.selectListItemByIndex(1);
          const secondSummary = await utilityProblematicFilesActions.readSelectedDetailSummary();
          expect(secondSummary.title, 'Expected the Problematic Files detail title to update after changing rows.').not.toBe('');
          expect(secondSummary.artist, 'Expected the Problematic Files detail artist line to render after changing rows.').not.toBe('');
          expect(
            `${secondSummary.title}::${secondSummary.artist}`,
            'Expected the Problematic Files detail summary to change after selecting a different row.',
          ).not.toBe(`${firstSummary.title}::${firstSummary.artist}`);
        }

        await utilityProblematicFilesActions.clearProblemFilter(problemType);
      }
    });

    await stepLogger.step('Keep the original detail surface stable after the problem-type review', async () => {
      const restoredItems = await utilityProblematicFilesActions.readVisibleListItems();
      expect(restoredItems.length, 'Expected Problematic Files rows to remain visible after the problem-type review.').toBeGreaterThan(0);
    });

    const finalMemory = await stepLogger.step('Sample idle memory after the full Problematic Files review cycle', async () => (
      utilityProblematicFilesLocalReport.recordPeakMemoryCheckpoint({
        key: 'problematic-files-final-memory',
        label: 'Problematic Files idle memory after the search and filter review pass',
        details: {
          phase: 'problematic_files_complete',
        },
      })
    ));

    await stepLogger.step('Close Settings cleanly after the Problematic Files pass', async () => {
      await settingsModalAppBarActions.closeSettings();
    });

    const rawMetrics = {
      coldProblematicApiMs,
      problematicResponseBytes,
      problematicReadyMs,
      problematicReadyPerformanceStatus: problematicReadyOutcome.status,
      problematicReadyTargetMet: problematicReadyOutcome.targetMet,
      problematicReadyGraceUsed: problematicReadyOutcome.graceUsed,
      problematicIdleMemory,
      searchReadyMs,
      searchToken,
      searchResultCount: searchResultItems.length,
      problemFilterCount: problemTypes.length,
      longestProblemFilterMs: Math.max(0, ...perFilterTimings),
      problematicLoadDiagnostics,
      initialSummary,
      finalMemory,
    };

    const benchmarkEvaluation = evaluateUtilityProblematicFilesLocalBenchmark(rawMetrics);
    logBenchmarkTimingResults(benchmarkEvaluation);
    utilityProblematicFilesLocalReport.setMetricsPayload({
      ...rawMetrics,
      benchmarkValidation: buildBenchmarkValidationPayload(benchmarkEvaluation),
      benchmark: benchmarkEvaluation.benchmark,
      benchmarkResults: benchmarkEvaluation.results,
      benchmarkFailures: benchmarkEvaluation.failures,
    });
    expectTimingBudgetOutcome(
      expect,
      problematicReadyOutcome,
      'Problematic Files readiness',
    );
    expect(benchmarkEvaluation.failures, benchmarkEvaluation.failures.join('\n')).toEqual([]);
  });
});
