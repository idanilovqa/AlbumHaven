const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

for (const layout of ['stacked_bar', 'editorial_canvas']) test(`${layout} stacks source markers below Back without overlap`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<!doctype html>
    <html><body>
      <div id="track-modal" class="is-mobile-page" data-mobile-album-layout="${layout}">
        <div class="mobile-album-overview">
          <div class="mobile-album-overview__rail">
            <button id="mobile-back-button" type="button" aria-label="Back"></button>
            <div class="album-details-source-markers album-details-cover-source-markers">
              <span class="album-details-source-marker album-details-source-marker--hoard"></span>
              <span class="album-details-source-marker album-details-source-marker--new_arrivals"></span>
            </div>
          </div>
          <div class="track-modal-cover"></div>
          <div class="mobile-album-identity"></div>
        </div>
      </div>
    </body></html>`);
  await page.addStyleTag({ path: path.join(staticRoot, 'css/runtime/album-details-components.css') });
  await page.addStyleTag({ path: path.join(staticRoot, 'css/mobile-layout.css') });

  const back = await page.locator('#mobile-back-button').boundingBox();
  const markers = await page.locator('.album-details-cover-source-markers').boundingBox();
  const sourceMarkers = await page.locator('.album-details-source-marker').all();
  const first = await sourceMarkers[0].boundingBox();
  const second = await sourceMarkers[1].boundingBox();

  expect(back).not.toBeNull();
  expect(markers).not.toBeNull();
  expect(markers.y).toBeGreaterThanOrEqual(back.y + back.height + 8);
  expect(Math.abs((markers.x + markers.width / 2) - (back.x + back.width / 2))).toBeLessThanOrEqual(1);
  expect(second.y).toBeGreaterThanOrEqual(first.y + first.height + 2);
});
