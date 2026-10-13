// R1: unresolved preference metadata is unknown, not a path-only read-only Off
// denial. Actual Loose capture and Queue batch owners; synthetic transport only.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const {createLooseAuthorityFixture, looseRow, browsePayload, overlay, outcome} = require('./loose-authority-harness.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const f = createLooseAuthorityFixture();
  f.state.player = {current: null, playbackQueue: null, loopActive: false};
  Object.assign(f.context, {playerTrackSelectionToken: 1,
    activateSharedTrackButton() {assert.fail('Queue metadata cannot activate playback');},
    getPlayerPlaybackSnapshot: () => ({}), streamingEngineState: () => null,
    resolveNextPlaybackContextQueue: () => null, peekNextOrdinaryQueuedTrack: () => null,
    playTrackFromPayload: async () => {assert.fail('Queue metadata cannot start playback');},
    buildApiUrl: (_view, options) => {assert.equal(options.payloadTier, 'full'); return '/view-data?surface=albums&payload_tier=full';},
  });
  f.context.window.AlbumHavenCapabilities = {allows: () => true};
  f.actionContext.activateSharedTrackButton = f.context.activateSharedTrackButton;
  for (const file of ['explicit-queue-planner.js', 'explicit-queue-runtime.js', 'explicit-queue-sources.js']) f.loadRuntime(file);
  return {...f, queue: f.context.window.AlbumHavenExplicitQueue};
}
const unknownRow = (id, patch = {}) => looseRow(id, {availability: 'local', duration_seconds: 193,
  canonical_track_ref: null, inventory_track_ref: null, track_preference_state: 'unavailable',
  track_preference: overlay('off', false), ...patch});
async function admitAlbum(f, row) {
  const index = f.requests.length, pending = f.context.fetchTrackModalAlbumDetails('known-alias-album');
  f.respond(index, {ok: true, album: {key: 'known-alias-album', tracks: [row]}}); await pending;
  assert.equal(f.preference(row).love_tier, 'obsessed');
  assert.equal(f.preference(row).allowed_actions.can_set_love_tier, true);
}
async function enqueue(f, rows) {
  const captures = f.context.captureNativeLooseQueueSources(browsePayload(rows), rows);
  const index = f.requests.length, pending = outcome(f.queue.enqueue(captures));
  assert.equal(f.requests.length, index + 1); f.respond(index, browsePayload(rows)); await turn();
  assert.equal(f.requests.length, index + 2, 'existing Queue owner separately revalidates playback');
  f.respond(index + 1, browsePayload(rows)); const result = await pending;
  assert.ifError(result.error); return result.value;
}

for (const [label, make] of [
  ['unavailable neutral path-only', () => unknownRow(401)],
  ['available missing canonical', () => unknownRow(401, {track_preference_state: 'available', inventory_track_ref: 'inventory-track:9:401'})],
  ['available missing inventory', () => unknownRow(401, {track_preference_state: 'available', canonical_track_ref: 'track:loose-authority-401'})],
  ['missing availability proof', () => {const row = looseRow(401, {availability: 'local', track_preference: overlay('off', false)});
    delete row.track_preference_state; return row;}],
]) {
  test(`${label} Queue metadata stays unknown and does not deny a genuine known alias`, async () => {
    const f = fixture(), known = looseRow(401, {track_preference: overlay('obsessed')});
    await admitAlbum(f, known);
    const row = make(), original = plain(row), before = f.batches.length, epoch = f.runtime.readEpoch();
    const [id] = await enqueue(f, [row]);
    const [entry] = f.queue.getSnapshot().entries;
    assert.equal(entry.id, id); assert.equal(entry.title, row.title); assert.equal(entry.duration_seconds, row.duration_seconds);
    assert.equal(entry.availability, 'local'); assert.equal(entry.sourceReadable, true);
    assert.equal(entry.track_preference, null, 'unproven receipt metadata must never display known Off');
    assert.equal(f.queue.trackPreference({id}), null);
    await assert.rejects(f.queue.setTrackLove({row: {id}, love_tier: 'loved'}));
    assert.equal(f.requests.length, 3, 'one Album read and two Queue reads, with no preference command');
    assert.equal(f.batches.length, before + 1); assert.equal(f.batches.at(-1).epoch, epoch);
    assert.equal(f.directReads.length, 0, 'only the existing Queue batch may attempt admission');
    assert.equal(f.runtime.readEpoch(), epoch, 'unknown metadata cannot advance the epoch with a fabricated denial');
    assert.equal(f.preference(known).love_tier, 'obsessed');
    assert.equal(f.preference(known).allowed_actions.can_set_love_tier, true);
    assert.equal(f.source(row), null); assert.deepEqual(plain(row), original);
  });
}

test('Unknown Loose Queue preference can become known on a later genuine refresh, without changing occurrence identity', async () => {
  const f = fixture(), unknown = unknownRow(411), [id] = await enqueue(f, [unknown]);
  assert.equal(f.queue.trackPreference({id}), null);
  const known = looseRow(411, {availability: 'local', track_preference: overlay('loved')}), epoch = f.runtime.readEpoch();
  const refresh = f.queue.refresh(); f.respond(2, browsePayload([known])); await refresh;
  const [entry] = f.queue.getSnapshot().entries;
  assert.equal(entry.id, id); assert.equal(entry.track_preference.love_tier, 'loved');
  assert.equal(entry.track_preference.allowed_actions.can_set_love_tier, true);
  assert.equal(f.batches.length, 2); assert.equal(f.batches[1].epoch, epoch);
  assert.equal(f.directReads.length, 0); assert.equal(f.source(known), null);
});

test('Unknown Loose metadata loader neither admits nor mutates a known alias before Queue consumes it', async () => {
  const f = fixture(), known = looseRow(421, {track_preference: overlay('obsessed')}); await admitAlbum(f, known);
  const row = unknownRow(421), [capture] = f.context.captureNativeLooseQueueSources(browsePayload([row]), [row]);
  const before = f.batches.length, epoch = f.runtime.readEpoch(), pending = capture.resolveMetadata();
  f.respond(1, browsePayload([row])); await pending;
  assert.equal(f.batches.length, before); assert.equal(f.directReads.length, 0); assert.equal(f.runtime.readEpoch(), epoch);
  assert.equal(f.preference(known).love_tier, 'obsessed'); assert.equal(f.preference(known).allowed_actions.can_set_love_tier, true);
});
