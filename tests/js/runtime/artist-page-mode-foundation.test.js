'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Root may point this additive packet at an immutable before tree or the final
// composed checkout. Whole existing owner scripts are loaded without rewriting.
const ROOT = process.env.ALBUMHAVEN_ARTIST_FOUNDATION_ROOT || path.resolve(__dirname, '../../..');
const ARTIST = 'Ария & The Artist / Live';
const OTHER = 'Other Canonical Artist';
const ORIGIN = 'https://albumhaven.test';
const plain = value => JSON.parse(JSON.stringify(value));
const params = value => new URL(value, ORIGIN).searchParams;
function load(context, ...files) {
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(ROOT, 'music_app/static/js', file), 'utf8'), context, {filename: file});
}
function artistView({artist = ARTIST, mode = 'info', ...patch} = {}) {
  return {
    surface: {active: 'albums'}, selected_artist: artist, query: '',
    visible_library_categories: ['main_library', 'hoard'], gallery_scope: 'all',
    gallery_display_mode: 'cards', gallery_scale_percent: 100,
    related_filter_artists: [], primary_filter_active: false,
    artist_groups: [{artist, albums: [{key: 'canonical-album-key', title: 'Known release'}]}],
    primary_artist_groups: [], family_artist_groups: [], artists_sidebar: [],
    album_count: 1, artist_count: 1, initial_view_partial: false,
    artist_page: {artist_ref: artist, active_page_mode: mode, page_modes: ['gallery', 'info'], default_page_mode: 'gallery'},
    ...patch,
  };
}
function harness(initial = {}) {
  const context = vm.createContext({URL, URLSearchParams, structuredClone,
    appBootstrap: {getInitialView: () => ({}), getBootstrap: () => ({})},
    state: {view: initial, ui: {}, gallery: {}},
  });
  load(context, 'runtime/view-state-helpers.js', 'runtime/response-state-helpers.js');
  return context;
}
function assertInfoUrls(context, view, artist = ARTIST) {
  for (const build of [context.buildUrl, context.buildApiUrl]) {
    const url = build(view), p = params(url);
    assert.equal(p.get('surface'), 'albums');
    assert.equal(p.get('artist'), artist);
    assert.equal(p.get('page_mode'), 'info');
    assert.equal(p.has('mobile_page'), false);
  }
}
function assertNoInfo(context, view) {
  assert.notEqual(view.page_mode, 'info');
  for (const build of [context.buildUrl, context.buildApiUrl]) assert.notEqual(params(build(view)).get('page_mode'), 'info');
}

test('direct selected-Artist info query round-trips through existing public and API builders', () => {
  const c = harness();
  const route = '/?surface=albums&artist=' + encodeURIComponent(ARTIST) + '&page_mode=info&category=main_library&category=hoard';
  const parsed = c.parseUrlStateFromUrl(route, ORIGIN);
  assertInfoUrls(c, parsed);
  assert.deepEqual(plain(parsed.visible_library_categories), ['main_library', 'hoard']);
  assertInfoUrls(c, c.parseUrlStateFromUrl(c.buildUrl(parsed), ORIGIN));
  const api = new URL(c.buildApiUrl(parsed, {omitSidebar: true, payloadTier: 'full'}), ORIGIN);
  assert.equal(api.pathname, '/view-data');
  assert.equal(api.searchParams.get('omit_sidebar'), '1');
  assert.equal(api.searchParams.get('payload_tier'), 'full');
  assert.equal(api.searchParams.has('gallery_page_size'), false);
});

test('server canonical Artist info descriptor survives normal response compaction and URL serialization', () => {
  const c = harness(), source = artistView(), before = JSON.stringify(source);
  for (const value of [c.normalizeViewPayload(source), c.cloneRuntimeCompactViewPayload(source)]) {
    assert.equal(value.artist_page.artist_ref, ARTIST);
    assertInfoUrls(c, value);
  }
  assert.equal(JSON.stringify(source), before, 'normalization must not mutate the admitted response');
});

test('matching server Gallery mode wins over a stale client info request', () => {
  const c = harness(), source = artistView({mode: 'gallery', page_mode: 'info'});
  const normalized = c.normalizeViewPayload(source);
  assertNoInfo(c, normalized);
  assert.equal(normalized.artist_page.active_page_mode, 'gallery');
});

test('missing and unknown modes cannot become an Artist info request', () => {
  const c = harness();
  for (const mode of ['', 'album', 'information-sheet', 'info,gallery', '<script>']) {
    const parsed = c.parseUrlStateFromUrl('/?surface=albums&artist=' + encodeURIComponent(ARTIST) + '&page_mode=' + encodeURIComponent(mode), ORIGIN);
    assertNoInfo(c, parsed);
    assertNoInfo(c, c.normalizeViewPayload(artistView({mode})));
  }
});

