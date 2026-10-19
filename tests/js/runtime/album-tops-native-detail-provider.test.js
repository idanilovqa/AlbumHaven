// Source-authored coverage. Execute only in the complete, approved composition.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createAlbumTopBackendProviders;
test.before(async () => {({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));});
const CONTEXT = 'a'.repeat(64), OTHER_CONTEXT = 'b'.repeat(64), GENERATION = 4;
const scope = (library = '2', context = CONTEXT, generation = GENERATION) => JSON.stringify(['1', library, context, generation]);
const SCOPE = scope(), INVENTORY = 'inventory-album:2:11', KEY = 'Artist/Album \u{1f3b5}';
const source = (patch = {}) => ({top_ref: F.TOP, item_ref: F.IA, revision: '7', album_ref: F.A,
  inventory_album_ref: INVENTORY, ...patch});
const target = (key = KEY) => ({album_ref: key, allowed_actions: {can_view_details: true, can_play_album: false}});
const data = (patch = {}) => ({top_ref: F.TOP, item_ref: F.IA, revision: '7', catalog_ref: F.A,
  inventory_album_ref: INVENTORY, native_target: target(), ...patch});
const envelope = value => ({status: 'ready', context_ref: CONTEXT, data: value});
const requestPath = value => '/album-tops/' + value.top_ref + '/items/' + value.item_ref + '/native-target?'
  + new URLSearchParams({revision: value.revision, inventory_album_ref: value.inventory_album_ref});
const isAbort = error => error.name === 'AbortError';
const isInvalid = error => error.status === 409 || error.status === 502;

function fixture(t, {reply = envelope(data()), expectedCalls = 1, payload = source(), scopeKey = SCOPE} = {}) {
  let liveContext = CONTEXT, generation = GENERATION, allowed = true, sourceLive = true;
  let acceptHook = () => {}, sourceHook = () => {};
  const controller = new AbortController(), calls = [], boundaryErrors = [];
  const options = {scopeKey, signal: controller.signal, isCurrent: () => {sourceHook(); return sourceLive;}};
  const transport = {context: () => liveContext, generation: () => generation,
    async request(path, request) {
      calls.push({path, request});
      try {
        assert.equal(calls.length, 1, 'No retry or additional lookup');
        assert.equal(path, requestPath(payload));
        assert.equal(request.expected, CONTEXT);
        assert.equal(request.signal, controller.signal);
        assert.equal(typeof request.isCurrent, 'function');
        assert.equal(request.method, undefined); assert.equal(request.body, undefined);
      } catch (error) {boundaryErrors.push(error); throw error;}
      return typeof reply === 'function' ? reply(request) : reply;
    }};
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: value => {
    const accepted = allowed && value === scopeKey; acceptHook(); return accepted;
  }});
  t.after(() => {
    providers.dispose();
    assert.equal(calls.length, expectedCalls, 'Exact transport call count');
    assert.equal(boundaryErrors.length, 0, boundaryErrors.map(error => error.message).join('; '));
  });
  return {providers, transport, calls, options, payload, controller,
    resolve: () => providers.resolveNativeAlbum(payload, options),
    context(value) {liveContext = value;}, generation(value) {generation = value;},
    allow(value) {allowed = value;}, sourceLive(value) {sourceLive = value;},
    onAccept(callback) {acceptHook = callback;}, onSource(callback) {sourceHook = callback;}};
}

test('saved Top resolution uses exact scoped endpoint and returns detached details-only DTO', async t => {
  const wire = data(), env = fixture(t, {reply: envelope(wire)}), expected = {...source(), native_target: target()};
  const result = await env.resolve();
  assert.deepEqual(result, expected);
  assert.notEqual(result, env.payload); assert.notEqual(result.native_target, wire.native_target);
  assert.notEqual(result.native_target.allowed_actions, wire.native_target.allowed_actions);
  wire.native_target.album_ref = 'changed'; wire.native_target.allowed_actions.can_play_album = true;
  env.payload.album_ref = F.B;
  assert.deepEqual(result, expected);
  assert.deepEqual(Object.keys(result).sort(), [...Object.keys(source()), 'native_target'].sort());
  assert.equal(env.calls[0].request.isCurrent(), false, 'Changing exact source retires the captured callback');
});

