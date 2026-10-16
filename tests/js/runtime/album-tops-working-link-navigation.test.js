'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
let mountAlbumTops, createAlbumTopBackendProviders, createAlbumTopController, albumTopActionAllowed;
test.before(async () => {
  ({mountAlbumTops} = await F.load('album-tops/index.mjs'));
  ({createAlbumTopBackendProviders} = await F.load('album-tops/backend-providers.mjs'));
  ({createAlbumTopController, albumTopActionAllowed} = await F.load('album-tops/model.mjs'));
});
const CONTEXT = 'a'.repeat(64), SHARE = F.id(77);
const viewer = (ref = F.TOP, title = 'Current named-viewer Top') => ({top_ref: ref, revision: '8', title,
  description: 'Read from the current working owner', visibility: 'private', items: [],
  allowed_actions: {'library.browse.read': true, can_read: true, can_edit: false, can_rename: false,
    can_add: false, can_remove: false, can_reorder: false, can_delete: false, can_share: false,
    can_create: false, can_copy: false, can_request_edit: false, can_view_sharing: false,
    can_manage_own_progress: false, can_set_activity: false}});
const directory = () => ({tops: [], next_cursor: null, allowed_actions: {'library.browse.read': true, can_create: false}});
function connected(t, read) {
  const env = F.nativeEnvironment(), shell = F.shell(env), calls = [];
  let context = CONTEXT;
  // Only transport is a seam. Provider, controller, shell consumer and native
  // presentation are their whole actual source owners. No redirect is a DTO.
  const transport = {context: () => context, async request(path, options) {
    const captured = context; calls.push({path, options});
    assert.equal(options.method, undefined, 'navigation dispatches reads only');
    const data = path.startsWith('/album-tops?') ? directory() : await read(path, options);
    return {status: 'ready', context_ref: captured, data};
  }};
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: env.runtime.acceptsPrivateScope});
  const mounted = mountAlbumTops({host: env.host, runtime: env.runtime, providers});
  t.after(() => {mounted.dispose(); env.assertClean();});
  return {env, shell, calls, setContext(value) {context = value;}};
}
function noEditing(env) {
  for (const label of ['Edit Album Top', 'Delete Album Top', 'Share', 'Add albums']) {
    assert.equal(env.host.querySelector(`[aria-label="${label}"]`), null, `viewer has no ${label} action`);
  }
}

test('fixed redirect identity starts a fresh actual native provider read with current viewer rights', async t => {
  const target = new URL(`/?surface=album_tops&top_ref=${F.TOP}`, 'https://public.example.test');
  assert.equal(target.searchParams.get('top_ref'), F.TOP);
  const state = connected(t, path => {assert.equal(path, '/album-tops/' + target.searchParams.get('top_ref')); return viewer();});
  await F.drain();
  assert.deepEqual(state.calls.map(call => call.path), ['/album-tops?limit=100', '/album-tops/' + F.TOP]);
  assert.ok(state.calls.every(call => call.options.expected === CONTEXT && call.options.signal instanceof AbortSignal));
  assert.ok(state.calls.every(call => !call.path.includes(SHARE) && !call.path.includes('public-link')));
  assert.match(state.env.host.textContent, /Current named-viewer Top/); noEditing(state.env);
  assert.equal(state.shell.navigations.length, 0, 'cold native bootstrap does not replay the resolver');
});

test('actual controller cannot turn viewer navigation identity into a mutation grant', async t => {
  const calls = [], providers = createAlbumTopBackendProviders({acceptsScope: scope => scope === F.SCOPE,
    transport: {context: () => CONTEXT, async request(path, options) {
      calls.push({path, options}); return {status: 'ready', context_ref: CONTEXT, data: viewer()};
    }}});
  const controller = createAlbumTopController({providers, requestKey: () => F.id(99)});
  t.after(() => {controller.dispose(); providers.dispose();});
  controller.setScope(F.SCOPE); await controller.open(F.TOP);
  assert.equal(controller.getSnapshot().detail.status, 'ready');
  for (const action of ['save', 'delete', 'add', 'reorder', 'grant_editor', 'enable_external', 'revoke_external']) {
    assert.equal(albumTopActionAllowed(controller.getSnapshot(), action), false);
    await controller.mutate(action);
  }
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/album-tops/' + F.TOP);
});

for (const status of [401, 403, 404]) test(`current working read ${status} cannot reuse a successful redirect as authority`, async t => {
  const state = connected(t, () => {throw Object.assign(new Error('Working access unavailable'), {status});});
  await F.drain();
  assert.doesNotMatch(state.env.host.textContent, /Current named-viewer Top|Published snapshot title/);
  noEditing(state.env);
  assert.equal(state.calls.filter(call => call.path === '/album-tops/' + F.TOP).length, 1);
  assert.equal(state.shell.navigations.length, 0);
});

test('account and context replacement retire a pending working read before its old metadata arrives', async t => {
  const pending = F.deferred(); let count = 0;
  const state = connected(t, () => ++count === 1 ? pending.promise : viewer(F.TOP, 'Replacement account current Top'));
  await F.drain();
  state.setContext('b'.repeat(64));
  state.shell.change({scopeKey: 'replacement-account:session:library', viewVersion: 2, viewRequestId: 11});
  await F.drain();
  assert.match(state.env.host.textContent, /Replacement account current Top/);
  pending.resolve(viewer(F.TOP, 'Retired account private title')); await F.drain();
  assert.match(state.env.host.textContent, /Replacement account current Top/);
  assert.doesNotMatch(state.env.host.textContent, /Retired account private title/); noEditing(state.env);
  assert.equal(state.calls.filter(call => call.path === '/album-tops/' + F.TOP).length, 2);
});

for (const outcome of ['success', 'denial']) test(`later navigation survives obsolete working-read ${outcome}`, async t => {
  const pending = F.deferred();
  const state = connected(t, path => path === '/album-tops/' + F.TOP ? pending.promise : viewer(F.OTHER, 'New selected Top'));
  await F.drain();
  state.shell.change({topRef: F.OTHER, viewVersion: 2, viewRequestId: 11}); await F.drain();
  assert.match(state.env.host.textContent, /New selected Top/);
  if (outcome === 'success') pending.resolve(viewer(F.TOP, 'Obsolete selection title'));
  else pending.reject(Object.assign(new Error('Old selection forbidden'), {status: 403}));
  await F.drain();
  assert.match(state.env.host.textContent, /New selected Top/);
  assert.doesNotMatch(state.env.host.textContent, /Obsolete selection title/); noEditing(state.env);
});
