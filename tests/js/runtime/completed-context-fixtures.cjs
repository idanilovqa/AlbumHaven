'use strict';
const assert = require('node:assert/strict');
const {fixture, track, deferred, frame} = require('./search-native-fixtures/ownership-platform.cjs');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
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
  const play = h.c.playTrackFromPayload;
  h.starts = [];
  // Transparent call-through observation: no owner, claim, result or guard is substituted.
  h.c.playTrackFromPayload = function (...args) {
    const promise = play.apply(this, args);
    h.starts.push({args, work: h.own(promise)});
    return promise;
  };
  h.select = value => h.own(h.c.playTrackFromPayload(value));
  h.replay = async () => {
    const before = h.starts.length;
    const accepted = h.c.togglePlayerPlayback();
    await h.flush();
    return {accepted, before, starts: () => h.starts.slice(before)};
  };
  h.finish = async ({expectEnded = true} = {}) => {
    const role = h.engine().roles.current;
    assert.ok(role);
    const node = h.engine().node;
    const play = node.sent.filter(message => message.type === 'play').at(-1);
    assert.ok(play && Number.isSafeInteger(play.playbackIntentId) && play.playbackIntentId > 0,
      'EOF is derived from a genuine configured owner PLAY intent');
    node.emit({type: 'ended', generation: role.generation,
      streamId: role.streamId, timelineFrame: 90 * 48000,
      playbackIntentId: play.playbackIntentId});
    await h.flush();
    if (expectEnded) assert.equal(h.c.getPlayerPlaybackSnapshot().ended, true);
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
  attempt(() => h.c.retirePlayerSelectionOwnership('completed-context-test-teardown'));
  const stopped = attempt(() => outcome(h.c.stopStreamingPlayback('completed-context-test-teardown')));
  // The synthetic fetch fixture does not itself honor AbortSignal. Reject its
  // held responses here, rather than waiting for a later fixture after-hook.
  // Late cleanup-only requests receive the same rejection; action requests
  // never receive automatic replies or errors.
  const fetch = h.c.fetch;
  const rejectPendingRequests = () => {
    for (const request of h.requests) if (!request.settled) attempt(() => request.reject(
      Object.assign(new Error('Completed context retired fixture request'), {name: 'AbortError'})));
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
  if (failures.length) throw new AggregateError([...new Set(failures)], 'Completed context action/cleanup failed');
}


module.exports = {scenario, track, plain, frame, F};
