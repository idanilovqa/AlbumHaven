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
  'client-preferences-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelper(overrides = {}) {
  const storage = new Map();
  const context = {
    state: {
      gallery: {
        combineSimilarArtistsByArtist: {},
      },
      player: {
        appearance: {
          seekbarMode: 'default',
          waveformFillColor: '#5b8f8e',
          waveformEdgeColor: '#c8ddd5',
        },
      },
    },
    getLocalStorageItem: (key) => (storage.has(key) ? storage.get(key) : ''),
    setLocalStorageItem: (key, value) => {
      storage.set(key, value);
      return true;
    },
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, storage };
}

{
  const { context } = loadHelper();
  assert.deepEqual(JSON.parse(JSON.stringify(context.getDefaultPlayerAppearance())), {
    seekbarMode: 'default',
    waveformFillColor: '#dadde2',
    waveformEdgeColor: '#494950',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizePlayerAppearance({
    seekbarMode: 'waveform',
    waveformFillColor: '#123456',
    waveformEdgeColor: '#abcdef',
  }))), {
    seekbarMode: 'waveform',
    waveformFillColor: '#123456',
    waveformEdgeColor: '#abcdef',
  });
}

{
  const { context } = loadHelper();
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizePlayerAppearance({
    seekbarMode: 'invalid',
    waveformFillColor: 'nope',
    waveformEdgeColor: '#fff',
  }))), {
    seekbarMode: 'default',
    waveformFillColor: '#dadde2',
    waveformEdgeColor: '#494950',
  });
}

{
  const { context } = loadHelper();
  assert.deepEqual(JSON.parse(JSON.stringify(context.getDefaultGalleryDisplayPreferences())), {
    defaultGalleryDisplayMode: 'cards',
    defaultGalleryScalePercent: 100,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.getDefaultGalleryPlaybackPreferences())), {
    albumTopsEndBehavior: 'continue',
    artistPagesEndBehavior: 'stop',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.getDefaultShellLayoutPreferences())), {
    contextualPaneWidthPx: 320,
    infoDrawerWidthPx: 360,
  });
  assert.equal(context.getDefaultAlbumOpenMode(), 'modal');
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeGalleryDisplayPreferences({
    defaultGalleryDisplayMode: 'list',
    defaultGalleryScalePercent: 135,
  }))), {
    defaultGalleryDisplayMode: 'list',
    defaultGalleryScalePercent: 135,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeGalleryPlaybackPreferences({
    albumTopsEndBehavior: 'stop',
    artistPagesEndBehavior: 'continue',
  }))), {
    albumTopsEndBehavior: 'stop',
    artistPagesEndBehavior: 'continue',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeShellLayoutPreferences({
    contextualPaneWidthPx: 280,
    infoDrawerWidthPx: 420,
  }))), {
    contextualPaneWidthPx: 280,
    infoDrawerWidthPx: 420,
  });
  assert.equal(context.normalizeAlbumOpenMode('page'), 'page');
}

{
  const { context } = loadHelper();
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeGalleryDisplayPreferences({
    defaultGalleryDisplayMode: 'nope',
    defaultGalleryScalePercent: 999,
  }))), {
    defaultGalleryDisplayMode: 'cards',
    defaultGalleryScalePercent: 100,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeGalleryPlaybackPreferences({
    albumTopsEndBehavior: 'later',
    artistPagesEndBehavior: 'nope',
  }))), {
    albumTopsEndBehavior: 'continue',
    artistPagesEndBehavior: 'stop',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeShellLayoutPreferences({
    contextualPaneWidthPx: 10,
    infoDrawerWidthPx: 9999,
  }))), {
    contextualPaneWidthPx: 320,
    infoDrawerWidthPx: 360,
  });
  assert.equal(context.normalizeAlbumOpenMode('sideways'), 'modal');
}

{
  const { context, storage } = loadHelper();
  context.state.gallery.combineSimilarArtistsByArtist = { Broadcast: true };
  context.persistCombineSimilarArtistsPreferences();
  context.persistPlayerAppearance();
  context.state.gallery.displayPreferences = {
    defaultGalleryDisplayMode: 'covers',
    defaultGalleryScalePercent: 135,
  };
  context.state.gallery.playbackPreferences = {
    albumTopsEndBehavior: 'stop',
    artistPagesEndBehavior: 'continue',
  };
  context.state.gallery.albumOpenMode = 'page';
  context.state.ui.shellLayoutPreferences = {
    contextualPaneWidthPx: 280,
    infoDrawerWidthPx: 420,
  };
  context.persistGalleryDisplayPreferences();
  context.persistGalleryPlaybackPreferences();
  context.persistAlbumOpenMode();
  context.persistShellLayoutPreferences();

  assert.equal(storage.get('albumhaven.combineSimilarArtists.v1'), JSON.stringify({ Broadcast: true }));
  assert.equal(storage.get('albumhaven.playerAppearance.v1'), JSON.stringify(context.state.player.appearance));
  assert.equal(
    storage.get('albumhaven.galleryDisplayPreferences.v1'),
    JSON.stringify({
      defaultGalleryDisplayMode: 'covers',
      defaultGalleryScalePercent: 135,
    }),
  );
  assert.equal(
    storage.get('albumhaven.galleryPlaybackPreferences.v1'),
    JSON.stringify({
      albumTopsEndBehavior: 'stop',
      artistPagesEndBehavior: 'continue',
    }),
  );
  assert.equal(storage.get('albumhaven.albumOpenMode.v1'), 'page');
  assert.equal(
    storage.get('albumhaven.shellLayoutPreferences.v1'),
    JSON.stringify({
      contextualPaneWidthPx: 280,
      infoDrawerWidthPx: 420,
    }),
  );
}

