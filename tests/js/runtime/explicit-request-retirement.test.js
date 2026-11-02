'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, track, deferred} = require('./search-native-fixtures/ownership-platform.cjs');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createAlbumTopBackendProviders, createTopPlaybackSource;
test.before(async () => {
  ({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));
  ({createTopPlaybackSource} = await F.load('album-tops/playback-source.mjs'));
});
const outcome = work => Promise.resolve(work).then(value => ({value}), error => ({error}));
const plain = value => JSON.parse(JSON.stringify(value));

async function scenario(t, run, options = {}) {
  const h = await fixture(t, undefined, options), work = [], gates = [];
  h.own = promise => {const observed = outcome(promise); work.push(observed); return observed;};
  h.gate = () => {const gate = deferred(); gates.push(gate); return gate;};
  h.open = async () => {
    await h.flush();
    for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
    await h.flush();
  };
  h.select = value => h.own(h.c.playTrackFromPayload(value));
  h.finish = async () => {
    const role = h.engine().roles.current;
    assert.ok(role);
    const node = h.engine().node;
    const configure = node.sent.filter(message => message.type === 'configure'
      && message.generation === role.generation).at(-1);
    const play = node.sent.filter(message => message.type === 'play'
      && message.generation === role.generation).at(-1);
    assert.ok(configure && play && node.sent.indexOf(configure) < node.sent.indexOf(play));
    assert.ok(Number.isSafeInteger(play.playbackIntentId) && play.playbackIntentId > 0,
      'EOF carries the actual configured PLAY intent, not invented authority');
    node.emit({type: 'ended', generation: role.generation,
      streamId: role.streamId, timelineFrame: 48000, playbackIntentId: play.playbackIntentId});
    await h.flush();
    assert.equal(h.c.getPlayerPlaybackSnapshot().ended, true);
  };
  h.complete = async pending => {
    await h.open(); const result = await pending;
    assert.equal(result.error, undefined, result.error?.stack); assert.equal(result.value, true);
  };
  h.disposals = [];
  h.events = [];
  const unsubscribe = h.queue.subscribe(() => h.events.push({type: 'queue', current: h.state.player.current,
    queue: h.state.player.playbackQueue}));
  const failures = [];
  try { await run(h); } catch (error) {failures.push(error);}
  const attempt = callback => {
    try {return callback();} catch (error) {failures.push(error); return undefined;}
  };
  const attemptAsync = async callback => {
    try {return await callback();} catch (error) {failures.push(error); return undefined;}
  };
  attempt(unsubscribe);
  for (const dispose of h.disposals.reverse()) attempt(dispose);
  // Queue abort listeners may synchronously start a successor. Retire that
  // selection too, before opening any failure-path provider/preparation gate.
  attempt(() => h.queueOwner().stopped());
  attempt(() => h.c.retirePlayerSelectionOwnership('c03-test-teardown'));
  const stopped = attempt(() => outcome(h.c.stopStreamingPlayback('c03-test-teardown')));
  // The synthetic fetch fixture does not itself honor AbortSignal. Reject its
  // held responses here, rather than waiting for a later fixture after-hook.
  // Late cleanup-only requests receive the same rejection; action requests
  // never receive automatic replies or errors.
  const fetch = h.c.fetch;
  const rejectPendingRequests = () => {
    for (const request of h.requests) if (!request.settled) attempt(() => request.reject(
      Object.assign(new Error('C03 retired fixture request'), {name: 'AbortError'})));
  };
  h.c.fetch = (...args) => {
    const result = fetch(...args);
    rejectPendingRequests();
    return result;
  };
  rejectPendingRequests();
  h.platform.holds.module = false;
  h.platform.holds.resume = false;
  for (const gate of gates) attempt(() => gate.resolve(null));
  for (const context of h.platform.contexts) {
    attempt(() => context.module.resolve());
    attempt(() => context.resumeGate?.resolve());
    attempt(() => context.closeGate?.resolve());
  }
  await attemptAsync(() => h.flush());
  if (stopped) {
    const result = await attemptAsync(() => stopped);
    if (result?.error) failures.push(result.error);
    else attempt(() => assert.equal(result?.value, true, 'actual owned stop completed'));
  }
  await attemptAsync(() => Promise.all(work));
  await attemptAsync(() => h.flush());
  rejectPendingRequests();
  h.c.fetch = fetch;
  // A captured preparePromise may allocate in its queued microtask after stop.
  // The lifecycle guard must retire those resources too; count is not authority.
  const engine = h.engine();
  for (const name of ['context', 'node', 'socket', 'preparePromise', 'stopPromise', 'playbackAttempt'])
    attempt(() => assert.equal(engine[name], null, `retired engine ${name}`));
  for (const role of ['current', 'continuity'])
    attempt(() => assert.equal(engine.roles[role], null, `no surviving ${role} role`));
  attempt(() => assert.equal(engine.snapshot.paused, true));
  attempt(() => assert.equal(engine.snapshot.src, ''));
  for (const context of h.platform.contexts) {
    attempt(() => assert.equal(context.state, 'closed', 'every allocated context is physically retired'));
    attempt(() => assert.ok(context.closeCount >= 1));
  }
  for (const node of h.platform.nodes) {
    attempt(() => assert.ok(node.disconnectCount >= 1, 'every allocated node is disconnected'));
    attempt(() => assert.ok(node.sent.some(message => message.type === 'stop')));
  }
  for (const socket of h.platform.sockets) {
    attempt(() => assert.equal(socket.readyState, 3, 'every allocated socket is closed'));
    attempt(() => assert.ok(socket.closeCount >= 1));
  }
  attempt(() => assert.equal(h.queueOwner().hasPendingStart(), false));
  attempt(() => assert.equal(h.c.getActivePlaybackOwnershipHandle(), null));
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError([...new Set(failures)], 'C03 action/cleanup failed');
}

