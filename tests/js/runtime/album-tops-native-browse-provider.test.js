// Source-only regression coverage for scoped, browse-only Album Top hints.
// Load the genuine provider through the existing runtime fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createAlbumTopBackendProviders;
test.before(async () => {({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));});

const CONTEXT = 'a'.repeat(64), OTHER_CONTEXT = 'b'.repeat(64), GENERATION = 4;
const MAX_ID = '9223372036854775807';
const scope = (library = '2', context = CONTEXT, generation = GENERATION) => JSON.stringify(['1', library, context, generation]);
const SCOPE = scope(), GROUP = F.id(104), DETAIL_PATH = '/album-tops/' + F.TOP;
const isAbort = error => error.name === 'AbortError';
const hint = (ref = 'inventory-album:2:11', artwork = '/library/album-artwork/' + ref) => ({
  inventory_album_ref: ref, artwork_url: artwork, allowed_actions: {can_view_details: true},
});
const localRow = (patch = {}) => ({ref: F.IA, catalog_ref: F.A, title: 'Local album', artist_display: 'Artist',
  release_year: 2001, original_position: 4, curator_position: 2, ...patch});
const remoteRow = (patch = {}) => ({ref: F.IB, catalog_ref: F.B, title: 'Remote album', artist_display: 'Remote artist',
  original_position: 9, curator_position: 1, source_kind: 'remote_summary', provider: 'musicbrainz',
  entity_kind: 'release-group', release_group_id: GROUP, first_release_date: '2000-02-29', primary_type: 'Album',
  metadata_coverage: 'album_summary_only', track_metadata_status: 'unavailable', track_count: null, ...patch});
const detail = (items = [localRow({native_album: hint()})], patch = {}) => ({top_ref: F.TOP,
  revision: '7', title: 'Curated Top', description: '', visibility: 'private',
  allowed_actions: {[F.BROWSE]: true, can_read: true}, items, ...patch});
const projectedLocal = (patch = {}) => ({item_ref: F.IA, album_ref: F.A, title: 'Local album', artist: 'Artist',
  year: 2001, original_position: 4, position: 2, ...patch});

// Every network call has exactly one explicit reply. Boundary assertion failures
// are rechecked in teardown, so assert.rejects cannot hide a fixture failure.
function fixture(t, data, {scopeKey = SCOPE, context = CONTEXT, generation = GENERATION,
  maxCalls = 1, expectedCalls = maxCalls, envelope} = {}) {
  let liveContext = context, liveGeneration = generation, allowed = true, acceptanceHook = null;
  const calls = [], boundaryErrors = [], acceptedScopes = new Set([scopeKey]);
  const transport = {context: () => liveContext, generation: () => liveGeneration,
    async request(path, request) {
      calls.push({path, request});
      try {
        assert.ok(calls.length <= maxCalls, 'No unplanned retry or extra request');
        assert.equal(path, DETAIL_PATH);
        assert.equal(request.expected, context);
        assert.ok(request.signal instanceof AbortSignal);
        assert.equal(request.method, undefined);
        assert.equal(request.body, undefined);
      } catch (error) {boundaryErrors.push(error); throw error;}
      const reply = typeof data === 'function' ? await data(request) : data;
      return envelope === undefined ? {status: 'ready', context_ref: context, data: reply} : envelope;
    }};
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: value => {
    const accepted = allowed && acceptedScopes.has(value);
    if (acceptanceHook) acceptanceHook(value);
    return accepted;
  }});
  t.after(() => {
    providers.dispose();
    if (expectedCalls !== null) assert.equal(calls.length, expectedCalls, 'Expected exact transport call count');
    assert.equal(boundaryErrors.length, 0, boundaryErrors.map(error => error.message).join('; '));
  });
  return {providers, transport, calls, options: (patch = {}) => ({scopeKey, signal: new AbortController().signal, ...patch}),
    deny() {allowed = false;}, acceptScope(value) {acceptedScopes.add(value);},
    onScopeAcceptance(callback) {acceptanceHook = callback;},
    context(value) {liveContext = value;}, generation(value) {liveGeneration = value;}};
}

