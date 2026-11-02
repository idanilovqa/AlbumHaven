'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {scenario, track, plain, frame, F} = require('./completed-context-fixtures.cjs');

function album(h) {
  const rows = ['First', 'Last'].map((name, index) => ({...track(name), album: 'Completed Album',
    artist: 'Album Artist', duration_seconds: 90, track: index + 1, track_number: index + 1,
    inventory_track_ref: `inventory-track:${h.shell.dataset.nativeLibraryId}:${101 + index}`,
    canonical_track_ref: `canonical-${101 + index}`, availability: 'local', source_readable: true,
    allowed_actions: {can_read: true, can_play: true}, playback_state: {can_start_here: true}}));
  const value = {key: 'completed-album', name: 'Completed Album', album_artist: 'Album Artist',
    tracks: rows, track_rows: rows, source_readable: true,
    allowed_actions: {can_read: true, can_play_album: true}};
  const queue = h.c.buildAlbumPlaybackQueueState(value, rows.at(-1).path);
  assert.ok(queue && queue.tracks.length === 2, 'actual album queue builder retains both occurrences');
  return {queue, value, first: queue.tracks[0], last: queue.tracks.at(-1)};
}
function playlist(h, {generated = false, duplicate = false, shuffled = false, repeat = 'off'} = {}) {
  const regularTracks = ['First', 'Middle', 'Last'].map((name, index) => ({...track(name), playlistItemId: F.id(101 + index)}));
  if (duplicate) Object.assign(regularTracks[2], {path: regularTracks[0].path, src: regularTracks[0].src});
  // This is a retained pre-start native queue dataset, not a replay-time reshuffle.
  const tracks = shuffled ? [regularTracks[1], regularTracks[0], regularTracks[2]] : regularTracks;
  const queue = {tracks, regularTracks, currentIndex: tracks.length - 1, shuffle: shuffled,
    repeatMode: repeat, playlistId: generated ? null : F.id(80), playlistRevision: F.id(81),
    displayedItemIds: regularTracks.map(row => row.playlistItemId),
    contextGeneration: h.c.AlbumHavenPrivateUITransport.generation(),
    ...(generated ? {libraryMixRef: F.id(82), libraryMixProtocol: 'library_mix_selection_v1',
      sourceEntryRefs: regularTracks.map(row => row.playlistItemId)} : {})};
  return {queue, first: tracks[0], last: tracks.at(-1)};
}
async function completed(h, data) {
  h.state.player.playbackQueue = data.queue;
  await h.complete(h.select(data.last));
  const session = h.state.player.listenSession;
  await h.finish();
  assert.strictEqual(h.state.player.current, data.last);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null, 'terminal current claim is released');
  return {data, session};
}
function freshRequest(h, data, since) {
  const matches = h.requests.slice(since).filter(row => {
    const path = new URL(row.url, h.location).pathname;
    return data.value ? path === '/album-details'
      : data.queue.libraryMixRef ? path.endsWith('/library-mix/native-queue')
        : path.endsWith(`/items/${data.first.playlistItemId}/native-target`);
  });
  assert.equal(matches.length, 1, 'Play after completion freshly authorizes the FIRST effective occurrence');
  const request = matches[0];
  assert.ok(request.options.signal, 'fresh replay resolve owns an abortable request');
  assert.equal(request.options.signal.aborted, false);
  return request;
}
function respond(h, data, request, patch = {}) {
  if (data.value) return request.resolve({ok: true, album: {...data.value, ...patch}});
  const target = row => ({path: row.path, playlist_item_id: row.playlistItemId, title: row.title,
    artist: row.artist, album_title: row.album, duration_seconds: row.durationSeconds,
    availability: 'local', source_readable: true, allowed_actions: {can_read: true, can_play: true}});
  const value = data.queue.libraryMixRef ? {
    source_protocol: data.queue.libraryMixProtocol,
    source: {kind: 'library', ref: data.queue.libraryMixRef, revision: data.queue.playlistRevision},
    starting_item_ref: data.first.playlistItemId,
    tracks: data.queue.sourceEntryRefs.map(id => {
      const row = data.queue.regularTracks.find(row => row.playlistItemId === id);
      return {playlist_item_id: id, native_target: target(row)};
    }), unavailable_item_refs: [], ...patch,
  } : {playlist_id: data.queue.playlistId, playlist_item_id: data.first.playlistItemId,
    revision: data.queue.playlistRevision, intent: 'play', native_target: target(data.first), ...patch};
  request.resolve({status: 'ready', context_ref: h.c.AlbumHavenPrivateUITransport.context(), data: value});
}
async function beginReplay(h, data) {
  const since = h.requests.length, replay = await h.replay();
  const request = freshRequest(h, data, since);
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, true, 'metadata does not restart old final track');
  return {replay, request};
}
async function acceptReplay(h, data, pending, rejectedCall = null) {
  respond(h, data, pending.request); await h.flush(); await h.open();
  const observed = pending.replay.starts();
  if (rejectedCall) {
    assert.equal(observed.length, 2, 'exactly the known rejected call followed by one replay call');
    assert.strictEqual(observed[0], rejectedCall, 'the rejected call remains visible in the full observation');
    const result = await rejectedCall.work;
    assert.equal(result.error, undefined, result.error?.stack);
    assert.equal(result.value, false);
  }
  const starts = rejectedCall ? observed.slice(1) : observed;
  assert.equal(starts.length, 1, 'one actual replay facade start');
  await h.complete(starts[0].work);
  assert.equal(h.state.player.current.path, data.first.path);
  if (data.first.playlistItemId) assert.equal(h.state.player.current.playlistItemId, data.first.playlistItemId);
  assert.equal(h.state.player.playbackQueue.currentIndex, 0);
  assert.equal(h.c.getPlayerPlaybackSnapshot().currentTime, 0);
  assert.equal(h.queueOwner().hasPendingStart(), false, 'accepted start has left pendingStart');
  assert.ok(h.c.getActivePlaybackOwnershipHandle());
  assert.equal(h.c.currentPlayerSelection(h.owner('playerSelectionOwnership')), true,
    'accepted native guard is current after pendingStart cleanup');
  assert.strictEqual(h.engine().roles.current.track, h.state.player.current);
  assert.equal(h.platform.contexts.filter(value => value.state === 'running').length, 1);
}
function metadata(h, role) {
  h.engine().socket.emit({type: 'metadata', generation: role.generation, streamId: role.streamId,
    role: role.role, sampleRate: 48000, channels: 2, requestedStartFrame: role.startFrame,
    timelineStartFrame: role.startFrame, provisionalTotalFrames: 90 * 48000});
}
async function promoteNext(h) {
  const outgoing = h.engine().roles.current;
  metadata(h, outgoing); frame(h, outgoing); await h.flush();
  // The decoder's real EOS protocol opens the protected continuity window; no
  // diagnostics, roles, receipt registry or callback guard is assigned by this test.
  h.engine().socket.emit({type: 'eos', generation: outgoing.generation, streamId: outgoing.streamId,
    role: 'current', emittedFrames: 90 * 48000, authoritativeTotalFrames: 90 * 48000});
  await h.flush();
  const incoming = h.engine().roles.continuity;
  assert.ok(incoming, 'actual first-frame and decoder EOS prepare the next native occurrence');
  metadata(h, incoming);
  h.engine().node.emit({type: 'boundary', generation: outgoing.generation,
    outgoingStreamId: outgoing.streamId, incomingStreamId: incoming.streamId,
    timelineFrame: 0, renderedFrame: 90 * 48000});
  await h.flush();
  h.engine().socket.emit({type: 'promoted', generation: incoming.generation,
    streamId: incoming.streamId, role: 'current'});
  await h.flush();
  assert.strictEqual(h.engine().roles.current, incoming);
  assert.strictEqual(h.state.player.current, incoming.track);
  assert.ok(h.c.getActivePlaybackOwnershipHandle(), 'claim follows actual promoted attempt');
  return incoming;
}