async function source(h, suffix = 'A') {
  const calls = [], currentCalls = [];
  let resolve = null, current = null;
  const target = {...track(suffix), album_title: `Album ${suffix}`, availability: 'local', source_readable: true,
    allowed_actions: {can_read: true, can_play: true}, playback_state: {can_start_here: true}};
  const capture = {display: {title: target.title, artist: target.artist, album: target.album_title},
    isCurrent() {currentCalls.push('current'); return current ? current() : true;},
    resolveMetadata: async () => target,
    resolve(options) {calls.push(options); return resolve ? resolve(options) : Promise.resolve(target);},
  };
  const [id] = await h.queue.enqueue([capture], 'end'); await h.flush();
  return {id, target, calls, currentCalls, setResolve: value => {resolve = value;},
    setCurrent: value => {current = value;}, item: () => h.queue.getSnapshot().entries.find(entry => entry.id === id)};
}
async function pendingSource(h) {
  const a = await source(h), gate = h.gate();
  a.setResolve(() => gate.promise);
  const work = h.own(h.queue.play(a.id));
  await h.flush();
  const signal = a.calls.at(-1).signal;
  assert.equal(signal.aborted, false);
  assert.equal(h.queueOwner().hasPendingStart(), true);
  return {...a, gate, work, signal};
}
async function installedSource(h) {
  const a = await source(h), previousQueue = h.state.player.playbackQueue;
  h.platform.holds.module = true;
  const work = h.own(h.queue.play(a.id)); await h.flush();
  const captured = h.queueOwner().captureStop();
  assert.ok(captured.start); assert.equal(captured.start.signal.aborted, false);
  assert.equal(h.state.player.playbackQueue.explicitContext.entryId, a.id);
  assert.equal(h.state.player.current, null);
  const context = h.platform.contexts.at(-1);
  assert.ok(context?.moduleURL, 'actual A worklet module preparation has begun');
  assert.equal(h.platform.nodes.some(node => node.context === context), false,
    'A module gate still prevents its worklet allocation');
  h.platform.holds.module = false;
  return {...a, work, signal: captured.start.signal, previousQueue,
    installedQueue: h.state.player.playbackQueue, context};
}
function rejectOld(a) {a.gate.reject(Object.assign(new Error('Old provider stopped'), {name: 'AbortError'}));}
function assertReady(a) {
  const item = a.item();
  assert.equal(item.sourceReadable, true);
  assert.equal(item.status, 'Ready', 'retained source must not become unavailable after stale completion');
}

