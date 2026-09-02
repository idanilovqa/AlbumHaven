const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (file) => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');

test('the existing Settings gear owns a shared, permission-filtered menu with protected logout', () => {
  const index = read('music_app/templates/index.html');
  const menu = read('music_app/templates/partials/account-menu.html');
  assert.match(index, /include 'partials\/account-menu.html'/);
  assert.doesNotMatch(index, /id="settings-button"/);
  assert.match(menu, /id="settings-button"[^>]*data-account-menu-trigger/);
  assert.match(menu, /aria-haspopup="menu"[^>]*aria-expanded="false"/);
  assert.match(menu, /allows\('accounts.read'\)/);
  assert.match(menu, /method="post" action="\/logout"/);
  assert.match(menu, /name="csrf_token" value="\{\{ account_menu_csrf_token \}\}"/);
  assert.ok(menu.indexOf('>Settings</span>') < menu.indexOf('>Admin Panel</span>'));
  assert.ok(menu.indexOf('>Admin Panel</span>') < menu.indexOf('>Sign Out</span>'));
  assert.doesNotMatch(read('music_app/templates/partials/primary-modals.html'), /utility-members-link/);
  assert.match(index, /<form class="toolbar-left" id="search-form"/);
  assert.doesNotMatch(index, /<form class="toolbar shell-app-bar"/);
});

test('shared menu ships with rounded interactive states and visibly disabled controls', () => {
  const css = read('music_app/static/css/runtime/account-menu.css');
  assert.match(css, /\.account-menu-item\s*\{[^}]*border-radius:\s*9px/s);
  assert.match(css, /:hover/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /aria-disabled="true"/);
  assert.match(css, /cursor:\s*not-allowed/);
  assert.match(read('music_app/templates/index.html'), /css\/runtime\/account-menu.css/);
  assert.match(read('scripts/build-runtime-bundle.cjs'), /js\/runtime\/account-menu.js/);
});
