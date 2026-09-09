const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appChromeCss = fs.readFileSync(
  path.join(__dirname, '..', '..', 'music_app', 'static', 'css', 'app-chrome.css'),
  'utf8',
);
const galleryMainCss = fs.readFileSync(
  path.join(__dirname, '..', '..', 'music_app', 'static', 'css', 'gallery-main.css'),
  'utf8',
);
const searchInputCss = fs.readFileSync(
  path.join(__dirname, '..', '..', 'music_app', 'static', 'css', 'search-input.css'),
  'utf8',
);
const appearanceCss = fs.readFileSync(
  path.join(__dirname, '..', '..', 'music_app', 'static', 'css', 'appearance-backgrounds.css'),
  'utf8',
);
const appTemplate = fs.readFileSync(
  path.join(__dirname, '..', '..', 'music_app', 'templates', 'index.html'),
  'utf8',
);

test('desktop library search aligns to the main panel outer edge', () => {
  assert.match(
    appChromeCss,
    /\.app-bar \.toolbar-left\s*\{[^}]*padding-left:\s*0;/,
  );
});

test('app-bar search keeps the native clear control close to the search action', () => {
  assert.match(
    appChromeCss,
    /\.app-bar \.search-field \.search-field-control\s*>\s*input\[type='search'\]\s*\{[^}]*padding-right:\s*0;/,
  );
});

test('shared search owns one external interaction outline with no outlined child seam', () => {
  assert.match(
    searchInputCss,
    /:root \.search-field \.search-field-control > input\[type='search'\]:focus-visible,\s*:root \.search-field \.search-field-action > \.search-field-button:focus-visible\s*\{[^}]*border:\s*0;[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/,
  );
  assert.match(
    appearanceCss,
    /:not\(\.navigation-tree-item\):not\(\.search-field-button\):not\(\.global-player \*\):hover[^\{]*\{[^}]*outline:/,
  );
});

test('narrow library search and Gallery body share the 24px content gutter', () => {
  assert.match(
    galleryMainCss,
    /@media \(max-width:\s*720px\)[\s\S]*?data-shell-horizontal-align="gallery-body"\][^}]*margin-left:\s*12px;/,
  );
});

test('Artist Family is an explicitly hidden off-canvas drawer until GalleryBar opens it', () => {
  assert.match(
    galleryMainCss,
    /\.artist-family-panel\[hidden\]\s*\{\s*display:\s*none;\s*\}/,
  );
  assert.match(
    galleryMainCss,
    /\.artist-family-panel\s*\{[^}]*position:\s*fixed;[^}]*right:\s*0;[^}]*clip-path:[^;]*;[^}]*opacity:\s*0;[^}]*transition:\s*clip-path\s+240ms\s+cubic-bezier\(\.22,\s*1,\s*\.36,\s*1\)/,
  );
  assert.match(
    galleryMainCss,
    /\.artist-family-panel\.is-open\s*\{[^}]*clip-path:[^;]*;[^}]*opacity:\s*1;/,
  );
});

test('Artist Family drawer explains how selection updates Gallery', () => {
  assert.match(appTemplate, /class="artist-family-panel__heading"/);
  assert.match(appTemplate, /Select or unselect an artist to update Gallery\./);
});

test('global appearance focus outlines exclude shared search descendants', () => {
  const globalFocusRule = appearanceCss.split('\n').find(line =>
    line.startsWith(':root :is(button, input, select,') && line.includes(':focus-visible'));
  assert.ok(globalFocusRule, 'The global focus rule must remain available to other controls');
  assert.ok(globalFocusRule.includes(':not(.search-field *)'),
    'Search input and action must share the component outer focus outline');
});

test('Gallery content cannot overpaint shared app-bar dropdowns', () => {
  assert.match(appChromeCss, /\.shell-layout > \.shell-main-surface\s*\{[^}]*position: relative;[^}]*z-index: 0;[^}]*isolation: isolate;/);
  assert.match(appChromeCss, /\.app-bar\s*\{[^}]*z-index: 100;/);
  assert.match(appTemplate, /app-chrome\.css\?v=\{\{ runtime_asset_version \}\}/);
});


test('Gallery reserves no layout space for scan errors and starts close to the app bar', () => {
  assert.doesNotMatch(appTemplate, /id="last-error"/);
  assert.match(appChromeCss, /\.shell-main-surface:has\(> \.gallery-bar\)\s*\{\s*padding-top: 6px;/);
});
