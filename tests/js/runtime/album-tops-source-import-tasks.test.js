'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./album-tops-source-import-task-fixtures/tasks.cjs');
const {F, JOB, REQUEST, INPUT, summary, job, ready, submit, resume, drain, noImplicitActions} = H;
test.before(H.load);

for (const initial of [{authenticated: false}, {scopeKey: null}, {scopeKey: ''}]) {
  test(`unavailable task scope does not allocate or dispatch (${JSON.stringify(initial)})`, async t => {
    const h = await ready(t, {initial});
    assert.deepEqual(h.tasks.getSnapshot(), {scopeKey: null, retainedCount: 0, capacity: 32, canCreate: false});
    assert.equal(h.tasks.create(), null); assert.equal(await h.tasks.resume(JOB), null);
    assert.equal(h.keyCalls(), 0); assert.equal(h.requests.length, 0); assert.equal(h.registrations.length, 0);
  });
}

test('one real registry source and immutable capacity snapshot belong to the authenticated scope', async t => {
  const h = await ready(t);
  assert.equal(h.registrations.length, 1);
  const options = h.registrations[0].options;
  assert.equal(options.name, 'album-top-source-imports'); assert.equal(options.label, 'Album Top imports');
  assert.equal(options.scopeKey, F.SCOPE); assert.equal(options.isCurrent(), true);
  const value = h.tasks.getSnapshot();
  assert.deepEqual(value, {scopeKey: F.SCOPE, retainedCount: 0, capacity: 32, canCreate: true});
  assert.equal(Object.isFrozen(value), true); assert.throws(() => {value.retainedCount = 100;}, TypeError);
  assert.equal(h.calls('list').length, 1); noImplicitActions(h);
  assert.equal(h.calls('list')[0].options.scopeKey, F.SCOPE);
  assert.equal(h.calls('list')[0].options.signal instanceof AbortSignal, true);
});

test('create allocates one request identity without submitting and idle release frees it', async t => {
  const h = await ready(t), before = h.requests.length, seen = [];
  const unsubscribe = h.tasks.subscribe(() => seen.push(h.tasks.getSnapshot()));
  const controller = h.tasks.create(); assert.ok(controller);
  assert.equal(controller.getSnapshot().status, 'idle'); assert.equal(h.keyCalls(), 1);
  assert.equal(h.requests.length, before); assert.equal(h.tasks.getSnapshot().retainedCount, 1);
  h.tasks.release(controller); h.tasks.release(controller);
  assert.equal(controller.getSnapshot().status, 'retired'); assert.equal(h.tasks.getSnapshot().retainedCount, 0);
  assert.ok(seen.some(row => row.retainedCount === 1)); assert.ok(seen.some(row => row.retainedCount === 0));
  assert.ok(seen.every(Object.isFrozen)); unsubscribe();
});

for (const key of [undefined, null, '', 'ABC', '00000000-0000-0000-0000-000000000000', `${REQUEST}\n`]) {
  test(`invalid generated key is rejected before controller/network allocation (${String(key)})`, async t => {
    const h = await ready(t, {key: () => key}), before = h.requests.length;
    assert.equal(h.tasks.create(), null); assert.equal(h.tasks.getSnapshot().retainedCount, 0);
    assert.equal(h.requests.length, before); assert.equal(h.keyCalls(), 1);
  });
}

test('duplicate generated identity cannot alias another controller', async t => {
  const h = await ready(t, {key: () => REQUEST}), first = h.tasks.create(), before = h.requests.length;
  assert.ok(first); assert.equal(h.tasks.create(), null);
  assert.equal(h.tasks.getSnapshot().retainedCount, 1); assert.equal(first.getSnapshot().status, 'idle');
  assert.equal(h.requests.length, before);
});

test('explicit submit starts the real durable parser command exactly once without implicit process or Open', async t => {
  const h = await ready(t), controller = h.tasks.create(), work = controller.submit(INPUT); await drain();
  const request = h.last('submit');
  assert.deepEqual(request.body, {request_key: F.id(1101), ...INPUT});
  assert.equal(request.options.scopeKey, F.SCOPE); assert.equal(request.options.signal.aborted, false);
  assert.equal(await controller.submit({...INPUT, title: 'Do not replace pending intent'}), false);
  assert.equal(h.calls('submit').length, 1);
  assert.deepEqual(h.rows().map(row => ({id: row.id, title: row.title, byline: row.byline})),
    [{id: `pending:${F.id(1101)}`, title: 'Album Top import', byline: 'Submitting source'}]);
  request.resolve(job({request_key: request.body.request_key})); assert.equal(await work, true); await drain();
  noImplicitActions(h); assert.equal(h.keyCalls(), 1);
  assert.equal(controller.getSnapshot().job.job_ref, JOB);
  assert.equal(h.tasks.getSnapshot().retainedCount, 1, 'attached review remains available after acknowledgment');
});

