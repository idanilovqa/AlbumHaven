'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./album-tops-source-import-task-fixtures/tasks.cjs');
const {F, INPUT, job, page, ready, drain} = H;
test.before(H.load);

for (const pending of ['feed', 'controller']) for (const nested of ['scope', 'configure']) {
  test(`synchronous ${pending} abort with nested ${nested} cannot overwrite or orphan its successor`, async t => {
    const h = await ready(t); let oldController, oldWork, oldRequest, oldGate;
    if (pending === 'feed') {
      oldGate = h.hold('list'); oldWork = h.tasks.refresh(); await drain(); oldRequest = h.last('list');
    } else {
      oldController = h.tasks.create(); oldWork = oldController.submit(INPUT); await drain(); oldRequest = h.last('submit');
    }
    const outerScope = `${F.SCOPE}:outer`, nestedScope = `${F.SCOPE}:nested`;
    let successor, successorWork, successorSource, callbackCount = 0;
    oldRequest.options.signal.addEventListener('abort', () => {
      callbackCount++;
      if (nested === 'scope') h.change({scopeKey: nestedScope});
      else h.tasks.configure(h.makeProviders());
      successor = h.tasks.create(); assert.ok(successor);
      successorSource = h.currentRegistration();
      successorWork = successor.submit(INPUT);
    }, {once: true});
    h.change({scopeKey: outerScope}); await drain();
    assert.equal(callbackCount, 1); assert.equal(oldRequest.options.signal.aborted, true);
    assert.equal(h.tasks.getSnapshot().scopeKey, nested === 'scope' ? nestedScope : outerScope);
    assert.equal(h.tasks.getSnapshot().retainedCount, 1); assert.equal(h.currentRegistration(), successorSource);
    assert.equal(h.registrations.filter(row => !row.disposed).length, 1);
    assert.equal(successorSource.options.isCurrent(), true); assert.equal(successor.getSnapshot().status, 'loading');
    const request = h.last('submit'); assert.notEqual(request, oldRequest);
    assert.equal(request.options.signal.aborted, false);
    assert.equal(request.options.scopeKey, nested === 'scope' ? nestedScope : outerScope);
    assert.equal(request.providerId, nested === 'configure' ? 1 : 0);
    if (nested === 'scope') assert.equal(h.requests.some(row => row.options.scopeKey === outerScope), false);
    if (oldController) assert.equal(oldController.getSnapshot().status, 'retired');
    if (oldGate) oldGate.resolve(page([H.summary()]));
    else oldRequest.resolve(job({request_key: oldRequest.body.request_key}));
    await oldWork; await drain();
    assert.equal(h.currentRegistration(), successorSource); assert.equal(h.tasks.getSnapshot().retainedCount, 1);
    assert.equal(successor.getSnapshot().status, 'loading'); assert.equal(request.options.signal.aborted, false);
    request.resolve(job({request_key: request.body.request_key})); assert.equal(await successorWork, true); await drain();
    assert.equal(successor.getSnapshot().job.job_ref, H.JOB); assert.equal(h.openings.length, 0);
    h.tasks.dispose(); assert.equal(successor.getSnapshot().status, 'retired');
    assert.ok(h.registrations.every(row => row.disposed), 'no nested source handle or controller is orphaned');
  });
}

test('a key callback that fills slot 32 makes the outer create fail without allocating slot 33', async t => {
  let h, armed = false, inner;
  h = await ready(t, {key(calls) {
    if (armed) {armed = false; inner = h.tasks.create();}
    return F.id(5000 + calls);
  }});
  const first = Array.from({length: 31}, () => h.tasks.create()); assert.ok(first.every(Boolean));
  const before = h.requests.length; armed = true;
  assert.equal(h.tasks.create(), null); assert.ok(inner); assert.equal(inner.getSnapshot().status, 'idle');
  assert.equal(h.tasks.getSnapshot().retainedCount, 32); assert.equal(h.tasks.getSnapshot().canCreate, false);
  assert.equal(h.keyCalls(), 33, '31 original keys plus outer and nested callbacks');
  assert.equal(h.requests.length, before); assert.ok(first.every(value => value.getSnapshot().status === 'idle'));
  assert.equal(h.tasks.create(), null); assert.equal(h.keyCalls(), 33, 'already-full guard runs before key allocation');
});

for (const revoke of ['logout', 'private-scope']) test(`authority is checked again after a key callback causes ${revoke}`, async t => {
  let h, armed = false;
  h = await ready(t, {key(calls) {
    if (armed) {armed = false; if (revoke === 'logout') h.change({authenticated: false}); else h.rejectScope();}
    return F.id(5000 + calls);
  }});
  const first = h.tasks.create(), before = h.requests.length; armed = true;
  assert.equal(h.tasks.create(), null); assert.equal(first.getSnapshot().status, 'retired');
  assert.equal(h.tasks.getSnapshot().retainedCount, 0); assert.equal(h.tasks.getSnapshot().canCreate, false);
  assert.equal(h.requests.length, before); assert.equal(h.cards().length, 0); assert.equal(h.calls('submit').length, 0);
});
