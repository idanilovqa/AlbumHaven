'use strict';
// Finite browser/transport inputs with served restore, setter, ownership and
// persistence owners. This is command/state evidence, not audible playback.
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('./search-native-fixtures/queue-actions.cjs');
const {fixture, world, track, displayMessages} = require('./search-native-fixtures/ownership-platform.cjs');
const SAVED = 'albumhaven.playerState.v1';
const LEASE = 'albumhaven.playbackOwnership.v1';
const outcome = work => Promise.resolve(work).then(value => ({value}), error => ({error}));

async function deniedFixture(t, {paused = false, media = true} = {}) {
  let h;
  const work = [], starts = [], setters = [], providers = [], bindings = [];
  let paints = 0, listens = 0;
  t.after(async () => {
    if (!h) return;
    try {
      h.c.retirePlayerRestoreAttempt('denied-restore-test-cleanup');
      h.c.retirePlayerSelectionOwnership('denied-restore-test-cleanup');
      const handle = h.c.getActivePlaybackOwnershipHandle();
      if (handle) h.c.releasePlaybackOwnership('stopped', handle);
      const stopping = h.c.stopStreamingPlayback('denied-restore-test-cleanup');
      // Release only this fixture's finite platform gates after retiring owners.
      for (const context of h.platform.contexts) {
        context.module.resolve(); context.resumeGate?.resolve(); context.closeGate?.resolve();
      }
      for (const request of h.requests) if (!request.settled) {
        request.reject(Object.assign(new Error('owned request retired'), {name: 'AbortError'}));
      }
      await stopping;
      const outcomes = await Promise.all(work);
      const errors = outcomes.filter(result => result.error).map(result => result.error);
      if (errors.length) throw new AggregateError(errors, 'Owned denied-restore work rejected');
      assert.equal(h.engine().roles.current, null);
      assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
    } finally { h.c.disposePlaybackOwnershipCoordinator(); }
  });
  h = await fixture(t, world(), {media, readyState: 'loading'});
  const data = {track: {...track('DeniedRestore'), durationSeconds: 181}, playbackQueue: null,
    currentTime: 12, paused, loop: {active: false, start: 0, end: 30}};
  h.c.localStorage.setItem(SAVED, JSON.stringify(data));
  h.state.player.restoredFromStorage = false;
  const start = h.c.startStreamingTrack, setter = h.c.setCurrentPlayerTrack;
  const provider = h.c.canRestoreActivePlayback, bind = h.c.bindPlaybackOwnershipAttempt;
  const ui = h.c.updatePlayerUi, listen = h.c.beginStreamingPlayerListenSession;
  h.c.startStreamingTrack = (input, options) => {
    const row = {input, options, attempt: null}; starts.push(row);
    const result = start(input, {...options, onStartAttempt(attempt) {
      row.attempt = attempt; options.onStartAttempt?.(attempt);
    }});
    row.work = outcome(result); work.push(row.work); return result;
  };
  h.c.setCurrentPlayerTrack = (...args) => {
    const result = setter(...args); setters.push({input: args[0], options: args[1], result}); return result;
  };
  h.c.canRestoreActivePlayback = (...args) => {
    const result = provider(...args); providers.push(result); return result;
  };
  h.c.bindPlaybackOwnershipAttempt = (...args) => { bindings.push(args); return bind(...args); };
  h.c.updatePlayerUi = (...args) => { paints++; return ui(...args); };
  h.c.beginStreamingPlayerListenSession = (...args) => { listens++; return listen(...args); };
  const original = h.c.localStorage.getItem(SAVED), cache = h.state.player.lastPersistedSnapshot;
  const baseline = h.world.writes.length;
  return Object.assign(h, {data, original, cache, starts, setters, providers, bindings, work,
    paints: () => paints, listens: () => listens,
    writes: () => h.world.writes.slice(baseline).filter(row => row.key === SAVED),
    own(promise) {const result = outcome(promise); work.push(result); return result;},
    exactFalse() {h.c.canRestoreActivePlayback = () => { providers.push(false); return false; };},
  });
}

