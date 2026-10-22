'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./album-tops-source-import-task-fixtures/tasks.cjs');
const {F, JOB, INPUT, summary, ready, submit, resume, drain} = H;
test.before(H.load);

test('exactly 32 retained controllers are accepted and the 33rd fails before key allocation or request', async t => {
  const h = await ready(t), controllers = Array.from({length: 32}, () => h.tasks.create());
  assert.ok(controllers.every(Boolean)); assert.equal(new Set(controllers).size, 32);
  assert.equal(h.keyCalls(), 32); assert.equal(h.tasks.getSnapshot().retainedCount, 32);
  assert.equal(h.tasks.getSnapshot().canCreate, false);
  const before = h.requests.length;
  assert.equal(h.tasks.create(), null); assert.equal(await h.tasks.resume(JOB), null);
  assert.equal(await h.tasks.resume('invalid'), null); assert.equal(h.keyCalls(), 32); assert.equal(h.requests.length, before);
  assert.ok(controllers.every(controller => controller.getSnapshot().status === 'idle'));
  h.tasks.release(controllers[0]); assert.equal(h.tasks.getSnapshot().retainedCount, 31);
  assert.equal(h.tasks.getSnapshot().canCreate, true); assert.ok(h.tasks.create()); assert.equal(h.keyCalls(), 33);
});

test('existing retained job remains resumable at capacity without a read or new key', async t => {
  const h = await ready(t), controller = await resume(h);
  for (let n = 0; n < 31; n++) assert.ok(h.tasks.create());
  const before = h.requests.length, keys = h.keyCalls();
  assert.equal(h.tasks.getSnapshot().retainedCount, 32); assert.equal(await h.tasks.resume(JOB), controller);
  assert.equal(h.requests.length, before); assert.equal(h.keyCalls(), keys);
});

test('uncertain detached input is never evicted and matching request-key resume still works at capacity', async t => {
  const h = await ready(t), controller = h.tasks.create(), work = controller.submit(INPUT); await drain();
  const request = h.last('submit'); request.reject(new TypeError('Lost acknowledgment')); await work; h.tasks.release(controller);
  for (let n = 0; n < 31; n++) assert.ok(h.tasks.create());
  h.setFeed([summary({request_key: request.body.request_key})]); await h.tasks.refresh(); await drain();
  const before = h.requests.length, keys = h.keyCalls();
  assert.equal(h.tasks.create(), null); assert.equal(await h.tasks.resume(JOB), controller);
  assert.equal(controller.getSnapshot().status, 'uncertain'); assert.equal(h.tasks.getSnapshot().retainedCount, 32);
  assert.equal(h.requests.length, before); assert.equal(h.keyCalls(), keys);
});

for (const mismatch of ['job', 'request', 'failure']) test(`detached settled ownership stays bounded until matching feed (${mismatch} does not release)`, async t => {
  const h = await ready(t), {controller, request} = await submit(h); h.tasks.release(controller);
  for (let n = 0; n < 31; n++) assert.ok(h.tasks.create());
  if (mismatch === 'failure') h.queue('list', () => {throw new TypeError('Feed unavailable');});
  else h.setFeed([summary({job_ref: mismatch === 'job' ? H.OTHER_JOB : JOB,
    request_key: mismatch === 'request' ? H.REQUEST : request.body.request_key})]);
  await h.tasks.refresh(); await drain();
  assert.equal(controller.getSnapshot().status, 'ready'); assert.equal(h.tasks.getSnapshot().retainedCount, 32);
  const keys = h.keyCalls(); assert.equal(h.tasks.create(), null); assert.equal(h.keyCalls(), keys);
  h.setFeed([summary({request_key: request.body.request_key})]); await h.tasks.refresh(); await drain();
  assert.equal(controller.getSnapshot().status, 'retired'); assert.equal(h.tasks.getSnapshot().retainedCount, 31);
  assert.equal(h.tasks.getSnapshot().canCreate, true); assert.ok(h.tasks.create());
});

for (const action of ['create', 'resume']) for (const retirement of ['scope', 'configure', 'dispose']) {
  test(`snapshot subscriber ${retirement} reentrancy cannot return or dispatch old ${action} ownership`, async t => {
    const h = await ready(t), beforeReads = h.calls('read').length; let armed = true;
    const off = h.tasks.subscribe(() => {
      if (!armed || h.tasks.getSnapshot().retainedCount !== 1) return;
      armed = false;
      if (retirement === 'scope') h.change({scopeKey: `${F.SCOPE}:successor`});
      else if (retirement === 'configure') h.tasks.configure(h.makeProviders());
      else h.tasks.dispose();
    });
    const result = action === 'create' ? h.tasks.create() : await h.tasks.resume(JOB);
    assert.equal(result, null); await drain();
    assert.equal(armed, false); assert.equal(h.tasks.getSnapshot().retainedCount, 0);
    assert.equal(h.calls('read').length, beforeReads); assert.equal(h.calls('submit').length, 0);
    assert.equal(h.keyCalls(), action === 'create' ? 1 : 0); off();
  });
}

test('concurrent resume shares one retained controller and one explicit read', async t => {
  const h = await ready(t), first = h.tasks.resume(JOB), second = h.tasks.resume(JOB); await drain();
  assert.equal(h.calls('read').length, 1); assert.equal(h.tasks.getSnapshot().retainedCount, 1);
  h.last('read').resolve(H.job()); const a = await first, b = await second;
  assert.ok(a); assert.equal(a, b); assert.equal(h.keyCalls(), 0);
});

test('unsubscribed and disposed snapshot consumers cannot receive later task changes', async t => {
  const h = await ready(t), seen = []; const off = h.tasks.subscribe(() => seen.push(h.tasks.getSnapshot()));
  h.tasks.create(); assert.ok(seen.length > 0); off(); const before = seen.length;
  h.tasks.create(); h.tasks.dispose(); h.tasks.dispose();
  assert.equal(seen.length, before); assert.equal(h.tasks.getSnapshot().canCreate, false);
  assert.equal(h.tasks.create(), null); assert.equal(await h.tasks.resume(JOB), null);
});
