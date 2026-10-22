'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const V = require('./album-tops-source-import-view-fixtures/view.cjs');
const {fixture, fill, button, click, settle} = V;
let mountSourceImportView;
test.before(async () => {await V.load(); ({mountSourceImportView} = await V.F.load('album-tops/source-import-view.mjs'));});

async function prepared(t, state = 'idle') {
  const h = await fixture(t, {opened: state === 'acknowledged'});
  if (state === 'pending') {
    fill(h, 'text', 'PRIVATE_PENDING_MOUNT_SOURCE'); click(button(h.host, 'Save source')); await settle();
    assert.equal(h.actual.getSubmittedSource().content, 'PRIVATE_PENDING_MOUNT_SOURCE');
  }
  h.view.dispose(); assert.equal(h.subscriptions.imported, 0); assert.equal(h.subscriptions.top, 0);
  const marker = h.document.createElement('p'); marker.textContent = 'Caller-owned content'; h.host.append(marker);
  return {h, marker};
}

// Transparent observations: the actual native renderers, document, controllers
// and subscriptions still execute. No alternate control or domain owner exists.
function observe(h, hooks = {}) {
  const counts = {nodes: 0, controls: 0, imported: 0, top: 0, projection: 0, snapshot: 0};
  const create = h.document.createElement, render = h.runtime.buttonHtml, action = h.runtime.actionHtml;
  const topSubscribe = h.topController.subscribe;
  h.document.createElement = function (...args) {counts.nodes++; return create.apply(this, args);};
  h.runtime.buttonHtml = function (...args) {counts.controls++; return render.apply(this, args);};
  h.runtime.actionHtml = function (...args) {counts.controls++; return action.apply(this, args);};
  h.topController.subscribe = function (...args) {counts.top++; return topSubscribe.apply(this, args);};
  const controller = Object.freeze({...h.controller,
    getSnapshot() {counts.snapshot++; const value = h.controller.getSnapshot(); hooks.snapshot?.(); return value;},
    getSubmittedSource() {counts.projection++; const value = h.controller.getSubmittedSource(); hooks.projection?.(); return value;},
    subscribe(...args) {counts.imported++; return h.controller.subscribe(...args);},
  });
  let restored = false;
  return {counts, props: {...h.props, controller, ...(hooks.isCurrent ? {isCurrent: hooks.isCurrent} : {})},
    restore() {
      if (restored) return; restored = true;
      h.document.createElement = create; h.runtime.buttonHtml = render; h.runtime.actionHtml = action;
      h.topController.subscribe = topSubscribe;
    },
  };
}
function quiet(h, observer, marker, before) {
  assert.deepEqual({nodes: observer.counts.nodes, controls: observer.counts.controls,
    imported: observer.counts.imported, top: observer.counts.top}, {nodes: 0, controls: 0, imported: 0, top: 0});
  assert.equal(h.host.childNodes.length, 1); assert.equal(h.host.firstChild, marker);
  assert.equal(marker.textContent, 'Caller-owned content'); assert.equal(h.subscriptions.imported, 0); assert.equal(h.subscriptions.top, 0);
  assert.equal(h.requests.length, before.requests); assert.equal(h.keyCalls(), before.keys);
  assert.equal(h.calls.importDispose, 0); assert.equal(h.calls.close, 0); assert.equal(h.calls.confirms.length, 0); V.noSave(h);
}
async function inert(owner) {
  assert.equal(Object.isFrozen(owner), true);
  for (const name of ['update', 'beforeDismiss', 'dispose']) assert.equal(typeof owner[name], 'function');
  owner.update(); owner.update(); const answer = owner.beforeDismiss(); assert.equal(typeof answer?.then, 'function');
  assert.equal(await answer, false); owner.dispose(); owner.dispose(); owner.update(); assert.equal(await owner.beforeDismiss(), false);
}
const totals = h => ({requests: h.requests.length, keys: h.keyCalls()});

for (const reason of ['stale view', 'retired controller']) for (const state of ['idle', 'pending', 'acknowledged']) {
  test(`initial ${reason} with ${state} state returns an inert owner without acquiring or exposing anything`, async t => {
    const {h, marker} = await prepared(t, state), request = state === 'pending' ? h.last('submit') : null;
    if (reason === 'stale view') h.live.view = false; else h.actual.dispose();
    const before = totals(h), observer = observe(h); let owner;
    try {
      assert.doesNotThrow(() => {owner = mountSourceImportView(h.host, h.runtime, observer.props);});
      await inert(owner); quiet(h, observer, marker, before);
      assert.equal(observer.counts.projection, 0, 'initial rejection never reads private intake');
      if (request) {
        assert.equal(request.options.signal.aborted, reason === 'retired controller');
        request.resolve(V.commandJob(request.body)); await settle(); owner.update();
        quiet(h, observer, marker, before);
        assert.equal(h.actual.getSnapshot().status, reason === 'retired controller' ? 'retired' : 'ready');
      }
    } finally {owner?.dispose(); observer.restore();}
  });
}

