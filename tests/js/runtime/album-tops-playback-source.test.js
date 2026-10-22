// Additive source-only coverage. Execute only in the approved full composition.
const test = require('node:test');
const assert = require('node:assert/strict');
let createTopPlaybackSource;
test.before(async () => ({createTopPlaybackSource} = await import('../../../music_app/static/js/album-tops/playback-source.mjs')));

const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const TOP = uuid(1), A = uuid(11), B = uuid(12), C = uuid(13);
const SCOPE = JSON.stringify(['1', '2', 'a'.repeat(64), 4]);
const occurrence = (member, track) => member + ':' + track;
const A1 = occurrence(A, 101), A2 = occurrence(A, 102), A3 = occurrence(A, 103), B1 = occurrence(B, 201), B2 = occurrence(B, 202);
const tuple = (member = A, track = 101, album = 11) => ({revision: '7', item_ref: member, catalog_ref: uuid(album + 100),
  inventory_album_ref: 'inventory-album:2:' + album, inventory_track_ref: 'inventory-track:2:' + track, canonical_track_ref: 'canonical-' + track});
const target = (track = 101, prefix = 'fresh') => ({track_ref: '/synthetic/' + prefix + '/' + track + ' #.flac',
  path: '/synthetic/' + prefix + '/' + track + ' #.flac', title: 'Track ' + track, artist: null, album_title: 'Album',
  duration_seconds: null, inventory_track_ref: 'inventory-track:2:' + track});
const album = (member, number, tracks) => ({item_ref: member, catalog_ref: uuid(number + 100), inventory_album_ref: 'inventory-album:2:' + number,
  album_ref: 'Native album ' + number, tracks: tracks.map(id => ({queue_item_ref: occurrence(member, id),
    source: tuple(member, id, number), native_target: target(id, 'captured')}))});
const capture = () => ({top_ref: TOP, revision: '7', albums: [album(A, 11, [101, 102, 103]), album(B, 12, [201, 202]), album(C, 13, [301])],
  unavailable_items: [{item_ref: A, reason: 'tracks_unavailable'}]});
const reply = input => ({top_ref: input.top_ref, source: {...input.source}, native_target: target(Number(input.source.inventory_track_ref.split(':')[2]))});
const unavailable = () => Object.assign(new Error('Unavailable'), {status: 404, code: 'item_unavailable', responseRejected: true});
const isAbort = error => error.name === 'AbortError';
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
function fixture(input = capture()) {
  const calls = []; let live = true, scopeHook = () => {}, resolver = reply;
  const providers = {resolveNativePlayback(payload, options) {calls.push({payload, options}); return resolver(payload, options);}};
  const source = createTopPlaybackSource({capture: input, providers, scopeKey: SCOPE, isCurrent: () => {scopeHook(); return live;}});
  return {source, calls, input, live: value => {live = value;}, onScope: hook => {scopeHook = hook;}, resolveWith: value => {resolver = value;}};
}
async function accept(env, options) {
  const receipt = await env.source.prepare(options); assert.ok(receipt);
  assert.equal(env.source.commit(receipt, receipt.payload), true); return receipt;
}

