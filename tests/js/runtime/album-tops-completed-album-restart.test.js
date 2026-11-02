// E1 scheduling/receipt foundation only; no terminal certification, audio or listening credit.
const test = require('node:test');
const assert = require('node:assert/strict');
let createTopQueuePlan, createTopPlaybackSource;
test.before(async () => {
  ({createTopQueuePlan} = await import('../../../music_app/static/js/album-tops/queue-plan.mjs'));
  ({createTopPlaybackSource} = await import('../../../music_app/static/js/album-tops/playback-source.mjs'));
});
const MODES = ['in_order', 'random_albums', 'random_songs', 'popular_songs'];
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const TOP = uuid(1), A = uuid(11), B = uuid(12);
const id = (album, track) => album + ':' + track;
const A1 = id(A, 101), A2 = id(A, 102), A3 = id(A, 103), B1 = id(B, 201), B3 = id(B, 203);
const SCOPE = JSON.stringify(['1', '2', 'a'.repeat(64), 4]);
const tuple = (member, track, album) => ({revision: '7', item_ref: member, catalog_ref: uuid(album + 100),
  inventory_album_ref: 'inventory-album:2:' + album, inventory_track_ref: 'inventory-track:2:' + track,
  canonical_track_ref: 'canonical-' + track});
function capture() {
  return {top_ref: TOP, revision: '7', albums: [[A, 11, [101, 102, 103]], [B, 12, [201, 202, 203]]].map(([member, album, tracks]) => ({
    item_ref: member, catalog_ref: uuid(album + 100), inventory_album_ref: 'inventory-album:2:' + album,
    album_ref: 'Album ' + album, tracks: tracks.map((track, index) => ({queue_item_ref: id(member, track),
      source: tuple(member, track, album), popularity: {provider: 'lastfm', metric: 'overall_scrobbles', count: index}})),
  }))};
}
const reply = input => ({top_ref: input.top_ref, source: {...input.source}, native_target: {
  path: '/synthetic/' + input.source.inventory_track_ref + '.flac', title: 'Fresh', artist: null,
  album_title: 'Album', duration_seconds: null, inventory_track_ref: input.source.inventory_track_ref,
}});
const unavailable = () => Object.assign(new Error('Unavailable'), {status: 404, responseRejected: true, code: 'item_unavailable'});
const isAbort = error => error?.name === 'AbortError';
function requireRestart(source) {
  assert.equal(typeof source.prepareRestart, 'function', 'E1 API ABSENT: approved source.prepareRestart; later restart invariants are unreached');
}
function requirePlanRestart(plan) {
  for (const key of ['restartCandidate', 'rejectRestart', 'commitRestart']) {
    assert.equal(typeof plan[key], 'function', 'E1 API ABSENT: approved plan.' + key + '; later restart invariants are unreached');
  }
}
function fixture(options = {}) {
  const calls = [], work = [], gates = []; let resolver = reply, live = true, scopeHook = () => {}, randomCalls = 0;
  // Source captures this real plan random function at construction; no private plan/state edits.
  const originalRandom = Math.random; let source;
  Math.random = () => {randomCalls++; return 0;};
  try {
    source = createTopPlaybackSource({capture: capture(), scopeKey: SCOPE, ...options,
      isCurrent: () => {scopeHook(); return live;}, providers: {resolveNativePlayback(payload, opts) {
        calls.push({payload, options: opts}); return resolver(payload, opts);
      }}});
  } finally {Math.random = originalRandom;}
  return {source, calls, randomCalls: () => randomCalls, resolveWith: fn => {resolver = fn;},
    live: value => {live = value;}, onScope: fn => {scopeHook = fn;},
    own(promise) {work.push(promise); promise.catch(() => {}); return promise;},
    gate() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
      const gate = {promise, resolve, reject}; gates.push(gate); return gate;},
    async close() {
      source.dispose(); // Retire ownership before releasing only test-held provider gates.
      for (const gate of gates) gate.resolve(null);
      const results = await Promise.allSettled(work);
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Owned assertion work failed');
    }};
}
async function accept(env, options) {
  const receipt = await env.source.prepare(options);
  assert.ok(receipt); assert.equal(env.source.commit(receipt, receipt.payload), true); return receipt;
}
async function finish(env, finalId = A3) {
  let last = await accept(env);
  for (let count = 0; last.occurrenceId !== finalId && count < 6; count++) last = await accept(env, {direction: 1, automatic: false});
  assert.equal(last.occurrenceId, finalId); return last;
}
function unchangedTraversal(before, after) {
  assert.equal(after.currentIndex, before.currentIndex); assert.equal(after.visitedEnd, before.visitedEnd);
  assert.deepEqual(after.order, before.order); assert.equal(after.mode, before.mode);
  assert.equal(after.stopAfterAlbum, before.stopAfterAlbum);
}

