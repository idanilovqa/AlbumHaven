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

test('an expanded SmallAlert shows its whole message, wrapping instead of cutting it (owner, 11-08)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent('<!doctype html><html><body style="margin:0;padding:16px;background:#101a29;color:#eef3fa"><div id="host" style="display:flex;align-items:center;gap:8px"><h4 style="margin:0">LOCAL</h4></div></body></html>');
  await page.addStyleTag({ path: path.join(staticRoot, 'css', 'runtime/alert-components.css') });
  await page.addScriptTag({ content: "function escapeHtml(v){return String(v ?? '').replaceAll('\"','&quot;');}" });
  await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', 'alert-components.js') });
  await page.evaluate(() => {
    document.getElementById('host').insertAdjacentHTML('beforeend', buildSmallAlertHtml({
      severity: 'warning', focusable: true, className: 'cover-lookup-local-alert',
      message: 'Some of these covers could not be listed because a folder is busy; the list refreshes on its own.',
    }));
  });
  const alert = page.locator('.cover-lookup-local-alert');
  await alert.focus();
  await page.waitForTimeout(250);
  const fit = await alert.evaluate((node) => {
    const text = node.querySelector('.small-alert__text');
    const box = node.getBoundingClientRect();
    const textBox = text.getBoundingClientRect();
    return { clipped: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1 || textBox.right > box.right + 1,
      right: node.getBoundingClientRect().right, viewport: window.innerWidth };
  });
  expect(fit.clipped).toBe(false);
  expect(fit.right).toBeLessThanOrEqual(fit.viewport);
});