// Genuine Top capture/provider/receipt, copied in bounded form from the existing
// native Top integration owner; only actual transport replies are synthetic.
async function top(h, t) {
  const native = h.owner('TopPlaybackRuntime'), transport = h.c.AlbumHavenPrivateUITransport;
  const scope = () => JSON.stringify([h.shell.dataset.nativeAccountId, h.shell.dataset.nativeLibraryId,
    transport.context(), transport.generation()]);
  const scopeKey = scope(), context = transport.context(), library = h.shell.dataset.nativeLibraryId;
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: value => value === scope()});
  const item_ref = F.id(21), catalog_ref = F.id(11), inventory_album_ref = `inventory-album:${library}:11`;
  const tuple = {revision: '7', item_ref, catalog_ref, inventory_album_ref,
    inventory_track_ref: `inventory-track:${library}:101`, canonical_track_ref: 'canonical-101'};
  const target = {path: '/synthetic/top/101.flac', track_ref: '/synthetic/top/101.flac', title: 'Top B',
    artist: 'Top Artist', album_title: 'Top Album', duration_seconds: 90, inventory_track_ref: tuple.inventory_track_ref};
  const captureWork = h.own(providers.captureNativeQueue({top_ref: F.TOP, revision: '7'}, {scopeKey, isCurrent: () => scope() === scopeKey}));
  await h.flush();
  const request = h.requests.find(row => new URL(row.url, h.location).pathname.endsWith('/native-queue'));
  assert.ok(request);
  request.resolve({status: 'ready', context_ref: context, data: {top_ref: F.TOP, revision: '7', unavailable_items: [],
    albums: [{item_ref, catalog_ref, inventory_album_ref, album_ref: 'Top native album',
      tracks: [{queue_item_ref: `${item_ref}:101`, source: tuple, native_target: target}]}]}});
  const captured = await captureWork; assert.equal(captured.error, undefined);
  const queue = native.create({capture: captured.value, isCurrent: () => scope() === scopeKey,
    onRetire: () => providers.dispose(),
    createSource: isCurrent => createTopPlaybackSource({capture: captured.value, providers, scopeKey, isCurrent})});
  h.disposals.push(() => native.dispose(queue));
  const requests = () => h.requests.filter(row => new URL(row.url, h.location).pathname.endsWith('/native-playback-target'));
  return {native, queue, requests,
    start: () => h.own(native.start(queue)),
    reply() {
      const request = requests().at(-1); assert.ok(request);
      assert.deepEqual(JSON.parse(request.options.body), tuple);
      request.resolve({status: 'ready', context_ref: context, data: {top_ref: F.TOP, source: tuple, native_target: target}});
    }};
}

test('C03 01 held explicit resolve is aborted immediately by ordinary selection', async t => scenario(t, async h => {
  const a = await pendingSource(h), b = track('B'), incoming = h.select(b);
  assert.equal(a.signal.aborted, true);
  await h.complete(incoming); const handle = h.c.getActivePlaybackOwnershipHandle(), events = h.events.slice();
  rejectOld(a); assert.ok((await a.work).error); await h.flush();
  assertReady(a); assert.deepEqual(h.events, events);
  assert.strictEqual(h.state.player.current, b); assert.strictEqual(h.c.getActivePlaybackOwnershipHandle(), handle);
}));

test('C03 02 held Top preparation retires explicit request before its provider settles', async t => scenario(t, async h => {
  const b = await top(h, t), a = await pendingSource(h), incoming = b.start();
  assert.equal(a.signal.aborted, true);
  await h.flush(); assert.equal(b.requests().length, 1); assert.equal(h.platform.contexts.length, 0);
  const events = h.events.slice(); rejectOld(a); assert.ok((await a.work).error); await h.flush();
  assertReady(a); assert.deepEqual(h.events, events);
  b.reply(); await h.complete(incoming);
  assert.equal(b.native.hasBinding(h.state.player.current), true);
  assert.equal(b.native.isPayloadCurrent(h.state.player.current), true);
  assert.strictEqual(h.engine().roles.current.track, h.state.player.current);
}));

