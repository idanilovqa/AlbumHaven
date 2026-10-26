'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('./foobar-maintenance-fixture.cjs'), {F} = M;
const withNodes = f => ({...f, ...f.nodes()});

test('MS01 registered Settings mounts the whole actual importer and maintenance through declared asset seam', async t => {
  const f = await M.settings(t), nodes = f.nodes(); assert.ok(f.mounted()); assert.equal(f.root.contains(f.overlay), false); assert.equal(nodes.start.disabled, false);
  assert.deepEqual(f.imports, ['maintenance%20fixture%20version']); assert.deepEqual(f.wire.calls.map(call => call.route), ['/job/list', '/ui/source']);
  assert.equal(f.host.querySelectorAll('.foobar-import').length, 1); assert.equal(M.calls(f).length, 0);
});
test('MS02 registered Settings explicit cleanup uses its genuine live fetch and session CSRF owner', async t => {
  const f = withNodes(await M.settings(t)); await M.complete(f, M.payload({inspected: 1, protected_receipts: 1}));
  assert.equal(M.calls(f).length, 1); assert.equal(new Headers(M.calls(f)[0].init.headers).get('X-Album-Haven-CSRF'), 'synthetic-maintenance-csrf');
  assert.deepEqual(M.body(M.calls(f)[0]), {version: M.VERSION, source_ref: F.SOURCE, cursor: null}); assert.match(f.status.textContent, /protected 1/);
});
test('MS03 registered Settings does not mount account controls without genuine capability input', async t => {
  const f = await M.settings(t, {allowed: false}); assert.equal(f.host, null); assert.equal(f.mounted(), undefined); assert.equal(f.imports.length, 0); assert.equal(f.wire.calls.length, 0); assert.match(f.detail.textContent, /unavailable/);
});
test('MS04 registered Settings close aborts pending cleanup removes owned nodes and fences late success', async t => {
  const f = withNodes(await M.settings(t)), pending = F.deferred(); f.wire.enqueue('/maintenance', () => pending.promise); f.click(f.start); f.close();
  assert.equal(M.calls(f)[0].init.signal.aborted, true); assert.equal(f.start.listeners.length, 0); assert.equal(f.section.isConnected, false); assert.equal(f.host.children.length, 0);
  pending.resolve(F.response(M.payload({inspected: 20, removed_receipts: 20}))); await F.settle(); assert.equal(f.host.textContent, ''); f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 1);
});
test('MS05 registered Settings tab switch fences cleanup before observer retirement', async t => {
  const f = withNodes(await M.settings(t)); f.c.state.utility.activeTab = 'rules'; f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 0);
  f.idleCheck(); assert.equal(f.section.isConnected, false); assert.doesNotMatch(f.host.textContent, /Clean expired metadata/);
});
test('MS06 registered Settings integration switch cannot lend Foobar cleanup to Lastfm', async t => {
  const f = withNodes(await M.settings(t)); f.c.state.utility.selectedIntegrationKey = 'lastfm'; f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 0);
  f.mutation(f.overlay, 'hidden'); assert.equal(f.section.isConnected, false); assert.doesNotMatch(f.host.textContent, /This pass inspected/);
});
test('MS07 registered Settings account mutation retires both Settings and component owners', async t => {
  const f = withNodes(await M.settings(t)); f.root.dataset.accountFoobarContext = 'b'.repeat(64); f.mutation(f.root, 'data-account-foobar-context');
  assert.equal(f.section.isConnected, false); assert.equal(f.mounted(), undefined); assert.equal(f.intervals.size, 0); assert.ok(f.observers.every(observer => !observer.active));
  f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 0);
});
test('MS08 registered Settings delayed asset completion cannot resurrect a closed dialog', async t => {
  const f = await M.settings(t, {deferAsset: true}); assert.equal(f.mounted(), null); assert.equal(f.wire.calls.length, 0); f.close(); await f.releaseAsset();
  assert.equal(f.host.children.length, 0); assert.equal(f.mounted(), undefined); assert.equal(f.wire.calls.length, 0);
});
test('MS09 registered Settings delayed asset completion cannot attach to a replacement same-id shell', async t => {
  const f = await M.settings(t, {deferAsset: true}); f.root.remove(); const replacement = f.document.createElement('main'); replacement.id = 'app-shell';
  Object.assign(replacement.dataset, {accountFoobarContext: F.STAMP, accountFoobarScope: F.SCOPE}); f.document.body.append(replacement); await f.releaseAsset();
  assert.equal(f.mounted(), undefined); assert.equal(f.wire.calls.length, 0); assert.match(f.host.textContent, /closed/);
});
test('MS10 registered Settings replacement utility state denies old cleanup even with same values', async t => {
  const f = withNodes(await M.settings(t)); f.c.state.utility = {...f.c.state.utility}; f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 0); f.idleCheck(); assert.equal(f.section.isConnected, false);
});
test('MS11 registered Settings deferred cleanup cannot steal focus moved outside its dialog', async t => {
  const f = withNodes(await M.settings(t)), pending = F.deferred(), outside = f.document.createElement('button'); outside.textContent = 'Outside'; f.document.body.append(outside);
  f.wire.enqueue('/maintenance', () => pending.promise); f.start.focus(); f.click(f.start); outside.focus(); pending.resolve(F.response(M.payload())); await F.settle(); assert.equal(f.document.activeElement, outside);
  assert.equal(f.status.getAttribute('role'), 'status'); assert.equal(f.status.getAttribute('aria-live'), 'polite'); assert.equal(f.start.type, 'button');
});
test('MS12 registered Settings session change releases cleanup and does not silently remount on restored page', async t => {
  const f = withNodes(await M.settings(t)); f.document.dispatchEvent(new f.c.Event('album-haven:session-changed')); assert.equal(f.section.isConnected, false);
  f.c.dispatchEvent(new f.c.Event('pageshow')); await F.settle(); assert.equal(f.imports.length, 1); assert.equal(M.calls(f).length, 0); assert.equal(f.mounted(), undefined);
});
