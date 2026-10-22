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

async function load(f, key, id, options = {}) {
  const data = f.data(key, id), pending = f.read(key, options);
  f.respond(f.requests.length - 1, data); await pending;
  return data;
}
function prepare(f, data) {
  f.context.window.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: 'scope'})};
  f.context.window.AlbumHavenPlaytableUI = {mount: () => ({dispose() {}, update() {}})};
  f.native.prepare('album-tracks', data, [{tracks: [{title: 'One'}]}], data.tracks, () => true);
  assert.equal(f.native.mount('album-tracks', {querySelectorAll: () => []}), true);
}
async function newer(f, prefix, start = 100) {
  for (let offset = 0; offset < 11; offset++) await load(f, `${prefix}-${offset}`, start + offset);
}

test('Unmounted oldest receipt expires after newer Album requests exceed existing hydration retention bound', async () => {
  const f = fixture(), oldest = await load(f, 'oldest', 11);
  assert.ok(f.source(oldest.tracks[0]));
  await newer(f, 'later');
  assert.equal(f.source(oldest.tracks[0]), null, 'held DTO object cannot outlive bounded provenance');
  prepare(f, oldest);
  assert.equal(f.source(oldest.tracks[0]), null, 'preparing an evicted DTO cannot recreate provenance');
  const refreshed = await load(f, 'oldest', 11);
  assert.ok(f.source(refreshed.tracks[0]));
  assert.equal(f.source(oldest.tracks[0]), null, 'fresh read does not reauthorize evicted objects');
});

test('Active native Album survives LRU churn; retirement makes its receipt eligible for expiry', async () => {
  const f = fixture(), active = await load(f, 'active', 11);
  prepare(f, active);
  await newer(f, 'while-active');
  assert.ok(f.source(active.tracks[0]), 'an active exact source owns its receipt lifetime');
  f.native.retire('album-tracks');
  await newer(f, 'after-retire', 200);
  assert.equal(f.source(active.tracks[0]), null);
  f.native.retire('album-tracks'); // Repeated cleanup must be harmless.
});

test('Same-resource native reprepare transfers retention before releasing old ownership', async () => {
  const f = fixture(), active = await load(f, 'active', 11);
  prepare(f, active);
  await newer(f, 'before-reprepare');
  prepare(f, active);
  assert.ok(f.source(active.tracks[0]), 'replacement must not expose an unpinned eviction window');
  await newer(f, 'after-reprepare', 200);
  assert.ok(f.source(active.tracks[0]));
  f.native.retire('album-tracks');
  await newer(f, 'after-last-release', 300);
  assert.equal(f.source(active.tracks[0]), null, 'reprepare must not leak a retained reference');
});

for (const options of [{readOnlySubject: true}, {admitPreferences: false}]) {
  test(`Non-Album consumer requests cannot displace own receipt retention ${JSON.stringify(options)}`, async () => {
    const f = fixture(), own = await load(f, 'own', 11);
    for (let offset = 0; offset < 15; offset++) {
      const foreign = await load(f, `other-${offset}`, 100 + offset, options);
      assert.equal(f.source(foreign.tracks[0]), null);
    }
    assert.ok(f.source(own.tracks[0]), 'subject/Queue reads are not Album UI LRU admissions');
  });
}
