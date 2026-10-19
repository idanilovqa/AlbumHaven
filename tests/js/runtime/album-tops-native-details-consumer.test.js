// Additive source-only coverage. Root owns execution in a complete composition.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./album-tops-native-details-fixtures.cjs');
const {F, KEY, OTHER_KEY, plain, isAbort, localRow, remoteRow, origin, reply} = H;
let createAlbumTopDetails, native;
test.before(async () => {
  ({createAlbumTopDetails} = await F.load('album-tops/details.mjs'));
  const window = {};
  vm.runInNewContext(fs.readFileSync(F.source('runtime/resource-selection.js'), 'utf8'), {window});
  native = window.AlbumHavenResourceSelection;
  assert.deepEqual(plain(native.projectOrigin(origin(localRow()))), origin(localRow()),
    'The accepted Top-origin prerequisite must be composed before this suite runs');
});
const fixture = (t, options) => H.fixture(t, createAlbumTopDetails, native, options);

test('action-time resolution enters the existing native owner with exact canonical identity and no playback', async t => {
  const env = fixture(t); env.counts(0, 0, 0);
  assert.equal(await env.details.open(env.rows[0]), true); env.counts(2, 1, 1);
  const {target, raw, context} = env.selection();
  assert.equal(raw.ref, F.A); assert.notEqual(raw.ref, KEY); assert.equal(raw.native_actions.album_ref, KEY);
  assert.deepEqual(raw.allowed_actions, {can_view_details: true});
  assert.deepEqual(raw.native_actions.allowed_actions, {can_open_album: true, can_play_album: false});
  assert.deepEqual(raw.origin, origin(env.rows[0])); assert.equal(Object.isFrozen(raw.origin), true);
  assert.deepEqual(Object.keys(raw.origin), ['source', 'top_ref', 'item_ref', 'revision']);
  assert.equal(context.origin, raw.origin);
  assert.equal(env.calls[0].options.signal, context.signal); assert.equal(env.calls[1].options.signal, context.signal);
  assert.equal(env.hooks.sourceResource(target, context), raw);
  assert.deepEqual(env.errors, []);
});

test('every authorization and history replay resolves again with the exact native callback signal contract', async t => {
  const env = fixture(t); assert.equal(await env.details.open(env.rows[0]), true);
  const request = env.selection(), extra = new AbortController(), replay = new AbortController();
  await env.authorize(); await env.authorize(extra.signal);
  const receipt = await env.replay(replay.signal);
  env.counts(5, 1, 1);
  assert.equal(env.calls[2].options.signal, request.context.signal);
  assert.equal(env.calls[3].options.signal, extra.signal); assert.equal(env.calls[4].options.signal, replay.signal);
  assert.deepEqual(receipt.target, request.raw); assert.notEqual(receipt.target, request.raw);
  assert.equal(receipt.isCurrent(), true); assert.equal(env.calls[4].options.isCurrent(), true);
  assert.equal(native.projectTarget(receipt.target).native_actions.allowed_actions.can_play_album, false);
  replay.abort();
  assert.equal(receipt.isCurrent(), false); assert.equal(env.calls[4].options.isCurrent(), false);
  assert.equal(env.calls[0].options.isCurrent(), true, 'Aborting a replay does not abort the original open');
});

const unavailable = [
  ['remote summary', () => remoteRow()], ['absent hint', () => {const row = localRow(); delete row.native_album; return row;}],
  ['null hint', () => localRow({native_album: null})],
  ['denied hint', () => localRow({native_album: {...localRow().native_album, allowed_actions: {can_view_details: false}}})],
  ['nonboolean hint', () => localRow({native_album: {...localRow().native_album, allowed_actions: {can_view_details: 1}}})],
  ['remote row with a forged local hint', () => ({...remoteRow(), native_album: localRow().native_album})],
];
for (const [name, row] of unavailable) test(name + ' never resolves or enters native selection', async t => {
  const env = fixture(t, {rows: [row()]});
  assert.equal(await env.details.open(env.rows[0]), false); env.counts(0, 0, 0); assert.deepEqual(env.errors, []);
});
test('an equal-looking row outside the exact current detail is not source authority', async t => {
  const env = fixture(t);
  assert.equal(await env.details.open(structuredClone(env.rows[0])), false);
  env.counts(0, 0, 0); assert.deepEqual(env.errors, []);
});

