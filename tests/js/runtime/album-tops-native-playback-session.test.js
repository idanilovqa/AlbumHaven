'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readRepo} = require('./native-home-harness.cjs');
const {actualChoiceEnvironment, settle} = require('./album-tops-native-fixtures/actual-choice-runtime.cjs');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
const {fixture, start, track: ordinaryTrack} = require('./search-native-fixtures/ownership-platform.cjs');

let getAlbumTopPlaybackSession, mountAlbumTopPlaybackControls;
test.before(async () => {
  ({getAlbumTopPlaybackSession} = await F.load('album-tops/playback-session.mjs'));
  ({mountAlbumTopPlaybackControls} = await F.load('album-tops/playback-controls.mjs'));
});
const outcome = work => Promise.resolve(work).then(value => ({value}), error => ({error}));
const plain = value => JSON.parse(JSON.stringify(value));

// Complete native owners come from ownership-platform. This adapter exposes
// those owners directly; it replaces neither a provider nor a playback owner.
// The Set represents mounted-UI notifications only. The actual Album Tops
// bridge and native consumer have separate connected acceptance coverage.
async function environment(t, {blocks = [[101, 102], [103, 104], [105, 106]], popularity = {}, choice = false} = {}) {
  const h = await fixture(t), native = h.owner('TopPlaybackRuntime');
  const transport = h.c.AlbumHavenPrivateUITransport, listeners = new Set();
  const scopeKey = JSON.stringify([h.shell.dataset.nativeAccountId, h.shell.dataset.nativeLibraryId,
    transport.context(), transport.generation()]);
  const context = transport.context(), library = h.shell.dataset.nativeLibraryId;
  const notify = () => {for (const listener of [...listeners]) if (listeners.has(listener)) listener();};
  const dom = choice ? actualChoiceEnvironment() : null;
  const choices = [];
  if (dom) for (const file of ['loop-range-controls.js', 'playback-control-cluster.js']) {
    vm.runInContext(readRepo(`music_app/static/js/runtime/${file}`), dom.context, {filename: file});
  }
  const runtime = Object.freeze({
    ...(dom ? {...dom.runtime,
      openChoice(trigger, options) {choices.push(options); return dom.runtime.openChoice(trigger, options);},
      playbackControlHtml: dom.context.renderPlaybackControlCluster,
      playbackControlElements: dom.context.getPlaybackControlClusterElements,
      mountPlaybackOptions: dom.context.mountLoopEditActionControl} : {}),
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
          native_target: target(number, 'captured'),
          ...(Object.hasOwn(popularity, number) ? {popularity: popularity[number] === null ? null : {
            provider: 'lastfm', metric: 'overall_scrobbles', count: popularity[number],
            observed_at: '2001-01-01T00:00:00+00:00'}} : {})}))};
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
  let controls = null, controlProps = null;
  if (dom) {
    const status = dom.document.createElement('div'); dom.document.body.append(status);
    controlProps = {resourceKind: 'album_top', isCurrent: () => uiCurrent,
      state: {scopeKey, selectedTopRef: F.TOP, directory: {status: 'ready'},
        detail: {status: 'ready', data: F.detail()}}};
    controls = mountAlbumTopPlaybackControls(dom.host, status, runtime, controlProps);
  }
  t.after(async () => {controls?.dispose(); ui.abort(); transport.invalidate(); unsubscribeTransport(); listeners.clear();
    await h.flush(); if (dom) {await settle(); dom.assertClean();}});
  return Object.assign(h, {native, transport, sessionRuntime: runtime, session, scopeKey, contextRef: context, listeners, notify, ui,
    captureRequests, targetRequests, replyCapture, replyTarget, play, finishStart, acceptStart, acceptTransition, openSockets, depart,
    dom, controls, controlProps, choices});
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

