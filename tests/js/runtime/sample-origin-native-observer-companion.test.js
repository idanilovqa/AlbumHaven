'use strict';
// Ten additive tests against candidate-tree owners. No execution/collection was
// performed in this authoring packet. Image R4 settlement tests stay immutable.
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, deferred, observe, suspension, settlement, operation, dismissal} =
  require('./sample-origin-native-observer-companion-fixture.cjs');

for (const retired of [false, true]) for (const disposed of [false, true]) {
  test(`${retired ? 'retired' : 'suspended'} presentation preserves exact physical observer after ${disposed ? 'disposed' : 'live'} wrapper forced cleanup`, async t => {
    const h = await fixture(t), form = h.open(), lease = suspension(form, {retire: retired});
    const original = form.originalPromise, gate = h.hold();
    assert.equal(h.page(), null);
    assert.equal(form.promise.state, 'pending');
    const close = observe(form.dialog.close({force: true, restoreFocus: false, returnToParent: false}));
    if (disposed) form.dialog.dispose();
    await h.flush();
    assert.equal(h.retirements.length, 1);
    assert.equal(h.retirements[0].args[0], form.owner.token);
    assert.equal(h.retirements[0].args[1].returnToParent, false);
    assert.equal(h.owner('mobilePageState').pages.some(row => row.formToken === form.owner.token), false,
      'real retirement has already removed its descriptor before the completion gate');
    assert.equal(h.content().childNodes.length, 0, 'real owner cleared its exact form subtree');
    assert.equal(h.modal().hidden, true);
    assert.equal(form.physical.length, 0, 'DOM cleanup and logical dispose are not physical completion');
    assert.equal(form.logical.length, 0);
    assert.equal(close.state, 'pending'); assert.equal(form.promise.state, 'pending');
    assert.equal(form.native.suspendPresentation(), false, 'genuine pending finish cannot acquire presentation');
    assert.equal(form.native.promise, original);
    assert.equal(lease.restore(), false, 'finishing owner cannot reveal its old presentation');
    gate.resolve(); await h.flush();
    assert.equal(close.state, 'resolved'); assert.equal(close.value, true);
    assert.equal(form.promise.state, 'resolved'); assert.equal(form.promise.value, null);
    assert.equal(form.promise.settlements, 1); assert.equal(form.physical.length, 1);
    assert.equal(form.native.suspendPresentation(), false, 'closed owner cannot acquire presentation');
    settlement(form.physical[0], 'closed', true, false);
    assert.equal(form.childDisposals, 1); assert.equal(form.logical.length, disposed ? 0 : 1);
    assert.deepEqual(form.trace, disposed ? ['child-disposed', 'physical'] : ['child-disposed', 'logical', 'physical']);
    form.dialog.close(); form.dialog.dispose(); form.native.close(null, {force: true, restoreFocus: false});
    lease.retire(); assert.equal(lease.restore(), false); await h.flush();
    assert.equal(form.physical.length, 1); assert.equal(form.promise.settlements, 1);
    assert.equal(h.retirements.length, 1); assert.deepEqual(h.historyTraversals, []);
    assert.equal(form.mounts, 1); assert.equal(h.requests.length, 0);
  });
}

test('retired presentation scope loss does not suppress owed physical observer or restore obsolete focus', async t => {
  const h = await fixture(t), trigger = h.document.createElement('button');
  h.main.append(trigger); trigger.focus();
  const form = h.open(), lease = suspension(form, {retire: true}), gate = h.hold();
  let focusReturns = 0;
  const originalFocus = trigger.focus;
  trigger.focus = function (...args) {focusReturns++; return originalFocus.apply(this, args);};
  const close = observe(form.dialog.close({force: true, restoreFocus: true, returnToParent: false}));
  h.shell.dataset.nativeAccountId = '8'; h.runtime.sync(); form.dialog.dispose();
  await h.flush();
  assert.equal(form.owner.isCurrentContext(), false);
  assert.equal(form.promise.state, 'pending'); assert.equal(close.state, 'pending');
  assert.equal(form.physical.length, 0); assert.equal(lease.restore(), false);
  gate.resolve(); await h.flush();
  assert.equal(close.state, 'resolved'); assert.equal(close.value, false);
  assert.equal(form.promise.state, 'resolved'); assert.equal(form.promise.value, null);
  assert.equal(form.physical.length, 1); settlement(form.physical[0], 'closed', false, true);
  assert.equal(form.logical.length, 0); assert.equal(form.childDisposals, 1);
  assert.equal(focusReturns, 0); assert.equal(h.modal().hidden, true);
  assert.equal(lease.restore(), false);
  form.dialog.dispose(); form.native.close(null, {force: true, restoreFocus: false}); await h.flush();
  assert.equal(form.physical.length, 1); assert.equal(form.promise.settlements, 1);
  assert.equal(h.retirements.length, 1); assert.deepEqual(h.historyTraversals, []);
});

