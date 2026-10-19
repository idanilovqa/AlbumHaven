'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {load, id, deferred, drain} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const request = {request_key: id(1), playlist_ref: id(2), revision: '7'};
const snapshot = () => ({preview_ref: id(1), source: {playlist_ref: id(2), revision: '7'}, expires_at: '2099-01-01T00:00:00Z', title: 'Source', description: 'Subtitle',
  albums: [{album_ref: id(3), title: 'First', artist: 'Artist', year: 2000}],
  report: [{playlist_item_ref: id(4), position: 1, reason: 'included'}, {playlist_item_ref: id(5), position: 2, reason: 'duplicate'}]});
const receipt = () => ({action: 'create', request_key: id(1), top_ref: id(6), revision: '1'});
async function fixture(overrides = {}) {
  const {createPlaylistTopPreview} = await load('playlists/album-top-preview.mjs');
  const calls = []; let live = true;
  const providers = Object.fromEntries(Object.entries({captureAlbumTopPreview: async () => snapshot(), saveAlbumTopPreview: async () => receipt(), discardAlbumTopPreview: async () => ({}), ...overrides})
    .map(([name, callback]) => [name, (...args) => {calls.push({name, args}); return callback(...args);} ]));
  const owner = createPlaylistTopPreview({providers, scopeKey: 'scope', playlistRef: id(2), sourceRevision: '7', requestKey: id(1), isCurrent: () => live});
  return {owner, calls, retire: () => {live = false;}, revive: () => {live = true;}};
}
test('capture is immutable, ordered and creates no Top before explicit Save', async () => {
  const f = await fixture(); await f.owner.load();
  assert.deepEqual(f.calls.map(x => x.name), ['captureAlbumTopPreview']);
  assert.deepEqual(f.calls[0].args[0], request);
  assert.ok(Object.isFrozen(f.owner.getSnapshot().preview.albums[0]));
  assert.equal(f.owner.getSnapshot().preview.report[1].reason, 'duplicate');
  assert.equal(f.owner.edit({title: ' Changed '}), true);
  await f.owner.save();
  assert.deepEqual(f.calls[1].args[0], {request_key: id(1), playlist_preview_ref: id(1), title: 'Changed', description: 'Subtitle'});
  await f.owner.save(); assert.equal(f.calls.filter(x => x.name === 'saveAlbumTopPreview').length, 1);
  f.owner.dispose(); await drain(); assert.equal(f.calls.filter(x => x.name === 'discardAlbumTopPreview').length, 0);
});
test('reentrant capture and Save share one pending command', async () => {
  const capture = deferred(), save = deferred(), f = await fixture({captureAlbumTopPreview: () => capture.promise, saveAlbumTopPreview: () => save.promise});
  let captureAgain, saveAgain;
  f.owner.subscribe(() => {const s = f.owner.getSnapshot(); if (s.status === 'loading') captureAgain = f.owner.load(); if (s.save.status === 'loading') saveAgain = f.owner.save();});
  const pending = f.owner.load(); assert.equal(pending, captureAgain); capture.resolve(snapshot()); await pending;
  const saving = f.owner.save(); assert.equal(saving, saveAgain); assert.equal(f.owner.canLeave(), false);
  save.resolve(receipt()); await saving; assert.equal(f.calls.filter(x => x.name === 'saveAlbumTopPreview').length, 1); f.owner.dispose();
});
test('uncertain Save freezes exact command through subsequent denial and retry', async () => {
  let n = 0; const f = await fixture({saveAlbumTopPreview: async () => {if (++n === 1) throw new Error('lost response');
    if (n === 2) throw Object.assign(new Error('later denial'), {responseRejected: true, status: 403}); return receipt();}});
  await f.owner.load(); await f.owner.save(); assert.equal(f.owner.getSnapshot().save.status, 'uncertain');
  assert.equal(f.owner.canLeave(), false); assert.equal(f.owner.edit({title: 'replacement'}), false);
  await f.owner.save(); assert.equal(f.owner.getSnapshot().save.status, 'uncertain'); await f.owner.save();
  const commands = f.calls.filter(x => x.name === 'saveAlbumTopPreview').map(x => x.args[0]); assert.equal(commands.length, 3);
  assert.equal(commands[0], commands[1]); assert.equal(commands[1], commands[2]); f.owner.dispose();
});
test('definite first Save rejection permits editing, then Cancel tombstones receipt', async () => {
  const f = await fixture({saveAlbumTopPreview: async () => {throw Object.assign(new Error('invalid'), {responseRejected: true, status: 422});}});
  await f.owner.load(); await f.owner.save(); assert.equal(f.owner.getSnapshot().save.status, 'error'); assert.equal(f.owner.canLeave(), true);
  assert.equal(f.owner.edit({title: 'Corrected'}), true); f.owner.dispose(); await drain();
  assert.equal(f.calls.filter(x => x.name === 'discardAlbumTopPreview').length, 1);
});
for (const phase of ['capture', 'save']) test(`retired scope cannot publish late ${phase} or revive`, async () => {
  const pending = deferred(), f = await fixture(phase === 'capture' ? {captureAlbumTopPreview: () => pending.promise} : {saveAlbumTopPreview: () => pending.promise});
  if (phase === 'save') await f.owner.load();
  const operation = phase === 'save' ? f.owner.save() : f.owner.load(); await Promise.resolve();
  f.retire(); assert.equal(f.owner.isCurrent(), false); f.revive(); pending.resolve(phase === 'save' ? receipt() : snapshot()); await operation;
  assert.equal(f.owner.isCurrent(), false); assert.notEqual(f.owner.getSnapshot()[phase === 'save' ? 'save' : 'status']?.status, 'ready');
  if (phase === 'capture') assert.equal(f.owner.getSnapshot().preview, null); f.owner.dispose();
});
test('empty conversion report cannot save and Cancel remains available', async () => {
  const f = await fixture({captureAlbumTopPreview: async () => ({...snapshot(), albums: [], report: [{playlist_item_ref: id(4), position: 1, reason: 'unresolved'}]})});
  await f.owner.load(); assert.equal(await f.owner.save(), null); assert.equal(f.owner.canLeave(), true); f.owner.dispose();
});
for (const mutate of [x => {x.source.revision = '8';}, x => {x.albums.push({...x.albums[0]});}, x => {x.report[1].position = 1;}, x => {x.report[0].reason = 'invented';}])
  test('malformed source evidence is rejected', async () => {const {projectPlaylistTopPreview} = await load('playlists/album-top-preview.mjs'); const x = snapshot(); mutate(x); assert.throws(() => projectPlaylistTopPreview(x, request));});