async function chooseTopMode(h, value) {
  const play = h.dom.host.querySelector('[data-playback-control-action="play"]');
  play.focus(); h.dom.click(h.dom.host.querySelector('[data-playback-control-action="options"]'));
  const row = h.dom.document.querySelector(`[data-foobar-format="${value}"]`);
  assert.ok(row, 'canonical Choice renders the requested mode'); assert.equal(row.disabled, false);
  h.dom.click(row); await settle(); await h.flush();
}
function queueTrackIds(h) {
  return Array.from(h.state.player.playbackQueue.tracks, row => Number(row.path.split('/').at(-1).split('.')[0]));
}
async function startFromTopControl(h) {
  h.dom.click(h.dom.host.querySelector('[data-playback-control-action="play"]'));
  await h.flush(); h.replyCapture(); await h.flush(); h.replyTarget(); await h.openSockets(); await settle();
  assert.ok(h.engine().roles.current, 'actual Top session and streaming owner accepted the Choice/Play command');
  assert.equal(h.dom.host.querySelector('[data-playback-control-action="play"]').disabled, false);
}

for (const unknown of [false, true]) test(`actual Choice popular Play captures every album occurrence (${unknown ? 'all unknown' : 'ties and zero'})`, async t => {
  const blocks = [[101, 102, 103, 104, 105], [201, 202, 203]];
  const h = await environment(t, {choice: true, blocks,
    popularity: unknown ? {101: null, 202: null} : {101: null, 102: 0, 103: 8, 104: 8, 201: null, 202: 7}});
  await chooseTopMode(h, 'popular_songs');
  assert.equal(h.dom.host.querySelector('[data-playback-mode-badge]').textContent, 'P');
  assert.match(h.dom.host.querySelector('[data-playback-control-action="play"]').getAttribute('aria-label'), /Most popular songs/);
  assert.equal(h.captureRequests().length, 0); assert.equal(h.targetRequests().length, 0);
  await startFromTopControl(h);
  const expected = unknown ? blocks.flat() : [103, 104, 102, 101, 105, 202, 201, 203];
  assert.deepEqual(queueTrackIds(h), expected);
  assert.equal(h.state.player.current.path, `/synthetic/fresh/${expected[0]}.flac`);
  assert.deepEqual(JSON.parse(h.captureRequests()[0].options.body), {revision: '7'});
  assert.equal(h.captureRequests().length, 1); assert.equal(h.targetRequests().length, 1);
  assert.equal(Object.keys(JSON.parse(h.targetRequests()[0].options.body)).length, 6);
  assert.equal(h.session.snapshot(F.TOP, h.scopeKey).mode, 'popular_songs');
  assert.equal(h.c.buildPersistedPlayerState(), null);
});

test('actual Choice popularity edit after Previous preserves audio and the full visited prefix', async t => {
  const h = await environment(t, {choice: true, blocks: [[101, 102, 103, 104], [201, 202, 203]],
    popularity: {103: 0, 104: 8, 201: 1, 202: 9}});
  await h.acceptStart(); await h.acceptTransition(outcome(h.c.playCompactQueueOffset(1)));
  await h.acceptTransition(outcome(h.c.playCompactQueueOffset(-1)));
  const queue = h.state.player.playbackQueue, prefix = queue.tracks.slice(0, 2);
  const current = h.state.player.current, role = h.engine().roles.current;
  const socket = h.engine().socket, context = h.engine().context;
  const opens = () => h.platform.sockets.flatMap(value => value.sent).filter(value => value.type === 'open').length;
  const before = opens();
  const nextSource = JSON.parse(h.targetRequests()[1].options.body);
  await chooseTopMode(h, 'popular_songs');
  assert.deepEqual(queueTrackIds(h), [101, 102, 104, 103, 202, 201, 203]);
  assert.equal(queue.currentIndex, 0); assert.equal(queue.tracks[0], prefix[0]); assert.equal(queue.tracks[1], prefix[1]);
  assert.equal(h.state.player.current, current); assert.equal(h.engine().roles.current, role);
  assert.equal(h.engine().socket, socket); assert.equal(h.engine().context, context); assert.equal(opens(), before);
  assert.equal(h.captureRequests().length, 1); assert.equal(h.targetRequests().length, 4);
  const continuity = h.targetRequests()[3];
  assert.deepEqual(JSON.parse(continuity.options.body), nextSource);
  assert.equal(Object.keys(nextSource).length, 6);
  assert.equal(continuity.options.signal.aborted, false);
  assert.equal(h.session.snapshot(F.TOP, h.scopeKey).mode, 'popular_songs');
  assert.equal(h.dom.host.querySelector('[data-playback-mode-badge]').textContent, 'P');
  const next = outcome(h.c.playCompactQueueOffset(1)); await h.flush();
  assert.equal(continuity.options.signal.aborted, true, 'deliberate Next supersedes pending continuity authority');
  assert.equal(h.targetRequests().length, 5);
  assert.deepEqual(JSON.parse(h.targetRequests()[4].options.body), nextSource);
  h.replyTarget(continuity); await h.flush();
  assert.equal(h.state.player.current, current); assert.equal(h.engine().roles.current, role);
  assert.equal(queue.currentIndex, 0); assert.equal(opens(), before);
  await h.acceptTransition(next);
  assert.equal(h.state.player.current.path, '/synthetic/fresh/102.flac');
  assert.equal(h.captureRequests().length, 1); assert.equal(h.targetRequests().length, 5);
});

