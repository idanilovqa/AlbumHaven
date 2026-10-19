'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-source-replay-fixture.cjs');
const {TOP, OTHER, ALBUM, ITEM, KEY, SCOPE, plain, detail, target, reply, deferred, atBoundary, fixture} = F;

test('the real native registry replays after UI disposal using a fresh Top and exact native resolver', async t => {
  const f = await fixture(t);
  assert.equal(await f.ui.open(), true); f.counts(0, 2, 1, 1);
  const first = f.presentations[0], descriptor = f.descriptor(), oldSignal = f.resolutions[0].options.signal;
  f.ui.details.dispose(); f.setShell({visible: false, active: false, topRef: OTHER, viewVersion: 8, viewRequestId: 20});
  assert.equal(oldSignal.aborted, true);
  assert.equal(first.owner.isCurrent(), true, 'A UI/action signal is not retained source authority');
  const signal = new AbortController().signal;
  assert.equal(await f.restore(descriptor, {signal}), true); f.counts(1, 3, 2, 2);
  assert.equal(f.nativeOwners.length, 1, 'One selection owner for the entire Top mount');
  assert.equal(f.reads[0].options.signal, signal); assert.equal(f.resolutions[2].options.signal, signal);
  assert.equal(f.hydrations[1].options.signal, signal);
  assert.deepEqual(f.resolutions[2].payload, {top_ref: TOP, revision: '7', item_ref: ITEM, album_ref: ALBUM,
    inventory_album_ref: 'inventory-album:2:11'});
  assert.equal(f.presentations[1].owner.token, first.owner.token, 'The existing native token is refreshed');
  assert.deepEqual(plain(f.presentations[1].restrictions), {can_view_artwork: true, can_play_album: false, can_open_album_page: true});
  assert.deepEqual(f.errors, []);
});

test('a replacement UI lease and stale lease disposal preserve native replay and never allocate a second owner', async t => {
  const f = await fixture(t); assert.equal(await f.ui.open(), true);
  const descriptor = f.descriptor(), second = f.mountUI();
  f.ui.details.dispose();
  assert.equal(await second.open(), true);
  second.details.dispose();
  assert.equal(await f.restore(descriptor), true); f.counts(1, 5, 3, 3);
  assert.equal(f.nativeOwners.length, 1);
});

test('replay reads the fresh inventory binding without changing the originally authorized native edition', async t => {
  const f = await fixture(t); assert.equal(await f.ui.open(), true); f.ui.details.dispose();
  const fresh = detail(); fresh.items[0].title = 'Fresh title'; fresh.items[0].native_album.inventory_album_ref = 'inventory-album:2:22';
  f.setBackend(fresh);
  assert.equal(await f.restore(), true);
  assert.equal(f.resolutions[2].payload.inventory_album_ref, 'inventory-album:2:22');
  assert.equal(f.hydrations[1].key, KEY); assert.equal(f.presentations[1].album.key, KEY);
});

const denials = [
  ['different Top', value => {value.top_ref = OTHER;}],
  ['different revision', value => {value.revision = '8';}],
  ['browse grant removed', value => {value.allowed_actions['library.browse.read'] = false;}],
  ['read grant removed', value => {value.allowed_actions.can_read = false;}],
  ['nonboolean read grant', value => {value.allowed_actions.can_read = 1;}],
  ['member removed', value => {value.items = [];}],
  ['wrong member', value => {value.items[0].item_ref = F.id(99);}],
  ['wrong canonical Album', value => {value.items[0].album_ref = F.id(99);}],
  ['duplicate exact member', value => {value.items.push(structuredClone(value.items[0]));}],
  ['remote member with a forged local hint', value => {value.items[0].source_kind = 'remote_summary';}],
  ['missing native hint', value => {delete value.items[0].native_album;}],
  ['native details grant removed', value => {value.items[0].native_album.allowed_actions.can_view_details = false;}],
  ['nonboolean native details grant', value => {value.items[0].native_album.allowed_actions.can_view_details = 1;}],
];
for (const [name, change] of denials) test(`fresh ${name} denies replay before native resolution or hydration`, async t => {
  const f = await fixture(t); assert.equal(await f.ui.open(), true); f.ui.details.dispose();
  const value = detail(); change(value); f.setBackend(value);
  await assert.rejects(f.restore(), {status: 403}); f.counts(1, 2, 1, 1);
});