const retirements = [
  ['controller scope', env => env.setState({scopeKey: JSON.stringify(['1', '3', 'a'.repeat(64), 4])})],
  ['detail replacement', env => env.setState({detail: {status: 'ready', data: structuredClone(env.detail)}})],
  ['detail loading', env => env.setState({detail: {...env.state().detail, status: 'loading'}})],
  ['detail denial', env => env.setState({detail: {status: 'denied', data: null}})],
  ['directory denial', env => env.setState({directory: {status: 'denied', data: null}})],
  ['retained detail refresh', env => env.setState({detail: {...env.state().detail, refreshing: true}})],
  ['selected Top', env => env.setState({selectedTopRef: F.OTHER})],
  ['provider replacement', env => env.replaceProvider()],
  ['equal-looking owner replacement', env => env.setOwner(Object.freeze({...env.owner}))],
  ['missing owner', env => env.setOwner(null)],
  ['runtime scope', env => env.setShell({scopeKey: JSON.stringify(['1', '2', 'b'.repeat(64), 5])})],
  ['logout', env => env.setShell({authenticated: false})], ['hidden view', env => env.setShell({visible: false})],
  ['runtime Top', env => env.setShell({topRef: F.OTHER})],
  ['view version', env => env.setShell({viewVersion: env.shell().viewVersion + 1})],
  ['view request', env => env.setShell({viewRequestId: env.shell().viewRequestId + 1})],
  ['mutation loading', env => env.setState({mutation: {status: 'loading'}})],
  ['mutation uncertain', env => env.setState({mutation: {status: 'uncertain'}})],
  ['mutation refresh', env => env.setState({mutation: {status: 'idle', refreshing: true}})],
  ['explicit retirement', env => env.details.retire()], ['disposal', env => env.details.dispose()],
];
for (const [name, retire] of retirements) for (const phase of ['resolve', 'authorize', 'replay']) {
  test(name + ' fences pending ' + phase + ' and suppresses stale errors', async t => {
    const pending = F.deferred(), entered = F.deferred(), stopAt = {resolve: 1, authorize: 2, replay: 3}[phase];
    const env = fixture(t, {resolve: (call, number) => {
      if (number === stopAt) {entered.resolve(call); return pending.promise;}
      return reply(call.row);
    }});
    let operation;
    const replay = new AbortController();
    if (phase === 'replay') {
      assert.equal(await env.details.open(env.rows[0]), true);
      operation = env.replay(replay.signal);
    } else operation = env.details.open(env.rows[0]);
    const observed = await H.atBoundary(entered, operation), savedState = env.state(), savedShell = env.shell(), savedOwner = env.owner;
    retire(env);
    assert.equal(observed.options.isCurrent(), false); assert.equal(observed.options.isCurrent(), false);
    env.setState(savedState); env.setShell(savedShell); env.setOwner(savedOwner);
    assert.equal(observed.options.isCurrent(), false, 'An observed retirement cannot revive when old state returns');
    if (env.intents.length) {
      const {target, context} = env.selection(); assert.equal(env.hooks.sourceResource(target, context), null);
    }
    const result = phase === 'replay' ? assert.rejects(operation, isAbort) : operation;
    pending.resolve(reply(observed.row));
    if (phase === 'replay') await result; else assert.equal(await result, false);
    env.counts(stopAt, phase === 'resolve' ? 0 : 1, phase === 'replay' ? 1 : 0);
    assert.deepEqual(env.errors, []);
  });
}

for (const [name, retire] of retirements.filter(([name]) =>
  !['view version', 'view request', 'explicit retirement', 'provider replacement', 'equal-looking owner replacement'].includes(name))) {
  test(name + ' rejects an initial action before resolution', async t => {
    const env = fixture(t); retire(env);
    assert.equal(await env.details.open(env.rows[0]), false); env.counts(0, 0, 0); assert.deepEqual(env.errors, []);
  });
}

for (const [name, replace] of retirements.filter(([name]) =>
  ['view version', 'view request', 'explicit retirement', 'provider replacement', 'equal-looking owner replacement'].includes(name))) {
  test('a new action captures the new valid ' + name, async t => {
    const env = fixture(t); replace(env);
    assert.equal(await env.details.open(env.rows[0]), true); env.counts(2, 1, 1); assert.deepEqual(env.errors, []);
  });
}

