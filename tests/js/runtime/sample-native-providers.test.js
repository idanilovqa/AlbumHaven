'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {id, plain, deferred, PROTOCOL, parent, options, refs, captured, captureResult, readResult, representatives} = require('./sample-native-fixtures.cjs');
let create;
test.before(async () => {({createPlaylistBackendProviders: create} = await import('../../../music_app/static/js/playlists/backend-providers.mjs'));});
function fixture(handler) {
  let scopeKey = 'sample:scope', context = 'context:original', listener;
  const calls = [], transport = {context: () => context, subscribe(fn) {listener = fn; return () => {listener = null;};},
    async request(path, input = {}) {calls.push({path, method: input.method || 'GET', expected: input.expected, body: input.body && plain(input.body)});
      const override = await handler?.(path, input); if (override !== undefined) return override;
      if (path === '/playlists/creation-source/sample/representatives') return representatives(scopeKey);
      if (path === '/playlists/creation-source/sample' && input.method === 'POST') return captureResult({...input.body, scopeKey});
      if (path.startsWith('/playlists/creation-source/sample?')) return readResult({scopeKey,
        ...Object.fromEntries(new URL(path, 'https://fixture.test').searchParams)});
      if (path === '/playlists') return {status: 'ready', data: {ok: true, action: 'create', request_key: input.body.request_key,
        playlist_id: id(80), revision: '1', changed: true, actor_scope: {account_id: 4, library_id: 5}}};
      throw new Error(`Unexpected path ${path}`);
    }};
  const providers = create({transport, runtime: {acceptsPrivateScope: key => key === scopeKey}});
  return {providers, calls, input: () => ({scopeKey, playlist_ref: parent().playlist_ref, revision: '3', options: options()}),
    clear() {context = 'context:replacement'; listener?.();}, navigate() {scopeKey = 'sample:remount';}};
}

test('Sample acquisition/capture use exact dedicated routes, inventory strings and authenticated transport context', async t => {
  const h = fixture(); t.after(() => h.providers.dispose());
  await h.providers.readSamplePlaylistRepresentatives(h.input());
  const result = await h.providers.captureSamplePlaylist({...h.input(), request_key: id(90), random_order: [...refs]});
  assert.deepEqual(h.calls, [{path: '/playlists/creation-source/sample/representatives', method: 'POST', expected: 'context:original', body: {
    playlist_ref: id(70), revision: '3', options: options()}}, {path: '/playlists/creation-source/sample', method: 'POST', expected: 'context:original', body: {
    playlist_ref: id(70), revision: '3', options: options(), request_key: id(90), random_order: refs}}]);
  assert.equal(result.data.scopeKey, 'sample:scope'); assert.equal(result.data.source.kind, 'playlist');
  assert.equal(result.data.source.ref, id(90));
  assert.equal(result.data.actor_scope, undefined); assert.equal(result.data.allowed_actions.can_use_for_playlist, false);
  assert.deepEqual(result.data.native_actions, {can_save: true, can_play: true});
});

test('Sample tuple and key recovery are distinct GET-only lookup forms', async t => {
  const h = fixture(); t.after(() => h.providers.dispose());
  const tupleRead = await h.providers.readSamplePlaylist({scopeKey: h.input().scopeKey, source_ref: id(1), source_revision: id(2)});
  const recovery = await h.providers.readSamplePlaylist({scopeKey: h.input().scopeKey, request_key: id(90)});
  assert.deepEqual(tupleRead.data.source, {kind: 'playlist', ref: id(1), revision: id(2)});
  assert.deepEqual(recovery.data.source, {kind: 'playlist', ref: id(90), revision: id(2)});
  assert.equal(h.calls.length, 2);
  const urls = h.calls.map(call => new URL(call.path, 'https://fixture.test'));
  assert.ok(h.calls.every(call => call.method === 'GET' && call.body === undefined));
  assert.equal(urls[0].pathname, '/playlists/creation-source/sample');
  assert.deepEqual([...urls[0].searchParams], [['source_ref', id(1)], ['source_revision', id(2)]]);
  assert.deepEqual([...urls[1].searchParams], [['request_key', id(90)]]);
  await assert.rejects(h.providers.readSamplePlaylist({scopeKey: h.input().scopeKey, source_ref: id(1), source_revision: id(2), request_key: id(90)}));
  assert.equal(h.calls.length, 2);
});