test('CC control 01 paused Play resumes the same song and position without a refresh', async t => scenario(t, async h => {
  const data = album(h); h.state.player.playbackQueue = data.queue;
  await h.complete(h.select(data.last)); const role = h.engine().roles.current;
  h.engine().node.emit({type: 'position', generation: role.generation, streamId: role.streamId, timelineFrame: 7 * 48000});
  assert.equal(h.c.togglePlayerPlayback(), true); await h.flush();
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, true);
  const before = h.starts.length, requests = h.requests.length;
  assert.equal(h.c.togglePlayerPlayback(), true); await h.flush();
  assert.strictEqual(h.engine().roles.current, role);
  assert.equal(h.c.getPlayerPlaybackSnapshot().currentTime, 7);
  assert.equal(h.starts.length, before);
  assert.equal(h.requests.slice(requests).some(row => new URL(row.url, h.location).pathname === '/album-details'), false);
}));

test('CC control 02 a genuine standalone completed song restarts itself at zero', async t => scenario(t, async h => {
  const song = track('Single'); await h.complete(h.select(song)); await h.finish();
  const replay = await h.replay(); await h.open();
  assert.equal(replay.starts().length, 1); await h.complete(replay.starts()[0].work);
  assert.equal(h.state.player.current.path, song.path);
  assert.equal(h.c.getPlayerPlaybackSnapshot().currentTime, 0);
}));

