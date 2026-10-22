'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./album-tops-source-import-task-fixtures/tasks.cjs');
const {F, JOB, INPUT, summary, job, ready, resume, drain} = H;
let createSourceImportController;
test.before(async () => {await H.load(); ({createSourceImportController} = await F.load('album-tops/source-import-controller.mjs'));});
function lease(h, controller) {
  const counts = [h.requests.length, h.keyCalls(), h.tasks.getSnapshot().retainedCount];
  const value = h.tasks.retain(controller);
  assert.ok(value); assert.equal(Object.isFrozen(value), true); assert.deepEqual(Object.keys(value), ['release']);
  assert.equal(typeof value.release, 'function');
  assert.deepEqual([h.requests.length, h.keyCalls(), h.tasks.getSnapshot().retainedCount], counts,
    'acquiring a surface lease allocates no controller/key and dispatches no request');
  return value;
}
function current(h, controller, count = 1) {
  assert.notEqual(controller.getSnapshot().status, 'retired'); assert.equal(h.tasks.getSnapshot().retainedCount, count);
}
function retired(h, controller) {
  assert.equal(controller.getSnapshot().status, 'retired'); assert.equal(h.tasks.getSnapshot().retainedCount, 0);
}

test('retain returns a frozen exact-entry lease and transferring legacy attachment has no collectible gap', async t => {
  const h = await ready(t), controller = h.tasks.create(), surface = lease(h, controller);
  h.tasks.release(controller); current(h, controller); assert.equal(controller.canSubmit(), true);
  surface.release(); retired(h, controller); surface.release(); retired(h, controller);
  assert.equal(h.calls('submit').length, 0); assert.equal(h.keyCalls(), 1);
});

test('releasing a surface lease never releases the independent legacy attachment', async t => {
  const h = await ready(t), controller = h.tasks.create(), surface = lease(h, controller);
  surface.release(); surface.release(); current(h, controller); assert.equal(controller.canSubmit(), true);
  h.tasks.release(controller); retired(h, controller);
});

for (const order of [[0, 1, 2], [2, 0, 1], [1, 2, 0]]) test(`independent leases survive old/new releases in order ${order.join(',')}`, async t => {
  const h = await ready(t, {feed: [summary()]}), controller = await resume(h);
  const surfaces = [lease(h, controller), lease(h, controller), lease(h, controller)];
  assert.equal(new Set(surfaces).size, 3); h.tasks.release(controller);
  await h.tasks.refresh(); await drain(); current(h, controller);
  for (const index of order.slice(0, -1)) {surfaces[index].release(); surfaces[index].release(); current(h, controller);}
  assert.equal(controller.select('1', {kind: 'local_catalog', album_ref: F.A}), true);
  surfaces[order.at(-1)].release(); retired(h, controller);
  assert.equal(h.calls('read').length, 1); assert.equal(h.calls('finalize').length, 0);
});

test('a released old lease cannot detach or collect a same-job replacement with its own current lease', async t => {
  const h = await ready(t, {feed: [summary()]}), old = await resume(h), previous = lease(h, old);
  h.tasks.release(old); previous.release(); retired(h, old); assert.equal(h.tasks.retain(old), null);
  const next = await resume(h), successor = lease(h, next); assert.notEqual(next, old); h.tasks.release(next);
  previous.release(); h.tasks.release(old); await h.tasks.refresh(); await drain(); current(h, next);
  assert.equal(next.select('1', {kind: 'local_catalog', album_ref: F.A}), true);
  successor.release(); retired(h, next); assert.equal(h.calls('read').length, 2); assert.equal(h.keyCalls(), 0);
});

test('foreign real controllers and lookalike values cannot acquire ownership or allocate anything', async t => {
  const h = await ready(t), owned = h.tasks.create(), foreign = createSourceImportController({providers: h.providers,
    scopeKey: F.SCOPE, isCurrent: () => true, key: () => H.REQUEST});
  t.after(() => foreign.dispose());
  const counts = [h.requests.length, h.keyCalls(), h.tasks.getSnapshot().retainedCount];
  for (const value of [null, undefined, {}, Object.create(owned), foreign]) assert.equal(h.tasks.retain(value), null);
  assert.deepEqual([h.requests.length, h.keyCalls(), h.tasks.getSnapshot().retainedCount], counts);
  assert.equal(foreign.canSubmit(), true); current(h, owned);
});

test('directly disposed controllers cannot be retained even while the task owner is otherwise current', async t => {
  const h = await ready(t), controller = h.tasks.create(), old = lease(h, controller); controller.dispose();
  const counts = [h.requests.length, h.keyCalls()]; assert.equal(h.tasks.retain(controller), null); old.release();
  assert.deepEqual([h.requests.length, h.keyCalls()], counts); assert.equal(controller.getSnapshot().status, 'retired');
});

