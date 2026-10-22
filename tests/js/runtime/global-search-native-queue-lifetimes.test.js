'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {queueFixture, admit, ready, ordinary, source, beginQueue, settleQueue, enqueue,
  batchCommand, batchReply, nativeReply, outcome, A, B, plain, assertQueuePrivate} = require('./search-native-fixtures/queue-actions.cjs');

for (const phase of ['metadata', 'play']) test(`replacement during initial ${phase} prevents append without taking a successor Search owner`, async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), request = await beginQueue(h, snapshot);
  if (phase === 'play') {h.reply(request.start, batchReply(h, request.start)); await h.flush();}
  const index = h.requests.length - 1, successor = await admit(h, ready({query: ':obsessed', presentation: 'tracks'}));
  h.reply(index, batchReply(h, index)); await h.flush();
  if (phase === 'metadata') {const play = h.requests.length - 1; assert.equal(batchCommand(h, play).intent, 'play'); h.reply(play, batchReply(h, play));}
  assert.equal((await request.work).error.name, 'AbortError'); await h.flush();
  assert.equal(h.queue.getSnapshot().entries.length, 0); assert.equal(h.runtime().isCurrent(successor), true);
  assert.equal(h.streams.length, 0); assertQueuePrivate(h);
});

test('already captured rows cannot enter Queue after their actual source lease is disposed', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), lease = source(h, snapshot);
  const captures = await lease.captureQueue(snapshot.result.tracks.map(row => row.rowKey)); lease.dispose();
  const result = await outcome(h.queue.enqueue(captures, 'end', {isCurrent: () => Boolean(lease.snapshot())}));
  assert.equal(result.error.name, 'AbortError'); assert.equal(h.requests.length, 1); assert.equal(h.queue.getSnapshot().entries.length, 0);
});

test('explicit Search continuation retires an unfinished Queue capture before the replacement page arrives', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), request = await beginQueue(h, snapshot);
  h.reply(request.start, batchReply(h, request.start)); await h.flush();
  const play = h.requests.length - 1;
  assert.equal(h.runtime().continueResults(snapshot), true); await h.flush();
  const continuation = h.requests.length - 1;
  assert.equal(new URL(h.requests[continuation].url, h.location).searchParams.get('search_cursor'), 'sealed-results-A');
  h.reply(play, batchReply(h, play)); assert.equal((await request.work).error.name, 'AbortError');
  assert.equal(h.queue.getSnapshot().entries.length, 0);
  h.reply(continuation, ready({presentation: 'tracks', patch: {sidebar: null,
    page: {limit: 50, returned_count: 2, has_more: false, next_cursor: null}}}));
  const applied = await h.invocations.at(-1).outcome;
  assert.equal(applied.error, undefined); assert.equal(applied.value, true);
  const successor = h.runtime().snapshot();
  assert.equal(successor.status, 'ready'); assert.equal(h.runtime().isCurrent(successor), true);
  assert.notEqual(successor.sourceIdentity, snapshot.sourceIdentity); assert.equal(h.streams.length, 0);
});

for (const change of ['query', 'page', 'ordinary', 'host', 'source']) test(`admitted Queue survives ${change} retirement of its originating visible Search`, async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), queued = await enqueue(h, snapshot);
  if (change === 'query') await admit(h, ready({query: ':obsessed'}));
  else if (change === 'page') {
    assert.equal(h.runtime().continueResults(snapshot), true); await h.flush();
    const index = h.requests.length - 1;
    assert.equal(new URL(h.requests[index].url, h.location).searchParams.get('search_cursor'), 'sealed-results-A');
    h.reply(index, ready({presentation: 'tracks', patch: {sidebar: null,
      page: {limit: 50, returned_count: 2, has_more: false, next_cursor: null}}}));
    const applied = await h.invocations.at(-1).outcome;
    assert.equal(applied.error, undefined); assert.equal(applied.value, true);
    const successor = h.runtime().snapshot();
    assert.equal(successor.status, 'ready'); assert.equal(h.runtime().isCurrent(successor), true);
    assert.notEqual(successor.sourceIdentity, snapshot.sourceIdentity);
  } else if (change === 'ordinary') {
    const index = h.requests.length, navigation = h.read('/view-data?surface=albums&q=ordinary');
    h.reply(index, ordinary('ordinary')); assert.equal((await navigation).value, true);
  } else if (change === 'host') {h.host.remove(); await h.flush();}
  else queued.lease.dispose();
  assert.deepEqual(plain(h.queue.getSnapshot().entries.map(row => row.id)), plain(queued.ids));
  assert.ok(h.queue.getSnapshot().entries.every(row => row.sourceReadable));
  const index = h.requests.length, refresh = outcome(h.queue.refresh()); await h.flush();
  assert.equal(batchCommand(h, index).intent, 'metadata');
  assert.equal(new URL(h.requests[index].url, h.location).searchParams.get('q'), ':loved', 'retained source reproves the original query');
  h.reply(index, batchReply(h, index)); assert.equal((await refresh).error, undefined);
  assert.ok(h.queue.getSnapshot().entries.every(row => row.sourceReadable)); assertQueuePrivate(h);
});

