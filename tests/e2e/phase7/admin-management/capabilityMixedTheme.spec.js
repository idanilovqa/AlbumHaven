import { enrollCapabilityMember } from '../actions/capabilityEditorActions.js';
import { CapabilityPresentationPage } from '../poms/capabilityPresentationPage.js';
import { readThemeColorChannels } from '../../poms/settingsModalAppBar.js';
import { test, expect } from '../support/baseFixtures.js';

function luminance(color) {
  const channels = readThemeColorChannels(color).map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
function expectSameColor(actual, expected) {
  const channels = readThemeColorChannels(actual), reference = readThemeColorChannels(expected);
  for (let index = 0; index < 3; index += 1) expect(Math.abs(channels[index] - reference[index])).toBeLessThan(1);
}

for (const client of [
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' },
]) {
  test.describe(client.name, () => {
    test.use({ viewport: client.viewport, ...(client.userAgent ? { userAgent: client.userAgent } : {}) });
    test(`FTC-CAP-AUDIT-021 ${client.name} Parchment and Pine member popup follows light content while chrome stays dark`, async ({
      page, freshBrowserSession, settingsModalAppBarActions, utilityTabBarActions, utilityAppearanceActions,
    }, testInfo) => {
      const administrator = await enrollCapabilityMember(page, freshBrowserSession,
        ['View library', 'Administer users and access']);
      const username = await new CapabilityPresentationPage(administrator.page).username.innerText();
      const ui = new CapabilityPresentationPage(page);
      await settingsModalAppBarActions.openSettings();
      await utilityTabBarActions.openTab('appearance');
      await utilityAppearanceActions.waitForReady();
      await utilityAppearanceActions.openSection('backgrounds');
      await utilityAppearanceActions.choosePalette('parchment-pine');
      await utilityAppearanceActions.save();
      await settingsModalAppBarActions.closeSettings();
      await expect(ui.root).toHaveAttribute('data-appearance-palette', 'parchment-pine');
      await expect(ui.root).toHaveAttribute('data-appearance-mode', 'light');
      const chrome = settingsModalAppBarActions.settingsModalAppBar;
      await chrome.settingsButton.click();
      await expect(chrome.accountMenu).toBeVisible();
      const chromeMenu = await ui.style(chrome.accountMenu);
      expect(luminance(chromeMenu.background)).toBeLessThan(0.2);
      expect(contrast(chromeMenu.color, chromeMenu.background)).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press('Escape');
      await ui.open();
      expect(luminance((await ui.style(ui.appBar)).background)).toBeLessThan(0.2);
      const expectedCard = await ui.contentCardColor();
      expect(luminance(expectedCard)).toBeGreaterThan(0.7);
      const trigger = ui.memberAction(username);
      await trigger.click();
      await expect(ui.openActionMenus).toBeVisible();
      await expect(ui.openActionMenus).toHaveAttribute('data-trigger-anchor-context', 'content');
      const popup = await ui.style(ui.openActionMenus), anchor = await ui.style(trigger);
      await testInfo.attach('mixed-theme-colors', { body: JSON.stringify({ expectedCard, popup, anchor, chromeMenu }, null, 2), contentType: 'application/json' });
      await page.screenshot({ path: testInfo.outputPath(`admin-parchment-${client.name}.png`), fullPage: true });
      expectSameColor(popup.background, expectedCard);
      expect(anchor.backgroundImage).toContain(`linear-gradient(${popup.background}, ${popup.background})`);
      expectSameColor(anchor.bridgeBackground, popup.background);
      expect(contrast(popup.color, popup.background)).toBeGreaterThanOrEqual(4.5);
      const edit = ui.openActionMenus.getByRole('menuitem', { name: 'Edit', exact: true });
      expect(contrast((await ui.style(edit)).color, popup.background)).toBeGreaterThanOrEqual(4.5);
      await edit.click();
      await expect(ui.heading).toBeVisible();
    });
  });
}
