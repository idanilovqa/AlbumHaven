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

test('album ratings share the title line; scrolled identity is top-aligned and initial scrollbars wait for touch', async ({ page, app, snapshot }) => {
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
  await phone.expectThumbnailTopAligned();
  await snapshot('114-scrolled-album-top-aligned');
  await phone.backButton.click();
  await phone.openLibraryStatus();
  await snapshot('115-library-state-back');
  await phone.statusBack.click();
  await expect(phone.statusPageBar).not.toBeVisible();
  await expect(phone.galleryCards.first()).toBeVisible();
});


for (const [width, palette] of [[390, 'black'], [320, 'parchment-pine']]) {
  test(`mobile search retains query, reserves Settings and restores collapsed state at ${width}px`, async ({ page, app, snapshot }) => {
    const phone = new MobileTouchFeedbackPage(page);
    await page.setViewportSize({ width, height: 844 });
    await phone.usePalette(palette);
    await phone.search('Sixteen Horizons');
    await phone.galleryContextName.click();
    await phone.expectSearchCollapsed('Sixteen Horizons');
    await snapshot(`116-query-indicator-${width}`);
    await phone.searchButton.tap();
    await expect(phone.searchInput).toBeFocused();
    await expect(phone.searchInput).toHaveValue('Sixteen Horizons');
    await phone.expectExpandedSearchLeavesSettings();
    await snapshot(`117-search-reserves-settings-${width}`);
    await phone.settingsButton.tap();
    await expect(phone.settingsMenu).toBeVisible();
    await phone.expectSearchCollapsed('Sixteen Horizons');
    await snapshot(`118-search-settings-same-tap-${width}`);
    await phone.settingsButton.tap();
    await expect(phone.settingsMenu).not.toBeVisible();
    await page.reload();
    await expect(phone.galleryCards.first()).toBeVisible();
    await phone.expectSearchCollapsed('Sixteen Horizons');
    await page.setViewportSize({ width: 1180, height: 844 });
    await expect(phone.searchInput).toBeVisible();
    await expect(phone.searchInput).toHaveValue('Sixteen Horizons');
    await page.setViewportSize({ width, height: 844 });
    await phone.expectSearchCollapsed('Sixteen Horizons');
    await phone.openAlbumTitle('Sixteen Horizons');
    await phone.scrollRegion('album', 550);
    await phone.expectThumbnailTopAligned();
    await snapshot(`119-top-aligned-album-${width}`);
    await phone.searchButton.tap();
    await phone.searchInput.press('Escape');
    await phone.expectSearchCollapsed('Sixteen Horizons');
    await phone.searchButton.tap();
    await phone.mainSearchClear.tap();
    await expect(phone.searchInput).toHaveValue('');
    await phone.visibleAppBar.tap({ position: { x: 2, y: 2 } });
    await phone.expectSearchCollapsed('');
  });
}


for (const palette of ['black', 'parchment-pine']) {
  test(`gallery counts retain the family-name column across narrow and roomy phones in ${palette}`, async ({ page, app, snapshot }) => {
    const phone = new MobileTouchFeedbackPage(page);
    await phone.usePalette(palette);
    await phone.browseArtist();
    await expect(phone.galleryContextName).toHaveText('Northlight family');
    for (const width of [390, 320, 350, 351, 430, 900, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await phone.expectGalleryTextColumn(width <= 350);
      if (width === 320 || width === 430) await snapshot(`120-family-text-column-${palette}-${width}`);
    }
    await phone.familyButton.click();
    await expect(phone.familyPanel).toBeVisible();
    await phone.page.keyboard.press('Escape');
    await expect(phone.familyPanel).not.toBeVisible();
    await phone.browseArtist('Northlight & The Lumen Trio');
    await expect(phone.galleryContextName).toHaveText('Northlight & The Lumen Trio family');
    await phone.expectGalleryTextColumn(false);
    await snapshot(`121-long-artist-text-column-${palette}`);
  });
}
