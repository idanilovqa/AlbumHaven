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
    albumRequiresHydration: value => value?.needsHydration === true,
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

for (const denial of [{source_readable: false}, {allowed_actions: {can_read: false}}]) {
  test(`Denied duplicate container excludes its raw/shared/gallery rows and descendants ${JSON.stringify(denial)}`, async () => {
    const f = fixture(), data = f.data();
    const denied = {...f.data('duplicate', 12), ...denial};
    denied.track_rows = f.data('duplicate', 13).tracks;
    denied.gallery_list_block = {track_rows: f.data('duplicate', 14).tracks};
    denied.duplicate_sources = [f.data('nested', 15)];
    data.duplicate_sources = [denied, f.data('readable-sibling', 16)];
    const pending = f.read(); f.respond(0, data); await pending;
    assert.ok(f.source(data.tracks[0]));
    assert.ok(f.source(data.duplicate_sources[1].tracks[0]), 'denial stays bounded to its container');
    for (const row of [denied.tracks[0], denied.track_rows[0], denied.gallery_list_block.track_rows[0],
      denied.duplicate_sources[0].tracks[0]]) {
      assert.equal(f.source(row), null, 'a granting child row cannot override an unreadable source container');
    }
  });
}
