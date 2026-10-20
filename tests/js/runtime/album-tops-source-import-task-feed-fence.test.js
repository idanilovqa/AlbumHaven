'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./album-tops-source-import-task-fixtures/tasks.cjs');
const {F, JOB, REQUEST, SAVED_TOP, summary, job, ready, drain} = H;
test.before(H.load);
const state = top_ref => ({top_ref, phase: top_ref ? 'top_created' : 'review_evidence'});
async function reading(t, original) {
  let h; const opens = [];
  h = await ready(t, {feed: [summary(original)], open: async (value, isCurrent) => {
    const item = {value, isCurrent, finish: F.deferred(), controller: null}; opens.push(item);
    item.controller = value.controller || await h.tasks.resume(value.job_ref);
    item.afterRead = isCurrent(); return item.finish.promise;
  }});
  assert.equal(h.activate(JOB), true); await drain();
  assert.equal(opens.length, 1); assert.equal(opens[0].value.controller, null);
  assert.equal(opens[0].isCurrent(), true); assert.equal(h.calls('read').length, 1);
  return {...h, opens, first: opens[0], read: h.last('read')};
}
function unread(h) {const card = h.cards().find(row => row.id === JOB); assert.ok(card); assert.equal(card.read, false);}
function noWrites(h) {
  for (const kind of ['submit', 'process', 'cancel', 'finalize']) assert.equal(h.calls(kind).length, 0);
  assert.equal(h.keyCalls(), 0);
}

for (const [label, original, changed] of [
  ['new saved receipt', state(null), state(SAVED_TOP)],
  ['replacement saved receipt', state(SAVED_TOP), state(F.id(998))],
  ['changed request identity', state(null), {...state(null), request_key: F.id(999)}],
]) test(`authoritative ${label} retires server-only Open even after older retained read evidence republishes`, async t => {
  const h = await reading(t, original), first = h.first;
  h.setFeed([summary({...changed, revision: '5'})]); await h.tasks.refresh(); await drain();
  assert.equal(first.isCurrent(), false); assert.equal(h.read.options.signal.aborted, false);
  assert.equal(h.tasks.getSnapshot().retainedCount, 1, 'a navigation fence does not discard its pending read controller');
  const publications = h.currentRegistration().replacements.length;
  h.read.resolve(job(original)); await drain();
  assert.ok(first.controller); assert.equal(first.controller.getSnapshot().status, 'ready');
  assert.equal(first.controller.getSnapshot().job.request_key, REQUEST);
  assert.equal(first.controller.getSnapshot().job.top_ref, original.top_ref);
  assert.ok(h.currentRegistration().replacements.length > publications, 'the actual older controller publishes after the new feed');
  assert.equal(first.afterRead, false); assert.equal(first.isCurrent(), false, 'older merged projection cannot restore authoritative feed identity');
  assert.equal(h.tasks.getSnapshot().retainedCount, 1); unread(h);
  first.finish.resolve(true); await drain(); unread(h);
  assert.equal(h.opens.length, 1); assert.equal(h.calls('read').length, 1); noWrites(h);
});

for (const top_ref of [null, SAVED_TOP]) test(`same authoritative ${top_ref ? 'saved' : 'unsaved'} identity and receipt refresh preserves the actual pending Open`, async t => {
  const original = state(top_ref), h = await reading(t, original), first = h.first;
  h.setFeed([summary({...original, revision: '5', title: 'New summary title'})]); await h.tasks.refresh(); await drain();
  assert.equal(first.isCurrent(), true); assert.equal(h.read.options.signal.aborted, false); unread(h);
  h.read.resolve(job(original)); await drain(); assert.ok(first.controller);
  assert.equal(first.afterRead, true); assert.equal(first.isCurrent(), true);
  assert.equal(h.activate(JOB), false, 'same-card pending duplicate does not replace the admitted activation');
  first.finish.resolve(true); await drain(); assert.equal(h.cards().find(row => row.id === JOB).read, true);
  assert.equal(h.opens.length, 1); assert.equal(h.tasks.getSnapshot().retainedCount, 1); noWrites(h);
});

for (const uncertain of [false, true]) test(`changed authoritative receipt fences Open without collecting ${uncertain ? 'uncertain' : 'loading'} finalization`, async t => {
  const finish = F.deferred(), h = await ready(t, {feed: [summary()], open: () => finish.promise});
  const controller = await H.resume(h); assert.equal(controller.select('1', {kind: 'local_catalog', album_ref: F.A}), true);
  const work = controller.finalize(); await drain(); const request = h.last('finalize');
  if (uncertain) {request.reject(new TypeError('Lost save acknowledgment')); assert.equal(await work, false); await drain();}
  assert.equal(h.activate(JOB), true); await drain(); const opening = h.openings[0];
  assert.equal(opening.value.controller, controller); assert.equal(opening.isCurrent(), true);
  h.tasks.release(controller);
  h.setFeed([summary({...state(SAVED_TOP), revision: '5'})]); await h.tasks.refresh(); await drain();
  assert.equal(opening.isCurrent(), false); assert.equal(controller.getSnapshot().status, uncertain ? 'uncertain' : 'loading');
  assert.equal(h.tasks.getSnapshot().retainedCount, 1); assert.equal(request.options.signal.aborted, false);
  finish.resolve(true); await drain(); unread(h);
  assert.equal(h.calls('finalize').length, 1); assert.equal(h.calls('read').length, 1);
  assert.equal(h.calls('submit').length, 0); assert.equal(h.calls('process').length, 0); assert.equal(h.keyCalls(), 0);
  if (!uncertain) {h.tasks.dispose(); request.resolve(H.receipt(request.body)); assert.equal(await work, false);}
});