for (const mode of ['play', 'skip']) test(`C03 0${mode === 'play' ? 3 : 4} explicit ${mode} keeps its own start signal live`, async t => scenario(t, async h => {
  const a = await source(h);
  if (mode === 'skip') await h.complete(h.select(track('Ordinary')));
  const priorResumes = new Map(h.platform.contexts.map(context => [context,
    {gate: context.resumeGate, count: context.resumeCount}]));
  h.platform.holds.module = mode === 'play';
  h.platform.holds.resume = mode === 'skip';
  const work = h.own(mode === 'play' ? h.queue.play(a.id) : h.queueOwner().skip(1));
  if (mode === 'skip') await h.open(); else await h.flush();
  const request = h.queueOwner().captureStop().start;
  assert.ok(request); assert.equal(request.signal.aborted, false);
  const context = h.platform.contexts.at(-1);
  assert.ok(context);
  h.platform.holds.module = false;
  h.platform.holds.resume = false;
  if (mode === 'skip') {
    assert.ok(context.resumeGate, 'real browser resume is held before skip can finish');
    assert.notStrictEqual(context.resumeGate, priorResumes.get(context)?.gate);
    assert.ok(context.resumeCount > (priorResumes.get(context)?.count || 0));
    context.state = 'running';
    context.resumeGate.resolve();
  } else context.module.resolve();
  await h.complete(work);
  assert.equal(request.signal.aborted, false); assert.equal(h.queueOwner().hasPendingStart(), false);
  assert.equal(h.state.player.current.explicitEntryId, a.id);
}));

for (const invalid of ['invalid-path', 'unbound-top']) test(`C03 05 denied ${invalid} selection preserves the old request`, async t => scenario(t, async h => {
  const a = await pendingSource(h);
  const incoming = invalid === 'invalid-path' ? {path: ''} : {...track('B'), sourceKind: 'album-top'};
  assert.equal((await h.select(incoming)).value, false); assert.equal(a.signal.aborted, false);
  a.gate.resolve(a.target); await h.complete(a.work);
  assert.equal(h.state.player.current.explicitEntryId, a.id);
}));

test('C03 06 abort reentry supersedes B before B starts Top preparation', async t => scenario(t, async h => {
  const b = await top(h, t), a = await pendingSource(h), c = track('C'); let successor;
  a.signal.addEventListener('abort', () => {successor = h.select(c);}, {once: true});
  const incoming = b.start(); assert.equal(a.signal.aborted, true); assert.ok(successor);
  assert.equal((await incoming).value, false); assert.equal(b.requests().length, 0);
  await h.complete(successor); const events = h.events.slice(); rejectOld(a); assert.ok((await a.work).error);
  assert.deepEqual(h.events, events); assert.strictEqual(h.state.player.current, c);
}));

for (const completion of ['success', 'failure']) test(`C03 07 stale source ${completion} cannot poison retained readiness`, async t => scenario(t, async h => {
  const a = await pendingSource(h), b = track('B'); await h.complete(h.select(b));
  const events = h.events.slice();
  if (completion === 'success') a.gate.resolve({...a.target, title: 'Stale result'}); else rejectOld(a);
  assert.ok((await a.work).error); await h.flush(); assertReady(a); assert.deepEqual(h.events, events);
  a.setResolve(async () => a.target);
  await h.finish();
  await h.complete(h.own(h.queue.play(a.id)));
  assert.equal(h.state.player.current.path, a.target.path);
}));

test('C03 07 source currentness reentry cannot bind a stale provider identity', async t => scenario(t, async h => {
  const a = await pendingSource(h), b = track('B'); let successor, entered = false;
  a.setCurrent(() => {
    if (!entered) {entered = true; successor = h.select(b);}
    return true;
  });
  a.gate.resolve({...a.target, inventory_track_ref: `inventory-track:${h.shell.dataset.nativeLibraryId}:991`});
  assert.ok((await a.work).error); assert.equal(entered, true); await h.complete(successor);
  assertReady(a);
  a.setCurrent(null); a.setResolve(async () => ({...a.target,
    inventory_track_ref: `inventory-track:${h.shell.dataset.nativeLibraryId}:992`}));
  await h.finish();
  await h.complete(h.own(h.queue.play(a.id)));
  assert.equal(h.state.player.current.inventory_track_ref, `inventory-track:${h.shell.dataset.nativeLibraryId}:992`);
}));

test('C03 08 genuine current resolver failure stays visible to its caller', async t => scenario(t, async h => {
  const a = await pendingSource(h), error = new Error('Current provider failure'), before = h.events.length;
  a.gate.reject(error); assert.strictEqual((await a.work).error, error);
  assert.equal(a.item().canPlay, false); assert.equal(h.events.length, before + 1);
  assert.equal(h.queueOwner().hasPendingStart(), false);
}));

