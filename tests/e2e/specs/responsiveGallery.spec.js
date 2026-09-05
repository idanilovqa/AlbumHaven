import { expect, test } from '../support/baseFixtures.js';
import {
  captureResponsiveGalleryScreenshot,
  expectCardsWithinSelectedScale,
  expectResponsiveRatingSingleLine,
  resolveSelectedScaleCardCeiling,
  waitForResponsiveGalleryLayout,
} from '../helpers/responsiveGalleryHelpers.js';

const ARTIST = 'Album Rating Contract';
const RATED_ALBUM = 'Rating Numeric Authority';
const COVERLESS_ARTIST = 'ДДТ';
const COVERLESS_ALBUM = 'Студийные записи';
const GALLERY_SCALE_PERCENT = 125;
const BASE_CARD_WIDTH_PX = 240;
const SELECTED_SCALE_CARD_CEILING_PX = resolveSelectedScaleCardCeiling(
  BASE_CARD_WIDTH_PX,
  GALLERY_SCALE_PERCENT,
);
const WIDE_VIEWPORT = Object.freeze({ width: 1440, height: 960 });
const NARROW_VIEWPORT = Object.freeze({ width: 1024, height: 960 });

test('FTC-MOBILE-WEB-007 keeps ratings on one line while narrower galleries preserve selected card scale', async ({
  galleryActions,
  page,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
  testArtifacts,
  utilityAppearanceActions,
  utilityTabBarActions,
}) => {
  let wideLayout;
  let narrowLayout;

  await stepLogger.step('Open the real Postgres gallery at an explicit 125 percent card scale', async () => {
    await page.setViewportSize(WIDE_VIEWPORT);
    await galleryActions.goto(
      `/?surface=albums&gallery_display=cards&gallery_scale_percent=${GALLERY_SCALE_PERCENT}`,
    );
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('appearance');
    await utilityAppearanceActions.waitForReady();
    await utilityAppearanceActions.choosePalette('paper', 1);
    await utilityAppearanceActions.save();
    await settingsModalAppBarActions.closeSettings();
    await searchToolbarActions.search(ARTIST, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ARTIST);
    await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, RATED_ALBUM);
    expect(new URL(page.url()).searchParams.get('gallery_scale_percent')).toBe(
      String(GALLERY_SCALE_PERCENT),
    );
  });

  await stepLogger.step('Record the wide gallery density, rating geometry, and visible screenshot', async () => {
    wideLayout = await waitForResponsiveGalleryLayout(galleryActions.galleryPage, {
      artistName: ARTIST,
      ratedAlbumName: RATED_ALBUM,
    });
    await galleryActions.waitForVisibleGalleryCoversLoaded({ minimumCount: 3 });
    await captureResponsiveGalleryScreenshot(
      galleryActions.galleryPage,
      testArtifacts,
      'responsive-gallery-scale-125-wide.png',
    );
  });

  await stepLogger.step('Narrow the same production view and record its settled layout and screenshot', async () => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await galleryActions.scrollToAlbumUnderHeading(ARTIST, RATED_ALBUM);
    narrowLayout = await waitForResponsiveGalleryLayout(galleryActions.galleryPage, {
      artistName: ARTIST,
      ratedAlbumName: RATED_ALBUM,
    });
    await galleryActions.waitForVisibleGalleryCoversLoaded({ minimumCount: 2 });
    await captureResponsiveGalleryScreenshot(
      galleryActions.galleryPage,
      testArtifacts,
      'responsive-gallery-scale-125-narrow.png',
    );
  });

  await stepLogger.step('Reduce columns without stretching cards or wrapping the rating', async () => {
    expect(wideLayout.columnCount).toBeGreaterThanOrEqual(3);
    expect(narrowLayout.columnCount).toBeLessThan(wideLayout.columnCount);
    expectCardsWithinSelectedScale(expect, wideLayout, SELECTED_SCALE_CARD_CEILING_PX);
    expectCardsWithinSelectedScale(expect, narrowLayout, SELECTED_SCALE_CARD_CEILING_PX);
    expect(narrowLayout.maxCardWidth).toBeLessThanOrEqual(wideLayout.maxCardWidth + 1);
    expectResponsiveRatingSingleLine(expect, wideLayout);
    expectResponsiveRatingSingleLine(expect, narrowLayout);
  });

  await stepLogger.step('Apply the Paper palette to an exact projected coverless album card', async () => {
    await searchToolbarActions.search(COVERLESS_ARTIST, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(COVERLESS_ARTIST);
    await galleryActions.scrollToAlbumUnderHeading(COVERLESS_ARTIST, COVERLESS_ALBUM);
    await galleryActions.waitForVisibleGalleryCoversLoaded({
      minimumCount: 1,
      allowPlaceholder: true,
      placeholderScenario: `${COVERLESS_ARTIST} / ${COVERLESS_ALBUM} is the projected coverless fixture`,
    });
    const coverPlaceholder = galleryActions.galleryPage.albumCard
      .coverPlaceholderByAlbumName(COVERLESS_ALBUM);
    await expect(coverPlaceholder).toBeVisible();
    const placeholder = await galleryActions.galleryPage.albumCard
      .readCoverPlaceholderAppearance(COVERLESS_ALBUM);
    expect(placeholder.backgroundImage).toContain('linear-gradient');
    expect(placeholder.borderColor).toBe('rgb(184, 189, 197)');
    expect(placeholder.color).toBe('rgb(80, 87, 98)');
  });
});