for (const artwork of ['path', 'null']) test('valid native browse hint preserves exact ' + artwork + ' artwork', async t => {
  const native = hint('inventory-album:2:11', artwork === 'null' ? null : '/library/album-artwork/inventory-album:2:11');
  const env = fixture(t, detail([localRow({native_album: native})]));
  const result = await env.providers.read(F.TOP, env.options());
  assert.deepEqual(result.items, [projectedLocal({native_album: native})]);
  assert.deepEqual(Object.keys(result.items[0].native_album).sort(), ['allowed_actions', 'artwork_url', 'inventory_album_ref']);
  assert.deepEqual(result.items[0].native_album.allowed_actions, {can_view_details: true});
  assert.equal(result.completion_summary, null);
  assert.equal(env.calls[0].request.signal.aborted, false);
});

for (const [library, album] of [['1', '1'], ['2', '9007199254740993'], [MAX_ID, MAX_ID]]) {
  test('canonical inventory integers are lossless through ' + library + ':' + album, async t => {
    const native = hint('inventory-album:' + library + ':' + album);
    const env = fixture(t, detail([localRow({native_album: native})]), {scopeKey: scope(library)});
    assert.deepEqual((await env.providers.read(F.TOP, env.options())).items[0].native_album, native);
  });
}

test('absent native hint stays absent and explicit null stays null', async t => {
  const env = fixture(t, detail([localRow(), localRow({ref: F.IB, catalog_ref: F.B, native_album: null})]));
  const result = await env.providers.read(F.TOP, env.options());
  assert.equal(Object.hasOwn(result.items[0], 'native_album'), false);
  assert.equal(Object.hasOwn(result.items[1], 'native_album'), true);
  assert.equal(result.items[1].native_album, null);
  assert.deepEqual(result.items.map(row => [row.item_ref, row.album_ref]), [[F.IA, F.A], [F.IB, F.B]]);
});

test('absent and null hints do not require a new transport generation method', async t => {
  const env = fixture(t, detail([localRow(), localRow({ref: F.IB, catalog_ref: F.B, native_album: null})]));
  delete env.transport.generation;
  const result = await env.providers.read(F.TOP, env.options());
  assert.equal(Object.hasOwn(result.items[0], 'native_album'), false);
  assert.equal(result.items[1].native_album, null);
});

test('each read returns detached native hints and detached nested actions', async t => {
  const data = detail(), wire = data.items[0].native_album;
  const env = fixture(t, data, {maxCalls: 2});
  const first = (await env.providers.read(F.TOP, env.options())).items[0].native_album;
  const second = (await env.providers.read(F.TOP, env.options())).items[0].native_album;
  assert.notStrictEqual(first, wire);
  assert.notStrictEqual(first.allowed_actions, wire.allowed_actions);
  assert.notStrictEqual(second, first);
  assert.notStrictEqual(second.allowed_actions, first.allowed_actions);
  wire.inventory_album_ref = 'inventory-album:2:99';
  wire.artwork_url = null;
  wire.allowed_actions.can_view_details = false;
  assert.deepEqual(first, hint());
  assert.deepEqual(second, hint());
  first.allowed_actions.can_view_details = false;
  first.artwork_url = null;
  assert.deepEqual(second, hint());
});

const privateFields = () => ({local_album_id: 11, album_id: 11, library_id: 2, inventory_album_ref: 'PRIVATE_SENTINEL',
  selected_local_album_id: 11, selected_source_ref: F.SOURCE, path: '/PRIVATE_SENTINEL',
  artwork_url: '/PRIVATE_SENTINEL', media_url: 'private://PRIVATE_SENTINEL', playback_url: '/PRIVATE_SENTINEL',
  tracks: [{path: '/PRIVATE_SENTINEL'}], playback: {can_play: true}, can_play: true,
  allowed_actions: {can_view_details: true, can_play: true}, access_token: 'PRIVATE_SENTINEL'});
test('only the native browse hint survives raw identity, path and playback extras', async t => {
  const env = fixture(t, detail([localRow({...privateFields(), native_album: hint()})]));
  const result = await env.providers.read(F.TOP, env.options());
  assert.deepEqual(result.items, [projectedLocal({native_album: hint()})]);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
  for (const key of Object.keys(privateFields())) assert.equal(Object.hasOwn(result.items[0], key), false, key);
});

