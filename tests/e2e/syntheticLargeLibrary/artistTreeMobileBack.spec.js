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

  for (const scrollBeyondJump of [false, true]) {
    test(scrollBeyondJump
      ? 'long-press Scroll, ordinary scroll to another artist, album, Back retains the new position'
      : 'long-press Scroll, album, Back restores an artist beyond the first root page', async ({
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

      const target = scrollBeyondJump
        ? await ui.scrollToDifferentGalleryArtist(renderedArtist)
        : { artist: renderedArtist, albumKey: await ui.firstAlbumKeyForArtist(renderedArtist) };
      const originatingArtist = target.artist;
      expect(originatingArtist).toBeTruthy();
      if (scrollBeyondJump) expect(originatingArtist).not.toBe(renderedArtist);

      const albumKey = target.albumKey;
      expect(albumKey).not.toBe('');
      const albumMetadata = ui.albumMetadataByKey(albumKey);
      await expect(albumMetadata).toBeInViewport({ ratio: 1 });
      const returnAnchor = await ui.captureSemanticVisibleCardAnchor(albumKey);
      expect(returnAnchor.albumKey).not.toBe('');
      expect(returnAnchor.artist).toBe(originatingArtist);
      expect(returnAnchor.top).not.toBeNull();
      await albumMetadata.click();
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
        await expect.poll(() => ui.readSemanticVisibleCardAnchorContinuity(returnAnchor)).toEqual({
          connected: true,
          delta: 0,
        });
        if (!scrollBeyondJump) expect(await ui.readArtistJumpPlacement(renderedArtist)).toEqual(expectedPlacement);
        expect(new URL(page.url()).searchParams.has('gallery_anchor_artist')).toBe(false);

        observation = scrollBeyondJump
          ? await ui.startVisibleCardAnchorObservation(returnAnchor)
          : await ui.startArtistJumpPlacementObservation(renderedArtist);
        await page.waitForTimeout(3000);
        const samples = await observation.finish();
        expect(samples.length).toBeGreaterThan(30);
        expect(samples.filter(sample => !sample.stable)).toEqual([]);
        expect(await ui.readSemanticVisibleCardAnchorContinuity(returnAnchor)).toEqual({
          connected: true,
          delta: 0,
        });
        if (!scrollBeyondJump) expect(await ui.readArtistJumpPlacement(renderedArtist)).toEqual(expectedPlacement);
        expect(anchoredBackRequests).toEqual([]);
      } finally {
        try { await observation?.finish(); }
        finally {
          page.off('request', recordAnchoredBackRequest);
        }
      }
    });
  }
});