test('E1-01 source restart prepares fresh first occurrence and resets traversal only on exact commit', async () => {
  const env = fixture({stopAfterAlbum: true});
  try {
    const old = await finish(env), completed = env.source.snapshot();
    assert.equal(completed.currentIndex, 2); assert.equal(completed.visitedEnd, 2);
    requireRestart(env.source);
    const receipt = await env.source.prepareRestart({expected: completed});
    assert.equal(receipt.occurrenceId, A1); assert.equal(env.source.snapshot(), completed);
    assert.notEqual(receipt.payload, old.payload); assert.deepEqual(env.calls.at(-1).payload.source, tuple(A, 101, 11));
    assert.equal(env.source.commit(receipt, receipt.payload), true);
    const after = env.source.snapshot();
    assert.equal(after.currentIndex, 0); assert.equal(after.visitedEnd, 0);
    assert.deepEqual(after.order, completed.order); assert.deepEqual(after.unavailableIds, completed.unavailableIds);
    assert.equal(after.mode, completed.mode); assert.equal(after.stopAfterAlbum, true);
    assert.equal(env.source.commit(receipt, receipt.payload), false);
  } finally {await env.close();}
});

test('E1-02 existing normal adjacency and private receipt authority cannot be bypassed by restart shapes', async () => {
  const env = fixture();
  try {
    const old = await finish(env), completed = env.source.snapshot(), calls = env.calls.length;
    await assert.rejects(env.source.prepare({occurrenceId: A1}), isAbort);
    assert.equal(env.calls.length, calls); assert.equal(env.source.snapshot(), completed);
    assert.equal(env.source.commit({kind: 'restart', snapshot: completed, occurrenceId: A1, payload: old.payload}, old.payload), false);
    assert.equal(env.source.commit(old, old.payload), false);
    const plan = createTopQueuePlan([{id: 'a', tracks: ['a1', 'a2', 'a3']}]);
    for (const value of ['a1', 'a2', 'a3']) assert.equal(plan.commit(value), true);
    const before = plan.snapshot(); assert.equal(plan.commit('a1'), false); assert.equal(plan.snapshot(), before);
  } finally {await env.close();}
});

for (const mode of MODES) test('E1-03 restart retains effective order without random sampling: ' + mode, async () => {
  const env = fixture({mode});
  try {
    const initial = env.source.snapshot(), last = initial.order.at(-1);
    await finish(env, last); const before = env.source.snapshot(), randomCalls = env.randomCalls();
    const first = before.order.find(value => env.source.albumFor(value) === before.currentAlbumId);
    requireRestart(env.source);
    const receipt = await env.source.prepareRestart();
    assert.equal(receipt.occurrenceId, first); assert.equal(env.source.snapshot(), before);
    assert.equal(env.source.commit(receipt, receipt.payload), true);
    const after = env.source.snapshot(), index = before.order.indexOf(first);
    assert.equal(after.currentIndex, index); assert.equal(after.visitedEnd, index);
    assert.deepEqual(after.order, initial.order); assert.equal(after.mode, mode);
    assert.equal(env.randomCalls(), randomCalls);
  } finally {await env.close();}
});

