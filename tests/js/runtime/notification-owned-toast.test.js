'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {createNativeHomeRuntime, readRepo} = require('./account-goals-dom-platform.cjs');
const {withDomPlatform} = require('./artist-host-fixtures/dom-platform.cjs');

// Actual notification, scheduling and canonical alert helpers run unchanged.
// Only DOM geometry, browser queues and observer delivery are platform fixtures.
function fixture(t, {geometry = false, synchronousFrames = false, synchronousTimers = false, layer = true} = {}) {
  const env = withDomPlatform(createNativeHomeRuntime()), {context: c, document} = env;
  const frames = new Map(), timers = new Map(), scheduled = [], cancelled = [], observers = [];
  const owners = [], blockers = []; let sequence = 0;
  const enqueue = (kind, callback, delay) => {
    const record = {id:++sequence, kind, callback, delay}; scheduled.push(record);
    (kind === 'frame' ? frames : timers).set(record.id, record); return record.id;
  };
  const cancel = (kind, id) => {cancelled.push({kind, id}); (kind === 'frame' ? frames : timers).delete(id);};
  if (synchronousFrames) {delete c.requestAnimationFrame; delete c.cancelAnimationFrame;}
  else {c.requestAnimationFrame = callback => enqueue('frame', callback); c.cancelAnimationFrame = id => cancel('frame', id);}
  if (synchronousTimers) {delete c.setTimeout; delete c.clearTimeout;}
  else {c.setTimeout = (callback, delay) => enqueue('timer', callback, delay); c.clearTimeout = id => cancel('timer', id);}
  document.defaultView = c; c.innerWidth = 1024; c.innerHeight = 768;
  c.addEventListener = document.addEventListener.bind(document); c.removeEventListener = document.removeEventListener.bind(document);
  const proto = c.Element.prototype, matches = proto.matches;
  proto.matches = function(selector) {return selector === ':disabled' ? this.disabled : matches.call(this, selector);};
  Object.defineProperty(proto, 'offsetWidth', {configurable:true, get() {return this.classList.contains('toast') ? 280 : this.getBoundingClientRect().width;}});
  Object.defineProperty(proto, 'offsetHeight', {configurable:true, get() {return this.classList.contains('toast') ? 64 : this.getBoundingClientRect().height;}});
  c.getComputedStyle = node => ({visibility:node.hidden ? 'hidden' : 'visible', opacity:'1',
    getPropertyValue:key => node.style.getPropertyValue(key), paddingLeft:'0px', paddingRight:'0px', borderLeftWidth:'0px', borderRightWidth:'0px'});
  const observer = kind => class {
    constructor(callback) {this.kind = kind; this.callback = callback; this.observed = new Set(); this.unobserved = []; this.disconnects = 0; observers.push(this);}
    observe(node) {this.observed.add(node);}
    unobserve(node) {this.unobserved.push(node); this.observed.delete(node);}
    disconnect() {this.disconnects++; this.observed.clear();}
  };
  c.MutationObserver = observer('mutation'); c.ResizeObserver = observer('resize');
  if (geometry) document.elementsFromPoint = (x, y) => [...blockers].reverse().filter(node => {
    const rect = node.getBoundingClientRect();
    return node.isConnected && !node.hidden && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }).concat(document.body);
  const layerNode = document.createElement('div'); layerNode.id = 'toast-layer'; if (layer) document.body.append(layerNode);
  assert.equal(vm.runInContext('window === globalThis', c), true, 'browser APIs and globals share one actual VM global');
  vm.runInContext(readRepo('music_app/static/js/runtime/alert-components.js'), c, {filename:'alert-components.js'});
  vm.runInContext(readRepo('music_app/static/js/runtime/browser-scheduling-helpers.js'), c, {filename:'browser-scheduling-helpers.js'});
  vm.runInContext(readRepo('music_app/static/js/runtime/notification-ui-helpers.js'), c, {filename:'notification-ui-helpers.js'});
  assert.equal(typeof c.buildOnPageAlertHtml, 'function', 'the actual canonical alert renderer is loaded explicitly');
  const run = record => {
    assert.ok(record, 'the requested browser callback is pending');
    const queue = record.kind === 'frame' ? frames : timers;
    assert.equal(queue.has(record.id), true, 'only a live scheduled callback is advanced');
    queue.delete(record.id); record.callback(); return record;
  };
  const show = (...args) => {const owner = c.showToast(...args); if (owner) owners.push(owner); return owner;};
  const baselineListeners = env.listeners().length;
  t.after(() => {for (const owner of owners.reverse()) owner.dispose();});
  return {...env, c, document, layer:layerNode, frames, timers, scheduled, cancelled, observers, show, run, baselineListeners,
    frame:() => run(frames.values().next().value),
    timer:delay => run([...timers.values()].find(record => Object.is(record.delay, delay))),
    read:expression => vm.runInContext(expression, c),
    blocker(rect) {const node = document.createElement('button'); node.textContent = 'Save'; document.body.append(node); env.setRect(node, rect); blockers.push(node); return node;},
    resize() {for (const item of observers.filter(item => item.kind === 'resize' && !item.disconnects)) item.callback();},
  };
}
const owned = owner => {assert.ok(owner); assert.equal(Object.isFrozen(owner), true); assert.deepEqual(Object.keys(owner), ['dispose']); assert.equal(typeof owner.dispose, 'function');};
const noPending = h => {assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);};
const stale = records => {for (const record of records) record.callback();};

