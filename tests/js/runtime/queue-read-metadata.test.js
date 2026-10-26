const nodeTest = require('node:test');
const test = (name, run) => nodeTest(name, {timeout: 2000}, run);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const preference = (love_tier = 'off') => ({rating: null, love_tier, allowed_actions: {can_set_love_tier: true}});
const target = (overrides = {}) => ({inventory_track_ref: 'inventory-track:1:11', track_ref: 'track:key-one',
  canonical_track_ref: 'track:key-one', path: '/private/one.flac', title: 'Same title', artist: 'Artist', album_title: 'Album',
  duration_seconds: 125, availability: 'local', source_readable: true,
  allowed_actions: {can_read: true, can_play: true}, playback_state: {can_start_here: true}, track_preference: preference(), ...overrides});
function fixture() {
  let media = true;
  const h = createNativeHomeRuntime(), sandbox = h.context, context = h.context;
  const shell = h.document.createElement('div'); shell.id = 'app-shell';
  Object.assign(shell.dataset, {nativeAccountId: 'actor-one', nativeLibraryId: '1', privateUiContext: 'a'.repeat(64)});
  h.document.body.appendChild(shell);
  const requests = [], starts = [];
  Object.assign(sandbox, {AbortController, AlbumHavenCapabilities: {allows: () => media},
    activateSharedTrackButton() {throw new Error('Queue fixture must use its explicit playback boundary');}, playerTrackSelectionToken: 1,
    resolveNextPlaybackContextQueue: () => null, peekNextOrdinaryQueuedTrack: () => null,
    playTrackFromPayload: async (value, options) => {
      const started = {value, options, currentAtAdmission: options.isCurrent()}; starts.push(started);
      await Promise.resolve(); started.currentBeforeCompletion = options.isCurrent(); return true;
    },
    fetch: async (url, options) => {const response = deferred(); requests.push({url, options, response}); return response.promise;}});
  // Whole initialized owners, in served order. No null engine or fake transport.
  for (const file of ['bootstrap-state.js', 'core-state-and-helpers.js', 'player-streaming-engine.js',
    'private-ui-transport.js', 'track-actions.js', 'explicit-queue-planner.js', 'explicit-queue-runtime.js']) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime', file), 'utf8'), context, {filename: file});
  }
  sandbox.getPlayerPlaybackSnapshot = sandbox.getStreamingPlaybackSnapshot;
  assert.equal(sandbox.streamingEngineState(), h.owner('state').player.streaming);
  assert.equal(sandbox.streamingEngineState().roles.current, null);
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
    replaceTransport: () => {shell.dataset.privateUiContext = 'b'.repeat(64);}, setMedia: value => {media = value;}};
}
const ui = {scopeKey: 'home:own:test'};
const abort = error => error?.name === 'AbortError';

test('Queue metadata refresh retains missing readable rows, nullable duration and Love without requesting play', async () => {
  const f = fixture(), source = f.capture(); const [id] = await f.queue.enqueue([source.capture]);
  const before = f.queue.getSnapshot(), plays = source.playCalls;
  source.metadata = target({path: undefined, availability: 'missing', duration_seconds: null,
    allowed_actions: {can_read: true, can_play: false}, playback_state: {can_start_here: false}, track_preference: preference('loved')});
  source.play = Object.assign(new Error('Media unavailable'), {status: 403});
  f.setMedia(false); await f.queue.refresh(); const after = f.queue.getSnapshot(), row = after.entries[0];
  assert.equal(source.playCalls, plays); assert.ok(source.metadataCalls >= 1);
  assert.equal(row.id, id); assert.equal(row.sourceReadable, true); assert.equal(row.canPlay, false);
  assert.equal(row.title, 'Same title'); assert.equal(row.availability, 'missing'); assert.equal(row.duration_seconds, null);
  assert.equal(row.track_preference.love_tier, 'loved'); assert.equal(after.revision, before.revision);
  assert.notEqual(after, before, 'read-only change must invalidate public snapshot');
  assert.equal(f.queue.trackPreference({id}, ui).love_tier, 'loved');
});

