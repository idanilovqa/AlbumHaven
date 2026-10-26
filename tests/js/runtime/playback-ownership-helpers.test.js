'use strict';
const nodeTest = require('node:test');
const test = (name, run) => nodeTest(name, {timeout: 5000}, run);
const assert = require('node:assert/strict');
const {world, fixture, track, start, frame, displayMessages} = require('./search-native-fixtures/ownership-platform.cjs');
const KEY = 'albumhaven.playbackOwnership.v1';
const plain = value => JSON.parse(JSON.stringify(value));
const foreign = w => ({tab_id: 'foreign-tab', status: 'playing', reason: 'manual_start', claim_revision: 9,
  updated_at_ms: w.now(), expires_at_ms: w.now() + 15000});
function deliverLease(h, record) {
  h.world.local.set(KEY, JSON.stringify(record));
  h.c.dispatchEvent(Object.assign(new h.c.Event('storage'), {key: KEY, newValue: JSON.stringify(record)}));
}
async function rendered(h, value = track('Local')) {
  const result = await start(h, value); assert.equal(await result.work, true);
  frame(h, result.role); await h.flush(); h.world.flush(); return result;
}

// The Oct19 scoped-claim owner supersedes the old raw track mirroring contract.
// A global lease is identity-only. It may stop only its captured local attempt.
test('foreign lease without a local claim gives a generic lock, no mirrored media and no stop', async t => {
  const h = await fixture(t), calls = [], stop = h.c.stopStreamingPlayback;
  h.c.stopStreamingPlayback = (...args) => {calls.push(args); return stop(...args);};
  const record = {...foreign(h.world), track: track('Remote')};
  deliverLease(h, record); await h.flush();
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
  assert.equal(h.state.player.ownership.lockStatus, 'locked');
  assert.equal(h.state.player.ownership.blockedReason, 'playing_in_another_tab');
  assert.equal(h.c.getMirroredPlaybackTrack(), null);
  assert.equal(h.state.player.current, null); assert.equal(h.platform.contexts.length, 0);
  assert.equal(calls.length, 0, 'a foreign record cannot stop an unrelated or absent local attempt');
  assert.equal(h.c.getPlayerElements().title.textContent, 'Playing in another tab');
  assert.equal(h.c.compactPlayerElements().titleText.textContent, 'Playing in another tab');
  const stored = JSON.parse(h.world.local.get(KEY));
  assert.deepEqual(Object.keys(stored).sort(), ['claim_revision', 'expires_at_ms', 'reason', 'status', 'tab_id', 'updated_at_ms']);
  assert.doesNotMatch(JSON.stringify(stored), /private-|\/track|coverPath|Title |Artist |Album /);
});

test('foreign lease retires the genuine captured local attempt and both streaming roles', async t => {
  const h = await fixture(t), first = await rendered(h), attempt = h.c.captureStreamingPlaybackAttempt();
  h.platform.nodes.at(-1).emit({type: 'consumed', generation: first.role.generation, streamId: first.role.streamId,
    role: 'current', frames: 0, bufferedFrames: 48000});
  await h.c.scheduleStreamingContinuity(track('Next'));
  assert.ok(h.engine().roles.continuity, 'the real engine owns an actual prepared role');
  const old = {context: h.engine().context, node: h.engine().node, socket: h.engine().socket};
  deliverLease(h, foreign(h.world)); await h.flush();
  assert.equal(h.c.isStreamingPlaybackAttemptCurrent(attempt), false);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), null);
  assert.equal(h.engine().roles.current, null); assert.equal(h.engine().roles.continuity, null);
  assert.equal(old.context.closeCount, 1); assert.equal(old.node.disconnectCount, 1); assert.equal(old.socket.closeCount, 1);
  assert.equal(h.c.isPlaybackLockedByAnotherTab(), true); assert.equal(h.c.getMirroredPlaybackTrack(), null);
});

