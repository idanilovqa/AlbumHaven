'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const {nativeFixture} = require('./library-mix-native-fixture.cjs');
const {id, deferred, plain, PROTOCOL, controllerFixture} = require('./sample-native-fixtures.cjs');
async function fixture(t) {
  const native = nativeFixture(), scopeKey = native.runtime.snapshot().scopeKey;
  const h = await controllerFixture({}, {scopeKey}); await h.generate(); t.after(() => h.controller.dispose());
  const sample = native.runtime.createSamplePlaylistRuntime({scopeKey, source: () => h.controller.source(), isCurrent: () => h.controller.source() !== null});
  const reply = (body, change = value => value, missing = []) => native.reply(body, {missing, mutate: value => {
    value.data.source_protocol = PROTOCOL; value.data.source.kind = 'playlist'; return change(value);
  }});
  const network = (change, missing) => {native.c.fetch = async (url, input) => {
    native.calls.requests.push({url, ...input}); assert.equal(url, '/playlists/creation-source/sample/native-queue');
    return reply(JSON.parse(input.body), change, missing);
  };};
  return {...native, ...h, calls: {...native.calls, ...h.calls}, sample, reply, network, rows: h.controller.source().detail.track_rows};
}
const ids = queue => Array.from(queue.tracks, row => row.playlistItemId);

test('Sample runtime preserves captured order, regular mode and null durable identity for row/start actions', async t => {
  for (const fromStart of [false, true]) {
    const h = await fixture(t); h.network(); vm.runInContext('Math.random = () => {throw new Error("No Play shuffle");}', h.c);
    await h.sample.trackIntent('play', h.rows[2], {fromStart});
    const queue = h.state.player.playbackQueue;
    assert.deepEqual(ids(queue), [id(11), id(12), id(13)]); assert.equal(queue.currentIndex, fromStart ? 0 : 2);
    assert.equal(queue.shuffle, false); assert.equal(queue.playlistId, null);
    assert.equal(queue.libraryMixRef, id(90)); assert.equal(queue.playlistRevision, id(2)); assert.equal(queue.libraryMixProtocol, PROTOCOL);
    assert.deepEqual(plain(queue.sourceEntryRefs), [id(11), id(12), id(13)]);
    assert.equal(queue.albumSnapshot, null); assert.equal(queue.playbackContext, null);
    assert.deepEqual(JSON.parse(h.calls.requests[0].body), {source_ref: id(90), source_revision: id(2),
      entry_refs: [id(11), id(12), id(13)], starting_entry_ref: id(fromStart ? 11 : 13)});
    assert.doesNotMatch(JSON.stringify(h.controller.getSnapshot()), /synthetic-only|track_ref|"path"/);
  }
});

for (const order of [[id(13), id(11), id(12)], [id(11)], [id(11), id(12), id(12)], [id(11), id(12), id(99)]])
  test(`Sample rejects noncaptured display order before transport: ${order.join(',')}`, async t => {
    const h = await fixture(t); h.network(); const prior = h.state.player.playbackQueue;
    await assert.rejects(h.sample.trackIntent('play', h.rows[0], {displayedItemIds: order}));
    assert.equal(h.calls.requests.length, 0); assert.equal(h.calls.starts.length, 0); assert.equal(h.state.player.playbackQueue, prior);
  });

const corruptions = {
  source: v => {v.data.source.ref = id(99);}, revision: v => {v.data.source.revision = id(99);},
  kind: v => {v.data.source.kind = 'library';}, protocol: v => {v.data.source_protocol = 'library_mix_selection_v1';},
  start: v => {v.data.starting_item_ref = id(12);}, omitted: v => {v.data.tracks.pop();},
  duplicate: v => {v.data.tracks.push(v.data.tracks[0]);}, reordered: v => {v.data.tracks.reverse();},
  foreign: v => {v.data.unavailable_item_refs.push(id(99));}, overlap: v => {v.data.unavailable_item_refs.push(id(11));},
  wrongTarget: v => {v.data.tracks[0].native_target.playlist_item_id = id(99);}, missingPath: v => {v.data.tracks[0].native_target.path = '';},
};
for (const [name, corrupt] of Object.entries(corruptions)) test(`Sample native response ${name} cannot publish or activate`, async t => {
  const h = await fixture(t), prior = h.state.player.playbackQueue;
  h.network(value => {corrupt(value); return value;});
  await assert.rejects(h.sample.trackIntent('play', h.rows[0]));
  assert.equal(h.state.player.playbackQueue, prior); assert.equal(h.calls.starts.length, 0); assert.equal(h.calls.activations.length, 0);
});

test('media policy is checked by actual TrackActionsRuntime even with projected native hints', async t => {
  const h = await fixture(t), prior = h.state.player.playbackQueue; h.network(); h.c.AlbumHavenCapabilities = {allows: () => false};
  await assert.rejects(h.sample.trackIntent('play', h.rows[0])); assert.equal(h.state.player.playbackQueue, prior); assert.equal(h.calls.starts.length, 0);
});

