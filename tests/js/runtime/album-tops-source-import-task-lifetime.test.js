'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./album-tops-source-import-task-fixtures/tasks.cjs');
const {F, JOB, INPUT, summary, job, receipt, ready, resume, drain} = H;
test.before(H.load);

async function pending(h, operation) {
  let controller, work;
  if (operation === 'submit') {controller = h.tasks.create(); work = controller.submit(INPUT);}
  else if (operation === 'read') {
    work = h.tasks.resume(JOB); await drain(); return {work, request: h.last('read'), controller: null};
  } else {
    controller = await resume(h);
    if (operation === 'finalize') assert.equal(controller.select('1', {kind: 'local_catalog', album_ref: F.A}), true);
    work = controller[operation]();
  }
  await drain(); return {controller, work, request: h.last(operation)};
}
function reply(request) {
  request.resolve(request.kind === 'finalize' ? receipt(request.body)
    : job({request_key: request.kind === 'submit' ? request.body.request_key : H.REQUEST,
      ...(request.kind === 'cancel' ? {status: 'canceled', phase: 'source_processing'} : {})}));
}

for (const operation of ['submit', 'read', 'process', 'cancel', 'finalize']) {
  for (const retirement of ['scope', 'configure', 'dispose']) {
    test(`${retirement} retires pending ${operation} before its late acknowledgment`, async t => {
      const h = await ready(t), active = await pending(h, operation), oldSource = h.currentRegistration();
      const oldKey = h.tasks.getSnapshot().scopeKey;
      if (retirement === 'scope') h.change({scopeKey: `${F.SCOPE}:successor`});
      else if (retirement === 'configure') h.tasks.configure(h.makeProviders());
      else h.tasks.dispose();
      assert.equal(active.request.options.signal.aborted, true); assert.equal(oldSource.disposed, true);
      if (active.controller) assert.equal(active.controller.getSnapshot().status, 'retired');
      assert.equal(h.tasks.getSnapshot().retainedCount, 0);
      reply(active.request); assert.equal(await active.work, operation === 'read' ? null : false); await drain();
      assert.equal(h.tasks.getSnapshot().retainedCount, 0); assert.equal(h.openings.length, 0);
      assert.equal(oldSource.options.isCurrent(), false);
      assert.equal(oldSource.options.onOpen(JOB), false);
      if (retirement === 'scope') assert.notEqual(h.tasks.getSnapshot().scopeKey, oldKey);
      if (retirement === 'configure') assert.equal(h.calls('list').at(-1).providerId, 1);
    });
  }
}

for (const operation of ['submit', 'cancel', 'finalize']) test(`dialog release preserves pending ${operation} and frees only matching settled durable evidence`, async t => {
  const h = await ready(t), {controller, request, work} = await pending(h, operation);
  h.tasks.release(controller);
  assert.equal(request.options.signal.aborted, false); assert.equal(controller.getSnapshot().status, 'loading');
  assert.equal(h.tasks.getSnapshot().retainedCount, 1);
  reply(request); await work; await drain();
  assert.equal(h.tasks.getSnapshot().retainedCount, 1); assert.notEqual(controller.getSnapshot().status, 'retired');
  const matching = summary({request_key: operation === 'submit' ? request.body.request_key : H.REQUEST,
    ...(operation === 'finalize' ? {top_ref: H.SAVED_TOP, phase: 'top_created'} : {}),
    ...(operation === 'cancel' ? {status: 'canceled', phase: 'source_processing'} : {})});
  h.setFeed([matching]); await h.tasks.refresh(); await drain();
  assert.equal(controller.getSnapshot().status, 'retired'); assert.equal(h.tasks.getSnapshot().retainedCount, 0);
  assert.equal(h.cards().length, 1); assert.equal(h.openings.length, 0);
  assert.equal(h.calls('process').length, 0);
});

for (const operation of ['cancel', 'finalize']) test(`detached uncertain ${operation} retains exact retry and truthful registry state`, async t => {
  const h = await ready(t), {controller, request, work} = await pending(h, operation);
  const loading = operation === 'cancel' ? 'Canceling import' : 'Saving Album Top';
  assert.equal(h.rows().find(row => row.id === JOB).byline, loading);
  h.tasks.release(controller); request.reject(new TypeError('Lost acknowledgment')); assert.equal(await work, false); await drain();
  assert.equal(controller.getSnapshot().status, 'uncertain');
  assert.equal(h.rows().find(row => row.id === JOB).byline, operation === 'cancel' ? 'Cancellation result unknown' : 'Save result unknown');
  h.setFeed([summary()]); await h.tasks.refresh(); await drain();
  assert.equal(h.tasks.getSnapshot().retainedCount, 1); assert.equal(await h.tasks.resume(JOB), controller);
  const retry = controller.retry(); await drain(); const next = h.last(operation);
  assert.deepEqual(next.body, request.body); assert.equal(next.path, request.path);
  assert.notEqual(next.options.signal, request.options.signal); reply(next); assert.equal(await retry, true);
  assert.equal(h.calls(operation).length, 2); assert.equal(h.openings.length, 0);
});

