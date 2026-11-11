const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

for (const layout of ['classic_bar', 'stacked_bar', 'editorial_canvas']) test(`${layout} keeps expandable source alerts at the artwork bottom-left`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<!doctype html>
    <html data-album-details-layout="${layout}"><body>
      <div id="track-modal" class="is-mobile-page" data-mobile-album-layout="${layout}">
        <div class="track-modal-cover" style="width: 240px">
          <div class="track-modal-cover-shell" style="width: 240px; height: 240px"></div>
          <div class="album-details-source-markers album-details-cover-source-markers">
            <span class="small-alert small-alert--info small-alert--fit-content album-details-source-marker album-details-source-marker--hoard" role="status" aria-label="Hoard" tabindex="0">
              <span class="small-alert__icon"><svg viewBox="0 0 24 24" aria-hidden="true"></svg></span><span class="small-alert__text">Hoard</span>
            </span>
            <span class="small-alert small-alert--info small-alert--fit-content album-details-source-marker album-details-source-marker--new_arrivals" role="status" aria-label="New Arrivals" tabindex="0">
              <span class="small-alert__icon"><svg viewBox="0 0 24 24" aria-hidden="true"></svg></span><span class="small-alert__text">New Arrivals</span>
            </span>
          </div>
        </div>
      </div>
    </body></html>`);
  await page.addStyleTag({ path: path.join(staticRoot, 'css/runtime/alert-components.css') });
  await page.addStyleTag({ path: path.join(staticRoot, 'css/runtime/album-details-components.css') });
  await page.addStyleTag({ path: path.join(staticRoot, 'css/mobile-layout.css') });

  const cover = await page.locator('.track-modal-cover').boundingBox();
  const markers = await page.locator('.album-details-cover-source-markers').boundingBox();
  const sourceMarkers = await page.locator('.album-details-source-marker').all();
  const collapsedSize = layout === 'classic_bar' ? 34 : 32;
  await expect(sourceMarkers[0]).toHaveCSS('width', `${collapsedSize}px`);
  await expect(sourceMarkers[1]).toHaveCSS('width', `${collapsedSize}px`);
  const first = await sourceMarkers[0].boundingBox();
  const second = await sourceMarkers[1].boundingBox();

  expect(cover).not.toBeNull();
  expect(markers).not.toBeNull();
  expect(first.width).toBe(collapsedSize);
  expect(first.height).toBe(collapsedSize);
  expect(second.width).toBe(collapsedSize);
  expect(second.height).toBe(collapsedSize);
  expect(first.x).toBeCloseTo(cover.x + 12, 1);
  expect(second.x).toBeCloseTo(first.x, 1);
  expect(second.y).toBeCloseTo(first.y + first.height + 4, 1);
  expect(markers.y + markers.height).toBeCloseTo(cover.y + cover.height - 12, 1);

  const coverBeforeFocus = await page.locator('.track-modal-cover').boundingBox();
  const pageHeightBeforeFocus = await page.evaluate(() => document.documentElement.scrollHeight);
  await sourceMarkers[1].focus();
  await expect.poll(async () => sourceMarkers[1].evaluate((element) => {
    const style = getComputedStyle(element);
    const borders = Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
    return Math.abs(element.getBoundingClientRect().width - element.scrollWidth - borders);
  })).toBeLessThanOrEqual(0.5);
  const firstAfterFocus = await sourceMarkers[0].boundingBox();
  const expanded = await sourceMarkers[1].boundingBox();
  expect(firstAfterFocus.x).toBeCloseTo(first.x, 1);
  expect(expanded.width).toBeGreaterThan(collapsedSize);
  expect(expanded.width).toBeLessThan(150);
  expect(expanded.x).toBeCloseTo(second.x, 1);
  expect(expanded.y).toBeCloseTo(second.y, 1);
  expect(await page.locator('.track-modal-cover').boundingBox()).toEqual(coverBeforeFocus);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(pageHeightBeforeFocus);
});

test('Album Details keeps the Gallery header offset and tightens its identity lines', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<!doctype html>
    <html><body>
      <div class="shell-layout">
        <main class="shell-main-surface" data-gallery-surface>
          <header class="gallery-bar" data-gallery-bar-instance="gallery"></header>
        </main>
        <main class="shell-main-surface has-mobile-page" data-album-surface>
          <header id="mobile-page-header" class="mobile-page-header">
            <button data-mobile-back></button>
            <div class="gallery-bar__context">
              <h1 id="mobile-page-title" class="gallery-bar__title">Album</h1>
              <p id="mobile-page-summary" class="gallery-bar__summary">Artist</p>
            </div>
          </header>
          <div id="mobile-page-outlet" data-mobile-page-kind="album"></div>
          <div class="mobile-album-identity">
            <div class="album-details-header">
              <h3 class="album-details-header__primary">Album</h3>
              <div class="album-details-header__secondary">Artist</div>
            </div>
          </div>
        </main>
      </div>
    </body></html>`);
  await page.addStyleTag({ path: path.join(staticRoot, 'css/runtime/album-details-components.css') });
  await page.addStyleTag({ path: path.join(staticRoot, 'css/mobile-layout.css') });

  const styles = await page.evaluate(() => ({
    galleryTop: getComputedStyle(document.querySelector('[data-gallery-surface]')).paddingTop,
    albumTop: getComputedStyle(document.querySelector('[data-album-surface]')).paddingTop,
    headerTitleMinHeight: getComputedStyle(document.querySelector('#mobile-page-title')).minHeight,
    headerIdentityGap: getComputedStyle(document.querySelector('#mobile-page-summary')).marginTop,
    identityGap: getComputedStyle(document.querySelector('.album-details-header__secondary')).marginTop,
  }));

  expect(styles.albumTop).toBe(styles.galleryTop);
  expect(styles.headerTitleMinHeight).toBe('0px');
  expect(Number.parseFloat(styles.headerIdentityGap)).toBeLessThanOrEqual(3);
  expect(Number.parseFloat(styles.identityGap)).toBeLessThanOrEqual(3);
});
