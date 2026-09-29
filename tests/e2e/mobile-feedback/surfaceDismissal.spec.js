import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { SurfaceDismissalPage } from '../poms/surfaceDismissalPage.js';
import { MobileLoopsPage } from '../poms/mobileLoopsPage.js';

for (const palette of ['black', 'parchment-pine']) {
  test(`outside touch dismisses family and artists without opening background albums; themed selection in ${palette}`, async ({ page, app, snapshot }) => {
    const phone = new SurfaceDismissalPage(page);
    await phone.usePalette(palette);
    await phone.browseArtist();
    await phone.selectView('cards');
    await phone.familyButton.tap();
    await phone.dismissOverAlbumAndOpenOnNextTap(phone.familyPanel);
    await phone.backButton.tap();
    await phone.libraryButton.tap();
    await phone.expectSelectedAccent(phone.activeArtist);
    await snapshot(`124-navigation-accent-${palette}`);
    await phone.dismissOverAlbumAndOpenOnNextTap(phone.artistRail);
    await phone.backButton.tap();
    await phone.notificationOpen.tap();
    await phone.dismissOverAlbumAndOpenOnNextTap(phone.notificationPanel);
    await phone.backButton.tap();
    await phone.dismissSettingsDrawerWithoutOpeningAccountMenu();
    await phone.inspectStandaloneAdminDismissal();
  });
}

test('outside mouse dismisses family and a real desktop album modal without activating background controls', async ({ page, app }) => {
  const desktop = new SurfaceDismissalPage(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await desktop.artist('Northlight').click();
  await expect(desktop.galleryCards.first()).toBeVisible();
  await desktop.familyButton.click();
  await desktop.dismissOverAlbumAndOpenOnNextTap(desktop.familyPanel, 'mouse');
  await expect(desktop.trackOverlay).not.toHaveClass(/is-mobile-page/);
  await desktop.settingsButton.click();
  await expect(desktop.trackTable).not.toBeVisible();
  await expect(desktop.settingsMenu).not.toBeVisible();
  await desktop.settingsButton.click();
  await expect(desktop.settingsMenu).toBeVisible();
});

test('a loop dropdown dismissal does not start the loop; its next play tap works', async ({ page, app }) => {
  const loops = new MobileLoopsPage(page);
  await loops.openFourLoopSong();
  await loops.pitch.tap();
  await expect(loops.pitchMenu).toBeVisible();
  await loops.play.tap();
  await expect(loops.pitchMenu).not.toBeVisible();
  await expect(loops.play).toHaveAttribute('aria-label', 'Play');
  await loops.play.tap();
  await expect(loops.play).toHaveAttribute('aria-label', 'Pause');
});