test('fresh native resolution cannot silently switch editions', async t => {
  const f = await fixture(t, {resolve: (call, n) => reply(call.payload, n === 3 ? 'Artist/Other edition' : KEY)});
  assert.equal(await f.ui.open(), true); f.ui.details.dispose();
  await assert.rejects(f.restore(), {status: 403}); f.counts(1, 3, 1, 1);
});

for (const stage of ['read', 'resolve']) for (const status of [401, 403, 404, 409]) {
  test(`${stage} rejection ${status} is preserved without retries or cached hydration`, async t => {
    const failure = Object.assign(new Error('Original Top unavailable'), {status});
    const f = await fixture(t, stage === 'read' ? {readTop: () => {throw failure;}}
      : {resolve: (call, n) => {if (n === 3) throw failure; return reply(call.payload);}});
    assert.equal(await f.ui.open(), true); f.ui.details.dispose();
    await assert.rejects(f.restore(), error => error === failure);
    f.counts(1, stage === 'read' ? 2 : 3, 1, 1);
  });
}

const retirements = [
  ['mount disposal', f => f.sourceReplay.dispose()],
  ['local mutation invalidation', f => f.sourceReplay.invalidate()],
  ['different session scope', f => f.setShell({scopeKey: 'new-session'})],
  ['logout', f => f.setShell({authenticated: false})],
  ['library departure', f => f.setShell({inLibrary: false})],
  ['replay cancellation', (_f, abort) => abort.abort()],
];
for (const stage of ['read', 'resolve', 'hydrate']) for (const [name, retire] of retirements) {
  test(`${name} during ${stage} cannot present a stale native Album`, async t => {
    const gate = deferred(), entered = deferred(), abort = new AbortController();
    const options = stage === 'read' ? {readTop(call) {entered.resolve(call); return gate.promise;}}
      : stage === 'resolve' ? {resolve(call, n) {if (n === 3) {entered.resolve(call); return gate.promise;} return reply(call.payload);}}
        : {hydrate(call, n) {if (n === 2) {entered.resolve(call); return gate.promise;} return {key: KEY, tracks: []};}};
    const f = await fixture(t, options); assert.equal(await f.ui.open(), true); f.ui.details.dispose();
    const operation = f.restore(f.descriptor(), {signal: abort.signal}), observed = await atBoundary(entered, operation);
    const rejection = assert.rejects(operation);
    retire(f, abort);
    if (observed.options.isCurrent) assert.equal(observed.options.isCurrent(), false);
    gate.resolve(stage === 'read' ? detail() : stage === 'resolve' ? reply(observed.payload) : {key: KEY, tracks: []});
    await rejection;
    assert.equal(f.presentations.length, 1);
    assert.equal(f.reads.length, 1); assert.equal(f.resolutions.length, stage === 'read' ? 2 : 3);
    assert.equal(f.hydrations.length, stage === 'hydrate' ? 2 : 1);
  });
}

for (const [name, retire] of [['disposed mount', f => f.sourceReplay.dispose()],
  ['logout', f => f.setShell({authenticated: false})], ['different session', f => f.setShell({scopeKey: 'new-session'})],
  ['outside library', f => f.setShell({inLibrary: false})]]) {
  test(`${name} cannot begin a fresh replay read`, async t => {
    const f = await fixture(t); assert.equal(await f.ui.open(), true); f.ui.details.dispose(); retire(f);
    await assert.rejects(f.restore(), {name: 'AbortError'}); f.counts(0, 2, 1, 1);
  });
}

test('an already aborted replay signal cannot begin a fresh read', async t => {
  const f = await fixture(t); assert.equal(await f.ui.open(), true); const abort = new AbortController(); abort.abort();
  await assert.rejects(f.restore(f.descriptor(), {signal: abort.signal}), {name: 'AbortError'}); f.counts(0, 2, 1, 1);
});

test('an observed old-session receipt never revives when the old shell snapshot returns', async t => {
  const f = await fixture(t); assert.equal(await f.ui.open(), true);
  const owner = f.presentations[0].owner;
  f.setShell({scopeKey: 'new-session'}); assert.equal(owner.isCurrent(), false);
  f.setShell({scopeKey: SCOPE}); assert.equal(owner.isCurrent(), false);
});

