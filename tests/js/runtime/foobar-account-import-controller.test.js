'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./foobar-account-import-fixture.cjs');

test('I09 account-only source selection and review use genuine same-origin POST/context/size contract', async t => {
  const f = await F.controller(t), selected = await F.ready(f);
  assert.deepEqual(f.wire.calls.map(call => call.route), ['/job/list', '/ui/source', '/review/start', '/review/status']);
  for (const {init} of f.wire.calls) {
    assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-AlbumHaven-Foobar-Context'], F.STAMP); assert.equal(init.headers['X-AlbumHaven-Context'], undefined);
  }
  assert.deepEqual(JSON.parse(f.wire.calls[1].init.body), {source_ref: null});
  const upload = f.wire.calls[2].init; assert.equal(upload.body, selected);
  assert.equal(upload.headers['X-Album-Haven-Foobar-Bytes'], String(selected.size));
  assert.equal(upload.headers['Content-Type'], 'text/tab-separated-values; charset=utf-8');
  assert.deepEqual(JSON.parse(upload.headers['X-AlbumHaven-Foobar-Command']), {version: F.REVIEW, source_ref: F.SOURCE, job_ref: F.JOBREF, mapping_name: F.MAPPING, matching_library_id: null, resume: false, conflict_after: 0, problem_after: 0, previous_review_sha256: null});
  assert.equal(f.owner.getState().job, null); assert.match(f.owner.getState().notice, /Nothing has been imported/);
});
test('I10 no job submit occurs until a real review and separate explicit confirm action', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  await f.owner.confirm(); f.owner.choose(F.file()); await f.owner.confirm(); assert.equal(f.wire.calls.length, 2);
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review());
  await f.owner.preview(); await f.owner.confirm(); assert.equal(f.wire.calls.length, 3);
  await f.time.tick(); assert.equal(f.wire.calls.length, 4); const selected = f.wire.calls[2].init.body;
  f.wire.enqueue('/job/start', F.accepted(F.JOB, 'start')); await f.owner.confirm();
  assert.equal(f.wire.calls[4].init.body, selected); const header = JSON.parse(f.wire.calls[4].init.headers['X-AlbumHaven-Foobar-Command']);
  assert.deepEqual(header, {version: F.JOB, ...F.command(), inventory_sha256: 'c'.repeat(64), review_sha256: 'd'.repeat(64)});
  assert.equal(f.owner.getState().phase, 'importing'); assert.equal(f.owner.getState().job, null);
  assert.doesNotMatch(f.owner.getState().notice, /All rows are confirmed/);
});
test('I11 changed selected File or matching scope invalidates the exact reviewed intent', async t => {
  const f = await F.controller(t, F.wire(), {library: '23'}); await F.ready(f);
  f.owner.setMatching(true); assert.equal(f.owner.getState().review, null); await f.owner.confirm(); assert.equal(f.wire.calls.length, 4);
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: F.proposal({command: F.command({original_matching_library_id: 23})})}));
  await f.owner.preview(); await f.time.tick(); f.owner.choose(F.file('new.tsv'));
  assert.equal(f.owner.getState().review, null); await f.owner.confirm(); assert.equal(f.wire.calls.length, 6);
});
test('I12 missing context, wrong scope, inexact library ID or denied policy sends no file or source request', async t => {
  const f = await F.controller(t); f.root.dataset.accountFoobarContext = '';
  await f.owner.initialize(); f.owner.choose(F.file()); await f.owner.preview(); assert.equal(f.wire.calls.length, 0); assert.equal(f.owner.getState().phase, 'retired');
  const {createImportController} = await F.load('controller.mjs');
  for (const patch of [{accountFoobarScope: 'goals-v1'}, {accountFoobarMatchingLibraryId: '9007199254740992'}, {accountFoobarMatchingLibraryId: '01'}, {accountFoobarMatchingLibraryId: '-1'}]) {
    const root = {isConnected: true, dataset: {accountFoobarContext: F.STAMP, accountFoobarScope: F.SCOPE, accountFoobarMatchingLibraryId: '', ...patch}};
    const owner = createImportController({fetch: () => assert.fail('invalid shell cannot fetch'), contextRoot: root, allows: () => true, isCurrent: () => true, onChange() {}});
    await owner.initialize(); assert.equal(owner.getState().phase, 'retired'); owner.dispose();
  }
});
test('I13 account self policy, not library browse, is required and rechecked for every action', async t => {
  const f = await F.controller(t); f.allow(false); await f.owner.initialize(); assert.equal(f.wire.calls.length, 0); assert.equal(f.owner.getState().phase, 'retired');
});
test('I14 initial source response cannot claim a different account marker or scope', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', {...F.source(), context_ref: 'e'.repeat(64)}); await f.owner.initialize();
  f.owner.choose(F.file()); await f.owner.preview(); assert.equal(f.wire.calls.length, 2); assert.equal(f.owner.getState().source, null); assert.equal(f.owner.getState().review, null);
});
for (const changed of ['accountFoobarContext', 'accountFoobarScope', 'accountFoobarMatchingLibraryId']) test(`I15 late review cannot survive ${changed} replacement`, async t => {
  const f = await F.controller(t), late = F.deferred(); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.owner.choose(F.file());
  f.wire.enqueue('/review/start', () => late.promise); const pending = f.owner.preview(), init = f.wire.calls.at(-1).init;
  f.root.dataset[changed] = changed === 'accountFoobarMatchingLibraryId' ? '24' : 'e'.repeat(64);
  late.resolve(F.response(F.accepted(F.REVIEW, 'start'))); await pending;
  assert.equal(init.signal.aborted, true); assert.equal(f.owner.getState().phase, 'retired'); assert.equal(f.owner.getState().filename, ''); assert.equal(f.owner.getState().review, null);
});
test('I16 a displayed review retires before another action after session or permission replacement', async t => {
  const f = await F.controller(t); await F.ready(f); f.allow(false); await f.owner.confirm();
  assert.equal(f.wire.calls.length, 4); assert.equal(f.owner.getState().phase, 'retired'); assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().filename, '');
});
for (const status of [401, 403]) test(`I17 consumed ${status} denial retires without reading hostile denial body`, async t => {
  const f = await F.controller(t); await F.ready(f);
  f.wire.enqueue('/job/start', () => Promise.resolve({status, body: {getReader() {assert.fail('Never decode denial');}}})); await f.owner.confirm();
  await f.owner.refreshStatus(); await f.owner.preview(); assert.equal(f.wire.calls.length, 5); assert.equal(f.owner.getState().phase, 'retired'); assert.equal(f.owner.getState().filename, '');
});
test('I18 repeated preview and confirmation clicks create one request each', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.owner.choose(F.file());
  const reviewStart = F.deferred(); f.wire.enqueue('/review/start', () => reviewStart.promise); const pending = f.owner.preview(); await f.owner.preview(); assert.equal(f.wire.calls.length, 3);
  reviewStart.resolve(F.response(F.accepted(F.REVIEW, 'start'))); await pending; f.wire.enqueue('/review/status', F.review()); await f.time.tick();
  const submit = F.deferred(); f.wire.enqueue('/job/start', () => submit.promise); const saving = f.owner.confirm(); await f.owner.confirm(); assert.equal(f.wire.calls.length, 5);
  submit.resolve(F.response(F.accepted(F.JOB, 'start'))); await saving;
});
test('I19 uncertain submit keeps same source/job and checks status rather than retrying start', async t => {
  const f = await F.controller(t); await F.ready(f); f.wire.enqueue('/job/start', () => Promise.reject(new TypeError('lost response'))); await f.owner.confirm();
  assert.equal(f.owner.getState().phase, 'paused'); assert.equal(f.owner.getState().jobRef, F.JOBREF); assert.equal(f.owner.getState().job, null);
  f.owner.clear(); await f.owner.selectSource(F.OTHER); await f.owner.confirm(); assert.equal(f.wire.calls.length, 5);
  f.wire.enqueue('/job/status', F.job({uncertain: true, error: 'commit_uncertain'})); await f.owner.refreshStatus();
  assert.deepEqual(JSON.parse(f.wire.calls.at(-1).init.body), {version: F.JOB, source_ref: F.SOURCE, job_ref: F.JOBREF});
  assert.equal(f.wire.calls.filter(call => call.route === '/job/start').length, 1);
});
test('I20 resume reviews same-file/same-job remainder before a distinct explicit resume submit', async t => {
  const f = await F.controller(t); await F.ready(f); f.wire.enqueue('/job/start', () => Promise.reject(new TypeError('lost'))); await f.owner.confirm();
  f.wire.enqueue('/job/status', F.job()); await f.owner.refreshStatus(); const original = F.file(); f.owner.choose(original);
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: F.proposal({resume: true, checked_rows: 2, start_offset: 2, proposed_counts: [0, 1, 0, 1, 0, 0, 1], review_counts: [2, 1, 0, 0, 0, 1]})}));
  await f.owner.resume(); const upload = f.wire.calls.at(-1); assert.equal(upload.init.body, original);
  assert.deepEqual(JSON.parse(upload.init.headers['X-AlbumHaven-Foobar-Command']), {version: F.REVIEW, source_ref: F.SOURCE, job_ref: F.JOBREF, mapping_name: F.MAPPING, matching_library_id: null, resume: true, conflict_after: 0, problem_after: 0, previous_review_sha256: null});
  await f.time.tick(); assert.equal(f.wire.calls.filter(call => call.route === '/job/resume').length, 0);
  f.wire.enqueue('/job/resume', F.accepted(F.JOB, 'resume')); await f.owner.confirm(); assert.equal(f.wire.calls.at(-1).init.body, original);
  assert.equal(JSON.parse(f.wire.calls.at(-1).init.headers['X-AlbumHaven-Foobar-Command']).job_ref, F.JOBREF);
});
test('I21 server rejection of different reselected bytes cannot replace a submitted import identity', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.wire.enqueue('/job/status', F.job()); await f.owner.recoverJob(F.JOBREF, F.SOURCE); f.owner.choose(F.file('changed.tsv', 'path\nother\n'));
  f.wire.enqueue('/review/start', () => Promise.resolve(F.response({protocol: F.REVIEW, error: 'stale_import'}, 409))); await f.owner.resume();
  assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().jobRef, F.JOBREF); await f.owner.confirm();
  assert.equal(f.wire.calls.filter(call => /^\/job\/(start|resume)$/.test(call.route)).length, 0);
});
test('I22 recovery reads exact saved identity with no upload or replacement key', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.wire.enqueue('/job/status', F.job()); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  assert.deepEqual(JSON.parse(f.wire.calls.at(-1).init.body), {version: F.JOB, source_ref: F.SOURCE, job_ref: F.JOBREF});
  assert.equal(f.owner.getState().filename, ''); assert.equal(f.owner.getState().job.confirmed_rows, 2);
  await f.owner.recoverJob(F.OTHER, F.SOURCE); await f.owner.recoverJob(F.JOBREF, F.OTHER);
  assert.equal(f.wire.calls.length, 3, 'An adopted source/job pair is indivisible');
});
test('I23 null prefix and nonproof diagnostics never become zero or complete', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  const value = F.job({phase: 'needs_reconciliation', uncertain: true, confirmed_rows: null, remaining_rows: null, confirmed_counts: null, disposition: null, cancel_requested: null});
  value.settled_diagnostic = {phase: 'completed', uncertain: false, error: null, snapshot_kind: 'settled_process_diagnostic', durable_proof: false};
  f.wire.enqueue('/job/status', value); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  assert.equal(f.owner.getState().job.confirmed_rows, null); assert.equal(f.owner.getState().phase, 'paused'); assert.doesNotMatch(f.owner.getState().notice, /All rows are confirmed/);
});
test('I24 completion needs coherent durable, certain, final server evidence', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  const complete = {phase: 'completed', disposition: 'completed', confirmed_rows: 4, remaining_rows: 0, confirmed_counts: [0, 3, 0, 1, 1, 0, 2]};
  f.wire.enqueue('/job/status', F.job({...complete, uncertain: true})); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  assert.notEqual(f.owner.getState().phase, 'completed'); assert.doesNotMatch(f.owner.getState().notice, /All rows are confirmed/);
  f.wire.enqueue('/job/status', F.job({...complete, snapshot_kind: 'last_confirmed', phase: 'applying'})); await f.owner.refreshStatus(); assert.notEqual(f.owner.getState().phase, 'completed');
  f.wire.enqueue('/job/status', F.job(complete)); await f.owner.refreshStatus(); assert.equal(f.owner.getState().phase, 'completed');
});
test('I25 cancellation preserves committed prefix and polls same job while stop is pending', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.wire.enqueue('/job/status', F.job()); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  f.wire.enqueue('/job/cancel', F.job({cancel_pending: true, cancel_requested: true}, 'cancel')); await f.owner.cancel();
  assert.equal(f.owner.getState().job.confirmed_rows, 2); assert.match(f.owner.getState().notice, /Already committed rows remain/);
  f.wire.enqueue('/job/status', F.job({phase: 'cancelled', disposition: 'cancelled', cancel_requested: true})); await f.time.tick();
  assert.deepEqual(JSON.parse(f.wire.calls.at(-1).init.body), {version: F.JOB, source_ref: F.SOURCE, job_ref: F.JOBREF}); assert.equal(f.owner.getState().job.confirmed_rows, 2);
});
test('I26 review cancellation is not an import cancellation or proof that a batch ran', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.owner.choose(F.file());
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')); await f.owner.preview();
  f.wire.enqueue('/review/cancel', F.review({phase: 'reviewing', review: null}, 'cancel')); await f.owner.cancel();
  f.wire.enqueue('/review/status', F.review({phase: 'cancelled_review', review: null})); await f.time.tick();
  assert.equal(f.owner.getState().job, null); assert.equal(f.owner.getState().review, null); assert.match(f.owner.getState().notice, /No import was applied/);
  assert.ok(f.wire.calls.every(call => !(call.route.startsWith('/job/') && call.route !== '/job/list')));
});
test('I27 close/dispose aborts in-flight request, clears File and rejects a late response', async t => {
  const f = await F.controller(t), late = F.deferred(); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.owner.choose(F.file());
  f.wire.enqueue('/review/start', () => late.promise); const pending = f.owner.preview(); f.owner.dispose(); const publications = f.publications.length;
  assert.equal(f.wire.calls.at(-1).init.signal.aborted, true); late.resolve(F.response(F.accepted(F.REVIEW, 'start'))); await pending;
  assert.equal(f.publications.length, publications); assert.equal(f.owner.getState().filename, ''); assert.equal(f.owner.getState().review, null); assert.equal(f.time.tasks.size, 0);
});
test('I28 mid-body source interruption can be explicitly re-read without sending a file early', async t => {
  const f = await F.controller(t); let pulls = 0;
  f.wire.enqueue('/ui/source', () => Promise.resolve(new Response(new ReadableStream({pull(control) {if (pulls++ === 0) control.enqueue(new TextEncoder().encode('{"protocol":')); else control.error(new TypeError('interrupted'));}}), {headers: {'Content-Type': 'application/json'}})));
  await f.owner.initialize(); assert.equal(f.owner.getState().source, null); f.owner.choose(F.file()); await f.owner.preview(); assert.equal(f.wire.calls.length, 2);
  f.wire.enqueue('/ui/source', F.source()); await f.owner.selectSource(null); assert.equal(f.owner.getState().source.source_ref, F.SOURCE); assert.equal(f.wire.calls.length, 3);
});
test('I29 library-bound recovered job cannot silently retarget to the current library', async t => {
  const f = await F.controller(t, F.wire(), {library: '24'}); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.wire.enqueue('/job/status', F.job({command: F.command({original_matching_library_id: 23})})); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  assert.equal(f.owner.getState().phase, 'paused'); assert.match(f.owner.getState().error, /original library scope/);
  f.owner.setMatching(false); assert.equal(f.owner.getState().job.command.original_matching_library_id, 23);
});
test('I30 shared CSRF fetch owner adds its header exactly once and never retries uncertain import submit', async t => {
  const f = await F.controller(t), calls = [], window = {location: new URL('https://albumhaven.test/account/integrations/foobar'), fetch: (...args) => {calls.push(args); return f.wire.fetch(...args);}};
  const context = F.vm.createContext({window, document: {cookie: '__Host-album_haven_csrf=synthetic-csrf'}, URL, Headers});
  F.vm.runInContext(F.read('music_app/static/js/runtime/session-csrf-fetch.js'), context, {filename: 'session-csrf-fetch.js'});
  const {createImportController} = await F.load('controller.mjs');
  const owner = createImportController({fetch: (...args) => window.fetch(...args), contextRoot: f.root, allows: () => true, isCurrent: () => true, onChange() {}});
  t.after(() => owner.dispose()); f.wire.enqueue('/ui/source', F.source()); await owner.initialize(); owner.choose(F.file());
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review()); await owner.preview(); await f.time.tick();
  f.wire.enqueue('/job/start', () => Promise.reject(new TypeError('uncertain'))); await owner.confirm();
  const submits = calls.filter(([url]) => url.endsWith('/job/start')); assert.equal(submits.length, 1);
  assert.equal(submits[0][1].headers.get('X-Album-Haven-CSRF'), 'synthetic-csrf'); assert.equal(submits[0][1].headers.get('X-AlbumHaven-Foobar-Context'), F.STAMP);
  assert.equal(submits[0][1].headers.get('X-AlbumHaven-Context'), null);
  const lists = calls.filter(([url]) => url.endsWith('/job/list')); assert.equal(lists.length, 1);
  assert.equal(lists[0][1].headers.get('X-Album-Haven-CSRF'), 'synthetic-csrf'); assert.equal(lists[0][1].headers.get('X-AlbumHaven-Foobar-Context'), F.STAMP);
});

