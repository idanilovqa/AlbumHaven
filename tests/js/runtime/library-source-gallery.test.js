const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const runtime = path.join(__dirname, '../../../music_app/static/js/runtime');
const galleryCss = fs.readFileSync(
  path.join(__dirname, '../../../music_app/static/css/gallery-main.css'),
  'utf8',
);
const mobileCss = fs.readFileSync(
    path.join(__dirname, '../../../music_app/static/css/mobile-layout.css'),
    'utf8',
);
function card(overrides = {}) {
  const context = vm.createContext({
    escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    galleryMainPlural: (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`,
  });
  vm.runInContext(fs.readFileSync(path.join(runtime, 'gallery-main-components.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(runtime, 'gallery-card-component.js'), 'utf8'), context);
  return context.buildGalleryCardHtml({
    albumKey: 'artist::album', title: 'Album', artboxHtml: '<span>Cover</span>', trackCount: 8, lengthDisplay: '43:12',
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

test('mobile gallery source actions share the duration row without enlarging the card', () => {
  const html = card();
  assert.match(
    html,
    /gallery-card__source-actions--artwork[\s\S]*?album-body gallery-card-info[\s\S]*?gallery-card__source-actions--details/,
    'desktop artwork actions and mobile details actions must have separate responsive placements',
  );
  assert.match(galleryCss, /\.gallery-card__source-actions--details \{ display: none; \}/);
  assert.match(mobileCss, /\.album-card \.gallery-card__source-actions--artwork \{ display: none; \}/);
  assert.match(mobileCss, /\.album-card \.gallery-card__source-actions--details \{ display: flex; \}/);
  assert.match(
    mobileCss,
    /@media \(max-width: 900px\)[\s\S]*?\[data-gallery-display="covers"\][\s\S]*?gallery-card__source-actions[\s\S]*?display: none/,
  );
  assert.match(
    mobileCss,
    /@media \(max-width: 900px\)[\s\S]*?gallery-source-action span[\s\S]*?display: none/,
  );
  assert.match(html, /gallery-card__status-group[\s\S]*?gallery-card__source-actions[\s\S]*?track-count[\s\S]*?album-length/);
  assert.match(mobileCss, /\.album-card \.gallery-card__source-actions \{[\s\S]*?position: static;/);
  assert.match(mobileCss, /\.album-card \.gallery-card__status-group \{[\s\S]*?grid-column: 1;[\s\S]*?grid-row: 3;/);
  assert.match(
    mobileCss,
    /@media \(max-width: 900px\)[\s\S]*?\.album-card \.gallery-source-action \{[\s\S]*?min-height: 20px;[\s\S]*?min-width: 20px;[\s\S]*?border: 0;[\s\S]*?background: transparent;/,
  );
  assert.match(mobileCss, /\.album-card \.gallery-source-action svg \{ width: 13px; height: 13px; \}/);
  assert.match(
    mobileCss,
    /@container \(max-width: 150px\)[\s\S]*?gallery-card__status-group[\s\S]*?display: contents;[\s\S]*?rating-row[\s\S]*?grid-row: 3;[\s\S]*?gallery-card__source-actions[\s\S]*?grid-row: 4;[\s\S]*?album-length[\s\S]*?grid-column: 2 \/ -1;[\s\S]*?grid-row: 4;/,
  );
  assert.match(
    mobileCss,
    /:root\[data-library-source-icons="false"\][\s\S]*?gallery-card-info[\s\S]*?track-count[\s\S]*?grid-column: 1 \/ 3;/,
  );
  assert.doesNotMatch(mobileCss, /padding-bottom: 44px/);
  assert.doesNotMatch(html, /gallery-card__duration-group/);
});

test('desktop cover-only cards retain source actions outside the omitted information area', () => {
  const html = card({ displayMode: 'covers' });

  assert.match(html, /gallery-card__source-actions/);
  assert.match(html, /aria-label="Hoard"/);
  assert.doesNotMatch(html, /album-body gallery-card-info/);
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
