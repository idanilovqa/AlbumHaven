'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {nativeFixture} = require('./library-mix-native-fixture.cjs');
const F = require('./sample-origin-fixtures.cjs');
async function fixture(t, kind) {
  const native = nativeFixture(), scopeKey = native.runtime.snapshot().scopeKey;
  const h = await F.typedController(kind, {}, {scopeKey}); t.after(() => h.controller.dispose()); await h.generateOrigin();
  assert.ok(h.controller.source(), 'The typed controller must admit its dedicated v2 receipt before runtime playback');
  const sample = native.runtime.createSamplePlaylistRuntime({scopeKey, source: () => h.controller.source(), isCurrent: () => h.controller.source() !== null});
  const reply = (body, mutate = value => value) => native.reply(body, {mutate: value => {
    value.data.source_protocol = F.PROTOCOL; value.data.source.kind = 'library'; return mutate(value);
  }});
  return {...native, ...h, nativeCalls: native.calls, sample, rows: h.controller.source().detail.track_rows,
    network(mutate) {native.c.fetch = async (url, input) => {native.calls.requests.push({url, ...input});
      assert.equal(url, '/playlists/creation-source/sample/native-queue'); return reply(JSON.parse(input.body), mutate);};}, reply};
}
for (const kind of Object.keys(F.origins)) {
  test(`${kind}: actual shared Sample player uses captured order, clicked occurrence and no durable parent identity`, async t => {
    const h = await fixture(t, kind); h.network(); await h.sample.trackIntent('play', h.rows[2]);
    assert.deepEqual(Array.from(h.state.player.playbackQueue.tracks, row => row.playlistItemId), [F.id(11), F.id(12), F.id(13)]);
    assert.equal(h.state.player.playbackQueue.currentIndex, 2); assert.equal(h.state.player.playbackQueue.playlistId, null);
    assert.equal(h.state.player.playbackQueue.shuffle, false); assert.equal(h.nativeCalls.starts.length, 1);
    assert.deepEqual(JSON.parse(h.nativeCalls.requests[0].body), {source_ref: F.id(90), source_revision: F.id(2),
      entry_refs: [F.id(11), F.id(12), F.id(13)], starting_entry_ref: F.id(13)});
    assert.equal(h.typedCalls.save.length, 0); assert.equal(h.typedCalls.capture.length, 1);
  });
  test(`${kind}: fresh media denial does not erase a Browse preview or grant playback`, async t => {
    const h = await fixture(t, kind), prior = h.state.player.playbackQueue; h.network();
    h.c.AlbumHavenCapabilities = {allows: () => false}; await assert.rejects(h.sample.trackIntent('play', h.rows[0]));
    assert.equal(h.state.player.playbackQueue, prior); assert.equal(h.nativeCalls.starts.length, 0); assert.ok(h.controller.source());
  });
  test(`${kind}: explicit-queue return uses dedicated retained reader and rejects expiry without recapture`, async t => {
    const h = await fixture(t, kind); h.network(); await h.sample.trackIntent('play', h.rows[0]);
    const nativeQueue = h.state.player.playbackQueue, selected = nativeQueue.tracks[0];
    await h.c.refreshExplicitQueueReturnTrack({nativeQueue}, selected); assert.equal(h.nativeCalls.requests.length, 2);
    assert.ok(h.nativeCalls.requests.every(request => request.url === '/playlists/creation-source/sample/native-queue'));
    h.c.fetch = async () => ({ok: false, status: 410, json: async () => ({status: 'source_expired'})});
    await assert.rejects(h.c.refreshExplicitQueueReturnTrack({nativeQueue}, selected)); assert.equal(h.typedCalls.capture.length, 1);
  });
}
for (const kind of ['playlist', 'activity']) test(`v2 native acknowledgement relabeled ${kind} cannot activate`, async t => {
  const h = await fixture(t, 'album_set'), prior = h.state.player.playbackQueue;
  h.network(value => {value.data.source.kind = kind; return value;}); await assert.rejects(h.sample.trackIntent('play', h.rows[0]));
  assert.equal(h.state.player.playbackQueue, prior); assert.equal(h.nativeCalls.starts.length, 0);
});
test('generic Mix native queue reader stays closed to Sample protocol despite the truthful library header', async () => {
  const h = nativeFixture();
  await assert.rejects(h.c.readLibraryMixNativeQueue({sourceRef: F.id(90), sourceRevision: F.id(2), entryRefs: [F.id(11)],
    startingEntryRef: F.id(11), sourceProtocol: F.PROTOCOL}));
  assert.equal(h.calls.requests.length, 0); assert.equal(h.calls.starts.length, 0);
});
test('late v2 native queue acknowledgement cannot activate after the actual origin lifetime retires', async t => {
  const h = await fixture(t, 'album_details'), waiting = F.deferred(), entered = F.deferred(); let body;
  h.c.fetch = async (_url, input) => {body = JSON.parse(input.body); entered.resolve(); return waiting.promise;};
  const operation = h.sample.trackIntent('play', h.rows[0]);
  await Promise.race([entered.promise, operation.then(() => {throw new Error('Missing media boundary');})]);
  const prior = h.state.player.playbackQueue; h.retire(); waiting.resolve(h.reply(body));
  await assert.rejects(operation); assert.equal(h.state.player.playbackQueue, prior); assert.equal(h.nativeCalls.starts.length, 0);
});
