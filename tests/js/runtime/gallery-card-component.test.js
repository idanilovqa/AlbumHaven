const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');

function loadGalleryCard() {
  const context = {
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  };
  vm.createContext(context);
  for (const filename of ['alert-components.js', 'album-artbox.js', 'gallery-card-component.js']) {
    vm.runInContext(
      fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', filename), 'utf8'),
      context,
    );
  }
  return context;
}

test('GalleryCard composes AlbumArtbox and preserves the stable gallery identity', () => {
  const context = loadGalleryCard();
  const html = context.buildGalleryCardHtml({
    identity: 'transatlantic:smpte:2000',
    renderKey: 'render-1',
    albumKey: 'album-1',
    albumVersionKey: 'version-1',
    albumFallback: '{}',
    title: 'SMPTe',
    artist: 'Transatlantic',
    year: '2000',
    ratingHtml: '<div class="rating-row">rating</div>',
    trackCount: 5,
    lengthDisplay: '1h 17m',
    artboxHtml: '<div class="album-artbox">cover</div>',
  });

  assert.match(html, /data-gallery-card-key="transatlantic:smpte:2000"/);
  assert.match(html, /data-gallery-card-render-key="render-1"/);
  assert.match(html, /class="album-card__artbox-trigger album-open-trigger cover"/);
  assert.match(html, /class="album-artbox"/);
  assert.match(html, /SMPTe/);
  assert.match(html, /Transatlantic/);
  assert.match(html, /5 tracks/);
});

test('the live virtual gallery delegates complete card markup to GalleryCard', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'virtual-artist-grid.js'),
    'utf8',
  );
  assert.match(source, /buildGalleryCardHtml\(/);
  assert.match(source, /buildAlbumArtboxHtml\(/);
  assert.match(source, /buildSmallAlertHtml\(/);
  assert.match(source, /Album not found/);
  assert.doesNotMatch(source, /Album deleted/);
});
