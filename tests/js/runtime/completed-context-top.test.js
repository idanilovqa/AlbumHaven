'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {scenario, plain, frame, F} = require('./completed-context-fixtures.cjs');
let createAlbumTopBackendProviders, createTopPlaybackSource;
test.before(async () => {
  ({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));
  ({createTopPlaybackSource} = await F.load('album-tops/playback-source.mjs'));
});

// All occurrences exist before capture. The actual provider validates the HTTP
// capture; the actual source creates every receipt and the facade commits it.
async function top(h, {counts = [2, 2], stopAfterAlbum = false, identityBase = 0, topRef = F.TOP} = {}) {
  const native = h.owner('TopPlaybackRuntime'), transport = h.c.AlbumHavenPrivateUITransport;
  const scope = () => JSON.stringify([h.shell.dataset.nativeAccountId, h.shell.dataset.nativeLibraryId,
    transport.context(), transport.generation()]);
  const scopeKey = scope(), context = transport.context(), library = h.shell.dataset.nativeLibraryId;
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: value => value === scope()});
  const albums = counts.map((count, albumIndex) => {
    const item_ref = F.id(21 + identityBase * 1000 + albumIndex), catalog_ref = F.id(11 + identityBase * 1000 + albumIndex);
    const inventory_album_ref = `inventory-album:${library}:${11 + identityBase * 1000 + albumIndex}`;
    return {item_ref, catalog_ref, inventory_album_ref, album_ref: `Top album ${albumIndex + 1}`,
      tracks: Array.from({length: count}, (_, trackIndex) => {
        const id = 101 + identityBase * 1000 + albumIndex * 100 + trackIndex;
        const source = {revision: '7', item_ref, catalog_ref, inventory_album_ref,
          inventory_track_ref: `inventory-track:${library}:${id}`, canonical_track_ref: `canonical-${id}`};
        return {queue_item_ref: `${item_ref}:${id}`, source,
          native_target: {path: `/synthetic/top/${id}.flac`, track_ref: `/synthetic/top/${id}.flac`,
            title: `Top track ${id}`, artist: 'Top artist', album_title: `Top album ${albumIndex + 1}`,
            duration_seconds: 90, inventory_track_ref: source.inventory_track_ref}};
      })};
  });
  const capturedWork = h.own(providers.captureNativeQueue({top_ref: topRef, revision: '7'},
    {scopeKey, isCurrent: () => scope() === scopeKey}));
  await h.flush();
  const captureRequest = h.requests.find(row => !row.settled
    && new URL(row.url, h.location).pathname === `/album-tops/${topRef}/native-queue`);
  assert.ok(captureRequest, 'fixture reaches actual capture transport');
  captureRequest.resolve({status: 'ready', context_ref: context,
    data: {top_ref: topRef, revision: '7', unavailable_items: [], albums}});
  const captured = await capturedWork;
  assert.equal(captured.error, undefined, captured.error?.stack);
  let source;
  const queue = native.create({capture: captured.value, isCurrent: () => scope() === scopeKey,
    onRetire: () => providers.dispose(),
    createSource: isCurrent => (source = createTopPlaybackSource({capture: captured.value,
      providers, scopeKey, isCurrent, stopAfterAlbum}))});
  h.disposals.push(() => native.dispose(queue));
  const requests = () => h.requests.filter(row => new URL(row.url, h.location).pathname === `/album-tops/${topRef}/native-playback-target`);
  const occurrence = (albumIndex, trackIndex) => albums[albumIndex].tracks[trackIndex];
  function expectRequest(row, request = requests().at(-1)) {
    assert.ok(request, 'Play reaches real Top fresh-target transport');
    assert.deepEqual(JSON.parse(request.options.body), row.source,
      'fresh target is the completed album occurrence, not displayed last track or whole Top first');
    return request;
  }
  function reply(row, request = expectRequest(row)) {
    expectRequest(row, request);
    request.resolve({status: 'ready', context_ref: context,
      data: {top_ref: topRef, source: row.source, native_target: row.native_target}});
  }
  async function startAt(albumIndex, trackIndex) {
    const destination = albums.slice(0, albumIndex).reduce((sum, album) => sum + album.tracks.length, 0) + trackIndex;
    const rows = albums.flatMap(album => album.tracks);
    for (let index = 0; index <= destination; index++) {
      if (index) await h.finish();
      const pending = h.own(index ? native.skip(queue, 1) : native.start(queue));
      await h.flush(); reply(rows[index]); await h.complete(pending);
      assert.equal(source.snapshot().currentId, rows[index].queue_item_ref);
      assert.equal(h.state.player.current.path, rows[index].native_target.path);
    }
    await h.finish();
    assert.equal(h.c.getActivePlaybackOwnershipHandle(), null, 'actual terminal callback releases claim');
    assert.strictEqual(h.state.player.playbackQueue, queue);
  }
  async function replayFirst(albumIndex, trackIndex = 0) {
    const count = requests().length, observation = await h.replay();
    assert.equal(observation.accepted, true);
    assert.equal(requests().length, count + 1, 'one Play creates one fresh Top target request');
    const request = expectRequest(occurrence(albumIndex, trackIndex));
    assert.equal(request.options.signal.aborted, false);
    return {observation, request};
  }
  async function acceptReplay(pending, row) {
    reply(row, pending.request); await h.flush();
    assert.equal(pending.observation.starts().length, 1, 'one actual facade start');
    await h.complete(pending.observation.starts()[0].work);
    assert.equal(source.snapshot().currentId, row.queue_item_ref);
    assert.equal(h.state.player.current.path, row.native_target.path);
    assert.strictEqual(h.engine().roles.current.track, h.state.player.current);
    assert.equal(native.isPayloadCurrent(h.state.player.current), true);
    assert.equal(h.c.isStreamingPlaybackAttemptCurrent(h.engine().playbackAttempt), true);
    assert.equal(h.queueOwner().hasPendingStart(), false, 'accepted selection survives replay cleanup');
    assert.equal(h.c.currentPlayerSelection(h.owner('playerSelectionOwnership')), true,
      'real facade guard remains current after pendingStart and rollback cleanup');
    assert.ok(h.c.getActivePlaybackOwnershipHandle());
  }
  return {native, queue, source, occurrence, requests, expectRequest, reply, startAt, replayFirst, acceptReplay};
}

