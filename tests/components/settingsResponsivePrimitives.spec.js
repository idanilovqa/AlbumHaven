const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

test('narrow preview backdrop remains anchored inside its scrolling detail', async ({ page }) => {
  for (const width of [390, 730]) {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent('<div class="utility-detail" style="width:340px;height:240px;box-sizing:border-box"><div class="player-preview-dock"><div class="player-live-preview"></div></div><div style="height:500px">Scrollable editor</div></div>');
    for (const name of ['runtime/base-layout.css', 'runtime/utilities.css', 'appearance-backgrounds.css']) {
      await page.addStyleTag({ path: path.join(staticRoot, 'css', name) });
    }
    const detail = page.locator('.utility-detail');
    expect(await detail.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    const dock = page.locator('.player-preview-dock');
    const before = await dock.boundingBox();
    await detail.evaluate(element => { element.scrollTop = 80; });
    const after = await dock.boundingBox();
    expect(Math.abs(before.y - after.y - 80)).toBeLessThanOrEqual(1);
  }
});

test('hidden shared empty states stay absent and become visible when a search has no matches', async ({ page }) => {
  await page.setContent('<div class="utility-empty-state compact" hidden>No matching settings.</div>');
  await page.addStyleTag({ path: path.join(staticRoot, 'css/runtime/utilities.css') });
  const empty = page.getByText('No matching settings.', { exact: true });
  await expect(empty).toBeHidden();
  await empty.evaluate(element => { element.hidden = false; });
  await expect(empty).toBeVisible();
  await empty.evaluate(element => { element.hidden = true; });
  await expect(empty).toBeHidden();
});

test('shared editor footer keeps Reset, Cancel and Save inside a narrow dialog and actionable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent('<div id="footer-host" class="utility-modal-footer" style="width:340px;box-sizing:border-box;margin:24px auto"></div>');
  for (const name of ['runtime/base-layout.css', 'appearance-backgrounds.css', 'button-component.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', name) });
  }
  for (const name of ['button-component.js', 'editor-page.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js', name) });
  }
  await page.evaluate(() => {
    window.footerActions = [];
    EditorPage.mountFooter(document.getElementById('footer-host'), {
      resetLabel: 'Reset Player & Seekbar', status: 'Saved to your account', canSave: true,
      onReset: () => window.footerActions.push('reset'),
      secondary: { label: 'Cancel', action: () => window.footerActions.push('cancel') },
      primary: { label: 'Save', action: () => window.footerActions.push('save') },
    });
  });
  const host = page.locator('#footer-host');
  const bounds = await host.boundingBox();
  for (const name of ['Reset Player & Seekbar', 'Cancel', 'Save']) {
    const button = host.getByRole('button', { name, exact: true });
    const buttonBounds = await button.boundingBox();
    expect(buttonBounds.x).toBeGreaterThanOrEqual(bounds.x);
    expect(buttonBounds.x + buttonBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    await button.click();
  }
  expect(await host.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => window.footerActions)).toEqual(['reset', 'cancel', 'save']);
});
