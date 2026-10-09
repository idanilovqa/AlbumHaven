const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtimeDirectory = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const read = name => fs.readFileSync(path.join(runtimeDirectory, name), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
function setup({idle = false, tracks, repeat = 'off'} = {}) {
  tracks ||= [
    {path: 'ordinary-a', playlistItemId: 'item-a', albumRef: 'album-a'},
    {path: 'ordinary-b', playlistItemId: 'item-b', albumRef: 'album-a'},
    {path: 'ordinary-c', playlistItemId: 'item-c', albumRef: 'album-b'},
  ];
  const queue = {playlistId: 'playlist', tracks, regularTracks: tracks, currentIndex: 0, repeatMode: repeat, shuffle: false};
  const state = {player: {current: idle ? null : tracks[0], playbackQueue: idle ? null : queue, loopActive: false}};
  const engine = {roles: {current: idle ? null : {}, continuity: null}};
  const scope = {token: 'signed-in-session-one', actor: 'actor-one', library: 'library-one'};
  const scheduled = [], starts = [], callbacks = [], closed = [];
  let permission = true, sourceCurrent = true, ended = idle, resolver = null, startResult = true;
  const context = vm.createContext({
    window: {AlbumHavenCapabilities: {allows: () => permission}},
    state, AbortController, Map, Set, WeakMap, Object, Promise,
    PrivateUITransport: {subscribe: () => () => {}},
    refreshExplicitQueueReturnTrack: async (context, track) => track,
    playerTrackSelectionToken: 0,
    TrackActionsRuntime: {
      scope: () => ({...scope}),
      canPlay: target => Boolean(target?.path && target.source_readable !== false && target.allowed_actions?.can_play !== false),
    },
    getPlayerPlaybackSnapshot: () => ({ended}),
    streamingEngineState: () => engine,
    resolveNextPlaybackContextQueue: () => null,
    scheduleStreamingContinuity: async track => { scheduled.push(track); },
    closeStreamingContinuityRole: reason => { closed.push(reason); engine.roles.continuity = null; return true; },
    observeStreamingFacadeCallback: promise => {callbacks.push(Promise.resolve(promise).catch(error => error));},
    playTrackFromPayload: async (track, options) => { starts.push({track, options}); return startResult; },
  });
  for (const name of ['playlist-queue.js', 'explicit-queue-planner.js', 'explicit-queue-runtime.js']) vm.runInContext(read(name), context);
  const native = read('tag-editor-and-optimistic-updates.js');
  vm.runInContext(native.slice(native.indexOf('function peekNextQueuedTrack()'), native.indexOf('function refreshTrackModalPlaybackState()')), context);
  const runtime = vm.runInContext('ExplicitQueueRuntime', context), api = context.window.AlbumHavenExplicitQueue;
  const target = (suffix = 'one') => ({path: `/private/music/${suffix}.flac`, title: `Queued ${suffix}`,
    artist: 'Artist', album_title: 'Album', availability: 'available', source_readable: true,
    allowed_actions: {can_play: true}, playback_state: {can_start_here: true}});
  const capture = (suffix = 'one') => ({display: {title: `Queued ${suffix}`, artist: 'Artist', album: 'Album'},
    isCurrent: () => sourceCurrent,
    resolve: options => resolver ? resolver(options, suffix) : Promise.resolve(target(suffix)),
  });
  const settle = async () => { while (callbacks.length) await Promise.all(callbacks.splice(0)); };
  const advance = async () => {
    await settle(); await runtime.prepareNext();
    const preview = context.peekNextQueuedTrack(), next = context.getNextQueuedTrack();
    assert.equal(next?.path, preview?.path);
    state.player.current = next;
    return next;
  };
  return {context, state, engine, queue, scope, runtime, api, capture, target, scheduled, starts, closed, settle, advance,
    setPermission: value => {permission = value;}, setSourceCurrent: value => {sourceCurrent = value;},
    setResolver: value => {resolver = value;}, setStartResult: value => {startResult = value;},
    setEnded: value => {ended = value;},
  };
}

test('explicit Queue starts empty and exposes no native paths or source authority', async () => {
  const h = setup({idle: true});
  assert.equal(h.api.getSnapshot().entries.length, 0);
  const [id] = await h.api.enqueue([h.capture()], 'end');
  const snapshot = h.api.getSnapshot(), item = snapshot.entries[0];
  assert.equal(item.id, id); assert.equal(item.title, 'Queued one'); assert.equal(item.canPlay, true);
  assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.entries)); assert.ok(Object.isFrozen(item));
  assert.doesNotMatch(JSON.stringify(snapshot), /private\/music|\.flac|resolve|nativeTracks|nativeQueue|signed-in-session/);
  assert.equal(h.state.player.playbackQueue, null); assert.equal(h.starts.length, 0);
});

test('duplicate explicit occurrences interrupt then restore the exact duplicate native occurrence', async () => {
  const tracks = [
    {path: 'same', playlistItemId: 'first', albumRef: 'a'},
    {path: 'same', playlistItemId: 'second', albumRef: 'a'},
    {path: 'last', playlistItemId: 'third', albumRef: 'b'},
  ];
  const h = setup({tracks}), ids = await h.api.enqueue([h.capture(), h.capture()], 'next');
  assert.notEqual(ids[0], ids[1]);
  assert.equal((await h.advance()).explicitEntryId, ids[0]);
  assert.equal((await h.advance()).explicitEntryId, ids[1]);
  assert.equal((await h.advance()).playlistItemId, 'second');
  assert.equal(h.state.player.playbackQueue, h.queue); assert.equal(h.queue.currentIndex, 1);
  assert.equal((await h.advance()).playlistItemId, 'third');
  assert.equal(h.api.getSnapshot().entries.length, 0); assert.equal(h.starts.length, 0);
});

