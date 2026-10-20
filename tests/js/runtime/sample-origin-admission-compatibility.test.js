'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const T = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const F = require('./sample-origin-fixtures.cjs');
async function fixture(t, picker, admitAlbum) {
  const svc = T.service({searchAlbums: async () => ({albums: [picker], next_cursor: null}), admitAlbum});
  const controller = await T.preparedController(svc, {selected: null});
  const {createAlbumTopDraft} = await T.load('album-tops/draft.mjs');
  const {captureAlbumTopSampleOrigin} = await T.load('playlists/sample-playlist-origins.mjs');
  const draft = createAlbumTopDraft({controller, providers: svc.providers});
  t.after(() => {draft.dispose(); controller.dispose();});
  await draft.setQuery('Picked');
  return {svc, controller, draft, capture: () => captureAlbumTopSampleOrigin({controller, draft, libraryRef: '5',
    isCurrent: () => controller.getSnapshot().scopeKey === T.SCOPE, returnToOrigin: async () => true})};
}
test('actual ordinary draft admission preserves exact captured picker string with exact legacy response and safe numeric ID', async t => {
  const picker = {local_album_id: 11, album_ref: null, inventory_album_ref: 'inventory-album:5:11', title: 'Picked', artist: 'Artist'};
  const waiting = F.deferred(), admitted = {album_ref: T.ALBUM};
  const h = await fixture(t, picker, async (id, context) => {
    assert.equal(id, 11); assert.equal(Number.isSafeInteger(id), true); assert.equal(context.scopeKey, T.SCOPE);
    return waiting.promise;
  });
  const selected = h.draft.getSnapshot().search.items[0], expected = selected.inventory_album_ref;
  const pending = h.draft.select(selected); assert.equal(h.draft.getSnapshot().busy, true);
  // Mutating the caller's picker DTO while admission is pending cannot replace
  // the already captured authoritative string. No new admission field exists.
  picker.inventory_album_ref = 'inventory-album:5:12';
  waiting.resolve(admitted); assert.equal(await pending, true);
  assert.deepEqual(Object.keys(admitted), ['album_ref']);
  const item = h.draft.getSnapshot().items[0];
  assert.equal(item.local_album_id, 11); assert.equal(item.inventory_album_ref, expected);
  assert.equal(Object.hasOwn(item, 'selected_inventory_album_ref'), false);
  assert.deepEqual(h.capture().origin, {kind: 'album_set', selections: [{kind: 'local', inventory_album_ref: expected}]});
  assert.equal(h.svc.count('admitAlbum'), 1); assert.equal(h.svc.count('execute'), 0);
});
test('ordinary draft.select still rejects an unsafe rounded legacy ID even alongside a valid bigint picker ref', async t => {
  const picker = {local_album_id: 9007199254740992, album_ref: null, inventory_album_ref: F.albumRefs[0], title: 'Picked', artist: 'Artist'};
  const h = await fixture(t, picker, async () => assert.fail('existing safe-integer admission guard must not be broadened'));
  assert.equal(await h.draft.select(h.draft.getSnapshot().search.items[0]), false);
  assert.equal(h.svc.count('admitAlbum'), 0); assert.deepEqual(h.draft.getSnapshot().items, []);
  // Bigint identity support is independently covered by original native177:
  // authoritative picker/selected edit_draft -> adapter, never unsafe admission.
});
test('real pending safe-ID admission cannot carry an authoritative picker string across a retired Top scope', async t => {
  const waiting = F.deferred(), picker = {local_album_id: 11, album_ref: null, inventory_album_ref: 'inventory-album:5:11', title: 'Picked', artist: 'Artist'};
  const h = await fixture(t, picker, async () => waiting.promise);
  const pending = h.draft.select(h.draft.getSnapshot().search.items[0]); h.controller.setScope('replacement');
  waiting.resolve({album_ref: T.ALBUM}); assert.equal(await pending, false);
  assert.deepEqual(h.draft.getSnapshot().items, []); assert.equal(h.capture(), null); assert.equal(h.svc.count('execute'), 0);
});
