'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const D = require('./foobar-account-diagnostic-pages-fixture.cjs'), {P, F} = D;
const writes = f => f.wire.calls.filter(x => (x.route.startsWith('/job/') && x.route !== '/job/list') || x.route === '/review/personal-changes');
test('D06 independent page cursors preserve File identity scope digest and unchanged page contents', async t => {
  const f = await P.ready(t, {value: D.page()}), initial = f.owner.getState().review;
  await P.startReview(f, D.page(true), 'nextProblemPage');
  const first = f.wire.calls.at(-2);
  assert.equal(first.init.body, f.selected); assert.equal(first.init.headers['X-AlbumHaven-Foobar-Context'], F.STAMP);
  assert.deepEqual(D.header(first), {version: F.REVIEW, source_ref: F.SOURCE, job_ref: F.JOBREF, mapping_name: F.MAPPING, matching_library_id: 23, resume: false, conflict_after: 0, problem_after: 63, previous_review_sha256: initial.review_sha256});
  assert.deepEqual(f.owner.getState().review.conflicts, initial.conflicts);
  await P.startReview(f, D.page(true, true), 'nextConflictPage');
  assert.equal(f.wire.calls.at(-2).init.body, f.selected); assert.equal(D.header(f.wire.calls.at(-2)).problem_after, 63); assert.equal(D.header(f.wire.calls.at(-2)).conflict_after, 64);
  assert.deepEqual(f.owner.getState().review.problem_items, D.page(true).problem_items);
  const count = f.wire.calls.length; await f.owner.nextProblemPage(); await f.owner.nextConflictPage(); assert.equal(f.wire.calls.length, count);
  assert.equal(writes(f).length, 0); assert.equal(f.owner.getState().submitted, false);
});
test('D07 either First action resets both cursors and discards continuation digest', async t => {
  const f = await P.ready(t, {value: D.page()});
  for (const method of ['firstProblemPage', 'firstConflictPage']) {
    await P.startReview(f, D.page(true), 'nextProblemPage'); await P.startReview(f, D.page(true, true), 'nextConflictPage');
    await P.startReview(f, D.page(), method);
    const request = f.wire.calls.at(-2); assert.equal(request.init.body, f.selected);
    assert.deepEqual(D.header(request), {version: F.REVIEW, source_ref: F.SOURCE, job_ref: F.JOBREF, mapping_name: F.MAPPING, matching_library_id: 23, resume: false, conflict_after: 0, problem_after: 0, previous_review_sha256: null});
  }
  assert.equal(writes(f).length, 0);
});
test('D08 continuation rejects exact-count digest unchanged-page and consumed-remaining drift', async t => {
  const mutations = [v => v.problem_count++, v => v.review_sha256 = 'e'.repeat(64), v => v.inventory_sha256 = 'e'.repeat(64),
    v => v.command.upload_sha256 = 'e'.repeat(64), v => v.conflicts[0].source_title = 'Changed label',
    v => {v.problem_items.pop();}, v => v.problem_after = 62];
  for (const mutate of mutations) {
    const f = await P.ready(t, {value: D.page()}), value = D.page(true); mutate(value);
    f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: value}));
    await f.owner.nextProblemPage(); await f.time.tick(); assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().phase, 'error');
    const before = f.wire.calls.length; await f.owner.confirm(); await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]); assert.equal(f.wire.calls.length, before);
    f.owner.dispose(); f.time.restore();
  }
});
test('D09 lost problem-page start acknowledgement never repeats upload or licenses stale actions', async t => {
  const f = await P.ready(t, {value: D.page()}); f.wire.enqueue('/review/start', () => Promise.reject(new Error('lost response')));
  await f.owner.nextProblemPage(); await F.settle();
  assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().phase, 'error');
  const before = f.wire.calls.length; await f.owner.nextProblemPage(); await f.owner.nextConflictPage(); await f.owner.confirm(); await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]);
  assert.equal(f.wire.calls.length, before); assert.equal(f.time.tasks.size, 0); assert.equal(writes(f).length, 0);
  await P.startReview(f, D.page()); assert.equal(D.header(f.wire.calls.at(-2)).problem_after, 0); assert.equal(D.header(f.wire.calls.at(-2)).previous_review_sha256, null);
});
test('D10 context replacement retires pending problem page and discards late response', async t => {
  const f = await P.ready(t, {value: D.page()}), late = F.deferred(); f.wire.enqueue('/review/start', () => late.promise);
  const pending = f.owner.nextProblemPage(), request = f.wire.calls.at(-1); f.root.dataset.accountFoobarContext = 'e'.repeat(64);
  late.resolve(F.response(F.accepted(F.REVIEW, 'start'))); await pending;
  assert.equal(f.owner.getState().phase, 'retired'); assert.equal(f.owner.getState().review, null); assert.equal(request.init.signal.aborted, true); assert.equal(f.time.tasks.size, 0); assert.equal(writes(f).length, 0);
});
test('D11 problem paging preserves explicit per-field save semantics without starting import', async t => {
  const f = await P.ready(t, {value: D.page()}); await P.startReview(f, D.page(true), 'nextProblemPage');
  f.wire.enqueue('/review/personal-changes', P.receipt([P.rating()])); await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]);
  assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].route, '/review/personal-changes'); assert.deepEqual(JSON.parse(writes(f)[0].init.body).choices, [[1, 'rating']]);
  assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().submitted, false); assert.equal(f.time.tasks.size, 0);
});
