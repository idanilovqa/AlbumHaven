'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {nativeEnvironment, nextTask} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');

test('actual modal pointer origin resets after synchronous click dispatch on the next task', async () => {
  const env = nativeEnvironment(), overlay = env.modal();
  env.owner('bindOverlayPointerOrigin')(overlay);
  let duringClick;
  overlay.addEventListener('click', () => {duringClick = overlay.dataset.pointerDownStartedOnOverlay;}, {once: true});
  overlay.dispatchEvent(new env.context.Event('pointerdown'));
  assert.equal(overlay.dataset.pointerDownStartedOnOverlay, '1');
  overlay.dispatchEvent(new env.context.Event('click'));
  assert.equal(duringClick, '1');
  assert.equal(overlay.dataset.pointerDownStartedOnOverlay, '1', 'Reset cannot run inside the triggering dispatch');
  assert.equal(env.frames.size, 0, 'Modal timeout is not a Gallery frame');
  assert.equal(env.timers.size, 1);
  await nextTask();
  assert.equal(overlay.dataset.pointerDownStartedOnOverlay, '0');
  assert.equal(env.timers.size, 0);
  env.assertClean();
});

test('both real modal shells retain their idempotent pointer owners across native confirmations', async () => {
  const env = nativeEnvironment(), confirm = env.document.getElementById('app-confirm-modal');
  for (const modal of [env.modal(), confirm]) {
    const baseline = env.listeners().filter(row => row.target === modal);
    assert.deepEqual(baseline.map(row => row.type).sort(), ['click', 'pointercancel', 'pointerdown']);
    env.owner('bindOverlayPointerOrigin')(modal);
    assert.deepEqual(env.listeners().filter(row => row.target === modal), baseline);
  }
  for (const accepted of [true, false]) {
    const result = env.runtime.confirm('Continue?');
    assert.equal(confirm.hidden, false);
    env.click(env.document.getElementById(accepted ? 'app-confirm-accept' : 'app-confirm-cancel'));
    assert.equal(await result, accepted);
    assert.equal(confirm.hidden, true);
    assert.equal(env.timers.size, 1, 'The shell click reset remains pending through microtasks');
    assert.throws(() => env.assertClean(), /native scheduled timers completed or cancelled/);
    await nextTask(); env.assertClean();
  }
  const leaked = () => {};
  confirm.addEventListener('click', leaked);
  await nextTask();
  assert.throws(() => env.assertClean(), /connected listeners restored/);
  confirm.removeEventListener('click', leaked); env.assertClean();
});

test('timer cancellation and pending animation frames remain independently observable', async () => {
  const env = nativeEnvironment(); let called = 0;
  const zero = env.context.scheduleBrowserTimeout(() => {called++;}, 0);
  const later = env.context.scheduleBrowserTimeout(() => {called++;}, 260);
  const frame = env.context.requestAnimationFrame(() => {called++;});
  env.context.clearBrowserTimeout(zero);
  await nextTask();
  assert.equal(called, 0, 'Cancelling a zero task and waiting one turn does not run delayed work');
  assert.equal(env.timers.size, 1); assert.equal(env.frames.size, 1);
  assert.throws(() => env.assertClean(), /native scheduled frames cancelled/);
  env.context.cancelAnimationFrame(frame);
  assert.throws(() => env.assertClean(), /native scheduled timers completed or cancelled/);
  env.context.clearBrowserTimeout(later); env.context.clearBrowserTimeout(later);
  env.assertClean();
});