test('Queue DTO exposes normalized opaque preferences and no native authority', async () => {
  const f = fixture(), source = f.capture(target({track_preference: {...preference(), secret: '/private/secret'}}));
  await f.queue.enqueue([source.capture]); await f.queue.refresh();
  const row = f.queue.getSnapshot().entries[0], wire = JSON.stringify(row);
  assert.equal(row.duration_seconds, 125); assert.equal(typeof row.track_preference.identity, 'string');
  for (const forbidden of ['inventory-track:', 'track:key-one', '/private/', 'canonical_track_ref', 'inventory_track_ref',
    'source_provenance', 'resolveMetadata', 'secret']) assert.equal(wire.includes(forbidden), false, forbidden);
  assert.deepEqual(Object.keys(row.track_preference).sort(), ['allowed_actions', 'identity', 'love_tier', 'rating']);
});

test('Duplicate occurrences share Love and a pending mutation but retain independent Queue identity/order/removal', async () => {
  const f = fixture(), a = f.capture(), b = f.capture(); const ids = await f.queue.enqueue([a.capture, b.capture]);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(f.queue.trackPreference({id: ids[0]}, ui).identity, f.queue.trackPreference({id: ids[1]}, ui).identity);
  const pending = f.queue.setTrackLove({row: {id: ids[0]}, context: ui, love_tier: 'loved'});
  await assert.rejects(f.queue.setTrackLove({row: {id: ids[1]}, context: ui, love_tier: 'obsessed'}), error => error.status === 409);
  assert.equal(f.requests.length, 1); assert.equal(JSON.parse(f.requests[0].options.body).track_ref, 'track:key-one');
  f.acknowledge(0, 'loved'); await pending;
  assert.equal(f.queue.trackPreference({id: ids[1]}, ui).love_tier, 'loved');
  f.queue.reorder([...ids].reverse()); assert.deepEqual(Array.from(f.queue.getSnapshot().entries, row => row.id), [...ids].reverse());
  f.queue.remove(ids[0]); assert.deepEqual(Array.from(f.queue.getSnapshot().entries, row => row.id), [ids[1]]);
});

test('Queue unknown preference is unavailable, never invented Off', async () => {
  const f = fixture(), source = f.capture(target({track_preference: null, canonical_track_ref: null, track_ref: null}));
  const [id] = await f.queue.enqueue([source.capture]); await f.queue.refresh();
  assert.equal(f.queue.getSnapshot().entries[0].track_preference, null); assert.equal(f.queue.trackPreference({id}, ui), null);
  await assert.rejects(f.queue.setTrackLove({row: {id}, context: ui, love_tier: 'loved'})); assert.equal(f.requests.length, 0);
});

test('Metadata denial clears readable metadata and mutation authority', async () => {
  const f = fixture(), source = f.capture(); const [id] = await f.queue.enqueue([source.capture]);
  source.metadata = Object.assign(new Error('Source revoked'), {status: 403}); await f.queue.refresh();
  const row = f.queue.getSnapshot().entries[0]; assert.equal(row.sourceReadable, false); assert.equal(row.canPlay, false);
  assert.equal(row.title, 'Unavailable track'); assert.equal(row.track_preference, null);
  assert.equal(f.queue.trackPreference({id}, ui), null);
  await assert.rejects(f.queue.setTrackLove({row: {id}, context: ui, love_tier: 'loved'})); assert.equal(f.requests.length, 0);
});

test('Fresh play denial does not revoke independently readable Queue metadata', async () => {
  const f = fixture(), source = f.capture(); const [id] = await f.queue.enqueue([source.capture]);
  const plays = source.playCalls; source.play = Object.assign(new Error('Media permission denied'), {status: 403});
  await assert.rejects(f.queue.play(id)); assert.equal(source.playCalls, plays + 1); assert.equal(f.starts.length, 0);
  const row = f.queue.getSnapshot().entries[0]; assert.equal(row.sourceReadable, true); assert.equal(row.title, 'Same title');
  assert.equal(row.canPlay, false); assert.ok(f.queue.trackPreference({id}, ui));
});

