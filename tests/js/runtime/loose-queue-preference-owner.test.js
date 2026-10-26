// Whole production Loose capture + explicit Queue owner with synthetic HTTP DTOs.
// These units do not claim browser, production ASGI, authentication or persistence proof.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const {
  createLooseAuthorityFixture, looseRow, browsePayload, overlay, outcome,
} = require('./loose-authority-harness.cjs');
const {ordinaryNativeState} = require('./ordinary-native-state-fixture.cjs');
const {runtimeRoot} = require('./loose-authority-harness.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function queueRow(id, patch = {}) {
  return looseRow(id, {track_ref: `track:loose-${id}`, canonical_track_ref: `track:loose-${id}`,
    title: 'Same display title', artist: 'Synthetic artist', duration_seconds: 123,
    availability: 'local', source_readable: true, allowed_actions: {can_read: true, can_play: true},
    playback_state: {can_start_here: true}, ...patch});
}
function fixture(rows) {
  const f = createLooseAuthorityFixture();
  f.state.player = ordinaryNativeState(runtimeRoot).player;
  const starts = [];
  Object.assign(f.context, {
    playerTrackSelectionToken: 1,
    activateSharedTrackButton() {throw new Error('Preference/Queue metadata must not activate a track');},
    getPlayerPlaybackSnapshot: () => ({}),
    resolveNextPlaybackContextQueue: () => null, peekNextOrdinaryQueuedTrack: () => null,
    playTrackFromPayload: async (payload, options) => {starts.push({payload, options}); return true;},
    buildApiUrl: (_view, options) => {
      assert.equal(options.payloadTier, 'full');
      return '/view-data?surface=albums&payload_tier=full';
    },
  });
  f.context.window.AlbumHavenCapabilities = {allows: () => true};
  f.actionContext.activateSharedTrackButton = f.context.activateSharedTrackButton;
  for (const file of ['player-streaming-engine.js', 'explicit-queue-planner.js', 'explicit-queue-runtime.js', 'explicit-queue-sources.js']) f.loadRuntime(file);
  assert.equal(f.context.streamingEngineState(), f.state.player.streaming);
  assert.equal(f.requests.length, 0, 'whole streaming owner evaluation dispatches no network or audio work');
  const view = browsePayload(rows), queue = f.context.window.AlbumHavenExplicitQueue;
  const captures = f.context.captureNativeLooseQueueSources(view, rows);
  assert.equal(captures.length, rows.length);
  return {...f, rows, view, queue, captures, starts};
}
function assertQueueRequest(request) {
  assert.equal(request.url, '/view-data?surface=albums&payload_tier=full');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
}
async function enqueue(f, metadataRows = f.rows, playbackRows = metadataRows) {
  const before = f.requests.length, pending = outcome(f.queue.enqueue(f.captures));
  assert.equal(f.requests.length, before + 1, 'sibling metadata captures share their genuine full read');
  assertQueueRequest(f.requests[before]);
  f.respond(before, browsePayload(metadataRows)); await turn();
  assert.equal(f.requests.length, before + 2, 'Queue separately revalidates playback through the full loader');
  assertQueueRequest(f.requests[before + 1]);
  f.respond(before + 1, browsePayload(playbackRows));
  const result = await pending;
  assert.equal(result.error, undefined, result.error?.stack);
  return result.value;
}