for (const stopAfterAlbum of [false, true]) {
  test('E1-04 existing automatic stop and deliberate next remain unchanged: ' + stopAfterAlbum, async () => {
    const env = fixture({stopAfterAlbum});
    try {
      await finish(env); const before = env.source.snapshot();
      assert.equal(env.source.candidate({automatic: true}), stopAfterAlbum ? null : B1);
      assert.equal(env.source.candidate({automatic: false}), B1);
      assert.equal(env.source.snapshot(), before);
      assert.equal((await accept(env, {direction: 1, automatic: false})).occurrenceId, B1);
    } finally {await env.close();}
  });
  test('E1-04 final current album restarts its region, not the whole Top: ' + stopAfterAlbum, async () => {
    const env = fixture({stopAfterAlbum});
    try {
      await finish(env, B3); const before = env.source.snapshot();
      requireRestart(env.source); const receipt = await env.source.prepareRestart();
      assert.equal(receipt.occurrenceId, B1); assert.notEqual(receipt.occurrenceId, A1);
      assert.equal(env.source.snapshot(), before); assert.equal(env.source.commit(receipt, receipt.payload), true);
      assert.equal(env.source.snapshot().currentIndex, 3); assert.equal(env.source.snapshot().visitedEnd, 3);
      assert.deepEqual(env.source.snapshot().order, before.order); assert.equal(env.source.snapshot().stopAfterAlbum, stopAfterAlbum);
    } finally {await env.close();}
  });
}

test('E1-05 known exclusions and fresh exact404 are retained without moving completed traversal', async () => {
  const env = fixture({stopAfterAlbum: true});
  try {
    env.resolveWith(input => {if (input.source.inventory_track_ref.endsWith(':101')) throw unavailable(); return reply(input);});
    await finish(env); const before = env.source.snapshot(), count = env.calls.length;
    assert.deepEqual(before.unavailableIds, [A1]);
    requireRestart(env.source);
    env.resolveWith(input => {if (input.source.inventory_track_ref.endsWith(':102')) throw unavailable(); return reply(input);});
    const receipt = await env.source.prepareRestart();
    assert.equal(receipt.occurrenceId, A3); unchangedTraversal(before, env.source.snapshot());
    assert.deepEqual(env.source.snapshot().unavailableIds, [A1, A2]);
    assert.deepEqual(env.calls.slice(count).map(call => call.payload.source.inventory_track_ref), ['inventory-track:2:102', 'inventory-track:2:103']);
    assert.equal(env.source.commit(receipt, receipt.payload), true);
    assert.deepEqual(env.source.snapshot().unavailableIds, [A1, A2]);
  } finally {await env.close();}
});
for (const stopAfterAlbum of [false, true]) test('E1-05 exhausted restart region never escapes into next album: ' + stopAfterAlbum, async () => {
  const env = fixture({stopAfterAlbum});
  try {
    await finish(env); const before = env.source.snapshot(), count = env.calls.length;
    requireRestart(env.source); env.resolveWith(() => {throw unavailable();});
    assert.equal(await env.source.prepareRestart(), null); unchangedTraversal(before, env.source.snapshot());
    assert.deepEqual(env.source.snapshot().unavailableIds, [A1, A2, A3]);
    assert.deepEqual(env.calls.slice(count).map(call => call.payload.source.item_ref), [A, A, A]);
    assert.equal(await env.source.prepareRestart(), null); assert.equal(env.calls.length, count + 3);
  } finally {await env.close();}
});

