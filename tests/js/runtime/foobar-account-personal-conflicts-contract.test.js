'use strict';
// Source-authored only. Execute only after an independent review and a fresh parent release.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./foobar-account-personal-conflicts-fixture.cjs'), {F} = P;
const validate = (C, proposal) => C.validateReview(F.review({review: proposal}), F.STAMP, 'status', F.SOURCE, F.JOBREF).review;

test('P01 review v2 requires the exact extended DTO while ordinary job v2 is unchanged', async () => {
  const C = await F.load('contract.mjs');
  assert.equal(C.REVIEW, 'foobar_account_review_v4'); assert.equal(C.JOB, 'foobar_account_job_v3');
  const value = F.review({review: P.proposal()}); assert.equal(C.validateReview(value, F.STAMP, 'status', F.SOURCE, F.JOBREF).review.conflicts.length, 3);
  for (const protocol of ['foobar_account_review_v1', F.JOB]) assert.throws(() => C.validateReview({...value, protocol}, F.STAMP, 'status', F.SOURCE, F.JOBREF));
  for (const key of ['conflicts', 'conflict_count', 'conflict_after', 'conflict_next', 'conflict_remaining']) {
    const copy = P.proposal(); delete copy[key]; assert.throws(() => validate(C, copy), key);
  }
  assert.deepEqual(C.validateJob(F.job(), F.STAMP, 'status', F.SOURCE, F.JOBREF).command, F.command());
  assert.throws(() => C.validateJob(F.job({conflicts: []}), F.STAMP, 'status', F.SOURCE, F.JOBREF));
});
test('P02 exact conflict totals include disabled fields on every bounded page', async () => {
  const C = await F.load('contract.mjs'), first = validate(C, P.page()), second = validate(C, P.page(true));
  assert.equal(first.conflicts.length, 32); assert.equal(first.conflict_count, 40); assert.equal(first.conflict_remaining, 8); assert.equal(first.conflict_next, 64);
  assert.equal(second.conflicts.length, 8); assert.equal(second.conflict_count, 40); assert.equal(second.conflict_remaining, 0); assert.equal(second.conflict_next, null);
  assert.equal(first.conflicts[2].eligible, false); assert.equal(second.conflicts[2].eligible, false);
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.conflicts)); assert.ok(first.conflicts.every(Object.isFrozen));
  assert.deepEqual([...first.conflicts, ...second.conflicts].map(item => item.row), Array.from({length: 40}, (_, index) => index + 1));
});
test('P03 conflict count cursor order and 32-field page bounds fail closed', async () => {
  const C = await F.load('contract.mjs');
  for (const patch of [{conflict_count: 39}, {conflict_count: 81}, {conflict_count: true}, {conflict_remaining: -1}, {conflict_remaining: 9},
    {conflict_after: -1}, {conflict_after: true}, {conflict_after: 82}, {conflict_next: null}, {conflict_next: 63}, {conflict_next: 65},
    {conflicts: P.page().conflicts.slice(0, 31)}, {conflicts: [...P.page().conflicts, P.rating({row: 33})]},
    {conflicts: [...P.page().conflicts].reverse()}, {conflicts: [P.rating(), P.rating(), ...P.page().conflicts.slice(2)]}]) assert.throws(() => validate(C, P.page(false, patch)), JSON.stringify(patch));
  for (const patch of [{conflict_next: 80}, {conflicts: [P.rating({row: 32}), ...P.page(true).conflicts.slice(1)]}]) assert.throws(() => validate(C, P.page(true, patch)));
  assert.throws(() => validate(C, P.proposal({conflicts: [], conflict_count: 3})), 'A truncated empty first page cannot claim a complete list');
});
test('P04 conflict DTO excludes ownership native fences raw values and inexact identities', async () => {
  const C = await F.load('contract.mjs');
  for (const patch of [{row: 0}, {row: 5}, {row: true}, {row: '1'}, {field: 'rating_stars'}, {field: 'all'}, {account_id: 1},
    {file_id: 9}, {expected_state: []}, {fence_sha256: 'e'.repeat(64)}, {association_seal: []}, {source_identity_sha256: 'e'.repeat(64)},
    {source_revision: 1}, {raw_cells: []}, {existing: '<img onerror=alert(1)>'}, {eligible: 'true'}, {reason: 'raw-secret'}]) {
    assert.throws(() => validate(C, P.proposal({conflicts: [P.rating(patch)], conflict_count: 1})), JSON.stringify(patch));
  }
});
test('P05 personal rating proposals are exact integers one through five and never clears', async () => {
  const C = await F.load('contract.mjs');
  for (const proposed of [1, 2, 3, 4, 5]) {
    const value = validate(C, P.proposal({conflicts: [P.rating({existing: null, proposed})], conflict_count: 1}));
    assert.equal(C.validatePersonalChoices([{row: 1, field: 'rating'}], value)[0].proposed, proposed);
  }
  for (const proposed of [null, undefined, false, true, 0, -1, 6, 1.5, '5', '', NaN, Infinity]) assert.throws(() => validate(C, P.proposal({conflicts: [P.rating({proposed})], conflict_count: 1})));
  for (const existing of [0, -1, 6, 1.5, false, true, '2', 5]) assert.throws(() => validate(C, P.proposal({conflicts: [P.rating({existing})], conflict_count: 1})));
});
test('P06 personal favourite proposals allow only Off to Loved without demotions', async () => {
  const C = await F.load('contract.mjs'); validate(C, P.proposal({conflicts: [P.favorite()], conflict_count: 1}));
  for (const patch of [{existing: 'loved'}, {existing: 'obsessed'}, {existing: null}, {existing: false}, {proposed: 'off'}, {proposed: 'obsessed'}, {proposed: true}, {proposed: false},
    {existing: 'loved', eligible: false, reason: 'provenance_requires_review'}, {existing: 'obsessed', eligible: false, reason: 'provenance_requires_review'}]) {
    assert.throws(() => validate(C, P.proposal({conflicts: [P.favorite(patch)], conflict_count: 1})), JSON.stringify(patch));
  }
});
test('P07 provenance requiring review remains visible counted and impossible to select', async () => {
  const C = await F.load('contract.mjs'), value = validate(C, P.proposal());
  assert.equal(value.conflict_count, 3); assert.equal(value.conflicts[2].reason, 'provenance_requires_review');
  assert.throws(() => C.validatePersonalChoices([{row: 2, field: 'rating'}], value));
  for (const patch of [{eligible: false, reason: null}, {eligible: true, reason: 'provenance_requires_review'}, {eligible: false, reason: 'malformed_path'}, {eligible: 0}]) assert.throws(() => validate(C, P.proposal({conflicts: [P.rating(patch)], conflict_count: 1})));
});
test('P08 individual selection is an exact current-page subset with no all shortcut and maximum 32', async () => {
  const C = await F.load('contract.mjs'), value = validate(C, P.proposal());
  const chosen = C.validatePersonalChoices([{row: 1, field: 'favorite'}], value);
  assert.deepEqual(chosen, P.changed([P.favorite()])); assert.ok(Object.isFrozen(chosen)); assert.ok(Object.isFrozen(chosen[0]));
  for (const choices of [[], 'all', {all: true}, [{all: true}], [{row: 1, field: 'all'}], [{row: 1, field: 'rating', proposed: 1}],
    [{row: 1, field: 'rating'}, {row: 1, field: 'rating'}], [{row: 3, field: 'rating'}], [[1, 'rating']], [{row: true, field: 'rating'}]]) assert.throws(() => C.validatePersonalChoices(choices, value));
  const all32 = validate(C, P.page(false, {conflicts: P.page().conflicts.map(item => ({...item, eligible: true, reason: null}))}));
  assert.equal(C.validatePersonalChoices(P.choices(all32.conflicts), all32).length, 32);
  assert.throws(() => C.validatePersonalChoices([...P.choices(all32.conflicts), {row: 33, field: 'rating'}], all32));
  assert.throws(() => C.validatePersonalChoices([{row: 33, field: 'rating'}], all32));
});
test('P09 personal acknowledgement must exactly match selected fields and cannot claim import progress', async () => {
  const C = await F.load('contract.mjs'), selection = P.changed([P.rating(), P.favorite()]);
  const result = C.validatePersonalChanges(P.receipt([P.favorite(), P.rating()]), F.STAMP, selection);
  assert.equal(result.import_started, false); assert.ok(Object.isFrozen(result.changed_fields)); assert.ok(result.changed_fields.every(Object.isFrozen));
  for (const mutate of [v => v.protocol = F.JOB, v => v.context_ref = 'e'.repeat(64), v => v.context_scope = 'library', v => v.operation = 'start',
    v => v.result.phase = 'completed', v => v.result.import_started = true, v => v.result.confirmed_rows = 1, v => v.result.confirmed_counts = [0, 1, 0, 0, 1, 0, 0],
    v => v.result.changed_fields.pop(), v => v.result.changed_fields.push(P.changed([P.rating({row: 3})])[0]),
    v => v.result.changed_fields[1] = {...v.result.changed_fields[0]}, v => v.result.changed_fields[0].proposed = 4,
    v => v.result.changed_fields[0].existing = 1, v => v.result.changed_fields[0].row = 2, v => v.result.changed_fields[0].source_ref = F.SOURCE]) {
    const value = P.receipt([P.rating(), P.favorite()]); mutate(value); assert.throws(() => C.validatePersonalChanges(value, F.STAMP, selection));
  }
});
test('P35 source labels enforce UTF-8 byte bounds exact fields and no Unicode control categories', async () => {
  const C = await F.load('contract.mjs');
  for (const [field, maximum] of [['source_artist', 48], ['source_title', 96], ['source_album', 48]]) {
    for (const value of ['', 'A'.repeat(maximum), 'é'.repeat(maximum / 2), '曲'.repeat(maximum / 3), '🎵'.repeat(maximum / 4), '<img src=x onerror=alert(1)>']) {
      assert.equal(validate(C, P.proposal({conflicts: [P.rating({[field]: value})], conflict_count: 1})).conflicts[0][field], value);
    }
    for (const value of [null, false, 7, [], {}, 'A'.repeat(maximum + 1), 'é'.repeat(maximum / 2 + 1), '曲'.repeat(maximum / 3 + 1), '🎵'.repeat(maximum / 4 + 1),
      'bad\u0000label', 'bad\nlabel', 'bad\tlabel', 'bad\u007flabel', 'bad\u0085label', 'bad\u202elabel', 'bad\u2066label', 'bad\u200dlabel', 'bad\ud800label', 'bad\ue000label', 'bad\u2028label', 'bad\u2029label']) {
      assert.throws(() => validate(C, P.proposal({conflicts: [P.rating({[field]: value})], conflict_count: 1})), field + ': ' + JSON.stringify(value));
    }
    const missing = P.rating(); delete missing[field]; assert.throws(() => validate(C, P.proposal({conflicts: [missing], conflict_count: 1})));
  }
});
test('P36 review response allowance is bounded at 32 KiB without enlarging the ordinary 12 KiB reader', async () => {
  const C = await F.load('contract.mjs'); assert.equal(C.MAX_RESPONSE_BYTES, 12288); assert.equal(C.MAX_REVIEW_RESPONSE_BYTES, 65536);
  const medium = {padding: 'x'.repeat(13000)};
  await assert.rejects(C.readBoundedJSON(F.response(medium)));
  assert.deepEqual(await C.readBoundedJSON(F.response(medium), undefined, C.MAX_REVIEW_RESPONSE_BYTES), medium);
  await assert.rejects(C.readBoundedJSON(F.response({padding: 'x'.repeat(65536)}), undefined, C.MAX_REVIEW_RESPONSE_BYTES));
  await assert.rejects(C.readBoundedJSON(new Response('{}', {headers: {'Content-Type': 'application/json', 'Content-Length': '65537'}}), undefined, C.MAX_REVIEW_RESPONSE_BYTES));
  for (const maximum of [0, 12289, 32769, 65537, Infinity, '32768']) await assert.rejects(C.readBoundedJSON(F.response({}), undefined, maximum));
});
