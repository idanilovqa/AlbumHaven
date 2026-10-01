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

test('album identity has exactly one owner until the complete inline block scrolls away', () => {
  const { resolveMobileAlbumHeaderState: resolve } = load('album-details-components.js', ['resolveMobileAlbumHeaderState']);
  const geometry = { albumPage: true, hasInlineIdentity: true, hasCover: true, viewportTop: 160, coverBottom: 150 };
  assert.equal(resolve({ ...geometry, identityBottom: 210 }).bodyOwnsIdentity, true);
  assert.equal(resolve({ ...geometry, identityBottom: 210 }).showCover, false);
  assert.equal(resolve({ ...geometry, identityBottom: 160 }).bodyOwnsIdentity, false);
  assert.equal(resolve({ ...geometry, identityBottom: 160 }).showCover, true);
  // Scrolling upward must return ownership to the body, not retain sticky text.
  assert.equal(resolve({ ...geometry, identityBottom: 300 }).bodyOwnsIdentity, true);
});

test('album header preserves classic, no-art and non-album page identities', () => {
  const { resolveMobileAlbumHeaderState: resolve } = load('album-details-components.js', ['resolveMobileAlbumHeaderState']);
  const geometry = { albumPage: true, hasInlineIdentity: false, hasCover: true, viewportTop: 160, coverBottom: 350 };
  assert.equal(resolve(geometry).bodyOwnsIdentity, false);
  assert.equal(resolve(geometry).showCover, false);
  assert.equal(resolve({ ...geometry, coverBottom: 100 }).showCover, true);
  assert.equal(resolve({ ...geometry, coverBottom: 100, hasCover: false }).showCover, false);
  const settings = resolve({ ...geometry, albumPage: false, hasInlineIdentity: true, identityBottom: 250 });
  assert.equal(settings.bodyOwnsIdentity, false);
  assert.equal(settings.showCover, false);
});


test('small-art identity does not move to the bar while the cover is still visible', () => {
  const { resolveMobileAlbumHeaderState: resolve } = load('album-details-components.js', ['resolveMobileAlbumHeaderState']);
  const geometry = { albumPage: true, hasInlineIdentity: true, hasCover: true, viewportTop: 160, identityBottom: 140 };
  assert.equal(resolve({ ...geometry, coverBottom: 190 }).bodyOwnsIdentity, true);
  assert.equal(resolve({ ...geometry, coverBottom: 150 }).bodyOwnsIdentity, false);
  assert.equal(resolve({ ...geometry, coverBottom: 150 }).showCover, true);
});

test('metadata updates preserve unchanged text nodes and expose three independent mobile values', () => {
  let mobile = true;
  const { renderGlobalPlayerMetadata } = load('player-loop-playback.js', ['renderGlobalPlayerMetadata'], {
    usesMobilePageLayout: () => mobile,
  });
  const row = () => ({ _text: '', writes: 0, get textContent() { return this._text; }, set textContent(text) { this.writes++; this._text = text; } });
  const els = { artist: row(), title: row(), albumLink: row() };
  const track = { artist: 'Artist with a long name', title: 'Song with a long name', album: 'Album with a long name' };
  renderGlobalPlayerMetadata(els, track);
  assert.equal(els.artist.textContent, track.artist);
  assert.equal(els.title.textContent, track.title);
  assert.equal(els.albumLink.textContent, track.album);
  renderGlobalPlayerMetadata(els, track);
  for (const node of Object.values(els)) assert.equal(node.writes, 1);
  mobile = false;
  renderGlobalPlayerMetadata(els, track);
  assert.equal(els.artist.hidden, true);
  assert.equal(els.title.textContent, `${track.artist} - ${track.title} /`);
});
