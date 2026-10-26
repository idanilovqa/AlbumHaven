'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {id, TOP, ALBUM, deferred, drain, detail, permissions, service, preparedController,
  nativeEnvironment, connectedView, nextTask} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;
const selector = '[data-gallery-card-intent="complete"]';
function projection(completed = false, patch = {}) {
  return detail({items: [{item_ref: id(21), album_ref: ALBUM, title: 'Actual album', artist: 'Artist', year: 2001}],
    top_viewer_overlay: {item_progress: {[ALBUM]: {progress_revision: '4', manual_completed_at: completed ? '2026-10-14T12:00:00Z' : null}}}, ...patch});
}
for (const completed of [false, true]) test(`actual Tops completion sends ${!completed}, suppresses duplicate activation, and refreshes authoritative state`, async () => {
  const write = deferred(), backend = service({execute: () => write.promise}), env = nativeEnvironment();
  backend.data.detail = projection(completed);
  const controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
  try {
    const button = env.host.querySelector(selector); assert.ok(button);
    assert.equal(button.getAttribute('aria-pressed'), String(completed));
    assert.equal(button.getAttribute('aria-label'), `${completed ? 'Clear completion' : 'Mark completed'} in this Top: Actual album`);
    env.click(button); await drain();
    assert.equal(backend.count('execute'), 0, 'confirmation cannot write before consent');
    assert.equal(env.document.getElementById('app-confirm-modal').hidden, false);
    env.click(env.document.getElementById('app-confirm-cancel')); await drain();
    assert.equal(backend.count('execute'), 0, 'declining completion cannot write');
    env.click(env.host.querySelector(selector)); await drain();
    assert.equal(env.document.getElementById('app-confirm-modal').hidden, false);
    env.click(env.document.getElementById('app-confirm-accept')); await drain();
    assert.equal(backend.count('execute'), 1);
    const call = backend.calls.find(row => row.method === 'execute'), command = call.args[1];
    assert.equal(call.args[0], 'set_manual_completion');
    assert.deepEqual(command, {top_ref: TOP, request_key: id(101), album_ref: ALBUM, progress_revision: '4', completed: !completed});
    const busy = env.host.querySelector(selector); assert.equal(busy.disabled, true);
    env.click(busy); assert.equal(backend.count('execute'), 1);
    backend.data.detail = projection(!completed);
    backend.data.detail.top_viewer_overlay.item_progress[ALBUM].progress_revision = '5';
    write.resolve({action: call.args[0], request_key: command.request_key, top_ref: TOP, album_ref: ALBUM, progress_revision: '5', completed: !completed});
    await drain();
    const refreshed = env.host.querySelector(selector); assert.ok(refreshed);
    assert.equal(refreshed.disabled, false); assert.equal(refreshed.getAttribute('aria-pressed'), String(!completed));
    assert.equal(controller.getSnapshot().mutation.status, 'ready');
    assert.equal(backend.count('read'), 2, 'receipt is followed by an authoritative detail read');
  } finally {owner.dispose();}
  await nextTask(); env.assertClean();
});
for (const [label, patch] of [
  ['missing progress', {top_viewer_overlay: {item_progress: {}}}],
  ['invalid progress', {top_viewer_overlay: {item_progress: {[ALBUM]: {progress_revision: '0', manual_completed_at: '2026-10-14T12:00:00Z'}}}}],
  ['denied own progress', {allowed_actions: {...permissions(), can_manage_own_progress: false}}],
]) test(`actual Tops view with ${label} exposes no completion intent`, async () => {
  const backend = service(), env = nativeEnvironment(); backend.data.detail = projection(false, patch);
  const controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
  try {assert.equal(env.host.querySelector(selector), null); assert.equal(backend.count('execute'), 0);}
  finally {owner.dispose();}
  env.assertClean();
});
test('scope retirement aborts an actual completion write and late settlement cannot restore its card', async () => {
  const write = deferred(), backend = service({execute: () => write.promise}), env = nativeEnvironment(); backend.data.detail = projection();
  const controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
  try {
    env.click(env.host.querySelector(selector)); await drain();
    assert.equal(backend.count('execute'), 0);
    assert.equal(env.document.getElementById('app-confirm-modal').hidden, false);
    env.click(env.document.getElementById('app-confirm-cancel')); await drain();
    assert.equal(backend.count('execute'), 0);
    env.click(env.host.querySelector(selector)); await drain();
    env.click(env.document.getElementById('app-confirm-accept')); await drain();
    const call = backend.calls.find(row => row.method === 'execute');
    assert.ok(call); controller.setScope(null);
    assert.equal(call.args[2].signal.aborted, true); assert.equal(env.host.querySelector(selector), null);
    write.resolve({action: 'set_manual_completion', request_key: call.args[1].request_key, top_ref: TOP, album_ref: ALBUM, completed: true, progress_revision: '5'});
    await drain(); assert.equal(env.host.querySelector(selector), null);
    assert.equal(controller.getSnapshot().mutation.status, 'idle'); assert.equal(backend.count('read'), 1);
    assert.equal(backend.count('execute'), 1);
  } finally {owner.dispose();}
  await nextTask(); env.assertClean();
});
