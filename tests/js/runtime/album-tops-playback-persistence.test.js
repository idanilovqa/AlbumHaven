'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, world, track} = require('./search-native-fixtures/ownership-platform.cjs');

const topTrack = () => ({...track('Top'), sourceKind: 'album-top'});
const saved = (current, playbackQueue = null) => ({
  track: current, playbackQueue, currentTime: 12, paused: false,
  loop: {active: false, start: 0, end: 90},
});

for (const explicitQueue of [false, true]) test(`Top current payload is never serialized with explicit Queue ${explicitQueue}`, async t => {
  const h = await fixture(t);
  h.state.player.current = topTrack();
  h.state.player.playbackQueue = explicitQueue
    ? {explicitQueue: true, tracks: [track('Explicit')], currentIndex: 0}
    : {sourceKind: 'album-top', tracks: [h.state.player.current], currentIndex: 0};
  const playbackSnapshot = {src: h.state.player.current.src, currentTime: 12, paused: true};
  assert.equal(h.c.buildPersistedPlayerState({playbackSnapshot}), null);
  h.c.persistPlayerState(true, {playbackSnapshot});
  assert.equal(h.c.localStorage.getItem('albumhaven.playerState.v1'), null);
});

for (const markedQueue of [false, true]) test(`Top queue provenance cannot become bare paths, queue marker ${markedQueue}`, async t => {
  const h = await fixture(t);
  const current = track('Ordinary');
  h.state.player.current = current;
  h.state.player.playbackQueue = markedQueue
    ? {sourceKind: 'album-top', tracks: [current], currentIndex: 0}
    : {tracks: [current, topTrack()], currentIndex: 0};
  assert.equal(h.c.buildPersistedPlaybackQueue(current.path), null);
  const value = h.c.buildPersistedPlayerState({playbackSnapshot: {src: current.src, paused: true}});
  assert.equal(value.track.path, current.path, 'independent ordinary current track remains persistable');
  assert.equal(value.playbackQueue, null);
});

for (const location of ['track', 'queue', 'occurrence']) test(`stored Top ${location} fails closed before native restore side effects`, async t => {
  const current = location === 'track' ? topTrack() : track('Ordinary');
  const queue = location === 'queue'
    ? {sourceKind: 'album-top', tracks: [current], currentIndex: 0}
    : location === 'occurrence' ? {tracks: [current, topTrack()], currentIndex: 0} : null;
  const value = saved(current, queue);
  const h = await fixture(t, world(), {savedPlayerState: value, readyState: 'complete'});
  await h.flush();
  assert.equal(h.owner('playerRestoreAttempt'), null);
  assert.equal(h.platform.contexts.length, 0);
  assert.equal(h.platform.sockets.length, 0);
  assert.equal(h.state.player.current, null);
  const previousQueue = h.state.player.playbackQueue;
  assert.equal(h.c.restorePersistedPlaybackQueue(value, current.path), false);
  assert.equal(h.state.player.playbackQueue, previousQueue);
  assert.equal(h.world.local.has('albumhaven.playbackOwnership.v1'), false);
});

test('ordinary persisted queue keeps its exact existing normalization and restore path', async t => {
  const h = await fixture(t);
  const current = track('Ordinary');
  h.state.player.current = current;
  h.state.player.playbackQueue = {tracks: [current], currentIndex: 0};
  const value = h.c.buildPersistedPlayerState({playbackSnapshot: {src: current.src, paused: true, currentTime: 12}});
  assert.equal(value.track.path, current.path);
  assert.equal(value.currentTime, 12);
  assert.equal(value.paused, true);
  assert.equal(value.playbackQueue.tracks.length, 1);
  assert.equal(value.playbackQueue.tracks[0].path, current.path);
  h.state.player.playbackQueue = null;
  assert.equal(h.c.restorePersistedPlaybackQueue(value, current.path), true);
  assert.equal(h.state.player.playbackQueue.tracks[0].path, current.path);
  assert.equal(h.state.player.playbackQueue.currentIndex, 0);
});
