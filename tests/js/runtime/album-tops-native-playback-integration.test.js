'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
const {fixture, frame, start, track: ordinaryTrack} = require('./search-native-fixtures/ownership-platform.cjs');
const Q = require('./search-native-fixtures/queue-actions.cjs');
let createAlbumTopBackendProviders, createTopPlaybackSource;
test.before(async () => {
  ({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));
  ({createTopPlaybackSource} = await F.load('album-tops/playback-source.mjs'));
});
const outcome = promise => Promise.resolve(promise).then(value => ({value}), error => ({error}));
async function environment(t, {blocks = [[101, 102], [103]], repeatedPath = false, partial = false} = {}) {
  const h = await fixture(t), native = h.owner('TopPlaybackRuntime'), transport = h.c.AlbumHavenPrivateUITransport;
  const scope = () => JSON.stringify([h.shell.dataset.nativeAccountId, h.shell.dataset.nativeLibraryId, transport.context(), transport.generation()]);
  const scopeKey = scope(), context = transport.context(), library = h.shell.dataset.nativeLibraryId;
  const provider = createAlbumTopBackendProviders({transport, acceptsScope: value => value === scope()});
  const target = (number, patch = {}) => ({track_ref: `/synthetic/top/${repeatedPath ? 'same' : number}.flac`,
    path: `/synthetic/top/${repeatedPath ? 'same' : number}.flac`, title: `Top track ${number}`, artist: 'Top Artist',
    album_title: 'Top Album', duration_seconds: 90, inventory_track_ref: `inventory-track:${library}:${number}`, ...patch});
  const albums = blocks.map((numbers, index) => {
    const item_ref = F.id(21 + index), catalog_ref = F.id(11 + index), inventory_album_ref = `inventory-album:${library}:${11 + index}`;
    return {item_ref, catalog_ref, inventory_album_ref, album_ref: `Top native album ${index}`, tracks: numbers.map(number => ({
      queue_item_ref: `${item_ref}:${number}`, source: {revision: '7', item_ref, catalog_ref, inventory_album_ref,
        inventory_track_ref: `inventory-track:${library}:${number}`, canonical_track_ref: `canonical-${number}`}, native_target: target(number)}))};
  });
  const wire = {top_ref: F.TOP, revision: '7', albums,
    unavailable_items: partial ? [{item_ref: albums[0].item_ref, reason: 'tracks_unavailable'}] : []};
  const captureWork = provider.captureNativeQueue({top_ref: F.TOP, revision: '7'}, {scopeKey, isCurrent: () => scope() === scopeKey});
  await h.flush();
  const captureRequest = h.requests.find(request => new URL(request.url, h.location).pathname.endsWith('/native-queue'));
  assert.ok(captureRequest, 'actual transport sent queue capture');
  captureRequest.resolve({status: 'ready', context_ref: context, data: wire});
  const capture = await captureWork;
  provider.dispose();
  function createQueue() {
    const sessionProvider = createAlbumTopBackendProviders({transport, acceptsScope: value => value === scope()});
    const value = native.create({capture, isCurrent: () => scope() === scopeKey, onRetire: () => sessionProvider.dispose(),
      createSource: isCurrent => createTopPlaybackSource({capture, providers: sessionProvider, scopeKey, isCurrent})});
    t.after(() => native.dispose(value));
    return value;
  }
  const queue = createQueue();
  const requests = () => h.requests.filter(request => new URL(request.url, h.location).pathname.endsWith('/native-playback-target'));
  function reply(request = requests().at(-1), {status = 200, patch = {}} = {}) {
    assert.ok(request, 'actual fresh Top resolver dispatched');
    const source = JSON.parse(request.options.body), number = Number(source.inventory_track_ref.split(':').at(-1));
    assert.equal(source.revision, '7');
    assert.ok(capture.albums.some(album => album.tracks.some(value => JSON.stringify(value.source) === JSON.stringify(source))), 'exact captured six-field tuple');
    request.resolve(status === 200 ? {status: 'ready', context_ref: context, data: {top_ref: F.TOP, source, native_target: target(number, patch)}}
      : {status: 'error', context_ref: context, error_code: 'item_unavailable'}, status);
  }
  async function accept(work, options) {
    await h.flush(); reply(undefined, options); await h.flush();
    for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
    await h.flush(); const result = await work; assert.equal(result.error, undefined, result.error?.stack); assert.equal(result.value, true);
    return h.engine().roles.current;
  }
  return Object.assign(h, {native, topQueue: queue, createQueue, capture, target, topRequests: requests, replyTop: reply, acceptTop: accept,
    play: () => outcome(native.start(queue))});
}

test('fresh Top resolver gates real native start and ignores captured display paths', async t => {
  const h = await environment(t), pending = h.play(); await h.flush();
  assert.equal(h.platform.contexts.length, 0, 'no audio before fresh authority');
  assert.equal(h.topQueue.currentIndex, 0);
  const path = '/synthetic/fresh/101.flac';
  const role = await h.acceptTop(pending, {patch: {path, track_ref: path}});
  assert.equal(role.track.path, path); assert.equal(h.state.player.current.path, path);
  assert.equal(h.native.hasBinding(h.state.player.current), true);
  assert.equal(h.c.buildPersistedPlayerState(), null);
});