test('capture detaches and freezes the exact tuple; no captured native target is read', async () => {
  const input = capture(), expected = {...input.albums[0].tracks[0].source};
  Object.defineProperty(input.albums[0].tracks[0], 'native_target', {get() {throw Error('Cached target must not grant playback');}});
  const env = fixture(input);
  input.top_ref = uuid(999); input.revision = '9'; input.albums[0].tracks[0].source.catalog_ref = uuid(999);
  input.albums[0].tracks.reverse(); input.albums.reverse();
  const receipt = await env.source.prepare();
  assert.deepEqual(env.calls[0].payload, {top_ref: TOP, source: expected});
  assert.ok(Object.isFrozen(env.calls[0].payload.source));
  assert.equal(env.calls[0].options.scopeKey, SCOPE); assert.equal(typeof env.calls[0].options.isCurrent, 'function');
  assert.ok(env.calls[0].options.signal instanceof AbortSignal);
  assert.equal(receipt.occurrenceId, A1); assert.equal(receipt.payload.path, target().path);
  assert.deepEqual(receipt.payload, {sourceKind: 'album-top', src: '/track?path=' + encodeURIComponent(target().path), path: target().path,
    title: 'Track 101', artist: null, album: 'Album', durationSeconds: null, inventory_track_ref: 'inventory-track:2:101', albumRef: 'Native album 11'});
  assert.ok(Object.isFrozen(receipt)); assert.ok(Object.isFrozen(receipt.payload));
  assert.ok(Object.isFrozen(receipt.snapshot)); assert.ok(Object.isFrozen(receipt.snapshot.order));
  for (const field of ['source', 'native_target', 'allowed_actions', 'playback_state', 'albumSnapshot', 'albumDurationSeconds']) {
    assert.equal(Object.hasOwn(receipt.payload, field), false);
  }
  assert.equal(JSON.stringify(receipt.snapshot).includes('inventory-'), false);
  assert.equal(JSON.stringify(receipt.snapshot).includes('/synthetic/'), false);
});

test('preparation never advances history; only the exact fresh native acceptance commits once', async () => {
  const env = fixture(), before = env.source.snapshot(), receipt = await env.source.prepare();
  assert.equal(env.source.snapshot(), before); assert.equal(before.visitedEnd, -1);
  assert.equal(env.source.isReceiptCurrent(receipt), true);
  assert.equal(env.source.commit(receipt), false); assert.equal(env.source.commit({...receipt}, receipt.payload), false);
  assert.equal(env.source.commit(receipt, {...receipt.payload}), false); assert.equal(env.source.snapshot(), before);
  assert.equal(env.source.commit(receipt, receipt.payload), true); assert.equal(env.source.snapshot().visitedEnd, 0);
  assert.equal(env.source.isReceiptCurrent(receipt), false); assert.equal(env.source.commit(receipt, receipt.payload), false);
  assert.equal(env.source.hasBinding(receipt.payload), true);
  const restart = await env.source.prepare({occurrenceId: A1});
  assert.notEqual(restart.payload, receipt.payload); assert.equal(env.calls.length, 2);
  assert.equal(env.source.commit(restart, receipt.payload), false);
  assert.equal(env.source.commit(restart, restart.payload), true);
});

test('first unavailable occurrence is rejected without committing; expected snapshot refreshes for the next receipt', async () => {
  const env = fixture(); env.resolveWith(input => {if (input.source.inventory_track_ref.endsWith(':101')) throw unavailable(); return reply(input);});
  const before = env.source.snapshot(), receipt = await env.source.prepare({occurrenceId: A1});
  assert.equal(receipt.occurrenceId, A2); assert.notEqual(receipt.snapshot, before); assert.equal(receipt.snapshot, env.source.snapshot());
  assert.equal(receipt.snapshot.currentId, A1); assert.equal(receipt.snapshot.visitedEnd, -1);
  assert.deepEqual(receipt.snapshot.unavailableIds, [A1]);
  assert.deepEqual(env.calls.map(call => call.payload.source), [tuple(), tuple(A, 102)]);
  assert.equal(env.calls[0].options.signal, env.calls[1].options.signal);
  assert.equal(env.calls[0].options.isCurrent, env.calls[1].options.isCurrent);
  assert.equal(env.source.commit(receipt, receipt.payload), true);
  assert.equal(env.source.snapshot().currentId, A2); assert.equal(env.source.snapshot().visitedEnd, 1);
});

