'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./foobar-account-history-fixture.cjs');
test('H09 provider dispatches only exact account read commands through supplied session fetch', async t => {
  const f = await H.setup(t); f.wire.enqueue('/history/sources', H.sources()); await f.controller.initialize();
  assert.equal(f.controller.getSnapshot().selectedSource, null); assert.equal(f.wire.calls.length, 1);
  f.wire.enqueue('/history/list', H.history()); f.controller.selectSource(H.SOURCE); await H.settle();
  for (const call of f.wire.calls) {assert.equal(call.init.credentials, 'same-origin'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.cache, 'no-store'); assert.equal(call.init.method, 'POST'); assert.equal(call.init.headers['X-AlbumHaven-Foobar-Context'], H.STAMP); assert.equal(call.init.headers['Content-Type'], 'application/json'); assert.ok(call.init.signal instanceof AbortSignal);}
  assert.deepEqual(JSON.parse(f.wire.calls[1].init.body), {version: H.VERSION, ...H.query(), cursor: null});
});
test('H10 provider real HTTP denial retires without trusting HTML error body', async t => {
  const f = await H.setup(t); f.wire.enqueue('/history/sources', () => Promise.resolve(new Response('denied', {status: 403})));
  await f.controller.initialize(); assert.equal(f.controller.getSnapshot().status, 'retired'); assert.equal(f.controller.getSnapshot().sources.length, 0); assert.equal(f.wire.calls.length, 1);
  assert.throws(() => f.provider.readSources(), {code: 'stale_context'});
});
test('H11 provider context grant and owner-current changes block reads before dispatch', async t => {
  for (const change of [f => {f.root.dataset.accountFoobarContext = 'b'.repeat(64);}, f => {f.root.dataset.accountFoobarScope = 'library';}, f => f.allow(false), f => f.current(false), f => {f.root.isConnected = false;}]) {
    const f = await H.setup(t); change(f); assert.throws(() => f.provider.readSources(), {code: 'stale_context'}); assert.equal(f.wire.calls.length, 0); assert.equal(f.controller.getSnapshot().status, 'retired');
  }
});
test('H12 controller source family and mode switches abort delayed reads and reject late rows', async t => {
  const f = await H.setup(t), late = H.deferred(); f.wire.enqueue('/history/sources', H.sources([H.source(), H.source(2)])); await f.controller.initialize();
  f.wire.enqueue('/history/list', () => late.promise, H.history([H.row(90)], {source_ref: H.id(2)})); f.controller.selectSource(H.SOURCE); const signal = f.wire.calls.at(-1).init.signal;
  f.controller.selectSource(H.id(2)); await H.settle(); assert.equal(signal.aborted, true); late.resolve(H.response(H.history())); await H.settle(); assert.equal(f.controller.getSnapshot().selectedSource.source_ref, H.id(2)); assert.equal(f.controller.getSnapshot().page.items[0].observation_ref, H.id(90));
  f.wire.enqueue('/history/list', H.history([H.row(80, {family: 'enhanced'})], {source_ref: H.id(2), family: 'enhanced'})); f.controller.setFamily('enhanced'); await H.settle(); assert.equal(f.controller.getSnapshot().family, 'enhanced');
  f.wire.enqueue('/history/list', H.history([H.row(70, {family: 'enhanced'}, 'unknown_dates_bucket')], {source_ref: H.id(2), family: 'enhanced', mode: 'individual'})); f.controller.setMode('individual'); await H.settle(); assert.equal(f.controller.getSnapshot().page.items[0].kind, 'unknown_dates_bucket');
  assert.equal(JSON.parse(f.wire.calls.at(-1).init.body).cursor, null);
});
test('H13 controller genuine moving window appends evicts and reloads exact newer checkpoint', async t => {
  const f = await H.setup(t); await H.selected(f);
  for (let n = 1; n <= 6; n++) {f.wire.enqueue('/history/list', H.page(n)); await f.controller.loadHistory({next: true}); const s = f.controller.getSnapshot(); assert.ok(s.pages.length <= 5); assert.ok(s.page.items.length <= 100); assert.equal(s.lastPage, n); assert.equal(s.hasOlder, true);}
  let s = f.controller.getSnapshot(); assert.equal(s.firstPage, 2); assert.equal(s.hasNewer, true); assert.equal(s.page.items[0].observation_ref, H.page(2).result.items[0].observation_ref);
  f.wire.enqueue('/history/list', H.page(1)); await f.controller.loadHistory({newer: true}); s = f.controller.getSnapshot(); assert.equal(s.firstPage, 1); assert.equal(s.lastPage, 5); assert.deepEqual(JSON.parse(f.wire.calls.at(-1).init.body).cursor, H.page(0).result.next_cursor);
  assert.equal(s.page.items.length, 100); assert.equal(s.direction, 'newer');
});
test('H14 controller delayed navigation retains rows and duplicate load is suppressed', async t => {
  const f = await H.setup(t); await H.selected(f); const late = H.deferred(), before = f.controller.getSnapshot().page;
  f.wire.enqueue('/history/list', () => late.promise); const work = f.controller.loadHistory({next: true}); await f.controller.loadHistory({next: true}); assert.equal(f.controller.getSnapshot().page, before); assert.equal(f.wire.calls.length, 3);
  late.resolve(H.response(H.page(1))); await work; assert.equal(f.controller.getSnapshot().page.items.length, 40);
});
test('H15 controller response-time visible-row guard declines eviction without advancing window', async t => {
  const f = await H.setup(t); await H.selected(f); for (let n = 1; n < 5; n++) {f.wire.enqueue('/history/list', H.page(n)); await f.controller.loadHistory({next: true});}
  const before = f.controller.getSnapshot().pages, late = H.deferred(); let seen;
  f.wire.enqueue('/history/list', () => late.promise); const work = f.controller.loadHistory({next: true, canCommit: pages => {seen = pages; return false;}});
  late.resolve(H.response(H.page(5))); await work; assert.equal(seen.length, 5); assert.equal(seen[0].index, 1); assert.equal(f.controller.getSnapshot().pages, before); assert.equal(f.controller.getSnapshot().status, 'ready');
  f.wire.enqueue('/history/list', H.page(5)); await f.controller.loadHistory({next: true, canCommit: () => true}); assert.equal(f.controller.getSnapshot().firstPage, 1);
});
test('H16 controller return newest null cursor remains revision fenced unlike explicit refresh', async t => {
  const f = await H.setup(t); await H.selected(f); for (let n = 1; n <= 5; n++) {f.wire.enqueue('/history/list', H.page(n)); await f.controller.loadHistory({next: true});}
  f.wire.enqueue('/history/list', H.page(0, {revision: '2'})); await f.controller.loadHistory({start: true}); assert.equal(JSON.parse(f.wire.calls.at(-1).init.body).cursor, null); assert.equal(f.controller.getSnapshot().status, 'stale'); assert.equal(f.controller.getSnapshot().pages.length, 0);
  f.wire.enqueue('/history/list', H.page(0, {revision: '2'})); await f.controller.loadHistory(); assert.equal(f.controller.getSnapshot().status, 'ready'); assert.equal(f.controller.getSnapshot().page.source_revision, '2');
});
test('H17 controller terminal cursor distinguishes known end from bounded loaded range', async t => {
  const f = await H.setup(t); await H.selected(f); assert.equal(f.controller.getSnapshot().hasOlder, true);
  f.wire.enqueue('/history/list', H.page(1, {more: false})); await f.controller.loadHistory({next: true}); assert.equal(f.controller.getSnapshot().hasOlder, false); const count = f.wire.calls.length; await f.controller.loadHistory({next: true}); assert.equal(f.wire.calls.length, count);
});
test('H18 controller source refresh retirement disposal and late response clear all retained rows', async t => {
  const f = await H.setup(t); await H.selected(f); const late = H.deferred(); f.wire.enqueue('/history/list', () => late.promise); const work = f.controller.loadHistory({next: true}), signal = f.wire.calls.at(-1).init.signal;
  f.wire.enqueue('/history/sources', H.sources()); await f.controller.loadSources(); assert.equal(signal.aborted, true); late.resolve(H.response(H.page(1))); await work; assert.equal(f.controller.getSnapshot().page, null); assert.equal(f.controller.getSnapshot().selectedSource, null);
  f.controller.retire(); assert.equal(f.controller.getSnapshot().sources.length, 0); assert.equal(f.controller.getSnapshot().pages.length, 0); f.controller.dispose(); assert.equal(f.controller.getSnapshot().status, 'retired');
});
test('H19 provider unavailable stale malformed and network responses never become empty history', async t => {
  for (const response of [() => Promise.resolve(H.response({protocol: H.VERSION, error: 'unavailable'}, 503)), () => Promise.resolve(H.response({protocol: H.VERSION, error: 'stale_history'}, 409)), () => Promise.resolve(H.response({})), () => Promise.reject(new Error('offline'))]) {
    const f = await H.setup(t); await H.selected(f); f.wire.enqueue('/history/list', response); await f.controller.loadHistory({next: true}); assert.ok(['unavailable', 'stale'].includes(f.controller.getSnapshot().status)); assert.equal(f.controller.getSnapshot().page, null); assert.equal(f.controller.getSnapshot().pages.length, 0);
  }
});
test('H31 actual session CSRF wrapper protects the history provider POST without library transport', async t => {
  const f = await H.setup(t), calls = [];
  const context = H.vm.createContext({URL, Headers, document: {cookie: '__Host-album_haven_csrf=synthetic-test-token'}, window: {location: {href: 'https://example.test/account/foobar-history', origin: 'https://example.test'}, fetch: (url, init) => {calls.push({url, init}); return Promise.resolve(H.response(H.sources()));}}});
  H.vm.runInContext(H.read('music_app/static/js/runtime/session-csrf-fetch.js'), context);
  const {createFoobarHistoryProvider} = await H.load('provider.mjs'); const provider = createFoobarHistoryProvider({fetch: (...args) => context.window.fetch(...args), contextRoot: f.root, allows: () => true, isCurrent: () => true}); t.after(() => provider.dispose());
  await provider.readSources(); assert.equal(calls.length, 1); assert.equal(calls[0].init.headers.get('X-Album-Haven-CSRF'), 'synthetic-test-token'); assert.equal(calls[0].init.headers.get('X-AlbumHaven-Foobar-Context'), H.STAMP); assert.equal(calls[0].url, '/integrations/foobar/account/history/sources');
});
test('H32 provider explicit cancellation aborts pending transport and ignores its late success', async t => {
  const f = await H.setup(t), late = H.deferred(), abort = new AbortController(); f.wire.enqueue('/history/sources', () => late.promise);
  const work = f.provider.readSources({signal: abort.signal}); abort.abort(); assert.equal(f.wire.calls[0].init.signal.aborted, true); late.resolve(H.response(H.sources())); await assert.rejects(work, {name: 'AbortError'}); assert.equal(f.wire.calls.length, 1);
});
test('H33 controller family and mode switches during delayed navigation ignore prior errors', async t => {
  const f = await H.setup(t); await H.selected(f);
  for (const [key, value, options] of [['setFamily', 'enhanced', {family: 'enhanced'}], ['setMode', 'individual', {family: 'enhanced', mode: 'individual'}]]) {
    const late = H.deferred(); f.wire.enqueue('/history/list', () => late.promise); const work = f.controller.loadHistory({next: true}), signal = f.wire.calls.at(-1).init.signal;
    f.wire.enqueue('/history/list', H.page(0, options)); f.controller[key](value); await H.settle(); assert.equal(signal.aborted, true); late.reject(Object.assign(new Error('old denial'), {code: 'stale_history'})); await work;
    assert.equal(f.controller.getSnapshot().status, 'ready'); assert.equal(f.controller.getSnapshot().firstPage, 0); assert.equal(f.controller.getSnapshot().pages.length, 1);
  }
});
test('H35 real controller finite grouped cap permits terminal probe but rejects excess row', async t => {
  const {createFoobarHistoryController} = await H.load('controller.mjs'); let terminal = false, requests = 0;
  const provider = {readSources: async () => H.sources().result, readHistory: async ({cursor}) => {requests++; const index = cursor === null ? 0 : Number(cursor.observation_ref.slice(-12)); if (index === 5000) return H.history(terminal ? [] : [H.row(1)]).result; return {...H.page(index).result, next_cursor: {...H.page(index).result.next_cursor, observation_ref: H.id(index+1)}};}};
  // The provider seam isolates the real controller bound; it is not a transport
  // or contract test and intentionally uses opaque synthetic checkpoint refs.
  const controller = createFoobarHistoryController({provider}); t.after(() => controller.dispose()); await controller.initialize(); controller.selectSource(H.SOURCE); await H.settle();
  for (let n = 1; n <= 5000; n++) await controller.loadHistory({next: true}); assert.equal(controller.getSnapshot().status, 'unavailable'); assert.equal(controller.getSnapshot().pages.length, 0); assert.equal(requests, 5001);
  terminal = true; await controller.loadHistory(); for (let n = 1; n <= 5000; n++) await controller.loadHistory({next: true}); assert.equal(controller.getSnapshot().hasOlder, false); assert.equal(controller.getSnapshot().lastPage, 5000); assert.ok(controller.getSnapshot().page.items.length <= 100);
});
test('H40 provider sixty second deadline aborts without automatic retry or empty fallback', async t => {
  const clock = H.clock(); t.after(() => clock.restore()); const f = await H.setup(t);
  f.wire.enqueue('/history/sources', (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true})));
  const work = assert.rejects(f.provider.readSources(), {name: 'AbortError'}); await clock.tick(60000); await work; assert.equal(f.wire.calls.length, 1); assert.equal(clock.tasks.size, 0);
});
test('H45 controller stale older and newer reads clear window before explicit refresh', async t => {
  for (const direction of ['next', 'newer']) {
    const f = await H.setup(t); await H.selected(f); if (direction === 'newer') for (let n = 1; n <= 5; n++) {f.wire.enqueue('/history/list', H.page(n)); await f.controller.loadHistory({next: true});}
    f.wire.enqueue('/history/list', H.page(direction === 'next' ? 1 : 0, {revision: '2'})); await f.controller.loadHistory({[direction]: true}); assert.equal(f.controller.getSnapshot().status, 'stale'); assert.equal(f.controller.getSnapshot().page, null); assert.equal(f.controller.getSnapshot().pages.length, 0);
  }
});
test('H46 controller same-revision changed known reverse continuation fails closed', async t => {
  const f = await H.setup(t); await H.selected(f); for (let n = 1; n <= 5; n++) {f.wire.enqueue('/history/list', H.page(n)); await f.controller.loadHistory({next: true});}
  // Contract-valid terminal page conflicts with the controller checkpoint that
  // already proved this exact revision/page had an older continuation.
  f.wire.enqueue('/history/list', H.page(0, {more: false})); await f.controller.loadHistory({newer: true}); assert.equal(f.controller.getSnapshot().status, 'unavailable'); assert.equal(f.controller.getSnapshot().pages.length, 0);
});
test('H47 real controller individual finite cap permits only ten thousand full pages plus terminal probe', async t => {
  const {createFoobarHistoryController} = await H.load('controller.mjs'); let requests = 0;
  const provider = {readSources: async () => H.sources().result, readHistory: async ({cursor, mode}) => {requests++; const index = cursor === null ? 0 : Number(cursor.observation_ref.slice(-12)); if (index === 10000) return H.history([], {mode}).result; const page = H.page(index, {mode}).result; return {...page, next_cursor: {...page.next_cursor, observation_ref: H.id(index+1)}};}};
  const controller = createFoobarHistoryController({provider}); t.after(() => controller.dispose()); await controller.initialize(); controller.setMode('individual'); controller.selectSource(H.SOURCE); await H.settle();
  for (let n = 1; n <= 10000; n++) await controller.loadHistory({next: true}); assert.equal(requests, 10001); assert.equal(controller.getSnapshot().lastPage, 10000); assert.equal(controller.getSnapshot().hasOlder, false); assert.ok(controller.getSnapshot().page.items.length <= 100); assert.ok(controller.getSnapshot().pages.length <= 5);
});
