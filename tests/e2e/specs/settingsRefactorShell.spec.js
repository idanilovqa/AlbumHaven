import { expect, test } from '../support/baseFixtures.js';
import { SettingsRefactorShell } from '../poms/settingsRefactorShell.js';
import { SettingsIntegrations } from '../poms/settingsIntegrations.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';
import { observeProblematicDetails, problemDetailExpectation, exerciseProblematicNativeJumps } from '../helpers/problematicVirtualScrollHelpers.js';

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
  let geometry;
  try {
    await expect.poll(async () => {
      geometry = await shell.filterGeometry();
      const { menu, dialog, viewport, anchor } = geometry;
      return menu.left >= Math.max(0, dialog.left) - 1
        && menu.right <= Math.min(viewport.width, dialog.right) + 1
        && menu.bottom <= viewport.height + 1
        && menu.top >= anchor.bottom - 1;
    }).toBe(true);
  } catch (error) {
    await test.info().attach('filter-boundary-geometry', {
      body: JSON.stringify(geometry || null), contentType: 'application/json',
    });
    throw error;
  }
}

test('FTC-SETTINGS-S06 searches preserve independent tab queries and unsaved editors', { tag: '@area:settings' }, async ({
  page, galleryActions, settingsModalAppBarActions, utilityTabBarActions,
  utilityRulesActions, utilityIntegrationsActions, utilityAppearanceActions,
}) => {
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await settingsModalAppBarActions.openSettings();
  const shell = new SettingsRefactorShell(page);
  const rules = utilityRulesActions.utilityRulesTab;
  const integrations = new SettingsIntegrations(page);
  const appearance = utilityAppearanceActions.utilityAppearanceTab;
  const noMatch = 'settings-search-no-match-7f402e';

  await utilityTabBarActions.openTab('rules');
  await utilityRulesActions.waitForReady();
  await utilityRulesActions.openProblemExclusions();
  await expect(rules.exclusionRows.first()).toBeVisible();
  const ruleRows = await rules.exclusionRows.count();
  const referenceKey = await rules.exclusionRows.first().getAttribute('data-cdt-row-key');
  const ruleQuery = (await rules.exclusionReason(rules.exclusionRows.first()).textContent()).trim();
  expect(ruleQuery).not.toBe('');
  await shell.search.fill(ruleQuery);
  await expect(rules.exclusionRowByKey(referenceKey)).toBeVisible();
  await shell.search.fill(noMatch);
  await expect(rules.exclusionRows).toHaveCount(0);
  await expect(rules.ruleTitle).toHaveText('Problem exclusions');
  await shell.search.fill('');
  await expect(rules.exclusionRows).toHaveCount(ruleRows);
  await shell.search.fill(ruleQuery);
  await expect(rules.exclusionRowByKey(referenceKey)).toBeVisible();

  await utilityTabBarActions.openTab('integrations');
  await utilityIntegrationsActions.waitForReady();
  await integrations.navigation('Library').click();
  await expect(integrations.roots('Main Library').first()).toBeVisible();
  await expect(shell.search).toHaveValue('');
  const integrationCount = await integrations.visibleNavigation.count();
  expect(integrationCount).toBeGreaterThan(1);
  const rootInput = integrations.roots('Main Library').first();
  const originalRoot = await rootInput.inputValue();
  const draftRoot = 'settings-search-unsaved-draft';
  await rootInput.fill(draftRoot);
  const retainedInput = await rootInput.elementHandle();
  try {
    await shell.search.fill('Foobar2000');
    await expect(integrations.visibleNavigation).toHaveCount(1);
    await expect(integrations.navigation('Foobar2000')).toBeVisible();
    await expect(integrations.navigation('Library')).toBeHidden();
    await expect(rootInput).toHaveValue(draftRoot);
    expect(await integrations.isRetainedField(retainedInput)).toBe(true);
    await shell.search.fill(noMatch);
    await expect(integrations.visibleNavigation).toHaveCount(0);
    await expect(integrations.searchEmpty).toBeVisible();
    await expect(rootInput).toHaveValue(draftRoot);
    await shell.search.fill('');
    await expect(integrations.visibleNavigation).toHaveCount(integrationCount);
    await expect(integrations.searchEmpty).toBeHidden();
    await expect(rootInput).toHaveValue(draftRoot);
    expect(await integrations.isRetainedField(retainedInput)).toBe(true);
  } finally {
    await retainedInput.dispose();
    await rootInput.fill(originalRoot);
  }
  await shell.search.fill('Library');

  await utilityTabBarActions.openTab('appearance');
  await utilityAppearanceActions.waitForReady();
  await utilityAppearanceActions.openSection('seekbar');
  await expect(shell.search).toHaveValue('');
  const appearanceCount = await appearance.visibleSectionButtons.count();
  expect(appearanceCount).toBeGreaterThan(1);
  const savedStyle = await appearance.liveLoopCluster.getAttribute('data-loop-control-style');
  const draftStyle = savedStyle === 'companion' ? 'capsule' : 'companion';
  await appearance.loopStyleButton(draftStyle).click();
  const retainedEditor = await appearance.editor.elementHandle();
  try {
    await shell.search.fill('Album page');
    await expect(appearance.visibleSectionButtons).toHaveCount(1);
    await expect(appearance.sectionButton('album-page')).toBeVisible();
    await expect(appearance.sectionButton('seekbar')).toBeHidden();
    await expect(appearance.loopStyleButton(draftStyle)).toHaveAttribute('aria-pressed', 'true');
    expect(await appearance.isRetainedEditor(retainedEditor)).toBe(true);
    await shell.search.fill(noMatch);
    await expect(appearance.visibleSectionButtons).toHaveCount(0);
    await expect(appearance.searchEmpty).toBeVisible();
    await expect(appearance.loopStyleButton(draftStyle)).toHaveAttribute('aria-pressed', 'true');
    await shell.search.fill('');
    await expect(appearance.visibleSectionButtons).toHaveCount(appearanceCount);
    await expect(appearance.searchEmpty).toBeHidden();
    await expect(appearance.loopStyleButton(draftStyle)).toHaveAttribute('aria-pressed', 'true');
    expect(await appearance.isRetainedEditor(retainedEditor)).toBe(true);
    await expect(appearance.liveLoopCluster).toHaveAttribute('data-loop-control-style', savedStyle);
  } finally {
    await retainedEditor.dispose();
    await utilityAppearanceActions.cancel();
  }
  await shell.search.fill('Album page');

  await utilityTabBarActions.openTab('rules');
  await utilityRulesActions.waitForReady();
  await expect(shell.search).toHaveValue(ruleQuery);
  await expect(rules.ruleTitle).toHaveText('Problem exclusions');
  await expect(rules.exclusionRowByKey(referenceKey)).toBeVisible();
  await utilityTabBarActions.openTab('integrations');
  await utilityIntegrationsActions.waitForReady();
  await expect(shell.search).toHaveValue('Library');
  await expect(integrations.roots('Main Library').first()).toHaveValue(originalRoot);
  await utilityTabBarActions.openTab('appearance');
  await utilityAppearanceActions.waitForReady();
  await expect(shell.search).toHaveValue('Album page');
  await expect(appearance.loopStyleButton(savedStyle)).toHaveAttribute('aria-pressed', 'true');
  await settingsModalAppBarActions.closeSettings();
});