test('repeated paths retain distinct occurrence identity through actual Next and Previous', async t => {
  const h = await environment(t, {repeatedPath: true}); await h.acceptTop(h.play());
  const first = h.state.player.current;
  await h.acceptTop(outcome(h.c.playCompactQueueOffset(1)));
  assert.equal(h.topQueue.currentIndex, 1); assert.notEqual(h.state.player.current, first);
  assert.equal(h.state.player.current.path, first.path);
  await h.acceptTop(outcome(h.c.playCompactQueueOffset(-1)));
  assert.equal(h.topQueue.currentIndex, 0);
  assert.equal(h.topRequests().length, 3, 'each deliberate transition reauthorizes');
});

test('retired mutable aliases remain excluded from persistence after marker removal', async t => {
  const h = await environment(t); await h.acceptTop(h.play());
  const original = h.state.player.current, alias = {...original, coverPath: 'synthetic-cover'};
  assert.equal(h.native.alias(original, alias), true);
  h.state.player.current = alias; h.native.dispose(h.topQueue);
  delete alias.sourceKind; alias.path = '/synthetic/changed.flac';
  assert.equal(h.c.isTopPlaybackBoundPayload(alias), true);
  assert.equal(h.c.buildPersistedPlayerState(), null);
  const count = h.topRequests().length, sockets = h.platform.sockets.length;
  const rejected = await outcome(h.c.playTrackFromPayload(alias));
  assert.equal(rejected.error?.name, 'AbortError');
  assert.equal(h.topRequests().length, count); assert.equal(h.platform.sockets.length, sockets);
});

test('a marked unbound payload cannot enter the native player', async t => {
  const h = await environment(t), count = h.topRequests().length;
  const value = await h.c.playTrackFromPayload({...ordinaryTrack(), sourceKind: 'album-top'});
  assert.equal(value, false); assert.equal(h.platform.contexts.length, 0); assert.equal(h.topRequests().length, count);
});

test('retired Top source remains a closed Queue context without stale media or snapshot exceptions', async t => {
  const h = await environment(t); await h.acceptTop(h.play());
  const count = h.topRequests().length;
  h.native.dispose(h.topQueue);
  const context = h.native.describe(h.topQueue);
  assert.equal(context.ended, true); assert.equal(context.albumComplete, false);
  assert.equal(context.tracks.length, 0); assert.equal(context.nativeTracks.length, 0);
  assert.doesNotThrow(() => h.queue.getSnapshot());
  assert.equal(h.queue.timingOptions().find(value => value.value === 'album').enabled, false);
  assert.equal(h.queueOwner().peek(), null);
  assert.equal(await h.c.playCompactQueueOffset(1), false);
  assert.equal(await h.native.prepareNext(h.topQueue), null);
  assert.equal(h.topRequests().length, count);
});

test('actual paused Top retirement rejects native Play, seek and loop without new audio effects', async t => {
  const h = await environment(t); await h.acceptTop(h.play());
  assert.equal(await h.c.pausePlayerPlaybackForHandoff(), true);
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, true);
  h.native.dispose(h.topQueue); await h.flush();
  const counts = () => [h.platform.contexts.reduce((sum, value) => sum + value.resumeCount, 0),
    h.platform.nodes.reduce((sum, value) => sum + value.sent.length, 0),
    h.platform.sockets.reduce((sum, value) => sum + value.sent.length, 0), h.topRequests().length];
  const before = counts();
  assert.equal(h.c.togglePlayerPlayback(), false);
  assert.equal(h.c.setPlayerPlaybackHead(12), false);
  assert.equal(h.c.setLoopPlaybackHead(12), false);
  assert.equal(h.c.setLoopBoundary('start', 12), false);
  assert.equal(h.c.setLoopActive(true), false);
  assert.equal(h.c.dispatchActiveStreamingLoop(), null);
  await h.flush();
  assert.deepEqual(counts(), before);
  assert.equal(h.engine().roles.current, null); assert.equal(h.engine().roles.continuity, null);
});

for (const buffered of [false, true]) test(`retiring Top clears ${buffered ? 'prepared' : 'deferred'} continuity before stale promotion`, async t => {
  const h = await environment(t), role = await h.acceptTop(h.play());
  frame(h, role); await h.flush();
  const node = h.platform.nodes.at(-1), deliver = node.port.onmessage;
  if (buffered) node.emit({type: 'consumed', generation: role.generation, streamId: role.streamId,
    role: 'current', frames: 0, bufferedFrames: 48000});
  h.replyTop(); await h.flush();
  const next = h.engine().roles.continuity;
  assert.ok(buffered ? next : h.engine().pendingContinuityTrack);
  h.native.dispose(h.topQueue); await h.flush();
  assert.equal(h.engine().roles.current, null); assert.equal(h.engine().roles.continuity, null);
  assert.equal(h.engine().pendingContinuityTrack, null);
  if (next) deliver({data: {type: 'boundary', generation: role.generation, outgoingStreamId: role.streamId,
    incomingStreamId: next.streamId, renderedFrame: 48000}});
  await h.flush();
  assert.equal(h.engine().roles.current, null); assert.equal(h.topQueue.currentIndex, 0);
});

test('retiring a replaced Top cannot close the accepted ordinary successor', async t => {
  const h = await environment(t); await h.acceptTop(h.play());
  const successor = await start(h, ordinaryTrack('Successor')); assert.equal(await successor.work, true);
  const context = h.engine().context, socket = h.engine().socket;
  h.native.dispose(h.topQueue); await h.flush();
  assert.equal(h.engine().roles.current, successor.role);
  assert.equal(h.engine().context, context); assert.equal(h.engine().socket, socket);
  assert.equal(context.closeCount, 0); assert.equal(socket.closeCount, 0);
});

