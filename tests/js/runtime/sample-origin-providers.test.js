'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./sample-origin-fixtures.cjs');
let create;
test.before(async () => {({createPlaylistBackendProviders: create} = await import('../../../music_app/static/js/playlists/backend-providers.mjs'));});
function fixture(handler) {
  const calls = []; let listener, context = 'context:original';
  const transport = {context: () => context, subscribe(fn) {listener = fn; return () => {};},
    async request(path, input = {}) {
      calls.push({path, method: input.method || 'GET', expected: input.expected, body: input.body && F.plain(input.body)});
      const value = await handler?.(path, input); if (value !== undefined) return value;
      if (path.endsWith('/representatives')) return F.v2Representatives({...input.body, scopeKey: 'sample:scope'});
      if (path === '/playlists/creation-source/sample') return F.v2Capture({...input.body, scopeKey: 'sample:scope'});
      throw new Error(`Unexpected request ${path}`);
    }};
  return {calls, providers: create({transport, runtime: {acceptsPrivateScope: key => key === 'sample:scope'}}),
    input: kind => ({scopeKey: 'sample:scope', origin: F.origins[kind](), options: F.options(), request_key: F.id(90), random_order: [...F.refs]}),
    clear() {context = 'context:replacement'; listener?.();}};
}
for (const kind of Object.keys(F.origins)) test(`${kind}: existing dedicated providers transport closed typed union without fabricated parent`, async t => {
  const h = fixture(); t.after(() => h.providers.dispose()); const input = h.input(kind);
  const {request_key, random_order, ...acquisition} = input;
  const acquired = await h.providers.readSamplePlaylistRepresentatives(acquisition);
  const result = await h.providers.captureSamplePlaylist(input);
  assert.deepEqual(h.calls, [{path: '/playlists/creation-source/sample/representatives', method: 'POST', expected: 'context:original',
    body: {origin: input.origin, options: input.options}}, {path: '/playlists/creation-source/sample', method: 'POST', expected: 'context:original',
    body: {origin: input.origin, options: input.options, request_key, random_order}}]);
  assert.deepEqual(acquired.data.origin, input.origin); assert.equal(acquired.data.library_ref, '5');
  assert.equal(acquired.data.actor_scope, undefined); assert.equal(result.data.actor_scope, undefined);
  assert.equal(result.data.source.kind, 'library'); assert.deepEqual(result.data.allowed_actions,
    {can_read: true, can_use_for_playlist: false, can_play: false});
});
const malformed = [
  ['unknown kind', () => ({kind: 'playlist', playlist_ref: F.id(501), revision: '1'})],
  ['saved Top numeric revision', () => ({...F.origins.album_top(), revision: 1})],
  ['saved Top noncanonical UUID', () => ({...F.origins.album_top(), top_ref: 'not-a-top'})],
  ['saved Top revision overflow', () => ({...F.origins.album_top(), revision: '9223372036854775808'})],
  ['saved Top invented members', () => ({...F.origins.album_top(), selections: []})],
  ['parentless catalog selector', () => ({kind: 'album_set', selections: [{kind: 'catalog', album_ref: F.id(20)}]})],
  ['local numeric identity', () => ({kind: 'album_set', selections: [{kind: 'local', inventory_album_ref: 9007199254740992}]})],
  ['local leading zero', () => ({kind: 'album_set', selections: [{kind: 'local', inventory_album_ref: 'inventory-album:5:01'}]})],
  ['local overflow', () => ({kind: 'album_set', selections: [{kind: 'local', inventory_album_ref: 'inventory-album:5:9223372036854775808'}]})],
  ['local track ref', () => ({kind: 'album_set', selections: [{kind: 'local', inventory_album_ref: F.refs[0]}]})],
  ['duplicate local selector', () => ({kind: 'album_set', selections: [0, 1].map(() => ({kind: 'local', inventory_album_ref: F.albumRefs[0]}))})],
  ['unavailable metadata', () => ({kind: 'album_set', selections: [{kind: 'unavailable', title: 'Do not transmit remote metadata'}]})],
  ['invented set revision', () => ({...F.origins.album_set(), revision: '1'})],
  ['details album identity', () => ({...F.origins.album_details(), inventory_album_ref: F.albumRefs[0]})],
  ['details numeric identity', () => ({kind: 'album_details', track_refs: [9007199254740992]})],
  ['details duplicate ref', () => ({kind: 'album_details', track_refs: [F.refs[0], F.refs[0]]})],
  ['details leading zero', () => ({kind: 'album_details', track_refs: ['inventory-track:05:3']})],
  ['details overflow', () => ({kind: 'album_details', track_refs: ['inventory-track:5:9223372036854775808']})],
  ['details album ref', () => ({kind: 'album_details', track_refs: [F.albumRefs[0]]})],
  ['details metadata', () => ({...F.origins.album_details(), title: 'Not source authority'})],
  ['5001 selectors', () => ({kind: 'album_set', selections: Array.from({length: 5001}, () => ({kind: 'unavailable'}))})],
  ['5001 tracks', () => ({kind: 'album_details', track_refs: Array.from({length: 5001}, (_, n) => `inventory-track:5:${n + 1}`)})],
];
for (const [name, origin] of malformed) for (const method of ['readSamplePlaylistRepresentatives', 'captureSamplePlaylist'])
  test(`${method}: ${name} rejects before authenticated transport`, async t => {
    const h = fixture(); t.after(() => h.providers.dispose()); const input = {...h.input('album_set'), origin: origin()};
    if (method === 'readSamplePlaylistRepresentatives') {delete input.request_key; delete input.random_order;}
    await assert.rejects(h.providers[method](input)); assert.equal(h.calls.length, 0);
  });
