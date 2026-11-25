const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.join(__dirname, '..', '..', 'music_app', 'static');

// The production drawer markup (closed), its renderer, the shared trigger-anchor owner and the
// app's own click and keydown dispatchers. Only the network loaders are inert.
async function mountClosedDrawer(page) {
  await page.setContent(`<!doctype html>
    <input id="before-trigger" aria-label="Before">
    <button class="cover-lookup-drawer-button" id="cover-lookup-drawer-button" type="button" data-toggle-cover-lookup-drawer="1" aria-label="Cover art lookups">Lookups</button>
    <span id="cover-lookup-drawer-badge" hidden></span>
    <aside class="cover-lookup-drawer shell-info-drawer" id="cover-lookup-drawer" hidden>
      <div class="cover-lookup-drawer-header">
        <div><h3 class="cover-lookup-drawer-title">Cover lookups</h3><div id="cover-lookup-drawer-summary">No activity</div></div>
        <div class="cover-lookup-drawer-actions">
          <button class="cover-lookup-drawer-clear" id="cover-lookup-drawer-clear" type="button" disabled data-clear-cover-lookup-completed="1" aria-label="Clear completed cover art lookups">Clear</button>
          <button class="cover-lookup-drawer-close" type="button" data-close-cover-lookup-drawer="1" aria-label="Close cover art lookups">Close</button>
        </div>
      </div>
      <div class="cover-lookup-drawer-body" id="cover-lookup-drawer-body"></div>
    </aside>`);
  await page.addStyleTag({ path: path.join(staticRoot, 'css/runtime/cover-lookup-drawer-and-related.css') });
  await page.evaluate(() => {
    window.state = {
      coverLookup: {
        drawerOpen: false,
        elapsedTimer: 0,
        modal: { taskId: '' },
        pollingTimer: 0,
        tasks: ['First', 'Second'].map((album, index) => ({
          id: `task-${index}`,
          status: 'completed',
          progress: 100,
          artist: 'Artist',
          album,
          album_payload: { album_artist: 'Artist', name: album },
        })),
      },
      tagEditor: {},
      utility: { problemExclusionDrag: null, repairDragActive: false, repairSuppressClick: false },
    };
    window.escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    window.formatCoverLookupTaskElapsedLabel = () => 'Took 20s';
    window.scheduleBrowserTimeout = (callback, delay) => window.setTimeout(callback, delay);
  });
  for (const file of ['button-component.js', 'runtime/trigger-anchor.js', 'runtime/cover-lookup-modal-and-drawer.js', 'runtime/bootstrap-utility-event-handlers.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js', file) });
  }
  await page.evaluate(() => {
    window.loadCoverLookupTasks = () => Promise.resolve();
    window.ensureCoverLookupPolling = () => {};
    window.stopCoverLookupPollingIfIdle = () => {};
    window.openCoverLookupModal = () => {};
    for (const name of ['closeTagEditorExceptionMenu', 'closeUtilityLoopSettingMenu', 'handleLibrarySettingsClick']) {
      window[name] = () => false;
    }
    document.addEventListener('click', event => handleUtilityBootstrapClick(event));
    document.addEventListener('keydown', event => handleUtilityBootstrapKeyDown(event));
    renderCoverLookupDrawer();
  });
  return {
    trigger: page.locator('#cover-lookup-drawer-button'),
    drawer: page.locator('#cover-lookup-drawer'),
    close: page.getByRole('button', { name: 'Close cover art lookups' }),
  };
}

const focusIsInsideDrawer = page => page.evaluate(() => (
  document.getElementById('cover-lookup-drawer').contains(document.activeElement)
));

test('opening the notifications drawer with the keyboard moves focus into it and Escape returns it to the trigger', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const { trigger, drawer, close } = await mountClosedDrawer(page);
  await page.locator('#before-trigger').focus();
  await page.keyboard.press('Tab');
  await expect(trigger).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveClass(/is-open/);
  // The first enabled control of the panel takes focus (Clear is disabled with nothing finished to clear).
  await expect(close).toBeFocused();
  expect(await focusIsInsideDrawer(page)).toBe(true);

  // Tab keeps working inside the open panel: it reaches the first notification card.
  await page.keyboard.press('Tab');
  expect(await focusIsInsideDrawer(page)).toBe(true);
  await expect(page.locator('[data-open-cover-lookup-task="task-0"]')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(drawer).not.toHaveClass(/is-open/);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => state.coverLookup.drawerOpen)).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('closing the notifications drawer from its Close button by keyboard returns focus to the trigger', async ({ page }) => {
  const { trigger, drawer, close } = await mountClosedDrawer(page);
  await trigger.focus();
  await page.keyboard.press('Space');
  await expect(close).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('Escape closes a pointer-opened notifications drawer and keeps focus on its trigger', async ({ page }) => {
  const { trigger, drawer } = await mountClosedDrawer(page);
  await trigger.click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});
