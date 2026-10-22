// Independent contract-first cases. Load the whole real provider through its
// existing fixture; the transport is the only network boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createAlbumTopBackendProviders;
test.before(async () => {({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));});
const CONTEXT = 'a'.repeat(64), MAX = '9223372036854775807', KEY = F.id(81), DRAFT = F.id(82);
const scope = (mode = 'artist', root_artist_id = MAX) => ({root_artist_id, mode});
const options = patch => ({scopeKey: F.SCOPE, signal: new AbortController().signal, ...patch});
const top = patch => ({top_ref: F.TOP, revision: '1', title: 'Explicit collection', description: '',
  visibility: 'private', allowed_actions: {[F.BROWSE]: true, can_read: true}, ...patch});
const detail = patch => ({...top(), items: [], ...patch});
const directory = value => ({tops: [value], allowed_actions: {[F.CREATE]: true}, next_cursor: null});
const page = () => ({albums: [F.album(12, {album_ref: null}), F.album(11)], next_cursor: 'opaque % cursor'});
const create = patch => ({request_key: KEY, title: 'Explicit collection', album_refs: [F.A], ...patch});
const local = () => ({kind: 'local_catalog', album_ref: F.A});
const pending = () => ({kind: 'remote_acquisition', acquisition_ref: F.id(83), evidence_version: 'b'.repeat(64)});
const typed = selections => ({request_key: KEY, title: 'Explicit collection', draft_ref: DRAFT, selections});
const receipt = draft => ({top_ref: F.TOP, revision: '1', action: 'create', request_key: KEY,
  ...(draft ? {draft_ref: DRAFT} : {})});
function fixture(t, data, expectedCalls = 1) {
  let context = CONTEXT, allowed = true;
  const calls = [], boundaryErrors = [];
  const providers = createAlbumTopBackendProviders({acceptsScope: value => allowed && value === F.SCOPE,
    transport: {context: () => context, async request(path, request) {
      calls.push({path, request});
      try {
        assert.ok(calls.length <= expectedCalls, 'No extra request or retry');
        assert.equal(request.expected, CONTEXT);
        assert.ok(request.signal instanceof AbortSignal);
      } catch (error) {boundaryErrors.push(error); throw error;}
      return {status: 'ready', context_ref: CONTEXT, data: typeof data === 'function' ? await data() : data};
    }}});
  t.after(() => {providers.dispose(); assert.equal(calls.length, expectedCalls);
    assert.deepEqual(boundaryErrors, [], 'Transport-boundary assertions must not be hidden by rejects');});
  return {providers, calls, deny() {allowed = false;}, context(value) {context = value;}};
}
function query(call) {
  const url = new URL(call.path, 'https://example.test');
  assert.equal(url.pathname, '/album-top-catalog/search');
  assert.equal(call.request.method, undefined); assert.equal(call.request.body, undefined);
  return Object.fromEntries(url.searchParams);
}
for (const mode of ['artist', 'family']) for (const projection of ['directory', 'detail']) {
  test(projection + ' preserves frozen lossless ' + mode + ' descriptor', async t => {
    const descriptor = scope(mode), wire = projection === 'detail' ? detail({artist_scope: descriptor}) : top({artist_scope: descriptor});
    const env = fixture(t, projection === 'detail' ? wire : directory(wire));
    const result = projection === 'detail' ? await env.providers.read(F.TOP, options()) : (await env.providers.list(options())).tops[0];
    assert.deepEqual(result.artist_scope, scope(mode)); assert.ok(Object.isFrozen(result.artist_scope));
    assert.notStrictEqual(result.artist_scope, descriptor); descriptor.root_artist_id = '1'; descriptor.mode = 'other';
    assert.deepEqual(result.artist_scope, scope(mode));
    assert.equal(result.allowed_actions[F.BROWSE], true);
  });
}
for (const projection of ['directory', 'detail']) test(projection + ' retains absent ordinary scope', async t => {
  const env = fixture(t, projection === 'detail' ? detail() : directory(top()));
  const result = projection === 'detail' ? await env.providers.read(F.TOP, options()) : (await env.providers.list(options())).tops[0];
  assert.equal(Object.hasOwn(result, 'artist_scope'), false);
});
const invalidScopes = [null, undefined, [], false, {}, {root_artist_id: '1'}, {mode: 'artist'},
  {...scope(), extra: true}, ...[0, 1, '0', '01', '-1', '+1', '1.0', '1e1', '１', '1\n', ' 1',
    '9223372036854775808', '9'.repeat(20)].map(id => scope('artist', id)),
  scope('Artist'), scope('all'), scope(null)];
