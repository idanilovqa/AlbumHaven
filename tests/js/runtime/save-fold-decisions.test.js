const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const modulePath = path.join(__dirname, '../../../music_app/static/js/runtime/save-fold-decisions.js');
const source = fs.readFileSync(modulePath, 'utf8');

const card = (name, paths) => ({
  key: `artist::${name.toLowerCase()}`, name, album_artist: 'Artist', track_paths: paths, tracks: [],
});
const album = (name, paths) => ({ ...card(name, paths), tracks: paths.map((trackPath) => ({ path: trackPath })) });

function page({ cards, revision = 7, stored = [] }) {
  const storage = new Map([['albumHaven.savingTagEdits', JSON.stringify(stored)]]);
  const applied = [];
  const context = {
    console, setTimeout, clearTimeout,
    state: { status: { inventory_mutation_revision: revision }, view: {} },
    getLocalStorageItem: (key, fallback) => storage.get(key) ?? fallback,
    setLocalStorageItem: (key, value) => storage.set(key, value),
    fetch: () => Promise.resolve({ ok: true, json: async () => ({ ok: true, albums: [] }) }),
    collectVisibleAlbumsUnique: () => cards,
    getAlbumTrackPaths: (value) => new Set([
      ...(value?.track_paths || []), ...(value?.tracks || []).map((track) => track.path),
    ]),
    buildOptimisticUpdatedAlbumsFromEdits: () => [{ name: 'edited' }],
    applyUpdatedAlbumsToCurrentView: (albums, options) => applied.push(options.tagEdits),
    mergeViewPayload() {}, synchronizeCurrentViewAlbumIndex() {}, showRepairAlert() {}, renderView() {},
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.saveFolds = saveFoldDecisions;`, context, { filename: modulePath });
  const start = (original, updates) => context.saveFolds.start({
    album: original, updates, stillOwns: () => true, render() {},
  });
  return { applied, start, storage, show: () => context.saveFolds.show(), state: context.state };
}

test('FTC-TAGS-015 a render during a partial move does not apply the move again', () => {
  const view = page({ cards: [card('Source', ['2', '3']), card('Destination', ['1'])] });
  view.start(album('Source', ['1', '2', '3']), { 1: { album: 'Destination' } });

  view.show();
  view.show();

  assert.deepEqual(view.applied, []);
});

test('FTC-TAGS-015 a render during a partial move of a card without paths does not apply it again', () => {
  const view = page({ cards: [card('Source', [])] });
  view.start(album('Source', ['1', '2']), { 1: { album: 'Destination' } });

  view.show();

  assert.deepEqual(view.applied, []);
});

test('a view read during a save still shows a partial move whose track is back in its source', () => {
  const view = page({ cards: [card('Source', ['1', '2'])] });
  view.start(album('Source', ['1', '2']), { 1: { album: 'Destination' } });

  view.show();

  assert.equal(view.applied.length, 1);
});

test('FTC-TAGS-041 a page opened during a whole-album rename shows it', () => {
  const updates = { 1: { album: 'Renamed' }, 2: { album: 'Renamed' } };
  const stored = [{ id: 'other', at: Date.now(), revision: 7, album: album('Original', ['1', '2']), updates }];
  const view = page({ cards: [card('Original', [])], revision: 7, stored });

  view.show();

  assert.equal(view.applied.length, 1);
});

test('FTC-TAGS-008 a save another page left behind is not applied once the library moved past it', () => {
  const updates = { 1: { album: 'Renamed' } };
  const stored = [{ id: 'other', at: Date.now(), revision: 7, album: album('Original', ['1']), updates }];
  const view = page({ cards: [card('Original', ['1'])], revision: 8, stored });

  view.show();

  assert.deepEqual(view.applied, []);
});

test('a save in this page outlasts another save committing before it', () => {
  const view = page({ cards: [card('Original', ['1'])], revision: 7 });
  view.start(album('Original', ['1']), { 1: { album: 'Renamed' } });
  view.state.status.inventory_mutation_revision = 8;

  view.show();

  assert.equal(view.applied.length, 1);
});