test('unavailable middle occurrence is skipped while the complete captured visited prefix survives mode edits', async () => {
  const env = fixture(); await accept(env);
  env.resolveWith(input => {if (input.source.inventory_track_ref.endsWith(':102')) throw unavailable(); return reply(input);});
  const receipt = await env.source.prepare({direction: 1, automatic: true, occurrenceId: A2});
  assert.equal(receipt.occurrenceId, A3); assert.equal(env.source.snapshot().currentId, A1); assert.equal(env.source.snapshot().visitedEnd, 0);
  assert.equal(env.source.commit(receipt, receipt.payload), true); assert.equal(env.source.snapshot().visitedEnd, 2);
  assert.equal(env.source.candidate({direction: -1}), A1);
  await accept(env, {direction: -1});
  for (const mode of ['random_albums', 'random_songs', 'in_order']) {
    assert.equal(env.source.configure({mode}), true);
    assert.equal(env.source.snapshot().currentId, A1); assert.equal(env.source.snapshot().visitedEnd, 2);
    assert.deepEqual(env.source.snapshot().order.slice(0, 3), [A1, A2, A3]);
    assert.equal(env.source.candidate(), A3);
  }
});

test('all fresh unavailable occurrences end honestly without moving the current or visited cursor', async () => {
  const env = fixture(); env.resolveWith(() => {throw unavailable();});
  assert.equal(await env.source.prepare(), null); assert.equal(env.calls.length, 6);
  assert.equal(env.source.snapshot().currentId, A1); assert.equal(env.source.snapshot().visitedEnd, -1);
  assert.equal(env.source.snapshot().unavailableIds.length, 6);
  assert.equal(await env.source.prepare(), null); assert.equal(env.calls.length, 6);
});

test('Stop is rechecked after tail rejections; deliberate Next can cross the album boundary', async () => {
  const env = fixture(); await accept(env); assert.equal(env.source.configure({stopAfterAlbum: true}), true);
  env.resolveWith(input => {if (['inventory-track:2:102', 'inventory-track:2:103'].includes(input.source.inventory_track_ref)) throw unavailable(); return reply(input);});
  assert.equal(await env.source.prepare({direction: 1, automatic: true}), null);
  assert.deepEqual(env.calls.map(call => call.payload.source.inventory_track_ref), ['inventory-track:2:101', 'inventory-track:2:102', 'inventory-track:2:103']);
  assert.equal(env.source.snapshot().currentId, A1); assert.equal(env.source.snapshot().visitedEnd, 0);
  const next = await accept(env, {direction: 1, automatic: false}); assert.equal(next.occurrenceId, B1);
  assert.equal(env.source.snapshot().stopAfterAlbum, true);
  assert.equal((await accept(env, {direction: 1, automatic: true})).occurrenceId, B2);
  assert.equal(await env.source.prepare({direction: 1, automatic: true}), null);
});

test('automatic initial rejection cannot cross Stop into another album', async () => {
  const env = fixture(); env.source.configure({stopAfterAlbum: true});
  env.resolveWith(input => {if (input.source.item_ref === A) throw unavailable(); return reply(input);});
  assert.equal(await env.source.prepare({automatic: true}), null);
  assert.equal(env.calls.length, 3); assert.equal(env.source.snapshot().visitedEnd, -1);
  assert.equal((await env.source.prepare()).occurrenceId, B1);
});

test('backward rejections skip only in the requested direction and retain furthest visited history', async () => {
  const env = fixture(); await accept(env); await accept(env, {direction: 1}); await accept(env, {direction: 1}); await accept(env, {direction: 1});
  env.resolveWith(input => {if (input.source.inventory_track_ref.endsWith(':103')) throw unavailable(); return reply(input);});
  const receipt = await env.source.prepare({direction: -1, occurrenceId: A3});
  assert.equal(receipt.occurrenceId, A2); assert.equal(env.source.snapshot().currentId, B1);
  assert.equal(env.source.commit(receipt, receipt.payload), true);
  assert.equal(env.source.snapshot().currentId, A2); assert.equal(env.source.snapshot().visitedEnd, 3);
  assert.equal(env.source.configure({mode: 'random_songs'}), true);
  assert.deepEqual(env.source.snapshot().order.slice(0, 4), [A1, A2, A3, B1]);
  assert.equal(env.source.candidate(), B1); assert.equal(env.source.albumFor(B1), B);
});

