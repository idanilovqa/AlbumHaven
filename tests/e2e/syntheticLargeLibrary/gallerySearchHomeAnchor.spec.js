import { expect, test } from '../support/performanceFixtures.js';
import { GalleryRegressions } from '../poms/galleryRegressions.js';
import { waitForLibraryStartupEntryVisible } from '../helpers/realAppBenchmarkHelpers.js';

const SEARCH_ARTIST = 'Neal Morse';

async function expectStableDestination(ui, page, testInfo, label, albumKey) {
  const anchor = await ui.captureSemanticVisibleCardAnchor(albumKey);
  expect(anchor.top).not.toBeNull();
  const observation = await ui.startVisibleCardAnchorObservation(anchor);
  await page.waitForTimeout(5000);
  const samples = await observation.finish();
  await testInfo.attach(`${label}-anchor`, {
    body: JSON.stringify({ anchor, samples }),
    contentType: 'application/json',
  });
  expect(samples.length).toBeGreaterThan(0);
  expect(samples.filter(sample => !sample.stable)).toEqual([]);
  expect(await ui.readSemanticVisibleCardAnchorContinuity(anchor)).toEqual({
    connected: true,
    delta: 0,
  });
}

test.describe('FTC-GALLERY-NAV-037 synthetic-large desktop search and Home anchoring', () => {
  test.use({ viewport: { width: 1280, height: 844 }, isMobile: false, hasTouch: false });

  test('search and Home destinations do not rebound after settling', async ({
    appBarActions, galleryActions, navigationPanelActions, page, searchToolbarActions,
  }, testInfo) => {
    const ui = new GalleryRegressions(page);
    await galleryActions.goto('/?surface=albums&all_artists=1');
    await waitForLibraryStartupEntryVisible(page, galleryActions, navigationPanelActions, {
      timeout: 120000,
    });
    await navigationPanelActions.waitForSidebarFullyHydrated({ timeout: 120000 });
    await galleryActions.waitForInitialRefreshCompleted({ timeout: 120000 });

    await searchToolbarActions.search(SEARCH_ARTIST);
    await searchToolbarActions.waitForQuery(SEARCH_ARTIST, { timeout: 60000 });
    await galleryActions.waitForSelectedArtistGallery(SEARCH_ARTIST, {
      queryValue: SEARCH_ARTIST,
      timeout: 60000,
    });
    const searchAlbumKey = await ui.firstAlbumKeyForArtist(SEARCH_ARTIST);
    expect(searchAlbumKey).not.toBe('');
    await expectStableDestination(ui, page, testInfo, 'search-destination', searchAlbumKey);
    expect(new URL(page.url()).searchParams.get('q')).toBe(SEARCH_ARTIST);

    await appBarActions.openLibraryHome();
    await searchToolbarActions.waitForQuery('', { timeout: 60000 });
    await navigationPanelActions.waitForAllArtistsVisibility(true, { timeout: 60000 });
    await galleryActions.waitForGalleryReady({ timeout: 60000 });
    const homeCard = await ui.captureMiddleVisibleCard();
    await expectStableDestination(ui, page, testInfo, 'home-destination', homeCard.albumKey);
    const homeUrl = new URL(page.url());
    expect(homeUrl.searchParams.has('q')).toBe(false);
    expect(homeUrl.searchParams.has('artist')).toBe(false);
  });
});
