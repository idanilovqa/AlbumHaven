const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const runtime = path.join(__dirname, '../../../music_app/static/js/runtime');
const mobileCss = fs.readFileSync(
    path.join(__dirname, '../../../music_app/static/css/mobile-layout.css'),
    'utf8',
);
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
  const html = card({ hasDuplicateFiles: true });
  assert.match(html, /data-library-sources="main hoard new_arrivals"/);
  assert.match(html, /aria-label="Hoard"/);
  assert.match(html, /aria-label="New Arrivals"/);
  assert.match(html, /<svg\b/);
  const sourceOverlay = html.match(/<div class="gallery-card__source-overlay">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.doesNotMatch(sourceOverlay, /gallery-card__source-actions/);
  assert.ok(
    html.indexOf('gallery-card__source-actions') > html.indexOf('gallery-card__source-overlay'),
    'mobile source actions must be positioned independently from the artbox overlay',
  );
});

test('mobile gallery source actions sit in card information space and never expand labels', () => {
  assert.match(
    mobileCss,
    /@media \(max-width: 900px\)[\s\S]*?\.album-card \.gallery-card__source-actions[\s\S]*?bottom:/,
  );
  assert.match(
    mobileCss,
    /@media \(max-width: 900px\)[\s\S]*?\[data-gallery-display="covers"\][\s\S]*?gallery-card__source-actions[\s\S]*?display: none/,
  );
  assert.match(
    mobileCss,
    /@media \(max-width: 900px\)[\s\S]*?gallery-source-action span[\s\S]*?display: none/,
  );
  assert.match(
    mobileCss,
    /@media \(max-width: 900px\)[\s\S]*?\.album-card \.gallery-source-action \{[\s\S]*?min-height: 36px;[\s\S]*?min-width: 36px;[\s\S]*?border: 0;[\s\S]*?background: transparent;/,
  );
  assert.match(
    mobileCss,
    /:root:not\(\[data-library-source-icons="false"\]\)[\s\S]*?padding-bottom: 44px/,
  );
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
