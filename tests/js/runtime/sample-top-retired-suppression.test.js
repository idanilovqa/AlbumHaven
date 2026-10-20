'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {A, detached, watchHidden, tapPresentation, flags, spent, freshSaved, freshChild} = require('./sample-top-lifecycle-fixture.cjs');
function suppression(h) {
  const snapshot = h.actual.sync();
  assert.equal(snapshot.sampleSuspended, true); assert.equal(snapshot.visible, false); assert.equal(h.topHost.hidden, true);
  assert.equal(h.actual.captureSampleOriginNavigation(), null, 'retired suppression is not new source admission');
}
function noFocusReturn(t, h) {
  const focus = h.opener.focus; let calls = 0;
  h.opener.focus = function (...args) {calls++; return focus.apply(this, args);};
  t.after(() => {h.opener.focus = focus;}); return () => assert.equal(calls, 0);
}
async function launched(t, callback) {
  const h = await detached(t, callback), captured = tapPresentation(t, h), original = flags(h.topHost);
  h.click(h.sourceButton()); await h.settle(); h.assertSetup(); assert.equal(captured.length, 1); assert.ok(captured[0].handle);
  const writes = watchHidden(t, h.topHost), noFocus = noFocusReturn(t, h); h.arm();
  return {h, captured, old: captured[0], original, writes, noFocus};
}

test('detached retirement never exposes its Top during actual physical callbacks or the pre-destination interval', async t => {
  const {h, captured, old, original, writes, noFocus} = await launched(t, (_stage, base) => suppression(base));
  let destinations = 0;
  assert.equal(await h.nav.deferCollectionDraftNavigation(() => {
    destinations++; assert.equal(h.nativeOwner.isActive(), false);
    assert.deepEqual(h.trace, ['onClose:before', 'onClose:after', 'onAfterClose:before', 'onAfterClose:after']);
    for (let n = 0; n < 3; n++) suppression(h);
    writes.concealed(); noFocus(); assert.deepEqual(h.history.traversals, []);
    // Only the already admitted external destination effect replaces this view.
    h.state.view = {context_ref: 'a'.repeat(64), surface: {active: 'albums'}};
    h.nav.writeLibraryHistory('/?surface=albums', {...h.c.history.state}, {mode: 'replace'}); return true;
  }), true);
  h.actual.sync(); h.runtime.sync(); await h.settle();
  assert.equal(destinations, 1); h.physicalClosed(); writes.concealed(); noFocus();
  assert.equal(h.topHost.hidden, true); assert.equal(h.topHost.inert, original.inert); assert.equal(h.topHost.getAttribute('aria-hidden'), original.aria);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); assert.deepEqual(h.history.traversals, []);
  const control = await freshSaved(h); assert.equal(h.actual.snapshot().sampleSuspended, false);
  await freshChild(h, captured, old, h.topHost, control); h.noWrites(h.svc, 1);
});

test('scope-lost failed restore keeps same-view retired Top suppressed after native disposal and arbitrary sync', async t => {
  const {h, captured, old, original, writes, noFocus} = await launched(t, (_stage, base) => suppression(base));
  const actor = h.shell.dataset.nativeAccountId, source = h.state.view;
  h.shell.dataset.nativeAccountId = '999';
  assert.equal(old.handle.restore(), false, 'actual failed restore, before normalizing sync or fallback retire');
  assert.equal(h.state.view, source); writes.concealed();
  assert.equal(h.topHost.inert, original.inert); assert.equal(h.topHost.getAttribute('aria-hidden'), original.aria);
  h.shell.dataset.nativeAccountId = actor;
  for (let n = 0; n < 3; n++) suppression(h);
  h.runtime.sync(); await h.settle(); h.physicalClosed({scopeLostReentry: true});
  for (let n = 0; n < 3; n++) suppression(h);
  writes.concealed(); noFocus(); spent(h, old, h.topHost);
  assert.equal(h.state.view, source); assert.deepEqual(h.history.traversals, []);
  const control = await freshSaved(h); assert.equal(h.actual.snapshot().sampleSuspended, false);
  await freshChild(h, captured, old, h.topHost, control); h.noWrites(h.svc, 1);
});

test('throwing physical completion cannot erase a real successor presentation acquired on a replaced Top host', async t => {
  const injected = new Error('controlled after-close observer failure'); let successor = null, newRoot = null;
  const {h, captured, old, writes, noFocus} = await launched(t, (stage, base) => {
    if (stage !== 'onAfterClose:after') {suppression(base); return;}
    // The actual native onAfterClose callback has already disposed its form.
    // A lawful shell host/view replacement supplies fresh inputs, not a private
    // suspension record or a fabricated typed source lease.
    base.topHost.remove(); newRoot = base.add('album-tops-root');
    base.state.view = {...base.sourceView, top_ref: A.T.OTHER};
    const admitted = base.actual.sync(); assert.equal(admitted.visible, true); assert.equal(admitted.sampleSuspended, false);
    assert.equal(base.actual.isCurrentSampleScope(admitted.scopeKey), true);
    const port = base.actual.captureSampleOriginNavigation(); assert.ok(port);
    successor = {port, handle: port.presentation.suspend()}; assert.ok(successor.handle);
    assert.equal(newRoot.hidden, true); assert.equal(base.actual.snapshot().sampleSuspended, true);
    // A genuine newer local presentation owner now exists. This factory grants
    // no controller/typed/read/Save authority; that separate admission follows below.
    throw injected;
  });
  assert.throws(() => old.handle.retire(), error => error === injected);
  await h.settle(); h.physicalClosed({expectedError: injected}); writes.concealed(); noFocus(); assert.ok(successor);
  assert.equal(h.document.getElementById('album-tops-root'), newRoot); assert.equal(newRoot.hidden, true);
  const before = flags(newRoot); spent(h, old, newRoot); assert.deepEqual(flags(newRoot), before);
  assert.equal(h.actual.snapshot().sampleSuspended, true, 'old finally did not clear or retire the successor');
  assert.equal(successor.handle.restore(), true); assert.equal(newRoot.hidden, false);
  h.runtime.sync(); await h.settle(); assert.equal(newRoot.hidden, false); assert.deepEqual(h.history.traversals, []);
  h.view.dispose(); const {mountAlbumTops} = await A.T.load('album-tops/index.mjs'); let view = null;
  t.after(() => view?.dispose());
  const control = await freshSaved(h, newRoot, host => {view = mountAlbumTops({host, runtime: h.actual, providers: h.svc.providers});});
  await freshChild(h, captured, old, newRoot, control); assert.equal(h.topHost.hidden, true); h.noWrites(h.svc, 1);
});
