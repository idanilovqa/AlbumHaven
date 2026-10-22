'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {load, id, deferred} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const command = {request_key: id(1), playlist_ref: id(2), revision: '1'};
const preview = () => ({preview_ref: id(1), source: {playlist_ref: id(2), revision: '1'}, expires_at: '2099-01-01T00:00:00Z', title: 'Source', description: '',
  albums: [{album_ref: id(3), title: 'Album', artist: 'Artist', year: null}], report: [{playlist_item_ref: id(4), position: 1, reason: 'included'}]});
async function fixture(reply) {
  const {createPlaylistBackendProviders} = await load('playlists/backend-providers.mjs'); let context = 'context', scope = 'scope'; const calls = [], listeners = new Set();
  const transport = {context: () => context, subscribe: fn => {listeners.add(fn); return () => listeners.delete(fn);},
    request: async (path, options) => {calls.push({path, options}); return {status: 'ready', context_ref: context, data: await reply(path, options)};}};
  const providers = createPlaylistBackendProviders({transport, runtime: {acceptsPrivateScope: value => value === scope}});
  return {providers, calls, change: () => {context = 'new'; scope = 'new'; for (const fn of listeners) fn();}, listeners};
}
test('capture and Save use exact receipt contracts and no inferred membership', async () => {
  const f = await fixture(path => path === '/album-tops' ? {action: 'create', request_key: id(1), top_ref: id(6), revision: '1'} : preview());
  const p = await f.providers.captureAlbumTopPreview(command, {scopeKey: 'scope'});
  assert.equal(p.preview_ref, id(1)); assert.deepEqual(f.calls[0], {path: `/album-tops/playlist-previews/${id(2)}`, options: {signal: undefined, expected: 'context', method: 'POST', body: {request_key: id(1), revision: '1'}}});
  const save = {request_key: id(1), playlist_preview_ref: id(1), title: 'New', description: ''};
  await f.providers.saveAlbumTopPreview(save, {scopeKey: 'scope'}); assert.equal(f.calls[1].path, '/album-tops'); assert.deepEqual(f.calls[1].options.body, save);
  await assert.rejects(f.providers.saveAlbumTopPreview({...save, album_refs: [id(3)]}, {scopeKey: 'scope'})); assert.equal(f.calls.length, 2);
  f.providers.dispose(); assert.equal(f.listeners.size, 0);
});
test('details binds receipt, canonical member and exact source revision, granting no playback', async () => {
  const data = {preview_ref: id(1), album_ref: id(3), source: {playlist_ref: id(2), revision: '1'}, native_target: {album_ref: 'current-native-key', allowed_actions: {can_view_details: true, can_play_album: false}}};
  const f = await fixture(() => data), result = await f.providers.resolveAlbumTopPreview(preview(), id(3), {scopeKey: 'scope'});
  assert.deepEqual(result, {album_ref: 'current-native-key', allowed_actions: {can_open_album: true, can_play_album: false}});
  assert.equal(f.calls[0].path, `/album-tops/playlist-previews/${id(1)}/albums/${id(3)}/native-target`);
  data.source.revision = '2'; await assert.rejects(f.providers.resolveAlbumTopPreview(preview(), id(3), {scopeKey: 'scope'}));
  await assert.rejects(f.providers.resolveAlbumTopPreview(preview(), id(99), {scopeKey: 'scope'})); assert.equal(f.calls.length, 2); f.providers.dispose();
});
test('late authenticated capture cannot cross context replacement', async () => {
  const pending = deferred(), f = await fixture(() => pending.promise);
  const result = f.providers.captureAlbumTopPreview(command, {scopeKey: 'scope'}); f.change(); pending.resolve(preview());
  await assert.rejects(result, {name: 'AbortError'}); f.providers.dispose();
});
for (const suffix of ['\n', '\r', '\u2028', ' ']) test(`new provider actions reject malformed scalars before transport ${JSON.stringify(suffix)}`, async () => {
  const f = await fixture(() => preview()), options = {scopeKey: 'scope'};
  await assert.rejects(f.providers.captureAlbumTopPreview({...command, request_key: id(1) + suffix}, options));
  await assert.rejects(f.providers.captureAlbumTopPreview({...command, revision: '1' + suffix}, options));
  await assert.rejects(f.providers.discardAlbumTopPreview(id(1) + suffix, options));
  await assert.rejects(f.providers.saveAlbumTopPreview({request_key: id(1) + suffix, playlist_preview_ref: id(1) + suffix, title: 'T', description: ''}, options));
  await assert.rejects(f.providers.resolveAlbumTopPreview(preview(), id(3) + suffix, options));
  assert.equal(f.calls.length, 0); f.providers.dispose();
});
