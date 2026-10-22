'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const V = require('./album-tops-source-import-view-fixtures/view.cjs');
const {F, JOB, SAVED_TOP, fixture, job, button, click, settle} = V;
test.before(V.load);
async function save(h, {duplicate = false} = {}) {
  await V.localMatch(h, '3'); if (duplicate) await V.localMatch(h, '1');
  click(button(h.host, 'Save Album Top')); await settle(); return h.last('finalize');
}
async function saved(h) {const request = await save(h); request.resolve(V.receipt(request.body)); await settle(); return request;}

for (const [status, pattern] of [['queued', /wait|queued|process/i], ['running', /process/i],
  ['failed', /fail/i], ['canceled', /cancel/i]]) test(`${status} import status is visible without automatically dispatching process, finalization or navigation`, async t => {
  const h = await fixture(t, {opened: true, wire: job({status, phase: 'source_processing', review: null,
    error: status === 'failed' ? 'source_processing_failed' : null})});
  assert.match(h.host.textContent, pattern); assert.equal(button(h.host, 'Close').disabled, false);
  const process = button(h.host, 'Retry processing');
  if (status === 'failed') assert.ok(process && !process.disabled); else assert.ok(!process || process.disabled);
  const final = button(h.host, 'Save Album Top'); assert.ok(!final || final.disabled);
  if (status === 'canceled') {const cancel = button(h.host, 'Cancel import'); assert.ok(!cancel || cancel.disabled);}
  assert.equal(h.count('read'), 1); V.noSave(h);
});

test('Retry processing is one explicit action for a failed job and never follows submit automatically', async t => {
  const h = await fixture(t, {opened: true, wire: job({status: 'failed', phase: 'source_processing', review: null, error: 'source_processing_failed'})});
  const retry = button(h.host, 'Retry processing'); click(retry); await settle(); click(retry); await settle();
  assert.equal(h.count('process'), 1); assert.equal(h.last('process').path, `/album-tops/source-imports/${JOB}/process`);
  assert.equal(button(h.host, 'Close').disabled, false); assert.match(h.host.textContent, /process/i);
  h.last('process').resolve(job()); await settle(); assert.ok(h.host.querySelector('[aria-label="Source review"]'));
  assert.equal(h.count('process'), 1); assert.equal(h.count('submit'), 0); assert.equal(h.count('finalize'), 0); assert.equal(h.calls.open.length, 0);
});

test('failed processing action exposes explicit Retry through the real controller without leaking the thrown message', async t => {
  const h = await fixture(t, {opened: true, wire: job({status: 'failed', phase: 'source_processing', review: null, error: 'source_processing_failed'})});
  click(button(h.host, 'Retry processing')); await settle(); const request = h.last('process');
  request.reject(new Error('SECRET_PROCESS_IMPLEMENTATION')); await settle(); assert.equal(h.actual.getSnapshot().status, 'error');
  assert.ok(h.host.querySelector('[role="alert"]')); assert.doesNotMatch(h.host.textContent, /SECRET_PROCESS_IMPLEMENTATION/);
  click(button(h.host, 'Retry')); await settle(); assert.equal(h.count('process'), 2); assert.equal(h.last('process').path, request.path);
  h.last('process').resolve(job()); await settle(); assert.equal(h.actual.getSnapshot().status, 'ready');
  assert.equal(h.count('finalize'), 0); assert.equal(h.calls.open.length, 0);
});

test('Cancel import is distinct from Close and uncertain cancellation retries the exact original action', async t => {
  const h = await fixture(t, {opened: true}); click(button(h.host, 'Cancel import')); await settle(); const request = h.last('cancel');
  assert.equal(request.path, `/album-tops/source-imports/${JOB}/cancel`); assert.equal(h.calls.close, 0);
  assert.match(h.host.textContent, /cancel/i); assert.equal(button(h.host, 'Close').disabled, false);
  request.reject(new TypeError('SECRET_CANCEL_FAILURE')); await settle(); assert.equal(h.actual.getSnapshot().status, 'uncertain');
  assert.match(h.host.textContent, /unknown|uncertain/i); assert.doesNotMatch(h.host.textContent, /SECRET_CANCEL_FAILURE/);
  const cancel = button(h.host, 'Cancel import'); if (cancel) {assert.equal(cancel.disabled, true); click(cancel);}
  assert.equal(h.count('cancel'), 1); click(button(h.host, 'Retry')); await settle();
  assert.equal(h.count('cancel'), 2); assert.equal(h.last('cancel').path, request.path); assert.deepEqual(h.last('cancel').body, request.body);
  h.last('cancel').resolve(job({status: 'canceled', phase: 'source_processing'})); await settle(); assert.equal(h.actual.getSnapshot().job.status, 'canceled');
  assert.equal(h.calls.close, 0); V.noSave(h);
});