test('view and dialog visibility changes do not retire index-scoped jobs', async t => {
  const h = await ready(t), {controller, request, work} = await pending(h, 'submit');
  h.change({visible: false, active: false, viewVersion: 2}); h.tasks.release(controller);
  assert.equal(request.options.signal.aborted, false); assert.equal(h.tasks.getSnapshot().retainedCount, 1);
  reply(request); await work; await drain();
  assert.equal(controller.getSnapshot().job.job_ref, JOB); assert.equal(h.openings.length, 0);
});

for (const change of ['logout', 'private-scope-rejection']) test(`${change} immediately retires all retained controllers`, async t => {
  const h = await ready(t), first = h.tasks.create(), second = h.tasks.create(), work = second.submit(INPUT); await drain();
  const request = h.last('submit');
  if (change === 'logout') h.change({authenticated: false}); else h.rejectScope();
  assert.equal(first.getSnapshot().status, 'retired'); assert.equal(second.getSnapshot().status, 'retired');
  assert.equal(request.options.signal.aborted, true); assert.equal(h.tasks.create(), null);
  assert.deepEqual(h.tasks.getSnapshot(), {scopeKey: null, retainedCount: 0, capacity: 32, canCreate: false});
  reply(request); assert.equal(await work, false); await drain(); assert.equal(h.cards().length, 0);
});

test('independent attached and detached jobs cannot cancel or consume each other', async t => {
  const h = await ready(t), a = h.tasks.create(), b = h.tasks.create();
  const aw = a.submit(INPUT), bw = b.submit({...INPUT, title: 'Another source'}); await drain();
  const [ar, br] = h.calls('submit'); h.tasks.release(a);
  ar.resolve(job({request_key: ar.body.request_key})); await aw;
  br.resolve(job({job_ref: H.OTHER_JOB, request_key: br.body.request_key, title: 'Another source'})); await bw; await drain();
  h.setFeed([summary({request_key: ar.body.request_key})]); await h.tasks.refresh(); await drain();
  assert.equal(a.getSnapshot().status, 'retired'); assert.equal(b.getSnapshot().status, 'ready');
  assert.equal(b.getSnapshot().job.job_ref, H.OTHER_JOB); assert.equal(h.tasks.getSnapshot().retainedCount, 1);
  assert.equal(br.options.signal.aborted, false); assert.equal(await h.tasks.resume(H.OTHER_JOB), b);
  assert.equal(h.calls('read').length, 0); assert.equal(h.openings.length, 0);
});

test('denial callback may synchronously retire the runtime without reviving stale source or controllers', async t => {
  let h;
  h = await ready(t, {denied() {h.change({authenticated: false});}});
  const old = h.currentRegistration(), active = await pending(h, 'submit');
  h.queue('list', () => {throw Object.assign(new Error('Denied'), {status: 403});});
  await h.tasks.refresh(); await drain();
  assert.equal(old.disposed, true); assert.equal(old.options.isCurrent(), false);
  assert.equal(active.request.options.signal.aborted, true); assert.equal(active.controller.getSnapshot().status, 'retired');
  assert.equal(h.tasks.getSnapshot().canCreate, false); assert.equal(h.cards().length, 0);
  reply(active.request); assert.equal(await active.work, false); await drain(); assert.equal(h.openings.length, 0);
});

for (const retirement of ['scope', 'configure', 'dispose']) test(`pending feed ${retirement} aborts before stale records can publish`, async t => {
  const h = await ready(t), gate = h.hold('list'), work = h.tasks.refresh(); await drain();
  const request = h.last('list'), source = h.currentRegistration();
  if (retirement === 'scope') h.change({scopeKey: `${F.SCOPE}:next`});
  else if (retirement === 'configure') h.tasks.configure(h.makeProviders());
  else h.tasks.dispose();
  assert.equal(request.options.signal.aborted, true); assert.equal(source.disposed, true);
  const replacements = source.replacements.length;
  gate.resolve(H.page([summary()])); await work; await drain();
  assert.equal(source.replacements.length, replacements); assert.equal(h.cards().length, 0);
  assert.equal(h.openings.length, 0);
});

test('an explicit failed process remains an inspectable retry action without raw error text', async t => {
  const h = await ready(t), controller = await resume(h), work = controller.process(); await drain();
  h.last('process').reject(new Error('PRIVATE_PROVIDER_ERROR')); assert.equal(await work, false); await drain();
  const row = h.rows().find(row => row.id === JOB); assert.ok(row);
  assert.equal(row.byline, 'Action needs retry'); assert.equal(row.statusLabel, 'Action needs retry');
  assert.doesNotMatch(JSON.stringify(h.rows()), /PRIVATE_PROVIDER_ERROR/);
  assert.equal(h.calls('process').length, 1); assert.equal(h.openings.length, 0);
});
