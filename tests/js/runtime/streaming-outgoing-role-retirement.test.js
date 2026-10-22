'use strict';
// Source-only proposal. Place beside the existing native runtime tests when the
// candidate is assembled. The fixture loads complete candidate owners; only
// browser audio/socket primitives and their external events are controlled.
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, track, start, frame} = require('./search-native-fixtures/ownership-platform.cjs');
const outcome = promise => Promise.resolve(promise).then(value => ({value}), error => ({error}));
const count = (source, type, role = null) => source.sent.filter(message => message.type === type
  && (!role || message.generation === role.generation && message.streamId === role.streamId)).length;

function metadata(h, role) {
  h.engine().socket.emit({type: 'metadata', generation: role.generation, streamId: role.streamId,
    role: role.role, sampleRate: 48000, channels: 2, requestedStartFrame: role.startFrame,
    timelineStartFrame: role.startFrame, provisionalTotalFrames: 90 * 48000});
}
function pcm(h, role, frames = 48000) {
  // A real AHPC frame crosses the installed socket callback. Use the fixture
  // realm's ArrayBuffer because the production protocol checks its realm.
  const Buffer = h.owner('ArrayBuffer'), buffer = new Buffer(24 + frames * 8), view = new DataView(buffer);
  for (const [index, byte] of [65, 72, 80, 67].entries()) view.setUint8(index, byte);
  view.setUint8(4, 1); view.setUint8(5, role.role === 'current' ? 0 : 1);
  view.setUint32(8, role.generation, false); view.setUint32(12, role.streamId, false);
  view.setUint32(16, role.nextSequence, false); view.setUint32(20, frames, false);
  for (let index = 0; index < frames * 2; index++) view.setFloat32(24 + index * 4, 0.125, true);
  h.engine().socket.onmessage({data: buffer});
}
function consumed(h, role, frames, bufferedFrames) {
  h.engine().node.emit({type: 'consumed', generation: role.generation, streamId: role.streamId,
    role: role.role, frames, bufferedFrames});
}
async function rendered(t, {cushion = false} = {}) {
  const h = await fixture(t), current = await start(h, track('RetiredOutgoing'));
  assert.equal(await current.work, true);
  metadata(h, current.role); pcm(h, current.role); frame(h, current.role); await h.flush();
  if (!cushion) consumed(h, current.role, 48000, 0);
  assert.equal(h.engine().snapshot.paused, false);
  assert.equal(h.engine().diagnostics.bufferedFrames.current, cushion ? 48000 : 0);
  assert.equal(h.engine().context.state, 'running');
  return Object.assign(h, {outgoing: current.role, outgoingPayload: current.payload,
    original: {context: h.engine().context, node: h.engine().node, socket: h.engine().socket}});
}
async function incoming(h, {replacement = false, payload = track('IncomingOrdinary')} = {}) {
  const work = outcome(h.c.playTrackFromPayload(payload)); await h.flush();
  const attempt = h.engine().playbackAttempt;
  assert.equal(h.c.isStreamingPlaybackAttemptCurrent(attempt), true);
  assert.equal(h.engine().roles.current, h.outgoing);
  if (replacement) {
    assert.equal(h.engine().pendingSeek?.kind, 'replacement');
    assert.equal(h.engine().roles.continuity?.track, payload);
  } else {
    assert.ok(h.engine().replacementCushionWaiter, 'ordinary start reached the existing cushion waiter');
    assert.equal(h.engine().roles.continuity, null);
  }
  return {work, attempt, payload, role: h.engine().roles.continuity};
}
function retainPhysicalOwner(h) {
  assert.equal(h.engine().context, h.original.context); assert.equal(h.engine().node, h.original.node);
  assert.equal(h.engine().socket, h.original.socket); assert.equal(h.original.context.closeCount, 0);
  assert.equal(h.original.node.disconnectCount, 0); assert.equal(h.original.socket.closeCount, 0);
  assert.equal(h.platform.contexts.length, 1); assert.equal(h.platform.nodes.length, 1);
  assert.equal(h.platform.sockets.length, 1);
}
function prepareIncoming(h, next) {
  if (!next.role.metadataAccepted) metadata(h, next.role);
  assert.ok(h.engine().diagnostics.inFlightFrames.continuity > 0,
    'retired outgoing cushion cannot block credit for its exact admitted incoming role');
  pcm(h, next.role); pcm(h, next.role);
  assert.equal(h.engine().pendingSeek.prepareSent, true);
  assert.equal(count(h.original.node, 'prepare-seek', next.role), 1);
}
function boundary(h, next) {
  assert.equal(h.engine().pendingSeek?.prepareSent, true, 'real PCM prepared the replacement first');
  h.original.node.emit({type: 'seek-boundary', generation: next.role.generation,
    outgoingStreamId: h.outgoing.streamId, incomingStreamId: next.role.streamId,
    timelineFrame: 0, renderedFrame: 48000, silentFrames: 0});
}
function assertRetiredResources(h) {
  assert.equal(h.engine().roles.current, null); assert.equal(h.engine().roles.continuity, null);
  assert.equal(h.engine().pendingSeek, null); assert.equal(h.engine().replacementCushionWaiter, null);
  assert.equal(h.engine().context, null); assert.equal(h.engine().node, null); assert.equal(h.engine().socket, null);
  assert.equal(h.original.context.closeCount, 1); assert.equal(h.original.node.disconnectCount, 1);
  assert.equal(h.original.socket.closeCount, 1); assert.equal(h.engine().snapshot.paused, true);
}