test('actual popular session keeps Stop independent and deliberate Next crosses only after the album boundary', async t => {
  const h = await environment(t, {choice: true, blocks: [[101, 102], [201, 202]],
    popularity: {101: 0, 102: 9, 201: 0, 202: 7}});
  await chooseTopMode(h, 'popular_songs'); await chooseTopMode(h, 'stop'); await startFromTopControl(h);
  assert.deepEqual(queueTrackIds(h), [102, 101, 202, 201]);
  assert.equal(h.session.snapshot(F.TOP, h.scopeKey).stopAfterAlbum, true);
  await h.acceptTransition(outcome(h.c.playCompactQueueOffset(1)));
  const queue = h.state.player.playbackQueue, requests = h.targetRequests().length;
  assert.equal(h.state.player.current.path, '/synthetic/fresh/101.flac');
  assert.equal(h.native.shouldStop(queue), true); assert.equal(await h.native.prepareNext(queue), null);
  assert.equal(h.targetRequests().length, requests);
  await h.acceptTransition(outcome(h.c.playCompactQueueOffset(1)));
  assert.equal(h.state.player.current.path, '/synthetic/fresh/202.flac');
  assert.equal(h.session.snapshot(F.TOP, h.scopeKey).mode, 'popular_songs');
  assert.equal(h.session.snapshot(F.TOP, h.scopeKey).stopAfterAlbum, true);
});