test('CC 03 completed album Play reauthorizes first track and does not credit unheard audio', async t => scenario(t, async h => {
  const data = album(h), {session} = await completed(h, data);
  const pending = await beginReplay(h, data); await acceptReplay(h, data, pending);
  assert.equal(session.measurement.total, 0, 'terminal state is not rendered-PCM listening evidence');
  assert.equal(h.state.player.listenSession.measurement.total, 0, 'restart itself creates no listening credit');
  for (const row of h.requests.filter(row => row.url.includes('/playback/session/complete'))) {
    const body = JSON.parse(row.options.body);
    assert.equal(body.measured_listened_seconds, 0);
    assert.equal(body.max_measured_contiguous_seconds, 0);
  }
}));

test('CC 04 completed saved Playlist restarts first occurrence despite a duplicate final path', async t => scenario(t, async h => {
  const data = playlist(h, {duplicate: true}); await completed(h, data);
  const order = data.queue.tracks, pending = await beginReplay(h, data);
  assert.notEqual(data.first.playlistItemId, data.last.playlistItemId);
  await acceptReplay(h, data, pending);
  assert.strictEqual(h.state.player.playbackQueue.tracks, order);
}));

for (const generated of [false, true]) test(`CC ${generated ? '06' : '05'} completed ${generated ? 'generated Mix' : 'saved Playlist'} keeps its retained shuffled order`, async t => scenario(t, async h => {
  const data = playlist(h, {generated, shuffled: true}); await completed(h, data);
  const order = data.queue.tracks, ids = order.map(row => row.playlistItemId);
  const pending = await beginReplay(h, data);
  if (generated) {
    const body = JSON.parse(pending.request.options.body);
    assert.deepEqual(body.entry_refs, plain(data.queue.sourceEntryRefs));
    assert.equal(body.starting_entry_ref, data.first.playlistItemId);
  }
  await acceptReplay(h, data, pending);
  assert.strictEqual(h.state.player.playbackQueue.tracks, order);
  assert.deepEqual(plain(order.map(row => row.playlistItemId)), plain(ids));
}));

test('CC 07 repeated Play shares one held replay request and one accepted start', async t => scenario(t, async h => {
  const data = album(h); await completed(h, data);
  const pending = await beginReplay(h, data), before = h.requests.length;
  await h.replay(); await h.replay();
  assert.equal(h.requests.length, before); assert.equal(pending.request.options.signal.aborted, false);
  await acceptReplay(h, data, pending);
}));

test('CC 08 a newer valid selection aborts held replay before its response and cannot be rolled back', async t => scenario(t, async h => {
  const data = album(h); await completed(h, data); const pending = await beginReplay(h, data);
  const newer = track('Newer'), selected = h.select(newer);
  assert.equal(pending.request.options.signal.aborted, true, 'cancellation is synchronous before provider settlement');
  await h.complete(selected); const handle = h.c.getActivePlaybackOwnershipHandle();
  respond(h, data, pending.request); await h.flush();
  assert.strictEqual(h.state.player.current, newer);
  assert.strictEqual(h.c.getActivePlaybackOwnershipHandle(), handle);
  assert.equal(h.queueOwner().hasPendingStart(), false);
}));

