const path = require('node:path');
const { test, expect } = require('@playwright/test');

const runtimeRoot = path.resolve(__dirname, '../../music_app/static/js/runtime');

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route('http://player-component.test/', route => route.fulfill({
    contentType: 'text/html',
    body: `<html data-compact-player-style="docked"><body>
      <button id="outside">Outside player</button>
      <section class="global-player">
        <div class="player-shell">
          <button data-ui-button-action="player-collapse">Collapse</button>
          <button data-playback-control-action="play-pause">Expanded play</button>
        </div>
        <div class="compact-player-shell">
          <button data-ui-button-action="player-expand">Expand</button>
        </div>
      </section>
    </body></html>`,
  }));
  await page.goto('http://player-component.test/');
  for (const filename of ['compact-player-helpers.js', 'playback-control-cluster.js', 'compact-player-controller.js']) {
    await page.addScriptTag({ path: path.join(runtimeRoot, filename) });
  }
  await page.evaluate(() => {
    // Isolate mode/focus behavior from the unrelated playback engine.
    syncCompactPlayerUi = () => {};
    initCompactPlayer();
  });
});

test('keyboard mode changes transfer focus to the active player controls', async ({ page }) => {
  const collapse = page.getByRole('button', { name: 'Collapse', exact: true });
  const expand = page.getByRole('button', { name: 'Expand', exact: true });
  await collapse.focus();
  await collapse.press('Enter');
  await expect(expand).toBeFocused();
  await expand.press('Enter');
  await expect(collapse).toBeFocused();
});

test('pointer mode changes leave no focus highlight after the pointer exits the player', async ({ page }) => {
  const collapse = page.getByRole('button', { name: 'Collapse', exact: true });
  const expand = page.getByRole('button', { name: 'Expand', exact: true });
  await collapse.click();
  await page.getByRole('button', { name: 'Outside player', exact: true }).hover();
  await expect(page.locator('.player-shell')).toHaveAttribute('aria-hidden', 'true');
  await expect(expand).not.toBeFocused();
  await expect(page.locator('.global-player:focus-within')).toHaveCount(0);
  await expand.click();
  await page.getByRole('button', { name: 'Outside player', exact: true }).hover();
  await expect(page.locator('.compact-player-shell')).toHaveAttribute('aria-hidden', 'true');
  await expect(collapse).not.toBeFocused();
  await expect(page.locator('.global-player:focus-within')).toHaveCount(0);
});

test('denied storage access still completes keyboard mode changes and UI synchronization', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    window.modeSyncCount = 0;
    syncCompactPlayerUi = () => { window.modeSyncCount += 1; };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Storage denied', 'SecurityError'); },
    });
  });
  const collapse = page.getByRole('button', { name: 'Collapse', exact: true });
  const expand = page.getByRole('button', { name: 'Expand', exact: true });
  await collapse.focus();
  await collapse.press('Enter');
  await expect(expand).toBeFocused();
  await expect(page.locator('.player-shell')).toHaveAttribute('aria-hidden', 'true');
  await expand.press('Enter');
  await expect(collapse).toBeFocused();
  await expect(page.locator('.compact-player-shell')).toHaveAttribute('aria-hidden', 'true');
  expect(await page.evaluate(() => window.modeSyncCount)).toBe(2);
  expect(errors).toEqual([]);
});

test('responsive expansion moves focus to playback when Collapse is hidden', async ({ page }) => {
  await page.getByRole('button', { name: 'Collapse', exact: true }).click();
  await page.getByRole('button', { name: 'Expand', exact: true }).focus();
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(page.getByRole('button', { name: 'Expanded play', exact: true })).toBeFocused();
});

test('mode changes preserve focus outside the player', async ({ page }) => {
  const outside = page.getByRole('button', { name: 'Outside player', exact: true });
  await outside.focus();
  await page.evaluate(() => applyCompactPlayerMode('compact'));
  await expect(outside).toBeFocused();
  await page.evaluate(() => applyCompactPlayerMode('expanded'));
  await expect(outside).toBeFocused();
});

test('responsive expansion retains a focus position when playback is disabled', async ({ page }) => {
  await page.getByRole('button', { name: 'Expanded play', exact: true }).evaluate(button => { button.disabled = true; });
  await page.getByRole('button', { name: 'Collapse', exact: true }).click();
  await page.getByRole('button', { name: 'Expand', exact: true }).focus();
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(page.locator('.player-shell')).toBeFocused();
});
