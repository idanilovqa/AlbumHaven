'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {queueFixture, admit, ready, track, source, beginQueue, settleQueue, enqueue, batchCommand, batchReply,
  nativeReply, fullAlbum, mountQueue, outcome, plain, A, assertQueuePrivate} = require('./search-native-fixtures/queue-actions.cjs');

test('capture transfers only exact selected current rows without issuing a request or changing Queue', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), lease = source(h, snapshot);
  const keys = snapshot.result.tracks.map(row => row.rowKey);
  assert.equal(lease.canQueue(keys), true); assert.equal(lease.canQueue([keys[0], keys[0]]), false);
  assert.equal(lease.canQueue(['inventory-track:9:101']), false);
  assert.equal(await lease.captureQueue([keys[0], 'foreign-row']), null);
  const captures = await lease.captureQueue([keys[1], keys[0]]);
  assert.equal(captures.length, 2); assert.equal(captures[0].display.title, snapshot.result.tracks[1].title);
  assert.ok(Object.isFrozen(captures) && captures.every(Object.isFrozen));
  assert.ok(captures.every(value => ['resolveMetadata', 'resolve', 'resolveDetails', 'resolvePlaylistItem', 'isCurrent']
    .every(name => typeof value[name] === 'function')));
  assert.equal(h.requests.length, 1); assert.equal(h.queue.getSnapshot().entries.length, 0); assert.equal(h.streams.length, 0);
  lease.dispose();
});

test('actual native multiselection and existing context menu admit the exact rows into the real Queue', async t => {
  const h = await queueFixture(t, {entry: true}); await admit(h, ready({presentation: 'tracks'}));
  const rows = [...h.host.querySelectorAll('[data-cdt-row-key]')];
  for (const row of rows) h.dispatch(row, 'keydown', {key: ' ', ctrlKey: true});
  assert.ok(rows.every(row => row.getAttribute('aria-selected') === 'true'));
  h.dispatch(rows[0], 'contextmenu', {button: 2});
  const menu = h.document.querySelector('.settings-foobar-format-menu'); assert.ok(menu);
  assert.match(menu.textContent, /Add to playlist/); assert.match(menu.textContent, /At end of queue/);
  h.click([...menu.querySelectorAll('button')].find(node => node.textContent.trim() === 'At end of queue'));
  await h.flush(); assert.deepEqual(batchCommand(h, 1), {resource_refs: ['inventory-track:9:101', 'inventory-track:9:102'], intent: 'metadata'});
  h.reply(1, batchReply(h, 1)); await h.flush(); assert.equal(batchCommand(h, 2).intent, 'play');
  h.reply(2, batchReply(h, 2)); await h.flush();
  const entries = h.queue.getSnapshot().entries;
  assert.equal(entries.length, 2); assert.deepEqual(plain(entries.map(row => row.title)), ['Current title 101', 'Current title 102']);
  assert.equal(new Set(entries.map(row => row.id)).size, 2); assert.ok(entries.every(row => row.sourceReadable && row.canPlay));
  assert.equal(h.streams.length, 0, 'enqueue alone does not start audio'); assertQueuePrivate(h);
});

test('100 current selected rows use exactly one metadata batch and one Play batch with exact query and order', async t => {
  const h = await queueFixture(t), payload = ready({presentation: 'tracks', all: true,
    patch: {tracks: Array.from({length: 100}, (_, index) => track(1001 + index)),
      page: {limit: 100, returned_count: 100, has_more: false, next_cursor: null}}});
  const snapshot = await admit(h, payload), request = await beginQueue(h, snapshot);
  assert.equal(h.requests.length, 2); const command = batchCommand(h, request.start);
  assert.equal(command.resource_refs.length, 100); assert.equal(new Set(command.resource_refs).size, 100);
  assert.deepEqual(command.resource_refs, Array.from({length: 100}, (_, index) => `inventory-track:9:${1001 + index}`));
  const result = await settleQueue(h, request); assert.equal(result.error, undefined); assert.equal(result.value.length, 100);
  assert.equal(h.requests.length, 3, 'no per-row transport fan-out or hidden scan');
  for (const request of h.requests.slice(1)) {
    const url = new URL(request.url, h.location);
    assert.equal(url.searchParams.get('q'), ':loved'); assert.equal(url.searchParams.get('all_artists'), '1');
    assert.equal(url.searchParams.get('search_presentation'), 'tracks'); assert.equal(url.searchParams.has('search_cursor'), false);
    assert.equal(request.options.headers.get('X-AlbumHaven-Context'), A);
    assert.equal(request.options.headers.get('X-Album-Haven-CSRF'), 'synthetic-search-action-csrf');
    assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.cache, 'no-store');
  }
  assert.deepEqual(batchCommand(h, 1).resource_refs, batchCommand(h, 2).resource_refs);
  assert.equal(h.queue.getSnapshot().entries.length, 100); assertQueuePrivate(h);
});

