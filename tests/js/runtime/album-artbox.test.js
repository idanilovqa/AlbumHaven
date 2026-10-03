const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');

test('loop artwork uses the scoped public cover URL for preview and enlargement without path fallbacks', () => {
  const context = loadAlbumArtbox();
  context.buildAlbumDisplayCoverUrl = () => '';
  context.buildAlbumLightboxCoverUrl = () => '';
  const html = context.buildUtilityAlbumArtbox({ id: 'owned-loop', cover_url: '/cover?loop_id=owned-loop' }, { interactive: true });
  assert.match(html, /src="\/cover\?loop_id=owned-loop"/);
  assert.match(html, /data-cover-src="\/cover\?loop_id=owned-loop"/);
});

test('utility album artbox can defer its preview to the shared gallery cover loader', () => {
  const context = loadAlbumArtbox();
  context.buildAlbumDisplayCoverUrl = () => '/cover?path=family-preview';
  context.buildAlbumLightboxCoverUrl = () => '/cover?path=family-full';

  const html = context.buildUtilityAlbumArtbox(
    { cover_path: 'family-preview' },
    { label: 'Family artwork', deferPreview: true },
  );

  assert.match(html, /data-gallery-cover-src="\/cover\?path=family-preview"/);
  assert.match(html, /data-production-cover-src="\/cover\?path=family-preview"/);
  assert.doesNotMatch(html, /<img[^>]+\ssrc=/);
});

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

test('AlbumArtbox owns an independent interactive overlay slot', () => {
  const context = loadAlbumArtbox();
  const html = context.buildAlbumArtboxHtml({
    state: 'ready',
    label: 'Album cover for SMPTe',
    coverHtml: '<img src="/cover/smpte" alt="SMPTe">',
    overlayHtml: '<button type="button" data-cover-action>Search</button>',
    actionHtml: '<span class="small-alert">Album found</span>',
  });

  assert.match(html, /<span class="album-artbox__overlay"><button[^>]*data-cover-action>Search<\/button><\/span>/);
  assert.match(html, /<span class="album-artbox__action"><span class="small-alert">Album found<\/span><\/span>/);
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

test('AlbumArtbox CSS owns overlay placement and reveal behavior', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-artbox-and-gallery-card.css'),
    'utf8',
  );

  assert.match(css, /\.album-artbox__overlay\s*\{[^}]*position:\s*absolute[^}]*right:\s*12px[^}]*bottom:\s*12px[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.album-artbox:hover \.album-artbox__overlay,[\s\S]*\.album-artbox:focus-within \.album-artbox__overlay\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/s);
  assert.match(css, /@media\s*\(hover:\s*none\)[\s\S]*\.album-artbox__overlay\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/s);
});

test('gallery card text and descendants do not gain separate hover colors', () => {
  const runtimeBaseCss = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'base-layout.css'),
    'utf8',
  );
  const legacyBaseCss = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'base.css'),
    'utf8',
  );
  const appearanceCss = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'appearance-backgrounds.css'),
    'utf8',
  );

  assert.doesNotMatch(runtimeBaseCss, /\.album-title-button:hover/);
  assert.doesNotMatch(legacyBaseCss, /\.album-title-button:hover/);
  assert.match(
    appearanceCss,
    /:not\(\.album-card \*\)[^{]*:hover:not\(:disabled\):not\(\[aria-disabled='true'\]\)\s*\{[^}]*background:/s,
  );
});