test('an info query with no selected Artist cannot survive parse/build', () => {
  const c = harness();
  for (const suffix of ['', '&artist=', '&artist=%20%20']) {
    assertNoInfo(c, c.parseUrlStateFromUrl('/?surface=albums&page_mode=info' + suffix, ORIGIN));
  }
});

test('mismatched server Artist identity cannot carry an old info descriptor', () => {
  const c = harness(), source = artistView();
  source.artist_page.artist_ref = OTHER;
  const normalized = c.normalizeViewPayload(source);
  assert.equal(normalized.selected_artist, ARTIST);
  assertNoInfo(c, normalized);
  assert.equal(normalized.artist_page, undefined, 'the foreign descriptor itself must be retired');
});

test('switching canonical Artist without a fresh descriptor retires the previous page mode', () => {
  const c = harness(), previous = artistView(), source = artistView({artist: OTHER});
  delete source.artist_page;
  const normalized = c.normalizeViewPayload(source, previous);
  assert.equal(normalized.selected_artist, OTHER);
  assertNoInfo(c, normalized);
  assert.equal(normalized.artist_page, undefined);
  assert.equal(previous.artist_page.artist_ref, ARTIST);
});

test('clearing selected Artist retires page metadata instead of inheriting the old page', () => {
  const c = harness();
  const normalized = c.normalizeViewPayload({surface: {active: 'albums'}, selected_artist: '', query: '', artist_groups: []}, artistView());
  assertNoInfo(c, normalized);
  assert.equal(normalized.artist_page, undefined);
});

test('a full same-Artist response missing its descriptor cannot inherit prior info admission', () => {
  const c = harness(), source = artistView({payload_tier: 'full'});
  delete source.artist_page;
  const normalized = c.normalizeViewPayload(source, artistView());
  assertNoInfo(c, normalized);
  assert.equal(normalized.artist_page, undefined);
});

test('a local non-identity patch keeps the current canonical Artist presentation', () => {
  const c = harness();
  const normalized = c.normalizeViewPayload({album_count: 2}, artistView());
  assert.equal(normalized.album_count, 2);
  assertInfoUrls(c, normalized);
});

for (const surface of ['home', 'playlists', 'album_tops']) {
  test(`Artist mode does not leak into the existing ${surface} surface`, () => {
    const c = harness(), contaminated = {...artistView(), surface: {active: surface}, selected_artist: '', page_mode: 'info'};
    const normalized = c.normalizeViewPayload(contaminated, artistView());
    assertNoInfo(c, normalized);
    assert.equal(normalized.artist_page, undefined);
    const parsed = c.parseUrlStateFromUrl('/?surface=' + surface + '&artist=' + encodeURIComponent(ARTIST) + '&page_mode=info', ORIGIN);
    // Home + an explicit artist is the existing Album-search compatibility path;
    // the actual Home response above is the presentation-boundary assertion.
    if (surface !== 'home') assertNoInfo(c, parsed);
  });
}

test('a private personal Search response cannot adopt stale Artist info presentation', () => {
  const c = harness(), source = {...artistView(), query: ':loved', private_search: true,
    contract_version: 'own-love-v1', status: 'ready', presentation: 'tracks', page_mode: 'info'};
  const normalized = c.normalizeViewPayload(source, artistView());
  assertNoInfo(c, normalized);
  assert.equal(normalized.artist_page, undefined);
  assert.equal(normalized.query, ':loved');
  assert.equal(normalized.private_search, true);
});

test('ordinary filtered Artist Gallery URL retains its existing filters and display choices', () => {
  const c = harness();
  const input = {...artistView({mode: 'gallery'}), query: 'progressive rock', related_filter_artists: [OTHER],
    primary_filter_active: true, gallery_display_mode: 'list', gallery_scale_percent: 125,
    search_filters: {genre: ['Rock'], mood: ['Calm'], style: [], duration: {min_seconds: 60, max_seconds: null}}};
  for (const build of [c.buildUrl, c.buildApiUrl]) {
    const p = params(build(input));
    assert.notEqual(p.get('page_mode'), 'info');
    assert.equal(p.get('q'), 'progressive rock');
    assert.equal(p.get('related_artist'), OTHER);
    assert.equal(p.get('primary_filter'), '1');
    assert.equal(p.get('gallery_display'), 'list');
    assert.equal(p.get('gallery_scale_percent'), '125');
    assert.equal(p.get('genre'), 'Rock');
    assert.equal(p.get('duration_min'), '60');
    assert.deepEqual(p.getAll('category'), ['main_library', 'hoard']);
  }
});