test('CC 09 an invalid click does not cancel a valid held replay', async t => scenario(t, async h => {
  const data = album(h); await completed(h, data); const pending = await beginReplay(h, data);
  assert.equal(pending.replay.starts().length, 0, 'held metadata has not invoked replay yet');
  const invalid = {path: '', src: ''};
  const resources = [h.streams.length, h.platform.contexts.length, h.platform.nodes.length, h.platform.sockets.length];
  const result = await h.select(invalid); assert.equal(result.value, false);
  assert.equal(result.error, undefined, result.error?.stack);
  const rejected = pending.replay.starts();
  assert.equal(rejected.length, 1, 'the deliberate invalid click is observed exactly once');
  assert.strictEqual(rejected[0].args[0], invalid);
  assert.deepEqual([h.streams.length, h.platform.contexts.length, h.platform.nodes.length, h.platform.sockets.length],
    resources, 'the rejected click starts no stream and allocates no playback resource');
  assert.equal(pending.request.options.signal.aborted, false);
  await acceptReplay(h, data, pending, rejected[0]);
  const sequence = pending.replay.starts();
  assert.equal(sequence.length, 2, 'full sequence contains rejected one plus accepted replay one');
  assert.strictEqual(sequence[0], rejected[0]);
  assert.equal((await sequence[0].work).value, false);
  assert.equal((await sequence[1].work).value, true);
}));

test('CC 10 denied first occurrence never substitutes last track and safe retry performs a fresh read', async t => scenario(t, async h => {
  const data = album(h); await completed(h, data); const pending = await beginReplay(h, data);
  respond(h, data, pending.request, {track_rows: data.value.track_rows.map((row, index) => index ? row : {...row, playback_state: {can_start_here: false}})});
  await h.flush();
  assert.equal(pending.replay.starts().length, 0);
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, true);
  const retry = await beginReplay(h, data); assert.notStrictEqual(retry.request, pending.request);
  await acceptReplay(h, data, retry);
}));

test('CC 11 changing saved Playlist repeat mode invalidates a held completed replay', async t => scenario(t, async h => {
  const data = playlist(h); await completed(h, data); const pending = await beginReplay(h, data);
  const changed = h.c.replacePlaylistQueueModes(data.queue, {repeat: 'all'});
  respond(h, data, pending.request); await h.flush();
  assert.strictEqual(h.state.player.playbackQueue, changed);
  assert.equal(pending.replay.starts().length, 0, 'obsolete completed order does not start');
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, true);
}));

test('CC 12 actor replacement prevents held replay publication', async t => scenario(t, async h => {
  const data = album(h); await completed(h, data); const pending = await beginReplay(h, data);
  h.shell.dataset.nativeAccountId = '999';
  respond(h, data, pending.request); await h.flush();
  assert.equal(pending.replay.starts().length, 0);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
}));

test('CC 13 unknown multi-track queue cannot use standalone-song replay fallback', async t => scenario(t, async h => {
  const first = track('UnknownFirst'), last = track('UnknownLast');
  h.state.player.playbackQueue = {tracks: [first, last], currentIndex: 1, sourceKind: 'album-top'};
  await h.complete(h.select(last)); await h.finish();
  const before = h.starts.length; await h.replay();
  assert.equal(h.starts.length, before, 'unbound sourceKind is not a completed-context or standalone grant');
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
}));

test('CC 14 accepted replay survives pending cleanup, first frame, promotion, pause/resume and later EOF', async t => scenario(t, async h => {
  const data = album(h); await completed(h, data);
  const pending = await beginReplay(h, data); await acceptReplay(h, data, pending);
  const current = await promoteNext(h);
  assert.equal(h.state.player.current.path, data.last.path);
  assert.equal(h.c.togglePlayerPlayback(), true); await h.flush();
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, true);
  assert.equal(h.c.togglePlayerPlayback(), true); await h.flush();
  assert.strictEqual(h.engine().roles.current, current);
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, false);
  await h.finish();
  const again = await beginReplay(h, data); await acceptReplay(h, data, again);
}));


test('CC control 15 an ordinary non-final track promotes to its next track', async t => scenario(t, async h => {
  const data = album(h); data.queue.currentIndex = 0; h.state.player.playbackQueue = data.queue;
  await h.complete(h.select(data.first)); await promoteNext(h);
  assert.equal(h.state.player.current.path, data.last.path);
  assert.equal(h.state.player.playbackQueue.currentIndex, 1);
}));

