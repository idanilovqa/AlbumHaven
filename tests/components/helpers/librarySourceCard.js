const path = require('node:path');
const staticRoot = path.resolve(__dirname, '../../../music_app/static');

async function mountLibrarySourceCard(page, { icons = true, colors = false, outline = false, mode = 'dark' } = {}) {
  const url = 'http://library-source-component.test/';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html data-appearance-mode="${mode}" data-library-source-icons="${icons}" data-library-source-card-colors="${colors}" data-library-source-hover-outline-colors="${outline}">
    <body style="margin:40px;--panel:${mode === 'light' ? '#eef2f5' : '#203040'};--text:${mode === 'light' ? '#111' : '#fff'};--muted:#888;--border:#64748b"><main style="width:240px"></main></body></html>` }));
  await page.goto(url);
  for (const file of ['runtime/non-album-and-player.css', 'runtime/album-artbox-and-gallery-card.css', 'gallery-main.css', 'button-component.css', 'appearance-backgrounds.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.addScriptTag({ content: 'function escapeHtml(value) { return String(value); } function buildGalleryCardInfoHtml() { return "<div class=album-body>Album metadata</div>"; }' });
  await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime/gallery-card-component.js') });
  await page.evaluate(() => {
    document.querySelector('main').innerHTML = buildGalleryCardHtml({
      title: 'Source Album', albumKey: 'source-album', sourceCategories: ['main', 'hoard', 'new_arrivals'], hasDuplicateFiles: true,
      artboxHtml: '<span class="album-artbox album-artbox--ready">Album artwork</span>',
    });
  });
  return {
    art: page.getByRole('button', { name: 'Open Source Album tracklist' }),
    hoard: page.getByRole('button', { name: 'Hoard', exact: true }),
    arrivals: page.getByRole('button', { name: 'New Arrivals', exact: true }),
    duplicate: page.getByRole('button', { name: 'Duplicate files', exact: true }),
    card: page.locator('.album-card'),
  };
}

module.exports = { mountLibrarySourceCard };
