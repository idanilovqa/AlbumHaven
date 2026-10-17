'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {id, SCOPE, ACTOR, recipe, capture, receipt, deferred} = require('./library-mix-fixtures.cjs');
let create;
test.before(async () => {({createPlaylistBackendProviders: create} = await import('../../../music_app/static/js/playlists/backend-providers.mjs'));});
function fixture(handler = () => undefined) {
  const calls = []; let context = 'context:mix', scope = SCOPE, changed;
  const transport = {context: () => context, subscribe(listener) {changed = listener; return () => {changed = null;};},
    query(path, values) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(values)) if (value != null) params.set(key, value);
      return `${path}?${params}`;
    },
    async request(path, options = {}) {
      calls.push({path, ...options, ...(options.body ? {body: structuredClone(options.body)} : {})}); const response = await handler(path, options);
      if (response !== undefined) return response;
      if (path === '/playlists/creation-source/library-mix') return capture();
      if (path === '/playlists/creation-source/current') return {status: 'ready', data: {
        ...capture().data, source_protocol: 'library_selection_v1', page_size: 100, max_selected_entries: 5000, max_command_bytes: 524288}};
      if (path === '/playlists') return receipt(options.body.request_key);
      throw new Error(`Unexpected request ${path}`);
    }};
  const providers = create({transport, runtime: {snapshot: () => ({scopeKey: scope})}});
  return {providers, calls, rotate() {context = 'context:next'; changed?.();}, retire() {scope = 'scope:next';}};
}
const options = () => ({scopeKey: SCOPE, recipe: recipe(), signal: new AbortController().signal});
const command = (data, patch = {}) => ({scopeKey: SCOPE, source: data.source, source_protocol: data.source_protocol,
  mode: 'ordinary', title: 'Captured mix', description: '', entry_refs: data.entries.map(row => row.entry_ref),
  mix_playback_order: 'shuffle', request_key: id(90), ...patch});

test('provider uses one bounded authenticated capture and redacts actor, internal context, diagnostics and inventory evidence', async () => {
  const h = fixture(path => path.endsWith('/library-mix') ? capture({context_ref: 'private-context', capture_ref: id(99),
    diagnostics: {private: 'provider SQL'}, entries: capture().data.entries.map(row => ({...row, inventory_track_ref: 'inventory-track:5:7'}))}) : undefined);
  const input = options(), value = await h.providers.beginLibraryMix(input);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, '/playlists/creation-source/library-mix');
  assert.equal(h.calls[0].method, 'POST'); assert.equal(h.calls[0].expected, 'context:mix');
  assert.equal(h.calls[0].signal, input.signal); assert.deepEqual(h.calls[0].body, recipe());
  assert.equal(value.data.scopeKey, SCOPE); assert.equal(value.data.source_protocol, 'library_mix_selection_v1');
  for (const key of ['actor_scope', 'context_ref', 'capture_ref', 'diagnostics']) assert.equal(Object.hasOwn(value.data, key), false);
  assert.equal(Object.hasOwn(value.data.entries[0], 'inventory_track_ref'), false);
});

test('capture enforces protocol, exact source kind/revision, completeness, boolean grants and stable authenticated actor', async () => {
  for (const patch of [{source_protocol: 'library_selection_v1'}, {mode: 'missing'},
    {source: {kind: 'playlist', ref: id(1), revision: id(2)}}, {source: {kind: 'library', ref: id(1), revision: '3'}},
    {source: {kind: 'library', ref: 'bad', revision: id(2)}}, {entries_complete: false}, {entries: null},
    {allowed_actions: {can_read: true, can_use_for_playlist: 1}}, {actor_scope: {account_id: 0, library_id: 5}}]) {
    const h = fixture(() => capture(patch)); await assert.rejects(h.providers.beginLibraryMix(options()));
    assert.equal(h.calls.length, 1);
  }
  let account = ACTOR.account_id;
  const h = fixture(() => capture({actor_scope: {...ACTOR, account_id: account}}));
  await h.providers.beginLibraryMix(options()); account++;
  await assert.rejects(h.providers.beginLibraryMix(options()), {status: 403});
});

