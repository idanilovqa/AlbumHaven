const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../../..');
const template = fs.readFileSync(path.join(root, 'music_app/templates/partials/app-bar.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'music_app/static/css/app-chrome.css'), 'utf8');

test('the shared app bar renders the Album Haven mark as a theme-aware component', () => {
  assert.match(template, /class="app-bar-brand-mark"/);
  assert.match(template, /class="app-bar-brand-label"/);
  assert.match(template, /class="app-bar-brand-label-hole"/);
  assert.match(css, /\.app-bar-brand-label\s*\{[^}]*background:\s*var\(--appearance-play,/s);
  assert.match(css, /\.app-bar-brand-label-hole\s*\{[^}]*background:\s*var\(--appearance-play-ink,/s);
});

test('light palettes give the detailed mark an explicit contrasting treatment', () => {
  assert.match(css, /:root\[data-appearance-mode='light'\]\s+\.app-bar-brand-art\s*\{/);
  assert.match(css, /:root\[data-appearance-mode='light'\]\s+\.app-bar-brand-art\s*\{[^}]*filter:[^}]*brightness\(0\)/s);
  assert.match(css, /\.app-bar-brand-mark\s*\{[^}]*--app-bar-brand-ink:\s*var\(--appearance-ink,/s);
});
