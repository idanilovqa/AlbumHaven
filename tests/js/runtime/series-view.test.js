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
  assert.equal(html, `<div class="album-details-series album-details-series--inline" data-album-details-series="series"><span class="album-details-series__label">Series:</span><span class="album-details-series__names"><button type="button" class="album-open-trigger album-title-button album-details-series__link" title="Show all albums in this series" data-open-series="${COLOSSUS}">Colossus Projects</button>, <button type="button" class="album-open-trigger album-title-button album-details-series__link" title="Show all albums in this series" data-open-series="b">Second Series</button></span></div>`);
  const featured = components().buildAlbumDetailsSeriesHtml(
    { musicbrainz_series: [{ mbid: 'c', name: 'Metal Albums', kind: 'featured_in' }] }, { inline: true });
  assert.match(featured, /<span class="album-details-series__label">Featured In:<\/span><span class="album-details-series__names"><button[^>]*data-open-series="c">Metal Albums<\/button><\/span><\/div>$/);
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

const FEATURED = 'd5471f85-4b54-45da-9de7-c9ad9843c4bd';
const TREE = [
  { mbid: 'eaf64fe2-2c12-44a6-9210-4b717d107c6e', name: 'COLEZO! TWIN', count: 1, kind: 'series', owner_kind: null },
  { mbid: FEATURED, name: 'Rolling Stone: The 100 Greatest Metal Albums of All Time', count: 2, kind: 'featured_in', owner_kind: null },
  { mbid: COLOSSUS, name: 'Colossus Projects', count: 10, kind: 'series', owner_kind: null },
];
const treeTags = (html) => [...html.matchAll(/<(?:a|button|div) [^>]*>/g)].map((match) => match[0]);
const treeLabels = (html) => [...html.matchAll(/artist-name-label">([^<]*)</g)].map((match) => match[1]);

test('2 and 4B: the Series tree uses the artist tree items, each with its count, the open one selected', () => {
  const html = viewHelpers().buildSeriesSidebarHtml({ selected_series: COLOSSUS, series_sidebar: TREE }, {});
  const item = treeTags(html).find((tag) => tag.includes(`data-sidebar-series="${COLOSSUS}"`));
  assert.match(item, /class="artist-link active navigation-tree-item is-selected"/);
  assert.match(item, new RegExp(`href="/\\?surface=albums&amp;series=${COLOSSUS}"`));
  assert.match(item, /data-nav="1"/);
  assert.match(html, /Colossus Projects<\/span><span class="navigation-tree-count artist-count">10<\/span>/);
  assert.equal(treeTags(html).filter((tag) => tag.includes('is-selected')).length, 1);
});

test('4B: two groups, Series then Featured In, each under its heading; no "All series" or "All Featured In"', () => {
  const html = viewHelpers().buildSeriesSidebarHtml({ selected_series: 'all', series_sidebar: TREE }, {});
  assert.deepEqual(treeLabels(html), ['Series', 'COLEZO! TWIN', 'Colossus Projects', 'Featured In',
    'Rolling Stone: The 100 Greatest Metal Albums of All Time']);
  assert.doesNotMatch(html, /All series|All Featured In|data-sidebar-all-series/);
  assert.equal(treeTags(html).some((tag) => tag.includes('is-selected')), false);
});

test('4B: a group heading is a collapsible button, never a link, a selection or a count', () => {
  const html = viewHelpers().buildSeriesSidebarHtml({ selected_series: 'all', series_sidebar: TREE }, {});
  const headings = treeTags(html).filter((tag) => tag.includes('data-series-tree-group'));
  assert.equal(headings.length, 2);
  for (const heading of headings) {
    assert.match(heading, /^<button [^>]*type="button"/);
    assert.match(heading, /navigation-tree-group-heading/);
    assert.match(heading, /aria-expanded="true"/);
    assert.doesNotMatch(heading, /data-nav="|href=|aria-current|is-selected/);
  }
  assert.doesNotMatch(html, /Series<\/span><span class="navigation-tree-count/);
});

test('4B: a collapsed group keeps its heading and hides its series; the other group stays open', () => {
  const html = viewHelpers().buildSeriesSidebarHtml({ selected_series: COLOSSUS, series_sidebar: TREE },
    { series: true, featured_in: false });
  assert.deepEqual(treeLabels(html), ['Series', 'Featured In', 'Rolling Stone: The 100 Greatest Metal Albums of All Time']);
  assert.match(html, /aria-expanded="false" data-series-tree-group="series"|data-series-tree-group="series"[^>]*aria-expanded="false"/);
  assert.match(html, /aria-expanded="true"[^>]*data-series-tree-group="featured_in"|data-series-tree-group="featured_in"[^>]*aria-expanded="true"/);
});

test("4B: the collapsed groups come from the viewer's saved preference by default", () => {
  const helpers = viewHelpers();
  helpers.state.ui = { seriesTreeCollapsedGroups: { series: false, featured_in: true } };
  assert.deepEqual(treeLabels(helpers.buildSeriesSidebarHtml({ series_sidebar: TREE })),
    ['Series', 'COLEZO! TWIN', 'Colossus Projects', 'Featured In']);
});

test('owner 2026-11-17: each group heading carries the fold arrow of the artist tree', () => {
  const helpers = viewHelpers();
  const arrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"></path></svg>';
  const getElementById = helpers.document.getElementById;
  helpers.document.getElementById = (id) => (id === 'artist-tree-fold-button'
    ? { querySelector: (selector) => (selector === 'svg' ? { outerHTML: arrow } : null) } : getElementById(id));
  const html = helpers.buildSeriesSidebarHtml({ selected_series: 'all', series_sidebar: TREE }, { featured_in: true });
  const chevrons = [...html.matchAll(/<span class="navigation-tree-group-heading__chevron">([^]*?)<\/span>/g)];
  assert.deepEqual(chevrons.map((match) => match[1]), [arrow, arrow]);
  assert.match(html, /aria-expanded="true"[^>]*>[^]*?navigation-tree-group-heading__chevron/);
  // Rows never carry it.
  assert.equal((html.match(/navigation-tree-group-heading__chevron/g) || []).length, 2);
});

test('4B: the separator comes before Featured In only where NavigationTree draws one', () => {
  const view = { selected_series: 'all', series_sidebar: TREE };
  const without = viewHelpers();
  assert.equal(typeof without.window.NavigationTree.renderSeparator, 'undefined');
  assert.doesNotMatch(without.buildSeriesSidebarHtml(view, {}), /separator/);
  const helpers = viewHelpers();
  const labels = [];
  helpers.window.NavigationTree.renderSeparator = ({ label }) => { labels.push(label); return '<div role="separator"></div>'; };
  const html = helpers.buildSeriesSidebarHtml(view, {});
  assert.deepEqual(labels, ['Featured In']);
  assert.match(html, /Colossus Projects<\/span>[^]*<div role="separator"><\/div><button[^>]*data-series-tree-group="featured_in"/);
  // No Series group above it: no separator at the top.
  labels.length = 0;
  helpers.buildSeriesSidebarHtml({ series_sidebar: TREE.filter((item) => item.kind === 'featured_in') }, {});
  assert.deepEqual(labels, []);
});

test('4B: a group with no series is left out, heading and all', () => {
  const html = viewHelpers().buildSeriesSidebarHtml({ series_sidebar: TREE.filter((item) => item.kind === 'series') }, {});
  assert.deepEqual(treeLabels(html), ['Series', 'COLEZO! TWIN', 'Colossus Projects']);
  assert.equal(viewHelpers().buildSeriesSidebarHtml({ series_sidebar: [] }, {}), '');
});

test('3A: a Featured In series is a selectable tree item that opens its gallery', () => {
  const html = viewHelpers().buildSeriesSidebarHtml({ selected_series: FEATURED, series_sidebar: TREE }, {});
  const item = treeTags(html).find((tag) => tag.includes(`data-sidebar-series="${FEATURED}"`));
  assert.match(item, /class="artist-link active navigation-tree-item is-selected"/);
  assert.match(item, new RegExp(`href="/\\?surface=albums&amp;series=${FEATURED}" data-nav="1"`));
});

function seriesKindSaver(response) {
  const context = load(['gallery-main-interactions.js']);
  const calls = { fetch: [], toasts: [], refreshes: [] };
  context.fetch = async (url, options) => { calls.fetch.push([url, options]); return response; };
  context.showToast = (...args) => calls.toasts.push(args);
  context.refreshCurrentViewAfterBackgroundCompletion = async (options) => { calls.refreshes.push(options); return true; };
  return { save: context.saveSeriesKind, calls };
}

test('5B: a series kind is saved for that series, then the open view reloads in place to regroup the tree', async () => {
  const { save, calls } = seriesKindSaver({ ok: true, json: async () => ({}) });
  assert.equal(await save(FEATURED, 'series'), true);
  const [[url, options]] = calls.fetch;
  assert.equal(url, `/api/musicbrainz/series/${FEATURED}/kind`);
  assert.equal(options.method, 'PUT');
  assert.deepEqual(JSON.parse(options.body), { kind: 'series' });
  assert.deepEqual(calls.refreshes.map((item) => ({ ...item })), [{ preserveScroll: true }]);
  assert.deepEqual(calls.toasts, []);
  await save(FEATURED, null);
  assert.deepEqual(JSON.parse(calls.fetch[1][1].body), { kind: null });
});

test('5B: a refused save says why and leaves the tree as it is', async () => {
  const { save, calls } = seriesKindSaver({ ok: false, json: async () => ({ detail: 'Action not permitted.' }) });
  assert.equal(await save(FEATURED, 'featured_in'), false);
  assert.deepEqual(calls.toasts.map((args) => [...args]), [['Action not permitted.', 'error', 3200]]);
  assert.deepEqual(calls.refreshes, []);
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