test('late captures cannot cross a transport rotation, UI scope replacement or abort', async () => {
  for (const invalidate of [(h, input) => h.rotate(), (h, input) => h.retire(), (_h, input) => input.abort.abort()]) {
    const wait = deferred(), entered = deferred(), h = fixture(() => {entered.resolve(); return wait.promise;});
    const input = options(); input.abort = new AbortController(); input.signal = input.abort.signal;
    const pending = h.providers.beginLibraryMix(input); await entered.promise;
    invalidate(h, input); wait.resolve(capture()); await assert.rejects(pending, {name: 'AbortError'});
    assert.equal(h.calls.length, 1);
  }
});

test('save accepts only the captured protocol/source and includes mix order only for Library Mix', async () => {
  const h = fixture(), value = await h.providers.beginLibraryMix(options());
  for (const patch of [{source: {...value.data.source, ref: id(22)}}, {source: {...value.data.source, revision: id(22)}},
    {source_protocol: 'library_selection_v1'}, {mode: 'missing'}]) {
    await assert.rejects(async () => h.providers.createPlaylistFromSelection(command(value.data, patch)), {status: 409});
  }
  assert.equal(h.calls.filter(x => x.path === '/playlists').length, 0);
  const saved = await h.providers.createPlaylistFromSelection(command(value.data));
  assert.equal(saved.data.playlist_id, id(80)); assert.equal(saved.data.actor_scope, undefined);
  const body = h.calls.at(-1).body;
  assert.deepEqual(body, {source_protocol: 'library_mix_selection_v1', mode: 'ordinary', source: value.data.source,
    title: 'Captured mix', description: '', entry_refs: [id(11), id(12), id(13)], mix_playback_order: 'shuffle', request_key: id(90)});
  const ordinary = fixture(), descriptor = await ordinary.providers.beginPlaylistCreationSource({scopeKey: SCOPE});
  await ordinary.providers.createPlaylistFromSelection(command({...capture().data, source: descriptor, source_protocol: 'library_selection_v1'}));
  assert.equal(Object.hasOwn(ordinary.calls.at(-1).body, 'mix_playback_order'), false);
});

test('lost save retries only original bytes/key after authoritative unknown check and prevents a second capture', async () => {
  let writes = 0;
  const h = fixture((path, options) => {
    if (path === '/playlists') {if (++writes === 1) throw new Error('Response lost'); return receipt(options.body.request_key);}
    if (path.startsWith('/playlists/operations/')) return {status: 'unknown'};
  });
  const value = await h.providers.beginLibraryMix(options()), original = command(value.data);
  await assert.rejects(h.providers.createPlaylistFromSelection(original), /still unknown/);
  assert.equal(h.providers.hasPendingPlaylistOperation({scopeKey: SCOPE, action: 'create'}), true);
  await assert.rejects(h.providers.beginLibraryMix(options()), /still unknown/);
  assert.equal(h.calls.filter(x => x.path.endsWith('/library-mix')).length, 1);
  original.title = 'Do not resend this changed title'; original.entry_refs.reverse(); original.mix_playback_order = 'regular';
  const recovered = await h.providers.retryPlaylistOperation({scopeKey: SCOPE, action: 'create'});
  assert.equal(recovered.data.request_key, id(90)); assert.equal(writes, 2);
  const sends = h.calls.filter(x => x.path === '/playlists'); assert.deepEqual(sends[1].body, sends[0].body);
  assert.equal(sends[1].body.title, 'Captured mix'); assert.equal(sends[1].body.mix_playback_order, 'shuffle');
  assert.deepEqual(sends[1].body.entry_refs, [id(11), id(12), id(13)]);
  const retryIndex = h.calls.indexOf(sends[1]); assert.equal(h.calls[retryIndex - 1].path, `/playlists/operations/${id(90)}`);
});

test('committed recovery reports the existing save without another create or capture', async () => {
  let committed = false;
  const h = fixture(path => {
    if (path === '/playlists') throw new Error('Response lost');
    if (path.startsWith('/playlists/operations/')) return committed ? {status: 'committed', receipt: receipt().data} : {status: 'unknown'};
  });
  const value = await h.providers.beginLibraryMix(options());
  await assert.rejects(h.providers.createPlaylistFromSelection(command(value.data)));
  committed = true;
  await assert.rejects(h.providers.beginLibraryMix(options()), /previous playlist was saved/);
  assert.equal(h.calls.filter(x => x.path === '/playlists').length, 1);
  assert.equal(h.calls.filter(x => x.path.endsWith('/library-mix')).length, 1);
  assert.equal(h.providers.hasPendingPlaylistOperation({scopeKey: SCOPE, action: 'create'}), false);
});