test('suspended admitted form still gives competing image wrapper exactly one genuine not-acquired observer', async t => {
  const h = await fixture(t), form = h.open(), lease = suspension(form);
  const element = form.dialog.element, input = form.input;
  let suppliedRejection = 0;
  const rejected = h.open({initial: {pageId: 'album-top-image', onAdmissionRejected() {suppliedRejection++;}}});
  await h.flush();
  assert.equal(rejected.dialog.failed, true); assert.equal(rejected.native, undefined);
  assert.equal(rejected.mounts, 0); assert.equal(rejected.errors.length, 1);
  assert.equal(rejected.errors[0].message, 'The form dialog is unavailable.');
  assert.equal(suppliedRejection, 0, 'caller cannot forge the wrapper physical proof');
  assert.deepEqual(rejected.trace, ['error', 'physical']);
  assert.equal(rejected.physical.length, 1); settlement(rejected.physical[0], 'not-acquired', false, false);
  rejected.dialog.close(); rejected.dialog.dispose(); await h.flush();
  assert.equal(rejected.physical.length, 1); assert.equal(h.retirements.length, 0);
  assert.equal(form.dialog.element, element); assert.equal(form.input, input);
  assert.equal(input.value, 'Retained native value'); assert.equal(form.promise.state, 'pending');
  assert.equal(form.owner.isActive(), true); assert.equal(h.page(), null);
  assert.equal(lease.restore(), true); assert.equal(h.page(), form.owner);
  assert.equal(form.mounts, 1); assert.equal(form.physical.length, 0);
});

for (const current of [true, false]) {
  test(`restored form preserves image dismissal operation ${current ? 'accepted' : 'return-stale'} outcome only after real retirement completion`, async t => {
    const h = await fixture(t), form = h.open({initial: {beforeDismiss: () => true}});
    const lease = suspension(form); assert.equal(lease.restore(), true);
    const op = operation(), outcomes = [], gate = h.hold();
    const result = observe(form.native.dismiss('replace', op.options(value => {
      outcomes.push(value);
      throw new Error('Observer failure must not replace native dismissal outcome');
    })));
    await h.flush();
    assert.equal(h.retirements.length, 1);
    assert.equal(h.owner('mobilePageState').pages.some(row => row.formToken === form.owner.token), false);
    assert.equal(form.promise.state, 'pending'); assert.equal(result.state, 'pending');
    assert.equal(form.physical.length, 0); assert.equal(outcomes.length, 0);
    assert.equal(form.native.suspendPresentation(), false, 'pending finish cannot resuspend');
    if (!current) op.retire();
    gate.resolve(); await h.flush();
    assert.equal(result.state, 'resolved'); assert.equal(result.value, current);
    assert.equal(outcomes.length, 1);
    dismissal(outcomes[0], form, op, current ? 'accepted' : 'superseded', current ? 'completed' : 'return-stale');
    assert.equal(form.promise.state, 'resolved'); assert.equal(form.promise.value, null);
    assert.equal(form.promise.settlements, 1);
    assert.equal(form.native.suspendPresentation(), false, 'closed owner cannot resuspend');
    if (current) {
      assert.equal(form.physical.length, 1); settlement(form.physical[0], 'closed', true, false);
      assert.equal(form.logical.length, 1); assert.equal(form.logical[0].current, true);
      assert.equal(form.childDisposals, 1);
      assert.deepEqual(form.trace, ['child-disposed', 'logical', 'physical']);
    } else {
      // R4 deliberately suppresses onAfterClose for a stale searchReplacement.
      // Do not weaken that return guard to manufacture a wrapper physical proof.
      assert.equal(form.physical.length, 0); assert.equal(form.logical.length, 0);
      assert.equal(form.childDisposals, 0); assert.deepEqual(form.trace, []);
    }
    form.dialog.close(); form.dialog.dispose(); gate.resolve(); await h.flush();
    assert.equal(outcomes.length, 1); assert.equal(form.physical.length, current ? 1 : 0);
    assert.equal(form.childDisposals, 1);
    assert.equal(form.promise.settlements, 1); assert.equal(h.retirements.length, 1);
    assert.deepEqual(h.historyTraversals, [], 'explicit no-parent return is never upgraded to history navigation');
    assert.equal(h.requests.length, 0);
  });
}