for (const extra of [{playlist_ref: F.id(70)}, {revision: '3'}, {playlist_ref: F.id(70), revision: '3'}])
  test(`mixed v1/v2 capture input rejects ${JSON.stringify(extra)}`, async t => {
    const h = fixture(); t.after(() => h.providers.dispose());
    await assert.rejects(h.providers.captureSamplePlaylist({...h.input('album_top'), ...extra})); assert.equal(h.calls.length, 0);
  });
test('repeated unavailable placeholders and quota5001 are valid and preserve indexes without numeric-ref conversion', async t => {
  const h = fixture(); t.after(() => h.providers.dispose());
  const input = {...h.input('album_set'), origin: {kind: 'album_set', selections: [{kind: 'unavailable'}, {kind: 'local',
    inventory_album_ref: F.albumRefs[1]}, {kind: 'unavailable'}]}, options: F.options('most_listened', {songs_per_group: 5001}), random_order: null};
  await h.providers.captureSamplePlaylist(input); assert.deepEqual(h.calls[0].body.origin, input.origin);
  assert.equal(h.calls[0].body.options.songs_per_group, 5001); assert.equal(h.calls[0].body.random_order, null);
});
for (const mismatch of ['playlist_kind', 'activity_kind', 'other_protocol', 'wrong_ref', 'wrong_library'])
  test(`typed receipt rejects ${mismatch} while v1 kind contract stays closed`, async t => {
    const h = fixture((_path, input) => {
      const value = F.v2Capture({...input.body, scopeKey: 'sample:scope'});
      if (mismatch === 'playlist_kind') value.data.source.kind = 'playlist';
      else if (mismatch === 'activity_kind') value.data.source.kind = 'activity';
      else if (mismatch === 'other_protocol') value.data.source_protocol = 'library_selection_v1';
      else if (mismatch === 'wrong_ref') value.data.source.ref = F.id(99);
      else value.data.actor_scope.library_id = 6; return value;
    }); t.after(() => h.providers.dispose());
    if (mismatch === 'wrong_library') {
      // Establish authenticated actor using an accepted acquisition, not a caller actor field.
      const original = h.providers; original.dispose();
      const other = fixture((path, input) => path.endsWith('/representatives') ? F.v2Representatives({...input.body, scopeKey: 'sample:scope'})
        : F.v2Capture({...input.body, scopeKey: 'sample:scope'}, {actor_scope: {account_id: 4, library_id: 6}}));
      t.after(() => other.providers.dispose()); const data = other.input('album_set');
      const {request_key, random_order, ...acquisition} = data;
      await other.providers.readSamplePlaylistRepresentatives(acquisition); await assert.rejects(other.providers.captureSamplePlaylist(data));
    } else await assert.rejects(h.providers.captureSamplePlaylist(h.input('album_set')));
  });
test('transport identity replacement retires a typed receipt even when the network returns successfully', async t => {
  const waiting = F.deferred(), entered = F.deferred(); let body;
  const h = fixture((_path, input) => {body = input.body; entered.resolve(); return waiting.promise;}); t.after(() => h.providers.dispose());
  const result = h.providers.captureSamplePlaylist(h.input('album_details'));
  await Promise.race([entered.promise, result.then(() => {throw new Error('Missing transport boundary');})]);
  h.clear(); waiting.resolve(F.v2Capture({...body, scopeKey: 'sample:scope'})); await assert.rejects(result); assert.equal(h.calls.length, 1);
});
function saveInput(source) {return {scopeKey: 'sample:scope', source, source_protocol: F.PROTOCOL, mode: 'ordinary',
  entry_refs: [F.id(11), F.id(12), F.id(13)], title: 'Manual Sample', description: '', request_key: F.id(91)};}
