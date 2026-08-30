import { expect, test } from '../support/baseFixtures.js';
import { readAlbumRatingAuthority } from '../helpers/albumRatingAuthorityHelpers.js';

const ARTIST = 'Album Rating Contract';
const NO_RATING_ALBUMS = [
  'Rating Absent',
  'Rating Malformed',
  'Rating Zero',
  'Rating Out Of Range',
];
const NUMERIC_AUTHORITY_ALBUM = 'Rating Numeric Authority';
const CLEARED_AUTHORITY_ALBUM = 'Rating Cleared Authority';
const IMPORT_CANDIDATE_ALBUM = 'Rating Import Candidate';
const SCAN_DISCOVERY_ALBUM = 'Rating Scan Discovery';
const FILLED_STAR_COLOR = 'rgb(250, 204, 21)';
const EMPTY_STAR_COLOR = 'rgb(75, 85, 99)';
const UNRATED_SURFACE = {
  rowCount: 1,
  starCount: 10,
  filledStarCount: 0,
  emptyStarCount: 10,
  role: 'img',
  ariaLabel: 'Album unrated',
  text: '',
  glyphs: Array(10).fill('☆'),
  filledColor: '',
  emptyColor: EMPTY_STAR_COLOR,
};

test('FTC-ALBUM-TASTE-013 keeps app ratings authoritative while import and scan seed missing ratings', async ({
  appBarActions,
  galleryActions,
  librarySettingsActions,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
}, testInfo) => {
  testInfo.setTimeout(240000);
  await stepLogger.step('Render absent and invalid ratings as ten empty stars in hydrated album cards', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    for (const album of NO_RATING_ALBUMS) {
      await searchToolbarActions.search(album, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(album);
      await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, album);
      expect(await galleryActions.readAlbumRatingSurface(ARTIST, album)).toEqual(UNRATED_SURFACE);
    }
  });

  await stepLogger.step('Prefer the numeric app rating and honor an explicitly cleared app rating', async () => {
    await searchToolbarActions.search(NUMERIC_AUTHORITY_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(NUMERIC_AUTHORITY_ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, NUMERIC_AUTHORITY_ALBUM);
    expect(await galleryActions.readAlbumRatingSurface(ARTIST, NUMERIC_AUTHORITY_ALBUM)).toEqual({
      rowCount: 1,
      starCount: 10,
      filledStarCount: 8,
      emptyStarCount: 2,
      role: 'img',
      ariaLabel: 'Album rating 8/10',
      text: '8/10',
      glyphs: [...Array(8).fill('★'), ...Array(2).fill('☆')],
      filledColor: FILLED_STAR_COLOR,
      emptyColor: EMPTY_STAR_COLOR,
    });
    const ratingLayout = await galleryActions.readAlbumRatingLayout(ARTIST, NUMERIC_AUTHORITY_ALBUM);
    expect(Math.abs(ratingLayout.starFontSize - (ratingLayout.starsWidth / 9))).toBeLessThanOrEqual(0.05);
    expect(ratingLayout.starGlyphSpan).toBeGreaterThanOrEqual(ratingLayout.rowWidth * 0.72);
    expect(ratingLayout.starLineSpread).toBeLessThanOrEqual(1);
    expect(ratingLayout.numericGap).toBeGreaterThanOrEqual(6);

    await searchToolbarActions.search(CLEARED_AUTHORITY_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(CLEARED_AUTHORITY_ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, CLEARED_AUTHORITY_ALBUM);
    expect(await galleryActions.readAlbumRatingSurface(ARTIST, CLEARED_AUTHORITY_ALBUM)).toEqual(UNRATED_SURFACE);
    const unratedLayout = await galleryActions.readAlbumRatingLayout(ARTIST, CLEARED_AUTHORITY_ALBUM);
    expect(unratedLayout.starsWidth).toBeCloseTo(ratingLayout.starsWidth, 0);
    expect(unratedLayout.starGlyphSpan).toBeCloseTo(ratingLayout.starGlyphSpan, 0);
  });

  await stepLogger.step('Keep the import candidate rendered without an app rating before import', async () => {
    await searchToolbarActions.search(IMPORT_CANDIDATE_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(IMPORT_CANDIDATE_ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, IMPORT_CANDIDATE_ALBUM);
    expect(await galleryActions.readAlbumRatingSurface(ARTIST, IMPORT_CANDIDATE_ALBUM)).toEqual(UNRATED_SURFACE);
  });

  let firstImportResult;
  await stepLogger.step('Import the missing tag rating and refresh the already-rendered card', async () => {
    await settingsModalAppBarActions.openSettings();
    await librarySettingsActions.open();
    firstImportResult = await librarySettingsActions.importRatings();
    expect(firstImportResult).toMatchObject({
      created: 1,
      authoritySkipped: 360,
      failed: 3,
    });
    await settingsModalAppBarActions.closeSettings();
    await searchToolbarActions.waitForQuery(IMPORT_CANDIDATE_ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, IMPORT_CANDIDATE_ALBUM);
    expect(await galleryActions.readAlbumRatingSurface(ARTIST, IMPORT_CANDIDATE_ALBUM)).toEqual({
      rowCount: 1,
      starCount: 10,
      filledStarCount: 7,
      emptyStarCount: 3,
      role: 'img',
      ariaLabel: 'Album rating 7/10',
      text: '7/10',
      glyphs: [...Array(7).fill('★'), ...Array(3).fill('☆')],
      filledColor: FILLED_STAR_COLOR,
      emptyColor: EMPTY_STAR_COLOR,
    });
  });

  await stepLogger.step('Repeat the explicit import without creating a duplicate authority row', async () => {
    await settingsModalAppBarActions.openSettings();
    await librarySettingsActions.open();
    const repeatedImportResult = await librarySettingsActions.importRatings(firstImportResult.text);
    expect(repeatedImportResult).toMatchObject({
      created: 0,
      authoritySkipped: 361,
      failed: 3,
    });
    await settingsModalAppBarActions.closeSettings();
  });

  await stepLogger.step('Keep the existing app rating visible while the incremental scan is active', async () => {
    await searchToolbarActions.search(CLEARED_AUTHORITY_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(CLEARED_AUTHORITY_ALBUM);
    await appBarActions.triggerIncrementalScanAndWaitForBusy();
    const viewPayload = await searchToolbarActions.searchAndReadViewDataPayload(
      NUMERIC_AUTHORITY_ALBUM,
      { submitWithEnter: true },
    );
    expect(readAlbumRatingAuthority(viewPayload, NUMERIC_AUTHORITY_ALBUM)).toEqual({
      appRating: 8,
      summaryAppRating: 8,
      tagRating: 3,
    });
    await searchToolbarActions.waitForQuery(NUMERIC_AUTHORITY_ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, NUMERIC_AUTHORITY_ALBUM);
    expect(await appBarActions.readIncrementalScanBusyState()).toBe(true);
    expect(await galleryActions.readAlbumRatingSurface(ARTIST, NUMERIC_AUTHORITY_ALBUM)).toEqual({
      rowCount: 1,
      starCount: 10,
      filledStarCount: 8,
      emptyStarCount: 2,
      role: 'img',
      ariaLabel: 'Album rating 8/10',
      text: '8/10',
      glyphs: [...Array(8).fill('★'), ...Array(2).fill('☆')],
      filledColor: FILLED_STAR_COLOR,
      emptyColor: EMPTY_STAR_COLOR,
    });
    expect(await appBarActions.readIncrementalScanBusyState()).toBe(true);
    await appBarActions.waitForIncrementalScanComplete();
  });

  await stepLogger.step('Open the newly discovered tagged MP3 after the scan completes', async () => {
    await searchToolbarActions.search(SCAN_DISCOVERY_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(SCAN_DISCOVERY_ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, SCAN_DISCOVERY_ALBUM);
    expect(await galleryActions.readAlbumRatingSurface(ARTIST, SCAN_DISCOVERY_ALBUM)).toEqual({
      rowCount: 1,
      starCount: 10,
      filledStarCount: 9,
      emptyStarCount: 1,
      role: 'img',
      ariaLabel: 'Album rating 9/10',
      text: '9/10',
      glyphs: [...Array(9).fill('★'), '☆'],
      filledColor: FILLED_STAR_COLOR,
      emptyColor: EMPTY_STAR_COLOR,
    });
  });

  await stepLogger.step('Keep numeric and cleared authorities unchanged after the regular scan', async () => {
    await searchToolbarActions.search(NUMERIC_AUTHORITY_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(NUMERIC_AUTHORITY_ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, NUMERIC_AUTHORITY_ALBUM);
    expect(await galleryActions.readAlbumRatingSurface(ARTIST, NUMERIC_AUTHORITY_ALBUM)).toEqual({
      rowCount: 1,
      starCount: 10,
      filledStarCount: 8,
      emptyStarCount: 2,
      role: 'img',
      ariaLabel: 'Album rating 8/10',
      text: '8/10',
      glyphs: [...Array(8).fill('★'), ...Array(2).fill('☆')],
      filledColor: FILLED_STAR_COLOR,
      emptyColor: EMPTY_STAR_COLOR,
    });

    await searchToolbarActions.search(CLEARED_AUTHORITY_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(CLEARED_AUTHORITY_ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, CLEARED_AUTHORITY_ALBUM);
    expect(await galleryActions.readAlbumRatingSurface(ARTIST, CLEARED_AUTHORITY_ALBUM)).toEqual(UNRATED_SURFACE);
  });
});
