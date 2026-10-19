// Source-authored additive coverage. Run only in the complete approved composition.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createAlbumTopBackendProviders;
test.before(async () => {({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));});
const CONTEXT = 'a'.repeat(64), OTHER_CONTEXT = 'b'.repeat(64), GENERATION = 4;
const scope = (library = '2', context = CONTEXT, generation = GENERATION) => JSON.stringify(['1', library, context, generation]);
const SCOPE = scope(), ALBUM = 'inventory-album:2:11';
const source = (track = 101, patch = {}) => ({revision: '7', item_ref: F.IA, catalog_ref: F.A,
  inventory_album_ref: ALBUM, inventory_track_ref: 'inventory-track:2:' + track, canonical_track_ref: 'canonical-' + track, ...patch});
const target = (track = 101, patch = {}) => ({track_ref: '/synthetic/private/' + track + '.flac', path: '/synthetic/private/' + track + '.flac',
  title: 'Track ' + track, artist: null, album_title: 'Album', duration_seconds: null, inventory_track_ref: 'inventory-track:2:' + track, ...patch});
const track = (id = 101, patch = {}) => ({queue_item_ref: F.IA + ':' + id, source: source(id), native_target: target(id), ...patch});
const album = (patch = {}) => ({item_ref: F.IA, catalog_ref: F.A, inventory_album_ref: ALBUM, album_ref: 'Native album key', tracks: [track()], ...patch});
const queue = (patch = {}) => ({top_ref: F.TOP, revision: '7', albums: [album()], unavailable_items: [], ...patch});
const resolved = (patch = {}) => ({top_ref: F.TOP, source: source(), native_target: target(), ...patch});
const envelope = value => ({status: 'ready', context_ref: CONTEXT, data: value});
const isAbort = error => error.name === 'AbortError';
const isInvalid = error => [409, 502].includes(error.status);
const modes = ['capture', 'resolve'];
function fixture(t, mode = 'capture', configuration = {}) {
  const payload = configuration.payload || (mode === 'capture' ? {top_ref: F.TOP, revision: '7'} : {top_ref: F.TOP, source: source()});
  const response = configuration.reply ?? envelope(mode === 'capture' ? queue() : resolved());
  const controller = new AbortController(), calls = [];
  let context = CONTEXT, generation = GENERATION, allowed = true, live = true, sourceHook = () => {}, scopeHook = () => {};
  const options = {scopeKey: SCOPE, signal: controller.signal, isCurrent: () => {sourceHook(); return live;}};
  const transport = {context: () => context, generation: () => generation, async request(path, request) {
    calls.push({path, request}); return typeof response === 'function' ? response(request) : response;
  }};
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: key => {scopeHook(); return allowed && key === SCOPE;}});
  t.after(() => {providers.dispose(); assert.equal(calls.length, configuration.expectedCalls ?? 1);});
  return {providers, transport, options, payload, controller, calls,
    run: () => providers[mode === 'capture' ? 'captureNativeQueue' : 'resolveNativePlayback'](payload, options),
    context(value) {context = value;}, generation(value) {generation = value;}, allow(value) {allowed = value;}, live(value) {live = value;},
    onSource(value) {sourceHook = value;}, onScope(value) {scopeHook = value;}};
}
for (const mode of modes) test(mode + ' uses exact private POST and detached wire-shaped DTOs', async t => {
  const wire = mode === 'capture' ? queue() : resolved(), expected = F.clone(wire), env = fixture(t, mode, {reply: envelope(wire)});
  const result = await env.run(), {path, request} = env.calls[0];
  assert.deepEqual(result, expected);
  assert.equal(path, '/album-tops/' + F.TOP + (mode === 'capture' ? '/native-queue' : '/native-playback-target'));
  assert.equal(request.method, 'POST'); assert.equal(request.signal, env.controller.signal); assert.equal(request.expected, CONTEXT);
  assert.equal(typeof request.isCurrent, 'function'); assert.deepEqual(request.body, mode === 'capture' ? {revision: '7'} : source());
  const projected = mode === 'capture' ? result.albums[0].tracks[0] : result;
  const original = mode === 'capture' ? wire.albums[0].tracks[0] : wire;
  assert.notEqual(projected.native_target, original.native_target); assert.notEqual(projected.source, original.source);
  original.native_target.path = 'changed'; original.source.catalog_ref = F.B;
  assert.deepEqual(result, expected); assert.equal(Object.hasOwn(projected.native_target, 'playback_state'), false);
});