test('after-album waits for the contiguous album boundary and preserves ordinary following album', async () => {
  const h = setup(), [id] = await h.api.enqueue([h.capture()], 'album');
  assert.equal((await h.advance()).playlistItemId, 'item-b');
  assert.equal((await h.advance()).explicitEntryId, id);
  assert.equal((await h.advance()).playlistItemId, 'item-c');
});

test('after-playlist waits through repeat one and interrupts repeat all at the captured pass end', async () => {
  const h = setup({repeat: 'one'}), [id] = await h.api.enqueue([h.capture()], 'playlist');
  assert.equal((await h.advance()).playlistItemId, 'item-a');
  h.context.replacePlaylistQueueModes(h.state.player.playbackQueue, {repeat: 'all'});
  assert.equal((await h.advance()).playlistItemId, 'item-b');
  assert.equal((await h.advance()).playlistItemId, 'item-c');
  assert.equal((await h.advance()).explicitEntryId, id);
  assert.equal((await h.advance()).playlistItemId, 'item-a');
});

test('deactivate preserves pending requests and lets a current explicit track return to ordinary playback', async () => {
  const h = setup(), [first, second] = await h.api.enqueue([h.capture('one'), h.capture('two')], 'next');
  assert.equal((await h.advance()).explicitEntryId, first);
  h.api.setEnabled(false);
  assert.equal((await h.advance()).playlistItemId, 'item-b');
  assert.deepEqual(Array.from(h.api.getSnapshot().entries, item => item.id), [second]);
  assert.equal(h.starts.length, 0);
  h.api.setEnabled(true); await h.settle(); assert.equal(h.starts.length, 0);
});

test('captured clear preserves a newly queued occurrence and rejects edits during native promotion', async () => {
  const h = setup(), original = await h.api.enqueue([h.capture()], 'next');
  const [newId] = await h.api.enqueue([h.capture('two')], 'end');
  h.api.clear(original);
  assert.deepEqual(Array.from(h.api.getSnapshot().entries, item => item.id), [newId]);
  h.engine.pendingPromotion = {};
  assert.throws(() => h.api.clear([newId]), /transition/);
  assert.equal(h.api.getSnapshot().entries[0].id, newId);
  await h.settle();
});

test('a refused native continuity close does not mutate pending entries', async () => {
  const h = setup(), [id] = await h.api.enqueue([h.capture()], 'next'); await h.settle();
  h.engine.roles.continuity = {track: h.scheduled.at(-1)};
  h.context.closeStreamingContinuityRole = () => false;
  assert.throws(() => h.api.remove(id), /transition|accepted/);
  assert.equal(h.api.getSnapshot().entries[0].id, id);
});

for (const invalidation of ['selection', 'session', 'source', 'permission', 'route', 'abort']) {
  test(`delayed enqueue cannot commit after ${invalidation} invalidation`, async () => {
    const h = setup(), waiting = deferred(); let routeCurrent = true;
    h.setResolver(() => waiting.promise);
    const controller = new AbortController();
    const pending = h.api.enqueue([h.capture()], 'next', {signal: controller.signal, isCurrent: () => routeCurrent});
    if (invalidation === 'selection') h.context.playerTrackSelectionToken++;
    if (invalidation === 'session') h.scope.token = 'signed-in-session-two';
    if (invalidation === 'source') h.setSourceCurrent(false);
    if (invalidation === 'permission') h.setPermission(false);
    if (invalidation === 'route') routeCurrent = false;
    if (invalidation === 'abort') controller.abort();
    waiting.resolve(h.target());
    await assert.rejects(pending);
    assert.equal(h.api.getSnapshot().entries.length, 0); assert.equal(h.scheduled.length, 0); assert.equal(h.starts.length, 0);
  });
}

for (const unavailable of [{availability: 'missing'}, {availability: 'unknown'}, {source_readable: false}, {allowed_actions: {can_play: false}}]) {
  test(`unavailable source is rejected before enqueue: ${JSON.stringify(unavailable)}`, async () => {
    const h = setup(); h.setResolver(() => Promise.resolve({...h.target(), ...unavailable}));
    await assert.rejects(h.api.enqueue([h.capture()], 'next'));
    assert.equal(h.api.getSnapshot().entries.length, 0); assert.equal(h.scheduled.length, 0);
  });
}

test('source authority is checked again before native preload and skips newly unavailable requests', async () => {
  const h = setup();
  await h.api.enqueue([h.capture()], 'next'); await h.settle();
  h.setResolver(() => Promise.resolve({...h.target(), availability: 'missing'}));
  const prepared = await h.runtime.prepareNext();
  assert.equal(prepared.playlistItemId, 'item-b');
  assert.equal(h.context.peekNextQueuedTrack().playlistItemId, 'item-b');
  assert.match(h.api.getSnapshot().entries[0].status, /Unavailable/);
});