test('real Queue duplicate occurrences deduplicate transport while keeping distinct occurrences and shared canonical preference identity', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), lease = source(h, snapshot);
  const [capture] = await lease.captureQueue([snapshot.result.tracks[0].rowKey]), index = h.requests.length;
  const work = outcome(h.queue.enqueue([capture, capture], 'end', {isCurrent: () => Boolean(lease.snapshot())})); await h.flush();
  assert.deepEqual(batchCommand(h, index).resource_refs, ['inventory-track:9:101']);
  h.reply(index, batchReply(h, index)); await h.flush();
  assert.deepEqual(batchCommand(h, index + 1).resource_refs, ['inventory-track:9:101']);
  h.reply(index + 1, batchReply(h, index + 1)); const result = await work;
  assert.equal(result.error, undefined); assert.equal(result.value.length, 2); assert.notEqual(result.value[0], result.value[1]);
  const rows = h.queue.getSnapshot().entries; assert.equal(rows[0].track_preference.identity, rows[1].track_preference.identity);
  assert.equal(rows[0].title, rows[1].title); assertQueuePrivate(h);
});

for (const [name, mutate] of [
  ['listener dialect', reply => {reply.contract_version = 'listener-history-v1';}],
  ['wrong intent', reply => {reply.data.intent = 'play';}],
  ['missing result', reply => {reply.data.results.pop();}],
  ['duplicate result', reply => {reply.data.results[1] = reply.data.results[0];}],
  ['reordered result', reply => {reply.data.results.reverse();}],
  ['wrong inventory target', reply => {reply.data.results[1].native_target.inventory_track_ref = 'inventory-track:9:999';}],
  ['canonical mismatch', reply => {reply.data.results[1].native_target.track_ref = 'other-canonical';}],
  ['nonboolean play grant', reply => {reply.data.results[1].native_target.allowed_actions.can_play = 'true';}],
  ['unreadable target', reply => {reply.data.results[1].native_target.source_readable = false;}],
  ['unknown availability', reply => {reply.data.results[1].native_target.availability = 'remote';}],
  ['inconsistent local grant', reply => {reply.data.results[1].native_target.availability = 'unresolved';}],
  ['foreign preference surface', reply => {reply.data.results[1].native_target.track_preference.allowed_actions.client_surface_class = 'public_web';}],
  ['nonboolean preference grant', reply => {reply.data.results[1].native_target.track_preference.allowed_actions.can_set_love_tier = 'yes';}],
  ['preference without canonical identity', reply => {reply.data.results[1].native_target.track_ref = null; reply.data.results[1].native_target.canonical_track_ref = null;}],
  ['metadata path injection', reply => {reply.data.results[1].native_target.path = '/borrowed/path';}],
  ['borrowed Activity origin', reply => {reply.data.results[1].origin = {source: 'activity'};}],
  ['projecting unavailable item', reply => {reply.data.results[1].status = 'unavailable';}],
]) test(`complete metadata batch rejects ${name} before any Queue admission or Play request`, async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), request = await beginQueue(h, snapshot);
  h.reply(request.start, batchReply(h, request.start, {mutate}));
  assert.equal((await request.work).error.status, 409); await h.flush();
  assert.equal(h.queue.getSnapshot().entries.length, 0); assert.equal(h.requests.length, 2); assert.equal(h.streams.length, 0);
  assertQueuePrivate(h);
});

