'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const E = require('./foobar-enhanced-v4-fixture.cjs'), {F} = E;
const header = call => JSON.parse(call.init.headers['X-AlbumHaven-Foobar-Command']);

test('EI01 actual Enhanced review streams the identical File with explicit SQLite MIME mapping and size', async t => {
  const f = await F.controller(t, F.wire(), {library: '23'}), file = await E.importReady(f);
  const request = f.wire.calls.find(call => call.route === '/review/start');
  assert.equal(request.init.body, file); assert.equal(request.init.headers['Content-Type'], 'application/vnd.sqlite3'); assert.equal(request.init.headers['X-Album-Haven-Foobar-Bytes'], '100');
  assert.deepEqual(header(request), {version: F.REVIEW, source_ref: F.SOURCE, job_ref: F.JOBREF, mapping_name: E.IMPORT_MAPPING, matching_library_id: null, resume: false, conflict_after: 0, problem_after: 0, previous_review_sha256: null});
  assert.equal(f.owner.getState().mapping, E.IMPORT_MAPPING); assert.equal(f.owner.getState().matching, false); assert.equal(f.owner.getState().job, null);
  assert.ok(f.wire.calls.every(call => call.init.credentials === 'same-origin' && call.init.redirect === 'error' && call.init.cache === 'no-store'));
});
test('EI02 actual Enhanced confirmation reuploads retained File only after explicit reviewed intent', async t => {
  const f = await F.controller(t), file = await E.importReady(f); assert.equal(f.wire.calls.filter(call => call.route === '/job/start').length, 0);
  f.wire.enqueue('/job/start', F.accepted(F.JOB, 'start')); await f.owner.confirm();
  const request = f.wire.calls.at(-1); assert.equal(request.route, '/job/start'); assert.equal(request.init.body, file); assert.equal(request.init.headers['Content-Type'], 'application/vnd.sqlite3');
  assert.deepEqual(header(request), {version: F.JOB, ...E.command(), inventory_sha256: 'c'.repeat(64), review_sha256: 'd'.repeat(64)});
  assert.equal(f.owner.getState().phase, 'importing'); assert.equal(f.owner.getState().job, null); assert.doesNotMatch(f.owner.getState().notice, /All rows are confirmed/);
});
test('EI03 actual Enhanced upload owns 610000ms deadline while JSON polling remains 60000ms', async t => {
  const f = await F.controller(t), wait = F.deferred(); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.owner.setMapping(E.IMPORT_MAPPING); f.owner.choose(E.file());
  f.wire.enqueue('/review/start', () => wait.promise); const pending = f.owner.preview();
  assert.deepEqual([...f.time.tasks.values()].map(task => task.delay), [610000]);
  wait.resolve(F.response(F.accepted(F.REVIEW, 'start'))); await pending;
  const poll = F.deferred(); f.wire.enqueue('/review/status', () => poll.promise); await f.time.tick();
  assert.deepEqual([...f.time.tasks.values()].map(task => task.delay), [60000]);
  poll.resolve(F.response(E.review())); await F.settle(); assert.equal(f.owner.getState().phase, 'review_ready'); assert.equal(f.time.tasks.size, 0);
});
test('EI04 actual Enhanced expired upload aborts and does not retry or silently start a job', async t => {
  const f = await F.controller(t), wait = F.deferred(); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.owner.setMapping(E.IMPORT_MAPPING); f.owner.choose(E.file());
  f.wire.enqueue('/review/start', () => wait.promise); const pending = f.owner.preview(), signal = f.wire.calls.at(-1).init.signal;
  await f.time.tick(610000); assert.equal(signal.aborted, true); wait.resolve(F.response(F.accepted(F.REVIEW, 'start'))); await pending;
  assert.equal(f.owner.getState().phase, 'error'); assert.equal(f.owner.getState().review, null); assert.equal(f.time.tasks.size, 0); assert.equal(f.wire.calls.length, 3);
});
test('EI05 actual format switch clears selected File review and matching while requiring fresh selection', async t => {
  const f = await F.controller(t, F.wire(), {library: '23'}); await F.ready(f, {matching: true});
  f.owner.setMapping(E.IMPORT_MAPPING); assert.equal(f.owner.getState().filename, ''); assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().matching, false);
  f.owner.setMatching(true); await f.owner.confirm(); await f.owner.preview(); assert.equal(f.wire.calls.length, 4); assert.equal(f.owner.getState().matching, true);
  assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().filename, '');
  f.owner.choose(E.file()); f.owner.setMapping(F.MAPPING); assert.equal(f.owner.getState().filename, ''); assert.equal(f.owner.getState().mapping, F.MAPPING); assert.equal(f.owner.getState().review, null);
});
test('EI06 actual Enhanced retained identity locks format source and matching during uncertain import', async t => {
  const f = await F.controller(t), file = await E.importReady(f); f.wire.enqueue('/job/start', () => Promise.reject(new TypeError('lost acknowledgement'))); await f.owner.confirm();
  f.owner.setMapping(F.MAPPING); f.owner.setMatching(true); await f.owner.selectSource(F.OTHER); f.owner.clear();
  assert.equal(f.owner.getState().mapping, E.IMPORT_MAPPING); assert.equal(f.owner.getState().jobRef, F.JOBREF); assert.equal(f.owner.getState().source.source_ref, F.SOURCE);
  assert.equal(f.owner.getState().matching, false); assert.equal(f.owner.getState().submitted, true); assert.equal(f.wire.calls.length, 5);
  f.owner.choose(file); assert.equal(f.owner.getState().jobRef, F.JOBREF);
});
test('EI07 actual Enhanced restart recovery requires original artifact reselection and same-job resume', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.wire.enqueue('/job/status', E.job({uncertain: true, disposition: 'needs_reconciliation', phase: 'needs_reconciliation'})); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  assert.equal(f.owner.getState().mapping, E.IMPORT_MAPPING); assert.equal(f.owner.getState().filename, ''); await f.owner.resume(); assert.equal(f.wire.calls.length, 3);
  const file = E.file(); f.owner.choose(file); f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', E.review({review: E.proposal({resume: true, start_offset: 2, checked_rows: 2, proposed_counts: [0, 2, 0, 0, 0, 0, 0], review_counts: [2, 0, 0, 1, 0, 0]})}));
  await f.owner.resume(); const request = f.wire.calls.at(-1); assert.equal(request.init.body, file); assert.equal(header(request).resume, true); assert.equal(header(request).job_ref, F.JOBREF);
  await f.time.tick(); f.wire.enqueue('/job/resume', F.accepted(F.JOB, 'resume')); await f.owner.confirm();
  assert.equal(f.wire.calls.at(-1).route, '/job/resume'); assert.equal(f.wire.calls.at(-1).init.body, file); assert.equal(header(f.wire.calls.at(-1)).job_ref, F.JOBREF);
  assert.equal(f.wire.calls.filter(call => call.route === '/job/start').length, 0);
});
test('EI08 actual Enhanced edited artifact review cannot replace original saved command or receipt identity', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.wire.enqueue('/job/status', E.job()); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  f.owner.choose(E.file('edited.sqlite')); f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', E.review({review: E.proposal({resume: true, command: E.command({upload_sha256: 'e'.repeat(64)})})}));
  await f.owner.resume(); await f.time.tick(); assert.equal(f.owner.getState().phase, 'paused'); assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().jobRef, F.JOBREF);
  await f.owner.confirm(); assert.equal(f.wire.calls.filter(call => call.route === '/job/resume').length, 0);
});
test('EI09 actual Enhanced receipt reconciliation may advance confirmed prefix without claiming review applied it', async t => {
  const f = await F.controller(t); await E.importReady(f); f.wire.enqueue('/job/start', () => Promise.reject(new TypeError('uncertain'))); await f.owner.confirm();
  f.wire.enqueue('/job/status', E.job({phase: 'needs_review', disposition: 'needs_review', confirmed_rows: 3, remaining_rows: 1, confirmed_counts: [0, 3, 0, 0, 0, 0, 0]})); await f.owner.refreshStatus();
  assert.equal(f.owner.getState().phase, 'paused'); assert.equal(f.owner.getState().job.confirmed_rows, 3); assert.equal(f.owner.getState().jobRef, F.JOBREF); assert.match(f.owner.getState().notice, /Only the confirmed prefix/);
  assert.equal(f.wire.calls.filter(call => call.route === '/job/start').length, 1); assert.equal(f.owner.getState().review, null);
});
test('EI10 actual Enhanced unavailable incoming summary exposes no personal saves matching or diagnostic dispatch', async t => {
  const f = await F.controller(t, F.wire(), {library: '23'}); await E.importReady(f); const count = f.wire.calls.length;
  assert.equal(f.owner.getState().review.review_counts[3], 2);
  await f.owner.savePersonalChanges([{row: 1, field: 'rating'}]); await f.owner.nextProblemPage(); await f.owner.nextConflictPage(); f.owner.setMatching(true);
  assert.equal(f.wire.calls.length, count); assert.equal(f.owner.getState().matching, true); assert.equal(f.owner.getState().review, null);
  await f.owner.confirm(); assert.equal(f.wire.calls.length, count);
  assert.ok(f.wire.calls.every(call => !call.route.includes('personal-changes')));
});
test('EI11 actual Enhanced late review after account or library authority replacement cannot be confirmed', async t => {
  for (const key of ['accountFoobarContext', 'accountFoobarMatchingLibraryId']) {
    const f = await F.controller(t), wait = F.deferred(); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.owner.setMapping(E.IMPORT_MAPPING); f.owner.choose(E.file());
    f.wire.enqueue('/review/start', () => wait.promise); const work = f.owner.preview(); f.root.dataset[key] = key === 'accountFoobarContext' ? 'e'.repeat(64) : '23';
    wait.resolve(F.response(F.accepted(F.REVIEW, 'start'))); await work; await f.owner.confirm();
    assert.equal(f.owner.getState().phase, 'retired'); assert.equal(f.owner.getState().filename, ''); assert.equal(f.owner.getState().review, null); assert.equal(f.wire.calls.length, 3);
  }
});
test('EI12 actual Enhanced cancellation retains durable prefix and never treats acceptance as completion', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.wire.enqueue('/job/status', E.job()); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  f.wire.enqueue('/job/cancel', F.envelope(F.JOB, 'cancel', {...E.job().result, cancel_pending: true, cancel_requested: true})); await f.owner.cancel();
  assert.equal(f.owner.getState().job.confirmed_rows, 2); assert.equal(f.owner.getState().phase, 'paused'); assert.equal(f.owner.getState().jobRef, F.JOBREF);
  f.wire.enqueue('/job/status', E.job({phase: 'cancelled', disposition: 'cancelled', cancel_requested: true})); await f.time.tick();
  assert.equal(f.owner.getState().job.confirmed_rows, 2); assert.equal(f.owner.getState().job.remaining_rows, 2); assert.doesNotMatch(f.owner.getState().notice, /All rows are confirmed/);
});
