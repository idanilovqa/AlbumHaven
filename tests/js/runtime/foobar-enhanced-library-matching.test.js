'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('./foobar-enhanced-consumers-fixture.cjs'), {E, F, I} = M;

test('EM01 Enhanced selected-library command accepts exact scope while rejecting coercion and taste flags', async () => {
  const C = await F.load('contract.mjs');
  for (const scope of [null, 1, 23, Number.MAX_SAFE_INTEGER]) {
    const value = M.command({original_matching_library_id: scope}); assert.deepEqual(C.validateCommand(value), value); assert.ok(Object.isFrozen(C.validateCommand(value)));
  }
  for (const scope of [0, -1, 1.5, '23', true, {}, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => C.validateCommand(M.command({original_matching_library_id: scope})));
  for (const key of ['override_rating', 'favorite', 'native_state', 'path', 'playback_allowed']) assert.throws(() => C.validateCommand({...M.command(), [key]: true}));
});
test('EM02 Enhanced selected-library review admits association counts without native taste or diagnostic payloads', async () => {
  const C = await F.load('contract.mjs'), value = C.validateReview(M.review(), F.STAMP, 'status', F.SOURCE, F.JOBREF).review;
  assert.deepEqual(value.proposed_counts, [1, 3, 0, 0, 0, 0, 2]); assert.deepEqual(value.review_counts, [4, 2, 1, 2, 0, 1]);
  assert.equal(value.command.original_matching_library_id, 23); assert.deepEqual(value.conflicts, []); assert.deepEqual(value.problem_items, []);
  for (const index of [2, 3, 4, 5]) {
    const v = M.review(); v.result.review.proposed_counts[index] = 1;
    if (index < 4) v.result.review.proposed_counts[1]--;
    assert.throws(() => C.validateReview(v, F.STAMP, 'status', F.SOURCE, F.JOBREF));
  }
  for (const patch of [{review_counts: [4, 2, 1, 2, 1, 1]}, {problems_truncated: true}, {problem_after: 1}, {conflict_after: 1}]) {
    assert.throws(() => C.validateReview(M.review({review: M.proposal(patch)}), F.STAMP, 'status', F.SOURCE, F.JOBREF));
  }
});
test('EM03 Enhanced account-only review cannot claim selected-library association or ambiguity counts', async () => {
  const C = await F.load('contract.mjs');
  for (const patch of [{proposed_counts: [1, 3, 0, 0, 0, 0, 1]}, {review_counts: [4, 1, 0, 0, 0, 0]}, {review_counts: [4, 0, 1, 0, 0, 0]}]) {
    assert.throws(() => C.validateReview(E.review({review: E.proposal(patch)}), F.STAMP, 'status', F.SOURCE, F.JOBREF));
  }
  assert.equal(C.validateReview(E.review(), F.STAMP, 'status', F.SOURCE, F.JOBREF).review.command.original_matching_library_id, null);
});
test('EM04 actual Enhanced selected-library review and confirm retain exact scope File and sealed intent', async t => {
  const f = await F.controller(t, F.wire(), {library: '23'}), file = await M.ready(f);
  const review = f.wire.calls.find(call => call.route === '/review/start');
  assert.equal(review.init.body, file); assert.equal(review.init.headers['Content-Type'], 'application/vnd.sqlite3');
  assert.deepEqual(M.header(review), {version: F.REVIEW, source_ref: F.SOURCE, job_ref: F.JOBREF, mapping_name: E.IMPORT_MAPPING, matching_library_id: 23, resume: false, conflict_after: 0, problem_after: 0, previous_review_sha256: null});
  assert.equal(f.wire.calls.some(call => call.route === '/job/start'), false);
  f.wire.enqueue('/job/start', F.accepted(F.JOB, 'start')); await f.owner.confirm();
  const request = f.wire.calls.at(-1); assert.equal(request.init.body, file); assert.equal(request.route, '/job/start');
  assert.deepEqual(M.header(request), {version: F.JOB, ...M.command(), inventory_sha256: 'c'.repeat(64), review_sha256: 'd'.repeat(64)});
  assert.doesNotMatch(JSON.stringify(M.header(request)), /rating|favorite|override|native_state|path|playback/);
});
test('EM05 actual Enhanced matching-scope toggle invalidates review and requires a new account-only dry run', async t => {
  const f = await F.controller(t, F.wire(), {library: '23'}), file = await M.ready(f), count = f.wire.calls.length;
  f.owner.setMatching(false); assert.equal(f.owner.getState().review, null); await f.owner.confirm(); assert.equal(f.wire.calls.length, count);
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', E.review());
  await f.owner.preview(); assert.equal(f.wire.calls.at(-1).init.body, file); assert.equal(M.header(f.wire.calls.at(-1)).matching_library_id, null);
  await f.time.tick(); assert.equal(f.owner.getState().review.command.original_matching_library_id, null);
});
test('EM06 actual Enhanced absent selected library never enables matching or acquires authority from a response', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.owner.setMapping(E.IMPORT_MAPPING); f.owner.setMatching(true); f.owner.choose(E.file());
  assert.equal(f.owner.getState().matchingAvailable, false); assert.equal(f.owner.getState().matching, false);
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', M.review());
  await f.owner.preview(); assert.equal(M.header(f.wire.calls.at(-1)).matching_library_id, null); await f.time.tick();
  assert.equal(f.owner.getState().phase, 'error'); assert.equal(f.owner.getState().review, null); await f.owner.confirm(); assert.equal(f.wire.calls.some(call => call.route === '/job/start'), false);
});
test('EM07 actual Enhanced review rejects a foreign selected-library command before confirmation', async t => {
  const f = await F.controller(t, F.wire(), {library: '23'}); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.owner.setMapping(E.IMPORT_MAPPING); f.owner.choose(E.file()); f.owner.setMatching(true);
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', M.review({review: M.proposal({command: M.command({original_matching_library_id: 24})})}));
  await f.owner.preview(); await f.time.tick(); assert.equal(f.owner.getState().phase, 'error'); assert.equal(f.owner.getState().review, null);
  await f.owner.confirm(); assert.equal(f.wire.calls.some(call => call.route === '/job/start'), false);
});
test('EM08 actual Enhanced uncertain selected-library import locks original identity and never retries automatically', async t => {
  const f = await F.controller(t, F.wire(), {library: '23'}); await M.ready(f);
  f.wire.enqueue('/job/start', () => Promise.reject(new TypeError('synthetic lost acknowledgement'))); await f.owner.confirm();
  const count = f.wire.calls.length; f.owner.setMatching(false); f.owner.setMapping(F.MAPPING); await f.owner.selectSource(F.OTHER); f.owner.clear(); await f.owner.confirm();
  assert.equal(f.wire.calls.length, count); assert.equal(f.owner.getState().matching, true); assert.equal(f.owner.getState().mapping, E.IMPORT_MAPPING);
  assert.equal(f.owner.getState().jobRef, F.JOBREF); assert.equal(f.owner.getState().source.source_ref, F.SOURCE); assert.equal(f.owner.getState().submitted, true);
  f.wire.enqueue('/job/status', M.job({uncertain: true, disposition: 'needs_reconciliation', phase: 'needs_reconciliation'})); await f.owner.refreshStatus();
  assert.equal(f.owner.getState().job.command.original_matching_library_id, 23); assert.equal(f.owner.getState().job.confirmed_rows, 2);
});
test('EM09 actual Enhanced selected-library recovery reselects exact artifact and resumes the original sealed job', async t => {
  const f = await F.controller(t, F.wire(), {library: '23'}); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.wire.enqueue('/job/status', M.job()); await f.owner.recoverJob(F.JOBREF, F.SOURCE); const count = f.wire.calls.length;
  await f.owner.resume(); assert.equal(f.wire.calls.length, count); assert.equal(f.owner.getState().matching, true);
  const file = E.file(); f.owner.choose(file);
  const remaining = M.proposal({resume: true, start_offset: 2, checked_rows: 2, proposed_counts: [0, 2, 0, 0, 0, 0, 1], review_counts: [2, 1, 0, 0, 0, 0]});
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', M.review({review: remaining})); await f.owner.resume();
  assert.equal(f.wire.calls.at(-1).init.body, file); assert.equal(M.header(f.wire.calls.at(-1)).matching_library_id, 23); assert.equal(M.header(f.wire.calls.at(-1)).resume, true);
  await f.time.tick(); f.wire.enqueue('/job/resume', F.accepted(F.JOB, 'resume')); await f.owner.confirm();
  assert.equal(f.wire.calls.at(-1).route, '/job/resume'); assert.equal(f.wire.calls.at(-1).init.body, file); assert.equal(M.header(f.wire.calls.at(-1)).original_matching_library_id, 23);
  assert.deepEqual(M.header(f.wire.calls.at(-1)), {version: F.JOB, ...M.command(), inventory_sha256: 'c'.repeat(64), review_sha256: 'd'.repeat(64)});
  assert.equal(f.wire.calls.some(call => call.route === '/job/start'), false);
});
test('EM10 actual Enhanced account or selected-library drift retires a pending matching review', async t => {
  for (const key of ['accountFoobarContext', 'accountFoobarMatchingLibraryId']) {
    const f = await F.controller(t, F.wire(), {library: '23'}), late = F.deferred(); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
    f.owner.setMapping(E.IMPORT_MAPPING); f.owner.choose(E.file()); f.owner.setMatching(true); f.wire.enqueue('/review/start', () => late.promise);
    const work = f.owner.preview(); f.root.dataset[key] = key === 'accountFoobarContext' ? 'e'.repeat(64) : '24';
    late.resolve({status: 200, body: {getReader() {assert.fail('Retired scope must not decode');}}}); await work; await f.owner.confirm();
    assert.equal(f.owner.getState().phase, 'retired'); assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().filename, ''); assert.equal(f.wire.calls.length, 3);
  }
});
test('EM11 actual Enhanced recovery cannot replace original upload scope generation or total-row identity', async t => {
  for (const patch of [{upload_sha256: 'e'.repeat(64)}, {original_matching_library_id: 24}, {original_generation: 2}, {total_rows: 5}]) {
    const f = await F.controller(t, F.wire(), {library: '23'}); await M.ready(f); f.wire.enqueue('/job/start', () => Promise.reject(new TypeError('uncertain'))); await f.owner.confirm();
    f.wire.enqueue('/job/status', M.job({command: M.command(patch), remaining_rows: patch.total_rows ? 3 : 2})); await f.owner.refreshStatus();
    assert.equal(f.owner.getState().phase, 'paused'); assert.equal(f.owner.getState().job, null); assert.equal(f.owner.getState().jobRef, F.JOBREF); assert.equal(f.owner.getState().review, null);
    assert.match(f.owner.getState().error, /changed/); assert.equal(f.wire.calls.filter(call => call.route === '/job/start').length, 1);
  }
});
test('EM12 actual Enhanced file reselection clears prior matching review without changing source evidence scope', async t => {
  const f = await F.controller(t, F.wire(), {library: '23'}); await M.ready(f); const count = f.wire.calls.length;
  f.owner.choose(E.file('other.sqlite')); await f.owner.confirm(); assert.equal(f.wire.calls.length, count); assert.equal(f.owner.getState().review, null);
  assert.equal(f.owner.getState().matching, true); assert.equal(f.owner.getState().phase, 'selected'); assert.equal(f.owner.getState().filename, 'other.sqlite');
});
test('EM13 genuine Enhanced matching review labels association counts and requires explicit import confirmation', async t => {
  const f = await I.native(t, F.wire(), {library: '23'}), file = await M.nativeReview(f);
  assert.equal(f.field('matching').checked, true); assert.equal(f.field('matching').disabled, false);
  for (const text of ['Records with a permitted library association', 'Ambiguous aliases or conflicting associations', 'No native rating/favourite change or playback grant']) assert.ok(f.host.textContent.includes(text), text);
  assert.equal(f.host.querySelector('.foobar-import__personal').hidden, true); assert.equal(f.action('savePersonal').disabled, true);
  f.click(f.action('confirm')); assert.equal(f.wire.calls.some(call => call.route === '/job/start'), false);
  f.field('confirmation').checked = true; f.change(f.field('confirmation')); f.wire.enqueue('/job/start', F.accepted(F.JOB, 'start')); f.click(f.action('confirm')); await F.settle();
  assert.equal(f.wire.calls.at(-1).init.body, file); assert.equal(M.header(f.wire.calls.at(-1)).original_matching_library_id, 23); assert.equal(f.field('matching').disabled, true);
});
test('EM14 genuine Enhanced foreign-library recovery exposes account status but disables scoped resume', async t => {
  const f = await I.native(t, F.wire(), {library: '24'}); await I.recover(f, M.job()); f.choose(E.file()); await F.settle();
  assert.equal(f.field('matching').checked, true); assert.equal(f.field('matching').disabled, true); assert.equal(f.action('resume').disabled, true);
  assert.match(f.host.textContent, /keeps its original library scope/); const count = f.wire.calls.length; f.click(f.action('resume')); assert.equal(f.wire.calls.length, count);
  assert.equal(f.wire.calls.filter(call => call.route === '/job/status').length, 1); assert.equal(f.wire.calls.some(call => call.route === '/review/start'), false);
});
test('EM15 genuine Enhanced account-only screen has no selected-library input or hidden native shell authority', async t => {
  const f = await I.native(t); f.field('mapping').value = E.IMPORT_MAPPING; f.change(f.field('mapping')); await F.settle();
  assert.equal(f.field('matching').disabled, true); assert.equal(f.field('matching').checked, false); assert.match(f.host.textContent, /No eligible current library/);
  assert.equal(f.host.querySelectorAll('input').some(input => input.name === 'matching_library_id'), false);
  assert.equal(f.c.AlbumHavenPrivateUITransport, undefined); assert.equal(f.c.TrackActionsRuntime, undefined); assert.equal(f.wire.calls.length, 2);
});
test('EM16 genuine Enhanced matching scope change clears checkbox and stale confirmation before any request', async t => {
  const f = await I.native(t, F.wire(), {library: '23'}); await M.nativeReview(f);
  f.field('confirmation').checked = true; f.change(f.field('confirmation')); assert.equal(f.action('confirm').disabled, false);
  f.field('matching').checked = false; f.change(f.field('matching')); await F.settle();
  assert.equal(f.field('confirmation').checked, false); assert.equal(f.action('confirm').disabled, true); assert.equal(f.action('preview').disabled, false);
  const count = f.wire.calls.length; f.click(f.action('confirm')); assert.equal(f.wire.calls.length, count); assert.equal(f.host.querySelector('.foobar-import__personal').hidden, true);
});
