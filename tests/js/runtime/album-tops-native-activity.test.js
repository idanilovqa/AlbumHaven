'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {id, TOP, OTHER, ALBUM, SCOPE, deferred, drain, detail, permissions, service,
  preparedController, nativeEnvironment, connectedView} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const completion = '[data-gallery-card-intent="complete"]';
const at = '2026-10-14T12:00:00Z';
function projection(active = true, completed = true, revision = '2') {
  return detail({allowed_actions: {...permissions(), can_set_activity: true, can_manage_own_progress: active},
    items: [{item_ref: id(21), album_ref: ALBUM, title: 'Actual album', artist: 'Artist', year: 2001}],
    top_viewer_overlay: {activity: {active, activity_revision: revision},
      item_progress: {[ALBUM]: {progress_revision: '4', manual_completed_at: completed ? at : null}}}});
}
const receipt = command => ({top_ref: TOP, action: 'set_activity', request_key: command.request_key,
  active: command.active, activity_revision: String(BigInt(command.activity_revision) + 1n), changed: true});
for (const completed of [false, true]) test(`paused native card retains completion=${completed}, disables mutation, and can reactivate`, async () => {
  const backend = service({execute: async (action, command) => {backend.data.detail = projection(true, completed, '3'); return receipt(command);}}), env = nativeEnvironment(); backend.data.detail = projection(false, completed);
  const controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
  try {
    const mark = env.host.querySelector(completion); assert.ok(mark); assert.equal(mark.disabled, true);
    assert.equal(mark.getAttribute('aria-pressed'), String(completed));
    env.click(mark); assert.equal(backend.count('execute'), 0);
    assert.equal(await controller.mutate('set_manual_completion', {album_ref: ALBUM, completed: !completed}), false);
    const activate = env.button(env.host, 'Activate Album Top'); assert.equal(activate.disabled, false);
    assert.match(activate.className, /action-button--bare/);
    env.click(activate); await drain();
    const call = backend.calls.find(row => row.method === 'execute');
    assert.equal(call.args[0], 'set_activity');
    assert.deepEqual(call.args[1], {top_ref: TOP, request_key: id(101), activity_revision: '2', active: true});
    assert.equal(env.host.querySelector(completion).disabled, false);
    assert.equal(env.host.querySelector(completion).getAttribute('aria-pressed'), String(completed));
    assert.equal(controller.getSnapshot().detail.data.top_viewer_overlay.item_progress[ALBUM].manual_completed_at, completed ? at : null);
  } finally {owner.dispose();} env.assertClean();
});
test('native toggle uses private revision, blocks duplicate sends, and reads current detail instead of replay receipt state', async () => {
  const write = deferred(), backend = service({execute: () => write.promise}), env = nativeEnvironment();
  backend.data.detail = projection(true);
  const controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
  try {
    env.click(env.button(env.host, 'Deactivate Album Top'));
    const call = backend.calls.find(row => row.method === 'execute');
    assert.deepEqual(call.args[1], {top_ref: TOP, request_key: id(101), activity_revision: '2', active: false});
    env.click(env.button(env.host, 'Deactivate Album Top')); assert.equal(backend.count('execute'), 1);
    assert.equal(controller.getSnapshot().detail.data.top_viewer_overlay.activity.active, true, 'no optimistic pause');
    backend.data.detail = projection(true, true, '4'); // Another session already reactivated after this receipt.
    write.resolve(receipt(call.args[1])); await drain();
    assert.equal(backend.count('read'), 2);
    assert.equal(controller.getSnapshot().detail.data.top_viewer_overlay.activity.active, true);
    assert.equal(env.host.querySelector(completion).getAttribute('aria-pressed'), 'true');
    assert.equal(env.host.querySelector(completion).disabled, false);
    assert.ok(env.button(env.host, 'Deactivate Album Top'));
  } finally {owner.dispose();} env.assertClean();
});
test('uncertain activity retries the exact command and cannot change progress while unresolved', async () => {
  let attempt = 0;
  const backend = service({execute: async (action, command) => {if (++attempt === 1) throw new Error('lost response'); return receipt(command);}});
  backend.data.detail = projection(); const controller = await preparedController(backend);
  try {
    assert.equal(await controller.mutate('set_activity', {active: false}), false);
    assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
    assert.equal(controller.getSnapshot().detail.data.top_viewer_overlay.activity.active, true);
    assert.equal(await controller.mutate('set_manual_completion', {album_ref: ALBUM, completed: false}), false);
    backend.data.detail = projection(false, true, '3');
    assert.equal(await controller.retryMutation(), true);
    const calls = backend.calls.filter(row => row.method === 'execute');
    assert.equal(calls.length, 2); assert.deepEqual(calls[0].args[1], calls[1].args[1]);
    assert.equal(controller.getSnapshot().detail.data.top_viewer_overlay.item_progress[ALBUM].manual_completed_at, at);
  } finally {controller.dispose();}
});
for (const [action, code, command] of [
  ['set_activity', 'activity_revision_conflict', {active: false}],
  ['set_manual_completion', 'top_inactive', {album_ref: ALBUM, completed: false}],
]) test(`${code} refreshes native detail without discarding private reactivation authority`, async () => {
  const backend = service({execute: async () => {backend.data.detail = projection(false, true, '3'); throw Object.assign(new Error(code), {status: 409, code});}}), env = nativeEnvironment();
  backend.data.detail = projection(); const controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
  try {
    assert.equal(await controller.mutate(action, command), false);
    assert.equal(backend.count('read'), 2); assert.equal(controller.getSnapshot().detail.status, 'ready');
    assert.equal(controller.getSnapshot().mutation.status, 'error'); assert.equal(controller.canRetryMutation(), false);
    assert.equal(env.host.querySelector(completion).disabled, true);
    assert.equal(env.host.querySelector(completion).getAttribute('aria-pressed'), 'true');
    assert.equal(env.button(env.host, 'Activate Album Top').disabled, false);
  } finally {owner.dispose();} env.assertClean();
});
for (const retire of ['navigate', 'scope']) test(`late activity settlement after ${retire} never restores the old Top`, async () => {
  const write = deferred(), backend = service({execute: () => write.promise}); backend.data.detail = projection();
  const controller = await preparedController(backend);
  try {
    const pending = controller.mutate('set_activity', {active: false}), call = backend.calls.find(row => row.method === 'execute');
    if (retire === 'scope') {controller.setScope('another-actor'); assert.equal(call.args[2].signal.aborted, true);}
    else await controller.open(OTHER);
    const reads = backend.count('read'); write.resolve(receipt(call.args[1])); await pending;
    assert.equal(backend.count('read'), reads);
    assert.equal(controller.getSnapshot().selectedTopRef, retire === 'scope' ? null : OTHER);
    if (retire === 'scope') assert.equal(controller.getSnapshot().mutation.status, 'idle');
    else assert.equal(controller.getSnapshot().detail.data.top_ref, OTHER);
  } finally {controller.dispose();}
});
test('consumed denial blocks uncertain activity replay until a later authorized read', async () => {
  const backend = service({execute: async () => {throw new Error('lost response');}}); backend.data.detail = projection();
  const controller = await preparedController(backend);
  try {
    await controller.mutate('set_activity', {active: false}); assert.equal(controller.canRetryMutation(), true);
    controller.observeDenial(SCOPE, Object.assign(new Error('revoked'), {status: 403}));
    assert.equal(controller.canRetryMutation(), false); assert.equal(await controller.retryMutation(), false);
    backend.data.detail = projection(false, true, '3'); await controller.open(TOP);
    assert.equal(controller.canRetryMutation(), true);
  } finally {controller.dispose();}
});
for (const patch of [{allowed_actions: {...permissions(), can_set_activity: false}},
  {top_viewer_overlay: {item_progress: {}}},
  {top_viewer_overlay: {activity: {active: 'false', activity_revision: '2'}, item_progress: {}}}]) {
  test('missing or denied activity authority never creates a native activation control', async () => {
    const backend = service(), env = nativeEnvironment(); backend.data.detail = {...projection(), ...patch};
    const controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
    try {
      assert.equal(env.host.querySelector('[aria-label="Deactivate Album Top"]'), null);
      assert.equal(env.host.querySelector('[aria-label="Activate Album Top"]'), null);
      assert.equal(await controller.mutate('set_activity', {active: false}), false); assert.equal(backend.count('execute'), 0);
    } finally {owner.dispose();} env.assertClean();
  });
}
test('an activity attempt started before a denial cannot publish success after authority is restored', async () => {
  const write = deferred(), backend = service({execute: () => write.promise}); backend.data.detail = projection();
  const controller = await preparedController(backend);
  try {
    const pending = controller.mutate('set_activity', {active: false}), call = backend.calls.find(row => row.method === 'execute');
    controller.observeDenial(SCOPE, Object.assign(new Error('revoked'), {status: 403}));
    await controller.open(TOP);
    write.resolve(receipt(call.args[1])); assert.equal(await pending, false);
    assert.equal(controller.getSnapshot().mutation.status, 'uncertain');
    assert.equal(controller.getSnapshot().detail.data.top_viewer_overlay.activity.active, true);
    assert.equal(backend.count('read'), 2);
  } finally {controller.dispose();}
});
test('definitive activity denial clears authority and cannot be retried', async () => {
  const backend = service({execute: async () => {throw Object.assign(new Error('revoked'), {status: 403});}}); backend.data.detail = projection();
  const controller = await preparedController(backend);
  try {
    assert.equal(await controller.mutate('set_activity', {active: false}), false);
    assert.equal(controller.getSnapshot().detail.status, 'denied'); assert.equal(controller.getSnapshot().directory.status, 'denied');
    assert.equal(controller.canRetryMutation(), false); assert.equal(backend.count('read'), 1);
  } finally {controller.dispose();}
});
test('directory shows personal inactive state while remaining navigable', async () => {
  const backend = service(), env = nativeEnvironment(); backend.data.detail = projection(false);
  const controller = await preparedController(backend, {selected: null}); let opened = null;
  const owner = await connectedView(env, backend, controller, {onOpen: ref => {opened = ref;}});
  try {
    assert.match(env.host.textContent, /Inactive for you/);
    env.click(env.host.querySelector('[data-gallery-card-intent="open"]')); assert.equal(opened, TOP);
    assert.equal(backend.count('execute'), 0);
  } finally {owner.dispose();} env.assertClean();
});
