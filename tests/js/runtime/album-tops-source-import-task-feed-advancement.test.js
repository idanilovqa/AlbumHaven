'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./album-tops-source-import-task-fixtures/tasks.cjs');
const {F, JOB, REQUEST, SAVED_TOP, summary, job, receipt, ready, resume, drain} = H;
test.before(H.load);
const states = (status, revision = '4', top_ref = null) => ({status, revision, top_ref,
  phase: top_ref ? 'top_created' : status === 'completed' ? 'review_evidence' : 'source_processing',
  error: status === 'failed' ? 'source_processing_failed' : null});

for (const [from, to, top_ref, byline] of [
  ['queued', 'running', null, 'Processing source'], ['running', 'completed', null, 'Ready for review'],
  ['running', 'failed', null, 'Source processing failed'], ['running', 'canceled', null, 'Import canceled'],
  ['completed', 'completed', SAVED_TOP, 'Album Top created'],
]) test(`newer same-job/request feed releases settled detached ${from} to ${to}${top_ref ? '/saved' : ''}`, async t => {
  const h = await ready(t, {open: () => false}), controller = await resume(h, job(states(from)));
  h.tasks.release(controller); assert.equal(h.tasks.getSnapshot().retainedCount, 1);
  h.setFeed([summary(states(to, '5', top_ref))]); await h.tasks.refresh(); await drain();
  assert.equal(controller.getSnapshot().status, 'retired'); assert.equal(h.tasks.getSnapshot().retainedCount, 0);
  assert.equal(h.rows().find(row => row.id === JOB).byline, byline);
  assert.equal(h.rows().find(row => row.id === JOB).statusLabel, byline);
  assert.equal(h.activate(JOB), true); await drain();
  assert.deepEqual(h.openings[0].value, {job_ref: JOB, top_ref, controller: null});
  assert.equal(h.calls('read').length, 1); assert.equal(h.calls('process').length, 0);
});

for (const [label, patch] of [
  ['older revision', states('running', '3')], ['equal conflicting status', states('running', '4')],
  ['newer different job', {...states('completed', '5', SAVED_TOP), job_ref: H.OTHER_JOB}],
  ['newer different request', {...states('completed', '5', SAVED_TOP), request_key: F.id(999)}],
]) test(`${label} cannot release detached ownership or replace its retained review`, async t => {
  const h = await ready(t, {open: () => false}), controller = await resume(h); h.tasks.release(controller);
  h.setFeed([summary(patch)]); await h.tasks.refresh(); await drain();
  assert.equal(controller.getSnapshot().status, 'ready'); assert.equal(h.tasks.getSnapshot().retainedCount, 1);
  assert.equal(h.rows().find(row => row.id === JOB).byline, 'Ready for review');
  assert.equal(h.activate(JOB), true); await drain();
  assert.deepEqual(h.openings[0].value, {job_ref: JOB, top_ref: null, controller});
});

test('equal revision and identical durable state may release a settled detached owner', async t => {
  const h = await ready(t), controller = await resume(h); h.tasks.release(controller);
  h.setFeed([summary()]); await h.tasks.refresh(); await drain();
  assert.equal(controller.getSnapshot().status, 'retired'); assert.equal(h.tasks.getSnapshot().retainedCount, 0);
  assert.equal(h.rows()[0].byline, 'Ready for review');
});

for (const top_ref of [SAVED_TOP, F.id(999)]) test(`newer feed ${top_ref === SAVED_TOP ? 'preserves' : 'cannot replace'} an already acknowledged saved Top identity`, async t => {
  const h = await ready(t, {open: () => false}), controller = await resume(h, job(states('completed', '4', SAVED_TOP)));
  h.tasks.release(controller); h.setFeed([summary(states('completed', '5', top_ref))]); await h.tasks.refresh(); await drain();
  const matches = top_ref === SAVED_TOP;
  assert.equal(controller.getSnapshot().status, matches ? 'retired' : 'ready');
  assert.equal(h.tasks.getSnapshot().retainedCount, matches ? 0 : 1);
  assert.equal(h.rows().find(row => row.id === JOB).byline, 'Album Top created');
  h.activate(JOB); await drain();
  assert.deepEqual(h.openings[0].value, {job_ref: JOB, top_ref: SAVED_TOP, controller: matches ? null : controller});
});

for (const revision of ['4', '5']) test(`an actual acknowledged finalization receipt is collected only by matching saved Top evidence at revision ${revision}`, async t => {
  const h = await ready(t, {open: () => false}), controller = await resume(h);
  assert.equal(controller.select('1', {kind: 'local_catalog', album_ref: F.A}), true);
  const work = controller.finalize(); await drain(); h.last('finalize').resolve(receipt(h.last('finalize').body));
  assert.equal(await work, true); h.tasks.release(controller); await drain();
  h.setFeed([summary(states('completed', revision, SAVED_TOP))]); await h.tasks.refresh(); await drain();
  assert.equal(controller.getSnapshot().status, 'retired'); assert.equal(h.tasks.getSnapshot().retainedCount, 0);
  h.activate(JOB); await drain(); assert.deepEqual(h.openings[0].value, {job_ref: JOB, top_ref: SAVED_TOP, controller: null});
  assert.equal(h.calls('finalize').length, 1);
});

for (const uncertain of [false, true]) test(`newer matching saved feed cannot discard a ${uncertain ? 'uncertain' : 'loading'} finalization command`, async t => {
  const h = await ready(t), controller = await resume(h);
  assert.equal(controller.select('1', {kind: 'local_catalog', album_ref: F.A}), true);
  const work = controller.finalize(); await drain(); const request = h.last('finalize'); h.tasks.release(controller);
  if (uncertain) {request.reject(new TypeError('Lost acknowledgment')); assert.equal(await work, false);}
  h.setFeed([summary(states('completed', '5', SAVED_TOP))]); await h.tasks.refresh(); await drain();
  assert.equal(controller.getSnapshot().status, uncertain ? 'uncertain' : 'loading');
  assert.equal(h.tasks.getSnapshot().retainedCount, 1);
  assert.equal(h.rows().find(row => row.id === JOB).byline, uncertain ? 'Save result unknown' : 'Saving Album Top');
  assert.equal(h.calls('finalize').length, 1); assert.equal(h.openings.length, 0);
  if (!uncertain) {assert.equal(request.options.signal.aborted, false); h.tasks.dispose();
    request.resolve(receipt(request.body)); assert.equal(await work, false);}
});

for (const [revision, top_ref] of [['3', SAVED_TOP], ['5', F.id(999)]]) {
  test(`conflicting feed ${revision}/${top_ref} cannot replace an actual acknowledged finalization receipt`, async t => {
    const h = await ready(t, {open: () => false}), controller = await resume(h);
    assert.equal(controller.select('1', {kind: 'local_catalog', album_ref: F.A}), true);
    const work = controller.finalize(); await drain(); h.last('finalize').resolve(receipt(h.last('finalize').body));
    assert.equal(await work, true); h.tasks.release(controller); await drain();
    h.setFeed([summary(states('completed', revision, top_ref))]); await h.tasks.refresh(); await drain();
    assert.equal(controller.getSnapshot().status, 'ready'); assert.equal(controller.getSnapshot().result.top_ref, SAVED_TOP);
    assert.equal(h.tasks.getSnapshot().retainedCount, 1); assert.equal(h.rows().find(row => row.id === JOB).byline, 'Album Top created');
    h.activate(JOB); await drain(); assert.deepEqual(h.openings[0].value, {job_ref: JOB, top_ref: SAVED_TOP, controller});
    assert.equal(h.calls('finalize').length, 1);
  });
}