test('retiring Top during pending promotion retires the captured incoming attempt', async t => {
  const h = await environment(t), role = await h.acceptTop(h.play());
  frame(h, role); await h.flush();
  const node = h.platform.nodes.at(-1);
  node.emit({type: 'consumed', generation: role.generation, streamId: role.streamId,
    role: 'current', frames: 0, bufferedFrames: 48000});
  h.replyTop(); await h.flush(); const next = h.engine().roles.continuity; assert.ok(next);
  node.emit({type: 'boundary', generation: role.generation, outgoingStreamId: role.streamId,
    incomingStreamId: next.streamId, renderedFrame: 48000});
  await h.flush(); assert.ok(h.engine().pendingPromotion); assert.equal(h.topQueue.currentIndex, 1);
  h.native.dispose(h.topQueue); await h.flush();
  assert.equal(h.engine().pendingPromotion, null); assert.equal(h.engine().roles.current, null);
  assert.equal(h.engine().pendingContinuityTrack, null); assert.equal(h.topQueue.currentIndex, 1);
});

test('retiring Top during its accepted native replacement cannot promote the new role', async t => {
  const h = await environment(t), role = await h.acceptTop(h.play());
  frame(h, role); await h.flush();
  h.platform.nodes.at(-1).emit({type: 'consumed', generation: role.generation, streamId: role.streamId,
    role: 'current', frames: 0, bufferedFrames: 96000});
  const next = outcome(h.c.playCompactQueueOffset(1)); await h.flush();
  h.replyTop(); await h.flush();
  assert.equal(h.engine().pendingSeek?.kind, 'replacement');
  h.native.dispose(h.topQueue); await h.flush();
  const result = await next; assert.ok(result.error || result.value === false);
  assert.equal(h.engine().roles.current, null); assert.equal(h.engine().roles.continuity, null);
  assert.equal(h.engine().pendingSeek, null); assert.equal(h.topQueue.currentIndex, 0);
});

test('retiring Top while native resume awaits the audio context cannot restart it', async t => {
  const h = await environment(t); await h.acceptTop(h.play());
  assert.equal(await h.c.pausePlayerPlaybackForHandoff(), true);
  h.platform.holds.resume = true;
  const context = h.engine().context, node = h.engine().node;
  assert.equal(h.c.togglePlayerPlayback(), true); await h.flush();
  const resume = context.resumeGate;
  h.native.dispose(h.topQueue); await h.flush();
  const plays = node.sent.filter(value => value.type === 'play').length;
  resume.resolve(); await h.flush();
  assert.equal(node.sent.filter(value => value.type === 'play').length, plays);
  assert.equal(h.engine().roles.current, null);
});

test('live Top native pause and resume retain the same authorized role', async t => {
  const h = await environment(t), role = await h.acceptTop(h.play());
  assert.equal(await h.c.pausePlayerPlaybackForHandoff(), true);
  assert.equal(h.c.togglePlayerPlayback(), true); await h.flush();
  assert.equal(h.engine().roles.current, role);
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, false);
  assert.equal(h.native.isPayloadCurrent(h.state.player.current), true);
});

test('live Top loop and seek keep the existing native owners available', async t => {
  const h = await environment(t);
  assert.equal(h.state.loopCreateAllowed, false, 'the fixture does not grant loop creation by default');
  h.c.applyStatusPayload({allowed_actions: {...h.state.status.allowed_actions, 'library.loops.create': true}});
  assert.equal(h.state.loopCreateAllowed, true, 'the actual status owner applies the scenario grant');
  const role = await h.acceptTop(h.play());
  h.c.setLoopActive(true); await h.flush();
  assert.equal(h.state.player.loopActive, true);
  assert.ok(h.engine().roles.continuity || h.engine().pendingContinuityTrack);
  h.c.setLoopBoundary('start', 2);
  assert.equal(h.state.player.loopStart, 2);
  assert.notEqual(h.c.setLoopPlaybackHead(3), false);
  await h.flush();
  assert.equal(h.native.isPayloadCurrent(h.state.player.current), true);
  assert.equal(h.topQueue.currentIndex, 0);
  assert.equal(role.track.path, h.state.player.current.path);
});

