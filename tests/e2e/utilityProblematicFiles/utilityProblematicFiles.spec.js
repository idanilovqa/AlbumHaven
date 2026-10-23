import { assertCompactProblematicSummary } from '../helpers/problematicPayloadEvidence.js';
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
});
