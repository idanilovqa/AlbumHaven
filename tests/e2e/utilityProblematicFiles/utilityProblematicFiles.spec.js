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

  test('Problematic Files paints its bounded first page before the complete tree and keeps the filter icon stable', async ({
    galleryActions,
    page,
    settingsModalAppBarActions,
    utilityProblematicFilesActions,
  }) => {
    expect(process.env.PLAYWRIGHT_ISOLATED_LIBRARY_APP).toBe('1');
    expect(process.env.ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE).toBe('postgres');
    await galleryActions.goto('/');

    let completeResponseReceived = false;
    const trackCompleteResponse = (response) => {
      const url = new URL(response.url());
      if (url.pathname === SUMMARY_PATHNAME && !url.searchParams.has('limit')) {
        completeResponseReceived = true;
      }
    };
    page.on('response', trackCompleteResponse);

    try {
      await settingsModalAppBarActions.prepareToOpenSettings();
      const boundedResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === SUMMARY_PATHNAME && url.searchParams.has('limit');
      }, { timeout: 120000 });
      const openSettings = settingsModalAppBarActions.openSettings();
      await boundedResponse;
      await utilityProblematicFilesActions.waitForFirstVisible({ timeout: 120000 });
      await expect(page.locator('#utility-problematic-list [data-problematic-album-key]').first()).toBeVisible();
      expect(
        completeResponseReceived,
        'The bounded first page must paint before the complete background tree response arrives.',
      ).toBe(false);

      await openSettings;
      await utilityProblematicFilesActions.waitForReady({ timeout: 120000, requirePopulated: true });

      const filterButton = page.locator('#utility-problem-filter-button');
      const filterIcon = filterButton.locator('svg');
      const filterMenu = page.locator('#utility-problem-filter-menu');
      const baseline = await filterIcon.boundingBox();
      expect(baseline, 'Expected a measurable Problematic Files filter icon.').toBeTruthy();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await filterButton.click();
        await expect(filterMenu).toBeVisible();
        const openBox = await filterIcon.boundingBox();
        expect(openBox, 'Expected the filter icon to remain measurable while open.').toBeTruthy();
        for (const property of ['x', 'y', 'width', 'height']) {
          expect(
            Math.abs(openBox[property] - baseline[property]),
            `Opening Filters must not move or resize the SVG ${property}.`,
          ).toBeLessThanOrEqual(0.5);
        }
        await expect(filterButton).toHaveClass(/trigger-anchor-open/);
        await expect(filterMenu).toHaveClass(/trigger-anchor-surface/);
        await expect(filterButton).toHaveAttribute('data-trigger-anchor-edge', /^(top|bottom)$/);
        await expect(filterMenu).toHaveAttribute('data-trigger-anchor-edge', /^(top|bottom)$/);
        const edge = await filterButton.getAttribute('data-trigger-anchor-edge');
        expect(edge).toBe(await filterMenu.getAttribute('data-trigger-anchor-edge'));
        const buttonBox = await filterButton.boundingBox();
        const menuBox = await filterMenu.boundingBox();
        expect(buttonBox, 'Expected a measurable open filter trigger.').toBeTruthy();
        expect(menuBox, 'Expected a measurable open filter menu.').toBeTruthy();
        const connectedGap = edge === 'bottom'
          ? Math.abs((menuBox.y + menuBox.height) - buttonBox.y)
          : Math.abs(menuBox.y - (buttonBox.y + buttonBox.height));
        expect(connectedGap, 'The trigger and menu must retain a continuous connected edge.').toBeLessThanOrEqual(2);
        expect(buttonBox.x + buttonBox.width).toBeGreaterThanOrEqual(menuBox.x);
        expect(buttonBox.x).toBeLessThanOrEqual(menuBox.x + menuBox.width);

        await filterButton.click();
        await expect(filterMenu).toBeHidden();
        const closedBox = await filterIcon.boundingBox();
        expect(closedBox, 'Expected the filter icon to remain measurable after closing.').toBeTruthy();
        for (const property of ['x', 'y', 'width', 'height']) {
          expect(
            Math.abs(closedBox[property] - baseline[property]),
            `Closing Filters must restore the SVG ${property} without jitter.`,
          ).toBeLessThanOrEqual(0.5);
        }
      }
    } finally {
      page.off('response', trackCompleteResponse);
    }
  });
});
