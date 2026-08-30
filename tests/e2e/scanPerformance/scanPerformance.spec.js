import { expect, test } from '../support/performanceFixtures.js';

import {
  buildScanSampleMetrics,
  buildFolderMilestoneText,
  expectBackgroundBrowseContinuity,
  expectTimingBudget,
  expectTerminalScanStatus,
  measureActionTime,
  performanceTimingBudget,
  SCAN_FIXTURE,
  waitForScanDrivenGalleryReady,
  waitForStatusCoverScan,
  waitForStatusDiscovery,
  waitForStatusIdle,
  waitForStatusScanStart,
} from '../helpers/index.js';

const COLD_CASE_ID = 'FTC-OPS-014';
const CACHED_CASE_ID = 'FTC-OPS-015';
const ADD_ALBUM_CASE_ID = 'FTC-OPS-016';
const METADATA_CASE_ID = 'FTC-OPS-017';
const SCAN_PAGE_CASE_ID = 'FTC-OPS-003C';
const SCAN_CANCEL_CASE_ID = 'FTC-OPS-003E';
const SCAN_CACHED_BUDGET = Object.freeze(
  performanceTimingBudget('scan-cached.startupReadyMs'),
);
const SCAN_ADD_ALBUM_BUDGET = Object.freeze(
  performanceTimingBudget('scan-add-album.uiUpdatedMs'),
);
const SCAN_METADATA_SEARCH_BUDGET = Object.freeze(
  performanceTimingBudget('scan-metadata.searchReadyMs'),
);
const METADATA_ARTIST_NAME = 'Scan Artist 001';
const BACKGROUND_BROWSE_ARTIST_NAME = 'Scan Artist 002';
const BACKGROUND_BROWSE_QUERY = 'Scan Artist 00';
const BACKGROUND_BROWSE_ARTIST_NAMES = Object.freeze([
  'Scan Artist 001',
  'Scan Artist 002',
  'Scan Artist 003',
  'Scan Artist 004',
  'Scan Artist 005',
  'Scan Artist 006',
  'Scan Artist 007',
  'Scan Artist 008',
  'Scan Artist 009',
]);
const ORIGINAL_METADATA_ALBUM_NAME = 'Album 001';
const STRICT_ONE_SECOND_BUDGET = Object.freeze(performanceTimingBudget('scan-interaction.responseMs'));

