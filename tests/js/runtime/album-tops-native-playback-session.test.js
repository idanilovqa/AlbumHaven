'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
const {fixture, start, track: ordinaryTrack} = require('./search-native-fixtures/ownership-platform.cjs');

let getAlbumTopPlaybackSession;
test.before(async () => {
  ({getAlbumTopPlaybackSession} = await F.load('album-tops/playback-session.mjs'));
});
const outcome = work => Promise.resolve(work).then(value => ({value}), error => ({error}));
const plain = value => JSON.parse(JSON.stringify(value));

// Complete native owners come from ownership-platform. This adapter exposes
// those owners directly; it replaces neither a provider nor a playback owner.
// The Set represents mounted-UI notifications only. The actual Album Tops
// bridge and native consumer have separate connected acceptance coverage.
async function environment(t, {blocks = [[101, 102], [103, 104], [105, 106]]} = {}) {
  const h = await fixture(t), native = h.owner('TopPlaybackRuntime');
  const transport = h.c.AlbumHavenPrivateUITransport, listeners = new Set();
  const scopeKey = JSON.stringify([h.shell.dataset.nativeAccountId, h.shell.dataset.nativeLibraryId,
    transport.context(), transport.generation()]);
  const context = transport.context(), library = h.shell.dataset.nativeLibraryId;
  const notify = () => {for (const listener of [...listeners]) if (listeners.has(listener)) listener();};
  const runtime = Object.freeze({
    playback: Object.freeze({
      transport,
      captureScope(key) {
        const scope = h.c.capturePlaybackOwnershipScope();
        if (!scope || JSON.stringify([scope.actor, scope.library, scope.context, scope.generation]) !== key) return null;
        return Object.freeze({isCurrent: () => h.c.isPlaybackOwnershipScopeCurrent(scope)});
      },
      create: native.create.bind(native), start: native.start.bind(native), configure: native.configure.bind(native),
      describe: native.describe.bind(native), dispose: native.dispose.bind(native),
    }),
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
  });
  const unsubscribeTransport = transport.subscribe(notify), session = getAlbumTopPlaybackSession(runtime);
  const ui = new AbortController();
  let uiCurrent = true;
  const captures = [];
  const requests = suffix => h.requests.filter(request => new URL(request.url, h.location).pathname.endsWith(suffix));
  const captureRequests = () => requests('/native-queue');
  const targetRequests = () => requests('/native-playback-target');
  const target = (number, prefix = 'fresh', patch = {}) => ({
    track_ref: `/synthetic/${prefix}/${number}.flac`, path: `/synthetic/${prefix}/${number}.flac`,
    title: `Top track ${number}`, artist: 'Top Artist', album_title: 'Top Album', duration_seconds: 90,
    inventory_track_ref: `inventory-track:${library}:${number}`, ...patch,
  });
  function captureWire(request, {empty = false, unavailable = []} = {}) {
    const topRef = new URL(request.url, h.location).pathname.split('/')[2];
    const {revision} = JSON.parse(request.options.body);
    const albums = empty ? [] : blocks.map((numbers, index) => {
      const item_ref = F.id(21 + index), catalog_ref = F.id(11 + index);
      const inventory_album_ref = `inventory-album:${library}:${11 + index}`;
      return {item_ref, catalog_ref, inventory_album_ref, album_ref: `Top session album ${index}`,
        tracks: numbers.map(number => ({queue_item_ref: `${item_ref}:${number}`,
          source: {revision, item_ref, catalog_ref, inventory_album_ref,
            inventory_track_ref: `inventory-track:${library}:${number}`, canonical_track_ref: `canonical-${number}`},
          native_target: target(number, 'captured')}))};
    });
    return {top_ref: topRef, revision, albums, unavailable_items: unavailable};
  }
  function replyCapture(request = captureRequests().at(-1), options = {}) {
    assert.ok(request, 'actual private transport dispatched a fresh queue capture');
    assert.equal(request.options.method, 'POST');
    const wire = captureWire(request, options);
    captures.push(wire);
    request.resolve({status: 'ready', context_ref: context, data: wire});
    return wire;
  }
  function replyTarget(request = targetRequests().at(-1), patch = {}) {
    assert.ok(request, 'actual provider dispatched fresh per-track authority');
    assert.equal(request.options.method, 'POST');
    const source = JSON.parse(request.options.body);
    const topRef = new URL(request.url, h.location).pathname.split('/')[2];
    assert.ok(captures.some(capture => capture.top_ref === topRef && capture.albums.some(album => album.tracks.some(
      track => JSON.stringify(track.source) === JSON.stringify(source)))), 'resolver receives the exact captured six-field tuple');
    const number = Number(source.inventory_track_ref.split(':').at(-1));
    request.resolve({status: 'ready', context_ref: context,
      data: {top_ref: topRef, source, native_target: target(number, 'fresh', patch)}});
  }
  async function openSockets() {
    await h.flush();
    for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
    await h.flush();
  }
  function play({topRef = F.TOP, revision = '7', ...options} = {}) {
    return outcome(session.start({top_ref: topRef, revision},
      {scopeKey, signal: ui.signal, isCurrent: () => uiCurrent, ...options}));
  }
  async function finishStart(work, {request, patch, unavailable = 0} = {}) {
    await h.flush(); replyTarget(request, patch); await openSockets();
    const result = await work;
    assert.equal(result.error, undefined, result.error?.stack);
    assert.deepEqual(plain(result.value), {started: true, unavailable});
    assert.ok(h.engine().roles.current, 'real streaming engine accepted the fresh target');
    return h.engine().roles.current;
  }
  async function acceptStart(work = play(), options = {}) {
    await h.flush(); replyCapture(options.captureRequest, options.capture);
    return finishStart(work, options);
  }
  async function acceptTransition(work) {
    await h.flush(); replyTarget(); await openSockets();
    const result = await work;
    assert.equal(result.error, undefined, result.error?.stack); assert.equal(result.value, true);
    return h.engine().roles.current;
  }
  function depart() {
    uiCurrent = false; ui.abort();
    h.state.view = {surface: {active: 'albums'}};
    h.location.pathname = '/settings';
    notify();
  }
  t.after(async () => {ui.abort(); transport.invalidate(); unsubscribeTransport(); listeners.clear(); await h.flush();});
  return Object.assign(h, {native, transport, sessionRuntime: runtime, session, scopeKey, contextRef: context, listeners, notify, ui,
    captureRequests, targetRequests, replyCapture, replyTarget, play, finishStart, acceptStart, acceptTransition, openSockets, depart});
}

