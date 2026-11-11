const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

async function mountCoverColumn(page, { saved = false, links = false } = {}) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#101a29;color:#eef3fa">
    <div class="track-modal-body" style="display:grid;grid-template-columns:288px 1fr;height:420px;padding:16px">
      <div class="track-modal-cover" id="track-modal-cover"></div><main></main>
    </div></body></html>`);
  for (const file of ['runtime/album-artbox-and-gallery-card.css', 'runtime/track-modal-and-lightbox.css', 'runtime/album-details-components.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.addScriptTag({ content: 'function escapeHtml(v){return String(v ?? "").replaceAll("\\"","&quot;");} var state={modalReleases:[],modalReleaseIndex:0,coverLookup:{modal:{}}};' });
  for (const file of ['album-artbox.js', 'album-details-components.js', 'album-additional-artbox.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
  }
  await page.evaluate(({ saved, links }) => {
    const album = { key: 'neal-morse::testimony', name: 'Testimony', cover_path: 'cover.jpg',
      additional_artworks: saved ? [{ slot: 1, source_kind: 'local', cover_path: 'back.jpg' }] : [] };
    window.buildAlbumDisplayCoverUrl = () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    window.albumHasDisplayCover = () => true;
    state.modalReleases = [album];
    const cover = document.getElementById('track-modal-cover');
    cover.innerHTML = `<div class="track-modal-cover-shell">${buildAlbumArtboxHtml({ state: 'ready', label: 'Album cover', coverHtml: '<span style="display:block;width:100%;height:100%;background:#345"></span>' })}</div>`;
    if (!saved) albumAdditionalArtboxState.pendingAlbumKey = album.key;
    renderAlbumAdditionalArtbox(cover, album);
    if (links) cover.insertAdjacentHTML('beforeend', buildAlbumServiceLinksHtml([{ provider: 'discogs', url: 'https://www.discogs.com/release/663181' }, { provider: 'musicbrainz', url: 'https://musicbrainz.org/release/x' }]));
  }, { saved, links });
}

for (const scenario of [{ saved: false, links: false }, { saved: true, links: true }]) {
  test(`two artboxes stay square inside the cover column (${scenario.saved ? 'saved art with links' : 'new Add art box'})`, async ({ page }) => {
    await mountCoverColumn(page, scenario);
    const column = await page.locator('#track-modal-cover').boundingBox();
    const shells = page.locator('#track-modal-cover .track-modal-cover-shell');
    await expect(shells).toHaveCount(2);
    const [first, second] = await Promise.all([shells.nth(0).boundingBox(), shells.nth(1).boundingBox()]);
    for (const box of [first, second]) {
      expect(Math.abs(box.width - box.height)).toBeLessThan(2);
      expect(box.y + box.height).toBeLessThanOrEqual(column.y + column.height + 1);
    }
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
    if (scenario.saved) {
      const links = page.locator('.album-details-service-links');
      await expect(links.locator('a')).toHaveText(['Discogs', 'MusicBrainz']);
      const linkBoxes = await links.locator('a').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
      expect(Math.abs(linkBoxes[0] - linkBoxes[1])).toBeLessThan(2);
      const linksBox = await links.boundingBox();
      expect(linksBox.x).toBeCloseTo(first.x, 0);
      expect(linksBox.y + linksBox.height).toBeLessThanOrEqual(column.y + column.height + 1);
      await expect(links.locator('a').first()).toHaveCSS('text-decoration-line', 'none');
      await links.locator('a').first().hover();
      await expect(links.locator('.album-details-service-link__label').first()).toHaveCSS('text-decoration-line', 'underline');
      await expect(links.locator('img').first()).toHaveCSS('text-decoration-line', 'none');
    } else {
      const add = page.getByRole('button', { name: 'Add art' });
      await expect(add).toBeVisible();
      await expect(add.locator('.album-artbox__add-plus')).toHaveText('+');
      await expect(add.locator('.album-artbox__add-plus')).toHaveCSS('border-top-width', '0px');
    }
  });
}
