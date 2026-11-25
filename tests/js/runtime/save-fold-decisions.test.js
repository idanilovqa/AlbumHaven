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

function page({ cards, revision = 7, stored = [], overrides = {} }) {
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
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.saveFolds = saveFoldDecisions;`, context, { filename: modulePath });
  const start = (original, updates) => context.saveFolds.start({
    album: original, updates, stillOwns: () => true, render() {},
  });
  return { applied, start, storage, show: () => context.saveFolds.show(), state: context.state, context };
}

test('FTC-TAGS-038 a finished save keeps its fold over a view the library has not folded yet', async () => {
  // The save's completion refresh can read the copy as its own card before the library folds the pair;
  // the fold the save showed must not go back for that frame, until a view holds the fold itself.
  const twin = card('Twin', ['t1']);
  const copy = card('Copy', ['c1']);
  const decision = { ok: true, albums: [{
    album_key: copy.key, track_paths: ['c1'], folds_into_key: twin.key, folds_into: ['t1'],
  }] };
  const view = page({ cards: [], overrides: {
    fetch: () => Promise.resolve({ ok: true, json: async () => decision }),
  } });
  const groups = () => [{ artist: 'Artist', albums: [twin, copy] }];
  view.state.view = { artist_groups: groups() };
  view.context.mergeViewPayload = (patch) => Object.assign(view.state.view, patch);
  const save = view.start(album('Copy', ['c1']), { c1: { album: 'Twin' } });
  save.follow();
  await new Promise((resolve) => setImmediate(resolve));
  const shownAlbums = () => view.state.view.artist_groups.flatMap((group) => group.albums.map((item) => item.name));
  assert.deepEqual(shownAlbums(), ['Twin']);

  save.finish();
  view.state.view = { artist_groups: groups() };
  view.show();
  assert.deepEqual(shownAlbums(), ['Twin'], 'the completion refresh does not bring the folded copy back');
  assert.equal(JSON.parse(view.storage.get('albumHaven.savingTagEdits')).length, 0, 'nothing is left stored');

  view.state.view = { artist_groups: [{ artist: 'Artist', albums: [twin] }] };
  view.show();
  view.state.view = { artist_groups: groups() };
  view.show();
  assert.deepEqual(shownAlbums(), ['Twin', 'Copy'], 'once a view holds the fold, the library owns it again');
});

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
