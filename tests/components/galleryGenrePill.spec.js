// Owner bug report 2026-11-16: "if genre is none or unavailable don't show label 'genre unavailable'".
// A genre pill shows only for a real genre, in the gallery header and on gallery cards.
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.join(path.resolve(__dirname, '../..'), 'music_app/static');

async function loadGalleryComponents(page) {
  await page.setContent('<div id="host"></div>');
  await page.addScriptTag({ content: 'window.escapeHtml = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));' });
  await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime/gallery-main-components.js') });
  for (const css of ['css/button-component.css', 'css/runtime/non-album-and-player.css', 'css/gallery-main.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, css) });
  }
}

test('no genre shows no genre pill and no placeholder text in the gallery header or on a card', async ({ page }) => {
  await loadGalleryComponents(page);
  await page.evaluate(() => {
    document.getElementById('host').innerHTML = buildGalleryBarHtml({
      contextKind: 'single-artist', artist: 'Unknown Artist', albumCount: 1,
      artist_musicbrainz: { country: 'Finland', genres: ['Genre unavailable'] },
    }) + buildGalleryCardInfoHtml({ title: 'Kingdom', artist: 'Unknown Artist', year: '2001', trackCount: 9 });
  });
  await expect(page.locator('.ui-metadata-pill--genre')).toHaveCount(0);
  await expect(page.getByText(/genre unavailable/i)).toHaveCount(0);
  await expect(page.locator('.ui-metadata-pill--country')).toHaveText('Finland');
});

test('a real genre still shows its pill in the gallery header and on a card', async ({ page }) => {
  await loadGalleryComponents(page);
  await page.evaluate(() => {
    document.getElementById('host').innerHTML = buildGalleryBarHtml({
      contextKind: 'single-artist', artist: 'Angra', albumCount: 16,
      artist_musicbrainz: { country: 'Brazil', genres: ['power metal'] },
    }) + buildGalleryCardInfoHtml({ title: 'Angels Cry', artist: 'Angra', year: '1993', trackCount: 10, genre: 'power metal' });
  });
  const pills = page.locator('.ui-metadata-pill--genre');
  await expect(pills).toHaveCount(2);
  await expect(pills.first()).toBeVisible();
  await expect(pills.nth(1)).toBeVisible();
  await expect(pills).toHaveText(['power metal', 'power metal']);
});