for (const [name, key] of [['ASCII maximum', 'a'.repeat(16384)], ['scalar maximum', '\u{1f3b5}'.repeat(16384)],
  ['one scalar', '\u{1f3b5}'], ['internal whitespace', 'Artist Album']]) {
  test('native hydration key accepts ' + name + ' without truncating or normalizing', async t => {
    const env = fixture(t, {reply: envelope(data({native_target: target(key)}))});
    assert.equal((await env.resolve()).native_target.album_ref, key);
  });
}
for (const [name, key] of [['empty', ''], ['missing', undefined], ['null', null], ['number', 12],
  ['leading space', ' key'], ['trailing space', 'key '], ['leading NBSP', '\u00a0key'], ['trailing NEL', 'key\u0085'],
  ['leading NEL', '\u0085key'], ['newline', 'key\n'], ['inner control', 'a\u0001b'], ['DEL', 'a\u007fb'],
  ['unpaired high', 'a\ud800b'], ['unpaired low', 'a\udfffb'], ['ASCII overflow', 'a'.repeat(16385)],
  ['scalar overflow', '\u{1f3b5}'.repeat(16385)]]) {
  test('native hydration key rejects ' + name, async t => {
    const invalid = target(); invalid.album_ref = key;
    const env = fixture(t, {reply: envelope(data({native_target: invalid}))});
    await assert.rejects(env.resolve(), isInvalid);
  });
}

const malformedData = [
  ['wrong Top', value => {value.top_ref = F.OTHER;}], ['wrong item', value => {value.item_ref = F.IB;}],
  ['wrong revision', value => {value.revision = '8';}], ['numeric revision', value => {value.revision = 7;}],
  ['wrong catalog', value => {value.catalog_ref = F.B;}], ['wrong inventory', value => {value.inventory_album_ref = 'inventory-album:2:12';}],
  ['different library', value => {value.inventory_album_ref = 'inventory-album:3:11';}],
  ['extra response field', value => {value.source_kind = 'remote_summary';}], ['missing field', value => {delete value.catalog_ref;}],
  ['null target', value => {value.native_target = null;}], ['array target', value => {value.native_target = [];}],
  ['extra target field', value => {value.native_target.path = 'private-path';}],
  ['denied details', value => {value.native_target.allowed_actions.can_view_details = false;}],
  ['nonboolean details', value => {value.native_target.allowed_actions.can_view_details = 1;}],
  ['playback grant', value => {value.native_target.allowed_actions.can_play_album = true;}],
  ['missing playback denial', value => {delete value.native_target.allowed_actions.can_play_album;}],
  ['extra action', value => {value.native_target.allowed_actions.can_open_album = true;}],
];
for (const [name, change] of malformedData) test('response binding rejects ' + name, async t => {
  const value = data(); change(value);
  await assert.rejects(fixture(t, {reply: envelope(value)}).resolve(), isInvalid);
});
for (const [name, value] of [['null', null], ['array', []], ['wrong context', {...envelope(data()), context_ref: OTHER_CONTEXT}],
  ['wrong status', {...envelope(data()), status: 'denied'}], ['array data', envelope([])]]) {
  test('private envelope rejects ' + name, async t => {await assert.rejects(fixture(t, {reply: value}).resolve(), isInvalid);});
}
for (const [name, patch] of [['Top newline', {top_ref: F.TOP + '\n'}], ['wrong item type', {item_ref: 1}],
  ['missing catalog', {album_ref: undefined}], ['zero revision', {revision: '0'}], ['revision newline', {revision: '7\n'}],
  ['bigint overflow', {revision: '9223372036854775808'}], ['remote source', {source_kind: 'remote_summary'}],
  ['wrong library', {inventory_album_ref: 'inventory-album:3:11'}], ['noncanonical library', {inventory_album_ref: 'inventory-album:02:11'}],
  ['noncanonical album', {inventory_album_ref: 'inventory-album:2:011'}], ['inventory newline', {inventory_album_ref: INVENTORY + '\n'}],
  ['inventory overflow', {inventory_album_ref: 'inventory-album:2:9223372036854775808'}],
  ['hydration key input', {native_target: target()}]]) {
  test('source rejects ' + name + ' before network', async t => {
    await assert.rejects(fixture(t, {expectedCalls: 0, payload: source(patch)}).resolve(), isInvalid);
  });
}
for (const value of ['not-json', '[]', JSON.stringify(['1', '2', CONTEXT]), scope('0'), scope('2', CONTEXT, -1)]) {
  test('malformed native scope fails before network: ' + value, async t => {
    await assert.rejects(fixture(t, {expectedCalls: 0, scopeKey: value}).resolve(), isInvalid);
  });
}
for (const kind of ['missing', 'nonfunction']) test('requires exact source callback: ' + kind, async t => {
  const env = fixture(t, {expectedCalls: 0}); env.options.isCurrent = kind === 'missing' ? undefined : true;
  await assert.rejects(env.resolve(), isInvalid);
});