test('typed receipt Save uses the actual shared ordinary provider and exact complete entry order', async t => {
  const h = fixture((path, input) => path === '/playlists' ? {status: 'ready', data: {ok: true, action: 'create',
    request_key: input.body.request_key, playlist_id: F.id(80), revision: '1', changed: true, actor_scope: {account_id: 4, library_id: 5}}} : undefined);
  t.after(() => h.providers.dispose()); const source = await h.providers.captureSamplePlaylist(h.input('album_top'));
  const command = saveInput(source.data.source); await h.providers.createPlaylistFromSelection(command);
  const {scopeKey, ...wire} = command;
  assert.equal(h.calls[1].path, '/playlists'); assert.deepEqual(h.calls[1].body, wire); assert.equal(h.calls[1].body.source.kind, 'library');
});
test('typed Sample known source cannot be reinterpreted as generic selection or partially saved', async t => {
  const h = fixture(); t.after(() => h.providers.dispose()); const source = await h.providers.captureSamplePlaylist(h.input('album_set'));
  const command = saveInput(source.data.source);
  for (const patch of [{entry_refs: [F.id(11)]}, {entry_refs: [F.id(13), F.id(12), F.id(11)]},
    {source_protocol: 'library_selection_v1'}, {recipe: {}}, {mix_playback_order: 'random'}]) {
    assert.throws(() => h.providers.createPlaylistFromSelection({...command, ...patch}));
  }
  assert.equal(h.calls.length, 1);
});
test('generic source reader stays closed even to a previously admitted library Sample receipt', async t => {
  const h = fixture(); t.after(() => h.providers.dispose()); const source = await h.providers.captureSamplePlaylist(h.input('album_set'));
  const result = await h.providers.readPlaylistCreationSource(saveInput(source.data.source));
  assert.equal(result.status, 'unavailable'); assert.equal(h.calls.length, 1);
});
test('typed capture lookup remains GET-only and retains library classification without parent or recapture', async t => {
  const h = fixture((path, input) => path.startsWith('/playlists/creation-source/sample?')
    ? F.v2Capture({request_key: F.id(90), scopeKey: 'sample:scope', options: F.options()}) : undefined);
  t.after(() => h.providers.dispose()); await h.providers.captureSamplePlaylist(h.input('album_details'));
  const recovered = await h.providers.readSamplePlaylist({scopeKey: 'sample:scope', request_key: F.id(90)});
  assert.equal(recovered.data.source.kind, 'library'); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].method, 'GET');
  assert.deepEqual([...new URL(h.calls[1].path, 'https://fixture.test').searchParams], [['request_key', F.id(90)]]);
});
test('typed unknown Save remains owned by the shared operation ledger and never allocates a replacement write', async t => {
  let writes = 0, committed = false;
  const h = fixture(path => {
    if (path === '/playlists') {writes++; throw new Error('response lost');}
    if (path === `/playlists/operations/${F.id(91)}`) return committed ? {status: 'committed', receipt: {ok: true, action: 'create',
      request_key: F.id(91), playlist_id: F.id(80), revision: '1', changed: true, actor_scope: {account_id: 4, library_id: 5}}} : {status: 'unknown'};
  }); t.after(() => h.providers.dispose()); const captured = await h.providers.captureSamplePlaylist(h.input('album_top'));
  await assert.rejects(h.providers.createPlaylistFromSelection(saveInput(captured.data.source)), {status: 'unknown'});
  assert.equal(h.providers.hasPendingPlaylistOperation({scopeKey: 'sample:scope', action: 'create'}), true);
  await assert.rejects(h.providers.captureSamplePlaylist({...h.input('album_details'), request_key: F.id(92)}));
  assert.equal(h.calls.filter(call => call.path === `/playlists/operations/${F.id(91)}`).length, 1,
    'automatic reconciliation observes the unresolved original operation');
  committed = true;
  const saved = await h.providers.recoverPlaylistCreation({scopeKey: 'sample:scope'});
  assert.equal(saved.playlist_id, F.id(80)); assert.equal(writes, 1); assert.equal(h.calls.at(-1).path, `/playlists/operations/${F.id(91)}`);
  assert.equal(saved.request_key, F.id(91));
  assert.equal(h.providers.hasPendingPlaylistOperation({scopeKey: 'sample:scope', action: 'create'}), false);
});
