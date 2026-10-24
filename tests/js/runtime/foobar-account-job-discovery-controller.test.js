'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./foobar-account-import-fixture.cjs'), J = require('./foobar-account-job-discovery-fixture.cjs');
test('J07 initialization reads discovery before idle default source with scoped POST credentials', async t => {
  const f = await F.controller(t, J.wire(J.list()).enqueue('/ui/source', F.source())); await f.owner.initialize();
  assert.deepEqual(f.wire.calls.map(x => x.route), ['/job/list', '/ui/source']);
  const request = f.wire.calls[0]; assert.deepEqual(J.body(request), {version: J.VERSION, unfinished: true, cursor: null});
  assert.equal(request.init.method, 'POST'); assert.equal(request.init.credentials, 'same-origin'); assert.equal(request.init.cache, 'no-store'); assert.equal(request.init.redirect, 'error'); assert.equal(request.init.headers['X-AlbumHaven-Foobar-Context'], F.STAMP);
  assert.equal(f.owner.getState().source.source_ref, F.SOURCE); assert.equal(f.owner.getState().canDiscover, true);
});
test('J08 busy initialization skips source discovery and never generates or dispatches a job', async t => {
  const f = await F.controller(t, J.wire(J.busy())); await f.owner.initialize();
  assert.deepEqual(f.wire.calls.map(x => x.route), ['/job/list']); assert.equal(f.owner.getState().source, null); assert.equal(f.owner.getState().jobRef, null); assert.equal(f.owner.getState().submitted, false); assert.equal(f.time.tasks.size, 0); assert.equal(J.writes(f).length, 0);
});
test('J09 failed initialization preserves identity and permits explicit manual source fallback', async t => {
  const f = await F.controller(t, J.wire(() => Promise.reject(new Error('lost')))); await f.owner.initialize();
  assert.equal(f.owner.getState().jobRef, null); assert.match(f.owner.getState().discoveryError, /could not be read/); assert.equal(f.wire.calls.length, 1);
  f.wire.enqueue('/ui/source', F.source()); await f.owner.selectSource(F.SOURCE); assert.equal(f.owner.getState().source.source_ref, F.SOURCE); assert.deepEqual(J.body(f.wire.calls.at(-1)), {source_ref: F.SOURCE});
});
test('J10 discovery page navigation replaces bounded items and refresh resets exact cursor', async t => {
  const first = J.page(), f = await F.controller(t, J.wire(first).enqueue('/ui/source', F.source())); await f.owner.initialize();
  f.wire.enqueue('/job/list', J.list([J.item(20)])); await f.owner.nextJobPage();
  assert.deepEqual(J.body(f.wire.calls.at(-1)).cursor, first.result.next_cursor); assert.equal(f.owner.getState().discovery.items.length, 1); assert.equal(f.owner.getState().discovery.items[0].job_ref, J.id(20));
  f.wire.enqueue('/job/list', J.list([], {unfinished: false})); await f.owner.discoverJobs(false, null); assert.deepEqual(J.body(f.wire.calls.at(-1)), {version: J.VERSION, unfinished: false, cursor: null}); assert.equal(f.owner.getState().discovery.items.length, 0);
});
test('J11 advisory selection reads genuine status and retains partial confirmed prefix without resume', async t => {
  const f = await F.controller(t, J.wire(J.list([J.item()])).enqueue('/ui/source', F.source())); await f.owner.initialize();
  f.wire.enqueue('/job/status', F.job()); await f.owner.selectDiscoveredJob(F.JOBREF, F.SOURCE);
  assert.equal(f.owner.getState().job.confirmed_rows, 2); assert.equal(f.owner.getState().jobRef, F.JOBREF); assert.equal(f.owner.getState().submitted, true); assert.equal(f.owner.getState().phase, 'paused');
  assert.deepEqual(J.body(f.wire.calls.at(-1)), {version: F.JOB, source_ref: F.SOURCE, job_ref: F.JOBREF}); assert.equal(J.writes(f).length, 0); assert.equal(f.time.tasks.size, 0);
});
test('J12 lost status after list selection retains same identity and forbids automatic new-key dispatch', async t => {
  const f = await F.controller(t, J.wire(J.busy([J.item(2, {created_at: null, updated_at: null})]))); await f.owner.initialize();
  f.wire.enqueue('/job/status', () => Promise.reject(new Error('lost'))); await f.owner.selectDiscoveredJob(F.JOBREF, F.SOURCE);
  const before = f.wire.calls.length; await f.owner.discoverJobs(); await f.owner.selectDiscoveredJob(F.OTHER, F.SOURCE); await f.owner.selectSource(null); await f.owner.confirm();
  assert.equal(f.wire.calls.length, before); assert.equal(f.owner.getState().jobRef, F.JOBREF); assert.equal(f.owner.getState().source.source_ref, F.SOURCE); assert.equal(f.owner.getState().submitted, true); assert.equal(J.writes(f).length, 0);
});
test('J13 malformed stale or foreign list preserves prior page and blocks stale selection', async t => {
  const f = await F.controller(t, J.wire(J.list([J.item()])).enqueue('/ui/source', F.source())); await f.owner.initialize(); const retained = f.owner.getState().discovery;
  for (const value of [{...J.list(), context_ref: 'e'.repeat(64)}, J.list([J.item(2, {updated_at: 'yesterday'})]), J.list([J.item(), J.item()])]) {
    f.wire.enqueue('/job/list', value); await f.owner.discoverJobs(); assert.equal(f.owner.getState().discovery, retained); assert.match(f.owner.getState().discoveryError, /stale/);
    const before = f.wire.calls.length; await f.owner.selectDiscoveredJob(F.JOBREF, F.SOURCE); await f.owner.nextJobPage(); assert.equal(f.wire.calls.length, before); assert.equal(f.owner.getState().jobRef, null);
  }
});
test('J14 discovery cannot interrupt selected file review or pending submission', async t => {
  const f = await F.controller(t); await F.ready(f); const review = f.owner.getState().review, before = f.wire.calls.length;
  await f.owner.discoverJobs(); await f.owner.selectDiscoveredJob(F.JOBREF, F.SOURCE); assert.equal(f.wire.calls.length, before); assert.equal(f.owner.getState().review, review);
  const late = F.deferred(); f.wire.enqueue('/job/start', () => late.promise); const pending = f.owner.confirm(), request = f.wire.calls.at(-1);
  await f.owner.discoverJobs(); assert.equal(request.init.signal.aborted, false); assert.equal(f.wire.calls.length, before + 1); late.resolve(F.response(F.accepted(F.JOB, 'start'))); await pending;
  await f.owner.discoverJobs(); assert.equal(f.wire.calls.length, before + 1); assert.equal(f.time.tasks.size, 1);
});
test('J15 pending list suppresses duplicate requests and late context response cannot publish or select source', async t => {
  const late = F.deferred(), f = await F.controller(t, J.wire(() => late.promise)); const pending = f.owner.initialize();
  await f.owner.discoverJobs(); await f.owner.selectSource(null); await f.owner.initialize(); assert.equal(f.wire.calls.length, 1);
  f.root.dataset.accountFoobarContext = 'e'.repeat(64); late.resolve(F.response(J.list([J.item()]))); await pending;
  assert.equal(f.owner.getState().phase, 'retired'); assert.equal(f.owner.getState().discovery, undefined); assert.equal(f.wire.calls.length, 1); assert.equal(f.time.tasks.size, 0);
});
test('J16 unlisted selection and malformed cursor never dispatch network requests', async t => {
  const f = await F.controller(t, J.wire(J.busy())); await f.owner.initialize();
  await f.owner.selectDiscoveredJob(F.JOBREF, F.SOURCE); await assert.rejects(f.owner.discoverJobs(true, {updated_at: 'bad'})); assert.equal(f.wire.calls.length, 1); assert.equal(f.owner.getState().jobRef, null);
});
