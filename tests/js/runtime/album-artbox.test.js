const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');

function loadAlbumArtbox() {
  const context = {
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'album-artbox.js'), 'utf8'),
    context,
  );
  return context;
}

test('AlbumArtbox renders a crossed-circle missing state and its bottom-right action slot', () => {
  const context = loadAlbumArtbox();
  const html = context.buildAlbumArtboxHtml({
    state: 'missing',
    label: 'SMPTe missing cover',
    actionHtml: '<span class="small-alert">Album not found</span>',
  });

  assert.match(html, /class="album-artbox album-artbox--missing"/);
  assert.match(html, /data-album-artbox-state="missing"/);
  assert.match(html, /album-artbox__missing-mark/);
  assert.match(html, /album-artbox__missing-disc/);
  assert.match(html, /album-artbox__missing-groove/);
  assert.match(html, /album-artbox__missing-hub/);
  assert.match(html, /album-artbox__missing-slash/);
  assert.doesNotMatch(html, /M38 32a6 6/);
  assert.match(html, /album-artbox__action/);
  assert.match(html, /Album not found/);
});

test('AlbumArtbox renders the same crossed-disc artwork for an ordinary empty cover state', () => {
  const context = loadAlbumArtbox();
  const html = context.buildAlbumArtboxHtml({
    state: 'empty',
    label: 'Album cover unavailable for an album that is still present',
  });

  assert.match(html, /class="album-artbox album-artbox--empty"/);
  assert.match(html, /data-album-artbox-state="empty"/);
  assert.match(html, /album-artbox__missing-mark/);
  assert.match(html, /album-artbox__missing-disc/);
  assert.match(html, /album-artbox__missing-groove/);
  assert.match(html, /album-artbox__missing-hub/);
  assert.match(html, /album-artbox__missing-slash/);
  assert.doesNotMatch(html, /No cover art/);
  assert.doesNotMatch(html, /album-artbox__action/);
});

test('AlbumArtbox preserves supplied cover markup for present albums', () => {
  const context = loadAlbumArtbox();
  const html = context.buildAlbumArtboxHtml({
    state: 'ready',
    label: 'Album cover for SMPTe',
    coverHtml: '<img src="/cover/smpte" alt="Album cover for SMPTe">',
  });
  assert.match(html, /album-artbox--ready/);
  assert.match(html, /<img src="\/cover\/smpte"/);
  assert.doesNotMatch(html, /album-artbox__missing-mark/);
});

test('AlbumArtbox CSS makes every state square', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-artbox-and-gallery-card.css'),
    'utf8',
  );
  assert.match(css, /\.album-artbox\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1/s);
});

test('AlbumArtbox action rail preserves expansion room without making the artbox a hover target', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-artbox-and-gallery-card.css'),
    'utf8',
  );
  assert.match(css, /\.album-artbox__action\s*\{[^}]*width:\s*calc\(100% - 20px\)[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.album-artbox__action \.small-alert\s*\{[^}]*pointer-events:\s*auto/s);
});