function foreignLease(h) {
  // A valid external-tab storage input, processed by the genuine coordinator.
  const raw = JSON.stringify({tab_id: 'denied-restore-foreign', claim_revision: 435,
    status: 'playing', reason: 'manual_start', updated_at_ms: h.world.now(), expires_at_ms: h.world.now() + 15000});
  h.c.localStorage.setItem(LEASE, raw);
  return raw;
}
async function deliverPageshow(h) {
  h.c.dispatchEvent(new h.c.Event('pageshow'));
  await h.flush();
  for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
  await h.flush();
}
function assertPausedPreparation(h) {
  assert.equal(h.starts.length, 1, 'literal false must reach genuine paused start, not merely paint');
  const row = h.starts[0], role = h.engine().roles.current;
  assert.ok(role);
  assert.equal(h.c.isStreamingPlaybackAttemptCurrent(row.attempt), true);
  assert.strictEqual(role.track, row.input);
  assert.equal(role.track.path, h.data.track.path);
  assert.equal(row.options.startSeconds, 12);
  assert.equal(row.options.autoplay, false);
  assert.equal(Object.hasOwn(row.options, 'allowSuspendedAutoplayFallback'), false);
  assert.equal(Object.hasOwn(row.options, 'onAutoplayStarted'), false);
  assert.equal(h.c.getPlayerPlaybackSnapshot().currentTime, 12);
  assert.equal(h.c.getPlayerPlaybackSnapshot().paused, true);
  assert.equal(h.engine().context.state, 'suspended');
  assert.equal(h.platform.contexts[0].resumeCount, 0);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
  assert.equal(h.bindings.length, 0);
  assert.equal(h.listens(), 0);
  assert.equal(h.state.player.listenSession, null);
  assert.equal(displayMessages(h.world).length, 0);
  return role;
}

test('denied435: literal false without foreign lock admits the exact canonical preview as paused once', async t => {
  const h = await deniedFixture(t); h.exactFalse();
  h.data.track.coverPath = '';
  h.state.modalReleases = [{key: 'denied-decoration', name: h.data.track.album, artist: h.data.track.artist,
    cover_path: '/library/denied-decoration.jpg', tracks: [h.data.track]}];
  h.c.localStorage.setItem(SAVED, JSON.stringify(h.data));
  h.c.restorePlayerState();
  const canonical = h.state.player.current;
  assert.equal(h.platform.contexts.length, 0);
  await deliverPageshow(h);
  assertPausedPreparation(h);
  assert.deepEqual(h.providers, [false]);
  assert.equal(h.setters.length, 1);
  assert.strictEqual(h.state.player.current, canonical);
  assert.strictEqual(h.setters[0].result, canonical);
  assert.equal(canonical.coverPath, '/library/denied-decoration.jpg');
  assert.equal(h.paints(), 1, 'confirmed preview owns the only updatePlayerUi call');
  assert.equal(h.c.persistPlayerState(true), true, 'genuine paused admission lifts only its own preview fence');
  assert.equal(JSON.parse(h.c.localStorage.getItem(SAVED)).currentTime, 12);
  assert.equal(JSON.parse(h.c.localStorage.getItem(SAVED)).paused, true);
});

