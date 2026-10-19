'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {load, id, nativeEnvironment, drain, deferred} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
async function page(overrides = {}) {
  const env = nativeEnvironment(), {createPlaylistTopPreview} = await load('playlists/album-top-preview.mjs'), {mountPlaylistAlbumTopPreview} = await load('playlists/native-album-top-preview.mjs');
  const calls = [], providers = {captureAlbumTopPreview: async () => ({preview_ref: id(1), source: {playlist_ref: id(2), revision: '1'}, expires_at: '2099-01-01T00:00:00Z', title: 'Source', description: '',
    albums: [{album_ref: id(3), title: 'First', artist: 'Artist', year: 2001}], report: [{playlist_item_ref: id(4), position: 1, reason: 'included'}, {playlist_item_ref: id(5), position: 2, reason: 'duplicate'}]}),
    saveAlbumTopPreview: async command => {calls.push(['save', command]); return {action: 'create', request_key: id(1), top_ref: id(6), revision: '1'};}, discardAlbumTopPreview: async () => {calls.push(['discard']);}, ...overrides};
  const controller = createPlaylistTopPreview({providers, scopeKey: 's', playlistRef: id(2), sourceRevision: '1', requestKey: id(1), isCurrent: () => true});
  const owner = mountPlaylistAlbumTopPreview(env.host, env.runtime, {token: id(1), controller, onClose: () => {calls.push(['close']);}, onSaved: value => {calls.push(['saved', value]); return false;}, onOpenAlbum: ref => {calls.push(['open', ref]); return true;}});
  await controller.load(); return {...env, controller, owner, calls, dispose() {owner.dispose(); controller.dispose();}};
}
test('actual Selected picker renders immutable report with no selection, reorder or completion', async () => {
  const env = await page();
  try {
    assert.match(env.host.textContent, /Duplicate album, included once/); assert.match(env.host.textContent, /This Top is unsaved/);
    assert.equal(env.host.querySelector('[data-in-page-tab="all"]'), null);
    for (const selector of ['[data-gallery-card-intent="select"]', '[data-album-draft-move]', '[data-album-draft-remove]', '[data-gallery-card-intent="complete"]']) assert.equal(env.host.querySelector(selector), null);
    assert.equal(env.calls.length, 0);
    env.click(env.host.querySelector('[data-gallery-card-intent="open"]')); await drain();
    assert.deepEqual(env.calls, [['open', id(3)]]);
    env.input(env.host.querySelector('[aria-label="Album Top name"]'), 'New Top');
    env.click(env.button(env.host, 'Save')); await drain();
    assert.equal(env.calls.filter(x => x[0] === 'save').length, 1); assert.equal(env.calls.find(x => x[0] === 'save')[1].title, 'New Top');
    env.click(env.button(env.host, 'Open saved Top')); await drain(); assert.equal(env.calls.filter(x => x[0] === 'save').length, 1);
  } finally {env.dispose();} env.assertClean();
});
test('pending Save disables metadata, Cancel and Album Details', async () => {
  const pending = deferred(), env = await page({saveAlbumTopPreview: () => pending.promise});
  try {
    env.click(env.button(env.host, 'Save')); await drain();
    assert.equal(env.button(env.host, 'Cancel').disabled, true); assert.equal(env.host.querySelector('input').disabled, true);
    assert.equal(env.host.querySelector('[data-gallery-card-intent="open"]').disabled, true);
    pending.resolve({action: 'create', request_key: id(1), top_ref: id(6), revision: '1'}); await drain();
  } finally {env.dispose();} env.assertClean();
});
test('detached input cannot mutate retired page and repeat dispose is harmless', async () => {
  const env = await page(), input = env.host.querySelector('[aria-label="Album Top name"]');
  env.owner.dispose(); input.value = 'Detached'; input.dispatchEvent(new env.context.Event('input', {bubbles: true}));
  assert.equal(env.controller.getSnapshot().title, 'Source'); env.dispose(); assert.equal(env.host.children.length, 0); env.assertClean();
});