for (const replacement of ['actor', 'library', 'transport', 'remove', 'source']) {
  test(`Late metadata cannot publish after ${replacement} replacement`, async () => {
    const f = fixture(), source = f.capture(), [id] = await f.queue.enqueue([source.capture]);
    const read = deferred(); source.metadata = read.promise;
    const pending = f.queue.refresh(); const outcome = pending.then(() => null, error => error);
    if (replacement === 'actor') f.shell.dataset.nativeAccountId = 'actor-two';
    if (replacement === 'library') f.shell.dataset.nativeLibraryId = '2';
    if (replacement === 'transport') f.replaceTransport();
    if (replacement === 'remove') f.queue.remove(id);
    if (replacement === 'source') source.current = false;
    read.resolve(target({title: 'Stale private title', track_preference: preference('obsessed')})); await outcome;
    assert.equal(JSON.stringify(f.queue.getSnapshot()).includes('Stale private title'), false);
    assert.equal(f.queue.trackPreference({id}, ui), null);
  });
}

test('Older Queue metadata cannot overwrite a newer confirmed Love mutation', async () => {
  const f = fixture(), source = f.capture(), [id] = await f.queue.enqueue([source.capture]);
  const read = deferred(); source.metadata = read.promise; const refresh = f.queue.refresh();
  const write = f.queue.setTrackLove({row: {id}, context: ui, love_tier: 'obsessed'});
  f.acknowledge(0, 'obsessed'); await write; read.resolve(target({track_preference: preference('off')})); await refresh;
  assert.equal(f.queue.trackPreference({id}, ui).love_tier, 'obsessed');
  assert.equal(f.queue.getSnapshot().entries[0].track_preference.love_tier, 'obsessed');
});

test('A removed occurrence cannot publish a late successful preference acknowledgement', async () => {
  const f = fixture(), source = f.capture(), [id] = await f.queue.enqueue([source.capture]);
  const write = f.queue.setTrackLove({row: {id}, context: ui, love_tier: 'loved'}); const result = assert.rejects(write, abort);
  f.queue.remove(id); f.acknowledge(0, 'loved'); await result; assert.equal(f.queue.trackPreference({id}, ui), null);
});

test('Only trusted read admission establishes aliases; matching title never merges tracks', () => {
  const f = fixture(), native = target(), alias = {...native, track_ref: native.path};
  const canonical = f.actions.preference(native), untrusted = f.actions.preference(alias);
  assert.notEqual(canonical.identity, untrusted.identity);
  f.actions.acceptRead(native, f.actions.readEpoch()); f.actions.acceptRead(alias, f.actions.readEpoch());
  assert.equal(f.actions.preference(native).identity, f.actions.preference(alias).identity);
  const other = target({inventory_track_ref: 'inventory-track:1:12', track_ref: 'track:key-two', canonical_track_ref: 'track:key-two', path: '/private/two.flac'});
  f.actions.acceptRead(other, f.actions.readEpoch()); assert.notEqual(f.actions.preference(native).identity, f.actions.preference(other).identity);
});

test('Trusted canonical aliases share pending guard and send supported canonical refs', async () => {
  const f = fixture(), native = target(), alias = {...native, track_ref: native.path};
  f.actions.acceptRead(native, f.actions.readEpoch()); f.actions.acceptRead(alias, f.actions.readEpoch());
  assert.equal(f.actions.preference(native).identity, f.actions.preference(alias).identity, 'trusted aliases must be admitted before testing pending writes');
  const first = f.actions.setLove({source: alias, love_tier: 'loved', isCurrent: () => true});
  await assert.rejects(f.actions.setLove({source: native, love_tier: 'obsessed', isCurrent: () => true}), error => error.status === 409);
  assert.equal(f.requests.length, 1); assert.equal(JSON.parse(f.requests[0].options.body).track_ref, native.canonical_track_ref);
  f.acknowledge(0, 'loved'); await first; assert.equal(f.actions.preference(native).love_tier, 'loved');
});

test('Subject taste never grants actor mutation authority', async () => {
  const f = fixture(), subject = target({read_only_subject: 'friend-one', track_preference: preference('obsessed')});
  f.actions.acceptRead(subject, f.actions.readEpoch());
  assert.equal(f.actions.preference(subject).allowed_actions.can_set_love_tier, false);
  await assert.rejects(f.actions.setLove({source: subject, love_tier: 'off', isCurrent: () => true})); assert.equal(f.requests.length, 0);
});