test('cached Queue snapshot cannot keep Play enabled after source access is revoked', async () => {
  const h = setup({idle: true}), [id] = await h.api.enqueue([h.capture()], 'end');
  assert.equal(h.api.getSnapshot().entries[0].canPlay, true);
  h.setSourceCurrent(false);
  const snapshot = h.api.getSnapshot();
  assert.equal(snapshot.entries[0].canPlay, false); assert.match(snapshot.entries[0].status, /Unavailable/);
  await assert.rejects(h.api.play(id)); assert.equal(h.starts.length, 0);
});

test('failed native explicit start leaves the occurrence pending and retryable', async () => {
  const h = setup({idle: true}), [id] = await h.api.enqueue([h.capture()], 'end');
  h.setStartResult(false);
  await assert.rejects(h.api.play(id), /start/);
  assert.equal(h.api.getSnapshot().currentId, null);
  assert.equal(h.api.getSnapshot().entries[0].id, id);
  assert.equal(h.api.getSnapshot().entries[0].canPlay, true);
  h.setStartResult(true); assert.equal(await h.api.play(id), true);
  assert.equal(h.starts.at(-1).options.explicitQueueTransition, true);
});

test('signed-in session change clears old pending entries and their action identity', async () => {
  const h = setup({idle: true}), [id] = await h.api.enqueue([h.capture()], 'end');
  h.scope.token = 'signed-in-session-two';
  assert.equal(h.api.getSnapshot().entries.length, 0);
  await assert.rejects(h.api.play(id)); assert.equal(h.starts.length, 0);
});

test('denied saved ordinary return never preloads or exposes its stale payload', async () => {
  const h = setup(); await h.api.enqueue([h.capture()], 'next');
  await h.advance();
  h.context.refreshExplicitQueueReturnTrack = async () => {throw new Error('Source access revoked');};
  const count = h.scheduled.length;
  assert.equal(await h.runtime.prepareNext(), null);
  assert.equal(h.scheduled.length, count);
  assert.equal(h.context.peekNextQueuedTrack(), null);
  assert.equal(h.context.getNextQueuedTrack(), null);
});

test('denied ordinary boundary cannot fall back to stale native payload while explicit requests wait', async () => {
  const h = setup(); await h.api.enqueue([h.capture()], 'playlist'); await h.settle();
  h.context.refreshExplicitQueueReturnTrack = async () => {throw new Error('Source access revoked');};
  const count = h.scheduled.length;
  assert.equal(await h.runtime.prepareNext(), null);
  assert.equal(h.scheduled.length, count);
  assert.equal(h.context.peekNextQueuedTrack(), null);
  assert.equal(h.context.getNextQueuedTrack(), null);
  assert.equal(h.state.player.current.playlistItemId, 'item-a');
});

test('an ordinary successor refresh completing after a newer selection cannot schedule stale media', async () => {
  const h = setup(); await h.api.enqueue([h.capture()], 'playlist'); await h.settle();
  const waiting = deferred();
  h.context.refreshExplicitQueueReturnTrack = () => waiting.promise;
  const pending = h.runtime.prepareNext(), count = h.scheduled.length;
  h.runtime.selectionStarted();
  waiting.resolve(h.queue.tracks[1]);
  await pending;
  assert.equal(h.scheduled.length, count);
});

test('native skip consumes one explicit occurrence and keeps the ordinary successor for return', async () => {
  const h = setup(), [id] = await h.api.enqueue([h.capture()], 'next'); await h.settle();
  assert.equal(await h.runtime.skip(1), true);
  assert.equal(h.starts[0].track.explicitEntryId, id);
  assert.equal(h.api.getSnapshot().currentId, id);
  assert.equal(await h.runtime.skip(-1), false);
  assert.equal(h.api.getSnapshot().currentId, id);
});

test('failed native skip restores both request ordering and the ordinary queue', async () => {
  const h = setup(), ids = await h.api.enqueue([h.capture('one'), h.capture('two')], 'next'); await h.settle();
  h.setStartResult(false);
  assert.equal(await h.runtime.skip(1), false);
  assert.equal(h.state.player.playbackQueue, h.queue);
  assert.equal(h.api.getSnapshot().currentId, null);
  assert.deepEqual(Array.from(h.api.getSnapshot().entries, item => item.id), Array.from(ids));
});

function nativeSources(h) {
  h.context.getAlbumPlaybackQueueRef = album => album?.ref;
  vm.runInContext(read('explicit-queue-sources.js'), h.context);
  return h.context;
}

test('native Album capture survives navigation but refreshes the exact inventory occurrence', async () => {
  const h = setup(), context = nativeSources(h), row = {...h.target(), inventory_track_ref: 'inventory-one'};
  delete row.artist; delete row.album_title; row.secondary_artist = null;
  const album = {ref: 'album-one', name: 'Captured album', album_artist: 'Primary artist',
    tracks: [{...row, artist: 'Primary artist'}], track_rows: [row]};
  context.fetchTrackModalAlbumDetails = async () => ({...album, tracks: [{...album.tracks[0], title: 'Fresh title'}],
    track_rows: [{...row, title: 'Fresh title'}]});
  const capture = context.captureNativeAlbumQueueSources(album, [row])[0];
  assert.equal(capture.isCurrent(), true);
  assert.equal(capture.display.album, 'Captured album');
  assert.equal(capture.display.artist, 'Primary artist');
  const refreshed = await capture.resolve();
  assert.equal(refreshed.title, 'Fresh title');
  assert.equal(refreshed.artist, 'Primary artist');
  assert.equal(refreshed.album_title, 'Captured album');
  assert.doesNotMatch(JSON.stringify(capture.display), /private\/music|inventory-one/);
  h.scope.token = 'another-session';
  assert.equal(capture.isCurrent(), false); await assert.rejects(capture.resolve());
});

