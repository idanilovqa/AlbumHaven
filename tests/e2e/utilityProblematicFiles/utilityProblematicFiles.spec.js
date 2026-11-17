import { assertCompactProblematicSummary } from '../helpers/problematicPayloadEvidence.js';
import { seedMusicBrainzCorrections } from '../helpers/musicbrainzCorrectionsFixture.js';
import { expect, test } from '../support/performanceFixtures.js';

import {
  expectPostgresLibraryBrowseTelemetry,
  evaluateTimingBudget,
  expectTimingBudgetOutcome,
  formatTimingBudgetOutcome,
  measureProblematicFilesSettingsOpenWithNetworkEvidence,
  partitionProblematicFilesRuntimeLogs,
  performanceTimingBudget,
  readCompletedResponseDurationMs,
  summarizeProblematicFilesDiagnostics,
} from '../helpers/index.js';

const CASE_ID = 'FTC-UTIL-PROBLEMS-010';
const READY_BUDGET = Object.freeze(performanceTimingBudget('problematic-files-focused.readyMs'));
const READY_TARGET_MS = READY_BUDGET.targetMaximum;
const READY_GRACE_MS = READY_BUDGET.graceMs;
const SUMMARY_PATHNAME = '/utilities/problematic-files';
const DETAIL_PATHNAME = '/utilities/problematic-files/detail';
const CORRECTION_PAGES_PATHNAME = '/api/musicbrainz/corrections/albums';
const DATA_CORRECTION_LABEL = 'Data Correction Needed';
// sandbox6's measured scale (2026-11-16): about 10,800 albums need a MusicBrainz data correction.
const CORRECTION_ALBUMS = 10800;

