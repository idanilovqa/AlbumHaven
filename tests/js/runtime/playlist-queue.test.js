const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/playlist-queue.js'), 'utf8');
function setup() {
  const tracks = ['one', 'two', 'three'].map(path => ({path}));
  const queue = {playlistId: 'p', tracks, regularTracks: tracks, currentIndex: 1, repeatMode: 'off', shuffle: false};
  const state = {player: {current: {path: 'two'}, playbackQueue: queue}}, engine = {roles: {current: {}, continuity: null}};
  const scheduled = [], closed = [];
  const context = vm.createContext({state, Math, Promise, streamingEngineState: () => engine,
    closeStreamingContinuityRole: reason => {closed.push(reason); engine.roles.continuity = null; return true;},
    scheduleStreamingContinuity: track => {scheduled.push(track); return Promise.resolve();}});
  vm.runInContext(source, context);
  return {context, queue, state, engine, scheduled, closed};
}
test('Playlist queue Regular, Repeat One and Repeat All choose exact next indices', () => {
  const h = setup();
  assert.equal(h.context.playlistQueueNextIndex(h.queue, 'two'), 2);
  assert.equal(h.context.playlistQueueNextIndex(h.queue, 'three'), -1);
  h.queue.repeatMode = 'one'; assert.equal(h.context.playlistQueueNextIndex(h.queue, 'two'), 1);
  h.queue.repeatMode = 'all'; assert.equal(h.context.playlistQueueNextIndex(h.queue, 'three'), 0);
  assert.equal(h.context.playlistQueueNextIndex({tracks: h.queue.tracks}, 'two'), null);
});
test('Shuffle keeps current track, every item once; Regular restores source order', () => {
  const h = setup(); let next = h.context.replacePlaylistQueueModes(h.queue, {shuffle: true});
  assert.equal(next.tracks[0].path, 'two'); assert.equal(next.currentIndex, 0);
  assert.deepEqual(Array.from(next.tracks, row => row.path).sort(), ['one', 'three', 'two']);
  next = h.context.replacePlaylistQueueModes(next, {shuffle: false});
  assert.deepEqual(Array.from(next.tracks, row => row.path), ['one', 'two', 'three']); assert.equal(next.currentIndex, 1);
});
test('in-flight promotion and notified boundary reject changes without disturbing queue or decoder', () => {
  for (const boundary of ['pendingPromotion', 'boundaryNotified']) {
    const h = setup(); h.engine.roles.continuity = {};
    if (boundary === 'pendingPromotion') h.engine.pendingPromotion = {};
    else h.engine.roles.current.boundaryNotified = true;
    assert.throws(() => h.context.replacePlaylistQueueModes(h.queue, {repeat: 'all'}), /transition/);
    assert.equal(h.state.player.playbackQueue, h.queue); assert.equal(h.closed.length, 0); assert.equal(h.scheduled.length, 0);
  }
});
test('confirmed queue change retires only prepared continuity and schedules through native owner', () => {
  const h = setup(); h.engine.roles.continuity = {};
  h.context.replacePlaylistQueueModes(h.queue, {repeat: 'one'});
  assert.deepEqual(h.closed, ['playlist-queue-mode']); assert.equal(h.scheduled[0].path, 'two');
  assert.equal(h.engine.roles.current.boundaryNotified, undefined);
});
test('source replacement and refused native close cannot mutate queue', () => {
  const h = setup(); h.state.player.playbackQueue = {owner: 'new-source'};
  assert.throws(() => h.context.replacePlaylistQueueModes(h.queue, {repeat: 'all'}));
  h.state.player.playbackQueue = h.queue; h.engine.roles.continuity = {}; h.context.closeStreamingContinuityRole = () => false;
  assert.throws(() => h.context.replacePlaylistQueueModes(h.queue, {repeat: 'all'})); assert.equal(h.state.player.playbackQueue, h.queue);
});