test('C03 09 installed rollback precedes abort reentry and old finally cannot overwrite C', async t => scenario(t, async h => {
  const a = await installedSource(h), c = track('C'); let atAbort, successor;
  a.signal.addEventListener('abort', () => {
    atAbort = {queue: h.state.player.playbackQueue, pending: h.queueOwner().hasPendingStart()};
    successor = h.select(c);
  }, {once: true});
  const incoming = h.select(track('B'));
  assert.deepEqual(atAbort, {queue: a.previousQueue, pending: false});
  assert.ok(successor); a.context.module.resolve();
  assert.equal((await incoming).value, false); await h.complete(successor);
  assert.ok((await a.work).error); assert.strictEqual(h.state.player.current, c);
}));

function onScopeRead(h, callback) {
  const lookup = h.document.getElementById.bind(h.document), reads = [];
  let armed = true, witness;
  const selectionBefore = h.owner('playerTrackSelectionToken');
  h.document.getElementById = id => {
    reads.push(id);
    // Real TrackActions scope reads both shell and mobile-home. Forward every
    // lookup; this finite platform callback never replaces the scope owner.
    if (id === 'mobile-home' && armed) {
      armed = false;
      witness = {selection: h.owner('playerTrackSelectionToken'),
        reservation: h.owner('pendingPlayerTrackStart'), pending: h.queueOwner().hasPendingStart()};
      callback();
    }
    return lookup(id);
  };
  h.disposals.push(() => {h.document.getElementById = lookup;});
  return {reads, entered: () => !armed, assertBoundary() {
    assert.ok(witness, 'actual fresh TrackActions scope read occurred');
    assert.ok(witness.reservation, 'incoming facade has reserved its request');
    assert.equal(witness.selection, selectionBefore, 'scope read precedes admitted-selection effects');
    assert.equal(witness.pending, true, 'captured old request is still attached before the scope read');
  }};
}

for (const changed of ['actor', 'library', 'empty-actor', 'empty-library'])
  test(`C03 10 fresh ${changed} scope cannot restore an old installed queue`, async t => scenario(t, async h => {
    const a = await installedSource(h); let atAbort;
    a.signal.addEventListener('abort', () => {atAbort = h.state.player.playbackQueue;}, {once: true});
    const observed = onScopeRead(h, () => {
      const key = changed.endsWith('actor') ? 'nativeAccountId' : 'nativeLibraryId';
      h.shell.dataset[key] = changed.startsWith('empty') ? '' : '999';
    });
    const incoming = h.select(track('B'));
    assert.equal(observed.entered(), true); observed.assertBoundary();
    assert.equal(a.signal.aborted, true);
    assert.strictEqual(atAbort, a.installedQueue, 'no transient old-scope restoration before abort');
    a.context.module.resolve(); await h.open();
    assert.notEqual((await incoming).value, true); assert.ok((await a.work).error);
  }));

test('C03 10 scope-read reentry cannot detach or abort a new C request', async t => scenario(t, async h => {
  const a = await pendingSource(h), c = track('C'); let successor;
  const observed = onScopeRead(h, () => {successor = h.select(c);});
  const incoming = h.select(track('B'));
  assert.equal(observed.entered(), true); observed.assertBoundary(); assert.ok(successor);
  assert.equal((await incoming).value, false); await h.complete(successor);
  rejectOld(a); assert.ok((await a.work).error);
  assert.strictEqual(h.state.player.current, c);
  assert.equal(h.c.isPlaybackOwnershipHandleCurrent(h.c.getActivePlaybackOwnershipHandle()), true);
}));

test('C03 10 scope read changing generation and session cannot adopt post-read identities', async t => scenario(t, async h => {
  const a = await installedSource(h), before = h.queueOwner().captureStop(); let afterCallback;
  const observed = onScopeRead(h, () => {
    h.queueOwner().replaced();
    afterCallback = h.queueOwner().captureStop();
  });
  const incoming = h.select(track('B'));
  assert.equal(observed.entered(), true); observed.assertBoundary();
  assert.strictEqual(afterCallback.owner, before.owner);
  assert.strictEqual(afterCallback.start, before.start);
  assert.equal(afterCallback.epoch, before.epoch);
  assert.notEqual(afterCallback.generation, before.generation);
  assert.notEqual(afterCallback.session, before.session);
  assert.equal(a.signal.aborted, false, 'a changed scope-read transaction cannot detach the old request');
  a.context.module.resolve(); await h.open(); await incoming; await a.work;
}));