const malformedRefs = [
  ['missing prefix', '2:11'], ['wrong prefix', 'album:2:11'], ['uppercase prefix', 'Inventory-album:2:11'],
  ['missing album', 'inventory-album:2:'], ['extra component', 'inventory-album:2:11:1'],
  ['zero album', 'inventory-album:2:0'], ['negative album', 'inventory-album:2:-1'],
  ['zero library', 'inventory-album:0:11'], ['negative library', 'inventory-album:-2:11'],
  ['padded album', 'inventory-album:2:011'], ['padded library', 'inventory-album:02:11'],
  ['positive sign', 'inventory-album:2:+11'], ['fraction', 'inventory-album:2:11.0'],
  ['exponent', 'inventory-album:2:1e1'], ['unicode digit', 'inventory-album:2:１１'],
  ['album overflow', 'inventory-album:2:9223372036854775808'],
  ['library overflow', 'inventory-album:9223372036854775808:11'],
  ['very long integer', 'inventory-album:2:' + '9'.repeat(100)],
  ['leading space', ' inventory-album:2:11'], ['trailing space', 'inventory-album:2:11 '],
  ['final newline', 'inventory-album:2:11\n'], ['encoded separators', 'inventory-album%3A2%3A11'],
  ['numeric ref', 11], ['null ref', null], ['object ref', {value: 'inventory-album:2:11'}],
];
for (const [name, ref] of malformedRefs) test('native hint rejects ' + name, async t => {
  const env = fixture(t, detail([localRow({native_album: hint(ref, null)})]));
  await assert.rejects(env.providers.read(F.TOP, env.options()));
});

const malformedHints = [
  ['undefined hint', () => undefined], ['boolean hint', () => false], ['numeric hint', () => 0],
  ['string hint', () => 'inventory-album:2:11'], ['array hint', () => []], ['empty hint', () => ({})],
  ...['inventory_album_ref', 'artwork_url', 'allowed_actions'].map(key => ['missing ' + key, () => {
    const value = hint(); delete value[key]; return value;
  }]),
  ['extra native field', () => ({...hint(), local_album_id: 11})],
  ['extra native playback', () => ({...hint(), playback: {can_play: true}})],
  ['undefined actions', () => ({...hint(), allowed_actions: undefined})],
  ['null actions', () => ({...hint(), allowed_actions: null})],
  ['array actions', () => ({...hint(), allowed_actions: []})],
  ['string actions', () => ({...hint(), allowed_actions: 'can_view_details'})],
  ['missing action', () => ({...hint(), allowed_actions: {}})],
  ['denied action', () => ({...hint(), allowed_actions: {can_view_details: false}})],
  ['string action', () => ({...hint(), allowed_actions: {can_view_details: 'true'}})],
  ['numeric action', () => ({...hint(), allowed_actions: {can_view_details: 1}})],
  ['extra granted action', () => ({...hint(), allowed_actions: {can_view_details: true, can_play: true}})],
  ['extra denied action', () => ({...hint(), allowed_actions: {can_view_details: true, can_play: false}})],
];
for (const [name, value] of malformedHints) test('native hint rejects ' + name, async t => {
  const env = fixture(t, detail([localRow({native_album: value()})]));
  await assert.rejects(env.providers.read(F.TOP, env.options()));
});

const ARTWORK = '/library/album-artwork/inventory-album:2:11';
const malformedArtwork = [
  ['absolute URL', 'https://example.test' + ARTWORK], ['alternate origin', 'https://attacker.test' + ARTWORK],
  ['scheme-relative URL', '//attacker.test' + ARTWORK], ['data URL', 'data:image/png;base64,AA=='],
  ['wrong album', '/library/album-artwork/inventory-album:2:12'],
  ['wrong library', '/library/album-artwork/inventory-album:3:11'],
  ['encoded ref', '/library/album-artwork/inventory-album%3A2%3A11'],
  ['encoded path', '/library/%61lbum-artwork/inventory-album:2:11'],
  ['dot traversal', '/library/album-artwork/../album-artwork/inventory-album:2:11'],
  ['encoded traversal', '/library/album-artwork/%2e%2e/album-artwork/inventory-album:2:11'],
  ['double slash', '/library//album-artwork/inventory-album:2:11'],
  ['backslashes', '\\library\\album-artwork\\inventory-album:2:11'],
  ['relative path', ARTWORK.slice(1)], ['trailing slash', ARTWORK + '/'],
  ['query', ARTWORK + '?size=100'], ['fragment', ARTWORK + '#cover'],
  ['leading whitespace', ' ' + ARTWORK], ['trailing newline', ARTWORK + '\n'],
  ['empty string', ''], ['undefined', undefined], ['boolean', false], ['object', {url: ARTWORK}],
];
for (const [name, artwork] of malformedArtwork) test('native artwork rejects ' + name, async t => {
  const env = fixture(t, detail([localRow({native_album: {...hint(), artwork_url: artwork}})]));
  await assert.rejects(env.providers.read(F.TOP, env.options()));
});

