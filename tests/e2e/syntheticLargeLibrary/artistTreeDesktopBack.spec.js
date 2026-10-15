import { expect, test } from '../support/performanceFixtures.js';
import { GalleryRegressions } from '../poms/galleryRegressions.js';
import { waitForLibraryStartupEntryVisible } from '../helpers/realAppBenchmarkHelpers.js';

test.describe('FTC-GALLERY-NAV-033 synthetic-large desktop gallery restoration', () => {
  test.use({ viewport: { width: 1280, height: 844 }, isMobile: false, hasTouch: false });

  for (const scrollBeyondJump of [false, true]) {
    test(scrollBeyondJump
      ? 'desktop Scroll, ordinary scroll, album, Close retains the departure position'
      : 'desktop Scroll, album, Close retains the jumped-to position', async ({
      galleryActions, navigationPanelActions, trackModalActions, page,
    }, testInfo) => {
      const ui = new GalleryRegressions(page);
      await galleryActions.goto();
      await waitForLibraryStartupEntryVisible(page, galleryActions, navigationPanelActions, { timeout: 120000 });
      await navigationPanelActions.waitForSidebarFullyHydrated({ timeout: 120000 });
      await galleryActions.waitForInitialRefreshCompleted({ timeout: 120000 });
      await navigationPanelActions.openArtistTree();
      const artists = await navigationPanelActions.readRuntimeSidebarArtistNames();
      expect(artists.length).toBeGreaterThan(250);
      const requestedArtist = artists[200];
      const row = await ui.revealArtistWithWheel(requestedArtist);
      await row.click({ button: 'right' });
      await expect(ui.artistTreeContextMenu).toHaveAttribute('data-artist', requestedArtist);
      await ui.scrollToArtistAction.click();
      await expect.poll(() => ui.readArtistJumpOwnership(requestedArtist))
        .toMatchObject({ anchorArtist: requestedArtist });
      const artist = (await ui.readArtistJumpOwnership(requestedArtist)).anchorGroupArtist || requestedArtist;
      await expect.poll(() => ui.readArtistJumpPlacement(artist)).toEqual({
        rendered: true, chromeMatches: true, rowsAligned: true, firstCardUncut: true,
      });
      const target = scrollBeyondJump
        ? await ui.scrollToDifferentGalleryArtist(artist)
        : { artist, albumKey: await ui.firstAlbumKeyForArtist(artist) };
      if (scrollBeyondJump) expect(target.artist).not.toBe(artist);
      expect(target.albumKey).not.toBe('');
      const metadata = ui.albumMetadataByKey(target.albumKey);
      await expect(metadata).toBeInViewport({ ratio: 1 });
      const anchor = await ui.captureSemanticVisibleCardAnchor(target.albumKey);
      expect(anchor.artist).toBe(target.artist);
      expect(anchor.top).not.toBeNull();
      const observation = await ui.startVisibleCardAnchorObservation(anchor);
      let samples;
      try {
        await ui.albumDetailsByKey(target.albumKey).click();
        await expect(trackModalActions.trackModal.dialog).toBeVisible();
        await trackModalActions.trackModal.closeButton.click();
        await expect(trackModalActions.trackModal.dialog).toBeHidden();
        // Observe delayed rendering after Close, not a readiness condition.
        await page.waitForTimeout(15000);
      } finally {
        samples = await observation.finish();
        await testInfo.attach('desktop-album-return-anchor', {
          body: JSON.stringify({ anchor, samples }), contentType: 'application/json',
        });
      }
      expect(samples.length).toBeGreaterThan(30);
      expect(samples.filter(sample => !sample.stable)).toEqual([]);
      const continuity = await ui.readSemanticVisibleCardAnchorContinuity(anchor);
      expect(continuity.connected).toBe(true);
      expect(Math.abs(continuity.delta)).toBeLessThanOrEqual(1);
    });
  }
});
