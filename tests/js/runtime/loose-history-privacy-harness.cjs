// R3 whole-source owner composition. The browser history seam models the native
// structured clone, without a browser, source extraction, or sanitizer stand-in.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  createLooseAuthorityFixture, looseRow, browsePayload, overlay, outcome,
  repositoryRoot,
} = require('./loose-authority-harness.cjs');

// The six bounded personal fields emitted or removed by the current Loose
// producer. Existing track/path, selection, navigation and action fields remain.
const privatePreferenceKeys = new Set([
  'canonical_track_ref', 'inventory_track_ref', 'track_preference',
  'track_preference_state', 'can_edit_preferences', 'track_preference_overlay',
]);

function freeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function historyPayload(id = 301, patch = {}) {
  const row = looseRow(id, {
    track_ref: `/synthetic/loose-authority/${id}.flac`,
    track_preference: overlay('obsessed'), can_edit_preferences: true,
    track_preference_overlay: overlay('loved', false),
    display_badge: 'Keep this badge', selection_label: 'Keep this selection',
  });
  const nested = {
    title: 'Retained section', tracks: [row], track_rows: [row],
    gallery_list_block: {heading: 'Loose display', track_rows: [row]},
    duplicate_sources: [{title: 'Duplicate representation', tracks: [row]}],
  };
  return freeze(browsePayload([row], {
    query: 'fixture search', selected_artist: 'Fixture Artist',
    gallery_display_mode: 'list', gallery_scale_percent: 125,
    selection: {rowKeys: ['row-for-navigation'], anchor: 'row-for-navigation'},
    navigation: {kind: 'library', token: 'existing-navigation-marker', returnTo: '/?surface=albums'},
    retained: {view: {non_album_tracks: [row]}, sections: [nested]},
    alias: nested,
    ...patch,
  }));
}

function element() {
  const classes = new Set();
  return {
    hidden: true, dataset: {}, isConnected: true,
    classList: {
      add: value => classes.add(value), remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle(value, enabled) {if (enabled) classes.add(value); else classes.delete(value);},
    },
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    contains: () => false, before() {}, focus() {}, replaceChildren() {},
  };
}

function createHistoryFixture({settings = false} = {}) {
  const f = createLooseAuthorityFixture(), historyWrites = [], warnings = [];
  const browser = f.context.window;
  browser.location = new URL('https://albumhaven.test/?surface=albums');
  browser.innerWidth = 600;
  browser.fetch = f.context.fetch;
  browser.DOMParser = class {};
  const store = (mode, snapshot, title, url) => {
    const serialized = structuredClone(snapshot);
    const target = new URL(String(url), browser.location.href);
    historyWrites.push({mode, snapshot: serialized, title, url: target.href});
    browser.history.state = serialized;
    browser.location = target;
  };
  browser.history = {
    state: {},
    pushState: (snapshot, title, url) => store('push', snapshot, title, url),
    replaceState: (snapshot, title, url) => store('replace', snapshot, title, url),
    go() {throw new Error('Unexpected history traversal in history-write regression');},
  };
  f.document.title = 'Loose tracks';
  f.document.addEventListener = () => {};
  f.document.removeEventListener = () => {};
  f.document.createComment = () => ({before() {}});
  Object.assign(f.context, {
    structuredClone,
    console: {...console, warn: (...args) => warnings.push(args)},
    // URL construction/parsing are unrelated endpoints of these owner units.
    buildUrl: view => `/?surface=albums&query=${encodeURIComponent(view?.query || '')}`,
    parseUrlStateFromUrl(value, origin) {
      const url = new URL(value, origin);
      return {query: url.searchParams.get('query') || '', selected_artist: url.searchParams.get('selected_artist') || ''};
    },
    closeArtistsDrawer() {}, closeGalleryMainSurface() {}, requestAnimationFrame() {},
  });
  // Real documents load Settings before the history-writing runtime owners.
  // The fallback has the script's shared exports, but no host or instance.
  installSettings(settings);
  f.loadRuntime('browser-navigation-helpers.js');
  f.loadRuntime('playtable-source.js');
  browser.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: 'history-privacy-own-scope'})};
  const native = vm.runInContext('NativePlaytables', f.context);
  function prepare(view = f.state.view) {
    f.state.view = view;
    const privateRows = view.non_album_tracks || [];
    return native.prepare('loose-tracks', view,
      [{title: 'Loose tracks', tracks: privateRows.map(row => ({title: row.title}))}],
      privateRows, () => f.state.view === view).trackPreferences;
  }
  function installSettings(withHost = true) {
    const host = element(), outlet = element(), nav = element();
    const settingsNodes = new Map(withHost ? [
      ['[data-settings-host]', host], ['[data-settings-outlet]', outlet],
      ['[data-settings-nav]', nav], ['#app-shell', f.shell],
    ] : [['#app-shell', f.shell]]);
    f.document.querySelector = selector => settingsNodes.get(selector) || null;
    vm.runInContext(fs.readFileSync(path.join(repositoryRoot, 'music_app/static/js/settings-navigation.js'), 'utf8'),
      f.context, {filename: 'settings-navigation.js'});
    assert.ok(browser.AlbumHavenSettingsNavigation, 'the actual Settings script must always export its shared owner');
    if (withHost) assert.ok(browser.AlbumHavenSettingsNavigation.instance, 'the real Settings owner must install');
    else assert.equal(browser.AlbumHavenSettingsNavigation.instance, null,
      'the actual no-host fallback must have no installed Settings instance');
    return browser.AlbumHavenSettingsNavigation.instance;
  }
  function installMobile() {
    f.nodes.set('mobile-page-outlet', element());
    f.nodes.set('non-album-modal', element());
    f.nodes.set('app-form-modal', element());
    f.loadRuntime('mobile-navigation.js');
  }
  function seedHistoryState(snapshot) {browser.history.state = structuredClone(snapshot);}
  async function browseAndPush(payload) {
    const index = f.requests.length;
    const pending = outcome(f.context.fetchAndRender('/view-data?surface=albums', true,
      {skipPendingViewTransition: true}));
    f.respond(index, payload);
    const result = await pending;
    assert.ifError(result.error);
    assert.equal(result.value, true, 'the actual foreground browse owner must commit');
  }
  historyWrites.length = 0;
  return {...f, browser, native, historyWrites, warnings, prepare, installSettings,
    installMobile, seedHistoryState, browseAndPush};
}

