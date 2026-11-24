const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

// INT-040 (owner, 11-08 evening): Compact and Large cover pin the source badges inside the art's bottom-left corner
// (Compact smaller and never expanding); Centered cover keeps them beside the art and a tap expands one over the
// art to its right. Every badge looks like the Gallery's: the source color outlines it and draws its glyph.
for (const width of [320, 390]) for (const layout of ['classic_bar', 'stacked_bar', 'editorial_canvas']) {
  test(`mobile ${layout} places Gallery-style source badges for its layout at ${width}px`, async ({ page }) => {
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
    const hoard = page.locator('.album-details-source-marker--hoard');
    const arrivals = page.locator('.album-details-source-marker--new_arrivals');
    await expect(hoard).toBeVisible();
    await expect(arrivals).toBeVisible();
    await expect(page.locator('.album-details-cover-source-markers')).toHaveCount(1);
    // Badges carry their names for assistive technology but never print them (Testimony showed "New Arrivals").
    await expect(page.getByText('New Arrivals', { exact: true })).toBeHidden();
    await expect(arrivals).toHaveAttribute('aria-label', 'New Arrivals');
    for (const [badge, color] of [[hoard, 'rgb(214, 163, 76)'], [arrivals, 'rgb(88, 191, 136)']]) {
      await expect(badge).toHaveCSS('border-top-color', color);
      await expect(badge).toHaveCSS('color', color);
      expect(await badge.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(color);
    }
    const artBox = await art.boundingBox();
    const [hoardBox, arrivalsBox] = await Promise.all([hoard.boundingBox(), arrivals.boundingBox()]);
    if (layout === 'editorial_canvas') {
      expect(hoardBox.x + hoardBox.width).toBeLessThanOrEqual(artBox.x + 1);
      const collapsed = hoardBox.width;
      await hoard.click();
      await expect.poll(async () => (await hoard.boundingBox()).width).toBeGreaterThan(collapsed + 20);
      const expanded = await hoard.boundingBox();
      expect(expanded.x).toBeGreaterThanOrEqual(hoardBox.x - 1);
      expect(expanded.x + expanded.width).toBeGreaterThan(artBox.x + 10);
      const onTop = await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('.album-details-source-marker--hoard')),
        [expanded.x + expanded.width - 6, expanded.y + expanded.height / 2]);
      expect(onTop).toBe(true);
      return;
    }
    const size = layout === 'stacked_bar' ? 22 : 28;
    for (const box of [hoardBox, arrivalsBox]) {
      expect(Math.round(box.width)).toBe(size);
      expect(artBox.y + artBox.height - (box.y + box.height)).toBeGreaterThanOrEqual(4);
      expect(artBox.y + artBox.height - (box.y + box.height)).toBeLessThanOrEqual(10);
    }
    expect(hoardBox.x - artBox.x).toBeGreaterThanOrEqual(4);
    expect(hoardBox.x - artBox.x).toBeLessThanOrEqual(10);
    expect(arrivalsBox.x).toBeGreaterThan(hoardBox.x + hoardBox.width);
    await hoard.click();
    if (layout === 'stacked_bar') expect((await hoard.boundingBox()).width).toBeLessThanOrEqual(size + 1);
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
      actionsHtml: '<button type="button" data-test-action style="width:32px;height:32px">x</button>',
    });
  }, layout);
  // INT-040 (owner): Edit Tags, Open folder and X sit at the top of the header in every layout; Editorial Canvas
  // centered them beside its tall title, a little lower than elsewhere.
  const header = await page.locator('.album-details-header').boundingBox();
  const action = await page.locator('[data-test-action]').boundingBox();
  if (layout !== 'classic_bar') expect(Math.abs(action.y - header.y)).toBeLessThanOrEqual(1);
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
