import { expect, test } from '../support/performanceFixtures.js';
import { GalleryRegressions } from '../poms/galleryRegressions.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';
import { waitForLibraryStartupEntryVisible } from '../helpers/realAppBenchmarkHelpers.js';

for (const mobile of [true, false]) {
  test.describe(`FTC-GALLERY-NAV-034 synthetic-large ${mobile ? 'mobile' : 'desktop'} presentation anchoring`, () => {
    test.use({
      hasTouch: mobile,
      isMobile: mobile,
      viewport: { width: mobile ? 390 : 1280, height: 844 },
    });

    test(`${mobile ? 'Mobile Cards, covers and rows' : 'Desktop Cards and covers'} retain the jumped-to release`, async ({
      galleryActions, navigationPanelActions, page,
    }, testInfo) => {
      const ui = new GalleryRegressions(page);
      const layout = new MobileLayoutPage(page);
      await galleryActions.goto();
      await waitForLibraryStartupEntryVisible(page, galleryActions, navigationPanelActions, {
        timeout: 120000,
      });
      await navigationPanelActions.waitForSidebarFullyHydrated({ timeout: 120000 });
      await galleryActions.waitForInitialRefreshCompleted({ timeout: 120000 });
      await navigationPanelActions.openArtistTree();
      const artists = await navigationPanelActions.readRuntimeSidebarArtistNames();
      expect(artists.length).toBeGreaterThan(250);
      const requestedArtist = artists[200];
      const row = await ui.revealArtistWithWheel(requestedArtist);
      if (mobile) await ui.longPressArtist(row);
      else await row.click({ button: 'right' });
      await expect(ui.artistTreeContextMenu).toHaveAttribute('data-artist', requestedArtist);
      await ui.scrollToArtistAction.click();
      await expect.poll(() => ui.readArtistJumpOwnership(requestedArtist))
        .toMatchObject({ anchorArtist: requestedArtist });
      const artist = (await ui.readArtistJumpOwnership(requestedArtist)).anchorGroupArtist || requestedArtist;
      await layout.selectView('cards');
      await expect.poll(() => ui.readArtistJumpPlacement(artist)).toEqual({
        rendered: true, chromeMatches: true, rowsAligned: true, firstCardUncut: true,
      });
      const albumKey = await ui.firstAlbumKeyForArtist(artist);
      expect(albumKey).not.toBe('');
      const anchor = await ui.captureSemanticVisibleCardAnchor(albumKey);
      expect(anchor.artist).toBe(artist);
      expect(anchor.top).not.toBeNull();

      for (const view of mobile ? ['covers', 'list', 'cards'] : ['covers', 'cards']) {
        const observation = await ui.startVisibleCardAnchorObservation(anchor);
        let samples;
        try {
          await layout.selectView(view);
          // Observe late layout work; this delay is not a readiness condition.
          await page.waitForTimeout(5000);
        } finally {
          samples = await observation.finish();
          await testInfo.attach(`presentation-${view}-anchor`, {
            body: JSON.stringify({ anchor, samples }), contentType: 'application/json',
          });
        }
        expect(samples.length).toBeGreaterThan(0);
        expect(samples.filter(sample => !sample.stable)).toEqual([]);
      }
    });
  });
}