test('expected occurrence fences an old restart or adjacent intent and never permits a jump', async () => {
  const env = fixture(), before = env.source.snapshot();
  for (const options of [{occurrenceId: A2}, {direction: 1, occurrenceId: B1}, {direction: -1, occurrenceId: A1}]) {
    await assert.rejects(env.source.prepare(options), isAbort);
    assert.equal(env.source.snapshot(), before); assert.equal(env.calls.length, 0);
  }
  assert.equal(await env.source.prepare({direction: -1}), null);
});

const refusals = [
  ['generic 404', {status: 404, responseRejected: true}],
  ['unconfirmed 404', {status: 404, code: 'item_unavailable'}],
  ['truthy rejection flag', {status: 404, responseRejected: 1, code: 'item_unavailable'}],
  ['text status', {status: '404', responseRejected: true, code: 'item_unavailable'}],
  ['different code', {status: 404, responseRejected: true, code: 'not_found'}],
  ['forbidden', {status: 403, responseRejected: true, code: 'item_unavailable'}],
  ['revision conflict', {status: 409, responseRejected: true, code: 'item_unavailable'}],
  ['server failure', {status: 502, responseRejected: true, code: 'item_unavailable'}],
  ['network failure', {}], ['provider abort', {name: 'AbortError'}],
];
for (const [name, fields] of refusals) test(name + ' propagates without skip or plan mutation', async () => {
  const env = fixture(), before = env.source.snapshot(), error = Object.assign(new Error(name), fields);
  env.resolveWith(() => {throw error;});
  await assert.rejects(env.source.prepare(), actual => actual === error);
  assert.equal(env.calls.length, 1); assert.equal(env.source.snapshot(), before); assert.equal(env.source.isCurrent(), true);
});

test('stale exact unavailable response cannot reject the occurrence', async () => {
  const env = fixture(), pending = deferred(), before = env.source.snapshot();
  env.resolveWith(() => pending.promise);
  const result = assert.rejects(env.source.prepare(), isAbort);
  env.live(false); pending.reject(unavailable()); await result;
  assert.equal(env.source.snapshot(), before); env.live(true); assert.equal(env.source.isCurrent(), false);
});

test('caller abort retires the owned provider signal and receipt, but permits a newer session intent', async () => {
  const env = fixture(), pending = deferred(), controller = new AbortController(), before = env.source.snapshot();
  env.resolveWith(() => pending.promise);
  const result = assert.rejects(env.source.prepare({signal: controller.signal}), isAbort);
  const call = env.calls[0]; assert.notEqual(call.options.signal, controller.signal); assert.equal(call.options.signal.aborted, false);
  controller.abort(); assert.equal(call.options.signal.aborted, true); assert.equal(call.options.isCurrent(), false);
  pending.resolve(reply(call.payload)); await result; assert.equal(env.source.snapshot(), before);
  env.resolveWith(reply); assert.equal((await env.source.prepare()).occurrenceId, A1);
});

test('already aborted caller does no I/O; abort after preparation prevents commit', async () => {
  const env = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(env.source.prepare({signal: controller.signal}), isAbort); assert.equal(env.calls.length, 0);
  const next = new AbortController(), before = env.source.snapshot(), receipt = await env.source.prepare({signal: next.signal});
  next.abort(); assert.equal(env.calls[0].options.signal.aborted, true);
  assert.equal(env.source.isReceiptCurrent(receipt), false); assert.equal(env.source.commit(receipt, receipt.payload), false);
  assert.equal(env.source.hasBinding(receipt.payload), true); assert.equal(env.source.snapshot(), before);
});

test('successor preparation cancels late work and a late response cannot replace or commit its receipt', async () => {
  const env = fixture(), pending = deferred(), before = env.source.snapshot(); env.resolveWith(() => pending.promise);
  const old = assert.rejects(env.source.prepare(), isAbort), oldCall = env.calls[0];
  env.resolveWith(reply); const receipt = await env.source.prepare();
  assert.equal(oldCall.options.signal.aborted, true); assert.equal(oldCall.options.isCurrent(), false);
  pending.resolve(reply(oldCall.payload)); await old;
  assert.equal(env.source.isReceiptCurrent(receipt), true); assert.equal(env.source.snapshot(), before);
  assert.equal(env.source.commit(receipt, receipt.payload), true);
});