test('outgoing retirement requires the exact pending incoming capability and exact current role', async t => {
  const h = await rendered(t), oldAttempt = h.c.captureStreamingPlaybackAttempt();
  const before = [h.original.node.sent.length, h.original.socket.sent.length, h.original.context.resumeCount];
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, oldAttempt), false, 'a current-only attempt has no successor');
  assert.deepEqual([h.original.node.sent.length, h.original.socket.sent.length, h.original.context.resumeCount], before);
  const next = await incoming(h);
  const pendingEffects = [h.original.node.sent.length, h.original.socket.sent.length, h.original.context.resumeCount];
  assert.equal(h.c.retireStreamingOutgoingRole({...h.outgoing}, next.attempt), false);
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, Object.freeze({})), false);
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, oldAttempt), false);
  assert.equal(h.c.retireStreamingOutgoingRole(null, next.attempt), false);
  assert.deepEqual([h.original.node.sent.length, h.original.socket.sent.length, h.original.context.resumeCount], pendingEffects);
  assert.equal(h.engine().snapshot.paused, false); assert.equal(h.c.isStreamingPlaybackAttemptCurrent(next.attempt), true);
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), true);
  assert.equal((await next.work).value, true);
});

test('the same track object does not qualify as a different outgoing-source handoff', async t => {
  const h = await rendered(t), next = await incoming(h, {payload: h.outgoingPayload});
  const pauses = count(h.original.node, 'pause');
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), false);
  assert.equal(count(h.original.node, 'pause'), pauses); assert.equal(h.engine().snapshot.paused, false);
  assert.equal(h.c.isStreamingPlaybackAttemptCurrent(next.attempt), true);
  await h.c.stopStreamingPlayback('same-target-test-complete', {expectedAttempt: next.attempt});
  assert.notEqual((await next.work).value, true);
});