for (const mutation of ['duplicate', 'path', 'missing', 'denied', 'album']) {
  test(`native Album capture rejects refreshed ${mutation} identity or authority`, async () => {
    const h = setup(), context = nativeSources(h), row = {...h.target(), inventory_track_ref: 'inventory-one'};
    const album = {ref: 'album-one', track_rows: [row]};
    const capture = context.captureNativeAlbumQueueSources(album, [row])[0];
    const fresh = {...album, track_rows: [{...row}]};
    if (mutation === 'duplicate') fresh.track_rows.push({...row});
    if (mutation === 'path') fresh.track_rows[0].path = '/private/music/other.flac';
    if (mutation === 'missing') fresh.track_rows[0].availability = 'missing';
    if (mutation === 'denied') fresh.allowed_actions = {can_play_album: false};
    if (mutation === 'album') fresh.ref = 'album-two';
    context.fetchTrackModalAlbumDetails = async () => fresh;
    await assert.rejects(capture.resolve(), /unavailable/);
  });
}

test('saved Playlist return requires the same occurrence, revision, intent and path', async () => {
  const h = setup(), context = nativeSources(h), track = h.queue.tracks[1];
  h.queue.playlistRevision = 7;
  const value = {playlist_id: 'playlist', playlist_item_id: 'item-b', revision: 7, intent: 'play',
    native_target: {path: track.path, playlist_item_id: 'item-b', title: 'Fresh title'}};
  const saved = {nativeQueue: h.queue};
  context.PrivateUITransport.request = async () => ({status: 'ready', data: value});
  assert.equal((await context.refreshExplicitQueueReturnTrack(saved, track)).title, 'Fresh title');
  for (const change of [{revision: 8}, {playlist_item_id: 'item-c'}, {playlist_id: 'other'}, {intent: 'inspect'},
    {native_target: {...value.native_target, path: 'another-path'}},
    {native_target: {...value.native_target, playlist_item_id: 'item-c'}}]) {
    context.PrivateUITransport.request = async () => ({status: 'ready', data: {...value, ...change}});
    await assert.rejects(context.refreshExplicitQueueReturnTrack(saved, track), /unavailable/);
  }
});

test('refresh restores a previously unavailable queued occurrence without replacing its identity', async () => {
  const h = setup({idle: true}), [id] = await h.api.enqueue([h.capture()], 'end');
  h.setResolver(() => Promise.resolve({...h.target(), availability: 'missing'}));
  await assert.rejects(h.api.play(id));
  assert.equal(h.api.getSnapshot().entries[0].canPlay, false);
  h.setResolver(() => Promise.resolve(h.target()));
  const restored = await h.api.refresh();
  assert.equal(restored.entries[0].id, id); assert.equal(restored.entries[0].canPlay, true);
  assert.equal(h.starts.length, 0);
});

function nativeStart(h) {
  const pending = deferred(), began = deferred(), stopped = [], selected = [];
  h.context.startStreamingTrack = track => {began.resolve(track); return pending.promise;};
  h.context.stopStreamingPlayback = async reason => {stopped.push(reason); h.runtime.stopped();};
  h.context.setCurrentPlayerTrack = track => {selected.push(track); h.state.player.current = track;};
  h.context.beginStreamingPlayerListenSession = () => {};
  h.context.updatePlayerUi = () => {};
  const source = read('player-loop-playback.js');
  vm.runInContext(source.slice(source.indexOf('async function playTrackFromPayload('), source.indexOf('let handledStreamingFirstFrameIdentity')), h.context);
  return {pending, began, stopped, selected};
}

for (const invalidation of ['abort', 'route', 'session']) {
  test(`native explicit start completing after ${invalidation} cancellation cannot install current media`, async () => {
    const h = setup({idle: true}), [id] = await h.api.enqueue([h.capture()], 'end'), native = nativeStart(h);
    const controller = new AbortController(); let current = true;
    const starting = h.api.play(id, {signal: controller.signal, isCurrent: () => current});
    const track = await native.began.promise;
    if (invalidation === 'abort') controller.abort();
    if (invalidation === 'route') current = false;
    if (invalidation === 'session') {h.scope.token = 'new-session'; h.api.getSnapshot();}
    native.pending.resolve({track});
    await assert.rejects(starting);
    await h.settle();
    assert.equal(native.selected.length, 0);
    assert.ok(native.stopped.length > 0);
    assert.equal(h.api.getSnapshot().currentId, null);
    if (invalidation !== 'session') assert.equal(h.api.getSnapshot().entries[0].id, id);
  });
}

