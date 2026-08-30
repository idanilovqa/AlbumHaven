const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'gallery-display-preference-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelper(overrides = {}) {
  const storage = new Map();
  const context = {
    state: {
      view: {},
      gallery: {
        combineSimilarArtistsByArtist: {},
        displayPreferences: {
          defaultGalleryDisplayMode: 'cards',
          defaultGalleryScalePercent: 100,
        },
      },
    },
    persistCombineSimilarArtistsPreferences: () => {
      const value = JSON.stringify(context.state.gallery.combineSimilarArtistsByArtist || {});
      storage.set('albumhaven.combineSimilarArtists.v1', value);
      return true;
    },
    persistGalleryDisplayPreferences: () => {
      const value = JSON.stringify(context.state.gallery.displayPreferences || {});
      storage.set('albumhaven.galleryDisplayPreferences.v1', value);
      return true;
    },
    setLocalStorageItem: (key, value) => {
      storage.set(key, value);
      return true;
    },
    console,
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, storage };
}

{
  const { context } = loadHelper();
  assert.equal(context.normalizeArtistPreferenceKey('  Broadcast  '), 'Broadcast');
  assert.equal(context.looksLikeCombinedArtistName('Alice & Bob'), true);
  assert.equal(context.looksLikeCombinedArtistName('Broadcast'), false);
  assert.equal(context.combinedArtistSignature('Alice and Bob'), 'alice bob');
}

{
  const { context, storage } = loadHelper();
  context.setCombineSimilarArtistsPreference('Alice & Bob', true);

  assert.equal(context.getCombineSimilarArtistsPreference('Alice & Bob'), true);
  assert.equal(
    storage.get('albumhaven.combineSimilarArtists.v1'),
    JSON.stringify({ 'Alice & Bob': true }),
  );
}

{
  const { context } = loadHelper();
  const resolved = JSON.parse(JSON.stringify(context.resolveGalleryDisplayPreferenceViewState({
    gallery_display_mode: 'cards',
    gallery_scale_percent: 100,
  })));
  assert.deepEqual(resolved, {
    gallery_display_mode: 'cards',
    gallery_scale_percent: 100,
  });
}

{
  const { context } = loadHelper({
    state: {
      view: {},
      gallery: {
        combineSimilarArtistsByArtist: {},
        displayPreferences: {
          defaultGalleryDisplayMode: 'covers',
          defaultGalleryScalePercent: 135,
        },
      },
    },
  });
  const resolved = JSON.parse(JSON.stringify(context.resolveGalleryDisplayPreferenceViewState({
    gallery_display_mode: 'cards',
    gallery_scale_percent: 100,
  }, {
    hasExplicitGalleryDisplayOverride: false,
    hasExplicitGalleryScaleOverride: false,
  })));
  assert.deepEqual(resolved, {
    gallery_display_mode: 'covers',
    gallery_scale_percent: 135,
  });
}

{
  const { context } = loadHelper({
    state: {
      view: {},
      gallery: {
        combineSimilarArtistsByArtist: {},
        displayPreferences: {
          defaultGalleryDisplayMode: 'covers',
          defaultGalleryScalePercent: 135,
        },
      },
    },
  });
  const resolved = JSON.parse(JSON.stringify(context.resolveGalleryDisplayPreferenceViewState({
    gallery_display_mode: 'list',
    gallery_scale_percent: 80,
  }, {
    hasExplicitGalleryDisplayOverride: true,
    hasExplicitGalleryScaleOverride: true,
  })));
  assert.deepEqual(resolved, {
    gallery_display_mode: 'list',
    gallery_scale_percent: 80,
  });
}

{
  const { context, storage } = loadHelper();
  context.persistCurrentGalleryDisplayPreferences({
    gallery_display_mode: 'covers',
    gallery_scale_percent: 140,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(context.state.gallery.displayPreferences)), {
    defaultGalleryDisplayMode: 'covers',
    defaultGalleryScalePercent: 140,
  });
  assert.equal(
    storage.get('albumhaven.galleryDisplayPreferences.v1'),
    JSON.stringify({
      defaultGalleryDisplayMode: 'covers',
      defaultGalleryScalePercent: 140,
    }),
  );
}

{
  const { context } = loadHelper({
    state: {
      view: {
        selected_artist: '',
        primary_artist_groups: [{ artist: 'Broadcast' }],
        family_artist_groups: [],
        artist_groups: [],
      },
      gallery: {
        combineSimilarArtistsByArtist: {},
      },
    },
  });

  assert.equal(context.getCurrentGalleryPreferenceArtist(), 'Broadcast');
}