test.describe(`${CASE_ID} production-path utility problematic-files UI`, () => {

  test('Problematic Files renders populated Postgres summary and automatic detail', async ({
    galleryActions,
    page,
    problematicFilesFocusedLocalReport,
    settingsModalAppBarActions,
    stepLogger,
    testArtifacts,
    utilityProblematicFilesActions,
  }) => {
    expect(process.env.PLAYWRIGHT_ISOLATED_LIBRARY_APP).toBe('1');
    expect(process.env.ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE).toBe('postgres');

    await stepLogger.step('Open the isolated production app root', async () => {
      await galleryActions.goto('/');
    });

    const networkEvidence = await stepLogger.step('Open Settings and wait for Problematic Files automatic detail', async () => (
      measureProblematicFilesSettingsOpenWithNetworkEvidence(
        page,
        settingsModalAppBarActions,
        utilityProblematicFilesActions,
        {
          timeout: 120000,
          summaryPathname: SUMMARY_PATHNAME,
          detailPathname: DETAIL_PATHNAME,
          onFirstVisible: (elapsed) => problematicFilesFocusedLocalReport.recordTextCheckpoint({
            key: 'problematic-files-first-visible-observed',
            label: 'Problematic Files first visible populated detail (diagnostic)',
            valueText: `${elapsed} ms from the Settings click boundary`,
          }),
        },
      )
    ));
    const {
      coverPreemptionWindow,
      detailRequestCount,
      readyMs,
      firstVisibleMs,
      summaryResponse,
      viewPreemptionWindow,
    } = networkEvidence;
    expect(summaryResponse.ok()).toBe(true);
    const summary = await summaryResponse.json();
    assertCompactProblematicSummary(summary);
    assertCompactProblematicSummary(await networkEvidence.completeSummaryResponse.json());
    expect(networkEvidence.summaryRequestCount, 'One bounded summary and one complete summary only').toBe(2);
    const firstSummary = summary.items[0];
    const detail = summary.initial_detail;
    let readinessOutcome;

    await stepLogger.step('Verify populated list, automatic detail, telemetry, layout, and timing ceiling', async () => {
      expectPostgresLibraryBrowseTelemetry(summary);
      expectPostgresLibraryBrowseTelemetry(detail);
      expect(summary.items).toHaveLength(summary.count);
      expect(summary.items.length).toBeGreaterThanOrEqual(2);
      expect(firstSummary.key).toBe(detail.key);
      expect(firstSummary.detail_loaded).toBe(false);
      expect(firstSummary.track_problem_rows).toBeUndefined();
      expect(firstSummary.repair_preview_rows).toBeUndefined();
      expect(firstSummary.problematic_track_paths).toBeUndefined();
      expect(detail.detail_loaded).toBe(true);
      expect(detailRequestCount).toBe(0);
      await utilityProblematicFilesActions.expectCoreLayoutVisible({ requirePopulated: true });
      const activeItem = await utilityProblematicFilesActions.readActiveListItem();
      const detailSummary = await utilityProblematicFilesActions.readSelectedDetailSummary();
      expect(detail.key).toBe(activeItem.key);
      expect(detail.name).toBe(detailSummary.title);
      expect(activeItem.title).toBe(detailSummary.title);
      expect(activeItem.meta).toBe([detailSummary.artist, detail.year].filter(Boolean).join(' · '));
      readinessOutcome = evaluateTimingBudget(readyMs, READY_BUDGET);
      expect(await utilityProblematicFilesActions.readErrorToastCount()).toBe(0);
    });

    await problematicFilesFocusedLocalReport.recordTimingCheckpoint({
      key: 'problematic-files-focused-api',
      label: 'Problematic Files tab ready',
      timingMs: readyMs,
      details: {
        phase: 'focused_utility_problematic_files',
        firstVisibleMs,
        problematicItemCount: summary.items.length,
        firstSummaryDetailLoaded: firstSummary.detail_loaded,
        initialDetailKey: detail.key,
        detailRequestCount,
        readyTargetMs: READY_TARGET_MS,
        readyGraceMs: READY_GRACE_MS,
        readyHardCeilingMs: READY_TARGET_MS + READY_GRACE_MS,
        readinessGraceUsed: readinessOutcome.graceUsed,
        readinessPerformanceStatus: readinessOutcome.status,
        persistenceBackend: summary.persistence_backend,
        persistenceSeam: summary.persistence_seam,
        viewDataSource: summary.view_data_source,
      },
    });
    problematicFilesFocusedLocalReport.recordTextCheckpoint({
      key: 'problematic-files-first-visible',
      label: 'Problematic Files first visible populated detail (diagnostic)',
      valueText: `${firstVisibleMs} ms from the same Settings click boundary; full readiness ${readyMs} ms`,
    });
    problematicFilesFocusedLocalReport.recordTextCheckpoint({
      key: 'problematic-files-focused-readiness-contract',
      label: 'Problematic Files focused readiness contract',
      valueText: formatTimingBudgetOutcome(
        'Problematic Files populated detail readiness',
        readinessOutcome,
      ),
    });
    const loadDiagnostics = await utilityProblematicFilesActions.readLoadDiagnostics();
    problematicFilesFocusedLocalReport.recordTextCheckpoint({
      key: 'problematic-files-load-diagnostics',
      label: 'Problematic Files request, parse, state, and render timings',
      valueText: summarizeProblematicFilesDiagnostics(loadDiagnostics),
    });
    const focusedMetrics = {
      firstVisibleMs,
      boundedResponseMs: await readCompletedResponseDurationMs(summaryResponse),
      completeResponseMs: await readCompletedResponseDurationMs(networkEvidence.completeSummaryResponse),
      summaryRequestCount: networkEvidence.summaryRequestCount,
      loadDiagnostics,
      problematicFilesApiMs: readyMs,
      problematicItemCount: summary.items.length,
      firstSummaryDetailLoaded: firstSummary.detail_loaded,
      initialDetailKey: detail.key,
      detailRequestCount,
      readyTargetMs: READY_TARGET_MS,
      readyGraceMs: READY_GRACE_MS,
      readyHardCeilingMs: READY_TARGET_MS + READY_GRACE_MS,
      readinessGraceUsed: readinessOutcome.graceUsed,
      readinessPerformanceStatus: readinessOutcome.status,
      readinessTargetMet: readinessOutcome.targetMet,
      persistenceBackend: summary.persistence_backend,
      persistenceSeam: summary.persistence_seam,
      viewDataSource: summary.view_data_source,
    };
    problematicFilesFocusedLocalReport.setMetricsPayload(focusedMetrics);

    await stepLogger.step('Verify runtime failures are clean or authenticated intentional cover cancellations', async () => {
      const runtimePartition = partitionProblematicFilesRuntimeLogs(
        testArtifacts.getRuntimeLogs(),
        coverPreemptionWindow,
        viewPreemptionWindow,
      );
      expect(runtimePartition.unexpectedRuntimeErrors).toEqual([]);
    });
    problematicFilesFocusedLocalReport.setMetricsPayload({
      ...focusedMetrics,
      benchmarkValidation: {
        selectedContract: READY_BUDGET.contractName,
        functionalChecksComplete: true,
        nonTimingChecksComplete: true,
        expectedMetricIds: [READY_BUDGET.metricId],
        results: [{
          key: 'readyMs',
          metricId: READY_BUDGET.metricId,
          contractName: READY_BUDGET.contractName,
          units: 'ms',
          actual: readyMs,
          targetMaximum: READY_BUDGET.targetMaximum,
          graceMs: READY_BUDGET.graceMs,
          hardCeiling: READY_BUDGET.hardCeiling,
          allowedMaximum: READY_BUDGET.hardCeiling,
          performanceStatus: readinessOutcome.status,
          passed: readinessOutcome.passed,
        }],
      },
    });
    expectTimingBudgetOutcome(expect, readinessOutcome, 'Problematic Files populated detail readiness');
  });


  // MusicBrainz Delivery 2, S4: the same readiness budget with about 10,800 stored data
  // corrections. The first open after seeding is "cold" for the corrections (stored counts are
  // read on every request, never cached); the reload that follows is warm.
  // Only listed albums carry the label in the list response; correction-only albums arrive in
  // pages when the filter is chosen.
  test('Problematic Files stays ready with stored MusicBrainz data corrections', async ({
    galleryActions,
    page,
    problematicFilesFocusedLocalReport,
    settingsModalAppBarActions,
    stepLogger,
    utilityProblematicFilesActions,
  }) => {
    expect(process.env.PLAYWRIGHT_ISOLATED_LIBRARY_APP).toBe('1');
    const seeded = await stepLogger.step('Store about 10,800 synthetic data corrections in the isolated database', async () => (
      seedMusicBrainzCorrections({ listedAlbums: 300, syntheticAlbums: CORRECTION_ALBUMS - 300 })
    ));
    expect(seeded.albums).toBe(CORRECTION_ALBUMS);

    const open = async (label) => {
      await galleryActions.goto('/');
      return stepLogger.step(label, async () => measureProblematicFilesSettingsOpenWithNetworkEvidence(
        page, settingsModalAppBarActions, utilityProblematicFilesActions,
        { timeout: 120000, summaryPathname: SUMMARY_PATHNAME, detailPathname: DETAIL_PATHNAME },
      ));
    };
    const cold = await open('Open Problematic Files cold, with stored corrections');
    const complete = await cold.completeSummaryResponse.json();
    const completeBytes = (await cold.completeSummaryResponse.body()).length;
    assertCompactProblematicSummary(complete);
    expect(complete.musicbrainz_correction_album_count).toBe(CORRECTION_ALBUMS);
    expect(complete.items.some((item) => item.entity_kind === 'musicbrainz_correction'),
      'correction-only albums never travel in the list response').toBe(false);
    expect(complete.items.some((item) => (item.problem_reasons || []).includes(DATA_CORRECTION_LABEL)),
      'listed albums carry the label').toBe(true);
    await utilityProblematicFilesActions.expectCoreLayoutVisible({ requirePopulated: true });
    const coldOutcome = evaluateTimingBudget(cold.readyMs, READY_BUDGET);

    const warm = await open('Reload and open Problematic Files warm');
    const warmOutcome = evaluateTimingBudget(warm.readyMs, READY_BUDGET);

    const pageRequests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === CORRECTION_PAGES_PATHNAME) pageRequests.push(request.url());
    });
    const filterMs = await stepLogger.step('Choose Data Correction Needed until page 1 is visible', async () => {
      const startedAt = Date.now();
      await utilityProblematicFilesActions.applySingleProblemFilter(DATA_CORRECTION_LABEL);
      await page.locator('[data-problematic-album-key^="musicbrainz-correction:"]').first()
        .waitFor({ state: 'visible', timeout: 60000 });
      return Date.now() - startedAt;
    });
    const filterOutcome = evaluateTimingBudget(filterMs, READY_BUDGET);
    expect(pageRequests.map((url) => new URL(url).searchParams.get('offset')), 'page 1 only').toEqual(['0']);
    expect(await utilityProblematicFilesActions.readErrorToastCount()).toBe(0);

    const metrics = {
      correctionAlbums: seeded.albums,
      labelledFixtureAlbums: seeded.fixtureAlbums,
      coldReadyMs: cold.readyMs,
      warmReadyMs: warm.readyMs,
      filterPageOneVisibleMs: filterMs,
      completeResponseBytes: completeBytes,
      completeResponseItems: complete.items.length,
      correctionPageRequests: pageRequests.length,
      readyTargetMs: READY_TARGET_MS,
      readyGraceMs: READY_GRACE_MS,
      readyHardCeilingMs: READY_TARGET_MS + READY_GRACE_MS,
    };
    for (const [key, label, timingMs] of [
      ['problematic-files-corrections-cold', 'Problematic Files ready, cold, with 10,800 corrections', cold.readyMs],
      ['problematic-files-corrections-warm', 'Problematic Files ready, warm, with 10,800 corrections', warm.readyMs],
      ['problematic-files-corrections-filter', 'Data Correction Needed page 1 visible', filterMs],
    ]) {
      await problematicFilesFocusedLocalReport.recordTimingCheckpoint({ key, label, timingMs, details: metrics });
    }
    problematicFilesFocusedLocalReport.recordTextCheckpoint({
      key: 'problematic-files-corrections-response-size',
      label: 'Complete Problematic Files response with corrections stored',
      valueText: `${completeBytes} bytes, ${complete.items.length} rows`,
    });
    problematicFilesFocusedLocalReport.setMetricsPayload({
      ...metrics,
      benchmarkValidation: {
        selectedContract: READY_BUDGET.contractName,
        functionalChecksComplete: true,
        nonTimingChecksComplete: true,
        expectedMetricIds: [READY_BUDGET.metricId],
        results: [{
          key: 'readyMs', metricId: READY_BUDGET.metricId, contractName: READY_BUDGET.contractName, units: 'ms',
          actual: cold.readyMs, targetMaximum: READY_BUDGET.targetMaximum, graceMs: READY_BUDGET.graceMs,
          hardCeiling: READY_BUDGET.hardCeiling, allowedMaximum: READY_BUDGET.hardCeiling,
          performanceStatus: coldOutcome.status, passed: coldOutcome.passed,
        }],
      },
    });
    expectTimingBudgetOutcome(expect, coldOutcome, 'Problematic Files readiness, cold, with corrections');
    expectTimingBudgetOutcome(expect, warmOutcome, 'Problematic Files readiness, warm, with corrections');
    expectTimingBudgetOutcome(expect, filterOutcome, 'Data Correction Needed page 1 visible');
  });
});