for (const failure of ['http', 'missing', 'denied', 'session']) {
  test(`native Loose Track capture fails closed on ${failure} refresh`, async () => {
    const h = setup(), context = nativeSources(h), row = {...h.target(), inventory_track_ref: 'loose-one'};
    context.buildApiUrl = () => '/view-data?scope=loose&payload=full';
    const fresh = {non_album_tracks: [{...row}]};
    context.fetch = async () => ({ok: failure !== 'http', json: async () => fresh});
    const capture = context.captureNativeLooseQueueSources({kind: 'loose'}, [row])[0];
    if (failure === 'missing') fresh.non_album_tracks[0].availability = 'missing';
    if (failure === 'denied') fresh.non_album_tracks[0].playback_state = {can_start_here: false};
    if (failure === 'session') h.scope.token = 'new-session';
    await assert.rejects(capture.resolve(), /unavailable|superseded/);
  });
}

test('native Loose Track batch shares only in-flight refresh and reauthorizes later calls', async () => {
  const h = setup(), context = nativeSources(h), first = {...h.target('first'), inventory_track_ref: 'first'},
    second = {...h.target('second'), inventory_track_ref: 'second'};
  context.buildApiUrl = () => '/view-data?scope=loose&payload=full';
  let requests = 0;
  context.fetch = async () => {requests++; return {ok: true, json: async () => ({non_album_tracks: [first, second]})};};
  const captures = context.captureNativeLooseQueueSources({kind: 'loose'}, [first, second]);
  const tracks = await Promise.all(captures.map(capture => capture.resolve()));
  assert.deepEqual(tracks.map(track => track.inventory_track_ref), ['first', 'second']);
  assert.equal(requests, 1);
  await captures[0].resolve(); assert.equal(requests, 2);
});

test('ready end requests retain displayed order while an earlier boundary-gated entry waits', async () => {
  const h = setup(), [waiting] = await h.api.enqueue([h.capture('waiting')], 'playlist');
  const [ready] = await h.api.enqueue([h.capture('ready')], 'end');
  assert.deepEqual(Array.from(h.api.getSnapshot().entries, item => item.id), [waiting, ready]);
  assert.equal((await h.advance()).explicitEntryId, ready);
  assert.equal((await h.advance()).playlistItemId, 'item-b');
  assert.equal((await h.advance()).playlistItemId, 'item-c');
  assert.equal((await h.advance()).explicitEntryId, waiting);
});

test('session replacement retires a prepared native continuity role without changing the audible ordinary owner', async () => {
  const h = setup(); await h.api.enqueue([h.capture()], 'next'); await h.settle();
  const currentRole = h.engine.roles.current;
  h.engine.roles.continuity = {track: h.scheduled.at(-1)};
  h.scope.token = 'new-session';
  assert.equal(h.api.getSnapshot().entries.length, 0);
  assert.equal(h.engine.roles.continuity, null);
  assert.equal(h.engine.roles.current, currentRole);
  assert.ok(h.closed.includes('queue-session-changed'));
});

test('details resolution cannot commit after its queued occurrence was removed', async () => {
  const h = setup({idle: true}), waiting = deferred(), source = {...h.capture(), resolveDetails: () => waiting.promise};
  const [id] = await h.api.enqueue([source], 'end');
  const pending = h.api.details(id, 'album');
  h.api.remove(id); waiting.resolve({target: {kind: 'album', ref: 'album'}, isCurrent: () => true});
  await assert.rejects(pending, /superseded/);
});

test('deactivated explicit requests do not break native gallery continuation into a newly built album queue', async () => {
  const h = setup();
  const first = {path: 'first-album-last-track'};
  h.state.player.current = first;
  h.state.player.playbackQueue = {albumRef: 'first-album', tracks: [first], currentIndex: 0, playbackContext: {orderedAlbumRefs: ['first-album', 'second-album']}};
  h.context.resolveNextPlaybackContextQueue = () => ({albumRef: 'second-album', tracks: [{path: 'second-album-first-track'}], currentIndex: 0});
  await h.api.enqueue([h.capture()], 'next'); await h.settle();
  h.api.setEnabled(false); await h.settle();
  await h.runtime.prepareNext();
  assert.equal(h.context.peekNextQueuedTrack()?.path, 'second-album-first-track');
  assert.equal(h.context.getNextQueuedTrack()?.path, 'second-album-first-track');
  assert.equal(h.state.player.playbackQueue.albumRef, 'second-album');
  assert.equal(h.api.getSnapshot().entries.length, 1);
});

test('native loop exit prepares an explicit successor through the existing streaming facade', async () => {
  const h = setup(); await h.api.enqueue([h.capture()], 'next'); await h.settle();
  h.state.player.loopActive = true;
  h.context.streamingLoopScheduleToken = 0;
  h.context.loopEditSessionExpiryController = {stop() {}};
  h.context.dispatchActiveStreamingLoop = async () => null;
  h.context.setStreamingLoop = () => {};
  h.context.updatePlayerUi = () => {};
  const source = read('player-loop-playback.js');
  vm.runInContext(source.slice(source.indexOf('function setLoopActive('), source.indexOf('function setLoopBoundary(')), h.context);
  const before = h.scheduled.length;
  h.context.setLoopActive(false); await h.settle();
  assert.equal(h.state.player.loopActive, false);
  assert.equal(h.scheduled.length, before + 1);
  assert.equal(h.scheduled.at(-1).path, h.target().path);
});