for (const attribute of ['nativeAccountId', 'nativeLibraryId', 'privateUiContext']) {
  for (const phase of ['fetch', 'json']) test(`${attribute} A-B-A during Queue ${phase} never revives the captured source`, async t => {
    const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), request = await beginQueue(h, snapshot);
    const reply = batchReply(h, request.start), body = phase === 'json' ? h.requests[request.start].holdJson() : null;
    if (body) await h.requests[request.start].jsonStarted;
    const original = h.shell.dataset[attribute]; h.shell.dataset[attribute] = attribute === 'privateUiContext' ? B : '99'; h.shell.dataset[attribute] = original;
    if (body) body.resolve(reply); else h.reply(request.start, reply);
    assert.equal((await request.work).error.name, 'AbortError'); await h.flush();
    assert.ok(request.captures.every(capture => capture.isCurrent() === false));
    assert.equal(h.queue.getSnapshot().entries.length, 0); assert.equal(h.streams.length, 0);
  });
}

for (const change of ['actor', 'library', 'context', 'runtime', 'transport']) test(`${change} replacement retires admitted captures without borrowing a new session`, async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), queued = await enqueue(h, snapshot);
  if (change === 'runtime') h.replaceRuntime();
  else if (change === 'transport') h.c.AlbumHavenPrivateUITransport = h.c.createAlbumHavenPrivateUITransport();
  else h.change(change);
  await h.flush(); assert.ok(queued.captures.every(capture => capture.isCurrent() === false));
  const entries = h.queue.getSnapshot().entries;
  assert.ok(entries.every(row => row.sourceReadable === false && row.canPlay === false));
  const index = h.requests.length, result = await outcome(queued.captures[0].resolveMetadata({signal: new AbortController().signal}));
  assert.equal(result.error.name, 'AbortError'); assert.equal(h.requests.length, index); assertQueuePrivate(h);
});

for (const phase of ['before dispatch', 'metadata', 'play']) test(`caller cancellation ${phase} cannot append, play or leave an authority result`, async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), controller = new AbortController();
  if (phase === 'before dispatch') {
    const lease = source(h, snapshot), captures = await lease.captureQueue(snapshot.result.tracks.map(row => row.rowKey));
    const work = outcome(h.queue.enqueue(captures, 'end', {signal: controller.signal, isCurrent: () => Boolean(lease.snapshot())}));
    controller.abort(); assert.equal((await work).error.name, 'AbortError'); await h.flush();
    assert.equal(h.requests.length, 1, 'cancelled microtask does not dispatch a batch');
  } else {
    const request = await beginQueue(h, snapshot, {signal: controller.signal});
    if (phase === 'play') {h.reply(request.start, batchReply(h, request.start)); await h.flush();}
    const index = h.requests.length - 1, reply = batchReply(h, index); controller.abort();
    assert.equal((await request.work).error.name, 'AbortError'); assert.equal(h.requests[index].options.signal.aborted, true);
    h.reply(index, reply); await h.flush();
  }
  assert.equal(h.queue.getSnapshot().entries.length, 0); assert.equal(h.streams.length, 0);
});

test('real newer player selection defeats an initial Queue capture even when all Search targets later succeed', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), request = await beginQueue(h, snapshot);
  const newer = outcome(h.c.playTrackFromPayload({path: '/library/newer-choice.flac', src: '/track?path=%2Flibrary%2Fnewer-choice.flac', title: 'Newer choice'}));
  const result = await settleQueue(h, request); await newer;
  assert.equal(result.error.name, 'AbortError'); assert.equal(h.queue.getSnapshot().entries.length, 0);
  assert.equal(h.streams.length, 1); assert.equal(h.streams[0][0].path, '/library/newer-choice.flac');
});

test('actual preference admission observer can retire the Search source before the final Queue append', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), request = await beginQueue(h, snapshot);
  const stop = h.c.AlbumHavenHomeRuntime.subscribeTrackPreferences(() => request.lease.dispose()); t.after(stop);
  const result = await settleQueue(h, request);
  assert.equal(result.error.name, 'AbortError'); assert.equal(h.queue.getSnapshot().entries.length, 0);
  assert.equal(request.lease.snapshot(), null); assert.equal(h.streams.length, 0);
});

test('Love or source loss after admission marks only the denied entry unavailable without clearing other Queue rows', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), queued = await enqueue(h, snapshot);
  let index = h.requests.length, refresh = outcome(h.queue.refresh()); await h.flush();
  h.reply(index, batchReply(h, index, {unavailable: ['inventory-track:9:101']})); assert.equal((await refresh).error, undefined);
  let entries = h.queue.getSnapshot().entries;
  assert.deepEqual(plain(entries.map(row => row.id)), plain(queued.ids));
  assert.equal(entries[0].sourceReadable, false); assert.equal(entries[0].canPlay, false); assert.equal(entries[0].title, 'Unavailable track');
  assert.equal(entries[1].sourceReadable, true); assert.equal(entries[1].title, 'Current title 102');
  index = h.requests.length; refresh = outcome(h.queue.refresh()); await h.flush();
  h.reply(index, batchReply(h, index)); assert.equal((await refresh).error, undefined);
  entries = h.queue.getSnapshot().entries; assert.ok(entries.every(row => row.sourceReadable));
  assertQueuePrivate(h);
});