for (const paused of [false, true]) {
  test(`denied435: real foreign refusal keeps ${paused ? 'saved-paused direct' : 'saved-playing pageshow'} preparation unassociated`, async t => {
    const h = await deniedFixture(t, {paused}), lease = foreignLease(h);
    assert.equal(h.c.isPlaybackLockedByAnotherTab(), true);
    h.c.restorePlayerState();
    assert.equal(h.state.player.current, null);
    assert.equal(h.setters.length, 1, 'actual setter refused synchronously before any preparation checkpoint');
    assert.equal(h.setters[0].result, undefined);
    if (!paused) {
      assert.equal(h.platform.contexts.length, 0, 'foreign refusal cannot bypass pageshow');
      await deliverPageshow(h);
    } else {
      await h.flush();
      for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
      await h.flush();
    }
    const role = assertPausedPreparation(h);
    assert.equal(h.setters.length, 1, 'no completion-time retry of refused publication');
    assert.equal(h.setters[0].result, undefined);
    assert.equal(h.state.player.current, null);
    assert.deepEqual(h.providers, paused ? [] : [false]);
    assert.equal(h.paints(), paused ? 0 : 1, 'only actual provider mirrored repaint, no local preview/completion paint');
    assert.equal(h.c.localStorage.getItem(SAVED), h.original);
    assert.equal(h.state.player.lastPersistedSnapshot, h.cache);
    assert.deepEqual(h.writes(), []);
    assert.equal(h.c.localStorage.getItem(LEASE), lease);
    // Expiration changes the lock, not the denied operation's publication receipt.
    h.world.advance(15001);
    assert.equal(h.c.isPlaybackLockedByAnotherTab(), false);
    const paints = h.paints(), imageCount = h.platform.images.length;
    const elements = h.c.getPlayerElements();
    const shown = [elements.title.textContent, elements.time.textContent, elements.timeline.max,
      elements.timeline.value, h.c.compactPlayerElements().titleText.textContent];
    h.engine().socket.emit({type: 'metadata', generation: role.generation, streamId: role.streamId,
      role: role.role, sampleRate: 48000, channels: 2, requestedStartFrame: role.startFrame,
      timelineStartFrame: role.startFrame, provisionalTotalFrames: 200 * 48000});
    h.engine().socket.emit({type: 'eos', generation: role.generation, streamId: role.streamId,
      role: role.role, emittedFrames: 0, authoritativeTotalFrames: 205 * 48000});
    assert.equal(h.c.getPlayerPlaybackSnapshot().duration, 205, 'real wire metadata/EOS are accepted');
    assert.equal(h.state.player.current, null);
    assert.deepEqual([elements.title.textContent, elements.time.textContent, elements.timeline.max,
      elements.timeline.value, h.c.compactPlayerElements().titleText.textContent], shown);
    assert.equal(h.paints(), paints);
    assert.equal(h.platform.images.length, imageCount);
    assert.equal(h.listens(), 0);
    assert.equal(h.engine().node.sent.filter(row => row.type === 'eos').length, 1);
  });
}

test('denied435: positive arbitration after refused publication cannot admit a role without a receipt', async t => {
  const h = await deniedFixture(t); foreignLease(h);
  assert.equal(h.c.isPlaybackLockedByAnotherTab(), true);
  h.c.restorePlayerState();
  assert.equal(h.state.player.current, null);
  h.world.advance(15001);
  await deliverPageshow(h);
  assert.equal(h.providers.length, 1, 'real arbitration remains the saved-playing boundary');
  assert.ok(h.providers[0], 'the expired foreign lease allows a genuine positive handle');
  assert.equal(h.c.isPlaybackOwnershipHandleCurrent(h.providers[0]), false, 'only the acquired restore claim is retired');
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
  assert.equal(h.engine().roles.current, null);
  assert.equal(h.state.player.current, null);
  assert.equal(h.listens(), 0);
  assert.equal(displayMessages(h.world).length, 0);
});

for (const [label, value] of [['undefined', undefined], ['null', null], ['true', true], ['number', 1], ['string', 'false'], ['object', {}], ['throws', new Error('denied435 provider failure')]]) {
  test(`denied435: ${label} provider result is not exact-false preparation authority`, async t => {
    const h = await deniedFixture(t);
    h.c.canRestoreActivePlayback = () => { h.providers.push(value); if (label === 'throws') throw value; return value; };
    h.c.restorePlayerState(); await deliverPageshow(h);
    assert.equal(h.providers.length, 1, 'the actual pageshow provider seam must be exercised');
    assert.equal(h.starts.length, 0);
    assert.equal(h.engine().roles.current, null);
    assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
    assert.equal(h.bindings.length, 0);
    assert.equal(h.listens(), 0);
    assert.equal(displayMessages(h.world).length, 0);
  });
}