for (const denied of [null, {availability: 'unknown'}, {availability: 'unresolved'}, {source_readable: false},
  {playback_state: {can_start_here: false}}, {allowed_actions: {can_play: false}}]) {
  test(`private playtable Queue availability rejects known denied source ${JSON.stringify(denied)}`, () => {
    const h = setup(), source = read('playtable-source.js');
    vm.runInContext(source.slice(0, source.indexOf('const NativePlaytables')), h.context);
    const row = {rowKey: 'row', readable: true}, target = denied === null ? null : {...h.target(), ...denied};
    const table = h.context.createPrivatePlaytableSource({rows: [row], revision: 1, isCurrent: () => true,
      resolveRow: () => target, captureQueueRows: () => []});
    assert.equal(table.canQueue(['row']), false);
  });
}

test('Queue detail lease survives deactivation but expires when its exact occurrence is cleared', async () => {
  const h = setup({idle: true}), source = {...h.capture(), resolveDetails: async () => ({
    target: {kind: 'album', ref: 'safe-ref'}, data: {title: 'Album'}, isCurrent: () => true,
  })};
  const [id] = await h.api.enqueue([source], 'end');
  const result = await h.api.details(id, 'album');
  assert.equal(result.isCurrent(), true);
  h.api.setEnabled(false); assert.equal(result.isCurrent(), true);
  h.api.clear([id]); assert.equal(result.isCurrent(), false);
});

test('native Album detail capture respects an explicit refreshed detail-view denial', async () => {
  const h = setup(), context = nativeSources(h), row = {...h.target(), inventory_track_ref: 'inventory-one'},
    album = {ref: 'album-one', track_rows: [row]};
  context.fetchTrackModalAlbumDetails = async () => ({...album, allowed_actions: {can_view_details: false}});
  const capture = context.captureNativeAlbumQueueSources(album, [row])[0];
  await assert.rejects(capture.resolveDetails('album'), /unavailable/);
});

test('incomplete native Album disc queues cannot promise an after-album boundary', () => {
  const h = setup(), first = {path: 'disc-one'}, second = {path: 'disc-two'};
  h.state.player.current = first;
  h.state.player.playbackQueue = {albumRef: 'album', tracks: [first], currentIndex: 0, albumSnapshot: {tracks: [first, second]}};
  const timing = h.api.timingOptions().find(item => item.value === 'album');
  assert.equal(timing.enabled, false); assert.match(timing.reason, /part of the album/);
  assert.equal(h.state.player.playbackQueue.tracks.length, 1);
});

test('a native Playlist with unknown album identities cannot invent an after-album boundary', () => {
  const h = setup(); delete h.queue.tracks[1].albumRef;
  assert.equal(h.api.timingOptions().find(item => item.value === 'album').enabled, false);
});

for (const kind of ['album-read-denied', 'loose-http-denied']) {
  test(`fresh native ${kind} redacts retained Queue labels without dropping occurrence identity`, async () => {
    const h = setup({idle: true}), context = nativeSources(h), row = {...h.target(), inventory_track_ref: 'inventory-one'};
    let revoked = false, captures;
    if (kind === 'album-read-denied') {
      const album = {ref: 'album', album: 'Private album', track_rows: [row]};
      context.fetchTrackModalAlbumDetails = async () => ({...album, source_readable: !revoked});
      captures = context.captureNativeAlbumQueueSources(album, [row]);
    } else {
      context.buildApiUrl = () => '/view-data?surface=albums';
      context.fetch = async () => ({ok: !revoked, status: revoked ? 403 : 200,
        json: async () => revoked ? {ok: false} : {non_album_tracks: [row]}});
      captures = context.captureNativeLooseQueueSources({}, [row]);
    }
    const [id] = await h.api.enqueue(captures, 'end');
    assert.equal(h.api.getSnapshot().entries[0].title, 'Queued one');
    revoked = true; await h.api.refresh();
    const denied = h.api.getSnapshot().entries[0];
    assert.equal(denied.id, id); assert.equal(denied.sourceReadable, false);
    assert.doesNotMatch(JSON.stringify(denied), /Queued one|Private album|private\/music/);
    revoked = false; await h.api.refresh();
    assert.equal(h.api.getSnapshot().entries[0].id, id);
    assert.equal(h.api.getSnapshot().entries[0].title, 'Queued one');
  });
}

test('an existing Queue detail lease expires when a later source refresh reports read denial', async () => {
  const h = setup({idle: true}), source = {...h.capture(), resolveDetails: async () => ({
    target: {kind: 'album', ref: 'safe-ref'}, data: {title: 'Album'}, isCurrent: () => true,
  })};
  const [id] = await h.api.enqueue([source], 'end'), details = await h.api.details(id, 'album');
  assert.equal(details.isCurrent(), true);
  h.setResolver(async () => {throw Object.assign(new Error('Source denied'), {status: 403});});
  await h.api.refresh();
  assert.equal(h.api.getSnapshot().entries[0].sourceReadable, false);
  assert.equal(details.isCurrent(), false);
});

for (const timing of ['next', 'album']) {
  test(`native ordinary ended boundary marks deactivated ${timing} request ready without starting it`, async () => {
    const track = {path: 'only-track', playlistItemId: 'only-item', albumRef: 'album'}, h = setup({tracks: [track]});
    const [id] = await h.api.enqueue([h.capture()], timing); await h.settle();
    h.api.setEnabled(false); await h.settle();
    h.engine.roles.current = null; h.setEnded(true); h.runtime.ended();
    assert.equal(h.api.getSnapshot().entries[0].id, id);
    assert.equal(h.api.getSnapshot().entries[0].ready, true);
    assert.equal(h.api.getSnapshot().entries[0].canPlay, false);
    h.api.setEnabled(true); await h.settle();
    assert.equal(h.api.getSnapshot().entries[0].canPlay, true);
    assert.equal(h.starts.length, 0);
  });
}

