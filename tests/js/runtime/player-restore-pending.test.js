'use strict';
// Finite platform contract tests, not browser/LS09 evidence. Playback, Top,
// ExplicitQueue, capabilities and transport owners are the served implementations.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
const Q = require('./search-native-fixtures/queue-actions.cjs');
const {fixture, world, track} = require('./search-native-fixtures/ownership-platform.cjs');
const KEY = 'albumhaven.playerState.v1';
const outcome = work => Promise.resolve(work).then(value => ({value}), error => ({error}));
const plain = value => JSON.parse(JSON.stringify(value));
let createAlbumTopBackendProviders, createTopPlaybackSource;
test.before(async () => {
  ({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));
  ({createTopPlaybackSource} = await F.load('album-tops/playback-source.mjs'));
});

async function environment(t) {
  let h;
  const works = [], controllers = [], dispose = [];
  t.after(async () => {
    if (!h) return;
    for (const controller of controllers) controller.abort();
    for (const close of dispose) close();
    h.c.retirePlayerRestoreAttempt('pending-restore-test-cleanup');
    h.c.retirePlayerSelectionOwnership('pending-restore-test-cleanup');
    // These are the exact external requests owned by this fixture, not a signal
    // that depends on a new product callback existing on the RED baseline.
    for (const request of h.requests) if (!request.settled)
      request.reject(Object.assign(new Error('owned pending request cancelled'), {name: 'AbortError'}));
    await Promise.all(works);
    const attempt = h.c.captureStreamingPlaybackAttempt();
    if (attempt) await h.c.stopStreamingPlayback('pending-restore-test-cleanup', {expectedAttempt: attempt});
    if (h.engine().stopPromise) await h.engine().stopPromise;
    assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
    assert.equal(h.engine().roles.current, null);
    h.c.disposePlaybackOwnershipCoordinator();
  });
  h = await fixture(t, world(), {readyState: 'loading'});
  function own(work) {const result = outcome(work); works.push(result); return result;}
  function controller() {const value = new h.c.AbortController(); controllers.push(value); return value;}
  const cached = {track: {...track('CachedStartup'), durationSeconds: 181}, playbackQueue: null,
    currentTime: 33, paused: false, loop: {active: false, start: 0, end: 30}};
  function seed() {
    h.c.localStorage.setItem(KEY, JSON.stringify(cached));
    h.state.player.restoredFromStorage = false;
  }
  seed();
  return Object.assign(h, {own, controller, dispose, cached, seed});
}

async function topQueue(h) {
  const native = h.owner('TopPlaybackRuntime'), transport = h.c.AlbumHavenPrivateUITransport;
  const scope = () => JSON.stringify([h.shell.dataset.nativeAccountId, h.shell.dataset.nativeLibraryId,
    transport.context(), transport.generation()]);
  const scopeKey = scope(), context = transport.context(), library = h.shell.dataset.nativeLibraryId;
  const provider = createAlbumTopBackendProviders({transport, acceptsScope: value => value === scope()});
  const item_ref = F.id(21), catalog_ref = F.id(11), inventory_album_ref = `inventory-album:${library}:11`;
  const target = {track_ref: '/synthetic/top/pending-101.flac', path: '/synthetic/top/pending-101.flac',
    title: 'Pending Top', artist: 'Top Artist', album_title: 'Top Album', duration_seconds: 90,
    inventory_track_ref: `inventory-track:${library}:101`};
  const source = {revision: '7', item_ref, catalog_ref, inventory_album_ref,
    inventory_track_ref: target.inventory_track_ref, canonical_track_ref: 'canonical-101'};
  const wire = {top_ref: F.TOP, revision: '7', albums: [{item_ref, catalog_ref, inventory_album_ref,
    album_ref: 'Pending Top Album', tracks: [{queue_item_ref: `${item_ref}:101`, source, native_target: target}]}], unavailable_items: []};
  const work = provider.captureNativeQueue({top_ref: F.TOP, revision: '7'}, {scopeKey, isCurrent: () => scope() === scopeKey});
  await h.flush();
  const request = h.requests.find(row => !row.settled && new URL(row.url, h.location).pathname.endsWith('/native-queue'));
  assert.ok(request);
  request.resolve({status: 'ready', context_ref: context, data: wire});
  const capture = await work;
  provider.dispose();
  const sessionProvider = createAlbumTopBackendProviders({transport, acceptsScope: value => value === scope()});
  const queue = native.create({capture, isCurrent: () => scope() === scopeKey, onRetire: () => sessionProvider.dispose(),
    createSource: isCurrent => createTopPlaybackSource({capture, providers: sessionProvider, scopeKey, isCurrent})});
  h.dispose.push(() => native.dispose(queue));
  const pending = () => h.requests.filter(row => !row.settled
    && new URL(row.url, h.location).pathname.endsWith('/native-playback-target'));
  function reply(row = pending().at(-1)) {
    assert.ok(row, 'real Top fresh resolver request');
    assert.deepEqual(JSON.parse(row.options.body), source);
    row.resolve({status: 'ready', context_ref: context, data: {top_ref: F.TOP, source, native_target: target}});
  }
  return {native, queue, pending, reply};
}

