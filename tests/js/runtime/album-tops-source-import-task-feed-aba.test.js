'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./album-tops-source-import-task-fixtures/tasks.cjs');
const {F, JOB, summary, job, ready, drain} = H;
test.before(H.load);

for (const change of ['receipt', 'request']) test(`authoritative ${change} change then restoration cannot revive an older pending Open without an intervening currentness check`, async t => {
  let h; const opens = [];
  h = await ready(t, {feed: [summary()], open: async (value, isCurrent) => {
    const record = {value, isCurrent, finish: F.deferred(), controller: null}; opens.push(record);
    record.controller = value.controller || await h.tasks.resume(value.job_ref);
    return record.finish.promise;
  }});
  assert.equal(h.activate(JOB), true); await drain(); const first = opens[0], read = h.last('read');
  assert.equal(first.value.controller, null); assert.equal(h.calls('read').length, 1);
  const changed = change === 'receipt' ? {top_ref: H.SAVED_TOP, phase: 'top_created'} : {request_key: F.id(999)};
  // Neither test nor callback evaluates first.isCurrent between these feeds.
  h.setFeed([summary({...changed, revision: '5'})]); await h.tasks.refresh(); await drain();
  h.setFeed([summary({revision: '6'})]); await h.tasks.refresh(); await drain();
  assert.equal(read.options.signal.aborted, false); assert.equal(h.tasks.getSnapshot().retainedCount, 1);
  read.resolve(job()); await drain(); assert.ok(first.controller); assert.equal(first.controller.getSnapshot().status, 'ready');
  assert.equal(first.isCurrent(), false, 'successful feed publication permanently retired this activation');
  first.finish.resolve(true); await drain(); assert.equal(h.cards().find(row => row.id === JOB).read, false);
  assert.equal(h.activate(JOB), true); await drain(); const fresh = opens[1];
  assert.equal(fresh.controller, first.controller); assert.equal(fresh.isCurrent(), true);
  fresh.finish.resolve(true); await drain(); assert.equal(h.cards().find(row => row.id === JOB).read, true);
  assert.equal(opens.length, 2); assert.equal(h.calls('read').length, 1); assert.equal(h.keyCalls(), 0);
  for (const kind of ['submit', 'process', 'cancel', 'finalize']) assert.equal(h.calls(kind).length, 0);
});
