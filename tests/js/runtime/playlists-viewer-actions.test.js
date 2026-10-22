const test = require('node:test');
const assert = require('node:assert/strict');
const path = '../../../music_app/static/js/playlists/';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = {account_id: 4, library_id: 5};
const options = () => ({scopeKey: 'actor:4/library:5', signal: new AbortController().signal,
  playlist_id: id(1), revision: '3', request_key: id(2)});
const copyReceipt = (body, extra = {}) => ({ok: true, action: 'copy', request_key: body.request_key,
  playlist_id: id(3), source_playlist_id: id(1), revision: '1', changed: true, actor_scope: actor, ...extra});
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const settle = () => new Promise(resolve => setImmediate(resolve));

async function providerFixture(handler = () => undefined) {
  const {createPlaylistBackendProviders} = await import(path + 'backend-providers.mjs');
  let scopeKey = options().scopeKey, context = 'context:one';
  const calls = [];
  const transport = {context: () => context,
    query: (url, values) => `${url}?${new URLSearchParams(Object.entries(values).filter(([, value]) => value != null))}`,
    async request(url, args = {}) {
      calls.push({url, ...args});
      const response = await handler(url, args);
      if (response !== undefined) return response;
      if (url === `/playlists/${id(1)}/sharing`) return {playlist_id: id(1), revision: '3',
        visibility: 'server_shared', can_manage: false, can_copy: true, can_request_edit: true,
        request_status: 'none', pending_requests: [], actor_scope: actor};
      if (url.startsWith('/playlists/operations/')) return {status: 'unknown'};
      if (url.endsWith('/copy')) return copyReceipt(args.body);
      throw new Error(`Unexpected request ${url}`);
    }};
  const providers = createPlaylistBackendProviders({transport, runtime: {snapshot: () => ({scopeKey})}});
  await providers.readSharing(options());
  return {providers, calls, changeScope() {scopeKey = 'actor:8/library:5'; context = 'context:two';}};
}

test('copy acknowledges fresh destination and preserves distinct original source identity', async () => {
  const value = await providerFixture();
  const result = await value.providers.copyPlaylist(options());
  assert.equal(result.playlist_id, id(3)); assert.equal(result.source_playlist_id, id(1));
  assert.equal(result.actor_scope, undefined); assert.equal(result.scopeKey, options().scopeKey);
  assert.deepEqual(await value.providers.copyPlaylist(options()), result);
  assert.equal(value.calls.filter(call => call.method === 'POST').length, 1);
  value.providers.dispose();
});

for (const [name, patch] of Object.entries({
  source: {source_playlist_id: id(9)}, destination: {playlist_id: id(1)}, actor: {actor_scope: {account_id: 9, library_id: 5}},
  action: {action: 'request_edit'}, key: {request_key: id(9)}, library: {actor_scope: {account_id: 4, library_id: 9}},
})) test(`copy rejects a mismatched ${name} receipt and retains uncertain original`, async () => {
  const value = await providerFixture((url, args) => url.endsWith('/copy') ? copyReceipt(args.body, patch) : undefined);
  await assert.rejects(value.providers.copyPlaylist(options()), /still unknown/);
  assert.equal(value.providers.hasPendingPlaylistOperation({...options(), action: 'copyPlaylist'}), true);
  assert.equal(value.calls.filter(call => call.method === 'POST').length, 1);
  value.providers.dispose();
});

test('lost copy response reconciles new destination without a second write', async () => {
  let saved;
  const value = await providerFixture((url, args) => {
    if (url.endsWith('/copy')) {saved = copyReceipt(args.body); throw new Error('Lost response');}
    if (url.startsWith('/playlists/operations/')) return {status: 'committed', receipt: saved};
  });
  const result = await value.providers.copyPlaylist(options());
  assert.equal(result.playlist_id, id(3)); assert.equal(result.source_playlist_id, id(1));
  assert.equal(value.calls.filter(call => call.method === 'POST').length, 1);
  value.providers.dispose();
});

test('explicit unknown-copy retry resends immutable original bytes and key despite newer options', async () => {
  let writes = 0;
  const value = await providerFixture((url, args) => {
    if (!url.endsWith('/copy')) return;
    if (++writes === 1) throw new Error('Lost response');
    return copyReceipt(args.body);
  });
  await assert.rejects(value.providers.copyPlaylist(options()), /still unknown/);
  const result = await value.providers.retryPlaylistOperation({...options(), action: 'copyPlaylist', revision: '99', title: 'Changed'});
  assert.equal(result.playlist_id, id(3));
  const posts = value.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2); assert.deepEqual(posts[1].body, posts[0].body);
  assert.deepEqual(posts[1].body, {revision: '3', request_key: id(2)});
  value.providers.dispose();
});

test('account change cannot accept a delayed copy or reuse its retry', async () => {
  const pending = deferred();
  const value = await providerFixture((url, args) => url.endsWith('/copy') ? pending.promise : undefined);
  const mutation = value.providers.copyPlaylist(options());
  value.changeScope(); pending.resolve(copyReceipt({request_key: id(2)}));
  await assert.rejects(mutation, error => error.name === 'AbortError');
  await assert.rejects(value.providers.retryPlaylistOperation({...options(), action: 'copyPlaylist'}), /context unavailable/);
  assert.equal(value.calls.filter(call => call.method === 'POST').length, 1);
  value.providers.dispose();
});

