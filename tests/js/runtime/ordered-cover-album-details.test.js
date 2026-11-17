const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(
  __dirname,
  '../../../music_app/static/js/runtime/tag-editor-and-optimistic-updates.js',
);

function loadRuntime() {
  const album = {
    key: 'album-1',
    selected_covers_loaded: true,
    selected_covers: [
      { selection_id: 'front', image_url: '/cover?selection_id=front' },
      { selection_id: 'back', image_url: '/cover?selection_id=back' },
      { selection_id: 'insert', unavailable: true },
    ],
  };
  const context = {
    Intl,
    state: { ui: {}, modalReleases: [album], modalReleaseIndex: 0 },
    console,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  const renders = [];
  context.getCurrentTrackModalAlbum = () => album;
  context.getTrackModalAlbumRequestKey = (value) => value?.key || '';
  context.resolveAlbumDetailsCoverSlots = (value) => value.selected_covers.map((slot) => ({
    selectionId: slot.selection_id,
    imageUrl: slot.image_url || '',
    unavailable: slot.unavailable === true || !slot.image_url,
  }));
  context.renderTrackModalRelease = (value, options) => renders.push([value.key, options]);
  context.syncMobileAlbumComposition = () => {};
  return { album, context, renders };
}

test('Album Details cover browsing wraps without changing saved order', () => {
  const { album, context, renders } = loadRuntime();
  const savedOrder = album.selected_covers.map((slot) => slot.selection_id);

  assert.equal(context.browseTrackModalSelectedCover(1), true);
  assert.equal(context.getTrackModalSelectedCoverIndex(album), 1);
  assert.equal(context.browseTrackModalSelectedCover(-1), true);
  assert.equal(context.getTrackModalSelectedCoverIndex(album), 0);
  assert.equal(context.browseTrackModalSelectedCover(-1), true);
  assert.equal(context.getTrackModalSelectedCoverIndex(album), 2);
  assert.deepEqual(album.selected_covers.map((slot) => slot.selection_id), savedOrder);
  assert.deepEqual(JSON.parse(JSON.stringify(renders)), [
    ['album-1', { coverOnly: true, coverShuffle: 1 }],
    ['album-1', { coverOnly: true, coverShuffle: -1 }],
    ['album-1', { coverOnly: true, coverShuffle: -1 }],
  ]);
});

test('rear-cover activation selects its exact saved slot and different albums default to primary', () => {
  const { album, context } = loadRuntime();

  assert.equal(context.browseTrackModalSelectedCover(1, { absolute: true }), true);
  assert.equal(context.getTrackModalSelectedCoverIndex(album), 1);
  assert.equal(context.getTrackModalSelectedCoverIndex({ ...album, key: 'album-2' }), 0);
});

test('an available rear cover remains selectable when the active saved slot is unavailable', () => {
  const { album, context } = loadRuntime();
  album.selected_covers = [
    { selection_id: 'missing', unavailable: true },
    { selection_id: 'front', image_url: '/cover?selection_id=front' },
  ];

  assert.equal(context.browseTrackModalSelectedCover(1, { absolute: true }), true);
  assert.equal(context.getTrackModalSelectedCoverIndex(album), 1);
});
