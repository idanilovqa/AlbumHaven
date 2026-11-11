const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

test('ordered covers keep front art size and rear art outside the track table', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.setContent(`<!doctype html><html><body>
    <div class="track-modal-dialog">
      <div class="track-modal-body">
        <div class="track-modal-cover">
          <div class="track-modal-cover-shell">
            <div class="album-details-cover-stack">
              <div class="album-details-cover-stack__rear-layer">
                <button class="album-details-cover-stack__rear is-top" type="button"><span></span></button>
                <button class="album-details-cover-stack__rear is-bottom" type="button"><span></span></button>
              </div>
              <div class="album-details-cover-stack__front">
                <span class="album-artbox"><button class="track-modal-cover-button" type="button"></button></span>
              </div>
              <div class="album-details-cover-stack__navigation">
                <button class="button ui-button action-button action-button--bare album-details-cover-nav album-details-cover-nav--previous" type="button">&lt;</button>
                <button class="button ui-button action-button action-button--bare album-details-cover-nav album-details-cover-nav--next" type="button">&gt;</button>
              </div>
            </div>
          </div>
        </div>
        <div class="track-modal-main"><div class="album-track-table" style="height: 280px"></div></div>
      </div>
    </div>
  </body></html>`);
  await page.addStyleTag({ path: path.join(staticRoot, 'css/button-component.css') });
  await page.addStyleTag({ path: path.join(staticRoot, 'css/runtime/album-artbox-and-gallery-card.css') });
  await page.addStyleTag({ path: path.join(staticRoot, 'css/runtime/track-modal-and-lightbox.css') });

  const front = await page.locator('.album-details-cover-stack__front').boundingBox();
  const shell = await page.locator('.track-modal-cover-shell').boundingBox();
  const top = await page.locator('.album-details-cover-stack__rear.is-top').boundingBox();
  const bottom = await page.locator('.album-details-cover-stack__rear.is-bottom').boundingBox();
  const table = await page.locator('.track-modal-main').boundingBox();
  expect(front.width).toBeCloseTo(288, 0);
  expect(shell.height).toBeGreaterThanOrEqual(front.height + 24);
  expect(top.y).toBeLessThan(front.y);
  expect(bottom.y + bottom.height).toBeGreaterThan(front.y + front.height);
  expect(Math.max(top.x + top.width, bottom.x + bottom.width)).toBeLessThan(table.x);
  await expect(page.locator('.album-details-cover-stack__rear.is-top')).toHaveCSS('cursor', 'pointer');
  await expect(page.locator('.album-details-cover-nav--previous')).toHaveCSS('border-left-width', '0px');
  await expect(page.locator('.album-details-cover-nav--previous')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

test('reduced motion keeps the ordered-cover stack static', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setContent(`<!doctype html><html><body>
    <div class="album-details-cover-stack" style="width:288px">
      <button class="album-details-cover-stack__rear is-top" type="button"></button>
    </div>
  </body></html>`);
  await page.addStyleTag({ path: path.join(staticRoot, 'css/runtime/track-modal-and-lightbox.css') });
  const rear = page.locator('.album-details-cover-stack__rear');
  const before = await rear.evaluate((element) => getComputedStyle(element).transform);
  await page.locator('.album-details-cover-stack').evaluate((element) => {
    element.style.setProperty('--album-cover-pointer-x', '2px');
    element.style.setProperty('--album-cover-pointer-y', '2px');
    element.style.setProperty('--album-cover-pointer-rotation', '1deg');
  });
  await expect(rear).toHaveCSS('transition-duration', '0s');
  expect(await rear.evaluate((element) => getComputedStyle(element).transform)).toBe(before);
});