function assertNoPlayback(h) {
  assert.equal(h.platform.contexts.length, 0);
  assert.equal(h.platform.sockets.length, 0);
  assert.equal(h.engine().roles.current, null);
  assert.equal(h.session.snapshot(F.TOP, h.scopeKey), null);
}

test('one shell owns one session and every accepted start captures before freshly resolving its first track', async t => {
  const h = await environment(t);
  assert.equal(getAlbumTopPlaybackSession(h.sessionRuntime), h.session);
  const work = h.play(); await h.flush();
  assert.equal(h.captureRequests().length, 1); assert.equal(h.targetRequests().length, 0);
  assertNoPlayback(h);
  assert.deepEqual(JSON.parse(h.captureRequests()[0].options.body), {revision: '7'});
  h.replyCapture(); await h.flush();
  assert.equal(h.targetRequests().length, 1); assertNoPlayback(h);
  const role = await h.finishStart(work);
  assert.equal(role.track.path, '/synthetic/fresh/101.flac');
  assert.equal(h.state.player.current.path, role.track.path);
  assert.equal(h.native.isPayloadCurrent(h.state.player.current), true);
  assert.equal(h.c.buildPersistedPlayerState(), null);
  assert.deepEqual(plain(h.session.snapshot(F.TOP, h.scopeKey)),
    {topRef: F.TOP, revision: '7', mode: 'in_order', stopAfterAlbum: false, unavailable: 0});
  assert.equal(h.listeners.size, 1);
});