test('pending outgoing retirement settles the cushion wait into the existing ordinary cold start', async t => {
  const h = await rendered(t), next = await incoming(h), previousGeneration = h.engine().generation;
  const pauses = count(h.original.node, 'pause'), plays = count(h.original.node, 'play');
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), true);
  assert.equal(h.engine().roles.current, h.outgoing, 'logical role remains until the admitted start replaces it');
  assert.equal(h.c.captureStreamingRetiredOutgoingAttempt(), next.attempt);
  assert.equal(h.engine().snapshot.paused, true); assert.equal(h.original.context.state, 'running');
  assert.equal(h.engine().replacementCushionWaiter, null); assert.equal(h.engine().playbackAttempt, next.attempt);
  assert.equal(count(h.original.node, 'pause'), pauses + 1); assert.equal(count(h.original.node, 'play'), plays);
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), true, 'duplicate retirement is idempotent');
  assert.equal(count(h.original.node, 'pause'), pauses + 1);
  assert.equal((await next.work).value, true); await h.flush();
  assert.equal(h.engine().roles.current.track, next.payload); assert.equal(h.state.player.current.path, next.payload.path);
  assert.equal(h.engine().generation, previousGeneration + 1); assert.equal(h.engine().playbackAttempt, next.attempt);
  assert.equal(h.c.captureStreamingPlaybackAttempt(), next.attempt);
  assert.equal(count(h.original.socket, 'close', h.outgoing), 1); assert.equal(count(h.original.node, 'reserve-seek'), 0);
  assert.equal(count(h.original.node, 'play'), plays + 1); retainPhysicalOwner(h);
  assert.equal(h.c.captureStreamingRetiredOutgoingAttempt(), null, 'completed automatic start no longer exposes cancellation intent');
  const completed = h.engine().roles.current;
  h.original.node.emit({type: 'ended', generation: completed.generation, streamId: completed.streamId, timelineFrame: 90 * 48000});
  await h.flush();
  assert.equal(h.engine().snapshot.paused, true);
  assert.equal(h.c.captureStreamingRetiredOutgoingAttempt(), null, 'natural end cannot revive a settled automatic-resume intent');
});

test('accepted replacement bypasses retired outgoing cushion and resumes only after real prepared promotion', async t => {
  const h = await rendered(t, {cushion: true}), next = await incoming(h, {replacement: true});
  consumed(h, h.outgoing, 48000, 0); metadata(h, next.role);
  assert.equal(next.role.initialCreditDeferred, true); assert.equal(count(h.original.socket, 'credit', next.role), 0);
  const plays = count(h.original.node, 'play'), outgoingCredit = count(h.original.socket, 'credit', h.outgoing);
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), true);
  assert.equal(h.engine().snapshot.paused, true); assert.equal(h.original.context.state, 'running');
  assert.equal(h.engine().roles.current, h.outgoing); assert.equal(h.engine().roles.continuity, next.role);
  assert.equal(h.engine().playbackAttempt, next.attempt); assert.equal(count(h.original.node, 'play'), plays);
  consumed(h, h.outgoing, 1, 0);
  h.original.node.emit({type: 'ended', generation: h.outgoing.generation, streamId: h.outgoing.streamId, timelineFrame: 90000});
  assert.equal(count(h.original.socket, 'credit', h.outgoing), outgoingCredit);
  assert.equal(count(h.original.node, 'play'), plays); assert.equal(h.engine().pendingSeek?.kind, 'replacement');
  prepareIncoming(h, next); assert.equal(count(h.original.node, 'play'), plays);
  boundary(h, next); assert.equal((await next.work).value, true); await h.flush();
  assert.equal(h.engine().roles.current, next.role); assert.equal(h.engine().roles.continuity, null);
  assert.equal(h.engine().pendingSeek, null); assert.equal(h.engine().snapshot.paused, false);
  assert.equal(h.engine().playbackAttempt, next.attempt); assert.equal(h.c.captureStreamingPlaybackAttempt(), next.attempt);
  assert.equal(h.state.player.current.path, next.payload.path); assert.equal(count(h.original.node, 'play'), plays + 1);
  assert.equal(count(h.original.socket, 'promote', next.role), 1); retainPhysicalOwner(h);
  h.original.node.emit({type: 'ended', generation: next.role.generation, streamId: next.role.streamId, timelineFrame: 90 * 48000});
  await h.flush();
  assert.equal(h.engine().snapshot.paused, true);
  assert.equal(h.c.captureStreamingRetiredOutgoingAttempt(), null, 'ended promoted role cannot revive completed automatic resume');
});

test('pending retirement ignores outgoing ended callbacks before its admitted cold start continues', async t => {
  const h = await rendered(t), next = await incoming(h), plays = count(h.original.node, 'play');
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), true);
  const time = h.engine().snapshot.currentTime;
  h.original.node.emit({type: 'ended', generation: h.outgoing.generation, streamId: h.outgoing.streamId, timelineFrame: 90000});
  h.original.node.emit({type: 'position', generation: h.outgoing.generation, streamId: h.outgoing.streamId, timelineFrame: 91000});
  assert.notEqual(h.outgoing.endedNotified, true); assert.equal(h.engine().snapshot.currentTime, time);
  assert.equal(h.c.isStreamingPlaybackAttemptCurrent(next.attempt), true); assert.equal(count(h.original.node, 'play'), plays);
  assert.equal((await next.work).value, true); await h.flush();
  assert.equal(h.engine().roles.current.track, next.payload); assert.equal(h.state.player.current.path, next.payload.path);
  retainPhysicalOwner(h);
});