for (const reason of ['scope', 'logout', 'private scope', 'configure', 'dispose', 'denial']) {
  test(`${reason} invalidates old surface leases before they can retain or affect a successor`, async t => {
    const h = await ready(t), controller = h.tasks.create(), old = lease(h, controller);
    h.tasks.release(controller); const pending = controller.submit(INPUT); await drain(); const request = h.last('submit');
    if (reason === 'scope') h.change({scopeKey: `${F.SCOPE}:next`});
    else if (reason === 'logout') h.change({authenticated: false});
    else if (reason === 'private scope') h.rejectScope();
    else if (reason === 'configure') h.tasks.configure(h.makeProviders());
    else if (reason === 'dispose') h.tasks.dispose();
    else {h.queue('list', () => {throw Object.assign(new Error('Denied'), {status: 403, responseRejected: true});}); await h.tasks.refresh();}
    await drain(); assert.equal(request.options.signal.aborted, true); assert.equal(h.tasks.retain(controller), null);
    assert.equal(controller.getSnapshot().status, 'retired');
    const successor = h.tasks.getSnapshot().canCreate ? h.tasks.create() : null;
    const surface = successor ? lease(h, successor) : null; if (successor) h.tasks.release(successor);
    const counts = [h.requests.length, h.keyCalls()]; old.release(); old.release();
    assert.deepEqual([h.requests.length, h.keyCalls()], counts);
    request.resolve(job({request_key: request.body.request_key})); assert.equal(await pending, false); await drain();
    if (successor) {current(h, successor); surface.release(); retired(h, successor);}
    else assert.equal(h.tasks.getSnapshot().retainedCount, 0);
    assert.equal(h.calls('submit').length, 1); assert.equal(h.calls('process').length, 0);
  });
}

for (const uncertain of [false, true]) test(`last lease release preserves a ${uncertain ? 'uncertain' : 'loading'} submission and its exact future acknowledgment`, async t => {
  const h = await ready(t), controller = h.tasks.create(), surface = lease(h, controller); h.tasks.release(controller);
  const pending = controller.submit(INPUT); await drain(); const first = h.last('submit');
  if (uncertain) {first.reject(new TypeError('Lost acknowledgment')); assert.equal(await pending, false);}
  surface.release(); surface.release(); await h.tasks.refresh(); await drain(); current(h, controller);
  assert.equal(controller.getSnapshot().status, uncertain ? 'uncertain' : 'loading'); assert.equal(first.options.signal.aborted, false);
  const reopened = lease(h, controller); let request = first, completion = pending;
  if (uncertain) {completion = controller.retry(); await drain(); request = h.last('submit'); assert.deepEqual(request.body, first.body);}
  const value = job({request_key: request.body.request_key}); request.resolve(value); assert.equal(await completion, true);
  h.setFeed([summary({request_key: value.request_key})]); await h.tasks.refresh(); await drain(); current(h, controller);
  assert.equal(controller.select('1', {kind: 'local_catalog', album_ref: F.A}), true);
  reopened.release(); retired(h, controller); assert.equal(h.calls('submit').length, uncertain ? 2 : 1);
  assert.equal(h.calls('process').length, 0); assert.equal(h.calls('finalize').length, 0);
});

for (const [label, patch, collect] of [
  ['equal matching', {}, true], ['newer matching', {revision: '5'}, true],
  ['newer saved', {revision: '5', top_ref: H.SAVED_TOP, phase: 'top_created'}, true],
  ['older', {revision: '3'}, false], ['different job', {job_ref: H.OTHER_JOB}, false],
  ['different request', {request_key: F.id(999)}, false],
  ['equal conflicting state', {status: 'running', phase: 'source_processing'}, false],
]) test(`last lease uses existing safe feed collection rules for ${label} evidence`, async t => {
  const h = await ready(t), controller = await resume(h), surface = lease(h, controller); h.tasks.release(controller);
  h.setFeed([summary(patch)]); await h.tasks.refresh(); await drain(); current(h, controller);
  assert.equal(controller.getSnapshot().job.revision, '4'); assert.equal(controller.getSnapshot().job.top_ref, null);
  surface.release(); await drain();
  if (collect) retired(h, controller); else {current(h, controller); assert.equal(controller.getSnapshot().job.request_key, H.REQUEST);}
  assert.equal(h.calls('read').length, 1); assert.equal(h.calls('submit').length, 0); assert.equal(h.calls('process').length, 0);
});

test('a later legacy resume attachment survives release of the last surface lease', async t => {
  const h = await ready(t, {feed: [summary()]}), controller = await resume(h), surface = lease(h, controller);
  h.tasks.release(controller); assert.equal(await h.tasks.resume(JOB), controller); surface.release();
  await h.tasks.refresh(); await drain(); current(h, controller); assert.equal(h.calls('read').length, 1);
  h.tasks.release(controller); retired(h, controller);
});

test('retaining an existing entry works at capacity without a thirty-third allocation or new key', async t => {
  const h = await ready(t), controllers = Array.from({length: 32}, () => h.tasks.create());
  assert.ok(controllers.every(Boolean)); assert.equal(h.tasks.getSnapshot().canCreate, false);
  const surface = lease(h, controllers[0]); h.tasks.release(controllers[0]); current(h, controllers[0], 32);
  assert.equal(h.tasks.create(), null); assert.equal(h.keyCalls(), 32); surface.release();
  assert.equal(h.tasks.getSnapshot().retainedCount, 31); assert.equal(h.tasks.getSnapshot().canCreate, true);
  assert.ok(controllers.slice(1).every(controller => controller.canSubmit())); assert.equal(h.calls('submit').length, 0);
});