for (const [mode, order] of [
  ['in_order', [101, 102, 103, 104, 105, 106]],
  ['random_albums', [103, 104, 105, 106, 101, 102]],
  ['random_songs', [102, 101, 104, 103, 106, 105]],
]) test(`initial ${mode} schedules the entire unvisited capture before first-track admission`, async t => {
  const h = await environment(t);
  t.mock.method(Math, 'random', () => 0); // Deterministic entropy, never a planner replacement.
  const work = h.play({mode, stopAfterAlbum: true}); await h.flush(); h.replyCapture(); await h.flush();
  const queue = h.state.player.playbackQueue;
  assert.ok(h.native.hasQueue(queue));
  assert.deepEqual(Array.from(queue.tracks, track => Number(track.path.split('/').at(-1).split('.')[0])), order);
  assert.equal(JSON.parse(h.targetRequests()[0].options.body).inventory_track_ref, `inventory-track:9:${order[0]}`);
  const role = await h.finishStart(work);
  assert.equal(role.track.path, `/synthetic/fresh/${order[0]}.flac`);
  const snapshot = h.session.snapshot(F.TOP, h.scopeKey);
  assert.equal(snapshot.mode, mode); assert.equal(snapshot.stopAfterAlbum, true);
  assert.equal(queue.currentIndex, 0);
});

test('an empty current capture reports unavailable albums without entering native playback', async t => {
  const h = await environment(t), work = h.play(); await h.flush();
  h.replyCapture(undefined, {empty: true, unavailable: [{item_ref: F.id(41), reason: 'unavailable'},
    {item_ref: F.id(42), reason: 'remote_summary'}]});
  const result = await work;
  assert.equal(result.error, undefined);
  assert.deepEqual(plain(result.value), {started: false, unavailable: 2});
  assert.equal(h.targetRequests().length, 0); assert.equal(h.listeners.size, 0); assertNoPlayback(h);
});

for (const status of [403, 409, 502]) test(`a ${status} capture rejection never authorizes playback`, async t => {
  const h = await environment(t), work = h.play(); await h.flush();
  h.captureRequests()[0].resolve({status: 'error', context_ref: h.contextRef, error_code: 'capture_rejected'}, status);
  const result = await work;
  assert.equal(result.error?.status, status);
  assert.equal(h.targetRequests().length, 0); assert.equal(h.listeners.size, 0); assertNoPlayback(h);
});

test('malformed capture revision cannot fall back to the visible Top or captured media paths', async t => {
  const h = await environment(t), work = h.play(); await h.flush();
  h.captureRequests()[0].resolve({status: 'ready', context_ref: h.contextRef,
    data: {top_ref: F.TOP, revision: '8', albums: [], unavailable_items: []}});
  assert.equal((await work).error?.status, 502);
  assert.equal(h.targetRequests().length, 0); assert.equal(h.listeners.size, 0); assertNoPlayback(h);
});

for (const response of ['empty', 'rejected']) test(`an ${response} replacement capture preserves the already accepted source and audio`, async t => {
  const h = await environment(t), role = await h.acceptStart();
  const queue = h.state.player.playbackQueue, socket = h.engine().socket, context = h.engine().context;
  const work = h.play({topRef: F.OTHER, revision: '8'}); await h.flush();
  if (response === 'empty') h.replyCapture(undefined, {empty: true});
  else h.captureRequests().at(-1).resolve({status: 'error', context_ref: h.contextRef, error_code: 'capture_rejected'}, 409);
  const result = await work;
  if (response === 'empty') {
    assert.equal(result.error, undefined); assert.deepEqual(plain(result.value), {started: false, unavailable: 0});
  } else assert.equal(result.error?.status, 409);
  assert.equal(h.engine().roles.current, role); assert.equal(h.state.player.playbackQueue, queue);
  assert.equal(h.engine().socket, socket); assert.equal(h.engine().context, context);
  assert.equal(h.session.snapshot(F.TOP, h.scopeKey).revision, '7');
  assert.equal(h.session.snapshot(F.OTHER, h.scopeKey), null);
  assert.equal(h.listeners.size, 1); assert.equal(h.targetRequests().length, 1);
});

