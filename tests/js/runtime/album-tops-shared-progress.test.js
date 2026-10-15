'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;
const {load, id, TOP, ALBUM, detail, service, preparedController, nativeEnvironment, connectedView} =
  require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const completedAt = '2026-10-14T12:00:00Z';
function raw(completed = 0) {
  const albums = [ALBUM, id(12)];
  return {top_ref: TOP, revision: '1', title: 'Top', description: '', visibility: 'private',
    allowed_actions: {'library.browse.read': true},
    items: albums.map((catalog_ref, i) => ({ref: id(21 + i), catalog_ref, title: 'Album', artist_display: 'Artist', release_year: 2000})),
    top_viewer_overlay: {item_progress: Object.fromEntries(albums.map((ref, i) => [ref,
      {progress_revision: '1', manual_completed_at: i < completed ? completedAt : null}]))}};
}
async function providers(data) {
  const {createAlbumTopBackendProviders} = await load('album-tops/backend-providers.mjs');
  const context = {};
  return createAlbumTopBackendProviders({acceptsScope: scope => scope === 'test',
    transport: {context: () => context, request: async () => ({status: 'ready', context_ref: context, data})}});
}
test('actual full-detail provider projects exact private counts; directory never infers them', async () => {
  for (const count of [0, 1, 2]) {
    const backend = await providers(raw(count));
    const projected = await backend.read(TOP, {scopeKey: 'test'});
    assert.deepEqual(projected.completion_summary, {completed: count, total: 2});
    assert.ok(Object.isFrozen(projected.completion_summary)); backend.dispose();
  }
  const backend = await providers({tops: [raw(2)], next_cursor: null, allowed_actions: {}});
  const list = await backend.list({scopeKey: 'test'});
  assert.equal(Object.hasOwn(list.tops[0], 'completion_summary'), false); backend.dispose();
});
test('actual provider refuses incomplete, extra and duplicate membership instead of manufacturing totals', async () => {
  for (const mutate of [
    value => {delete value.top_viewer_overlay.item_progress[ALBUM];},
    value => {value.top_viewer_overlay.item_progress[id(13)] = {progress_revision: '0', manual_completed_at: null};},
    value => {value.items[1].catalog_ref = ALBUM;},
    value => {value.next_cursor = 'remaining-page';},
    value => {value.top_viewer_overlay.item_progress[ALBUM].manual_completed_at = 'invalid';},
  ]) {
    const value = raw(); mutate(value); const backend = await providers(value);
    await assert.rejects(backend.read(TOP, {scopeKey: 'test'})); backend.dispose();
  }
  const absent = raw(); delete absent.top_viewer_overlay;
  const backend = await providers(absent);
  assert.equal((await backend.read(TOP, {scopeKey: 'test'})).completion_summary, null); backend.dispose();
});
test('shared actual owner retains nodes and geometry classes across count, achievement and unavailable states', async () => {
  const {mountAlbumProgress} = await load('home-friends/album-progress.mjs'), env = nativeEnvironment();
  const owner = mountAlbumProgress(env.host, {summary: {completed: 0, total: 2}});
  const slot = env.host.querySelector('.album-progress'), track = env.host.querySelector('[role="progressbar"]');
  for (const completed of [1, 2, 0]) {
    owner.update({summary: {completed, total: 2}});
    assert.equal(env.host.querySelector('.album-progress'), slot);
    assert.equal(env.host.querySelector('[role="progressbar"]'), track);
    assert.equal(track.getAttribute('aria-valuenow'), String(completed));
    assert.equal(track.getAttribute('aria-valuemax'), '2');
    assert.equal(slot.className, 'album-progress');
    assert.equal(slot.hidden, false);
    assert.equal(track.querySelector('.album-progress__fill').style.width, String(100 * completed / 2) + '%');
  }
  for (const summary of [null, {completed: 0, total: 0}, {completed: 3, total: 2}, {completed: -1, total: 2}]) {
    owner.update({summary}); assert.equal(env.host.querySelector('[role="progressbar"]'), null);
    assert.equal(env.host.querySelector('.album-progress'), slot); assert.equal(slot.hidden, true);
  }
  owner.update({summary: {completed: 10, total: 10}});
  assert.equal(env.host.querySelector('.album-progress'), slot); assert.equal(slot.hidden, false);
  assert.equal(env.host.querySelector('[role="progressbar"]'), track);
  owner.dispose(); owner.dispose(); assert.equal(env.host.querySelector('.album-progress'), null);
  owner.update({summary: null});
  owner.update({summary: {completed: 1, total: 2}, label: 'Retired'});
  assert.equal(env.host.querySelector('.album-progress'), null);
  assert.equal(slot.hidden, false); assert.equal(track.getAttribute('aria-valuenow'), '10');
  assert.equal(track.getAttribute('aria-label'), 'Completed albums');
  assert.equal(track.querySelector('.album-progress__fill').style.width, '100%');
  env.assertClean();
});
test('actual Tops header uses validated full-detail counts, not visible cards; retires on scope loss', async () => {
  const provider = await providers(raw(1)), projected = await provider.read(TOP, {scopeKey: 'test'});
  const backend = service(), env = nativeEnvironment();
  // Simulate a display-only filter: the full-detail summary remains authoritative.
  backend.data.detail = detail({...projected, items: projected.items.slice(0, 1)});
  const controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
  try {
    const track = env.host.querySelector('[role="progressbar"]'); assert.ok(track);
    assert.equal(track.getAttribute('aria-valuenow'), '1'); assert.equal(track.getAttribute('aria-valuemax'), '2');
    assert.equal(track.getAttribute('aria-label'), 'Manually completed albums in this Top');
    controller.setScope(null); assert.equal(env.host.querySelector('[role="progressbar"]'), null);
  } finally {owner.dispose(); provider.dispose();}
  env.assertClean();
});
test('actual empty Top has no progress semantics', async () => {
  const value = raw(); value.items = []; value.top_viewer_overlay.item_progress = {};
  const provider = await providers(value), backend = service(), env = nativeEnvironment();
  backend.data.detail = detail(await provider.read(TOP, {scopeKey: 'test'}));
  const controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
  try {
    assert.equal(env.host.querySelector('[role="progressbar"]'), null);
    assert.equal(env.host.querySelector('.album-progress').hidden, true);
  }
  finally {owner.dispose(); provider.dispose();} env.assertClean();
});
test('shared stylesheet fixes the same geometry without achievement or filter variants', () => {
  const fs = require('node:fs'), path = require('node:path');
  const css = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/css/runtime/home-friends.css'), 'utf8');
  const slot = css.match(/\.album-progress \{([^}]+)\}/)?.[1];
  assert.ok(slot);
  for (const rule of ['width: 160px;', 'min-width: 160px;', 'max-width: 160px;', 'height: 8px;', 'min-height: 8px;', 'flex: 0 0 160px;']) assert.ok(slot.includes(rule));
  assert.equal((css.match(/\.album-progress \{/g) || []).length, 1);
  assert.ok(css.includes('.album-progress[hidden] { display: none; }'));
});
