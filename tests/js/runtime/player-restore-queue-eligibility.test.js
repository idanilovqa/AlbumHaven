'use strict';
// Finite browser/server inputs; real Queue planner, restore/publication owners,
// media grant, resolver and streaming facade. No audible/browser acceptance claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('./search-native-fixtures/queue-actions.cjs');
const {fixture, world, track, deferred} = require('./search-native-fixtures/ownership-platform.cjs');
const SAVED = 'albumhaven.playerState.v1';
const outcome = work => Promise.resolve(work).then(value => ({value}), error => ({error}));

async function queueRestoreFixture(t) {
  let h;
  const streams = [], actions = [];
  t.after(async () => {
    if (!h) return;
    try {
      h.c.retirePlayerRestoreAttempt('queue-preview-test-cleanup');
      h.c.retirePlayerSelectionOwnership('queue-preview-test-cleanup');
      const handle = h.c.getActivePlaybackOwnershipHandle();
      if (handle) h.c.releasePlaybackOwnership('stopped', handle);
      const stopping = h.c.stopStreamingPlayback('queue-preview-test-cleanup');
      for (const context of h.platform.contexts) {
        context.module.resolve(); context.resumeGate?.resolve(); context.closeGate?.resolve();
      }
      for (const request of h.requests) if (!request.settled) request.reject(
        Object.assign(new Error('test-owned request retired'), {name: 'AbortError'}));
      await stopping;
      const results = await Promise.all(streams);
      await Promise.all(actions); // Actions are asserted by their owning cases, including expected denial.
      const errors = results.filter(result => result.error).map(result => result.error);
      if (errors.length) throw new AggregateError(errors, 'Owned streaming work failed');
      assert.equal(h.engine().roles.current, null);
      assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
    } finally { h.c.disposePlaybackOwnershipCoordinator(); }
  });
  h = await fixture(t, world(), {readyState: 'loading'});
  const start = h.c.startStreamingTrack;
  h.c.startStreamingTrack = (...args) => {
    const result = start(...args); streams.push(outcome(result)); return result;
  };
  const data = {track: {...track('QueuePreview435'), durationSeconds: 181}, playbackQueue: null,
    currentTime: 12, paused: false, loop: {active: false, start: 0, end: 30}};
  h.c.localStorage.setItem(SAVED, JSON.stringify(data));
  h.state.player.restoredFromStorage = false;
  // Existing documented false-provider seam; does not grant media/owner authority.
  h.c.canRestoreActivePlayback = () => false;
  const search = await Q.admit(h, Q.ready({presentation: 'tracks'}));
  return Object.assign(h, {data, search, streams,
    own(promise) {const result = outcome(promise); actions.push(result); return result;}});
}
function publishOnly(h) {
  const before = JSON.stringify(h.c.getPlayerPlaybackSnapshot());
  h.c.restorePlayerState();
  assert.equal(h.state.player.current?.path, h.data.track.path, 'actual synchronous display preview exists');
  assert.ok(h.owner('playerRestoreAttempt')?.pageshow);
  assert.equal(h.platform.contexts.length, 0);
  assert.equal(h.engine().roles.current, null);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
  assert.equal(JSON.stringify(h.c.getPlayerPlaybackSnapshot()), before, 'preview never alters engine authority');
}
async function playQueued(h, id) {
  const requestIndex = h.requests.length;
  const work = h.own(h.queue.play(id));
  await h.flush();
  assert.ok(h.requests[requestIndex], 'explicit action must reach the actual fresh queue resolver');
  assert.equal(Q.batchCommand(h, requestIndex).intent, 'play');
  h.reply(requestIndex, Q.batchReply(h, requestIndex));
  await h.flush();
  for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
  assert.deepEqual(await work, {value: true});
  await h.flush();
  assert.equal(h.queue.getSnapshot().currentId, id);
  assert.equal(h.state.player.current.path, Q.playTarget('inventory-track:9:101').path);
  assert.equal(h.engine().roles.current.track.path, h.state.player.current.path);
  const selected = h.engine().roles.current;
  h.c.dispatchEvent(new h.c.Event('pageshow')); await h.flush();
  assert.strictEqual(h.engine().roles.current, selected, 'retired restore cannot restart behind user Queue playback');
}

