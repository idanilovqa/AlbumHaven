import { expect, test } from '../support/performanceFixtures.js';

import {
  buildBenchmarkValidationPayload,
  evaluateArtistFamilyLocalBenchmark,
  expectPostgresLibraryBrowseTelemetry,
  measureActionTime,
  logBenchmarkTimingResults,
} from '../helpers/index.js';
import {
  enterAndWaitForPostgresBrowseWarmRoot,
  readRuntimeView,
  requirePostgresRuntimeEnv,
} from '../helpers/realAppBenchmarkHelpers.js';

const CASE_ID = 'FTC-SEARCH-NAV-005A';
const LONG_REAL_APP_TEST_TIMEOUT_MS = 420000;
const SEARCH_QUERY = 'Neal Morse';
const RESONANCE_ALBUM = 'No Hill For A Climber';
const EXPECTED_FAMILY_TAG_REFS = Object.freeze({
  primary: 'artist-family:nealmorse',
  resonance: 'artist-family:nealmorsetheresonance',
});
const EXPECTED_FAMILY = Object.freeze({
  primary: 'Neal Morse',
  cosmic: 'Cosmic Cathedral',
  dvirgilio: "D'virgilio, Morse & Jennings",
  mpg: 'Morse Portnoy George',
  resonance: 'Neal Morse & The Resonance',
  nealMorseBand: 'The Neal Morse Band',
  progWorld: 'The Prog World Orchestra',
  combinedPrimaryAndResonance: 'Neal Morse / Neal Morse & The Resonance',
});
const EXPECTED_NUMERIC_ARTIST_FAMILY = Object.freeze({
  primary: '3',
  elpChip: 'Emerson, Lake & Palmer',
  elpGallery: 'Emerson, Lake & Palmer',
  elpGalleryDisplay: 'Emerson, Lake & Palmer',
  powell: 'Emerson, Lake & Powell',
});