for (const kind of ['forbidden', 'network', 'malformed']) test('E1-06 current failure preserves traversal and allows fresh retry: ' + kind, async () => {
  const env = fixture();
  try {
    await finish(env); const before = env.source.snapshot(); requireRestart(env.source);
    const error = Object.assign(new Error(kind), kind === 'forbidden' ? {status: 403, code: 'item_unavailable', responseRejected: true} : {});
    env.resolveWith(input => {if (kind === 'malformed') return {...reply(input), top_ref: 'wrong'}; throw error;});
    await assert.rejects(env.source.prepareRestart(), actual => kind === 'malformed' ? actual.status === 502 : actual === error);
    assert.equal(env.source.snapshot(), before);
    env.resolveWith(reply); const receipt = await env.source.prepareRestart();
    assert.equal(receipt.occurrenceId, A1); assert.equal(env.source.commit(receipt, receipt.payload), true);
  } finally {await env.close();}
});

test('E1-07 stale restart snapshot cannot abort an active normal preparation', async () => {
  const env = fixture();
  try {
    const stale = env.source.snapshot(); await finish(env); requireRestart(env.source);
    const gate = env.gate(); env.resolveWith(() => gate.promise);
    const pending = env.own(env.source.prepare()), call = env.calls.at(-1), count = env.calls.length;
    await assert.rejects(env.source.prepareRestart({expected: stale}), isAbort);
    assert.equal(call.options.signal.aborted, false); assert.equal(env.calls.length, count);
    gate.resolve(reply(call.payload)); const receipt = await pending;
    assert.equal(env.source.isReceiptCurrent(receipt), true); assert.equal(env.source.commit(receipt, receipt.payload), true);
  } finally {await env.close();}
});

test('E1-07 configure retires a restart without rewinding completed traversal', async () => {
  const env = fixture();
  try {
    await finish(env); const before = env.source.snapshot(); requireRestart(env.source);
    const receipt = await env.source.prepareRestart();
    assert.equal(env.source.configure({stopAfterAlbum: true}), true);
    assert.equal(env.source.isReceiptCurrent(receipt), false); assert.equal(env.source.commit(receipt, receipt.payload), false);
    assert.equal(env.source.snapshot().currentIndex, before.currentIndex); assert.equal(env.source.snapshot().visitedEnd, before.visitedEnd);
  } finally {await env.close();}
});

test('E1-07 plan restart checks exact snapshots and current-region candidates only', () => {
  const plan = createTopQueuePlan([{id: 'a', tracks: ['a1', 'a2', 'a3']}, {id: 'b', tracks: ['b1']}]);
  const stale = plan.snapshot();
  for (const value of ['a1', 'a2', 'a3']) assert.equal(plan.commit(value), true);
  const completed = plan.snapshot(); requirePlanRestart(plan);
  assert.equal(plan.restartCandidate(stale), null);
  assert.equal(plan.rejectRestart('a1', stale), false); assert.equal(plan.commitRestart('a1', stale), false);
  assert.equal(plan.restartCandidate(completed), 'a1'); assert.equal(plan.snapshot(), completed);
  assert.equal(plan.rejectRestart('b1', completed), false); assert.equal(plan.commitRestart('a2', completed), false);
  assert.equal(plan.snapshot(), completed);
  assert.equal(plan.rejectRestart('a1', completed), true);
  const excluded = plan.snapshot(); unchangedTraversal(completed, excluded);
  assert.equal(plan.restartCandidate(excluded), 'a2'); assert.deepEqual(excluded.unavailableIds, ['a1']);
  assert.equal(plan.commitRestart('a2', completed), false); assert.equal(plan.commitRestart('a2', excluded), true);
  assert.equal(plan.snapshot().currentIndex, 1); assert.equal(plan.snapshot().visitedEnd, 1);
  assert.deepEqual(plan.snapshot().order, completed.order); assert.deepEqual(plan.snapshot().unavailableIds, ['a1']);
});