for (const change of ['scope', 'manual', 'explicit-queue']) {
  test(`denied435: exact-false provider reentry through ${change} cancels the old preparation`, async t => {
    const h = await deniedFixture(t);
    let queued, requestIndex, successor, queueSelectionAtProvider;
    if (change === 'explicit-queue') {
      const snapshot = await Q.admit(h, Q.ready({presentation: 'tracks'}));
      queued = await Q.enqueue(h, snapshot, {indices: [0], timing: 'end'});
    }
    h.c.canRestoreActivePlayback = () => {
      h.providers.push(false);
      if (change === 'scope') { h.change('actor', ''); h.c.capturePlaybackOwnershipScope(); }
      if (change === 'manual') successor = h.own(h.c.playTrackFromPayload({...h.data.track, title: 'Same-path manual successor'}, {autoplay: false}));
      if (change === 'explicit-queue') {
        requestIndex = h.requests.length;
        successor = h.own(h.queue.play(queued.ids[0]));
        queueSelectionAtProvider = h.owner('playerSelectionOwnership');
      }
      return false;
    };
    h.c.restorePlayerState(); await deliverPageshow(h);
    assert.equal(h.providers.length, 1);
    assert.equal(h.starts.filter(row => row.input.title === h.data.track.title).length, 0, 'old exact-false result cannot start behind the new intent');
    if (change === 'explicit-queue') {
      assert.equal(queueSelectionAtProvider, null, 'queue resolver was still before facade admission inside provider');
      assert.equal(Q.batchCommand(h, requestIndex).intent, 'play');
      h.reply(requestIndex, Q.batchReply(h, requestIndex));
      await h.flush();
      for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
    }
    if (successor) {
      assert.deepEqual(await successor, {value: true});
      assert.ok(h.engine().roles.current);
      assert.notEqual(h.state.player.current.title, h.data.track.title);
    } else assert.equal(h.engine().roles.current, null);
  });
}

for (const retirement of ['scope', 'unload', 'same-object-manual']) {
  test(`denied435: ${retirement} retires held false preparation without harming its successor`, async t => {
    const h = await deniedFixture(t); h.exactFalse(); h.platform.holds.module = true;
    h.c.restorePlayerState();
    h.c.dispatchEvent(new h.c.Event('pageshow')); await h.flush();
    assert.equal(h.starts.length, 1, 'test must own a genuine pending paused preparation');
    const oldAttempt = h.starts[0].attempt;
    assert.ok(oldAttempt);
    let successor;
    if (retirement === 'scope') { h.change('actor', ''); h.c.capturePlaybackOwnershipScope(); }
    if (retirement === 'unload') h.c.persistPlayerStateForUnload('pagehide');
    if (retirement === 'same-object-manual') {
      const sameObject = h.state.player.current;
      assert.ok(sameObject);
      successor = h.own(h.c.playTrackFromPayload(sameObject, {autoplay: false}));
    }
    h.platform.holds.module = false;
    for (const context of h.platform.contexts) context.module.resolve();
    await h.flush();
    for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
    await Promise.all(h.work); await h.flush();
    assert.equal(h.c.isStreamingPlaybackAttemptCurrent(oldAttempt), false);
    if (successor) {
      assert.deepEqual(await successor, {value: true});
      assert.ok(h.engine().roles.current);
      assert.equal(h.c.isStreamingPlaybackAttemptCurrent(h.starts.at(-1).attempt), true);
      assert.equal(h.state.player.current.path, h.data.track.path);
    } else assert.equal(h.engine().roles.current, null);
  });
}

