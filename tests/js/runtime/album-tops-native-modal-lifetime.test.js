'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {nativeEnvironment} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const {actualChoiceEnvironment, settle} = require('./album-tops-native-fixtures/actual-choice-runtime.cjs');

const shellListeners = env => env.listeners().filter(row => row.target === env.modal());

test('actual native form leases retain one shared pointer-origin owner across close and reopen', async () => {
  const env = nativeEnvironment(), overlay = env.modal();
  const shell = shellListeners(env);
  assert.deepEqual(shell.map(row => row.type).sort(), ['click', 'pointercancel', 'pointerdown']);
  assert.equal(overlay.dataset.pointerOriginBound, '1');
  for (let cycle = 0; cycle < 2; cycle++) {
    const form = env.runtime.openForm({title: 'Native lifetime', onMount(host) {
      const input = env.document.createElement('input'); host.append(input);
    }});
    assert.equal(overlay.hidden, false);
    assert.ok(shellListeners(env).length > shell.length, 'The live native form acquires its own modal listeners');
    assert.throws(() => env.assertClean(), /native observers disconnected/);
    form.close(null, {force: true}); await form.promise; await settle();
    assert.equal(overlay.hidden, true);
    assert.deepEqual(shellListeners(env), shell, 'Closing releases only the form lease and retains exact shell listener identities');
    env.assertClean();
  }
});

test('native cleanup still detects an extra connected listener on the persistent modal shell', () => {
  const env = actualChoiceEnvironment(), overlay = env.modal(), listener = () => {};
  overlay.addEventListener('click', listener);
  assert.throws(() => env.assertClean(), /connected listeners restored/);
  overlay.removeEventListener('click', listener);
  env.assertClean();
});