for (const successorKind of ['normal', 'restart']) for (const settlement of ['success', 'failure']) {
  test('E1-08 held restart cannot bind or retire successor: ' + successorKind + '/' + settlement, async () => {
    const env = fixture();
    try {
      await finish(env); requireRestart(env.source); const before = env.source.snapshot();
      const gate = env.gate(); env.resolveWith(() => gate.promise);
      const old = env.own(assert.rejects(env.source.prepareRestart(), isAbort)), call = env.calls.at(-1);
      env.resolveWith(reply);
      const receipt = await (successorKind === 'normal' ? env.source.prepare() : env.source.prepareRestart());
      assert.equal(call.options.signal.aborted, true);
      if (settlement === 'failure') gate.reject(new Error('late old failure')); else gate.resolve(reply(call.payload));
      await old;
      assert.equal(env.source.snapshot(), before); assert.equal(env.source.isReceiptCurrent(receipt), true);
      assert.equal(env.source.commit(receipt, receipt.payload), true);
      assert.equal(env.source.snapshot().currentId, successorKind === 'normal' ? A3 : A1);
    } finally {await env.close();}
  });
}

test('E1-09 abort reentry C wins and outer restart B never reaches provider', async () => {
  const env = fixture(); let successor;
  try {
    await finish(env); requireRestart(env.source);
    const gate = env.gate(); env.resolveWith(() => gate.promise);
    const old = env.own(assert.rejects(env.source.prepare(), isAbort)), call = env.calls.at(-1), count = env.calls.length;
    call.options.signal.addEventListener('abort', () => {successor = env.own(env.source.prepareRestart());}, {once: true});
    env.resolveWith(reply);
    await assert.rejects(env.source.prepareRestart(), isAbort);
    assert.ok(successor, 'Abort callback actually launched C');
    const receipt = await successor;
    assert.equal(env.calls.length, count + 1, 'Only C resolves; B cannot reach provider after losing ownership');
    gate.resolve(reply(call.payload)); await old;
    assert.equal(env.source.isReceiptCurrent(receipt), true); assert.equal(env.source.commit(receipt, receipt.payload), true);
  } finally {await env.close();}
});

for (const guard of [1, 2, 3, 4]) test('E1-10 intent callback cancellation at request guard ' + guard, async () => {
  const env = fixture();
  try {
    await finish(env); requireRestart(env.source); const before = env.source.snapshot();
    let checks = 0, reentered = false;
    await assert.rejects(env.source.prepareRestart({isCurrent: () => {
      if (++checks === guard) {reentered = true; env.source.cancel();}
      return true;
    }}), isAbort);
    assert.equal(reentered, true, 'Intended real callback guard was exercised');
    assert.equal(env.source.snapshot(), before);
    const retry = await env.source.prepareRestart(); assert.equal(env.source.commit(retry, retry.payload), true);
  } finally {await env.close();}
});

for (const guard of [1, 2]) test('E1-10 intent callback cancellation at receipt guard ' + guard, async () => {
  const env = fixture();
  try {
    await finish(env); requireRestart(env.source); const before = env.source.snapshot();
    let armed = false, checks = 0, reentered = false;
    const receipt = await env.source.prepareRestart({isCurrent: () => {
      if (armed && ++checks === guard) {reentered = true; env.source.cancel();}
      return true;
    }});
    armed = true;
    assert.equal(env.source.commit(receipt, receipt.payload), false);
    assert.equal(reentered, true); assert.equal(env.source.snapshot(), before);
  } finally {await env.close();}
});

for (const cause of ['scope', 'dispose', 'scope-reentry', 'unavailable-getter']) {
  test('E1-10 invalidation prevents stale unavailable exclusion: ' + cause, async () => {
    const env = fixture();
    try {
      await finish(env); requireRestart(env.source); const before = env.source.snapshot();
      const gate = env.gate(); env.resolveWith(() => gate.promise);
      const pending = env.own(assert.rejects(env.source.prepareRestart(), isAbort));
      let reentered = false;
      const error = unavailable();
      if (cause === 'scope') env.live(false);
      else if (cause === 'dispose') env.source.dispose();
      else if (cause === 'scope-reentry') env.onScope(() => {reentered = true; env.source.isCurrent();});
      else Object.defineProperty(error, 'status', {get() {reentered = true; env.source.cancel(); return 404;}});
      gate.reject(error); await pending;
      if (cause.endsWith('reentry') || cause === 'unavailable-getter') assert.equal(reentered, true);
      assert.equal(env.source.snapshot(), before);
    } finally {await env.close();}
  });
}

