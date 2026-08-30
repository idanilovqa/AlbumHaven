import { expect, test } from '../support/performanceFixtures.js';

import {
  buildBenchmarkValidationPayload,
  evaluateAllArtistsLocalBenchmark,
  evaluateSearchAllArtistsLocalBenchmark,
  expectPostgresLibraryBrowseTelemetry,
  measureActionTime,
  samplePeakMemory,
  logBenchmarkTimingResults,
} from '../helpers/index.js';
import {
  jumpGalleryToMiddle,
  measureAllArtistsReturn,
  measureSearchAllArtistsLoad,
  measureStartupSidebarHydration,
  pickSearchFollowUpArtist,
  readBrowseTelemetry,
  runWithSelectedArtistRequestLifecycle,
  selectSidebarArtistAtAndVerify,
  summarizeSelectedArtistRequestLifecycle,
  waitForActiveBrowseRequestClear,
  waitForBrowseIdle,
  waitForRootStartupSignal,
  waitForSearchBenchmarkWarmRoot,
} from '../helpers/allArtistsResponsivenessHelpers.js';
import {
  requirePostgresRuntimeEnv,
  readRuntimeView,
  waitForPostgresBrowseWarmRoot,
} from '../helpers/realAppBenchmarkHelpers.js';

const SEARCH_CASE_ID = 'FTC-SEARCH-NAV-003A';
const LONG_REAL_APP_ROOT_WARM_TIMEOUT_MS = 240000;
const LONG_REAL_APP_TEST_TIMEOUT_MS = 420000;
const SEARCH_QUERY = 'Ария';
const ARIA_VITALIY_DIRECT_URL = `/?surface=albums&artist=${encodeURIComponent('Ария')}&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals&related_artist=${encodeURIComponent('Виталий Дубинин')}`;
const SEARCH_EXPECTED = Object.freeze({
  primary: 'Ария',
  bi2: 'БИ-2',
  filterArtist: 'Виталий Дубинин',
  helavisa: 'Ария & Хелависа',
  helavisaAlbums: ['No albums'],
  featuredAlbum: 'Tribute To Harley-Davidson',
  featuredTrackIndex: 2,
  featuredTrackTitle: 'Штиль',
  featuredTrackSecondaryArtist: 'feat. U.D.O.',
  familyMembers: ['Ария', 'Кипелов', 'Виталий Дубинин', 'Дубинин & Холстинин'],
  excludedFamilyMembers: ['Ария feat U.D.O.'],
});