test('Media loss retains independently readable Queue metadata but prevents fresh playback', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), queued = await enqueue(h, snapshot);
  const index = h.requests.length, refresh = outcome(h.queue.refresh()); await h.flush();
  h.reply(index, batchReply(h, index, {targetPatch: {allowed_actions: {can_read: true, can_play: false}, playback_state: {can_start_here: false}}}));
  assert.equal((await refresh).error, undefined);
  assert.ok(h.queue.getSnapshot().entries.every(row => row.sourceReadable && !row.canPlay && row.title.startsWith('Current title')));
  const play = await outcome(h.queue.play(queued.ids[0])); assert.ok(play.error); assert.equal(h.streams.length, 0);
});

test('canonical remapping on a later metadata refresh cannot inherit an admitted Queue preference identity', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})); await enqueue(h, snapshot);
  const index = h.requests.length, work = outcome(h.queue.refresh()); await h.flush();
  h.reply(index, batchReply(h, index, {mutate: reply => {
    reply.data.results[0].native_target.track_ref = 'reassigned-canonical';
    reply.data.results[0].native_target.canonical_track_ref = 'reassigned-canonical';
  }}));
  assert.equal((await work).error, undefined); const entries = h.queue.getSnapshot().entries;
  assert.equal(entries[0].sourceReadable, false); assert.equal(entries[0].track_preference, null); assert.equal(entries[1].sourceReadable, true);
});

test('a later refresh batches only retained Queue occurrences, not removed members of the captured Search page', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), queued = await enqueue(h, snapshot);
  assert.equal(h.queue.remove(queued.ids[0]), true);
  const index = h.requests.length, refresh = outcome(h.queue.refresh()); await h.flush();
  assert.deepEqual(batchCommand(h, index), {resource_refs: ['inventory-track:9:102'], intent: 'metadata'});
  h.reply(index, batchReply(h, index)); assert.equal((await refresh).error, undefined);
  assert.deepEqual(plain(h.queue.getSnapshot().entries.map(row => row.id)), [queued.ids[1]]);
});

test('separate Queue operation signals cannot share, revive or consume each other batch replies', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), queued = await enqueue(h, snapshot);
  const one = new AbortController(), two = new AbortController(), index = h.requests.length;
  const first = outcome(queued.captures[0].resolveMetadata({signal: one.signal}));
  const second = outcome(queued.captures[0].resolveMetadata({signal: two.signal})); await h.flush();
  assert.equal(h.requests.length, index + 2); one.abort(); assert.equal((await first).error.name, 'AbortError');
  h.reply(index, {error: 'forbidden'}, 403); h.reply(index + 1, batchReply(h, index + 1));
  assert.equal((await second).value.inventory_track_ref, 'inventory-track:9:101'); assert.equal(queued.captures[0].isCurrent(), true);
  const nextIndex = h.requests.length, next = outcome(queued.captures[0].resolveMetadata({signal: two.signal})); await h.flush();
  assert.equal(h.requests.length, nextIndex + 1, 'settled data is not cached even when the caller reuses a signal');
  h.reply(nextIndex, batchReply(h, nextIndex)); assert.equal((await next).error, undefined);
});

test('current Queue details denial affects its source without revoking a successor visible Search', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), queued = await enqueue(h, snapshot);
  const successor = await admit(h, ready({query: ':obsessed', presentation: 'tracks'}));
  const index = h.requests.length, work = outcome(h.queue.details(queued.ids[0], 'album', {signal: new AbortController().signal}));
  h.reply(index, {error: 'forbidden'}, 403); assert.equal((await work).error.status, 403);
  assert.equal(h.queue.getSnapshot().entries[0].sourceReadable, false); assert.equal(h.queue.getSnapshot().entries[1].sourceReadable, true);
  assert.equal(h.runtime().isCurrent(successor), true); assert.equal(h.runtime().canOpenAlbum(successor, successor.result.tracks[0]), true);
});

test('removing a Queue occurrence retires its real detail selection and blocks a late native details reply', async t => {
  const h = await queueFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), queued = await enqueue(h, snapshot);
  const scopeKey = h.c.AlbumHavenHomeRuntime.snapshot().scopeKey;
  const details = h.c.AlbumHavenQueueResourceSelection.create({queue: h.queue, scopeKey, isCurrent: () => true}); t.after(() => details.dispose());
  const index = h.requests.length, work = outcome(details.select([queued.ids[0]]));
  assert.equal(h.queue.remove(queued.ids[0]), true); h.reply(index, nativeReply(h, index)); await work;
  assert.equal(details.getSnapshot().album, null); assert.equal(h.opens.length, 0);
  assert.deepEqual(plain(h.queue.getSnapshot().entries.map(row => row.id)), [queued.ids[1]]);
});