test('read loading stays visible and Close disposes only the surface while the retained task finishes', async t => {
  const h = await fixture(t, {opened: true}), gate = F.deferred(); h.queue('read', gate.promise);
  const pending = h.actual.open(JOB); await settle(); assert.match(h.host.textContent, /load/i);
  assert.equal(button(h.host, 'Close').disabled, false); click(button(h.host, 'Close')); assert.equal(h.calls.close, 1);
  const request = h.last('read'); h.view.dispose(); assert.equal(request.options.signal.aborted, false);
  gate.resolve(job({revision: '5'})); assert.equal(await pending, true); await settle();
  assert.equal(h.actual.getSnapshot().job.revision, '5'); assert.equal(h.host.children.length, 0); assert.equal(h.calls.importDispose, 0); V.noSave(h);
});

test('explicit Save Album Top sends all rows and preserves duplicate selections for the validated server report', async t => {
  const h = await fixture(t, {opened: true}); const request = await save(h, {duplicate: true});
  assert.equal(h.count('finalize'), 1); assert.deepEqual(request.body, {request_key: JOB, title: V.SOURCE.title,
    description: V.SOURCE.description, source_review: {job_ref: JOB, revision: '4', rows: [
      {row_ref: '3', selection: {kind: 'local_catalog', album_ref: F.C}}, {row_ref: '2', selection: null},
      {row_ref: '1', selection: {kind: 'local_catalog', album_ref: F.C}}]}});
  assert.match(h.host.textContent, /sav/i); assert.equal(button(h.host, 'Close').disabled, false);
  const again = button(h.host, 'Save Album Top'); if (again) {assert.equal(again.disabled, true); click(again);}
  assert.equal(h.count('finalize'), 1); assert.equal(h.calls.open.length, 0);
  const receipt = V.receipt(request.body); request.resolve(receipt); await settle();
  assert.deepEqual(h.actual.getSnapshot().result, receipt); assert.match(h.host.textContent, /created/i);
  for (const outcome of ['matched', 'duplicate', 'unresolved']) assert.match(h.host.textContent, new RegExp(outcome, 'i'));
  assert.equal(button(h.host, 'Open Album Top').disabled, false); assert.equal(h.calls.open.length, 0);
  assert.equal(h.api.count('execute'), 0); assert.equal(h.calls.topMutate.length, 0); assert.equal(h.count('process'), 0);
});

test('uncertain finalization retains all row choices and only explicit Retry resends the exact immutable command', async t => {
  const h = await fixture(t, {opened: true}), request = await save(h), before = h.actual.getSnapshot().rows;
  request.reject(new Error('PRIVATE_FINALIZATION_FAILURE')); await settle(); assert.equal(h.actual.getSnapshot().status, 'uncertain');
  assert.match(h.host.textContent, /unknown|uncertain/i); assert.doesNotMatch(h.host.textContent, /PRIVATE_FINALIZATION_FAILURE/);
  assert.equal(button(h.host, 'Close').disabled, false); assert.equal(h.actual.select('3', null), false);
  assert.deepEqual(h.actual.getSnapshot().rows, before); assert.equal(h.count('finalize'), 1);
  click(button(h.host, 'Retry')); await settle(); assert.equal(h.count('finalize'), 2); assert.deepEqual(h.last('finalize').body, request.body);
  h.last('finalize').resolve(V.receipt(request.body)); await settle(); assert.equal(h.actual.getSnapshot().result.top_ref, SAVED_TOP);
  assert.equal(h.calls.open.length, 0); assert.equal(h.count('submit'), 0);
});

test('an explicit Open delegates the exact saved Top and a live receipt-bound currentness callback without another save', async t => {
  const h = await fixture(t, {opened: true}); await saved(h); assert.equal(h.calls.open.length, 0);
  click(button(h.host, 'Open Album Top')); await settle(); assert.equal(h.calls.open.length, 1);
  assert.equal(h.calls.open[0].top, SAVED_TOP); assert.equal(h.calls.open[0].current(), true);
  assert.equal(h.count('finalize'), 1); assert.equal(h.api.count('execute'), 0); assert.equal(h.calls.topMutate.length, 0);
});

for (const failure of ['false', 'reject']) test(`Open ${failure} is a generic retryable navigation outcome and does not repeat finalization`, async t => {
  let attempts = 0; const h = await fixture(t, {opened: true, onOpenTop: () => ++attempts === 1
    ? failure === 'false' ? false : Promise.reject(new Error('SECRET_NAVIGATION_PATH')) : true});
  await saved(h); click(button(h.host, 'Open Album Top')); await settle();
  assert.ok(h.host.querySelector('[role="alert"]')); assert.doesNotMatch(h.host.textContent, /SECRET_NAVIGATION_PATH/);
  assert.equal(button(h.host, 'Open Album Top').disabled, false); assert.equal(h.count('finalize'), 1);
  click(button(h.host, 'Open Album Top')); await settle(); assert.equal(h.calls.open.length, 2); assert.equal(h.count('finalize'), 1);
  assert.ok(h.calls.open.every(value => value.top === SAVED_TOP));
});

