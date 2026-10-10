import { expect, test } from '../support/performanceFixtures.js';

import {
  collectResponseTrafficDuringAction,
  expectPostgresLibraryBrowseTelemetry,
  expectTimingBudget,
  measureActionTime,
  measureInteractionToPaint,
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
const ALBUM_DETAILS_CLOSE_BUDGET = Object.freeze(
  performanceTimingBudget('all-artists-local-managed-chrome.albumDetailsCloseMs'),
);
const INTERACTION_BUDGETS = Object.freeze(Object.fromEntries([
  'tagEditorFocusMs',
  'tagEditorTypingMs',
  'tagEditorCancelMs',
  'notificationDrawerOpenMs',
  'notificationDrawerCloseMs',
  'galleryReturnMs',
].map((key) => [key, Object.freeze(performanceTimingBudget(`selected-artist.${key}`))])));
const MAX_INTERACTION_LONG_TASK_MS = 200;
const MAX_MOUNTED_SIDEBAR_ARTISTS = 160;
const MAX_TOTAL_DOM_NODES = 8000;
const MAX_SELECTED_ARTIST_VIEW_DATA_RESPONSES = 1;
const MAX_SELECTED_ARTIST_VIEW_DATA_BYTES = 2 * 1024 * 1024;
const TAG_TYPING_PROBE = 'perf';

test.describe(`${CASE_ID} synthetic-large selected-artist browse`, () => {

  test('Selected artist UI reports library_browse telemetry and timing', async ({
    coverLookupActions,
    galleryActions,
    navigationPanelActions,
    page,
    selectedArtistFocusedLocalReport,
    stepLogger,
    tagEditorActions,
    trackModalActions,
  }) => {
    requirePostgresRuntimeEnv('the selected-artist benchmark');

    await stepLogger.step('Warm the real app root through the visible sidebar and gallery path', async () => {
      await galleryActions.goto('/');
      await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions);
    });

    const domMountMetrics = await stepLogger.step('Assert the hydrated large library keeps sidebar and document mounts bounded', async () => {
      const metrics = await page.evaluate((selectors) => {
        const sidebarList = document.querySelector(selectors.sidebarListSelector);
        return {
          logicalSidebarArtists: Array.isArray(state?.view?.artists_sidebar)
            ? state.view.artists_sidebar.length
            : 0,
          mountedSidebarArtists: document.querySelectorAll(selectors.sidebarArtistSelector).length,
          sidebarVirtualized: sidebarList?.dataset?.sidebarVirtualized === 'true',
          totalDomNodes: document.querySelectorAll('*').length,
        };
      }, {
        sidebarArtistSelector: navigationPanelActions.navigationPanel.sidebarArtistSelector,
        sidebarListSelector: '#sidebar-list',
      });
      expect(metrics.logicalSidebarArtists).toBeGreaterThan(MAX_MOUNTED_SIDEBAR_ARTISTS);
      expect(metrics.sidebarVirtualized, 'Expected the synthetic-large artist sidebar to use its virtual window.').toBe(true);
      expect(metrics.mountedSidebarArtists).toBeGreaterThan(0);
      expect(metrics.mountedSidebarArtists).toBeLessThanOrEqual(MAX_MOUNTED_SIDEBAR_ARTISTS);
      expect(metrics.mountedSidebarArtists).toBeLessThan(metrics.logicalSidebarArtists);
      expect(metrics.totalDomNodes).toBeLessThanOrEqual(MAX_TOTAL_DOM_NODES);
      return metrics;
    });

    let selectedArtist = '';
    const selectedArtistTraffic = await stepLogger.step('Select one sidebar artist and wait for the gallery to switch visibly', async () => (
      collectResponseTrafficDuringAction(
        page,
        (response) => new URL(response.url()).pathname === '/view-data',
        () => measureActionTime(
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
        ),
      )
    ));
    const selectedArtistApiMs = selectedArtistTraffic.result;

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

    const selectedArtistViewDataBytes = selectedArtistTraffic.responses.reduce(
      (total, response) => total + response.bodyBytes,
      0,
    );
    await stepLogger.step('Assert selected-artist navigation does not reload full-library view data', async () => {
      expect(selectedArtistTraffic.requests).toHaveLength(MAX_SELECTED_ARTIST_VIEW_DATA_RESPONSES);
      expect(selectedArtistTraffic.responses).toHaveLength(MAX_SELECTED_ARTIST_VIEW_DATA_RESPONSES);
      const [response] = selectedArtistTraffic.responses;
      const responseUrl = new URL(response.url);
      expect(response.status).toBe(200);
      expect(responseUrl.searchParams.get('artist')).toBe(selectedArtist);
      expect(responseUrl.searchParams.get('omit_sidebar')).toBe('1');
      expect(selectedArtistViewDataBytes).toBeLessThanOrEqual(MAX_SELECTED_ARTIST_VIEW_DATA_BYTES);
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

    const interactionMetrics = {};
    await stepLogger.step('Measure tag editor focus, typing, and immediate cancel paint', async () => {
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen();
      const input = tagEditorActions.tagEditor.albumNameInput;
      interactionMetrics.tagEditorFocusMs = await measureInteractionToPaint(
        page,
        () => input.focus(),
        () => expect(input).toBeFocused(),
      );
      const originalValue = await input.inputValue();
      await input.evaluate((element) => {
        window.__albumHavenTagTypingFocusLosses = 0;
        window.__albumHavenTagTypingFocusAbort = new AbortController();
        element.addEventListener('focusout', () => {
          window.__albumHavenTagTypingFocusLosses += 1;
        }, { signal: window.__albumHavenTagTypingFocusAbort.signal });
      });
      interactionMetrics.tagEditorTypingMs = await measureInteractionToPaint(
        page,
        async () => {
          await input.press('End');
          await input.pressSequentially(TAG_TYPING_PROBE);
          for (let index = 0; index < TAG_TYPING_PROBE.length; index += 1) {
            await input.press('Backspace');
          }
        },
        () => Promise.all([
          expect(input).toBeFocused(),
          expect(input).toHaveValue(originalValue),
        ]),
      );
      expect(await page.evaluate(() => window.__albumHavenTagTypingFocusLosses)).toBe(0);
      await page.evaluate(() => {
        window.__albumHavenTagTypingFocusAbort.abort();
        delete window.__albumHavenTagTypingFocusAbort;
        delete window.__albumHavenTagTypingFocusLosses;
      });
      interactionMetrics.tagEditorCancelMs = await measureInteractionToPaint(
        page,
        () => tagEditorActions.tagEditor.cancelButton.click(),
        () => expect(tagEditorActions.tagEditor.overlay).toBeHidden(),
      );
    });

    const albumDetailsClose = await stepLogger.step('Close the selected-artist album details modal cleanly', async () => (
      measureInteractionToPaint(
        page,
        () => trackModalActions.clickClose(),
        () => trackModalActions.waitForClosed({ timeout: 60000 }),
      )
    ));

    await stepLogger.step('Measure notification drawer and gallery return paint', async () => {
      interactionMetrics.notificationDrawerOpenMs = await measureInteractionToPaint(
        page,
        () => coverLookupActions.coverLookup.drawerButton.click(),
        () => coverLookupActions.coverLookup.waitForDrawerState(true),
      );
      interactionMetrics.notificationDrawerCloseMs = await measureInteractionToPaint(
        page,
        () => coverLookupActions.coverLookup.drawerCloseButton.click(),
        () => coverLookupActions.coverLookup.waitForDrawerState(false),
      );
      interactionMetrics.galleryReturnMs = await measureInteractionToPaint(
        page,
        () => navigationPanelActions.clickAllArtists({ expectArtistQueryCleared: true }),
        () => Promise.all([
          navigationPanelActions.waitForSidebarSelection('', { timeout: 60000 }),
          galleryActions.waitForInitialAllArtistsSections({ timeout: 60000 }),
        ]),
      );
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
      albumDetailsCloseMs: albumDetailsClose.durationMs,
      albumDetailsCloseMaxLongTaskMs: albumDetailsClose.maxLongTaskMs,
      domMountMetrics,
      selectedArtistViewDataRequestCount: selectedArtistTraffic.requests.length,
      selectedArtistViewDataBytes,
      tagEditorTypingCharacterCount: TAG_TYPING_PROBE.length,
      ...Object.fromEntries(Object.entries(interactionMetrics).map(([key, value]) => [key, value.durationMs])),
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
    for (const [key, measurement] of Object.entries(interactionMetrics)) {
      expect.soft(
        measurement.maxLongTaskMs,
        `${key} produced a ${measurement.maxLongTaskMs} ms browser main-thread task.`,
      ).toBeLessThanOrEqual(MAX_INTERACTION_LONG_TASK_MS);
      selectedArtistFocusedLocalReport.recordTerminalTimingOutcome(
        INTERACTION_BUDGETS[key].metricId,
        key,
        expectTimingBudget(expect.soft, measurement.durationMs, INTERACTION_BUDGETS[key], key),
      );
    }
    selectedArtistFocusedLocalReport.recordTerminalTimingOutcome(
      ALBUM_DETAILS_BUDGET.metricId,
      'albumDetailsOpenMs',
      expectTimingBudget(expect.soft, albumDetailsOpenMs, ALBUM_DETAILS_BUDGET, 'Selected artist album details readiness'),
    );
    expect.soft(
      albumDetailsClose.maxLongTaskMs,
      `Closing album details produced a ${albumDetailsClose.maxLongTaskMs} ms browser main-thread task.`,
    ).toBeLessThanOrEqual(MAX_INTERACTION_LONG_TASK_MS);
    expectTimingBudget(
      expect.soft,
      albumDetailsClose.durationMs,
      ALBUM_DETAILS_CLOSE_BUDGET,
      'Selected artist album details close',
    );
    selectedArtistFocusedLocalReport.recordContractCompletion();
  });

  test('FTC-ARTIST-FAMILY-004 keeps the IR8 / Sexoturica split release in the Devin Townsend family', async ({
    artistFamilyActions,
    galleryActions,
    navigationPanelActions,
    page,
    searchToolbarActions,
    stepLogger,
  }) => {
    requirePostgresRuntimeEnv('the Devin Townsend split-release family guard');

    await stepLogger.step('Open Devin Townsend through search and the production family projection', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await searchToolbarActions.search('Devin Townsend');
      await navigationPanelActions.waitForSidebarSelection('Devin Townsend', { timeout: 120000 });
      await artistFamilyActions.waitForViewReady('Devin Townsend', {
        timeout: 120000,
        queryValue: 'Devin Townsend',
      });
    });

    await stepLogger.step('Hydrate the complete known family with every member selected by default', async () => {
      const runtimeView = await readRuntimeView(page);
      expect(runtimeView.related_artists).toEqual(['IR8']);
      await artistFamilyActions.expand();
      const familyTags = await artistFamilyActions.readChipTexts();
      expect(familyTags).toEqual(['Devin Townsend', 'IR8 / Sexoturica']);
      expect(await artistFamilyActions.readChipCountByName('IR8 / Sexoturica')).toBeGreaterThan(0);
      await artistFamilyActions.waitForAllChipsActive(familyTags);
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