test('capture retains server block/track order and honest partially playable reports', async t => {
  const first = album({tracks: [track(104), track(101)]});
  const second = album({item_ref: F.IB, catalog_ref: F.B, inventory_album_ref: 'inventory-album:2:12', album_ref: 'Second', tracks: [
    track(103, {queue_item_ref: F.IB + ':103', source: source(103, {item_ref: F.IB, catalog_ref: F.B, inventory_album_ref: 'inventory-album:2:12'})}),
  ]});
  const wire = queue({albums: [second, first], unavailable_items: [{item_ref: F.IB, reason: 'tracks_unavailable'}, {item_ref: F.id(23), reason: 'remote_summary'}]});
  assert.deepEqual(await fixture(t, 'capture', {reply: envelope(wire)}).run(), wire);
});
for (const reason of ['remote_summary', 'ambiguous_edition', 'unavailable', 'tracks_unavailable']) test('all-unavailable queue preserves ' + reason, async t => {
  const wire = queue({albums: [], unavailable_items: [{item_ref: F.IA, reason}]});
  assert.deepEqual(await fixture(t, 'capture', {reply: envelope(wire)}).run(), wire);
});
test('empty saved Top is an honest empty queue', async t => {
  const wire = queue({albums: [], unavailable_items: []});
  assert.deepEqual(await fixture(t, 'capture', {reply: envelope(wire)}).run(), wire);
});
test('distinct saved canonical members may repeat the same inventory track as distinct occurrences', async t => {
  const second = album({item_ref: F.IB, catalog_ref: F.B, tracks: [track(101, {queue_item_ref: F.IB + ':101', source: source(101, {item_ref: F.IB, catalog_ref: F.B})})]});
  const wire = queue({albums: [album(), second]});
  assert.deepEqual(await fixture(t, 'capture', {reply: envelope(wire)}).run(), wire);
});
test('exact 5000 playable occurrences are preserved without truncation', async t => {
  const wire = queue({albums: [album({tracks: Array.from({length: 5000}, (_, index) => track(index + 1))})]});
  assert.deepEqual(await fixture(t, 'capture', {reply: envelope(wire)}).run(), wire);
});
test('5001 occurrences split across valid blocks still reject the entire capture', async t => {
  const second = album({item_ref: F.IB, catalog_ref: F.B, tracks: [track(6000, {queue_item_ref: F.IB + ':6000', source: source(6000, {item_ref: F.IB, catalog_ref: F.B})})]});
  const wire = queue({albums: [album({tracks: Array.from({length: 5000}, (_, i) => track(i + 1))}), second]});
  await assert.rejects(fixture(t, 'capture', {reply: envelope(wire)}).run(), isInvalid);
});
const malformedQueues = [
  ['wrong Top', value => {value.top_ref = F.OTHER;}], ['wrong revision', value => {value.revision = '8';}],
  ['extra response authority', value => {value.can_play = true;}], ['missing reports', value => {delete value.unavailable_items;}],
  ['null albums', value => {value.albums = null;}], ['sparse albums', value => {value.albums = Array(1);}],
  ['duplicate membership', value => {value.albums.push(F.clone(value.albums[0]));}],
  ['duplicate catalog', value => {value.albums.push(album({item_ref: F.IB}));}],
  ['empty playable block', value => {value.albums[0].tracks = [];}], ['sparse tracks', value => {value.albums[0].tracks = Array(1);}],
  ['oversized tracks', value => {value.albums[0].tracks = Array.from({length: 5001}, (_, i) => track(i + 1));}],
  ['wrong album library', value => {value.albums[0].inventory_album_ref = 'inventory-album:3:11';}],
  ['unknown native album', value => {value.albums[0].album_ref = ''; }],
  ['duplicate occurrence', value => {value.albums[0].tracks.push(F.clone(value.albums[0].tracks[0]));}],
  ['wrong occurrence item', value => {value.albums[0].tracks[0].queue_item_ref = F.IB + ':101';}],
  ['wrong occurrence track', value => {value.albums[0].tracks[0].queue_item_ref = F.IA + ':102';}],
  ['numeric occurrence', value => {value.albums[0].tracks[0].queue_item_ref = 101;}],
  ['extra track authority', value => {value.albums[0].tracks[0].allowed_actions = {can_play: true};}],
  ['source item swap', value => {value.albums[0].tracks[0].source.item_ref = F.IB;}],
  ['source catalog swap', value => {value.albums[0].tracks[0].source.catalog_ref = F.B;}],
  ['source album swap', value => {value.albums[0].tracks[0].source.inventory_album_ref = 'inventory-album:2:12';}],
  ['source revision swap', value => {value.albums[0].tracks[0].source.revision = '8';}],
  ['source track library swap', value => {value.albums[0].tracks[0].source.inventory_track_ref = 'inventory-track:3:101';}],
  ['sparse unavailable', value => {value.unavailable_items = Array(1);}],
  ['duplicate unavailable', value => {value.unavailable_items = [{item_ref: F.IB, reason: 'unavailable'}, {item_ref: F.IB, reason: 'unavailable'}];}],
  ['false unavailable overlap', value => {value.unavailable_items = [{item_ref: F.IA, reason: 'remote_summary'}];}],
  ['unknown unavailable reason', value => {value.unavailable_items = [{item_ref: F.IB, reason: 'not_popular'}];}],
  ['unavailable identity leak', value => {value.unavailable_items = [{item_ref: F.IB, reason: 'unavailable', inventory_track_ref: 'inventory-track:2:102'}];}],
  ['overlarge membership union', value => {value.unavailable_items = Array.from({length: 5000}, (_, i) => ({item_ref: F.id(i + 100), reason: 'unavailable'}));}],
];
for (const [name, mutate] of malformedQueues) test('capture rejects ' + name + ' as a whole response', async t => {
  const wire = queue(); mutate(wire); await assert.rejects(fixture(t, 'capture', {reply: envelope(wire)}).run(), isInvalid);
});
for (const field of ['inventory_album_ref', 'canonical_track_ref']) test('repeated inventory rejects inconsistent ' + field, async t => {
  const second = album({item_ref: F.IB, catalog_ref: F.B, tracks: [track(101, {queue_item_ref: F.IB + ':101', source: source(101, {item_ref: F.IB, catalog_ref: F.B})})]});
  if (field === 'inventory_album_ref') {second.inventory_album_ref = 'inventory-album:2:12'; second.tracks[0].source[field] = second.inventory_album_ref;}
  else second.tracks[0].source[field] = 'swapped-key';
  await assert.rejects(fixture(t, 'capture', {reply: envelope(queue({albums: [album(), second]}))}).run(), isInvalid);
});
const targetChanges = [
  ['missing metadata', value => {delete value.artist;}], ['undefined duration', value => {value.duration_seconds = undefined;}],
  ['infinite duration', value => {value.duration_seconds = Infinity;}], ['NaN duration', value => {value.duration_seconds = NaN;}],
  ['negative duration', value => {value.duration_seconds = -1;}], ['string duration', value => {value.duration_seconds = '5';}],
  ['empty path', value => {value.path = ''; value.track_ref = '';}], ['wrong path identity', value => {value.track_ref = '/swapped';}],
  ['wrong inventory identity', value => {value.inventory_track_ref = 'inventory-track:2:102';}],
  ['invalid metadata', value => {value.title = {text: 'Track'};}], ['fake play flag', value => {value.playback_state = {can_start_here: true};}],
];
for (const mode of modes) for (const [name, mutate] of targetChanges) test(mode + ' rejects target ' + name, async t => {
  const wire = mode === 'capture' ? queue() : resolved(); mutate(mode === 'capture' ? wire.albums[0].tracks[0].native_target : wire.native_target);
  await assert.rejects(fixture(t, mode, {reply: envelope(wire)}).run(), isInvalid);
});
for (const mode of modes) test(mode + ' preserves nullable metadata and finite duration without inventing flags', async t => {
  const native = target(101, {title: null, artist: null, album_title: null, duration_seconds: 0});
  const wire = mode === 'capture' ? queue({albums: [album({tracks: [track(101, {native_target: native})]})]}) : resolved({native_target: native});
  assert.deepEqual(await fixture(t, mode, {reply: envelope(wire)}).run(), wire);
});
for (const mode of modes) for (const name of ['null', 'status', 'context', 'data']) test(mode + ' rejects invalid envelope ' + name, async t => {
  let reply = envelope(mode === 'capture' ? queue() : resolved());
  if (name === 'null') reply = null;
  else if (name === 'status') reply.status = 'denied';
  else if (name === 'context') reply.context_ref = OTHER_CONTEXT;
  else reply.data = [];
  await assert.rejects(fixture(t, mode, {reply: () => reply}).run(), isInvalid);
});
for (const mode of modes) for (const callback of [undefined, true]) test(mode + ' requires source-current callback ' + String(callback), async t => {
  const env = fixture(t, mode, {expectedCalls: 0}); env.options.isCurrent = callback;
  await assert.rejects(env.run(), isInvalid);
});
for (const field of Object.keys(source())) test('resolver rejects swapped exact source field ' + field, async t => {
  const fresh = source(); fresh[field] = field === 'revision' ? '8' : field === 'item_ref' ? F.IB : field === 'catalog_ref' ? F.B
    : field === 'inventory_album_ref' ? 'inventory-album:2:12' : field === 'inventory_track_ref' ? 'inventory-track:2:102' : 'new-key';
  await assert.rejects(fixture(t, 'resolve', {reply: envelope(resolved({source: fresh}))}).run(), isInvalid);
});
for (const mode of modes) for (const [name, mutate] of [
  ['invalid Top', value => {value.top_ref += '\n';}], ['extra hint', value => {value.allowed_actions = {can_play: true};}],
  ['remote source', value => {value.source_kind = 'remote_summary';}],
  ['overflow revision', value => {(mode === 'capture' ? value : value.source).revision = '9223372036854775808';}],
  ['numeric revision', value => {(mode === 'capture' ? value : value.source).revision = 7;}],
]) test(mode + ' rejects input ' + name + ' before I/O', async t => {
  const env = fixture(t, mode, {expectedCalls: 0}); mutate(env.payload); await assert.rejects(env.run(), isInvalid);
});
for (const [name, patch] of [['foreign album', {inventory_album_ref: 'inventory-album:3:11'}],
  ['foreign track', {inventory_track_ref: 'inventory-track:3:101'}], ['noncanonical track', {inventory_track_ref: 'inventory-track:2:0101'}],
  ['track overflow', {inventory_track_ref: 'inventory-track:2:9223372036854775808'}], ['empty key', {canonical_track_ref: ''}],
  ['extra authority', {can_play: true}]]) test('resolver rejects input ' + name + ' before I/O', async t => {
  await assert.rejects(fixture(t, 'resolve', {expectedCalls: 0, payload: {top_ref: F.TOP, source: source(101, patch)}}).run(), isInvalid);
});
const retirements = [
  ['scope', env => env.allow(false)], ['source', env => env.live(false)], ['context', env => env.context(OTHER_CONTEXT)],
  ['generation', env => env.generation(GENERATION + 1)], ['abort', env => env.controller.abort()], ['disposal', env => env.providers.dispose()],
  ['scope option', env => {env.options.scopeKey = scope('3');}], ['callback replacement', env => {env.options.isCurrent = () => true;}],
  ['signal replacement', env => {env.options.signal = new AbortController().signal;}], ['Top replacement', env => {env.payload.top_ref = F.OTHER;}],
];
for (const mode of modes) for (const [name, retire] of retirements) test(mode + ' pending ' + name + ' retires permanently', async t => {
  const pending = F.deferred(), env = fixture(t, mode, {reply: pending.promise}), result = env.run();
  retire(env); assert.equal(env.calls[0].request.isCurrent(), false);
  env.live(true); env.allow(true); assert.equal(env.calls[0].request.isCurrent(), false);
  pending.resolve(envelope(mode === 'capture' ? queue() : resolved())); await assert.rejects(result, isAbort);
});
for (const replace of [false, true]) test('resolver retires changed nested source ' + (replace ? 'identity' : 'field'), async t => {
  const pending = F.deferred(), env = fixture(t, 'resolve', {reply: pending.promise}), result = env.run();
  if (replace) env.payload.source = {...env.payload.source}; else env.payload.source.canonical_track_ref = 'changed';
  pending.resolve(envelope(resolved())); await assert.rejects(result, isAbort);
});
for (const mode of modes) for (const callback of ['onSource', 'onScope']) test(mode + ' ' + callback + ' exception retires before I/O', async t => {
  const env = fixture(t, mode, {expectedCalls: 0}); env[callback](() => {throw Error('Retired');});
  await assert.rejects(env.run(), isAbort);
});
for (const mode of modes) test(mode + ' reentrant current callback cannot revive', async t => {
  const pending = F.deferred(), env = fixture(t, mode, {reply: pending.promise}), result = env.run(), current = env.calls[0].request.isCurrent;
  env.onSource(() => current()); assert.equal(current(), false); env.onSource(() => {}); assert.equal(current(), false);
  pending.resolve(envelope(mode === 'capture' ? queue() : resolved())); await assert.rejects(result, isAbort);
});
for (const mode of modes) test(mode + ' final guard catches retirement during projection', async t => {
  const wire = mode === 'capture' ? queue() : resolved(), env = fixture(t, mode, {reply: envelope(wire)});
  const native = mode === 'capture' ? wire.albums[0].tracks[0].native_target : wire.native_target;
  Object.defineProperty(native, 'path', {enumerable: true, get() {env.live(false); return target().path;}});
  await assert.rejects(env.run(), isAbort);
});
for (const mode of modes) test(mode + ' projects the once-captured path which passed validation', async t => {
  const wire = mode === 'capture' ? queue() : resolved(), env = fixture(t, mode, {reply: envelope(wire)});
  const native = mode === 'capture' ? wire.albums[0].tracks[0].native_target : wire.native_target;
  let reads = 0; Object.defineProperty(native, 'path', {enumerable: true, get() {return ++reads === 1 ? target().path : '/swapped';}});
  const result = await env.run(); assert.equal((mode === 'capture' ? result.albums[0].tracks[0] : result).native_target.path, target().path);
  assert.equal(reads, 1);
});
for (const mode of modes) for (const status of [401, 403, 404, 409, 422]) test(mode + ' propagates current denial ' + status + ' without fallback', async t => {
  const denial = Object.assign(new Error('Denied'), {status, responseRejected: true});
  await assert.rejects(fixture(t, mode, {reply: () => {throw denial;}}).run(), error => error === denial);
});