test('a pending Open is single-flight and becomes inert when the surface is disposed', async t => {
  const gate = F.deferred(), h = await fixture(t, {opened: true, onOpenTop: () => gate.promise}); await saved(h);
  const open = button(h.host, 'Open Album Top'); click(open); await settle(); click(open); await settle();
  assert.equal(h.calls.open.length, 1); assert.equal(h.calls.open[0].current(), true);
  h.view.dispose(); assert.equal(h.calls.open[0].current(), false); gate.reject(new Error('LATE_PRIVATE_OPEN_ERROR')); await settle();
  click(open); assert.equal(h.calls.open.length, 1); assert.equal(h.host.children.length, 0); assert.equal(h.count('finalize'), 1);
});

for (const retirement of ['scope', 'new revision']) test(`pending Open currentness excludes ${retirement} even if the saved Top identity matches`, async t => {
  const gate = F.deferred(), h = await fixture(t, {opened: true, onOpenTop: () => gate.promise}); await saved(h);
  click(button(h.host, 'Open Album Top')); await settle(); const old = h.calls.open[0]; assert.equal(old.current(), true);
  if (retirement === 'scope') h.scope(); else {h.setWire(job({revision: '5', top_ref: SAVED_TOP, phase: 'top_created'})); await h.actual.open(JOB);}
  assert.equal(old.current(), false); gate.resolve(true); await settle(); assert.equal(h.count('finalize'), 1);
  if (retirement === 'scope') assert.equal(h.host.children.length, 0); else {
    assert.equal(button(h.host, 'Open Album Top').disabled, false); click(button(h.host, 'Open Album Top')); await settle();
    assert.equal(h.calls.open.length, 2); assert.equal(h.calls.open[1].current(), true);
  }
});

test('a saved resumed job exposes explicit Open without preparing another receipt or finalization', async t => {
  const h = await fixture(t, {opened: true, wire: job({top_ref: SAVED_TOP, phase: 'top_created'})});
  assert.match(h.host.textContent, /created/i); assert.equal(h.calls.open.length, 0); assert.equal(h.count('finalize'), 0);
  click(button(h.host, 'Open Album Top')); await settle(); assert.equal(h.calls.open.length, 1); assert.equal(h.calls.open[0].top, SAVED_TOP);
  assert.equal(h.calls.open[0].current(), true); assert.equal(h.count('finalize'), 0); assert.equal(h.count('process'), 0);
});

for (const state of ['loading', 'uncertain']) test(`closing ${state} finalization preserves the real task and cannot revive the disposed view`, async t => {
  const h = await fixture(t, {opened: true}), request = await save(h);
  if (state === 'uncertain') {request.reject(new Error('Uncertain finalization')); await settle();}
  assert.equal(h.actual.getSnapshot().status, state); assert.equal(button(h.host, 'Close').disabled, false);
  click(button(h.host, 'Close')); assert.equal(h.calls.close, 1); h.view.dispose();
  assert.equal(h.calls.importDispose, 0); assert.equal(h.actual.getSnapshot().status, state);
  let pending;
  if (state === 'loading') assert.equal(request.options.signal.aborted, false);
  else {pending = h.actual.retry(); await settle(); assert.deepEqual(h.last('finalize').body, request.body);}
  h.last('finalize').resolve(V.receipt(request.body)); if (pending) assert.equal(await pending, true); await settle();
  assert.equal(h.actual.getSnapshot().result.top_ref, SAVED_TOP); assert.equal(h.host.children.length, 0); assert.equal(h.calls.open.length, 0);
});

test('an invalid finalization receipt never exposes Open or client-deduplicates rows as if creation succeeded', async t => {
  const h = await fixture(t, {opened: true}), request = await save(h, {duplicate: true}), before = h.actual.getSnapshot().rows;
  const malformed = V.receipt(request.body); malformed.source_report[2].outcome = 'matched'; malformed.source_report[2].retained_row_ref = null;
  request.resolve(malformed); await settle(); assert.equal(h.actual.getSnapshot().status, 'uncertain');
  assert.equal(h.actual.getSnapshot().result, null); assert.deepEqual(h.actual.getSnapshot().rows, before);
  const open = button(h.host, 'Open Album Top'); assert.ok(!open || open.disabled); if (open) click(open);
  assert.equal(h.calls.open.length, 0); assert.equal(h.count('finalize'), 1); assert.match(h.host.textContent, /unknown|uncertain/i);
});
