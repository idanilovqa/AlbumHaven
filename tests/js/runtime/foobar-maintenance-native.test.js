'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('./foobar-maintenance-fixture.cjs'), {F, I} = M;

test('MN01 genuine import renderer mounts maintenance once and initial discovery never cleans metadata', async t => {
  const f = await M.native(t); assert.equal(f.root.contains(f.host), false); assert.equal(f.start.disabled, false); assert.equal(f.more.disabled, true);
  assert.equal(f.host.querySelectorAll('summary').filter(node => node.textContent === 'Expired import replay metadata').length, 1);
  assert.deepEqual(f.wire.calls.map(call => call.route), ['/job/list', '/ui/source']); assert.equal(M.calls(f).length, 0);
});
test('MN02 genuine import source action selects exact own-source response before maintenance POST', async t => {
  const f = await M.native(t); const source = F.source(); source.result.source_ref = F.OTHER;
  f.field('source-choice').value = F.OTHER; f.wire.enqueue('/ui/source', source); f.click(f.action('selectSource')); await F.settle();
  assert.equal(f.field('selected-source').value, F.OTHER); await M.complete(f, M.payload({source_ref: F.OTHER}));
  assert.equal(M.body(M.calls(f)[0]).source_ref, F.OTHER); assert.deepEqual(JSON.parse(f.wire.calls.findLast(call => call.route === '/ui/source').init.body), {source_ref: F.OTHER});
});
test('MN03 genuine import selected file disables maintenance and clearing restores idle ownership', async t => {
  const f = await M.native(t); f.choose(F.file()); await F.settle(); assert.equal(f.start.disabled, true); f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 0);
  f.click(f.action('clear')); await F.settle(); assert.equal(f.start.disabled, false); await M.complete(f); assert.equal(M.calls(f).length, 1);
});
test('MN04 genuine import review in flight and ready confirmation both keep cleanup unavailable', async t => {
  const f = await M.native(t); f.choose(F.file()); await F.settle(); const pending = F.deferred(); f.wire.enqueue('/review/start', () => pending.promise);
  f.click(f.action('preview')); assert.equal(f.start.disabled, true); f.start.dispatchEvent(new f.c.Event('click'));
  f.wire.enqueue('/review/status', F.review()); pending.resolve(F.response(F.accepted(F.REVIEW, 'start'))); await F.settle(); await f.time.tick();
  assert.equal(f.action('confirm').disabled, true); assert.equal(f.start.disabled, true); f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 0);
});
test('MN05 genuine import submitted and uncertain jobs retain identity without enabling cleanup', async t => {
  const f = await M.native(t); await I.reviewed(f); f.field('confirmation').checked = true; f.change(f.field('confirmation'));
  f.wire.enqueue('/job/start', () => Promise.reject(new TypeError('Lost import acknowledgment'))); f.click(f.action('confirm')); await F.settle();
  assert.equal(f.start.disabled, true); f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 0); assert.equal(f.field('job-reference').value, F.JOBREF); assert.match(f.host.textContent, /The request could not be confirmed\. Check the same import status before retrying\./);
});
test('MN06 genuine recovered durable job blocks cleanup even when paused not actively importing', async t => {
  const f = await M.native(t); await I.recover(f); assert.equal(f.start.disabled, true); f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 0);
  assert.equal(f.field('job-reference').value, F.JOBREF); assert.match(f.host.textContent, /Server-confirmed prefix: 2 of 4/);
});
test('MN07 genuine discovery loading disables cleanup then restores the same selected source', async t => {
  const f = await M.native(t), pending = F.deferred(); f.wire.enqueue('/job/list', () => pending.promise); f.click(f.action('refreshJobs'));
  assert.equal(f.start.disabled, true); f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 0);
  pending.resolve(F.response(F.envelope('foobar_account_job_list_v1', 'list', {unfinished: true, snapshot_kind: 'durable_page', busy: false, items: [], next_cursor: null}))); await F.settle();
  assert.equal(f.start.disabled, false); assert.equal(f.field('selected-source').value, F.SOURCE);
});
test('MN08 genuine import source switch retires pending cleanup publication and cursor', async t => {
  const f = await M.native(t), pending = F.deferred(); f.wire.enqueue('/maintenance', () => pending.promise); f.click(f.start);
  const source = F.source(); source.result.source_ref = F.OTHER; f.field('source-choice').value = F.OTHER; f.wire.enqueue('/ui/source', source); f.click(f.action('selectSource')); await F.settle();
  assert.equal(M.calls(f)[0].init.signal.aborted, true); assert.equal(f.status.textContent, ''); pending.resolve(F.response(M.payload({inspected: 20, removed_receipts: 20, next_cursor: M.cursor()}))); await F.settle();
  assert.equal(f.more.disabled, true); assert.equal(f.status.textContent, ''); await M.complete(f, M.payload({source_ref: F.OTHER})); assert.equal(M.body(M.calls(f)[1]).cursor, null);
});
test('MN09 genuine account marker mutation removes cleanup listeners and fences delayed acknowledgment', async t => {
  const f = await M.native(t), pending = F.deferred(); f.wire.enqueue('/maintenance', () => pending.promise); f.click(f.start);
  f.root.dataset.accountFoobarContext = 'b'.repeat(64); f.mutation(f.root, 'data-account-foobar-context');
  assert.equal(f.section.isConnected, false); assert.equal(f.start.listeners.length, 0); assert.equal(M.calls(f)[0].init.signal.aborted, true);
  pending.resolve(F.response(M.payload())); await F.settle(); assert.match(f.host.textContent, /account context changed/); assert.doesNotMatch(f.host.textContent, /This pass inspected/);
});
test('MN10 genuine policy invalidation and pagehide release maintenance with every existing listener', async t => {
  const f = await M.native(t); f.document.dispatchEvent(new f.c.Event('album-haven:policy-invalidated')); assert.equal(f.section.isConnected, false); assert.equal(f.start.listeners.length, 0); assert.equal(f.more.listeners.length, 0);
  f.start.dispatchEvent(new f.c.Event('click')); f.c.dispatchEvent(new f.c.Event('pagehide')); assert.equal(M.calls(f).length, 0); assert.equal(f.intervals.size, 0);
});
test('MN11 genuine silent currentness revocation is fenced immediately and idle check retires controls', async t => {
  const f = await M.native(t); f.current(false); f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 0);
  f.idleCheck(); assert.equal(f.section.isConnected, false); assert.match(f.host.textContent, /account context changed/);
});
test('MN12 genuine maintenance result preserves separate importer controls and never grants confirmation', async t => {
  const f = await M.native(t); f.field('confirmation').checked = false; await M.complete(f, M.payload({inspected: 20, removed_receipts: 10, protected_receipts: 10, removed_keys: 100}));
  assert.equal(f.action('confirm').disabled, true); assert.equal(f.field('confirmation').checked, false); assert.equal(f.action('savePersonal').disabled, true); assert.equal(f.field('selected-source').value, F.SOURCE);
  assert.deepEqual(f.wire.calls.map(call => call.route), ['/job/list', '/ui/source', '/maintenance']); assert.match(f.host.textContent, /Play counts and dates remain source observations/);
});
