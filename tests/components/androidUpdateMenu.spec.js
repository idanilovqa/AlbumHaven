// The Android app's Update row in the cogwheel menu: the shipped template row, menu, stylesheet,
// shell detection and update state machine, driven by a fake shell bridge.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { renderActionButton } = require('../../music_app/static/js/button-component.js');

const root = path.resolve(__dirname, '../..');
const template = fs.readFileSync(path.join(root, 'music_app/templates/partials/account-menu.html'), 'utf8');
const settingsItem = template.match(/<button class="account-menu-item"[^>]*data-account-menu-settings[\s\S]*?<\/button>/)[0];
const updateItem = template.match(/<button class="account-menu-item"[^>]*data-android-update-menu-item[\s\S]*?<\/button>/)[0];
const handshake = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/android-bridge/v1.json'), 'utf8'))
  .handshakeResponse.payload;
const ready = { versionName: '0.10.0-sandbox.763af93', versionCode: 2 };

async function mountMenu(page, { shell = true, updates = handshake.updates } = {}) {
  const trigger = renderActionButton({
    ariaLabel: 'Settings',
    attributes: { 'data-account-menu-trigger': true, 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
  });
  await page.setContent(`<!doctype html><html><body><div class="app-bar">
    <div class="account-menu-component" data-account-menu-component>${trigger}
      <div class="account-menu" data-account-menu role="menu" aria-label="Account actions" hidden>
        ${settingsItem}${updateItem}
      </div>
    </div></div></body></html>`);
  for (const name of ['runtime/base-layout.css', 'runtime/account-menu.css', 'runtime/trigger-anchor.css', 'button-component.css']) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css', name) });
  }
  if (shell) {
    // The APK injects a plain bridge object; this one answers the handshake with `updates` and
    // records every command, answering it with `window.answer` when the test sets one.
    await page.evaluate(({ payload }) => {
      window.sent = [];
      window.AlbumHavenBridge = {
        postMessage(raw) {
          const message = JSON.parse(raw);
          window.sent.push(message.name);
          const answer = message.name === 'bridge.handshake' ? payload : window.answer;
          if (answer) setTimeout(() => this.onmessage({ data: JSON.stringify({ ...message, type: 'response', payload: answer }) }));
        },
      };
      window.shellEvent = (name, eventPayload) => window.AlbumHavenBridge.onmessage({
        data: JSON.stringify({ protocol: 1, id: 'shell-event', type: 'event', name, payload: eventPayload }),
      });
    }, { payload: { ...handshake, capabilities: ['sandbox.select.v1', 'updates.manual.v1'], updates } });
  }
  for (const name of ['capability-ui.js', 'runtime/trigger-anchor.js', 'runtime/account-menu.js',
    'runtime/android-bridge-client.js', 'runtime/android-settings.js']) {
    await page.addScriptTag({ path: path.join(root, 'music_app/static/js', name) });
  }
  await page.evaluate(async () => {
    window.state = { utility: { activeTab: 'appearance' } };
    attachAccountMenu(document.querySelector('[data-account-menu-component]'));
    initAndroidSettings();
    await connectAndroidBridge();
  });
  return {
    trigger: page.getByRole('button', { name: 'Settings', exact: true }),
    menu: page.getByRole('menu', { name: 'Account actions' }),
    row: page.locator('[data-android-update-menu-item]'),
  };
}

test('the Update row shows only inside the Android app', async ({ page }) => {
  const { trigger, menu, row } = await mountMenu(page, { shell: false });
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(1);
  await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
  await expect(row).toBeHidden();
});

test('Check for update runs from the menu, which closes and shows the new state when it reopens', async ({ page }) => {
  const { trigger, menu } = await mountMenu(page);
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const check = menu.getByRole('menuitem', { name: 'Check for update' });
  await expect(check).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(check).toBeFocused();
  await page.evaluate((updates) => { window.answer = { ok: true, updates }; }, { ...handshake.updates, state: 'checking' });
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.sent)).toEqual(['bridge.handshake', 'updates.check']);

  await trigger.click();
  const checking = menu.getByRole('menuitem', { name: 'Checking…' });
  await expect(checking).toHaveAttribute('aria-disabled', 'true');
  await expect(checking).toHaveCSS('cursor', 'not-allowed');
  await expect(checking).toHaveCSS('color', 'rgb(101, 117, 136)');
  // A busy row ignores a press and leaves the menu open.
  await checking.click({ force: true });
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => window.sent)).toEqual(['bridge.handshake', 'updates.check']);
});

test('an open menu follows the download in place, then offers Update', async ({ page }) => {
  const { trigger, menu, row } = await mountMenu(page, { updates: { ...handshake.updates, state: 'available', ...ready } });
  await trigger.click();
  const available = menu.getByRole('menuitem', { name: 'Update available Download update' });
  await expect(available).toBeVisible();
  await expect(available.locator('[data-android-update-detail]')).toHaveText('Download update');
  const box = await available.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(menuBox.x + menuBox.width);
  expect(await available.evaluate(item => item.scrollWidth <= item.clientWidth)).toBe(true);

  const event = state => page.evaluate(([name, payload]) => window.shellEvent(name, payload),
    ['updates.state', { ...handshake.updates, ...ready, ...state }]);
  for (const progress of [10, 42]) {
    await event({ state: 'downloading', progress });
    await expect(row).toHaveAccessibleName(`Downloading ${progress}%`);
    await expect(row).toHaveAttribute('aria-disabled', 'true');
    await expect(row.locator('[data-android-update-detail]')).toBeHidden();
    await expect(menu).toBeVisible();
  }
  await event({ state: 'verifying', progress: 100 });
  await expect(row).toHaveAccessibleName('Verifying update…');
  await event({ state: 'ready' });
  const install = menu.getByRole('menuitem', { name: 'Update', exact: true });
  await expect(install).not.toHaveAttribute('aria-disabled', /.*/);
  await install.click();
  await expect(menu).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.sent.at(-1))).toBe('updates.install');
});

for (const [state, name, command] of [
  [{ state: 'installing', ...ready }, 'Installing…', 'updates.install'],
  [{ state: 'failed', error: 'check_failed' }, 'Update failed. Try again', 'updates.check'],
  [{ state: 'failed', error: 'download_failed', ...ready }, 'Update failed. Try again', 'updates.download'],
]) {
  test(`${name} stays pressable and sends ${command}`, async ({ page }) => {
    const { trigger, menu } = await mountMenu(page, { updates: { ...handshake.updates, ...state } });
    await trigger.click();
    await menu.getByRole('menuitem', { name, exact: true }).click();
    await expect(menu).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.sent.at(-1))).toBe(command);
  });
}
