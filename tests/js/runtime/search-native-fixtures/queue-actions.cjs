'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const base = require('./native-actions.cjs');

// Additive exact-owner composition. The inherited fixture loads the served
// runtime manifest, real private transport, Search, TrackActions, ExplicitQueue,
// native selection and Album presentation. Only network replies, bounded DOM
// geometry and the unavailable audio-device boundary are synthetic inputs.
async function queueFixture(t, options = {}) {
  const h = await base.actionFixture(t, options), queue = h.c.AlbumHavenExplicitQueue;
  assert.ok(queue?.enqueue && queue?.refresh && queue?.details && queue?.play);
  assert.deepEqual(base.plain(queue.getSnapshot().entries), []);
  return {...h, queue};
}
function batchCommand(h, index) {
  const request = h.requests[index]; assert.ok(request, `actual batch request ${index} exists`);
  assert.equal(new URL(request.url, h.location).pathname, '/search/native-targets');
  assert.equal(request.options.method, 'POST');
  const command = JSON.parse(request.options.body);
  assert.deepEqual(Object.keys(command).sort(), ['intent', 'resource_refs']);
  assert.ok(['metadata', 'play'].includes(command.intent));
  return command;
}
function metadataTarget(resourceRef, patch = {}) {
  const id = resourceRef.split(':').at(-1), canonical = `canonical-track-${id}`;
  return {inventory_track_ref: resourceRef, track_ref: canonical, canonical_track_ref: canonical, source_readable: true,
    title: `Current title ${id}`, artist: 'Current Artist', album_title: 'Current Album', duration_seconds: 90,
    availability: 'local', allowed_actions: {can_read: true, can_play: true}, playback_state: {can_start_here: true},
    track_preference: {love_tier: 'loved', rating: null,
      allowed_actions: {client_surface_class: 'private_web', can_rate: true, can_set_love_tier: true}}, ...patch};
}
function playTarget(resourceRef, patch = {}) {
  const id = resourceRef.split(':').at(-1), file = `/library/queue/${id}.flac`;
  return {inventory_track_ref: resourceRef, track_ref: file, path: file,
    title: `Played title ${id}`, artist: 'Current Artist', album_title: 'Current Album', duration_seconds: 90, ...patch};
}
function batchReply(h, index, {unavailable = [], mutate, targetPatch = {}} = {}) {
  const command = batchCommand(h, index);
  const result = {status: 'ready', contract_version: 'own-love-native-batch-v1', context_ref: base.A,
    data: {intent: command.intent, results: command.resource_refs.map(resource_ref => unavailable.includes(resource_ref)
      ? {resource_ref, status: 'unavailable'}
      : {resource_ref, status: 'ready', native_target: (command.intent === 'metadata' ? metadataTarget : playTarget)(resource_ref, targetPatch)})}};
  mutate?.(result); return result;
}
async function beginQueue(h, snapshot = h.runtime().snapshot(), {indices, signal, timing = 'end', isCurrent} = {}) {
  const lease = base.source(h, snapshot), keys = (indices || snapshot.result.tracks.map((_, index) => index))
    .map(index => snapshot.result.tracks[index].rowKey);
  const captures = await lease.captureQueue(keys, {signal}); assert.ok(captures);
  const start = h.requests.length;
  const work = base.outcome(h.queue.enqueue(captures, timing, {signal,
    isCurrent: () => Boolean(lease.snapshot()) && (!isCurrent || isCurrent())}));
  await h.flush();
  return {lease, keys, captures, work, start};
}
async function settleQueue(h, request, {metadata = {}, play = {}} = {}) {
  assert.equal(batchCommand(h, request.start).intent, 'metadata');
  h.reply(request.start, batchReply(h, request.start, metadata)); await h.flush();
  assert.equal(batchCommand(h, request.start + 1).intent, 'play');
  h.reply(request.start + 1, batchReply(h, request.start + 1, play));
  const result = await request.work; await h.flush(); return result;
}
async function enqueue(h, snapshot, options) {
  const request = await beginQueue(h, snapshot, options), result = await settleQueue(h, request);
  assert.equal(result.error, undefined, result.error?.stack); assert.equal(result.value.length, request.keys.length);
  return {...request, ids: result.value};
}
async function mountQueue(h, t, {selectedIds = []} = {}) {
  const module = await import(pathToFileURL(path.join(base.ROOT, 'music_app/static/js/home-friends/queue.mjs')).href);
  const host = h.document.createElement('section'); h.document.body.append(host);
  const runtime = h.c.AlbumHavenHomeRuntime, changes = [];
  const props = () => ({api: h.queue, value: h.queue.getSnapshot(), scopeKey: runtime.snapshot().scopeKey,
    selectedIds, onSelect: ids => changes.push(base.plain(ids))});
  const owner = module.mountQueuePanel(host, runtime, props());
  const unsubscribe = h.queue.subscribe(() => owner.update(props()));
  t.after(() => {unsubscribe(); owner.dispose(); host.remove();});
  return {host, owner, changes, update: () => owner.update(props())};
}
function assertQueuePrivate(h, host) {
  const publicValues = [JSON.stringify(h.queue.getSnapshot()), host?.innerHTML || '', JSON.stringify(h.historyCalls),
    JSON.stringify(h.applications.map(row => row.result))];
  for (const value of publicValues) for (const secret of ['/library/queue/', 'canonical-track-', '/search/native-targets',
    'inventory-track:9:', 'native_target', 'resource_refs']) assert.equal(value.includes(secret), false, `public Queue excludes ${secret}`);
}
module.exports = {...base, queueFixture, batchCommand, metadataTarget, playTarget, batchReply,
  beginQueue, settleQueue, enqueue, mountQueue, assertQueuePrivate};