test('forged actor/key or saved identity acknowledgements remain unconfirmed and cannot silently report success', async () => {
  for (const patch of [{actor_scope: {...ACTOR, account_id: 99}}, {request_key: id(91)}, {playlist_id: 'bad'}, {revision: '0'}]) {
    const h = fixture(path => path === '/playlists' ? receipt(id(90), patch)
      : path.startsWith('/playlists/operations/') ? {status: 'unknown'} : undefined);
    const value = await h.providers.beginLibraryMix(options());
    await assert.rejects(h.providers.createPlaylistFromSelection(command(value.data)));
    assert.equal(h.providers.hasPendingPlaylistOperation({scopeKey: SCOPE, action: 'create'}), true);
    assert.equal(h.calls.filter(x => x.path === '/playlists').length, 1);
  }
});

test('retained Mix reread uses its GET producer and exactly the captured source query without paging or recapture', async () => {
  const h = fixture(path => path.startsWith('/playlists/creation-source/library-mix?')
    ? capture({diagnostics: {private: 'provider details'}, context_ref: 'private-context', capture_ref: id(99),
      entries: capture().data.entries.map(row => ({...row, inventory_track_ref: 'inventory-track:5:7'}))}) : undefined);
  const first = await h.providers.beginLibraryMix(options()), input = {...options(), source: first.data.source, mode: 'ordinary',
    q: 'must not become a Mix filter', cursor: 'must not become a Mix cursor', limit: 7, source_protocol: 'must not be sent'};
  const result = await h.providers.readPlaylistCreationSource(input), call = h.calls.at(-1), url = new URL(call.path, 'https://albumhaven.test');
  assert.equal(h.calls.length, 2); assert.equal(call.method ?? 'GET', 'GET'); assert.equal(call.body, undefined);
  assert.equal(call.signal, input.signal); assert.equal(url.pathname, '/playlists/creation-source/library-mix');
  assert.deepEqual([...url.searchParams], [['source_ref', id(1)], ['source_revision', id(2)]]);
  assert.equal(result.status, 'ready'); assert.equal(result.data.scopeKey, SCOPE);
  assert.equal(result.data.source_protocol, 'library_mix_selection_v1'); assert.equal(result.data.entries_complete, true);
  assert.deepEqual(result.data.source, first.data.source); assert.deepEqual(result.data.entries.map(row => row.entry_ref), [id(11), id(12), id(13)]);
  for (const key of ['actor_scope', 'context_ref', 'capture_ref', 'diagnostics']) assert.equal(Object.hasOwn(result.data, key), false);
  assert.equal(Object.hasOwn(result.data.entries[0], 'inventory_track_ref'), false);
});

test('retained Mix reread rejects an unregistered or changed source tuple and mode without contacting any producer', async () => {
  const h = fixture(), first = await h.providers.beginLibraryMix(options());
  for (const patch of [{source: {...first.data.source, ref: id(99)}}, {source: {...first.data.source, revision: id(99)}},
    {source: {...first.data.source, kind: 'playlist'}}, {mode: 'missing'}]) {
    const result = await h.providers.readPlaylistCreationSource({...options(), source: first.data.source, mode: 'ordinary', ...patch});
    assert.deepEqual(result, {status: 'unavailable', data: null});
  }
  assert.equal(h.calls.length, 1);
  const absent = fixture();
  assert.deepEqual(await absent.providers.readPlaylistCreationSource({...options(), source: first.data.source, mode: 'ordinary'}),
    {status: 'unavailable', data: null});
  assert.equal(absent.calls.length, 0);
});

test('retained Mix reread validates exact reply source, revision, protocol, completeness, grants and actor', async () => {
  for (const patch of [{source: {kind: 'library', ref: id(99), revision: id(2)}},
    {source: {kind: 'library', ref: id(1), revision: id(99)}}, {source: {kind: 'playlist', ref: id(1), revision: '1'}},
    {source_protocol: 'library_selection_v1'}, {source_protocol: 'complete_inventory_selection_v1'},
    {mode: 'missing'}, {entries_complete: false}, {entries_complete: undefined}, {entries_complete: 1},
    {allowed_actions: {can_read: true, can_use_for_playlist: 'true'}},
    {actor_scope: {...ACTOR, account_id: 99}}]) {
    const h = fixture(path => path.startsWith('/playlists/creation-source/library-mix?') ? capture(patch) : undefined);
    const first = await h.providers.beginLibraryMix(options());
    await assert.rejects(h.providers.readPlaylistCreationSource({...options(), source: first.data.source, mode: 'ordinary'}),
      {status: patch.actor_scope ? 403 : 409});
    assert.equal(h.calls.length, 2); assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  }
});

