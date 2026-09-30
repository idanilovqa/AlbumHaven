import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { SurfaceDismissalPage } from '../poms/surfaceDismissalPage.js';
import { MobileLoopsPage } from '../poms/mobileLoopsPage.js';

for (const palette of ['black', 'parchment-pine']) {
  test(`touch distinguishes real backdrops from uncovered actions; themed selection in ${palette}`, async ({ page, app, snapshot }) => {
    const phone = new SurfaceDismissalPage(page);
    await phone.usePalette(palette);
    await phone.browseArtist();
    await phone.selectView('cards');
    await phone.familyButton.tap();
    await phone.activateUncoveredArtwork(phone.familyPanel);
    await phone.backButton.tap();
    await phone.libraryButton.tap();
    await phone.expectSelectedAccent(phone.activeArtist);
    await snapshot(`124-navigation-accent-${palette}`);
    await phone.dismissOverAlbumAndOpenOnNextTap(phone.artistRail);
    await phone.backButton.tap();
    await phone.notificationOpen.tap();
    await phone.activateUncoveredArtwork(phone.notificationPanel);
    await phone.backButton.tap();
    await phone.openAccountMenuOutsideSettingsDrawer();
    await phone.inspectStandaloneAdminDismissal();
  });
}

test('outside mouse activates uncovered family content but dismisses a real desktop modal backdrop', async ({ page, app }) => {
  const desktop = new SurfaceDismissalPage(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  if (await desktop.artistTreeToggle.getAttribute('aria-expanded') === 'false') await desktop.artistTreeToggle.click();
  await desktop.artist('Northlight').click();
  await expect(desktop.galleryCards.first()).toBeVisible();
  await desktop.familyButton.click();
  await desktop.activateUncoveredArtwork(desktop.familyPanel, 'mouse');
  await expect(desktop.trackOverlay).not.toHaveClass(/is-mobile-page/);
  await desktop.clickSettingsPosition();
  await expect(desktop.trackTable).not.toBeVisible();
  await expect(desktop.settingsMenu).not.toBeVisible();
  await desktop.settingsButton.click();
  await expect(desktop.settingsMenu).toBeVisible();
});

test('an uncovered loop play button activates on the first tap while a dropdown is open', async ({ page, app }) => {
  const loops = new MobileLoopsPage(page);
  await loops.openFourLoopSong();
  await loops.pitch.tap();
  await expect(loops.pitchMenu).toBeVisible();
  await loops.play.tap();
  await expect(loops.pitchMenu).not.toBeVisible();
  await expect(loops.play).toHaveAttribute('aria-label', 'Pause');
  await loops.play.tap();
  await expect(loops.play).toHaveAttribute('aria-label', 'Play');
});

test('mobile player taps work outside the Artists scrim and open notification and Settings surfaces', async ({ page, app }) => {
  const phone = new SurfaceDismissalPage(page);
  await phone.browseArtist();
  await phone.galleryAlbums.first().tap();
  await phone.firstTrackTitle.tap();
  await expect(phone.playerPlay).toHaveAttribute('aria-label', 'Pause');
  await phone.backButton.tap();
  await phone.libraryButton.tap();
  await expect(phone.artistBackdrop).toBeVisible();
  await phone.toggleExposedPlayer();
  await phone.notificationOpen.tap();
  await expect(phone.notificationPanel).toBeVisible();
  await phone.toggleExposedPlayer();
  await phone.openSettings();
  await expect(phone.utilitiesPage).toBeVisible();
  await phone.toggleExposedPlayer();
});
