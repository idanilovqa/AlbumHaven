'use strict';
// Additive prerequisites for bounded Sample Save R2. These exercise the actual
// existing create operation owner with an admitted ordinary source, NOT Sample
// capture, UI integration, Sample source admission, or document-reload recovery.
// No Sample capture/read route or source-registration API has been agreed yet.
const test = require('node:test');
const assert = require('node:assert/strict');
let create;
test.before(async () => {
  ({createPlaylistBackendProviders: create} = await import('../../../music_app/static/js/playlists/backend-providers.mjs'));
});
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = {account_id: 3, library_id: 7};
const SOURCE = {kind: 'library', ref: id(1), revision: id(2)};
const KEY = id(90), OPERATION = `/playlists/operations/${KEY}`;
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const receipt = (key = KEY) => ({ok: true, action: 'create', request_key: key,
  playlist_id: id(80), revision: '1', changed: true, actor_scope: {...ACTOR}});
function fixture(handler = () => undefined) {
  let scope = 'scope:original', context = 'context:original', changed;
  const calls = [];
  const transport = {
    context: () => context,
    subscribe(listener) {changed = listener; return () => {changed = null;};},
    async request(path, options = {}) {
      calls.push({path, method: options.method || 'GET', expected: options.expected,
        ...(options.body ? {body: structuredClone(options.body)} : {})});
      const response = await handler(path, options);
      if (response !== undefined) return response;
      if (path === '/playlists/creation-source/current') return {status: 'ready', data: {
        source_protocol: 'library_selection_v1', source: {...SOURCE}, mode: 'ordinary',
        actor_scope: {...ACTOR}, allowed_actions: {can_read: true, can_use_for_playlist: true},
        page_size: 100, max_selected_entries: 5000, max_command_bytes: 524288,
        expires_at: '2099-01-01T00:00:00Z'}};
      if (path === '/playlists/destinations') return {status: 'empty', data: {destinations: [], actor_scope: {...ACTOR}}};
      if (path === '/playlists') return {status: 'ready', data: receipt(options.body.request_key)};
      throw new Error(`Unexpected transport: ${path}`);
    },
  };
  const providers = create({transport, runtime: {acceptsPrivateScope: key => key === scope}});
  const options = () => ({scopeKey: scope});
  return {providers, calls, options,
    async open() {await providers.beginPlaylistCreationSource(options());},
    command(patch = {}) {return {...options(), source: {...SOURCE}, source_protocol: 'library_selection_v1',
      mode: 'ordinary', title: 'Explicit Save', description: 'Retained command',
      entry_refs: [id(11), id(12), id(13)], request_key: KEY, ...patch};},
    navigate() {scope = 'scope:remounted';},
    clearIdentity() {context = 'context:replacement'; changed?.();},
    writes() {return calls.filter(call => call.path === '/playlists');},
  };
}
async function makeUnknown(f, patch = {}) {
  await f.open();
  await assert.rejects(f.providers.createPlaylistFromSelection(f.command(patch)), {status: 'unknown'});
  assert.equal(f.providers.hasPendingPlaylistOperation({...f.options(), action: 'create'}), true);
}

test('existing create owner posts to /playlists with exact command and no recipe or alternate endpoint', async t => {
  const f = fixture(); t.after(() => f.providers.dispose()); await f.open();
  const command = f.command(); const result = await f.providers.createPlaylistFromSelection(command);
  assert.deepEqual(f.writes(), [{path: '/playlists', method: 'POST', expected: 'context:original', body: {
    source_protocol: command.source_protocol, mode: 'ordinary', source: SOURCE,
    title: command.title, description: command.description, entry_refs: command.entry_refs, request_key: KEY}}]);
  assert.equal(result.data.playlist_id, id(80)); assert.equal(result.data.actor_scope, undefined);
  assert.deepEqual(f.calls.map(call => call.path), ['/playlists/creation-source/current', '/playlists']);
});

test('same-provider navigation retains unknown original key and immutable bytes for explicit retry', async t => {
  let writes = 0;
  const f = fixture((path, options) => {
    if (path === '/playlists' && ++writes === 1) throw new Error('Timed out after send');
    if (path === OPERATION) return {status: 'unknown'};
  }); t.after(() => f.providers.dispose()); await f.open();
  const original = f.command(); await assert.rejects(f.providers.createPlaylistFromSelection(original), {status: 'unknown'});
  original.title = 'Changed view'; original.entry_refs.reverse(); original.source.ref = id(99);
  f.navigate();
  const saved = await f.providers.retryPlaylistOperation({...f.options(), action: 'create', request_key: KEY});
  assert.equal(saved.data.scopeKey, 'scope:remounted'); assert.equal(saved.data.request_key, KEY);
  assert.equal(f.writes().length, 2); assert.deepEqual(f.writes()[1], f.writes()[0]);
  assert.deepEqual(f.calls.slice(-2).map(call => call.path), [OPERATION, '/playlists']);
});

