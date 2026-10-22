'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./album-tops-source-import-task-fixtures/tasks.cjs');
const {F, JOB, REQUEST, SAVED_TOP, summary, job, ready, drain} = H;
test.before(H.load);
async function fixture(t, feed = [summary()]) {
  let h; const opens = [];
  h = await ready(t, {feed, open: async (value, isCurrent) => {
    const record = {value, isCurrent, atStart: isCurrent(), finish: F.deferred(), controller: undefined}; opens.push(record);
    record.controller = value.controller || await h.tasks.resume(value.job_ref);
    record.afterResume = isCurrent(); return record.finish.promise;
  }});
  return {...h, opens};
}
function unread(h, ref = JOB) {const row = h.rows().find(row => row.id === ref); assert.ok(row); assert.equal(row.read, false);}
function noWrites(h) {
  for (const kind of ['submit', 'process', 'cancel', 'finalize']) assert.equal(h.calls(kind).length, 0);
  assert.equal(h.keyCalls(), 0);
}
async function acknowledge(h, wire = job()) {const request = h.last('read'); request.resolve(wire); await drain(); return request;}

for (const top_ref of [null, SAVED_TOP]) test(`server-only ${top_ref ? 'saved' : 'review'} Open binds exactly once to its actual resumed controller and marks read only after current success`, async t => {
  const state = {top_ref, phase: top_ref ? 'top_created' : 'review_evidence'}, h = await fixture(t, [summary(state)]);
  assert.equal(h.opens.length, 0); unread(h); assert.equal(h.activate(JOB), true); await drain();
  const open = h.opens[0]; assert.deepEqual(open.value, {job_ref: JOB, top_ref, controller: null}); assert.equal(open.atStart, true);
  assert.equal(h.calls('read').length, 1); assert.equal(h.tasks.getSnapshot().retainedCount, 1);
  assert.equal(h.activate(JOB), false, 'a rejected duplicate cannot retire its pending owner');
  assert.equal(open.isCurrent(), true); unread(h);
  await acknowledge(h, job(state)); assert.ok(open.controller); assert.equal(open.afterResume, true);
  assert.equal(open.controller.getSnapshot().job.request_key, REQUEST); assert.equal(open.isCurrent(), true);
  assert.equal(await h.tasks.resume(JOB), open.controller); assert.equal(h.calls('read').length, 1);
  unread(h); open.finish.resolve(true); await drain(); assert.equal(h.rows().find(row => row.id === JOB).read, true);
  await h.tasks.refresh(); await drain(); assert.equal(h.rows().find(row => row.id === JOB).read, true);
  assert.equal(h.opens.length, 1); noWrites(h);
});

for (const outcome of ['false', 'rejected']) test(`bound Open ${outcome} leaves the real registry unread and a later explicit Open reuses its exact controller`, async t => {
  const h = await fixture(t); assert.equal(h.activate(JOB), true); await drain(); await acknowledge(h);
  const first = h.opens[0]; assert.equal(first.afterResume, true);
  if (outcome === 'false') first.finish.resolve(false); else first.finish.reject(new Error('PRIVATE_OPEN_FAILURE'));
  await drain(); unread(h); assert.equal(h.activate(JOB), true); await drain(); const second = h.opens[1];
  assert.equal(second.controller, first.controller); assert.equal(second.value.controller, first.controller);
  assert.equal(second.afterResume, true); assert.equal(h.calls('read').length, 1);
  second.finish.resolve(true); await drain(); assert.equal(h.rows().find(row => row.id === JOB).read, true); noWrites(h);
});

for (const failure of ['rejected read', 'wrong job response']) test(`a ${failure} remains a current retryable owner but is not falsely acknowledged or marked read`, async t => {
  const h = await fixture(t); h.activate(JOB); await drain();
  if (failure === 'rejected read') h.last('read').reject(Object.assign(new Error('PRIVATE_READ_FAILURE'), {status: 409, responseRejected: true}));
  else h.last('read').resolve(job({job_ref: H.OTHER_JOB}));
  await drain();
  const first = h.opens[0]; assert.ok(first.controller); assert.equal(first.controller.getSnapshot().status, 'error');
  assert.equal(first.controller.getSnapshot().job, null); assert.equal(first.afterResume, true);
  first.finish.resolve(false); await drain(); unread(h);
  const retry = first.controller.retry(); await drain(); await acknowledge(h); assert.equal(await retry, true);
  unread(h); assert.equal(h.opens.length, 1, 'read recovery alone never reopens or marks the notification');
  h.activate(JOB); await drain(); const next = h.opens[1]; assert.equal(next.controller, first.controller); assert.equal(next.afterResume, true);
  next.finish.resolve(true); await drain(); assert.equal(h.rows().find(row => row.id === JOB).read, true); noWrites(h);
});

