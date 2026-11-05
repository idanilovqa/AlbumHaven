const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

async function mountAlbumPage(page, { mobile = false, setting = 'enabled' } = {}) {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 });
  await page.setContent(`<!doctype html><html data-album-art-quality-alert="${setting}"><body style="margin:0;background:#101a29;color:#eef3fa">
    <section id="track-modal" class="${mobile ? 'is-mobile-page' : ''}"><div class="track-modal-header"></div>
      <div class="track-modal-body" style="display:grid;grid-template-columns:${mobile ? '1fr' : '288px 1fr'};padding:16px;gap:16px">
        <div class="track-modal-cover" id="track-modal-cover"><div class="track-modal-cover-shell" style="width:${mobile ? 220 : 288}px;height:${mobile ? 220 : 288}px;background:#345"></div></div>
        <main style="height:300px">Tracks</main>
      </div></section></body></html>`);
  for (const file of ['runtime/alert-components.css', 'runtime/album-artbox-and-gallery-card.css', 'runtime/track-modal-and-lightbox.css', 'runtime/album-details-components.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.addScriptTag({ content: `function escapeHtml(v){return String(v ?? '').replaceAll('"','&quot;');} function usesMobilePageLayout(){return ${mobile};}` });
  for (const file of ['alert-components.js', 'album-details-components.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
  }
  await page.evaluate(() => {
    document.querySelector('.track-modal-header').innerHTML = buildAlbumDetailsHeaderHtml({ layout: 'classic_bar', artist: 'Sandy Alex G', album: 'Rocket', poorArtQuality: true });
    renderAlbumArtQualityAlert(document.getElementById('track-modal-cover'), { poor_art_quality: true });
  });
}

test('desktop poor-art warning sits on the art top-right and expands leftward to its text with no dead space', async ({ page }) => {
  await mountAlbumPage(page);
  await expect(page.locator('.track-modal-header')).not.toContainText('Poor art quality');
  const alert = page.locator('.track-modal-cover-shell > .album-details-art-quality-alert');
  await expect(alert).toBeVisible();
  const art = await page.locator('.track-modal-cover-shell').boundingBox();
  const collapsed = await alert.boundingBox();
  expect(art.x + art.width - (collapsed.x + collapsed.width)).toBeCloseTo(8, 0);
  expect(collapsed.y - art.y).toBeCloseTo(8, 0);
  expect(collapsed.width).toBeLessThanOrEqual(31);

  await alert.hover();
  await expect.poll(async () => (await alert.boundingBox()).width).toBeGreaterThan(collapsed.width + 40);
  await page.waitForTimeout(250);
  const expanded = await alert.boundingBox();
  expect(expanded.x + expanded.width).toBeCloseTo(collapsed.x + collapsed.width, 0);
  expect(expanded.x).toBeLessThan(collapsed.x - 40);
  const text = await alert.locator('.small-alert__text').boundingBox();
  await expect(alert.locator('.small-alert__text')).toHaveText('Poor art quality');
  // No dead space: the pill ends right after its text padding.
  expect(expanded.x + expanded.width - (text.x + text.width)).toBeLessThanOrEqual(2);
});

test('the Album page setting hides the poor-art warning', async ({ page }) => {
  await mountAlbumPage(page, { setting: 'disabled' });
  await expect(page.locator('.album-details-art-quality-alert')).toBeHidden();
  await expect(page.getByText('Poor art quality')).toBeHidden();
});

test('mobile poor-art warning sits on the page body top-right, not in the header', async ({ page }) => {
  await mountAlbumPage(page, { mobile: true });
  const alert = page.locator('.track-modal-body > .album-details-art-quality-alert');
  await expect(alert).toBeVisible();
  await expect(page.locator('.track-modal-header .album-details-art-quality-alert')).toHaveCount(0);
  const body = await page.locator('.track-modal-body').boundingBox();
  const box = await alert.boundingBox();
  expect(body.x + body.width - (box.x + box.width)).toBeCloseTo(8, 0);
  expect(box.y - body.y).toBeCloseTo(8, 0);
});