test('I51 repeated source selection while initial read is pending cannot replace or duplicate request', async t => {
  const f = await F.controller(t), late = F.deferred(); f.wire.enqueue('/ui/source', () => late.promise);
  const initial = f.owner.initialize(); await F.settle(); await f.owner.initialize(); await f.owner.selectSource(null); await f.owner.selectSource(F.OTHER);
  assert.equal(f.wire.calls.length, 2); late.resolve(F.response(F.source())); await initial; assert.equal(f.owner.getState().source.source_ref, F.SOURCE);
});
test('I52 lost start before metadata permits only same-command re-review with same source/job identity', async t => {
  const f = await F.controller(t); const selected = await F.ready(f);
  f.wire.enqueue('/job/start', () => Promise.reject(new TypeError('lost'))); await f.owner.confirm();
  f.wire.enqueue('/job/status', () => Promise.resolve(F.response({protocol: F.JOB, error: 'unavailable'}, 503))); await f.owner.refreshStatus();
  assert.equal(f.owner.getState().job, null); f.owner.choose(selected);
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review()); await f.owner.resume();
  const header = JSON.parse(f.wire.calls.at(-1).init.headers['X-AlbumHaven-Foobar-Command']);
  assert.deepEqual(header, {version: F.REVIEW, source_ref: F.SOURCE, job_ref: F.JOBREF, mapping_name: F.MAPPING, matching_library_id: null, resume: false, conflict_after: 0, problem_after: 0, previous_review_sha256: null});
  await f.time.tick(); assert.equal(f.owner.getState().phase, 'review_ready');
  assert.equal(f.wire.calls.filter(call => call.route === '/job/start').length, 1, '503 was not permission to resubmit automatically');
  f.wire.enqueue('/job/start', F.accepted(F.JOB, 'start')); await f.owner.confirm();
  assert.equal(JSON.parse(f.wire.calls.at(-1).init.headers['X-AlbumHaven-Foobar-Command']).job_ref, F.JOBREF);
});
for (const change of [{upload_sha256: 'e'.repeat(64)}, {original_generation: 2}, {mapping_name: 'custom'}]) test(`I53 premetadata retry rejects changed immutable command ${Object.keys(change)[0]}`, async t => {
  const f = await F.controller(t); await F.ready(f); f.wire.enqueue('/job/start', () => Promise.reject(new TypeError('lost'))); await f.owner.confirm(); f.owner.choose(F.file('edited.tsv'));
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: F.proposal({command: F.command(change)})}));
  await f.owner.resume(); await f.time.tick(); assert.equal(f.owner.getState().review, null); assert.equal(f.owner.getState().jobRef, F.JOBREF);
  await f.owner.confirm(); assert.equal(f.wire.calls.filter(call => call.route === '/job/start').length, 1);
});
test('I54 restored identity without metadata or retained command stays status-only', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.wire.enqueue('/job/status', () => Promise.resolve(F.response({protocol: F.JOB, error: 'unavailable'}, 503))); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  f.owner.choose(F.file()); await f.owner.resume(); await f.owner.preview(); await f.owner.confirm(); assert.equal(f.wire.calls.length, 3); assert.equal(f.owner.getState().jobRef, F.JOBREF);
});
test('I55 cancelling a review that settles ready cannot re-enable confirmation', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.owner.choose(F.file());
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')); await f.owner.preview();
  f.wire.enqueue('/review/cancel', F.review({phase: 'reviewing', review: null}, 'cancel')); await f.owner.cancel();
  f.wire.enqueue('/review/status', F.review()); await f.time.tick(); assert.equal(f.owner.getState().review, null); assert.match(f.owner.getState().notice, /cancelled/);
  await f.owner.confirm(); assert.equal(f.wire.calls.filter(call => (call.route.startsWith('/job/') && call.route !== '/job/list')).length, 0);
});