for (const retirement of ['scope', 'logout', 'private scope', 'configure', 'dispose', 'denial']) {
  test(`server-only binding cannot outlive ${retirement} during its actual resume read`, async t => {
    const h = await fixture(t); h.activate(JOB); await drain(); const open = h.opens[0], request = h.last('read');
    assert.equal(open.isCurrent(), true);
    if (retirement === 'scope') h.change({scopeKey: `${F.SCOPE}:next`});
    else if (retirement === 'logout') h.change({authenticated: false});
    else if (retirement === 'private scope') h.rejectScope();
    else if (retirement === 'configure') h.tasks.configure(h.makeProviders());
    else if (retirement === 'dispose') h.tasks.dispose();
    else {h.queue('list', () => {throw Object.assign(new Error('Denied'), {status: 403, responseRejected: true});}); await h.tasks.refresh();}
    await drain(); assert.equal(request.options.signal.aborted, true); assert.equal(open.isCurrent(), false);
    request.resolve(job()); await drain(); assert.equal(open.controller, null); assert.equal(open.afterResume, false);
    open.finish.resolve(true); await drain(); assert.ok(h.rows().every(row => row.read === false));
    assert.equal(h.tasks.getSnapshot().retainedCount, 0); assert.equal(h.opens.length, 1); noWrites(h);
  });
}

test('an acknowledged mismatched request identity cannot inherit the captured server-only Open', async t => {
  const h = await fixture(t); h.activate(JOB); await drain(); await acknowledge(h, job({request_key: F.id(999)}));
  const open = h.opens[0]; assert.equal(open.isCurrent(), false); assert.equal(open.afterResume, false);
  if (open.controller) assert.equal(open.controller.getSnapshot().job.request_key, F.id(999));
  open.finish.resolve(true); await drain(); assert.ok(h.rows().every(row => row.read === false)); assert.equal(h.opens.length, 1); noWrites(h);
});

test('saved receipt advancement during resume cannot reuse an unsaved captured Open even for the same job/request', async t => {
  const h = await fixture(t); h.activate(JOB); await drain(); await acknowledge(h, job({top_ref: SAVED_TOP, phase: 'top_created'}));
  const old = h.opens[0]; assert.equal(old.isCurrent(), false); old.finish.resolve(true); await drain(); unread(h);
  assert.equal(h.activate(JOB), true); await drain(); const next = h.opens[1];
  assert.equal(next.value.top_ref, SAVED_TOP); assert.equal(next.controller, old.controller); assert.equal(next.afterResume, true);
  next.finish.resolve(true); await drain(); assert.equal(h.rows().find(row => row.id === JOB).read, true); noWrites(h);
});

test('direct disposal of an already bound controller makes its pending Open inert', async t => {
  const h = await fixture(t); h.activate(JOB); await drain(); await acknowledge(h); const old = h.opens[0], controller = old.controller;
  assert.equal(old.isCurrent(), true); controller.dispose(); assert.equal(old.isCurrent(), false);
  old.finish.resolve(true); await drain(); assert.ok(h.rows().every(row => row.read === false)); noWrites(h);
});

test('a released bound controller cannot be rebound to a same-identity replacement by the original Open', async t => {
  const h = await fixture(t); h.activate(JOB); await drain(); await acknowledge(h); const old = h.opens[0], controller = old.controller;
  assert.equal(old.isCurrent(), true);
  h.tasks.release(controller); await h.tasks.refresh(); await drain();
  assert.equal(controller.getSnapshot().status, 'retired');
  const replacement = h.tasks.resume(JOB); await drain(); await acknowledge(h); const next = await replacement;
  assert.ok(next); assert.notEqual(next, controller); assert.equal(next.getSnapshot().job.request_key, REQUEST);
  assert.equal(old.isCurrent(), false); old.finish.resolve(true); await drain(); unread(h); noWrites(h);
});

test('a non-null captured controller never gains generic replacement tolerance from the server-only binding exception', async t => {
  const h = await fixture(t), controller = await H.resume(h); h.activate(JOB); await drain(); const old = h.opens[0];
  assert.equal(old.value.controller, controller); assert.equal(old.controller, controller); assert.equal(old.isCurrent(), true);
  h.tasks.release(controller); await h.tasks.refresh(); await drain(); assert.equal(controller.getSnapshot().status, 'retired');
  const replacement = h.tasks.resume(JOB); await drain(); await acknowledge(h); const next = await replacement;
  assert.ok(next); assert.notEqual(next, controller); assert.equal(old.isCurrent(), false);
  old.finish.resolve(true); await drain(); unread(h); noWrites(h);
});

test('an accepted newer card Open globally retires the older navigation callback without discarding its still-owned read', async t => {
  const otherRequest = F.id(997), h = await fixture(t, [summary(), summary({job_ref: H.OTHER_JOB, request_key: otherRequest})]);
  h.activate(JOB); await drain(); const first = h.opens[0], firstRead = h.last('read'); assert.equal(first.isCurrent(), true);
  assert.equal(h.activate(H.OTHER_JOB), true); await drain(); const second = h.opens[1], secondRead = h.last('read');
  assert.equal(first.isCurrent(), false); assert.equal(second.isCurrent(), true); assert.equal(firstRead.options.signal.aborted, false);
  firstRead.resolve(job()); await drain(); assert.equal(first.afterResume, false); first.finish.resolve(true); await drain(); unread(h, JOB);
  assert.equal(second.isCurrent(), true); assert.equal(h.activate(H.OTHER_JOB), false);
  assert.equal(h.opens.length, 2, 'old completion cannot clear the newer activation lock');
  secondRead.resolve(job({job_ref: H.OTHER_JOB, request_key: otherRequest})); await drain(); assert.equal(second.afterResume, true);
  second.finish.resolve(true); await drain(); assert.equal(h.rows().find(row => row.id === H.OTHER_JOB).read, true);
  unread(h, JOB); assert.equal(h.tasks.getSnapshot().retainedCount, 2); assert.equal(h.calls('read').length, 2); noWrites(h);
});