for (const [index, descriptor] of invalidScopes.entries()) for (const projection of ['directory', 'detail']) {
  test(projection + ' rejects malformed present descriptor ' + index, async t => {
    const env = fixture(t, projection === 'detail' ? detail({artist_scope: descriptor}) : directory(top({artist_scope: descriptor})));
    await assert.rejects(projection === 'detail' ? env.providers.read(F.TOP, options()) : env.providers.list(options()));
  });
}
for (const mode of ['artist', 'family']) test('canonical Create serializes detached ' + mode + ' scope', async t => {
  const command = create({artist_scope: scope(mode)}), before = structuredClone(command), env = fixture(t, receipt(false));
  assert.deepEqual(await env.providers.execute('create', command, options()), receipt(false));
  assert.equal(env.calls[0].path, '/album-tops'); assert.equal(env.calls[0].request.method, 'POST');
  assert.deepEqual(env.calls[0].request.body, before); assert.deepEqual(command, before);
  assert.notStrictEqual(env.calls[0].request.body.artist_scope, command.artist_scope);
  command.artist_scope.mode = 'other'; assert.deepEqual(env.calls[0].request.body.artist_scope, scope(mode));
});
for (const variant of ['local', 'mixed']) test('scoped typed Create preserves ' + variant + ' selectors', async t => {
  const selections = variant === 'local' ? [local()] : [local(), pending()];
  const command = {...typed(selections), artist_scope: scope()}, before = structuredClone(command), env = fixture(t, receipt(true));
  assert.deepEqual(await env.providers.execute('create', command, options()), receipt(true));
  assert.deepEqual(env.calls[0].request.body, before); assert.deepEqual(command, before);
  command.selections[0].album_ref = F.B; command.artist_scope.root_artist_id = '1';
  assert.deepEqual(env.calls[0].request.body, before);
});
for (const descriptor of invalidScopes) test('malformed Create scope never requests', async t => {
  const env = fixture(t, {}, 0);
  await assert.rejects(env.providers.execute('create', create({artist_scope: descriptor}), options()));
});
for (const field of ['source_review', 'playlist_preview_ref']) test('scoped Create rejects ' + field + ' combination', async t => {
  const env = fixture(t, {}, 0);
  await assert.rejects(env.providers.execute('create', create({artist_scope: scope(), [field]: F.id(85)}), options()));
});
for (const action of ['save', 'add', 'copy', 'remove', 'reorder', 'delete', 'visibility']) {
  for (const descriptor of [null, scope()]) test(action + ' cannot change or clear scope ' + String(descriptor), async t => {
    const env = fixture(t, {}, 0);
    await assert.rejects(env.providers.execute(action, {top_ref: F.TOP, request_key: KEY, revision: '1', artist_scope: descriptor}, options()));
  });
}
for (const action of ['create', 'add']) test('ordinary typed all-local ' + action + ' remains rejected', async t => {
  const env = fixture(t, {}, 0), command = action === 'create' ? typed([local()]) :
    {top_ref: F.TOP, request_key: KEY, revision: '1', selections: [local()]};
  await assert.rejects(env.providers.execute(action, command, options()));
});
for (const hole of [0, 1, 2]) test('scoped typed Create rejects sparse position ' + hole, async t => {
  const selections = [local(), pending(), {kind: 'local_catalog', album_ref: F.B}]; delete selections[hole];
  const env = fixture(t, {}, 0);
  await assert.rejects(env.providers.execute('create', {...typed(selections), artist_scope: scope()}, options()));
});
for (const patch of [{draft_ref: undefined}, {draft_ref: '00000000-0000-0000-0000-000000000000'},
  {request_key: '00000000-0000-0000-0000-000000000000'}, {selections: []},
  {selections: [local(), local()]}, {selections: Array.from({length: 5001}, local)}]) {
  test('scoped typed Create preserves draft/key/selection validation', async t => {
    const env = fixture(t, {}, 0);
    await assert.rejects(env.providers.execute('create', {...typed([local()]), artist_scope: scope(), ...patch}, options()));
  });
}
for (const mode of ['artist', 'family']) for (const q of [undefined, '', '   ', '  100%_  ']) {
  test('unsaved scoped ' + mode + ' inventory reaches existing endpoint for ' + JSON.stringify(q), async t => {
    const env = fixture(t, page()), input = options({artistScope: scope(mode), ...(q === undefined ? {} : {q})});
    assert.deepEqual(await env.providers.listScopedAlbums(input), page());
    assert.deepEqual(query(env.calls[0]), {limit: '100', q: q?.trim() || '', root_artist_id: MAX, scope_mode: mode});
    assert.equal(env.calls.length, 1, 'Candidate listing never auto-admits or selects');
  });
}
test('saved scoped listing uses only immutable Top destination and opaque cursor', async t => {
  const env = fixture(t, page());
  assert.deepEqual(await env.providers.listScopedAlbums(options({topRef: F.TOP, cursor: 'old & cursor', q: ' x '})), page());
  assert.deepEqual(query(env.calls[0]), {limit: '100', cursor: 'old & cursor', q: 'x', top_ref: F.TOP});
});
const invalidLists = [{}, {topRef: 'bad'}, {artistScope: null}, {artistScope: undefined},
  {topRef: F.TOP, artistScope: scope()},
  ...[null, 1, 'x'.repeat(101), '\0', '\ud800', '\udfff'].map(q => ({artistScope: scope(), q})),
  ...['', 'x'.repeat(4097), false].map(cursor => ({artistScope: scope(), cursor})),
  ...invalidScopes.map(artistScope => ({artistScope}))];