test('reentrant successor from cancellation wins over the outer preparation', async () => {
  const env = fixture(), pending = deferred(); let successor;
  env.resolveWith(() => pending.promise); const old = assert.rejects(env.source.prepare(), isAbort), oldCall = env.calls[0];
  oldCall.options.signal.addEventListener('abort', () => {successor = env.source.prepare();}, {once: true});
  env.resolveWith(reply); await assert.rejects(env.source.prepare(), isAbort);
  const receipt = await successor; assert.equal(env.calls.length, 2); assert.equal(env.source.isReceiptCurrent(receipt), true);
  pending.resolve(reply(oldCall.payload)); await old;
  assert.equal(env.source.commit(receipt, receipt.payload), true);
});

test('cancel leaves bindings recognizable but rejects ready or late pending receipts', async () => {
  const env = fixture(), first = await env.source.prepare(), before = env.source.snapshot();
  env.source.cancel(); assert.equal(env.source.commit(first, first.payload), false); assert.equal(env.source.hasBinding(first.payload), true);
  const pending = deferred(); env.resolveWith(() => pending.promise);
  const result = assert.rejects(env.source.prepare(), isAbort), call = env.calls.at(-1);
  env.source.cancel(); pending.resolve(reply(call.payload)); await result;
  assert.equal(env.source.snapshot(), before); assert.equal(env.source.isCurrent(), true);
});

test('scope retirement is sticky after ready preparation and disposal never erases provenance', async () => {
  const env = fixture(), receipt = await env.source.prepare(), before = env.source.snapshot();
  env.live(false); assert.equal(env.source.isReceiptCurrent(receipt), false); env.live(true);
  assert.equal(env.source.isCurrent(), false); assert.equal(env.source.hasBinding(receipt.payload), true);
  assert.equal(env.source.commit(receipt, receipt.payload), false); await assert.rejects(env.source.prepare(), isAbort);
  assert.equal(env.source.snapshot(), before);
  const disposed = fixture(), ready = await disposed.source.prepare(); disposed.source.dispose();
  assert.equal(disposed.source.hasBinding(ready.payload), true); assert.equal(disposed.source.commit(ready, ready.payload), false);
  assert.equal(disposed.source.configure({stopAfterAlbum: true}), false);
});

for (const cause of ['throw', 'reentry']) test('session current callback ' + cause + ' retires permanently', async () => {
  const env = fixture();
  env.onScope(() => {if (cause === 'throw') throw Error('Scope retired'); env.source.isCurrent();});
  await assert.rejects(env.source.prepare(), isAbort); assert.equal(env.calls.length, 0);
  env.onScope(() => {}); assert.equal(env.source.isCurrent(), false);
});

for (const cause of ['false', 'throw', 'reentry']) test('native intent ' + cause + ' retires only that request and never revives', async () => {
  const env = fixture(), pending = deferred(); let changed = false;
  const intent = () => {
    if (!changed) return true;
    if (cause === 'throw') throw Error('Native selection retired');
    if (cause === 'reentry') env.calls[0].options.isCurrent();
    return cause !== 'false';
  };
  env.resolveWith(() => pending.promise); const result = assert.rejects(env.source.prepare({isCurrent: intent}), isAbort);
  changed = true; assert.equal(env.calls[0].options.isCurrent(), false); changed = false;
  assert.equal(env.calls[0].options.isCurrent(), false); pending.resolve(reply(env.calls[0].payload)); await result;
  assert.equal(env.source.isCurrent(), true); env.resolveWith(reply); assert.ok(await env.source.prepare());
});

test('receipt guard reevaluates a phased native selection predicate before and after accepted admission', async () => {
  const env = fixture(); let selection = 'old', admitted = false, checks = 0;
  const receipt = await env.source.prepare({isCurrent: () => {checks++; return selection === (admitted ? 'new' : 'old');}});
  const preparedChecks = checks; assert.equal(env.source.isReceiptCurrent(receipt), true); assert.ok(checks > preparedChecks);
  admitted = true; selection = 'new';
  assert.equal(env.source.isReceiptCurrent(receipt), true); assert.equal(env.source.commit(receipt, receipt.payload), true);
});

