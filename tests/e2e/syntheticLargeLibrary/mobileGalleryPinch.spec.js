import { expect, test } from '../support/performanceFixtures.js';
import { GalleryRegressions } from '../poms/galleryRegressions.js';
import { MobileGalleryPinchPage } from '../poms/mobileGalleryPinchPage.js';
import { waitForLibraryStartupEntryVisible } from '../helpers/realAppBenchmarkHelpers.js';

test.describe('mobile continuous gallery pinch on the production-calibration library', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  for (const view of ['cards', 'covers']) {
    test(`${view}: deep midpoint stays visible during pinch, paged continuation stays usable and returning to the top is complete`, async ({
      galleryActions, navigationPanelActions, page, layoutPreferenceIsolation,
    }, testInfo) => {
      const ui = new GalleryRegressions(page);
      const phone = new MobileGalleryPinchPage(page);
      await galleryActions.goto('/?surface=albums&all_artists=1');
      await waitForLibraryStartupEntryVisible(page, galleryActions, navigationPanelActions, { timeout: 120000 });
      await navigationPanelActions.waitForSidebarFullyHydrated({ timeout: 120000 });
      await galleryActions.waitForInitialRefreshCompleted({ timeout: 120000 });
      await layoutPreferenceIsolation.capture();
      await phone.selectView(view);
      await phone.selectColumns(3);
      await navigationPanelActions.openArtistTree();
      const artists = await navigationPanelActions.readRuntimeSidebarArtistNames();
      expect(artists.length).toBeGreaterThan(250);
      const requestedArtist = artists[200];
      const row = await ui.revealArtistWithWheel(requestedArtist);
      await ui.longPressArtist(row);
      await expect(ui.artistTreeContextMenu).toHaveAttribute('data-artist', requestedArtist);
      await ui.scrollToArtistAction.click();
      await expect.poll(() => ui.readArtistJumpOwnership(requestedArtist)).toMatchObject({ anchorArtist: requestedArtist });
      const renderedArtist = (await ui.readArtistJumpOwnership(requestedArtist)).anchorGroupArtist || requestedArtist;
      await expect.poll(() => ui.readArtistJumpPlacement(renderedArtist)).toEqual({
        rendered: true, chromeMatches: true, rowsAligned: true, firstCardUncut: true,
      });
      // Scroll with native touch after the jump. The midpoint anchor is deliberately
      // different from the old first-visible-card anchor.
      for (let index = 0; index < 4; index++) {
        const beforeScroll = (await phone.geometry()).scrollTop;
        await phone.swipeGallery();
        await expect.poll(async () => (await phone.geometry()).scrollTop).toBeGreaterThan(beforeScroll);
      }
      const before = await phone.geometry();
      expect(before.scrollTop).toBeGreaterThan(before.viewport.height);
      const anchor = phone.midpointCard(before);
      expect(anchor.key).not.toBe(before.visible[0].key);
      const gesture = await phone.beginPinch({ center: anchor.center });
      const samples = [];
      try {
        for (const scale of [1.08, 1.18, 1.3, 1.4]) {
          await gesture.move(scale);
          await expect.poll(async () => {
            const card = (await phone.geometry()).cards.find(item => item.key === anchor.key && item.occurrence === anchor.occurrence);
            return card?.artbox.top + card?.artbox.height * anchor.fractionY;
          }).toBeCloseTo(anchor.center.y, 0);
          const sample = await phone.geometry();
          phone.expectBounds(sample);
          expect(sample.mounted).toBeLessThan(artists.length);
          const same = sample.cards.find(item => item.key === anchor.key && item.occurrence === anchor.occurrence);
          expect(same.title).toBe(anchor.title);
          await expect(phone.galleryCardByKey(anchor.key)).toBeInViewport();
          samples.push(sample);
        }
        await gesture.end();
      } finally { await gesture.close(); }
      await phone.expectGridColumns(2);
      await phone.expectNoPreview();
      await expect.poll(async () => {
        const card = (await phone.geometry()).cards.find(item => item.key === anchor.key && item.occurrence === anchor.occurrence);
        return card?.artbox.top + card?.artbox.height * anchor.fractionY;
      }).toBeCloseTo(anchor.center.y, 0);
      await testInfo.attach(`${view}-deep-pinch`, { body: JSON.stringify({ anchor, before, samples }), contentType: 'application/json' });
      const after = await phone.geometry();
      for (let index = 0; index < 12; index++) {
        const previous = (await phone.geometry()).scrollTop;
        await phone.swipeGallery();
        await expect.poll(async () => (await phone.geometry()).scrollTop).toBeGreaterThan(previous);
        phone.expectBounds(await phone.geometry());
      }
      const continued = await phone.geometry();
      expect(continued.visible.some(card => !after.cards.some(previous => previous.key === card.key))).toBe(true);
      expect(continued.mounted).toBeLessThan(artists.length);
      const liveCard = continued.visible.find(card => card.artbox.top >= continued.viewport.top
        && card.artbox.bottom <= continued.viewport.bottom);
      expect(liveCard).toBeTruthy();
      await page.touchscreen.tap(liveCard.artbox.x + liveCard.artbox.width / 2, liveCard.artbox.y + liveCard.artbox.height / 2);
      await expect(phone.albumPage).toBeVisible();
      await expect(phone.pageTitle).not.toHaveText('');
      await phone.backButton.click();
      await expect(phone.albumPage).not.toBeVisible();
      await expect(phone.galleryCardByKey(liveCard.key)).toBeInViewport();
      await phone.expectGridColumns(2);
      // Return through the real Artist Tree, then prove exact leading boundary and chrome.
      await navigationPanelActions.openArtistTree();
      const firstRow = await ui.revealArtistWithWheel(artists[0]);
      await ui.longPressArtist(firstRow);
      await ui.scrollToArtistAction.click();
      const firstArtist = (await ui.readArtistJumpOwnership(artists[0])).anchorGroupArtist || artists[0];
      await expect.poll(() => ui.readArtistJumpPlacement(firstArtist)).toEqual({
        rendered: true, chromeMatches: true, rowsAligned: true, firstCardUncut: true,
      });
      phone.expectBounds(await phone.geometry());
    });
  }
});
