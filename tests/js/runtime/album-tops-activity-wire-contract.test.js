'use strict';
// Transport-contract tests: controlled HTTP replies, actual transport/provider,
// controller and native view. These are neither SQL nor browser acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readRepo} = require('./native-home-harness.cjs');
const {load, id, TOP, OTHER, ALBUM, SCOPE, deferred, drain, nativeEnvironment,
  connectedView} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const MARK = '[data-gallery-card-intent="complete"]';
const AT = '2026-10-14T12:00:00+00:00';
const clone = value => JSON.parse(JSON.stringify(value));
function rawDetail(active, activityRevision, {ref = TOP, completed = true} = {}) {
  assert.equal(active, BigInt(activityRevision) % 2n === 0n, 'wire fixture obeys persisted activity parity');
  return {top_ref: ref, title: 'Wire Top', description: 'Private progress', revision: '7', visibility: 'private',
    allowed_actions: {'library.browse.read': true, 'library.album_tops.manage': false,
      'library.album_tops.items.manage': false, can_read: true, can_edit: false, can_rename: false,
      can_add: false, can_remove: false, can_reorder: false, can_delete: false, can_share: false,
      can_view_sharing: true, can_request_edit: false, can_copy: true,
      can_set_activity: true, can_manage_own_progress: active},
    items: [{ref: id(21), catalog_ref: ALBUM, title: 'Retained album', artist_display: 'Artist',
      release_year: 2001, original_position: 1, curator_position: 1}],
    top_viewer_overlay: {activity: {active, activity_revision: activityRevision}, item_progress: {
      [ALBUM]: {progress_revision: completed ? '1' : '0', manual_completed_at: completed ? AT : null}}}};
}
function directory(detail) {
  const {items, top_viewer_overlay, ...row} = detail;
  return {tops: [{...row, top_viewer_overlay: {activity: clone(top_viewer_overlay.activity)}}],
    allowed_actions: {'library.browse.read': true, 'library.album_tops.create': true, can_create: true}, next_cursor: null};
}
const receipt = (body, active, revision, changed = true) => ({top_ref: TOP, action: 'set_activity',
  request_key: body.request_key, active, activity_revision: revision, changed});

async function setup(t, initial, onPost) {
  let env, shell, providers, controller, owner, closed = false;
  const pageObservers = [], calls = [];
  const close = () => {
    if (closed) return; closed = true;
    const failures = [];
    const retire = callback => {try {callback();} catch (error) {failures.push(error);}};
    retire(() => owner?.dispose());
    // connectedView normally retires this controller too. Keep explicit ownership
    // for failed view acquisition or a view disposer that throws first.
    retire(() => controller?.dispose());
    retire(() => providers?.dispose());
    for (const observer of pageObservers) retire(() => observer.disconnect());
    retire(() => shell?.remove());
    retire(() => env?.assertClean());
    retire(() => env?.host.remove());
    if (failures.length) throw new AggregateError(failures, 'Activity wire fixture cleanup failed');
  };
  t.after(close);
  try {
  env = nativeEnvironment();
  let scope = SCOPE, stamp = 'a'.repeat(64), current = clone(initial);
  shell = env.document.createElement('div'); shell.id = 'app-shell';
  shell.dataset.privateUiContext = stamp; env.document.body.append(shell);
  const http = (data, status = 200, context = stamp) => ({ok: status >= 200 && status < 300, status,
    json: async () => clone(status < 400 ? {status: 'ready', data, context_ref: context} : {ok: false, error: data})});
  env.context.fetch = async (url, options) => {
    const call = {url, method: options.method, body: options.body === undefined ? undefined : JSON.parse(options.body),
      context: options.headers['X-AlbumHaven-Context'], signal: options.signal}; calls.push(call);
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
    if (call.method === 'POST') return onPost(call, api);
    if (url === '/album-tops?limit=100') return http(directory(current), 200, call.context);
    assert.equal(url, '/album-tops/' + current.top_ref, 'only current detail route is requested');
    return http(current, 200, call.context);
  };
  const observerStart = env.observers.length;
  try {
    vm.runInContext(readRepo('music_app/static/js/runtime/private-ui-transport.js'), env.context,
      {filename: 'private-ui-transport.js'});
  } finally {pageObservers.push(...env.observers.slice(observerStart));}
  const {createAlbumTopBackendProviders} = await load('album-tops/backend-providers.mjs');
  providers = createAlbumTopBackendProviders({transport: env.context.AlbumHavenPrivateUITransport,
    acceptsScope: value => value === scope});
  const {createAlbumTopController} = await load('album-tops/model.mjs'); let key = 100;
  controller = createAlbumTopController({providers, requestKey: () => id(++key)});
  const api = {env, calls, providers, controller, http,
    set(detail) {current = clone(detail);},
    posts: () => calls.filter(call => call.method === 'POST'),
    rotate(detail) {scope = 'another-account:session:library'; stamp = 'b'.repeat(64);
      shell.dataset.privateUiContext = stamp; current = clone(detail); controller.setScope(scope);},
  };
  controller.setScope(scope); await controller.load(); await controller.open(initial.top_ref);
  owner = await connectedView(env, {providers}, controller);
  api.close = close;
  return api;
  } catch (error) {
    try {close();} catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Activity wire setup and cleanup failed', {cause: error});
    }
    throw error;
  }
}

