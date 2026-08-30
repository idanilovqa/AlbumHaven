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
  stepLogger,
  testArtifacts,
}) => {
  let wideLayout;
  let narrowLayout;

  await stepLogger.step('Open the real Postgres gallery at an explicit 125 percent card scale', async () => {
    await page.setViewportSize(WIDE_VIEWPORT);
    await galleryActions.goto(
      `/?surface=albums&gallery_display=cards&gallery_scale_percent=${GALLERY_SCALE_PERCENT}`,
    );
    await galleryActions.waitForGalleryReady();
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
    await galleryActions.waitForVisibleGalleryCoversLoaded({
      minimumCount: 3,
      allowPlaceholder: true,
      placeholderScenario: 'Rating Scan Discovery intentionally has no cover art',
    });
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
    await galleryActions.waitForVisibleGalleryCoversLoaded({
      minimumCount: 2,
      allowPlaceholder: true,
      placeholderScenario: 'Rating Scan Discovery intentionally has no cover art',
    });
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
});