for (const grants of [[false, true, false], [true, false, true]]) {
  test(`Loose Queue loader leaves one original-epoch batch to Queue, grants ${grants}`, async () => {
    const tiers = ['loved', 'obsessed', 'off'];
    const f = fixture(grants.map((writable, index) => queueRow(301 + index,
      {track_preference: overlay(tiers[index], writable)})));
    const epoch = f.runtime.readEpoch(), ids = await enqueue(f);
    assert.equal(f.batches.length, 1, 'no loader, receipt renderer or modal admission');
    assert.equal(f.directReads.length, 0, 'the loader cannot bypass Queue batching with direct admission');
    assert.equal(f.batches[0].epoch, epoch, 'Queue uses its pre-dispatch read epoch');
    assert.equal(f.batches[0].sources.length, 3, 'one admission attempt for each queued occurrence');
    const entries = Array.from(f.queue.getSnapshot().entries);
    assert.deepEqual(entries.map(entry => entry.id), Array.from(ids));
    assert.deepEqual(entries.map(entry => entry.track_preference?.love_tier), tiers);
    assert.deepEqual(entries.map(entry => entry.track_preference?.allowed_actions.can_set_love_tier), grants);
    assert.equal(new Set(entries.map(entry => entry.id)).size, 3);
    assert.equal(f.starts.length, 0);
    for (const row of f.rows) assert.equal(f.source(row), null, 'Queue does not mint modal exact-object provenance');
    assert.doesNotMatch(JSON.stringify(entries), /inventory-track:|canonical_track_ref|track_ref|\/synthetic\//);
  });
}

test('Standalone Loose metadata and playback loaders do not admit preference batches', async () => {
  const f = fixture([queueRow(311)]), epoch = f.runtime.readEpoch();
  const metadata = f.captures[0].resolveMetadata();
  f.respond(0, f.view); await metadata;
  const play = f.captures[0].resolve();
  f.respond(1, f.view); await play;
  assert.equal(f.batches.length, 0);
  assert.equal(f.directReads.length, 0, 'raw loader completion cannot directly adopt private grants');
  assert.equal(f.runtime.readEpoch(), epoch);
  assert.equal(f.source(f.rows[0]), null);
  assert.equal(f.starts.length, 0);
});

test('Intervening denial cannot let Loose loader replace Queue original epoch with a new one', async () => {
  const f = fixture([queueRow(321)]), epoch = f.runtime.readEpoch();
  const pending = outcome(f.queue.enqueue(f.captures));
  f.runtime.acceptRead(queueRow(399, {track_preference: overlay('loved', false)}), epoch);
  assert.notEqual(f.runtime.readEpoch(), epoch);
  f.respond(0, f.view); await turn(); f.respond(1, f.view);
  const result = await pending;
  assert.equal(result.error, undefined, result.error?.stack);
  assert.equal(f.batches.length, 1); assert.equal(f.batches[0].epoch, epoch);
  const [entry] = f.queue.getSnapshot().entries;
  assert.equal(entry.track_preference, null, 'stale first admission never exposes raw writable DTO fields');
  await assert.rejects(f.queue.setTrackLove({row: {id: entry.id}, love_tier: 'loved'}));
  assert.equal(f.requests.length, 2);
  const refreshEpoch = f.runtime.readEpoch(), refresh = f.queue.refresh();
  f.respond(2, f.view); await refresh;
  assert.equal(f.batches.length, 2); assert.equal(f.batches[1].epoch, refreshEpoch);
  assert.equal(f.queue.trackPreference({id: entry.id}).love_tier, 'off');
});

test('Loose Queue refresh keeps exact occurrence IDs and admits a mixed denial batch once', async () => {
  const f = fixture([queueRow(331), queueRow(332)]), ids = await enqueue(f);
  const updated = [queueRow(331, {track_preference: overlay('obsessed', false)}),
    queueRow(332, {track_preference: overlay('loved', true)})];
  const epoch = f.runtime.readEpoch(), refresh = f.queue.refresh();
  f.respond(2, browsePayload(updated)); await refresh;
  assert.equal(f.requests.length, 3, 'metadata refresh does not run playback resolution');
  assert.equal(f.batches.length, 2); assert.equal(f.batches[1].epoch, epoch);
  assert.equal(f.batches[1].sources.length, 2);
  const entries = Array.from(f.queue.getSnapshot().entries);
  assert.deepEqual(entries.map(row => row.id), Array.from(ids));
  assert.deepEqual(entries.map(row => row.track_preference.love_tier), ['obsessed', 'loved']);
  assert.deepEqual(entries.map(row => row.track_preference.allowed_actions.can_set_love_tier), [false, true]);
  assert.equal(f.starts.length, 0);
});

test('Loose duplicate capture keeps separate Queue occurrences with shared Love authority', async () => {
  const row = queueRow(341), f = fixture([row, row]), ids = await enqueue(f, [row]);
  const entries = Array.from(f.queue.getSnapshot().entries);
  assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
  assert.equal(entries[0].track_preference.identity, entries[1].track_preference.identity);
  assert.equal(f.batches.length, 1); assert.equal(f.batches[0].sources.length, 2);
  const selection = f.queue.playlistSelection([ids[1]]);
  f.respond(2, browsePayload([row]));
  const resolved = await selection;
  assert.deepEqual(plain(resolved.rows), [{rowKey: ids[1], track_ref: row.inventory_track_ref,
    source_provenance: {kind: 'inventory', track_ref: row.inventory_track_ref}}]);
  assert.equal(f.batches.length, 1, 'selection resolution cannot manufacture preference admission');
});

for (const invalid of ['path', 'playback', 'selection', 'source-denial']) {
  test(`Fresh Loose Queue ${invalid} change prevents admission and playback`, async () => {
    const f = fixture([queueRow(351)]), pending = outcome(f.queue.enqueue(f.captures));
    f.respond(0, f.view); await turn();
    let rows = f.rows;
    if (invalid === 'path') rows = [queueRow(351, {path: '/synthetic/loose-reassigned.flac'})];
    if (invalid === 'playback') rows = [queueRow(351, {playback_state: {can_start_here: false}})];
    if (invalid === 'selection') f.context.playerTrackSelectionToken++;
    const payload = browsePayload(rows, invalid === 'source-denial' ? {source_readable: false} : {});
    f.respond(1, payload);
    assert.ok((await pending).error);
    assert.equal(f.queue.getSnapshot().entries.length, 0);
    assert.equal(f.batches.length, 0, 'neither completed metadata nor failed playback authorizes a Queue batch');
    assert.equal(f.starts.length, 0);
  });
}

test('Path-only production Loose DTOs reach Queue preference ownership without acquiring modal receipts', async () => {
  const row = queueRow(361); delete row.track_ref;
  const f = fixture([row]), epoch = f.runtime.readEpoch();
  const [id] = await enqueue(f);
  const preference = f.queue.trackPreference({id});
  assert.ok(preference, 'the real path-only Loose response must normalize inside the existing private Queue path');
  assert.equal(preference.love_tier, 'off'); assert.equal(preference.allowed_actions.can_set_love_tier, true);
  assert.equal(f.batches.length, 1); assert.equal(f.batches[0].epoch, epoch);
  assert.equal(f.batches[0].sources.length, 1); assert.equal(f.source(row), null);
  assert.equal(Object.hasOwn(row, 'track_ref'), false, 'source normalization must not mutate the HTTP DTO');
});