test.describe('FTC-GALLERY-STARTUP-005A synthetic-large responsiveness', () => {

  test('All Artists round-trip reports synthetic-data responsiveness and memory timings', async ({
    page,
    galleryActions,
    navigationPanelActions,
    allArtistsLocalReport,
    stepLogger,
    testArtifacts,
    trackModalActions,
  }) => {
    test.setTimeout(LONG_REAL_APP_TEST_TIMEOUT_MS);
    requirePostgresRuntimeEnv('the All Artists round-trip benchmark');

    const startupSidebarHydration = await stepLogger.step('Load the real All Artists view and capture startup responsiveness checkpoints', async () => {
      const startup = await measureStartupSidebarHydration(galleryActions, navigationPanelActions);
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'startup-preview-sidebar',
        label: `Startup preview sidebar count ${startup.previewSidebarCount} appeared`,
        timingMs: startup.previewSidebarMs,
        details: {
          phase: 'startup_hydration',
          startupMode: startup.startupMode,
          sidebarCount: startup.previewSidebarCount,
        },
      });
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'startup-full-sidebar',
        label: `Full sidebar count ${startup.fullSidebarCount} appeared`,
        timingMs: startup.fullSidebarMs,
        details: {
          phase: 'startup_hydration',
          sidebarCount: startup.fullSidebarCount,
        },
      });
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'startup-full-all-artists-count',
        label: `All artists badge reached ${startup.fullVisibleAllArtistsCount}`,
        timingMs: startup.fullCountSynchronizedMs,
        details: {
          phase: 'startup_hydration',
          previewVisibleAllArtistsCount: startup.previewVisibleAllArtistsCount,
          fullVisibleAllArtistsCount: startup.fullVisibleAllArtistsCount,
          fullSidebarCount: startup.fullSidebarCount,
        },
      });
      expect(
        startup.fullVisibleAllArtistsCount,
        'Expected the All artists badge to match the fully hydrated sidebar count on startup.',
      ).toBe(startup.fullSidebarCount);
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'startup-first-albums',
        label: 'Initial All Artists first albums ready',
        timingMs: startup.firstAlbumsMs,
        details: {
          phase: 'startup_hydration',
          readinessBefore: startup.firstAlbumsReadinessBefore,
          readinessAfter: startup.firstAlbumsReadinessAfter,
        },
      });
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'startup-visible-covers',
        label: 'Initial All Artists visible covers ready',
        timingMs: startup.coversMs,
        details: { phase: 'startup_hydration' },
      });
      return startup;
    });

    const initialMemory = await stepLogger.step('Wait for the root view to settle and sample initial idle memory', async () => {
      await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions, {
        timeout: LONG_REAL_APP_ROOT_WARM_TIMEOUT_MS,
        minimumVisibleCovers: 2,
      });
      await page.waitForTimeout(500);
      const memory = await samplePeakMemory(page, { sampleCount: 3, delayMs: 250 });
      allArtistsLocalReport.recordMemoryCheckpoint({
        key: 'startup-idle-memory',
        label: 'Initial All Artists idle memory',
        memorySummary: memory,
        details: {
          phase: 'startup_hydration',
          sampleCount: memory.idleSamples.length,
        },
      });
      return memory;
    });

    await stepLogger.step('Confirm the root All Artists browse is fully idle before selecting the round-trip artist', async () => {
      await waitForBrowseIdle(page, 60000);
    });

    const selectedArtistIndex = 0;
    const selectedArtistName = await stepLogger.step('Read one visible artist target from the All Artists tree', async () => {
      const sidebarArtists = await navigationPanelActions.readSidebarArtistNames();
      const artistName = String(sidebarArtists[selectedArtistIndex] || '').trim();
      expect(
        artistName,
        `Expected a visible artist row at index ${selectedArtistIndex + 1} under All artists.`,
      ).not.toBe('');
      return artistName;
    });

    let selectedArtistRequestLifecycle = null;
    const { selectedArtistSelectionMs, selectedArtistGalleryMs } = await stepLogger.step('Measure the selected artist tree selection and gallery readiness', async () => {
      let selectionMs = 0;
      let galleryMs = 0;
      const lifecycle = await runWithSelectedArtistRequestLifecycle(
        page,
        galleryActions,
        navigationPanelActions,
        selectedArtistName,
        async () => {
          selectionMs = await measureActionTime(
            async () => {
              await selectSidebarArtistAtAndVerify(
                navigationPanelActions,
                selectedArtistIndex,
                selectedArtistName,
              );
            },
            async () => {
              await navigationPanelActions.waitForSidebarSelection(selectedArtistName, { timeout: 60000 });
            },
          );

          galleryMs = await measureActionTime(
            async () => {},
            async () => {
              await galleryActions.waitForSelectedArtistGallery(selectedArtistName, { timeout: 60000 });
              await galleryActions.waitForVisibleGalleryCoversLoaded({
                minimumCount: 1,
                timeout: 60000,
              });
            },
          );
        },
      );
      selectedArtistRequestLifecycle = lifecycle;
      testArtifacts.queueJsonAttachment('selected-artist-request-lifecycle', lifecycle);
      allArtistsLocalReport.recordTextCheckpoint({
        key: 'selected-artist-request-lifecycle',
        label: `Artist[10] "${selectedArtistName}" request lifecycle`,
        valueText: summarizeSelectedArtistRequestLifecycle(lifecycle),
        details: lifecycle,
      });
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'selected-artist-selection-visible',
        label: `Artist[10] "${selectedArtistName}" tree selection visible`,
        timingMs: selectionMs,
        details: {
          phase: 'selected_artist',
          selectedArtistIndex: selectedArtistIndex + 1,
          selectedArtistName,
        },
      });
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'selected-artist-gallery-ready',
        label: `Artist[10] "${selectedArtistName}" gallery ready`,
        timingMs: galleryMs,
        details: {
          phase: 'selected_artist',
          selectedArtistIndex: selectedArtistIndex + 1,
          selectedArtistName,
        },
      });
      return {
        selectedArtistSelectionMs: selectionMs,
        selectedArtistGalleryMs: galleryMs,
      };
    });
    const selectedArtistBrowseTelemetry = await readBrowseTelemetry(page);
    await stepLogger.step('Assert the selected-artist round-trip stayed on the Postgres browse seam', async () => {
      const selectedArtistView = await readRuntimeView(page);
      expect(selectedArtistView, 'Expected the selected-artist runtime view to be readable.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(selectedArtistView, 'full');
      expect(String(selectedArtistView.selected_artist || '').trim()).toBe(selectedArtistName);
    });

    const {
      allArtistsSelectionMs,
      allArtistsFirstAlbumsMs,
      allArtistsCoversMs,
      allArtistsReturnMemory,
    } = await stepLogger.step('Return to All Artists and record responsiveness plus memory after the round-trip', async () => {
      const allArtistsReturn = await measureAllArtistsReturn(galleryActions, navigationPanelActions);
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'all-artists-selection-visible',
        label: 'All artists selection visible',
        timingMs: allArtistsReturn.selectionMs,
        details: { phase: 'all_artists_return' },
      });
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'all-artists-first-albums-visible',
        label: 'All artists first albums visible again',
        timingMs: allArtistsReturn.firstAlbumsMs,
        details: { phase: 'all_artists_return' },
      });
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'all-artists-visible-covers',
        label: 'All artists visible covers ready again',
        timingMs: allArtistsReturn.coversMs,
        details: { phase: 'all_artists_return' },
      });
      await page.waitForTimeout(750);
      const memory = await samplePeakMemory(page, { sampleCount: 3, delayMs: 250 });
      allArtistsLocalReport.recordMemoryCheckpoint({
        key: 'all-artists-return-memory',
        label: 'All artists idle memory after return',
        memorySummary: memory,
        details: {
          phase: 'all_artists_return',
          sampleCount: memory.idleSamples.length,
        },
      });
      return {
        allArtistsSelectionMs: allArtistsReturn.selectionMs,
        allArtistsFirstAlbumsMs: allArtistsReturn.firstAlbumsMs,
        allArtistsCoversMs: allArtistsReturn.coversMs,
        allArtistsReturnMemory: memory,
      };
    });

    await stepLogger.step('Confirm the returned All Artists browse is fully idle before the deep jump scroll', async () => {
      await waitForBrowseIdle(page, 60000);
    });

    const {
      jumpScroll,
      jumpScrollMemory,
      jumpScrollCoversReadyMs,
    } = await stepLogger.step('Jump deep into the gallery and capture scroll-state checkpoints', async () => {
      const jumpState = await jumpGalleryToMiddle(galleryActions);
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'jump-scroll-settled',
        label: 'Jump-scrolled to middle',
        timingMs: jumpState.jumpSettledMs,
        details: { phase: 'jump_scroll' },
      });
      allArtistsLocalReport.recordTextCheckpoint({
        key: 'jump-scroll-visible-artists',
        label: 'Visible artists after jump',
        valueText: jumpState.visibleArtists.slice(0, 6).join(' | '),
        details: {
          phase: 'jump_scroll',
          visibleArtistCount: jumpState.visibleArtistCount,
        },
      });
      allArtistsLocalReport.recordTextCheckpoint({
        key: 'jump-scroll-position',
        label: 'Jump scroll position',
        valueText: `${jumpState.scrollTop} / ${jumpState.maxScrollTop}`,
        details: { phase: 'jump_scroll' },
      });
      const memory = await samplePeakMemory(page, { sampleCount: 3, delayMs: 250 });
      allArtistsLocalReport.recordMemoryCheckpoint({
        key: 'jump-scroll-memory',
        label: 'Idle memory right after jump',
        memorySummary: memory,
        details: {
          phase: 'jump_scroll',
          sampleCount: memory.idleSamples.length,
        },
      });
      const coversReadyMs = jumpState.jumpSettledMs + (await measureActionTime(
        async () => {},
        async () => {
          await galleryActions.waitForVisibleGalleryCoversLoaded({
            minimumCount: 2,
            timeout: 30000,
          });
        },
      ));
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'jump-scroll-visible-covers',
        label: 'Visible covers ready after jump',
        timingMs: coversReadyMs,
        details: { phase: 'jump_scroll' },
      });
      return {
        jumpScroll: jumpState,
        jumpScrollMemory: memory,
        jumpScrollCoversReadyMs: coversReadyMs,
      };
    });

    await page.waitForTimeout(750);
    await waitForActiveBrowseRequestClear(page, 15000);

    const visibleIndexes = await stepLogger.step('Collect visible album-detail targets after the deep scroll', async () => (
      (async () => {
        await waitForBrowseIdle(page, 60000);
        return galleryActions.readVisibleAlbumDetailButtonIndexes();
      })()
    ));
    expect(visibleIndexes.length, 'Expected at least one visible album after deeper All artists scrolling.').toBeGreaterThan(0);
    const stableVisibleIndex = visibleIndexes[0];
    stepLogger.note(`Using visible album button index ${stableVisibleIndex} for the modal round-trip`, 2);

    const {
      albumDetailsOpenMs,
      albumDetailsCloseMs,
      trackModalSummary,
      finalMemory,
    } = await stepLogger.step('Open one visible album details modal, verify it, and close it cleanly', async () => {
      const openMs = await measureActionTime(
        async () => {
          await galleryActions.clickAlbumDetailsAt(stableVisibleIndex);
        },
        async () => {
          await trackModalActions.waitForReady({ timeout: 60000 });
        },
      );
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'album-details-open',
        label: 'Album details opened',
        timingMs: openMs,
        details: {
          phase: 'album_details',
          stableVisibleIndex,
        },
      });

      const summary = await trackModalActions.readSummary();
      const closeMs = await measureActionTime(
        async () => {
          await trackModalActions.clickClose();
        },
        async () => {
          await trackModalActions.waitForClosed();
        },
      );
      await allArtistsLocalReport.recordTimingCheckpoint({
        key: 'album-details-close',
        label: 'Album details closed',
        timingMs: closeMs,
        details: {
          phase: 'album_details',
          stableVisibleIndex,
        },
      });

      const memory = await samplePeakMemory(page, { sampleCount: 3, delayMs: 250 });
      allArtistsLocalReport.recordMemoryCheckpoint({
        key: 'final-idle-memory',
        label: 'Peak idle memory after modal close',
        memorySummary: memory,
        details: {
          phase: 'album_details',
          sampleCount: memory.idleSamples.length,
          stableVisibleIndex,
        },
      });

      expect(summary.title, 'Expected the album details modal title to load.').not.toBe('');
      expect(summary.footer, 'Expected the album details modal footer to include album length.').toContain('Length');
      expect(summary.playButtons, 'Expected per-track play buttons to render in the album details modal.').toBeGreaterThan(0);
      expect(summary.trackRows, 'Expected the album details modal tracklist to render.').toBeGreaterThan(0);

      return {
        albumDetailsOpenMs: openMs,
        albumDetailsCloseMs: closeMs,
        trackModalSummary: summary,
        finalMemory: memory,
      };
    });

    const metricsPayload = {
      startupSidebarHydration,
      selectedArtistRequestLifecycle,
      selectedArtistBrowseTelemetry,
      selectedArtistIndex: selectedArtistIndex + 1,
      selectedArtistName,
      selectedArtistSelectionMs,
      selectedArtistGalleryMs,
      allArtistsSelectionMs,
      allArtistsFirstAlbumsMs,
      allArtistsCoversMs,
      initialMemory,
      allArtistsReturnMemory,
      jumpScroll,
      jumpScrollMemory,
      jumpScrollCoversReadyMs,
      stableVisibleIndex,
      albumDetailsOpenMs,
      albumDetailsCloseMs,
      trackModalSummary,
      finalMemory,
    };

    const benchmarkEvaluation = evaluateAllArtistsLocalBenchmark(metricsPayload);
    logBenchmarkTimingResults(benchmarkEvaluation);
    allArtistsLocalReport.setMetricsPayload({
      ...metricsPayload,
      benchmarkValidation: buildBenchmarkValidationPayload(benchmarkEvaluation),
    });
    expect(
      benchmarkEvaluation.failures,
      benchmarkEvaluation.failures.join('\n'),
    ).toEqual([]);
  });
});

