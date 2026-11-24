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

test('1D-3: a phone album row shows the album title\'s Latin form under the title, rows no taller', () => {
  const context = loadGalleryCard();
  const html = context.buildGalleryCardInfoHtml({ title: '秒速5センチメートル', titleLatin: 'Byousoku <5>', artist: '天門', year: '2007', trackCount: 11, artistRomanized: 'Tenmon' });
  assert.match(html, /<div class="album-meta-row"><div class="album-subtitle gallery-card__title-latin"><span class="gallery-artist-romanized">\(Byousoku &lt;5&gt;\)<\/span><\/div><div class="album-subtitle" title="Tenmon">/,
    'first in the meta row, right under the title, dimmed in parentheses');
  for (const titleLatin of [undefined, null, '', '  ']) {
    assert.doesNotMatch(context.buildGalleryCardInfoHtml({ title: 'Hoshi no Koe', titleLatin, artist: '天門', year: '2002' }), /gallery-card__title-latin/);
  }
  const css = (file) => fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', file), 'utf8');
  assert.match(css('gallery-main.css'), /\.gallery-card-info \.gallery-card__title-latin \{ display: none; \}/, 'desktop shows nothing yet');
  const phone = css('mobile-layout.css');
  const phoneBlock = phone.slice(phone.indexOf('@media (max-width: 900px)'));
  assert.match(phoneBlock, /\.album-card\[data-gallery-display="list"\] \.gallery-card__title-latin \{ display: block; grid-column: 1 \/ -1; font-size: 11px; line-height: 1\.25; margin: 0 0 1px; \}/);
  assert.match(phoneBlock, /\.album-card:not\(\[data-gallery-display="list"\]\) \.gallery-card__title-latin \{ display: none; \}/, 'list rows only');
  // The row keeps its height: only rows with the line tighten their gaps (the approved mockup's values).
  assert.match(phoneBlock, /\.gallery-card-info:has\(\.gallery-card__title-latin\) \{ row-gap: 2px; padding-block: 4px; \}/);
  assert.match(phoneBlock, /\.gallery-card-info:has\(\.gallery-card__title-latin\) \.album-title \{ margin: 0 0 1px; \}/);
  assert.match(phoneBlock, /\.gallery-card-info:has\(\.gallery-card__title-latin\) \.chip-row \{ margin-top: 2px; \}/);
  assert.match(phone, /\.album-card\[data-gallery-display="list"\] \{[^}]*min-height: 88px;/, 'the row height itself is unchanged');
});

test('album cards pass the stored Latin title and re-render when it changes (0256)', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'virtual-artist-grid.js'), 'utf8');
  assert.match(source, /titleLatin: album\?\.title_latin,/);
  assert.match(source, /String\(album\?\.title_latin \|\| ''\),/);
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

// Mobile gallery cards observe each metadata row and its text. One resized row
// must refresh that row only, whatever the number of registered rows.
function loadMetadataMotion(rowCount) {
  const { createInteractionCounter } = require('../helpers/bounded-interaction-counter');
  const { createCountedDom } = require('../helpers/counted-dom');
  const counter = createInteractionCounter();
  const { CountedElement } = createCountedDom(counter);
  const frames = [];
  let observer = null;
  const texts = Array.from({ length: rowCount }, (_, index) => {
    const row = new CountedElement('div');
    const text = new CountedElement('span', { scrollWidth: index % 2 ? 260 : 80 });
    Object.defineProperty(row, 'clientWidth', { get() { counter.count('itemsVisited'); return 120; } });
    row.appendChild(text);
    return text;
  });
  const root = { querySelectorAll() { counter.count('domQueries'); return texts; } };
  const context = {
    usesMobilePageLayout: () => true,
    window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
    document: {},
    requestAnimationFrame(callback) { counter.count('animationFrames'); frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
    ResizeObserver: class {
      constructor(callback) { counter.count('observers'); observer = { callback, observed: new Set() }; }
      observe(target) { observer.observed.add(target); }
      unobserve(target) { observer.observed.delete(target); }
      disconnect() { observer.observed.clear(); }
    },
  };
  vm.createContext(context);
  for (const filename of ['compact-player-helpers.js', 'gallery-card-component.js']) {
    const sourcePath = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', filename);
    vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }
  const flushFrames = () => { while (frames.length) frames.shift()(); };
  const resize = (...targets) => {
    observer.callback(targets.map(target => ({ target })));
    flushFrames();
  };
  context.syncGalleryCardMetadataMotion(root);
  flushFrames();
  return { CountedElement, context, counter, flushFrames, resize, root, texts, observed: () => observer.observed };
}

async function oneResizedMetadataRow(rowCount) {
  const { counter, resize, texts } = loadMetadataMotion(rowCount);
  const resizedText = texts[rowCount - 1];
  const row = resizedText.parentElement;
  resizedText.scrollWidth = 400;
  const counts = await counter.measure(() => resize(resizedText));
  assert.equal(row.classList.contains('is-card-text-overflowing'), true, 'the resized row starts its pan');
  assert.equal(row.style.getPropertyValue('--card-text-distance'), '280px');
  return counts;
}

test('BI gallery card metadata motion refreshes only the resized row at production scale', async () => {
  const { measureScalePair } = require('../helpers/bounded-interaction-counter');
  const { small, large } = await measureScalePair({
    id: 'js:runtime/gallery-card-component.js#syncGalleryCardMetadataMotion',
    small: 12,
    large: 1200,
    run: oneResizedMetadataRow,
    budgets: { itemsVisited: 1, domMutations: 3, domQueries: 0, animationFrames: 1, observers: 0 },
    growth: { metric: 'itemsVisited', largeMinusSmallMax: 0 },
  });
  assert.deepEqual(large, small, 'a resize observation costs the same at every registered row count');
});

test('gallery card metadata motion re-renders, prunes, and replaces rows without a full refresh', () => {
  const { CountedElement, context, counter, flushFrames, resize, root, texts, observed } = loadMetadataMotion(6);
  const before = counter.snapshot().itemsVisited;
  context.syncGalleryCardMetadataMotion(root);
  flushFrames();
  assert.equal(counter.snapshot().itemsVisited, before, 'a re-render that keeps every row refreshes none');

  const removed = texts[2];
  const row = removed.parentElement;
  row.isConnected = false;
  resize(row);
  assert.equal(observed().has(removed), false, 'a removed row stops being observed');
  assert.equal(counter.snapshot().itemsVisited, before, 'a removed row is pruned without a measurement');

  const replacement = new CountedElement('span', { scrollWidth: 500 });
  row.isConnected = true;
  row.replaceChildren(replacement);
  texts[2] = replacement;
  context.syncGalleryCardMetadataMotion(root);
  flushFrames();
  assert.equal(counter.snapshot().itemsVisited, before + 1, 'only the newly registered row is measured');
  assert.equal(row.classList.contains('is-card-text-overflowing'), true);
});