for (const order of ['before-preview', 'after-preview']) {
  test(`denied435 queue: enqueue ${order} is ready and user action starts without a phantom playback anchor`, async t => {
    const h = await queueRestoreFixture(t);
    if (order === 'after-preview') publishOnly(h);
    const enqueued = await Q.enqueue(h, h.search, {indices: [0], timing: 'end'});
    if (order === 'before-preview') publishOnly(h);
    const snapshot = h.queue.getSnapshot(), row = snapshot.entries.find(entry => entry.id === enqueued.ids[0]);
    assert.equal(row.ready, true, 'a display-only preview cannot create an active end-of-queue anchor');
    assert.equal(row.canPlay, true, 'real source permissions plus no active context permit the explicit action');
    assert.equal(h.queue.getSnapshot(), snapshot, 'the enabled snapshot is actually cached');
    const requests = h.requests.length;
    assert.deepEqual([...h.queue.timingOptions()].filter(option => option.enabled).map(option => option.value), ['next', 'end']);
    await h.flush();
    assert.equal(h.requests.length, requests, 'snapshot and timing reads do not authorize work');
    assert.equal(h.platform.contexts.length, 0, 'queue metadata/enqueue does not start preview audio');
    await playQueued(h, enqueued.ids[0]);
  });
}

test('denied435 queue: retiming after preview stays ready rather than capturing its phantom active track', async t => {
  const h = await queueRestoreFixture(t);
  const enqueued = await Q.enqueue(h, h.search, {indices: [0], timing: 'end'});
  publishOnly(h);
  assert.equal(h.queue.retime(enqueued.ids[0], 'next'), true);
  assert.equal(h.queue.retime(enqueued.ids[0], 'end'), true);
  const row = h.queue.getSnapshot().entries.find(entry => entry.id === enqueued.ids[0]);
  assert.equal(row.timing, 'end');
  assert.equal(row.ready, true);
  assert.equal(row.canPlay, true);
  assert.equal(h.platform.contexts.length, 0);
  await playQueued(h, enqueued.ids[0]);
});

test('denied435 queue: enqueue after retired exact preview remains ready for a real explicit start', async t => {
  const h = await queueRestoreFixture(t);
  publishOnly(h);
  const preview = h.state.player.current;
  h.c.retirePlayerRestoreAttempt('queue-preview-explicit-retirement');
  assert.equal(h.owner('playerRestoreAttempt'), null);
  assert.strictEqual(h.state.player.current, preview);
  assert.equal(h.c.persistPlayerState(true), false, 'retirement does not turn preview into admitted playback');
  const enqueued = await Q.enqueue(h, h.search, {indices: [0], timing: 'end'});
  const row = h.queue.getSnapshot().entries.find(entry => entry.id === enqueued.ids[0]);
  assert.equal(row.ready, true);
  assert.equal(row.canPlay, true);
  await playQueued(h, enqueued.ids[0]);
});

for (const transition of ['paused-admission', 'same-object-setter']) {
  test(`denied435 queue: ${transition} invalidates cached canPlay without a planner change`, async t => {
    const h = await queueRestoreFixture(t);
    const enqueued = await Q.enqueue(h, h.search, {indices: [0], timing: 'end'});
    publishOnly(h);
    const canonical = h.state.player.current;
    const before = h.queue.getSnapshot();
    assert.strictEqual(h.queue.getSnapshot(), before, 'cache was populated before ownership transition');
    if (transition === 'paused-admission') {
      h.c.dispatchEvent(new h.c.Event('pageshow')); await h.flush();
      for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
      await Promise.all(h.streams); await h.flush();
      assert.ok(h.engine().roles.current, 'genuine false-fallback paused role is admitted');
      assert.equal(h.c.getPlayerPlaybackSnapshot().paused, true);
    } else {
      const result = h.c.setCurrentPlayerTrack(canonical, {persist: false});
      assert.strictEqual(result, canonical, 'actual successful same-object setter creates a new publication');
      assert.equal(h.owner('playerRestoreAttempt'), null);
    }
    assert.strictEqual(h.state.player.current, canonical);
    const after = h.queue.getSnapshot();
    assert.equal(after.revision, before.revision, 'no planner mutation explains the eligibility change');
    assert.notStrictEqual(after, before, 'a changed publication/admission invalidates cached canPlay');
    assert.equal(before.entries[0].canPlay, true, 'recorded display-only state allowed user Queue start');
    assert.equal(after.entries[0].canPlay, false, 'ordinary current publication preserves the existing active-track block');
    const requests = h.requests.length;
    const denial = h.own(h.queue.play(enqueued.ids[0]));
    await h.flush();
    assert.equal(h.requests.length, requests, 'blocked action cannot resolve another media target');
    const denied = await denial;
    assert.match(denied.error?.message || '', /not ready to play/);
    assert.strictEqual(h.state.player.current, canonical);
  });
}