test.describe(`${SEARCH_CASE_ID} synthetic-large responsiveness`, () => {

  test('FTC-SEARCH-NAV-005 direct-loads a filtered Ария gallery with the complete Artist Family labels', async ({
    artistFamilyActions,
    galleryActions,
    navigationPanelActions,
    searchToolbarActions,
    stepLogger,
  }) => {
    test.setTimeout(LONG_REAL_APP_TEST_TIMEOUT_MS);
    requirePostgresRuntimeEnv('the direct-loaded Ария family-filter regression');

    await stepLogger.step('Open the filtered Ария and Виталий Дубинин URL as a new document', async () => {
      await galleryActions.goto(ARIA_VITALIY_DIRECT_URL);
      await searchToolbarActions.waitForVisible({ timeout: 60000 });
      await searchToolbarActions.waitForQuery('', { timeout: 60000 });
      await navigationPanelActions.waitForSidebarSelection(SEARCH_EXPECTED.primary, { timeout: 60000 });
      await artistFamilyActions.waitForViewReady(SEARCH_EXPECTED.primary, { timeout: 60000 });
      await artistFamilyActions.expand();
    });

    await stepLogger.step('Keep every Ария family label while applying only the requested family filter', async () => {
      expect(await artistFamilyActions.readChipTexts()).toEqual(
        expect.arrayContaining([
          ...SEARCH_EXPECTED.familyMembers,
          SEARCH_EXPECTED.helavisa,
        ]),
      );
      for (const featuredArtist of SEARCH_EXPECTED.excludedFamilyMembers) {
        expect(await artistFamilyActions.readChipTexts()).not.toContain(featuredArtist);
      }
      await artistFamilyActions.waitForChipActive(SEARCH_EXPECTED.filterArtist, true);
      await galleryActions.waitForOnlyArtistHeadings([SEARCH_EXPECTED.filterArtist], {
        timeout: 60000,
      });
    });
  });

  test('FTC-SEARCH-NAV-026 clears an Ария search after filtering to Виталий Дубинин without remounting the gallery or reducing Artist Family', async ({
    artistFamilyActions,
    galleryActions,
    navigationPanelActions,
    page,
    searchToolbarActions,
    stepLogger,
  }) => {
    test.setTimeout(LONG_REAL_APP_TEST_TIMEOUT_MS);
    requirePostgresRuntimeEnv('the Ария filtered-family clear regression');
    let defaultArtistHeadings = [];
    let rootArtistNames = [];
    let restoredRootArtistNames = [];
    let rootArtistCount = 0;
    await galleryActions.goto();
    await searchToolbarActions.waitForVisible({ timeout: 60000 });
    await waitForRootStartupSignal(galleryActions, navigationPanelActions, {
      timeout: 60000,
    });
    await waitForSearchBenchmarkWarmRoot(
      galleryActions,
      navigationPanelActions,
      LONG_REAL_APP_ROOT_WARM_TIMEOUT_MS,
    );
    await waitForBrowseIdle(page, LONG_REAL_APP_ROOT_WARM_TIMEOUT_MS);
    rootArtistNames = await navigationPanelActions.readRuntimeSidebarArtistNames();
    rootArtistCount = await navigationPanelActions.readAllArtistsVisibleCount();
    expect(rootArtistNames.length).toBeGreaterThan(SEARCH_EXPECTED.familyMembers.length);
    expect(rootArtistCount).toBeGreaterThanOrEqual(rootArtistNames.length);
    restoredRootArtistNames = rootArtistNames.includes(SEARCH_EXPECTED.primary)
      ? rootArtistNames
      : [SEARCH_EXPECTED.primary, ...rootArtistNames];

    await stepLogger.step('Search for Ария and filter its family gallery to Виталий Дубинин', async () => {
      await searchToolbarActions.search(SEARCH_QUERY);
      await searchToolbarActions.waitForQuery(SEARCH_QUERY, { timeout: 60000 });
      await navigationPanelActions.waitForSidebarSelection(SEARCH_EXPECTED.primary, { timeout: 60000 });
      await artistFamilyActions.waitForViewReady(SEARCH_EXPECTED.primary, {
        queryValue: SEARCH_QUERY,
        timeout: 60000,
      });
      await artistFamilyActions.expand();
      expect(await artistFamilyActions.readChipTexts()).toEqual(
        expect.arrayContaining(SEARCH_EXPECTED.familyMembers),
      );
      defaultArtistHeadings = await galleryActions.readArtistHeadings();
      expect(defaultArtistHeadings).toEqual([SEARCH_EXPECTED.primary]);
      await artistFamilyActions.clickChipByName(SEARCH_EXPECTED.filterArtist);
      await artistFamilyActions.waitForChipActive(SEARCH_EXPECTED.filterArtist, true);
      await galleryActions.waitForOnlyArtistHeadings([SEARCH_EXPECTED.filterArtist], {
        timeout: 60000,
      });
      expect(await navigationPanelActions.readRuntimeSidebarArtistNames()).not.toEqual(rootArtistNames);
    });

    await stepLogger.step('Clear search without changing the filtered gallery or complete Artist Family', async () => {
      const familyChipTexts = await artistFamilyActions.readChipTexts();
      const filteredArtistHeadings = await galleryActions.readArtistHeadings();
      expect(familyChipTexts).toEqual(expect.arrayContaining(SEARCH_EXPECTED.familyMembers));
      expect(filteredArtistHeadings).toEqual([SEARCH_EXPECTED.filterArtist]);
      await galleryActions.prepareMountedGalleryContinuityCheckpoint({
        minimumDecodedCovers: 1,
      });

      const transition = await searchToolbarActions.clearSearchAndObserveStableGallery();
      expect(transition).toEqual(expect.objectContaining({
        cardContentChanged: false,
        cardNodesChanged: false,
        familyChipContentChanged: false,
        familyChipNodesChanged: false,
        familyControlsHidden: false,
        familyListReplaced: false,
        familyMutationCount: 0,
        familyPanelContentChanged: false,
        familyPanelReplaced: false,
        familyScrollChanged: false,
        familySelectionChanged: false,
        familyToggleReplaced: false,
        familyViewDataRequests: [],
        galleryContentChanged: false,
        galleryReplaced: false,
        galleryScrollChanged: false,
        loaderActivated: false,
        spinnerActivated: false,
        viewDataRequests: [],
      }));
      expect(await artistFamilyActions.readChipTexts()).toEqual(familyChipTexts);
      expect(await galleryActions.readArtistHeadings()).toEqual(filteredArtistHeadings);
      await artistFamilyActions.waitForChipActive(SEARCH_EXPECTED.filterArtist, true);
      await navigationPanelActions.waitForSidebarSelection(SEARCH_EXPECTED.primary, { timeout: 60000 });
      await searchToolbarActions.waitForQuery('', { timeout: 60000 });
      await navigationPanelActions.waitForAllArtistsVisibility(true, { timeout: 60000 });
      await navigationPanelActions.waitForRuntimeSidebarArtistNames(restoredRootArtistNames, { timeout: 60000 });
      await navigationPanelActions.waitForActiveSelectionInViewport({ timeout: 60000 });
      expect(await navigationPanelActions.readAllArtistsVisibleCount()).toBe(rootArtistCount);
    });

    await stepLogger.step('Unselect Виталий Дубинин without showing a loader or requesting the default Ария gallery again', async () => {
      const transition = await searchToolbarActions.observeMountedGalleryTransition(
        () => artistFamilyActions.clickChipByName(SEARCH_EXPECTED.filterArtist),
        async () => {
          await artistFamilyActions.waitForChipActive(SEARCH_EXPECTED.filterArtist, false);
          await galleryActions.waitForDisplayedArtistSections(defaultArtistHeadings, {
            timeout: 60000,
          });
        },
      );
      expect(transition).toEqual(expect.objectContaining({
        familyPanelReplaced: false,
        familyViewDataRequests: [],
        galleryReplaced: false,
        libraryLoaderMutationCount: 0,
        loaderActivated: false,
        spinnerActivated: false,
        spinnerMutationCount: 0,
        viewDataRequests: [],
      }));
      expect(await galleryActions.readArtistHeadings()).toEqual(defaultArtistHeadings);
      expect(await artistFamilyActions.readChipTexts()).toEqual(
        expect.arrayContaining(SEARCH_EXPECTED.familyMembers),
      );
      expect(await navigationPanelActions.readRuntimeSidebarArtistNames()).toEqual(restoredRootArtistNames);
      expect(await navigationPanelActions.readAllArtistsVisibleCount()).toBe(rootArtistCount);
    });
  });

  test(`${SEARCH_CASE_ID} multi-family search keeps search-scoped All artists and follow-up tree selection responsive on synthetic data`, async ({
    artistFamilyActions,
    galleryActions,
    navigationPanelActions,
    page,
    searchToolbarActions,
    searchAllArtistsLocalReport,
    stepLogger,
    trackModalActions,
  }) => {
    test.setTimeout(LONG_REAL_APP_TEST_TIMEOUT_MS);
    requirePostgresRuntimeEnv('the search-scoped All Artists benchmark');
    await galleryActions.goto();
    await searchToolbarActions.waitForVisible({ timeout: 60000 });
    await waitForRootStartupSignal(galleryActions, navigationPanelActions, {
      timeout: 60000,
    });

    await stepLogger.step('Let the root browse finish warming before measuring the search path', async () => {
      await waitForSearchBenchmarkWarmRoot(
        galleryActions,
        navigationPanelActions,
        LONG_REAL_APP_ROOT_WARM_TIMEOUT_MS,
      );
      await waitForBrowseIdle(page, LONG_REAL_APP_ROOT_WARM_TIMEOUT_MS);
    });

    const searchAutoSelectionMs = await stepLogger.step('Search for Ария and wait for the filtered tree to auto-select it', async () => (
      measureActionTime(
        async () => {
          await searchToolbarActions.search(SEARCH_QUERY);
        },
        async () => {
          await searchToolbarActions.waitForQuery(SEARCH_QUERY, { timeout: 60000 });
          await navigationPanelActions.waitForSidebarSelection(SEARCH_EXPECTED.primary, { timeout: 60000 });
        },
      )
    ));
    await searchAllArtistsLocalReport.recordTimingCheckpoint({
      key: 'search-auto-selection',
      label: 'Search auto-selected Ария in the filtered tree',
      timingMs: searchAutoSelectionMs,
    });

    const searchGalleryReadyMs = await stepLogger.step('Wait for the Ария gallery, visible covers, and family box after search', async () => (
      measureActionTime(
        async () => {},
        async () => {
          await galleryActions.waitForSelectedArtistGallery(SEARCH_EXPECTED.primary, {
            timeout: 60000,
            queryValue: SEARCH_QUERY,
          });
          await galleryActions.waitForVisibleGalleryCoversLoaded({ minimumCount: 1, timeout: 60000 });
        },
      )
    ));
    await searchAllArtistsLocalReport.recordTimingCheckpoint({
      key: 'search-gallery-ready',
      label: 'Search-loaded Ария gallery ready',
      timingMs: searchGalleryReadyMs,
    });

    await stepLogger.step('Assert the search-loaded artist view stayed on the Postgres browse seam', async () => {
      const searchView = await readRuntimeView(page);
      expect(searchView, 'Expected the search runtime view to be readable after the search-loaded gallery flow.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(searchView, 'full');
      expect(String(searchView.query || '').trim()).toBe(SEARCH_QUERY);
      expect(String(searchView.selected_artist || '').trim()).toBe(SEARCH_EXPECTED.primary);
    });

    const filteredSidebarArtists = await stepLogger.step('Verify the filtered tree keeps All artists and the expected live artist names', async () => {
      const sidebarArtists = await navigationPanelActions.readSidebarArtistNames();
      expect(sidebarArtists).toContain(SEARCH_EXPECTED.primary);
      expect(sidebarArtists).toContain(SEARCH_EXPECTED.bi2);
      const allArtistsCount = await navigationPanelActions.readAllArtistsCount();
      expect(allArtistsCount, 'Expected the filtered tree to expose the search-only All artists row.').toBeGreaterThan(0);
      return sidebarArtists;
    });

    await stepLogger.step('Expand Artist Family and confirm the expected Ария family members are present', async () => {
    });

    const searchIdleMemory = await stepLogger.step('Sample idle memory after the search-loaded Ария view settles', async () => (
      searchAllArtistsLocalReport.recordPeakMemoryCheckpoint({
        key: 'search-idle-memory',
        label: 'Search-loaded Ария idle memory',
        details: {
          phase: 'search_loaded_aria',
        },
      })
    ));

    await stepLogger.step('Assert the search-loaded artist family chips stay present', async () => {
      await artistFamilyActions.expand();
      const chipTexts = await artistFamilyActions.readChipTexts();
      expect(chipTexts).toEqual(expect.arrayContaining(SEARCH_EXPECTED.familyMembers));
      for (const featuredArtist of SEARCH_EXPECTED.excludedFamilyMembers) {
        expect(chipTexts).not.toContain(featuredArtist);
      }
      await artistFamilyActions.waitForPrimaryChipActive(SEARCH_EXPECTED.primary);
    });

    await stepLogger.step('Keep the real Ария featured-track credit visible in Album Details', async () => {
      await galleryActions.clickAlbumDetailsByAlbumName(SEARCH_EXPECTED.featuredAlbum);
      await trackModalActions.waitForLoadedSummary();
      const visibleCredit = await trackModalActions.readTrackCreditAt(
        SEARCH_EXPECTED.featuredTrackIndex,
      );
      expect(visibleCredit).toEqual({
        title: SEARCH_EXPECTED.featuredTrackTitle,
        secondaryArtist: SEARCH_EXPECTED.featuredTrackSecondaryArtist,
      });
      await trackModalActions.close();
    });

    await stepLogger.step('Filter to Ария & Хелависа without leaking another Ария collaboration', async () => {
      await artistFamilyActions.clickChipByName(SEARCH_EXPECTED.helavisa);
      await artistFamilyActions.waitForChipActive(SEARCH_EXPECTED.helavisa);
      await galleryActions.waitForOnlyArtistHeadings([SEARCH_EXPECTED.helavisa]);
      expect(await galleryActions.readArtistHeadings()).toEqual([SEARCH_EXPECTED.helavisa]);
      expect(await galleryActions.readAlbumNamesByHeading(SEARCH_EXPECTED.helavisa)).toEqual(
        SEARCH_EXPECTED.helavisaAlbums,
      );
      await galleryActions.waitForAlbumHidden(SEARCH_EXPECTED.featuredAlbum);

      await artistFamilyActions.clickChipByName(SEARCH_EXPECTED.helavisa);
      await artistFamilyActions.waitForChipActive(SEARCH_EXPECTED.helavisa, false);
    });

    await stepLogger.step('Confirm the search-loaded artist browse is fully idle before reopening search-scoped All artists', async () => {
      await waitForBrowseIdle(page, 60000);
    });

    const { allArtistsSelectionMs, allArtistsGalleryReadyMs } = await stepLogger.step('Click the search-scoped All artists row and record readiness', async () => {
      const allArtistsLoad = await measureSearchAllArtistsLoad(
        galleryActions,
        navigationPanelActions,
        SEARCH_QUERY,
      );
      await searchAllArtistsLocalReport.recordTimingCheckpoint({
        key: 'search-all-artists-selection-visible',
        label: 'Search-scoped All artists selection visible',
        timingMs: allArtistsLoad.selectionMs,
        details: {
          phase: 'search_all_artists',
          query: SEARCH_QUERY,
        },
      });
      await searchAllArtistsLocalReport.recordTimingCheckpoint({
        key: 'search-all-artists-gallery-ready',
        label: 'Search-scoped All artists gallery ready',
        timingMs: allArtistsLoad.galleryReadyMs,
        details: {
          phase: 'search_all_artists',
          query: SEARCH_QUERY,
        },
      });
      return {
        allArtistsSelectionMs: allArtistsLoad.selectionMs,
        allArtistsGalleryReadyMs: allArtistsLoad.galleryReadyMs,
      };
    });

    await stepLogger.step('Assert the search-scoped All artists view stayed on the Postgres browse seam', async () => {
      const allArtistsView = await readRuntimeView(page);
      expect(allArtistsView, 'Expected the search-scoped All artists runtime view to be readable.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(allArtistsView, 'full');
      expect(String(allArtistsView.query || '').trim()).toBe(SEARCH_QUERY);
    });

    const {
      jumpScroll,
      jumpScrollMemory,
      jumpScrollCoversReadyMs,
    } = await stepLogger.step('Jump-scroll the search-scoped All artists gallery to the middle and capture memory', async () => {
      const jumpState = await jumpGalleryToMiddle(galleryActions);
      await searchAllArtistsLocalReport.recordTimingCheckpoint({
        key: 'search-all-artists-jump-scroll-settled',
        label: 'Search-scoped All artists jump-scroll settled',
        timingMs: jumpState.jumpSettledMs,
        details: {
          phase: 'search_all_artists_jump_scroll',
          query: SEARCH_QUERY,
        },
      });
      searchAllArtistsLocalReport.recordTextCheckpoint({
        key: 'search-all-artists-jump-scroll-visible-artists',
        label: 'Visible artists after search-scoped jump scroll',
        valueText: jumpState.visibleArtists.slice(0, 6).join(' | '),
        details: {
          phase: 'search_all_artists_jump_scroll',
          visibleArtistCount: jumpState.visibleArtistCount,
        },
      });
      const memory = await samplePeakMemory(page, { sampleCount: 3, delayMs: 250 });
      searchAllArtistsLocalReport.recordMemoryCheckpoint({
        key: 'search-all-artists-jump-scroll-memory',
        label: 'Search-scoped All artists jump-scroll idle memory',
        memorySummary: memory,
        details: {
          phase: 'search_all_artists_jump_scroll',
          sampleCount: memory.idleSamples.length,
        },
      });
      const coversReadyMs = jumpState.jumpSettledMs + (await measureActionTime(
        async () => {},
        async () => {
          await waitForBrowseIdle(page, 30000);
        },
      ));
      await searchAllArtistsLocalReport.recordTimingCheckpoint({
        key: 'search-all-artists-jump-scroll-visible-covers',
        label: 'Search-scoped All artists visible covers ready after jump scroll',
        timingMs: coversReadyMs,
        details: {
          phase: 'search_all_artists_jump_scroll',
        },
      });
      return {
        jumpScroll: jumpState,
        jumpScrollMemory: memory,
        jumpScrollCoversReadyMs: coversReadyMs,
      };
    });

    const { bi2SelectionMs, bi2GalleryReadyMs, finalMemory, followUpArtist } = await stepLogger.step('Click БИ-2 in the filtered tree and verify the gallery plus idle memory', async () => {
      const followUpArtist = pickSearchFollowUpArtist(filteredSidebarArtists, SEARCH_EXPECTED.bi2);
      expect(followUpArtist, 'Expected the synthetic-data filtered tree to include the required follow-up artist.').toBe(SEARCH_EXPECTED.bi2);
      const selectionMs = await measureActionTime(
        async () => {
          await navigationPanelActions.selectSidebarArtistByName(followUpArtist);
        },
        async () => {
          await navigationPanelActions.waitForSidebarSelection(followUpArtist, { timeout: 60000 });
        },
      );
      await searchAllArtistsLocalReport.recordTimingCheckpoint({
        key: 'tree-bi2-selection',
        label: 'Filtered tree selected БИ-2',
        timingMs: selectionMs,
        details: {
          phase: 'bi2_tree_selection',
          artist: followUpArtist,
        },
      });

      const galleryMs = await measureActionTime(
        async () => {},
        async () => {
          await galleryActions.waitForSelectedArtistGallery(followUpArtist, {
            timeout: 60000,
          });
          await galleryActions.waitForVisibleGalleryCoversLoaded({ minimumCount: 1, timeout: 60000 });
        },
      );
      await searchAllArtistsLocalReport.recordTimingCheckpoint({
        key: 'tree-bi2-gallery-ready',
        label: 'БИ-2 gallery ready from the filtered tree',
        timingMs: galleryMs,
        details: {
          phase: 'bi2_tree_selection',
          artist: followUpArtist,
        },
      });

      const memory = await samplePeakMemory(page, { sampleCount: 3, delayMs: 250 });
      searchAllArtistsLocalReport.recordMemoryCheckpoint({
        key: 'final-idle-memory',
        label: 'Idle memory after the БИ-2 follow-up selection',
        memorySummary: memory,
        details: {
          phase: 'bi2_tree_selection',
          sampleCount: memory.idleSamples.length,
          artist: followUpArtist,
        },
      });

      return {
        bi2SelectionMs: selectionMs,
        bi2GalleryReadyMs: galleryMs,
        finalMemory: memory,
        followUpArtist,
      };
    });
    await stepLogger.step('Assert the follow-up tree selection stayed on the Postgres browse seam', async () => {
      const followUpView = await readRuntimeView(page);
      expect(followUpView, 'Expected the follow-up artist runtime view to be readable.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(followUpView, 'full');
      expect(String(followUpView.selected_artist || '').trim()).toBe(followUpArtist);
    });

    const rawMetrics = {
      searchAutoSelectionMs,
      searchGalleryReadyMs,
      searchIdleMemory,
      allArtistsSelectionMs,
      allArtistsGalleryReadyMs,
      jumpScroll,
      jumpScrollMemory,
      jumpScrollCoversReadyMs,
      bi2SelectionMs,
      bi2GalleryReadyMs,
      finalMemory,
      followUpArtist,
    };

    const benchmarkEvaluation = evaluateSearchAllArtistsLocalBenchmark(rawMetrics);
    logBenchmarkTimingResults(benchmarkEvaluation);
    searchAllArtistsLocalReport.setMetricsPayload({
      ...rawMetrics,
      benchmarkValidation: buildBenchmarkValidationPayload(benchmarkEvaluation),
      benchmark: benchmarkEvaluation.benchmark,
      benchmarkResults: benchmarkEvaluation.results,
      benchmarkFailures: benchmarkEvaluation.failures,
    });
    expect(benchmarkEvaluation.failures, benchmarkEvaluation.failures.join('\n')).toEqual([]);
  });
});
