const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../../..');
const template = fs.readFileSync(path.join(root, 'music_app/templates/partials/app-bar.html'), 'utf8');
const appChromeCss = fs.readFileSync(path.join(root, 'music_app/static/css/app-chrome.css'), 'utf8');
const baseLayoutCss = fs.readFileSync(path.join(root, 'music_app/static/css/runtime/base-layout.css'), 'utf8');

test('the shared app bar renders the Album Haven mark as a theme-aware component', () => {
  assert.match(template, /class="app-bar-brand-mark"/);
  assert.match(template, /class="app-bar-brand-label"/);
  assert.match(template, /class="app-bar-brand-label-hole"/);
  assert.match(appChromeCss, /\.app-bar-brand-label\s*\{[^}]*background:\s*var\(--appearance-play,/s);
  assert.match(appChromeCss, /\.app-bar-brand-label-hole\s*\{[^}]*background:\s*var\(--appearance-play-ink,/s);
});

test('light palettes give the detailed mark an explicit contrasting treatment', () => {
  assert.match(appChromeCss, /:root\[data-appearance-mode='light'\]\s+\.app-bar-brand-art\s*\{/);
  assert.match(appChromeCss, /:root\[data-appearance-mode='light'\]\s+\.app-bar-brand-art\s*\{[^}]*filter:[^}]*brightness\(0\)/s);
  assert.match(appChromeCss, /\.app-bar-brand-mark\s*\{[^}]*--app-bar-brand-ink:\s*var\(--appearance-ink,/s);
});

test('folded Artist Tree aligns the brand mark with the compact navigation centerline', () => {
  assert.match(appChromeCss, /\.shell-layout\.is-artist-tree-folded\s+\.app-bar-brand\s*\{[^}]*margin-left:\s*0/s);
});

test('expanded Artist Tree aligns its back button and title on one centerline', () => {
  assert.match(baseLayoutCss, /\.shell-navigation-rail-header\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*flex-start;[^}]*gap:\s*8px;/s);
  assert.match(baseLayoutCss, /\.shell-navigation-rail-header h2\s*\{[^}]*margin:\s*0;/s);
});
