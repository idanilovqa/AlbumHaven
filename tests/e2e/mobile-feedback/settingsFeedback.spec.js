import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { MobileSettingsFeedbackPage } from '../poms/mobileSettingsFeedbackPage.js';

for (const palette of ['black', 'paper', 'parchment-pine']) {
  test(`Settings menus, empty Rules, and read-only Library use ${palette}`, async ({ page, app, snapshot }) => {
    const ui = new MobileSettingsFeedbackPage(page);
    await ui.usePalette(palette);
    await ui.openSettings();
    await ui.settingsSectionsButton.click();
    await ui.expectChromeMenu(ui.settingsDrawer);
    await ui.settingsSectionsButton.click();
    await expect(ui.settingsDrawer).not.toBeVisible();
    await ui.selectUtility('rules');
    await expect(ui.detail).toContainText('No version exceptions yet.');
    await expect(ui.detail.getByText('No version exceptions yet.')).toBeInViewport();
    await ui.subsectionButton.click();
    const selected = ui.selectedSubsection;
    await expect(selected).toHaveCSS('text-decoration-line', 'none');
    await ui.expectReadable(selected);
    await selected.hover();
    await ui.expectReadable(selected);
    await snapshot(`100-rules-menu-${palette}`);
    await ui.subsectionButton.click();
    await expect(ui.subsectionMenu).not.toBeVisible();
    await ui.selectUtility('integrations');
    await ui.selectSubsection('library');
    await ui.expectLibraryReadOnly();
    await snapshot(`101-library-readonly-${palette}`);
    await page.setViewportSize({ width: 1180, height: 900 });
    await expect(ui.libraryRefresh).toBeVisible();
    await ui.expectReadable(ui.libraryRefresh);
    await ui.expectReadable(ui.libraryPaths.first());
    await snapshot(`102-retained-settings-wide-${palette}`);
  });
}

test('Logs cards open Recent activity, export, and preserve Back and Forward', async ({ page, app, snapshot }) => {
  const ui = new MobileSettingsFeedbackPage(page);
  await ui.openSettings();
  await ui.selectUtility('log-history');
  await expect(ui.recentActivity).toBeVisible();
  await expect(ui.detail).not.toBeVisible();
  await snapshot('103-logs-index');
  await ui.recentActivity.click();
  await expect(ui.detail).toBeVisible();
  await expect(ui.list).not.toBeVisible();
  await snapshot('104-logs-detail');
  await ui.backButton.click();
  await expect(ui.recentActivity).toBeVisible();
  await page.goForward();
  await expect(ui.detail).toBeVisible();
  await page.reload();
  await expect(ui.detail).toBeVisible();
  await ui.backButton.click();
  await expect(ui.recentActivity).toBeVisible();
  await ui.filter.click();
  await expect(ui.form).toBeVisible();
  await ui.expectReadable(ui.formPanel);
  await ui.filter.click();
  await expect(ui.form).not.toBeVisible();
  await ui.filter.click();
  await ui.pageTitle.click();
  await expect(ui.form).not.toBeVisible();
});

test('Problematic Files uses generated defects and mobile cards with persistent detail navigation', async ({ page, app, snapshot }) => {
  const ui = new MobileSettingsFeedbackPage(page);
  await ui.openSettings();
  await ui.selectUtility('problematic-files');
  await expect(ui.problemCards.first()).toBeVisible();
  await expect(ui.detail).not.toBeVisible();
  await snapshot('105-problematic-index');
  await ui.problemCards.first().click();
  await expect(ui.detail).toBeVisible();
  await expect(ui.detail).toContainText(/Missing track number|Missing year/);
  await expect(ui.list).not.toBeVisible();
  expect(await ui.hasNoHorizontalOverflow()).toBe(true);
  await snapshot('106-problematic-detail');
  await ui.backButton.click();
  await expect(ui.problemCards.first()).toBeVisible();
  await ui.problemCards.first().click();
  await expect(ui.detail).toContainText(/Missing track number|Missing year/);
  await page.reload();
  await expect(ui.detail).toContainText(/Missing track number|Missing year/);
});

test('Loop pickers align their selection and repeat keeps its selected paint', async ({ page, app, snapshot }) => {
  const ui = new MobileSettingsFeedbackPage(page);
  await ui.usePalette('parchment-pine');
  await ui.openFourLoopSong();
  await expect(ui.loopCount).toHaveText('4 saved loops');
  await ui.speed.click();
  await ui.expectAnchoredSelection(ui.speedMenu, ui.speed);
  await snapshot('107-anchored-loop-speed');
  await ui.pageTitle.click();
  await expect(ui.speedMenu).not.toBeVisible();
  await ui.repeat.click();
  await expect(ui.repeat).toHaveAttribute('aria-pressed', 'true');
  // parity-check: allow-read-only-measurement-evaluate -- capture the selected control's paint after its CSS transition.
  await expect(ui.repeat).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const paint = await ui.repeat.evaluate(node => getComputedStyle(node).backgroundColor);
  await ui.play.click();
  await expect(ui.repeat).toHaveCSS('background-color', paint);
  await ui.play.click();
  await ui.pageTitle.click();
  await expect(ui.repeat).toHaveCSS('background-color', paint);
});