test('CC Top 01 final album Play restarts that album rather than the whole Top', async t => scenario(t, async h => {
  const a = await top(h); await a.startAt(1, 1);
  const completed = a.source.snapshot(), pending = await a.replayFirst(1);
  await a.acceptReplay(pending, a.occurrence(1, 0));
  const restarted = a.source.snapshot();
  assert.deepEqual(plain(restarted.order), plain(completed.order));
  assert.equal(restarted.currentIndex, 2);
  assert.equal(restarted.visitedEnd, 2, 'actual E1 restart commit resets traversal to accepted occurrence');
  assert.equal(restarted.currentAlbumId, completed.currentAlbumId);
}));

test('CC Top 02 stop-after-album Play stays inside the stopped album', async t => scenario(t, async h => {
  const a = await top(h, {stopAfterAlbum: true}); await a.startAt(0, 1);
  const pending = await a.replayFirst(0);
  await a.acceptReplay(pending, a.occurrence(0, 0));
  assert.equal(a.source.snapshot().stopAfterAlbum, true);
  assert.equal(a.source.snapshot().currentAlbumId, F.id(21));
  assert.equal(a.requests().some(row => JSON.parse(row.options.body).item_ref === F.id(22)), false);
}));

test('CC Top 03 one Play adopts two real unavailable-only E1 steps before fresh acceptance', async t => scenario(t, async h => {
  const a = await top(h, {counts: [3, 1], stopAfterAlbum: true}); await a.startAt(0, 2);
  const completed = a.source.snapshot(), pending = await a.replayFirst(0);
  let request = pending.request;
  for (let index = 0; index < 2; index++) {
    a.expectRequest(a.occurrence(0, index), request);
    const count = a.requests().length;
    request.resolve({error_code: 'item_unavailable'}, 404);
    await h.flush();
    const progressed = a.source.snapshot();
    assert.equal(progressed.revision, completed.revision + index + 1);
    for (const key of ['currentId', 'currentIndex', 'currentAlbumId', 'visitedEnd', 'mode', 'stopAfterAlbum'])
      assert.equal(progressed[key], completed[key], `unavailable progress preserves ${key}`);
    assert.deepEqual(plain(progressed.order), plain(completed.order));
    assert.deepEqual(plain(progressed.unavailableIds), [0, 1].slice(0, index + 1).map(i => a.occurrence(0, i).queue_item_ref));
    assert.equal(a.requests().length, count + 1,
      'real E1 request.isCurrent callback must accept only its own progress before the next provider call');
    request = a.expectRequest(a.occurrence(0, index + 1));
    assert.equal(request.options.signal.aborted, false);
  }
  await a.acceptReplay({...pending, request}, a.occurrence(0, 2));
  assert.equal(a.source.snapshot().revision, completed.revision + 3, 'two rejects and actual accepted restart commit');
}));

