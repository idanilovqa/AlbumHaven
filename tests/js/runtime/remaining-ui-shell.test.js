const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const read = relative => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

test('Settings tabs touch with one joined active contour', () => {
  const css = read('music_app/static/css/runtime/utilities.css');
  assert.match(css, /\.utility-modal-tabs\s*\{[^}]*gap:\s*0/s);
  assert.match(css, /\.utility-modal-tabs\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/s);
  assert.match(css, /\.utility-tab\s*\+\s*\.utility-tab\s*\{[^}]*margin-left:\s*-1px/s);
  assert.match(css, /#utility-modal \.utility-tab\.is-active\s*\{[^}]*border-bottom:\s*0/s);
  assert.match(css, /#utility-modal \.utility-tab\.is-active::after\s*\{[^}]*bottom:\s*-2px;[^}]*height:\s*3px;[^}]*background:\s*var\(--trigger-anchor-background\)/s);
});

test('shared scrollbar reaches app, account, admin, and login surfaces with forced-color fallback', () => {
  const css = read('music_app/static/css/scrollbar.css');
  assert.match(css, /body \*/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/);
  for (const template of ['account.html', 'admin-account-detail.html', 'admin-members.html', 'login.html']) {
    assert.match(read(`music_app/templates/${template}`), /css\/scrollbar\.css/, template);
  }
});

test('connected menus retain resize, scroll, outside-click, and above/below ownership', () => {
  const source = read('music_app/static/js/runtime/trigger-anchor.js');
  assert.match(source, /addEventListener\?\.\('resize'/);
  assert.match(source, /addEventListener\?\.\('scroll'/);
  assert.match(source, /pointerdown/);
  assert.match(source, /triggerAnchorEdge/);
  const css = read('music_app/static/css/runtime/trigger-anchor.css');
  assert.match(css, /data-trigger-anchor-edge="bottom"/);
});