test('info presentation cannot reuse an ordinary selected-search Gallery cache entry', () => {
  const c = harness();
  const gallery = artistView({mode: 'gallery', query: 'Artist'});
  c.rememberReusableSelectedArtistBrowseView(gallery);
  assert.equal(c.getReusableSelectedArtistBrowseView(gallery).artist_page.active_page_mode, 'gallery');
  assert.equal(c.getReusableSelectedArtistBrowseView(artistView({query: 'Artist'})), null,
    'explicit Artist page entry must go through a fresh source read');
});

test('info data cannot contaminate a later ordinary selected-search Gallery cache hit', () => {
  const c = harness();
  c.rememberReusableSelectedArtistBrowseView(artistView({query: 'Artist'}));
  assert.equal(c.getReusableSelectedArtistBrowseView(artistView({mode: 'gallery', query: 'Artist'})), null);
});

test('an Info response cannot be remembered and reused by another Info read', () => {
  const c = harness(), info = artistView({query: 'Artist'});
  c.rememberReusableSelectedArtistBrowseView(info);
  assert.equal(c.getReusableSelectedArtistBrowseView(info), null,
    'partitioning Info into its own cache key still violates fresh source admission');
});

function parsedInfoRequest(c) {
  const request = c.parseUrlStateFromUrl('/?surface=albums&artist=' + encodeURIComponent(ARTIST)
    + '&q=Artist&page_mode=info&gallery_scope=all&category=main_library&category=hoard', ORIGIN);
  assert.equal(request.page_mode, 'info');
  assert.equal(Object.hasOwn(request, 'artist_page'), false,
    'navigation criteria must not manufacture a server admission descriptor');
  return request;
}

test('parsed request-only Info cannot retrieve a reusable ordinary Gallery response', () => {
  const c = harness(), gallery = artistView({mode: 'gallery', query: 'Artist'});
  gallery.artist_groups[0].albums[0].title = 'Original Gallery cache marker';
  c.rememberReusableSelectedArtistBrowseView(gallery);
  assert.equal(c.getReusableSelectedArtistBrowseView(gallery).artist_groups[0].albums[0].title,
    'Original Gallery cache marker', 'ordinary Gallery reuse remains available');
  assert.equal(c.getReusableSelectedArtistBrowseView(parsedInfoRequest(c)), null);
});

test('remembering request-only Info cannot populate its cache or replace ordinary Gallery data', () => {
  const c = harness(), gallery = artistView({mode: 'gallery', query: 'Artist'});
  gallery.artist_groups[0].albums[0].title = 'Original Gallery cache marker';
  c.rememberReusableSelectedArtistBrowseView(gallery);
  assert.equal(c.getReusableSelectedArtistBrowseView(gallery).artist_groups[0].albums[0].title,
    'Original Gallery cache marker');
  const request = parsedInfoRequest(c);
  c.rememberReusableSelectedArtistBrowseView(request);
  assert.equal(c.getReusableSelectedArtistBrowseView(request), null);
  assert.equal(c.getReusableSelectedArtistBrowseView(gallery).artist_groups[0].albums[0].title,
    'Original Gallery cache marker', 'an unadmitted Info request cannot overwrite the reusable Gallery response');
});

function navigationHarness(initial = artistView()) {
  const c = harness(initial), writes = [], reads = [];
  const location = new URL('/?surface=albums&artist=' + encodeURIComponent(ARTIST) + '&page_mode=info', ORIGIN);
  c.window = {location, history: {state: {artist_page: {artist_ref: 'FORGED HISTORY ARTIST', active_page_mode: 'info'}},
    pushState(snapshot, title, url) {writes.push({snapshot, url});}},
  };
  load(c, 'settings-navigation.js', 'runtime/browser-navigation-helpers.js', 'runtime/bootstrap-gallery-event-handlers.js');
  c.fetchAndRender = (url, push, options) => {
    reads.push({url, api: c.buildApiUrl(c.parseBrowserUrlState(url)), push, options});
    return Promise.resolve(true);
  };
  return {c, writes, reads, location};
}

test('native history adapter forwards Artist mode and snapshot to its writer collaborator', () => {
  const h = navigationHarness(), snapshot = {selected_artist: ARTIST, page_mode: 'info'};
  h.c.window.AlbumHavenSettingsNavigation.instance = {pushLibraryHistory(url, value) {h.writes.push({url, snapshot: value});}};
  h.c.pushBrowserViewState(artistView(), snapshot);
  assert.equal(h.writes.length, 1);
  assert.equal(params(h.writes[0].url).get('page_mode'), 'info');
  assert.strictEqual(h.writes[0].snapshot, snapshot);
});