const malformedScopes = [
  ['foreign library', scope('3')], ['stale context', scope('2', OTHER_CONTEXT)], ['stale generation', scope('2', CONTEXT, 3)],
  ['unstructured scope', 'top-builder:actor:session:library'], ['invalid JSON', '['], ['object scope', '{}'], ['null scope', 'null'],
  ['missing field', JSON.stringify(['1', '2', CONTEXT])], ['extra field', JSON.stringify(['1', '2', CONTEXT, 4, 'extra'])],
  ['numeric account', JSON.stringify([1, '2', CONTEXT, 4])], ['null account', JSON.stringify([null, '2', CONTEXT, 4])],
  ['numeric library', JSON.stringify(['1', 2, CONTEXT, 4])], ['padded library', scope('02')],
  ['short context', scope('2', 'a'.repeat(63))], ['nonhex context', scope('2', 'z'.repeat(64))],
  ['numeric context', scope('2', 1)], ['string generation', scope('2', CONTEXT, '4')],
  ['negative generation', scope('2', CONTEXT, -1)], ['fractional generation', scope('2', CONTEXT, 4.5)],
  ['unsafe generation', scope('2', CONTEXT, Number.MAX_SAFE_INTEGER + 1)], ['null generation', scope('2', CONTEXT, null)],
];
for (const [name, scopeKey] of malformedScopes) test('native hint rejects ' + name + ' despite caller acceptance', async t => {
  const env = fixture(t, detail(), {scopeKey, expectedCalls: null});
  await assert.rejects(env.providers.read(F.TOP, env.options()));
});

for (const generation of [0, Number.MAX_SAFE_INTEGER]) test('matching safe generation ' + generation + ' accepts native hint', async t => {
  const env = fixture(t, detail(), {scopeKey: scope('2', CONTEXT, generation), generation});
  assert.deepEqual((await env.providers.read(F.TOP, env.options())).items[0].native_album, hint());
});
for (const [name, generation] of [['missing', undefined], ['string', '4'], ['negative', -1], ['fractional', 4.5], ['unsafe', Number.MAX_SAFE_INTEGER + 1]]) {
  test('native hint rejects ' + name + ' live transport generation', async t => {
    const env = fixture(t, detail(), {expectedCalls: null});
    if (name === 'missing') delete env.transport.generation;
    else env.generation(generation);
    await assert.rejects(env.providers.read(F.TOP, env.options()));
  });
}

for (const presence of ['absent', 'null']) test('remote summary remains unbound with ' + presence + ' native hint', async t => {
  const row = remoteRow({...privateFields(), ...(presence === 'null' ? {native_album: null} : {})});
  const env = fixture(t, detail([row]));
  const result = (await env.providers.read(F.TOP, env.options())).items[0];
  assert.equal(result.source_kind, 'remote_summary');
  assert.equal(result.release_group_id, GROUP);
  assert.equal(result.track_count, null);
  assert.equal(result.track_metadata_status, 'unavailable');
  assert.equal(result.album_ref, F.B);
  assert.equal(result.year, 2000);
  assert.equal(Object.hasOwn(result, 'native_album'), presence === 'null');
  if (presence === 'null') assert.equal(result.native_album, null);
  for (const key of Object.keys(privateFields())) assert.equal(Object.hasOwn(result, key), false, key);
});
for (const [name, native] of [['valid bound hint', hint()], ['empty hint', {}], ['undefined hint', undefined], ['false hint', false]]) {
  test('remote summary rejects non-null ' + name, async t => {
    const env = fixture(t, detail([remoteRow({native_album: native})]));
    await assert.rejects(env.providers.read(F.TOP, env.options()));
  });
}