test('changed mode or Stop setting cancels pending work; invalid, stale, or no-op configuration preserves a ready receipt', async () => {
  for (const configuration of [{mode: 'random_albums'}, {mode: 'popular_songs'}, {stopAfterAlbum: true}]) {
    const env = fixture(), pending = deferred(); env.resolveWith(() => pending.promise);
    const result = assert.rejects(env.source.prepare(), isAbort), call = env.calls[0];
    assert.equal(env.source.configure(configuration), true); const after = env.source.snapshot();
    assert.equal(call.options.signal.aborted, true); pending.resolve(reply(call.payload)); await result;
    assert.equal(env.source.snapshot(), after); assert.equal(after.visitedEnd, -1);
  }
  const env = fixture(), receipt = await env.source.prepare(), before = env.source.snapshot();
  assert.equal(env.source.configure({mode: 'unsupported_mode'}), false); assert.equal(env.source.configure({stopAfterAlbum: 1}), false);
  assert.equal(env.source.configure({stopAfterAlbum: true}, {...before}), false); assert.equal(env.source.configure({mode: 'in_order'}), true);
  assert.equal(env.source.snapshot(), before); assert.equal(env.source.isReceiptCurrent(receipt), true);
  assert.equal(env.source.commit(receipt, receipt.payload), true);
});

test('reentrant mode change from the native intent guard cannot publish or commit a stale receipt', async () => {
  const env = fixture(); let changed = false;
  await assert.rejects(env.source.prepare({isCurrent: () => {
    if (!changed) {changed = true; env.source.configure({stopAfterAlbum: true});} return true;
  }}), isAbort);
  assert.equal(env.calls.length, 0); assert.equal(env.source.snapshot().stopAfterAlbum, true); assert.equal(env.source.snapshot().visitedEnd, -1);
  assert.equal(env.source.isCurrent(), true);
});

test('final payload projection fence rejects a response that retires the native intent while being projected', async () => {
  const env = fixture(), before = env.source.snapshot(); let live = true;
  env.resolveWith(input => {
    const value = reply(input); Object.defineProperty(value.native_target, 'path', {enumerable: true, get() {live = false; return target().path;}}); return value;
  });
  await assert.rejects(env.source.prepare({isCurrent: () => live}), isAbort); assert.equal(env.source.snapshot(), before);
});

test('wrong fresh source identity fails closed without falling back to captured native authority', async () => {
  const env = fixture(), before = env.source.snapshot();
  env.resolveWith(input => ({...reply(input), source: {...input.source, canonical_track_ref: 'swapped'}}));
  await assert.rejects(env.source.prepare(), error => error.status === 502);
  assert.equal(env.source.snapshot(), before); assert.equal(env.calls.length, 1);
});

test('coverPath aliases preserve exact receipt identity, including after retirement, while mutations and foreign copies fail closed', async () => {
  const env = fixture(), receipt = await env.source.prepare(), clone = {...receipt.payload, coverPath: '/cover/11'};
  assert.equal(env.source.hasBinding(clone), false); assert.equal(env.source.aliasBinding(receipt.payload, clone), true);
  assert.equal(env.source.hasBinding(clone), true); assert.equal(env.source.isReceiptCurrent(receipt, clone), true);
  clone.path = '/swapped.flac'; assert.equal(env.source.commit(receipt, clone), false); assert.equal(env.source.hasBinding(clone), true);
  assert.equal(env.source.aliasBinding(clone, {...receipt.payload}), false);
  assert.equal(env.source.aliasBinding(receipt.payload, {...receipt.payload, source: tuple()}), false);
  assert.equal(env.source.aliasBinding(receipt.payload, {...receipt.payload, coverPath: 12}), false);
  const accepted = {...receipt.payload, coverPath: '/cover/12'};
  assert.equal(env.source.aliasBinding(receipt.payload, accepted), true); assert.equal(env.source.commit(receipt, accepted), true);
  env.source.dispose(); const retiredClone = {...receipt.payload, coverPath: '/cover/13'};
  assert.equal(env.source.aliasBinding(receipt.payload, retiredClone), true); assert.equal(env.source.hasBinding(retiredClone), true);
  assert.equal(env.source.isReceiptCurrent(receipt, retiredClone), false);
});

