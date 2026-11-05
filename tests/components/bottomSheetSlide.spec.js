const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

test('mobile Cover Look Up bottom sheet slides up from the bottom edge and rests there', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent('<section class="cover-lookup-modal" hidden><div class="cover-lookup-modal-dialog" role="dialog" aria-label="Cover Art Look Up Gallery"><div class="cover-lookup-modal-header"><h3>Cover Art Look Up Gallery</h3></div><div class="cover-lookup-modal-body">Cover choices</div></div></section>');
  for (const file of ['button-component.css', 'runtime/cover-lookup-modal.css', 'mobile-layout.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  const sheet = page.getByRole('dialog', { name: 'Cover Art Look Up Gallery' });
  const firstTop = await page.evaluate(() => new Promise((resolve) => {
    const overlay = document.querySelector('.cover-lookup-modal');
    overlay.classList.add('is-mobile-sheet');
    overlay.hidden = false;
    requestAnimationFrame(() => resolve(overlay.firstElementChild.getBoundingClientRect().top));
  }));
  const slide = await sheet.evaluate((node) => node.getAnimations().map((animation) => animation.animationName));
  expect(slide).toEqual(['bottom-sheet-enter']);
  await sheet.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const box = await sheet.boundingBox();
  expect(firstTop).toBeGreaterThan(box.y + 20);
  const overlay = await page.locator('.cover-lookup-modal').boundingBox();
  expect(box.y + box.height).toBeCloseTo(overlay.y + overlay.height, 0);
});

test('bottom sheets appear without sliding when the device asks for reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent('<section class="artist-info-overlay is-mobile-artist-dialog" role="dialog" aria-label="Artist information"><p>Bio</p></section>');
  await page.addStyleTag({ path: path.join(staticRoot, 'css', 'mobile-layout.css') });
  expect(await page.getByRole('dialog').evaluate((node) => node.getAnimations().length)).toBe(0);
});