test('I56 status and cancellation cannot alter retained immutable command under the same identity', async t => {
  const f = await F.controller(t); await F.ready(f); f.wire.enqueue('/job/start', () => Promise.reject(new TypeError('lost'))); await f.owner.confirm();
  f.wire.enqueue('/job/status', F.job({command: F.command({upload_sha256: 'e'.repeat(64)})})); await f.owner.refreshStatus();
  assert.equal(f.owner.getState().job, null); assert.equal(f.owner.getState().jobRef, F.JOBREF); assert.match(f.owner.getState().error, /changed/);
  f.wire.enqueue('/job/cancel', F.job({command: F.command({original_generation: 2})}, 'cancel')); await f.owner.cancel();
  assert.equal(f.owner.getState().job, null); assert.equal(f.owner.getState().jobRef, F.JOBREF);
});
test('I57 first recovered durable command anchors subsequent status and review command equality', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.wire.enqueue('/job/status', F.job()); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  f.wire.enqueue('/job/status', F.job({command: F.command({original_generation: 2})})); await f.owner.refreshStatus();
  assert.equal(f.owner.getState().job.command.original_generation, 1);
  f.owner.choose(F.file()); f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: F.proposal({command: F.command({upload_sha256: 'e'.repeat(64)}), resume: true})}));
  await f.owner.resume(); await f.time.tick(); assert.equal(f.owner.getState().review, null); await f.owner.confirm();
  assert.equal(f.wire.calls.filter(call => call.route === '/job/resume').length, 0);
});
for (const currentLibrary of ['', '24']) test(`I58 durable completed library-scoped recovery remains clearable with current library ${currentLibrary || 'none'}`, async t => {
  const f = await F.controller(t, F.wire(), {library: currentLibrary}); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.wire.enqueue('/job/status', F.job({command: F.command({original_matching_library_id: 23}), phase: 'completed', disposition: 'completed', confirmed_rows: 4, remaining_rows: 0, confirmed_counts: [0, 3, 0, 1, 1, 0, 2]}));
  await f.owner.recoverJob(F.JOBREF, F.SOURCE); assert.equal(f.owner.getState().phase, 'completed'); assert.equal(f.owner.getState().error, '');
  f.owner.clear(); assert.equal(f.owner.getState().jobRef, null); assert.equal(f.owner.getState().submitted, false);
});
test('I59 cancellation racing durable completion settles as complete without trapping recovery controls', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.wire.enqueue('/job/status', F.job()); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  f.wire.enqueue('/job/cancel', F.job({phase: 'completed', disposition: 'completed', confirmed_rows: 4, remaining_rows: 0, confirmed_counts: [0, 3, 0, 1, 1, 0, 2]}, 'cancel'));
  await f.owner.cancel(); assert.equal(f.owner.getState().phase, 'completed'); f.owner.clear(); assert.equal(f.owner.getState().jobRef, null);
});
test('I60 settled nonpending cancellation still refreshes server status rather than leaving an inert snapshot', async t => {
  const f = await F.controller(t); f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize(); f.wire.enqueue('/job/status', F.job()); await f.owner.recoverJob(F.JOBREF, F.SOURCE);
  f.wire.enqueue('/job/cancel', F.job({phase: 'cancelled', disposition: 'cancelled', cancel_requested: true}, 'cancel')); await f.owner.cancel();
  f.wire.enqueue('/job/status', F.job({phase: 'cancelled', disposition: 'cancelled', cancel_requested: true})); await f.time.tick();
  assert.equal(f.wire.calls.at(-1).route, '/job/status'); assert.equal(f.owner.getState().job.confirmed_rows, 2);
});