test('unavailable nonstarting refs form an exact ordered subsequence, starting unavailable rejects', async t => {
  const h = await fixture(t); h.network(undefined, [id(12)]); await h.sample.trackIntent('play', h.rows[0]);
  assert.deepEqual(ids(h.state.player.playbackQueue), [id(11), id(13)]);
  const other = await fixture(t); other.network(undefined, [id(11)]);
  await assert.rejects(other.sample.trackIntent('play', other.rows[0])); assert.equal(other.calls.starts.length, 0);
});

for (const invalidation of ['player', 'dispose', 'scope', 'abort', 'newer_play']) test(`Sample pending activation fences ${invalidation}`, async t => {
  const h = await fixture(t), wait = deferred(), entered = deferred(), abort = new AbortController(); let body;
  h.c.fetch = async (_url, input) => {body = JSON.parse(input.body); entered.resolve(); return wait.promise;};
  const old = h.sample.trackIntent('play', h.rows[0], {signal: abort.signal}); await entered.promise;
  let expected = h.state.player.playbackQueue;
  if (invalidation === 'player') h.c.playerTrackSelectionToken++;
  else if (invalidation === 'dispose') h.controller.dispose();
  else if (invalidation === 'scope') h.shell.dataset.nativeAccountId = '9';
  else if (invalidation === 'abort') abort.abort();
  else {h.network(); await h.sample.trackIntent('play', h.rows[2]); expected = h.state.player.playbackQueue;}
  wait.resolve(h.reply(body)); await assert.rejects(old, {name: 'AbortError'});
  assert.equal(h.state.player.playbackQueue, expected); assert.equal(h.calls.starts.length, invalidation === 'newer_play' ? 1 : 0);
});

for (const replaced of [false, true]) test(`Sample failed start rollback respects newer queue owner ${replaced}`, async t => {
  const h = await fixture(t), prior = h.state.player.playbackQueue, newer = {owner: 'newer'}; h.network();
  h.c.playTrackFromPayload = async () => {if (replaced) h.state.player.playbackQueue = newer; return false;};
  await assert.rejects(h.sample.trackIntent('play', h.rows[0])); assert.equal(h.state.player.playbackQueue, replaced ? newer : prior);
});

test('Sample explicit-queue return uses dedicated reader, never recaptures, and rejects expired/file-changed context', async t => {
  const h = await fixture(t); h.network(); await h.sample.trackIntent('play', h.rows[0]);
  const nativeQueue = h.state.player.playbackQueue, selected = nativeQueue.tracks[0]; h.calls.requests.length = 0;
  const fresh = await h.c.refreshExplicitQueueReturnTrack({nativeQueue}, selected);
  assert.equal(fresh.path, selected.path); assert.equal(h.calls.requests.length, 1);
  assert.equal(h.calls.requests[0].url, '/playlists/creation-source/sample/native-queue');
  assert.deepEqual(JSON.parse(h.calls.requests[0].body).entry_refs, [id(11), id(12), id(13)]);
  h.network(value => {value.data.tracks[0].native_target.path = '/synthetic-only/replaced.flac'; return value;});
  await assert.rejects(h.c.refreshExplicitQueueReturnTrack({nativeQueue}, selected));
  h.c.fetch = async () => ({ok: false, status: 410, json: async () => ({status: 'source_expired'})});
  await assert.rejects(h.c.refreshExplicitQueueReturnTrack({nativeQueue}, selected));
  assert.equal(h.calls.capture.length, 1);
});

test('shared shuffle-copy preserves values and existing current-occurrence anchoring', () => {
  const h = nativeFixture(); vm.runInContext('Math.random = () => 0;', h.c);
  const input = Object.freeze(['inventory-track:5:9223372036854775807', 'inventory-track:5:9007199254740993', 'inventory-track:5:3']);
  assert.deepEqual(Array.from(h.c.playlistQueueShuffleCopy(input, () => 0)), [input[1], input[2], input[0]]);
  assert.deepEqual(Array.from(h.c.playlistQueueShuffleCopy(Object.freeze([]), () => {throw new Error('empty');})), []);
  const rows = Object.freeze([{path: 'same', playlistItemId: 'a'}, {path: 'same', playlistItemId: 'b'}, {path: 'other', playlistItemId: 'c'}]);
  assert.deepEqual(Array.from(h.c.playlistQueueOrder(rows, true, 'same', 'b'), x => x.playlistItemId), ['b', 'c', 'a']);
  assert.notEqual(h.c.playlistQueueOrder(rows, false), rows);
  assert.deepEqual(Array.from(rows, x => x.playlistItemId), ['a', 'b', 'c']);
});
