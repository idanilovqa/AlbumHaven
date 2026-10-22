'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./sample-origin-fixtures.cjs');
const {modalFixture} = require('./sample-origin-modal-fixtures.cjs');
let captureTop;
test.before(async () => ({captureAlbumTopSampleOrigin: captureTop} = await import('../../../music_app/static/js/playlists/sample-playlist-origins.mjs')));
for (const kind of ['saved_top', 'draft']) test(`empty canonical ${kind} disables the initiating Sample action`, () => {
  const state = F.topState(); state.detail.data.items = [];
  const controller = {getSnapshot: () => state};
  const input = {controller, libraryRef: '5', isCurrent: () => true,
    returnToOrigin: () => {throw new Error('Empty source must not navigate');}};
  if (kind === 'draft') input.draft = {getSnapshot: () => F.draftState([])};
  assert.equal(captureTop(input), null);
});
test('empty physical canonical release does not manufacture track or album authority', () => {
  const h = modalFixture();
  h.c.openTrackModal({key: 'alpha', request_key: 'actual:alpha', name: 'Empty', source_readable: true,
    allowed_actions: {can_read: true, can_play_album: false}, tracks: []});
  assert.equal(h.capturePhysical(), null);
});
test('empty current loose-track collection disables Sample instead of falling back to library rows', () => {
  const h = modalFixture();
  h.c.state.view = {non_album_tracks: [], albums: []};
  h.c.openNonAlbumModal();
  assert.equal(h.captureLoose(), null);
});