test('returning to the library needs a fresh native replay rather than reviving the old receipt', async t => {
  const f = await fixture(t); assert.equal(await f.ui.open(), true); const descriptor = f.descriptor();
  const retained = f.presentations[0].owner; f.ui.details.dispose();
  f.setShell({inLibrary: false}); assert.equal(retained.isCurrent(), false);
  f.setShell({inLibrary: true}); assert.equal(retained.isCurrent(), false);
  assert.equal(await f.restore(descriptor), true); f.counts(1, 3, 2, 2);
  assert.equal(f.presentations[1].owner.isCurrent(), true);
});

for (const [name, change] of denials.filter(([name]) => name !== 'different Top')) {
  test(`observing ${name} retires the detached receipt even after its UI is gone`, async t => {
    const f = await fixture(t); assert.equal(await f.ui.open(), true); f.ui.details.dispose();
    const owner = f.presentations[0].owner, changed = detail(); change(changed);
    f.sourceReplay.observeDetail(changed); assert.equal(owner.isCurrent(), false);
    f.sourceReplay.observeDetail(detail()); assert.equal(owner.isCurrent(), false);
    f.counts(0, 2, 1, 1);
  });
}
test('observing a changed inventory binding retires the detached receipt', async t => {
  const f = await fixture(t); assert.equal(await f.ui.open(), true); f.ui.details.dispose();
  const changed = detail(); changed.items[0].native_album.inventory_album_ref = 'inventory-album:2:99';
  f.sourceReplay.observeDetail(changed); assert.equal(f.presentations[0].owner.isCurrent(), false);
});
test('identical and display-only refreshes or unrelated Tops preserve the detached receipt', async t => {
  const f = await fixture(t); assert.equal(await f.ui.open(), true); f.ui.details.dispose();
  const owner = f.presentations[0].owner, refreshed = detail(); refreshed.items[0].title = 'Fresh display'; refreshed.items[0].position = 5;
  for (const value of [detail(), refreshed, detail({top_ref: OTHER, revision: '8', items: []})]) {
    f.sourceReplay.observeDetail(value); assert.equal(owner.isCurrent(), true);
  }
});

for (const stage of ['read', 'resolve']) test(`observed source replacement during pending ${stage} retires that replay`, async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, stage === 'read' ? {readTop(call) {entered.resolve(call); return gate.promise;}}
    : {resolve(call, n) {if (n === 3) {entered.resolve(call); return gate.promise;} return reply(call.payload);}});
  assert.equal(await f.ui.open(), true); f.ui.details.dispose();
  const operation = f.restore(), observed = await atBoundary(entered, operation), rejection = assert.rejects(operation);
  f.sourceReplay.observeDetail(detail({revision: '8'}));
  gate.resolve(stage === 'read' ? detail() : reply(observed.payload));
  await rejection; assert.equal(f.presentations.length, 1); assert.equal(f.hydrations.length, 1);
});

test('a newer replay supersedes a pending older read and only the newer native result opens', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, {readTop(call, n) {if (n === 1) {entered.resolve(call); return gate.promise;} return detail();}});
  assert.equal(await f.ui.open(), true); f.ui.details.dispose(); const descriptor = f.descriptor();
  const old = f.restore(descriptor); await atBoundary(entered, old); const rejection = assert.rejects(old, {name: 'AbortError'});
  assert.equal(await f.restore(descriptor), true); gate.resolve(detail()); await rejection;
  f.counts(2, 3, 2, 2);
});

test('the native pending load token fences replay even when its Top response remains current', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, {hydrate(call, n) {if (n === 2) {entered.resolve(call); return gate.promise;} return {key: KEY};}});
  assert.equal(await f.ui.open(), true); f.ui.details.dispose();
  const operation = f.restore(); await atBoundary(entered, operation);
  const rejection = assert.rejects(operation, {name: 'AbortError', sourcePageSuperseded: true});
  f.context.invalidatePendingTrackModalLoad(); gate.resolve({key: KEY}); await rejection;
  f.counts(1, 3, 2, 1);
});

test('a native history presenter cannot authorize an old replay after a newer native source is retained', async t => {
  const f = await fixture(t); assert.equal(await f.ui.open(), true); const descriptor = f.descriptor();
  assert.equal(await f.restore(descriptor, {async present(open) {
    assert.equal(await f.ui.open(), true); assert.equal(open(), false); return true;
  }}), false);
  f.counts(1, 5, 3, 2);
});

