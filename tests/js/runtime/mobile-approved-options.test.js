const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
function load(file, names, context = {}) {
  let code = fs.readFileSync(path.join(root, 'music_app/static/js/runtime', file), 'utf8');
  // The pure helper unit does not boot the browser-owned preference state.
  if (file === 'client-preferences-helpers.js') code = code.replace(/\nrestorePersistedClientPreferences\(\);\s*$/, '');
  return vm.runInNewContext(`${code}\n;({${names.join(',')}})`, context);
}
test('thin preference survives runtime normalization; malformed values stay safe', () => {
  const { normalizePlayerAppearance } = load('client-preferences-helpers.js', ['normalizePlayerAppearance']);
  assert.equal(normalizePlayerAppearance({ seekbarMode: 'thin' }).seekbarMode, 'thin');
  for (const mode of ['default', 'waveform']) assert.equal(normalizePlayerAppearance({ seekbarMode: mode }).seekbarMode, mode);
  assert.equal(normalizePlayerAppearance({ seekbarMode: 'untrusted' }).seekbarMode, 'default');
});
test('thin is mobile-only, while loop/waveform presentation always keeps its existing priority', () => {
  const { resolvePlayerSeekbarPresentation: mode } = load('player-and-waveform.js', ['resolvePlayerSeekbarPresentation']);
  assert.equal(mode({ seekbarMode: 'thin', viewportWidth: 390 }), 'thin');
  assert.equal(mode({ seekbarMode: 'thin', viewportWidth: 900 }), 'thin');
  assert.equal(mode({ seekbarMode: 'thin', viewportWidth: 1180 }), 'regular');
  assert.equal(mode({ seekbarMode: 'default', viewportWidth: 390 }), 'regular');
  assert.equal(mode({ seekbarMode: 'thin', viewportWidth: 390, isWaveform: true }), 'waveform');
});
test('tabs cannot activate a disabled initial selection and escape supplied labels', () => {
  const escapeHtml = value => String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const { buildInPageTabsHtml } = load('in-page-tabs.js', ['buildInPageTabsHtml'], { escapeHtml });
  const html = buildInPageTabsHtml({ id: 'tabs', label: 'Sections', selectedKey: 'news', tabs: [
    { key: 'recent', label: '<Recent>', panelId: 'recent' }, { key: 'news', label: 'News', disabled: true },
  ] });
  assert.match(html, /data-in-page-tab="recent" aria-selected="true" tabindex="0"/);
  assert.match(html, /data-in-page-tab="news" aria-selected="false" tabindex="-1" disabled/);
  assert.match(html, /&lt;Recent>/);
});
test('three existing album layout values are preserved, including the original full artwork choice', () => {
  const { normalizeAlbumDetailsLayout } = load('album-details-components.js', ['normalizeAlbumDetailsLayout']);
  for (const value of ['classic_bar', 'stacked_bar', 'editorial_canvas']) assert.equal(normalizeAlbumDetailsLayout(value), value);
  assert.equal(normalizeAlbumDetailsLayout('unknown'), 'classic_bar');
});
