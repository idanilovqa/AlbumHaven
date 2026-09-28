const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ButtonComponent = require('../../../music_app/static/js/button-component.js');
const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

test('shared back glyph is an actual bare ActionButton with accessible name', () => {
  const markup = ButtonComponent.renderActionButton({ icon: 'back', presentation: 'bare', ariaLabel: 'Back to library' });
  assert.match(markup, /action-button--bare/);
  assert.match(markup, /aria-label="Back to library"/);
  assert.match(markup, /<svg/);
  assert.match(markup, /M19 12H5/);
});

test('loading artbox reuses existing artwork without changing empty/missing states', () => {
  const context = vm.createContext({ escapeHtml });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/album-artbox.js'), 'utf8'), context);
  const loading = context.buildAlbumArtboxHtml({ state: 'loading', label: 'Loading cover art' });
  assert.match(loading, /data-album-artbox-state="loading"/);
  assert.match(loading, /\/static\/images\/loading-idea.png/);
  assert.doesNotMatch(context.buildAlbumArtboxHtml({ state: 'empty', label: 'No cover' }), /loading-idea/);
  assert.doesNotMatch(context.buildAlbumArtboxHtml({ state: 'missing', label: 'Missing album' }), /loading-idea/);
});