for (const status of [401, 403, 409, 503]) test(`whole batch HTTP ${status} never becomes an empty successful enqueue`, async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), request = await beginQueue(h, snapshot);
  h.reply(request.start, {error: 'unavailable'}, status);
  assert.equal((await request.work).error.status, status); assert.equal(h.queue.getSnapshot().entries.length, 0);
});

for (const [name, mutate] of [
  ['reordered results', reply => {reply.data.results.reverse();}],
  ['mismatched media identity', reply => {reply.data.results[1].native_target.track_ref = '/library/borrowed.flac';}],
  ['caller-like grant', reply => {reply.data.results[1].native_target.allowed_actions = {can_play: true};}],
  ['borrowed origin', reply => {reply.data.results[1].origin = {source: 'playlist'};}],
]) test(`complete Play batch rejects ${name} before any Queue append or preference admission`, async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), request = await beginQueue(h, snapshot);
  const admissions = []; const stop = h.c.AlbumHavenHomeRuntime.subscribeTrackPreferences(() => admissions.push(true)); t.after(stop);
  h.reply(request.start, batchReply(h, request.start)); await h.flush();
  h.reply(request.start + 1, batchReply(h, request.start + 1, {mutate}));
  assert.equal((await request.work).error.status, 409); await h.flush();
  assert.equal(admissions.length, 0); assert.equal(h.queue.getSnapshot().entries.length, 0); assert.equal(h.streams.length, 0);
  assertQueuePrivate(h);
});

for (const intent of ['metadata', 'play']) test(`one unavailable ${intent} item prevents partial initial append`, async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), request = await beginQueue(h, snapshot);
  if (intent === 'play') {h.reply(request.start, batchReply(h, request.start)); await h.flush();}
  const index = h.requests.length - 1;
  h.reply(index, batchReply(h, index, {unavailable: ['inventory-track:9:102']})); await h.flush();
  if (intent === 'metadata') {
    assert.deepEqual(batchCommand(h, index + 1), {resource_refs: ['inventory-track:9:101'], intent: 'play'});
    h.reply(index + 1, batchReply(h, index + 1));
  }
  assert.equal((await request.work).error.status, 403); await h.flush();
  assert.equal(h.queue.getSnapshot().entries.length, 0); assert.equal(h.streams.length, 0);
});

test('nullable metadata without canonical preference stays readable without inventing an editable preference identity', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), request = await beginQueue(h, snapshot);
  const result = await settleQueue(h, request, {metadata: {targetPatch: {title: null, artist: null, album_title: null,
    track_ref: null, canonical_track_ref: null, track_preference: null}}});
  assert.equal(result.error, undefined); const entries = h.queue.getSnapshot().entries;
  assert.ok(entries.every(row => row.title === '' && row.artist === '' && row.album === '' && row.track_preference === null));
  assert.ok(entries.every(row => row.sourceReadable && row.canPlay));
});

test('actual Queue panel renders refreshed metadata and owns keyboard selection independently of Search', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})); await enqueue(h, snapshot);
  const index = h.requests.length, panel = await mountQueue(h, t); await h.flush();
  assert.equal(batchCommand(h, index).intent, 'metadata'); h.reply(index, batchReply(h, index)); await h.flush();
  const rows = [...panel.host.querySelectorAll('[data-queue-row]')]; assert.equal(rows.length, 2);
  assert.match(panel.host.textContent, /Current title 101/); assert.ok(rows.every(row => row.tabIndex === 0));
  h.dispatch(rows[0], 'keydown', {key: ' ', ctrlKey: true});
  assert.deepEqual(panel.changes.at(-1), [h.queue.getSnapshot().entries[0].id]);
  assert.equal(panel.host.querySelectorAll('.album-track-table__row--search-match').length, 0); assertQueuePrivate(h, panel.host);
});