for (const refusal of ['caller-guard-then-lock', 'lock-read-retires-scope']) {
  test(`denied435: ${refusal} cannot masquerade as an invocation-specific foreign refusal`, async t => {
    const h = await deniedFixture(t);
    const setter = h.c.setCurrentPlayerTrack, lock = h.c.isPlaybackLockedByAnotherTab;
    let entered = 0;
    const notReturned = Symbol('setter-did-not-return');
    let callerResult = notReturned, installedLease, observedLock;
    const scopeBeforeSetter = h.c.capturePlaybackOwnershipScope();
    if (refusal === 'caller-guard-then-lock') {
      h.c.setCurrentPlayerTrack = (input, options) => {
        entered++;
        // Negative caller input at the real setter, not a replacement setter result.
        const result = setter(input, {...options, isCurrent: () => false});
        callerResult = result;
        installedLease = foreignLease(h); // Later lock observation is not evidence of earlier refusal cause.
        return result;
      };
    } else {
      foreignLease(h);
      h.c.setCurrentPlayerTrack = (...args) => {
        const previous = h.c.isPlaybackLockedByAnotherTab;
        h.c.isPlaybackLockedByAnotherTab = () => {
          const result = lock();
          observedLock = result;
          if (!entered++) { h.change('actor', ''); h.c.capturePlaybackOwnershipScope(); }
          return result;
        };
        try { return setter(...args); } finally { h.c.isPlaybackLockedByAnotherTab = previous; }
      };
    }
    h.c.restorePlayerState();
    assert.ok(entered > 0, 'the actual setter refusal/reentrant lock seam was exercised');
    if (refusal === 'caller-guard-then-lock') {
      assert.notEqual(callerResult, notReturned, 'actual setter returned through the callback');
      assert.equal(callerResult, undefined, 'caller guard refusal produced no successful receipt');
      assert.equal(h.c.localStorage.getItem(LEASE), installedLease, 'exact later foreign lease was installed');
      assert.equal(h.c.isPlaybackLockedByAnotherTab(), true);
    } else {
      assert.equal(observedLock, true, 'actual foreign predicate was reached');
      assert.equal(h.c.isPlaybackOwnershipScopeCurrent(scopeBeforeSetter), false);
    }
    await deliverPageshow(h);
    assert.equal(h.state.player.current, null);
    assert.equal(h.starts.length, 0);
    assert.equal(h.providers.length, 0, 'cancelled publication cannot retain pageshow arbitration');
    assert.equal(h.owner('playerRestoreAttempt'), null);
    assert.equal(h.c.localStorage.getItem(SAVED), h.original);
    assert.equal(h.state.player.lastPersistedSnapshot, h.cache);
  });
}

for (const current of ['null', 'same-path', 'other-path']) {
  for (const entry of ['ordinary-ui', 'forced', 'unload']) {
    test(`denied435 writer: foreign lease fences ${entry} with ${current} current and retains confirmed cache`, async t => {
      const h = await deniedFixture(t);
      h.c.setCurrentPlayerTrack(h.data.track, {persist: false});
      assert.equal(h.c.persistPlayerState(true), true);
      const saved = h.c.localStorage.getItem(SAVED), cache = h.state.player.lastPersistedSnapshot;
      assert.equal(cache, saved, 'cache comes from an actual confirmed write');
      // Pure persisted-input shapes; no restore, lease, selection or safety owner is fabricated.
      if (current === 'null') h.state.player.current = null;
      if (current === 'other-path') h.c.setCurrentPlayerTrack(track('PriorOther'), {persist: false});
      const beforeLockSaved = h.c.localStorage.getItem(SAVED), beforeLockCache = h.state.player.lastPersistedSnapshot;
      const lease = foreignLease(h), writes = h.writes().length;
      assert.equal(h.c.isPlaybackLockedByAnotherTab(), true);
      if (h.state.player.current) h.state.player.current.title += ' unsaved metadata';
      if (entry === 'ordinary-ui') h.c.updatePlayerUi();
      if (entry === 'forced') assert.equal(h.c.persistPlayerState(true), false);
      if (entry === 'unload') assert.equal(h.c.persistPlayerStateForUnload('pagehide'), true);
      assert.equal(h.c.localStorage.getItem(SAVED), beforeLockSaved);
      assert.equal(h.state.player.lastPersistedSnapshot, beforeLockCache);
      assert.equal(h.writes().length, writes, 'all saved-key sets/removals are visible');
      assert.equal(h.c.localStorage.getItem(LEASE), lease);
      assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
    });
  }
}