test.describe(`${CASE_ID} synthetic-large artist family responsiveness`, () => {

  test('Neal Morse scrolling keeps each displayed artist heading unique before and after filtering', async ({
    artistFamilyActions,
    artistPageSettingsActions,
    galleryActions,
    navigationPanelActions,
    page,
    scanPageActions,
    searchToolbarActions,
    stepLogger,
  }) => {
    test.setTimeout(LONG_REAL_APP_TEST_TIMEOUT_MS);

    requirePostgresRuntimeEnv('the Neal Morse duplicate-heading regression');
    await galleryActions.goto();
    await searchToolbarActions.waitForVisible({ timeout: 60000 });
    await navigationPanelActions.waitForSidebarPreviewHydrated({ timeout: 60000 });
    await enterAndWaitForPostgresBrowseWarmRoot(
      page,
      galleryActions,
      navigationPanelActions,
      scanPageActions,
      { timeout: 120000 },
    );

    await stepLogger.step('Load the unfiltered Neal Morse family gallery', async () => {
      await searchToolbarActions.search(SEARCH_QUERY);
      await searchToolbarActions.waitForQuery(SEARCH_QUERY, { timeout: 120000 });
      await navigationPanelActions.waitForSidebarSelection(EXPECTED_FAMILY.primary, { timeout: 120000 });
      await artistFamilyActions.waitForViewReady(EXPECTED_FAMILY.primary, {
        timeout: 120000,
        queryValue: SEARCH_QUERY,
      });
    });

    await stepLogger.step('Keep Neal Morse and The Resonance as distinct family tags with one authoritative album owner', async () => {
      const runtimeView = await readRuntimeView(page);
      expect(runtimeView.artist_family_filters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          family_tag_ref: EXPECTED_FAMILY_TAG_REFS.primary,
          display_name: EXPECTED_FAMILY.primary,
          variation_names: [EXPECTED_FAMILY.primary],
          is_selected_artist: true,
        }),
        expect.objectContaining({
          family_tag_ref: EXPECTED_FAMILY_TAG_REFS.resonance,
          display_name: EXPECTED_FAMILY.resonance,
          variation_names: [EXPECTED_FAMILY.resonance],
          is_selected_artist: false,
        }),
      ]));

      const primaryAlbumNames = runtimeView.primary_artist_groups
        .flatMap((group) => group.albums || [])
        .map((album) => album.name);
      expect(primaryAlbumNames).not.toContain(RESONANCE_ALBUM);

      const resonanceGroups = runtimeView.family_artist_groups.filter(
        (group) => group.family_tag_ref === EXPECTED_FAMILY_TAG_REFS.resonance,
      );
      expect(resonanceGroups).toHaveLength(1);
      expect(
        resonanceGroups[0].albums.filter((album) => album.name === RESONANCE_ALBUM),
      ).toHaveLength(1);

      await artistFamilyActions.expand();
      const chipTexts = (await artistFamilyActions.readChipTexts())
        .map((text) => String(text || '').trim());
      expect(chipTexts.filter((text) => text === EXPECTED_FAMILY.primary)).toHaveLength(1);
      expect(chipTexts.filter((text) => text === EXPECTED_FAMILY.resonance)).toHaveLength(1);
    });

    await stepLogger.step('Find one Resonance heading across the entire virtualized gallery', async () => {
      const occurrences = await galleryActions.readArtistHeadingOccurrencesAcrossGallery({ timeout: 60000 });
      expect(occurrences.filter(({ artist }) => artist === EXPECTED_FAMILY.resonance)).toHaveLength(1);
    });

    await stepLogger.step('Keep one Resonance heading after filtering to that artist', async () => {
      await artistFamilyActions.expand();
      await artistFamilyActions.clickChipByName(EXPECTED_FAMILY.resonance);
      await artistFamilyActions.waitForChipActive(EXPECTED_FAMILY.resonance, true);
      await galleryActions.waitForOnlyArtistHeadings([EXPECTED_FAMILY.resonance], { timeout: 60000 });
      await galleryActions.scrollToAlbumUnderHeading(
        EXPECTED_FAMILY.resonance,
        RESONANCE_ALBUM,
        { timeout: 60000 },
      );
      const occurrences = await galleryActions.readArtistHeadingOccurrencesAcrossGallery({ timeout: 60000 });
      expect(occurrences.filter(({ artist }) => artist === EXPECTED_FAMILY.resonance)).toHaveLength(1);
    });

    await stepLogger.step('Merge only while Combine similar artists is enabled and restore the distinct section afterward', async () => {
      await artistFamilyActions.clickPrimaryChip();
      await artistFamilyActions.waitForPrimaryAndRelatedFilterActive(
        EXPECTED_FAMILY.resonance,
        { timeout: 60000 },
      );
      const separateOccurrences = await galleryActions.readArtistHeadingOccurrencesAcrossGallery({ timeout: 60000 });
      expect(separateOccurrences.map(({ artist }) => artist).sort()).toEqual(
        [EXPECTED_FAMILY.primary, EXPECTED_FAMILY.resonance].sort(),
      );

      await artistPageSettingsActions.toggleCombineSimilarArtists();
      await galleryActions.waitForOnlyArtistHeadings(
        [EXPECTED_FAMILY.combinedPrimaryAndResonance],
        { timeout: 60000 },
      );
      await galleryActions.scrollToAlbumUnderHeading(
        EXPECTED_FAMILY.combinedPrimaryAndResonance,
        RESONANCE_ALBUM,
        { timeout: 60000 },
      );

      await artistPageSettingsActions.toggleCombineSimilarArtists();
      const restoredOccurrences = await galleryActions.readArtistHeadingOccurrencesAcrossGallery({ timeout: 60000 });
      expect(restoredOccurrences.map(({ artist }) => artist).sort()).toEqual(
        [EXPECTED_FAMILY.primary, EXPECTED_FAMILY.resonance].sort(),
      );
      await galleryActions.scrollToAlbumUnderHeading(
        EXPECTED_FAMILY.resonance,
        RESONANCE_ALBUM,
        { timeout: 60000 },
      );
    });
  });

  test('Neal Morse family search, filters, details, settings, and clear-search flows stay responsive on synthetic data', async ({
    artistFamilyActions,
    page,
    artistPageSettingsActions,
    galleryActions,
    navigationPanelActions,
    scanPageActions,
    searchToolbarActions,
    artistFamilyLocalReport,
    stepLogger,
    trackModalActions,
  }) => {
    test.setTimeout(LONG_REAL_APP_TEST_TIMEOUT_MS);

    requirePostgresRuntimeEnv('the Neal Morse artist-family benchmark');
    await galleryActions.goto();
    await searchToolbarActions.waitForVisible({ timeout: 60000 });
    await navigationPanelActions.waitForSidebarPreviewHydrated({ timeout: 60000 });

    await stepLogger.step('Let the root browse finish warming before measuring the Neal Morse search path', async () => {
      await enterAndWaitForPostgresBrowseWarmRoot(
        page,
        galleryActions,
        navigationPanelActions,
        scanPageActions,
        { timeout: 120000 },
      );
    });

    const numericArtistSelectionMs = await stepLogger.step('Select artist 3 and verify its Emerson/Lake family gallery renders from real Postgres data', async () => (
      measureActionTime(
        async () => {
          await navigationPanelActions.selectSidebarArtistByName(EXPECTED_NUMERIC_ARTIST_FAMILY.primary);
        },
        async () => {
          await navigationPanelActions.waitForSidebarSelection(EXPECTED_NUMERIC_ARTIST_FAMILY.primary, { timeout: 120000 });
          await artistFamilyActions.waitForViewReady(EXPECTED_NUMERIC_ARTIST_FAMILY.primary, { timeout: 120000 });
          await artistFamilyActions.waitForVisible({ timeout: 60000 });
          await galleryActions.waitForDisplayedArtistSections(
            [
              EXPECTED_NUMERIC_ARTIST_FAMILY.primary,
              EXPECTED_NUMERIC_ARTIST_FAMILY.elpGalleryDisplay,
              EXPECTED_NUMERIC_ARTIST_FAMILY.powell,
            ],
            { timeout: 60000 },
          );
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'numeric-artist-family-gallery-ready',
      label: 'Artist 3 Emerson/Lake family gallery ready',
      timingMs: numericArtistSelectionMs,
    });

    await stepLogger.step('Assert artist 3 exposes both Emerson/Lake family chips and non-empty gallery groups', async () => {
      const runtimeView = await readRuntimeView(page);
      expect(runtimeView, 'Expected the artist 3 runtime view to be readable from real Postgres data.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(runtimeView, 'full');
      expect(runtimeView.selected_artist).toBe(EXPECTED_NUMERIC_ARTIST_FAMILY.primary);
      expect(runtimeView.related_artists).toEqual(expect.arrayContaining([
        EXPECTED_NUMERIC_ARTIST_FAMILY.elpChip,
        EXPECTED_NUMERIC_ARTIST_FAMILY.powell,
      ]));
      expect(Array.isArray(runtimeView.artist_family_filters)).toBe(true);
      expect(runtimeView.artist_family_filters.map((filter) => filter.display_name)).toEqual(expect.arrayContaining([
        EXPECTED_NUMERIC_ARTIST_FAMILY.primary,
        EXPECTED_NUMERIC_ARTIST_FAMILY.elpChip,
        EXPECTED_NUMERIC_ARTIST_FAMILY.powell,
      ]));
      expect(Array.isArray(runtimeView.family_artist_groups)).toBe(true);
      const familyGroupSummaries = runtimeView.family_artist_groups.map((group) => ({
        artist: String(group.artist || '').trim(),
        albumCount: Array.isArray(group.albums) ? group.albums.length : 0,
      }));
      expect(familyGroupSummaries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artist: EXPECTED_NUMERIC_ARTIST_FAMILY.elpGallery,
          albumCount: expect.any(Number),
        }),
        expect.objectContaining({
          artist: EXPECTED_NUMERIC_ARTIST_FAMILY.powell,
          albumCount: expect.any(Number),
        }),
      ]));
      const elpSummary = familyGroupSummaries.find((group) => group.artist === EXPECTED_NUMERIC_ARTIST_FAMILY.elpGallery);
      const powellSummary = familyGroupSummaries.find((group) => group.artist === EXPECTED_NUMERIC_ARTIST_FAMILY.powell);
      expect(elpSummary).toBeTruthy();
      expect(powellSummary).toBeTruthy();
      expect(elpSummary.albumCount).toBeGreaterThan(0);
      expect(powellSummary.albumCount).toBeGreaterThan(0);
    });

    const searchAutoSelectionMs = await stepLogger.step('Search for Neal Morse and wait for auto-selection in the filtered tree', async () => (
      measureActionTime(
        async () => {
          await searchToolbarActions.search(SEARCH_QUERY);
        },
        async () => {
          await searchToolbarActions.waitForQuery(SEARCH_QUERY, { timeout: 120000 });
          await navigationPanelActions.waitForSidebarSelection(EXPECTED_FAMILY.primary, { timeout: 120000 });
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'search-auto-selection',
      label: 'Search auto-selected Neal Morse in the filtered tree',
      timingMs: searchAutoSelectionMs,
    });

    const searchRuntimeSnapshot = await stepLogger.step('Capture the Neal Morse runtime snapshot right after search auto-selection', async () => {
      const runtimeView = await readRuntimeView(page);
      const snapshot = {
        selectedArtist: String(runtimeView?.selected_artist || ''),
        query: String(runtimeView?.query || ''),
        artistGroupCount: Array.isArray(runtimeView?.artist_groups) ? runtimeView.artist_groups.length : 0,
        primaryArtistGroupCount: Array.isArray(runtimeView?.primary_artist_groups) ? runtimeView.primary_artist_groups.length : 0,
        familyArtistGroupCount: Array.isArray(runtimeView?.family_artist_groups) ? runtimeView.family_artist_groups.length : 0,
        relatedArtistCount: Array.isArray(runtimeView?.related_artists) ? runtimeView.related_artists.length : 0,
      };
      stepLogger.note(JSON.stringify({
        ...snapshot,
      }), 2);
      return snapshot;
    });

    const searchGalleryReadyMs = await stepLogger.step('Wait for the Neal Morse family gallery to render after search', async () => (
      measureActionTime(
        async () => {},
        async () => {
          await artistFamilyActions.waitForViewReady(EXPECTED_FAMILY.primary, {
            timeout: 120000,
            queryValue: SEARCH_QUERY,
          });
          await artistFamilyActions.waitForVisible({ timeout: 120000 });
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'search-gallery-ready',
      label: 'Search-loaded Neal Morse family gallery ready',
      timingMs: searchGalleryReadyMs,
    });

    await stepLogger.step('Assert the live Neal Morse family payload came from Postgres and exposed non-empty family context', async () => {
      const runtimeView = await readRuntimeView(page);
      expect(runtimeView, 'Expected the Neal Morse family runtime view to be readable after search auto-selection.').toBeTruthy();
      expectPostgresLibraryBrowseTelemetry(runtimeView, 'full');
      expect(runtimeView.selected_artist).toBe(EXPECTED_FAMILY.primary);
      expect(Array.isArray(runtimeView.related_artists)).toBe(true);
      expect(runtimeView.related_artists.length).toBeGreaterThan(0);
      expect(Array.isArray(runtimeView.family_artist_groups)).toBe(true);
      expect(runtimeView.family_artist_groups.length).toBeGreaterThan(0);
    });

    const filteredTreeArtists = await stepLogger.step('Read the filtered-tree artist family labels from the live dataset', async () => (
      navigationPanelActions.readSidebarArtistNames()
    ));
    expect(filteredTreeArtists).toEqual(expect.arrayContaining([
      EXPECTED_FAMILY.cosmic,
      EXPECTED_FAMILY.dvirgilio,
      EXPECTED_FAMILY.mpg,
      EXPECTED_FAMILY.primary,
      EXPECTED_FAMILY.resonance,
      EXPECTED_FAMILY.nealMorseBand,
      EXPECTED_FAMILY.progWorld,
    ]));

    await stepLogger.step('Expand Artist Family and verify the live family tags', async () => {
      await artistFamilyActions.expand();
      const chipTexts = await artistFamilyActions.readChipTexts();
      expect(chipTexts).toEqual(expect.arrayContaining([
        EXPECTED_FAMILY.primary,
        EXPECTED_FAMILY.cosmic,
        EXPECTED_FAMILY.dvirgilio,
        EXPECTED_FAMILY.mpg,
        EXPECTED_FAMILY.resonance,
        EXPECTED_FAMILY.nealMorseBand,
        EXPECTED_FAMILY.progWorld,
      ]));
      await artistFamilyActions.waitForPrimaryChipActive(EXPECTED_FAMILY.primary);
    });

    const searchIdleMemory = await stepLogger.step('Sample idle memory after the search-loaded Neal Morse family view settles', async () => (
      artistFamilyLocalReport.recordPeakMemoryCheckpoint({
        key: 'search-idle-memory',
        label: 'Search-loaded Neal Morse idle memory',
        details: {
          phase: 'search_loaded_neal',
        },
      })
    ));

    const resonanceChipReadyMs = await stepLogger.step('Filter the family view down to Neal Morse & The Resonance only', async () => (
      measureActionTime(
        async () => {
          await artistFamilyActions.clickChipByName(EXPECTED_FAMILY.resonance);
        },
        async () => {
          await artistFamilyActions.waitForChipActive(EXPECTED_FAMILY.resonance, true);
          await galleryActions.waitForOnlyArtistHeadings([EXPECTED_FAMILY.resonance], { timeout: 60000 });
          await galleryActions.waitForAlbumVisible('No Hill For A Climber', { timeout: 60000 });
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'resonance-chip-ready',
      label: 'Filtered to Neal Morse & The Resonance only',
      timingMs: resonanceChipReadyMs,
    });

    const cosmicChipAddReadyMs = await stepLogger.step('Add Cosmic Cathedral to the family filter set', async () => (
      measureActionTime(
        async () => {
          await artistFamilyActions.clickChipByName(EXPECTED_FAMILY.cosmic);
        },
        async () => {
          await artistFamilyActions.waitForChipActive(EXPECTED_FAMILY.cosmic, true);
          await galleryActions.waitForDisplayedArtistSections(
            [EXPECTED_FAMILY.resonance, EXPECTED_FAMILY.cosmic],
            { timeout: 60000 },
          );
          await galleryActions.waitForAlbumVisible('Deep Water', { timeout: 60000 });
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'cosmic-chip-add-ready',
      label: 'Added Cosmic Cathedral to the active family tags',
      timingMs: cosmicChipAddReadyMs,
    });

    const nealMorseBandChipAddReadyMs = await stepLogger.step('Add The Neal Morse Band to the family filter set', async () => (
      measureActionTime(
        async () => {
          await artistFamilyActions.clickChipByName(EXPECTED_FAMILY.nealMorseBand);
        },
        async () => {
          await artistFamilyActions.waitForChipActive(EXPECTED_FAMILY.nealMorseBand, true);
          await galleryActions.waitForDisplayedArtistSections(
            [
              EXPECTED_FAMILY.resonance,
              EXPECTED_FAMILY.cosmic,
              EXPECTED_FAMILY.nealMorseBand,
            ],
            { timeout: 60000 },
          );
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'neal-morse-band-chip-add-ready',
      label: 'Added The Neal Morse Band to the active family tags',
      timingMs: nealMorseBandChipAddReadyMs,
    });

    const resonanceChipRemoveReadyMs = await stepLogger.step('Remove Neal Morse & The Resonance from the active family filter set', async () => (
      measureActionTime(
        async () => {
          await artistFamilyActions.clickChipByName(EXPECTED_FAMILY.resonance);
        },
        async () => {
          await artistFamilyActions.waitForChipActive(EXPECTED_FAMILY.resonance, false);
          await galleryActions.waitForDisplayedArtistSections(
            [EXPECTED_FAMILY.cosmic, EXPECTED_FAMILY.nealMorseBand],
            { timeout: 60000 },
          );
          const headings = await galleryActions.readArtistHeadings();
          expect(headings).not.toContain(EXPECTED_FAMILY.resonance);
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'resonance-chip-remove-ready',
      label: 'Removed Neal Morse & The Resonance from the active family tags',
      timingMs: resonanceChipRemoveReadyMs,
    });

    await stepLogger.step('Sample idle memory after the multi-chip family filter state settles', async () => {
      await artistFamilyLocalReport.recordPeakMemoryCheckpoint({
        key: 'family-multi-filter-memory',
        label: 'Multi-chip family filter idle memory',
        details: {
          phase: 'multi_chip_family_filter',
        },
      });
    });

    const treeCosmicSelectionMs = await stepLogger.step('Click Cosmic Cathedral in the filtered tree and wait for the selection highlight', async () => (
      measureActionTime(
        async () => {
          await navigationPanelActions.selectSidebarArtistByName(EXPECTED_FAMILY.cosmic);
        },
        async () => {
          await navigationPanelActions.waitForSidebarSelection(EXPECTED_FAMILY.cosmic);
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'tree-cosmic-selection',
      label: 'Filtered tree selected Cosmic Cathedral',
      timingMs: treeCosmicSelectionMs,
    });

    const treeCosmicGalleryReadyMs = await stepLogger.step('Wait for the Cosmic Cathedral family gallery to render', async () => (
      measureActionTime(
        async () => {},
        async () => {
          await artistFamilyActions.waitForViewReady(EXPECTED_FAMILY.cosmic, { timeout: 120000 });
          await artistFamilyActions.waitForVisible({ timeout: 60000 });
          await artistFamilyActions.waitForPrimaryChipActive(EXPECTED_FAMILY.cosmic);
          await galleryActions.waitForAlbumVisible('Deep Water', { timeout: 60000 });
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'tree-cosmic-gallery-ready',
      label: 'Cosmic Cathedral family gallery ready from the filtered tree',
      timingMs: treeCosmicGalleryReadyMs,
    });

    const cosmicPrimaryOnlyChipMs = await stepLogger.step('Use the primary Cosmic Cathedral family chip to show only its own album section', async () => (
      measureActionTime(
        async () => {
          await artistFamilyActions.clickPrimaryChip();
        },
        async () => {
          await galleryActions.waitForOnlyArtistHeadings([EXPECTED_FAMILY.cosmic], { timeout: 60000 });
          await galleryActions.waitForAlbumCountByHeading(EXPECTED_FAMILY.cosmic, 1, { timeout: 60000 });
          await galleryActions.waitForAlbumVisible('Deep Water', { timeout: 60000 });
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'cosmic-primary-only-chip-ready',
      label: 'Cosmic Cathedral primary-only family view ready',
      timingMs: cosmicPrimaryOnlyChipMs,
    });

    const cosmicAlbumDetailsOpenMs = await stepLogger.step('Open the Cosmic Cathedral album details and wait for the tracklist', async () => (
      measureActionTime(
        async () => {
          await galleryActions.clickAlbumDetailsByAlbumName('Deep Water');
        },
        async () => {
          await trackModalActions.waitForInteractiveSummary({ timeout: 60000 });
        },
      )
    ));
    await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'cosmic-album-details-open',
      label: 'Opened the Cosmic Cathedral album details',
      timingMs: cosmicAlbumDetailsOpenMs,
    });

    const cosmicAlbumDetailsCloseMs = await stepLogger.step('Close the Cosmic Cathedral album details and wait for the gallery to settle', async () => (
      measureActionTime(
        async () => {
          await trackModalActions.clickClose();
        },
        async () => {
          await trackModalActions.waitForClosed({ timeout: 60000 });
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'cosmic-album-details-close',
      label: 'Closed the Cosmic Cathedral album details',
      timingMs: cosmicAlbumDetailsCloseMs,
    });

    await stepLogger.step('Sample idle memory after the Cosmic Cathedral modal round-trip', async () => {
      await artistFamilyLocalReport.recordPeakMemoryCheckpoint({
        key: 'cosmic-modal-memory',
        label: 'Cosmic Cathedral modal-cycle idle memory',
        details: {
          phase: 'cosmic_modal_round_trip',
        },
      });
    });

    const treeNealSelectionMs = await stepLogger.step('Return to Neal Morse from the filtered tree', async () => (
      measureActionTime(
        async () => {
          await navigationPanelActions.selectSidebarArtistByName(EXPECTED_FAMILY.primary);
        },
        async () => {
          await navigationPanelActions.waitForSidebarSelection(EXPECTED_FAMILY.primary);
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'tree-neal-selection',
      label: 'Filtered tree reselected Neal Morse',
      timingMs: treeNealSelectionMs,
    });

    const treeNealGalleryReadyMs = await stepLogger.step('Wait for the Neal Morse family gallery to return', async () => (
      measureActionTime(
        async () => {},
        async () => {
          await artistFamilyActions.waitForViewReady(EXPECTED_FAMILY.primary, { timeout: 120000 });
          await artistFamilyActions.waitForVisible({ timeout: 60000 });
          await artistFamilyActions.waitForPrimaryChipActive(EXPECTED_FAMILY.primary);
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'tree-neal-gallery-ready',
      label: 'Neal Morse family gallery ready again',
      timingMs: treeNealGalleryReadyMs,
    });

    const nealAlbumNames = await stepLogger.step('Read the Neal Morse album order so the test can open the first and seventh albums', async () => (
      galleryActions.readAlbumNamesByHeading(EXPECTED_FAMILY.primary)
    ));
    expect(nealAlbumNames.length).toBeGreaterThan(6);
    expect(nealAlbumNames[0]).not.toEqual(nealAlbumNames[6]);

    const firstAlbumOpenMs = await stepLogger.step('Open the first visible Neal Morse album details', async () => (
      measureActionTime(
        async () => {
          await galleryActions.clickAlbumDetailsByHeadingAndIndex(EXPECTED_FAMILY.primary, 0);
        },
        async () => {
          await trackModalActions.waitForInteractiveSummary({ timeout: 60000 });
        },
      )
    ));
    await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'neal-first-album-open',
      label: 'Opened the first visible Neal Morse album details',
      timingMs: firstAlbumOpenMs,
    });

    const firstAlbumCloseMs = await stepLogger.step('Close the first Neal Morse album details', async () => (
      measureActionTime(
        async () => {
          await trackModalActions.clickClose();
        },
        async () => {
          await trackModalActions.waitForClosed({ timeout: 60000 });
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'neal-first-album-close',
      label: 'Closed the first visible Neal Morse album details',
      timingMs: firstAlbumCloseMs,
    });

    const secondAlbumOpenMs = await stepLogger.step('Open the seventh Neal Morse album details view', async () => (
      measureActionTime(
        async () => {
          await galleryActions.clickAlbumDetailsByHeadingAndIndex(EXPECTED_FAMILY.primary, 6);
        },
        async () => {
          await trackModalActions.waitForInteractiveSummary({ timeout: 60000 });
        },
      )
    ));
    await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'neal-second-album-open',
      label: 'Opened a second visible Neal Morse album details view',
      timingMs: secondAlbumOpenMs,
    });

    const secondAlbumCloseMs = await stepLogger.step('Close the second Neal Morse album details view', async () => (
      measureActionTime(
        async () => {
          await trackModalActions.clickClose();
        },
        async () => {
          await trackModalActions.waitForClosed({ timeout: 60000 });
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'neal-second-album-close',
      label: 'Closed the second visible Neal Morse album details view',
      timingMs: secondAlbumCloseMs,
    });

    await stepLogger.step('Sample idle memory after the Neal Morse album-details cycle', async () => {
      await artistFamilyLocalReport.recordPeakMemoryCheckpoint({
        key: 'neal-modal-cycle-memory',
        label: 'Neal Morse modal-cycle idle memory',
        details: {
          phase: 'neal_modal_round_trip',
        },
      });
    });

    await stepLogger.step('Narrow the Neal Morse family view down to the primary and Resonance sections before testing Combine similar artists', async () => {
      await artistFamilyActions.clickChipByName(EXPECTED_FAMILY.resonance);
      await artistFamilyActions.waitForChipActive(EXPECTED_FAMILY.resonance, true);
      await artistFamilyActions.clickPrimaryChip();
      await artistFamilyActions.waitForPrimaryAndRelatedFilterActive(
        EXPECTED_FAMILY.resonance,
        { timeout: 60000 },
      );
      await galleryActions.waitForDisplayedArtistSections(
        [EXPECTED_FAMILY.primary, EXPECTED_FAMILY.resonance],
        { timeout: 60000 },
      );
    });

    const combineSimilarOnMs = await stepLogger.step('Turn on Combine similar artists from the artist-page settings menu', async () => (
      measureActionTime(
        async () => {
          await artistPageSettingsActions.toggleCombineSimilarArtists();
        },
        async () => {
          await galleryActions.waitForDisplayedArtistSections(
            [EXPECTED_FAMILY.combinedPrimaryAndResonance],
            { timeout: 60000 },
          );
          await galleryActions.waitForOnlyArtistHeadings([EXPECTED_FAMILY.combinedPrimaryAndResonance], { timeout: 60000 });
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'combine-similar-on-ready',
      label: 'Combine similar artists turned on and merged the Resonance section',
      timingMs: combineSimilarOnMs,
    });

    await stepLogger.step('Scroll the merged Neal Morse section until the Resonance album appears under that same section', async () => {
      await galleryActions.scrollToAlbumUnderHeading(
        EXPECTED_FAMILY.combinedPrimaryAndResonance,
        'No Hill For A Climber',
        { timeout: 60000 },
      );
    });

    const combineSimilarOffMs = await stepLogger.step('Turn off Combine similar artists and restore the default grouped family view', async () => (
      measureActionTime(
        async () => {
          await artistPageSettingsActions.toggleCombineSimilarArtists();
        },
        async () => {
          await galleryActions.waitForDisplayedArtistSections(
            [EXPECTED_FAMILY.primary, EXPECTED_FAMILY.resonance],
            { timeout: 60000 },
          );
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'combine-similar-off-ready',
      label: 'Combine similar artists turned off and restored the separate Resonance section',
      timingMs: combineSimilarOffMs,
    });

    await stepLogger.step('Sample idle memory after the combine-similar toggle cycle', async () => {
      await artistFamilyLocalReport.recordPeakMemoryCheckpoint({
        key: 'combine-toggle-memory',
        label: 'Combine similar artists toggle-cycle idle memory',
        details: {
          phase: 'combine_toggle_cycle',
        },
      });
    });

    const clearSearchReadyMs = await stepLogger.step('Clear the search and wait for the full tree to return while keeping Neal Morse selected', async () => (
      measureActionTime(
        async () => {
          await searchToolbarActions.clearSearch();
        },
        async () => {
          await searchToolbarActions.waitForQuery('', { timeout: 60000 });
          await navigationPanelActions.waitForSidebarSelection(EXPECTED_FAMILY.primary, { timeout: 60000 });
          await navigationPanelActions.waitForActiveSelectionInViewport({ timeout: 60000 });
          await galleryActions.waitForSelectedArtistGallery(EXPECTED_FAMILY.primary, { timeout: 60000 });
          await searchToolbarActions.waitForUrlWithoutQueryParameter('q', { timeout: 10000 });
        },
      )
    ));
    await artistFamilyLocalReport.recordTimingCheckpoint({
      key: 'clear-search-ready',
      label: 'Cleared search and restored the full tree with Neal Morse still selected',
      timingMs: clearSearchReadyMs,
    });

    const finalIdleMemory = await stepLogger.step('Sample idle memory after clearing search back to the full tree', async () => (
      artistFamilyLocalReport.recordPeakMemoryCheckpoint({
        key: 'clear-search-idle-memory',
        label: 'Idle memory after clearing search',
        details: {
          phase: 'clear_search_full_tree',
        },
      })
    ));

    const peakIdleMemoryBytes = artistFamilyLocalReport.checkpoints.reduce(
      (maxValue, checkpoint) => Math.max(maxValue, Number(checkpoint.memoryBytes || 0)),
      0,
    );
    artistFamilyLocalReport.recordTextCheckpoint({
      key: 'peak-idle-memory',
      label: 'Peak idle memory across the full Neal Morse family run',
      valueText: `${peakIdleMemoryBytes} bytes`,
      details: {
        phase: 'overall',
        peakIdleMemoryBytes,
      },
    });

    const rawMetrics = {
      searchAutoSelectionMs,
      searchGalleryReadyMs,
      searchIdleMemory,
      resonanceChipReadyMs,
      cosmicChipAddReadyMs,
      nealMorseBandChipAddReadyMs,
      resonanceChipRemoveReadyMs,
      treeCosmicSelectionMs,
      treeCosmicGalleryReadyMs,
      cosmicPrimaryOnlyChipMs,
      cosmicAlbumDetailsOpenMs,
      cosmicAlbumDetailsCloseMs,
      treeNealSelectionMs,
      treeNealGalleryReadyMs,
      nealFirstAlbumOpenMs: firstAlbumOpenMs,
      nealFirstAlbumCloseMs: firstAlbumCloseMs,
      nealSecondAlbumOpenMs: secondAlbumOpenMs,
      nealSecondAlbumCloseMs: secondAlbumCloseMs,
      combineSimilarOnMs,
      combineSimilarOffMs,
      clearSearchReadyMs,
      finalIdleMemory,
      peakIdleMemoryBytes,
    };

    const benchmarkEvaluation = evaluateArtistFamilyLocalBenchmark(rawMetrics);
    logBenchmarkTimingResults(benchmarkEvaluation);
    artistFamilyLocalReport.setMetricsPayload({
      ...rawMetrics,
      benchmarkValidation: buildBenchmarkValidationPayload(benchmarkEvaluation),
      benchmark: benchmarkEvaluation.benchmark,
      benchmarkResults: benchmarkEvaluation.results,
      benchmarkFailures: benchmarkEvaluation.failures,
    });
    expect(benchmarkEvaluation.failures, benchmarkEvaluation.failures.join('\n')).toEqual([]);
  });
});