test('a detached detail lease cannot revive after a denied source is restored between observations', async () => {
  const h = setup({idle: true}), source = {...h.capture(), resolveDetails: async () => ({
    target: {kind: 'album', ref: 'safe-ref'}, data: {title: 'Album'}, isCurrent: () => true,
  })};
  const [id] = await h.api.enqueue([source], 'end'), prior = await h.api.details(id, 'album');
  h.setResolver(async () => {throw Object.assign(new Error('Source denied'), {status: 403});});
  await h.api.refresh();
  h.setResolver(async () => h.target()); await h.api.refresh();
  assert.equal(prior.isCurrent(), false);
  assert.equal((await h.api.details(id, 'album')).isCurrent(), true);
});

test('native explicit skip locks Queue edits until its asynchronous player selection finishes', async () => {
  const h = setup(), [id] = await h.api.enqueue([h.capture()], 'next'); await h.settle();
  const native = nativeStart(h), pending = h.runtime.skip(1), track = await native.began.promise;
  let editingError;
  try {h.api.setEnabled(false);} catch (error) {editingError = error;}
  native.pending.resolve({track});
  const started = await pending; await h.settle();
  assert.match(editingError?.message || '', /transition/);
  assert.equal(started, true);
  assert.equal(h.api.getSnapshot().currentId, id);
  assert.equal(h.state.player.current.explicitEntryId, id);
});

for (const invalidation of ['stopped', 'source-revoked']) {
  test(`native explicit skip cannot strand its occurrence after ${invalidation} during delayed start`, async () => {
    const h = setup(), [id] = await h.api.enqueue([h.capture()], 'next'); await h.settle();
    const native = nativeStart(h), pending = h.runtime.skip(1), track = await native.began.promise;
    if (invalidation === 'stopped') h.runtime.stopped();
    else h.setSourceCurrent(false);
    native.pending.resolve({track});
    assert.equal(await pending, false); await h.settle();
    assert.equal(native.selected.length, 0);
    assert.equal(h.api.getSnapshot().currentId, null);
    assert.equal(h.api.getSnapshot().entries[0].id, id);
    assert.equal(h.state.player.playbackQueue, h.queue);
    assert.equal(h.api.getSnapshot().halted, true);
  });
}

for (const method of ['play', 'skip']) for (const restore of [false, true]) {
  test(`native ${method} start cannot outlive read denial${restore ? ' and restoration' : ''}`, async () => {
    const h = setup({idle: method === 'play'}); let denied = false;
    const source = {...h.capture(), resolveDetails: async () => {
      if (denied) throw Object.assign(new Error('Source denied'), {status: 403});
      return {target: {kind: 'album', ref: 'safe-ref'}, data: {title: 'Album'}, isCurrent: () => true};
    }};
    const [id] = await h.api.enqueue([source], method === 'play' ? 'end' : 'next'); await h.settle();
    const native = nativeStart(h);
    const pending = (method === 'play' ? h.api.play(id) : h.runtime.skip(1)).then(value => ({value}), error => ({error}));
    const track = await native.began.promise;
    denied = true; await assert.rejects(h.api.details(id, 'album'), /denied/);
    if (restore) {denied = false; await h.api.details(id, 'album');}
    native.pending.resolve({track});
    const completed = await pending; await h.settle();
    if (method === 'play') assert.match(completed.error?.message || '', /start/);
    else assert.equal(completed.value, false);
    assert.equal(native.selected.length, 0);
    assert.equal(h.api.getSnapshot().currentId, null);
    assert.equal(h.api.getSnapshot().entries[0].id, id);
  });
}

test('source denial retires prepared native continuity without a Queue snapshot subscriber', async () => {
  const h = setup(); let denied = false, resolves = 0;
  h.setResolver(async () => {resolves++; return h.target();});
  const source = {...h.capture(), resolveDetails: async () => {
    if (denied) throw Object.assign(new Error('Source denied'), {status: 403});
    return {target: {kind: 'album', ref: 'safe-ref'}, data: {title: 'Album'}, isCurrent: () => true};
  }};
  const [id] = await h.api.enqueue([source], 'next'); await h.settle();
  h.engine.roles.continuity = {track: h.scheduled.at(-1)};
  const audible = h.engine.roles.current;
  denied = true; await assert.rejects(h.api.details(id, 'album'), /denied/);
  assert.equal(h.engine.roles.continuity, null);
  assert.equal(h.engine.roles.current, audible);
  denied = false; await h.api.details(id, 'album');
  assert.equal(h.context.peekNextQueuedTrack(), null);
  const before = resolves;
  await h.runtime.prepareNext();
  assert.equal(resolves, before + 1);
  assert.equal(h.context.peekNextQueuedTrack().explicitEntryId, id);
});

function builderCapture(h, resolve = async () => ({inventory_track_ref: 'inventory-track:1:17', source_readable: true})) {
  return {...h.capture(), resolvePlaylistItem: async (...args) => {
    const item = await resolve(...args);
    return {...item, source_provenance: {kind: 'inventory', track_ref: item.inventory_track_ref}};
  }};
}

