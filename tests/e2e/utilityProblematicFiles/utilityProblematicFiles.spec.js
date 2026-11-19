import { assertCompactProblematicSummary } from '../helpers/problematicPayloadEvidence.js';
import { expect, test } from '../support/performanceFixtures.js';
import { setProblematicCompleteListHeld } from '../helpers/coverLookupProviderHelpers.js';
import { createWatchedAlbumFixture } from '../helpers/libraryFilesystemWatcherFixture.js';
import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';
import { queryPersistedAlbumIdentity } from '../helpers/postgresAlbumIdentityHelpers.js';

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
  // The fixture library has no missing album, so the Missing Albums step owns one.
  let missingAlbumFixture = null;
  test.afterEach(async ({ context, managedAppLifecycle }) => {
    const fixture = missingAlbumFixture;
    missingAlbumFixture = null;
    if (fixture) await fixture.cleanup({ context, managedAppLifecycle });
  });


  test('Problematic Files renders populated Postgres summary and automatic detail', async ({
    context,
    galleryActions,
    managedAppLifecycle,
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
    let detailReadinessOutcome;
    let missingAlbumReadinessOutcome;

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

    await stepLogger.step('Measure a newly selected populated detail independently', async () => {
      const startedAt = performance.now();
      await utilityProblematicFilesActions.selectListItemByIndex(1);
      const selectedDetail = await utilityProblematicFilesActions.readSelectedDetailSummary();
      detailReadinessOutcome = evaluateTimingBudget(performance.now() - startedAt, READY_BUDGET);
      expect(selectedDetail.title, 'The selected PF detail must render its album title.').not.toBe('');
      expect(selectedDetail.artist, 'The selected PF detail must render its artist.').not.toBe('');
      expect(selectedDetail.problemReasons.length, 'The selected PF detail must render its problems.').toBeGreaterThan(0);
    });

    await stepLogger.step('Measure Missing Albums and keep its selected row stable', async () => {
      // Create a uniquely named album, let the watcher index it, then remove its folder so the
      // library keeps it as an explicit missing album. Timing starts only once it is listed.
      const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      missingAlbumFixture = await createWatchedAlbumFixture({
        artist: `PF Missing Artist ${token}`,
        album: `PF Missing Album ${token}`,
        year: 2003,
        trackTitles: ['PF Missing First', 'PF Missing Second'],
        ownedDirectoryName: 'problematic-files-missing-album',
        context,
        managedAppLifecycle,
      });
      const ownedAlbumReasons = async () => {
        const response = await authenticatedPageGet(
          page,
          `/utilities/problematic-files?q=${encodeURIComponent(`PF Missing Album ${token}`)}&limit=50`,
        );
        const payload = await response.json();
        return (payload.items || []).flatMap((item) => item.problem_reasons || []);
      };
      // The watcher must persist the album before its folder is removed.
      await expect.poll(async () => {
        const identity = await queryPersistedAlbumIdentity({
          artist: `PF Missing Artist ${token}`, album: `PF Missing Album ${token}`, year: 2003,
        });
        return identity.track_counts;
      }, {
        message: 'The watcher must index the owned album before it is removed.',
        timeout: 90000,
        intervals: [500, 1000, 2000],
      }).toEqual([2]);
      // A Main Library album: only New Arrivals removes an untouched deleted album by itself
      // (owner rule 2026-11-08, corrected 2026-11-18), so this one stays listed as "Album not found".
      missingAlbumFixture.deleteAlbum();
      await expect.poll(async () => ownedAlbumReasons(), {
        message: 'The server must report the removed owned album as Album not found.',
        timeout: 120000,
        intervals: [500, 1000, 2000],
      }).toContain('Album not found');
      await expect.poll(async () => utilityProblematicFilesActions.readProblemFilterValues(), {
        message: 'The removed owned album must be listed as Album not found.',
        timeout: 120000,
        intervals: [500, 1000, 2000],
      }).toContain('Album not found');
      const startedAt = performance.now();
      await utilityProblematicFilesActions.applySingleProblemFilter('Album not found');
      await expect(page.locator('#utility-problematic-list [data-problematic-album-key]').first()).toBeVisible();
      const missingSelection = await utilityProblematicFilesActions.selectListItemByIndex(0);
      const missingDetail = await utilityProblematicFilesActions.readSelectedDetailSummary();
      missingAlbumReadinessOutcome = evaluateTimingBudget(performance.now() - startedAt, READY_BUDGET);
      expect(missingDetail.problemReasons).toContain('Album not found');

      const activeBefore = await utilityProblematicFilesActions.readActiveListItem();
      expect(activeBefore.key).toBe(missingSelection.key);
      expect(activeBefore.title).toBe(missingDetail.title);
      await page.locator('#utility-problem-filter-button').click();
      await expect(page.locator('#utility-problem-filter-menu')).toBeVisible();
      await page.locator('#utility-problem-filter-button').click();
      await expect(page.locator('#utility-problem-filter-menu')).toBeHidden();
      expect(await utilityProblematicFilesActions.readActiveListItem()).toEqual(activeBefore);
      expect(
        (await utilityProblematicFilesActions.readVisibleListItems()).some((item) => item.key === activeBefore.key),
        'The selected missing-album row must remain in the list after its detail opens.',
      ).toBe(true);
      await utilityProblematicFilesActions.clearProblemFilter('Album not found');
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
      selectedDetailReadyMs: detailReadinessOutcome.actualMs,
      selectedDetailReadinessPerformanceStatus: detailReadinessOutcome.status,
      missingAlbumReadyMs: missingAlbumReadinessOutcome.actualMs,
      missingAlbumReadinessPerformanceStatus: missingAlbumReadinessOutcome.status,
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
    // Timing verdicts follow the retained metrics so a hard failure keeps its evidence.
    expectTimingBudgetOutcome(expect, readinessOutcome, 'Problematic Files populated detail readiness');
    expectTimingBudgetOutcome(expect, detailReadinessOutcome, 'Problematic Files selected detail readiness');
    expectTimingBudgetOutcome(expect, missingAlbumReadinessOutcome, 'Problematic Files Missing Albums readiness');
  });

  test('Problematic Files paints its bounded first page before the complete tree and keeps the filter icon stable', async ({
    galleryActions,
    page,
    settingsModalAppBarActions,
    utilityProblematicFilesActions,
  }, testInfo) => {
    expect(process.env.PLAYWRIGHT_ISOLATED_LIBRARY_APP).toBe('1');
    expect(process.env.ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE).toBe('postgres');
    await galleryActions.goto('/');
    // The earlier test leaves the complete list warm; holding it makes "bounded first" a
    // controlled precondition instead of a race the warm list always wins.
    await setProblematicCompleteListHeld(testInfo, true);

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
      const firstPageStartedAt = performance.now();
      const boundedResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === SUMMARY_PATHNAME && url.searchParams.has('limit');
      }, { timeout: 120000 });
      const openSettings = settingsModalAppBarActions.openSettings();
      await boundedResponse;
      await utilityProblematicFilesActions.waitForFirstVisible({ timeout: 120000 });
      const firstPageReadiness = evaluateTimingBudget(performance.now() - firstPageStartedAt, READY_BUDGET);
      await expect(page.locator('#utility-problematic-list [data-problematic-album-key]').first()).toBeVisible();
      expectTimingBudgetOutcome(expect, firstPageReadiness, 'Problematic Files first populated page readiness');
      expect(
        completeResponseReceived,
        'The bounded first page must paint before the complete background tree response arrives.',
      ).toBe(false);

      const earlyFilterButton = page.locator('#utility-problem-filter-button');
      const earlyFilterMenu = page.locator('#utility-problem-filter-menu');
      await earlyFilterButton.click();
      await expect(earlyFilterMenu).toBeVisible();
      expect(
        completeResponseReceived,
        'The filter must open from bounded metadata before the complete response arrives.',
      ).toBe(false);
      const earlyOptions = earlyFilterMenu.locator('[data-problem-filter-value]');
      expect(await earlyOptions.count(), 'The bounded response must provide multiple usable filter types.').toBeGreaterThanOrEqual(2);
      const boundedDetail = await utilityProblematicFilesActions.readSelectedDetailSummary();
      const normalizeReason = (reason) => {
        const value = String(reason || '').trim();
        if (value === 'Inconsistent year' || value.startsWith('Year mismatch')) return 'Year mismatch';
        return value.startsWith('Incomplete track order:') ? 'Incomplete track order' : value;
      };
      const boundedReasons = new Set(boundedDetail.problemReasons.map(normalizeReason));
      const earlyOptionValues = await earlyOptions.evaluateAll((options) => (
        options.map((option) => String(option.getAttribute('data-problem-filter-value') || ''))
      ));
      const retainedIndex = earlyOptionValues.findIndex((value) => boundedReasons.has(value));
      expect(retainedIndex, 'The bounded selected detail must expose one usable matching filter.').toBeGreaterThanOrEqual(0);
      const secondIndex = retainedIndex === 0 ? 1 : 0;
      const retainedOption = earlyOptions.nth(retainedIndex);
      const secondOption = earlyOptions.nth(secondIndex);
      await retainedOption.click();
      await expect(retainedOption).toHaveAttribute('aria-selected', 'true');
      await expect(earlyFilterMenu).toBeVisible();
      await secondOption.click();
      await expect(secondOption).toHaveAttribute('aria-selected', 'true');
      await expect(earlyFilterMenu).toBeVisible();
      await secondOption.click();
      await expect(secondOption).toHaveAttribute('aria-selected', 'false');
      await expect(retainedOption).toHaveAttribute('aria-selected', 'true');
      await expect(earlyFilterMenu).toBeVisible();
      await earlyFilterButton.click();
      await expect(earlyFilterMenu).toBeHidden();
      const activeBeforeComplete = await utilityProblematicFilesActions.readActiveListItem();
      await setProblematicCompleteListHeld(testInfo, false);

      await openSettings;
      await utilityProblematicFilesActions.waitForReady({ timeout: 120000, requirePopulated: true });
      expect(await utilityProblematicFilesActions.readActiveListItem()).toEqual(activeBeforeComplete);
      expect(
        (await utilityProblematicFilesActions.readVisibleListItems())
          .some((item) => item.key === activeBeforeComplete.key),
        'The bounded selected row must remain visible when complete PF work settles.',
      ).toBe(true);
      await earlyFilterButton.click();
      await expect(earlyFilterMenu).toBeVisible();
      const settledOptions = earlyFilterMenu.locator('[data-problem-filter-value]');
      const settledOptionValues = await settledOptions.evaluateAll((options) => (
        options.map((option) => String(option.getAttribute('data-problem-filter-value') || ''))
      ));
      expect(settledOptionValues.length).toBeGreaterThanOrEqual(earlyOptionValues.length);
      const settledRetainedIndex = settledOptionValues.indexOf(earlyOptionValues[retainedIndex]);
      expect(settledRetainedIndex).toBeGreaterThanOrEqual(0);
      const settledRetainedOption = settledOptions.nth(settledRetainedIndex);
      await expect(settledRetainedOption).toHaveAttribute('aria-selected', 'true');
      await settledRetainedOption.click();
      await expect(settledRetainedOption).toHaveAttribute('aria-selected', 'false');
      await earlyFilterButton.click();
      await expect(earlyFilterMenu).toBeHidden();

      const filterButton = page.locator('#utility-problem-filter-button');
      const filterControl = filterButton.locator(
        'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " search-field-control ")][1]',
      );
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
        await expect(filterControl).not.toHaveClass(/trigger-anchor-open/);
        await expect(filterMenu).toHaveClass(/trigger-anchor-surface/);
        await expect(filterButton).toHaveAttribute('data-trigger-anchor-edge', /^(top|bottom)$/);
        await expect(filterMenu).toHaveAttribute('data-trigger-anchor-edge', /^(top|bottom)$/);
        const edge = await filterButton.getAttribute('data-trigger-anchor-edge');
        expect(edge).toBe(await filterMenu.getAttribute('data-trigger-anchor-edge'));
        const anchorBox = await filterButton.boundingBox();
        const menuBox = await filterMenu.boundingBox();
        expect(anchorBox, 'Expected a measurable open filter anchor.').toBeTruthy();
        expect(menuBox, 'Expected a measurable open filter menu.').toBeTruthy();
        const connectedGap = edge === 'bottom'
          ? Math.abs((menuBox.y + menuBox.height) - anchorBox.y)
          : Math.abs(menuBox.y - (anchorBox.y + anchorBox.height));
        expect(connectedGap, 'The trigger and menu must retain a continuous connected edge.').toBeLessThanOrEqual(2);
        expect(anchorBox.x + anchorBox.width).toBeGreaterThanOrEqual(menuBox.x);
        expect(anchorBox.x).toBeLessThanOrEqual(menuBox.x + menuBox.width);

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
      await setProblematicCompleteListHeld(testInfo, false);
    }
  });
});