test('C03 10 scope change inside abort suppresses stale rollback notification', async t => scenario(t, async h => {
  const a = await installedSource(h); let atAbort, eventsAtAbort;
  a.signal.addEventListener('abort', () => {
    atAbort = h.state.player.playbackQueue;
    eventsAtAbort = h.events.slice();
    h.shell.dataset.nativeAccountId = '999';
  }, {once: true});
  const incoming = h.select(track('B'));
  assert.strictEqual(atAbort, a.previousQueue);
  assert.deepEqual(h.events, eventsAtAbort, 'retirement must not notify the previous scope after abort');
  a.context.module.resolve(); await h.open(); await incoming; await a.work;
}));

test('C03 11 held Top selection preserves unrelated refresh until actual admission', async t => scenario(t, async h => {
  const b = await top(h, t);
  await h.complete(h.select(track('Ordinary')));
  const a = await source(h), refreshGate = h.gate();
  a.setResolve(() => refreshGate.promise);
  const refresh = h.own(h.queueOwner().prepareNext({automatic: false})); await h.flush();
  const refreshSignal = a.calls.at(-1).signal;
  assert.equal(refreshSignal.aborted, false);
  assert.equal(h.queueOwner().hasPendingStart(), false);
  const incoming = b.start();
  assert.equal(refreshSignal.aborted, false);
  await h.flush(); b.reply(); await h.complete(incoming);
  assert.equal(refreshSignal.aborted, true, 'existing admitted selection still retires refresh');
  refreshGate.resolve(a.target); await refresh;
  assert.equal(h.queue.getSnapshot().halted, false);
}));

test('C03 07 caller-currentness reentry cannot install or notify a stale explicit result', async t => scenario(t, async h => {
  const a = await source(h), gate = h.gate(), b = track('B'); let successor, entered = false;
  a.setResolve(() => gate.promise);
  const pending = h.own(h.queue.play(a.id, {isCurrent: () => {
    if (!entered) {entered = true; successor = h.select(b);}
    return true;
  }}));
  await h.flush(); gate.resolve(a.target);
  assert.ok((await pending).error); assert.equal(entered, true); await h.complete(successor);
  assertReady(a); assert.strictEqual(h.state.player.current, b);
  for (const event of h.events) assert.notEqual(event.queue?.explicitContext?.entryId, a.id,
    'no notification may expose A installation after the caller callback superseded it');
}));

test('C03 09 stopped owner with changed selection token preserves installed queue', async t => scenario(t, async h => {
  const a = await installedSource(h), before = h.owner('playerTrackSelectionToken'); let atAbort;
  a.signal.addEventListener('abort', () => {atAbort = h.state.player.playbackQueue;}, {once: true});
  h.c.retirePlayerSelectionOwnership('c03-independent-selection-retirement');
  assert.notEqual(h.owner('playerTrackSelectionToken'), before);
  assert.equal(h.queueOwner().hasPendingStart(), false, 'actual stopped owner already retired A');
  const incoming = h.select(track('B'));
  assert.equal(a.signal.aborted, true); assert.strictEqual(atAbort, a.installedQueue);
  a.context.module.resolve(); await h.complete(incoming); assert.ok((await a.work).error);
}));

test('C03 11 held Top lookup with no pending request preserves the active current engine', async t => scenario(t, async h => {
  const b = await top(h, t), playing = track('Playing'); await h.complete(h.select(playing));
  const role = h.engine().roles.current, context = h.engine().context, socket = h.engine().socket;
  assert.equal(h.queueOwner().hasPendingStart(), false);
  const incoming = b.start(); await h.flush();
  assert.strictEqual(h.state.player.current, playing); assert.strictEqual(h.engine().roles.current, role);
  assert.strictEqual(h.engine().context, context); assert.strictEqual(h.engine().socket, socket);
  assert.equal(context.state, 'running'); assert.equal(socket.readyState, 1);
  b.reply(); await h.complete(incoming);
}));

