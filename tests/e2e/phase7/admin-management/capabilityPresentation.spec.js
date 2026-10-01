import { enrollCapabilityMember } from '../actions/capabilityEditorActions.js';
import { CapabilityPresentationPage } from '../poms/capabilityPresentationPage.js';
import { readThemeColorChannels } from '../../poms/settingsModalAppBar.js';
import { test, expect } from '../support/baseFixtures.js';

function luminance(color) {
  const channels = readThemeColorChannels(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('FTC-CAP-AUDIT-015 Admin controls stay readable and accessible in light and dark themes', async ({
  page, freshBrowserSession, settingsModalAppBarActions, utilityTabBarActions, utilityAppearanceActions,
}, testInfo) => {
  const administrator = await enrollCapabilityMember(page, freshBrowserSession,
    ['View library', 'Administer users and access']);
  const username = await new CapabilityPresentationPage(administrator.page).username.innerText();
  const ui = new CapabilityPresentationPage(page);
  for (const [palette, mode] of [['paper', 'light'], ['graphite', 'dark']]) {
    await page.goto('/');
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('appearance');
    await utilityAppearanceActions.waitForReady();
    await utilityAppearanceActions.openSection('backgrounds');
    await utilityAppearanceActions.choosePalette(palette);
    await utilityAppearanceActions.save();
    await settingsModalAppBarActions.closeSettings();
    await ui.open();
    await expect(ui.root).toHaveAttribute('data-appearance-mode', mode);
    await ui.memberAction(username).click();
    await expect(ui.openActionMenus).toBeVisible();
    const menu = await ui.style(ui.openActionMenus);
    expect(contrast(menu.color, menu.background)).toBeGreaterThanOrEqual(4.5);
    if (mode === 'light') expect(luminance(menu.background)).toBeGreaterThan(0.7);
    else expect(luminance(menu.background)).toBeLessThan(0.2);
    await page.screenshot({ path: testInfo.outputPath(`admin-menu-${mode}.png`), fullPage: true });
    await ui.openActionMenus.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await expect(ui.heading).toBeVisible();
    await expect(ui.backToUsers).toHaveAccessibleName('Back to users');
    const back = await ui.backToUsers.boundingBox(), heading = await ui.heading.boundingBox();
    expect(back.x + back.width).toBeLessThanOrEqual(heading.x);
    expect(Math.abs(back.y + back.height / 2 - heading.y - heading.height / 2)).toBeLessThan(5);
    for (let index = 0; index < await ui.notices.count(); index += 1) {
      const surface = await ui.style(ui.notices.nth(index));
      const message = await ui.style(ui.noticeMessages.nth(index));
      expect(contrast(message.color, surface.background)).toBeGreaterThanOrEqual(4.5);
      if (mode === 'light') expect(luminance(surface.background)).toBeGreaterThan(0.7);
      else expect(luminance(surface.background)).toBeLessThan(0.2);
    }
    await expect(ui.rolesOnly).toBeDisabled();
    const disabled = await ui.style(ui.rolesOnly);
    expect(disabled.opacity).toBeLessThan(1);
    expect(disabled.cursor).toBe('not-allowed');
    await expect(ui.rolesOnly).toHaveAttribute('aria-describedby', 'roles-only-help');
    await expect(ui.help).toContainText('Select at least one role first.');
    await expect(ui.help).toContainText('Save changes');
    const button = await ui.rolesOnly.boundingBox(), help = await ui.help.boundingBox();
    const notice = await ui.followingNotice.boundingBox();
    expect(help.y).toBeGreaterThan(button.y + button.height);
    expect(notice.y).toBeGreaterThan(help.y + help.height);
    await ui.viewerRow.hover();
    const hovered = await ui.style(ui.viewerRow);
    expect(hovered.background).toBe('rgba(0, 0, 0, 0)');
    expect(hovered.shadow).toBe('none');
    await page.screenshot({ path: testInfo.outputPath(`admin-editor-${mode}.png`), fullPage: true });
    await ui.role('Viewer').check();
    await expect(ui.rolesOnly).toBeEnabled();
    expect((await ui.style(ui.rolesOnly)).opacity).toBe(1);
    await ui.role('Viewer').uncheck();
    await expect(ui.rolesOnly).toBeDisabled();
    await ui.backToUsers.click();
    await expect(page).toHaveURL(/\/admin\/members$/);
  }
});
