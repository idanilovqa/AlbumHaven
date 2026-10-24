'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const D = require('./foobar-account-diagnostic-pages-fixture.cjs'), {F} = D;
test('D01 problem pagination counts instances rather than tracks and freezes every labeled item', async () => {
  const C = await F.load('contract.mjs'), first = D.validate(C, D.page()), second = D.validate(C, D.page(true));
  assert.equal(first.problem_count, 40); assert.equal(first.problem_next, 63); assert.equal(first.problem_remaining, 8);
  assert.equal(second.problem_count, 40); assert.equal(second.problem_next, null); assert.equal(second.problem_remaining, 0);
  const items = [...first.problem_items, ...second.problem_items];
  assert.deepEqual(items.map(x => x.cursor), Array.from({length: 40}, (_, n) => 32 + n));
  assert.equal(new Set(items.map(x => x.row)).size, 2);
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.problem_items)); assert.ok(items.every(Object.isFrozen));
});
test('D02 exact problem metadata is mandatory and legacy review v2 is rejected', async () => {
  const C = await F.load('contract.mjs');
  for (const key of ['problem_items', 'problem_count', 'problem_after', 'problem_next', 'problem_remaining']) {
    const value = D.page(); delete value[key]; assert.throws(() => D.validate(C, value), key);
  }
  const value = F.review({review: D.page()}); value.protocol = 'foobar_account_review_v2';
  assert.throws(() => C.validateReview(value, F.STAMP, 'status', F.SOURCE, F.JOBREF));
});
test('D03 malformed count bounds order cursor encoding and continuation fail closed', async () => {
  const C = await F.load('contract.mjs');
  for (const patch of [{problem_count: 39}, {problem_count: 1281}, {problem_count: true}, {problem_after: -1}, {problem_after: true}, {problem_after: 1312},
    {problem_remaining: 9}, {problem_remaining: -1}, {problem_next: null}, {problem_next: 62}, {problem_next: 64},
    {problem_items: D.page().problem_items.slice(0, 31)}, {problem_items: [...D.page().problem_items, D.item(32)]},
    {problem_items: [...D.page().problem_items].reverse()}, {problem_items: [D.item(0), D.item(0), ...D.page().problem_items.slice(2)]}]) assert.throws(() => D.validate(C, D.page(false, false, patch)));
  for (const patch of [{cursor: 31}, {cursor: 64}, {cursor: '32'}, {cursor: true}, {row: 0}, {row: 2}, {row: 41}, {code: 'secret'}, {field: 'secret'}, {raw_cells: []}, {account_id: 1}]) {
    assert.throws(() => D.validate(C, D.page(false, false, {problem_items: [D.item(0, patch), ...D.page().problem_items.slice(1)]})), JSON.stringify(patch));
  }
  assert.throws(() => D.validate(C, D.page(true, false, {problem_next: 71})));
  assert.throws(() => D.validate(C, D.page(true, false, {problem_items: [D.item(31), ...D.page(true).problem_items.slice(1)]})));
});
test('D04 problem labels require exact UTF8 bounds and reject controls missing fields and private data', async () => {
  const C = await F.load('contract.mjs');
  for (const [field, max] of [['source_artist', 48], ['source_title', 96], ['source_album', 48]]) {
    for (const text of ['', 'A'.repeat(max), 'é'.repeat(max / 2), '<img src=x onerror=alert(1)>']) {
      const value = D.page(); value.problem_items[0][field] = text; assert.equal(D.validate(C, value).problem_items[0][field], text);
    }
    for (const text of [null, false, 1, {}, 'é'.repeat(max / 2 + 1), 'x\n', 'x\u202e', 'x\u200d', 'x\ud800', 'x\ue000', 'x\u2028']) {
      const value = D.page(); value.problem_items[0][field] = text; assert.throws(() => D.validate(C, value));
    }
    const value = D.page(); delete value.problem_items[0][field]; assert.throws(() => D.validate(C, value));
  }
});
test('D05 simultaneous full labeled pages fit only the 64KiB review allowance and job cap stays 12KiB', async t => {
  const C = await F.load('contract.mjs'), value = D.page();
  for (const group of [value.conflicts, value.problem_items]) for (const item of group) Object.assign(item, {source_artist: String.fromCharCode(92).repeat(48), source_title: String.fromCharCode(92).repeat(96), source_album: String.fromCharCode(92).repeat(48)});
  const body = F.review({review: value}), size = new TextEncoder().encode(JSON.stringify(body)).length;
  assert.ok(size > 32768 && size <= 65536); assert.equal(C.MAX_REVIEW_RESPONSE_BYTES, 65536); assert.equal(C.MAX_RESPONSE_BYTES, 12288);
  await assert.rejects(C.readBoundedJSON(F.response(body)));
  assert.deepEqual(await C.readBoundedJSON(F.response(body), undefined, 65536), body);
  const f = await D.P.ready(t, {value}); assert.equal(f.owner.getState().review.problem_items.length, 32); assert.equal(f.owner.getState().review.conflicts.length, 32);
  await assert.rejects(C.readBoundedJSON(F.response({padding: 'x'.repeat(65536)}), undefined, 65536));
});
