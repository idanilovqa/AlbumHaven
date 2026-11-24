const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

test('duplicate album files alert puts numbered folder buttons beside its text with readable numbers', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 600 });
  await page.setContent('<!doctype html><html><body style="margin:0;padding:24px;background:#101a29;color:#eef3fa"><div id="host" style="width:640px"></div></body></html>');
  for (const file of ['css/button-component.css', 'css/runtime/alert-components.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, file) });
  }
  for (const file of ['js/button-component.js', 'js/runtime/alert-components.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, file) });
  }
  await page.evaluate(() => {
    document.getElementById('host').innerHTML = AlertComponent.buildOnPageAlertHtml({
      severity: 'warning', title: 'Duplicate album files', message: 'Album seems to have duplicate files:',
      actionsPlacement: 'inline',
      actionsHtml: [1, 2].map((number) => ButtonComponent.renderActionButton({
        icon: 'folder', badge: String(number), ariaLabel: `Open folder ${number}`,
      })).join(''),
    });
  });
  const message = page.locator('.on-page-alert__message');
  const first = page.getByRole('button', { name: 'Open folder 1' });
  const second = page.getByRole('button', { name: 'Open folder 2' });
  const [messageBox, firstBox, secondBox] = await Promise.all([message.boundingBox(), first.boundingBox(), second.boundingBox()]);
  expect(firstBox.x).toBeGreaterThan(messageBox.x + messageBox.width);
  expect(Math.abs((firstBox.y + firstBox.height / 2) - (messageBox.y + messageBox.height / 2))).toBeLessThan(10);
  expect(secondBox.x).toBeGreaterThan(firstBox.x);

  for (const [button, number] of [[first, '1'], [second, '2']]) {
    const badge = button.locator('.action-button__badge');
    await expect(badge).toHaveText(number);
    await expect(badge).toBeVisible();
    const colors = await badge.evaluate((node) => {
      const style = getComputedStyle(node);
      return { color: style.color, background: style.backgroundColor, size: parseFloat(style.fontSize) };
    });
    expect(colors.color).not.toBe(colors.background);
    expect(colors.size).toBeGreaterThanOrEqual(10);
  }

  await page.setViewportSize({ width: 360, height: 600 });
  await page.evaluate(() => { document.getElementById('host').style.width = '260px'; });
  const narrowMessage = await message.boundingBox();
  const narrowFirst = await first.boundingBox();
  expect(narrowFirst.y).toBeGreaterThanOrEqual(narrowMessage.y + narrowMessage.height - 1);
});