test('Queue builder receipt preserves distinct occurrence order even when inventory identities repeat', async () => {
  const h = setup({idle: true}), ids = await h.api.enqueue([builderCapture(h), builderCapture(h)], 'end');
  const selection = await h.api.playlistSelection([ids[1], ids[0]]);
  assert.deepEqual(Array.from(selection.rows, row => row.rowKey), [ids[1], ids[0]]);
  assert.deepEqual(Array.from(selection.rows, row => row.track_ref), ['inventory-track:1:17', 'inventory-track:1:17']);
  assert.ok(Object.isFrozen(selection)); assert.ok(Object.isFrozen(selection.rows));
  assert.doesNotMatch(JSON.stringify(selection.rows), /private\/music|\.flac|resolve/);
  await assert.rejects(h.api.playlistSelection([ids[0], ids[0]]));
});

test('Queue builder receipt can read missing inventory without playback permission', async () => {
  const h = setup({idle: true}), [id] = await h.api.enqueue([builderCapture(h, async () => ({
    inventory_track_ref: 'inventory-track:1:17', source_readable: true, availability: 'missing',
    playback_state: {can_start_here: false}, allowed_actions: {can_read: true, can_play: false},
  }))], 'end');
  h.setPermission(false);
  const selection = await h.api.playlistSelection([id]);
  assert.equal(selection.rows[0].track_ref, 'inventory-track:1:17'); assert.equal(selection.isCurrent(), true);
  assert.equal(h.starts.length, 0);
});

for (const invalidation of ['removed', 'session', 'route', 'abort']) {
  test(`delayed Queue builder capture rejects ${invalidation} lifetime`, async () => {
    const h = setup({idle: true}), waiting = deferred(), [id] = await h.api.enqueue([builderCapture(h, () => waiting.promise)], 'end');
    let current = true; const controller = new AbortController();
    const pending = h.api.playlistSelection([id], {signal: controller.signal, isCurrent: () => current});
    if (invalidation === 'removed') h.api.remove(id);
    if (invalidation === 'session') h.scope.token = 'new-session';
    if (invalidation === 'route') current = false;
    if (invalidation === 'abort') controller.abort();
    waiting.resolve({inventory_track_ref: 'inventory-track:1:17', source_readable: true});
    await assert.rejects(pending, /superseded/);
  });
}

test('Queue builder capture rejects malformed inventory refs instead of substituting native paths', async () => {
  const h = setup({idle: true}), [id] = await h.api.enqueue([builderCapture(h, async () => ({inventory_track_ref: h.target().path}))], 'end');
  await assert.rejects(h.api.playlistSelection([id]), /inventory identity/);
});

test('Queue builder source read denial invalidates and redacts the retained occurrence', async () => {
  const h = setup({idle: true}), [id] = await h.api.enqueue([builderCapture(h, async () => ({
    inventory_track_ref: 'inventory-track:1:17', source_readable: false,
  }))], 'end');
  await assert.rejects(h.api.playlistSelection([id]), /unreadable/);
  assert.equal(h.api.getSnapshot().entries[0].sourceReadable, false);
});

test('Queue builder receipt survives deactivation but cannot survive exact occurrence removal', async () => {
  const h = setup({idle: true}), [id] = await h.api.enqueue([builderCapture(h)], 'end');
  const selection = await h.api.playlistSelection([id]);
  h.api.setEnabled(false); assert.equal(selection.isCurrent(), true);
  h.api.remove(id); assert.equal(selection.isCurrent(), false);
});

test('Queue builder receipt never revives after an unobserved source denial and restoration', async () => {
  const h = setup({idle: true}), [id] = await h.api.enqueue([builderCapture(h)], 'end');
  const selection = await h.api.playlistSelection([id]);
  h.setResolver(async () => {throw Object.assign(new Error('Source denied'), {status: 403});}); await h.api.refresh();
  h.setResolver(async () => h.target()); await h.api.refresh();
  assert.equal(selection.isCurrent(), false);
  assert.equal((await h.api.playlistSelection([id])).isCurrent(), true);
});

for (const kind of ['album', 'loose']) {
  test(`native ${kind} builder capture refreshes readable missing inventory without media authority`, async () => {
    const h = setup(), context = nativeSources(h), row = {...h.target(), inventory_track_ref: 'inventory-track:1:17'};
    const missing = {...row, availability: 'missing', playback_state: {can_start_here: false}};
    let captures;
    if (kind === 'album') {
      const album = {ref: 'album', track_rows: [row]};
      context.fetchTrackModalAlbumDetails = async () => ({...album, allowed_actions: {can_read: true, can_play_album: false}, track_rows: [missing]});
      captures = context.captureNativeAlbumQueueSources(album, [row]);
    } else {
      context.buildApiUrl = () => '/view-data?surface=albums';
      context.fetch = async () => ({ok: true, json: async () => ({non_album_tracks: [missing]})});
      captures = context.captureNativeLooseQueueSources({}, [row]);
    }
    h.setPermission(false);
    const target = await captures[0].resolvePlaylistItem();
    assert.equal(target.inventory_track_ref, 'inventory-track:1:17'); assert.equal(target.availability, 'missing');
  });
}
