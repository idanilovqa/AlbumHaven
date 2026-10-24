'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./foobar-account-import-fixture.cjs'), J = require('./foobar-account-job-discovery-fixture.cjs');
const check = async value => (await F.load('contract.mjs')).validateJobList(value, F.STAMP, value.result.unfinished);
test('J01 discovery request preserves exact UTC microseconds and strict cursor keys', async () => {
  const C = await F.load('contract.mjs'), cursor = J.cursor(J.item());
  assert.deepEqual(C.jobListRequest(false, cursor), {version: J.VERSION, unfinished: false, cursor});
  assert.ok(Object.isFrozen(C.jobListRequest(true, cursor).cursor));
  for (const bad of [{}, {...cursor, extra: 1}, {...cursor, updated_at: '2026-10-23T12:00:00.123Z'}, {...cursor, job_ref: '<script>'}]) assert.throws(() => C.jobListRequest(true, bad));
  assert.throws(() => C.jobListRequest('true', null));
});
test('J02 discovery validates bounded descending durable pages and exact last-row cursor', async () => {
  const value = J.page(), result = await check(value); assert.equal(result.items.length, 20); assert.deepEqual(result.next_cursor, J.cursor(result.items.at(-1))); assert.ok(Object.isFrozen(result.items));
  for (const mutate of [v => v.result.items.push(J.item(20)), v => v.result.items.reverse(), v => v.result.next_cursor.job_ref = J.id(20), v => v.result.items.pop()]) {const bad = F.clone(value); mutate(bad); await assert.rejects(check(bad));}
});
test('J03 discovery rejects impossible dates duplicate rows unknown fields and invalid progress', async () => {
  for (const patch of [{created_at: '2026-02-30T00:00:00.000001Z'}, {updated_at: '2026-10-23T12:00:00.123456+00:00'}, {created_at: '2027-10-23T12:00:00.123456Z'}, {confirmed_rows: 5}, {confirmed_rows: null}, {cancel_requested: null}, {total_rows: 0}, {label: '<img>'}]) await assert.rejects(check(J.list([J.item(2, patch)])));
  await assert.rejects(check(J.list([J.item(), J.item()])));
});
test('J04 discovery validates all three descending keyset columns without timestamp rounding', async () => {
  const C = await F.load('contract.mjs'), row = J.item();
  for (const prior of [{...J.cursor(row), updated_at: '2026-10-23T12:00:00.123457Z'}, {...J.cursor(row), source_ref: F.OTHER}, {...J.cursor(row), job_ref: J.id(3)}]) assert.equal(C.validateJobList(J.list([row]), F.STAMP, true, prior).items.length, 1);
  for (const prior of [J.cursor(row), {...J.cursor(row), updated_at: '2026-10-23T12:00:00.123455Z'}, {...J.cursor(row), job_ref: J.id(1)}]) assert.throws(() => C.validateJobList(J.list([row]), F.STAMP, true, prior));
});
test('J05 busy discovery permits empty non-leaking snapshot and nullable progress only', async () => {
  assert.equal((await check(J.busy())).items.length, 0);
  const row = J.item(2, {created_at: null, updated_at: null, confirmed_rows: null, cancel_requested: null});
  assert.equal((await check(J.busy([row]))).items[0].confirmed_rows, null);
  for (const value of [J.busy([J.item()]), J.busy([row, {...row, job_ref: J.id(3)}]), J.busy([row], {next_cursor: J.cursor(J.item())})]) {
    if (value.result.items.length === 1 && value.result.items[0].created_at === null) value.result.next_cursor = J.cursor(J.item());
    await assert.rejects(check(value));
  }
});
test('J06 discovery rejects foreign account scope operation and unfinished mismatch', async () => {
  const C = await F.load('contract.mjs');
  for (const patch of [{context_ref: 'e'.repeat(64)}, {context_scope: 'library'}, {operation: 'status'}, {protocol: F.JOB}, {extra: true}]) assert.throws(() => C.validateJobList({...J.list(), ...patch}, F.STAMP, true));
  assert.throws(() => C.validateJobList(J.list([], {unfinished: false}), F.STAMP, true));
  await assert.rejects(check(J.list([J.item(2, {confirmed_rows: 4})])));
  assert.equal((await check(J.list([J.item(2, {confirmed_rows: 4})], {unfinished: false}))).items.length, 1);
});