function assertNoPrivatePreferenceMetadata(snapshot) {
  const seen = new Set(), pending = [{value: snapshot, location: 'history'}];
  while (pending.length) {
    const {value, location} = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      assert.equal(privatePreferenceKeys.has(key), false,
        `${location}.${key} must not be serialized into browser history`);
      pending.push({value: child, location: `${location}.${key}`});
    }
  }
}

function assertDisplayPreserved(snapshot, original) {
  for (const key of ['query', 'selected_artist', 'gallery_display_mode', 'gallery_scale_percent',
    'selection', 'navigation']) assert.deepEqual(snapshot[key], structuredClone(original[key]), `preserve ${key}`);
  const paths = [
    value => value.non_album_tracks[0],
    value => value.retained.view.non_album_tracks[0],
    value => value.retained.sections[0].tracks[0],
    value => value.retained.sections[0].track_rows[0],
    value => value.retained.sections[0].gallery_list_block.track_rows[0],
    value => value.retained.sections[0].duplicate_sources[0].tracks[0],
    value => value.alias.tracks[0],
  ];
  for (const resolve of paths) {
    const actual = resolve(snapshot), expected = resolve(original);
    for (const [key, value] of Object.entries(expected)) {
      if (!privatePreferenceKeys.has(key)) assert.deepEqual(actual[key], structuredClone(value), `preserve row ${key}`);
    }
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).filter(key => !privatePreferenceKeys.has(key)).sort(),
      'history rows contain only their existing display/navigation fields, never receipt/token properties');
  }
  assert.equal(snapshot.alias.gallery_list_block.heading, 'Loose display');
}

function captureLiveReceipt(f, payload) {
  const row = payload.non_album_tracks[0], source = f.source(row), preference = f.preference(row);
  assert.ok(source, 'setup requires a genuine admitted exact-row receipt');
  assert.equal(preference.love_tier, 'obsessed');
  assert.equal(preference.allowed_actions.can_set_love_tier, true);
  const before = structuredClone(payload), batchCount = f.batches.length, requestCount = f.requests.length;
  return () => {
    assert.equal(f.state.view, payload, 'history writing must not replace the live view');
    assert.equal(f.state.view.non_album_tracks[0], row, 'history writing must retain the exact live row');
    assert.equal(f.source(row), source, 'history writing must retain the exact genuine receipt source');
    assert.deepEqual(f.preference(row), preference, 'history writing must not change personal preference authority');
    assert.deepEqual(structuredClone(payload), before, 'history writing must leave the frozen live graph unchanged');
    assert.equal(f.batches.length, batchCount, 'history cannot mint a read batch');
    assert.equal(f.requests.length, requestCount, 'history cannot dispatch a read or preference command');
  };
}

module.exports = {
  createHistoryFixture, historyPayload, captureLiveReceipt,
  assertNoPrivatePreferenceMetadata, assertDisplayPreserved,
};