test('same-provider remount recovers committed original without reading expired source or resending', async t => {
  let committed = false;
  const f = fixture(path => {
    if (path === '/playlists') throw new Error('Missing response');
    if (path === OPERATION) return committed ? {status: 'committed', receipt: receipt()} : {status: 'unknown'};
  }); t.after(() => f.providers.dispose()); await makeUnknown(f); f.navigate(); committed = true;
  const before = f.calls.length;
  const recovered = await f.providers.recoverPlaylistCreation(f.options());
  assert.equal(recovered.request_key, KEY); assert.equal(recovered.scopeKey, 'scope:remounted');
  assert.deepEqual(f.calls.slice(before).map(call => call.path), [OPERATION]);
  assert.equal(f.writes().length, 1);
  assert.equal(await f.providers.recoverPlaylistCreation(f.options()), null);
});

test('abort after submission preserves uncertainty and permits lookup on the same provider', async t => {
  const entered = deferred(), pending = deferred(), abort = new AbortController();
  const f = fixture(path => {
    if (path === '/playlists') {entered.resolve(); return pending.promise;}
    if (path === OPERATION) return {status: 'committed', receipt: receipt()};
  }); t.after(() => f.providers.dispose()); await f.open();
  const saving = f.providers.createPlaylistFromSelection(f.command({signal: abort.signal}));
  await entered.promise; abort.abort(); f.navigate(); pending.resolve({status: 'ready', data: receipt()});
  await assert.rejects(saving, {name: 'AbortError'});
  assert.equal(f.providers.hasPendingPlaylistOperation({...f.options(), action: 'create'}), true);
  assert.equal((await f.providers.recoverPlaylistCreation(f.options())).playlist_id, id(80));
  assert.equal(f.writes().length, 1);
});

test('repeated create calls during a pending POST reconcile instead of posting twice', async t => {
  const entered = deferred(), pending = deferred();
  const f = fixture(path => {
    if (path === '/playlists') {entered.resolve(); return pending.promise;}
    if (path === OPERATION) return {status: 'unknown'};
  }); t.after(() => f.providers.dispose()); await f.open();
  const first = f.providers.createPlaylistFromSelection(f.command()); await entered.promise;
  await assert.rejects(f.providers.createPlaylistFromSelection(f.command()), {status: 'unknown'});
  assert.equal(f.writes().length, 1);
  pending.resolve({status: 'ready', data: receipt()}); await first;
});

test('a fresh key and changed command cannot bypass an unresolved original', async t => {
  const f = fixture(path => {
    if (path === '/playlists') throw new Error('Response lost');
    if (path === OPERATION) return {status: 'unknown'};
  }); t.after(() => f.providers.dispose()); await makeUnknown(f);
  await assert.rejects(f.providers.createPlaylistFromSelection(f.command({request_key: id(91), title: 'New action'})), {status: 'unknown'});
  assert.equal(f.writes().length, 1); assert.equal(f.calls.at(-1).path, OPERATION);
});

test('empty manual directory is not proof of noncommit and does not clear uncertainty', async t => {
  const f = fixture(path => {
    if (path === '/playlists') throw new Error('Response lost');
    if (path === OPERATION) return {status: 'unknown'};
  }); t.after(() => f.providers.dispose()); await makeUnknown(f);
  const directory = await f.providers.readPlaylistDestinations(f.options());
  assert.equal(directory.status, 'empty');
  assert.equal(f.providers.hasPendingPlaylistOperation({...f.options(), action: 'create'}), true);
  await assert.rejects(f.providers.recoverPlaylistCreation(f.options()), {status: 'unknown'});
  assert.equal(f.writes().length, 1);
});

test('explicit retry receives committed receipt before considering resend', async t => {
  let committed = false;
  const f = fixture(path => {
    if (path === '/playlists') throw new Error('Response lost');
    if (path === OPERATION) return committed ? {status: 'committed', receipt: receipt()} : {status: 'unknown'};
  }); t.after(() => f.providers.dispose()); await makeUnknown(f); committed = true;
  const result = await f.providers.retryPlaylistOperation({...f.options(), action: 'create', request_key: KEY});
  assert.equal(result.data.request_key, KEY); assert.equal(f.writes().length, 1);
});

test('concurrent explicit retries cannot submit duplicate original commands', async t => {
  let checking = false;
  const entered = deferred(), pending = deferred();
  const f = fixture(path => {
    if (path === '/playlists' && !checking) throw new Error('Response lost');
    if (path === OPERATION) {
      if (checking) {entered.resolve(); return pending.promise;}
      return {status: 'unknown'};
    }
  }); t.after(() => f.providers.dispose()); await makeUnknown(f); checking = true;
  const retry = f.providers.retryPlaylistOperation({...f.options(), action: 'create'}); await entered.promise;
  await assert.rejects(f.providers.retryPlaylistOperation({...f.options(), action: 'create'}), /already being checked/);
  pending.resolve({status: 'unknown'}); await retry;
  assert.equal(f.writes().length, 2); assert.deepEqual(f.writes()[1], f.writes()[0]);
});

test('provider identity clear loses in-memory recovery and never manufactures a new Save', async t => {
  const f = fixture(path => {
    if (path === '/playlists') throw new Error('Response lost');
    if (path === OPERATION) return {status: 'unknown'};
  }); t.after(() => f.providers.dispose()); await makeUnknown(f); f.clearIdentity();
  const before = f.calls.length;
  assert.equal(await f.providers.recoverPlaylistCreation(f.options()), null);
  await assert.rejects(f.providers.retryPlaylistOperation({...f.options(), action: 'create', request_key: KEY}), /No uncertain original/);
  assert.equal(f.calls.length, before); assert.equal(f.writes().length, 1);
});