for (const guard of ['session', 'intent']) for (const field of ['path', 'sourceKind']) for (const method of ['isReceiptCurrent', 'commit']) {
  test(method + ' rejects alias ' + field + ' mutation in the final ' + guard + ' callback', async () => {
    const env = fixture(); let clone, checks = 0;
    const mutate = () => {
      if (clone && ++checks === 2) clone[field] = field === 'path' ? '/swapped.flac' : 'ordinary';
      return true;
    };
    if (guard === 'session') env.onScope(mutate);
    const receipt = await env.source.prepare(guard === 'intent' ? {isCurrent: mutate} : {}), before = env.source.snapshot();
    clone = {...receipt.payload, coverPath: '/cover/11'};
    assert.equal(env.source.aliasBinding(receipt.payload, clone), true);
    assert.equal(env.source[method](receipt, clone), false);
    assert.equal(checks, 2, 'Mutation happened in the callback after the first payload validation');
    assert.equal(env.source.snapshot(), before); assert.equal(env.source.snapshot().visitedEnd, -1);
    assert.equal(env.source.hasBinding(clone), true, 'Persistence still recognizes the invalid mutated alias');
  });
}

test('identical fresh native fields never alias a foreign session or a different receipt', async () => {
  const left = fixture(), right = fixture(), first = await left.source.prepare(), foreign = await right.source.prepare();
  assert.deepEqual(first.payload, foreign.payload);
  assert.equal(left.source.hasBinding(foreign.payload), false); assert.equal(left.source.aliasBinding(first.payload, foreign.payload), false);
  assert.equal(left.source.commit(first, foreign.payload), false); assert.equal(right.source.hasBinding(first.payload), false);
  const later = await left.source.prepare();
  assert.equal(left.source.hasBinding(first.payload), true); assert.equal(left.source.aliasBinding(later.payload, first.payload), false);
  assert.equal(left.source.commit(later, first.payload), false); assert.equal(left.source.commit(later, later.payload), true);
});

test('shared native track identity in distinct saved members retains exact per-occurrence source and receipt binding', async () => {
  const first = album(A, 11, [101]), second = album(B, 11, [101]);
  second.catalog_ref = uuid(112); second.tracks[0].source.catalog_ref = uuid(112);
  const env = fixture({...capture(), albums: [first, second], unavailable_items: []});
  const accepted = await accept(env), next = await env.source.prepare({direction: 1, occurrenceId: occurrence(B, 101)});
  assert.deepEqual(accepted.payload, next.payload); assert.notEqual(accepted.occurrenceId, next.occurrenceId);
  assert.deepEqual(env.calls[1].payload.source, second.tracks[0].source);
  assert.equal(env.source.aliasBinding(next.payload, accepted.payload), false);
  assert.equal(env.source.commit(next, accepted.payload), false); assert.equal(env.source.commit(next, next.payload), true);
  assert.equal(env.source.snapshot().currentId, occurrence(B, 101));
});

test('invalid capture and malformed request do not invent empty plans or discard an existing receipt', async () => {
  for (const albums of [[], Array(1), [album(A, 11, [])]]) {
    assert.throws(() => fixture({...capture(), albums}), TypeError);
  }
  const env = fixture(), receipt = await env.source.prepare();
  for (const options of [{direction: 2}, {automatic: 1}, {occurrenceId: ''}, {isCurrent: true}, {signal: {}}]) {
    await assert.rejects(env.source.prepare(options), TypeError); assert.equal(env.source.isReceiptCurrent(receipt), true);
  }
  assert.equal(env.source.hasBinding(null), false); assert.equal(env.source.aliasBinding({}, {}), false);
});
