const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

for (const width of [390, 1440]) {
  for (const [sourceWidth, sourceHeight] of [[360, 480], [480, 360]]) {
    test(`Gallery and Album Details show the full ${sourceWidth}x${sourceHeight} cover at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const source = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${sourceWidth}" height="${sourceHeight}"><rect width="100%" height="100%" fill="teal"/><path d="M0 0H${sourceWidth}V${sourceHeight}H0Z" fill="none" stroke="red" stroke-width="12"/></svg>`);
      await page.setContent(`<style>*{box-sizing:border-box}body{margin:0}.gallery-test{width:240px}</style>
        <section class="gallery-test"><article class="album-card"><button class="cover album-card__artbox-trigger"></button></article></section>
        <div id="track-modal" class="track-modal ${width < 720 ? 'is-mobile-page' : ''}"><div class="track-modal-dialog"><header class="track-modal-header">Начало Века — Золушка</header>
          <div class="track-modal-body"><div class="track-modal-cover"><div class="track-modal-cover-shell"></div></div><main class="track-modal-main">Tracks</main></div>
        </div></div>`);
      for (const file of ['runtime/base-layout.css', 'runtime/non-album-and-player.css', 'runtime/album-details-components.css', 'runtime/track-modal-and-lightbox.css', 'runtime/album-artbox-and-gallery-card.css', 'mobile-layout.css']) {
        await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
      }
      await page.addScriptTag({ content: 'function escapeHtml(value) { return String(value || ""); }' });
      await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime/album-artbox.js') });
      await page.evaluate(source => {
        document.querySelector('.cover').innerHTML = buildAlbumArtboxHtml({ state: 'ready', coverHtml: `<img src="${source}" alt="Gallery cover">` });
        document.querySelector('.track-modal-cover-shell').innerHTML = buildAlbumArtboxHtml({ state: 'ready', coverHtml: `<button class="track-modal-cover-button"><span class="track-modal-cover-visual"><img src="${source}" alt="Details cover"></span></button>` });
      }, source);
      await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
      for (const image of await page.locator('img').all()) {
        await expect(image).toBeVisible();
        await expect(image).toHaveCSS('object-fit', 'fill');
        const geometry = await image.evaluate(image => {
          const rect = image.getBoundingClientRect();
          const box = image.closest('.album-artbox').getBoundingClientRect();
          return { width: rect.width, height: rect.height, boxWidth: box.width, boxHeight: box.height,
            left: rect.left - box.left, top: rect.top - box.top, right: box.right - rect.right, bottom: box.bottom - rect.bottom };
        });
        expect(geometry.width).toBeGreaterThan(0);
        expect(geometry.width).toBeCloseTo(geometry.height, 0);
        expect(geometry.boxWidth).toBeCloseTo(geometry.boxHeight, 0);
        for (const edge of ['left', 'top', 'right', 'bottom']) {
          expect(geometry[edge]).toBeGreaterThanOrEqual(0);
          expect(geometry[edge]).toBeLessThanOrEqual(1);
        }
      }
    });
  }
}
