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

// Independent authority regressions. Each case owns its Queue, native scope,
// transport promises and complete metadata population; no other test is loaded.
const ownTrack = (id, tier = 'off', editable = true) => target({
  inventory_track_ref: `inventory-track:1:${id}`, track_ref: `track:key-${id}`,
  canonical_track_ref: `track:key-${id}`, path: `/private/${id}.flac`, title: `Track ${id}`,
  track_preference: {rating: null, love_tier: tier, allowed_actions: {can_set_love_tier: editable}},
});

for (const grants of [[false, false, false], [false, true, false], [true, false, true]]) {
  test(`One Queue metadata batch retains every authoritative Love with grants ${grants.join(',')}`, async () => {
    const f = fixture(), tiers = ['loved', 'obsessed', 'off'];
    const sources = grants.map((grant, index) => f.capture(ownTrack(21 + index, tiers[index], grant)));
    const ids = await f.queue.enqueue(sources.map(source => source.capture));
    for (const phase of ['enqueue', 'refresh']) {
      if (phase === 'refresh') await f.queue.refresh();
      const rows = f.queue.getSnapshot().entries;
      assert.equal(rows.length, grants.length);
      rows.forEach((row, index) => {
        assert.equal(row.id, ids[index], `${phase}: occurrence survives`);
        assert.equal(row.sourceReadable, true);
        assert.ok(row.track_preference, `${phase}: row ${index} retains its authoritative Love`);
        assert.equal(row.track_preference.love_tier, tiers[index]);
        assert.equal(row.track_preference.allowed_actions.can_set_love_tier, grants[index]);
      });
    }
    assert.equal(f.requests.length, 0, 'read admission never mutates preferences');
  });
}

test('A mixed Queue refresh does not discard later Love when the first row loses edit permission', async () => {
  const f = fixture(), sources = [31, 32, 33].map(id => f.capture(ownTrack(id)));
  const ids = await f.queue.enqueue(sources.map(source => source.capture));
  sources[0].metadata = ownTrack(31, 'loved', false);
  sources[1].metadata = ownTrack(32, 'obsessed', true);
  sources[2].metadata = ownTrack(33, 'loved', false);
  await f.queue.refresh();
  const values = Array.from(ids, id => f.queue.trackPreference({id}, ui));
  assert.ok(values.every(Boolean), 'one denied grant must not stale unrelated rows in the same batch');
  assert.deepEqual(values.map(value => value.love_tier), ['loved', 'obsessed', 'loved']);
  assert.deepEqual(values.map(value => value.allowed_actions.can_set_love_tier), [false, true, false]);
});

test('First Queue admission rejected by a newer preference epoch cannot expose an editable raw overlay', async () => {
  const f = fixture(), source = f.capture(ownTrack(41, 'off')), read = deferred();
  source.metadata = read.promise;
  const enqueue = f.queue.enqueue([source.capture]);
  const other = ownTrack(42);
  f.actions.acceptRead(other, f.actions.readEpoch());
  const write = f.actions.setLove({source: other, love_tier: 'loved', isCurrent: () => true});
  f.acknowledge(0, 'loved'); await write;
  read.resolve(ownTrack(41, 'off'));
  const [id] = await enqueue;
  assert.equal(f.queue.getSnapshot().entries[0].sourceReadable, true);
  assert.equal(f.queue.trackPreference({id}, ui), null, 'no prior admitted authority exists to retain');
  assert.equal(f.queue.getSnapshot().entries[0].track_preference, null);
  await assert.rejects(f.queue.setTrackLove({row: {id}, love_tier: 'obsessed'}));
  assert.equal(f.requests.length, 1, 'stale first admission cannot dispatch another write');
  source.metadata = ownTrack(41, 'off');
  await f.queue.refresh();
  assert.equal(f.queue.trackPreference({id}, ui).love_tier, 'off', 'fresh admission restores known state');
});

test('Metadata-only refresh cannot admit a cached playback path as a current canonical alias', async () => {
  const f = fixture(), canonical = ownTrack(51), privatePath = '/private/reassigned.flac';
  const source = f.capture({...canonical, track_ref: null, canonical_track_ref: null, track_preference: null});
  source.play = {...canonical, track_ref: privatePath, canonical_track_ref: undefined, path: privatePath, track_preference: undefined};
  const [id] = await f.queue.enqueue([source.capture]);
  const raw = {track_ref: privatePath, track_preference: preference('off')};
  const rawIdentity = f.actions.preference(raw).identity;
  const playCalls = source.playCalls;
  source.metadata = canonical;
  await f.queue.refresh();
  assert.equal(source.playCalls, playCalls, 'read refresh does not re-resolve playback');
  const queued = f.queue.trackPreference({id}, ui);
  assert.ok(queued);
  assert.notEqual(queued.identity, rawIdentity, 'cached play target is not fresh path-to-track evidence');
  const replacement = {...ownTrack(52, 'obsessed'), track_ref: privatePath, path: privatePath};
  f.actions.acceptRead(replacement, f.actions.readEpoch());
  const replaced = f.actions.preference(replacement);
  assert.ok(replaced, 'fresh admission may establish the path actual new owner');
  assert.notEqual(replaced.identity, queued.identity);
  assert.equal(f.queue.trackPreference({id}, ui).identity, queued.identity, 'new path owner does not poison unrelated canonical Queue track');
});

test('A stale metadata denial never restores a previous editable Queue grant', async () => {
  const f = fixture(), source = f.capture(ownTrack(61)), [id] = await f.queue.enqueue([source.capture]);
  const read = deferred(); source.metadata = read.promise;
  const refresh = f.queue.refresh();
  const write = f.queue.setTrackLove({row: {id}, love_tier: 'loved'});
  f.acknowledge(0, 'loved'); await write;
  read.resolve(ownTrack(61, 'off', false)); await refresh;
  const current = f.queue.trackPreference({id}, ui);
  assert.ok(current === null || current.allowed_actions.can_set_love_tier === false);
  await assert.rejects(f.queue.setTrackLove({row: {id}, love_tier: 'obsessed'}));
  assert.equal(f.requests.length, 1);
});
