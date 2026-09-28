import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { MobileTouchFeedbackPage } from '../poms/mobileTouchFeedbackPage.js';

for (const palette of ['black', 'parchment-pine']) {
  test(`phone touch boundaries, shared drawers and compact footer in ${palette}`, async ({ page, app, snapshot }) => {
    const phone = new MobileTouchFeedbackPage(page);
    await page.setViewportSize({ width: 390, height: 650 });
    await phone.usePalette(palette);
    await phone.browseArtist();
    await phone.expectGalleryMeetsPlayer();
    const artistPaint = await phone.inspectArtistDrawerTouch();
    await snapshot(`110-artist-drawer-${palette}`);
    await phone.closeArtistRail.click();
    await phone.openUsers();
    await phone.accountNavToggle.click();
    await phone.expectDrawerAtAppBar(phone.adminDrawer);
    expect(await phone.readPaint(phone.adminDrawer)).toEqual(artistPaint);
    await snapshot(`111-admin-drawer-${palette}`);
    await phone.adminBack.click();
    await phone.parentLink.click();
    await phone.openSettings();
    await phone.expectTightAppearanceFooter();
    await phone.settingsSectionsButton.click();
    await phone.expectDrawerAtAppBar(phone.settingsDrawer);
    await phone.settingsDrawerBack.click();
    await snapshot(`112-settings-footer-${palette}`);
    await phone.backButton.click();
    await phone.notificationOpen.click();
    await expect(phone.notificationPanel).toBeVisible();
    await expect(phone.notificationActions).toHaveCount(2);
    for (const action of await phone.notificationActions.all()) {
      const bounds = await action.boundingBox();
      expect(bounds.width).toBe(40); expect(bounds.height).toBe(40);
    }
    await snapshot(`113-notifications-${palette}`);
    await phone.notificationClose.click();
  });
}

test('album ratings share the title line; scrolled identity is centered and initial scrollbars wait for touch', async ({ page, app, snapshot }) => {
  const phone = new MobileTouchFeedbackPage(page);
  await phone.browseArtist();
  for (const mode of ['list', 'cards']) {
    await phone.selectView(mode);
    await phone.expectRatingBesideTitle();
  }
  await phone.search('Sixteen Horizons');
  await phone.openAlbumTitle('Sixteen Horizons');
  await expect(phone.albumRows).toHaveCount(16);
  await expect(phone.pageOutlet).toHaveAttribute('data-mobile-page-kind', 'album');
  await expect(phone.pageOutlet).not.toHaveAttribute('data-page-interacted', 'true');
  await expect(phone.pageOutlet).toHaveCSS('scrollbar-color', 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');
  await phone.scrollRegion('album', 550);
  await expect(phone.pageOutlet).toHaveAttribute('data-page-interacted', 'true');
  await phone.expectThumbnailCentered();
  await snapshot('114-scrolled-album-centered');
  await phone.backButton.click();
  await phone.openLibraryStatus();
  await snapshot('115-library-state-back');
  await phone.statusBack.click();
  await expect(phone.statusPageBar).not.toBeVisible();
  await expect(phone.galleryCards.first()).toBeVisible();
});