for (const replacement of [false, true]) test(`explicit shared pause cancels ${replacement ? 'replacement' : 'pending cold-start'} automatic resume`, async t => {
  const h = await rendered(t, {cushion: replacement}), next = await incoming(h, {replacement});
  const plays = count(h.original.node, 'play');
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), true);
  // Exercise the shared pause owner. The native handoff facade's paused-state
  // early return is a separate dependent integration change, not mocked here.
  const pause = h.c.pauseStreamingPlayback();
  if (replacement) {
    assert.equal(h.original.context.state, 'running', 'paused worklet must still commit its prepared seek');
    prepareIncoming(h, next); boundary(h, next);
  }
  await pause; assert.equal((await next.work).value, true); await h.flush();
  assert.equal(h.engine().roles.current.track, next.payload); assert.equal(h.state.player.current.path, next.payload.path);
  assert.equal(h.engine().snapshot.paused, true); assert.equal(count(h.original.node, 'play'), plays);
  assert.equal(h.c.captureStreamingPlaybackAttempt(), next.attempt); retainPhysicalOwner(h);
  assert.equal(h.c.togglePlayerPlayback(), true, 'normal native Play resumes the admitted incoming role');
  await h.flush(); assert.equal(h.engine().snapshot.paused, false);
  assert.equal(h.engine().roles.current.track, next.payload); assert.equal(count(h.original.node, 'play'), plays + 1);
});

for (const replacement of [false, true]) test(`explicit pause also fences an already awaited ${replacement ? 'replacement' : 'cold-start'} automatic resume`, async t => {
  const h = await rendered(t, {cushion: replacement}), next = await incoming(h, {replacement});
  const plays = count(h.original.node, 'play'), previousResume = h.original.context.resumeGate;
  h.platform.holds.resume = true;
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), true);
  if (replacement) { prepareIncoming(h, next); boundary(h, next); }
  await h.flush();
  const pendingResume = h.original.context.resumeGate;
  assert.notEqual(pendingResume, previousResume, 'the incoming native resume is genuinely awaiting its platform result');
  assert.equal(h.engine().roles.current.track, next.payload);
  assert.equal(h.c.captureStreamingRetiredOutgoingAttempt(), next.attempt,
    'native facade can still capture the exact incoming automatic resume after role promotion');
  await h.c.pauseStreamingPlayback(); pendingResume.resolve(); await h.flush();
  assert.equal((await next.work).value, true); assert.equal(h.engine().snapshot.paused, true);
  assert.equal(count(h.original.node, 'play'), plays); assert.equal(h.engine().playbackAttempt, next.attempt);
  assert.equal(h.state.player.current.path, next.payload.path); retainPhysicalOwner(h);
  assert.equal(h.c.captureStreamingRetiredOutgoingAttempt(), null, 'explicit pause consumes the automatic resume intent');
});

test('retirement pause callback cannot overwrite a synchronously registered newer ordinary selection', async t => {
  const h = await rendered(t), next = await incoming(h), successor = track('CallbackSuccessor');
  let successorWork, successorAttempt;
  h.platform.onPortPost = (_node, message) => {
    if (message.type !== 'pause') return;
    h.platform.onPortPost = null;
    successorWork = outcome(h.c.playTrackFromPayload(successor)); successorAttempt = h.engine().playbackAttempt;
  };
  t.after(() => {h.platform.onPortPost = null;});
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), true);
  assert.ok(successorWork); assert.notEqual(successorAttempt, next.attempt);
  await h.flush(); assert.equal((await successorWork).value, true); assert.equal((await next.work).value, false);
  const before = [h.original.node.sent.length, h.original.socket.sent.length, h.original.context.resumeCount];
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), false);
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, successorAttempt), false);
  assert.deepEqual([h.original.node.sent.length, h.original.socket.sent.length, h.original.context.resumeCount], before);
  assert.equal(h.engine().roles.current.track, successor); assert.equal(h.engine().playbackAttempt, successorAttempt);
  assert.equal(h.state.player.current.path, successor.path); retainPhysicalOwner(h);
});

