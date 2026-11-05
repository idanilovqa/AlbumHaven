const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

test('mobile artist info sits at the bottom without an anchored trigger outline', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <button class="gallery-info-button trigger-anchor-open" aria-expanded="true" aria-label="Artist info">i</button>
    <section class="artist-info-overlay is-mobile-artist-dialog" role="dialog" aria-label="Artist information">
      <button class="mobile-artist-info-close" aria-label="Close artist information">×</button>
      <div class="artist-info-overlay__body"><h2>Northlight</h2>${'<p>Artist biography.</p>'.repeat(60)}</div>
    </section>`);
  for (const file of ['gallery-main.css', 'runtime/trigger-anchor.css', 'mobile-layout.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'Northlight' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Close artist information' })).toBeVisible();
  // INT-023: the sheet slides up from the bottom edge, quickly, then rests at the bottom.
  const slide = await sheet.evaluate((node) => node.getAnimations().map((animation) => ({
    name: animation.animationName, duration: animation.effect.getTiming().duration,
  })));
  expect(slide).toEqual([{ name: 'bottom-sheet-enter', duration: 240 }]);
  await sheet.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const box = await sheet.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeCloseTo(0, 0);
  expect(box.width).toBeCloseTo(390, 0);
  expect(box.y + box.height).toBeCloseTo(844, 0);
  expect(box.height).toBeLessThanOrEqual(844 * 0.88 + 1);
  const trigger = page.getByRole('button', { name: 'Artist info', exact: true });
  await expect(trigger).toHaveCSS('box-shadow', 'none');
  await expect(trigger).toHaveCSS('outline-style', 'none');
  for (const pseudo of ['::before', '::after']) {
    expect(await trigger.evaluate((node, pseudo) => getComputedStyle(node, pseudo).display, pseudo)).toBe('none');
  }
  const body = sheet.locator('.artist-info-overlay__body');
  expect(await body.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
});