for (const [variant, role] of [['info', 'status'], ['success', 'status'], ['error', 'alert']]) test(`Owned ${variant} toast uses the actual canonical ${role} alert`, t => {
  const h = fixture(t), owner = h.show('Completed 3/5 <albums>', variant, 1250, {placement:'top-center'}); owned(owner);
  const node = h.layer.firstElementChild, alert = node.querySelector('.on-page-alert'); assert.ok(alert);
  assert.equal(alert.getAttribute('role'), role); assert.match(node.textContent, /Completed 3\/5 <albums>/);
  assert.equal(node.querySelector('albums'), null); assert.equal(node.classList.contains('is-top-center'), true);
  assert.equal(node.classList.contains('is-visible'), false); h.frame(); assert.equal(node.classList.contains('is-visible'), true);
  assert.equal([...h.timers.values()][0].delay, 1250); owner.dispose(); assert.equal(node.isConnected, false); noPending(h);
});

test('Missing layer returns null without creating an owner or scheduling browser callbacks', t => {
  const h = fixture(t, {layer:false}); assert.equal(h.show('No layer', 'info'), null);
  assert.equal(h.document.querySelector('.toast'), null); assert.equal(h.scheduled.length, 0); noPending(h);
});

for (const phase of ['before-show', 'before-hide', 'before-removal']) test(`Disposal ${phase} cancels only its queued work and stale callbacks cannot revive the toast`, t => {
  const h = fixture(t), owner = h.show('Owned notice', 'info', 900), node = h.layer.firstElementChild; owned(owner);
  if (phase !== 'before-show') h.frame();
  if (phase === 'before-removal') h.timer(900);
  const pending = [...h.frames.values(), ...h.timers.values()]; assert.ok(pending.length);
  owner.dispose(); const classAfterDispose = node.className; owner.dispose();
  assert.equal(node.isConnected, false); assert.equal(h.layer.children.length, 0); noPending(h);
  for (const record of pending) assert.ok(h.cancelled.some(item => item.id === record.id && item.kind === record.kind));
  stale(pending); assert.equal(node.className, classAfterDispose); assert.equal(node.isConnected, false); noPending(h);
});

test('Disposal before floating placement cancels placement and disconnects the real placement owner', t => {
  const h = fixture(t, {geometry:true}), owner = h.show('Pending placement', 'info', 900), node = h.layer.firstElementChild;
  assert.equal(h.read('floatingNotifications.size'), 1); assert.equal(node.hasAttribute('data-notification-deferred'), true);
  assert.equal(h.frames.size, 1); assert.equal(h.timers.size, 0); const placement = [...h.frames.values()];
  owner.dispose(); noPending(h); assert.equal(h.read('floatingNotifications.size'), 0); assert.equal(h.read('floatingNotificationCleanup'), null);
  assert.equal(h.observers.length, 2); assert.equal(h.observers.every(item => item.disconnects === 1), true);
  assert.equal(h.observers.find(item => item.kind === 'resize').unobserved.includes(node), true);
  assert.equal(h.listeners().length, h.baselineListeners); stale(placement); noPending(h); assert.equal(h.layer.children.length, 0);
});

