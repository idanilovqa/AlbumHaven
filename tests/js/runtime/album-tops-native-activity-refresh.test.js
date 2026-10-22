'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {id, TOP, OTHER, ALBUM, deferred, drain, detail, permissions, service,
  preparedController, nativeEnvironment, connectedView} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const completion = '[data-gallery-card-intent="complete"]';
const timestamp = '2026-10-14T12:00:00Z';
function projection(active = true, topRef = TOP, canSet = true) {
  return detail({top_ref: topRef, allowed_actions: {...permissions(), can_set_activity: canSet, can_manage_own_progress: active},
    items: [{item_ref: id(21), album_ref: ALBUM, title: 'Retained album', artist: 'Artist', year: 2001}],
    top_viewer_overlay: {activity: {active, activity_revision: active ? '2' : '3'},
      item_progress: {[ALBUM]: {progress_revision: '4', manual_completed_at: timestamp}}}});
}
const directory = row => ({tops: [row], allowed_actions: permissions()});
const receipt = command => ({top_ref: TOP, action: 'set_activity', request_key: command.request_key,
  active: false, activity_revision: '3', changed: true});
const conflict = () => Object.assign(new Error('activity changed'), {status: 409, code: 'activity_revision_conflict'});
const hasVisibleControl = (env, label) => env.host.querySelectorAll('button').some(button =>
  (button.getAttribute('aria-label') || button.textContent.trim()) === label && !button.closest('[hidden]'));
for (const outcome of ['acknowledged', 'conflict']) for (const failures of ['detail', 'list', 'both']) {
  test(`${outcome} activity survives failed ${failures} refresh and native read retry recovers without resending`, async () => {
    let reads = 0, lists = 0, saved = false;
    const failDetail = failures !== 'list', failList = failures !== 'detail';
    const backend = service({
      read: async ref => {if (++reads === 2 && failDetail) throw new Error('detail unavailable'); return projection(!saved, ref);},
      list: async () => {if (++lists === 2 && failList) throw new Error('directory unavailable'); return directory(projection(!saved));},
      execute: async (action, command) => {saved = true; if (outcome === 'conflict') throw conflict(); return receipt(command);},
    });
    const env = nativeEnvironment(), controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
    try {
      const result = await controller.mutate('set_activity', {active: false});
      assert.equal(result, outcome === 'acknowledged');
      const state = controller.getSnapshot();
      assert.equal(state.mutation.status, outcome === 'acknowledged' ? 'ready' : 'error');
      assert.equal(state.mutation.refreshing, false);
      assert.equal(state.detail.status, failDetail ? 'error' : 'ready');
      assert.equal(state.directory.status, failList ? 'error' : 'ready');
      assert.equal(controller.canRetryMutation(), false);
      assert.equal(await controller.retryMutation(), false); assert.equal(backend.count('execute'), 1);
      if (outcome === 'acknowledged') assert.equal(state.mutation.data.activity_revision, '3');
      else assert.equal(state.mutation.error.code, 'activity_revision_conflict');
      assert.equal(hasVisibleControl(env, 'Retry original request'), false);
      if (failDetail) {
        assert.equal(env.host.querySelector(completion), null);
        assert.equal(hasVisibleControl(env, 'Activate Album Top'), false);
        env.click(env.button(env.host, 'Retry')); await drain();
        assert.equal(controller.getSnapshot().detail.status, 'ready');
      }
      if (failList) {
        await controller.open(null);
        env.click(env.button(env.host, 'Retry')); await drain();
        assert.equal(controller.getSnapshot().directory.status, 'ready');
        await controller.open(TOP);
      }
      const recovered = controller.getSnapshot();
      assert.equal(recovered.detail.data.top_viewer_overlay.activity.active, false);
      assert.equal(recovered.detail.data.top_viewer_overlay.item_progress[ALBUM].manual_completed_at, timestamp);
      assert.equal(recovered.mutation.status, outcome === 'acknowledged' ? 'ready' : 'error');
      assert.equal(recovered.directory.status, 'ready'); assert.equal(recovered.detail.status, 'ready');
      assert.equal(env.host.querySelector(completion).getAttribute('aria-pressed'), 'true');
      assert.equal(env.host.querySelector(completion).disabled, true);
      assert.equal(env.button(env.host, 'Activate Album Top').disabled, false);
      assert.equal(backend.count('execute'), 1);
      assert.equal(controller.canRetryMutation(), false);
      assert.equal(hasVisibleControl(env, 'Retry original request'), false);
    } finally {owner.dispose();} env.assertClean();
  });
}
for (const outcome of ['acknowledged', 'conflict']) for (const retire of ['navigation', 'scope']) {
  test(`${outcome} refresh settling after ${retire} cannot revive the old activation control`, async () => {
    const oldDetail = deferred(), oldList = deferred(); let reads = 0, lists = 0;
    const other = projection(true, OTHER, false);
    const backend = service({
      read: async ref => {if (++reads === 2) return oldDetail.promise; return reads === 1 ? projection() : {...other, top_ref: ref};},
      list: async () => {if (++lists === 2) return oldList.promise; return directory(lists === 1 ? projection() : other);},
      execute: async (action, command) => {if (outcome === 'conflict') throw conflict(); return receipt(command);},
    });
    const env = nativeEnvironment(), controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
    try {
      const pending = controller.mutate('set_activity', {active: false}); await drain();
      assert.equal(backend.count('read'), 2); assert.equal(backend.count('list'), 2);
      assert.equal(controller.getSnapshot().mutation.refreshing, true);
      assert.equal(hasVisibleControl(env, 'Activate Album Top'), false);
      assert.equal(hasVisibleControl(env, 'Deactivate Album Top'), false);
      if (retire === 'scope') {
        const refreshRead = backend.calls.filter(call => call.method === 'read').at(-1);
        const refreshList = backend.calls.filter(call => call.method === 'list').at(-1);
        controller.setScope('different-actor:session:library');
        assert.equal(refreshRead.args[1].signal.aborted, true);
        assert.equal(refreshList.args[0].signal.aborted, true);
        await controller.load();
      }
      await controller.open(OTHER);
      const selected = controller.getSnapshot().detail.data;
      assert.equal(hasVisibleControl(env, 'Activate Album Top'), false);
      assert.equal(hasVisibleControl(env, 'Deactivate Album Top'), false);
      oldDetail.resolve(projection(false)); oldList.resolve(directory(projection(false)));
      await pending; await drain();
      const state = controller.getSnapshot();
      assert.equal(state.selectedTopRef, OTHER); assert.equal(state.detail.data, selected);
      assert.equal(state.detail.data.top_ref, OTHER); assert.equal(state.detail.data.allowed_actions.can_set_activity, false);
      assert.equal(hasVisibleControl(env, 'Activate Album Top'), false);
      assert.equal(hasVisibleControl(env, 'Deactivate Album Top'), false);
      assert.equal(backend.count('execute'), 1);
      if (retire === 'scope') {
        assert.equal(state.mutation.status, 'idle'); assert.equal(state.directory.data.tops[0].top_ref, OTHER);
      } else assert.equal(state.mutation.status, outcome === 'acknowledged' ? 'ready' : 'error');
    } finally {owner.dispose();} env.assertClean();
  });
}
