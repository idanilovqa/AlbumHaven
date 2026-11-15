const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Owner (11-08): Mark As A Version lists albums with the same navigation-tree element as the split-release choice
// (the wide item with the green accent on the left when selected).
const root = path.join(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Mark As A Version selects an album with the same wide navigation-tree item as the split-release choice', async ({ page }) => {
  await page.setContent(`<!doctype html><html><body style="background:#111;color:#eee">
    <script type="text/plain" id="navigation-tree-item-template">${read('music_app/templates/components/navigation-tree-item.html')}</script>
    <div id="app-form-modal"><div id="app-form-content" style="width:420px"></div></div></body></html>`);
  for (const css of ['music_app/static/css/navigation-tree.css', 'music_app/static/css/runtime/utilities.css']) {
    await page.addStyleTag({ path: path.join(root, css) });
  }
  await page.addScriptTag({ path: path.join(root, 'music_app/static/js/navigation-tree.js') });
  await page.addScriptTag({ content: `
    var state = { view: {} };
    function escapeHtml(value) { return String(value ?? ''); }
    function buildUtilityAlbumArtbox() { return '<span class="utility-detail-cover" style="display:block;width:40px;height:40px"></span>'; }
    ${read('music_app/static/js/runtime/modal-and-overlay-helpers.js').match(/function buildVersionPickerListHtml[\s\S]*?\r?\n}\r?\n/)[0]}
  ` });
  const styles = await page.evaluate(() => {
    const content = document.getElementById('app-form-content');
    const album = { key: 'holy-war-2014', name: 'Holy War', year: '2014', album_artist: 'Thy Majestie' };
    const read = (item) => {
      const style = getComputedStyle(item);
      const accent = getComputedStyle(item, '::before');
      return { tree: item.getAttribute('data-navigation-tree-item'), background: style.backgroundColor, border: style.borderColor,
        radius: style.borderRadius, padding: style.padding, accent: accent.backgroundColor, accentWidth: accent.width,
        accentContent: accent.content, height: Math.round(item.getBoundingClientRect().height) };
    };
    content.innerHTML = `<nav class="navigation-tree navigation-tree--choice">${buildVersionPickerListHtml([album], new Set([album.key]))}</nav>`;
    const version = read(content.querySelector('[data-version-picker-target]'));
    content.innerHTML = `<nav class="navigation-tree navigation-tree--choice">${window.NavigationTree.renderItem({
      variant: 'wide', action: true, key: '1', label: album.name, selected: true, subtitle: album.album_artist, year: album.year,
      artworkHtml: buildUtilityAlbumArtbox(), attributes: { 'data-cover-lookup-split-release': '1' } })}</nav>`;
    const split = read(content.querySelector('[data-cover-lookup-split-release]'));
    return { version, split };
  });
  expect(styles.version.tree).toBe('wide');
  expect(styles.version).toEqual(styles.split);
});