test('same-current source replacement retires old prepared next before installing the new playlist', () => {
  const h = setup(); h.engine.roles.continuity = {track: {path: 'three'}};
  const next = {playlistId: 'new-playlist', tracks: [{path: 'two'}, {path: 'new-next'}], currentIndex: 0, repeatMode: 'off'};
  h.context.commitPlaylistQueue(next, h.queue);
  assert.equal(h.state.player.playbackQueue, next); assert.equal(h.scheduled[0].path, 'new-next');
  assert.deepEqual(h.closed, ['playlist-queue-mode']);
});
test('a native user loop keeps its continuity owner when a Playlist queue changes', () => {
  const h = setup(); h.state.player.loopActive = true; h.engine.roles.continuity = {continuityOptions: {kind: 'short-loop'}};
  h.context.replacePlaylistQueueModes(h.queue, {repeat: 'all'});
  assert.equal(h.closed.length, 0); assert.equal(h.scheduled.length, 0);
  assert.equal(h.engine.roles.continuity.continuityOptions.kind, 'short-loop');
});

test('Repeat changes preserve the exact chosen shuffled order', () => {
  const h = setup(); let calls = 0;
  h.context.Math = Object.assign(Object.create(Math), {random: () => {calls++; return 0;}});
  let queue = h.context.replacePlaylistQueueModes(h.queue, {shuffle: true});
  const order = queue.tracks, count = calls;
  queue = h.context.replacePlaylistQueueModes(queue, {repeat: 'all'});
  assert.equal(queue.tracks, order); queue = h.context.replacePlaylistQueueModes(queue, {repeat: 'one'});
  assert.equal(queue.tracks, order); assert.equal(calls, count);
});

test('distinct Playlist occurrences sharing one path advance through the native queue owner', () => {
  const h = setup(), tracks = [{playlistItemId: 'A', path: 'X'}, {playlistItemId: 'B', path: 'X'}, {playlistItemId: 'C', path: 'Y'}];
  h.queue.tracks = tracks; h.queue.regularTracks = tracks; h.queue.currentIndex = 0; h.state.player.current = tracks[0];
  const native = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/tag-editor-and-optimistic-updates.js'), 'utf8');
  vm.runInContext(native.slice(native.indexOf('function peekNextQueuedTrack()'), native.indexOf('function refreshTrackModalPlaybackState()')), h.context);
  assert.equal(h.context.peekNextQueuedTrack().playlistItemId, 'B');
  h.state.player.current = h.context.getNextQueuedTrack(); assert.equal(h.queue.currentIndex, 1);
  assert.equal(h.context.peekNextQueuedTrack().playlistItemId, 'C');
  h.state.player.current = h.context.getNextQueuedTrack(); assert.equal(h.queue.currentIndex, 2);
  assert.equal(h.context.peekNextQueuedTrack(), null);
});
test('Shuffle and Repeat preserve the exact current duplicate-path occurrence', () => {
  const h = setup(), tracks = [{playlistItemId: 'A', path: 'X'}, {playlistItemId: 'B', path: 'X'}, {playlistItemId: 'C', path: 'Y'}];
  h.queue.tracks = tracks; h.queue.regularTracks = tracks; h.queue.currentIndex = 1; h.state.player.current = tracks[1];
  let queue = h.context.replacePlaylistQueueModes(h.queue, {shuffle: true});
  assert.equal(queue.tracks[0].playlistItemId, 'B'); assert.equal(queue.currentIndex, 0);
  queue = h.context.replacePlaylistQueueModes(queue, {repeat: 'one'});
  assert.equal(queue.tracks[h.context.playlistQueueNextIndex(queue, 'X')].playlistItemId, 'B');
  queue = h.context.replacePlaylistQueueModes(queue, {shuffle: false}); assert.equal(queue.currentIndex, 1);
  assert.equal(queue.tracks[queue.currentIndex].playlistItemId, 'B');
});
