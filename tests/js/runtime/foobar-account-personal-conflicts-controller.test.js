'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./foobar-account-personal-conflicts-fixture.cjs'), {F} = P;
const saves = f => f.wire.calls.filter(call => call.route === '/review/personal-changes');
const jobs = f => f.wire.calls.filter(call => (call.route.startsWith('/job/') && call.route !== '/job/list'));

test('P10 conflict pagination reuploads the identical File and visits all fields with exact totals', async t => {
  const f = await P.ready(t, {value: P.page()}), first = f.owner.getState().review;
  await P.startReview(f, P.page(true), 'nextConflictPage');
  const second = f.owner.getState().review, request = f.wire.calls.at(-2);
  assert.equal(request.init.body, f.selected);
  assert.deepEqual(JSON.parse(request.init.headers['X-AlbumHaven-Foobar-Command']), {version: F.REVIEW, source_ref: F.SOURCE, job_ref: F.JOBREF, mapping_name: F.MAPPING, matching_library_id: 23, resume: false, conflict_after: 64, problem_after: 0, previous_review_sha256: first.review_sha256});
  assert.equal(first.conflict_count, 40); assert.equal(second.conflict_count, 40);
  assert.deepEqual([...first.conflicts, ...second.conflicts].map(item => item.row), Array.from({length: 40}, (_, index) => index + 1));
  const before = f.wire.calls.length; await f.owner.nextConflictPage(); assert.equal(f.wire.calls.length, before);
  await P.startReview(f, P.page(), 'firstConflictPage');
  const reset = JSON.parse(f.wire.calls.at(-2).init.headers['X-AlbumHaven-Foobar-Command']);
  assert.equal(reset.conflict_after, 0); assert.equal(reset.previous_review_sha256, null); assert.equal(reset.job_ref, F.JOBREF);
  assert.equal(jobs(f).length, 0); assert.equal(saves(f).length, 0); assert.equal(f.owner.getState().submitted, false);
});
for (const drift of ['review digest', 'inventory digest', 'source generation', 'upload hash', 'exact count']) test(`P11 next conflict page rejects ${drift} drift without authorizing a save`, async t => {
  const f = await P.ready(t, {value: P.page()}), value = P.page(true);
  if (drift === 'review digest') value.review_sha256 = 'e'.repeat(64);
  if (drift === 'inventory digest') value.inventory_sha256 = 'e'.repeat(64);
  if (drift === 'source generation') value.command.original_generation = 2;
  if (drift === 'upload hash') value.command.upload_sha256 = 'e'.repeat(64);
  if (drift === 'exact count') value.conflict_count = 41;
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: value}));
  await f.owner.nextConflictPage(); await f.time.tick();
  assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().phase, 'error');
  const before = f.wire.calls.length; await f.owner.savePersonalChanges([{row: 33, field: 'rating'}]); await f.owner.confirm();
  assert.equal(f.wire.calls.length, before); assert.equal(saves(f).length, 0); assert.equal(jobs(f).length, 0);
});
test('P12 first review rejects a server page that does not match the requested cursor', async t => {
  const f = await F.controller(t, F.wire(), {library: '23'});
  f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.owner.choose(F.file()); f.owner.setMatching(true);
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: P.page(true)}));
  await f.owner.preview(); await f.time.tick(); assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().phase, 'error');
});
test('P13 partial per-field save carries only chosen identities and requires fresh review before import', async t => {
  const f = await P.ready(t), before = f.owner.getState();
  f.wire.enqueue('/review/personal-changes', P.receipt([P.favorite()])); await f.owner.savePersonalChanges([{row: 1, field: 'favorite'}]);
  const request = saves(f)[0]; assert.ok(request);
  assert.equal(request.init.method, 'POST'); assert.equal(request.init.credentials, 'same-origin'); assert.equal(request.init.cache, 'no-store'); assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers['Content-Type'], 'application/json'); assert.equal(request.init.headers['X-AlbumHaven-Foobar-Context'], F.STAMP);
  assert.equal(request.init.headers['X-AlbumHaven-Foobar-Command'], undefined); assert.equal(request.init.headers['X-Album-Haven-Foobar-Bytes'], undefined);
  assert.deepEqual(JSON.parse(request.init.body), {version: F.REVIEW, source_ref: F.SOURCE, job_ref: F.JOBREF, review_sha256: before.review.review_sha256, choices: [[1, 'favorite']]});
  const after = f.owner.getState(); assert.equal(after.review, null); assert.equal(after.phase, 'selected'); assert.equal(after.job, before.job); assert.equal(after.submitted, false); assert.equal(after.filename, before.filename); assert.equal(after.jobRef, before.jobRef);
  assert.match(after.notice, /No import was started/); assert.match(after.notice, /fresh review/); assert.equal(f.time.tasks.size, 0);
  await f.owner.confirm(); await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]); assert.equal(saves(f).length, 1); assert.equal(jobs(f).length, 0);
  await P.startReview(f, P.proposal({conflicts: [P.rating(), P.disabled()], conflict_count: 2, review_sha256: 'e'.repeat(64)}));
  assert.equal(f.wire.calls.at(-2).init.body, f.selected); assert.equal(f.owner.getState().jobRef, F.JOBREF);
  f.wire.enqueue('/job/start', F.accepted(F.JOB, 'start')); await f.owner.confirm();
  assert.equal(jobs(f).length, 1); assert.equal(JSON.parse(jobs(f)[0].init.headers['X-AlbumHaven-Foobar-Command']).review_sha256, 'e'.repeat(64));
});
test('P14 invalid empty duplicate disabled bulk or value-bearing choices never dispatch or consume review', async t => {
  const f = await P.ready(t), review = f.owner.getState().review;
  for (const choices of [[], 'all', [{all: true}], [{row: 1, field: 'all'}], [{row: 2, field: 'rating'}], [{row: 3, field: 'rating'}],
    [{row: 1, field: 'rating', proposed: 3}], [{row: 1, field: 'rating'}, {row: 1, field: 'rating'}], Array(33).fill({row: 1, field: 'rating'})]) {
    await f.owner.savePersonalChanges(choices); assert.equal(f.owner.getState().review, review); assert.equal(f.owner.getState().phase, 'review_ready');
  }
  assert.equal(saves(f).length, 0); assert.equal(jobs(f).length, 0); assert.equal(f.wire.calls.length, 4);
});
test('P15 personal dispatch synchronously burns review and locks duplicate competing operations', async t => {
  const f = await P.ready(t), late = F.deferred(); f.wire.enqueue('/review/personal-changes', () => late.promise);
  const pending = f.owner.savePersonalChanges([{row: 1, field: 'rating'}]);
  assert.equal(f.owner.getState().phase, 'saving_personal'); assert.equal(f.owner.getState().review, null);
  await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]); await f.owner.confirm(); await f.owner.preview(); await f.owner.nextConflictPage(); await f.owner.firstConflictPage();
  await f.owner.refreshStatus(); await f.owner.cancel(); await f.owner.selectSource(F.OTHER); await f.owner.recoverJob(F.OTHER, F.OTHER);
  f.owner.choose(F.file('replacement.tsv')); f.owner.setMatching(false); f.owner.clear();
  assert.equal(f.wire.calls.length, 5); assert.equal(saves(f).length, 1); assert.equal(jobs(f).length, 0); assert.equal(f.owner.getState().filename, f.selected.name);
  late.resolve(F.response(P.receipt())); await pending; assert.equal(f.time.tasks.size, 0); assert.equal(f.owner.getState().review, null);
});
test('P16 lost personal acknowledgement never auto-retries polls imports or reuses burned review', async t => {
  const f = await P.ready(t); f.wire.enqueue('/review/personal-changes', () => Promise.reject(new Error('lost response')));
  await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]);
  assert.equal(f.owner.getState().phase, 'error'); assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().submitted, false);
  assert.match(f.owner.getState().error, /may already have changed/); assert.match(f.owner.getState().error, /do not resend/);
  await F.settle(); await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]); await f.owner.confirm(); await f.owner.nextConflictPage(); await f.owner.refreshStatus();
  assert.equal(f.wire.calls.length, 5); assert.equal(saves(f).length, 1); assert.equal(jobs(f).length, 0); assert.equal(f.time.tasks.size, 0);
  await P.startReview(f, P.proposal({conflicts: [P.favorite(), P.disabled()], conflict_count: 2, review_sha256: 'e'.repeat(64)}));
  assert.equal(f.wire.calls.at(-2).init.body, f.selected); assert.equal(f.owner.getState().jobRef, F.JOBREF); assert.equal(saves(f).length, 1);
  await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]); assert.equal(saves(f).length, 1);
});
for (const invalid of ['wrong field', 'partial receipt', 'import claim', 'malformed body']) test(`P17 ${invalid} acknowledgement cannot prove personal success or unlock stale confirmation`, async t => {
  const f = await P.ready(t);
  let response = P.receipt();
  if (invalid === 'wrong field') response = P.receipt([P.favorite()]);
  if (invalid === 'partial receipt') response = P.receipt([], {});
  if (invalid === 'import claim') response.result.import_started = true;
  f.wire.enqueue('/review/personal-changes', invalid === 'malformed body' ? () => Promise.resolve(new Response('{', {headers: {'Content-Type': 'application/json'}})) : response);
  await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]);
  assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().phase, 'error'); assert.doesNotMatch(f.owner.getState().notice, /^Saved/);
  await f.owner.confirm(); await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]); assert.equal(saves(f).length, 1); assert.equal(jobs(f).length, 0); assert.equal(f.time.tasks.size, 0);
});
for (const code of ['stale_import', 'commit_uncertain']) test(`P18 ${code} personal rejection burns proposal and demands fresh review`, async t => {
  const f = await P.ready(t); f.wire.enqueue('/review/personal-changes', () => Promise.resolve(F.response(P.rejection(code), code === 'stale_import' ? 409 : 503)));
  await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]); assert.equal(f.owner.getState().review, null);
  assert.match(f.owner.getState().error, /fresh review/); await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]);
  assert.equal(saves(f).length, 1); assert.equal(jobs(f).length, 0); assert.equal(f.time.tasks.size, 0);
});
test('P19 a personal save during resume never modifies the server-confirmed import prefix or counters', async t => {
  const f = await F.controller(t, F.wire(), {library: '23'}), command = F.command({original_matching_library_id: 23});
  f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.wire.enqueue('/job/status', F.job({command})); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  const job = f.owner.getState().job; f.owner.choose(F.file());
  const conflict = P.rating({row: 3});
  await P.startReview(f, P.proposal({command, resume: true, start_offset: 2, checked_rows: 2, proposed_counts: [1, 1, 0, 0, 1, 0, 0], review_counts: [2, 0, 0, 0, 1, 0], conflicts: [conflict], conflict_count: 1}), 'resume');
  f.wire.enqueue('/review/personal-changes', P.receipt([conflict])); await f.owner.savePersonalChanges([{row: 3, field: 'rating'}]);
  assert.equal(f.owner.getState().job, job); assert.equal(f.owner.getState().job.confirmed_rows, 2); assert.equal(f.owner.getState().job.remaining_rows, 2);
  assert.deepEqual(f.owner.getState().job.confirmed_counts, [0, 1, 0, 1, 1, 0, 1]); assert.equal(f.owner.getState().phase, 'paused'); assert.equal(f.owner.getState().submitted, true);
  assert.equal(jobs(f).length, 1); assert.equal(jobs(f)[0].route, '/job/status'); assert.equal(f.time.tasks.size, 0); assert.match(f.owner.getState().notice, /import progress is unchanged/);
});
for (const drift of ['session', 'scope', 'library', 'permission', 'owner', 'dispose']) test(`P20 in-flight personal save cannot survive ${drift} replacement or late success`, async t => {
  const f = await P.ready(t), late = F.deferred(); f.wire.enqueue('/review/personal-changes', () => late.promise);
  const pending = f.owner.savePersonalChanges([{row: 1, field: 'rating'}]), request = saves(f)[0];
  if (drift === 'session') f.root.dataset.accountFoobarContext = 'e'.repeat(64);
  if (drift === 'scope') f.root.dataset.accountFoobarScope = 'library';
  if (drift === 'library') f.root.dataset.accountFoobarMatchingLibraryId = '24';
  if (drift === 'permission') f.allow(false);
  if (drift === 'owner') f.current(false);
  if (drift === 'dispose') f.owner.dispose();
  late.resolve(F.response(P.receipt())); await pending;
  assert.equal(f.owner.getState().phase, 'retired'); assert.equal(f.owner.getState().review, null); assert.equal(request.init.signal.aborted, true);
  assert.doesNotMatch(f.owner.getState().notice, /^Saved/); assert.equal(saves(f).length, 1); assert.equal(jobs(f).length, 0); assert.equal(f.time.tasks.size, 0);
});
for (const changed of ['source', 'file', 'matching']) test(`P21 changing ${changed} prevents any stale personal selection dispatch`, async t => {
  const f = await P.ready(t);
  if (changed === 'source') {f.wire.enqueue('/ui/source', F.envelope('foobar_account_import_v4', 'source', {...F.source().result, source_ref: F.OTHER})); await f.owner.selectSource(F.OTHER);}
  if (changed === 'file') f.owner.choose(F.file('another.tsv'));
  if (changed === 'matching') f.owner.setMatching(false);
  assert.equal(f.owner.getState().review, null); await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]); await f.owner.confirm();
  assert.equal(saves(f).length, 0); assert.equal(jobs(f).length, 0);
});
for (const status of [401, 403]) test(`P22 personal ${status} denial retires without reading hostile body or retrying`, async t => {
  const f = await P.ready(t); let reads = 0;
  f.wire.enqueue('/review/personal-changes', () => Promise.resolve({status, get body() {reads++; throw new Error('Denied response body must not be consumed');}}));
  await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]); assert.equal(reads, 0); assert.equal(f.owner.getState().phase, 'retired');
  await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]); await f.owner.preview(); assert.equal(saves(f).length, 1); assert.equal(f.time.tasks.size, 0);
});
test('P39 full 32-field labeled review uses the review-only response allowance', async t => {
  const value = P.page(); value.conflicts = value.conflicts.map(item => ({...item, source_artist: 'A'.repeat(48), source_title: 'T'.repeat(96), source_album: 'B'.repeat(48)}));
  const size = new TextEncoder().encode(JSON.stringify(F.review({review: value}))).byteLength;
  assert.ok(size > 12288 && size <= 32768, 'Fixture must genuinely cross the old response limit without exceeding the bounded review allowance');
  const f = await P.ready(t, {value}); assert.equal(f.owner.getState().review.conflicts.length, 32); assert.equal(f.owner.getState().review.conflicts[0].source_title.length, 96);
});
test('P40 job status retains the smaller response cap rather than inheriting the review allowance', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  const response = F.response(F.job()); response.headers.set('Content-Length', '13000');
  f.wire.enqueue('/job/status', () => Promise.resolve(response)); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  assert.equal(f.owner.getState().job, null); assert.equal(f.owner.getState().phase, 'paused'); assert.equal(f.time.tasks.size, 0);
});
