'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const V = require('./album-tops-source-import-view-fixtures/view.cjs');
const {fixture, fill, button, click, settle} = V;
let mountSourceImportView;
test.before(async () => {await V.load(); ({mountSourceImportView} = await V.F.load('album-tops/source-import-view.mjs'));});

test('late final-snapshot view retirement cannot acquire any source-view surface', async t => {
  const h = await fixture(t); fill(h, 'text', 'PRIVATE_LATE_ADMISSION_SOURCE');
  click(button(h.host, 'Save source')); await settle(); const request = h.last('submit');
  assert.equal(h.actual.getSubmittedSource().content, 'PRIVATE_LATE_ADMISSION_SOURCE');
  h.view.dispose(); assert.equal(h.subscriptions.imported, 0); assert.equal(h.subscriptions.top, 0);
  const marker = h.document.createElement('p'); marker.textContent = 'Caller-owned content'; h.host.append(marker);
  const counts = {nodes: 0, controls: 0, imported: 0, top: 0};
  const create = h.document.createElement, render = h.runtime.buttonHtml, action = h.runtime.actionHtml;
  const topSubscribe = h.topController.subscribe;
  h.document.createElement = function (...args) {counts.nodes++; return create.apply(this, args);};
  h.runtime.buttonHtml = function (...args) {counts.controls++; return render.apply(this, args);};
  h.runtime.actionHtml = function (...args) {counts.controls++; return action.apply(this, args);};
  h.topController.subscribe = function (...args) {counts.top++; return topSubscribe.apply(this, args);};
  let reads = 0, projectionAt = null, boundary = null, owner;
  const controller = Object.freeze({...h.controller,
    getSubmittedSource() {const value = h.controller.getSubmittedSource(); projectionAt = reads; return value;},
    getSnapshot() {
      const value = h.controller.getSnapshot(); reads++;
      // This is R1's validated last admission observation: the fourth snapshot,
      // second after projection. It is a known owner callback boundary, not a
      // general API guarantee that every implementation must read four times.
      if (reads === 4) {
        boundary = {reads, afterProjection: projectionAt === null ? null : reads - projectionAt,
          status: value.status, operation: value.operation, ...counts};
        h.live.view = false;
      }
      return value; // Return the exact captured actual snapshot, never a substitute.
    },
    subscribe(...args) {counts.imported++; return h.controller.subscribe(...args);},
  });
  const quiet = () => {
    assert.deepEqual(counts, {nodes: 0, controls: 0, imported: 0, top: 0});
    assert.equal(h.host.childNodes.length, 1); assert.equal(h.host.firstChild, marker);
    assert.equal(marker.textContent, 'Caller-owned content'); assert.equal(h.subscriptions.imported, 0); assert.equal(h.subscriptions.top, 0);
    assert.equal(h.requests.length, 1); assert.equal(h.count('submit'), 1); assert.equal(h.keyCalls(), 1);
    assert.equal(h.calls.importDispose, 0); assert.equal(h.calls.close, 0); assert.equal(h.calls.confirms.length, 0); V.noSave(h);
  };
  try {
    assert.doesNotThrow(() => {owner = mountSourceImportView(h.host, h.runtime, {...h.props, controller});});
    assert.deepEqual(boundary, {reads: 4, afterProjection: 2, status: 'loading', operation: 'submit',
      nodes: 0, controls: 0, imported: 0, top: 0}, 'the otherwise-current final pre-DOM read must actually be reached');
    assert.equal(Object.isFrozen(owner), true); quiet();
    owner.update(); owner.update(); const answer = owner.beforeDismiss(); assert.equal(typeof answer?.then, 'function');
    assert.equal(await answer, false); owner.dispose(); owner.dispose(); owner.update(); assert.equal(await owner.beforeDismiss(), false);
    quiet(); assert.equal(request.options.signal.aborted, false);
    request.resolve(V.commandJob(request.body)); await settle(); owner.update(); quiet();
    assert.equal(h.actual.getSnapshot().status, 'ready');
    assert.equal(h.host.textContent.includes('PRIVATE_LATE_ADMISSION_SOURCE'), false);
  } finally {
    owner?.dispose(); h.document.createElement = create; h.runtime.buttonHtml = render; h.runtime.actionHtml = action;
    h.topController.subscribe = topSubscribe;
  }
});