async function notificationFixture(readEditRequests) {
  const {createPlaylistEditNotifications} = await import(path + 'edit-request-notifications.mjs');
  let shell = {scopeKey: options().scopeKey, authenticated: true};
  const subscriptions = new Set(), sources = [], opened = [];
  const producer = createPlaylistEditNotifications({
    runtime: {snapshot: () => shell, subscribe(callback) {subscriptions.add(callback); return () => subscriptions.delete(callback);}},
    providers: {readEditRequests}, onOpen(row, isCurrent) {opened.push({row, isCurrent});},
    notifications: {registerSource(config) {
      const source = {...config, records: [], disposed: false}; sources.push(source);
      return {replace(records, {status}) {source.records = records; source.status = status;},
        dispose() {source.disposed = true; source.records = [];}};
    }},
  });
  return {producer, sources, opened, subscriptions,
    change(patch) {shell = {...shell, ...patch}; for (const callback of subscriptions) callback();}};
}
const requestRow = (extra = {}) => ({request_ref: id(4), playlist_id: id(1), title: 'Shared list',
  account_ref: id(5), display_name: 'Reader', username_display: 'reader', created_at: '2026-10-09T00:00:00Z', ...extra});
const page = (requests = [requestRow()], next_cursor = null) => ({requests, next_cursor});

test('normal notification source reads all pages and opens exact playlist request without a grant', async () => {
  const calls = [];
  const value = await notificationFixture(args => {calls.push(args); return args.cursor ? page([requestRow({request_ref: id(6), playlist_id: id(7)})]) : page(undefined, 'next');});
  await settle(); const source = value.sources.at(-1);
  assert.deepEqual(calls.map(call => call.cursor), [null, 'next']);
  assert.deepEqual(source.records.map(row => row.id), [id(4), id(6)]);
  assert.equal(source.onOpen('unknown'), false); assert.equal(source.onOpen(id(6)), true);
  assert.equal(source.onOpen(id(6)), false, 'opening is single-flight'); await settle();
  assert.equal(value.opened[0].row.playlist_id, id(7)); assert.equal(value.opened[0].isCurrent(), true);
  value.producer.dispose(); assert.equal(value.opened[0].isCurrent(), false);
});

test('notification scope ABA aborts old reads and retires callbacks before late completion', async () => {
  const reads = [];
  const value = await notificationFixture(args => {const pending = deferred(); reads.push({...pending, signal: args.signal}); return pending.promise;});
  const first = value.sources[0];
  value.change({scopeKey: 'actor:8/library:5'}); const second = value.sources[1];
  value.change({scopeKey: options().scopeKey}); const third = value.sources[2];
  assert.deepEqual(reads.map(read => read.signal.aborted), [true, true, false]);
  reads[0].resolve(page()); reads[1].resolve(page()); reads[2].resolve(page([requestRow({request_ref: id(9)})]));
  await settle();
  assert.deepEqual(first.records, []); assert.deepEqual(second.records, []);
  assert.equal(first.isCurrent(), false); assert.equal(first.onOpen(id(4)), false);
  assert.deepEqual(third.records.map(row => row.id), [id(9)]);
  value.change({authenticated: false}); assert.equal(third.onOpen(id(9)), false);
  assert.deepEqual(third.records, []); value.producer.dispose(); assert.equal(value.subscriptions.size, 0);
});

test('notification refresh and provider replacement cannot retain resolved request callbacks', async () => {
  let next = page();
  const value = await notificationFixture(() => next); await settle();
  const first = value.sources.at(-1);
  next = page([]); await value.producer.refresh();
  assert.equal(first.onOpen(id(4)), false); assert.deepEqual(first.records, []);
  value.producer.configure({readEditRequests: () => page([requestRow({request_ref: id(8)})])}); await settle();
  assert.equal(first.isCurrent(), false); assert.equal(first.onOpen(id(4)), false);
  assert.deepEqual(value.sources.at(-1).records.map(row => row.id), [id(8)]);
  value.producer.dispose();
});

test('notification repeated pagination cursor fails closed', async () => {
  const value = await notificationFixture(() => page(undefined, 'loop')); await settle();
  const source = value.sources.at(-1);
  assert.deepEqual(source.records, []); assert.equal(source.status, 'error');
  assert.equal(source.onOpen(id(4)), false); value.producer.dispose();
});


test('retained notification navigation guard loses authority when request is removed', async () => {
  let next = page();
  const value = await notificationFixture(() => next); await settle();
  const source = value.sources.at(-1);
  assert.equal(source.onOpen(id(4)), true); await settle();
  const retained = value.opened[0]; assert.equal(retained.isCurrent(), true);
  next = page([]); await value.producer.refresh();
  assert.equal(retained.isCurrent(), false, 'removed request cannot pass deferred native navigation guard');
  assert.equal(source.onOpen(id(4)), false); value.producer.dispose();
});

for (const change of ['snapshot', 'away-return', 'provider', 'request']) test(`queued Share intent retires after ${change} replacement`, async () => {
  const {playlistShareIntentCurrent} = await import(path + 'shell.mjs');
  const shell = Object.freeze({visible: true, scopeKey: 'scope', playlistId: id(1), entryKey: 3});
  let current = true;
  const intent = {row: requestRow(), nativeSnapshot: shell, generation: 4, isCurrent: () => current};
  assert.equal(playlistShareIntentCurrent(intent, shell, 4), true);
  let latest = shell, generation = 4;
  if (change === 'snapshot') latest = {...shell};
  if (change === 'away-return') {
    assert.equal(playlistShareIntentCurrent(intent, {...shell, playlistId: id(8), entryKey: 4}, generation), false);
    latest = {...shell, entryKey: 5};
  }
  if (change === 'provider') generation++;
  if (change === 'request') current = false;
  assert.equal(playlistShareIntentCurrent(intent, latest, generation), false);
  assert.equal(playlistShareIntentCurrent(null, shell, 4), false);
});
