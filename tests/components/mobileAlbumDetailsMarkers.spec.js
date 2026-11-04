const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

for (const width of [320, 390]) for (const layout of ['classic_bar', 'stacked_bar', 'editorial_canvas']) {
  test(`mobile ${layout} retains source icons through header handoff at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.setContent(`<style>body{margin:0}.shell-main-surface{position:relative}#mobile-page-outlet{height:420px;overflow:auto}#track-modal-cover{height:180px}.gallery-bar__context{min-width:0;flex:1}#mobile-page-header{display:flex;gap:6px}#mobile-page-title{font-size:16px}#mobile-page-cover{width:40px;height:40px}</style>
      <main class="shell-main-surface"><header id="mobile-page-header" class="mobile-page-header"><button id="mobile-back-button">Back</button><img id="mobile-page-cover" hidden><div class="gallery-bar__context"><h1 id="mobile-page-title" class="gallery-bar__title">A long album title</h1><p class="gallery-bar__summary" id="mobile-page-summary">Artist · 2026</p></div></header><div id="mobile-page-outlet" class="mobile-page-outlet" data-mobile-page-kind="album"><section id="track-modal"><div class="mobile-album-overview"><div class="mobile-album-overview__rail"></div><div id="track-modal-cover"></div><div class="mobile-album-identity"></div></div><div style="height:1200px">Tracks</div></section></div></main>`);
    for (const file of ['runtime/alert-components.css', 'runtime/album-details-components.css', 'mobile-layout.css']) {
      await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
    }
    await page.addScriptTag({ content: 'function escapeHtml(v){return String(v || "");} function usesMobilePageLayout(){return true;}' });
    for (const file of ['alert-components.js', 'gallery-main-components.js', 'album-details-components.js', 'mobile-navigation.js']) {
      await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
    }
    await page.evaluate(layout => {
      const identity = document.querySelector('.mobile-album-identity');
      identity.innerHTML = buildAlbumDetailsHeaderHtml({ variant:'copy', title:'A long album title', subtitle:'Artist' });
      const host = layout === 'classic_bar' ? document.querySelector('.gallery-bar__context') : identity.querySelector('.album-details-header__copy');
      host.insertAdjacentHTML('beforeend', buildAlbumCoverSourceMarkersHtml({root_provenance:{categories:['hoard','new_arrivals']}}));
      identity.hidden = layout === 'classic_bar';
      mobilePageState.pages = [{kind:'album'}];
      document.getElementById('mobile-page-outlet').addEventListener('scroll', syncMobileAlbumHeader);
      syncMobileAlbumHeader();
    }, layout);
    if (layout !== 'classic_bar') {
      await expect(page.locator('.mobile-album-identity .album-details-source-marker')).toHaveCount(2);
      await page.locator('#mobile-page-outlet').hover();
      await page.mouse.wheel(0, 600);
    }
    const header = page.locator('#mobile-page-header');
    await expect(header.locator('.album-details-source-marker--hoard')).toBeVisible();
    await expect(header.locator('.album-details-source-marker--new_arrivals')).toBeVisible();
    await expect(page.locator('.album-details-cover-source-markers')).toHaveCount(1);
    const title = await header.locator('h1').boundingBox();
    const icons = await header.locator('.album-details-cover-source-markers').boundingBox();
    expect(icons.x).toBeGreaterThanOrEqual(title.x + title.width);
    expect(icons.x + icons.width).toBeLessThanOrEqual(width);
    expect(Math.abs(icons.y + icons.height/2 - title.y - title.height/2)).toBeLessThan(3);
    if (layout !== 'classic_bar') {
      await page.locator('#mobile-page-outlet').hover();
      await page.mouse.wheel(0, -1000);
      await expect(page.locator('.mobile-album-identity .album-details-source-marker--hoard')).toBeVisible();
    }
    await page.evaluate(() => { mobilePageState.pages = [{kind:'cover-lookup'}]; syncMobileAlbumHeader(); });
    await expect(page.locator('.album-details-cover-source-markers')).toBeHidden();
  });
}

for (const layout of ['classic_bar', 'stacked_bar', 'editorial_canvas']) test(`${layout} shows source labels beside the album type`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent('<html><body><main></main></body></html>');
  await page.addStyleTag({ content: ':root { --library-source-hoard: #d6a34c; --library-source-arrivals: #58bf88; }' });
  await page.addStyleTag({ path: path.join(staticRoot, 'css/runtime/alert-components.css') });
  await page.addStyleTag({ path: path.join(staticRoot, 'css/runtime/album-details-components.css') });
  await page.addScriptTag({ content: 'function escapeHtml(value) { return String(value || ""); }' });
  await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime/alert-components.js') });
  await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime/gallery-main-components.js') });
  await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime/album-details-components.js') });
  await page.evaluate((layout) => {
    document.querySelector('main').innerHTML = buildAlbumDetailsHeaderHtml({
      layout, album: 'G_d’s Pee AT STATE’S END!', releaseType: 'ALBUM',
      sourceMarkersHtml: buildAlbumCoverSourceMarkersHtml({root_provenance: {categories: ['hoard', 'new_arrivals']}}),
    });
  }, layout);
  const type = page.locator('.album-details-header__release-type');
  const hoard = page.locator('.album-details-source-marker--hoard');
  const arrivals = page.locator('.album-details-source-marker--new_arrivals');
  await expect(hoard).toHaveText('Hoard');
  await expect(arrivals).toHaveText('New Arrivals');
  // Each source is a compact alert whose edge is that source's library color, not plain text.
  const edge = locator => locator.evaluate(element => getComputedStyle(element).getPropertyValue('--alert-edge').trim());
  expect(await edge(hoard)).toBe('#d6a34c');
  expect(await edge(arrivals)).toBe('#58bf88');
  await expect(hoard).toHaveAttribute('tabindex', '0');
  const collapsed = await hoard.boundingBox();
  await hoard.hover();
  await expect.poll(async () => (await hoard.boundingBox()).width).toBeGreaterThan(collapsed.width + 20);
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await hoard.boundingBox()).width).toBeLessThanOrEqual(collapsed.width + 1);
  const boxes = await Promise.all([type, hoard, arrivals].map(locator => locator.boundingBox()));
  for (const box of boxes) expect(box).not.toBeNull();
  expect(boxes[1].x).toBeGreaterThanOrEqual(boxes[0].x + boxes[0].width);
  expect(boxes[2].x).toBeGreaterThanOrEqual(boxes[1].x + boxes[1].width);
  expect(Math.abs((boxes[1].y + boxes[1].height / 2) - (boxes[0].y + boxes[0].height / 2))).toBeLessThanOrEqual(1);
  expect(boxes[2].x + boxes[2].width).toBeLessThanOrEqual(390);
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
