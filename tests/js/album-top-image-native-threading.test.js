'use strict';
// Real index/app/Share/native form/Choice ownership. The coordinator boundary
// alone is a recording double; the separate source/access suite proves the
// actual per-runtime singleton and the coordinator suite exercises its work.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(process.env.ALBUM_TOP_TEST_ROOT || path.join(__dirname, '../..'));
const J = require(path.join(ROOT, 'tests/js/runtime/album-tops-joined-share-fixtures/joined.cjs'));
const C = require(path.join(ROOT, 'tests/js/runtime/album-tops-native-fixtures/actual-choice-runtime.cjs'));
const N = require(path.join(ROOT, 'tests/js/runtime/album-tops-native-fixtures/actual-native-runtime.cjs'));
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const imageButton = root => [...root.querySelectorAll('button')].find(node => /(?:generate|create|export).*image|image.*(?:generate|create|export)/i.test(node.getAttribute('aria-label') || node.textContent.trim()) && !node.closest('[hidden]'));
function coordinator() {
  const calls = [], handles = []; let disposals = 0;
  const value = Object.freeze({open(options) {
    calls.push(options); const deferred = N.deferred();
    const record = {updates: [], closes: 0, disposals: 0, deferred};
    const handle = Object.freeze({update(next) {record.updates.push(next);}, close() {record.closes++;}, dispose() {record.disposals++;}, closed: deferred.promise});
    record.handle = handle; handles.push(record); return handle;
  }, read: () => Object.freeze({phase: handles.length ? 'active' : 'idle'}), dispose() {disposals++; return Promise.resolve();}});
  return {value, calls, handles, disposals: () => disposals};
}
async function connected(t, {withCoordinator = true, withProviders = true} = {}) {
  const env = C.actualChoiceEnvironment(), data = J.backend(), controller = await N.preparedController(data), exported = coordinator();
  const extra = withCoordinator ? {imageExportCoordinator: exported.value} : {};
  if (!withProviders) extra.providers = undefined;
  const owner = await N.connectedView(env, data, controller, extra);
  t.after(async () => {owner.dispose(); for (const record of exported.handles) record.deferred.resolve(); await C.settle(); env.assertClean(); env.host.remove();});
  env.click(env.button(env.host, 'Share')); await C.settle();
  return {...env, data, controller, exported, owner};
}

test('actual app threads providers and runtime-retained coordinator through joined Share into one image invocation', async t => {
  const h = await connected(t), before = J.joined(h), button = imageButton(h.content()); assert.ok(button, 'functional image entry'); assert.equal(button.disabled, false);
  button.focus(); h.click(button); await C.settle(); assert.equal(h.exported.calls.length, 1);
  const options = h.exported.calls[0]; keys(options, ['controller', 'providers', 'attribution', 'returnFocus', 'fallbackHost', 'onClose']);
  assert.equal(options.controller, h.controller); assert.equal(options.providers, h.data.providers);
  assert.equal(typeof options.attribution, 'string'); assert.ok(options.attribution.trim());
  assert.equal(typeof options.returnFocus, 'function'); assert.equal(typeof options.onClose, 'function'); assert.ok(options.fallbackHost);
  assert.equal(h.exported.disposals(), 0); assert.equal(h.data.count('execute'), 0, 'image action is not publication or sharing mutation');
  // Existing joined keys and source/publication/People work are not replaced.
  const after = J.joined(h); assert.equal(after.grid, before.grid); assert.equal(after.people, before.people); assert.equal(after.publicPane, before.publicPane);
  assert.ok(h.button(after.people, 'Save visibility')); assert.ok(after.publicPane.querySelector('.album-top-share__publication'));
});

for (const missing of ['coordinator', 'providers']) test(`missing ${missing} leaves image entry explicitly unavailable and preserves joined Share`, async t => {
  const h = await connected(t, {withCoordinator: missing !== 'coordinator', withProviders: missing !== 'providers'});
  J.joined(h); const button = imageButton(h.content());
  if (button) {assert.equal(button.disabled, true, 'unavailable image action is natively disabled'); h.click(button);}
  assert.equal(h.exported.calls.length, 0); assert.equal(h.data.count('execute'), 0);
});

for (const close of ['view', 'share-close', 'native-x']) test(`actual ${close} cleanup closes only the returned designer handle, not runtime coordinator`, async t => {
  const h = await connected(t); h.click(imageButton(h.content())); await C.settle(); const handle = h.exported.handles[0]; assert.ok(handle);
  if (close === 'view') h.owner.dispose();
  else if (close === 'share-close') h.click(h.button(h.content(), 'Close'));
  else h.click(h.document.getElementById('app-form-close'));
  await C.settle(); assert.equal(handle.closes + handle.disposals, 1, 'one owned close path initiated');
  assert.equal(h.exported.disposals(), 0, 'view/Share cleanup cannot destroy singleton or pending barrier');
});

test('actual Share update forwards exact current state to its active designer handle', async t => {
  const h = await connected(t); h.click(imageButton(h.content())); await C.settle(); const record = h.exported.handles[0];
  h.owner.update({}); await C.settle(); assert.ok(record.updates.length > 0);
  keys(record.updates.at(-1), ['state']); assert.equal(record.updates.at(-1).state, h.controller.getSnapshot());
  assert.equal(h.exported.calls.length, 1, 'rerender does not create second designer');
});

test('index obtains retained coordinator once per mount and threads it through real app/Share; remount cannot dispose it', async t => {
  const env = C.actualChoiceEnvironment(), native = N.shell(env), data = J.backend(), exported = coordinator(), factories = [];
  env.runtime.imageExport = Object.freeze({coordinator(factory) {factories.push(factory); return exported.value;}, createAccess() {assert.fail('index must not create source access itself');}});
  const {mountAlbumTops} = await import(pathToFileURL(path.join(ROOT, 'music_app/static/js/album-tops/index.mjs')).href);
  let owner = mountAlbumTops({host: env.host, runtime: env.runtime, providers: data.providers});
  t.after(async () => {owner.dispose(); for (const record of exported.handles) record.deferred.resolve(); await C.settle(); env.host.remove();});
  await C.settle();
  assert.equal(factories.length, 1); assert.equal(typeof factories[0], 'function');
  env.click(env.button(env.host, 'Share')); await C.settle(); const first = imageButton(env.content()); assert.ok(first); env.click(first); await C.settle();
  assert.equal(exported.calls.length, 1); assert.equal(exported.calls[0].providers, data.providers);
  owner.dispose(); await C.settle(); assert.equal(exported.disposals(), 0);
  assert.equal(exported.handles[0].closes + exported.handles[0].disposals, 1);
  owner = mountAlbumTops({host: env.host, runtime: env.runtime, providers: data.providers}); await C.settle();
  assert.equal(factories.length, 2); env.click(env.button(env.host, 'Share')); await C.settle(); env.click(imageButton(env.content())); await C.settle();
  assert.equal(exported.calls.length, 2); assert.equal(exported.disposals(), 0);
  owner.dispose(); for (const record of exported.handles) record.deferred.resolve(); await C.settle(); env.assertClean(); env.host.remove();
  assert.equal(native.listeners.size, 0, 'view listeners released, persistent coordinator retained');
});