test('a partially playable capture reports its omissions while preserving the native incomplete-album guard', async t => {
  const h = await environment(t);
  await h.acceptStart(h.play(), {capture: {unavailable: [{item_ref: F.id(21), reason: 'tracks_unavailable'}]}, unavailable: 1});
  assert.equal(h.session.snapshot(F.TOP, h.scopeKey).unavailable, 1);
  assert.equal(h.native.describe(h.state.player.playbackQueue).albumComplete, false);
  assert.equal(h.queue.timingOptions().find(option => option.value === 'album').enabled, false);
});

test('freshly unavailable captured tracks report a start failure without opening audio', async t => {
  const h = await environment(t, {blocks: [[101]]}), work = h.play();
  await h.flush(); h.replyCapture(); await h.flush();
  h.targetRequests()[0].resolve({status: 'error', context_ref: h.contextRef, error_code: 'item_unavailable'}, 404);
  const result = await work;
  assert.equal(result.error?.name, 'Error'); assert.equal(result.error?.message, 'Top playback could not start.');
  assert.equal(h.ui.signal.aborted, false, 'the still-current UI can show the real start failure');
  assert.equal(h.listeners.size, 0); assertNoPlayback(h);
});

test('accepted playback survives view replacement and disposal, then uses its live provider for native Next', async t => {
  const h = await environment(t), role = await h.acceptStart();
  const queue = h.state.player.playbackQueue, socket = h.engine().socket, context = h.engine().context;
  h.depart(); await h.flush();
  assert.equal(h.engine().roles.current, role); assert.equal(h.engine().socket, socket);
  assert.equal(h.engine().context, context); assert.equal(socket.closeCount, 0); assert.equal(context.closeCount, 0);
  assert.equal(h.listeners.size, 1); assert.equal(h.session.snapshot(F.TOP, h.scopeKey).mode, 'in_order');
  await h.acceptTransition(outcome(h.c.playCompactQueueOffset(1)));
  assert.equal(queue.currentIndex, 1); assert.equal(h.state.player.current.path, '/synthetic/fresh/102.flac');
  assert.equal(h.captureRequests().length, 1); assert.equal(h.targetRequests().length, 2);
  assert.equal(h.native.isPayloadCurrent(h.state.player.current), true);
});

for (const change of ['account', 'library', 'context', 'generation'])
  test(`actual ${change} scope retirement closes accepted playback and removes its UI subscription`, async t => {
    const h = await environment(t); await h.acceptStart();
    const queue = h.state.player.playbackQueue, requests = h.targetRequests().length;
    if (change === 'account') h.shell.dataset.nativeAccountId = '10';
    if (change === 'library') h.shell.dataset.nativeLibraryId = '10';
    if (change === 'context') h.shell.dataset.privateUiContext = 'b'.repeat(64);
    if (change === 'generation') h.transport.invalidate();
    h.notify(); await h.flush();
    assert.equal(h.session.snapshot(F.TOP, h.scopeKey), null);
    assert.equal(h.listeners.size, 0); assert.equal(h.native.describe(queue).ended, true);
    assert.equal(h.engine().roles.current, null); assert.equal(h.engine().roles.continuity, null);
    assert.equal(await h.c.playCompactQueueOffset(1), false);
    assert.equal(h.targetRequests().length, requests);
  });