test('a retired owner cannot revive callbacks, authorize or replay after the same owner becomes readable again', async t => {
  const env = fixture(t); assert.equal(await env.details.open(env.rows[0]), true);
  const {target, context} = env.selection(), callbacks = env.calls.map(call => call.options.isCurrent);
  env.setOwner(null); env.details.retire(); env.setOwner(env.initialOwner);
  assert.equal(context.signal.aborted, true); assert.equal(env.hooks.sourceResource(target, context), null);
  for (const current of callbacks) assert.equal(current(), false);
  await assert.rejects(env.authorize(), isAbort); await assert.rejects(env.replay(new AbortController().signal), isAbort);
  env.counts(2, 1, 1); assert.deepEqual(env.errors, []);
});

test('context origin can carry the exact source when the native selection omits its optional origin', async t => {
  const env = fixture(t); assert.equal(await env.details.open(env.rows[0]), true);
  const {target, raw, context} = env.selection(), selection = {...target}; delete selection.origin;
  assert.equal(env.hooks.sourceResource(selection, context), raw);
  await env.hooks.authorizeResource(selection, context, 'open');
  env.counts(3, 1, 1); assert.deepEqual(env.errors, []);
});

test('the consumer final fence rejects a stale provider result even if the provider never polls its callback', async t => {
  const pending = F.deferred(), env = fixture(t, {resolve: () => pending.promise});
  const operation = env.details.open(env.rows[0]);
  env.setState({detail: {...env.state().detail, refreshing: true}});
  pending.resolve(reply(env.rows[0]));
  assert.equal(await operation, false); env.counts(1, 0, 0); assert.deepEqual(env.errors, []);
});

test('native completion cannot report a successful open after the source view retires synchronously', async t => {
  const env = fixture(t); env.onPresentation(() => env.setShell({visible: false}));
  assert.equal(await env.details.open(env.rows[0]), false);
  env.counts(2, 1, 1); assert.deepEqual(env.errors, []);
  const {target, context} = env.selection(); assert.equal(env.hooks.sourceResource(target, context), null);
});

const tupleChanges = [
  ['Top', env => {env.detail.top_ref = F.OTHER;}], ['revision', env => {env.detail.revision = '8';}],
  ['item', env => {env.rows[0].item_ref = F.IB;}], ['catalog album', env => {env.rows[0].album_ref = F.B;}],
  ['inventory binding', env => {env.rows[0].native_album.inventory_album_ref = 'inventory-album:2:12';}],
  ['membership removal', env => {env.detail.items = [];}],
  ['remote conversion', env => {env.rows[0].source_kind = 'remote_summary';}],
  ['hint removal', env => {env.rows[0].native_album = null;}],
  ['detail grant removal', env => {env.rows[0].native_album.allowed_actions.can_view_details = false;}],
];
for (const [name, change] of tupleChanges) test('in-place ' + name + ' change permanently retires the captured source tuple', async t => {
  const pending = F.deferred(), env = fixture(t, {resolve: () => pending.promise});
  const row = env.rows[0], initialRow = structuredClone(row), initialItems = env.detail.items;
  const expected = reply(row), operation = env.details.open(row), observed = env.calls[0];
  change(env);
  assert.deepEqual(observed.payload, H.source(initialRow), 'The pending request keeps its original exact tuple');
  assert.equal(observed.options.isCurrent(), false);
  env.detail.top_ref = F.TOP; env.detail.revision = '7'; env.detail.items = initialItems;
  for (const key of Object.keys(row)) delete row[key]; Object.assign(row, initialRow);
  assert.equal(observed.options.isCurrent(), false, 'Restoring the source tuple cannot revive this request');
  pending.resolve(expected); assert.equal(await operation, false);
  env.counts(1, 0, 0); assert.deepEqual(env.errors, []);
});

test('display-only changes preserve the exact retained source and its replay authority', async t => {
  const env = fixture(t); assert.equal(await env.details.open(env.rows[0]), true);
  env.rows[0].title = 'Updated display title'; env.rows[0].artist = 'Updated display artist';
  env.rows[0].position = 2; env.rows[0].native_album.artwork_url = null;
  const {target, raw, context} = env.selection(); assert.equal(env.hooks.sourceResource(target, context), raw);
  const receipt = await env.replay(new AbortController().signal);
  assert.equal(receipt.isCurrent(), true); assert.deepEqual(receipt.target, raw);
  env.counts(3, 1, 1); assert.deepEqual(env.errors, []);
});

