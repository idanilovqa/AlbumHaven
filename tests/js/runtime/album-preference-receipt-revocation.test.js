// Additive source units for reviewed Album admission/revocation contracts.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const outcome = promise => promise.then(value => ({value}), error => ({error}));
function fixture() {
  const requests = [], shell = {dataset: {nativeAccountId: '7', nativeLibraryId: '9'}};
  const state = {view: {}, ui: {}, player: {}, status: {inventory_mutation_revision: 1}};
  const context = vm.createContext({state, window: {addEventListener() {}, removeEventListener() {}},
    document: {getElementById: id => id === 'app-shell' ? shell : null},
    PrivateUITransport: {generation: () => 1},
    fetch: (url, options) => new Promise(resolve => requests.push({url, options, resolve}))});
  for (const file of ['track-actions.js', 'track-modal-lightbox-helpers.js', 'playtable-source.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file});
  }
  const runtime = vm.runInContext('TrackActionsRuntime', context), native = vm.runInContext('NativePlaytables', context);
  const source = row => context.getTrackModalPreferenceSource(row);
  const read = (key = 'album-one', options = {}) => outcome(context.fetchTrackModalAlbumDetails(key, options));
  const respond = (index, data, status = 200) => requests[index].resolve({ok: status === 200, status,
    json: async () => ({ok: status === 200, album: data})});
  const data = (key = 'album-one', id = 11) => ({key, tracks: [{track_ref: `/synthetic/${id}.flac`,
    canonical_track_ref: `track:${id}`, inventory_track_ref: `inventory-track:9:${id}`,
    track_preference_state: 'available', track_preference: {rating: null, love_tier: 'off',
      allowed_actions: {can_set_love_tier: true}}, source_readable: true, allowed_actions: {can_read: true}}]});
  return {context, state, requests, runtime, native, source, read, respond, data};
}

test('Wrong Album response identity cannot mint private preference provenance', async () => {
  const f = fixture(), pending = f.read(), data = f.data('another-album');
  f.respond(0, data); await pending;
  assert.equal(f.source(data.tracks[0]), null);
});

test('Incomplete Album hydration cannot mint private preference provenance', async () => {
  const f = fixture(), pending = f.read(), data = {...f.data(), preview_only: true};
  f.respond(0, data); await pending;
  assert.equal(f.source(data.tracks[0]), null);
});

for (const throws of [false, true]) {
  test(`Revoked caller guard${throws ? ' throwing' : ''} prevents response admission`, async () => {
    const f = fixture(); let current = true;
    const pending = f.read('album-one', {isCurrent: () => {
      if (!current && throws) throw new Error('Retired source'); return current;
    }});
    current = false;
    const data = f.data(); f.respond(0, data); await pending;
    assert.equal(f.source(data.tracks[0]), null);
  });
}

test('An admitted exact row loses provenance when inventory revision advances', async () => {
  const f = fixture(), pending = f.read(), data = f.data(); f.respond(0, data); await pending;
  assert.ok(f.source(data.tracks[0]));
  f.state.status.inventory_mutation_revision++;
  assert.equal(f.source(data.tracks[0]), null);
});

for (const denial of ['source_readable', 'can_read']) {
  test(`Mounted native Album ${denial} revocation disables projection and dispatch`, async () => {
    const f = fixture(), pending = f.read(), data = f.data(); f.respond(0, data); await pending;
    let mount;
    f.context.window.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: 'scope'})};
    f.context.window.AlbumHavenPlaytableUI = {mount: (_host, options) => {mount = options;
      return {dispose() {}, update() {}};}};
    f.native.prepare('album-tracks', data, [{tracks: [{title: 'One'}]}], data.tracks, () => true);
    f.native.mount('album-tracks', {querySelectorAll: () => []});
    const prefs = mount.trackPreferences, row = prefs.rows[0];
    assert.equal(prefs.runtime.trackPreference(row, prefs.context).allowed_actions.can_set_love_tier, true);
    if (denial === 'source_readable') data.source_readable = false;
    else data.allowed_actions = {can_read: false};
    assert.equal(prefs.runtime.trackPreference(row, prefs.context), null);
    const result = await outcome(prefs.runtime.setTrackLove({row, context: prefs.context, love_tier: 'loved'}));
    assert.ok(result.error);
    assert.equal(f.requests.length, 1, 'revoked Album must not dispatch a write');
  });
}

test('Declared Album track-count mismatch cannot mint private preference provenance', async () => {
  const f = fixture(), pending = f.read(), data = {...f.data(), track_count: 2};
  assert.equal(data.tracks.length, 1, 'fixture supplies incomplete production Album membership');
  f.respond(0, data); await pending;
  assert.equal(f.source(data.tracks[0]), null);
});