test.describe('isolated scan performance benchmarks', () => {
  test(`${COLD_CASE_ID} cold isolated scan captures loader, browse, and folder-threshold timings`, async ({
    appBarActions,
    galleryActions,
    navigationPanelActions,
    scanColdLocalReport,
    scanStatusSampler,
    scanPageActions,
    stepLogger,
  }, testInfo) => {
    const coldStartAt = Date.now();
    const statusSampler = scanStatusSampler;
    await statusSampler.start();
    const discoveryVisiblePromise = (async () => {
      const discovery = await waitForStatusDiscovery(statusSampler, { timeoutMs: 60000 });
      return Math.max(0, Number(discovery.recordedAtEpochMs || 0) - coldStartAt);
    })();
    const loaderVisibleMs = await stepLogger.step('Open the isolated app with no cache and wait for the scan loader', async () => {
      await galleryActions.goto();
      await appBarActions.waitForVisible({ timeout: 60000 });
      await waitForStatusScanStart(statusSampler, { timeoutMs: 30000 });
      await scanPageActions.waitForVisible({ timeout: 60000 });
      return Date.now() - coldStartAt;
    });
    await scanColdLocalReport.recordTimingCheckpoint({
      key: 'loader-visible',
      label: 'Cold scan loader visible',
      timingMs: loaderVisibleMs,
    });

    const discoveryVisibleMs = await stepLogger.step('Wait for launch-time discovery progress to be recorded', async () => {
      return discoveryVisiblePromise;
    });
    await scanColdLocalReport.recordTimingCheckpoint({
      key: 'discovery-visible',
      label: 'Scan discovery progress visible',
      timingMs: discoveryVisibleMs,
    });

    const indexingVisibleMs = await stepLogger.step('Wait for indexing progress to begin', async () => {
      await scanPageActions.waitForIndexingVisible({ timeout: 60000 });
      return Date.now() - coldStartAt;
    });
    await scanColdLocalReport.recordTimingCheckpoint({
      key: 'indexing-visible',
      label: 'Scan indexing progress visible',
      timingMs: indexingVisibleMs,
    });

    const elapsedTimerStartedMs = await stepLogger.step('Wait for the elapsed timer to start counting on the scan page', async () => {
      await scanPageActions.waitForElapsedTimer({ timeout: 60000 });
      return Date.now() - coldStartAt;
    });
    await scanColdLocalReport.recordTimingCheckpoint({
      key: 'elapsed-timer-started',
      label: 'Scan elapsed timer started',
      timingMs: elapsedTimerStartedMs,
    });

    await stepLogger.step('Explicitly open the Scan Page before browsing partial scan results', async () => {
      await appBarActions.openStatusMenu();
      await appBarActions.waitForScanActionLabel('Go to Scan Page');
      await appBarActions.goToScanPage({ menuAlreadyOpen: true });
      await scanPageActions.waitForDedicatedPageVisible({ timeout: 60000 });
      await scanPageActions.expectBrowseContextCleared();
    });

    const browseReadyMs = await stepLogger.step('Wait for enough partial results to expose the browse-during-scan button', async () => {
      await scanPageActions.waitForBrowseButton({ timeout: 120000 });
      return Date.now() - coldStartAt;
    });
    await scanColdLocalReport.recordTimingCheckpoint({
      key: 'browse-button-visible',
      label: 'Browse scanned library button visible during active scan',
      timingMs: browseReadyMs,
    });

    const browseLoadMs = await stepLogger.step('Use Browse Library and wait for the partial gallery plus visible covers', async () => (
      measureActionTime(
        async () => {
          await scanPageActions.clickBrowseScannedLibrary();
        },
        async () => {
          await waitForScanDrivenGalleryReady({
            galleryActions,
            navigationPanelActions,
            minimumVisibleCoverCount: 8,
          });
          await scanPageActions.waitForDedicatedPageHidden({ timeout: 60000 });
        },
      )
    ));
    await scanColdLocalReport.recordTimingCheckpoint({
      key: 'browse-partial-gallery-ready',
      label: 'Partial browse gallery ready during active scan',
      timingMs: browseLoadMs,
    });
    await stepLogger.step('Sample browse idle memory after the partial gallery settles', async () => {
      await scanColdLocalReport.recordPeakMemoryCheckpoint({
        key: 'browse-idle-memory',
        label: 'Partial browse idle memory during active scan',
        details: {
          phase: 'browse_during_scan',
        },
      });
    });

    const initialAllArtistsCount = await stepLogger.step('Read the first visible All artists count after partial browse', async () => (
      navigationPanelActions.readAllArtistsVisibleCount()
    ));
    scanColdLocalReport.recordTextCheckpoint({
      key: 'all-artists-initial-count',
      label: 'Initial All artists count after partial browse',
      valueText: String(initialAllArtistsCount),
    });

    const statusAfterBrowse = await waitForStatusScanStart(statusSampler, { timeoutMs: 30000 });
    expect(Boolean(statusAfterBrowse.scan_in_progress || statusAfterBrowse.relations_in_progress)).toBe(true);
    scanColdLocalReport.recordTextCheckpoint({
      key: 'scan-state-after-browse',
      label: 'Scan state immediately after the first browse-during-scan load',
      valueText: 'active',
    });

    const scanPageReturnMs = await stepLogger.step('Use the app-bar status menu to return to the scan page while the job is still active', async () => (
        measureActionTime(
          async () => {
            await appBarActions.openStatusMenu();
            await appBarActions.waitForScanActionLabel('Go to Scan Page', { timeout: 30000 });
            await appBarActions.goToScanPage({ menuAlreadyOpen: true });
          },
          async () => {
            await scanPageActions.waitForVisible({ timeout: 30000 });
          },
        )
      ));
    const returnSnapshot = await scanPageActions.readSnapshot();
    await scanColdLocalReport.recordTimingCheckpoint({
        key: 'scan-page-return-visible',
        label: 'Returned to scan page during active scan',
        timingMs: scanPageReturnMs,
      });
    scanColdLocalReport.recordTextCheckpoint({
        key: 'scan-page-return-snapshot',
        label: 'Scan page snapshot after returning from browse',
        valueText: `${returnSnapshot.title} | ${returnSnapshot.status}`,
      });

    const backObservation = await scanPageActions.startGalleryExitObservation();
    const activeScanBackMs = await stepLogger.step(
      'Use Back during the active scan and immediately restore a complete top gallery',
      async () => measureActionTime(
        async () => scanPageActions.clickBack(),
        async () => {
          await waitForScanDrivenGalleryReady({
            galleryActions,
            navigationPanelActions,
            minimumVisibleCoverCount: 8,
          });
          await scanPageActions.waitForDedicatedPageHidden({ timeout: 60000 });
        },
      ),
    );
    const activeScanBackExit = await scanPageActions.finishGalleryExitObservation(backObservation, {
      attachmentName: 'temporary-active-scan-back-gallery-exit-diagnostics',
      testInfo,
    });
    scanColdLocalReport.recordTerminalTimingOutcome('scan-cold.activeBackStableMs', 'activeBackStableMs', expectTimingBudget(
      expect.soft,
      activeScanBackExit.firstReadyMs,
      STRICT_ONE_SECOND_BUDGET,
      'Active-scan Back to stable top gallery',
    ));
    scanColdLocalReport.recordTerminalTimingOutcome('scan-cold.activeBackReadyMs', 'activeBackReadyMs', expectTimingBudget(
      expect.soft,
      activeScanBackMs,
      STRICT_ONE_SECOND_BUDGET,
      'Active-scan Back gallery readiness',
    ));

    await stepLogger.step('Reopen Scan Page while the cold scan remains active', async () => {
      await appBarActions.openStatusMenu();
      await appBarActions.waitForScanActionLabel('Go to Scan Page', { timeout: 30000 });
      await appBarActions.goToScanPage({ menuAlreadyOpen: true });
      await scanPageActions.waitForDedicatedPageVisible({ timeout: 30000 });
    });

    const resumeBrowseObservation = await scanPageActions.startGalleryExitObservation();
    const resumeBrowseMs = await stepLogger.step('Resume browse from the scan page and wait for the partial gallery to settle again', async () => (
        measureActionTime(
          async () => {
            await scanPageActions.clickBrowseScannedLibrary();
          },
          async () => {
            await waitForScanDrivenGalleryReady({
              galleryActions,
              navigationPanelActions,
              minimumVisibleCoverCount: 8,
            });
            await scanPageActions.waitForDedicatedPageHidden({ timeout: 60000 });
          },
        )
      ));
    const resumeBrowseExit = await stepLogger.step(
      'Keep the resumed active-scan gallery complete and pinned to the top',
      async () => scanPageActions.finishGalleryExitObservation(resumeBrowseObservation, {
        attachmentName: 'temporary-resume-browse-gallery-exit-diagnostics',
        testInfo,
      }),
    );
    scanColdLocalReport.recordTerminalTimingOutcome('scan-cold.resumeBrowseStableMs', 'resumeBrowseStableMs', expectTimingBudget(
      expect.soft,
      resumeBrowseExit.firstReadyMs,
      STRICT_ONE_SECOND_BUDGET,
      'Repeated active-scan Browse to stable top gallery',
    ));
    scanColdLocalReport.recordTerminalTimingOutcome('scan-cold.resumeBrowseReadyMs', 'resumeBrowseReadyMs', expectTimingBudget(
      expect.soft,
      resumeBrowseMs,
      STRICT_ONE_SECOND_BUDGET,
      'Repeated active-scan Browse gallery readiness',
    ));
    await scanColdLocalReport.recordTimingCheckpoint({
        key: 'scan-page-browse-resume-ready',
        label: 'Returned from scan page back into partial browse',
        timingMs: resumeBrowseMs,
      });

    const liveCountGrowthMs = await stepLogger.step('Wait for the live All artists count to increase while the scan keeps running', async () => (
        measureActionTime(
          async () => {},
          async () => {
            await navigationPanelActions.waitForAllArtistsVisibleCountGreaterThan(initialAllArtistsCount, { timeout: 60000 });
          },
        )
      ));
    const grownAllArtistsCount = await navigationPanelActions.readAllArtistsVisibleCount();
    await scanColdLocalReport.recordTimingCheckpoint({
        key: 'all-artists-live-count-growth',
        label: 'All artists count increased while scan was still active',
        timingMs: liveCountGrowthMs,
        details: {
          before: initialAllArtistsCount,
          after: grownAllArtistsCount,
        },
      });

    const selectedArtistName = await stepLogger.step('Select one visible artist from the partial browse tree', async () => (
      navigationPanelActions.selectSidebarArtistAt(2)
    ));
    const selectedArtistReadyMs = await stepLogger.step('Wait for the selected artist gallery to become ready', async () => (
      measureActionTime(
        async () => {},
        async () => {
          await navigationPanelActions.waitForSidebarSelection(selectedArtistName, { timeout: 60000 });
          await galleryActions.waitForSelectedArtistGallery(selectedArtistName, {
            timeout: 60000,
            requireExclusiveView: true,
          });
          await galleryActions.waitForVisibleGalleryCoversLoaded({ minimumCount: 1, timeout: 60000 });
        },
      )
    ));
    await scanColdLocalReport.recordTimingCheckpoint({
      key: 'selected-artist-gallery-ready',
      label: `Partial browse selected artist "${selectedArtistName}" ready`,
      timingMs: selectedArtistReadyMs,
    });

    const allArtistsReturnMs = await stepLogger.step('Return to All artists and wait for the partial gallery to settle again', async () => (
      measureActionTime(
        async () => {
          await navigationPanelActions.clickAllArtists({ expectArtistQueryCleared: true, timeout: 60000 });
        },
        async () => {
          await galleryActions.waitForAllArtistsStructure({ timeout: 60000 });
          await galleryActions.waitForVisibleGalleryCoversLoaded({ minimumCount: 1, timeout: 60000 });
        },
      )
    ));
    await scanColdLocalReport.recordTimingCheckpoint({
      key: 'all-artists-return-ready',
      label: 'Returned to All artists during active scan',
      timingMs: allArtistsReturnMs,
    });

    await stepLogger.step('Sample idle memory after the selected-artist round-trip', async () => {
      await scanColdLocalReport.recordPeakMemoryCheckpoint({
        key: 'post-round-trip-memory',
        label: 'Partial browse round-trip idle memory',
        details: {
          phase: 'partial_round_trip',
        },
      });
    });

    let terminalStatus;
    let terminalArtistCount = 0;
    await stepLogger.step('Wait for the cold scan and any relation work to finish', async () => {
      terminalStatus = await waitForStatusIdle(statusSampler, { timeoutMs: 120000, requireScanStart: true, scanStartObserved: true });
      await galleryActions.goto();
      await waitForScanDrivenGalleryReady({
        galleryActions,
        navigationPanelActions,
        sidebarHydration: 'full',
      });
      terminalArtistCount = await navigationPanelActions.readAllArtistsVisibleCount();
    });
    await statusSampler.stop();

    const metricsPayload = await stepLogger.step('Fetch server-side scan samples and derive milestone timings', async () => {
      const harnessMetrics = await statusSampler.snapshot();
      const launchStartedAt = Number(harnessMetrics.samples[0]?.recordedAtEpochMs || coldStartAt);
      const sampleMetrics = buildScanSampleMetrics(harnessMetrics.samples, launchStartedAt);
      await scanColdLocalReport.recordTimingCheckpoint({
        key: 'folders-100-threshold',
        label: 'Server sample reached 100 album folders',
        timingMs: sampleMetrics.folders100Ms,
      });
      await scanColdLocalReport.recordTimingCheckpoint({
        key: 'folders-300-threshold',
        label: 'Server sample reached 300 album folders',
        timingMs: sampleMetrics.folders300Ms,
      });
      await scanColdLocalReport.recordTimingCheckpoint({
        key: 'folders-500-threshold',
        label: 'Server sample reached 500 album folders',
        timingMs: sampleMetrics.folders500Ms,
      });
      await scanColdLocalReport.recordTimingCheckpoint({
        key: 'scan-complete',
        label: 'Cold scan completion threshold',
        timingMs: sampleMetrics.scanCompletedMs,
      });
      scanColdLocalReport.recordTextCheckpoint({
        key: 'folders-100-speed',
        label: '100-folder throughput snapshot',
        valueText: buildFolderMilestoneText(sampleMetrics, 100),
      });
      scanColdLocalReport.recordTextCheckpoint({
        key: 'folders-300-speed',
        label: '300-folder throughput snapshot',
        valueText: buildFolderMilestoneText(sampleMetrics, 300),
      });
      scanColdLocalReport.recordTextCheckpoint({
        key: 'folders-500-speed',
        label: '500-folder throughput snapshot',
        valueText: buildFolderMilestoneText(sampleMetrics, 500),
      });
      return {
        sampleMetrics,
        harnessMetrics,
        loaderVisibleMs,
        discoveryVisibleMs,
        indexingVisibleMs,
        elapsedTimerStartedMs,
        browseReadyMs,
        browseLoadMs,
        liveCountGrowthMs,
        selectedArtistName,
        selectedArtistReadyMs,
        allArtistsReturnMs,
        scanPageReturnMs,
        returnSnapshot,
        initialAllArtistsCount,
        grownAllArtistsCount,
      };
    });

    scanColdLocalReport.setMetricsPayload(metricsPayload);

    expect(metricsPayload.sampleMetrics.scanStartSample).not.toBeNull();
    expect(metricsPayload.sampleMetrics.discoverySample).not.toBeNull();
    expect(metricsPayload.sampleMetrics.indexingSample).not.toBeNull();
    expect(metricsPayload.sampleMetrics.elapsedTimerSample).not.toBeNull();
    expect(metricsPayload.sampleMetrics.scanStartMs).toBeGreaterThanOrEqual(0);
    expect(metricsPayload.sampleMetrics.discoveryVisibleMs).toBeGreaterThanOrEqual(0);
    expect(metricsPayload.sampleMetrics.indexingVisibleMs).toBeGreaterThanOrEqual(0);
    expect(metricsPayload.sampleMetrics.elapsedTimerStartedMs).toBeGreaterThanOrEqual(0);
    expect(metricsPayload.loaderVisibleMs).toBeGreaterThan(0);
    expect(metricsPayload.discoveryVisibleMs).toBeGreaterThanOrEqual(0);
    expect(metricsPayload.indexingVisibleMs).toBeGreaterThan(0);
    expect(metricsPayload.elapsedTimerStartedMs).toBeGreaterThan(0);
    expect(metricsPayload.browseLoadMs).toBeGreaterThan(0);
    expect(metricsPayload.sampleMetrics.folders100Ms).toBeGreaterThan(0);
    expect(metricsPayload.sampleMetrics.folders300Ms).toBeGreaterThan(metricsPayload.sampleMetrics.folders100Ms);
    expect(metricsPayload.sampleMetrics.folders500Ms).toBeGreaterThan(metricsPayload.sampleMetrics.folders300Ms);
    expect(metricsPayload.grownAllArtistsCount).toBeGreaterThan(metricsPayload.initialAllArtistsCount);
    expect(returnSnapshot.title.toLowerCase()).toContain('scanning');
    expectTerminalScanStatus(terminalStatus, SCAN_FIXTURE.albumCount);
    expect(terminalArtistCount).toBe(SCAN_FIXTURE.artistCount);
    scanColdLocalReport.recordContractCompletion();
  });

  test(`${CACHED_CASE_ID} unchanged isolated cached startup stays effectively idle`, async ({
    appBarActions,
    galleryActions,
    navigationPanelActions,
    scanCachedLocalReport,
    scanStatusSampler,
    scanPageActions,
    stepLogger,
  }) => {
    const statusSampler = scanStatusSampler;
    await statusSampler.start();

    let cachedTerminalStatus;
    let cachedArtistCount = 0;
    const startupReadyMs = await stepLogger.step('Reload from the isolated cache and wait for browse-ready startup', async () => {
      const startedAt = Date.now();
      await galleryActions.goto();
      await appBarActions.waitForVisible({ timeout: 60000 });
      await scanPageActions.waitForHidden({ timeout: 60000 });
      await waitForScanDrivenGalleryReady({
        galleryActions,
        navigationPanelActions,
        sidebarHydration: 'full',
      });
      cachedTerminalStatus = await waitForStatusIdle(statusSampler, { timeoutMs: 30000 });
      expect(cachedTerminalStatus.scan_in_progress).toBe(false);
      expect(cachedTerminalStatus.relations_in_progress).toBe(false);
      cachedArtistCount = await navigationPanelActions.readAllArtistsVisibleCount();
      return Date.now() - startedAt;
    });
    await scanCachedLocalReport.recordTimingCheckpoint({
      key: 'cached-startup-ready',
      label: 'Cached isolated startup ready',
      timingMs: startupReadyMs,
    });

    await stepLogger.step('Sample idle memory after unchanged cached startup', async () => {
      await scanCachedLocalReport.recordPeakMemoryCheckpoint({
        key: 'cached-startup-memory',
        label: 'Cached startup idle memory',
      });
    });

    await statusSampler.stop();
    const harnessMetrics = await statusSampler.snapshot();
    const visibleScanTriggered = harnessMetrics.samples.some((sample) => sample.scanInProgress || sample.relationsInProgress);
    const historicalLastScanDisplay = String(cachedTerminalStatus.last_scan_display || '');
    const hasExpectedHistoricalYear = SCAN_FIXTURE.cachedLastScanYearCandidates.some(
      (year) => historicalLastScanDisplay.includes(year),
    );
    scanCachedLocalReport.recordTextCheckpoint({
      key: 'cached-startup-scan-visibility',
      label: 'Visible scan state during unchanged cached startup',
      valueText: visibleScanTriggered ? 'visible' : 'not-visible',
    });
    scanCachedLocalReport.setMetricsPayload({
      startupReadyMs,
      visibleScanTriggered,
      historicalLastScanDisplay,
      harnessMetrics,
    });

    expect(visibleScanTriggered).toBe(false);
    expect(hasExpectedHistoricalYear).toBe(true);
    expect(historicalLastScanDisplay).not.toContain(String(new Date().getFullYear()));
    expectTerminalScanStatus(cachedTerminalStatus, SCAN_FIXTURE.albumCount);
    expect(cachedArtistCount).toBe(SCAN_FIXTURE.artistCount);
    scanCachedLocalReport.recordTerminalTimingOutcome(
      SCAN_CACHED_BUDGET.metricId,
      'startupReadyMs',
      expectTimingBudget(expect.soft, startupReadyMs, SCAN_CACHED_BUDGET, 'Cached startup readiness'),
    );
    scanCachedLocalReport.recordContractCompletion();
  });

  test(`${ADD_ALBUM_CASE_ID} isolated incremental scan surfaces one new album promptly`, async ({
    appBarActions,
    galleryActions,
    navigationPanelActions,
    scanAddAlbumLocalReport,
    scanStatusSampler,
    stepLogger,
  }) => {
    await galleryActions.goto();
    await waitForScanDrivenGalleryReady({
      galleryActions,
      navigationPanelActions,
      sidebarHydration: 'full',
    });
    const addedAlbumName = SCAN_FIXTURE.addedAlbumName;
    const addedArtistName = SCAN_FIXTURE.addedArtistName;
    expect(addedAlbumName).not.toBe('');

    const rescanStartAt = Date.now();
    const statusSampler = scanStatusSampler;
    await statusSampler.start();
    let scanStartStatus;
    const scanStartedMs = await stepLogger.step('Click the production scan indicator and observe background scan start', async () => {
      const startedAt = Date.now();
      await appBarActions.triggerIncrementalScan();
      scanStartStatus = await waitForStatusScanStart(statusSampler, { timeoutMs: 30000 });
      return Date.now() - startedAt;
    });
    await scanAddAlbumLocalReport.recordTimingCheckpoint({
      key: 'incremental-scan-started',
      label: 'Incremental new-album background scan started',
      timingMs: scanStartedMs,
    });

    let terminalStatus;
    await stepLogger.step('Wait for the incremental rescan to finish', async () => {
      terminalStatus = await waitForStatusIdle(statusSampler, { timeoutMs: 120000, requireScanStart: true, scanStartObserved: true });
    });

    let terminalArtistCount = 0;
    const uiUpdatedMs = await stepLogger.step('Select the auto-refreshed new artist and wait for its new album', async () => {
      await navigationPanelActions.waitForAllArtistsVisibleCountGreaterThan(SCAN_FIXTURE.artistCount, { timeout: 60000 });
      terminalArtistCount = await navigationPanelActions.readAllArtistsVisibleCount();
      expect(terminalArtistCount).toBe(SCAN_FIXTURE.artistCount + 1);
      await navigationPanelActions.selectSidebarArtistByName(addedArtistName);
      await galleryActions.waitForSelectedArtistGallery(addedArtistName, {
        timeout: 60000,
        requireExclusiveView: true,
      });
      await galleryActions.waitForAlbumVisible(addedAlbumName, { timeout: 60000 });
      return Date.now() - rescanStartAt;
    });
    await scanAddAlbumLocalReport.recordTimingCheckpoint({
      key: 'new-album-visible',
      label: `New album "${addedAlbumName}" visible after incremental scan`,
      timingMs: uiUpdatedMs,
    });

    await stepLogger.step('Sample idle memory after the new album appears', async () => {
      await scanAddAlbumLocalReport.recordPeakMemoryCheckpoint({
        key: 'new-album-memory',
        label: 'Incremental new-album idle memory',
      });
    });

    await statusSampler.stop();
    const harnessMetrics = await statusSampler.snapshot();
    const sampleMetrics = buildScanSampleMetrics(harnessMetrics.samples, rescanStartAt);
    scanAddAlbumLocalReport.setMetricsPayload({
      sampleMetrics,
      uiUpdatedMs,
      harnessMetrics,
      addedAlbumName,
      addedArtistName,
    });

    expect(scanStartStatus.scan_mode).toBe('background');
    expect(harnessMetrics.samples.some((sample) => sample.scanMode === 'background')).toBe(true);
    expect(sampleMetrics.scanStartSample).not.toBeNull();
    expect(sampleMetrics.scanStartMs).toBeGreaterThanOrEqual(0);
    expect(addedAlbumName).not.toBe('');
    expectTerminalScanStatus(terminalStatus, SCAN_FIXTURE.albumCount + 1);
    expect(terminalArtistCount).toBe(SCAN_FIXTURE.artistCount + 1);
    scanAddAlbumLocalReport.recordTerminalTimingOutcome(
      SCAN_ADD_ALBUM_BUDGET.metricId,
      'uiUpdatedMs',
      expectTimingBudget(
        expect.soft,
        uiUpdatedMs,
        SCAN_ADD_ALBUM_BUDGET,
        'Incremental new-album visible UI readiness',
      ),
    );
    scanAddAlbumLocalReport.recordContractCompletion();
  });

  test(`${METADATA_CASE_ID} isolated incremental scan refreshes changed metadata promptly`, async ({
    appBarActions,
    galleryActions,
    navigationPanelActions,
    scanPageActions,
    scanMetadataLocalReport,
    scanStatusSampler,
    searchToolbarActions,
    stepLogger,
  }) => {
    await galleryActions.goto();
    await waitForScanDrivenGalleryReady({
      galleryActions,
      navigationPanelActions,
      sidebarHydration: 'full',
    });
    await galleryActions.waitForInitialRefreshCompleted({ timeout: 60000 });
    const changedAlbumName = SCAN_FIXTURE.changedAlbumName;
    expect(changedAlbumName).toBe('Album 001 Metadata Updated');

    const rescanStartAt = Date.now();
    const statusSampler = scanStatusSampler;
    await statusSampler.start();
    let scanStartStatus;
    const scanStartedMs = await stepLogger.step('Click the production scan indicator and observe metadata background scan start', async () => {
      const startedAt = Date.now();
      await appBarActions.triggerIncrementalScan();
      scanStartStatus = await waitForStatusScanStart(statusSampler, { timeoutMs: 30000 });
      return Date.now() - startedAt;
    });
    await scanMetadataLocalReport.recordTimingCheckpoint({
      key: 'metadata-scan-started',
      label: 'Metadata-change background scan started',
      timingMs: scanStartedMs,
    });

    const deepScroll = await galleryActions.jumpGalleryToMiddle();
    expect(deepScroll.maxScrollTop).toBeGreaterThan(2);
    expect(deepScroll.scrollTop).toBeGreaterThan(2);

    await stepLogger.step('Open the Scan Page while the cached incremental scan remains active', async () => {
      await appBarActions.openStatusMenu();
      await appBarActions.waitForScanActionLabel('Go to Scan Page');
      await appBarActions.goToScanPage({ menuAlreadyOpen: true });
      await scanPageActions.waitForDedicatedPageVisible({ timeout: 60000 });
      await scanPageActions.waitForBrowseButton({ timeout: 60000 });
    });

    const cachedBrowseObservation = await scanPageActions.startGalleryExitObservation();
    const cachedBrowseMs = await stepLogger.step('Browse the cached library immediately during the active incremental scan', async () => (
      measureActionTime(
        async () => {
          await scanPageActions.clickBrowseScannedLibrary();
        },
        async () => {
          await waitForScanDrivenGalleryReady({
            galleryActions,
            navigationPanelActions,
          });
          await scanPageActions.waitForDedicatedPageHidden({ timeout: 60000 });
          await galleryActions.waitForGalleryScrollAtStart({ timeout: 10000 });
        },
      )
    ));
    const cachedBrowseExit = await stepLogger.step(
      'Keep the regular-scan cached gallery complete and pinned to the top after Browse',
      async () => scanPageActions.finishGalleryExitObservation(cachedBrowseObservation),
    );
    await scanMetadataLocalReport.recordTimingCheckpoint({
      key: 'active-scan-cached-browse-ready',
      label: 'Cached library browse ready during active metadata scan',
      timingMs: cachedBrowseMs,
    });
    scanMetadataLocalReport.recordTerminalTimingOutcome('scan-metadata.cachedBrowseReadyMs', 'cachedBrowseReadyMs', expectTimingBudget(
      expect.soft,
      cachedBrowseMs,
      STRICT_ONE_SECOND_BUDGET,
      'Cached library Browse readiness during active scan',
    ));
    scanMetadataLocalReport.recordTerminalTimingOutcome('scan-metadata.cachedBrowseStableMs', 'cachedBrowseStableMs', expectTimingBudget(
      expect.soft,
      cachedBrowseExit.firstReadyMs,
      STRICT_ONE_SECOND_BUDGET,
      'Cached regular-scan Browse to stable top gallery',
    ));
    expect(await navigationPanelActions.readAllArtistsVisibleCount()).toBe(SCAN_FIXTURE.artistCount);

    await stepLogger.step('Keep the busy scan indicator left click inert with no refresh request or restart message', async () => {
      const repeatedScan = await appBarActions.triggerBusyIncrementalScanAndExpectInert();
      expect(repeatedScan.refreshRequestCount).toBe(0);
    });

    await stepLogger.step('Keep the busy scan indicator right-click status menu available', async () => {
      await appBarActions.openStatusMenu();
      await appBarActions.waitForScanActionLabel('Go to Scan Page');
      await appBarActions.dismissStatusMenu();
    });

    await stepLogger.step('Open the existing metadata artist while the incremental scan remains active', async () => {
      await galleryActions.expectCentralLoaderHidden();
      await navigationPanelActions.selectSidebarArtistByName(METADATA_ARTIST_NAME);
      await navigationPanelActions.waitForSidebarSelection(METADATA_ARTIST_NAME);
      await galleryActions.waitForSelectedArtistGallery(METADATA_ARTIST_NAME, {
        timeout: 60000,
        requireExclusiveView: true,
      });
      await galleryActions.waitForAlbumCoverReadyUnderHeading(
        METADATA_ARTIST_NAME,
        ORIGINAL_METADATA_ALBUM_NAME,
        { timeout: 60000 },
      );
      await galleryActions.expectCentralLoaderHidden();
    });

    await stepLogger.step('Open the Scan Page from Artist 001 while the metadata scan remains active', async () => {
      await appBarActions.openStatusMenu();
      await appBarActions.waitForScanActionLabel('Go to Scan Page');
      await appBarActions.goToScanPage({ menuAlreadyOpen: true });
      await scanPageActions.waitForDedicatedPageVisible({ timeout: 60000 });
      await scanPageActions.expectBrowseContextCleared();
    });

    let searchSubmittedAt = 0;
    let searchReadiness = null;
    const searchReadyMs = await stepLogger.step('Search from Scan Page and wait for the complete Artist 001 result view', async () => {
      await searchToolbarActions.search(BACKGROUND_BROWSE_QUERY, {
        submitWithEnter: true,
        async recordSubmissionBoundary() {
          searchSubmittedAt = await scanPageActions.readPerformanceNow();
        },
      });
      searchReadiness = await scanPageActions.waitForSearchReadiness({
        expectedAlbumCount: 10,
        expectedQuery: BACKGROUND_BROWSE_QUERY,
        expectedSelectedArtistName: METADATA_ARTIST_NAME,
        expectedSidebarArtistNames: BACKGROUND_BROWSE_ARTIST_NAMES,
      }, {
        timeout: 60000,
      });
      expect(searchSubmittedAt).toBeGreaterThan(0);
      return searchReadiness.completedAtMs - searchSubmittedAt;
    });
    expect(searchReadiness.snapshot.query).toBe(BACKGROUND_BROWSE_QUERY);
    expect(new URL(searchReadiness.snapshot.url).searchParams.get('q'))
      .toBe(BACKGROUND_BROWSE_QUERY);
    expect(searchReadiness.snapshot.loaderVisible).toBe(false);
    expect(searchReadiness.snapshot.sidebarArtistNames).toEqual(
      BACKGROUND_BROWSE_ARTIST_NAMES,
    );
    expect(searchReadiness.snapshot.allArtistsVisibleCount)
      .toBe(BACKGROUND_BROWSE_ARTIST_NAMES.length);
    expect(searchReadiness.snapshot.selectedArtistName).toBe(METADATA_ARTIST_NAME);
    const searchSelectedArtistUrl = new URL(
      searchReadiness.snapshot.selectedArtistHref,
      searchReadiness.snapshot.url,
    );
    expect(searchSelectedArtistUrl.searchParams.get('artist')).toBe(METADATA_ARTIST_NAME);
    expect(searchSelectedArtistUrl.searchParams.get('q')).toBe(BACKGROUND_BROWSE_QUERY);
    expect(searchReadiness.snapshot.galleryHeadings).toEqual([METADATA_ARTIST_NAME]);
    expect(searchReadiness.snapshot.albumCards).toHaveLength(10);
    expect(
      searchReadiness.snapshot.albumCards.every(
        (card) => card.albumKey && card.title && card.coverSettled,
      ),
    ).toBe(true);
    await scanMetadataLocalReport.recordTimingCheckpoint({
      key: 'active-scan-search-ready',
      label: 'Search results and Artist 001 gallery ready during active metadata scan',
      timingMs: searchReadyMs,
    });
    scanMetadataLocalReport.recordTerminalTimingOutcome('scan-metadata.searchReadyMs', 'searchReadyMs', expectTimingBudget(
      expect.soft,
      searchReadyMs,
      SCAN_METADATA_SEARCH_BUDGET,
      'Committed search and Artist 001 gallery readiness during active scan',
    ));

    await stepLogger.step('Reopen Scan Page and choose Artist 002 from the retained filtered tree', async () => {
      await appBarActions.openStatusMenu();
      await appBarActions.waitForScanActionLabel('Go to Scan Page');
      await appBarActions.goToScanPage({ menuAlreadyOpen: true });
      await scanPageActions.waitForDedicatedPageVisible({ timeout: 60000 });
      await scanPageActions.expectBrowseContextCleared();
      await navigationPanelActions.selectSidebarArtistByName(BACKGROUND_BROWSE_ARTIST_NAME);
      await scanPageActions.waitForDedicatedPageHidden({ timeout: 60000 });
      await searchToolbarActions.waitForQuery(BACKGROUND_BROWSE_QUERY, { timeout: 60000 });
      await navigationPanelActions.waitForSidebarArtistNames(BACKGROUND_BROWSE_ARTIST_NAMES, { timeout: 60000 });
      await navigationPanelActions.waitForSidebarSelection(BACKGROUND_BROWSE_ARTIST_NAME, { timeout: 60000 });
      expect(await navigationPanelActions.readSidebarArtistNames()).toEqual(BACKGROUND_BROWSE_ARTIST_NAMES);
      expect(await navigationPanelActions.readAllArtistsVisibleCount()).toBe(BACKGROUND_BROWSE_ARTIST_NAMES.length);
      expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(BACKGROUND_BROWSE_ARTIST_NAME);
      await galleryActions.waitForSelectedArtistGallery(BACKGROUND_BROWSE_ARTIST_NAME, {
        timeout: 60000,
        queryValue: BACKGROUND_BROWSE_QUERY,
        requireExclusiveView: true,
      });
      await galleryActions.waitForVisibleGalleryCoversLoaded({
        minimumCount: 1,
        timeout: 60000,
      });
    });

    const browseContinuityObservation = await scanPageActions.startBrowseContinuityObservation();

    let terminalStatus;
    await stepLogger.step('Wait for the metadata rescan to finish', async () => {
      terminalStatus = await waitForStatusIdle(statusSampler, { timeoutMs: 120000, requireScanStart: true, scanStartObserved: true });
    });

    const uiUpdatedMs = await stepLogger.step('Keep the gallery visible through completion and any cover follow-up', async () => {
      await galleryActions.expectCentralLoaderHidden();
      await navigationPanelActions.selectSidebarArtistByName(METADATA_ARTIST_NAME);
      await navigationPanelActions.waitForSidebarSelection(METADATA_ARTIST_NAME, { timeout: 60000 });
      await navigationPanelActions.waitForSidebarArtistNames(BACKGROUND_BROWSE_ARTIST_NAMES, { timeout: 60000 });
      await galleryActions.waitForSelectedArtistGallery(METADATA_ARTIST_NAME, {
        timeout: 60000,
        requireExclusiveView: true,
      });
      await galleryActions.waitForAlbumCoverReadyUnderHeading(
        METADATA_ARTIST_NAME,
        changedAlbumName,
        { timeout: 60000 },
      );
      await galleryActions.expectCentralLoaderHidden();
      return Date.now() - rescanStartAt;
    });
    await scanMetadataLocalReport.recordTimingCheckpoint({
      key: 'metadata-visible',
      label: `Changed album title "${changedAlbumName}" visible after incremental scan`,
      timingMs: uiUpdatedMs,
    });

    await stepLogger.step('Sample idle memory after the metadata update appears', async () => {
      await scanMetadataLocalReport.recordPeakMemoryCheckpoint({
        key: 'metadata-memory',
        label: 'Metadata-change idle memory',
      });
    });


    const browseContinuity = await stepLogger.step('Verify the gallery stayed visible through scan, relation, and cover follow-up', async () => (
      browseContinuityObservation.finish()
    ));
    expectBackgroundBrowseContinuity(browseContinuity);
    await statusSampler.stop();
    const harnessMetrics = await statusSampler.snapshot();
    const sampleMetrics = buildScanSampleMetrics(harnessMetrics.samples, rescanStartAt);
    scanMetadataLocalReport.setMetricsPayload({
      sampleMetrics,
      cachedBrowseMs,
      uiUpdatedMs,
      harnessMetrics,
      changedAlbumName,
    });

    const terminalArtistNames = await navigationPanelActions.readSidebarArtistNames();
    const terminalActiveArtistName = await navigationPanelActions.readActiveSidebarArtistName();
    const terminalAllArtistsVisibleCount = await navigationPanelActions.readAllArtistsVisibleCount();
    expect(scanStartStatus.scan_mode).toBe('background');
    expect(harnessMetrics.samples.some((sample) => sample.scanMode === 'background')).toBe(true);
    expect(sampleMetrics.scanStartSample).not.toBeNull();
    expect(harnessMetrics.samples.some((sample) => sample.coversInProgress)).toBe(true);
    expect(harnessMetrics.samples.some((sample) => (
      sample.scanPhase === 'finalizing' || sample.relationsInProgress
    ))).toBe(true);
    expect(sampleMetrics.scanStartMs).toBeGreaterThanOrEqual(0);
    expect(changedAlbumName).toBe('Album 001 Metadata Updated');
    expectTerminalScanStatus(terminalStatus, SCAN_FIXTURE.albumCount);
    expect(Number(terminalStatus.relations_total || 0)).toBe(SCAN_FIXTURE.artistCount);
    expect(terminalArtistNames).toEqual(BACKGROUND_BROWSE_ARTIST_NAMES);
    expect(terminalActiveArtistName).toBe(METADATA_ARTIST_NAME);
    expect(terminalAllArtistsVisibleCount).toBe(BACKGROUND_BROWSE_ARTIST_NAMES.length);
    scanMetadataLocalReport.recordContractCompletion();
  });

  test(`${SCAN_PAGE_CASE_ID} explicit Scan Page preserves and restores browse context through idle`, async ({
    appBarActions,
    galleryActions,
    navigationPanelActions,
    scanPageActions,
    scanStatusSampler,
    searchToolbarActions,
    stepLogger,
  }, testInfo) => {
    const statusSampler = scanStatusSampler;
    await statusSampler.start();
    await stepLogger.step('Open the cached generated library and establish a searchable gallery context', async () => {
      await galleryActions.goto();
      await waitForScanDrivenGalleryReady({
        galleryActions,
        navigationPanelActions,
        sidebarHydration: 'full',
      });
      await searchToolbarActions.search(BACKGROUND_BROWSE_QUERY, { submitWithEnter: true });
      await navigationPanelActions.waitForSidebarSelection(METADATA_ARTIST_NAME, { timeout: 60000 });
      await galleryActions.waitForSelectedArtistGallery(METADATA_ARTIST_NAME, {
        timeout: 60000,
        queryValue: BACKGROUND_BROWSE_QUERY,
        requireExclusiveView: true,
      });
      await galleryActions.waitForVisibleGalleryCoversLoaded({
        minimumCount: 1,
        timeout: 60000,
      });
    });

    const priorBrowseContext = await stepLogger.step('Capture the visible query, tree, family, URL, and gallery scope', async () => (
      scanPageActions.readBrowseContext()
    ));
    expect(priorBrowseContext.query).toBe(BACKGROUND_BROWSE_QUERY);
    expect(priorBrowseContext.activeSelection).toBe(METADATA_ARTIST_NAME);
    expect(priorBrowseContext.galleryHeadings).toEqual([METADATA_ARTIST_NAME]);
    expect(priorBrowseContext.artistFamilyVisible).toBe(false);
    expect(priorBrowseContext.galleryVisible).toBe(true);
    expect(priorBrowseContext.hasVisibleCover).toBe(true);
    stepLogger.note('Generated scan fixture has no visible Artist Family; the exact absent family state remains part of the Back round trip.');

    const phaseObservation = await scanPageActions.startPhaseObservation();
    await stepLogger.step('Start a background incremental scan and explicitly open its Scan Page', async () => {
      await appBarActions.triggerIncrementalScanAndWaitForBusy();
      await appBarActions.openStatusMenu();
      await appBarActions.waitForScanActionLabel('Go to Scan Page');
      await appBarActions.goToScanPage({ menuAlreadyOpen: true });
      await scanPageActions.waitForDedicatedPageVisible({ timeout: 60000 });
      await scanPageActions.expectBrowseContextCleared();
    });
    const relationshipScreenshot = scanPageActions.captureRelationshipRefreshActions(
      testInfo.outputPath('relationship-refresh-actions.png'),
    );

    let terminalStatus;
    const observedPhases = await stepLogger.step('Leave the explicit Scan Page open through scan, relation, cover, and idle phases', async () => {
      await appBarActions.openStatusMenu();
      await Promise.all([
        waitForStatusCoverScan(statusSampler, { timeoutMs: 120000 }),
        appBarActions.expectActiveCoverScanAction({ timeout: 120000 }),
      ]);
      await appBarActions.dismissStatusMenu();
      terminalStatus = await waitForStatusIdle(statusSampler, {
        timeoutMs: 120000,
        requireScanStart: true,
        scanStartObserved: true,
      });
      await scanPageActions.waitForPhaseTitle('No Active Scan Running', { timeout: 30000 });
      await scanPageActions.waitForDedicatedPageVisible({ timeout: 30000 });
      await relationshipScreenshot;
      return phaseObservation.finish();
    });
    scanPageActions.expectPhaseObservation(observedPhases);
    await statusSampler.stop();

    await stepLogger.step('Keep the idle Full Rescan menu action available from the Scan Page', async () => {
      await appBarActions.openStatusMenu();
      await appBarActions.waitForScanActionLabel('Full Rescan');
      await appBarActions.dismissStatusMenu();
    });

    const restoredBackObservation = await scanPageActions.startGalleryExitObservation();
    const restoredBackMs = await stepLogger.step(
      'Use Back to immediately restore the complete prior query, tree, family, URL, and gallery',
      async () => measureActionTime(
        async () => scanPageActions.clickBack(),
        async () => scanPageActions.waitForBrowseContext(
          priorBrowseContext,
          { timeout: 60000 },
        ),
      ),
    );
    const restoredBackExit = await stepLogger.step(
      'Keep the restored Back gallery complete and stable at the top',
      async () => scanPageActions.finishGalleryExitObservation(restoredBackObservation),
    );
    expectTimingBudget(
      expect.soft,
      restoredBackExit.firstReadyMs,
      STRICT_ONE_SECOND_BUDGET,
      'Scan Page Back to stable complete top gallery',
    );
    expectTimingBudget(
      expect.soft,
      restoredBackMs,
      STRICT_ONE_SECOND_BUDGET,
      'Scan Page Back context readiness',
    );

    expectTerminalScanStatus(terminalStatus, SCAN_FIXTURE.albumCount + 1);
  });

  test(`${SCAN_CANCEL_CASE_ID} dedicated Scan Page cancels regular and full scans`, async ({
    appBarActions,
    galleryActions,
    navigationPanelActions,
    page,
    scanPageActions,
    searchToolbarActions,
    stepLogger,
  }, testInfo) => {
    const regularScanBrowseContext = await stepLogger.step(
      'Open a committed search with a selected artist and settled real covers before starting a cancellable regular scan',
      async () => {
        await galleryActions.goto();
        await waitForScanDrivenGalleryReady({
          galleryActions,
          navigationPanelActions,
          sidebarHydration: 'full',
        });
        await searchToolbarActions.search(BACKGROUND_BROWSE_QUERY, { submitWithEnter: true });
        await navigationPanelActions.waitForSidebarSelection(METADATA_ARTIST_NAME, {
          timeout: 60000,
        });
        await galleryActions.waitForSelectedArtistGallery(METADATA_ARTIST_NAME, {
          timeout: 60000,
          queryValue: BACKGROUND_BROWSE_QUERY,
          requireExclusiveView: true,
        });
        await galleryActions.waitForVisibleGalleryCoversLoaded({
          minimumCount: 6,
          requireLocalImage: true,
          timeout: 60000,
        });
        await scanPageActions.expectCancelAbsent();
        return scanPageActions.readBrowseContext();
      },
    );
    expect(regularScanBrowseContext.query).toBe(BACKGROUND_BROWSE_QUERY);
    expect(regularScanBrowseContext.activeSelection).toBe(METADATA_ARTIST_NAME);
    expect(regularScanBrowseContext.galleryHeadings).toEqual([METADATA_ARTIST_NAME]);
    expect(regularScanBrowseContext.galleryVisible).toBe(true);
    expect(regularScanBrowseContext.hasVisibleCover).toBe(true);

    await stepLogger.step('Open the active regular scan from the exact status-menu action', async () => {
      await appBarActions.triggerIncrementalScanAndWaitForBusy();
      await scanPageActions.expectCancelAbsent();
      await appBarActions.openStatusMenu();
      await appBarActions.waitForScanActionLabel('Go to Scan Page');
      await appBarActions.goToScanPage({ menuAlreadyOpen: true });
      await scanPageActions.waitForDedicatedPageVisible({ timeout: 60000 });
    });

    await stepLogger.step('Verify the approved regular-scan actions and cancel with one request', async () => {
      await scanPageActions.expectDedicatedScanActions('Cancel Scan');
      await scanPageActions.cancelActiveScan('Cancel Scan');
    });

    const cancelledBackObservation = await scanPageActions.startGalleryExitObservation({
      requireRealCovers: true,
    });
    const cancelledBackExit = await stepLogger.step(
      'Use Back after cancellation and keep the retained real-cover gallery complete and stable',
      async () => {
        await scanPageActions.clickBack();
        await scanPageActions.waitForBrowseContext(regularScanBrowseContext, {
          timeout: 60000,
        });
        await scanPageActions.waitForDedicatedPageHidden({ timeout: 60000 });
        await scanPageActions.expectCancelAbsent();
        return scanPageActions.finishGalleryExitObservation(cancelledBackObservation);
      },
    );
    expectTimingBudget(
      expect.soft,
      cancelledBackExit.firstReadyMs,
      STRICT_ONE_SECOND_BUDGET,
      'Cancelled Scan Page Back to stable retained real-cover gallery',
    );
    await page.screenshot({
      path: testInfo.outputPath('cancelled-scan-back-gallery.png'),
      fullPage: true,
    });

    await stepLogger.step('Start a full rescan and open it from the exact status-menu action', async () => {
      await appBarActions.triggerFullRescanAndWaitForBusy();
      await scanPageActions.expectCancelAbsent();
      await appBarActions.openStatusMenu();
      await appBarActions.waitForScanActionLabel('Go to Scan Page');
      await appBarActions.goToScanPage({ menuAlreadyOpen: true });
      await scanPageActions.waitForDedicatedPageVisible({ timeout: 60000 });
    });

    await stepLogger.step('Verify the approved full-rescan actions and cancel with one request', async () => {
      await scanPageActions.expectDedicatedScanActions('Cancel Full Rescan');
      await scanPageActions.cancelActiveScan('Cancel Full Rescan');
    });

    await stepLogger.step('Leave the idle Scan Page with cancellation absent off-page', async () => {
      await scanPageActions.clickBack();
      await scanPageActions.waitForDedicatedPageHidden({ timeout: 60000 });
      await scanPageActions.expectCancelAbsent();
    });
  });
});