for (const phase of ['authorize', 'replay']) test('a changed native target rejects ' + phase + ' rather than swapping editions', async t => {
  const env = fixture(t, {resolve: (call, number) => reply(call.row, number === (phase === 'authorize' ? 2 : 3) ? OTHER_KEY : KEY)});
  if (phase === 'authorize') {assert.equal(await env.details.open(env.rows[0]), false); env.counts(2, 1, 0);}
  else {
    assert.equal(await env.details.open(env.rows[0]), true);
    await assert.rejects(env.replay(new AbortController().signal), isAbort); env.counts(3, 1, 1);
  }
  const request = env.selection();
  assert.equal(env.hooks.sourceResource(request.target, request.context), null, 'A changed edition permanently retires its source');
  await assert.rejects(env.authorize(), isAbort);
  env.counts(phase === 'authorize' ? 2 : 3, 1, phase === 'authorize' ? 0 : 1);
  assert.deepEqual(env.errors, []);
});

const mismatches = [
  ['kind', request => {request.target = {...request.target, kind: 'artist'};}],
  ['catalog ref', request => {request.target = {...request.target, ref: F.B};}],
  ['scope', request => {request.context = {...request.context, scopeKey: 'wrong-scope'};}],
  ['context Top', request => {request.context = {...request.context, origin: {...request.context.origin, top_ref: F.OTHER}};}],
  ['context member', request => {request.context = {...request.context, origin: {...request.context.origin, item_ref: F.IB}};}],
  ['context revision', request => {request.context = {...request.context, origin: {...request.context.origin, revision: '8'}};}],
  ['context extras', request => {request.context = {...request.context, origin: {...request.context.origin, inventory_album_ref: 'inventory-album:2:11'}};}],
  ['selection origin', request => {request.target = {...request.target, origin: {...request.target.origin, item_ref: F.IB}};}],
];
for (const [name, change] of mismatches) test('callback rejects mismatched ' + name + ' without another resolution', async t => {
  const env = fixture(t); assert.equal(await env.details.open(env.rows[0]), true);
  const request = {...env.selection()}; change(request);
  assert.equal(env.hooks.sourceResource(request.target, request.context), null);
  await assert.rejects(env.hooks.authorizeResource(request.target, request.context, 'open'), isAbort);
  await assert.rejects(env.hooks.revalidateResource(request.target, {...request.context, signal: undefined},
    {signal: new AbortController().signal}), isAbort);
  env.counts(2, 1, 1); assert.deepEqual(env.errors, []);
});

for (const phase of ['resolve', 'authorize', 'replay']) for (const status of [401, 403, 404, 409]) {
  test('current ' + phase + ' preserves denial ' + status + ' without retry or presentation', async t => {
    const denyAt = {resolve: 1, authorize: 2, replay: 3}[phase];
    const denial = Object.assign(new Error('Saved Top source is denied'), {status, responseRejected: true});
    const env = fixture(t, {resolve: (call, number) => {if (number === denyAt) throw denial; return reply(call.row);}});
    if (phase === 'replay') {
      assert.equal(await env.details.open(env.rows[0]), true);
      await assert.rejects(env.replay(new AbortController().signal), error => error === denial);
      env.counts(3, 1, 1); assert.deepEqual(env.errors, []);
    } else {
      assert.equal(await env.details.open(env.rows[0]), false);
      env.counts(denyAt, phase === 'resolve' ? 0 : 1, 0); assert.deepEqual(env.errors, [denial]);
    }
  });
}

for (const phase of ['resolve', 'authorize']) test('retirement suppresses an old ' + phase + ' rejection', async t => {
  const pending = F.deferred(), entered = F.deferred(), stopAt = phase === 'resolve' ? 1 : 2;
  const env = fixture(t, {resolve: (call, number) => {if (number === stopAt) {entered.resolve(call); return pending.promise;} return reply(call.row);}});
  const result = env.details.open(env.rows[0]); await H.atBoundary(entered, result); env.details.retire();
  pending.reject(Object.assign(new Error('Old forbidden response'), {status: 403, responseRejected: true}));
  assert.equal(await result, false); env.counts(stopAt, phase === 'resolve' ? 0 : 1, 0); assert.deepEqual(env.errors, []);
});

test('a newer row open supersedes pending resolution, aborts its signal and is the sole presentation', async t => {
  const rows = [localRow(), localRow({item_ref: F.IB, album_ref: F.B, native_album: {
    inventory_album_ref: 'inventory-album:2:12', artwork_url: null, allowed_actions: {can_view_details: true}}})];
  const pending = F.deferred();
  const env = fixture(t, {rows, resolve: (call, number) => number === 1 ? pending.promise : reply(call.row, OTHER_KEY)});
  const first = env.details.open(rows[0]), old = env.calls[0];
  assert.equal(await env.details.open(rows[1]), true);
  assert.equal(old.options.signal.aborted, true); assert.equal(old.options.isCurrent(), false);
  pending.resolve(reply(rows[0])); assert.equal(await first, false);
  env.counts(3, 1, 1); assert.equal(env.selection().target.ref, F.B); assert.deepEqual(env.errors, []);
});