test('retained Mix reread cannot publish after scope, authenticated context, abort or disposal changes', async () => {
  for (const invalidate of [h => h.retire(), h => h.rotate(), (_h, abort) => abort.abort(), h => h.providers.dispose()]) {
    const waiting = deferred(), entered = deferred();
    const h = fixture(path => {if (path.startsWith('/playlists/creation-source/library-mix?')) {entered.resolve(); return waiting.promise;}});
    const first = await h.providers.beginLibraryMix(options()), abort = new AbortController();
    const pending = h.providers.readPlaylistCreationSource({...options(), signal: abort.signal, source: first.data.source, mode: 'ordinary'});
    await entered.promise; invalidate(h, abort); waiting.resolve(capture());
    await assert.rejects(pending, {name: 'AbortError'}); assert.equal(h.calls.length, 2);
  }
});

test('retained Mix producer failure stays exact and never falls back to complete inventory or captures a replacement', async () => {
  const failure = Object.assign(new Error('Captured source expired'), {status: 410, code: 'source_expired'});
  const h = fixture(path => {if (path.startsWith('/playlists/creation-source/library-mix?')) throw failure;});
  const first = await h.providers.beginLibraryMix(options());
  await assert.rejects(h.providers.readPlaylistCreationSource({...options(), source: first.data.source, mode: 'ordinary'}), error => error === failure);
  assert.equal(h.calls.length, 2); assert.equal(h.calls[0].method, 'POST');
  assert.equal(new URL(h.calls[1].path, 'https://albumhaven.test').pathname, '/playlists/creation-source/library-mix');
});

test('ordinary paged and complete inventory rereads retain their existing routes, queries and completeness', async () => {
  const paged = fixture(path => path.startsWith('/playlists/creation-source/entries?')
    ? capture({source_protocol: 'library_selection_v1', entries_complete: false}) : undefined);
  const ordinary = await paged.providers.beginPlaylistCreationSource(options());
  const page = await paged.providers.readPlaylistCreationSource({...options(), source: ordinary, mode: 'ordinary', q: 'Artist & song', cursor: 'page:2'});
  const pageUrl = new URL(paged.calls.at(-1).path, 'https://albumhaven.test');
  assert.equal(pageUrl.pathname, '/playlists/creation-source/entries');
  assert.deepEqual([...pageUrl.searchParams], [['source_ref', id(1)], ['source_revision', id(2)], ['q', 'Artist & song'], ['cursor', 'page:2'], ['limit', '100']]);
  assert.equal(page.data.source_protocol, 'library_selection_v1'); assert.equal(page.data.entries_complete, false);
  const completeData = () => capture({source_protocol: 'complete_inventory_selection_v1',
    entries: [{...capture().data.entries[0], inventory_track_ref: 'inventory-track:5:7'}]});
  const complete = fixture(path => path === '/playlists/creation-source/selection' || path.startsWith('/playlists/creation-source/complete?')
    ? completeData() : undefined);
  const selected = await complete.providers.beginPlaylistSelectionSource({...options(), track_refs: ['inventory-track:5:7']});
  const all = await complete.providers.readPlaylistCreationSource({...options(), source: selected.source, mode: 'ordinary', q: 'ignored', cursor: 'ignored'});
  const allUrl = new URL(complete.calls.at(-1).path, 'https://albumhaven.test');
  assert.equal(allUrl.pathname, '/playlists/creation-source/complete');
  assert.deepEqual([...allUrl.searchParams], [['source_ref', id(1)], ['source_revision', id(2)]]);
  assert.equal(all.data.source_protocol, 'complete_inventory_selection_v1'); assert.equal(all.data.entries_complete, true);
  assert.ok([...paged.calls, ...complete.calls].every(call => !call.path.includes('/library-mix')));
});