for (const capturedDuration of [null, 90]) test(`measured duration preserves actual decorated Top provenance (${capturedDuration})`, async t => {
  const h = await environment(t);
  assert.equal(h.state.loopCreateAllowed, false, 'the fixture does not grant loop creation by default');
  h.c.applyStatusPayload({allowed_actions: {...h.state.status.allowed_actions, 'library.loops.create': true}});
  assert.equal(h.state.loopCreateAllowed, true, 'the actual status owner applies the scenario grant');
  h.state.modalReleases = [{name: 'Top Album', artist: 'Top Artist', cover_path: '/synthetic/top-cover.jpg',
    tracks: [{path: '/synthetic/top/101.flac'}]}];
  const role = await h.acceptTop(h.play(), {patch: {duration_seconds: capturedDuration}});
  const decorated = h.state.player.current;
  assert.notEqual(decorated, role.track, 'actual native cover owner created the alias');
  assert.equal(decorated.coverPath, '/synthetic/top-cover.jpg');
  h.platform.sockets.at(-1).emit({type: 'metadata', generation: role.generation, streamId: role.streamId,
    role: 'current', sampleRate: 48000, channels: 2, provisionalTotalFrames: 120 * 48000,
    requestedStartFrame: 0, timelineStartFrame: 0});
  assert.equal(h.c.getPlayerDuration(), 120);
  assert.equal(decorated.durationSeconds, role.track.durationSeconds, 'measured presentation does not rewrite fresh authority');
  assert.equal(h.native.isPayloadCurrent(decorated), true);
  assert.equal(await h.c.pausePlayerPlaybackForHandoff(), true);
  assert.equal(h.c.togglePlayerPlayback(), true); await h.flush();
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, false);
  h.c.setLoopActive(true); await h.flush();
  assert.equal(h.state.player.loopEnd, 120);
  assert.equal((h.engine().roles.continuity?.continuityOptions || h.engine().pendingContinuityOptions)?.kind,
    'whole-track-repeat', 'native loop classification uses the measured full range');
  assert.notEqual(h.c.setLoopPlaybackHead(3), false); await h.flush();
  assert.equal(h.native.isPayloadCurrent(decorated), true);
  decorated.path = '/synthetic/changed.flac';
  assert.equal(h.native.isPayloadCurrent(decorated), false, 'media identity remains exact');
});

test('retiring an incoming Top replacement settles the ordinary-to-Top native transaction', async t => {
  const h = await environment(t), ordinary = await start(h, ordinaryTrack('Outgoing'));
  assert.equal(await ordinary.work, true); frame(h, ordinary.role); await h.flush();
  h.platform.nodes.at(-1).emit({type: 'consumed', generation: ordinary.role.generation, streamId: ordinary.role.streamId,
    role: 'current', frames: 0, bufferedFrames: 96000});
  const work = h.play(); await h.flush(); h.replyTop(); await h.flush();
  assert.equal(h.engine().pendingSeek?.kind, 'replacement');
  assert.notEqual(h.engine().roles.continuity?.track, ordinary.role.track);
  h.native.dispose(h.topQueue); await h.flush();
  const result = await work;
  assert.ok(result.error || result.value === false);
  assert.equal(h.engine().pendingSeek, null);
  assert.equal(h.engine().roles.current, null); assert.equal(h.engine().roles.continuity, null);
});

function prepareOrdinaryReplacement(h, role) {
  h.engine().socket.emit({type: 'metadata', generation: role.generation, streamId: role.streamId, role: 'continuity',
    sampleRate: 48000, channels: 2, requestedStartFrame: 0, timelineStartFrame: 0, provisionalTotalFrames: 90 * 48000});
  for (let packet = 0; packet < 2; packet++) {
    const Buffer = h.owner('ArrayBuffer'), data = new Buffer(24 + 48000 * 8), view = new DataView(data);
    [65, 72, 80, 67].forEach((byte, index) => view.setUint8(index, byte));
    view.setUint8(4, 1); view.setUint8(5, 1);
    view.setUint32(8, role.generation); view.setUint32(12, role.streamId);
    view.setUint32(16, role.nextSequence); view.setUint32(20, 48000);
    h.engine().socket.onmessage({data});
  }
  assert.equal(h.engine().pendingSeek.prepareSent, true, 'actual bounded PCM prepared the incoming role');
}

for (const replacement of [false, true]) for (const pause of [false, true])
  test(`Top retirement preserves ordinary ${replacement ? 'replacement' : 'cushion wait'} with pause=${pause}`, async t => {
    const h = await environment(t), outgoing = await h.acceptTop(h.play());
    frame(h, outgoing); await h.flush();
    if (replacement) h.engine().node.emit({type: 'consumed', generation: outgoing.generation, streamId: outgoing.streamId,
      role: 'current', frames: 0, bufferedFrames: 96000});
    const payload = ordinaryTrack('Incoming'), work = outcome(h.c.playTrackFromPayload(payload)); await h.flush();
    const attempt = h.engine().playbackAttempt, node = h.engine().node, context = h.engine().context;
    const incoming = h.engine().roles.continuity;
    assert.ok(replacement ? h.engine().pendingSeek : h.engine().replacementCushionWaiter);
    if (replacement) {
      const transaction = h.engine().pendingSeek;
      assert.equal(h.native.configure(h.topQueue, {mode: 'random_albums'}), false);
      assert.equal(h.engine().pendingSeek, transaction);
      assert.equal(h.engine().roles.continuity, incoming, 'mode change cannot close an admitted different-source replacement');
      assert.throws(() => h.queue.setEnabled(false), /current track transition/);
      assert.equal(await h.owner('ExplicitQueueRuntime').prepareNext(), null);
      assert.equal(h.engine().pendingSeek, transaction); assert.equal(h.engine().roles.continuity, incoming);
      const requests = h.topRequests().length;
      assert.equal(await h.c.playCompactQueueOffset(1), false, 'Top preflight cannot orphan another admitted replacement');
      assert.equal(h.topRequests().length, requests);
      assert.equal(h.engine().pendingSeek, transaction); assert.equal(h.engine().roles.continuity, incoming);
    }
    const plays = node.sent.filter(value => value.type === 'play').length;
    h.native.dispose(h.topQueue);
    assert.equal(h.engine().playbackAttempt, attempt);
    assert.equal(h.engine().snapshot.paused, true);
    assert.equal(node.sent.filter(value => value.type === 'play').length, plays);
    const pauseWork = pause ? h.c.pausePlayerPlaybackForHandoff() : null;
    if (replacement) {
      assert.equal(context.state, 'running'); prepareOrdinaryReplacement(h, incoming);
      node.emit({type: 'seek-boundary', generation: incoming.generation, outgoingStreamId: outgoing.streamId,
        incomingStreamId: incoming.streamId, timelineFrame: 0, renderedFrame: 48000});
    }
    assert.equal((await work).value, true); await h.flush();
    if (pauseWork) assert.equal(await pauseWork, true, 'actual native pause reaches the admitted handoff');
    assert.equal(h.engine().roles.current.track, payload);
    assert.equal(h.state.player.current.path, payload.path);
    assert.equal(h.engine().playbackAttempt, attempt);
    assert.equal(h.engine().snapshot.paused, pause);
    assert.equal(context.closeCount, 0);
    assert.equal(h.native.isPayloadCurrent(outgoing.track), false);
  });