for (const boundary of ['currentness', 'snapshot', 'projection']) for (const reason of ['stale view', 'retired controller']) {
  test(`${reason} during actual ${boundary} admission callbacks is rechecked before construction`, async t => {
    const {h, marker} = await prepared(t, 'pending'), request = h.last('submit'); let changed = 0;
    const retire = () => {
      if (changed++) return;
      if (reason === 'stale view') h.live.view = false; else h.actual.dispose();
    };
    const hooks = boundary === 'currentness' ? {isCurrent() {const current = h.props.isCurrent(); retire(); return current;}}
      : {[boundary]: retire};
    const before = totals(h), observer = observe(h, hooks); let owner;
    try {
      assert.doesNotThrow(() => {owner = mountSourceImportView(h.host, h.runtime, observer.props);});
      assert.ok(changed > 0, 'the real admission callback was reached'); await inert(owner); quiet(h, observer, marker, before);
      assert.equal(request.options.signal.aborted, reason === 'retired controller');
      request.resolve(V.commandJob(request.body)); await settle(); owner.update(); quiet(h, observer, marker, before);
      assert.equal(h.actual.getSnapshot().status, reason === 'retired controller' ? 'retired' : 'ready');
    } finally {owner?.dispose(); observer.restore();}
  });
}

test('a rejected view stays inert after currentness returns and cannot dispose a later actual view on the same host', async t => {
  const {h, marker} = await prepared(t, 'pending'); h.live.view = false;
  const before = totals(h), observer = observe(h); let rejected, successor;
  try {
    rejected = mountSourceImportView(h.host, h.runtime, observer.props); quiet(h, observer, marker, before);
    h.live.view = true; await inert(rejected); quiet(h, observer, marker, before); observer.restore();
    successor = mountSourceImportView(h.host, h.runtime, h.props);
    const root = h.host.querySelector('[aria-label="Import Album Top"]'); assert.ok(root);
    assert.equal(V.field(h.host, 'Source content').value, 'PRIVATE_PENDING_MOUNT_SOURCE');
    assert.equal(V.field(h.host, 'Source content').disabled, true); assert.equal(h.subscriptions.imported, 1); assert.equal(h.subscriptions.top, 1);
    await inert(rejected); assert.equal(h.host.querySelector('[aria-label="Import Album Top"]'), root);
    assert.equal(marker.parentNode, h.host); assert.equal(h.subscriptions.imported, 1); assert.equal(h.subscriptions.top, 1);
    const request = h.last('submit'); assert.equal(request.options.signal.aborted, false);
    request.resolve(V.commandJob(request.body)); await settle();
    assert.equal(h.actual.getSnapshot().status, 'ready'); assert.equal(h.host.querySelector('[aria-label="Source evidence"]').hidden, false);
    assert.equal(h.count('submit'), 1); assert.equal(h.keyCalls(), 1); assert.equal(h.calls.importDispose, 0); V.noSave(h);
  } finally {rejected?.dispose(); successor?.dispose(); observer.restore();}
});

test('current admission still mounts real native controls and subscriptions and releases only its own surface', async t => {
  const {h, marker} = await prepared(t), observer = observe(h); let owner;
  try {
    owner = mountSourceImportView(h.host, h.runtime, observer.props);
    assert.ok(observer.counts.nodes > 0); assert.ok(observer.counts.controls > 0);
    assert.equal(observer.counts.imported, 1); assert.equal(observer.counts.top, 1);
    assert.equal(h.subscriptions.imported, 1); assert.equal(h.subscriptions.top, 1); assert.equal(await owner.beforeDismiss(), true);
    fill(h, 'text', 'Current admission source'); click(button(h.host, 'Save source')); await settle();
    const request = h.last('submit'); request.resolve(V.commandJob(request.body)); await settle();
    assert.equal(h.actual.getSnapshot().job.source.content, 'Current admission source'); assert.equal(h.count('submit'), 1);
    owner.dispose(); owner.dispose(); owner.update(); assert.equal(await owner.beforeDismiss(), false);
    assert.equal(h.host.childNodes.length, 1); assert.equal(h.host.firstChild, marker);
    assert.equal(h.subscriptions.imported, 0); assert.equal(h.subscriptions.top, 0); assert.equal(h.calls.importDispose, 0); V.noSave(h);
  } finally {owner?.dispose(); observer.restore();}
});

for (const boundary of ['currentness', 'projection']) test(`genuine ${boundary} callback errors are not swallowed as retirement`, async t => {
  const {h, marker} = await prepared(t), failure = new Error('Deliberate admission callback failure');
  const hooks = boundary === 'currentness' ? {isCurrent() {throw failure;}} : {projection() {throw failure;}};
  const before = totals(h), observer = observe(h, hooks);
  try {
    assert.throws(() => mountSourceImportView(h.host, h.runtime, observer.props), error => error === failure);
    quiet(h, observer, marker, before);
  } finally {observer.restore();}
});