for (const [index, input] of invalidLists.entries()) test('invalid scoped destination/query/cursor ' + index + ' never requests', async t => {
  const env = fixture(t, {}, 0); await assert.rejects(env.providers.listScopedAlbums(options(input)));
});
for (const reply of [{albums: [F.album(), F.album()], next_cursor: null}, {albums: [], next_cursor: ''},
  {albums: Array.from({length: 101}, (_, i) => F.album(i + 1)), next_cursor: null},
  {albums: [F.album(11, {local_album_id: 0})], next_cursor: null}]) {
  test('scoped listing keeps strict ordinary page validation', async t => {
    const env = fixture(t, reply); await assert.rejects(env.providers.listScopedAlbums(options({artistScope: scope()})));
  });
}
test('scoped candidate projection strips private fields without sorting or admitting', async t => {
  const reply = page(); reply.albums[0].path = '/PRIVATE'; reply.albums[0].can_play = true;
  const env = fixture(t, reply); assert.deepEqual(await env.providers.listScopedAlbums(options({artistScope: scope()})), page());
});
test('ordinary blank search stays request-free', async t => {
  const env = fixture(t, {}, 0);
  assert.deepEqual(await env.providers.searchAlbums(options({q: '  '})), {albums: [], next_cursor: null});
});
for (const mode of ['artist', 'family']) test('unsaved admission sends exact ' + mode + ' descriptor and album', async t => {
  const descriptor = scope(mode), env = fixture(t, {album_ref: F.A, path: '/PRIVATE'});
  assert.deepEqual(await env.providers.admitAlbum(11, options({artistScope: descriptor})), {album_ref: F.A});
  assert.equal(env.calls[0].path, '/album-top-catalog/inventory'); assert.equal(env.calls[0].request.method, 'POST');
  assert.deepEqual(env.calls[0].request.body, {album_id: 11, artist_scope: scope(mode)});
  assert.notStrictEqual(env.calls[0].request.body.artist_scope, descriptor);
  descriptor.mode = 'other'; assert.deepEqual(env.calls[0].request.body.artist_scope, scope(mode));
});
for (const saved of [false, true]) test('ordinary/saved admission retains exact existing route ' + saved, async t => {
  const env = fixture(t, {album_ref: F.A});
  await env.providers.admitAlbum(11, options(saved ? {topRef: F.TOP} : {}));
  assert.equal(env.calls[0].path, saved ? '/album-tops/' + F.TOP + '/catalog/inventory' : '/album-top-catalog/inventory');
  assert.deepEqual(env.calls[0].request.body, {album_id: 11});
});
for (const input of [{topRef: F.TOP, artistScope: scope()}, ...invalidScopes.map(artistScope => ({artistScope}))]) {
  test('invalid scoped admission rejects before any request', async t => {
    const env = fixture(t, {}, 0); await assert.rejects(env.providers.admitAlbum(11, options(input)));
  });
}
for (const operation of ['read', 'listScopedAlbums', 'admitAlbum']) for (const change of ['scope', 'context', 'dispose', 'abort']) {
  test(operation + ' suppresses late scoped result after ' + change, async t => {
    const gate = F.deferred(), env = fixture(t, () => gate.promise), controller = new AbortController();
    const input = options({signal: controller.signal, artistScope: scope()});
    const waiting = operation === 'read' ? env.providers.read(F.TOP, input) : operation === 'admitAlbum'
      ? env.providers.admitAlbum(11, input) : env.providers.listScopedAlbums(input);
    assert.equal(env.calls.length, 1);
    if (change === 'scope') env.deny(); else if (change === 'context') env.context('b'.repeat(64));
    else if (change === 'dispose') env.providers.dispose(); else controller.abort();
    gate.resolve(operation === 'read' ? detail({artist_scope: scope()}) : operation === 'admitAlbum' ? {album_ref: F.A} : page());
    await assert.rejects(waiting);
  });
}
for (const topRef of [null, undefined]) test('nullish topRef preserves explicit unsaved destination', async t => {
  const env = fixture(t, page());
  await env.providers.listScopedAlbums(options({topRef, artistScope: scope()}));
  assert.deepEqual(query(env.calls[0]), {limit: '100', q: '', root_artist_id: MAX, scope_mode: 'artist'});
});
for (const topRef of [null, undefined]) test('nullish topRef preserves explicit unsaved admission', async t => {
  const env = fixture(t, {album_ref: F.A});
  await env.providers.admitAlbum(11, options({topRef, artistScope: scope()}));
  assert.equal(env.calls[0].path, '/album-top-catalog/inventory');
  assert.deepEqual(env.calls[0].request.body, {album_id: 11, artist_scope: scope()});
});
for (const status of [401, 403, 409]) test('scoped listing propagates denial/conflict ' + status + ' without synthetic empty success', async t => {
  const cause = Object.assign(new Error('Denied scoped inventory'), {status});
  const env = fixture(t, () => {throw cause;});
  await assert.rejects(env.providers.listScopedAlbums(options({artistScope: scope()})), error => error === cause);
});
