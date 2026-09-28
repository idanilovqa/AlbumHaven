import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';
import { UtilityAppearanceTab } from '../poms/utilityAppearanceTab.js';

for (const palette of ['black', 'parchment-pine']) {
  test(`mobile appearance retains an offline draft and saves after reconnection in ${palette}`, async ({ page, app, context, snapshot }) => {
    const appearance = new UtilityAppearanceTab(page);
    await app.openSettings();
    await app.customAppearance.click();
    await appearance.paletteButton(palette).click();
    await context.setOffline(true);
    try {
      await app.saveAppearance.click();
      await expect(appearance.requestError).toBeVisible();
      await expect(app.saveAppearance).toBeEnabled();
      await expect(appearance.paletteButton(palette)).toHaveAttribute('aria-pressed', 'true');
      expect(await app.hasNoHorizontalOverflow()).toBe(true);
      await snapshot(`83-offline-appearance-${palette}`);
    } finally { await context.setOffline(false); }
    await app.saveAppearanceChanges();
    await page.reload();
    await expect(appearance.documentRoot).toHaveAttribute('data-appearance-palette', palette);
    await expect(app.cancelAppearance).toBeDisabled();
  });
}


test('a session ended in another tab blocks a mobile appearance save and allows normal sign-in', async ({ page, app, context }) => {
  const appearance = new UtilityAppearanceTab(page);
  await app.openSettings();
  await app.customAppearance.click();
  await appearance.paletteButton('paper').click();
  const otherPage = await context.newPage();
  try {
    const other = new MobileLayoutPage(otherPage);
    await otherPage.goto('/');
    await other.settingsButton.click();
    await other.signOut.click();
    await expect(other.loginForm).toBeVisible();
    await app.saveAppearance.click();
    await expect(appearance.requestError).toContainText('session changed or expired');
    await expect(app.saveAppearance).toBeDisabled();
  } finally { await otherPage.close(); }
  await app.signIn('rendref', 'Phase Seven Owner Passphrase 2026!');
  await expect(app.home).toBeVisible();
  await app.openSettings();
  await expect(app.followAppearance).toHaveAttribute('aria-pressed', 'true');
});
