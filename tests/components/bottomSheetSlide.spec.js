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

test('mobile bottom sheets slide back down when closed (INT-023)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent('<section class="cover-lookup-modal is-mobile-sheet"><div class="cover-lookup-modal-dialog" role="dialog" aria-label="Cover Art Look Up Gallery"><div class="cover-lookup-modal-body">Cover choices</div></div></section>'
    + '<section class="artist-info-overlay is-mobile-artist-dialog" role="dialog" aria-label="Artist information"><p>Bio</p></section><div class="mobile-artist-info-backdrop"></div>');
  for (const file of ['button-component.css', 'runtime/cover-lookup-modal.css', 'mobile-layout.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.addScriptTag({ content: require('node:fs').readFileSync(path.join(staticRoot, 'js/runtime/mobile-navigation.js'), 'utf8')
    .match(/const BOTTOM_SHEET_EXIT_MS[\s\S]*?\nfunction cancelBottomSheetExit[^\n]*\n/)[0] });
  const result = await page.evaluate(() => new Promise((resolve) => {
    const overlay = document.querySelector('.cover-lookup-modal');
    const artist = document.querySelector('.artist-info-overlay');
    const done = [];
    const sheetAnimating = runBottomSheetExit(overlay, () => done.push('cover'));
    const artistAnimating = runBottomSheetExit(artist, () => done.push('artist'), { backdrop: document.querySelector('.mobile-artist-info-backdrop') });
    const names = [
      ...overlay.firstElementChild.getAnimations().map((animation) => animation.animationName),
      ...artist.getAnimations().map((animation) => animation.animationName),
    ];
    setTimeout(() => resolve({ sheetAnimating, artistAnimating, names, done, closing: overlay.classList.contains('is-sheet-closing') }), 400);
  }));
  expect(result.sheetAnimating).toBe(true);
  expect(result.artistAnimating).toBe(true);
  expect(result.names.filter((name) => name === 'bottom-sheet-exit')).toHaveLength(2);
  expect(result.done.sort()).toEqual(['artist', 'cover']);
  expect(result.closing).toBe(false);
});
