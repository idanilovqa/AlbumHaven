'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./foobar-account-import-fixture.cjs');
const N = require('./foobar-account-import-native-fixture.cjs');
const COMPLETE = {phase: 'completed', disposition: 'completed', confirmed_rows: 4,
  remaining_rows: 0, confirmed_counts: [0, 3, 0, 1, 1, 0, 2]};

function noRetainedTransport(f) {
  assert.equal(f.wire.calls.some(call => call.route === '/temporary-source/status'), false);
  for (const {init} of f.wire.calls) {
    assert.equal(init.headers['X-AlbumHaven-Retain-Source'], undefined);
    assert.equal(init.headers['X-AlbumHaven-Retained-Source'], undefined);
  }
}

async function submitted(f) {
  const selected = await F.ready(f);
  f.wire.enqueue('/job/start', () => Promise.resolve(F.response(F.accepted(F.JOB, 'start'), 202)));
  await f.owner.confirm();
  return selected;
}

test('R01 no controller opt-in or retained-copy reuse capability remains', async t => {
  const f = await F.controller(t);
  assert.equal(f.owner.setRetainSource, undefined);
  assert.equal(f.owner.useTemporarySource, undefined);
  assert.equal(Object.hasOwn(f.owner.getState(), 'retainSource'), false);
  assert.equal(Object.hasOwn(f.owner.getState(), 'usingTemporarySource'), false);
});

test('R02 ordinary real File review and confirmation preserve bytes without retention headers or lookup', async t => {
  const f = await F.controller(t), selected = await F.ready(f);
  const original = await selected.text();
  f.wire.enqueue('/job/start', F.accepted(F.JOB, 'start')); await f.owner.confirm();
  assert.equal(f.wire.calls.find(call => call.route === '/review/start').init.body, selected);
  assert.equal(f.wire.calls.find(call => call.route === '/job/start').init.body, selected);
  assert.equal(await selected.text(), original);
  noRetainedTransport(f);
});

test('R03 stale retained metadata cannot become an input or automatically submit an import', async t => {
  const f = await F.controller(t);
  f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  const selected = F.file(); f.owner.choose(selected);
  f.wire.enqueue('/review/start', {protocol: 'foobar_temporary_source_v1', context_ref: F.STAMP,
    context_scope: F.SCOPE, source: {source_ref: F.SOURCE, job_ref: F.JOBREF, mapping_name: F.MAPPING,
      upload_sha256: 'b'.repeat(64), byte_length: 32, expires_at: '2026-10-25T17:00:00+00:00'}});
  await f.owner.preview(); await f.owner.confirm();
  assert.equal(f.owner.getState().review, null);
  assert.equal(f.owner.getState().filename, selected.name);
  assert.equal(f.wire.calls.find(call => call.route === '/review/start').init.body, selected);
  assert.equal(f.wire.calls.some(call => /^\/job\/(start|resume)$/.test(call.route)), false);
  noRetainedTransport(f);
});

for (const operation of ['status', 'cancel']) test(`R04 durable ${operation} completion retires selected File use but preserves durable identity and counts`, async t => {
  const f = await F.controller(t), selected = await submitted(f), original = await selected.text();
  f.wire.enqueue('/job/' + operation, F.job(COMPLETE, operation));
  await (operation === 'status' ? f.owner.refreshStatus() : f.owner.cancel());
  const state = f.owner.getState();
  assert.equal(state.phase, 'completed'); assert.equal(state.filename, ''); assert.equal(state.review, null);
  assert.equal(state.jobRef, F.JOBREF); assert.equal(state.source.source_ref, F.SOURCE);
  assert.equal(state.submitted, true); assert.equal(state.job.confirmed_rows, 4);
  assert.deepEqual(state.job.confirmed_counts, COMPLETE.confirmed_counts);
  const before = f.wire.calls.length;
  await f.owner.preview(); await f.owner.resume(); await f.owner.confirm();
  assert.equal(f.wire.calls.length, before, 'Completed upload cannot be re-sent without another File selection');
  assert.equal(await selected.text(), original, 'Retirement does not mutate the original File');
  noRetainedTransport(f);
});