test('CC 16 unprepared logical next occurrence prevents false completed-album replay', async t => scenario(t, async h => {
  const data = album(h); data.queue.currentIndex = 0; h.state.player.playbackQueue = data.queue;
  await h.complete(h.select(data.first));
  assert.equal(h.engine().roles.continuity, null, 'no next decoder was prepared');
  await h.finish(); const before = h.starts.length;
  await h.replay(); assert.equal(h.starts.length, before, 'logical successor is not terminal completion');
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
}));

for (const repeat of ['one', 'all']) test(`CC ${repeat === 'one' ? '17' : '18'} repeat-${repeat} is not a finite completed Playlist`, async t => scenario(t, async h => {
  const data = playlist(h, {repeat}); await completed(h, data);
  const before = h.starts.length; await h.replay();
  assert.equal(h.starts.length, before, 'unexpected decoder end cannot convert repeat into finite restart');
}));

test('CC 19 live gallery successor prevents false completion of its first album', async t => scenario(t, async h => {
  const data = album(h), nextTrack = {...data.value.tracks[0], path: '/library/gallery-next.flac',
    album: 'Next Gallery Album', inventory_track_ref: `inventory-track:${h.shell.dataset.nativeLibraryId}:301`,
    canonical_track_ref: 'canonical-301'};
  const next = {...data.value, key: 'next-gallery-album', name: 'Next Gallery Album',
    tracks: [nextTrack], track_rows: [nextTrack]};
  const nextRef = h.c.getAlbumPlaybackQueueRef(next);
  data.queue.playbackContext = {end_behavior: 'continue', ordered_album_refs: [data.queue.albumRef, nextRef]};
  h.state.view.primary_artist_groups = [{artist: 'Album Artist', albums: [data.value, next]}];
  h.state.view.family_artist_groups = []; h.state.view.artist_groups = [];
  h.state.player.playbackQueue = data.queue;
  await h.complete(h.select(data.last));
  const handle = h.c.getActivePlaybackOwnershipHandle();
  assert.ok(handle, 'gallery successor lookup occurs under the actual live outgoing claim');
  const successor = h.c.resolveNextPlaybackContextQueue(data.queue);
  assert.ok(successor, 'real pre-EOF gallery resolver reaches the live next album');
  assert.equal(successor.albumRef, nextRef);
  assert.equal(successor.tracks[0].path, nextTrack.path);
  assert.strictEqual(h.state.player.playbackQueue, data.queue, 'reachability check does not advance the queue');
  assert.strictEqual(h.c.getActivePlaybackOwnershipHandle(), handle);
  await h.finish();
  assert.strictEqual(h.state.player.current, data.last);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
  const before = h.starts.length;
  await h.replay(); assert.equal(h.starts.length, before, 'live gallery continuation is not album completion');
}));

test('CC control 20 terminal notification reentry finalizes only the captured outgoing session once', async t => scenario(t, async h => {
  const data = album(h); h.state.player.playbackQueue = data.queue;
  await h.complete(h.select(data.last)); const outgoing = h.state.player.listenSession;
  const calls = [], finalize = h.c.finalizeListenSession;
  h.c.finalizeListenSession = function (reason, options) {
    calls.push({reason, session: options?.session || h.state.player.listenSession});
    return finalize.call(this, reason, options);
  };
  let successor = null, fired = false;
  const off = h.queue.subscribe(() => {
    if (!fired && h.c.getPlayerPlaybackSnapshot().ended) {fired = true; successor = h.select(track('TerminalReentry'));}
  });
  h.disposals.push(off);
  await h.finish({expectEnded: false}); off(); assert.ok(successor, 'real terminal queue notification reenters actual selection');
  await h.complete(successor);
  assert.equal(calls.filter(call => call.reason === 'ended' && call.session === outgoing).length, 1);
  assert.equal(calls.some(call => call.reason === 'ended' && call.session !== outgoing), false);
  assert.equal(h.state.player.current.path, track('TerminalReentry').path);
  assert.ok(h.c.getActivePlaybackOwnershipHandle(), 'old terminal work cannot release successor claim');
}));

