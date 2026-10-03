const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
const primary = fs.readFileSync(path.join(root, 'music_app/templates/partials/primary-modals.html'), 'utf8');
const tagMarkup = primary.slice(primary.indexOf('  <div class="tag-editor-modal"'), primary.indexOf('  <div class="track-modal"'));
const confirmations = fs.readFileSync(path.join(root, 'music_app/templates/partials/confirm-modals.html'), 'utf8')
  .replace(/{%[^]*?%}|{{[^]*?}}/g, '');

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.route('http://modal-component.test/', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body>
      <div class="track-modal" id="track-modal"><div role="dialog" aria-modal="true"><button id="background-control">Album details</button></div></div>
      ${tagMarkup}${confirmations}
      <output id="confirmation-result"></output><output id="background-events">0</output>
    </body></html>`,
  }));
  await page.goto('http://modal-component.test/');
  for (const file of ['runtime/base-layout.css', 'runtime/track-modal-and-lightbox.css', 'runtime/utilities.css']) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
  }
  for (const file of ['markup-format-helpers.js', 'modal-and-overlay-helpers.js', 'utility-loaders-and-cover-lookup.js', 'tag-editor-and-optimistic-updates.js', 'track-modal-lightbox-helpers.js', 'browser-dialog-helpers.js']) {
    await page.addScriptTag({ path: path.join(root, 'music_app/static/js/runtime', file) });
  }
  await page.evaluate(() => {
    window.state = { tagEditor: {
      album: { name: 'Test album' }, tracks: [{ path: 'a.mp3' }, { path: 'b.mp3' }],
      selectedPaths: ['a.mp3', 'b.mp3'], selectedPath: 'a.mp3',
      values: { 'a.mp3': { title: 'Unsaved title' }, 'b.mp3': { title: 'Unsaved title' } },
    } };
    // Component dependencies unrelated to Escape or selection rendering.
    window.syncTagEditorPendingChanges = () => {};
    window.settleTagEditorSessionMutationClaim = () => {};
    window.getFileTypeFromPath = () => 'MP3';
    window.getFilenameFromPath = path => path;
    document.getElementById('tag-editor-modal').hidden = false;
    renderTagEditor();
    attachModalEvents();
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') document.getElementById('background-events').textContent = '1';
    });
  });
});

test('real Escape clears all file selections, disables fields, then cancels only Edit tags', async ({ page }) => {
  await page.getByLabel('Track Name', { exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#tag-editor-subtitle')).toContainText('0 selected');
  await expect(page.locator('.tag-editor-track.is-active')).toHaveCount(0);
  await expect(page.getByLabel('Track Name', { exact: true })).toBeDisabled();
  await expect(page.locator('#track-modal')).toBeVisible();
  await expect(page.locator('#background-events')).toHaveText('0');
  await page.keyboard.press('Escape');
  await expect(page.locator('#tag-editor-modal')).toBeHidden();
  await expect(page.locator('#track-modal')).toBeVisible();
  await expect(page.locator('#background-events')).toHaveText('0');
});

test('a promise-backed confirmation cancels once and leaves the editor selection intact', async ({ page }) => {
  await page.evaluate(() => {
    void showAppConfirmDialog({ title: 'Discard draft?', message: 'Test confirmation' })
      .then(accepted => { document.getElementById('confirmation-result').textContent = String(accepted); });
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('#app-confirm-modal')).toBeHidden();
  await expect(page.locator('#confirmation-result')).toHaveText('false');
  await expect(page.locator('#tag-editor-modal')).toBeVisible();
  await expect(page.locator('.tag-editor-track.is-active')).toHaveCount(2);
  await expect(page.locator('#track-modal')).toBeVisible();
  await expect(page.locator('#background-events')).toHaveText('0');
});

test('Escape targets the foreground even when keyboard focus remains behind it', async ({ page }) => {
  await page.locator('#background-control').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#tag-editor-subtitle')).toContainText('0 selected');
  await expect(page.locator('#track-modal')).toBeVisible();
  await expect(page.locator('#background-events')).toHaveText('0');
});

test('nested stacking contexts outrank a child dialog with a larger local z-index', async ({ page }) => {
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;z-index:90';
    document.body.appendChild(host);
    host.appendChild(document.getElementById('app-confirm-modal'));
    void showAppConfirmDialog({ title: 'Covered dialog', message: 'Lower stacking context' });
    document.getElementById('app-confirm-modal').style.zIndex = '9999';
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('#tag-editor-subtitle')).toContainText('0 selected');
  await expect(page.locator('#app-confirm-modal')).toBeVisible();
  await expect(page.locator('#track-modal')).toBeVisible();
});

test('Settings filter consumes first Escape and returns focus before the next closes Settings', async ({ page }) => {
  await page.addScriptTag({ path: path.join(root, 'music_app/static/js/runtime/bootstrap-utility-event-handlers.js') });
  await page.evaluate(() => {
    document.getElementById('tag-editor-modal').hidden = true;
    document.body.insertAdjacentHTML('beforeend', `<section id="utility-modal" class="utility-modal" style="z-index:200">
      <div role="dialog" aria-modal="true">
        <button id="utility-problem-filter-button" aria-expanded="true">Filter</button>
        <div id="utility-problem-filter-menu"><button data-problem-filter-value="missing">Missing tags</button></div>
      </div></section>`);
    state.utility = { activeTab: 'problematic-files', problemDropdownOpen: true };
    window.resumeDeferredUtilityViewRequest = () => {};
    document.addEventListener('keydown', handleUtilityBootstrapKeyDown);
  });
  await page.locator('[data-problem-filter-value]').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#utility-problem-filter-menu')).toBeHidden();
  await expect(page.locator('#utility-problem-filter-button')).toBeFocused();
  await expect(page.locator('#utility-problem-filter-button')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#utility-modal')).toBeVisible();
  await expect(page.locator('#track-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#utility-modal')).toBeHidden();
  await expect(page.locator('#track-modal')).toBeVisible();
});