for (const change of ['source', 'wrong_valid_ref', 'kind', 'protocol', 'entry_duplicate']) test(`Sample transport rejects ${change} acknowledgment without widening generic source admission`, async t => {
  const h = fixture((_path, input) => {const result = captureResult({...input.body, scopeKey: 'sample:scope'});
    if (change === 'source') result.data.source.ref = 'not-a-uuid';
    else if (change === 'wrong_valid_ref') result.data.source.ref = id(99);
    else if (change === 'kind') result.data.source.kind = 'library';
    else if (change === 'protocol') result.data.source_protocol = 'library_selection_v1';
    else if (change === 'entry_duplicate') result.data.entries.push(result.data.entries[0]);
    return result;
  }); t.after(() => h.providers.dispose());
  await assert.rejects(h.providers.captureSamplePlaylist({...h.input(), request_key: id(90), random_order: refs}));
});

test('representative actor is fenced against a later capture response from another library', async t => {
  const h = fixture((path, input) => path.endsWith('/representatives') ? representatives('sample:scope') : captureResult({...input.body, scopeKey: 'sample:scope'}, {actor_scope: {account_id: 4, library_id: 6}}));
  t.after(() => h.providers.dispose()); await h.providers.readSamplePlaylistRepresentatives(h.input());
  await assert.rejects(h.providers.captureSamplePlaylist({...h.input(), request_key: id(90), random_order: refs}));
});

test('Sample Save goes only through ordinary /playlists and retains an unknown original command across provider remount', async t => {
  let committed = false, writes = 0;
  const saved = {ok: true, action: 'create', request_key: id(91), playlist_id: id(80), revision: '1', changed: true, actor_scope: {account_id: 4, library_id: 5}};
  const h = fixture(path => {
    if (path === '/playlists') {writes++; throw new Error('Lost response');}
    if (path === `/playlists/operations/${id(91)}`) return committed ? {status: 'committed', receipt: saved} : {status: 'unknown'};
  }); t.after(() => h.providers.dispose());
  const source = await h.providers.captureSamplePlaylist({...h.input(), request_key: id(90), random_order: refs});
  const body = {scopeKey: h.input().scopeKey, source: source.data.source, source_protocol: PROTOCOL, mode: 'ordinary',
    title: 'Sample', description: '', request_key: id(91), entry_refs: [id(11), id(12), id(13)]};
  await assert.rejects(h.providers.createPlaylistFromSelection(body), {status: 'unknown'});
  const posted = h.calls.find(call => call.path === '/playlists').body;
  const {scopeKey: omittedScope, ...wireBody} = body; assert.deepEqual(posted, wireBody);
  h.navigate(); committed = true;
  const result = await h.providers.recoverPlaylistCreation({scopeKey: h.input().scopeKey});
  assert.equal(result.playlist_id, id(80)); assert.equal(writes, 1);
  assert.equal(h.calls.at(-1).path, `/playlists/operations/${id(91)}`);
});

test('transport identity clear invalidates pending receipt response and cannot recapture it', async t => {
  const entered = deferred(), waiting = deferred();
  const h = fixture(() => {entered.resolve(); return waiting.promise;}); t.after(() => h.providers.dispose());
  const result = h.providers.captureSamplePlaylist({...h.input(), request_key: id(90), random_order: refs});
  await entered.promise; h.clear(); waiting.resolve(captureResult({scopeKey: 'sample:scope', request_key: id(90)}));
  await assert.rejects(result); assert.equal(h.calls.length, 1);
});

test('key-only recovery rejects a valid UUID belonging to another retained capture', async t => {
  const h = fixture(() => captured('sample:scope', {source: {kind: 'playlist', ref: id(99), revision: id(2)}}));
  t.after(() => h.providers.dispose());
  await assert.rejects(h.providers.readSamplePlaylist({scopeKey: h.input().scopeKey, request_key: id(90)}));
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].method, 'GET');
});

test('provider transports explicit quota5001 unchanged rather than imposing the member-array bound', async t => {
  const h = fixture((path, input) => {
    if (path.endsWith('/representatives')) return representatives('sample:scope', {options: input.body.options});
  }); t.after(() => h.providers.dispose());
  const explicit = {...h.input(), options: options('random', {songs_per_group: 5001})};
  await h.providers.readSamplePlaylistRepresentatives(explicit);
  const result = await h.providers.captureSamplePlaylist({...explicit, request_key: id(90), random_order: refs});
  assert.equal(h.calls.length, 2); assert.ok(h.calls.every(call => call.body.options.songs_per_group === 5001));
  assert.equal(result.data.options.songs_per_group, 5001); assert.equal(result.data.source.ref, id(90));
});