function settingsWriterHarness({mounted = true} = {}) {
  const c = harness(artistView()), writes = [], listeners = [];
  const location = new URL('/?surface=albums', ORIGIN);
  let historyState = {albumHavenNavigationPosition: 17};
  const history = {
    get state() {return historyState;},
    pushState(value, title, url) {
      historyState = structuredClone(value);
      location.href = new URL(url, location).href;
      writes.push({mode: 'push', snapshot: structuredClone(historyState), url: location.href});
    },
    replaceState(value, title, url) {
      historyState = structuredClone(value);
      location.href = new URL(url || location.href, location).href;
      writes.push({mode: 'replace', snapshot: structuredClone(historyState), url: location.href});
    },
    go() {assert.fail('a history write must not traverse browser history');},
  };
  const node = () => ({hidden: true, inert: false, attributes: new Map(),
    classList: {remove() {}, contains: () => false}, querySelector: () => null,
    setAttribute(name, value) {this.attributes.set(name, String(value));},
  });
  const host = node(), outlet = node(), nav = node(), library = node();
  const nodes = new Map([['[data-settings-host]', host], ['[data-settings-outlet]', outlet],
    ['[data-settings-nav]', nav], ['#app-shell', library]]);
  const document = {title: 'Album Haven', querySelector: selector => mounted ? nodes.get(selector) || null : null,
    addEventListener(name, callback) {listeners.push({target: 'document', name, callback});}, removeEventListener() {},
  };
  c.AbortController = AbortController;
  c.document = document;
  c.window = {location, history, innerWidth: 1200, DOMParser: class {},
    fetch() {assert.fail('a native history commit must not fetch Settings');},
    addEventListener(name, callback, capture) {listeners.push({target: 'window', name, callback, capture});}, removeEventListener() {},
  };
  load(c, 'settings-navigation.js', 'runtime/browser-navigation-helpers.js');
  return {c, writes, history, location, listeners};
}

test('the actual Settings history writer commits one canonical Artist Info entry and sanitizes its snapshot', () => {
  const h = settingsWriterHarness();
  assert.ok(h.c.window.AlbumHavenSettingsNavigation.instance, 'the real Settings owner must be mounted');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].mode, 'replace', 'Settings initializes the existing navigation position');
  const snapshot = {selected_artist: ARTIST, page_mode: 'info', bodyScroll: 27,
    mobileCollapsed: {info: true, discography: false}, track_preference: {love_tier: 2}};
  const original = JSON.stringify(snapshot);
  h.c.pushBrowserViewState(artistView(), snapshot);
  assert.equal(h.writes.length, 2, 'one initialization replacement and one push');
  assert.equal(h.writes.filter(write => write.mode === 'push').length, 1);
  const committed = h.writes[1];
  assert.equal(params(committed.url).get('artist'), ARTIST);
  assert.equal(params(committed.url).get('page_mode'), 'info');
  assert.equal(committed.snapshot.albumHavenNavigationPosition, 18);
  assert.equal(committed.snapshot.selected_artist, ARTIST);
  assert.equal(committed.snapshot.page_mode, 'info');
  assert.equal(committed.snapshot.bodyScroll, 27);
  assert.deepEqual(plain(committed.snapshot.mobileCollapsed), {info: true, discography: false});
  assert.equal(Object.hasOwn(committed.snapshot, 'track_preference'), false,
    'the actual existing native sanitizer excludes preference receipts');
  assert.equal(JSON.stringify(snapshot), original, 'owner/sanitizer/browser must not mutate the caller snapshot');
  assert.notStrictEqual(h.history.state, snapshot, 'browser I/O stores a clone');
});

test('the instance-absent history branch keeps the native sanitizer and browser push', () => {
  const h = settingsWriterHarness({mounted: false});
  assert.equal(h.c.window.AlbumHavenSettingsNavigation.instance, null);
  assert.equal(h.writes.length, 0);
  const snapshot = {selected_artist: ARTIST, page_mode: 'info', bodyScroll: 42,
    track_preference: {love_tier: 1}};
  const original = JSON.stringify(snapshot);
  h.c.pushBrowserViewState(artistView(), snapshot);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].mode, 'push');
  assert.equal(params(h.writes[0].url).get('page_mode'), 'info');
  assert.equal(h.writes[0].snapshot.selected_artist, ARTIST);
  assert.equal(h.writes[0].snapshot.bodyScroll, 42);
  assert.equal(Object.hasOwn(h.writes[0].snapshot, 'track_preference'), false);
  assert.equal(JSON.stringify(snapshot), original);
});

