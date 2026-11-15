const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

test('alert removal action stays in place when hovered and accepts an edge click', async ({ page }) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  for (const file of ['button-component.css', 'runtime/alert-components.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/alert-components.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js', file) });
  }
  await page.evaluate(() => {
    document.body.innerHTML = buildOnPageAlertHtml({
      severity: 'warning',
      message: 'Album files are missing.',
      actionsHtml: ButtonComponent.renderButton({ label: 'Remove from library' }),
    }) + '<output id="result"></output>';
    document.querySelector('button').addEventListener('click', () => {
      document.querySelector('#result').textContent = 'Removal requested';
    });
  });
  const button = page.getByRole('button', { name: 'Remove from library', exact: true });
  const before = await button.boundingBox();
  await button.hover();
  expect(await button.boundingBox()).toEqual(before);
  const edge = await button.evaluate(node => ({
    x: node.clientWidth / 2, y: node.clientHeight - 1,
  }));
  await button.click({ position: edge });
  await expect(page.locator('#result')).toHaveText('Removal requested');
});

test('bare lightbox close has no pointer outline and retains its keyboard focus ring', async ({ page }) => {
  await page.setContent('<!doctype html><html><body style="--lightbox-control-accent: #72baff"></body></html>');
  for (const file of ['button-component.css', 'runtime/track-modal-and-lightbox.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.addScriptTag({ path: path.join(staticRoot, 'js/button-component.js') });
  await page.evaluate(() => {
    document.body.innerHTML = ButtonComponent.renderActionButton({
      ariaLabel: 'Close full-screen cover', presentation: 'bare',
      icon: 'close', className: 'image-lightbox-close',
    });
  });
  const close = page.getByRole('button', { name: 'Close full-screen cover', exact: true });
  await expect(close).toHaveCSS('outline-style', 'none');
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await expect(close).toHaveCSS('outline-style', 'solid');
  await expect(close).toHaveCSS('outline-width', '2px');
});
