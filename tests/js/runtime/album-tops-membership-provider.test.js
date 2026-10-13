const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createAlbumTopBackendProviders;
test.before(async () => {({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));});
const CONTEXT = 'a'.repeat(64), options = () => ({scopeKey: F.SCOPE, signal: new AbortController().signal});
const draftItems = () => [{item_ref: F.IA, album_ref: F.A, selected_local_album_id: 11, selected_source_ref: F.SOURCE}];
const preview = (patch = {}) => ({top_ref: F.TOP, revision: '7', evidence_revision: 'b'.repeat(64), items: [{...draftItems()[0], title: 'Album', artist: 'Artist', year: 2001, track_count: 3}], ...patch});
function fixture(t, reply) {
  let context = CONTEXT, allowed = true; const calls = [];
  const transport = {context: () => context, async request(path, request) {calls.push({path, request});
    const data = typeof reply === 'function' ? await reply(path, request) : reply;
    return {status: 'ready', context_ref: CONTEXT, data};}};
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: scope => allowed && scope === F.SCOPE});
  t.after(() => providers.dispose());
  return {providers, calls, context(value) {context = value;}, deny() {allowed = false;}};
}

test('query-first search uses only the bounded context-owned metadata endpoint', async t => {
  const row = {...F.album(), path: '/private/music', tracks: [{path: '/secret'}], media_url: 'private://media', source_name: 'Hidden drive'};
  const {providers, calls} = fixture(t, {albums: [row], next_cursor: 'opaque'});
  assert.deepEqual(await providers.searchAlbums({...options(), q: '   '}), {albums: [], next_cursor: null}); assert.deepEqual(calls, []);
  const result = await providers.searchAlbums({...options(), q: '  100%_  ', cursor: 'previous', topRef: F.TOP});
  const url = new URL(calls[0].path, 'https://example.test');
  assert.equal(url.pathname, '/album-top-catalog/search');
  assert.deepEqual(Object.fromEntries(url.searchParams), {limit: '100', q: '100%_', cursor: 'previous', top_ref: F.TOP});
  assert.equal(calls[0].request.expected, CONTEXT); assert.ok(calls[0].request.signal instanceof AbortSignal);
  assert.deepEqual(result, {albums: [F.album()], next_cursor: 'opaque'});
});

for (const albums of [null, Array.from({length: 101}, (_, i) => F.album(i + 20)), [F.album(), F.album()],
  [F.album(11, {local_album_id: 0})], [F.album(11, {local_album_id: '11'})], [F.album(11, {local_album_id: Number.MAX_SAFE_INTEGER + 1})],
  [F.album(11, {album_ref: 'not-an-id'})], [F.album(11, {title: null})], [F.album(11, {artist: []})], [F.album(11, {year: '2001'})]]) {
  test('malformed or overlong album page cannot become selectable metadata', async t => {
    const {providers} = fixture(t, {albums, next_cursor: null}); await assert.rejects(providers.searchAlbums({...options(), q: 'x'}));
  });
}

test('canonical aliases are valid local search rows but duplicate local identities are not', async t => {
  const {providers} = fixture(t, {albums: [F.album(11), F.album(12, {album_ref: F.A}), F.album(13, {album_ref: null})], next_cursor: null});
  const result = await providers.searchAlbums({...options(), q: 'x'}); assert.equal(result.albums.length, 3);
});

for (const value of [{q: 'x'.repeat(101)}, {q: 1}, {q: 'x', topRef: 'bad'}, {q: 'x', cursor: ''}, {q: 'x', cursor: 'x'.repeat(4097)}]) {
  test('invalid search identity or bound fails before any network request', async t => {
    const {providers, calls} = fixture(t, {}); await assert.rejects(providers.searchAlbums({...options(), ...value})); assert.deepEqual(calls, []);
  });
}

for (const change of ['scope', 'context', 'dispose', 'abort']) test(`${change} change prevents late search data exposure`, async t => {
  const gate = F.deferred(), env = fixture(t, () => gate.promise), abort = new AbortController();
  const waiting = env.providers.searchAlbums({scopeKey: F.SCOPE, signal: abort.signal, q: 'x'});
  if (change === 'scope') env.deny(); else if (change === 'context') env.context('b'.repeat(64)); else if (change === 'dispose') env.providers.dispose(); else abort.abort();
  gate.resolve({albums: [F.album()], next_cursor: null}); await assert.rejects(waiting); assert.equal(env.calls.length, 1);
});