function observeMutationSettlement(t, controller, requestKey) {
  let unsubscribe = () => {};
  const settled = new Promise(resolve => {
    const observe = () => {
      const mutation = controller.getSnapshot().mutation;
      if (mutation.command?.request_key !== requestKey || mutation.refreshing === true
        || !['ready', 'error', 'denied', 'uncertain'].includes(mutation.status)) return;
      unsubscribe(); resolve();
    };
    unsubscribe = controller.subscribe(observe);
    t.after(() => unsubscribe());
    observe();
  });
  return settled;
}

for (const completed of [false, true]) test(`raw paused projection retains completed=${completed} and independently permits activation`, async t => {
  const f = await setup(t, rawDetail(false, '1', {completed}), (call, api) => {
    api.set(rawDetail(true, '2', {completed})); return api.http(receipt(call.body, true, '2'), 200, call.context);
  });
  try {
    const state = f.controller.getSnapshot();
    assert.deepEqual(state.directory.data.tops[0].top_viewer_overlay, {activity: {active: false, activity_revision: '1'}});
    assert.deepEqual(state.detail.data.top_viewer_overlay.activity, {active: false, activity_revision: '1'});
    assert.equal(state.detail.data.allowed_actions.can_manage_own_progress, false);
    assert.equal(state.detail.data.allowed_actions.can_set_activity, true);
    const mark = f.env.host.querySelector(MARK); assert.equal(mark.disabled, true);
    assert.equal(mark.getAttribute('aria-pressed'), String(completed));
    f.env.click(mark); assert.equal(f.posts().length, 0);
    assert.equal(await f.controller.mutate('set_manual_completion', {album_ref: ALBUM, completed: !completed}), false);
    const settled = observeMutationSettlement(t, f.controller, id(101));
    f.env.click(f.env.button(f.env.host, 'Activate Album Top')); await settled;
    assert.equal(f.controller.getSnapshot().mutation.refreshing, false);
    assert.equal(f.posts().length, 1);
    assert.equal(f.posts()[0].url, `/album-tops/${TOP}/set_activity`);
    assert.deepEqual(f.posts()[0].body, {request_key: id(101), activity_revision: '1', active: true});
    assert.equal(f.controller.getSnapshot().mutation.status, 'ready');
    assert.equal(f.controller.getSnapshot().detail.data.top_viewer_overlay.activity.activity_revision, '2');
    assert.equal(f.env.host.querySelector(MARK).disabled, false);
    assert.equal(f.env.host.querySelector(MARK).getAttribute('aria-pressed'), String(completed));
    assert.equal(f.controller.getSnapshot().detail.data.top_viewer_overlay.item_progress[ALBUM].manual_completed_at, completed ? AT : null);
  } finally {f.close();}
});

