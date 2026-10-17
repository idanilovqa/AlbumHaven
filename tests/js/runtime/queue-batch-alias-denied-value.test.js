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

test('Batch alias merge preserves known denied Love when an older raw record survives', async () => {
  const f = fixture(), privatePath = '/private/older-alias.flac';
  // Opening a legacy surface may create its opaque raw identity before native
  // Queue metadata has established the canonical mapping.
  const raw = {track_ref: privatePath, track_preference: preference('off')};
  f.actions.preference(raw);
  const denied = f.capture(target({track_preference: {
    rating: 4, love_tier: 'loved', allowed_actions: {can_set_love_tier: false},
  }}));
  const sibling = f.capture(target({track_preference: preference('off')}));
  sibling.play = target({track_ref: privatePath, canonical_track_ref: undefined, path: privatePath});
  const ids = await f.queue.enqueue([denied.capture, sibling.capture]);
  const first = f.queue.trackPreference({id: ids[0]}, ui), second = f.queue.trackPreference({id: ids[1]}, ui);
  assert.ok(first); assert.ok(second);
  assert.equal(first.identity, second.identity);
  for (const value of [first, second]) {
    assert.equal(value.allowed_actions.can_set_love_tier, false);
    assert.equal(value.love_tier, 'loved', 'absorbing an identity must retain its authoritative denied tier');
    assert.equal(value.rating, 4, 'read-only personal rating belongs to the same preserved overlay');
  }
  await assert.rejects(f.queue.setTrackLove({row: {id: ids[1]}, love_tier: 'obsessed'}));
  assert.equal(f.requests.length, 0);
});