const retirements = [
  ['scope denial', env => env.allow(false)], ['source retirement', env => env.sourceLive(false)],
  ['context change', env => env.context(OTHER_CONTEXT)], ['generation change', env => env.generation(GENERATION + 1)],
  ['missing generation', env => {delete env.transport.generation;}], ['abort', env => env.controller.abort()],
  ['disposal', env => env.providers.dispose()], ['scope option change', env => {env.options.scopeKey = scope('3');}],
  ['callback replacement', env => {env.options.isCurrent = () => true;}],
  ['signal replacement', env => {env.options.signal = new AbortController().signal;}],
  ['source tuple replacement', env => {env.payload.item_ref = F.IB;}],
];
for (const [name, retire] of retirements) {
  if (!['scope option change', 'callback replacement', 'signal replacement', 'source tuple replacement'].includes(name)) test('before-request ' + name + ' fails without network', async t => {
    const env = fixture(t, {expectedCalls: 0}); retire(env); await assert.rejects(env.resolve(), isAbort);
  });
  test('pending ' + name + ' cannot expose the returned native binding', async t => {
    const pending = F.deferred(), env = fixture(t, {reply: pending.promise});
    const result = env.resolve(); retire(env); pending.resolve(envelope(data()));
    await assert.rejects(result, isAbort);
    assert.equal(env.calls[0].request.isCurrent(), false);
  });
}
for (const owner of ['scope', 'source']) for (const [name, retire] of retirements.filter(([name]) =>
  ['generation change', 'abort', 'disposal', 'callback replacement', 'signal replacement', 'source tuple replacement'].includes(name))) {
  test(owner + ' callback reentrancy: ' + name + ' fails before request', async t => {
    const env = fixture(t, {expectedCalls: 0});
    (owner === 'scope' ? env.onAccept : env.onSource)(() => retire(env));
    await assert.rejects(env.resolve(), isAbort);
  });
}

test('scope acceptance may retire the source even while returning true', async t => {
  const env = fixture(t, {expectedCalls: 0}); env.onAccept(() => env.sourceLive(false));
  await assert.rejects(env.resolve(), isAbort);
});
for (const owner of ['scope', 'source']) test(owner + ' callback exception is retirement', async t => {
  const env = fixture(t, {expectedCalls: 0});
  (owner === 'scope' ? env.onAccept : env.onSource)(() => {throw new Error('Retired source');});
  await assert.rejects(env.resolve(), isAbort);
});

test('a stale callback stays false across repeated calls and later apparent recovery', async t => {
  const pending = F.deferred(), env = fixture(t, {reply: pending.promise});
  const result = env.resolve(), current = env.calls[0].request.isCurrent;
  assert.equal(current(), true); env.sourceLive(false); assert.equal(current(), false);
  env.sourceLive(true); assert.equal(current(), false); assert.equal(current(), false);
  pending.resolve(envelope(data())); await assert.rejects(result, isAbort);
});

test('recursive source-current callback retires the request without recursion or revival', async t => {
  const pending = F.deferred(), env = fixture(t, {reply: pending.promise});
  const result = env.resolve(), current = env.calls[0].request.isCurrent;
  env.onSource(() => current());
  assert.equal(current(), false); env.onSource(() => {}); assert.equal(current(), false);
  pending.resolve(envelope(data())); await assert.rejects(result, isAbort);
});

for (const accessor of ['context', 'generation']) test('reentrant transport ' + accessor + ' read retires without recursive ownership checks', async t => {
  const pending = F.deferred(), env = fixture(t, {reply: pending.promise});
  const result = env.resolve(), current = env.calls[0].request.isCurrent, original = env.transport[accessor];
  env.transport[accessor] = () => {current(); return original();};
  assert.equal(current(), false); env.transport[accessor] = original; assert.equal(current(), false);
  pending.resolve(envelope(data())); await assert.rejects(result, isAbort);
});

test('final source fence catches retirement triggered during response projection', async t => {
  const value = data(), env = fixture(t, {reply: envelope(value)});
  Object.defineProperty(value.native_target, 'album_ref', {enumerable: true, get() {env.sourceLive(false); return KEY;}});
  await assert.rejects(env.resolve(), isAbort);
});

