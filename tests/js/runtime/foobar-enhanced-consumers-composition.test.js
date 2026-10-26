'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('./foobar-enhanced-consumers-fixture.cjs'), {P} = M;

test('ENC01 genuine Enhanced entry Play never borrows unrelated visible Album modal intent or queue', async t => {
  const f = await P.platform(t); await M.selected(f); const {starts, modal} = P.genuineDispatcher(f);
  assert.equal(modal.hidden, false); await f.check(); await f.play();
  assert.equal(starts.length, 1); assert.equal(starts[0].path, P.target().path); assert.equal(starts[0].inventory_track_ref, 'inventory-track:1:9');
  assert.equal(Object.hasOwn(starts[0], 'albumListeningIntent'), false); assert.equal(f.c.state.player.playbackQueue, null);
  assert.ok(f.wire.calls.every(call => !call.url.includes('/playback/capture/album-selection'))); M.noPublicTarget(f);
});
test('ENC02 genuine Enhanced grouped nullable Play remains detached with hidden or absent Album modal', async t => {
  for (const mode of ['hidden', 'absent']) {
    const f = await P.platform(t); await M.selected(f, 'grouped'); const {starts, modal} = P.genuineDispatcher(f);
    if (mode === 'hidden') modal.hidden = true; else modal.remove();
    await f.check(); await f.play(P.target({title: null, artist: null, album_title: null, duration_seconds: null}));
    assert.equal(starts.length, 1); assert.equal(starts[0].title, 'Track'); assert.equal(starts[0].artist, ''); assert.equal(starts[0].album, ''); assert.equal(starts[0].durationSeconds, 0);
    assert.equal(Object.hasOwn(starts[0], 'albumListeningIntent'), false); assert.equal(f.c.state.player.playbackQueue, null); M.noPublicTarget(f);
  }
});
test('ENC03 genuine ordinary Album modal control keeps its intent and queue after Enhanced native Play', async t => {
  const f = await P.platform(t); await M.selected(f); const {starts, modal, album} = P.genuineDispatcher(f); await f.check(); await f.play();
  const button = f.document.createElement('button'); modal.append(button);
  button.setAttribute('data-src', '/track?path=' + encodeURIComponent(album.tracks[0].path)); button.setAttribute('data-track-path', album.tracks[0].path); button.setAttribute('data-track-title', 'Owned modal track');
  f.c.activateSharedTrackButton(button); assert.equal(starts.length, 2); assert.equal(starts[1].path, album.tracks[0].path); assert.equal(starts[1].albumListeningIntent.albumKey, album.key);
  const queue = f.c.state.player.playbackQueue; assert.equal(queue.albumRef, album.key); assert.equal(queue.tracks.length, 1); assert.equal(queue.tracks[0].albumListeningIntent, starts[1].albumListeningIntent);
  assert.equal(JSON.stringify(queue).includes('albumListeningIntent'), false); assert.equal(f.nativeCalls().length, 2);
});
test('ENC04 genuine Enhanced native and ordinary Album controls retain isolation across consecutive actions', async t => {
  const f = await P.platform(t); await M.selected(f); const {starts, modal, album} = P.genuineDispatcher(f);
  const button = f.document.createElement('button'); modal.append(button); button.setAttribute('data-src', '/track?path=' + encodeURIComponent(album.tracks[0].path)); button.setAttribute('data-track-path', album.tracks[0].path);
  f.c.activateSharedTrackButton(button); assert.equal(starts.length, 1); assert.equal(starts[0].albumListeningIntent.albumKey, album.key);
  await f.check(); await f.play(); assert.equal(starts.length, 2); assert.equal(Object.hasOwn(starts[1], 'albumListeningIntent'), false); assert.equal(f.c.state.player.playbackQueue, null);
  assert.equal(modal.hidden, false); assert.equal(f.c.state.modalReleases[0], album); assert.equal(f.nativeCalls().length, 2); M.noPublicTarget(f);
});