test('R05 HTTP 202 acceptance retains the original File for same-command uncertain reconciliation', async t => {
  const f = await F.controller(t), selected = await submitted(f);
  assert.equal(f.owner.getState().filename, selected.name);
  assert.notEqual(f.owner.getState().phase, 'completed');
  f.wire.enqueue('/job/status', F.job({uncertain: true, error: 'commit_uncertain'}));
  await f.owner.refreshStatus();
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')); await f.owner.resume();
  const call = f.wire.calls.at(-1);
  assert.equal(call.route, '/review/start'); assert.equal(call.init.body, selected);
  const command = JSON.parse(call.init.headers['X-AlbumHaven-Foobar-Command']);
  assert.equal(command.source_ref, F.SOURCE); assert.equal(command.job_ref, F.JOBREF);
  assert.equal(command.resume, true); noRetainedTransport(f);
});

for (const [name, patch] of [
  ['last-confirmed completion', {...COMPLETE, snapshot_kind: 'last_confirmed'}],
  ['uncertain completion', {...COMPLETE, uncertain: true}],
  ['pending cancellation', {cancel_pending: true, cancel_requested: true}],
]) test(`R06 ${name} does not release the selected File or invent durable completion`, async t => {
  const f = await F.controller(t), selected = await submitted(f);
  f.wire.enqueue('/job/status', F.job(patch)); await f.owner.refreshStatus();
  const state = f.owner.getState();
  assert.notEqual(state.phase, 'completed'); assert.equal(state.filename, selected.name);
  assert.equal(state.jobRef, F.JOBREF); assert.equal(state.submitted, true);
  f.wire.enqueue('/job/status', F.job()); await f.owner.refreshStatus();
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')); await f.owner.resume();
  assert.equal(f.wire.calls.at(-1).route, '/review/start');
  assert.equal(f.wire.calls.at(-1).init.body, selected, 'Retained original remains usable after nonterminal status settles');
  noRetainedTransport(f);
});

test('R07 cancellation request and pending response retain the original File until genuine completion', async t => {
  const f = await F.controller(t), selected = await submitted(f), late = F.deferred();
  f.wire.enqueue('/job/cancel', () => late.promise); const pending = f.owner.cancel();
  assert.equal(f.owner.getState().filename, selected.name);
  late.resolve(F.response(F.job({cancel_pending: true, cancel_requested: true}, 'cancel'), 202));
  await pending;
  assert.equal(f.owner.getState().filename, selected.name);
  assert.notEqual(f.owner.getState().phase, 'completed');
  assert.equal(f.owner.getState().job.confirmed_rows, 2);
});

for (const operation of ['status', 'cancel']) test(`R08 delayed ${operation} completion cannot clear a newer File selection`, async t => {
  const f = await F.controller(t); await submitted(f);
  f.wire.enqueue('/job/status', F.job()); await f.owner.refreshStatus();
  const late = F.deferred(); f.wire.enqueue('/job/' + operation, () => late.promise);
  const pending = operation === 'status' ? f.owner.refreshStatus() : f.owner.cancel();
  const successor = F.file('reselected-original.tsv'); f.owner.choose(successor);
  assert.equal(f.owner.getState().filename, successor.name);
  late.resolve(F.response(F.job(COMPLETE, operation))); await pending;
  assert.equal(f.owner.getState().filename, successor.name, 'Earlier status cannot retire a successor selection');
});

test('R09 late completion is rejected after account context replacement', async t => {
  const f = await F.controller(t); await submitted(f);
  const late = F.deferred(); f.wire.enqueue('/job/status', () => late.promise);
  const pending = f.owner.refreshStatus();
  f.root.dataset.accountFoobarContext = 'e'.repeat(64);
  late.resolve(F.response(F.job(COMPLETE))); await pending;
  assert.equal(f.owner.getState().phase, 'retired'); assert.equal(f.owner.getState().filename, '');
  assert.notEqual(f.owner.getState().job?.confirmed_rows, 4);
});

test('R10 mounted import flow offers no private-copy control and still uses original-file input', async t => {
  const f = await N.native(t);
  assert.equal(f.host.querySelector('[data-foobar-import-action="temporarySource"]'), null);
  assert.equal(f.host.querySelectorAll('input').some(node => node.id.endsWith('-retain-source')), false);
  assert.doesNotMatch(f.host.textContent, /Keep a private temporary source copy|Use temporary copy/);
  assert.match(f.host.textContent, /original file/i);
  const selected = F.file(); f.choose(selected); await F.settle();
  assert.equal(f.field('file').value, '', 'Existing selection handler clears the input immediately');
  assert.equal(f.action('preview').disabled, false);
});

