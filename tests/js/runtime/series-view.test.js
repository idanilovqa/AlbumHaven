// MusicBrainz Delivery 2, S6: the owner-approved Series view (round 2 mockups 1B, 2, 3A,
// 4A and 4B), rule by rule with each negative case.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..', '..');
const runtime = (name) => path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', name);
const navigationItemTemplate = fs.readFileSync(path.join(repoRoot, 'music_app', 'templates', 'components', 'navigation-tree-item.html'), 'utf8');
const COLOSSUS = '520f6fcd-251d-46cd-83a9-0bc725d42333';
const SERIES = { mbid: COLOSSUS, name: 'Colossus Projects', type: 'Release group series', type_label: 'Album series' };

function load(files) {
  const context = {
    URL,
    URLSearchParams,
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    document: { getElementById(id) { return id === 'navigation-tree-item-template' ? { textContent: navigationItemTemplate } : null; } },
    state: { view: {} },
  };
  context.window = { ...context, CSS: null, location: { origin: 'http://localhost:5000' } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'button-component.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'navigation-tree.js'), 'utf8'), context);
  context.NavigationTree = context.window.NavigationTree;
  for (const file of files) vm.runInContext(fs.readFileSync(runtime(file), 'utf8'), context, { filename: file });
  return context;
}

const components = () => load(['gallery-main-components.js', 'alert-components.js', 'album-details-components.js']);
const viewHelpers = () => load(['view-state-helpers.js', 'browser-navigation-helpers.js', 'view-value-helpers.js',
  'markup-format-helpers.js', 'render-markup-helpers.js']);

test('web album details read "Series: <name>" on one line; the name links to its gallery', () => {
  const html = components().buildAlbumDetailsSeriesHtml(
    { musicbrainz_series: [{ ...SERIES, kind: 'series' }, { ...SERIES, mbid: 'b', name: 'Second Series', kind: 'series' }] },
    { inline: true });
  assert.equal(html, `<div class="album-details-series album-details-series--inline" data-album-details-series="series"><span class="album-details-series__label">Series:</span> <span class="album-details-series__names"><button type="button" class="album-open-trigger album-title-button album-details-series__link" title="Show all albums in this series" data-open-series="${COLOSSUS}">Colossus Projects</button>, <button type="button" class="album-open-trigger album-title-button album-details-series__link" title="Show all albums in this series" data-open-series="b">Second Series</button></span></div>`);
  const featured = components().buildAlbumDetailsSeriesHtml(
    { musicbrainz_series: [{ mbid: 'c', name: 'Metal Albums', kind: 'featured_in' }] }, { inline: true });
  assert.match(featured, /<span class="album-details-series__label">Featured In:<\/span> <span class="album-details-series__names"><button[^>]*data-open-series="c">Metal Albums<\/button><\/span><\/div>$/);
});

test('4A: phone album details show a SERIES block naming each series as a link to its gallery', () => {
  const html = components().buildAlbumDetailsSeriesHtml({ musicbrainz_series: [{ ...SERIES, kind: 'series', number: '18' }] });
  assert.match(html, /^<div class="album-details-series" data-album-details-series="series">/);
  assert.match(html, /<div class="section-split-label">Series<\/div>/);
  assert.match(html, new RegExp(`<button type="button" class="album-open-trigger album-title-button album-details-series__link" title="Show all albums in this series" data-open-series="${COLOSSUS}">Colossus Projects</button>`));
  assert.doesNotMatch(html, /Featured In/);
});

test('lists and awards show in a FEATURED IN block beside SERIES, or instead of it', () => {
  const { buildAlbumDetailsSeriesHtml } = components();
  const list = { mbid: 'd5471f85-4b54-45da-9de7-c9ad9843c4bd', name: '100 Greatest Metal Albums', kind: 'featured_in' };
  const both = buildAlbumDetailsSeriesHtml({ musicbrainz_series: [list, { ...SERIES, kind: 'series' }] });
  assert.deepEqual([...both.matchAll(/data-album-details-series="([a-z_]+)"><div class="section-split-label">([^<]+)</g)]
    .map((match) => [match[1], match[2]]), [['series', 'Series'], ['featured_in', 'Featured In']]);
  const only = buildAlbumDetailsSeriesHtml({ musicbrainz_series: [list] });
  assert.match(only, /^<div class="album-details-series" data-album-details-series="featured_in"><div class="section-split-label">Featured In<\/div>/);
  assert.doesNotMatch(only, />Series</);
});

test('1B: an album in no series shows no SERIES block', () => {
  const { buildAlbumDetailsSeriesHtml } = components();
  assert.equal(buildAlbumDetailsSeriesHtml({}), '');
  assert.equal(buildAlbumDetailsSeriesHtml({ musicbrainz_series: [] }), '');
});

test('Featured In opens the same gallery, labelled Featured In', () => {
  const content = components().resolveSeriesGalleryBarContent({
    series: { ...SERIES, kind: 'featured_in', type_label: 'Featured In' }, albumCount: 2, mobile: false });
  assert.match(content.metadataHtml, /^<span class="gallery-bar__summary">Featured In<\/span>/);
});

test('2: the desktop Series header is the name and its i; "Album series • N albums" is the line under it', () => {
  const content = components().resolveSeriesGalleryBarContent({ series: SERIES, albumCount: 10, mobile: false });
  assert.equal(content.name, 'Colossus Projects');
  assert.equal(content.inlineTotal, '');
  assert.equal(content.metadataHtml,
    '<span class="gallery-bar__summary">Album series</span><span class="gallery-bar__artist-total">10 albums</span>');
});

test('4B: the phone Series header is exactly the band header, with no subheader', () => {
  const content = components().resolveSeriesGalleryBarContent({ series: SERIES, albumCount: 1, mobile: true });
  assert.deepEqual({ ...content }, { name: 'Colossus Projects', inlineTotal: '1 album', metadataHtml: '', summary: '' });
});

test('All series reads like the artist gallery: "Series" with its series and album totals', () => {
  const content = components().resolveSeriesGalleryBarContent({ series: null, seriesCount: 2, albumCount: 5, mobile: false });
  assert.deepEqual({ ...content }, { name: 'Series', inlineTotal: '', metadataHtml: '', summary: '2 series · 5 albums' });
});

test('2: the Series tree uses the artist tree items: All series, then each series with its count, the open one selected', () => {
  const html = viewHelpers().buildSeriesSidebarHtml({
    selected_series: COLOSSUS,
    series_sidebar: [{ mbid: 'eaf64fe2-2c12-44a6-9210-4b717d107c6e', name: 'COLEZO! TWIN', count: 1 },
      { mbid: COLOSSUS, name: 'Colossus Projects', count: 10 }],
  });
  const items = [...html.matchAll(/<a [^>]*>/g)].map((match) => match[0]);
  assert.equal(items.length, 3);
  assert.match(items[0], /data-sidebar-all-series="1"/);
  assert.match(html, /All series<\/span><span class="navigation-tree-count artist-count">2<\/span>/);
  assert.doesNotMatch(items[0], /is-selected/);
  assert.doesNotMatch(items[1], /is-selected/);
  assert.match(items[2], /class="artist-link active navigation-tree-item is-selected"/);
  assert.match(items[2], new RegExp(`href="/\\?surface=albums&amp;series=${COLOSSUS}"`));
  assert.match(items.join(''), /data-nav="1"/);
});

test('3A: a Featured In series is a selectable tree item that opens its gallery', () => {
  const featured = 'd5471f85-4b54-45da-9de7-c9ad9843c4bd';
  const html = viewHelpers().buildSeriesSidebarHtml({
    selected_series: featured,
    series_sidebar: [{ mbid: COLOSSUS, name: 'Colossus Projects', count: 4 },
      { mbid: featured, name: 'Rolling Stone: The 100 Greatest Metal Albums of All Time', count: 2 }],
  });
  const item = [...html.matchAll(/<a [^>]*>/g)].map((match) => match[0]).find((tag) => tag.includes(featured));
  assert.match(item, /class="artist-link active navigation-tree-item is-selected"/);
  assert.match(item, new RegExp(`href="/\\?surface=albums&amp;series=${featured}" data-nav="1"`));
});

test('the Series view is part of the page and data URLs only without a search or an artist', () => {
  const { buildUrl, buildApiUrl, parseUrlStateFromUrl } = viewHelpers();
  assert.equal(parseUrlStateFromUrl(`/?surface=albums&series=${COLOSSUS}`, 'http://localhost').selected_series, COLOSSUS);
  assert.equal(parseUrlStateFromUrl('/?surface=albums', 'http://localhost').selected_series, '');
  const view = { surface: { active: 'albums' }, selected_series: COLOSSUS };
  assert.equal(new URL(buildUrl(view), 'http://localhost').searchParams.get('series'), COLOSSUS);
  const api = new URL(buildApiUrl(view), 'http://localhost');
  assert.equal(api.searchParams.get('series'), COLOSSUS);
  // A series is never paged like the root gallery, nor asks for a payload tier.
  assert.equal(api.searchParams.has('gallery_page_size'), false);
  assert.equal(api.searchParams.has('payload_tier'), false);
  for (const other of [{ ...view, query: 'colossus' }, { ...view, selected_artist: 'Colossus Project' }]) {
    assert.equal(new URL(buildUrl(other), 'http://localhost').searchParams.has('series'), false);
    assert.equal(new URL(buildApiUrl(other), 'http://localhost').searchParams.has('series'), false);
  }
});

test('3A: the folded sidebar has a Series button directly below the Artist Tree button, with the Linked sleeves icon', () => {
  const template = fs.readFileSync(path.join(repoRoot, 'music_app', 'templates', 'index.html'), 'utf8');
  const rail = template.slice(template.indexOf('id="shell-navigation-compact"'), template.indexOf('</nav>', template.indexOf('id="shell-navigation-compact"')));
  const tree = rail.indexOf("id='artist-tree-navigation-button'");
  const series = rail.indexOf("id='series-tree-navigation-button'");
  assert.ok(tree > 0 && series > tree);
  assert.match(rail.slice(series), /'data-open-series-tree': '1'/);
  // Linked sleeves: two rounded sleeves, their discs and the link, in the rail's stroke.
  assert.match(rail.slice(series), /<rect x="2\.5" y="2\.5" width="9" height="9" rx="1\.6"><\/rect><circle cx="7" cy="7" r="1\.8"><\/circle><rect x="12\.5" y="12\.5" width="9" height="9" rx="1\.6"><\/rect><circle cx="17" cy="17" r="1\.8"><\/circle>/);
});