test('Duration begins only after real clear-rectangle placement, and disposal works while placement is deferred', t => {
  const h = fixture(t, {geometry:true}); const blocker = h.blocker({x:0, y:0, width:1024, height:768});
  const owner = h.show('Deferred count', 'info', 700), node = h.layer.firstElementChild; h.frame();
  assert.equal(node.hasAttribute('data-notification-deferred'), true); assert.equal(h.timers.size, 0); assert.equal(node.classList.contains('is-visible'), false);
  blocker.hidden = true; h.resize(); h.frame(); assert.equal(node.hasAttribute('data-notification-deferred'), false);
  assert.equal([...h.timers.values()].filter(record => record.delay === 700).length, 1); h.frame();
  h.resize(); h.frame(); assert.equal(h.scheduled.filter(record => record.kind === 'timer' && record.delay === 700).length, 1, 'repositioning cannot restart duration');
  owner.dispose(); noPending(h); assert.equal(h.read('floatingNotifications.size'), 0);
  blocker.hidden = false; const deferredOwner = h.show('Still blocked', 'info', 700); h.frame();
  assert.equal(h.timers.size, 0); deferredOwner.dispose(); noPending(h); assert.equal(h.read('floatingNotifications.size'), 0);
});

test('Natural hide and removal release geometry observers and clear their own error-map entry', t => {
  const h = fixture(t, {geometry:true}), owner = h.show('Natural failure', 'error', 1100), node = h.layer.firstElementChild;
  h.frame(); h.frame(); assert.equal(node.classList.contains('is-visible'), true); assert.equal(h.read('activeErrorToasts.size'), 1);
  h.timer(1100); assert.equal(node.classList.contains('is-visible'), false); assert.equal(node.isConnected, true);
  assert.equal([...h.timers.values()][0].delay, 260); h.timer(260); noPending(h);
  assert.equal(node.isConnected, false); assert.equal(h.read('activeErrorToasts.size'), 0); assert.equal(h.read('floatingNotifications.size'), 0);
  assert.equal(h.observers.every(item => item.disconnects === 1), true); assert.equal(h.listeners().length, h.baselineListeners);
  owner.dispose(); noPending(h);
});

test('Actual placement avoids an interactive obstacle and disposing one toast retains the other placement owner', t => {
  const h = fixture(t, {geometry:true}); const obstacle = h.blocker({x:800, y:8, width:210, height:88});
  const first = h.show('First notice', 'info', 800), firstNode = h.layer.firstElementChild;
  const second = h.show('Second notice', 'success', 1200), secondNode = h.layer.lastElementChild;
  h.frame(); const left = parseFloat(firstNode.style.getPropertyValue('--notification-left')), top = parseFloat(firstNode.style.getPropertyValue('--notification-top'));
  const rect = obstacle.getBoundingClientRect(); assert.ok(Number.isFinite(left) && Number.isFinite(top));
  assert.ok(left + firstNode.offsetWidth <= rect.left - 8 || left >= rect.right + 8 || top + firstNode.offsetHeight <= rect.top - 8 || top >= rect.bottom + 8);
  assert.equal(h.read('floatingNotifications.size'), 2); first.dispose(); assert.equal(firstNode.isConnected, false); assert.equal(secondNode.isConnected, true);
  assert.equal(h.read('floatingNotifications.size'), 1); assert.equal(h.observers.every(item => item.disconnects === 0), true);
  second.dispose(); assert.equal(h.read('floatingNotifications.size'), 0); assert.equal(h.observers.every(item => item.disconnects === 1), true); noPending(h);
});

test('Deduplicated errors return null and cannot acquire another caller’s toast ownership', t => {
  const h = fixture(t), first = h.show('Private failure', 'error', 1300, {errorKey:'shared-operation'}), node = h.layer.firstElementChild;
  const count = h.scheduled.length, duplicate = h.show('Different display text', 'error', 2, {errorKey:'shared-operation'});
  assert.equal(duplicate, null); assert.equal(h.scheduled.length, count); assert.equal(h.layer.children.length, 1); assert.equal(h.layer.firstElementChild, node);
  first.dispose(); assert.equal(h.read('activeErrorToasts.size'), 0); const next = h.show('New failure', 'error', 1300, {errorKey:'shared-operation'}); owned(next);
  assert.notEqual(h.layer.firstElementChild, node); next.dispose(); noPending(h);
});