for (const stage of ['capture', 'target']) test(`pending UI abort retires the ${stage} request and rejects a late successful response`, async t => {
  const h = await environment(t), work = h.play(); await h.flush();
  if (stage === 'target') {h.replyCapture(); await h.flush();}
  const request = stage === 'capture' ? h.captureRequests().at(-1) : h.targetRequests().at(-1);
  h.depart();
  assert.equal(request.options.signal.aborted, true); assert.equal(h.listeners.size, 0);
  if (stage === 'capture') h.replyCapture(request); else h.replyTarget(request);
  assert.equal((await work).error?.name, 'AbortError');
  await h.flush(); assertNoPlayback(h);
  assert.equal(h.targetRequests().length, stage === 'capture' ? 0 : 1);
});

test('a superseded view callback rejects an outstanding capture even without an abort event', async t => {
  const h = await environment(t); let visible = true;
  const work = h.play({isCurrent: () => visible}); await h.flush();
  visible = false; h.replyCapture();
  assert.equal((await work).error?.name, 'AbortError');
  assert.equal(h.ui.signal.aborted, false); assert.equal(h.listeners.size, 0);
  assert.equal(h.targetRequests().length, 0); assertNoPlayback(h);
});

test('actual bridge and transport retire a pending capture on shell context mutation before its HTTP reply', async t => {
  const h = await fixture(t), bridge = h.c.AlbumHavenAlbumTopsRuntime;
  const transport = h.c.AlbumHavenPrivateUITransport;
  assert.ok(h.loaded.includes('music_app/static/js/runtime/album-tops-react-bridge.js'));
  assert.equal(bridge.playback.transport, transport, 'the bridge uses the actual private transport');
  const host = h.document.createElement('section'); host.id = 'album-tops-root'; h.main.append(host);
  h.state.view = {surface: {active: 'album_tops'}, top_ref: F.TOP};
  await h.flush();
  const subscriptions = new Set(); let notifications = 0;
  // Observe subscription lifetime while delegating every notification and
  // unsubscription to the real bridge. No manual sync or callback delivery.
  const runtime = Object.freeze({...bridge, subscribe(listener) {
    const observed = () => {notifications++; listener();};
    const unsubscribe = bridge.subscribe(observed); subscriptions.add(observed);
    return () => {unsubscribe(); subscriptions.delete(observed);};
  }});
  const session = getAlbumTopPlaybackSession(runtime), ui = new AbortController();
  t.after(() => ui.abort());
  const context = transport.context(), generation = transport.generation();
  const actor = h.shell.dataset.nativeAccountId, library = h.shell.dataset.nativeLibraryId;
  const scopeKey = JSON.stringify([actor, library, context, generation]);
  const view = h.state.view, queue = h.state.player.playbackQueue;
  const work = outcome(session.start({top_ref: F.TOP, revision: '7'},
    {scopeKey, signal: ui.signal, isCurrent: () => true}));
  await h.flush();
  const requests = suffix => h.requests.filter(request => new URL(request.url, h.location).pathname.endsWith(suffix));
  assert.equal(requests('/native-queue').length, 1);
  const request = requests('/native-queue')[0];
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), {revision: '7'});
  assert.equal(request.options.signal.aborted, false); assert.equal(request.settled, false);
  assert.equal(subscriptions.size, 1); assert.equal(notifications, 0);
  assert.equal(requests('/native-playback-target').length, 0);

  h.shell.dataset.privateUiContext = 'b'.repeat(64);
  await h.flush(); // Deliver the fixture's attribute MutationObservers normally.
  // Assert cancellation before a scope/snapshot read or a network response can
  // discover the changed context and accidentally satisfy the regression.
  assert.equal(request.options.signal.aborted, true);
  assert.equal(request.settled, false, 'the HTTP response is still outstanding');
  assert.ok(notifications > 0, 'actual bridge notification reached the session');
  assert.equal(subscriptions.size, 0, 'the pending session released its bridge subscription');
  assert.equal(ui.signal.aborted, false, 'UI cancellation did not retire this request');
  assert.equal(h.state.view, view); assert.equal(h.shell.dataset.nativeAccountId, actor);
  assert.equal(h.shell.dataset.nativeLibraryId, library);
  assert.equal(h.state.player.playbackQueue, queue); assert.equal(h.engine().roles.current, null);
  assert.equal(h.platform.contexts.length, 0); assert.equal(h.platform.sockets.length, 0);
  assert.equal(h.platform.nodes.length, 0); assert.equal(requests('/native-playback-target').length, 0);

  // A valid playable reply for the retired request must not create a queue or
  // open audio even though the caller's UI signal and callback remain current.
  const item_ref = F.id(21), catalog_ref = F.id(11), inventory_album_ref = `inventory-album:${library}:11`;
  const inventory_track_ref = `inventory-track:${library}:101`, path = '/synthetic/retired-context/101.flac';
  request.resolve({status: 'ready', context_ref: context, data: {top_ref: F.TOP, revision: '7',
    unavailable_items: [], albums: [{item_ref, catalog_ref, inventory_album_ref, album_ref: 'Retired context album',
      tracks: [{queue_item_ref: `${item_ref}:101`,
        source: {revision: '7', item_ref, catalog_ref, inventory_album_ref, inventory_track_ref, canonical_track_ref: 'canonical-101'},
        native_target: {track_ref: path, path, inventory_track_ref, title: 'Retired context track',
          artist: 'Top Artist', album_title: 'Retired context album', duration_seconds: 90}}]}]}});
  assert.equal((await work).error?.name, 'AbortError'); await h.flush();
  assert.equal(subscriptions.size, 0); assert.equal(h.state.player.playbackQueue, queue);
  assert.equal(requests('/native-playback-target').length, 0);
  assert.equal(h.engine().roles.current, null); assert.equal(h.engine().roles.continuity, null);
  assert.equal(h.platform.contexts.length, 0); assert.equal(h.platform.sockets.length, 0);
  assert.equal(h.platform.nodes.length, 0); assert.equal(session.snapshot(F.TOP, scopeKey), null);
});