// Only browser AbortSignal property access is controlled. Native listener
// methods retain the actual signal as receiver; the real controller owns abort.
function observedCallerSignal(controller, readAborted) {
  return new Proxy(controller.signal, {
    get(target, property) {
      if (property === 'aborted') return readAborted(target.aborted);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

for (const mode of ['passive', 'abort-return-prior-false', 'throw'])
  test(`C03 P1 caller signal ${mode} preserves request cancellation boundaries`, async t => scenario(t, async h => {
    const a = await source(h, 'Signal'), gate = h.gate(), controller = new AbortController();
    const events = [], identityReads = [];
    const getterFailure = new Error('controlled caller signal getter failure');
    let armed = false, activated = false;
    controller.signal.addEventListener('abort', () => events.push({type: 'caller-abort'}), {once: true});
    const signal = observedCallerSignal(controller, capturedAborted => {
      events.push({type: 'read-aborted', armed, capturedAborted});
      if (armed && mode === 'throw') {activated = true; throw getterFailure;}
      if (armed && !activated && mode === 'abort-return-prior-false') {
        activated = true;
        controller.abort();
        return capturedAborted;
      }
      return capturedAborted;
    });
    const target = {...a.target};
    Object.defineProperty(target, 'inventory_track_ref', {enumerable: true, get() {
      identityReads.push({aborted: controller.signal.aborted});
      return `inventory-track:${h.shell.dataset.nativeLibraryId}:993`;
    }});
    a.setResolve(() => gate.promise);
    const pending = h.own(h.queue.play(a.id, {signal, isCurrent: () => {
      events.push({type: 'caller-current'});
      armed = true;
      return true;
    }}));
    await h.flush();
    assert.equal(controller.signal.aborted, false);
    assert.equal(armed, false, 'provider is held before caller-currentness boundary');
    const queueAtResolution = h.state.player.playbackQueue;
    const eventsAtResolution = h.events.slice();
    gate.resolve(target);
    await h.open();
    const result = await pending;
    assert.equal(events.some(event => event.type === 'read-aborted'), true);
    if (mode === 'passive') {
      assert.equal(result.error, undefined, result.error?.stack);
      assert.equal(result.value, true);
      assert.equal(controller.signal.aborted, false);
      assert.equal(h.state.player.current.explicitEntryId, a.id);
      assert.ok(identityReads.length > 0);
    } else {
      assert.equal(activated, true, 'late external getter is actually reached, not assumed');
      assert.equal(result.error?.name, 'AbortError', 'callback failure/cancellation remains an owned cancellation');
      assert.notStrictEqual(result.error, getterFailure);
      assert.strictEqual(h.state.player.playbackQueue, queueAtResolution);
      assert.deepEqual(h.events, eventsAtResolution, 'no stale source failure or install notification');
      assert.equal(h.platform.contexts.length, 0);
      assert.equal(h.platform.nodes.length, 0);
      assert.equal(h.platform.sockets.length, 0);
      if (mode === 'abort-return-prior-false') {
        assert.equal(controller.signal.aborted, true);
        assert.equal(events.some(event => event.type === 'caller-abort'), true);
        assert.ok(identityReads.length > 0, 'provider identity was genuinely observed');
      }
    }
    for (const read of identityReads) assert.equal(read.aborted, false,
      'provider identity must not be read for binding/publication after actual caller cancellation');
    assert.equal(h.queueOwner().hasPendingStart(), false);
  }));

for (const reenter of [false, true])
  test(`C03 P2 options signal getter ${reenter ? 'selects C before stale B can adopt its entry' : 'passively forwards a real signal'}`, async t => scenario(t, async h => {
    const controller = new AbortController(), b = track('Signal-B'), c = track('Signal-C');
    const events = [];
    let selected = false, successor;
    const options = {get signal() {
      events.push('signal-read');
      if (reenter && !selected) {
        selected = true;
        events.push('select-C');
        successor = h.select(c);
      }
      return controller.signal;
    }};
    const incoming = h.own(h.c.playTrackFromPayload(b, options));
    await h.open();
    const result = await incoming;
    assert.ok(events.length > 0);
    assert.equal(controller.signal.aborted, false);
    if (reenter) {
      assert.equal(selected, true);
      assert.ok(successor);
      assert.equal(result.error, undefined, result.error?.stack);
      assert.equal(result.value, false, 'B must retain its original entry identity from before the getter');
      await h.complete(successor);
      assert.strictEqual(h.state.player.current, c);
      assert.strictEqual(h.engine().roles.current.track, c);
      assert.equal(h.c.isPlaybackOwnershipHandleCurrent(h.c.getActivePlaybackOwnershipHandle()), true);
      for (const socket of h.platform.sockets)
        for (const message of socket.sent)
          if (message.type === 'open') assert.equal(message.path, c.path, 'stale B must not open a decoder');
    } else {
      assert.equal(result.error, undefined, result.error?.stack);
      assert.equal(result.value, true);
      assert.strictEqual(h.state.player.current, b);
      assert.strictEqual(h.engine().roles.current.track, b);
    }
  }));