test('admission retains legacy canonical-only response and binds edit purpose without actor claims', async t => {
  const {providers, calls} = fixture(t, {album_ref: F.A, title: 'Ignore extra', source_ref: F.SOURCE});
  assert.deepEqual(await providers.admitAlbum(11, {...options(), topRef: F.TOP}), {album_ref: F.A});
  assert.equal(calls[0].path, '/album-tops/' + F.TOP + '/catalog/inventory'); assert.equal(calls[0].request.method, 'POST');
  assert.deepEqual(calls[0].request.body, {album_id: 11});
  await providers.admitAlbum(11, options()); assert.deepEqual(calls[1].request.body, {album_id: 11});
});

for (const id of [0, -1, 1.5, '11', true, Number.MAX_SAFE_INTEGER + 1]) test('invalid local admission identity never reaches the server', async t => {
  const {providers, calls} = fixture(t, {album_ref: F.A}); await assert.rejects(providers.admitAlbum(id, options())); assert.deepEqual(calls, []);
});

test('publication preview validates the full ordered identity vector and strips unauthorized fields', async t => {
  const reply = preview(); reply.items[0].path = '/private'; reply.items[0].tracks = [{path: '/private'}]; reply.share_token = 'never render';
  const {providers, calls} = fixture(t, reply), payload = {revision: '7', items: draftItems()};
  assert.deepEqual(await providers.preview(F.TOP, payload, options()), preview());
  assert.equal(calls[0].path, `/album-tops/${F.TOP}/publication-preview`); assert.equal(calls[0].request.method, 'POST'); assert.deepEqual(calls[0].request.body, payload);
});

for (const patch of [{top_ref: F.OTHER}, {revision: '8'}, {evidence_revision: 'not-evidence'}, {items: []},
  {items: [{...preview().items[0], album_ref: F.B}]}, {items: [{...preview().items[0], item_ref: F.IB}]},
  {items: [{...preview().items[0], selected_source_ref: F.id(99)}]}, {items: [{...preview().items[0], selected_local_album_id: 12}]},
  {items: [preview().items[0], preview().items[0]]}, {items: [{...preview().items[0], track_count: -1}]}]) {
  test('mismatched preview evidence never authorizes Save', async t => {
    const {providers} = fixture(t, preview(patch)); await assert.rejects(providers.preview(F.TOP, {revision: '7', items: draftItems()}, options()));
  });
}

function wireDetail() {
  return {top_ref: F.TOP, revision: '7', title: 'Top', description: '', visibility: 'private', allowed_actions: {[F.BROWSE]: true, can_edit: true, can_add: true, can_remove: true, can_reorder: true},
    items: [{ref: F.IA, catalog_ref: F.A, title: 'Album', artist_display: 'Artist', release_year: 2001, original_position: 4, curator_position: 1}],
    edit_draft: {items: draftItems(), publication_preview_required: true}};
}
test('detail editing projection keeps exact detached source bindings without general server data', async t => {
  const reply = wireDetail(); reply.edit_draft.items[0].path = '/private'; reply.edit_draft.secret = 'private';
  const {providers} = fixture(t, reply); const result = await providers.read(F.TOP, options());
  assert.deepEqual(result.edit_draft, {items: draftItems(), publication_preview_required: true});
  assert.equal(JSON.stringify(result).includes('/private'), false); assert.equal(JSON.stringify(result).includes('secret'), false);
});

for (const change of ['missing', 'duplicate', 'foreign', 'source-half', 'flag']) test(`invalid edit projection ${change} cannot authorize a draft`, async t => {
  const reply = wireDetail();
  if (change === 'missing') reply.edit_draft.items = [];
  else if (change === 'duplicate') reply.edit_draft.items.push({...reply.edit_draft.items[0]});
  else if (change === 'foreign') reply.edit_draft.items[0].album_ref = F.B;
  else if (change === 'source-half') delete reply.edit_draft.items[0].selected_local_album_id;
  else reply.edit_draft.publication_preview_required = 'true';
  const {providers} = fixture(t, reply); await assert.rejects(providers.read(F.TOP, options()));
});