test('pending UI abort while the real audio context awaits resume cannot later start sound', async t => {
  const h = await environment(t); h.platform.holds.resume = true;
  const work = h.play(); await h.flush(); h.replyCapture(); await h.flush(); h.replyTarget(); await h.openSockets();
  const context = h.platform.contexts.at(-1), resume = context?.resumeGate;
  assert.ok(resume, 'actual native start reached the audio-context boundary');
  h.depart(); await h.flush();
  const sent = h.platform.nodes.reduce((count, node) => count + node.sent.filter(value => value.type === 'play').length, 0);
  resume.resolve(); await h.openSockets();
  assert.ok((await work).error, 'a cancelled native admission cannot report a successful session');
  assert.equal(h.engine().roles.current, null); assert.equal(h.engine().roles.continuity, null);
  assert.equal(h.platform.nodes.reduce((count, node) => count + node.sent.filter(value => value.type === 'play').length, 0), sent);
  assert.equal(h.listeners.size, 0);
});

for (const stage of ['capture', 'target']) test(`a duplicate start supersedes the pending ${stage} admission without accepting its late reply`, async t => {
  const h = await environment(t), first = h.play(); await h.flush();
  if (stage === 'target') {h.replyCapture(); await h.flush();}
  const stale = stage === 'capture' ? h.captureRequests().at(-1) : h.targetRequests().at(-1);
  const latest = h.play({topRef: F.OTHER, revision: '8'}); await h.flush();
  assert.equal(stale.options.signal.aborted, true); assert.equal(h.listeners.size, 1);
  const role = await h.acceptStart(latest);
  const queue = h.state.player.playbackQueue, sockets = h.platform.sockets.length;
  if (stage === 'capture') h.replyCapture(stale); else h.replyTarget(stale);
  assert.equal((await first).error?.name, 'AbortError'); await h.flush();
  assert.equal(h.engine().roles.current, role); assert.equal(h.state.player.playbackQueue, queue);
  assert.equal(h.platform.sockets.length, sockets); assert.equal(h.listeners.size, 1);
  assert.equal(h.session.snapshot(F.TOP, h.scopeKey), null);
  assert.equal(h.session.snapshot(F.OTHER, h.scopeKey).revision, '8');
});