test('actual Choice toggles Stop during active popular playback without restarting audio or reusing stale continuity', async t => {
  const h = await environment(t, {choice: true, blocks: [[101], [201, 202]],
    popularity: {101: 0, 201: 0, 202: 9}});
  await chooseTopMode(h, 'popular_songs'); await startFromTopControl(h);
  const queue = h.state.player.playbackQueue, current = h.state.player.current, role = h.engine().roles.current;
  const socket = h.engine().socket, context = h.engine().context;
  const opens = () => h.platform.sockets.flatMap(value => value.sent).filter(value => value.type === 'open').length;
  const before = opens(), library = h.shell.dataset.nativeLibraryId;
  const nextSource = {revision: '7', item_ref: F.id(22), catalog_ref: F.id(12),
    inventory_album_ref: `inventory-album:${library}:12`, inventory_track_ref: `inventory-track:${library}:202`,
    canonical_track_ref: 'canonical-202'};
  const assertCurrent = stopAfterAlbum => {
    assert.equal(h.state.player.playbackQueue, queue); assert.deepEqual(queueTrackIds(h), [101, 202, 201]);
    assert.equal(queue.currentIndex, 0); assert.equal(h.state.player.current, current);
    assert.equal(h.engine().roles.current, role); assert.equal(h.engine().roles.continuity, null);
    assert.equal(h.engine().socket, socket); assert.equal(h.engine().context, context);
    assert.equal(socket.closeCount, 0); assert.equal(context.closeCount, 0); assert.equal(opens(), before);
    assert.equal(h.captureRequests().length, 1); assert.equal(h.c.buildPersistedPlayerState(), null);
    assert.equal(h.session.snapshot(F.TOP, h.scopeKey).mode, 'popular_songs');
    assert.equal(h.session.snapshot(F.TOP, h.scopeKey).stopAfterAlbum, stopAfterAlbum);
    assert.equal(h.dom.host.querySelector('[data-playback-mode-badge]').textContent, 'P');
    assert.equal(h.native.shouldStop(queue), stopAfterAlbum);
  };
  assertCurrent(false); assert.equal(h.targetRequests().length, 1);

  await chooseTopMode(h, 'stop');
  assertCurrent(true); assert.equal(h.targetRequests().length, 1);
  assert.equal(await h.native.prepareNext(queue), null);
  assert.equal(h.targetRequests().length, 1);

  await chooseTopMode(h, 'stop');
  assertCurrent(false); assert.equal(h.targetRequests().length, 2);
  const stale = h.targetRequests()[1];
  assert.deepEqual(JSON.parse(stale.options.body), nextSource);
  assert.equal(stale.options.signal.aborted, false);
  await chooseTopMode(h, 'stop');
  assertCurrent(true); assert.equal(stale.options.signal.aborted, true);
  assert.equal(h.targetRequests().length, 2);
  h.replyTarget(stale); await h.flush();
  assertCurrent(true); assert.equal(h.engine().pendingContinuityTrack, null);

  await chooseTopMode(h, 'stop');
  assertCurrent(false); assert.equal(h.targetRequests().length, 3);
  const fresh = h.targetRequests()[2];
  assert.notEqual(fresh.options.signal, stale.options.signal);
  assert.equal(fresh.options.signal.aborted, false);
  assert.deepEqual(JSON.parse(fresh.options.body), nextSource);
  h.replyTarget(fresh); await h.flush();
  assertCurrent(false);
  assert.equal(h.engine().pendingContinuityTrack?.path, '/synthetic/fresh/202.flac');
  assert.equal(h.native.peek(queue), h.engine().pendingContinuityTrack);

  await chooseTopMode(h, 'stop');
  assertCurrent(true); assert.equal(h.targetRequests().length, 3);
  assert.equal(h.engine().pendingContinuityTrack, null); assert.equal(h.native.peek(queue), null);
});

for (const stage of ['capture', 'target']) test(`popular pending ${stage} cannot revive after current UI retirement`, async t => {
  const h = await environment(t, {popularity: {102: 20}}), work = h.play({mode: 'popular_songs'});
  await h.flush(); if (stage === 'target') {h.replyCapture(); await h.flush();}
  const stale = stage === 'capture' ? h.captureRequests().at(-1) : h.targetRequests().at(-1);
  h.depart(); assert.equal(stale.options.signal.aborted, true);
  if (stage === 'capture') h.replyCapture(stale); else h.replyTarget(stale);
  assert.equal((await work).error?.name, 'AbortError'); await h.flush(); assertNoPlayback(h);
  assert.equal(h.targetRequests().length, stage === 'capture' ? 0 : 1);
});

test('retained actual popular Choice callback cannot reconfigure after scope retirement', async t => {
  const h = await environment(t, {choice: true, popularity: {102: 20}});
  await chooseTopMode(h, 'popular_songs'); await startFromTopControl(h);
  const play = h.dom.host.querySelector('[data-playback-control-action="play"]');
  play.focus(); h.dom.click(h.dom.host.querySelector('[data-playback-control-action="options"]'));
  const callback = h.choices.at(-1).onSelect;
  const oldRow = h.dom.document.querySelector('[data-foobar-format="popular_songs"]');
  const requests = h.targetRequests().length, captures = h.captureRequests().length;
  h.depart(); h.transport.invalidate(); h.controls.update(h.controlProps); await h.flush();
  assert.equal(callback('popular_songs'), false); assert.equal(callback('stop'), false);
  h.dom.click(oldRow); await settle();
  assert.equal(h.session.snapshot(F.TOP, h.scopeKey), null); assert.equal(h.engine().roles.current, null);
  assert.equal(h.targetRequests().length, requests); assert.equal(h.captureRequests().length, captures);
});

test('invalid popularity never reaches real session native admission', async t => {
  const h = await environment(t, {popularity: {101: -1}}), work = h.play({mode: 'popular_songs'});
  await h.flush(); h.replyCapture(); assert.equal((await work).error?.status, 502);
  assert.equal(h.targetRequests().length, 0); assertNoPlayback(h);
});
