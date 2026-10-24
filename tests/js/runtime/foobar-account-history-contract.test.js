'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./foobar-account-history-fixture.cjs');
test('H01 history contract preserves exact bigint count and prior observation revision', async () => {
  const C = await H.load('contract.mjs'), count = '9223372036854775807';
  const result = C.validateHistory(H.history([H.row(99, {total: count, aggregate_remainder: count})], {source_revision: '2'}), H.STAMP, H.query());
  assert.equal(result.items[0].projection.total, count); assert.equal(result.items[0].projection.source_revision, '1'); assert.ok(Object.isFrozen(result.items[0].projection));
  for (const invalid of ['01', '-1', '9223372036854775808', 2]) assert.equal(C.decimal(invalid), false);
});
test('H02 history contract exact context scope operation and unknown fields fail closed', async () => {
  const C = await H.load('contract.mjs');
  for (const patch of [{context_ref: 'b'.repeat(64)}, {context_scope: 'library'}, {operation: 'source'}, {extra: true}]) assert.throws(() => C.validateHistory({...H.history(), ...patch}, H.STAMP, H.query()));
  assert.throws(() => C.validateHistory(H.history([H.row(1, {track_uuid: H.OTHER})]), H.STAMP, H.query()));
  assert.throws(() => C.validateQuery({...H.query(), library_id: 1}));
});
test('H03 history contract zero one two missing and corrected counts remain evidence not events', async () => {
  const C = await H.load('contract.mjs');
  for (const total of ['0', '1', '2']) {const p = H.projection({total, aggregate_remainder: total, show_grouped_count: total === '2', show_remainder_count: total === '2'}); assert.equal(C.validateHistory(H.history([H.row(1, p)]), H.STAMP, H.query()).items[0].projection.total, total);}
  const absent = H.projection({count_state: 'absent', total: null, status: 'unavailable', reason: 'count_unavailable', aggregate_remainder: null, show_grouped_count: false, show_remainder_count: false});
  assert.equal(C.validateHistory(H.history([H.row(1, absent)]), H.STAMP, H.query()).items[0].projection.total, null);
  const invalid = {...absent, count_state: 'invalid', status: 'needs_reconciliation', reason: 'invalid_count'};
  assert.equal(C.validateHistory(H.history([H.row(1, invalid)]), H.STAMP, H.query()).items[0].projection.reason, 'invalid_count');
});
test('H04 history contract equal boundaries preserve first marker and undated weight one', async () => {
  const C = await H.load('contract.mjs'), b = H.boundary(), p = {first: b, last: b, timestamp_coverage: 'boundary_evidence', first_marker_weight: 1, aggregate_remainder: '1', first_sort_key: '10', remainder_sort_key: '10', grouped_sort_key: '10', show_remainder_count: false};
  const rows = [H.row(2, p, 'first_boundary'), H.row(2, p, 'unknown_dates_bucket')];
  const result = C.validateHistory(H.history(rows, {mode: 'individual'}), H.STAMP, H.query({mode: 'individual'}));
  assert.equal(result.items.length, 2); assert.equal(result.items[1].projection.aggregate_remainder, '1'); assert.equal(result.items[1].projection.show_remainder_count, false);
  assert.throws(() => C.validateHistory(H.history([...rows].reverse(), {mode: 'individual'}), H.STAMP, H.query({mode: 'individual'})));
});
test('H05 history contract unresolved raw boundary and hostile metadata remain bounded strings', async () => {
  const C = await H.load('contract.mjs'), raw = H.boundary(null, '23/10/2026 local');
  const p = {title: H.label('<img src=x onerror=alert(1)>'), first: raw, timestamp_coverage: 'boundary_evidence', first_marker_weight: 1, aggregate_remainder: '1', first_sort_key: H.MIN, show_remainder_count: false};
  const result = C.validateHistory(H.history([H.row(1, p)]), H.STAMP, H.query()); assert.equal(result.items[0].projection.first.unix_microseconds, null);
  for (const text of ['x\ny', '\ud800', '😀'.repeat(25)]) assert.throws(() => C.validateHistory(H.history([H.row(1, {title: H.label(text)})]), H.STAMP, H.query()));
});
test('H06 history contract enforces page ordering duplicate identity and exact continuation', async () => {
  const C = await H.load('contract.mjs'), first = H.page(); C.validateHistory(first, H.STAMP, H.query());
  const next = H.page(1); C.validateHistory(next, H.STAMP, H.query(), first.result.next_cursor);
  const changed = H.page(1, {revision: '2'}); assert.throws(() => C.validateHistory(changed, H.STAMP, H.query(), first.result.next_cursor), {code: 'stale_history'});
  for (const bad of [H.history([H.row(), H.row()]), H.history([H.row(1), H.row(2)]), H.history(Array.from({length: 21}, (_, n) => H.row(100-n)))]) assert.throws(() => C.validateHistory(bad, H.STAMP, H.query()));
  const wrong = H.clone(first); wrong.result.next_cursor.observation_ref = H.OTHER; assert.throws(() => C.validateHistory(wrong, H.STAMP, H.query()));
});
test('H07 source contract requires ordered unique explicit source choices and bounded cursors', async () => {
  const C = await H.load('contract.mjs'); assert.equal(C.validateSources(H.sources(), H.STAMP).items[0].is_default, true);
  for (const items of [[H.source(), H.source()], [H.source(2), H.source(1)], Array.from({length: 21}, (_, n) => H.source(n+1))]) assert.throws(() => C.validateSources(H.sources(items), H.STAMP));
  assert.throws(() => C.validateSources(H.sources([H.source()], {context_ref: H.STAMP, source_ref: H.SOURCE}), H.STAMP));
  assert.throws(() => C.sourceCursor({context_ref: H.STAMP, source_ref: H.SOURCE, extra: 1}, H.STAMP));
});
test('H08 bounded reader rejects content type redirects oversized and invalid UTF8', async () => {
  const C = await H.load('contract.mjs');
  for (const response of [new Response('{}', {headers: {'Content-Type': 'text/html'}}), new Response('{}', {headers: {'Content-Type': 'application/json', 'Content-Length': '131073'}}), new Response(new Uint8Array([255]), {headers: {'Content-Type': 'application/json'}}), new Response(' '.repeat(131073), {headers: {'Content-Type': 'application/json'}})]) await assert.rejects(C.readBoundedJSON(response, () => {}));
  let calls = 0; assert.deepEqual(await C.readBoundedJSON(H.response({ok: true}), () => {calls++;}), {ok: true}); assert.ok(calls >= 3);
});
test('H29 strict wire rejects impossible ready zero dated disjoint singleton and reversed intervals', async () => {
  const C = await H.load('contract.mjs');
  const make = (total, first, last) => H.row(1, {total, first, last, timestamp_coverage: 'boundary_evidence', first_marker_weight: total === '0' ? 0 : 1, first_sort_key: total === '0' ? null : first.unix_microseconds ?? H.MIN, grouped_sort_key: last.unix_microseconds ?? H.MIN, remainder_sort_key: last.unix_microseconds ?? H.MIN, aggregate_remainder: String(BigInt(total) - (total === '0' ? 0n : 1n)), show_grouped_count: total === '2', show_remainder_count: false});
  for (const row of [make('0', H.boundary(), H.boundary()), make('1', H.boundary('10'), H.boundary('20')), make('2', H.boundary('20'), H.boundary('10')), make('1', H.boundary(null, 'Monday local'), H.boundary(null, 'Tuesday local'))]) assert.throws(() => C.validateHistory(H.history([row]), H.STAMP, H.query()));
  const first = {...H.boundary('-1000000'), fraction_digits: 0}, last = H.boundary('-1');
  assert.equal(C.validateHistory(H.history([make('1', first, last)]), H.STAMP, H.query()).items.length, 1);
});
test('H30 strict wire classifies ASCII empty unavailable and truncated raw boundary evidence', async () => {
  const C = await H.load('contract.mjs');
  for (const label of ['', ' ', 'N/A']) {const last = H.boundary(null, label); assert.throws(() => C.validateHistory(H.history([H.row(1, {last, timestamp_coverage: 'boundary_evidence'})]), H.STAMP, H.query()));}
  const last = {...H.absent(), state: 'empty', label: ' '.repeat(128), truncated: true}; assert.equal(C.validateHistory(H.history([H.row(1, {last})]), H.STAMP, H.query()).items[0].projection.last.truncated, true);
  const unavailable = {...H.absent(), state: 'unavailable', label: ' N/A '}; assert.equal(C.validateHistory(H.history([H.row(1, {last: unavailable})]), H.STAMP, H.query()).items[0].projection.last.state, 'unavailable');
});
test('H44 bounded reader rejects redirected response before acquiring stream reader', async () => {
  const C = await H.load('contract.mjs'); let acquired = false;
  await assert.rejects(C.readBoundedJSON({redirected: true, headers: new Headers({'Content-Type': 'application/json'}), body: {getReader() {acquired = true; throw new Error('unexpected reader');}}}, () => {})); assert.equal(acquired, false);
});