test('a reentrant admission callback preserves the latest start before the older entry exists', async t => {
  const h = await environment(t);
  let latest = null, once = false;
  const first = h.play({isCurrent() {
    if (!once) {once = true; latest = h.play({topRef: F.OTHER, revision: '8'});}
    return true;
  }});
  await h.flush();
  assert.ok(latest); assert.equal((await first).error?.name, 'AbortError');
  assert.equal(h.captureRequests().length, 1); assert.equal(h.listeners.size, 1);
  await h.acceptStart(latest);
  assert.equal(h.session.snapshot(F.TOP, h.scopeKey), null);
  assert.equal(h.session.snapshot(F.OTHER, h.scopeKey).revision, '8');
});

test('reentry while an older capture is being accepted cannot retire the newer provider', async t => {
  const h = await environment(t);
  let latest = null, reenter = false;
  const first = h.play({isCurrent() {
    if (reenter) {reenter = false; latest = h.play({topRef: F.OTHER, revision: '8'});}
    return true;
  }});
  await h.flush(); reenter = true; h.replyCapture(); await h.flush();
  assert.ok(latest); assert.equal((await first).error?.name, 'AbortError');
  assert.equal(h.captureRequests().length, 2); assert.equal(h.listeners.size, 1);
  await h.acceptStart(latest);
  assert.equal(h.session.snapshot(F.TOP, h.scopeKey), null);
  assert.equal(h.session.snapshot(F.OTHER, h.scopeKey).revision, '8');
  assert.equal(h.targetRequests().length, 1);
});

test('starting an already visited Top captures afresh from the beginning and retires only its predecessor', async t => {
  const h = await environment(t); await h.acceptStart();
  await h.acceptTransition(outcome(h.c.playCompactQueueOffset(1)));
  const previous = h.state.player.playbackQueue;
  assert.equal(previous.currentIndex, 1);
  const role = await h.acceptStart(h.play());
  assert.notEqual(h.state.player.playbackQueue, previous);
  assert.equal(h.state.player.playbackQueue.currentIndex, 0);
  assert.equal(role.track.path, '/synthetic/fresh/101.flac');
  assert.equal(h.captureRequests().length, 2); assert.equal(h.targetRequests().length, 3);
  assert.equal(h.native.describe(previous).ended, true); assert.equal(h.listeners.size, 1);
});

test('accepted mode edits preserve the playing role and visited prefix without a fresh capture or restart', async t => {
  const h = await environment(t); t.mock.method(Math, 'random', () => 0);
  await h.acceptStart(); await h.acceptTransition(outcome(h.c.playCompactQueueOffset(1)));
  const role = h.engine().roles.current, queue = h.state.player.playbackQueue;
  const socket = h.engine().socket, context = h.engine().context, payload = h.state.player.current;
  const prefix = queue.tracks.slice(0, 2);
  const commandCount = () => h.platform.sockets.flatMap(value => value.sent).filter(value => value.type === 'open').length;
  const before = commandCount();
  assert.equal(h.session.configure(F.TOP, h.scopeKey, {mode: 'random_albums', stopAfterAlbum: true}), true);
  await h.flush();
  assert.equal(h.engine().roles.current, role); assert.equal(h.engine().socket, socket);
  assert.equal(h.engine().context, context); assert.equal(h.state.player.current, payload);
  assert.equal(queue.currentIndex, 1); assert.equal(queue.tracks[0], prefix[0]); assert.equal(queue.tracks[1], prefix[1]);
  assert.equal(h.captureRequests().length, 1); assert.equal(commandCount(), before);
  assert.equal(h.native.shouldStop(queue), true);
  assert.deepEqual(plain(h.session.snapshot(F.TOP, h.scopeKey)),
    {topRef: F.TOP, revision: '7', mode: 'random_albums', stopAfterAlbum: true, unavailable: 0});
  assert.equal(h.session.configure(F.OTHER, h.scopeKey, {mode: 'in_order'}), false);
  assert.equal(h.session.configure(F.TOP, 'stale-scope', {mode: 'in_order'}), false);
});