test('FTC-SETTINGS-S01 six tabs preserve keyboard wrapping and joined Close hit testing', { tag: '@area:settings' }, async ({
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

test('FTC-SETTINGS-S02 combined search and Filters retain selection and keyboard anchor focus', { tag: '@area:settings' }, async ({
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
  await shell.filters.click();
  await expect(shell.filterMenu).toBeVisible();
  await shell.search.click();
  await expect(shell.filterMenu).toBeHidden();
  await expect(shell.filters).toHaveAttribute('aria-expanded', 'false');
  await expect(shell.search).toBeFocused();
  await expect(shell.search).toHaveValue('Neal Morse Plays Pink Floyd');
  await expect(shell.filter('Missing cover art')).toHaveAttribute('aria-selected', 'true');
  await expect(shell.activeRow()).toHaveAttribute('data-problematic-album-key', key);
  await shell.filters.press('ArrowDown');
  await expect(shell.filterMenu).toBeVisible();
  await expect(shell.filterOptions.first()).toBeFocused();
  await shell.filter('Missing cover art').press('Escape');
  await expect(shell.dialog).toBeVisible();
  await expect(shell.filterMenu).toBeHidden();
  await expect(shell.filters).toBeFocused();
  await expect(shell.activeRow()).toHaveAttribute('data-problematic-album-key', key);
  await expect(shell.filterIcon).toBeVisible();
  await shell.tab('log-history').click();
  await expect(shell.filters).toHaveAccessibleName('Period');
  await expect(shell.filterIcon).toBeVisible();
  for (const navigationKey of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    await shell.filters.press(navigationKey);
    await expect(shell.filters).toBeEnabled();
    await expect(shell.filterMenu).toBeHidden();
    await expect(shell.periodDialog).toBeHidden();
    await expect(shell.filters).toBeFocused();
  }
  await shell.filters.press('Enter');
  await expect(shell.periodDialog).toBeVisible();
  await shell.periodDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(shell.periodDialog).toBeHidden();
  await shell.tab('problematic-files').click();
  await expect(shell.filterIcon).toBeVisible();
  await expect(shell.filter('Missing cover art')).toHaveAttribute('aria-selected', 'true');
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

test('FTC-SETTINGS-S03 deep Problems selection retains the mounted tree scroll and focused row', { tag: '@area:settings' }, async ({
  page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions,
}) => {
  const capture = observeProblematicDetails(page);
  try {
    const shell = await openProblems({ page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions });
    const count = Number(await shell.resultCount.textContent());
    expect(count).toBeGreaterThan(10);
    const summary = await capture.summary();
    expect(summary).toHaveLength(count);
    const items = await utilityProblematicFilesActions.readCompleteListItems();
    expect(items.map(item => item.key)).toEqual(summary.map(item => item.key));
    const target = items[count - 2];
    await utilityProblematicFilesActions.revealListItemByIdentity({ key: target.key });
    const row = shell.rowByKey(target.key);
    await row.scrollIntoViewIfNeeded();
    const retained = await shell.retainTree(row);
    try {
      expect((await retained.read()).scrollTop).toBeGreaterThan(0);
      await selectRow(shell, row);
      await expect.poll(async () => Boolean(await capture.detail(target.key))).toBe(true);
      const expected = problemDetailExpectation(await capture.detail(target.key));
      await expect(shell.heading).toHaveText(expected.title);
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
    const jumps = await exerciseProblematicNativeJumps({ page, shell, capture });
    await test.info().attach('problematic-native-jumps', { body: JSON.stringify(jumps), contentType: 'application/json' });
  } finally { await capture.dispose(); }
});

test('FTC-SETTINGS-S04 ready and missing Problems artwork preserve selection through the real lightbox lifecycle', { tag: '@area:settings' }, async ({
  page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions,
}) => {
  const shell = await openProblems({ page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions });
  const readyKey = await utilityProblematicFilesActions.revealListItemWithArtwork('ready');
  const ready = shell.rowByKey(readyKey);
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

test('FTC-SETTINGS-S05 an open Filters surface remains inside Settings after narrow resize and reopen', { tag: '@area:settings' }, async ({
  page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions,
}) => {
  const mobile = new MobileLayoutPage(page);
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
  await mobile.backButton.click();
  await expect(shell.dialog).toBeHidden();
  await mobile.openSettings();
  await mobile.selectUtility('rules');
  await mobile.selectUtility('problematic-files');
  await shell.filters.click();
  await expect(shell.filterMenu).toBeVisible();
  await expectFilterInside(shell);
  expect(await mobile.backOwnsHit()).toBe(true);
  await shell.filterOptions.first().press('Escape');
  await mobile.backButton.click();
  await expect(shell.dialog).toBeHidden();
});
