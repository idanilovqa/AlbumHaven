'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const E = require('./foobar-enhanced-v4-fixture.cjs'), {F, H} = E;
const state = f => f.controller.getSnapshot();
const advance = async (f, n, options = {}) => {f.wire.enqueue('/history/enhanced', E.page(n, options)); await f.controller.loadHistory({next: true});};

test('EC01 actual Enhanced provider emits account-only exact entries command without native authority', async t => {
  const f = await H.setup(t); await E.selected(f); const request = f.wire.calls.at(-1);
  assert.equal(request.route, '/history/enhanced'); assert.deepEqual(JSON.parse(request.init.body), {version: E.HISTORY, source_ref: F.SOURCE, view: 'entries', cursor: null});
  assert.equal(request.init.method, 'POST'); assert.equal(request.init.credentials, 'same-origin'); assert.equal(request.init.cache, 'no-store'); assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers['X-AlbumHaven-Foobar-Context'], F.STAMP); assert.equal(request.init.headers['X-AlbumHaven-Context'], undefined);
  assert.equal(state(f).family, 'local_entries'); assert.equal(state(f).mode, 'individual'); assert.equal(state(f).page.items[0].enhanced.entry.iso_utc, E.ISO);
});
test('EC02 actual Enhanced provider maps grouped mode to record evidence without list fallback', async t => {
  const f = await H.setup(t); await E.selected(f, E.page(0, {mode: 'grouped'}), 'grouped');
  assert.equal(JSON.parse(f.wire.calls.at(-1).init.body).view, 'records'); assert.equal(state(f).page.items[0].enhanced.entry, null);
  assert.ok(f.wire.calls.every(call => ['/history/sources', '/history/enhanced'].includes(call.route)));
});
test('EC03 actual Enhanced long traversal exceeds prior 200000-row cap while retaining five pages', async t => {
  const longPage = n => {
    // More than 200000 entries belong to only seven source records, each with
    // a valid 32766-entry vector, not an impossible >100000-record source.
    const rows = Array.from({length: 20}, (_, i) => {
      const offset = n * 20 + i;
      return E.record(999999 - Math.floor(offset / 32766), {local_vector_count: '32766',
        entry: E.entry({ordinal: 32765 - offset % 32766})});
    });
    return E.history(rows, {next_cursor: E.cursor(rows.at(-1)), previous_cursor: n ? E.cursor(rows[0], 'newer') : null});
  };
  const f = await H.setup(t); await E.selected(f, longPage(0));
  const assertRetainedRows = snapshot => {
    assert.equal(snapshot.pages.length, 5); assert.equal(snapshot.page.items.length, 100);
    assert.deepEqual(snapshot.pages.map(value => value.index), Array.from({length: 5}, (_, i) => snapshot.firstPage + i));
    for (const value of snapshot.pages) {
      assert.deepEqual(Object.keys(value).sort(), ['index', 'page']);
      assert.equal(value.page.items.length, 20);
    }
    const rows = snapshot.pages.flatMap(value => value.page.items);
    assert.equal(new Set(rows).size, 100, 'Exactly 100 distinct retained row objects');
    assert.equal(new Set(rows.map(row => row.observation_ref + ':' + row.kind)).size, 100, 'Exactly 100 entry identities');
    assert.equal(new Set(rows.map(row => row.enhanced)).size, 100, 'Exactly 100 retained record objects');
    assert.equal(new Set(rows.map(row => row.enhanced.entry)).size, 100, 'Exactly 100 retained entry objects');
    rows.forEach((row, i) => {
      assert.strictEqual(snapshot.page.items[i], row, 'Flattened row aliases retained page row ' + i);
      assert.equal(String(row.enhanced.entry.ordinal).length, 5, 'Compared windows have equal ordinal widths');
      assert.equal(row.kind, 'local_entry:' + row.enhanced.entry.ordinal);
      assert.match(row.enhanced.label, /^Source file [0-9]{6}$/);
    });
    for (const page of [...snapshot.pages.map(value => value.page), snapshot.page]) {
      assert.equal(page.next_cursor.ordinal.length, 5); assert.equal(page.previous_cursor.ordinal.length, 5);
    }
  };
  // These eight numeric positions legitimately gain decimal digits during a
  // long traversal. No row, cursor, history array or other field is excluded.
  const positionCharacters = snapshot => [snapshot.firstPage, snapshot.lastPage, snapshot.pageNumber,
    ...snapshot.pages.map(value => value.index)].reduce((length, value) => length + String(value).length, 0);
  let shortWindowPayloadLength = null;
  // Synthetic transport history is discarded, not product state. The recorder
  // must not accumulate all requests across the 200,120-entry traversal.
  for (let n = 1; n <= 10005; n++) {
    f.wire.calls.length = 0; f.wire.enqueue('/history/enhanced', longPage(n)); await f.controller.loadHistory({next: true});
    assert.equal(state(f).status, 'ready', 'Forward page ' + n);
    assert.equal(state(f).pages.length, Math.min(n + 1, 5)); assert.equal(state(f).page.items.length, Math.min((n + 1) * 20, 100));
    assert.equal(state(f).lastPage, n); assert.equal(state(f).hasOlder, true);
    assert.deepEqual(JSON.parse(f.wire.calls[0].init.body).cursor, longPage(n - 1).result.next_cursor);
    if (n === 5) {
      const snapshot = state(f); assertRetainedRows(snapshot);
      // Pages 1..5 have both cursors, five-digit ordinals and six-digit labels,
      // just like the final pages. Keep only a scalar, not this old snapshot.
      assert.equal(positionCharacters(snapshot), 8);
      shortWindowPayloadLength = JSON.stringify(snapshot).length - positionCharacters(snapshot);
    }
  }
  assert.equal(state(f).firstPage, 10001); assert.equal(state(f).hasNewer, true);
  assertRetainedRows(state(f)); assert.notEqual(shortWindowPayloadLength, null);
  assert.equal(positionCharacters(state(f)), 40, 'Only the eight positions gain four digits each');
  // JSON repeats aliased rows through pages and page.items; it is not a heap
  // measurement. Same-width payload stays equal to the short five-page window.
  assert.equal(JSON.stringify(state(f)).length - positionCharacters(state(f)), shortWindowPayloadLength,
    'Serialized payload stays equal to the short five-page window after more than 200000 entries');
  for (let n = 10000; n >= 9991; n--) {
    const anchor = state(f).pages[0].page.previous_cursor; f.wire.calls.length = 0;
    f.wire.enqueue('/history/enhanced', longPage(n)); await f.controller.loadHistory({newer: true});
    assert.deepEqual(JSON.parse(f.wire.calls[0].init.body).cursor, anchor);
    assert.equal(state(f).firstPage, n); assert.equal(state(f).page.items.length, 100); assert.equal(state(f).status, 'ready');
    assertRetainedRows(state(f));
    assert.equal(JSON.stringify(state(f)).length - positionCharacters(state(f)), shortWindowPayloadLength,
      'Reverse reload retains the same bounded payload at page ' + n);
  }
});
test('EC04 actual Enhanced long reverse reload uses current first-page previous keyset not cursor history', async t => {
  const f = await H.setup(t); await E.selected(f);
  for (let n = 1; n <= 140; n++) await advance(f, n);
  for (let n = 135; n >= 0; n--) {
    const anchor = state(f).pages[0].page.previous_cursor;
    f.wire.enqueue('/history/enhanced', E.page(n)); await f.controller.loadHistory({newer: true});
    assert.deepEqual(JSON.parse(f.wire.calls.at(-1).init.body).cursor, anchor);
    assert.equal(state(f).status, 'ready'); assert.equal(state(f).firstPage, n); assert.equal(state(f).pages.length, 5);
    assert.equal(state(f).page.items.length, 100); assert.equal(state(f).hasNewer, n > 0);
  }
  const calls = f.wire.calls.length; await f.controller.loadHistory({newer: true}); assert.equal(f.wire.calls.length, calls);
});
test('EC05 actual Enhanced true end derives from source cursor and not window eviction or failure', async t => {
  const f = await H.setup(t); await E.selected(f); for (let n = 1; n <= 5; n++) await advance(f, n);
  assert.equal(state(f).hasOlder, true); await advance(f, 6, {more: false});
  assert.equal(state(f).hasOlder, false); assert.equal(state(f).hasNewer, true); assert.equal(state(f).page.items.length, 100);
  const count = f.wire.calls.length; await f.controller.loadHistory({next: true}); assert.equal(f.wire.calls.length, count);
});
test('EC06 actual Enhanced read failure clears evidence and cannot masquerade as confirmed end', async t => {
  const f = await H.setup(t); await E.selected(f); f.wire.enqueue('/history/enhanced', () => Promise.reject(new TypeError('synthetic transport failure')));
  await f.controller.loadHistory({next: true}); assert.equal(state(f).status, 'unavailable'); assert.equal(state(f).page, null); assert.deepEqual(state(f).pages, []);
  assert.match(state(f).error, /unavailable/); assert.doesNotMatch(state(f).error, /end|completed/i); assert.equal(f.wire.calls.length, 3);
  f.wire.enqueue('/history/enhanced', E.page()); await f.controller.loadHistory(); assert.equal(state(f).status, 'ready'); assert.equal(JSON.parse(f.wire.calls.at(-1).init.body).cursor, null);
});
test('EC07 actual Enhanced stale revision response clears window and requires explicit first-page refresh', async t => {
  const f = await H.setup(t); await E.selected(f);
  f.wire.enqueue('/history/enhanced', () => Promise.resolve(F.response({protocol: E.HISTORY, error: 'stale_history'}, 409)));
  await f.controller.loadHistory({next: true}); assert.equal(state(f).status, 'stale'); assert.equal(state(f).page, null); assert.match(state(f).error, /source changed/);
  const calls = f.wire.calls.length; await f.controller.loadHistory({next: true}); assert.equal(f.wire.calls.length, calls);
  f.wire.enqueue('/history/enhanced', E.page(0, {revision: '2'})); await f.controller.loadHistory(); assert.equal(state(f).page.source_revision, '2'); assert.equal(state(f).firstPage, 0);
});
test('EC08 actual Enhanced successful-envelope revision drift is rejected without mixed old and new pages', async t => {
  const f = await H.setup(t); await E.selected(f); await advance(f, 1, {revision: '2'});
  assert.equal(state(f).status, 'unavailable'); assert.equal(state(f).page, null); assert.deepEqual(state(f).pages, []);
});
test('EC09 actual Enhanced source switch aborts delayed entries and retains only new source evidence', async t => {
  const f = await H.setup(t); await E.selected(f, E.page(), 'individual', H.sources([H.source(), H.source(2)]));
  const late = F.deferred(); f.wire.enqueue('/history/enhanced', () => late.promise); const work = f.controller.loadHistory({next: true}), signal = f.wire.calls.at(-1).init.signal;
  f.wire.enqueue('/history/enhanced', E.page(0, {source: H.id(2)})); f.controller.selectSource(H.id(2)); await F.settle();
  assert.equal(signal.aborted, true); late.resolve(F.response(E.page(1))); await work;
  assert.equal(state(f).page.source_ref, H.id(2)); assert.equal(state(f).pages.length, 1); assert.equal(state(f).firstPage, 0);
});
test('EC10 actual Enhanced family switch aborts old entries and preserves genuine TSV count family', async t => {
  const f = await H.setup(t); await E.selected(f); const late = F.deferred(); f.wire.enqueue('/history/enhanced', () => late.promise); const work = f.controller.loadHistory({next: true});
  const signal = f.wire.calls.at(-1).init.signal;
  f.wire.enqueue('/history/list', H.page(0, {mode: 'individual'})); f.controller.setFamily('standard'); await F.settle(); late.resolve(F.response(E.page(1))); await work;
  assert.equal(signal.aborted, true); assert.equal(state(f).family, 'standard'); assert.equal(state(f).page.items[0].enhanced, undefined); assert.equal(state(f).page.items[0].kind, 'unknown_dates_bucket');
});
test('EC11 actual Enhanced mode switch aborts late entries and shows empty or unavailable records', async t => {
  const f = await H.setup(t); await E.selected(f); const late = F.deferred(); f.wire.enqueue('/history/enhanced', () => late.promise); const work = f.controller.loadHistory({next: true});
  const records = E.history([E.record(2, {entry: null, local_vector_count: '0'}), E.record(1, {entry: null, local_vector_count: null, local_provenance: null})], {view: 'records', ordering: 'source_record_identity'});
  f.wire.enqueue('/history/enhanced', records); f.controller.setMode('grouped'); await F.settle(); late.resolve(F.response(E.page(1))); await work;
  assert.equal(state(f).mode, 'grouped'); assert.deepEqual(state(f).page.items.map(row => row.enhanced.local_vector_count), ['0', null]); assert.equal(state(f).pages.length, 1);
});
test('EC12 actual Enhanced account retirement aborts in-flight request and rejects delayed authority', async t => {
  const f = await H.setup(t); await E.selected(f); const late = F.deferred(); f.wire.enqueue('/history/enhanced', () => late.promise); const work = f.controller.loadHistory({next: true});
  const signal = f.wire.calls.at(-1).init.signal; f.provider.retire(); assert.equal(signal.aborted, true);
  late.resolve(F.response(E.page(1))); await work; assert.equal(state(f).status, 'retired'); assert.equal(state(f).selectedSource, null); assert.deepEqual(state(f).sources, []); assert.equal(state(f).page, null);
});
test('EC13 actual Enhanced account capability and context changes invalidate delayed response before decode', async t => {
  for (const change of ['marker', 'scope', 'capability', 'current', 'detached']) {
    const f = await H.setup(t); await E.selected(f); const late = F.deferred(); f.wire.enqueue('/history/enhanced', () => late.promise); const work = f.controller.loadHistory({next: true});
    if (change === 'marker') f.root.dataset.accountFoobarContext = 'd'.repeat(64);
    if (change === 'scope') f.root.dataset.accountFoobarScope = 'library';
    if (change === 'capability') f.allow(false); if (change === 'current') f.current(false); if (change === 'detached') f.root.isConnected = false;
    late.resolve({status: 200, body: {getReader() {assert.fail('Retired response must not decode');}}}); await work;
    assert.equal(state(f).status, 'retired', change); assert.equal(state(f).page, null);
  }
});
test('EC14 actual Enhanced HTTP denial retires account without decoding hostile response', async t => {
  for (const status of [401, 403]) {
    const f = await H.setup(t); await E.selected(f); f.wire.enqueue('/history/enhanced', () => Promise.resolve({status, body: {getReader() {assert.fail('Denial body must not decode');}}}));
    await f.controller.loadHistory({next: true}); assert.equal(state(f).status, 'retired'); assert.equal(state(f).page, null);
  }
});
test('EC15 actual Enhanced same-time ordinals remain unique across five-page window and reverse reload', async t => {
  const f = await H.setup(t);
  const page = n => {const rows = Array.from({length: 20}, (_, i) => E.record(1, {local_vector_count: '200', entry: E.entry({ordinal: 199 - n * 20 - i})})); return E.history(rows, {next_cursor: E.cursor(rows.at(-1)), previous_cursor: n ? E.cursor(rows[0], 'newer') : null});};
  await E.selected(f, page(0)); for (let n = 1; n <= 6; n++) {f.wire.enqueue('/history/enhanced', page(n)); await f.controller.loadHistory({next: true});}
  assert.equal(new Set(state(f).page.items.map(row => row.kind)).size, 100); assert.equal(state(f).page.items[0].kind, 'local_entry:159');
  f.wire.enqueue('/history/enhanced', page(1)); await f.controller.loadHistory({newer: true}); assert.equal(state(f).page.items[0].kind, 'local_entry:179'); assert.equal(state(f).page.items.at(-1).kind, 'local_entry:80');
});
test('EC16 actual Enhanced cancelled auto-eviction leaves cursors unchanged for manual retry', async t => {
  const f = await H.setup(t); await E.selected(f); for (let n = 1; n < 5; n++) await advance(f, n);
  const previous = state(f).pages, before = state(f).page;
  f.wire.enqueue('/history/enhanced', E.page(5)); await f.controller.loadHistory({next: true, canCommit: () => false});
  assert.equal(state(f).pages, previous); assert.equal(state(f).page, before); assert.equal(state(f).status, 'ready');
  const request = JSON.parse(f.wire.calls.at(-1).init.body); await advance(f, 5); assert.deepEqual(JSON.parse(f.wire.calls.at(-1).init.body), request); assert.equal(state(f).firstPage, 1);
});
test('EC17 actual Enhanced repeated navigation and delayed disposed response cannot duplicate requests', async t => {
  const f = await H.setup(t); await E.selected(f); const late = F.deferred(); f.wire.enqueue('/history/enhanced', () => late.promise); const work = f.controller.loadHistory({next: true});
  await f.controller.loadHistory({next: true}); await f.controller.loadHistory({newer: true}); assert.equal(f.wire.calls.length, 3);
  const signal = f.wire.calls.at(-1).init.signal; f.controller.dispose(); assert.equal(signal.aborted, true); late.resolve(F.response(E.page(1))); await work; assert.equal(state(f).status, 'retired'); assert.equal(state(f).page, null);
});
test('EC18 actual Enhanced return-to-newest discards distant window and sends no old keyset', async t => {
  const f = await H.setup(t); await E.selected(f); for (let n = 1; n <= 8; n++) await advance(f, n);
  f.wire.enqueue('/history/enhanced', E.page()); await f.controller.loadHistory({start: true});
  assert.equal(JSON.parse(f.wire.calls.at(-1).init.body).cursor, null); assert.equal(state(f).pages.length, 1); assert.equal(state(f).firstPage, 0); assert.equal(state(f).hasNewer, false);
});