test('closing pending submit keeps the command alive until matching durable feed acknowledges detached ownership', async t => {
  const h = await ready(t), controller = h.tasks.create(), work = controller.submit(INPUT); await drain();
  const request = h.last('submit'); h.tasks.release(controller);
  assert.equal(request.options.signal.aborted, false); assert.equal(controller.getSnapshot().status, 'loading');
  request.resolve(job({request_key: request.body.request_key})); await work; await drain();
  assert.equal(controller.getSnapshot().status, 'ready'); assert.equal(h.tasks.getSnapshot().retainedCount, 1);
  h.setFeed([summary({request_key: request.body.request_key})]); await h.tasks.refresh(); await drain();
  assert.equal(controller.getSnapshot().status, 'retired'); assert.equal(h.tasks.getSnapshot().retainedCount, 0);
  assert.equal(h.cards().length, 1); assert.equal(h.cards()[0].id, JOB); noImplicitActions(h);
});

test('uncertain detached submit resumes exact retained intent by feed request key and retries unchanged bytes', async t => {
  const h = await ready(t), controller = h.tasks.create(), input = {...INPUT};
  const work = controller.submit(input); await drain(); const original = h.last('submit');
  input.content = 'Replacement private text'; original.reject(new TypeError('Acknowledgment lost'));
  assert.equal(await work, false); h.tasks.release(controller); await drain();
  assert.equal(controller.getSnapshot().status, 'uncertain'); assert.equal(h.tasks.getSnapshot().retainedCount, 1);
  assert.equal(h.rows().find(row => row.id.startsWith('pending:')).byline, 'Submission result unknown');
  h.setFeed([summary({request_key: original.body.request_key})]); await h.tasks.refresh(); await drain();
  assert.equal(controller.getSnapshot().status, 'uncertain');
  const reads = h.calls('read').length;
  assert.equal(await h.tasks.resume(JOB), controller); assert.equal(h.calls('read').length, reads);
  const retry = controller.retry(); await drain(); const repeated = h.last('submit');
  assert.deepEqual(repeated.body, original.body); assert.notEqual(repeated.options.signal, original.options.signal);
  assert.equal(h.keyCalls(), 1); assert.equal(h.calls('submit').length, 2);
  repeated.resolve(job({request_key: original.body.request_key})); assert.equal(await retry, true); await drain();
  noImplicitActions(h); assert.equal(controller.getSnapshot().status, 'ready');
});

test('definitively rejected detached submit releases without pretending a job was created', async t => {
  const h = await ready(t), controller = h.tasks.create(), work = controller.submit(INPUT); await drain();
  h.tasks.release(controller);
  h.last('submit').reject(Object.assign(new Error('Rejected command'), {status: 400, responseRejected: true}));
  assert.equal(await work, false); await drain();
  assert.equal(controller.getSnapshot().status, 'retired'); assert.equal(h.tasks.getSnapshot().retainedCount, 0);
  assert.equal(h.cards().length, 0); noImplicitActions(h);
});

test('explicit resume reads one real controller without allocating a submission identity', async t => {
  const h = await ready(t), controller = await resume(h);
  assert.equal(h.keyCalls(), 0); assert.equal(h.calls('read').length, 1);
  assert.equal(h.last('read').path, `/album-tops/source-imports/${JOB}`);
  assert.equal(h.last('read').options.scopeKey, F.SCOPE);
  assert.equal(await h.tasks.resume(JOB), controller); assert.equal(h.calls('read').length, 1);
  assert.equal(h.tasks.getSnapshot().retainedCount, 1); noImplicitActions(h);
});

test('failed current resume preserves the actual controller for explicit Retry', async t => {
  const h = await ready(t), work = h.tasks.resume(JOB); await drain();
  h.last('read').reject(new TypeError('Read failed')); const controller = await work;
  assert.ok(controller); assert.equal(controller.getSnapshot().status, 'error');
  const retry = controller.retry(); await drain(); h.last('read').resolve(job());
  assert.equal(await retry, true); assert.equal(controller.getSnapshot().job.job_ref, JOB);
  assert.equal(h.calls('read').length, 2); assert.equal(h.keyCalls(), 0); noImplicitActions(h);
});

for (const ref of [null, '', 'ABC', '00000000-0000-0000-0000-000000000000', `${JOB}\n`]) {
  test(`malformed resume is rejected before allocation or request (${String(ref)})`, async t => {
    const h = await ready(t), before = h.requests.length;
    assert.equal(await h.tasks.resume(ref), null); assert.equal(h.tasks.getSnapshot().retainedCount, 0);
    assert.equal(h.requests.length, before); assert.equal(h.keyCalls(), 0);
  });
}