test('R11 mounted durable completion clears selection display while retaining saved import status', async t => {
  const f = await N.native(t); const selected = await N.reviewed(f);
  const check = f.field('confirmation'); check.checked = true; f.change(check);
  f.wire.enqueue('/job/start', F.accepted(F.JOB, 'start')); f.click(f.action('confirm')); await F.settle();
  assert.equal(f.field('file').value, '');
  f.wire.enqueue('/job/status', F.job(COMPLETE)); await f.time.tick();
  assert.equal(f.field('file').value, ''); assert.match(f.host.textContent, /No file selected/);
  assert.equal(f.host.textContent.includes('Selected file: ' + selected.name), false);
  assert.equal(f.field('source-reference').value, F.SOURCE); assert.equal(f.field('job-reference').value, F.JOBREF);
  assert.equal(f.action('clear').disabled, false); assert.equal(f.action('preview').disabled, true);
  assert.match(f.host.textContent, /server has confirmed the complete import/);
  noRetainedTransport(f);
});

for (const operation of ['status', 'cancel']) test(`R12 delayed ${operation} completion preserves explicit reselection of the same File object`, async t => {
  const f = await F.controller(t), selected = await submitted(f);
  assert.equal(f.wire.calls.find(call => call.route === '/job/start').init.body, selected);
  f.wire.enqueue('/job/status', F.job()); await f.owner.refreshStatus();
  const before = f.wire.calls.length, late = F.deferred();
  f.wire.enqueue('/job/' + operation, () => late.promise);
  const pending = operation === 'status' ? f.owner.refreshStatus() : f.owner.cancel();
  assert.equal(f.wire.calls.length, before + 1);
  const held = f.wire.calls.at(-1);
  assert.equal(held.route, '/job/' + operation);
  assert.deepEqual(JSON.parse(held.init.body), {version: F.JOB, source_ref: F.SOURCE, job_ref: F.JOBREF});
  // Explicit user action creates a new selection even when object identity is
  // unchanged. File equality alone cannot fence this delayed response.
  f.owner.choose(selected);
  const reselected = f.owner.getState();
  assert.equal(reselected.filename, selected.name); assert.equal(reselected.phase, 'selected');
  assert.equal(f.wire.calls.length, before + 1, 'Reselection itself sends no request');
  late.resolve(F.response(F.job(COMPLETE, operation))); await pending;
  const settled = f.owner.getState();
  assert.equal(settled.filename, selected.name); assert.equal(settled.review, null);
  assert.equal(settled.jobRef, F.JOBREF); assert.equal(settled.source.source_ref, F.SOURCE);
  assert.equal(f.wire.calls.length, before + 1, 'Late completion cannot auto-submit or re-review');
  // Observe actual controller use, not a retained test reference or a GC claim.
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')); await f.owner.preview();
  assert.equal(f.wire.calls.length, before + 2);
  const review = f.wire.calls.at(-1), command = JSON.parse(review.init.headers['X-AlbumHaven-Foobar-Command']);
  assert.equal(review.route, '/review/start'); assert.equal(review.init.body, selected);
  assert.equal(command.source_ref, F.SOURCE); assert.equal(command.job_ref, F.JOBREF);
  assert.equal(command.resume, true); assert.equal(f.owner.getState().filename, selected.name);
  assert.equal(f.wire.calls.filter(call => call.route === '/job/start').length, 1);
  assert.equal(f.wire.calls.filter(call => call.route === '/job/resume').length, 0);
  noRetainedTransport(f);
});

const E = require('./foobar-enhanced-v4-fixture.cjs');