test('lost HTTP response retries exact activity command and uses current refresh after historical receipt', async t => {
  let attempts = 0;
  const f = await setup(t, rawDetail(true, '0'), (call, api) => {
    if (++attempts === 1) throw new Error('controlled lost HTTP response');
    // Original pause receipt is historical; a separate session has reactivated.
    api.set(rawDetail(true, '2'));
    return api.http(receipt(call.body, false, '1'), 200, call.context);
  });
  try {
    assert.equal(await f.controller.mutate('set_activity', {active: false}), false);
    assert.equal(f.controller.getSnapshot().mutation.status, 'uncertain');
    assert.equal(f.controller.canRetryMutation(), true);
    assert.equal(await f.controller.mutate('set_activity', {active: false}), false);
    assert.equal(await f.controller.mutate('set_manual_completion', {album_ref: ALBUM, completed: false}), false);
    assert.equal(f.posts().length, 1);
    assert.equal(await f.controller.retryMutation(), true);
    assert.equal(f.posts().length, 2); assert.deepEqual(f.posts()[0].body, f.posts()[1].body);
    assert.deepEqual(f.posts()[1].body, {request_key: id(101), activity_revision: '0', active: false});
    const state = f.controller.getSnapshot();
    assert.equal(state.mutation.data.active, false); assert.equal(state.mutation.data.activity_revision, '1');
    assert.deepEqual(state.detail.data.top_viewer_overlay.activity, {active: true, activity_revision: '2'});
    assert.deepEqual(state.directory.data.tops[0].top_viewer_overlay.activity, {active: true, activity_revision: '2'});
    assert.equal(state.detail.data.top_viewer_overlay.item_progress[ALBUM].manual_completed_at, AT);
    assert.equal(f.env.host.querySelector(MARK).disabled, false);
    assert.ok(f.env.button(f.env.host, 'Deactivate Album Top'));
    assert.equal(f.controller.canRetryMutation(), false);
  } finally {f.close();}
});

for (const [action, code, payload] of [
  ['set_activity', 'activity_revision_conflict', {active: false}],
  ['set_manual_completion', 'top_inactive', {album_ref: ALBUM, completed: false}],
]) test(`real transport ${code} preserves error code and refreshes paused authority`, async t => {
  const f = await setup(t, rawDetail(true, '0'), (call, api) => {
    api.set(rawDetail(false, '1')); return api.http(code, 409, call.context);
  });
  try {
    assert.equal(await f.controller.mutate(action, payload), false);
    const state = f.controller.getSnapshot();
    assert.equal(state.mutation.status, 'error'); assert.equal(state.mutation.error.status, 409);
    assert.equal(state.mutation.error.code, code); assert.equal(state.mutation.refreshing, false);
    assert.equal(state.detail.status, 'ready'); assert.equal(state.directory.status, 'ready');
    assert.deepEqual(state.detail.data.top_viewer_overlay.activity, {active: false, activity_revision: '1'});
    assert.deepEqual(state.directory.data.tops[0].top_viewer_overlay.activity, {active: false, activity_revision: '1'});
    assert.equal(f.env.host.querySelector(MARK).disabled, true);
    assert.equal(f.env.host.querySelector(MARK).getAttribute('aria-pressed'), 'true');
    assert.equal(f.env.button(f.env.host, 'Activate Album Top').disabled, false);
    assert.equal(f.controller.canRetryMutation(), false); assert.equal(await f.controller.retryMutation(), false);
    assert.equal(f.posts().length, 1);
  } finally {f.close();}
});

for (const outcome of ['receipt', 'conflict']) test(`late raw ${outcome} after scope replacement cannot restore old activity`, async t => {
  const delayed = deferred();
  const f = await setup(t, rawDetail(true, '0'), () => delayed.promise);
  try {
    const pending = f.controller.mutate('set_activity', {active: false});
    const call = f.posts()[0]; assert.ok(call);
    f.rotate(rawDetail(true, '0', {ref: OTHER, completed: false}));
    assert.equal(call.signal.aborted, true);
    await f.controller.load(); await f.controller.open(OTHER);
    const selected = f.controller.getSnapshot().detail.data, readCount = f.calls.length;
    delayed.resolve(outcome === 'receipt' ? f.http(receipt(call.body, false, '1'), 200, call.context)
      : f.http('activity_revision_conflict', 409, call.context));
    assert.equal(await pending, false); await drain();
    const state = f.controller.getSnapshot();
    assert.equal(state.selectedTopRef, OTHER); assert.equal(state.detail.data, selected);
    assert.equal(state.mutation.status, 'idle'); assert.equal(state.directory.data.tops[0].top_ref, OTHER);
    assert.deepEqual(state.detail.data.top_viewer_overlay.activity, {active: true, activity_revision: '0'});
    assert.equal(f.calls.length, readCount, 'retired settlement starts no refresh');
    assert.equal(f.env.host.querySelector(MARK).getAttribute('aria-pressed'), 'false');
    assert.ok(f.env.button(f.env.host, 'Deactivate Album Top'));
    assert.equal(f.posts().length, 1);
  } finally {f.close();}
});