{
  const { context } = loadHelper();
  const groups = JSON.parse(JSON.stringify(context.buildDisplayGroups([
    {
      artist: 'Alice & Bob',
      artist_display: 'Alice & Bob',
      albums: [
        { album_artist: 'Alice & Bob', name: 'Collab' },
        { album_artist: 'Alice', name: 'Solo Alice' },
        { album_artist: 'Bob', name: 'Solo Bob' },
      ],
    },
  ])));

  assert.deepEqual(groups, [
    {
      artist: 'Alice & Bob',
      artist_display: 'Alice & Bob',
      albums: [{ album_artist: 'Alice & Bob', name: 'Collab' }],
      display_artist_key: 'Alice & Bob::Alice & Bob',
    },
    {
      artist: 'Alice',
      artist_display: 'Alice',
      albums: [{ album_artist: 'Alice', name: 'Solo Alice' }],
      display_artist_key: 'Alice & Bob::Alice',
    },
    {
      artist: 'Bob',
      artist_display: 'Bob',
      albums: [{ album_artist: 'Bob', name: 'Solo Bob' }],
      display_artist_key: 'Alice & Bob::Bob',
    },
  ]);
}

{
  const { context } = loadHelper();
  const repeatedArtist = 'Frank Churchill / Leigh Harline / Larry Morey / Frank Churchill / Larry Morey';
  const groups = JSON.parse(JSON.stringify(context.buildDisplayGroups([{
    artist: repeatedArtist,
    artist_display: repeatedArtist,
    albums: [{ album_artist: repeatedArtist, name: 'Snow White And The Seven Dwarfs' }],
  }])));

  assert.equal(groups[0].artist, repeatedArtist);
  assert.equal(groups[0].artist_display, 'Frank Churchill / Leigh Harline / Larry Morey');
}

{
  const { context } = loadHelper({
    state: {
      view: {},
      gallery: {
        combineSimilarArtistsByArtist: {
          'Neal Morse': true,
        },
      },
    },
  });
  const groups = JSON.parse(JSON.stringify(context.buildSelectedArtistDisplayGroups(
    [{
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      albums: [
        { key: 'neal-1', album_artist: 'Neal Morse', name: 'One', year: 2004 },
      ],
    }],
    [{
      artist: 'Neal Morse & The Resonance',
      artist_display: 'Neal Morse & The Resonance',
      albums: [
        { key: 'resonance-1', album_artist: 'Neal Morse & The Resonance', name: 'No Hill For A Climber', year: 2024 },
      ],
    }, {
      artist: 'The Neal Morse Band',
      artist_display: 'The Neal Morse Band',
      albums: [
        { key: 'band-1', album_artist: 'The Neal Morse Band', name: 'The Grand Experiment', year: 2015 },
      ],
    }],
    'Neal Morse',
  )));

  assert.deepEqual(groups, {
    primaryGroups: [{
      artist: 'Neal Morse',
      artist_display: 'Neal Morse / Neal Morse & The Resonance',
      display_artist_key: 'Neal Morse::merged::Neal Morse & The Resonance',
      albums: [
        { key: 'neal-1', album_artist: 'Neal Morse', name: 'One', year: 2004 },
        { key: 'resonance-1', album_artist: 'Neal Morse & The Resonance', name: 'No Hill For A Climber', year: 2024 },
      ],
    }],
    familyGroups: [{
      artist: 'The Neal Morse Band',
      artist_display: 'The Neal Morse Band',
      albums: [
        { key: 'band-1', album_artist: 'The Neal Morse Band', name: 'The Grand Experiment', year: 2015 },
      ],
    }],
  });
}

{
  const { context } = loadHelper();
  const resonanceAlbum = {
    key: 'resonance-1',
    album_artist: 'Neal Morse & The Resonance',
    name: 'No Hill For A Climber',
    year: 2024,
  };
  const groups = JSON.parse(JSON.stringify(context.buildSelectedArtistDisplayGroups(
    [{
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      albums: [
        { key: 'neal-1', album_artist: 'Neal Morse', name: 'One', year: 2004 },
        resonanceAlbum,
      ],
    }],
    [{
      artist: 'Neal Morse & The Resonance',
      artist_display: 'Neal Morse & The Resonance',
      albums: [resonanceAlbum],
    }],
    'Neal Morse',
  )));

  assert.deepEqual(groups, {
    primaryGroups: [{
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      albums: [
        { key: 'neal-1', album_artist: 'Neal Morse', name: 'One', year: 2004 },
      ],
    }],
    familyGroups: [{
      artist: 'Neal Morse & The Resonance',
      artist_display: 'Neal Morse & The Resonance',
      albums: [resonanceAlbum],
    }],
  });
}

{
  const { context } = loadHelper();
  const groups = JSON.parse(JSON.stringify(context.buildDisplayGroups([
    {
      artist: 'Morse Portnoy George',
      artist_display: 'Morse Portnoy George / Morse, Portnoy & George',
      albums: [
        { album_artist: 'Morse Portnoy George', name: 'Cover 2 Cover' },
        { album_artist: 'Morse, Portnoy & George', name: 'Songs from November' },
      ],
    },
  ])));

  assert.deepEqual(groups, [
    {
      artist: 'Morse Portnoy George',
      artist_display: 'Morse Portnoy George / Morse, Portnoy & George',
      albums: [
        { album_artist: 'Morse Portnoy George', name: 'Cover 2 Cover' },
        { album_artist: 'Morse, Portnoy & George', name: 'Songs from November' },
      ],
      display_artist_key: 'Morse Portnoy George',
    },
  ]);
}