test('CC Top 04 all unavailable restart occurrences stop without crossing the album boundary', async t => scenario(t, async h => {
  const a = await top(h, {stopAfterAlbum: true}); await a.startAt(0, 1);
  const oldTrack = h.state.player.current, pending = await a.replayFirst(0);
  const streamCount = h.streams.length;
  pending.request.resolve({error_code: 'item_unavailable'}, 404); await h.flush();
  const second = a.expectRequest(a.occurrence(0, 1));
  assert.notStrictEqual(second, pending.request);
  second.resolve({error_code: 'item_unavailable'}, 404); await h.flush();
  assert.equal(a.requests().some(row => JSON.parse(row.options.body).item_ref === F.id(22)), false);
  assert.equal(h.streams.length, streamCount, 'no fallback audio start');
  assert.strictEqual(h.state.player.current, oldTrack);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
  assert.equal(h.queueOwner().hasPendingStart(), false);
  assert.equal(a.source.snapshot().currentIndex, 1);
  assert.deepEqual(plain(a.source.snapshot().unavailableIds), [a.occurrence(0, 0).queue_item_ref, a.occurrence(0, 1).queue_item_ref]);
}));

test('CC Top 05 a foreign source mode revision during restart is not adopted as unavailable progress', async t => scenario(t, async h => {
  const a = await top(h, {stopAfterAlbum: true}); await a.startAt(0, 1);
  const pending = await a.replayFirst(0), count = a.requests().length, streamCount = h.streams.length;
  const before = a.source.snapshot();
  // A real lower-owner edit, not replacement snapshot injection or a stubbed guard.
  assert.equal(a.source.configure({mode: 'popular_songs'}, before), true);
  const edited = a.source.snapshot();
  assert.equal(edited.revision, before.revision + 1);
  assert.equal(pending.request.options.signal.aborted, true, 'E1 retires its real active request on configure');
  pending.request.resolve({error_code: 'item_unavailable'}, 404); await h.flush();
  assert.strictEqual(a.source.snapshot(), edited, 'late rejection cannot create unavailable progress');
  assert.equal(a.requests().length, count, 'no next occurrence after foreign revision');
  assert.equal(h.streams.length, streamCount);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
  assert.equal(h.queueOwner().hasPendingStart(), false);
}));

// Lifecycle continuation: first == last makes target selection nondiscriminating;
// actual accepted publication and later controls, not path equality, are the oracle.
test('CC Top 06 accepted one-track replay survives cleanup first-frame pause resume and later EOF', async t => scenario(t, async h => {
  const a = await top(h, {counts: [1]}); await a.startAt(0, 0);
  const pending = await a.replayFirst(0); await a.acceptReplay(pending, a.occurrence(0, 0));
  const role = h.engine().roles.current, attempt = h.engine().playbackAttempt;
  frame(h, role); await h.flush();
  assert.equal(h.c.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(h.c.isNativePlayerSourceCurrent(h.state.player.current), true);
  assert.equal(h.c.currentPlayerSelection(h.owner('playerSelectionOwnership')), true);
  assert.equal(await h.c.pausePlayerPlaybackForHandoff(), true);
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, true);
  assert.equal(h.c.togglePlayerPlayback(), true); await h.flush();
  assert.strictEqual(h.engine().roles.current, role);
  assert.strictEqual(h.engine().playbackAttempt, attempt);
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, false);
  assert.ok(h.c.getActivePlaybackOwnershipHandle());
  await h.finish();
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
  const again = await a.replayFirst(0); await a.acceptReplay(again, a.occurrence(0, 0));
}));


test('CC Top 07 a newer Top selection cancels held completed replay before its own target await', async t => scenario(t, async h => {
  const a = await top(h, {stopAfterAlbum: true}); await a.startAt(0, 1);
  const b = await top(h, {counts: [1], identityBase: 1, topRef: F.id(2)});
  const pending = await a.replayFirst(0), streamCount = h.streams.length;
  const incoming = h.own(b.native.start(b.queue));
  assert.equal(pending.request.options.signal.aborted, true,
    'valid B reservation cancels A synchronously before waiting for B Top metadata');
  await h.flush();
  const bRequest = b.expectRequest(b.occurrence(0, 0));
  assert.equal(bRequest.settled, false, 'B metadata is still held');
  assert.equal(h.streams.length, streamCount, 'neither held provider may start media');
  b.reply(b.occurrence(0, 0), bRequest); await h.complete(incoming);
  const selected = h.state.player.current, claim = h.c.getActivePlaybackOwnershipHandle();
  const attempt = h.engine().playbackAttempt;
  assert.equal(selected.path, b.occurrence(0, 0).native_target.path);
  assert.strictEqual(h.state.player.playbackQueue, b.queue);
  a.reply(a.occurrence(0, 0), pending.request); await h.flush();
  assert.strictEqual(h.state.player.current, selected, 'late cancelled A cannot replace B');
  assert.strictEqual(h.state.player.playbackQueue, b.queue, 'late cancelled A cannot restore its old queue');
  assert.strictEqual(h.c.getActivePlaybackOwnershipHandle(), claim);
  assert.strictEqual(h.engine().playbackAttempt, attempt);
  assert.equal(h.c.currentPlayerSelection(h.owner('playerSelectionOwnership')), true);
  assert.equal(h.streams.length, streamCount + 1, 'only B starts one new stream');
}));