test('late automatic-resume settlement and old callbacks cannot play or retire a newer successor', async t => {
  const h = await rendered(t, {cushion: true}), next = await incoming(h, {replacement: true});
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), true); prepareIncoming(h, next);
  h.platform.holds.resume = true; boundary(h, next);
  const retiredResume = h.original.context.resumeGate;
  await h.flush(); assert.equal((await next.work).value, true);
  h.platform.holds.resume = false;
  const successor = await start(h, track('ResumeSuccessor')); assert.equal(await successor.work, true);
  const current = h.engine().roles.current, attempt = h.engine().playbackAttempt;
  const before = [count(h.original.node, 'play'), h.original.socket.sent.length, h.original.context.closeCount];
  retiredResume.resolve();
  h.original.node.emit({type: 'seek-boundary', generation: next.role.generation,
    outgoingStreamId: h.outgoing.streamId, incomingStreamId: next.role.streamId, timelineFrame: 0, renderedFrame: 48000});
  h.original.socket.emit({type: 'error', generation: next.role.generation, streamId: next.role.streamId, message: 'late retired error'});
  await h.flush();
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), false);
  assert.deepEqual([count(h.original.node, 'play'), h.original.socket.sent.length, h.original.context.closeCount], before);
  assert.equal(h.engine().roles.current, current); assert.equal(h.engine().playbackAttempt, attempt);
  assert.equal(h.engine().snapshot.paused, false); assert.equal(h.state.player.current.path, successor.payload.path);
  retainPhysicalOwner(h);
});

for (const replacement of [false, true]) test(`${replacement ? 'Incoming replacement' : 'Pending transport'} failure leaves retired outgoing silent and releases physical resources`, async t => {
  const h = await rendered(t, {cushion: replacement}), next = await incoming(h, {replacement});
  const oldWorklet = h.original.node.port.onmessage, oldSocketError = h.original.socket.onerror;
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), true);
  const plays = count(h.original.node, 'play');
  const failedRole = next.role || h.outgoing;
  h.original.socket.emit({type: 'error', generation: failedRole.generation, streamId: failedRole.streamId,
    message: 'bounded incoming preparation failure'});
  assert.notEqual((await next.work).value, true); await h.flush();
  assertRetiredResources(h); assert.equal(count(h.original.node, 'play'), plays);
  assert.equal(h.c.isStreamingPlaybackAttemptCurrent(next.attempt), false);
  oldWorklet({data: {type: 'ended', generation: h.outgoing.generation, streamId: h.outgoing.streamId, timelineFrame: 90000}});
  oldSocketError({message: 'late detached socket error'}); await h.flush();
  assertRetiredResources(h); assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), false);
});

test('automatic resume rejection after incoming promotion releases the exact retired handoff resources', async t => {
  const h = await rendered(t, {cushion: true}), next = await incoming(h, {replacement: true});
  const plays = count(h.original.node, 'play');
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), true); prepareIncoming(h, next);
  h.platform.holds.resume = true; boundary(h, next);
  const resume = h.original.context.resumeGate;
  assert.equal((await next.work).value, true);
  resume.reject(new Error('bounded incoming context resume failure')); await h.flush();
  assertRetiredResources(h); assert.equal(count(h.original.node, 'play'), plays);
  assert.equal(h.c.isStreamingPlaybackAttemptCurrent(next.attempt), false);
});

test('a throwing native pause primitive fails the owned handoff without retaining outgoing audio', async t => {
  const h = await rendered(t), next = await incoming(h);
  h.platform.onPortPost = (_node, message) => {
    if (message.type !== 'pause') return;
    h.platform.onPortPost = null; throw new Error('bounded native pause failure');
  };
  t.after(() => {h.platform.onPortPost = null;});
  assert.equal(h.c.retireStreamingOutgoingRole(h.outgoing, next.attempt), true);
  assert.notEqual((await next.work).value, true); await h.flush();
  assertRetiredResources(h); assert.equal(h.c.isStreamingPlaybackAttemptCurrent(next.attempt), false);
});
