const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

for (const width of [320, 390]) for (const layout of ['classic_bar', 'stacked_bar', 'editorial_canvas']) {
  test(`mobile ${layout} pins colorful source badges to the album art's top-left corner at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.setContent(`<style>body{margin:0}</style><main class="shell-main-surface"><header id="mobile-page-header" class="mobile-page-header"><div class="gallery-bar__context"><h1 class="gallery-bar__title">Testimony</h1></div></header>
      <section id="track-modal" class="is-mobile-page"><div class="track-modal-header"></div><div class="track-modal-body"><div id="track-modal-cover" class="track-modal-cover"><div class="track-modal-cover-shell" style="width:220px;height:220px;background:#345"></div></div><div>Tracks</div></div></section></main>`);
    await page.addStyleTag({ content: ':root { --library-source-hoard: #d6a34c; --library-source-arrivals: #58bf88; }' });
    for (const file of ['runtime/alert-components.css', 'runtime/album-details-components.css', 'runtime/track-modal-and-lightbox.css', 'mobile-layout.css']) {
      await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
    }
    await page.addScriptTag({ content: 'function escapeHtml(v){return String(v || "");} function usesMobilePageLayout(){return true;}' });
    for (const file of ['alert-components.js', 'gallery-main-components.js', 'album-details-components.js', 'mobile-navigation.js']) {
      await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
    }
    await page.evaluate((layout) => {
      document.documentElement.setAttribute('data-album-details-layout', layout);
      const album = { name: 'Testimony', album_artist: 'Neal Morse', root_provenance: { categories: ['hoard', 'new_arrivals'] } };
      document.querySelector('.track-modal-header').innerHTML = buildAlbumDetailsHeaderHtml({
        layout, album: 'Testimony', releaseType: 'ALBUM', sourceMarkersHtml: buildAlbumCoverSourceMarkersHtml(album),
      });
      syncMobileAlbumComposition(album);
    }, layout);
    const art = page.locator('#track-modal-cover .track-modal-cover-shell');
    const hoard = art.locator('.album-details-source-marker--hoard');
    const arrivals = art.locator('.album-details-source-marker--new_arrivals');
    await expect(hoard).toBeVisible();
    await expect(arrivals).toBeVisible();
    await expect(page.locator('.album-details-cover-source-markers')).toHaveCount(1);
    // Badges carry their names for assistive technology but never print them (Testimony showed "New Arrivals").
    await expect(page.getByText('New Arrivals', { exact: true })).toBeHidden();
    await expect(page.getByText('Hoard', { exact: true })).toBeHidden();
    await expect(arrivals).toHaveAttribute('aria-label', 'New Arrivals');
    const artBox = await art.boundingBox();
    const [hoardBox, arrivalsBox] = await Promise.all([hoard.boundingBox(), arrivals.boundingBox()]);
    expect(hoardBox.x - artBox.x).toBeGreaterThanOrEqual(4);
    expect(hoardBox.x - artBox.x).toBeLessThanOrEqual(12);
    expect(hoardBox.y - artBox.y).toBeGreaterThanOrEqual(4);
    expect(hoardBox.y - artBox.y).toBeLessThanOrEqual(12);
    expect(arrivalsBox.x).toBeGreaterThan(hoardBox.x);
    expect(Math.abs(arrivalsBox.y - hoardBox.y)).toBeLessThan(1);
    for (const [badge, color] of [[hoard, 'rgb(214, 163, 76)'], [arrivals, 'rgb(88, 191, 136)']]) {
      await expect(badge).toHaveCSS('background-color', color);
      await badge.hover();
      expect((await badge.boundingBox()).width).toBeLessThanOrEqual(30);
    }
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