for (const replacement of [false, true]) test(`native pause fences awaited ${replacement ? 'promoted' : 'cold-start'} resume after Top retirement`, async t => {
  const h = await environment(t), outgoing = await h.acceptTop(h.play());
  frame(h, outgoing); await h.flush();
  if (replacement) h.engine().node.emit({type: 'consumed', generation: outgoing.generation, streamId: outgoing.streamId,
    role: 'current', frames: 0, bufferedFrames: 96000});
  const payload = ordinaryTrack('PausedIncoming'), work = outcome(h.c.playTrackFromPayload(payload)); await h.flush();
  const incoming = h.engine().roles.continuity, context = h.engine().context, node = h.engine().node;
  const previousResume = context.resumeGate, plays = node.sent.filter(value => value.type === 'play').length;
  h.platform.holds.resume = true;
  h.native.dispose(h.topQueue);
  if (replacement) {
    prepareOrdinaryReplacement(h, incoming);
    node.emit({type: 'seek-boundary', generation: incoming.generation, outgoingStreamId: outgoing.streamId,
      incomingStreamId: incoming.streamId, timelineFrame: 0, renderedFrame: 48000});
  }
  await h.flush();
  const resume = context.resumeGate;
  assert.notEqual(resume, previousResume);
  assert.equal(h.engine().roles.current.track, payload);
  assert.equal(await h.c.pausePlayerPlaybackForHandoff(), true, 'actual facade reaches the still-pending automatic resume');
  resume.resolve(); await h.flush();
  assert.equal((await work).value, true);
  assert.equal(h.state.player.current.path, payload.path);
  assert.equal(h.engine().snapshot.paused, true);
  assert.equal(node.sent.filter(value => value.type === 'play').length, plays);
  h.platform.holds.resume = false;
  assert.equal(h.c.togglePlayerPlayback(), true); await h.flush();
  assert.equal(h.engine().snapshot.paused, false);
  assert.equal(h.engine().roles.current.track, payload);
});

test('current session change rejects late fresh target without native admission', async t => {
  const h = await environment(t), pending = h.play(); await h.flush();
  const request = h.topRequests().at(-1); h.change('context'); h.replyTop(request);
  const result = await pending;
  assert.equal(result.error?.name, 'AbortError'); assert.equal(h.platform.contexts.length, 0);
});

test('new ordinary selection wins over a pending Top fresh resolver', async t => {
  const h = await environment(t), pending = h.play(); await h.flush();
  const request = h.topRequests().at(-1), successor = await start(h, ordinaryTrack('Successor'));
  assert.equal(await successor.work, true); h.replyTop(request);
  const result = await pending;
  assert.equal(result.error?.name, 'AbortError'); assert.equal(h.state.player.current.path, successor.payload.path);
  assert.equal(h.engine().roles.current, successor.role);
});

test('a newer native Next owns the pending occurrence without double advancement', async t => {
  const h = await environment(t); await h.acceptTop(h.play());
  const first = outcome(h.c.playCompactQueueOffset(1)); await h.flush();
  const stale = h.topRequests().at(-1);
  const second = outcome(h.c.playCompactQueueOffset(1)); await h.flush();
  assert.notEqual(h.topRequests().at(-1), stale);
  h.replyTop(stale);
  await h.acceptTop(second);
  const superseded = await first;
  assert.equal(superseded.error?.name, 'AbortError');
  assert.equal(h.topQueue.currentIndex, 1);
  assert.match(h.state.player.current.path, /102\.flac$/);
});

test('new Top intent fences an older ordinary start that has not received its native role yet', async t => {
  const h = await environment(t), payload = ordinaryTrack('Older');
  h.platform.holds.module = true;
  let olderSettled = false;
  const older = outcome(h.c.playTrackFromPayload(payload)).then(value => {olderSettled = true; return value;});
  await h.flush();
  const preparation = h.platform.contexts.at(-1);
  assert.ok(preparation, 'ordinary start reached the actual AudioWorklet module gate');
  assert.equal(h.engine().roles.current, null, 'held module preparation cannot publish a native role');
  assert.equal(olderSettled, false, 'the older selection is still pending when Top intent arrives');
  const pending = h.play(); await h.flush();
  h.platform.holds.module = false; preparation.module.resolve(); await h.flush();
  for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
  await h.flush();
  const stale = await older; assert.equal(stale.value, false);
  assert.notEqual(h.state.player.current?.path, payload.path);
  await h.acceptTop(pending);
  assert.equal(h.state.player.playbackQueue, h.topQueue);
  assert.match(h.state.player.current.path, /101\.flac$/);
});

