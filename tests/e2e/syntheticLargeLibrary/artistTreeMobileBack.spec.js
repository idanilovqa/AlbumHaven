import { expect, test } from '../support/performanceFixtures.js';
import { GalleryRegressions } from '../poms/galleryRegressions.js';
import {
  waitForLibraryStartupEntryVisible,
} from '../helpers/realAppBenchmarkHelpers.js';

test.describe('FTC-GALLERY-NAV-033 synthetic-large mobile anchored gallery restoration', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test('long-press Scroll, album, Back restores an artist beyond the first root page', async ({
    galleryActions,
    navigationPanelActions,
    page,
  }) => {
    const ui = new GalleryRegressions(page);
    await galleryActions.goto();
    await waitForLibraryStartupEntryVisible(page, galleryActions, navigationPanelActions, {
      timeout: 120000,
    });
    await navigationPanelActions.waitForSidebarFullyHydrated({ timeout: 120000 });
    await galleryActions.waitForInitialAllArtistsSections({
      requireScrollable: false,
      timeout: 120000,
    });
    await galleryActions.waitForInitialRefreshCompleted({ timeout: 120000 });
    await page.waitForFunction(() => (
      typeof state !== 'undefined'
      && !state.busy
      && !String(state.ui?.activeViewRequestUrl || '').trim()
    ), null, { timeout: 120000 });

    await navigationPanelActions.openArtistTree();
    const artists = await navigationPanelActions.readRuntimeSidebarArtistNames();
    expect(artists.length).toBeGreaterThan(250);
    const requestedArtist = artists[200];
    expect(await ui.sidebarArtistSourceIndex(requestedArtist)).toBeGreaterThan(50);
    const row = await ui.revealArtistWithWheel(requestedArtist);
    await ui.longPressArtist(row);
    await expect(ui.scrollToArtistAction).toBeVisible();
    await expect(ui.artistTreeContextMenu).toHaveAttribute('data-artist', requestedArtist);
    await ui.scrollToArtistAction.click();

    await expect.poll(() => ui.readArtistJumpOwnership(requestedArtist))
      .toMatchObject({ anchorArtist: requestedArtist });
    const renderedArtist = (await ui.readArtistJumpOwnership(requestedArtist)).anchorGroupArtist || requestedArtist;
    const expectedPlacement = {
      rendered: true,
      chromeMatches: true,
      rowsAligned: true,
      firstCardUncut: true,
    };
    await expect.poll(() => ui.readArtistJumpPlacement(renderedArtist)).toEqual(expectedPlacement);

    const albumKey = await ui.firstAlbumKeyForArtist(renderedArtist);
    expect(albumKey).not.toBe('');
    await ui.albumMetadataByKey(albumKey).click();
    await expect(ui.mobileAlbum).toBeVisible();
    const anchoredBackRequests = [];
    const recordAnchoredBackRequest = (request) => {
      const url = new URL(request.url());
      if (
        url.pathname.endsWith('/view-data')
        && url.searchParams.get('gallery_anchor_artist') === requestedArtist
      ) anchoredBackRequests.push(url.href);
    };
    page.on('request', recordAnchoredBackRequest);
    let observation;
    try {
      await ui.mobileBack.click();
      await expect(ui.mobileAlbum).toBeHidden();
      expect(await ui.readArtistJumpPlacement(renderedArtist)).toEqual(expectedPlacement);
      expect(new URL(page.url()).searchParams.has('gallery_anchor_artist')).toBe(false);

      observation = await ui.startArtistJumpPlacementObservation(renderedArtist);
      await page.waitForTimeout(3000);
      const samples = await observation.finish();
      expect(samples.length).toBeGreaterThan(30);
      expect(samples.filter(sample => !sample.stable)).toEqual([]);
      expect(await ui.readArtistJumpPlacement(renderedArtist)).toEqual(expectedPlacement);
      expect(anchoredBackRequests).toEqual([]);
    } finally {
      try { await observation?.finish(); }
      finally { page.off('request', recordAnchoredBackRequest); }
    }
  });
});