test('E1-11 cancellation retires issued aliases and never undoes an accepted restart', async () => {
  const env = fixture();
  try {
    await finish(env); requireRestart(env.source); const before = env.source.snapshot();
    const controller = new AbortController();
    const receipt = await env.source.prepareRestart({signal: controller.signal}), alias = {...receipt.payload, coverPath: '/cover'};
    assert.equal(env.source.aliasBinding(receipt.payload, alias), true);
    controller.abort(); assert.equal(env.source.snapshot(), before);
    assert.equal(env.source.commit(receipt, alias), false); assert.equal(env.source.hasBinding(alias), true);
    const fresh = await env.source.prepareRestart(); assert.equal(env.source.commit(fresh, fresh.payload), true);
    const accepted = env.source.snapshot(); env.source.cancel(); assert.equal(env.source.snapshot(), accepted);
    assert.equal(accepted.currentId, A1); assert.equal(accepted.visitedEnd, 0);
  } finally {await env.close();}
});

test('E1-12 receipt payload identity and permitted cover alias remain exact on restart', async () => {
  const env = fixture();
  try {
    const old = await finish(env); requireRestart(env.source); const before = env.source.snapshot();
    const receipt = await env.source.prepareRestart();
    assert.equal(env.source.commit(receipt, old.payload), false);
    assert.equal(env.source.commit(receipt, {...receipt.payload}), false);
    assert.equal(env.source.commit({...receipt}, receipt.payload), false);
    const mutated = {...receipt.payload, coverPath: '/cover'};
    assert.equal(env.source.aliasBinding(receipt.payload, mutated), true);
    mutated.coverPath = 42; assert.equal(env.source.commit(receipt, mutated), false);
    assert.equal(env.source.snapshot(), before);
    const valid = {...receipt.payload, coverPath: '/fresh-cover'};
    assert.equal(env.source.aliasBinding(receipt.payload, valid), true);
    assert.equal(env.source.commit(receipt, valid), true); assert.equal(env.source.snapshot().currentId, A1);
  } finally {await env.close();}
});


test('E1-12 identical native payloads in distinct member occurrences cannot replace restart provenance', async () => {
  const input = capture();
  const firstAlbum = input.albums[0], secondAlbum = input.albums[1];
  secondAlbum.album_ref = firstAlbum.album_ref;
  secondAlbum.inventory_album_ref = firstAlbum.inventory_album_ref;
  secondAlbum.tracks = firstAlbum.tracks.map((track, index) => ({...track, queue_item_ref: id(B, 101 + index),
    source: {...track.source, item_ref: B, catalog_ref: secondAlbum.catalog_ref}}));
  const env = fixture({capture: input});
  try {
    const first = await accept(env);
    for (let count = 0; count < 5; count++) await accept(env, {direction: 1, automatic: false});
    assert.equal(env.source.snapshot().currentId, id(B, 103)); requireRestart(env.source);
    const receipt = await env.source.prepareRestart();
    assert.equal(receipt.occurrenceId, id(B, 101)); assert.deepEqual(receipt.payload, first.payload);
    assert.equal(env.calls.at(-1).payload.source.item_ref, B);
    assert.equal(env.source.aliasBinding(receipt.payload, first.payload), false);
    assert.equal(env.source.commit(receipt, first.payload), false);
    assert.equal(env.source.commit(receipt, receipt.payload), true);
  } finally {await env.close();}
});