test('failed overlapping Top starts restore the original queue rather than a retired pending owner', async t => {
  const h = await environment(t), ordinary = await start(h, ordinaryTrack('Existing'));
  assert.equal(await ordinary.work, true);
  const previous = h.state.player.playbackQueue;
  const first = h.play(); await h.flush(); const firstRequest = h.topRequests().at(-1);
  const replacement = h.createQueue(), second = outcome(h.native.start(replacement)); await h.flush();
  h.replyTop(firstRequest); await first;
  h.replyTop(undefined, {status: 403}); const rejected = await second;
  assert.ok(rejected.error);
  assert.equal(h.state.player.playbackQueue, previous);
  assert.equal(h.engine().roles.current, ordinary.role);
});

test('a captured Top start is admitted only once while its first resolver is pending', async t => {
  const h = await environment(t), pending = h.play(); await h.flush();
  assert.equal(await h.native.start(h.topQueue), false);
  assert.equal(h.topRequests().length, 1);
  await h.acceptTop(pending);
  assert.equal(h.state.player.playbackQueue, h.topQueue);
});

test('partial captured album never advertises complete-album Queue timing', async t => {
  const h = await environment(t, {partial: true}); await h.acceptTop(h.play());
  const context = h.native.describe(h.topQueue);
  assert.equal(context.albumComplete, false);
  const planner = h.c.createExplicitQueuePlanner();
  const option = planner.timingOptions(context).find(value => value.value === 'album');
  assert.equal(option.enabled, false); assert.match(option.reason, /only part/);
});

test('classified unavailable start skips the captured occurrence without using its media', async t => {
  const h = await environment(t), pending = h.play(); await h.flush();
  h.replyTop(undefined, {status: 404}); await h.flush();
  assert.equal(h.topRequests().length, 2);
  assert.equal(JSON.parse(h.topRequests()[1].options.body).inventory_track_ref.endsWith(':102'), true);
  await h.acceptTop(pending);
  assert.equal(h.topQueue.currentIndex, 1); assert.match(h.state.player.current.path, /102\.flac$/);
  assert.equal(h.platform.sockets.length, 1, 'unavailable captured media never opens a decoder');
  assert.equal(h.native.describe(h.topQueue).albumCaptureComplete, true);
  assert.equal(h.native.describe(h.topQueue).albumComplete, false);
  assert.equal(h.queue.timingOptions().find(value => value.value === 'album').enabled, false);
});

test('actual continuity promotion commits only its prepared Top occurrence', async t => {
  const h = await environment(t), role = await h.acceptTop(h.play());
  frame(h, role); await h.flush();
  assert.equal(h.topQueue.currentIndex, 0, 'preparation cannot advance history');
  h.platform.nodes.at(-1).emit({type: 'consumed', generation: role.generation, streamId: role.streamId,
    role: 'current', frames: 0, bufferedFrames: 48000});
  h.replyTop(); await h.flush();
  const next = h.engine().roles.continuity;
  assert.ok(next, 'actual continuity decoder receives the fresh native target');
  assert.equal(h.topQueue.currentIndex, 0);
  h.platform.nodes.at(-1).emit({type: 'boundary', generation: role.generation, outgoingStreamId: role.streamId,
    incomingStreamId: next.streamId, renderedFrame: 48000});
  await h.flush();
  assert.equal(h.engine().roles.current, next); assert.equal(h.state.player.current.path, next.track.path);
  assert.equal(h.topQueue.currentIndex, 1);
  assert.equal(h.topRequests().length, 3, 'promoted role prepares the following occurrence despite its historical boundary flag');
  assert.ok(h.engine().pendingPromotion);
  assert.equal(await h.c.playCompactQueueOffset(1), false);
  assert.equal(h.native.configure(h.topQueue, {mode: 'random_songs'}), false);
  assert.equal(h.topRequests().length, 3, 'manual actions cannot retire an in-flight native promotion');
  h.replyTop(); await h.flush();
  assert.match(h.engine().pendingContinuityTrack?.path || '', /103\.flac$/);
  h.platform.nodes.at(-1).emit({type: 'consumed', generation: next.generation, streamId: next.streamId,
    role: 'current', frames: 0, bufferedFrames: 48000});
  h.platform.sockets.at(-1).emit({type: 'promoted', generation: next.generation, streamId: next.streamId, role: 'current'});
  await h.flush();
  assert.match(h.engine().roles.continuity?.track.path || '', /103\.flac$/);
  const snapshot = await Q.admit(h, Q.ready({presentation: 'tracks'}));
  const admitted = await Q.enqueue(h, snapshot, {indices: [0], timing: 'next'});
  assert.equal(admitted.ids.length, 1, 'a completed Top promotion does not permanently lock Queue editing');
});

test('Stop after current album prevents automatic preload and preserves deliberate Next', async t => {
  const h = await environment(t, {blocks: [[101], [102]]}), role = await h.acceptTop(h.play());
  assert.equal(h.native.configure(h.topQueue, {stopAfterAlbum: true}), true);
  frame(h, role); await h.flush();
  assert.equal(h.topRequests().length, 1); assert.equal(h.engine().roles.continuity, null);
  h.platform.nodes.at(-1).emit({type: 'ended', generation: role.generation, streamId: role.streamId, timelineFrame: 48000});
  await h.flush(); assert.equal(h.state.player.playbackQueue, h.topQueue);
  await h.acceptTop(outcome(h.c.playCompactQueueOffset(1)));
  assert.equal(h.topQueue.currentIndex, 1); assert.match(h.state.player.current.path, /102\.flac$/);
});

