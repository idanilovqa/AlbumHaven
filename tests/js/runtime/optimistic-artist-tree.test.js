const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const modulePath = path.join(__dirname, '../../../music_app/static/js/runtime/optimistic-artist-tree.js');
const source = fs.readFileSync(modulePath, 'utf8');

function tree(sidebar) {
  const context = { state: { view: { artists_sidebar: sidebar }, gallery: { sidebarArtistsOverride: null } } };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: modulePath });
  return {
    apply: (original, updated) => context.applyTagEditToArtistTree(original, updated),
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

  view.apply({ album_artist: 'Alpha' }, [{ album_artist: 'Alpha' }, { album_artist: 'Beta' }]);

  assert.deepEqual(view.read(), [['Alpha', 1], ['Beta', 1]]);
});

test('an edit that keeps the album artist leaves the tree as it was', () => {
  const view = tree([entry('Alpha', 3)]);

  view.apply({ album_artist: 'Alpha' }, [{ album_artist: 'Alpha', name: 'Renamed' }]);

  assert.deepEqual(view.read(), [['Alpha', 3]]);
});