test('An older error owner never deletes a replacement error node or its deduplication map entry', t => {
  const h = fixture(t), first = h.show('Old failure', 'error', 1000, {errorKey:'one-key'}), oldNode = h.layer.firstElementChild;
  const oldCallbacks = [...h.frames.values(), ...h.timers.values()]; oldNode.remove();
  const replacement = h.show('Replacement failure', 'error', 2000, {errorKey:'one-key'}), newNode = h.layer.firstElementChild;
  assert.notEqual(oldNode, newNode); first.dispose(); stale(oldCallbacks);
  assert.equal(newNode.isConnected, true); assert.equal(h.layer.children.length, 1); assert.equal(h.read('activeErrorToasts.size'), 1);
  assert.equal(h.show('Duplicate replacement', 'error', 1, {errorKey:'one-key'}), null);
  replacement.dispose(); assert.equal(h.read('activeErrorToasts.size'), 0); noPending(h);
});

for (const retirement of ['detached-layer', 'moved-node', 'removed-node']) test(`A ${retirement} cannot be shown by delayed callbacks`, t => {
  const h = fixture(t), owner = h.show('Retired context', 'error', 1000), node = h.layer.firstElementChild;
  const callbacks = [...h.frames.values(), ...h.timers.values()];
  if (retirement === 'detached-layer') h.layer.remove(); else if (retirement === 'moved-node') h.document.body.append(node); else node.remove();
  h.frame(); assert.equal(node.isConnected, false); assert.equal(node.classList.contains('is-visible'), false); assert.equal(h.read('activeErrorToasts.size'), 0); noPending(h);
  stale(callbacks); owner.dispose(); noPending(h); assert.equal(node.isConnected, false);
});

test('Hide before the show frame cancels that frame and stale delivery cannot make a fading toast visible', t => {
  const h = fixture(t), owner = h.show('Short notice', 'info', 0), node = h.layer.firstElementChild;
  const showFrame = [...h.frames.values()][0]; h.timer(0); assert.equal(h.frames.size, 0); assert.equal(node.classList.contains('is-visible'), false);
  showFrame.callback(); assert.equal(node.classList.contains('is-visible'), false); h.timer(260); owner.dispose(); noPending(h);
});

for (const duration of [0, null, -1, NaN, Infinity, 17]) test(`Legacy explicit duration ${String(duration)} is passed unchanged to the browser scheduler`, t => {
  const h = fixture(t), owner = h.show('Duration', 'info', duration); assert.equal(h.timers.size, 1);
  assert.equal(Object.is([...h.timers.values()][0].delay, duration), true); owner.dispose(); noPending(h);
});

test('Default duration remains 3600 with a separate 260 removal delay', t => {
  const h = fixture(t), owner = h.show('Default duration'); assert.equal([...h.timers.values()][0].delay, 3600);
  h.frame(); h.timer(3600); assert.equal([...h.timers.values()][0].delay, 260); h.timer(260); owner.dispose(); noPending(h);
});

for (const [synchronousFrames, synchronousTimers] of [[true, true], [true, false], [false, true]]) test(`Actual scheduling fallback handles synchronous frames=${synchronousFrames}, timers=${synchronousTimers}`, t => {
  const h = fixture(t, {synchronousFrames, synchronousTimers}), owner = h.show('Fallback notice', 'error', 1500); owned(owner);
  if (synchronousTimers) {assert.equal(h.layer.children.length, 0); assert.equal(h.read('activeErrorToasts.size'), 0); noPending(h);}
  else {assert.equal(h.layer.firstElementChild.classList.contains('is-visible'), true); assert.equal(h.timers.size, 1);}
  owner.dispose(); owner.dispose(); noPending(h); assert.equal(h.layer.children.length, 0);
  const next = h.show('Fallback notice', 'error', 1500); owned(next); next.dispose(); noPending(h);
});


test('Disconnected pending geometry placement retires the owned error before a replacement layer reuses its key', t => {
  const h = fixture(t, {geometry:true}), owner = h.show('Old private failure', 'error', 1000, {errorKey:'retired-layer'});
  const node = h.layer.firstElementChild; assert.equal(h.timers.size, 0); assert.equal(h.read('activeErrorToasts.size'), 1);
  h.layer.remove(); h.frame();
  assert.equal(node.parentElement, null); assert.equal(h.read('activeErrorToasts.size'), 0);
  assert.equal(h.read('floatingNotifications.size'), 0); noPending(h);
  const nextLayer = h.document.createElement('div'); nextLayer.id = 'toast-layer'; h.document.body.append(nextLayer);
  const next = h.show('Current failure', 'error', 1000, {errorKey:'retired-layer'}); owned(next);
  assert.equal(nextLayer.children.length, 1); owner.dispose(); assert.equal(nextLayer.children.length, 1);
  next.dispose(); noPending(h); assert.equal(h.read('activeErrorToasts.size'), 0);
});