test('Queue explicit play performs a fresh resolution after read metadata succeeds', async () => {
  const f = fixture(), source = f.capture(), [id] = await f.queue.enqueue([source.capture]);
  await f.queue.refresh(); const plays = source.playCalls;
  source.play = target({duration_seconds: 199}); await f.queue.play(id);
  assert.equal(source.playCalls, plays + 1); assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].value.durationSeconds, 199);
  assert.equal(f.starts[0].currentAtAdmission, true); assert.equal(f.starts[0].currentBeforeCompletion, true);
  assert.equal(f.starts[0].options.isCurrent(), false, 'completed start no longer owns the pending-start authority');
});

test('Shared preference subscription updates duplicate public rows without planner edits', async () => {
  const f = fixture(), a = f.capture(), b = f.capture(), ids = await f.queue.enqueue([a.capture, b.capture]);
  const before = f.queue.getSnapshot(); let notifications = 0;
  const unsubscribe = f.queue.subscribeTrackPreferences(() => {notifications++;});
  const write = f.queue.setTrackLove({row: {id: ids[0]}, context: ui, love_tier: 'loved'});
  f.acknowledge(0, 'loved'); await write;
  const after = f.queue.getSnapshot(); assert.ok(notifications > 0); unsubscribe();
  assert.equal(after.revision, before.revision); assert.notEqual(after, before);
  assert.deepEqual(Array.from(after.entries, row => row.track_preference.love_tier), ['loved', 'loved']);
});

test('An inventory remap cannot redirect a pending native alias mutation', async () => {
  const f = fixture(), native = target(); f.actions.acceptRead(native, f.actions.readEpoch());
  const write = f.actions.setLove({source: native, love_tier: 'loved', isCurrent: () => true});
  const result = assert.rejects(write);
  const remapped = {...native, canonical_track_ref: 'track:other', track_ref: 'track:other'};
  f.actions.acceptRead(remapped, f.actions.readEpoch());
  assert.equal(JSON.parse(f.requests[0].options.body).track_ref, 'track:key-one');
  f.acknowledge(0, 'loved'); await result;
  const value = f.actions.preference(remapped);
  assert.ok(value === null || value.allowed_actions.can_set_love_tier === false, 'conflicting alias must fail closed');
});

test('Pre-mutation native read epoch cannot overwrite confirmed actor preferences through an alias', async () => {
  const f = fixture(), native = target(), alias = {...native, track_ref: native.path};
  f.actions.acceptRead(native, f.actions.readEpoch()); f.actions.acceptRead(alias, f.actions.readEpoch());
  const oldEpoch = f.actions.readEpoch();
  const write = f.actions.setLove({source: native, love_tier: 'obsessed', isCurrent: () => true});
  f.acknowledge(0, 'obsessed'); await write;
  f.actions.acceptRead({...alias, track_preference: preference('off')}, oldEpoch);
  assert.equal(f.actions.preference(alias).love_tier, 'obsessed');
});

for (const status of [401, 404, 409]) {
  test(`Metadata ${status} revokes the exact captured read authority`, async () => {
    const f = fixture(), source = f.capture(), [id] = await f.queue.enqueue([source.capture]);
    source.metadata = Object.assign(new Error('Read authority expired'), {status}); await f.queue.refresh();
    const row = f.queue.getSnapshot().entries[0]; assert.equal(row.sourceReadable, false);
    assert.equal(row.title, 'Unavailable track'); assert.equal(row.track_preference, null);
    assert.equal(f.queue.trackPreference({id}, ui), null);
  });
}

test('Fresh play 404 cannot erase an independently readable metadata projection', async () => {
  const f = fixture(), source = f.capture(), [id] = await f.queue.enqueue([source.capture]);
  source.play = Object.assign(new Error('File missing'), {status: 404}); await assert.rejects(f.queue.play(id));
  const row = f.queue.getSnapshot().entries[0]; assert.equal(row.sourceReadable, true);
  assert.equal(row.title, 'Same title'); assert.equal(row.canPlay, false); assert.ok(row.track_preference);
});