test('projection returns the exact captured hydration key that was validated', async t => {
  const value = data(); let reads = 0;
  Object.defineProperty(value.native_target, 'album_ref', {enumerable: true, get() {return ++reads === 1 ? KEY : 'bad\nkey';}});
  const env = fixture(t, {reply: envelope(value)});
  assert.equal((await env.resolve()).native_target.album_ref, KEY); assert.equal(reads, 1);
});

for (const status of [401, 403, 404, 409]) test('endpoint denial ' + status + ' is preserved without a target or retry', async t => {
  const denial = Object.assign(new Error('Denied by the exact saved Top source'), {status, responseRejected: true});
  const env = fixture(t, {reply: () => {throw denial;}});
  await assert.rejects(env.resolve(), error => error === denial);
});

// Genuine private transport integration protects the rejected-I/O boundary and
// proves that the composed method uses the ordinary guarded request contract.
function privateFixture(t, respond) {
  const shell = {dataset: {privateUiContext: CONTEXT}}, calls = [], window = {};
  const sourceText = fs.readFileSync(F.source('runtime/private-ui-transport.js'), 'utf8');
  vm.runInNewContext(sourceText, {window, document: {getElementById: () => shell}, URLSearchParams,
    fetch: async (...args) => {calls.push(args); return respond(...args);}});
  const transport = window.AlbumHavenPrivateUITransport;
  let live = true;
  const controller = new AbortController(), options = {scopeKey: scope('2', CONTEXT, 0), signal: controller.signal, isCurrent: () => live};
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: key => key === options.scopeKey});
  t.after(() => {providers.dispose(); transport.dispose();});
  return {transport, shell, calls, options, controller, retire() {live = false;},
    resolve: () => providers.resolveNativeAlbum(source(), options)};
}
const http = (status, value) => ({status, ok: status >= 200 && status < 300, json: async () => value});

test('genuine private transport carries same-origin no-store context and exact abort signal', async t => {
  const env = privateFixture(t, async () => http(200, envelope(data())));
  assert.deepEqual(await env.resolve(), {...source(), native_target: target()});
  assert.equal(env.calls.length, 1);
  const [path, options] = env.calls[0];
  assert.equal(path, requestPath(source())); assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
  assert.equal(options.headers['X-AlbumHaven-Context'], CONTEXT); assert.equal(options.signal, env.controller.signal);
  assert.equal(options.body, undefined);
});
for (const stage of ['fetch', 'json']) test('genuine transport rejects stale ' + stage + ' completion', async t => {
  const pending = F.deferred(), entered = F.deferred();
  const env = privateFixture(t, async () => stage === 'fetch' ? pending.promise :
    {status: 200, ok: true, json: () => {entered.resolve(); return pending.promise;}});
  const result = env.resolve();
  if (stage === 'json') await entered.promise;
  env.retire(); pending.resolve(stage === 'fetch' ? http(200, envelope(data())) : envelope(data()));
  await assert.rejects(result, isAbort); assert.equal(env.calls.length, 1);
});
for (const stage of ['fetch', 'json']) test('genuine transport rejects stale ' + stage + ' failure as abort', async t => {
  const pending = F.deferred(), entered = F.deferred();
  const env = privateFixture(t, async () => stage === 'fetch' ? pending.promise :
    {status: 200, ok: true, json: () => {entered.resolve(); return pending.promise;}});
  const result = env.resolve();
  if (stage === 'json') await entered.promise;
  env.retire(); pending.reject(new Error('Old network or parser failure'));
  await assert.rejects(result, isAbort); assert.equal(env.calls.length, 1);
});
for (const status of [401, 403]) test('genuine private transport preserves current ' + status + ' denial', async t => {
  const env = privateFixture(t, async () => http(status, {error: 'forbidden'}));
  await assert.rejects(env.resolve(), error => error.status === status && error.responseRejected === true);
  assert.equal(env.calls.length, 1);
});
test('genuine transport context mismatch preserves the originating policy retirement error', async t => {
  const env = privateFixture(t, async () => http(200, {...envelope(data()), context_ref: OTHER_CONTEXT}));
  await assert.rejects(env.resolve(), error => error.status === 409 && error.code === 'stale_context');
  assert.equal(env.calls.length, 1); assert.equal(env.transport.generation(), 1);
});
