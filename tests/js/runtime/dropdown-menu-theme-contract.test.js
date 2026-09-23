const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const galleryCss = fs.readFileSync(
  path.join(__dirname, '../../../music_app/static/css/gallery-main.css'),
  'utf8',
);
const modalCss = fs.readFileSync(
  path.join(__dirname, '../../../music_app/static/css/modals.css'),
  'utf8',
);
const statusRuntime = fs.readFileSync(
  path.join(__dirname, '../../../music_app/static/js/runtime/status-ui-helpers.js'),
  'utf8',
);

test('Library actions use the shared themed dropdown-row treatment', () => {
  assert.match(statusRuntime, /menu\.className\s*=\s*'gallery-anchored-menu'/);
  assert.match(statusRuntime, /className:\s*'gallery-menu-action'/);
  assert.match(
    galleryCss,
    /\.gallery-anchored-menu \.gallery-menu-action\.ui-button\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*transparent;[^}]*color:\s*inherit;/s,
  );
  assert.match(
    galleryCss,
    /\.gallery-anchored-menu \.gallery-menu-action\.ui-button:hover[^}]*\{[^}]*background:\s*var\(--dropdown-item-hover-background,\s*var\(--appearance-item-hover,/s,
  );
  assert.doesNotMatch(modalCss, /\.status-context-menu-item/);
  assert.doesNotMatch(modalCss, /\.status-context-menu\s*\{[^}]*background:/s);
});