test('captured old-claim retirement preserves a genuine successor reserved during storage reentry', async t => {
  const h = await fixture(t); await rendered(h);
  const oldAttempt = h.c.captureStreamingPlaybackAttempt(), oldRole = h.engine().roles.current;
  let successor, handle, entered = false;
  h.platform.storageHook = ({op, key, map}) => {
    if (op !== 'get' || key !== KEY || h.c.getActivePlaybackOwnershipHandle() !== null) return;
    h.platform.storageHook = null; entered = true;
    // The foreign lease disappears at the platform read boundary. A newer
    // deliberate start now claims the actual owner before old cancellation resumes.
    map.delete(KEY); successor = start(h, track('Successor')); handle = h.c.getActivePlaybackOwnershipHandle();
  };
  deliverLease(h, foreign(h.world)); await h.flush();
  assert.equal(entered, true); assert.ok(handle);
  const next = await successor; h.world.advance(1000); await h.flush();
  for (const socket of h.platform.sockets) if (socket.readyState === 0) socket.open();
  await h.flush(); assert.equal(await next.work, true);
  assert.equal(h.c.getActivePlaybackOwnershipHandle(), handle);
  assert.equal(h.c.isStreamingPlaybackAttemptCurrent(oldAttempt), false);
  const role = h.engine().roles.current; assert.notEqual(role, oldRole);
  assert.equal(role.track.path, track('Successor').path); assert.equal(h.engine().context.closeCount, 0);
  frame(h, role); await h.flush();
  assert.equal(displayMessages(h.world).at(-1).data.display.title, track('Successor').title);
});

test('only a current private-scope display packet may mirror title, artist and album', async t => {
  const w = world(), sender = await fixture(t, w), receiver = await fixture(t, w), otherScope = await fixture(t, w);
  otherScope.shell.dataset.privateUiContext = 'b'.repeat(64);
  otherScope.c.AlbumHavenPrivateUITransport.generation(); otherScope.c.capturePlaybackOwnershipScope();
  await rendered(sender, track('Remote')); w.flush();
  assert.equal(receiver.c.isPlaybackLockedByAnotherTab(), true);
  assert.equal(otherScope.c.isPlaybackLockedByAnotherTab(), true);
  assert.equal(otherScope.c.getMirroredPlaybackTrack(), null, 'global lock cannot disclose labels into another private scope');
  assert.deepEqual(plain(receiver.c.getMirroredPlaybackTrack()), {title: 'Title Remote', artist: 'Artist Remote', album: 'Album Remote'});
  assert.equal(receiver.state.player.current, null); assert.equal(receiver.platform.contexts.length, 0);
  assert.equal(receiver.c.getPlayerElements().title.textContent, 'Artist Remote - Title Remote /');
  assert.equal(receiver.c.compactPlayerElements().titleText.textContent, 'Title Remote');
  const packet = displayMessages(w).at(-1).data;
  assert.deepEqual(Object.keys(packet.display).sort(), ['album', 'artist', 'title']);
  assert.doesNotMatch(JSON.stringify(packet), /private-|coverPath|\/track|inventory-track:/);
});

for (const key of ['path', 'src', 'coverPath']) {
  test(`scoped display rejects raw ${key} even with matching live claim and newer sequence`, async t => {
    const w = world(), sender = await fixture(t, w), receiver = await fixture(t, w);
    await rendered(sender); w.flush();
    const packet = plain(displayMessages(w).at(-1).data), before = plain(receiver.c.getMirroredPlaybackTrack());
    const channel = w.channels.find(value => value.tab === receiver.platform && !value.closed && value.name.includes('playbackDisplay'));
    channel.listeners[0]({data: {...packet, sequence: packet.sequence + 1, display: {...packet.display, [key]: track('Secret')[key]}}});
    assert.deepEqual(plain(receiver.c.getMirroredPlaybackTrack()), before);
    assert.equal(receiver.state.player.current, null); assert.equal(receiver.platform.contexts.length, 0);
  });
}