test('restored form stale dismissal intent during real beforeDismiss never fabricates physical settlement', async t => {
  const h = await fixture(t), decision = deferred(); let beforeCalls = 0;
  const form = h.open({initial: {beforeDismiss() {beforeCalls++; return decision.promise;}}});
  const lease = suspension(form); assert.equal(lease.restore(), true);
  const op = operation(), outcomes = [];
  const result = observe(form.native.dismiss('replace', op.options(value => outcomes.push(value))));
  await h.flush(); assert.equal(beforeCalls, 1); assert.equal(result.state, 'pending');
  op.retire(); decision.resolve(true); await h.flush();
  assert.equal(result.state, 'resolved'); assert.equal(result.value, false);
  assert.equal(outcomes.length, 1); dismissal(outcomes[0], form, op, 'superseded', 'stale-intent');
  assert.equal(h.retirements.length, 0); assert.equal(form.physical.length, 0);
  assert.equal(form.promise.state, 'pending'); assert.equal(form.logical.length, 0);
  assert.equal(form.owner.isActive(), true); assert.equal(h.page(), form.owner);
  assert.equal(form.input.value, 'Retained native value');
  await form.dialog.close({force: true, restoreFocus: false, returnToParent: false}); await h.flush();
  assert.equal(form.physical.length, 1); settlement(form.physical[0], 'closed', true, false);
  assert.equal(outcomes.length, 1, 'later owner cleanup cannot replay a terminal dismissal outcome');
  assert.equal(form.promise.settlements, 1); assert.equal(h.retirements.length, 1);
  assert.deepEqual(h.historyTraversals, []); assert.equal(h.requests.length, 0);
});

test('restored form rejects foreign image return operation before discard and preserves the original owner', async t => {
  const h = await fixture(t); let beforeCalls = 0;
  const form = h.open({initial: {beforeDismiss() {beforeCalls++; return true;}}});
  const lease = suspension(form); assert.equal(lease.restore(), true);
  const op = operation(), foreign = operation(), outcomes = [], options = op.options(value => outcomes.push(value));
  options.searchReplacement = {...options.searchReplacement, operation: foreign.identity};
  const result = observe(form.native.dismiss('replace', options)); await h.flush();
  assert.equal(result.state, 'resolved'); assert.equal(result.value, false);
  assert.equal(outcomes.length, 1); dismissal(outcomes[0], form, op, 'cancelled', 'blocked-return');
  assert.equal(beforeCalls, 0); assert.equal(h.retirements.length, 0);
  assert.equal(form.physical.length, 0); assert.equal(form.logical.length, 0);
  assert.equal(form.promise.state, 'pending'); assert.equal(form.owner.isActive(), true);
  assert.equal(h.page(), form.owner); assert.equal(form.input.value, 'Retained native value');
  await form.dialog.close({force: true, restoreFocus: false, returnToParent: false}); await h.flush();
  assert.equal(form.physical.length, 1); assert.equal(outcomes.length, 1);
  assert.equal(form.promise.settlements, 1); assert.equal(h.retirements.length, 1);
  assert.deepEqual(h.historyTraversals, []); assert.equal(h.requests.length, 0);
});
