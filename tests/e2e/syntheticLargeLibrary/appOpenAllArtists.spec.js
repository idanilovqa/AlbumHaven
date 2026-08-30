import { expect, test } from '../support/performanceFixtures.js';

import {
  buildBenchmarkValidationPayload,
  evaluateAppOpenAllArtistsLocalBenchmark,
  expectPostgresLibraryBrowseTelemetry,
  logBenchmarkTimingResults,
  partitionAuthenticatedCoverPreemptionRuntimeLogs,
  readGalleryCoverPreemptionSnapshot,
} from '../helpers/index.js';
import {
  measureAllArtistsAppOpenVisibleReadiness,
  readStartupDiagnostics,
} from '../helpers/appOpenAllArtistsHelpers.js';
import {
  collectRootBrowseStartupAuthorityEvidence,
  expectManualStartupEntryPath,
  expectNoUnexpectedRuntimeFailures,
  expectRootBrowseStartupAuthorityEvidence,
  readRuntimeView,
  requirePostgresRuntimeEnv,
} from '../helpers/realAppBenchmarkHelpers.js';

const CASE_ID = 'FTC-GALLERY-STARTUP-005T';

test.describe(`${CASE_ID} synthetic-large app-open All Artists UI`, () => {

  test('App open renders All Artists UI and explicit full root browse uses library_browse', async ({
    galleryActions,
    navigationPanelActions,
    page,
    appOpenAllArtistsFocusedLocalReport,
    stepLogger,
    testArtifacts,
  }) => {
    requirePostgresRuntimeEnv('the app-open All Artists benchmark');

    let startupAuthorityEvidence = null;
    const coverPreemptionBefore = await readGalleryCoverPreemptionSnapshot(page);
    const { appOpenTimings, startupEntryState, awaitFullSidebarProof } = await stepLogger.step('Open the real app root, confirm the startup entry path, and wait for visible All Artists UI readiness', async () => {
      let readinessResult = null;
      startupAuthorityEvidence = await collectRootBrowseStartupAuthorityEvidence(page, async () => {
        readinessResult = await measureAllArtistsAppOpenVisibleReadiness(galleryActions, navigationPanelActions);
      });
      return readinessResult;
    });
    const runtimeView = await readRuntimeView(page);
    const startupDiagnostics = await readStartupDiagnostics(page);
    const sidebarArtistCount = await navigationPanelActions.readSidebarArtistCount();
    const visibleAllArtistsCount = await navigationPanelActions.readAllArtistsVisibleCount();
    const visibleArtistHeadings = await galleryActions.readArtistHeadings();

    await stepLogger.step('Assert the app-open path exposes a valid startup entry path and then hydrates into All Artists', async () => {
      expectManualStartupEntryPath(startupEntryState, 'the app-open benchmark');
      expectRootBrowseStartupAuthorityEvidence(startupAuthorityEvidence);
      expect(runtimeView, 'Expected the app-open runtime view to be available after visible readiness.').toBeTruthy();
      expect(Array.isArray(runtimeView.artist_groups), 'Expected visible readiness to leave rendered artist groups in state.view.').toBe(true);
      expect(runtimeView.artist_groups.length, 'Expected visible readiness to expose All Artists groups before the full-sidebar proof.').toBeGreaterThan(0);
      expect(visibleArtistHeadings.length).toBeGreaterThan(0);
    });

    await appOpenAllArtistsFocusedLocalReport.recordTimingCheckpoint({
      key: 'app-open-visible-ui-ready',
      label: 'App-open visible All Artists UI ready',
      timingMs: appOpenTimings.visibleUiReadyMs,
      details: {
        phase: 'app_open_visible_all_artists_ui',
        startupMode: startupEntryState?.startupMode || 'unknown',
        startupEntryVisibleMs: appOpenTimings.startupEntryVisibleMs,
        navigationMs: appOpenTimings.navigationMs,
        gotoMs: appOpenTimings.gotoMs,
        startupSignalMs: appOpenTimings.startupSignalMs,
        visibleRefreshMs: appOpenTimings.visibleRefreshMs,
        firstSectionsMs: appOpenTimings.firstSectionsMs,
        coversMs: appOpenTimings.coversMs,
        visibleAllArtistsCount,
        sidebarArtistCount,
        visibleArtistHeadingCount: visibleArtistHeadings.length,
        startupPersistenceBackend: runtimeView.persistence_backend,
        startupPersistenceSeam: runtimeView.persistence_seam,
        startupViewDataSource: runtimeView.view_data_source,
        startupDiagnostics,
      },
    });

    const fullSidebarProof = await stepLogger.step('Wait for strict full sidebar hydration proof after visible readiness', async () => (
      awaitFullSidebarProof()
    ));
    const fullRuntimeView = await readRuntimeView(page);
    const fullSidebarArtistCount = await navigationPanelActions.readSidebarArtistCount();
    const fullVisibleAllArtistsCount = await navigationPanelActions.readAllArtistsVisibleCount();
    const sidebarArtistNames = await navigationPanelActions.readSidebarArtistNames();
    const coverPreemptionAfter = await readGalleryCoverPreemptionSnapshot(page);
    const coverPreemptionWindow = {
      sequenceBefore: coverPreemptionBefore.sequence,
      sequenceAfter: coverPreemptionAfter.sequence,
      preemptions: coverPreemptionAfter.preemptions,
    };

    await stepLogger.step('Assert app-open full sidebar proof came from library_browse', async () => {
      expect(fullRuntimeView, 'Expected the full app-open runtime view to be available after full-sidebar readiness.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(fullRuntimeView, 'full');
      expect(fullSidebarArtistCount).toBe(fullVisibleAllArtistsCount);
      expect(sidebarArtistNames.length).toBeGreaterThan(0);
    });

    await appOpenAllArtistsFocusedLocalReport.recordTimingCheckpoint({
      key: 'app-open-full-sidebar-proof',
      label: 'App-open full sidebar hydration proof',
      timingMs: fullSidebarProof.fullSidebarMs,
      details: {
        phase: 'app_open_full_sidebar_proof',
        fullSidebarMs: fullSidebarProof.fullSidebarMs,
        countSynchronizedMs: fullSidebarProof.countSynchronizedMs,
        initialRefreshMs: fullSidebarProof.initialRefreshMs,
        visibleAllArtistsCount: fullVisibleAllArtistsCount,
        sidebarArtistCount: fullSidebarArtistCount,
        startupPersistenceBackend: fullRuntimeView.persistence_backend,
        startupPersistenceSeam: fullRuntimeView.persistence_seam,
        startupViewDataSource: fullRuntimeView.view_data_source,
      },
    });

    const benchmarkEvaluation = evaluateAppOpenAllArtistsLocalBenchmark({
      visibleUiReadyMs: appOpenTimings.visibleUiReadyMs,
    });
    logBenchmarkTimingResults(benchmarkEvaluation);
    const runtimePartition = partitionAuthenticatedCoverPreemptionRuntimeLogs(
      testArtifacts.getRuntimeLogs(),
      coverPreemptionWindow,
    );
    const acceptedCoverRequestIds = new Set(
      runtimePartition.acceptedIntentionalCoverAborts
        .map((entry) => String(entry?.coverRequestId || ''))
        .filter(Boolean),
    );
    const authenticatedCoverPreemptionEvidence = coverPreemptionWindow.preemptions
      .filter((entry) => acceptedCoverRequestIds.has(String(entry?.requestId || '')))
      .map((entry) => ({
        coverRequestId: String(entry.requestId),
        normalizedUrl: String(entry.normalizedUrl),
        reason: String(entry.reason),
        sequence: Number(entry.sequence),
      }));
    appOpenAllArtistsFocusedLocalReport.setMetricsPayload({
      visibleUiReadyMs: appOpenTimings.visibleUiReadyMs,
      appOpenTimings,
      startupHydrationPayloadCount: startupAuthorityEvidence.rootBrowsePayloads.length,
      startupBootstrapPayloadCount: startupAuthorityEvidence.bootstrapPayloads.length,
      fullSidebarProof,
      artistCount: Number(fullRuntimeView.artist_count || 0),
      albumCount: Number(fullRuntimeView.album_count || 0),
      artistGroupCount: fullRuntimeView.artist_groups.length,
      sidebarArtistCount: fullSidebarArtistCount,
      visibleAllArtistsCount: fullVisibleAllArtistsCount,
      visibleArtistHeadingCount: visibleArtistHeadings.length,
      startupPersistenceBackend: fullRuntimeView.persistence_backend,
      startupPersistenceSeam: fullRuntimeView.persistence_seam,
      startupViewDataSource: fullRuntimeView.view_data_source,
      startupDiagnostics,
      persistenceBackend: fullRuntimeView.persistence_backend,
      persistenceSeam: fullRuntimeView.persistence_seam,
      viewDataSource: fullRuntimeView.view_data_source,
      authenticatedCoverPreemptionCount: runtimePartition.acceptedIntentionalCoverAborts.length,
      authenticatedCoverPreemptionEvidence,
      benchmarkValidation: buildBenchmarkValidationPayload(benchmarkEvaluation),
    });
    expectNoUnexpectedRuntimeFailures(
      runtimePartition.unexpectedRuntimeErrors,
      'the app-open All Artists benchmark',
    );
    expect(
      benchmarkEvaluation.failures,
      benchmarkEvaluation.failures.join('\n'),
    ).toEqual([]);
  });
});
