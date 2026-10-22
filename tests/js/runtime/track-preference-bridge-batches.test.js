// Whole native bridge units. No browser, HTTP server, database or scheduler proof.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const root = path.resolve(__dirname, '../../../music_app/static/js');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const stamp = 'a'.repeat(64);
const friend = '00000000-0000-4000-8000-000000000001';
const inventory = 'inventory-track:73:901';
const target = (patch = {}) => ({inventory_track_ref: inventory, track_ref: 'synthetic-track-901',
  canonical_track_ref: 'synthetic-track-901', title: 'Current title', artist: 'Artist', album_title: 'Album',
  duration_seconds: null, source_readable: true, availability: 'missing',
  allowed_actions: {can_read: true, can_play: false}, playback_state: {can_start_here: false},
  track_preference: {rating: 4, love_tier: 'loved', allowed_actions: {can_set_love_tier: true}}, ...patch});
const response = data => ({ok: true, status: 200, json: async () => ({context_ref: stamp, ...data})});
function setup(kind, data) {
  const h = createNativeHomeRuntime(), {context, document} = h;
  const add = id => {const node = document.createElement('div'); node.id = id; document.body.appendChild(node); return node;};
  const shell = add('app-shell'); add('mobile-home'); add('playlists-root'); add('shell-main-surface');
  Object.assign(shell.dataset, {nativeAccountId: '41', nativeLibraryId: '73', privateUiContext: stamp});
  const state = {view: data || {context_ref: stamp, recent_local_albums: [], recent_not_local_albums: []}, ui: {}, player: {}};
  Object.assign(context, {state, URL, URLSearchParams, AbortController,
    location: new URL(`https://albumhaven.test/?surface=${kind}`), history: {state: {}},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    MutationObserver: class {observe() {}}, shouldShowMobileHome: () => !shell.hidden,
    fetch: async () => {throw new Error('Unexpected transport request');},
    AlbumHavenCapabilities: {allows: () => true}, escapeHtml: String});
  for (const name of ['private-ui-transport.js', 'track-actions.js', 'resource-selection.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'runtime', name), 'utf8'), context, {filename: name});
  }
  context.createPrivatePlaytableSource = options => options;
  const filename = kind === 'home' ? 'home-friends-bridge.js' : 'playlists-react-bridge.js';
  vm.runInContext(fs.readFileSync(path.join(root, 'runtime', filename), 'utf8'), context, {filename});
  return {...h, shell, state, bridge: kind === 'home' ? context.AlbumHavenHomeRuntime : context.AlbumHavenPlaylistRuntime};
}

const overlay = (tier, editable) => ({rating: null, love_tier: tier, allowed_actions: {can_set_love_tier: editable}});
const nativeRow = (id, tier = 'off', editable = true, canonical = id) => ({
  row_id: `row:${id}`, actor_id: '41', library_id: '73',
  inventory_track_ref: `inventory-track:73:${canonical}`, track_ref: `track:key-${canonical}`,
  canonical_track_ref: `track:key-${canonical}`, path: `/private/${canonical}.flac`, title: `Track ${id}`,
  artist: 'Artist', album_title: 'Album', duration_seconds: 140, source_readable: true,
  availability: 'local', allowed_actions: {can_read: true, can_play: true},
  playback_state: {can_start_here: true}, track_preference: overlay(tier, editable),
});
const playlistId = '00000000-0000-4000-8000-000000000031';
const playlistData = rows => ({context_ref: stamp, surface: {active: 'playlists'},
  playlist_sidebar: {active_playlist_id: playlistId, items: [{playlist_id: playlistId, title: 'Owned', allowed_actions: {can_open: true}}]},
  playlist_detail: {playlist_id: playlistId, revision: '1', title: 'Owned', allowed_actions: {can_play: true},
    track_rows: rows.map((row, index) => ({...row, playlist_item_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, playlist_position: index + 1}))},
});

function bridgeFixture(kind, initial) {
  let rows = initial;
  const h = setup(kind, kind === 'playlists' ? playlistData(rows) : undefined);
  const scopeKey = h.bridge.snapshot().scopeKey;
  if (kind === 'home') {
    const query = {scopeKey, account_ref: null, kind: 'tracks', period: 'week'};
    const read = h.bridge.configureActivityProvider({
      readActivity: async () => ({rows: rows.map(row => ({id: row.row_id, kind: 'track', title: row.title,
        source_readable: true, allowed_actions: {can_resolve_native_play: true}}))}),
      resolveActivityTrack: ({rowId}) => rows.find(row => row.row_id === rowId),
    });
    return {set: value => {rows = value;}, read: async () => (await read(query)).rows};
  }
  h.context.fetch = async () => response(playlistData(rows));
  return {set: value => {rows = value;}, read: async () =>
    (await h.bridge.readPlaylists({scopeKey, playlist_id: playlistId})).playlist_detail.track_rows};
}

for (const kind of ['home', 'playlists']) {
  test(`${kind} native bridge admits every fresh row after a sibling becomes read-only`, async () => {
    const fixture = bridgeFixture(kind, [nativeRow(901), nativeRow(902), nativeRow(903)]);
    const initial = await fixture.read();
    assert.deepEqual(Array.from(initial, row => row.track_preference.love_tier), ['off', 'off', 'off']);
    fixture.set([nativeRow(901, 'loved', false), nativeRow(902, 'obsessed', true), nativeRow(903, 'loved', false)]);
    const fresh = await fixture.read();
    assert.deepEqual(Array.from(fresh, row => row.track_preference.love_tier), ['loved', 'obsessed', 'loved']);
    assert.deepEqual(Array.from(fresh, row => row.track_preference.allowed_actions.can_set_love_tier), [false, true, false]);
  });

  for (const grants of [[false, true], [true, false]]) {
    test(`${kind} final public duplicate projection respects same-batch denial ${grants.join(',')}`, async () => {
      const fixture = bridgeFixture(kind, [nativeRow(911, 'loved', true, 911), nativeRow(912, 'loved', true, 911)]);
      await fixture.read();
      fixture.set(grants.map((grant, index) => nativeRow(911 + index, 'loved', grant, 911)));
      const rows = await fixture.read(), preferences = Array.from(rows, row => row.track_preference);
      assert.ok(preferences.every(Boolean));
      assert.equal(preferences[0].identity, preferences[1].identity);
      assert.deepEqual(preferences.map(value => value.allowed_actions.can_set_love_tier), [false, false],
        'public cells are projected only after the full batch authority is known');
      fixture.set([nativeRow(911, 'loved', true, 911), nativeRow(912, 'loved', true, 911)]);
      const granted = await fixture.read();
      assert.deepEqual(Array.from(granted, row => row.track_preference.allowed_actions.can_set_love_tier), [true, true]);
    });
  }
}
