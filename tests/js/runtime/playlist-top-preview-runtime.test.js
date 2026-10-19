'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {nativeMixFixture} = require('./library-mix-react-fixture.cjs');
const {id, deferred} = require('./library-mix-fixtures.cjs');
async function fixture(t, resolver) {
  const h = await nativeMixFixture(t); h.installNavigation();
  const scopeKey = h.runtime.snapshot().scopeKey, token = id(91); let live = true, discarded = 0;
  assert.equal(h.runtime.openDraft({token, scopeKey, isCurrent: () => live, confirmLeave: () => true, onDiscard: () => {discarded++;}}), true);
  const preview = {preview_ref: token, source: {playlist_ref: id(80), revision: '1'}, albums: [{album_ref: id(3)}]};
  const resolutions = [], native = {album_ref: 'authorized-key', allowed_actions: {can_open_album: true, can_play_album: false}};
  const adapter = h.runtime.createAlbumTopPreviewRuntime({token, scopeKey, preview, isCurrent: () => live,
    resolveAlbum: async (ref, options) => {resolutions.push({ref, options}); return resolver ? resolver(ref, options) : native;}});
  let opened = null;
  h.c.fetchTrackModalAlbumDetails = async () => ({key: 'authorized-key'});
  h.c.releaseTrackModalSelection = () => {};
  h.c.openTrackModal = (_album, options) => {opened = options; return true;};
  return {...h, scopeKey, token, adapter, resolutions, get opened() {return opened;}, get discarded() {return discarded;}, retire: () => {live = false;}};
}
test('preview Details use server mapping twice and preserve exact nested origin', async t => {
  const h = await fixture(t);
  await h.adapter.openAlbum(id(3)); assert.equal(h.resolutions.length, 2);
  assert.equal(h.runtime.snapshot().retainedDraftToken, h.token); assert.equal(h.discarded, 0);
  assert.equal(typeof h.opened.sourcePageOwner.retainNavigation, 'function');
  const refreshed = await h.opened.sourcePageOwner.revalidate({albumKey: 'authorized-key'});
  assert.ok(refreshed); assert.equal(h.resolutions.length, 3);
  await h.adapter.openAlbum(id(3)); assert.equal(h.runtime.snapshot().retainedDraftToken, h.token);
  h.adapter.dispose();
});
test('nonmembers never ask resolver and changed native mapping cannot hydrate', async t => {
  let n = 0; const h = await fixture(t, () => ({album_ref: ++n === 1 ? 'first' : 'remapped', allowed_actions: {can_open_album: true, can_play_album: false}}));
  await assert.rejects(h.adapter.openAlbum(id(99)), {name: 'AbortError'}); assert.equal(n, 0);
  await assert.rejects(h.adapter.openAlbum(id(3)), /changed/); assert.equal(h.opened, null); h.adapter.dispose();
});
test('retired preview cannot finish an in-flight details resolution', async t => {
  const wait = deferred(), h = await fixture(t, () => wait.promise), pending = h.adapter.openAlbum(id(3));
  h.retire(); wait.resolve({album_ref: 'key', allowed_actions: {can_open_album: true, can_play_album: false}});
  await assert.rejects(pending, {name: 'AbortError'}); assert.equal(h.opened, null); h.adapter.dispose();
});
test('explicit draft release removes history ownership and adapter cannot resurrect it', async t => {
  const h = await fixture(t); assert.equal(h.runtime.releaseDraft(h.token), true); assert.equal(h.discarded, 1);
  await assert.rejects(h.adapter.openAlbum(id(3)), {name: 'AbortError'}); assert.equal(h.resolutions.length, 0);
  assert.notEqual(h.runtime.snapshot().retainedDraftToken, h.token); h.adapter.dispose();
});