test('denied435 queue: genuinely admitted paused manual playback remains blocked for standalone Queue start', async t => {
  const h = await queueRestoreFixture(t);
  const enqueued = await Q.enqueue(h, h.search, {indices: [0], timing: 'end'});
  const playing = h.own(h.c.playTrackFromPayload(track('RealPausedCurrent435'), {autoplay: false}));
  await h.flush();
  for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
  assert.deepEqual(await playing, {value: true});
  const current = h.state.player.current, role = h.engine().roles.current;
  assert.ok(current && role);
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, true);
  const snapshot = h.queue.getSnapshot();
  assert.equal(snapshot.entries[0].ready, true);
  assert.equal(snapshot.entries[0].canPlay, false);
  const requests = h.requests.length;
  const denial = h.own(h.queue.play(enqueued.ids[0]));
  await h.flush();
  assert.equal(h.requests.length, requests, 'denied action must settle without issuing a held resolver');
  const denied = await denial;
  assert.match(denied.error?.message || '', /not ready to play/);
  assert.strictEqual(h.state.player.current, current);
  assert.strictEqual(h.engine().roles.current, role);
});

test('denied435 queue: reads and enqueue cannot preload continuity while genuine paused admission is held', async t => {
  const h = await queueRestoreFixture(t), suspended = deferred();
  let suspendCalls = 0;
  h.platform.onContextCreate = context => {
    // Finite native state/settlement boundary; the real start owns its role.
    context.state = 'running';
    context.suspend = () => { suspendCalls++; return suspended.promise.then(() => { if (context.state !== 'closed') context.state = 'suspended'; }); };
  };
  try {
    publishOnly(h);
    h.c.dispatchEvent(new h.c.Event('pageshow')); await h.flush();
    for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
    await h.flush();
    assert.equal(suspendCalls, 1, 'real autoplay:false start reached the held native suspend');
    const role = h.engine().roles.current, context = h.engine().context;
    assert.ok(role);
    assert.equal(h.streams.length, 1);
    const requests = h.requests.length;
    h.queue.getSnapshot(); h.queue.timingOptions(); await h.flush();
    assert.equal(h.requests.length, requests, 'read-only classification does not resolve media');
    const enqueued = await Q.enqueue(h, h.search, {indices: [0], timing: 'end'});
    const row = h.queue.getSnapshot().entries.find(entry => entry.id === enqueued.ids[0]);
    assert.equal(row.ready, true, 'unadmitted role does not create an active scheduling anchor');
    assert.equal(row.canPlay, true);
    assert.equal(h.requests.length, enqueued.start + 2, 'only explicit enqueue metadata/play requests; no automatic continuity resolver');
    assert.strictEqual(h.engine().roles.current, role);
    assert.strictEqual(h.engine().context, context);
    assert.equal(h.engine().roles.continuity, null);
    assert.equal(h.engine().pendingContinuityTrack ?? null, null);
    assert.equal(h.platform.contexts.length, 1, 'no additional audio resource set');
    assert.equal(h.platform.sockets[0].sent.filter(message => message.type === 'open' && message.role === 'continuity').length, 0);
    assert.equal(context.resumeCount, 0);
  } finally {
    h.c.retirePlayerRestoreAttempt('held-queue-preview-test-retirement');
    suspended.resolve();
    await Promise.all(h.streams);
  }
});
