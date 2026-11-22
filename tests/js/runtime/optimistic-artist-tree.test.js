const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const modulePath = path.join(__dirname, '../../../music_app/static/js/runtime/optimistic-artist-tree.js');
const source = fs.readFileSync(modulePath, 'utf8');

function tree(sidebar, visible = []) {
  const context = {
    state: { view: { artists_sidebar: sidebar }, gallery: { sidebarArtistsOverride: null } },
    getAlbumTrackPaths: (album) => new Set(album?.track_paths || []),
    findVisibleAlbumByTrackPaths: (paths) => visible.find((card) => card.track_paths.some((path) => paths.has(path))),
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: modulePath });
  return {
    apply: (original, updated, kept = false) => context.applyTagEditToArtistTree(original, updated, kept),
    keeps: (album, updates) => context.artistTreeKeepsEditedAlbum(album, updates),
    list: () => context.state.view.artists_sidebar,
    serverTree: (sidebar) => JSON.parse(JSON.stringify(
      context.withPendingArtistTreeEdits(sidebar).map(({ artist, count }) => [artist, count]))),
    settle: (id, options) => context.settleArtistTreeEdit(id, options),
    read: () => JSON.parse(JSON.stringify(context.state.view.artists_sidebar.map(({ artist, count }) => [artist, count]))),
  };
}

const entry = (artist, count) => ({ artist, artist_display: artist, count });

test('FTC-TAGS-040 an album moved to a new artist shows that artist in the tree at Save', () => {
  const view = tree([entry('Alpha', 2), entry('Zulu', 1)]);

  view.apply({ album_artist: 'Alpha' }, [{ album_artist: 'Mike' }]);

  assert.deepEqual(view.read(), [['Alpha', 1], ['Mike', 1], ['Zulu', 1]]);
});

test('an artist whose only album moves leaves the tree, and an existing artist gains it', () => {
  const view = tree([entry('Alpha', 1), entry('Zulu', 1)]);

  view.apply({ album_artist: 'alpha' }, [{ album_artist: 'ZULU' }]);

  assert.deepEqual(view.read(), [['Zulu', 2]]);
});

test('a partial move keeps the source count and adds the destination', () => {
  const view = tree([entry('Alpha', 1)]);

  view.apply({ key: 'a::x', album_artist: 'Alpha' }, [{ key: 'a::x', album_artist: 'Alpha' }, { album_artist: 'Beta' }], true);

  assert.deepEqual(view.read(), [['Alpha', 1], ['Beta', 1]]);
});

test('an edit that keeps the album artist leaves the tree as it was', () => {
  const view = tree([entry('Alpha', 3)]);

  view.apply({ album_artist: 'Alpha' }, [{ album_artist: 'Alpha', name: 'Renamed' }]);

  assert.deepEqual(view.read(), [['Alpha', 3]]);
});

test('FTC-TAGS-040 moving one copy of a twin out keeps the selected artist in the tree', () => {
  // The twin's card lists one copy and carries the marker.
  const twin = { key: 'a::twin', album_artist: 'Alpha', track_paths: ['1', '2'], has_duplicate_files: true };
  const copy = { key: 'a::twin', album_artist: 'Alpha', track_paths: ['1', '2'] };
  const updates = { 1: { album_artist: 'Beta' }, 2: { album_artist: 'Beta' } };
  const view = tree([entry('Alpha', 1)], [twin]);

  const kept = view.keeps(copy, updates);
  view.apply(copy, [{ key: 'b::twin', album_artist: 'Beta' }], kept);

  assert.equal(kept, true);
  assert.deepEqual(view.read(), [['Alpha', 1], ['Beta', 1]]);
});

test('an edit of every file of the card does not keep it', () => {
  const album = { key: 'a::x', album_artist: 'Alpha', track_paths: ['1', '2'] };
  const view = tree([entry('Alpha', 1)], [album]);

  assert.equal(view.keeps(album, { 1: { album: 'Y' }, 2: { album: 'Y' } }), false);
});

test('FTC-TAGS-036 an edit that moves no album between artists keeps the same tree list', () => {
  const sidebar = [entry('Alpha', 2)];
  const view = tree(sidebar);
  const before = view.list();

  view.apply({ key: 'a::x', album_artist: 'Alpha' }, [{ key: 'a::y', album_artist: 'Alpha' }], false);

  assert.equal(view.list(), before);
});

test('FTC-TAGS-040 a tree the server sends while the save is written still shows the move', () => {
  const view = tree([entry('Alpha', 2)]);
  view.apply({ key: 'a::x', album_artist: 'Alpha' }, [{ key: 'm::x', album_artist: 'Mike' }], false);

  assert.deepEqual(view.serverTree([entry('Alpha', 2), entry('Zulu', 1)]), [['Alpha', 1], ['Mike', 1], ['Zulu', 1]]);
});

test('FTC-TAGS-040 a failed save takes its artist back out of the tree', () => {
  const view = tree([entry('Alpha', 2)]);
  const id = view.apply({ key: 'a::x', album_artist: 'Alpha' }, [{ key: 'm::x', album_artist: 'Mike' }], false);

  view.settle(id, { failed: true });

  assert.deepEqual(view.read(), [['Alpha', 2]]);
  assert.deepEqual(view.serverTree([entry('Alpha', 2)]), [['Alpha', 2]]);
});

test('a finished save leaves the trees the server sends afterwards as they are', () => {
  const view = tree([entry('Alpha', 2)]);
  const id = view.apply({ key: 'a::x', album_artist: 'Alpha' }, [{ key: 'm::x', album_artist: 'Mike' }], false);

  view.settle(id);

  assert.deepEqual(view.read(), [['Alpha', 1], ['Mike', 1]]);
  assert.deepEqual(view.serverTree([entry('Alpha', 1), entry('Mike', 1)]), [['Alpha', 1], ['Mike', 1]]);
});