function assertRestoreDidNotSteal(h, {queue = h.state.player.playbackQueue, stored = h.c.localStorage.getItem(KEY)} = {}) {
  const current = h.state.player.current, session = h.state.player.listenSession;
  const requests = h.requests.length, writes = h.world.writes.length;
  h.c.restorePlayerState();
  assert.strictEqual(h.state.player.playbackQueue, queue, 'automatic restore cannot clear a pending user queue');
  assert.strictEqual(h.state.player.current, current);
  assert.strictEqual(h.state.player.listenSession, session);
  assert.equal(h.owner('playerRestoreAttempt'), null);
  assert.equal(h.c.localStorage.getItem(KEY), stored);
  assert.equal(h.world.writes.length, writes);
  assert.equal(h.requests.length, requests, 'cold exclusion must not resolve albums or media');
}

async function openCreatedSockets(h) {
  await h.flush();
  for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
  await h.flush();
}

test('preview436 pending: genuine Top fresh resolver excludes cached restore before selection admission', async t => {
  const h = await environment(t), top = await topQueue(h), signal = h.controller();
  const work = h.own(top.native.start(top.queue, {signal: signal.signal}));
  await h.flush();
  assert.equal(top.pending().length, 1);
  assert.equal(h.owner('playerSelectionOwnership'), null);
  assert.equal(h.state.player.current, null);
  assert.equal(h.platform.contexts.length, 0);
  assert.strictEqual(h.state.player.playbackQueue, top.queue);
  assertRestoreDidNotSteal(h, {queue: top.queue});
  top.reply();
  await openCreatedSockets(h);
  assert.deepEqual(await work, {value: true});
  assert.equal(h.state.player.current.title, 'Pending Top');
  assert.strictEqual(h.state.player.playbackQueue, top.queue);
});

test('preview436 pending: genuine ExplicitQueue resolution excludes restore before facade selection', async t => {
  const h = await environment(t);
  const snapshot = await Q.admit(h, Q.ready({presentation: 'tracks'}));
  const enqueued = await Q.enqueue(h, snapshot, {indices: [0], timing: 'end'});
  const before = plain(h.queue.getSnapshot()), queue = h.state.player.playbackQueue;
  const signal = h.controller(), index = h.requests.length;
  const work = h.own(h.queue.play(enqueued.ids[0], {signal: signal.signal}));
  await h.flush();
  assert.equal(Q.batchCommand(h, index).intent, 'play');
  assert.equal(h.owner('playerSelectionOwnership'), null);
  assert.equal(h.state.player.current, null);
  assert.equal(h.platform.contexts.length, 0);
  assertRestoreDidNotSteal(h, {queue});
  assert.deepEqual(plain(h.queue.getSnapshot()), before);
  h.reply(index, Q.batchReply(h, index));
  await openCreatedSockets(h);
  assert.deepEqual(await work, {value: true});
  assert.equal(h.queue.getSnapshot().currentId, enqueued.ids[0]);
  assert.equal(h.state.player.current.path, Q.playTarget('inventory-track:9:101').path);
});

