const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Gallery, Album Details, and Settings use one header component; primary bars share geometry', () => {
  const pageHeader = read('music_app/templates/partials/page-gallery-bar.html');
  const galleryHeader = read('music_app/templates/partials/gallery-bar.html');
  const index = read('music_app/templates/index.html');
  const mobileCss = read('music_app/static/css/mobile-layout.css');

  assert.match(pageHeader, /from ["']partials\/gallery-bar\.html["'] import gallery_bar/);
  assert.match(pageHeader, /gallery_bar\([^)]*mobile_layout='mobile-primary'/s);
  assert.match(galleryHeader, /data-gallery-bar-layout="\{\{ mobile_layout \}\}"/);
  assert.match(index, /from ["']partials\/gallery-bar\.html["'] import gallery_bar/);
  assert.match(index, /gallery_bar\([^)]*element_id='mobile-page-header'[^)]*mobile_page=true/s);
  assert.match(index, /gallery_bar\([^)]*mobile_layout='mobile-primary'[^)]*gallery_context=true/s);
  assert.doesNotMatch(index, /<section class="mobile-page-header gallery-bar"/);
  assert.match(mobileCss, /\[data-gallery-bar-layout="mobile-primary"\]/);
  assert.doesNotMatch(
    mobileCss,
    /\.settings-outlet \.page-gallery-bar\s*\{[^}]*(?:padding|margin|top):/s,
    'Settings must not override shared mobile-header position or spacing',
  );
});

test('desktop Settings content uses the Gallery surface header origin and horizontal gutter', () => {
  const chromeCss = read('music_app/static/css/app-chrome.css');

  assert.match(
    chromeCss,
    /\.settings-host \.settings-main\s*\{[^}]*padding:\s*6px 24px 60px/s,
  );
  assert.match(
    chromeCss,
    /\.shell-main-surface:has\(> \.gallery-bar\)\s*\{[^}]*padding-top:\s*var\(--app-page-header-top\)/s,
  );
  assert.match(chromeCss, /--app-page-header-top:\s*6px/);
});
