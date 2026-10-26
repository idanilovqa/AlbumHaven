'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const P = require('./foobar-account-history-play-fixture.cjs');

test('HC01 genuine shared dispatcher never borrows an unrelated visible Album modal for native Play', async t => {
  const f = await P.platform(t); await f.choose(); const {starts, modal} = P.genuineDispatcher(f);
  assert.equal(modal.hidden, false); await f.check(); await f.play();
  assert.equal(starts.length, 1); assert.equal(starts[0].path, P.target().path); assert.equal(starts[0].inventory_track_ref, 'inventory-track:1:9');
  assert.equal(Object.hasOwn(starts[0], 'albumListeningIntent'), false); assert.equal(f.c.state.player.playbackQueue, null);
  assert.equal(f.nativeCalls().length, 2); assert.ok(f.wire.calls.every(call => !call.url.includes('/playback/capture/album-selection')));
  assert.doesNotMatch(JSON.stringify(f.owner.controller.getSnapshot()), /albumListeningIntent|inventory-track|synthetic\/library-one/);
});
test('HC02 genuine shared dispatcher keeps detached native Play unscoped with hidden or absent modal', async t => {
  for (const state of ['hidden', 'absent']) {
    const f = await P.platform(t); await f.choose(); const {starts, modal} = P.genuineDispatcher(f);
    if (state === 'hidden') modal.hidden = true; else modal.remove();
    await f.check(); await f.play(P.target({title: null, artist: null, album_title: null, duration_seconds: null}));
    assert.equal(starts.length, 1); assert.equal(starts[0].title, 'Track'); assert.equal(starts[0].artist, ''); assert.equal(starts[0].album, ''); assert.equal(starts[0].durationSeconds, 0);
    assert.equal(Object.hasOwn(starts[0], 'albumListeningIntent'), false); assert.equal(f.c.state.player.playbackQueue, null);
  }
});
test('HC03 genuine modal-contained ordinary control preserves its actual Album intent and queue', async t => {
  const f = await P.platform(t), {starts, modal, album} = P.genuineDispatcher(f);
  const button = f.document.createElement('button'); modal.append(button);
  button.setAttribute('data-src', '/track?path=' + encodeURIComponent(album.tracks[0].path)); button.setAttribute('data-track-path', album.tracks[0].path);
  button.setAttribute('data-track-title', 'Owned modal track');
  f.c.activateSharedTrackButton(button);
  assert.equal(starts.length, 1); assert.equal(starts[0].path, album.tracks[0].path); assert.equal(starts[0].albumListeningIntent.albumKey, album.key);
  const queue = f.c.state.player.playbackQueue; assert.equal(queue.albumRef, album.key); assert.equal(queue.tracks.length, 1);
  assert.equal(queue.tracks[0].albumListeningIntent, starts[0].albumListeningIntent); assert.equal(queue.tracks[0].path, album.tracks[0].path);
  assert.equal(JSON.stringify(queue).includes('albumListeningIntent'), false); assert.equal(f.nativeCalls().length, 0);
});