test('opaque token tampering, a mismatched Album key and registry eviction cannot bypass fresh authority', async t => {
  const f = await fixture(t); assert.equal(await f.ui.open(), true); const original = f.descriptor();
  assert.equal(await f.restore({...original, sourcePageToken: 'missing-token'}), false);
  assert.equal(await f.restore({...original, albumKey: 'Artist/Other edition'}), false); f.counts(0, 2, 1, 1);
  for (let n = 0; n < 20; n++) assert.equal(await f.ui.open(), true);
  assert.equal(f.nativeOwners.length, 1); const newest = f.descriptor(); f.ui.details.dispose();
  assert.equal(await f.restore(original), false); assert.equal(f.reads.length, 0);
  assert.equal(await f.restore(newest), true); f.counts(1, 43, 22, 22);
});

test('adapter UI callback replacement is fenced synchronously and obsolete lease calls are rejected', async t => {
  const f = await fixture(t), selection = target(), context = {scopeKey: SCOPE, origin: F.origin(), signal: new AbortController().signal};
  const binding = {top_ref: TOP, revision: '7', item_ref: ITEM, album_ref: ALBUM, inventory_album_ref: 'inventory-album:2:11'};
  const callbacks = {sourceResource: () => selection, authorizeResource: async () => {}, readSourceBinding: () => binding};
  let replacement;
  const old = f.sourceReplay.createSelection({...callbacks, sourceResource() {
    replacement ||= f.sourceReplay.createSelection(callbacks); return selection;
  }});
  const hooks = f.nativeOwners[0].hooks;
  assert.equal(hooks.sourceResource(selection, context), null);
  await assert.rejects(old.resourceIntent('open', selection, context), {name: 'AbortError'});
  old.dispose(); assert.equal(hooks.sourceResource(selection, context), selection);
  replacement.dispose(); assert.equal(hooks.sourceResource(selection, context), null);
  f.counts(0, 0, 0, 0);
});

test('a replacement UI lease fences authorization already waiting inside the old details owner', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, {resolve(call, n) {if (n === 2) {entered.resolve(call); return gate.promise;} return reply(call.payload);}});
  const operation = f.ui.open(), observed = await atBoundary(entered, operation), next = f.mountUI();
  gate.resolve(reply(observed.payload)); assert.equal(await operation, false);
  assert.equal(await next.open(), true); f.ui.details.dispose();
  assert.equal(f.presentations[0].owner.isCurrent(), true); assert.deepEqual(f.errors, []);
  f.counts(0, 4, 1, 1); assert.equal(f.nativeOwners.length, 1);
});

for (const [name, selection, origin] of [
  ['empty explicit origin', target(), ''],
  ['origin with extra fields', target(), {...F.origin(), inventory_album_ref: 'private-hint'}],
  ['wrong source member', target(), {...F.origin(), item_ref: F.id(99)}],
  ['playable target', {...target(), native_actions: {album_ref: KEY, allowed_actions: {can_open_album: true, can_play_album: true}}}, F.origin()],
]) test(`adapter rejects ${name} before any replay read`, async t => {
  const f = await fixture(t);
  await assert.rejects(f.nativeOwners[0].hooks.revalidateResource(selection,
    {scopeKey: SCOPE, origin}, {signal: new AbortController().signal}), {status: 403});
  f.counts(0, 0, 0, 0);
});

test('root disposal during a synchronous binding callback cannot retain native authority', async t => {
  const f = await fixture(t), selection = target(), context = {scopeKey: SCOPE, origin: F.origin(), signal: new AbortController().signal};
  f.sourceReplay.createSelection({sourceResource: () => selection, authorizeResource: async () => {}, readSourceBinding() {
    f.sourceReplay.dispose(); return {top_ref: TOP, revision: '7', item_ref: ITEM, album_ref: ALBUM, inventory_album_ref: 'inventory-album:2:11'};
  }});
  assert.equal(f.nativeOwners[0].hooks.retainResource(selection, context), null);
  assert.throws(() => f.sourceReplay.createSelection({}), {name: 'AbortError'});
  f.counts(0, 0, 0, 0);
});

