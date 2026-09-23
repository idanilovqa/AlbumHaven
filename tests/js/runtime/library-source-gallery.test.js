const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const runtime = path.join(__dirname, '../../../music_app/static/js/runtime');
function card(overrides = {}) {
  const context = vm.createContext({
    escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    buildGalleryCardInfoHtml: () => '<div>Album metadata</div>',
  });
  vm.runInContext(fs.readFileSync(path.join(runtime, 'gallery-card-component.js'), 'utf8'), context);
  return context.buildGalleryCardHtml({
    albumKey: 'artist::album', title: 'Album', artboxHtml: '<span>Cover</span>',
    sourceCategories: ['main', 'hoard', 'new_arrivals'], ...overrides,
  });
}

test('mixed-source cards retain Main, Hoard and New Arrivals categories for independent styling', () => {
  const html = card();
  assert.match(html, /data-library-sources="main hoard new_arrivals"/);
  assert.match(html, /aria-label="Hoard"/);
  assert.match(html, /aria-label="New Arrivals"/);
  assert.match(html, /<svg\b/);
});

test('duplicate warning opens album details as an independent accessible artbox action', () => {
  const html = card({ hasDuplicateFiles: true });
  assert.match(html, /<button[^>]*aria-label="Duplicate files"[^>]*>/);
  const warning = html.match(/<button[^>]*aria-label="Duplicate files"[^>]*>/)?.[0];
  assert.match(warning, /data-open-tracklist="1"/);
  assert.match(warning, /data-album-key="artist::album"/);
  assert.doesNotMatch(html, /duplicate issues exist/i);
  let depth = 0;
  for (const tag of html.matchAll(/<\/?button\b[^>]*>/g)) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    assert.ok(depth <= 1, 'Hover actions must not nest inside the artbox button');
  }
  assert.equal(depth, 0);
});

test('normal albums do not receive a duplicate warning or unknown source markup', () => {
  const html = card({ sourceCategories: ['main', '<script>'], hasDuplicateFiles: false });
  assert.doesNotMatch(html, /aria-label="Duplicate files"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-library-sources="main"/);
});
