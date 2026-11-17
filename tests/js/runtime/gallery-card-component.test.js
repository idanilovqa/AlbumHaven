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
  assert.match(infoHtml, /class="album-subtitle"><span data-gallery-metadata-text>Transatlantic · 2000<\/span><\/div>/);
  assert.doesNotMatch(infoHtml, /class="album-year"/);
  assert.match(infoHtml, /5 tracks/);
  assert.match(infoHtml, /1h 17m/);
  assert.equal((infoHtml.match(/<span class="star(?: filled)?">/g) || []).length, 10);
});

test('GalleryCard keeps a complete accessible name while clamping long card titles', () => {
  const context = loadGalleryCard();
  const title = 'And the Glass Handed Kites: A Very Long Album Title';
  const html = context.buildGalleryCardInfoHtml({
    title,
    openAttributes: 'data-open-tracklist="1" data-album-key="mew"',
  });
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app/static/css/runtime/non-album-and-player.css'),
    'utf8',
  );

  assert.match(html, new RegExp(`aria-label="${title}"`));
  assert.match(
    css,
    /\.album-card\[data-gallery-display="cards"\] \.album-title-button\s*\{[^}]*-webkit-line-clamp:\s*2;/s,
  );
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
    assert.doesNotMatch(html, /gallery-card__year-frame/);
  }
  assert.doesNotMatch(context.buildGalleryCardHtml({ year: '<img src=x>', displayMode: 'covers' }), /<img src=x>/);
  const cards = context.buildGalleryCardHtml({ year: '2005', displayMode: 'cards' });
  assert.doesNotMatch(cards, /gallery-card__hover-year|gallery-card__year-frame|data-gallery-release-year/);
  assert.match(cards, /<span data-gallery-metadata-text>2005<\/span><\/div>/);
});

test('GalleryCardInfo shows the MusicBrainz genre pill beside artist and year (approved A2)', () => {
  const context = loadGalleryCard();
  const withGenre = context.buildGalleryCardInfoHtml({ title: 'Angels Cry', artist: 'Angra', year: '1993', trackCount: 10, genre: 'power metal' });
  assert.match(withGenre,
    /<div class="album-meta-row"><div class="album-subtitle"><span data-gallery-metadata-text>Angra · 1993<\/span><\/div><span class="ui-metadata-pill ui-metadata-pill--genre">power metal<\/span><\/div>/);
  const escaped = context.buildGalleryCardInfoHtml({ title: 'X', artist: 'Y', genre: '<b>' });
  assert.match(escaped, /ui-metadata-pill--genre">&lt;b&gt;</);
  const without = context.buildGalleryCardInfoHtml({ title: 'Angels Cry', artist: 'Angra', year: '1993', trackCount: 10 });
  assert.doesNotMatch(without, /ui-metadata-pill/);
});

test('album cards pass the payload genre and re-render when it changes', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'virtual-artist-grid.js'), 'utf8');
  assert.match(source, /genre: album\?\.musicbrainz_genre/);
  assert.match(source, /String\(album\?\.musicbrainz_genre \|\| ''\)/);
});

test('1D-3: a card of an original-script artist reads "天門 (Tenmon) · 2002" on phones, hover text only on desktop', () => {
  const context = loadGalleryCard();
  const html = context.buildGalleryCardInfoHtml({ title: 'Hoshi no Koe', artist: '天門', year: '2002', trackCount: 12, artistRomanized: 'Tenmon <b>' });
  assert.match(html, /<div class="album-subtitle" title="Tenmon &lt;b&gt;"><span data-gallery-metadata-text>天門<span class="gallery-artist-romanized gallery-card__romanized"> \(Tenmon &lt;b&gt;\)<\/span> · 2002<\/span><\/div>/);
  // Rows keep their height: no second line under artist and year any more.
  assert.equal((html.match(/class="album-subtitle/g) || []).length, 1);
  const noYear = context.buildGalleryCardInfoHtml({ title: 'X', artist: '天門', trackCount: 1, artistRomanized: 'Tenmon' });
  assert.match(noYear, /<span data-gallery-metadata-text>天門<span class="gallery-artist-romanized gallery-card__romanized"> \(Tenmon\)<\/span><\/span>/);
  const plain = context.buildGalleryCardInfoHtml({ title: 'Angels Cry', artist: 'Angra', year: '1993', trackCount: 10 });
  assert.doesNotMatch(plain, /title=|gallery-card__romanized/);
  assert.match(plain, /<span data-gallery-metadata-text>Angra · 1993<\/span>/);
  assert.match(context.buildGalleryCardInfoHtml({ title: 'X', artist: 'A <b>', year: '1' }), /<span data-gallery-metadata-text>A &lt;b&gt; · 1<\/span>/);
  const css = (file) => fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', file), 'utf8');
  assert.match(css('gallery-main.css'), /\.gallery-card-info \.gallery-card__romanized \{ display: none; \}/, 'desktop shows only the hover text');
  const phone = css('mobile-layout.css');
  const phoneBlock = phone.slice(phone.indexOf('@media (max-width: 900px)'));
  assert.match(phoneBlock, /\.album-card \.gallery-card__romanized \{ display: inline; \}/);
  assert.doesNotMatch(phone, /\.gallery-card__romanized \{ display: block/, 'never its own line');
});

test('album cards pass the romanized artist name and re-render when it arrives (J3)', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'virtual-artist-grid.js'), 'utf8');
  assert.match(source, /artistRomanized: galleryRomanizedArtistName\(album\.album_artist\)/);
  assert.match(source, /galleryRomanizedArtistName\(album\?\.album_artist\),/);
});

test('a card without a genre shows no genre pill and no placeholder text (owner 2026-11-16)', () => {
  const context = loadGalleryCard();
  for (const genre of [undefined, null, '', '  ']) {
    const html = context.buildGalleryCardInfoHtml({ title: 'X', artist: 'Y', year: '2000', trackCount: 1, genre });
    assert.doesNotMatch(html, /ui-metadata-pill|unavailable/i);
  }
  assert.match(context.buildGalleryCardInfoHtml({ title: 'X', artist: 'Y', genre: 'power metal' }),
    /<span class="ui-metadata-pill ui-metadata-pill--genre">power metal<\/span>/);
});