for (const stage of ['read', 'resolve', 'hydrate']) {
  test(`a newly admitted UI open retires older replay at ${stage} before its first resolver completes`, async t => {
    const replayGate = deferred(), replayEntered = deferred(), nextGate = deferred(), nextEntered = deferred();
    let nextInitial = false;
    const f = await fixture(t, {
      readTop(call) {
        if (stage === 'read') {replayEntered.resolve(call); return replayGate.promise;}
        return detail();
      },
      resolve(call, n) {
        if (nextInitial) {nextInitial = false; nextEntered.resolve(call); return nextGate.promise;}
        if (stage === 'resolve' && n === 3) {replayEntered.resolve(call); return replayGate.promise;}
        return reply(call.payload);
      },
      hydrate(call, n) {
        if (stage === 'hydrate' && n === 2) {replayEntered.resolve(call); return replayGate.promise;}
        return {key: KEY, tracks: []};
      },
    });
    assert.equal(await f.ui.open(), true); const descriptor = f.descriptor();
    const replay = f.restore(descriptor), old = await atBoundary(replayEntered, replay);
    const rejected = assert.rejects(replay);
    nextInitial = true;
    const next = f.ui.open(), fresh = await atBoundary(nextEntered, next);
    assert.equal(fresh.options.signal.aborted, false); assert.equal(f.presentations.length, 1);
    // The newer action is still waiting at its first resolver. It has neither
    // hydrated nor retained a replacement source owner when the old reply lands.
    replayGate.resolve(stage === 'read' ? detail() : stage === 'resolve' ? reply(old.payload) : {key: KEY, tracks: []});
    await rejected;
    assert.equal(f.presentations.length, 1, 'Older replay must not present while the newer valid action is pending');
    if (stage !== 'read') assert.equal(old.options.isCurrent(), false);
    assert.equal(fresh.options.isCurrent(), true);
    nextGate.resolve(reply(fresh.payload)); assert.equal(await next, true);
    f.counts(1, stage === 'read' ? 4 : 5, stage === 'hydrate' ? 3 : 2, 2);
    assert.deepEqual(f.errors, []); assert.equal(f.nativeOwners.length, 1);
  });
}

test('beginIntent rejects a stale UI lease without retiring the current retained receipt', async t => {
  const f = await fixture(t); assert.equal(await f.ui.open(), true);
  const retained = f.presentations[0].owner, selection = target();
  const binding = {top_ref: TOP, revision: '7', item_ref: ITEM, album_ref: ALBUM, inventory_album_ref: 'inventory-album:2:11'};
  const callbacks = {sourceResource: () => selection, authorizeResource: async () => {}, readSourceBinding: () => binding};
  const old = f.sourceReplay.createSelection(callbacks), current = f.sourceReplay.createSelection(callbacks);
  assert.throws(() => old.beginIntent(), {name: 'AbortError'});
  assert.equal(retained.isCurrent(), true, 'A replaced lease cannot invalidate the current mount authority');
  old.dispose(); assert.equal(retained.isCurrent(), true);
  current.beginIntent(); assert.equal(retained.isCurrent(), false);
  current.dispose(); assert.throws(() => current.beginIntent(), {name: 'AbortError'});
  f.counts(0, 2, 1, 1); assert.equal(f.nativeOwners.length, 1);
});

test('a newer native replay retires an older UI open still waiting at its first resolver', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, {resolve(call, n) {
    if (n === 3) {entered.resolve(call); return gate.promise;}
    return reply(call.payload);
  }});
  assert.equal(await f.ui.open(), true); const descriptor = f.descriptor();
  const old = f.ui.open(), pending = await atBoundary(entered, old);
  assert.equal(pending.options.signal.aborted, false);
  assert.equal(pending.options.isCurrent(), true);
  f.counts(0, 3, 1, 1);

  assert.equal(await f.restore(descriptor), true);
  const newest = f.presentations[1].owner;
  assert.equal(newest.isCurrent(), true);
  assert.equal(pending.options.signal.aborted, false, 'Replay retirement must not depend on aborting the older UI signal');
  f.counts(1, 4, 2, 2);
  // Do not poll the old currentness callback after replay until its delayed
  // response has returned. The details owner must reject that response itself.
  gate.resolve(reply(pending.payload));
  assert.equal(await old, false, 'The older UI result must not overwrite the newer native replay');
  f.counts(1, 4, 2, 2);
  assert.equal(pending.options.isCurrent(), false);
  assert.equal(newest.isCurrent(), true, 'Rejecting the old response must preserve the newer replay receipt');
  assert.deepEqual(f.errors, []); assert.equal(f.nativeOwners.length, 1);
});
