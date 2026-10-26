'use strict';
// Ordinary browser defaults from the complete served owners. This isolated realm
// has no transport, timers, AudioContext, WebSocket or process capability. It does
// not run bootstrap-init.js (which schedules real application startup work).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function ordinaryNativeState(runtimeRoot) {
  const owner = vm.createContext({URL, window: {location: new URL('https://albumhaven.test/')},
    document: {querySelector: () => null}});
  for (const file of ['bootstrap-state.js', 'response-state-helpers.js', 'core-state-and-helpers.js']) {
    const filename = path.join(runtimeRoot, file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), owner, {filename});
  }
  const state = vm.runInContext('state', owner);
  assert.equal(state.modalReleases.length, 0); assert.equal(state.modalReleaseIndex, 0);
  assert.equal(state.player.streaming.mode, 'stopped');
  for (const key of ['context', 'node', 'socket', 'preparePromise', 'stopPromise'])
    assert.equal(state.player.streaming[key], null);
  assert.equal(state.player.streaming.roles.current, null); assert.equal(state.player.streaming.roles.continuity, null);
  return state;
}
function loadNativeResponseState(context, runtimeRoot) {
  const filename = path.join(runtimeRoot, 'response-state-helpers.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, {filename});
  assert.equal(typeof context.captureRuntimeAlbumPreferenceScope, 'function');
  return Object.freeze({captureScope: context.captureRuntimeAlbumPreferenceScope,
    applyViewPayload: context.applyViewPayload});
}
module.exports = {ordinaryNativeState, loadNativeResponseState};
