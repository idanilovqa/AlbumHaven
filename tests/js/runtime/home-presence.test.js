const test = require('node:test');
const assert = require('node:assert/strict');
let createPresencePublisher, currentPresence;
test.before(async () => ({createPresencePublisher, currentPresence} = await import('../../../music_app/static/js/home-friends/presence.mjs')));
const settle = () => new Promise(resolve => setImmediate(resolve));
test('presence publishes path-free source and one monotonic sequence; pause clears without touching playback', async () => {
  const calls = [], timers = new Map(); let timerId = 0, playback = {track_ref: 'inventory-track:1:4', state: 'playing'}, listener;
  const publisher = createPresencePublisher({playerRef: 'player', readPlayback: () => playback, subscribe: next => {listener = next; return () => {listener = null;};},
    transport: {context: () => 'scope', request: async (url, options) => {calls.push({url, ...options}); return {data: {presence_ref: 'opaque'}};}},
    schedule: (callback, delay) => {timers.set(++timerId, {callback, delay}); return timerId;}, cancel: id => timers.delete(id)});
  await settle(); assert.deepEqual(calls.map(call => call.body.sequence), [1, 2]);
  assert.equal(calls[0].body.track_ref, 'inventory-track:1:4'); assert.equal(calls[1].body.state, 'playing');
  playback = {...playback, state: 'paused'}; listener(); await settle();
  assert.equal(calls.at(-1).body.state, 'paused'); assert.equal(calls.at(-1).body.sequence, 3);
  assert.equal(playback.state, 'paused'); publisher.dispose(); assert.equal(timers.size, 0); assert.equal(listener, null);
});
test('source acquisition resolving after pause never announces stale playing', async () => {
  let resolve, playback = {track_ref: 'inventory-track:1:4', state: 'playing'}; const calls = [];
  const publisher = createPresencePublisher({playerRef: 'player', readPlayback: () => playback,
    transport: {context: () => 'scope', request: async (url, options) => {calls.push({url, ...options});
      if (url.endsWith('presence-source')) return new Promise(done => {resolve = done;}); return {data: {}};}}, schedule: () => 1, cancel() {}});
  playback = {...playback, state: 'stopped'}; resolve({data: {presence_ref: 'opaque'}}); await settle();
  assert.equal(calls.at(-1).body.state, 'stopped'); publisher.dispose();
});
test('live presentation rejects completed, stale, other-subject and revoked rows without history inference', () => {
  const now = Date.parse('2026-10-09T07:00:00Z');
  const data = {subject_ref: 'friend', occurrence_ref: 'occurrence', state: 'playing', observed_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 14000).toISOString(), row: {kind: 'track', title: 'Track', source_readable: true}};
  assert.equal(currentPresence({status: 'ready', data}, 'friend', now), data);
  for (const patch of [{state: 'paused'}, {state: 'completed'}, {subject_ref: 'actor'}, {expires_at: new Date(now).toISOString()},
    {observed_at: new Date(now - 16000).toISOString()}, {row: {source_readable: false}}]) {
    assert.equal(currentPresence({status: 'ready', data: {...data, ...patch}}, 'friend', now), null);
  }
  assert.equal(currentPresence({status: 'denied', data}, 'friend', now), null);
});


test('presence never sends raw-path acquisition or silently revives an expired token on timer', async () => {
  const calls = [], timers = []; let playback = {track_ref: '/private/track.flac', state: 'playing'}, listener;
  const publisher = createPresencePublisher({playerRef: 'player', readPlayback: () => playback,
    subscribe: value => {listener = value; return () => {};},
    transport: {context: () => 'scope', request: async (url, options) => {calls.push({url, ...options}); throw Object.assign(new Error('expired'), {status: 410});}},
    schedule: callback => {timers.push(callback); return timers.length;}, cancel() {}});
  await settle(); assert.equal(calls.length, 0);
  playback = {track_ref: 'inventory-track:1:4', state: 'playing'}; listener(); await settle(); assert.equal(calls.length, 1);
  timers.at(-1)(); await settle(); assert.equal(calls.length, 1, 'timer cannot revive rejected presence');
  listener(); await settle(); assert.equal(calls.length, 2, 'new playback event can acquire with a higher sequence');
  assert.equal(calls[1].body.sequence, 2); publisher.dispose();
});