module.exports = {snapshot, request, receipt};
for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029', ' ']) test(`exact preview scalars reject trailing ${JSON.stringify(suffix)}`, async () => {
  const {projectPlaylistTopPreview, createPlaylistTopPreview, isPlaylistTopPreviewRef, isPlaylistTopPreviewRevision} = await load('playlists/album-top-preview.mjs');
  assert.equal(isPlaylistTopPreviewRef(id(1) + suffix), false); assert.equal(isPlaylistTopPreviewRevision('7' + suffix), false);
  for (const field of ['album', 'item', 'preview', 'source']) {
    const value = snapshot();
    if (field === 'album') value.albums[0].album_ref += suffix;
    if (field === 'item') value.report[0].playlist_item_ref += suffix;
    if (field === 'preview') value.preview_ref += suffix;
    if (field === 'source') value.source.revision += suffix;
    assert.throws(() => projectPlaylistTopPreview(value, request));
  }
  assert.throws(() => createPlaylistTopPreview({providers: {}, scopeKey: 's', playlistRef: id(2), sourceRevision: '7' + suffix, requestKey: id(1), isCurrent: () => true}));
});
test('canonical scalar predicates reject padding, case, zero and signed-bigint overflow', async () => {
  const {isPlaylistTopPreviewRef: ref, isPlaylistTopPreviewRevision: revision} = await load('playlists/album-top-preview.mjs');
  for (const value of [' 7', '07', '+7', '-1', '0', '', '9223372036854775808', '10000000000000000000']) assert.equal(revision(value), false);
  assert.equal(revision('9223372036854775807'), true);
  assert.equal(ref('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'.toUpperCase()), false);
  assert.equal(ref(' ' + id(1)), false);
});
for (const field of ['top_ref', 'revision']) test(`malformed acknowledged Save ${field} cannot navigate`, async () => {
  const f = await fixture({saveAlbumTopPreview: async () => {const value = receipt(); value[field] += '\n'; return value;}});
  await f.owner.load(); assert.equal(await f.owner.save(), null); assert.equal(f.owner.getSnapshot().save.status, 'uncertain'); f.owner.dispose();
});
