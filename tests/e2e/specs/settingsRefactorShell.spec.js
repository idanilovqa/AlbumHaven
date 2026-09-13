import { expect, test } from '../support/baseFixtures.js';
import { SettingsRefactorShell } from '../poms/settingsRefactorShell.js';

async function openProblems({ page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions }) {
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('problematic-files');
  await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
  return new SettingsRefactorShell(page);
}

async function selectRow(shell, row) {
  const title = (await shell.rowTitle(row).textContent()).trim();
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(shell.heading).toHaveText(title);
  return title;
}

async function expectFilterInside(shell) {
  await expect.poll(async () => {
    const { menu, dialog, viewport, anchor } = await shell.filterGeometry();
    return menu.left >= Math.max(0, dialog.left) - 1
      && menu.right <= Math.min(viewport.width, dialog.right) + 1
      && menu.bottom <= viewport.height + 1
      && menu.top >= anchor.bottom - 1;
  }).toBe(true);
}

test('FTC-SETTINGS-S01 six tabs preserve keyboard wrapping and joined Close hit testing', async ({
  page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions,
}) => {
  const shell = await openProblems({ page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions });
  const keys = ['problematic-files', 'rules', 'loops', 'log-history', 'integrations', 'appearance'];
  await expect(shell.tabs).toHaveCount(6);
  for (const key of keys) {
    await shell.tab(key).click();
    await expect(shell.tab(key)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => {
      const bounds = await shell.geometry();
      return bounds.tabOwnsHit && bounds.closeOwnsHit
        && Math.abs(bounds.joinedLeft - (bounds.active.left - bounds.header.left)) <= 1
        && Math.abs(bounds.joinedRight - (bounds.active.right - bounds.header.left)) <= 1;
    }).toBe(true);
  }
  await shell.tab('appearance').press('ArrowRight');
  await expect(shell.tab('problematic-files')).toBeFocused();
  await expect(shell.tab('problematic-files')).toHaveAttribute('aria-selected', 'true');
  await shell.tab('problematic-files').press('ArrowLeft');
  await expect(shell.tab('appearance')).toBeFocused();
  await shell.tab('appearance').press('Home');
  await expect(shell.tab('problematic-files')).toBeFocused();
  await shell.tab('problematic-files').press('End');
  await expect(shell.tab('appearance')).toBeFocused();
  await shell.tab('appearance').press('a');
  await expect(shell.tab('appearance')).toBeFocused();
  await expect(shell.tab('appearance')).toHaveAttribute('aria-selected', 'true');
  await shell.close.click();
  await expect(shell.dialog).toBeHidden();
});

test('FTC-SETTINGS-S02 combined search and Filters retain selection and keyboard anchor focus', async ({
  page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions,
}) => {
  const shell = await openProblems({ page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions });
  await shell.search.fill('Neal Morse Plays Pink Floyd');
  await expect(shell.rows).toHaveCount(1);
  await selectRow(shell, shell.rows.first());
  const key = await shell.activeRow().getAttribute('data-problematic-album-key');
  await shell.filters.focus();
  await shell.filters.press('ArrowDown');
  await expect(shell.filterMenu).toBeVisible();
  await expect(shell.filterOptions.first()).toBeFocused();
  await shell.filter('Missing cover art').click();
  await expect(shell.filter('Missing cover art')).toHaveAttribute('aria-selected', 'true');
  await expect(shell.filterMenu).toBeHidden();
  await shell.filters.press('ArrowDown');
  await expect(shell.filterMenu).toBeVisible();
  await expect(shell.filterOptions.first()).toBeFocused();
  await shell.filter('Missing cover art').press('Escape');
  await expect(shell.dialog).toBeVisible();
  await expect(shell.filterMenu).toBeHidden();
  await expect(shell.filters).toBeFocused();
  await expect(shell.activeRow()).toHaveAttribute('data-problematic-album-key', key);
  await shell.search.fill('');
  await expect(shell.activeRow()).toHaveAttribute('data-problematic-album-key', key);
  await shell.filters.press('ArrowDown');
  await shell.filter('Missing cover art').click();
  await expect(shell.filter('Missing cover art')).toHaveAttribute('aria-selected', 'false');
  await expect(shell.filterMenu).toBeHidden();
  await shell.filters.press('ArrowDown');
  await expect(shell.filterMenu).toBeVisible();
  await expect(shell.filterOptions.first()).toBeFocused();
  await shell.filter('Missing cover art').press('Escape');
  await expect(shell.dialog).toBeVisible();
  await expect(shell.filters).toBeFocused();
  await expect(shell.activeRow()).toHaveAttribute('data-problematic-album-key', key);
});

