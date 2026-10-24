'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const B = require('./foobar-track-evidence-fixture.cjs');
const load = () => require('./foobar-account-history-fixture.cjs').load('track-evidence.mjs');
const validate = async () => (await load()).validateTrackEvidence;
test('BT01 genuine track evidence DTO preserves exact large TSV counts and source provenance', async () => {
  const read = await validate(), value = B.payload([B.item(1, {count: '9223372036854775807', source_revision: '9223372036854775807'})]);
  assert.equal(read(value, B.scope()), value.result); assert.equal(value.result.items[0].count, '9223372036854775807');
});
test('BT02 genuine zero and unavailable Enhanced local vectors are distinct closed tuples', async () => {
  const read = await validate();
  for (const count of ['0', '1', '32766']) assert.equal(read(B.payload([B.item(1, {evidence_kind: 'enhanced_store', count})]), B.scope()).items[0].count, count);
  const row = B.item(1, {evidence_kind: 'enhanced_store', count_state: 'unavailable', count: null, status: 'unavailable', reason: 'local_timestamp_vector_unavailable'});
  assert.equal(read(B.payload([row]), B.scope()).items[0].count, null);
});
test('BT03 TSV absent empty unavailable and invalid counts retain genuine status and reason', async () => {
  const read = await validate();
  for (const count_state of ['absent', 'empty', 'unavailable', 'invalid']) {
    const row = B.item(1, {count_state, count: null, status: count_state === 'invalid' ? 'needs_reconciliation' : 'unavailable', reason: count_state === 'invalid' ? 'invalid_count' : 'count_unavailable'});
    assert.equal(read(B.payload([row]), B.scope()).items[0], row);
  }
});
test('BT04 contradictory TSV totals are reported not coerced into zero or proven listens', async () => {
  const read = await validate();
  for (const [count, reason] of [['0', 'zero_count_with_boundaries'], ['1', 'single_count_boundary_conflict'], ['1', 'boundary_order_conflict'], ['12', 'boundary_order_conflict']]) {
    const row = B.item(1, {count, reason, status: 'needs_reconciliation'});
    assert.equal(read(B.payload([row]), B.scope()).items[0].count, count);
  }
});
test('BT05 strict Enhanced tuple cross product rejects every unsupported state status reason pairing', async () => {
  const read = await validate();
  const allowed = new Set(['valid|0|ready|', 'valid|2|ready|', 'unavailable||unavailable|local_timestamp_vector_unavailable']);
  for (const count_state of ['valid', 'invalid', 'unavailable', 'absent', 'empty']) for (const count of [null, '0', '2']) for (const status of ['ready', 'unavailable', 'needs_reconciliation']) for (const reason of [null, 'invalid_count', 'count_unavailable', 'local_timestamp_vector_unavailable', 'zero_count_with_boundaries', 'boundary_order_conflict', 'single_count_boundary_conflict']) {
    const value = B.payload([B.item(1, {evidence_kind: 'enhanced_store', count_state, count, status, reason})]);
    const key = [count_state, count, status, reason].join('|');
    if (allowed.has(key)) assert.doesNotThrow(() => read(value, B.scope()), key); else assert.throws(() => read(value, B.scope()), /could not be verified/, key);
  }
});
test('BT06 strict TSV tuple cross product rejects fabricated unavailable reconciliation and ready claims', async () => {
  const read = await validate();
  const allowed = new Set(['valid|0|ready|', 'valid|1|ready|', 'valid|2|ready|', 'valid|0|needs_reconciliation|zero_count_with_boundaries', 'valid|1|needs_reconciliation|single_count_boundary_conflict', 'valid|1|needs_reconciliation|boundary_order_conflict', 'valid|2|needs_reconciliation|boundary_order_conflict', 'invalid||needs_reconciliation|invalid_count', 'absent||unavailable|count_unavailable', 'empty||unavailable|count_unavailable', 'unavailable||unavailable|count_unavailable']);
  for (const count_state of ['valid', 'invalid', 'unavailable', 'absent', 'empty']) for (const count of [null, '0', '1', '2']) for (const status of ['ready', 'unavailable', 'needs_reconciliation']) for (const reason of [null, 'invalid_count', 'count_unavailable', 'local_timestamp_vector_unavailable', 'zero_count_with_boundaries', 'boundary_order_conflict', 'single_count_boundary_conflict']) {
    const value = B.payload([B.item(1, {count_state, count, status, reason})]), key = [count_state, count, status, reason].join('|');
    if (allowed.has(key)) assert.doesNotThrow(() => read(value, B.scope()), key); else assert.throws(() => read(value, B.scope()), /could not be verified/, key);
  }
});
test('BT07 decoder rejects numeric coercions overflow negative fractions and padded decimals', async () => {
  const read = await validate();
  for (const count of [0, 12, false, '', '00', '01', '-1', '1.0', '1e3', '9223372036854775808']) assert.throws(() => read(B.payload([B.item(1, {count})]), B.scope()));
  assert.throws(() => read(B.payload([B.item(1, {evidence_kind: 'enhanced_store', count: '32767'})]), B.scope()));
  for (const field of ['source_revision', 'association_version']) for (const bad of ['0', 1, '01', '-1', '9223372036854775808']) assert.throws(() => read(B.payload([B.item(1, {[field]: bad})]), B.scope()));
});
test('BT08 closed envelope result and row reject missing and additional keys including private targets', async () => {
  const read = await validate();
  for (const choose of [v => v, v => v.result, v => v.result.items[0]]) {
    const base = B.payload();
    for (const key of Object.keys(choose(base))) {const value = B.clone(base); delete choose(value)[key]; assert.throws(() => read(value, B.scope()), key);}
    for (const key of ['path', 'inventory_track_ref', 'native_handle', 'total', 'lastfm_count']) {const value = B.clone(base); choose(value)[key] = 'forbidden'; assert.throws(() => read(value, B.scope()), key);}
  }
});
test('BT09 protocol context track family and current-page consistency must match exactly', async () => {
  const read = await validate();
  for (const change of [v => v.protocol = 'v0', v => v.context_ref = 'd'.repeat(64), v => v.result.track_id = '12', v => v.result.track_id = 11, v => v.result.family = 'enhanced', v => v.result.consistency = 'all_sources_snapshot']) {
    const value = B.payload(); change(value); assert.throws(() => read(value, B.scope()));
  }
  assert.equal(read(B.payload([], {family: 'enhanced'}), B.scope({family: 'enhanced'})).family, 'enhanced');
});
test('BT10 bounded page admits twenty rows but rejects oversized nonarray and duplicate keys', async () => {
  const read = await validate(); assert.equal(read(B.page(), B.scope()).items.length, 20);
  for (const items of [Array.from({length: 21}, (_, n) => B.item(n+1)), {}, null, [B.item(), B.item()], [B.item(2), B.item(1)]]) assert.throws(() => read(B.payload(items), B.scope()));
});
test('BT11 stable source observation key order permits multiple observations of one source', async () => {
  const read = await validate(), rows = [B.item(1), B.item(2, {source_ref: B.item(1).source_ref})];
  assert.equal(read(B.payload(rows), B.scope()).items.length, 2);
  assert.throws(() => read(B.payload(rows.reverse()), B.scope()));
});
test('BT12 response continuation requires exact final row key and full twenty-row page', async () => {
  const read = await validate();
  for (const count of [0, 1, 19]) {const value = B.page(1, count, false); value.result.next_cursor = B.cursor(B.item(20)); assert.throws(() => read(value, B.scope()));}
  const value = B.page(); value.result.next_cursor.observation_ref = B.item(19).observation_ref; assert.throws(() => read(value, B.scope()));
});
test('BT13 cursor is closed and binds account library track family and lowercase identity hash', async () => {
  const read = await validate();
  for (const [key, bad] of [['account_id', '8'], ['library_id', '4'], ['track_id', '12'], ['family', 'enhanced'], ['track_sha256', 'B'.repeat(64)], ['source_ref', 'bad'], ['observation_ref', 'bad']]) {
    const value = B.page(); value.result.next_cursor[key] = bad; assert.throws(() => read(value, B.scope()), key);
  }
  for (const key of Object.keys(B.cursor(B.item()))) {const value = B.page(); delete value.result.next_cursor[key]; assert.throws(() => read(value, B.scope()), key);}
  const value = B.page(); value.result.next_cursor.path = '/synthetic/private'; assert.throws(() => read(value, B.scope()));
});
test('BT14 continuation rejects replayed keys and changed track identity without freezing source revisions', async () => {
  const read = await validate(), before = B.cursor(B.item(20));
  assert.throws(() => read(B.page(20), B.scope({cursor: before})));
  const next = B.page(21); next.result.next_cursor.track_sha256 = 'd'.repeat(64); assert.throws(() => read(next, B.scope({cursor: before})));
  const corrected = B.page(21); corrected.result.items[0].source_revision = '99'; corrected.result.items[0].count = '2';
  assert.equal(read(corrected, B.scope({cursor: before})).items[0].count, '2');
});
test('BT15 empty and short terminal pages are true ends without invented all-source totals', async () => {
  const read = await validate();
  for (const count of [0, 1, 19, 20]) {const result = read(B.page(1, count, false), B.scope()); assert.equal(result.next_cursor, null); assert.equal(Object.hasOwn(result, 'total'), false);}
});
test('BT16 UUID creation timestamp shape and evidence enums reject malformed wire values', async () => {
  const read = await validate();
  for (const [key, bad] of [['source_ref', 'not-a-source'], ['observation_ref', '0'], ['source_created_at', '2026-10-23'], ['source_created_at', 123], ['evidence_kind', 'lastfm'], ['count_state', 'known'], ['status', 'complete'], ['reason', 'opaque path']]) assert.throws(() => read(B.payload([B.item(1, {[key]: bad})]), B.scope()), key);
});