test('preview436 pending: manual reservation exists before reentrant restore-retirement callback', async t => {
  const h = await environment(t), payload = track('ManualBeforeRetirement');
  const queue = {tracks: [payload], currentIndex: 0};
  h.state.player.playbackQueue = queue;
  const retire = h.c.retirePlayerRestoreAttempt;
  let observations = null;
  h.c.retirePlayerRestoreAttempt = (...args) => {
    const result = retire(...args);
    if (args[0] === 'manual-selection' && !observations) {
      h.c.restorePlayerState();
      observations = {queue: h.state.player.playbackQueue, current: h.state.player.current,
        restore: h.owner('playerRestoreAttempt'), contexts: h.platform.contexts.length};
    }
    return result;
  };
  const work = h.own(h.c.playTrackFromPayload(payload, {autoplay: false}));
  await openCreatedSockets(h);
  assert.deepEqual(await work, {value: true});
  assert.ok(observations, 'actual manual retirement boundary was reached');
  assert.strictEqual(observations.queue, queue);
  assert.equal(observations.current, null);
  assert.equal(observations.restore, null);
  assert.equal(observations.contexts, 0);
  assert.equal(h.state.player.current.path, payload.path);
});

test('preview436 pending: superseded outer finally cannot clear a nested Top reservation', async t => {
  const h = await environment(t), top = await topQueue(h), signal = h.controller();
  const retire = h.c.retirePlayerRestoreAttempt;
  let nested;
  let entered = false;
  h.c.retirePlayerRestoreAttempt = (...args) => {
    const result = retire(...args);
    if (args[0] === 'manual-selection' && !entered) {
      entered = true;
      nested = h.own(top.native.start(top.queue, {signal: signal.signal}));
    }
    return result;
  };
  const outer = h.own(h.c.playTrackFromPayload(track('SupersededOuter'), {autoplay: false}));
  await h.flush();
  assert.deepEqual(await outer, {value: false});
  assert.ok(nested);
  assert.equal(top.pending().length, 1);
  assert.equal(h.owner('playerSelectionOwnership'), null);
  assertRestoreDidNotSteal(h, {queue: top.queue});
  top.reply();
  await openCreatedSockets(h);
  assert.deepEqual(await nested, {value: true});
  assert.equal(h.state.player.current.title, 'Pending Top');
});

test('preview436 pending: settled failed Top start releases its reservation for genuine cold restore', async t => {
  const h = await environment(t), top = await topQueue(h);
  const work = h.own(top.native.start(top.queue));
  await h.flush();
  const request = top.pending()[0];
  assert.ok(request);
  request.reject(new Error('synthetic fresh resolver unavailable'));
  const result = await work;
  assert.ok(result.error, 'real failed resolver rejects its owner before retry');
  assert.equal(h.state.player.current, null);
  assert.equal(h.owner('playerSelectionOwnership'), null);
  assert.equal(h.platform.contexts.length, 0);
  h.seed();
  h.c.restorePlayerState();
  assert.ok(h.state.player.current, 'a settled reservation must not permanently block cold preview');
  assert.equal(h.state.player.current.path, h.cached.track.path);
  assert.equal(h.state.player.current.durationSeconds, 181);
  assert.ok(h.owner('playerRestoreAttempt')?.pageshow);
  assert.equal(h.platform.contexts.length, 0);
});

test('preview436 pending: reservation precedes real Top cancellation abort callbacks', async t => {
  const h = await environment(t), top = await topQueue(h);
  const old = h.own(top.native.start(top.queue));
  await h.flush();
  const request = top.pending()[0];
  assert.ok(request?.options.signal);
  let observations;
  request.options.signal.addEventListener('abort', () => {
    const queue = h.state.player.playbackQueue, stored = h.c.localStorage.getItem(KEY);
    h.c.restorePlayerState();
    observations = {queue, after: h.state.player.playbackQueue, current: h.state.player.current,
      restore: h.owner('playerRestoreAttempt'), stored, afterStored: h.c.localStorage.getItem(KEY)};
  }, {once: true});
  const payload = track('AfterTopCancel');
  const next = h.own(h.c.playTrackFromPayload(payload, {autoplay: false}));
  await openCreatedSockets(h);
  assert.deepEqual(await next, {value: true});
  assert.ok(observations, 'actual source cancellation synchronously delivered its request abort');
  assert.strictEqual(observations.after, observations.queue);
  assert.equal(observations.current, null);
  assert.equal(observations.restore, null);
  assert.equal(observations.afterStored, observations.stored);
  if (!request.settled) request.reject(Object.assign(new Error('cancelled previous Top request'), {name: 'AbortError'}));
  assert.equal((await old).error?.name, 'AbortError');
  assert.equal(h.state.player.current.path, payload.path);
});
