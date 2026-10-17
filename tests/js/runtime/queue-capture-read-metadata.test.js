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
async function activityFixture() {
  const h = setup('home'), calls = [];
  const context = {scopeKey: h.bridge.snapshot().scopeKey, account_ref: friend, kind: 'tracks', period: 'week'};
  const row = {id: 'activity_' + 'b'.repeat(64), kind: 'track', title: 'Captured title', artist: 'Artist',
    availability: 'local', source_readable: true, inventory_track_ref: inventory,
    track_preference: {rating: 1, love_tier: 'obsessed', allowed_actions: {can_set_love_tier: false}},
    allowed_actions: {can_resolve_native_play: true}};
  let receipt = 'B'.repeat(43), native = target();
  const provider = {readActivity: async () => ({snapshot_ref: receipt, rows: [row]}),
    resolveActivityNativeTarget: async options => {calls.push(options); return typeof native === 'function' ? native(options) : native;}};
  const read = h.bridge.configureActivityProvider(provider), data = await read(context);
  const source = h.bridge.createPlaytableSource({rows: data.rows, context, instance: data, revision: data, isCurrent: () => true});
  return {...h, calls, context, row, read, source, capture: source.captureQueueRows(data.rows)[0],
    replaceReceipt: value => {receipt = value;}, native: value => {native = value;}};
}
test('Activity metadata uses captured receipt after current source changes, never friend taste', async () => {
  const h = await activityFixture();
  assert.equal(typeof h.capture.resolveMetadata, 'function');
  h.replaceReceipt('C'.repeat(43)); await h.read(h.context);
  const value = await h.capture.resolveMetadata();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].intent, 'metadata');
  assert.equal(h.calls[0].snapshot_ref, 'B'.repeat(43)); assert.equal(h.calls[0].account_ref, friend);
  assert.equal(h.calls[0].rowId, h.row.id);
  assert.equal(value.track_preference.love_tier, 'loved');
  assert.equal(value.track_preference.rating, 4);
  assert.equal(value.duration_seconds, null); assert.equal(value.availability, 'missing');
  assert.equal(value.playback_state.can_start_here, false);
});
test('Activity capture cannot redirect established inventory across metadata and play', async () => {
  for (const first of ['resolve', 'resolveMetadata']) {
    const h = await activityFixture();
    if (first === 'resolve') h.native(target({availability: 'local', playback_state: {can_start_here: true}}));
    await h.capture[first](); h.native(target({inventory_track_ref: 'inventory-track:73:902'}));
    await assert.rejects(h.capture.resolveMetadata()); await assert.rejects(h.capture.resolve());
  }
});
test('Activity metadata completion rejects friend revocation, actor/library replacement and abort', async () => {
  for (const change of ['friend', 'actor', 'library', 'transport', 'abort']) {
    const h = await activityFixture(), pending = deferred(), controller = new AbortController();
    h.native(() => pending.promise);
    const result = h.capture.resolveMetadata({signal: controller.signal});
    if (change === 'friend') h.bridge.retireFriendActivity({scopeKey: h.context.scopeKey, friends: {status: 'denied'}});
    if (change === 'actor') h.shell.dataset.nativeAccountId = '42';
    if (change === 'library') h.shell.dataset.nativeLibraryId = '74';
    if (change === 'transport') h.shell.dataset.privateUiContext = 'd'.repeat(64);
    if (change === 'abort') controller.abort();
    pending.resolve(target()); await assert.rejects(result, {name: 'AbortError'});
  }
});
function playlistFixture() {
  const row = {playlist_item_id: 'item:one', inventory_track_ref: inventory, title: 'Song', artist: 'Artist',
    source_readable: true, availability: 'local', allowed_actions: {can_play: true}};
  const data = {context_ref: stamp, surface: {active: 'playlists'},
    playlist_sidebar: {active_playlist_id: 'playlist:one', items: []},
    playlist_detail: {playlist_id: 'playlist:one', revision: '7', title: 'Playlist', allowed_actions: {can_play: true}, track_rows: [row]}};
  const h = setup('playlists', data), shell = h.bridge.snapshot();
  const source = h.bridge.createPlaytableSource({rows: [row], context: {scopeKey: shell.scopeKey, playlist_id: shell.playlistId},
    instance: data, revision: '7', isCurrent: () => true});
  const calls = []; let reply = {}, currentTarget = target();
  h.context.fetch = async url => {calls.push(url); return response({status: 'ready', data: {
    playlist_id: 'playlist:one', playlist_item_id: 'item:one', revision: '7', intent: 'metadata', native_target: currentTarget, ...reply}});};
  return {...h, calls, source, capture: source.captureQueueRows([row])[0],
    reply: value => {reply = value;}, target: value => {currentTarget = value;}};
}
test('Playlist metadata retains missing readable rows with unknown length and uses metadata endpoint', async () => {
  const h = playlistFixture(); assert.equal(typeof h.capture.resolveMetadata, 'function');
  const value = await h.capture.resolveMetadata();
  assert.deepEqual(h.calls, ['/playlists/playlist%3Aone/items/item%3Aone/native-target?intent=metadata']);
  assert.equal(value.availability, 'missing'); assert.equal(value.duration_seconds, null);
  assert.equal(value.playback_state.can_start_here, false);
  assert.equal(value.track_preference.love_tier, 'loved');
});
test('Playlist metadata rejects changed receipt shape, membership, revision and inventory identity', async () => {
  for (const patch of [{revision: '8'}, {revision: 7}, {playlist_id: 'playlist:two'},
    {playlist_item_id: 'item:two'}, {intent: 'play'}, {native_target: null}]) {
    const h = playlistFixture(); h.reply(patch); await assert.rejects(h.capture.resolveMetadata());
  }
  const h = playlistFixture(); await h.capture.resolveMetadata();
  h.target(target({inventory_track_ref: 'inventory-track:73:902'}));
  await assert.rejects(h.capture.resolveMetadata());
});
test('Playlist metadata completion rejects actor/library/transport replacement and cancellation', async () => {
  for (const change of ['actor', 'library', 'transport', 'abort']) {
    const h = playlistFixture(), wait = deferred(), controller = new AbortController();
    h.context.fetch = () => wait.promise;
    const result = h.capture.resolveMetadata({signal: controller.signal});
    if (change === 'actor') h.shell.dataset.nativeAccountId = '42';
    if (change === 'library') h.shell.dataset.nativeLibraryId = '74';
    if (change === 'transport') h.shell.dataset.privateUiContext = 'c'.repeat(64);
    if (change === 'abort') controller.abort();
    wait.resolve(response({status: 'ready', data: {playlist_id: 'playlist:one', playlist_item_id: 'item:one',
      revision: '7', intent: 'metadata', native_target: target()}}));
    await assert.rejects(result, {name: 'AbortError'});
  }
});
test('Activity provider metadata preserves exact existing request shape and validates echoed receipt', async () => {
  const {createHomeBackendProviders} = await import('../../../music_app/static/js/home-friends/backend-providers.mjs');
  const options = {scopeKey: 'scope:one', account_ref: friend, kind: 'tracks', period: 'week',
    snapshot_ref: 'B'.repeat(43), rowId: 'activity_' + 'b'.repeat(64), intent: 'metadata'};
  let patch = {}, body;
  const transport = {context: () => stamp, request: async (url, request) => {
    assert.equal(url, '/home/activity/native-target'); assert.equal(request.method, 'POST');
    body = request.body;
    return {status: 'ready', data: {...body, native_target: target(), ...patch}};
  }};
  const provider = createHomeBackendProviders(transport);
  assert.equal((await provider.resolveActivityNativeTarget(options)).duration_seconds, null);
  assert.deepEqual(Object.keys(body).sort(), ['intent', 'origin', 'row_ref']);
  assert.deepEqual(plain(body.origin), {audience: 'friend', subject_ref: friend, kind: 'tracks', period: 'week', snapshot_ref: options.snapshot_ref});
  for (const change of [{row_ref: 'other'}, {intent: 'play'}, {origin: {...body.origin, snapshot_ref: 'C'.repeat(43)}},
    {origin: {...body.origin, extra: true}}]) {
    patch = change; await assert.rejects(provider.resolveActivityNativeTarget(options));
  }
});