// Real guarded private transport, with only its HTTP I/O replaced.
function privateFixture(t, mode, respond) {
  const shell = {dataset: {privateUiContext: CONTEXT}}, calls = [], window = {};
  vm.runInNewContext(fs.readFileSync(F.source('runtime/private-ui-transport.js'), 'utf8'), {
    window, document: {getElementById: () => shell}, URLSearchParams, fetch: async (...args) => {calls.push(args); return respond(...args);},
  });
  const transport = window.AlbumHavenPrivateUITransport, controller = new AbortController();
  let live = true;
  const options = {scopeKey: scope('2', CONTEXT, 0), signal: controller.signal, isCurrent: () => live};
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: key => key === options.scopeKey});
  t.after(() => {providers.dispose(); transport.dispose();});
  return {transport, calls, controller, retire() {live = false;}, run: () => mode === 'capture'
    ? providers.captureNativeQueue({top_ref: F.TOP, revision: '7'}, options)
    : providers.resolveNativePlayback({top_ref: F.TOP, source: source()}, options)};
}
const http = (status, value) => ({status, ok: status >= 200 && status < 300, json: async () => value});
for (const mode of modes) test(mode + ' genuine transport keeps exact private POST protections', async t => {
  const wire = mode === 'capture' ? queue() : resolved(), env = privateFixture(t, mode, async () => http(200, envelope(wire)));
  assert.deepEqual(await env.run(), wire); assert.equal(env.calls.length, 1);
  const [, options] = env.calls[0]; assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store'); assert.equal(options.headers['X-AlbumHaven-Context'], CONTEXT);
  assert.equal(options.signal, env.controller.signal); assert.deepEqual(JSON.parse(options.body), mode === 'capture' ? {revision: '7'} : source());
});
for (const mode of modes) for (const stage of ['fetch', 'json']) for (const failure of [false, true]) test(mode + ' stale transport ' + stage + (failure ? ' rejection' : ' completion'), async t => {
  const pending = F.deferred(), entered = F.deferred(), wire = mode === 'capture' ? queue() : resolved();
  const env = privateFixture(t, mode, async () => stage === 'fetch' ? pending.promise :
    {status: 200, ok: true, json: () => {entered.resolve(); return pending.promise;}});
  const result = env.run(); if (stage === 'json') await entered.promise;
  env.retire(); if (failure) pending.reject(new Error('Old I/O error')); else pending.resolve(stage === 'fetch' ? http(200, envelope(wire)) : envelope(wire));
  await assert.rejects(result, isAbort); assert.equal(env.calls.length, 1);
});
for (const mode of modes) test(mode + ' genuine transport preserves current policy denial', async t => {
  const env = privateFixture(t, mode, async () => http(403, {error: 'forbidden'}));
  await assert.rejects(env.run(), error => error.status === 403 && error.responseRejected === true); assert.equal(env.calls.length, 1);
});
