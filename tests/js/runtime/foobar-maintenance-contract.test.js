'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('./foobar-maintenance-fixture.cjs'), {F} = M;
const decoder = async () => (await F.load('maintenance.mjs')).validateMaintenance;
const reject = (decode, value) => assert.throws(() => decode(value, F.STAMP, F.SOURCE), TypeError);

test('MC01 maintenance strict decoder accepts genuine empty per-pass scalar result', async () => {
  const decode = await decoder(), value = M.payload(); assert.deepEqual(decode(value, F.STAMP, F.SOURCE), value.result);
});
test('MC02 maintenance strict decoder accepts exact twenty receipt hundred key bounds', async () => {
  const decode = await decoder(), value = M.payload({inspected: 20, removed_receipts: 17, protected_receipts: 3, removed_keys: 100, retired_through: 2147483646, next_cursor: M.cursor(), more_retired_keys: true});
  assert.deepEqual(decode(value, F.STAMP, F.SOURCE), value.result);
});
test('MC03 maintenance strict decoder returns immutable detached result and continuation', async () => {
  const decode = await decoder(), value = M.payload({inspected: 20, removed_receipts: 20, next_cursor: M.cursor()});
  const output = decode(value, F.STAMP, F.SOURCE); assert.ok(Object.isFrozen(output)); assert.ok(Object.isFrozen(output.next_cursor));
  value.result.next_cursor.generation = 2; value.result.removed_receipts = 0; assert.equal(output.next_cursor.generation, 1); assert.equal(output.removed_receipts, 20);
});
test('MC04 maintenance strict decoder rejects missing and added envelope fields', async () => {
  const decode = await decoder(); for (const key of Object.keys(M.payload())) {const value = M.payload(); delete value[key]; reject(decode, value);}
  reject(decode, M.payload({}, {operation: 'maintenance'})); reject(decode, M.payload({}, {unexpected: true}));
});
test('MC05 maintenance strict decoder rejects missing and added result fields', async () => {
  const decode = await decoder(); for (const key of Object.keys(M.result())) {const value = M.payload(); delete value.result[key]; reject(decode, value);}
  reject(decode, M.payload({total_removed: 0})); reject(decode, M.payload({imported_plays: 0}));
});
test('MC06 maintenance strict decoder rejects foreign protocol context scope and source', async () => {
  const decode = await decoder(); for (const patch of [{protocol: F.JOB}, {context_ref: 'b'.repeat(64)}, {context_scope: 'library'}, {protocol: null}]) reject(decode, M.payload({}, patch));
  reject(decode, M.payload({source_ref: F.OTHER}));
});
test('MC07 maintenance strict decoder rejects malformed source identity and value kinds', async () => {
  const decode = await decoder(); for (const value of [null, [], 'result', true, 0]) reject(decode, value);
  for (const source of ['', 'not-a-source', F.SOURCE.toUpperCase().replace('00000000', 'AAAAAAAA')]) assert.throws(() => decode(M.payload({source_ref: source}), F.STAMP, source), TypeError);
  for (const result of [null, [], 'result', true, 0]) reject(decode, M.payload({}, {result}));
});
test('MC08 maintenance strict decoder rejects negative fractional nonnumeric and unsafe counters', async () => {
  const decode = await decoder(); for (const key of ['inspected', 'removed_receipts', 'protected_receipts', 'removed_keys', 'retired_through'])
    for (const value of [-1, 0.5, '0', null, true, NaN, Infinity, 9007199254740992]) reject(decode, M.payload({[key]: value}));
});
test('MC09 maintenance strict decoder rejects receipt counts above twenty and keys above hundred', async () => {
  const decode = await decoder(); for (const patch of [{inspected: 21, removed_receipts: 21}, {inspected: 21, protected_receipts: 21}, {removed_receipts: 21}, {protected_receipts: 21}, {removed_keys: 101}, {retired_through: 2147483647}]) reject(decode, M.payload(patch));
});
test('MC10 maintenance strict decoder rejects receipt partitions inconsistent with inspection', async () => {
  const decode = await decoder(); for (const patch of [{inspected: 1}, {removed_receipts: 1}, {protected_receipts: 1}, {inspected: 20, removed_receipts: 11, protected_receipts: 10}]) reject(decode, M.payload(patch));
});
test('MC11 maintenance strict decoder independently enumerates every valid bounded receipt partition', async () => {
  const decode = await decoder(); let checked = 0;
  for (let inspected = 0; inspected <= 20; inspected++) for (let removed = 0; removed <= inspected; removed++) {
    const value = M.payload({inspected, removed_receipts: removed, protected_receipts: inspected - removed});
    assert.equal(decode(value, F.STAMP, F.SOURCE).inspected, inspected); checked++;
  } assert.equal(checked, 231);
});
test('MC12 maintenance strict decoder requires literal false history deletion and job reconciliation', async () => {
  const decode = await decoder(); for (const key of ['history_deleted', 'job_reconciled']) for (const value of [true, 0, null, 'false', undefined]) reject(decode, M.payload({[key]: value}));
});
test('MC13 maintenance strict decoder requires boolean key continuation without coercion', async () => {
  const decode = await decoder(); for (const value of [0, 1, 'true', null, [], {}]) reject(decode, M.payload({more_retired_keys: value}));
  assert.equal(decode(M.payload({more_retired_keys: true}), F.STAMP, F.SOURCE).more_retired_keys, true);
});
test('MC14 maintenance strict decoder accepts continuation only after a full receipt page', async () => {
  const decode = await decoder(); for (let inspected = 0; inspected < 20; inspected++) reject(decode, M.payload({inspected, removed_receipts: inspected, next_cursor: M.cursor()}));
});
test('MC15 maintenance strict decoder requires exact cursor shape and primitive field types', async () => {
  const decode = await decoder(), check = next_cursor => reject(decode, M.payload({inspected: 20, removed_receipts: 20, next_cursor}));
  for (const next of [undefined, [], true, '', 0]) check(next);
  for (const key of Object.keys(M.cursor())) {const value = M.cursor(); delete value[key]; check(value);}
  check(M.cursor({source_ref: F.SOURCE})); check(M.cursor({expires_at: 1})); check(M.cursor({receipt_ref: F.OTHER.toUpperCase().replace('00000000', 'AAAAAAAA')}));
});
test('MC16 maintenance strict decoder rejects nonpositive overbound and noninteger cursor generations', async () => {
  const decode = await decoder(); for (const generation of [0, -1, 0.1, '1', null, true, 2147483648]) reject(decode, M.payload({inspected: 20, removed_receipts: 20, next_cursor: M.cursor({generation})}));
  assert.equal(decode(M.payload({inspected: 20, protected_receipts: 20, next_cursor: M.cursor({generation: 2147483647})}), F.STAMP, F.SOURCE).next_cursor.generation, 2147483647);
});
test('MC17 maintenance strict decoder preserves microseconds and requires the documented UTC spelling', async () => {
  const decode = await decoder(), valid = M.payload({inspected: 20, protected_receipts: 20, next_cursor: M.cursor()});
  assert.equal(decode(valid, F.STAMP, F.SOURCE).next_cursor.expires_at, '2026-10-22T01:02:03.123456+00:00');
  for (const expires_at of ['2026-10-22T01:02:03.123Z', '2026-10-22T01:02:03.123456Z', '2026-10-22T01:02:03+00:00', '2026-10-22T01:02:03.123456+01:00', '<img src=x>']) reject(decode, M.payload({inspected: 20, protected_receipts: 20, next_cursor: M.cursor({expires_at})}));
});
test('MC18 maintenance strict decoder makes no lifetime total or import completion inference', async () => {
  const decode = await decoder(), first = decode(M.payload({inspected: 20, removed_receipts: 20, removed_keys: 100}), F.STAMP, F.SOURCE);
  const fresh = decode(M.payload({inspected: 1, removed_receipts: 1, removed_keys: 2}), F.STAMP, F.SOURCE);
  assert.equal(first.removed_receipts, 20); assert.equal(fresh.removed_receipts, 1); assert.equal(fresh.removed_keys, 2);
  assert.deepEqual(Object.keys(fresh).sort(), Object.keys(M.result()).sort());
});
test('MC19 maintenance strict decoder rejects impossible Gregorian cursor dates and year zero', async () => {
  const decode = await decoder();
  for (const expires_at of ['0000-01-01T00:00:00.000001+00:00', '2026-13-01T00:00:00.000001+00:00', '2026-00-01T00:00:00.000001+00:00', '2026-04-31T00:00:00.000001+00:00', '2026-02-29T00:00:00.000001+00:00', '2026-01-00T00:00:00.000001+00:00', '2026-01-01T24:00:00.000001+00:00', '2026-01-01T23:60:00.000001+00:00', '2026-01-01T23:59:60.000001+00:00']) reject(decode, M.payload({inspected: 20, removed_receipts: 20, next_cursor: M.cursor({expires_at})}));
});
test('MC20 maintenance strict decoder preserves valid leapday century and submillisecond cursors', async () => {
  const decode = await decoder();
  for (const expires_at of ['0001-01-01T00:00:00.000001+00:00', '2000-02-29T23:59:59.999999+00:00', '2024-02-29T12:30:45.123001+00:00', '9999-12-31T23:59:59.999999+00:00']) {
    assert.equal(decode(M.payload({inspected: 20, protected_receipts: 20, next_cursor: M.cursor({expires_at})}), F.STAMP, F.SOURCE).next_cursor.expires_at, expires_at);
  }
  reject(decode, M.payload({inspected: 20, removed_receipts: 20, next_cursor: M.cursor({expires_at: '1900-02-29T00:00:00.000001+00:00'})}));
});