// E1-P1: ordinary-source cases intentionally reach existing behavior before any new API.
for (const kind of ['normal', 'restart']) for (const action of ['cancel', 'dispose', 'replace']) {
  test('E1-P1 final legitimate alias descriptor reentry cannot commit: ' + kind + '/' + action, async () => {
    const env = fixture();
    try {
      await finish(env);
      if (kind === 'restart') requireRestart(env.source);
      const receipt = await (kind === 'restart' ? env.source.prepareRestart() : env.source.prepare());
      const before = env.source.snapshot();
      let armed = false, descriptorPasses = 0, reentered = false, successor;
      const alias = new Proxy({...receipt.payload, coverPath: '/legitimate-cover'}, {
        ownKeys(target) {
          if (armed && ++descriptorPasses === 2) {
            reentered = true;
            if (action === 'replace') {
              // Observe both outcomes immediately; no rejection may escape a failed assertion cleanup.
              successor = env.own(env.source.prepare().then(value => ({value}), error => ({error})));
            } else env.source[action]();
          }
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
      });
      assert.equal(env.source.aliasBinding(receipt.payload, alias), true);
      assert.equal(env.source.hasBinding(alias), true);
      armed = true; // Only after real private alias issuance; no fabricated receipt/binding.
      const accepted = env.source.commit(receipt, alias);
      const successorOutcome = successor ? await successor : null;
      assert.equal(reentered, true, 'Final actual descriptor trap must have run');
      assert.equal(descriptorPasses, 2);
      assert.equal(accepted, false, 'Retired request cannot commit after final alias validation');
      assert.equal(env.source.snapshot(), before);
      if (action === 'replace') {
        assert.ok(successorOutcome);
        if (successorOutcome.error) throw successorOutcome.error;
        assert.equal(env.source.isReceiptCurrent(successorOutcome.value), true);
        assert.equal(env.source.commit(successorOutcome.value, successorOutcome.value.payload), true);
      }
    } finally {await env.close();}
  });
}

for (const kind of ['normal', 'restart']) test('E1-P1 passive legitimate Proxy alias remains accepted: ' + kind, async () => {
  const env = fixture();
  try {
    await finish(env);
    if (kind === 'restart') requireRestart(env.source);
    const receipt = await (kind === 'restart' ? env.source.prepareRestart() : env.source.prepare());
    let descriptorPasses = 0;
    const alias = new Proxy({...receipt.payload, coverPath: '/legitimate-cover'}, {
      ownKeys(target) {descriptorPasses++; return Reflect.ownKeys(target);},
      getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
    });
    assert.equal(env.source.aliasBinding(receipt.payload, alias), true);
    descriptorPasses = 0;
    assert.equal(env.source.commit(receipt, alias), true);
    assert.equal(descriptorPasses, 2);
  } finally {await env.close();}
});

for (const kind of ['normal', 'restart']) test('E1-P1 final private ownership check never rereads caller signal getter: ' + kind, async () => {
  const env = fixture();
  try {
    await finish(env);
    if (kind === 'restart') requireRestart(env.source);
    const controller = new AbortController();
    let armed = false, descriptorPasses = 0, finalDescriptorReached = false, lateSignalReads = 0, signalReads = 0;
    // A real caller AbortSignal with only its observable getter instrumented.
    const signal = new Proxy(controller.signal, {get(target, key) {
      if (key === 'aborted') signalReads++;
      if (key === 'aborted' && finalDescriptorReached) {lateSignalReads++; env.source.cancel();}
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    const receipt = await (kind === 'restart' ? env.source.prepareRestart({signal}) : env.source.prepare({signal}));
    assert.ok(signalReads > 0, 'Real preparation exercised the instrumented caller signal');
    const alias = new Proxy({...receipt.payload, coverPath: '/legitimate-cover'}, {
      ownKeys(target) {
        if (armed && ++descriptorPasses === 2) finalDescriptorReached = true;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
    });
    assert.equal(env.source.aliasBinding(receipt.payload, alias), true);
    armed = true;
    const accepted = env.source.commit(receipt, alias);
    assert.equal(finalDescriptorReached, true);
    assert.equal(lateSignalReads, 0, 'Final private postcheck must not invoke caller-controlled signal getter');
    assert.equal(accepted, true);
  } finally {await env.close();}
});
