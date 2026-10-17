// Per-Album request provenance revocation, independent of global preference grants.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const outcome = promise => promise.then(value => ({value}), error => ({error}));
function fixture() {
  const requests = [], state = {view: {}, ui: {}, player: {}, status: {inventory_mutation_revision: 1}};
  const shell = {dataset: {nativeAccountId: '7', nativeLibraryId: '9'}};
  const context = vm.createContext({state, window: {addEventListener() {}, removeEventListener() {}},
    document: {getElementById: id => id === 'app-shell' ? shell : null}, PrivateUITransport: {generation: () => 1},
    albumRequiresHydration: () => false,
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({url, options, resolve, reject}))});
  for (const file of ['track-actions.js', 'track-modal-lightbox-helpers.js', 'playtable-source.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file});
  }
  const runtime = vm.runInContext('TrackActionsRuntime', context), native = vm.runInContext('NativePlaytables', context);
  const source = row => context.getTrackModalPreferenceSource(row);
  const read = (key = 'album-one', options = {}) => outcome(context.fetchTrackModalAlbumDetails(key, {isCurrent: () => true, ...options}));
  const respond = (index, data, status = 200) => requests[index].resolve({ok: status === 200, status,
    json: async () => ({ok: status === 200, album: data})});
  const data = (key = 'album-one', id = 11) => ({key, tracks: [{track_ref: `/synthetic/${id}.flac`,
    canonical_track_ref: `track:${id}`, inventory_track_ref: `inventory-track:9:${id}`,
    track_preference_state: 'available', track_preference: {rating: null, love_tier: 'off',
      allowed_actions: {can_set_love_tier: true}}, source_readable: true, allowed_actions: {can_read: true}}]});
  async function load(value = data()) {const pending = read(value.key); respond(requests.length - 1, value); await pending; return value;}
  function mount(value) {
    let options;
    context.window.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: 'scope'})};
    context.window.AlbumHavenPlaytableUI = {mount: (_host, supplied) => {options = supplied;
      return {dispose() {}, update() {}};}};
    native.prepare('album-tracks', value, [{tracks: [{title: 'One'}]}], value.tracks, () => true);
    native.mount('album-tracks', {querySelectorAll: () => []});
    return options.trackPreferences;
  }
  return {context, requests, runtime, source, read, respond, data, load, mount};
}

for (const status of [401, 403]) {
  test(`HTTP ${status} revokes same-Album receipt and native write while unrelated Album survives`, async () => {
    const f = fixture(), one = await f.load(), other = await f.load(f.data('album-two', 12));
    const normalized = f.source(one.tracks[0]), prefs = f.mount(one);
    let notifications = 0;
    const unsubscribe = prefs.runtime.subscribeTrackPreferences(() => {notifications++;});
    const pending = f.read(); f.respond(2, null, status); assert.ok((await pending).error);
    assert.equal(f.source(one.tracks[0]), null);
    assert.ok(f.source(other.tracks[0]), 'Album denial is bounded to the denied source');
    assert.equal(f.runtime.preference(normalized).allowed_actions.can_set_love_tier, true,
      'Album source loss does not manufacture a cross-surface preference denial');
    assert.equal(prefs.runtime.trackPreference(prefs.rows[0], prefs.context), null);
    const result = await outcome(prefs.runtime.setTrackLove({row: prefs.rows[0], context: prefs.context, love_tier: 'loved'}));
    assert.ok(result.error);
    assert.equal(f.requests.length, 3, 'revoked native owner cannot dispatch Love');
    assert.ok(notifications > 0, 'mounted Love must repaint immediately on source denial');
    unsubscribe();
  });
}

test('Pending pre-denial response cannot acquire a token from a later successful request', async () => {
  const f = fixture(), original = await f.load();
  const earlier = f.read(), denied = f.read();
  f.respond(2, null, 403); await denied;
  assert.equal(f.source(original.tracks[0]), null);
  const fresh = await f.load();
  assert.ok(f.source(fresh.tracks[0]), 'a new guarded request after denial can restore this Album');
  const stale = f.data(); f.respond(1, stale); await earlier;
  assert.equal(f.source(stale.tracks[0]), null, 'dispatch-time provenance token cannot be upgraded at response');
  assert.ok(f.source(fresh.tracks[0]));
  assert.equal(f.source(original.tracks[0]), null, 'new receipt never retroactively blesses old cached objects');
});

for (const mode of ['network', 'server']) {
  test(`${mode} failure preserves an otherwise unchanged valid Album receipt`, async () => {
    const f = fixture(), original = await f.load(), source = f.source(original.tracks[0]);
    const pending = f.read();
    if (mode === 'network') f.requests[1].reject(new Error('Network unavailable'));
    else f.respond(1, null, 500);
    assert.ok((await pending).error);
    assert.equal(f.source(original.tracks[0]), source);
    assert.equal(f.runtime.preference(source).allowed_actions.can_set_love_tier, true);
  });
}

test('A post-denial read whose caller is superseded cannot restore source authority', async () => {
  const f = fixture(), original = await f.load();
  const denied = f.read(); f.respond(1, null, 403); await denied;
  let current = true;
  const pending = f.read('album-one', {isCurrent: () => current}); current = false;
  const stale = f.data(); f.respond(2, stale); await pending;
  assert.equal(f.source(stale.tracks[0]), null);
  assert.equal(f.source(original.tracks[0]), null);
});
