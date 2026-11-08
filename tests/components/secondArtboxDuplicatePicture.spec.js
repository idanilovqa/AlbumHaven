const path = require('node:path');
const { test, expect } = require('@playwright/test');

// UI-14 (owner, 11-08): the second artbox cannot take the same picture as the album cover, even when it comes
// from another source or at another size; it is recognized as each preview loads (dHash) and dimmed.
const root = path.join(__dirname, '..', '..');

test('the second artbox lookup dims a picture that matches the album cover and keeps different art selectable', async ({ page }) => {
  await page.setContent('<!doctype html><html><body><div id="body"></div></body></html>');
  await page.addStyleTag({ path: path.join(root, 'music_app/static/css/runtime/cover-lookup-modal.css') });
  const urls = await page.evaluate(() => {
    const draw = (size, paint) => { const c = document.createElement('canvas'); c.width = c.height = size; paint(c.getContext('2d'), size); return c.toDataURL('image/png'); };
    const sunset = (ctx, s) => { const g = ctx.createLinearGradient(0, 0, s, s); g.addColorStop(0, '#f60'); g.addColorStop(1, '#203'); ctx.fillStyle = g; ctx.fillRect(0, 0, s, s); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(s * 0.3, s * 0.6, s * 0.18, 0, Math.PI * 2); ctx.fill(); };
    const stripes = (ctx, s) => { for (let i = 0; i < 8; i += 1) { ctx.fillStyle = i % 2 ? '#0a3' : '#ee2'; ctx.fillRect(i * s / 8, 0, s / 8, s); } };
    return { cover: draw(600, sunset), sameSmall: draw(120, sunset), different: draw(120, stripes) };
  });
  await page.evaluate((urls) => {
    window.state = { coverLookup: { modal: { artboxSlot: 1, album: { key: 'a' } } } };
    window.buildAlbumDisplayCoverUrl = () => urls.cover;
    const card = (id, src) => `<div class="cover-lookup-art-card" id="${id}" role="button" tabindex="0" data-select-remote-cover="${id}"><span class="cover-lookup-art-preview"><img src="${src}" alt=""></span><span class="cover-lookup-art-action-label">Select</span></div>`;
    document.getElementById('body').innerHTML = card('same', urls.sameSmall) + card('other', urls.different);
  }, urls);
  await page.addScriptTag({ path: path.join(root, 'music_app/static/js/runtime/album-additional-artbox.js') });
  await page.evaluate(() => markSecondArtboxDuplicatePictures(document.getElementById('body')));
  await expect(page.locator('#same')).toHaveClass(/is-disabled/);
  await expect(page.locator('#same')).not.toHaveAttribute('data-select-remote-cover', /.*/);
  await expect(page.locator('#same .cover-lookup-art-action-label')).toHaveText('Same picture as the album cover');
  await page.waitForTimeout(200);
  await expect(page.locator('#other')).not.toHaveClass(/is-disabled/);
  await expect(page.locator('#other')).toHaveAttribute('data-select-remote-cover', 'other');
});
