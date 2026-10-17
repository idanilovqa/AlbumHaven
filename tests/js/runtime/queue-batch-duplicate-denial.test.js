const nodeTest = require('node:test');
const test = (name, run) => nodeTest(name, {timeout: 2000}, run);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const preference = (love_tier = 'off') => ({rating: null, love_tier, allowed_actions: {can_set_love_tier: true}});
const target = (overrides = {}) => ({inventory_track_ref: 'inventory-track:1:11', track_ref: 'track:key-one',
  canonical_track_ref: 'track:key-one', path: '/private/one.flac', title: 'Same title', artist: 'Artist', album_title: 'Album',
  duration_seconds: 125, availability: 'local', source_readable: true,
  allowed_actions: {can_read: true, can_play: true}, playback_state: {can_start_here: true}, track_preference: preference(), ...overrides});
function fixture() {
  let generation = 1, media = true;
  const shell = {dataset: {nativeAccountId: 'actor-one', nativeLibraryId: '1'}}, requests = [], starts = [];
  const state = {player: {current: null, playbackQueue: null, loopActive: false}};
  const sandbox = {console, AbortController, Promise, Map, Set, WeakMap, Object, JSON, Math, state,
    document: {getElementById: () => shell}, window: {AlbumHavenCapabilities: {allows: () => media}},
    PrivateUITransport: {generation: () => generation, subscribe: () => () => {}},
    activateSharedTrackButton() {}, playerTrackSelectionToken: 1,
    getPlayerPlaybackSnapshot: () => ({}), streamingEngineState: () => null,
    resolveNextPlaybackContextQueue: () => null, peekNextOrdinaryQueuedTrack: () => null,
    playTrackFromPayload: async (value, options) => {starts.push({value, options}); return true;},
    fetch: async (url, options) => {const response = deferred(); requests.push({url, options, response}); return response.promise;}};
  const context = vm.createContext(sandbox);
  for (const file of ['track-actions.js', 'explicit-queue-planner.js', 'explicit-queue-runtime.js']) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime', file), 'utf8'), context, {filename: file});
  }
  const actions = vm.runInContext('TrackActionsRuntime', context), queue = sandbox.window.AlbumHavenExplicitQueue;
  for (const method of ['acceptRead', 'preference', 'setLove', 'readEpoch']) assert.equal(typeof actions[method], 'function', method);
  function capture(initial = target()) {
    const value = {metadata: initial, play: initial, current: true, metadataCalls: 0, playCalls: 0};
    value.capture = {display: {title: initial.title, artist: initial.artist, album: initial.album_title}, isCurrent: () => value.current,
      async resolveMetadata() {value.metadataCalls++; if (value.metadata instanceof Error) throw value.metadata; return value.metadata;},
      async resolve() {value.playCalls++; if (value.play instanceof Error) throw value.play; return value.play;}};
    return value;
  }
  const acknowledge = (index, tier) => {
    const request = requests[index], body = JSON.parse(request.options.body);
    request.response.resolve({ok: true, json: async () => ({ok: true, actor_id: shell.dataset.nativeAccountId,
      library_id: shell.dataset.nativeLibraryId, track_ref: body.track_ref, track_preference: preference(tier)})});
  };
  return {queue, actions, capture, requests, starts, acknowledge, shell, context,
    replaceTransport: () => {generation++;}, setMedia: value => {media = value;}};
}
const ui = {scopeKey: 'home:own:test'};

// Concurrent source reads have no shared server preference revision. A denial
// observed in a batch therefore cannot be superseded by its sibling old read.
for (const grants of [[false, true], [true, false]]) {
  test(`Canonical denial dominates duplicate Queue batch grants ${grants.join(',')}`, async () => {
    const f = fixture();
    const sources = grants.map(editable => f.capture(target({track_preference: {
      rating: null, love_tier: 'loved', allowed_actions: {can_set_love_tier: editable},
    }})));
    const ids = await f.queue.enqueue(sources.map(source => source.capture));
    assert.notEqual(ids[0], ids[1]);
    const values = Array.from(ids, id => f.queue.trackPreference({id}, ui));
    assert.ok(values.every(Boolean), 'known readable Love remains visible');
    assert.equal(values[0].identity, values[1].identity, 'both occurrences retain one canonical preference owner');
    for (const value of values) {
      assert.equal(value.love_tier, 'loved');
      assert.equal(value.allowed_actions.can_set_love_tier, false, 'a sibling pre-denial read cannot regrant');
    }
    for (const id of ids) await assert.rejects(f.queue.setTrackLove({row: {id}, love_tier: 'obsessed'}));
    assert.equal(f.requests.length, 0);
    for (const source of sources) source.metadata = target({track_preference: preference('loved')});
    await f.queue.refresh();
    for (const id of ids) assert.equal(f.queue.trackPreference({id}, ui).allowed_actions.can_set_love_tier, true,
      'a later freshly begun metadata batch may establish a genuine regrant');
  });
}
