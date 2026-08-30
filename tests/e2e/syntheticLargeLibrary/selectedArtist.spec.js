import { expect, test } from '../support/performanceFixtures.js';

import {
  expectPostgresLibraryBrowseTelemetry,
  expectTimingBudget,
  measureActionTime,
  performanceTimingBudget,
} from '../helpers/index.js';
import {
  flattenAlbums,
  readRuntimeView,
  requirePostgresRuntimeEnv,
  waitForPostgresBrowseWarmRoot,
} from '../helpers/realAppBenchmarkHelpers.js';

const CASE_ID = 'FTC-GALLERY-STARTUP-005Q';
const SELECTED_ARTIST_BUDGET = Object.freeze(
  performanceTimingBudget('selected-artist.selectedArtistApiMs'),
);
const ALBUM_DETAILS_BUDGET = Object.freeze(
  performanceTimingBudget('selected-artist.albumDetailsOpenMs'),
);

test.describe(`${CASE_ID} synthetic-large selected-artist browse`, () => {

  test('Selected artist UI reports library_browse telemetry and timing', async ({
    galleryActions,
    navigationPanelActions,
    page,
    selectedArtistFocusedLocalReport,
    stepLogger,
    trackModalActions,
  }) => {
    requirePostgresRuntimeEnv('the selected-artist benchmark');

    await stepLogger.step('Warm the real app root through the visible sidebar and gallery path', async () => {
      await galleryActions.goto('/');
      await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions);
    });

    let selectedArtist = '';
    const selectedArtistApiMs = await stepLogger.step('Select one sidebar artist and wait for the gallery to switch visibly', async () => (
      measureActionTime(
        async () => {
          selectedArtist = await navigationPanelActions.selectSidebarArtistAt(0);
        },
        async () => {
          await navigationPanelActions.waitForSidebarSelection(selectedArtist, { timeout: 120000 });
          await galleryActions.waitForSelectedArtistGallery(selectedArtist, { timeout: 120000 });
          await galleryActions.waitForVisibleGalleryCoversLoaded({
            minimumCount: 1,
            timeout: 120000,
          });
        },
      )
    ));

    const selectedArtistPayload = await readRuntimeView(page);
    let albums = [];
    let firstAlbumName = '';
    await stepLogger.step('Assert the selected artist UI came from library_browse with playable track paths', async () => {
      expect(selectedArtistPayload, 'Expected the selected-artist runtime view to be available after visible selection.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(selectedArtistPayload, 'full');
      expect(String(selectedArtistPayload.selected_artist || '').trim()).not.toBe('');
      expect(String(selectedArtistPayload.selected_artist || '').trim().toLowerCase()).toBe(selectedArtist.toLowerCase());
      expect(Array.isArray(selectedArtistPayload.artist_groups)).toBe(true);
      expect(Number(selectedArtistPayload.album_count || 0)).toBeGreaterThan(0);
      albums = flattenAlbums(selectedArtistPayload.artist_groups);
      expect(albums.length).toBeGreaterThan(0);
      firstAlbumName = String(albums[0]?.name || '').trim();
      expect(firstAlbumName, 'Expected a visible selected-artist album name to open in the details modal.').not.toBe('');
    });

    let trackModalSummary = null;
    let firstTrackPath = '';
    const albumDetailsOpenMs = await stepLogger.step('Open one selected-artist album details modal and wait for playable tracks', async () => (
      measureActionTime(
        async () => {
          await galleryActions.clickAlbumDetailsByAlbumName(firstAlbumName);
        },
        async () => {
          trackModalSummary = await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
          firstTrackPath = String((await trackModalActions.readTrackAt(0)).path || '');
        },
      )
    ));

    await stepLogger.step('Assert the selected-artist details modal loaded real playable tracks', async () => {
      expect(trackModalSummary?.title, 'Expected the selected-artist album details modal title to load.').not.toBe('');
      expect(trackModalSummary?.trackRows, 'Expected selected-artist album details to render track rows.').toBeGreaterThan(0);
      expect(trackModalSummary?.playButtons, 'Expected selected-artist album details to render play buttons.').toBeGreaterThan(0);
      expect(firstTrackPath, 'Expected at least one playable track path after opening selected-artist album details.').not.toBe('');
    });

    await stepLogger.step('Close the selected-artist album details modal cleanly', async () => {
      await trackModalActions.clickClose();
      await trackModalActions.waitForClosed({ timeout: 60000 });
    });

    await selectedArtistFocusedLocalReport.recordTimingCheckpoint({
      key: 'selected-artist-api',
      label: 'Selected artist UI ready',
      timingMs: selectedArtistApiMs,
      details: {
        phase: 'selected_artist',
        selectedArtist,
        returnedSelectedArtist: selectedArtistPayload.selected_artist,
        albumCount: Number(selectedArtistPayload.album_count || 0),
        artistGroupCount: selectedArtistPayload.artist_groups.length,
        firstAlbumName,
        persistenceBackend: selectedArtistPayload.persistence_backend,
        persistenceSeam: selectedArtistPayload.persistence_seam,
        viewDataSource: selectedArtistPayload.view_data_source,
      },
    });
    await selectedArtistFocusedLocalReport.recordTimingCheckpoint({
      key: 'selected-artist-album-details-open',
      label: 'Selected artist album details opened',
      timingMs: albumDetailsOpenMs,
      details: {
        phase: 'selected_artist_album_details',
        selectedArtist,
        firstAlbumName,
        firstTrackPath,
        trackRows: Number(trackModalSummary?.trackRows || 0),
        playButtons: Number(trackModalSummary?.playButtons || 0),
      },
    });

    selectedArtistFocusedLocalReport.setMetricsPayload({
      selectedArtistApiMs,
      albumDetailsOpenMs,
      selectedArtist,
      returnedSelectedArtist: selectedArtistPayload.selected_artist,
      albumCount: Number(selectedArtistPayload.album_count || 0),
      artistGroupCount: selectedArtistPayload.artist_groups.length,
      firstAlbumName,
      firstTrackPath,
      trackRows: Number(trackModalSummary?.trackRows || 0),
      playButtons: Number(trackModalSummary?.playButtons || 0),
      persistenceBackend: selectedArtistPayload.persistence_backend,
      persistenceSeam: selectedArtistPayload.persistence_seam,
      viewDataSource: selectedArtistPayload.view_data_source,
    });
    selectedArtistFocusedLocalReport.recordTerminalTimingOutcome(
      SELECTED_ARTIST_BUDGET.metricId,
      'selectedArtistApiMs',
      expectTimingBudget(expect.soft, selectedArtistApiMs, SELECTED_ARTIST_BUDGET, 'Selected artist UI readiness'),
    );
    selectedArtistFocusedLocalReport.recordTerminalTimingOutcome(
      ALBUM_DETAILS_BUDGET.metricId,
      'albumDetailsOpenMs',
      expectTimingBudget(expect.soft, albumDetailsOpenMs, ALBUM_DETAILS_BUDGET, 'Selected artist album details readiness'),
    );
    selectedArtistFocusedLocalReport.recordContractCompletion();
  });

  test('FTC-ARTIST-FAMILY-004 keeps the IR8 / Sexoturica split release in the Devin Townsend family', async ({
    artistFamilyActions,
    galleryActions,
    navigationPanelActions,
    stepLogger,
  }) => {
    requirePostgresRuntimeEnv('the Devin Townsend split-release family guard');

    await stepLogger.step('Open Devin Townsend through the production sidebar and family projection', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await navigationPanelActions.selectSidebarArtistByName('Devin Townsend');
      await navigationPanelActions.waitForSidebarSelection('Devin Townsend', { timeout: 120000 });
      await artistFamilyActions.waitForViewReady('Devin Townsend', { timeout: 120000 });
    });

    await stepLogger.step('Label the split-release family tag with its combined artist credit', async () => {
      const familyTags = await artistFamilyActions.readChipTexts();
      expect(familyTags).toContain('IR8 / Sexoturica');
      expect(familyTags).not.toContain('IR8');
    });

    await stepLogger.step('Keep the split release visible under its combined artist heading', async () => {
      await galleryActions.scrollToAlbumUnderHeading(
        'IR8 / Sexoturica',
        'IR8 vs Sexoturica',
      );
      await galleryActions.waitForAlbumVisibleUnderHeading(
        'IR8 / Sexoturica',
        'IR8 vs Sexoturica',
      );
    });
  });
});