test('Queue Play resolves fresh media after capture and hands the new path to the actual native streaming owner', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), queued = await enqueue(h, snapshot);
  const index = h.requests.length, work = outcome(h.queue.play(queued.ids[0])); await h.flush();
  assert.deepEqual(batchCommand(h, index), {resource_refs: ['inventory-track:9:101'], intent: 'play'});
  h.reply(index, batchReply(h, index, {targetPatch: {path: '/library/current-renamed.flac', track_ref: '/library/current-renamed.flac'}}));
  const result = await work; await h.flush();
  assert.ok(result.error, 'the bounded fixture has no working audio device');
  assert.equal(h.streams.length, 1); assert.equal(h.streams[0][0].path, '/library/current-renamed.flac');
  assert.equal(h.streams[0][0].inventory_track_ref, 'inventory-track:9:101'); assert.equal(h.audioAttempts.length, 1);
  assertQueuePrivate(h);
});

test('Queue constructs its own origin and reauthorizes Search before full native Album presentation', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), queued = await enqueue(h, snapshot);
  const scopeKey = h.c.AlbumHavenHomeRuntime.snapshot().scopeKey;
  const details = h.c.AlbumHavenQueueResourceSelection.create({queue: h.queue, scopeKey, isCurrent: () => true}); t.after(() => details.dispose());
  let index = h.requests.length; const selected = outcome(details.select([queued.ids[0]]));
  h.reply(index, nativeReply(h, index)); const result = await selected; assert.equal(result.error, undefined);
  const selection = details.getSnapshot().album;
  assert.deepEqual(plain(selection.origin), {source: 'queue', occurrence_refs: [queued.ids[0]]});
  assert.equal(details.getSnapshot().artist, null); assert.ok(h.queue.getSnapshot().entries.every(row => row.sourceReadable));
  index = h.requests.length; const opened = outcome(details.resourceIntent('open', selection, {scopeKey}));
  h.reply(index, nativeReply(h, index)); await h.flush();
  assert.equal(h.requests[index + 1].url, '/album-details?album_key=native-album-eleven');
  h.reply(index + 1, {ok: true, album: fullAlbum()}); assert.equal((await opened).error, undefined);
  assert.equal(h.modal.hidden, false); assert.equal(h.opens.length, 1); assert.equal(h.hydrations.length, 1);
  assertQueuePrivate(h);
});

test('later Queue-to-Playlist selection rechecks Search metadata and returns only genuine inventory provenance', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), queued = await enqueue(h, snapshot);
  const index = h.requests.length, work = outcome(h.queue.playlistSelection(queued.ids, {signal: new AbortController().signal}));
  await h.flush(); assert.equal(batchCommand(h, index).intent, 'metadata'); h.reply(index, batchReply(h, index));
  const result = await work; assert.equal(result.error, undefined);
  assert.deepEqual(plain(result.value.rows), plain(queued.ids).map((rowKey, index) => ({rowKey,
    track_ref: `inventory-track:9:${101 + index}`, source_provenance: {kind: 'inventory', track_ref: `inventory-track:9:${101 + index}`}})));
  assert.equal(result.value.isCurrent(), true); assert.equal(h.requests.length, index + 1, 'no Playlist is created by source preparation');
});

test('Viewer selection and details remain available while Queue capture is denied without Media capability', async t => {
  const h = await queueFixture(t, {media: false, entry: true}), snapshot = await admit(h, ready({presentation: 'tracks'})), lease = source(h, snapshot);
  const row = snapshot.result.tracks[0], node = h.host.querySelector('[data-cdt-row-key]');
  assert.equal(node.tabIndex, 0); h.dispatch(node, 'keydown', {key: ' ', ctrlKey: true});
  assert.equal(node.getAttribute('aria-selected'), 'true'); assert.equal(h.runtime().canOpenAlbum(snapshot, row), true);
  assert.equal(lease.canQueue([row.rowKey]), false); assert.equal(await lease.captureQueue([row.rowKey]), null);
  h.dispatch(node, 'contextmenu', {button: 2}); const menu = h.document.querySelector('.settings-foobar-format-menu');
  assert.match(menu.textContent, /Add to playlist/); assert.doesNotMatch(menu.textContent, /At end of queue/);
  assert.equal(h.requests.length, 1); assert.equal(h.queue.getSnapshot().entries.length, 0);
});
