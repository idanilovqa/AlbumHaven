import { expect, test } from '../support/baseFixtures.js';
import { SettingsIntegrations } from '../poms/settingsIntegrations.js';
import { withUnavailableOwnedPickerRoot } from '../helpers/ownedUnavailableRoot.js';

test('FTC-SETTINGS-I01 real folder picking preserves Cancel and validates saved root membership', { tag: '@area:integrations' }, async ({
  page, galleryActions, appBarActions, settingsModalAppBarActions, utilityTabBarActions, utilityIntegrationsActions,
}) => {
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('integrations');
  await utilityIntegrationsActions.waitForReady();
  const ui = new SettingsIntegrations(page);
  await ui.navigation('Library').click();
  await expect(ui.save).toBeEnabled();
  const before = await ui.readSettings();
  const categories = [
    ['Main Library', 'main_library_roots', 'Main additional'],
    ['Hoard', 'hoarding_library_roots', 'Hoard additional'],
    ['New Arrivals', 'new_arrivals_roots', 'Incoming additional'],
  ];
  try {
    await expect(ui.detail).not.toContainText('Folder layout');
    for (const [title, category, folder] of categories) {
      const initialCount = Math.max(1, before[category].length);
      await expect(ui.roots(title)).toHaveCount(initialCount);
      if (!before[category].length) await expect(ui.roots(title).first()).toHaveValue('');
      await ui.add(title);
      await expect(ui.roots(title)).toHaveCount(initialCount + 1);
      await expect(ui.roots(title).last()).toHaveValue('');
      await ui.chooseLast(title, folder, true);
      await expect(ui.roots(title).last()).toHaveValue('');
      await ui.chooseLast(title, folder);
      await expect(ui.roots(title).last()).not.toHaveValue('');
    }
    for (const [label, title, category, key] of [
      ['Library destination', 'Main Library', 'main_library_roots', 'preferred_main_write_root'],
      ['Move to Hoard', 'Hoard', 'hoarding_library_roots', 'move_new_arrivals_to'],
    ]) {
      await ui.enableMovePolicy(label);
      if ((await ui.rootValues(title)).filter(value => value.trim()).length === 1) {
        await expect(ui.policyTrigger(label)).toHaveCount(0);
        continue;
      }
      await ui.choosePolicy(label, await ui.roots(title).last().inputValue());
      const original = before[category].find(root => root.id === before.move_policy[key]);
      await ui.choosePolicy(label, original ? original.path : (await ui.rootValues(title)).find(value => value.trim()));
    }
    const chosen = await ui.roots('Main Library').last().inputValue();
    await ui.add('Main Library');
    await ui.roots('Main Library').last().fill(chosen);
    expect((await ui.saveResult()).status).toBe(400);
    await expect(ui.error).toContainText(/duplicate|overlap/iu);
    expect(await ui.readSettings()).toEqual(before);
    const missingSibling = `${chosen.replace(/[\\/][^\\/]+$/u, '')}/Missing owned directory`;
    await ui.roots('Main Library').last().fill(missingSibling);
    expect((await ui.saveResult()).status).toBe(400);
    await expect(ui.error).toContainText(/available directory/iu);
    expect(await ui.readSettings()).toEqual(before);
    await ui.removeLast('Main Library');
    expect((await ui.saveResult()).status).toBe(200);
    const saved = await ui.readSettings();
    for (const [, category] of categories) expect(saved[category]).toHaveLength(before[category].length + 1);
    await appBarActions.waitForIncrementalScanComplete();
    await withUnavailableOwnedPickerRoot(chosen, async () => {
      expect((await ui.saveResult()).status).toBe(200);
      expect(await ui.readSettings()).toEqual(saved);
      await expect(ui.watcherWarning).toBeVisible();
      await expect.poll(() => ui.readWatcherWarningPlacement()).toEqual({
        separate: true, insideViewport: true, saveOwnsHit: true, dismissOwnsHit: true,
      });
      // Making the saved root unavailable intentionally raises the persistent warning.
      // Acknowledge it as a user before further Settings actions or reload.
      await ui.acknowledgeUnavailableRootWarning();
    });
    await page.reload();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('integrations');
    await utilityIntegrationsActions.waitForReady();
    await ui.navigation('Library').click();
    await expect(ui.save).toBeEnabled();
    expect(await ui.readSettings()).toEqual(saved);
    for (const [title, category] of categories) await expect(ui.roots(title)).toHaveCount(saved[category].length);
  } finally {
    await appBarActions.waitForIncrementalScanComplete();
    await ui.navigation('Library').click();
    for (const [title, category] of categories) {
      const retainedCount = Math.max(1, before[category].length);
      while (await ui.roots(title).count() > retainedCount) await ui.removeLast(title);
      if (!before[category].length) {
        await ui.removeLast(title);
        await expect(ui.roots(title)).toHaveCount(1);
        await expect(ui.roots(title).first()).toHaveValue('');
      }
    }
    expect((await ui.saveResult()).status).toBe(200);
    expect(await ui.readSettings()).toEqual(before);
  }
});

test('FTC-SETTINGS-I02 Scrobbling statistics and readable Foobar help retain disabled playlist import', { tag: '@area:integrations' }, async ({
  page, galleryActions, settingsModalAppBarActions, utilityTabBarActions, utilityIntegrationsActions,
}) => {
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('integrations');
  await utilityIntegrationsActions.waitForReady();
  const ui = new SettingsIntegrations(page);
  await ui.navigation('Scrobbling').click();
  await expect(ui.playbackStatistics).toBeVisible();
  await expect(ui.detail).toContainText('Local playcount');
  await expect(ui.detail).toContainText('Total listening time');
  await ui.navigation('Foobar2000').click();
  await expect(ui.importButton).toBeDisabled();
  await ui.instructions.click();
  await expect(ui.guide).toBeVisible();
  await expect(ui.guideButtons).toHaveCount(1);
  await expect(ui.guideClose).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(async () => {
      const box = await ui.guideGeometry();
      return box.left >= 0 && box.right <= box.width && box.top >= 0 && box.bottom <= box.height && box.scrolls === 1;
    }).toBe(true);
  }
  await ui.guideClose.click();
  await ui.navigation('Import Local Playlist').click();
  await expect(ui.importButton).toHaveCount(1);
  await expect(ui.importButton).toBeDisabled();
});