test('mode edits preserve the native role and visited prefix after Previous', async t => {
  const h = await environment(t, {blocks: [[101, 102], [103, 104], [105]]});
  await h.acceptTop(h.play()); await h.acceptTop(outcome(h.c.playCompactQueueOffset(1)));
  await h.acceptTop(outcome(h.c.playCompactQueueOffset(-1)));
  const role = h.engine().roles.current, current = h.state.player.current;
  const prefix = Array.from(h.native.describe(h.topQueue).tracks.slice(0, 2));
  assert.equal(h.native.configure(h.topQueue, {mode: 'random_songs'}), true);
  assert.deepEqual(Array.from(h.native.describe(h.topQueue).tracks.slice(0, 2)), prefix);
  assert.equal(h.engine().roles.current, role); assert.equal(h.state.player.current, current);
  assert.equal(h.topQueue.currentIndex, 0);
});

test('automatic Stop precedes injected Queue, preserves its entry, and deliberate Next returns to fresh Top authority', async t => {
  const h = await environment(t, {blocks: [[101], [102]]}), role = await h.acceptTop(h.play());
  assert.equal(h.native.configure(h.topQueue, {stopAfterAlbum: true}), true);
  const snapshot = await Q.admit(h, Q.ready({presentation: 'tracks'}));
  const admitted = await Q.enqueue(h, snapshot, {indices: [0], timing: 'next'});
  assert.equal(admitted.ids.length, 1); assert.equal(h.queue.getSnapshot().entries.length, 1);
  frame(h, role); await h.flush();
  assert.equal(h.engine().roles.continuity, null);
  assert.equal(h.topRequests().length, 1);
  h.platform.nodes.at(-1).emit({type: 'ended', generation: role.generation, streamId: role.streamId, timelineFrame: 48000});
  await h.flush();
  assert.equal(h.queue.getSnapshot().entries.length, 1, 'automatic Stop consumes no injected request');
  assert.equal(h.state.player.playbackQueue, h.topQueue);
  const injected = outcome(h.c.playCompactQueueOffset(1)); await h.flush();
  h.replyTop(); await h.flush();
  const requestIndex = h.requests.findIndex(request => !request.settled && new URL(request.url, h.location).pathname === '/search/native-targets');
  assert.ok(requestIndex >= 0, 'deliberate Queue admission resolves its own source');
  assert.equal(Q.batchCommand(h, requestIndex).intent, 'play');
  h.reply(requestIndex, Q.batchReply(h, requestIndex)); await h.flush();
  for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
  await h.flush();
  const injectedResult = await injected;
  assert.equal(injectedResult.error, undefined, injectedResult.error?.stack); assert.equal(injectedResult.value, true);
  assert.ok(h.state.player.current.explicitEntryId);
  assert.equal(h.queueOwner().referencesOrdinaryQueue(h.topQueue), true);
  const injectedRole = h.engine().roles.current, injectedQueue = h.state.player.playbackQueue;
  assert.equal(h.native.configure(h.topQueue, {mode: 'random_songs'}), true);
  assert.equal(h.engine().roles.current, injectedRole); assert.equal(h.state.player.playbackQueue, injectedQueue);
  assert.equal(h.queueOwner().referencesOrdinaryQueue(h.topQueue), true, 'mode edit retains the actual explicit return owner');
  const returning = outcome(h.c.playCompactQueueOffset(1)); await h.flush();
  const before = h.topRequests().length; h.replyTop(); await h.flush();
  assert.equal(h.topRequests().length, before + 1, 'native start reauthorizes the prepared explicit return');
  h.replyTop(); await h.flush();
  for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
  await h.flush();
  const returned = await returning;
  assert.equal(returned.error, undefined, returned.error?.stack); assert.equal(returned.value, true);
  assert.equal(h.state.player.playbackQueue, h.topQueue); assert.equal(h.topQueue.currentIndex, 1);
  assert.equal(h.queue.getSnapshot().entries.length, 0);
  assert.equal(h.native.hasBinding(h.state.player.current), true);
});

for (const status of [403, 409, 502]) test(`fresh refusal ${status} cannot skip or replace the audible Top occurrence`, async t => {
  const h = await environment(t), role = await h.acceptTop(h.play()), current = h.state.player.current;
  const pending = outcome(h.c.playCompactQueueOffset(1)); await h.flush();
  h.replyTop(undefined, {status});
  const result = await pending;
  assert.ok(result.error || result.value === false);
  assert.equal(h.topRequests().length, 2); assert.equal(h.topQueue.currentIndex, 0);
  assert.equal(h.engine().roles.current, role); assert.equal(h.state.player.current, current);
});