for (const phase of ['payload-nonnull', 'payload-null-nonforced', 'payload-null-forced', 'serialization']) {
  test(`denied435 writer: foreign acquisition during ${phase} preserves storage and cache`, async t => {
    const h = await deniedFixture(t);
    h.c.setCurrentPlayerTrack(h.data.track, {persist: false});
    assert.equal(h.c.persistPlayerState(true), true);
    const stored = h.c.localStorage.getItem(SAVED), cache = h.state.player.lastPersistedSnapshot;
    assert.equal(cache, stored);
    if (phase.startsWith('payload-null')) h.state.player.current = null;
    let entries = 0, lease;
    const snapshot = h.c.getPlayerPlaybackSnapshot;
    if (phase === 'serialization') {
      h.state.player.playbackQueue = {tracks: [h.data.track], currentIndex: 0,
        albumSnapshot: {toJSON() { entries++; lease = foreignLease(h); return {key: 'serialized-album'}; }}};
    } else {
      h.c.getPlayerPlaybackSnapshot = (...args) => {
        const result = snapshot(...args);
        entries++; lease = foreignLease(h);
        return result;
      };
    }
    const writes = h.writes().length;
    try {
      assert.equal(h.c.persistPlayerState(phase !== 'payload-null-nonforced'), false);
      assert.equal(entries, 1, 'payload/serialization boundary must actually acquire the foreign lease');
      assert.equal(h.c.localStorage.getItem(SAVED), stored);
      assert.equal(h.state.player.lastPersistedSnapshot, cache, 'including nonforced null-payload cache clearing');
      assert.equal(h.writes().length, writes);
      assert.equal(h.c.localStorage.getItem(LEASE), lease);
      assert.equal(h.c.isPlaybackLockedByAnotherTab(), true, 'actual predicate observes callback-acquired lease');
    } finally { h.c.getPlayerPlaybackSnapshot = snapshot; }
  });
}

test('denied435 writer: unlocked null payload retains ordinary cache clearing and forced removal', async t => {
  const h = await deniedFixture(t);
  h.c.setCurrentPlayerTrack(h.data.track, {persist: false});
  assert.equal(h.c.persistPlayerState(true), true);
  const saved = h.c.localStorage.getItem(SAVED);
  h.state.player.current = null;
  assert.equal(h.c.persistPlayerState(false), false);
  assert.equal(h.state.player.lastPersistedSnapshot, '');
  assert.equal(h.c.localStorage.getItem(SAVED), saved);
  assert.equal(h.c.persistPlayerState(true), false);
  assert.equal(h.c.localStorage.getItem(SAVED), null);
});

test('denied435: actual local reservation write failure remains an exact-false paused preparation', async t => {
  const h = await deniedFixture(t);
  let refusedWrites = 0;
  h.platform.beforeStorageWrite = ({kind, key}) => {
    if (kind === 'local' && key === LEASE) { refusedWrites++; throw new Error('finite localStorage lease reservation failure'); }
  };
  h.c.restorePlayerState(); await deliverPageshow(h);
  assert.ok(refusedWrites > 0, 'real provider must attempt and fail the browser storage write');
  assert.deepEqual(h.providers, [false]);
  assertPausedPreparation(h);
  assert.equal(h.c.localStorage.getItem(LEASE), null);
  assert.equal(h.paints(), 2, 'preview plus actual failed-reservation release repaint are both observed');
  h.platform.beforeStorageWrite = null;
});