test('native availability never rewrites canonical members, ordering or progress denominator', async t => {
  const thirdItem = F.id(23), fourthItem = F.id(24), fourthAlbum = F.id(14);
  const rows = [localRow({native_album: hint()}), remoteRow({native_album: null}),
    localRow({ref: thirdItem, catalog_ref: F.C, native_album: null, original_position: 3, curator_position: 4}),
    localRow({ref: fourthItem, catalog_ref: fourthAlbum, original_position: 2, curator_position: 3})];
  const progress = Object.fromEntries(rows.map((row, index) => [row.catalog_ref, {progress_revision: index === 1 ? '1' : '0',
    manual_completed_at: index === 1 ? '2026-10-18T12:00:00Z' : null}]));
  const env = fixture(t, detail(rows, {top_viewer_overlay: {item_progress: progress}}));
  const result = await env.providers.read(F.TOP, env.options());
  assert.deepEqual(result.items.map(row => [row.item_ref, row.album_ref, row.original_position, row.position]),
    rows.map(row => [row.ref, row.catalog_ref, row.original_position, row.curator_position]));
  assert.deepEqual(result.completion_summary, {completed: 1, total: 4});
  assert.deepEqual(result.top_viewer_overlay.item_progress, progress);
  assert.equal(result.items.filter(row => row.native_album).length, 1);
  assert.equal(Object.hasOwn(result.items[3], 'native_album'), false);
});

test('malformed native hint rejects the whole detail instead of dropping a member', async t => {
  const env = fixture(t, detail([localRow({native_album: hint()}),
    localRow({ref: F.IB, catalog_ref: F.B, native_album: {...hint(), allowed_actions: {can_view_details: false}}})]));
  await assert.rejects(env.providers.read(F.TOP, env.options()));
});

for (const change of ['scope', 'context', 'generation', 'dispose', 'abort']) test(change + ' change suppresses native hints from a pending detail', async t => {
  const gate = F.deferred(), env = fixture(t, () => gate.promise), abort = new AbortController();
  const waiting = env.providers.read(F.TOP, env.options({signal: abort.signal}));
  assert.equal(env.calls.length, 1, 'Read reached the deferred transport');
  if (change === 'scope') env.deny();
  else if (change === 'context') env.context(OTHER_CONTEXT);
  else if (change === 'generation') env.generation(5);
  else if (change === 'dispose') env.providers.dispose();
  else abort.abort();
  gate.resolve(detail());
  await assert.rejects(waiting, isAbort);
});

test('mutating the options scope while pending cannot rebind the response to another accepted library', async t => {
  const gate = F.deferred(), env = fixture(t, () => gate.promise), options = env.options();
  const waiting = env.providers.read(F.TOP, options);
  assert.equal(env.calls.length, 1);
  options.scopeKey = scope('3');
  env.acceptScope(options.scopeKey);
  gate.resolve(detail([localRow({native_album: hint('inventory-album:3:11')})]));
  await assert.rejects(waiting, isAbort);
});

test('scope acceptance cannot retire a generation after its native guard read and still expose hints', async t => {
  const env = fixture(t, detail()), generation = env.transport.generation;
  let generationRead = false, retiredDuringAcceptance = false;
  env.transport.generation = () => {generationRead = true; return generation();};
  env.onScopeAcceptance(() => {
    if (generationRead) {retiredDuringAcceptance = true; env.generation(5);}
  });
  await assert.rejects(env.providers.read(F.TOP, env.options()), isAbort);
  assert.equal(retiredDuringAcceptance, true, 'Scope callback ran after native generation observation');
});

for (const change of ['scope', 'dispose', 'abort']) test('preflight ' + change + ' prevents a detail request', async t => {
  const env = fixture(t, detail(), {maxCalls: 0}), abort = new AbortController();
  if (change === 'scope') env.deny();
  else if (change === 'dispose') env.providers.dispose();
  else abort.abort();
  await assert.rejects(env.providers.read(F.TOP, env.options({signal: abort.signal})));
});

test('invalid requested Top identity never reaches the transport', async t => {
  const env = fixture(t, detail(), {maxCalls: 0});
  await assert.rejects(env.providers.read('not-a-top-ref', env.options()));
});
test('mismatched response Top identity cannot return a valid native hint', async t => {
  const env = fixture(t, detail(undefined, {top_ref: F.OTHER}));
  await assert.rejects(env.providers.read(F.TOP, env.options()));
});
for (const [name, envelope] of [['wrong context', {status: 'ready', context_ref: OTHER_CONTEXT, data: detail()}],
  ['unready response', {status: 'loading', context_ref: CONTEXT, data: detail()}]]) {
  test(name + ' cannot return a valid native hint', async t => {
    const env = fixture(t, detail(), {envelope});
    await assert.rejects(env.providers.read(F.TOP, env.options()));
  });
}