test('invalid and no-op mode changes preserve the prepared native successor', async t => {
  const h = await environment(t), role = await h.acceptTop(h.play());
  frame(h, role); await h.flush();
  h.platform.nodes.at(-1).emit({type: 'consumed', generation: role.generation, streamId: role.streamId,
    role: 'current', frames: 0, bufferedFrames: 48000});
  h.replyTop(); await h.flush(); const prepared = h.engine().roles.continuity;
  assert.ok(prepared);
  assert.equal(h.native.configure(h.topQueue, {mode: 'most_popular'}), false);
  assert.equal(h.native.configure(h.topQueue, {stopAfterAlbum: 'yes'}), false);
  assert.equal(h.native.configure(h.topQueue, {mode: 'in_order', stopAfterAlbum: false}), true);
  assert.equal(h.engine().roles.continuity, prepared);
  assert.equal(h.topRequests().length, 2);
});

test('actual injected Queue continuity returns to the exact prepared Top occurrence', async t => {
  const h = await environment(t), original = await h.acceptTop(h.play());
  frame(h, original); await h.flush();
  h.platform.nodes.at(-1).emit({type: 'consumed', generation: original.generation, streamId: original.streamId,
    role: 'current', frames: 0, bufferedFrames: 48000});
  h.replyTop(); await h.flush(); assert.ok(h.engine().roles.continuity);
  const snapshot = await Q.admit(h, Q.ready({presentation: 'tracks'}));
  await Q.enqueue(h, snapshot, {indices: [0], timing: 'next'});
  h.replyTop(); await h.flush();
  const request = h.requests.findIndex(value => !value.settled && new URL(value.url, h.location).pathname === '/search/native-targets');
  assert.ok(request >= 0); assert.equal(Q.batchCommand(h, request).intent, 'play');
  h.reply(request, Q.batchReply(h, request)); await h.flush();
  const injected = h.engine().roles.continuity; assert.ok(injected?.track.explicitEntryId);
  h.platform.nodes.at(-1).emit({type: 'boundary', generation: original.generation, outgoingStreamId: original.streamId,
    incomingStreamId: injected.streamId, renderedFrame: 48000});
  await h.flush();
  assert.equal(h.engine().roles.current, injected); assert.ok(h.state.player.current.explicitEntryId);
  assert.equal(h.topQueue.currentIndex, 0, 'injection does not consume the retained Top successor');
  assert.equal(h.queueOwner().referencesOrdinaryQueue(h.topQueue), true);
  h.replyTop(); await h.flush();
  h.platform.nodes.at(-1).emit({type: 'consumed', generation: injected.generation, streamId: injected.streamId,
    role: 'current', frames: 0, bufferedFrames: 48000});
  h.platform.sockets.at(-1).emit({type: 'promoted', generation: injected.generation, streamId: injected.streamId, role: 'current'});
  await h.flush();
  const returned = h.engine().roles.continuity; assert.ok(returned); assert.match(returned.track.path, /102\.flac$/);
  assert.equal(h.topQueue.currentIndex, 0);
  h.platform.nodes.at(-1).emit({type: 'boundary', generation: injected.generation, outgoingStreamId: injected.streamId,
    incomingStreamId: returned.streamId, renderedFrame: 96000});
  await h.flush();
  assert.equal(h.engine().roles.current, returned); assert.equal(h.state.player.playbackQueue, h.topQueue);
  assert.equal(h.topQueue.currentIndex, 1); assert.equal(h.queue.getSnapshot().entries.length, 0);
});

for (const stopping of [false, true]) test(`freshly missing album tail handles captured Queue anchor with Stop ${stopping}`, async t => {
  const h = await environment(t), role = await h.acceptTop(h.play());
  if (stopping) assert.equal(h.native.configure(h.topQueue, {stopAfterAlbum: true}), true);
  else frame(h, role);
  await h.flush();
  assert.equal(h.topRequests().filter(request => !request.settled).length, 1, 'the actual mode/first-frame owner prepares one successor');
  h.platform.nodes.at(-1).emit({type: 'consumed', generation: role.generation, streamId: role.streamId,
    role: 'current', frames: 0, bufferedFrames: 48000});
  h.replyTop(); await h.flush();
  const snapshot = await Q.admit(h, Q.ready({presentation: 'tracks'}));
  await Q.enqueue(h, snapshot, {indices: [0], timing: 'album'});
  h.replyTop(undefined, {status: 404}); await h.flush();
  assert.equal(h.queue.timingOptions().find(value => value.value === 'album').enabled, false,
    'new complete-album requests are unavailable after fresh rejection');
  assert.doesNotMatch(h.queue.getSnapshot().entries[0].status, /^Unavailable/,
    'the previously captured complete anchor remains owned');
  if (stopping) {
    assert.equal(h.engine().roles.continuity, null);
    assert.equal(h.queue.getSnapshot().entries.length, 1);
    assert.equal(h.requests.some(request => !request.settled && new URL(request.url, h.location).pathname === '/search/native-targets'), false);
  } else {
    assert.equal(JSON.parse(h.topRequests().at(-1).options.body).inventory_track_ref.endsWith(':103'), true);
    h.replyTop(); await h.flush();
    const index = h.requests.findIndex(request => !request.settled && new URL(request.url, h.location).pathname === '/search/native-targets');
    assert.ok(index >= 0, 'proven forward album crossing releases the existing album anchor');
    assert.equal(Q.batchCommand(h, index).intent, 'play');
    h.reply(index, Q.batchReply(h, index)); await h.flush();
    assert.ok(h.engine().roles.continuity?.track.explicitEntryId);
  }
  assert.equal(h.topQueue.currentIndex, 0, 'a skipped unavailable tail receives no played cursor credit');
});
