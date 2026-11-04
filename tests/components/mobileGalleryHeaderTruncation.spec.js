const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

test('mobile gallery header truncates long artist names without truncating artist separators', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<!doctype html>
    <html><body>
      <section class="gallery-bar" data-gallery-bar-instance="gallery">
        <div class="gallery-bar__context">
          <div class="gallery-bar__title">
            <button class="mobile-bar-action" type="button" aria-label="Artists"></button>
            <span data-gallery-context-name>Adrian Leaper, Polish National Radio Symphony Orchestra</span>
            <button class="gallery-info-button" type="button" aria-label="Artist information"></button>
          </div>
          <span class="gallery-bar__summary">1 album</span>
        </div>
        <div class="gallery-bar__actions"><button class="gallery-action-button" type="button"></button></div>
      </section>
      <div class="family-artist-header" style="width: 180px">
        <h2 class="artist-name">Adrian Leaper, Polish National Radio Symphony Orchestra</h2>
        <button class="gallery-info-button" type="button"></button>
        <span class="gallery-divider__line"></span>
        <span>1 album</span>
      </div>
    </body></html>`);
  await page.addStyleTag({ path: path.join(staticRoot, 'css/gallery-main.css') });
  await page.addStyleTag({ path: path.join(staticRoot, 'css/mobile-layout.css') });

  const headerName = page.locator('[data-gallery-context-name]');
  await expect(headerName).toHaveCSS('white-space', 'nowrap');
  await expect(headerName).toHaveCSS('text-overflow', 'ellipsis');
  await expect(headerName).toHaveCSS('overflow-x', 'hidden');
  expect(await headerName.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

  const separatorName = page.locator('.family-artist-header .artist-name');
  await expect(separatorName).toHaveCSS('white-space', 'normal');
  await expect(separatorName).not.toHaveCSS('text-overflow', 'ellipsis');
});