for (const phase of ['authorize', 'replay']) test('a repeated same-row action supersedes pending ' + phase + ' without reviving its callback', async t => {
  const pending = F.deferred(), entered = F.deferred(), stopAt = phase === 'authorize' ? 2 : 3;
  const env = fixture(t, {resolve: (call, number) => {if (number === stopAt) {entered.resolve(call); return pending.promise;} return reply(call.row);}});
  let operation;
  if (phase === 'replay') {
    assert.equal(await env.details.open(env.rows[0]), true);
    operation = env.replay(new AbortController().signal);
  } else operation = env.details.open(env.rows[0]);
  const observed = await H.atBoundary(entered, operation);
  assert.equal(await env.details.open(env.rows[0]), true);
  assert.equal(observed.options.isCurrent(), false); assert.equal(env.intents[0].context.signal.aborted, true);
  const result = phase === 'replay' ? assert.rejects(operation, isAbort) : operation;
  pending.resolve(reply(observed.row));
  if (phase === 'replay') await result; else assert.equal(await result, false);
  assert.equal(observed.options.isCurrent(), false);
  env.counts(stopAt + 2, 2, phase === 'replay' ? 2 : 1); assert.deepEqual(env.errors, []);
});

test('a new invalid action retires the previous valid selection without using its cached target', async t => {
  const rows = [localRow(), remoteRow()], env = fixture(t, {rows});
  assert.equal(await env.details.open(rows[0]), true); const old = env.selection();
  assert.equal(await env.details.open(rows[1]), false);
  assert.equal(old.context.signal.aborted, true); assert.equal(env.hooks.sourceResource(old.target, old.context), null);
  await assert.rejects(env.authorize(), isAbort); env.counts(2, 1, 1);
});

for (const phase of ['authorize', 'replay']) test('already aborted ' + phase + ' signal is rejected before provider I/O', async t => {
  const env = fixture(t); assert.equal(await env.details.open(env.rows[0]), true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(phase === 'authorize' ? env.authorize(controller.signal) : env.replay(controller.signal), isAbort);
  env.counts(2, 1, 1); assert.deepEqual(env.errors, []);
});

for (const phase of ['authorize', 'replay']) test('aborting pending ' + phase + ' invalidates its exact provider callback', async t => {
  const pending = F.deferred(), entered = F.deferred(), controller = new AbortController();
  const env = fixture(t, {resolve: (call, number) => {if (number === 3) {entered.resolve(call); return pending.promise;} return reply(call.row);}});
  assert.equal(await env.details.open(env.rows[0]), true);
  const operation = phase === 'authorize' ? env.authorize(controller.signal) : env.replay(controller.signal);
  const observed = await H.atBoundary(entered, operation); assert.equal(observed.options.signal, controller.signal);
  controller.abort(); assert.equal(observed.options.isCurrent(), false);
  const rejection = assert.rejects(operation, isAbort); pending.resolve(reply(observed.row)); await rejection;
  env.counts(3, 1, 1); assert.deepEqual(env.errors, []);
});

for (const reader of ['controller', 'runtime']) test(reader + ' snapshot callback cannot retire the owner while allowing resolution', async t => {
  const env = fixture(t), retire = () => env.setOwner(null);
  if (reader === 'controller') env.onControllerRead(retire); else env.onSnapshot(retire);
  assert.equal(await env.details.open(env.rows[0]), false); env.counts(0, 0, 0); assert.deepEqual(env.errors, []);
});

test('disposal is idempotent, invalidates native leases and prevents later actions', async t => {
  const env = fixture(t); assert.equal(await env.details.open(env.rows[0]), true);
  const before = env.invalidations, {target, context} = env.selection();
  env.details.dispose(); assert.equal(env.invalidations, before + 1); env.details.dispose();
  assert.equal(env.invalidations, before + 1); assert.equal(context.signal.aborted, true);
  assert.equal(env.hooks.sourceResource(target, context), null);
  assert.equal(await env.details.open(env.rows[0]), false); env.counts(2, 1, 1);
  assert.deepEqual(env.errors, []);
});
