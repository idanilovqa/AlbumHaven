import { expect, test } from '../support/baseFixtures.js';
import {
  EMPTY_KEY_ARTISTS,
  MORSE_ALBUMS,
  MORSE_ALIAS_ARTIST,
  MORSE_CANONICAL_ARTIST,
  NEAL_MORSE_RETAINED_ALBUM,
  expectNealMorseScrollResetViewport,
  WHITESPACE_ALBUM,
  WHITESPACE_ALBUM_YEAR,
  WHITESPACE_DISPLAY_ARTIST,
  WHITESPACE_RELATED_ALBUM,
  WHITESPACE_RELATED_ARTIST,
  WHITESPACE_SEARCH_ARTIST,
  expectedOtherEmptyKeyAlbums,
  expectMorseAlbums,
  expectPostgresBrowse,
  expectStartupProjectionRebuilt,
} from '../helpers/artistAliasParityHelpers.js';

test('FTC-SEARCH-NAV-020 resolves punctuation-credit aliases through startup and keeps both raw credits', async ({
  artistFamilyActions,
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  startupRelationProjectionReadiness,
  stepLogger,
}) => {
  await stepLogger.step('Open the normal Postgres-backed library after startup rebuilt the missing projection', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    expectStartupProjectionRebuilt(expect, startupRelationProjectionReadiness);
    await expectPostgresBrowse(expect, galleryActions);
    expect(await navigationPanelActions.readSidebarArtistNameCount(MORSE_CANONICAL_ARTIST)).toBe(1);
    expect(await navigationPanelActions.readSidebarArtistNameCount(MORSE_ALIAS_ARTIST)).toBe(0);
  });

  await stepLogger.step('Reach the canonical scope through the exact unpunctuated credit', async () => {
    await searchToolbarActions.search(MORSE_CANONICAL_ARTIST, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(MORSE_CANONICAL_ARTIST);
    await expectMorseAlbums(expect, galleryActions);
    await expectPostgresBrowse(expect, galleryActions);
  });

  await stepLogger.step('Reach the same canonical scope through the exact punctuation alias', async () => {
    await searchToolbarActions.search(MORSE_ALIAS_ARTIST, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(MORSE_ALIAS_ARTIST);
    await expectMorseAlbums(expect, galleryActions);
    await expectPostgresBrowse(expect, galleryActions);
  });

  await stepLogger.step('Open the canonical artist directly from the production sidebar', async () => {
    await searchToolbarActions.clearSearch({ submitWithEnter: true });
    await searchToolbarActions.waitForQuery('');
    await navigationPanelActions.selectSidebarArtistByName(MORSE_CANONICAL_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(MORSE_CANONICAL_ARTIST);
    await expectMorseAlbums(expect, galleryActions);
  });

  await stepLogger.step('Exercise the existing Artist Family chip semantics without losing either source credit', async () => {
    await artistFamilyActions.waitForViewReady(MORSE_CANONICAL_ARTIST);
    await artistFamilyActions.expand();
    await artistFamilyActions.waitForPrimaryChipActive(MORSE_CANONICAL_ARTIST);
    const familyChips = await artistFamilyActions.readChipTexts();
    expect(familyChips).toContain(MORSE_CANONICAL_ARTIST);
    expect(familyChips).toContain('Neal Morse');

    await artistFamilyActions.clickChipByName('Neal Morse');
    await artistFamilyActions.waitForChipActive('Neal Morse');
    await galleryActions.waitForOnlyArtistHeadings(['Neal Morse']);
    expect(await galleryActions.readArtistHeadings()).toEqual(['Neal Morse']);
    const nealOnlyAlbums = await galleryActions.readAlbumNamesByHeading('Neal Morse');
    expect(nealOnlyAlbums.length).toBeGreaterThan(0);
    for (const fixture of MORSE_ALBUMS) {
      await galleryActions.waitForAlbumHidden(fixture.album);
      expect(nealOnlyAlbums).not.toContain(fixture.album);
    }

    await artistFamilyActions.clickPrimaryChip();
    await artistFamilyActions.waitForChipActive(MORSE_CANONICAL_ARTIST);
    await artistFamilyActions.waitForPrimaryAndRelatedFilterActive('Neal Morse');
    await galleryActions.waitForOnlyArtistHeadings([MORSE_CANONICAL_ARTIST, 'Neal Morse']);
    await expectMorseAlbums(expect, galleryActions);

    await artistFamilyActions.clickChipByName('Neal Morse');
    await artistFamilyActions.waitForChipActive('Neal Morse', false);
    await galleryActions.waitForOnlyArtistHeadings([MORSE_CANONICAL_ARTIST]);
    expect(await galleryActions.readArtistHeadings()).toEqual([MORSE_CANONICAL_ARTIST]);
    await expectMorseAlbums(expect, galleryActions);

    await artistFamilyActions.clickPrimaryChip();
    await artistFamilyActions.waitForChipActive(MORSE_CANONICAL_ARTIST, false);
    await galleryActions.waitForArtistHeadings([MORSE_CANONICAL_ARTIST, 'Neal Morse']);
  });

  await stepLogger.step('Reset the deep gallery viewport when the family tree selects a different artist', async () => {
    await searchToolbarActions.search(MORSE_CANONICAL_ARTIST, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(MORSE_CANONICAL_ARTIST);
    await artistFamilyActions.waitForViewReady(MORSE_CANONICAL_ARTIST, {
      queryValue: MORSE_CANONICAL_ARTIST,
    });
    await galleryActions.waitForArtistHeadings([MORSE_CANONICAL_ARTIST, 'Neal Morse']);

    await navigationPanelActions.selectSidebarArtistByName('Neal Morse');
    await navigationPanelActions.waitForSidebarSelection('Neal Morse');
    await artistFamilyActions.waitForViewReady('Neal Morse', {
      queryValue: MORSE_CANONICAL_ARTIST,
    });
    await galleryActions.waitForAlbumVisibleUnderHeading(
      'Neal Morse',
      NEAL_MORSE_RETAINED_ALBUM,
    );

    await navigationPanelActions.selectSidebarArtistByName(MORSE_CANONICAL_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(MORSE_CANONICAL_ARTIST);
    await artistFamilyActions.waitForViewReady(MORSE_CANONICAL_ARTIST, {
      queryValue: MORSE_CANONICAL_ARTIST,
    });
    await galleryActions.waitForArtistHeadings([MORSE_CANONICAL_ARTIST, 'Neal Morse']);

    const deepScroll = await galleryActions.jumpGalleryToMiddle();
    expect(deepScroll.maxScrollTop).toBeGreaterThan(2);
    expect(deepScroll.scrollTop).toBeGreaterThan(2);

    await navigationPanelActions.selectSidebarArtistByName('Neal Morse');
    await navigationPanelActions.waitForSidebarSelection('Neal Morse');
    await artistFamilyActions.waitForViewReady('Neal Morse', {
      queryValue: MORSE_CANONICAL_ARTIST,
    });
    await galleryActions.waitForAlbumVisibleUnderHeading(
      'Neal Morse',
      NEAL_MORSE_RETAINED_ALBUM,
    );
    await galleryActions.waitForGalleryScrollAtStart();
    const viewport = await galleryActions.readArtistSelectionGalleryViewportState(
      'Neal Morse',
      NEAL_MORSE_RETAINED_ALBUM,
    );
    expectNealMorseScrollResetViewport(expect, viewport);
  });

  await stepLogger.step('Keep both source credits under the canonical root grouping', async () => {
    await searchToolbarActions.clearSearch({ submitWithEnter: true });
    await searchToolbarActions.waitForQuery('');
    await navigationPanelActions.clickAllArtists({ expectArtistQueryCleared: true });
    await galleryActions.waitForInitialAllArtistsSections({ minimumHeadingCount: 4 });
    expect(await navigationPanelActions.readSidebarArtistNameCount(MORSE_CANONICAL_ARTIST)).toBe(1);
    expect(await navigationPanelActions.readSidebarArtistAlbumCount(MORSE_CANONICAL_ARTIST)).toBe(2);
    expect(await navigationPanelActions.readSidebarArtistNameCount(MORSE_ALIAS_ARTIST)).toBe(0);

    await navigationPanelActions.selectSidebarArtistByName(MORSE_CANONICAL_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(MORSE_CANONICAL_ARTIST);
    await expectMorseAlbums(expect, galleryActions);
    await expectPostgresBrowse(expect, galleryActions);
  });
});

test('FTC-SEARCH-NAV-021 keeps empty normalized artist keys isolated', async ({
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  startupRelationProjectionReadiness,
  stepLogger,
}) => {
  await stepLogger.step('Open the normal library and verify startup projection readiness', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    expectStartupProjectionRebuilt(expect, startupRelationProjectionReadiness);
  });

  for (const fixture of EMPTY_KEY_ARTISTS) {
    await stepLogger.step(`Open only the exact ${fixture.artist} artist identity`, async () => {
      await searchToolbarActions.search(fixture.artist, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(fixture.artist);
      expect(await navigationPanelActions.readSidebarArtistNameCount(fixture.artist)).toBe(1);
      await galleryActions.waitForAlbumVisibleUnderHeading(fixture.artist, fixture.album);
      expect(await galleryActions.readArtistHeadings()).toEqual([fixture.artist]);
      expect(await galleryActions.readAlbumCreditByName(fixture.album)).toBe(fixture.artist);
      const visibleAlbums = await galleryActions.readAlbumNamesByHeading(fixture.artist);
      expect(visibleAlbums).toEqual([fixture.album]);
      for (const otherAlbum of expectedOtherEmptyKeyAlbums(fixture.artist)) {
        expect(visibleAlbums).not.toContain(otherAlbum);
      }
      await expectPostgresBrowse(expect, galleryActions);
    });
  }
});

test('FTC-SEARCH-NAV-022 starts with a collapsed scan identity and browses its repeated-space artist family', async ({
  artistFamilyActions,
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  startupRelationProjectionReadiness,
  stepLogger,
}) => {
  await stepLogger.step('Open the production app after lifespan rebuilt the relation projection', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    expectStartupProjectionRebuilt(expect, startupRelationProjectionReadiness);
    await expectPostgresBrowse(expect, galleryActions);
    expect(await navigationPanelActions.readSidebarArtistNameCount(WHITESPACE_DISPLAY_ARTIST)).toBe(1);
    expect(await navigationPanelActions.readSidebarArtistNameCount(WHITESPACE_SEARCH_ARTIST)).toBe(0);
  });

  await stepLogger.step('Search by the collapsed scan identity and retain the stored display credit', async () => {
    await searchToolbarActions.search(WHITESPACE_SEARCH_ARTIST, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(WHITESPACE_SEARCH_ARTIST);
    await galleryActions.waitForArtistHeadings([
      WHITESPACE_DISPLAY_ARTIST,
      WHITESPACE_RELATED_ARTIST,
    ]);
    await galleryActions.waitForAlbumVisibleUnderHeading(WHITESPACE_DISPLAY_ARTIST, WHITESPACE_ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(
      WHITESPACE_RELATED_ARTIST,
      WHITESPACE_RELATED_ALBUM,
    );
    expect(await galleryActions.readAlbumCreditByName(WHITESPACE_ALBUM)).toBe(WHITESPACE_DISPLAY_ARTIST);
    expect(await galleryActions.readAlbumYearByName(WHITESPACE_ALBUM)).toBe(
      String(WHITESPACE_ALBUM_YEAR),
    );
    await expectPostgresBrowse(expect, galleryActions);
  });

  await stepLogger.step('Browse the folder-derived relation through Artist Family controls', async () => {
    await artistFamilyActions.waitForViewReady(WHITESPACE_DISPLAY_ARTIST, {
      queryValue: WHITESPACE_SEARCH_ARTIST,
    });
    await artistFamilyActions.expand();
    await artistFamilyActions.waitForPrimaryChipActive(WHITESPACE_DISPLAY_ARTIST);
    const familyChips = await artistFamilyActions.readChipTexts();
    expect(familyChips).toContain(WHITESPACE_DISPLAY_ARTIST);
    expect(familyChips).toContain(WHITESPACE_RELATED_ARTIST);

    await artistFamilyActions.clickChipByName(WHITESPACE_RELATED_ARTIST);
    await artistFamilyActions.waitForChipActive(WHITESPACE_RELATED_ARTIST);
    await galleryActions.waitForOnlyArtistHeadings([WHITESPACE_RELATED_ARTIST]);
    expect(await galleryActions.readArtistHeadings()).not.toContain(WHITESPACE_DISPLAY_ARTIST);
    await galleryActions.waitForAlbumVisibleUnderHeading(
      WHITESPACE_RELATED_ARTIST,
      WHITESPACE_RELATED_ALBUM,
    );
    expect(await galleryActions.readAlbumCreditByName(WHITESPACE_RELATED_ALBUM)).toBe(
      WHITESPACE_RELATED_ARTIST,
    );
  });
});