test('native popstate rereads Artist info URL without adopting history payload or pushing', () => {
  const h = navigationHarness(), current = h.c.state.view;
  h.c.handleGalleryBootstrapPopState({skipPendingViewTransition: true});
  assert.equal(h.reads.length, 1);
  assert.equal(h.reads[0].push, false);
  assert.equal(params(h.reads[0].api).get('artist'), ARTIST);
  assert.equal(params(h.reads[0].api).get('page_mode'), 'info');
  assert.strictEqual(h.c.state.view, current);
  assert.equal(h.writes.length, 0);
  assert.doesNotMatch(h.reads[0].api, /FORGED/);
});

function startupHarness({endpoint = '', mode = 'info', required = true, partial = true} = {}) {
  const c = harness(artistView({mode, initial_view_partial: partial})), requests = [];
  const bootstrap = {partialView: partial, startupHydration: {required, endpoint, tier: 'full'}};
  c.appBootstrap.getBootstrap = () => bootstrap;
  c.window = {location: new URL('/?surface=albums&artist=' + encodeURIComponent(ARTIST) + '&page_mode=' + mode, ORIGIN), addEventListener() {}};
  c.document = {querySelectorAll: () => [], getElementById: () => null, addEventListener() {}};
  c.console = console;
  c.resolveGalleryDisplayPreferenceViewState = view => view;
  c.applyViewPayload = value => {c.state.view = value;};
  c.startupMetrics = {beginInitialRefresh() {}, markInitialRender() {}, completeInitialRefresh() {}};
  c.fetchAndRender = (...args) => {requests.push(args); return Promise.resolve(true);};
  for (const name of ['restorePlayerAppearance', 'attachModalEvents', 'attachAccountMenu', 'attachCoverLookupModalEvents',
    'attachCoverLookupDeleteConfirmEvents', 'attachUtilityModalEvents', 'attachRepairConfirmEvents', 'attachPlayerEvents',
    'renderView', 'updateStatusIndicator', 'renderLibraryLoader', 'scheduleBrowserTimeout', 'pollStatus',
    'hideStatusContextMenu', 'hideVersionContextMenu']) c[name] = () => {};
  load(c, 'runtime/view-value-helpers.js', 'runtime/bootstrap-init.js');
  return {c, requests};
}

test('actual bootstrap entry carries canonical Artist info mode into generated hydration', () => {
  const {c, requests} = startupHarness();
  assert.equal(requests.length, 1);
  assert.equal(params(requests[0][0]).get('artist'), ARTIST);
  assert.equal(params(requests[0][0]).get('page_mode'), 'info');
  assert.equal(requests[0][1], false);
  assert.equal(requests[0][2].startupRefresh, true);
  assertInfoUrls(c, c.state.view);
});

test('same-surface startup endpoint options cannot erase canonical Artist identity or info mode', () => {
  const {requests} = startupHarness({endpoint: '/view-data?surface=albums&artist=Old&page_mode=gallery&payload_tier=full&omit_sidebar=1'});
  assert.equal(requests.length, 1);
  const p = params(requests[0][0]);
  assert.equal(p.get('artist'), ARTIST);
  assert.equal(p.get('page_mode'), 'info');
  assert.equal(p.get('payload_tier'), 'full');
  assert.equal(p.get('omit_sidebar'), '1');
});

test('same-surface Gallery hydration cannot resurrect an old Artist info endpoint', () => {
  const {requests} = startupHarness({mode: 'gallery', endpoint: '/view-data?surface=albums&artist=Old&page_mode=info&payload_tier=full'});
  assert.equal(requests.length, 1);
  assert.equal(params(requests[0][0]).get('artist'), ARTIST);
  assert.notEqual(params(requests[0][0]).get('page_mode'), 'info');
});

test('Artist hydration does not rewrite a different route or collection endpoint', () => {
  const {c} = startupHarness({required: false, partial: false});
  for (const endpoint of ['/home-data?surface=albums', '/view-data?surface=playlists&playlist_id=existing-playlist']) {
    assert.equal(c.resolveInitialHydrationEndpoint({endpoint}), endpoint);
  }
});

test('a complete existing Artist bootstrap does not create redundant hydration', () => {
  const {c, requests} = startupHarness({required: false, partial: false});
  assert.equal(requests.length, 0);
  assertInfoUrls(c, c.state.view);
});