async function insertNext(h) {
  const row = {...track('Inserted'), duration_seconds: 90, album: 'Inserted Album',
    inventory_track_ref: `inventory-track:${h.shell.dataset.nativeLibraryId}:201`,
    canonical_track_ref: 'canonical-201', source_readable: true, availability: 'local',
    allowed_actions: {can_read: true, can_play: true}, playback_state: {can_start_here: true}};
  const value = {key: 'inserted-album', name: 'Inserted Album', album_artist: row.artist,
    tracks: [row], track_rows: [row], source_readable: true,
    allowed_actions: {can_read: true, can_play_album: true}};
  const albumRef = h.c.getAlbumPlaybackQueueRef(value);
  const captures = h.c.captureNativeAlbumQueueSources(value, [row]);
  assert.equal(captures.length, 1, 'actual native album source capture');
  const replyFresh = async () => {
    await h.flush();
    const request = h.requests.filter(request => !request.settled && !request.options.signal?.aborted
      && new URL(request.url, h.location).pathname === '/album-details'
      && new URL(request.url, h.location).searchParams.get('album_key') === albumRef).at(-1);
    assert.ok(request, 'actual Queue source refresh reaches native album details');
    request.resolve({ok: true, album: value}); await h.flush();
  };
  const enqueued = h.own(h.queue.enqueue(captures, 'next'));
  // enqueue owns separate metadata and playable-target reads; both are real
  // capture.resolve* calls and both complete before a Queue entry is admitted.
  await replyFresh(); await replyFresh();
  const result = await enqueued; assert.equal(result.error, undefined, result.error?.stack);
  assert.equal(result.value.length, 1); const id = result.value[0];
  const skipped = h.own(h.queueOwner().skip(1));
  // skip retires the background refresh and owns its new fresh read. Never reply
  // to an aborted preparation as a shortcut for the selected entry's authority.
  await replyFresh(); await h.complete(skipped);
  assert.equal(h.state.player.current.explicitEntryId, id);
  assert.equal(h.queue.getSnapshot().currentId, id);
  return id;
}

test('CC 21 completed native return replays the album without restoring its consumed insertion', async t => scenario(t, async h => {
  const data = album(h); h.state.player.playbackQueue = data.queue;
  await h.complete(h.select(data.last)); const id = await insertNext(h);
  await h.finish();
  assert.equal(h.queue.getSnapshot().entries.some(entry => entry.id === id), false, 'terminal insertion is consumed');
  const pending = await beginReplay(h, data); await acceptReplay(h, data, pending);
  assert.equal(h.queue.getSnapshot().entries.some(entry => entry.id === id), false, 'replay never restores consumed insertion');
  assert.equal(h.state.player.current.explicitEntryId, undefined);
}));

test('CC 22 a live native return after an insertion prevents false album completion', async t => scenario(t, async h => {
  const data = album(h); data.queue.currentIndex = 0; h.state.player.playbackQueue = data.queue;
  await h.complete(h.select(data.first)); const id = await insertNext(h);
  await h.finish(); const before = h.starts.length;
  await h.replay(); assert.equal(h.starts.length, before, 'the unplayed native return cannot become completed-album replay');
  assert.equal(h.queue.getSnapshot().entries.some(entry => entry.id === id), false);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
}));

test('CC 23 loop-owned EOF does not arm completed-context replay', async t => scenario(t, async h => {
  h.c.applyStatusPayload({...h.state.status, allowed_actions: {'library.loops.create': true}});
  assert.equal(h.state.loopCreateAllowed, true, 'pre-start server status admits the real loop control');
  const data = album(h); h.state.player.playbackQueue = data.queue;
  await h.complete(h.select(data.last)); metadata(h, h.engine().roles.current);
  h.c.setLoopActive(true); await h.flush();
  assert.equal(h.state.player.loopActive, true, 'real loop control owns playback');
  await h.finish(); const before = h.starts.length, requests = h.requests.length;
  await h.replay(); assert.equal(h.starts.length, before, 'loop end is not a completed album');
  assert.equal(h.requests.slice(requests).some(row => new URL(row.url, h.location).pathname === '/album-details'), false);
  assert.equal(h.state.player.loopActive, true);
}));
