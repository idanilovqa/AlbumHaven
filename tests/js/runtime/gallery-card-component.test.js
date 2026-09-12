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
  for (const filename of ['alert-components.js', 'album-artbox.js', 'gallery-main-components.js', 'gallery-card-component.js']) {
    const sourcePath = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', filename);
    if (!fs.existsSync(sourcePath)) continue;
    vm.runInContext(
      fs.readFileSync(sourcePath, 'utf8'),
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

test('GalleryCardInfo keeps artist and year together with ten-point rating, track count, and duration', () => {
  const context = loadGalleryCard();
  assert.equal(typeof context.buildGalleryCardInfoHtml, 'function', 'GalleryCardInfo must own the approved metadata contract');
  assert.equal(typeof context.buildGalleryRatingHtml, 'function', 'Rating must expose the approved ten-point renderer');

  const ratingHtml = context.buildGalleryRatingHtml({ value: 8, maximum: 10, label: 'Rated 8 out of 10' });
  assert.equal((ratingHtml.match(/<span class="star(?: filled)?">/g) || []).length, 10);
  assert.match(ratingHtml, /aria-label="Rated 8 out of 10"/);

  const infoHtml = context.buildGalleryCardInfoHtml({
    title: 'SMPTe', artist: 'Transatlantic', year: '2000', ratingHtml, trackCount: 5, lengthDisplay: '1h 17m',
  });
  assert.match(infoHtml, /SMPTe/);
  assert.match(infoHtml, /class="album-subtitle">Transatlantic · 2000<\/div>/);
  assert.doesNotMatch(infoHtml, /class="album-year"/);
  assert.match(infoHtml, /5 tracks/);
  assert.match(infoHtml, /1h 17m/);
  assert.equal((infoHtml.match(/<span class="star(?: filled)?">/g) || []).length, 10);
});

test('GalleryCardInfo omits the separator when either metadata value is missing', () => {
  const context = loadGalleryCard();
  for (const config of [{ artist: 'Transatlantic' }, { year: '2000' }, {}]) {
    assert.doesNotMatch(context.buildGalleryCardInfoHtml(config), / · /);
  }
});

test('No info GalleryCard renders cover plus a title revealed by hover or keyboard focus only', () => {
  const context = loadGalleryCard();
  const html = context.buildGalleryCardHtml({
    identity: 'broadcast:tender-buttons:2005',
    albumKey: 'album-2',
    albumVersionKey: 'version-2',
    title: 'Tender Buttons',
    artist: 'Broadcast',
    year: '2005',
    ratingValue: 9,
    trackCount: 14,
    lengthDisplay: '40m',
    artboxHtml: '<div class="album-artbox">cover</div>',
    displayMode: 'covers',
  });
  assert.match(html, /data-gallery-display="covers"/);
  assert.match(html, /class="[^"]*gallery-card__focus-title[^"]*"/);
  assert.match(html, />Tender Buttons</);
  assert.doesNotMatch(html, /Broadcast/);
  assert.match(html, /class="gallery-card__hover-year"[^>]*>2005<\/span>/);
  assert.doesNotMatch(html, /14 tracks/);
  assert.doesNotMatch(html, />40m</);
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

test('hover year omits unknown values and safely renders supplied release years', () => {
  const context = loadGalleryCard();
  for (const year of [undefined, null, '', '   ']) {
    assert.doesNotMatch(context.buildGalleryCardHtml({ year, displayMode: 'covers' }), /gallery-card__hover-year/);
  }
  for (const displayMode of ['covers']) {
    const html = context.buildGalleryCardHtml({ year: '2005', displayMode });
    assert.match(html, /class="gallery-card__hover-year"[^>]*>2005<\/span>/);
    assert.match(html, /data-gallery-release-year="2005"/);
  }
  assert.doesNotMatch(context.buildGalleryCardHtml({ year: '<img src=x>', displayMode: 'covers' }), /<img src=x>/);
  const cards = context.buildGalleryCardHtml({ year: '2005', displayMode: 'cards' });
  assert.doesNotMatch(cards, /gallery-card__hover-year|gallery-card__year-frame|data-gallery-release-year/);
  assert.match(cards, />2005<\/div>/);
});