{
  const { context, storage } = loadHelper();
  storage.set('albumhaven.combineSimilarArtists.v1', JSON.stringify({ Stereolab: true }));
  storage.set('albumhaven.playerAppearance.v1', JSON.stringify({
    seekbarMode: 'waveform',
    waveformFillColor: '#112233',
    waveformEdgeColor: '#445566',
  }));
  storage.set('albumhaven.galleryDisplayPreferences.v1', JSON.stringify({
    defaultGalleryDisplayMode: 'list',
    defaultGalleryScalePercent: 80,
  }));
  storage.set('albumhaven.galleryPlaybackPreferences.v1', JSON.stringify({
    albumTopsEndBehavior: 'stop',
    artistPagesEndBehavior: 'continue',
  }));
  storage.set('albumhaven.albumOpenMode.v1', 'page');
  storage.set('albumhaven.shellLayoutPreferences.v1', JSON.stringify({
    contextualPaneWidthPx: 275,
    infoDrawerWidthPx: 410,
  }));

  context.restorePersistedClientPreferences();

  assert.deepEqual(JSON.parse(JSON.stringify(context.state.gallery.combineSimilarArtistsByArtist)), { Stereolab: true });
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.gallery.displayPreferences)), {
    defaultGalleryDisplayMode: 'list',
    defaultGalleryScalePercent: 80,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.gallery.playbackPreferences)), {
    albumTopsEndBehavior: 'stop',
    artistPagesEndBehavior: 'continue',
  });
  assert.equal(context.state.gallery.albumOpenMode, 'page');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.player.appearance)), {
    seekbarMode: 'waveform',
    waveformFillColor: '#112233',
    waveformEdgeColor: '#445566',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.ui.shellLayoutPreferences)), {
    contextualPaneWidthPx: 275,
    infoDrawerWidthPx: 410,
  });
}

{
  const { context, storage } = loadHelper();
  storage.set('albumhaven.combineSimilarArtists.v1', '{bad json');
  storage.set('albumhaven.playerAppearance.v1', '{bad json');
  storage.set('albumhaven.galleryDisplayPreferences.v1', '{bad json');
  storage.set('albumhaven.galleryPlaybackPreferences.v1', '{bad json');
  storage.set('albumhaven.albumOpenMode.v1', 'sideways');
  storage.set('albumhaven.shellLayoutPreferences.v1', '{bad json');

  context.restorePersistedClientPreferences();

  assert.deepEqual(JSON.parse(JSON.stringify(context.state.gallery.combineSimilarArtistsByArtist)), {});
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.gallery.displayPreferences)), {
    defaultGalleryDisplayMode: 'cards',
    defaultGalleryScalePercent: 100,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.gallery.playbackPreferences)), {
    albumTopsEndBehavior: 'continue',
    artistPagesEndBehavior: 'stop',
  });
  assert.equal(context.state.gallery.albumOpenMode, 'modal');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.player.appearance)), {
    seekbarMode: 'default',
    waveformFillColor: '#5b8f8e',
    waveformEdgeColor: '#c8ddd5',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.ui.shellLayoutPreferences)), {
    contextualPaneWidthPx: 320,
    infoDrawerWidthPx: 360,
  });
}

{
  const { context } = loadHelper();
  context.state.gallery.playbackPreferences = {
    albumTopsEndBehavior: 'stop',
    artistPagesEndBehavior: 'continue',
  };

  assert.equal(context.resolveGalleryPlaybackEndBehavior({
    kind: 'artist_page',
    end_behavior: 'stop',
  }), 'continue');
  assert.equal(context.resolveGalleryPlaybackEndBehavior({
    kind: 'album_top',
    end_behavior: 'continue',
  }), 'stop');
  assert.equal(context.resolveGalleryPlaybackEndBehavior({
    kind: 'playlist_detail',
    end_behavior: 'continue',
  }), 'continue');
}
