'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./album-tops-source-import-task-fixtures/tasks.cjs');
const {F, JOB, INPUT, summary, job, ready, resume, drain, noImplicitActions} = H;
test.before(H.load);

for (const top_ref of [null, H.SAVED_TOP]) test(`server-only ${top_ref ? 'saved' : 'review'} notification opens only explicitly and marks read only on current success`, async t => {
  const gate = F.deferred(), value = summary({top_ref, phase: top_ref ? 'top_created' : 'review_evidence'});
  const h = await ready(t, {feed: [value], open: () => gate.promise}); noImplicitActions(h);
  assert.equal(h.rows()[0].read, false); assert.equal(h.activate(JOB), true); await drain();
  assert.equal(h.openings.length, 1); assert.deepEqual(h.openings[0].value, {job_ref: JOB, top_ref, controller: null});
  assert.equal(h.openings[0].isCurrent(), true); assert.equal(h.activate(JOB), false); assert.equal(h.rows()[0].read, false);
  assert.equal(h.calls('read').length, 0); assert.equal(h.calls('finalize').length, 0);
  gate.resolve(true); await drain(); assert.equal(h.rows()[0].read, true);
  await h.tasks.refresh(); await drain(); assert.equal(h.rows()[0].read, true); assert.equal(h.openings.length, 1);
});

for (const rejected of [false, true]) test(`${rejected ? 'rejected' : 'declined'} explicit Open leaves notification unread and permits a later attempt`, async t => {
  let count = 0;
  const h = await ready(t, {feed: [summary()], open() {
    if (++count === 1) return rejected ? Promise.reject(new Error('Navigation failed')) : false;
    return true;
  }});
  assert.equal(h.activate(JOB), true); await drain(); assert.equal(h.rows()[0].read, false);
  assert.equal(h.activate(JOB), true); await drain(); assert.equal(h.rows()[0].read, true); assert.equal(h.openings.length, 2);
});

for (const retirement of ['scope', 'configure', 'dispose', 'removed-summary', 'saved-summary']) {
  test(`late explicit Open is fenced by ${retirement}`, async t => {
    const gate = F.deferred(), h = await ready(t, {feed: [summary()], open: () => gate.promise});
    const source = h.currentRegistration(); assert.equal(h.activate(JOB), true); await drain();
    const opening = h.openings[0]; assert.equal(opening.isCurrent(), true);
    if (retirement === 'scope') h.change({scopeKey: `${F.SCOPE}:next`});
    else if (retirement === 'configure') h.tasks.configure(h.makeProviders());
    else if (retirement === 'dispose') h.tasks.dispose();
    else {h.setFeed(retirement === 'removed-summary' ? [] : [summary({top_ref: H.SAVED_TOP, phase: 'top_created'})]); await h.tasks.refresh();}
    await drain(); assert.equal(opening.isCurrent(), false);
    gate.resolve(true); await drain();
    assert.ok(h.rows().every(row => row.read === false)); assert.equal(h.openings.length, 1);
    if (['scope', 'configure', 'dispose'].includes(retirement)) assert.equal(source.options.onOpen(JOB), false);
  });
}

for (const uncertain of [false, true]) test(`explicit pending ${uncertain ? 'uncertain' : 'submitting'} Open supplies the original retained controller`, async t => {
  const h = await ready(t, {open: () => false}), controller = h.tasks.create(), work = controller.submit(INPUT); await drain();
  const request = h.last('submit');
  if (uncertain) {request.reject(new TypeError('Lost acknowledgment')); assert.equal(await work, false); await drain();}
  h.tasks.release(controller); const id = `pending:${request.body.request_key}`;
  assert.equal(h.activate(id), true); await drain();
  assert.deepEqual(h.openings[0].value, {job_ref: null, top_ref: null, controller});
  assert.equal(h.openings[0].isCurrent(), true); assert.equal(h.rows().find(row => row.id === id).read, false);
  assert.equal(h.calls('submit').length, 1); assert.equal(h.calls('read').length, 0); assert.equal(h.calls('process').length, 0);
  if (!uncertain) {request.resolve(job({request_key: request.body.request_key})); await work; await drain();}
});

test('acknowledged retained review Open returns its actual controller and never creates a second reader', async t => {
  const h = await ready(t, {feed: [summary()]}), controller = await resume(h);
  assert.equal(h.activate(JOB), true); await drain();
  assert.deepEqual(h.openings[0].value, {job_ref: JOB, top_ref: null, controller});
  assert.equal(h.calls('read').length, 1); assert.equal(h.tasks.getSnapshot().retainedCount, 1);
});

test('a pending Open cannot mark a durable successor read after its submit acknowledgment changes identity', async t => {
  const gate = F.deferred(), h = await ready(t, {open: () => gate.promise}), controller = h.tasks.create();
  const work = controller.submit(INPUT); await drain(); const request = h.last('submit');
  assert.equal(h.activate(`pending:${request.body.request_key}`), true); await drain();
  const opening = h.openings[0];
  h.setFeed([summary({request_key: request.body.request_key})]); request.resolve(job({request_key: request.body.request_key}));
  assert.equal(await work, true); await drain(); assert.equal(opening.isCurrent(), false);
  gate.resolve(true); await drain(); assert.equal(h.rows().find(row => row.id === JOB).read, false);
});

test('read state is scoped and does not leak across account/session generations', async t => {
  const h = await ready(t, {feed: [summary()]}); h.activate(JOB); await drain(); assert.equal(h.rows()[0].read, true);
  h.change({scopeKey: `${F.SCOPE}:new-generation`}); await drain();
  assert.equal(h.rows()[0].read, false); assert.equal(h.openings.length, 1);
});