test('FTC-SETTINGS-S03 deep Problems selection retains the mounted tree scroll and focused row', async ({
  page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions,
}) => {
  const shell = await openProblems({ page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions });
  const count = await shell.rows.count();
  expect(count).toBeGreaterThan(10);
  const row = shell.rows.nth(count - 2);
  await row.scrollIntoViewIfNeeded();
  const retained = await shell.retainTree(row);
  try {
    expect((await retained.read()).scrollTop).toBeGreaterThan(0);
    await selectRow(shell, row);
    await expect(shell.rowMeta(row)).not.toBeEmpty();
    await expect(shell.rowCount(row)).toBeHidden();
    await expect(shell.rowArt(row)).toHaveAttribute('data-album-artbox-state', /^(ready|missing)$/);
    for (const key of ['Enter', 'Enter']) {
      await row.press(key);
      await expect(row).toBeFocused();
      const observed = await retained.read();
      expect(observed.treeRetained).toBe(true);
      expect(observed.rowRetained).toBe(true);
      expect(observed.visible).toBe(true);
      expect(Math.abs(observed.scrollDelta)).toBeLessThanOrEqual(1);
    }
  } finally { await retained.dispose(); }
});

test('FTC-SETTINGS-S04 ready and missing Problems artwork preserve selection through the real lightbox lifecycle', async ({
  page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions,
}) => {
  const shell = await openProblems({ page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions });
  const ready = shell.artworkRows('ready').first();
  await expect(ready).toBeVisible();
  await selectRow(shell, ready);
  await expect(shell.enlarge).toBeVisible();
  const key = await shell.activeRow().getAttribute('data-problematic-album-key');
  for (const activation of ['pointer', 'keyboard']) {
    if (activation === 'pointer') await shell.enlarge.click();
    else await shell.enlarge.press('Enter');
    await expect(shell.lightbox).toBeVisible();
    await expect(shell.lightboxImage).toBeVisible();
    await expect.poll(() => shell.imageLoaded(shell.lightboxImage)).toBe(true);
    await shell.lightboxClose.click();
    await expect(shell.lightbox).toBeHidden();
    await expect(shell.enlarge).toBeFocused();
    await expect(shell.activeRow()).toHaveAttribute('data-problematic-album-key', key);
  }
  await shell.search.fill('Neal Morse Plays Pink Floyd');
  await expect(shell.rows).toHaveCount(1);
  await selectRow(shell, shell.rows.first());
  await expect(shell.headerArt).toHaveAttribute('data-album-artbox-state', 'missing');
  await expect(shell.enlarge).toHaveCount(0);
  await shell.headerArt.click();
  await expect(shell.lightbox).toBeHidden();
});

test('FTC-SETTINGS-S05 an open Filters surface remains inside Settings after narrow resize and reopen', async ({
  page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const shell = await openProblems({ page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions });
  await shell.filters.click();
  await expect(shell.filterMenu).toBeVisible();
  await expectFilterInside(shell);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectFilterInside(shell);
  await shell.filterOptions.first().press('Escape');
  await expect(shell.filters).toBeFocused();
  await shell.search.fill('Neal Morse');
  await expect(shell.search).toHaveValue('Neal Morse');
  await shell.search.press('ControlOrMeta+A');
  await shell.search.press('Backspace');
  await expect(shell.search).toHaveValue('');
  await shell.close.click();
  await settingsModalAppBarActions.openSettings();
  await shell.tab('rules').click();
  await shell.tab('problematic-files').click();
  await shell.filters.click();
  await expect(shell.filterMenu).toBeVisible();
  await expectFilterInside(shell);
  expect((await shell.geometry()).closeOwnsHit).toBe(true);
  await shell.filterOptions.first().press('Escape');
  await shell.close.click();
  await expect(shell.dialog).toBeHidden();
});