test('native retirement closes the surviving provider and aborts its outstanding continuation after UI disposal', async t => {
  const h = await environment(t); await h.acceptStart(); h.depart();
  const queue = h.state.player.playbackQueue;
  const work = outcome(h.native.prepareNext(queue)); await h.flush();
  const request = h.targetRequests().at(-1);
  assert.equal(h.targetRequests().length, 2); assert.equal(request.options.signal.aborted, false);
  h.native.dispose(queue);
  assert.equal(request.options.signal.aborted, true); assert.equal(h.listeners.size, 0);
  h.replyTarget(request); assert.equal((await work).error?.name, 'AbortError'); await h.flush();
  assert.equal(h.session.snapshot(F.TOP, h.scopeKey), null);
  assert.equal(h.engine().roles.current, null); assert.equal(h.engine().roles.continuity, null);
  const requests = h.targetRequests().length;
  assert.equal(await h.native.prepareNext(queue), null);
  assert.equal(h.session.configure(F.TOP, h.scopeKey, {stopAfterAlbum: false}), false);
  assert.equal(h.targetRequests().length, requests);
});

for (const observation of ['notification', 'fresh launch', 'snapshot', 'configure'])
  test(`ordinary replacement retires its old Top on ${observation} without closing the successor`, async t => {
    const h = await environment(t); await h.acceptStart();
    const queue = h.state.player.playbackQueue;
    const payload = ordinaryTrack('Top session successor');
    h.c.setAlbumPlaybackQueue({name: payload.album, artist: payload.artist, tracks: [{path: payload.path,
      title: payload.title, duration_seconds: payload.durationSeconds, disc_number: 1, track_number: 1}]}, payload.path);
    assert.notEqual(h.state.player.playbackQueue, queue, 'actual ordinary queue owner replaced the Top queue');
    const successor = await start(h, payload);
    assert.equal(await successor.work, true);
    const socket = h.engine().socket, context = h.engine().context;
    if (observation === 'notification') h.notify();
    if (observation === 'snapshot') assert.equal(h.session.snapshot(F.OTHER, h.scopeKey), null);
    if (observation === 'configure') assert.equal(h.session.configure(F.OTHER, h.scopeKey, {mode: 'in_order'}), false);
    if (observation === 'fresh launch') {
      const work = h.play({topRef: F.OTHER, revision: '8'}); await h.flush();
      assert.equal(h.listeners.size, 1, 'fresh pending capture remains after predecessor subscription retires');
      assert.equal(h.engine().roles.current, successor.role, 'a capture alone cannot replace ordinary audio');
      h.replyCapture(undefined, {empty: true});
      const result = await work;
      assert.equal(result.error, undefined); assert.deepEqual(plain(result.value), {started: false, unavailable: 0});
    }
    await h.flush();
    assert.equal(h.listeners.size, 0, 'observation, rather than this later snapshot, released the predecessor');
    assert.equal(h.session.snapshot(F.TOP, h.scopeKey), null);
    assert.equal(h.native.describe(queue).ended, true);
    assert.equal(h.engine().roles.current, successor.role);
    assert.equal(h.engine().socket, socket); assert.equal(h.engine().context, context);
    assert.equal(socket.closeCount, 0); assert.equal(context.closeCount, 0);
  });
