const path = require('node:path');
const { test, expect } = require('@playwright/test');

// UI-14 (owner, 11-08): adding the second artbox never resizes the first, not even by a pixel.
const root = path.join(__dirname, '..', '..');
const shell = (extra = '') => `<div class="track-modal-cover-shell${extra}"><span class="album-artbox album-artbox--ready"><button class="track-modal-cover-button" type="button" style="display:block;width:100%;height:100%;background:#345"></button></span></div>`;

for (const links of [false, true]) {
  test(`the album cover keeps its size when a second artbox is added${links ? ' (with service links)' : ''}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.setContent(`<!doctype html><html><body style="margin:0">
      <section id="track-modal"><div class="track-modal-dialog" style="height:640px;display:flex;flex-direction:column">
        <div class="track-modal-body" style="display:grid;grid-template-columns:334px 1fr;flex:1 1 auto;min-height:0">
          <div class="track-modal-cover" id="cover">${shell()}${links ? '<div class="album-details-service-links" style="height:18px">Links</div>' : ''}</div>
          <main>Tracks</main>
        </div></div></section></body></html>`);
    for (const file of ['runtime/album-artbox-and-gallery-card.css', 'runtime/track-modal-and-lightbox.css']) {
      await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
    }
    const size = () => page.locator('#cover > .track-modal-cover-shell').first().evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { width: box.width, height: box.height, left: box.left, top: box.top };
    });
    const before = await size();
    await page.evaluate((html) => document.getElementById('cover').insertAdjacentHTML('beforeend', html), shell(' track-modal-additional-artbox'));
    const after = await size();
    expect(after).toEqual(before);
    expect(before.width).toBeGreaterThan(200);
  });
}
