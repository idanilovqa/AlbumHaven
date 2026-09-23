const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('tag editor track rows use one short active accent without pill chrome', () => {
  const css = read('music_app/static/css/runtime/utilities.css');
  assert.match(css, /\.tag-editor-track\s*\{[^}]*border:\s*0;/s);
  assert.match(css, /\.tag-editor-track\s*\{[^}]*border-radius:\s*0;/s);
  assert.match(css, /\.tag-editor-track\.is-active\s*\{[^}]*border-color:\s*transparent;/s);
  assert.match(css, /\.tag-editor-track-accent\s*\{[^}]*align-self:\s*center;[^}]*height:\s*18px;/s);
});

test('tag editor footer uses quiet Cancel and affirmative Apply buttons', () => {
  const markup = read('music_app/templates/partials/primary-modals.html');
  assert.match(markup, /class="button ui-button ui-button--quiet[^"']*"[^>]*data-close-tag-editor="1"[^>]*>Cancel<\/button>/);
  assert.match(markup, /class="button ui-button ui-button--primary[^"']*"[^>]*data-open-tag-edit-confirm="1"[^>]*>Apply<\/button>/);
  assert.doesNotMatch(markup, /confirm-modal-danger"[^>]*data-open-tag-edit-confirm="1"/);
});

test('Cancel actions use the shared hollow Button presentation', () => {
  const quietClass = /class="[^"]*ui-button--quiet[^"]*"[^>]*>Cancel<\/button>/g;
  const primaryModals = read('music_app/templates/partials/primary-modals.html');
  const confirmModals = read('music_app/templates/partials/confirm-modals.html');
  const versionPicker = read('music_app/static/js/runtime/modal-and-overlay-helpers.js');
  const selectionAccent = read('music_app/static/js/selection-accent.js');

  assert.ok((primaryModals.match(quietClass) || []).length >= 2);
  assert.equal((confirmModals.match(quietClass) || []).length, 6);
  assert.match(versionPicker, /ui-button--quiet[^"']*["'][^>]*>Cancel<\/button>/);
  assert.match(selectionAccent, /ui-button--quiet[^"']*["'][^>]*>Cancel<\/button>/);
});
