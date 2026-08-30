import { expect, test } from '../support/performanceFixtures.js';

import {
  expectPostgresLibraryBrowseTelemetry,
  expectTimingBudget,
  measureActionTime,
  performanceTimingBudget,
  partitionAuthenticatedCoverPreemptionRuntimeLogs,
  readGalleryCoverPreemptionSnapshot,
} from '../helpers/index.js';
import {
  collectRootBrowseStartupAuthorityEvidence,
  expectManualStartupEntryPath,
  expectNoUnexpectedRuntimeFailures,
  expectRootBrowseStartupAuthorityEvidence,
  flattenAlbums,
  readRuntimeView,
  requirePostgresRuntimeEnv,
  waitForLibraryStartupEntryVisible,
} from '../helpers/realAppBenchmarkHelpers.js';

const CASE_ID = 'FTC-GALLERY-STARTUP-005S';
const ROOT_ALBUM_BROWSE_BUDGET = Object.freeze(
  performanceTimingBudget('root-album-browse.rootAlbumBrowseApiMs'),
);

test.describe(`${CASE_ID} synthetic-large root album browse UI`, () => {

  test('Root album browse UI reports library_browse telemetry and timing', async ({
    galleryActions,
    navigationPanelActions,
    page,
    rootAlbumBrowseFocusedLocalReport,
    stepLogger,
    testArtifacts,
  }) => {
    requirePostgresRuntimeEnv('the root album browse benchmark');

    let startupAuthorityEvidence = null;
    let startupEntryState = null;
    const coverPreemptionBefore = await readGalleryCoverPreemptionSnapshot(page);
    const rootAlbumBrowseApiMs = await stepLogger.step('Open the real app root and wait for the All Artists gallery to settle visibly', async () => {
      const timeout = 120000;
      let timingMs = 0;
      startupAuthorityEvidence = await collectRootBrowseStartupAuthorityEvidence(page, async () => {
        timingMs = await measureActionTime(
          async () => {
            await galleryActions.goto('/');
          },
          async () => {
            startupEntryState = await waitForLibraryStartupEntryVisible(
              page,
              galleryActions,
              navigationPanelActions,
              { timeout },
            );
            await navigationPanelActions.waitForSidebarFullyHydrated({ timeout });
            await navigationPanelActions.waitForSidebarAndAllArtistsCountSynchronized({ timeout });
            await galleryActions.waitForInitialAllArtistsSections({ timeout });
            await galleryActions.waitForInitialRefreshCompleted({ timeout });
            await galleryActions.waitForVisibleGalleryCoversLoaded({ minimumCount: 2, timeout });
          },
        );
      });
      return timingMs;
    });
    const coverPreemptionAfter = await readGalleryCoverPreemptionSnapshot(page);
    const coverPreemptionWindow = {
      sequenceBefore: coverPreemptionBefore.sequence,
      sequenceAfter: coverPreemptionAfter.sequence,
      preemptions: coverPreemptionAfter.preemptions,
    };

    const rootAlbumsPayload = await readRuntimeView(page);
    let albums = [];
    await stepLogger.step('Assert the visible root album browse came from library_browse with the full browse payload', async () => {
      expectManualStartupEntryPath(startupEntryState, 'the root album browse benchmark');
      expect(rootAlbumsPayload, 'Expected the root album browse runtime view to be available after visible readiness.').toBeTruthy();
      expectRootBrowseStartupAuthorityEvidence(startupAuthorityEvidence);
      expectPostgresLibraryBrowseTelemetry(rootAlbumsPayload, 'full');
      expect(String(rootAlbumsPayload.query || '').trim()).toBe('');
      expect(String(rootAlbumsPayload.selected_artist || '').trim()).toBe('');
      expect(Array.isArray(rootAlbumsPayload.artist_groups)).toBe(true);
      expect(rootAlbumsPayload.artist_groups.length).toBeGreaterThan(0);
      expect(Array.isArray(rootAlbumsPayload.artists_sidebar)).toBe(true);
      expect(rootAlbumsPayload.artists_sidebar.length).toBeGreaterThan(0);
      expect(Number(rootAlbumsPayload.artist_count || 0)).toBeGreaterThan(0);
      expect(Number(rootAlbumsPayload.album_count || 0)).toBeGreaterThan(0);
      albums = flattenAlbums(rootAlbumsPayload.artist_groups);
      expect(albums.length).toBeGreaterThan(0);
      expect(albums.every((album) => album?.preview_only === true)).toBe(true);
      expect(albums.every((album) => !Object.prototype.hasOwnProperty.call(album || {}, 'tracks'))).toBe(true);
      expect(albums.some((album) => Number(album?.track_count_preview || 0) > 0)).toBe(true);
    });

    await rootAlbumBrowseFocusedLocalReport.recordTimingCheckpoint({
      key: 'root-album-browse-api',
      label: 'Root album browse UI ready',
      timingMs: rootAlbumBrowseApiMs,
      details: {
        phase: 'root_album_browse',
        artistCount: Number(rootAlbumsPayload.artist_count || 0),
        albumCount: Number(rootAlbumsPayload.album_count || 0),
        artistGroupCount: rootAlbumsPayload.artist_groups.length,
        sidebarArtistCount: rootAlbumsPayload.artists_sidebar.length,
        flattenedAlbumCount: albums.length,
        persistenceBackend: rootAlbumsPayload.persistence_backend,
        persistenceSeam: rootAlbumsPayload.persistence_seam,
        viewDataSource: rootAlbumsPayload.view_data_source,
      },
    });

    rootAlbumBrowseFocusedLocalReport.setMetricsPayload({
      rootAlbumBrowseApiMs,
      artistCount: Number(rootAlbumsPayload.artist_count || 0),
      albumCount: Number(rootAlbumsPayload.album_count || 0),
      artistGroupCount: rootAlbumsPayload.artist_groups.length,
      sidebarArtistCount: rootAlbumsPayload.artists_sidebar.length,
      flattenedAlbumCount: albums.length,
      persistenceBackend: rootAlbumsPayload.persistence_backend,
      persistenceSeam: rootAlbumsPayload.persistence_seam,
      viewDataSource: rootAlbumsPayload.view_data_source,
    });
    const runtimePartition = partitionAuthenticatedCoverPreemptionRuntimeLogs(
      testArtifacts.getRuntimeLogs(),
      coverPreemptionWindow,
    );
    expectNoUnexpectedRuntimeFailures(
      runtimePartition.unexpectedRuntimeErrors,
      'the root album browse benchmark',
    );
    rootAlbumBrowseFocusedLocalReport.recordTerminalTimingOutcome(
      ROOT_ALBUM_BROWSE_BUDGET.metricId,
      'rootAlbumBrowseApiMs',
      expectTimingBudget(
        expect.soft,
        rootAlbumBrowseApiMs,
        ROOT_ALBUM_BROWSE_BUDGET,
        'Root album browse UI readiness',
      ),
    );
    rootAlbumBrowseFocusedLocalReport.recordContractCompletion();
  });
});