for (const entry of ['recover', 'status', 'cancel']) test(`R13 stale cross-mapping ${entry} completion cannot erase or relabel a newer TSV selection`, async t => {
  const f = await F.controller(t);
  f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  const selected = F.file('explicit-original.tsv');
  if (entry !== 'recover') {
    // A saved identity with temporarily unavailable metadata is an existing
    // legitimate recovery state. No replacement command may be invented.
    f.wire.enqueue('/job/status', () => Promise.resolve(F.response({protocol: F.JOB,
      context_ref: F.STAMP, context_scope: F.SCOPE, error: 'unavailable'}, 503)));
    await f.owner.recoverJob(F.JOBREF, F.SOURCE);
    assert.equal(f.owner.getState().job, null); assert.equal(f.owner.getState().jobRef, F.JOBREF);
    f.owner.choose(selected);
  }
  const operation = entry === 'cancel' ? 'cancel' : 'status';
  const before = f.wire.calls.length, late = F.deferred();
  f.wire.enqueue('/job/' + operation, () => late.promise);
  const pending = entry === 'recover' ? f.owner.recoverJob(F.JOBREF, F.SOURCE)
    : entry === 'cancel' ? f.owner.cancel() : f.owner.refreshStatus();
  assert.equal(f.wire.calls.length, before + 1);
  const held = f.wire.calls.at(-1);
  assert.equal(held.route, '/job/' + operation);
  assert.deepEqual(JSON.parse(held.init.body), {version: F.JOB, source_ref: F.SOURCE, job_ref: F.JOBREF});
  // For status/cancel this explicitly reselects the SAME object held when the
  // request began. Generation, not just object equality, identifies the action.
  f.owner.choose(selected);
  assert.equal(f.owner.getState().filename, selected.name);
  assert.equal(f.owner.getState().mapping, F.MAPPING);
  late.resolve(F.response(F.job({...COMPLETE, command: E.command(),
    confirmed_counts: [0, 4, 0, 0, 0, 0, 0]}, operation)));
  await pending;
  const settled = f.owner.getState();
  assert.equal(settled.filename, selected.name); assert.equal(settled.mapping, F.MAPPING);
  assert.equal(settled.job, null); assert.equal(settled.review, null);
  assert.equal(settled.jobRef, F.JOBREF); assert.equal(settled.source.source_ref, F.SOURCE);
  assert.equal(settled.submitted, true);
  assert.equal(f.wire.calls.length, before + 1, 'Stale response cannot trigger another operation');
  await f.owner.preview(); await f.owner.resume(); await f.owner.confirm();
  assert.equal(f.wire.calls.length, before + 1, 'No command adoption means status-only recovery, never TSV under an Enhanced command');
  assert.equal(f.owner.getState().filename, selected.name); assert.equal(f.owner.getState().mapping, F.MAPPING);
  assert.equal(f.wire.calls.some(call => /^\/(review|job)\/(start|resume)$/.test(call.route)), false);
  noRetainedTransport(f);
});

test('R14 recovery without a successor selection adopts the genuine Enhanced mapping and accepts only that format', async t => {
  const f = await F.controller(t);
  f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.owner.choose(F.file('previous.tsv'));
  const before = f.wire.calls.length, late = F.deferred();
  f.wire.enqueue('/job/status', () => late.promise);
  const pending = f.owner.recoverJob(F.JOBREF, F.SOURCE);
  assert.equal(f.wire.calls.length, before + 1); assert.equal(f.wire.calls.at(-1).route, '/job/status');
  assert.deepEqual(JSON.parse(f.wire.calls.at(-1).init.body), {version: F.JOB, source_ref: F.SOURCE, job_ref: F.JOBREF});
  late.resolve(F.response(E.job())); await pending;
  const recovered = f.owner.getState();
  assert.equal(recovered.mapping, E.IMPORT_MAPPING); assert.equal(recovered.filename, '');
  assert.equal(recovered.job.command.mapping_name, E.IMPORT_MAPPING);
  assert.equal(recovered.jobRef, F.JOBREF); assert.equal(recovered.job.confirmed_rows, 2);
  f.owner.choose(F.file('wrong-format.tsv')); await f.owner.resume();
  assert.equal(f.owner.getState().filename, ''); assert.equal(f.wire.calls.length, before + 1);
  const correct = E.file('original.sqlite'); f.owner.choose(correct);
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')); await f.owner.resume();
  assert.equal(f.wire.calls.length, before + 2);
  const review = f.wire.calls.at(-1), command = JSON.parse(review.init.headers['X-AlbumHaven-Foobar-Command']);
  assert.equal(review.route, '/review/start'); assert.equal(review.init.body, correct);
  assert.equal(review.init.headers['Content-Type'], 'application/vnd.sqlite3');
  assert.equal(command.mapping_name, E.IMPORT_MAPPING); assert.equal(command.resume, true);
  assert.equal(command.source_ref, F.SOURCE); assert.equal(command.job_ref, F.JOBREF);
  assert.equal(f.wire.calls.some(call => /^\/job\/(start|resume)$/.test(call.route)), false);
  noRetainedTransport(f);
});
