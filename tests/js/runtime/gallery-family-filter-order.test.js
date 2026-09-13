const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const primaryArtist = 'Neal Morse';
const aliasArtist = 'Neal Morse & The Resonance';
const otherArtist = 'Cosmic Cathedral';

function createContext(mode = 'grouped') {
  const group = (artist, key, year) => ({
    artist,
    albums: [{ key, name: key, album_artist: artist, year }],
  });
  const primary = group(primaryArtist, 'solo', 2020);
  const alias = group(aliasArtist, 'resonance', 2024);
  const other = group(otherArtist, 'cosmic', 2025);
  const context = vm.createContext({
    state: {
      view: {
        selected_artist: primaryArtist,
        selected_artist_family_display_mode: mode,
        related_artists: [aliasArtist, otherArtist],
        primary_artist_groups: [primary],
        family_artist_groups: [alias, other],
        artist_groups: [primary, alias, other],
      },
      gallery: { combineSimilarArtistsByArtist: { [primaryArtist]: true } },
    },
  });
  for (const file of ['gallery-main-state.js', 'gallery-display-preference-helpers.js', 'gallery-main-interactions.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime', file), 'utf8'), context, { filename: file });
  }
  return context;
}

function select(context, artists) {
  context.state.gallery.mainState = context.createGalleryMainState({
    familyArtists: artists,
    familySelectionExplicit: true,
  });
  return context.getFilteredGalleryMainModel();
}

function albumKeys(groups) {
  return Array.from(groups.flatMap(group => group.albums.map(album => album.key))).sort();
}

test('partial family selection survives real alias combining without including deselected artists', () => {
  const context = createContext();
  const model = select(context, [primaryArtist, aliasArtist]);
  assert.equal(model.groups.length, 1);
  assert.equal(model.groups[0].artist_display, `${primaryArtist} / ${aliasArtist}`);
  assert.deepEqual(albumKeys(model.groups), ['resonance', 'solo']);
  assert.equal(model.totals.albumCount, 2);
  assert.deepEqual(albumKeys(select(context, [primaryArtist]).groups), ['solo']);
  assert.deepEqual(albumKeys(select(context, [aliasArtist]).groups), ['resonance']);
  assert.equal(context.state.view.family_artist_groups.length, 2, 'selection must not remove source family data');
});

test('chronological view sends only selected original artists to its fallback renderer', () => {
  const context = createContext('chronological');
  const model = select(context, [aliasArtist, otherArtist]);
  assert.equal(model.primaryGroups.length, 0);
  assert.equal(model.familyGroups.length, 0);
  assert.deepEqual(albumKeys(model.fallbackGroups), ['cosmic', 'resonance']);
  assert.deepEqual(albumKeys(model.groups), ['cosmic', 'resonance']);
  assert.equal(model.totals.albumCount, 2);
  assert.deepEqual(albumKeys(select(context, [primaryArtist]).fallbackGroups), ['solo']);
});

for (const mode of ['grouped', 'chronological']) {
  test(`${mode} explicit empty selection stays empty and selecting again restores albums`, () => {
    const context = createContext(mode);
    const empty = select(context, []);
    assert.equal(empty.groups.length, 0);
    assert.equal(empty.totals.albumCount, 0);
    assert.deepEqual(albumKeys(select(context, [primaryArtist, aliasArtist, otherArtist]).groups), ['cosmic', 'resonance', 'solo']);
  });
}
