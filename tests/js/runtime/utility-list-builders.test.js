const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
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
  'utility-list-builders.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');
const compactDataTablePath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'compact-data-table.js',
);
const compactDataTableSource = fs.readFileSync(compactDataTablePath, 'utf8');
const tagEditorHelperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'tag-editor-and-optimistic-updates.js',
);
const tagEditorHelperSource = fs.readFileSync(tagEditorHelperPath, 'utf8');
const orderAlbumTracksHelperSource = tagEditorHelperSource.slice(
  0,
  tagEditorHelperSource.indexOf('function openTagEditor'),
);

function loadHelpers() {
  const context = {
    Map,
    state: {
      view: {
        selected_artist: 'Mono',
        selected_artist_family_display_mode: 'chronological',
        primary_filter_active: false,
        related_filter_artists: [],
        related_artists: ['World\'s End Girlfriend'],
        artist_groups: [],
        primary_artist_groups: [],
        family_artist_groups: [],
      },
    },
    mergeViewPayload(payload) {
      context.lastMergedPayload = payload;
      context.state.view = {
        ...context.state.view,
        ...payload,
      };
      return context.state.view;
    },
    rebuildAlbumIndex(groups) {
      const nextIndex = new Map();
      (Array.isArray(groups) ? groups : []).forEach((group) => {
        (Array.isArray(group?.albums) ? group.albums : []).forEach((album) => {
          const identity = typeof context.getAlbumIdentity === 'function'
            ? String(context.getAlbumIdentity(album) || '').trim()
            : '';
          const requestKey = typeof context.getAlbumRequestKey === 'function'
            ? String(context.getAlbumRequestKey(album) || '').trim()
            : '';
          if (identity) nextIndex.set(identity, album);
          if (requestKey) nextIndex.set(requestKey, album);
        });
      });
      context.state.gallery = context.state.gallery || {};
      context.state.gallery.albumIndex = nextIndex;
      return nextIndex;
    },
    renderView() {},
    getViewportScrollPosition() {
      return { x: 0, y: 0 };
    },
    document: {
      scrollingElement: {
        scrollLeft: 0,
        scrollTop: 0,
      },
      documentElement: {
        scrollLeft: 0,
        scrollTop: 0,
      },
      body: {
        scrollLeft: 0,
        scrollTop: 0,
      },
      getElementById() {
        return null;
      },
    },
    window: {
      scrollTo() {},
    },
    scheduleBrowserAnimationFrame(callback) {
      if (typeof callback === 'function') callback();
      return 1;
    },
    setUtilityActiveTab(nextTab) {
      context.state.utility = context.state.utility || {};
      if (context.state.utility.activeTab === 'loops' && nextTab !== 'loops') {
        context.state.utility.loopSpaceOwnerId = '';
      }
      context.state.utility.activeTab = nextTab;
      return nextTab;
    },
    groupMatchesRelatedArtists(group, activeArtists) {
      const groupArtist = String(group?.artist || '').trim();
      return Boolean(groupArtist && activeArtists.has(groupArtist));
    },
    lastMergedPayload: null,
  };
  vm.createContext(context);
  vm.runInContext(
    orderAlbumTracksHelperSource,
    context,
    { filename: tagEditorHelperPath },
  );
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

function loadPlayerAlbumResolutionHelpers() {
  const context = loadHelpers();
  context.state.modalReleases = [];
  context.state.player = {
    current: null,
    playbackQueue: null,
  };
  context.state.utility = {
    problematicFiles: [],
  };
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.flattenVisibleAlbums = () => [
    ...context.state.view.primary_artist_groups,
    ...context.state.view.family_artist_groups,
    ...context.state.view.artist_groups,
  ].flatMap((group) => group.albums || []);
  return context;
}

test('player album resolution uses the active queue album after the visible search context changes', () => {
  const context = loadPlayerAlbumResolutionHelpers();
  const playingTrackPath = 'C:\\Music\\Various Artists\\Featured Signal Collection\\01 Signal.flac';
  const playingAlbum = {
    key: 'featured-signal-collection',
    name: 'Featured Signal Collection',
    album_artist: 'Various Artists',
    tracks: [{ path: playingTrackPath }],
  };
  const playingTrack = {
    path: playingTrackPath,
    artist: 'Solo Voice',
    albumArtist: 'Various Artists',
    album: 'Featured Signal Collection',
  };
  context.state.view.artist_groups = [{
    artist: 'Unrelated Artist',
    albums: [{
      key: 'unrelated-album',
      name: 'Unrelated Album',
      album_artist: 'Unrelated Artist',
      tracks: [{ path: 'C:\\Music\\Unrelated Artist\\Unrelated Album\\01 Other.flac' }],
    }],
  }];
  context.state.player.current = playingTrack;
  context.state.player.playbackQueue = {
    albumRef: playingAlbum.key,
    albumSnapshot: playingAlbum,
    currentIndex: 0,
    tracks: [{ ...playingTrack }],
  };

  assert.strictEqual(context.resolveAlbumForPlayerTrack(playingTrack), playingAlbum);
});

test('player album resolution prefers fresh exact-track data over the active queue snapshot', () => {
  const context = loadPlayerAlbumResolutionHelpers();
  const playingTrackPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Signal.flac';
  const queueSnapshot = {
    key: 'album-alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    cover_path: 'C:\\Music\\Artist Alpha\\Album Alpha\\old-cover.jpg',
    tracks: [{ path: playingTrackPath }],
  };
  const freshAlbum = {
    ...queueSnapshot,
    cover_path: 'C:\\Music\\Artist Alpha\\Album Alpha\\new-cover.jpg',
  };
  const playingTrack = {
    path: playingTrackPath,
    artist: 'Artist Alpha',
    albumArtist: 'Artist Alpha',
    album: 'Album Alpha',
  };
  context.state.view.artist_groups = [{ artist: 'Artist Alpha', albums: [freshAlbum] }];
  context.state.player.playbackQueue = {
    albumRef: queueSnapshot.key,
    albumSnapshot: queueSnapshot,
    currentIndex: 0,
    tracks: [{ ...playingTrack }],
  };

  assert.strictEqual(context.resolveAlbumForPlayerTrack(playingTrack), freshAlbum);
});

test('player album resolution rejects an active queue snapshot with a mismatched album identity', () => {
  const context = loadPlayerAlbumResolutionHelpers();
  const playingTrackPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Signal.flac';
  const queueSnapshot = {
    key: 'stale-album',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    tracks: [{ path: playingTrackPath }],
  };
  const playingTrack = {
    path: playingTrackPath,
    artist: 'Artist Alpha',
    albumArtist: 'Artist Alpha',
    album: 'Album Alpha',
  };
  context.state.player.playbackQueue = {
    albumRef: 'active-album',
    albumSnapshot: queueSnapshot,
    currentIndex: 0,
    tracks: [{ ...playingTrack }],
  };

  assert.equal(context.resolveAlbumForPlayerTrack(playingTrack), null);
});

test('player album resolution rejects an active queue snapshot without the requested track path', () => {
  const context = loadPlayerAlbumResolutionHelpers();
  const playingTrackPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Signal.flac';
  const queueSnapshot = {
    key: 'album-alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    tracks: [{ path: 'C:\\Music\\Artist Alpha\\Album Alpha\\02 Other.flac' }],
  };
  const playingTrack = {
    path: playingTrackPath,
    artist: 'Artist Alpha',
    albumArtist: 'Artist Alpha',
    album: 'Album Alpha',
  };
  context.state.player.playbackQueue = {
    albumRef: queueSnapshot.key,
    albumSnapshot: queueSnapshot,
    currentIndex: 0,
    tracks: [{ ...playingTrack }],
  };

  assert.equal(context.resolveAlbumForPlayerTrack(playingTrack), null);
});

test('player album resolution rejects an active queue snapshot when the requested track left the queue', () => {
  const context = loadPlayerAlbumResolutionHelpers();
  const playingTrackPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Signal.flac';
  const queueSnapshot = {
    key: 'album-alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    tracks: [{ path: playingTrackPath }],
  };
  const playingTrack = {
    path: playingTrackPath,
    artist: 'Artist Alpha',
    albumArtist: 'Artist Alpha',
    album: 'Album Alpha',
  };
  context.state.player.playbackQueue = {
    albumRef: queueSnapshot.key,
    albumSnapshot: queueSnapshot,
    currentIndex: 0,
    tracks: [{
      ...playingTrack,
      path: 'C:\\Music\\Artist Alpha\\Album Alpha\\02 Other.flac',
    }],
  };

  assert.equal(context.resolveAlbumForPlayerTrack(playingTrack), null);
});

function loadLoopBuilderHelpers() {
  const context = {
    state: {
      utility: {
        loops: [],
        selectedLoopId: '',
        loopRepeatEnabled: false,
      },
    },
    escapeHtml(value) {
      return String(value ?? '');
    },
    formatLoopTime(value, includeMilliseconds = false) {
      const seconds = Math.max(0, Number(value) || 0);
      const wholeMinutes = Math.floor(seconds / 60);
      const remaining = seconds - (wholeMinutes * 60);
      return includeMilliseconds
        ? `${wholeMinutes}:${remaining.toFixed(3).padStart(6, '0')}`
        : `${wholeMinutes}:${String(Math.floor(remaining)).padStart(2, '0')}`;
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

function loadProblematicTrackNavigationHelpers() {
  const trackPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\18 Late Problem.flac';
  const album = {
    key: 'album-alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    detail_loaded: true,
    problematic_track_paths: [trackPath],
    track_paths: [trackPath],
    tracks: [{ path: trackPath, title: 'Late Problem' }],
    track_problem_rows: [{
      path: trackPath,
      filename: '18 Late Problem.flac',
      file_type: 'FLAC',
      reasons: ['Missing year'],
      ignorable_reasons: [],
    }],
    repair_preview_rows: [],
  };
  const unrelatedAlbum = {
    key: 'album-beta',
    name: 'Album Beta',
    album_artist: 'Artist Beta',
    detail_loaded: true,
    problematic_track_paths: ['C:\\Music\\Artist Beta\\Album Beta\\01 Other Problem.flac'],
    track_paths: ['C:\\Music\\Artist Beta\\Album Beta\\01 Other Problem.flac'],
    tracks: [{
      path: 'C:\\Music\\Artist Beta\\Album Beta\\01 Other Problem.flac',
      title: 'Other Problem',
    }],
    track_problem_rows: [],
    repair_preview_rows: [],
  };
  const context = {
    console,
    state: {
      utility: {
        activeTab: 'problematic-files',
        loaded: true,
        problematicFiles: [album, unrelatedAlbum],
        selectedProblematicKey: '',
        searchQuery: 'Existing filter',
        focusedTrackPath: '',
        showRepairedDisplay: false,
        deferProblematicAutoSelection: true,
        selectedProblemFilters: ['Missing year'],
        problemDropdownOpen: true,
        repairSelections: {},
        separateReleaseSelections: {},
        collapsedSections: {},
      },
    },
    openUtilityModal(options = {}) {
      if (options.resetSearch) {
        context.state.utility.searchQuery = '';
      }
    },
    async loadProblematicFiles() {},
    async loadProblematicAlbumDetail() {},
    getSelectedProblematicAlbum() {
      return context.state.utility.problematicFiles.find(
        (item) => item.key === context.state.utility.selectedProblematicKey,
      ) || null;
    },
    albumMatchesProblemFilters() {
      return true;
    },
    renderUtilityModalContent() {},
    showToast() {},
    setUtilityActiveTab(nextTab) {
      if (context.state.utility.activeTab === 'loops' && nextTab !== 'loops') {
        context.state.utility.loopSpaceOwnerId = '';
      }
      context.state.utility.activeTab = nextTab;
      return nextTab;
    },
    escapeHtml(value) {
      return String(value);
    },
    getFileTypeFromPath(value) {
      return String(value).split('.').pop() || '';
    },
    getFilenameFromPath(value) {
      return String(value).split('\\').pop() || '';
    },
  };
  vm.createContext(context);
  context.buildCompactDataTable = vm.runInContext(
    `(() => { ${compactDataTableSource}; return buildCompactDataTable; })()`,
    context,
    { filename: compactDataTablePath },
  );
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { album, context, trackPath };
}

test('applyUpdatedAlbumsToCurrentView removes a source album with no optimistic candidates', () => {
  const context = loadHelpers();
  const album = {
    key: 'mono::only album::2009',
    name: 'Only Album',
    album_artist: 'Mono',
    year: 2009,
    tracks: [{ path: 'C:\\Music\\Mono\\Only Album\\01 Only.flac' }],
  };
  const primaryGroup = { artist: 'Mono', albums: [album] };
  context.state.view = {
    ...context.state.view,
    selected_artist: 'Mono',
    artist_groups: [primaryGroup],
    primary_artist_groups: [primaryGroup],
    family_artist_groups: [],
  };

  context.applyUpdatedAlbumsToCurrentView([], {
    originalAlbum: album,
    skipRender: true,
    tagEdits: { [album.tracks[0].path]: { album: '' } },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.artist_groups)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.primary_artist_groups)), []);
  assert.equal(context.state.view.album_count, 0);
});

test('applyUpdatedAlbumsToCurrentView inserts an album restored from selected-artist loose tracks', () => {
  const context = loadHelpers();
  const existingAlbum = {
    key: 'folkstone::dreams',
    name: 'Dreams',
    album_artist: 'Folkstone',
    year: 2003,
    tracks: [{ path: 'C:\\Music\\Folkstone\\Dreams\\01 Track.flac' }],
  };
  const looseTrackPath = 'C:\\Music\\Folkstone\\ballad.mp3';
  const looseCollection = {
    key: 'folkstone::non-album',
    name: 'Non-album tracks',
    album_artist: 'Folkstone',
    tag_editor_collection: true,
    tracks: [{
      path: looseTrackPath,
      album: 'Folkstone',
      album_artist: 'Folkstone',
      exception_type: 'Non-album rarity',
    }],
  };
  const restoredAlbum = {
    key: 'folkstone::folkstone',
    name: 'Folkstone',
    album_artist: 'Folkstone',
    year: 2009,
    tracks: [{
      path: looseTrackPath,
      album: 'Folkstone',
      album_artist: 'Folkstone',
      exception_type: '',
    }],
  };
  const primaryGroup = { artist: 'Folkstone', albums: [existingAlbum] };
  context.state.view = {
    ...context.state.view,
    selected_artist: 'Folkstone',
    artist_groups: [primaryGroup],
    primary_artist_groups: [primaryGroup],
    family_artist_groups: [],
  };

  context.applyUpdatedAlbumsToCurrentView([restoredAlbum], {
    originalAlbum: looseCollection,
    skipRender: true,
    tagEdits: { [looseTrackPath]: { exception_type: '' } },
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.state.view.primary_artist_groups[0].albums.map((album) => album.name),
    )),
    ['Dreams', 'Folkstone'],
  );
  assert.equal(context.state.view.album_count, 2);
});

test('applyUpdatedAlbumsToCurrentView keeps a restored album beside an existing Other album', () => {
  const context = loadHelpers();
  const restoredPath = 'X:\\SyntheticMusic\\Fictional Artist\\ballad.mp3';
  const otherPath = 'X:\\SyntheticMusic\\Fictional Artist\\second-track.mp3';
  const existingAlbum = {
    key: 'folkstone::dreams',
    name: 'Dreams',
    album_artist: 'Folkstone',
    year: 2003,
    tracks: [{ path: 'X:\\SyntheticMusic\\Fictional Artist\\Synthetic Album\\01 Track.mp3' }],
  };
  const otherAlbum = {
    key: 'folkstone::',
    name: 'Unknown Album',
    album_artist: 'Folkstone',
    year: 2009,
    tracks: [{ path: otherPath, album: 'Unknown Album', album_artist: 'Folkstone' }],
  };
  const looseCollection = {
    key: 'non-album-tracks::folkstone',
    name: '',
    album_artist: '',
    tag_editor_collection: true,
    tracks: [
      {
        path: restoredPath,
        album: 'Folkstone',
        album_artist: 'Folkstone',
        exception_type: 'Non-album rarity',
      },
      {
        path: otherPath,
        album: '',
        album_artist: 'Folkstone',
        exception_type: '',
      },
    ],
  };
  const restoredAlbum = {
    key: 'folkstone::folkstone',
    name: 'Folkstone',
    album_artist: 'Folkstone',
    year: 2009,
    tracks: [{ path: restoredPath, album: 'Folkstone', album_artist: 'Folkstone' }],
  };
  const finalizedOtherAlbum = {
    ...otherAlbum,
    tracks: [{ path: otherPath, album: 'Unknown Album', album_artist: 'Folkstone' }],
  };
  const primaryGroup = { artist: 'Folkstone', albums: [existingAlbum, otherAlbum] };
  context.state.view = {
    ...context.state.view,
    selected_artist: 'Folkstone',
    artist_groups: [primaryGroup],
    primary_artist_groups: [primaryGroup],
    family_artist_groups: [],
  };

  context.applyUpdatedAlbumsToCurrentView(
    [restoredAlbum, finalizedOtherAlbum],
    {
      originalAlbum: looseCollection,
      skipRender: true,
      tagEdits: { [restoredPath]: { exception_type: '' } },
    },
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.state.view.primary_artist_groups[0].albums.map((album) => album.name),
    )),
    ['Dreams', 'Folkstone', 'Unknown Album'],
  );
  assert.equal(context.state.view.album_count, 3);
});

test('applyUpdatedAlbumsToCurrentView preserves chronological selected-artist family display', () => {
  const context = loadHelpers();
  const monoAlbum = {
    key: 'mono-1',
    name: 'Hymn to the Immortal Wind',
    album_artist: 'Mono',
    year: 2009,
    release_date: '2009-03-24',
    tracks: [{ path: 'C:\\Music\\Mono\\Hymn\\01 Track.flac' }],
  };
  const wegAlbum = {
    key: 'weg-1',
    name: 'Palmless Prayer / Mass Murder Refrain',
    album_artist: 'World\'s End Girlfriend',
    year: 2006,
    release_date: '2006-01-01',
    tracks: [{ path: 'C:\\Music\\Worlds End Girlfriend\\Palmless\\01 Track.flac' }],
  };

  context.state.view.primary_artist_groups = [{
    artist: 'Mono',
    albums: [monoAlbum],
  }];
  context.state.view.family_artist_groups = [{
    artist: 'World\'s End Girlfriend',
    albums: [wegAlbum],
  }];
  context.state.view.artist_groups = [{
    artist: 'Chronological',
    artist_display: 'Chronological',
    albums: [wegAlbum, monoAlbum],
  }];

  context.applyUpdatedAlbumsToCurrentView([{
    ...monoAlbum,
    name: 'Hymn to the Immortal Wind (Updated)',
  }], { skipRender: true });

  assert.deepEqual(JSON.parse(JSON.stringify(context.lastMergedPayload.primary_artist_groups)), [{
    artist: 'Mono',
    artist_display: 'Mono',
    albums: [{
      key: 'mono-1',
      name: 'Hymn to the Immortal Wind (Updated)',
      album_artist: 'Mono',
      year: 2009,
      release_date: '2009-03-24',
      tracks: [{ path: 'C:\\Music\\Mono\\Hymn\\01 Track.flac' }],
    }],
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.lastMergedPayload.family_artist_groups)), [{
    artist: 'World\'s End Girlfriend',
    artist_display: 'World\'s End Girlfriend',
    albums: [wegAlbum],
  }]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.lastMergedPayload.related_artists)),
    ['World\'s End Girlfriend'],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(context.lastMergedPayload.artist_groups)), [{
    artist: 'Chronological',
    artist_display: 'Chronological',
    albums: [
      wegAlbum,
      {
        key: 'mono-1',
        name: 'Hymn to the Immortal Wind (Updated)',
        album_artist: 'Mono',
        year: 2009,
        release_date: '2009-03-24',
        tracks: [{ path: 'C:\\Music\\Mono\\Hymn\\01 Track.flac' }],
      },
    ],
  }]);
  assert.equal(context.lastMergedPayload.artist_count, 2);
  assert.equal(context.lastMergedPayload.album_count, 2);
});

test('applyUpdatedAlbumsToCurrentView keeps unknown-year chronological albums after dated albums', () => {
  const context = loadHelpers();
  const unknownYearAlbum = {
    key: 'unknown-year',
    name: 'Unknown Year',
    album_artist: 'Mono',
    year: null,
    release_date: '',
    tracks: [{ path: 'C:\\Music\\Mono\\Unknown\\01 Track.flac' }],
  };
  const datedAlbum = {
    key: 'dated',
    name: 'Dated Album',
    album_artist: 'World\'s End Girlfriend',
    year: 2006,
    release_date: '',
    tracks: [{ path: 'C:\\Music\\Worlds End Girlfriend\\Dated\\01 Track.flac' }],
  };

  context.state.view.primary_artist_groups = [{
    artist: 'Mono',
    albums: [unknownYearAlbum],
  }];
  context.state.view.family_artist_groups = [{
    artist: 'World\'s End Girlfriend',
    albums: [datedAlbum],
  }];
  context.state.view.artist_groups = [{
    artist: 'Chronological',
    artist_display: 'Chronological',
    albums: [datedAlbum, unknownYearAlbum],
  }];

  context.applyUpdatedAlbumsToCurrentView([{
    ...unknownYearAlbum,
    name: 'Unknown Year (Updated)',
  }], { skipRender: true });

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.lastMergedPayload.artist_groups[0].albums.map((album) => album.key))),
    ['dated', 'unknown-year'],
  );
});

test('applyUpdatedAlbumsToCurrentView preserves mounted artist groups when raw credits differ from the group artist', () => {
  const context = loadHelpers();
  const earlyAlbum = {
    key: 'ддт::я получил эту роль::1985',
    name: 'Я получил эту роль',
    album_artist: 'Юрий Шевчук',
    year: 1985,
    tracks: [{ path: 'D:\\Music\\ДДТ\\Я получил эту роль\\01 Early.flac' }],
  };
  const publicationAlbum = {
    key: 'ддт::публикация::1987',
    name: 'Публикация',
    album_artist: 'ДДТ / Юрий Шевчук',
    year: 1987,
    tracks: [{ path: 'D:\\Music\\ДДТ\\Публикация\\01 Publication.flac' }],
  };
  const movedPath = 'D:\\Music\\ДДТ\\Студийные записи\\01 Moved.flac';
  const siblingPath = 'D:\\Music\\ДДТ\\Студийные записи\\02 Sibling.flac';
  const originalAlbum = {
    key: 'ддт::студийные записи::1988',
    name: 'Студийные записи',
    album_artist: 'Юрий Шевчук / ДДТ',
    year: 1988,
    tracks: [
      { path: movedPath, album: 'Студийные записи', album_artist: 'Юрий Шевчук / ДДТ' },
      { path: siblingPath, album: 'Студийные записи', album_artist: 'Юрий Шевчук / ДДТ' },
    ],
  };
  const laterAlbum = {
    key: 'ддт::актер весна::1992',
    name: 'Актриса Весна',
    album_artist: 'ДДТ',
    year: 1992,
    tracks: [{ path: 'D:\\Music\\ДДТ\\Актриса Весна\\01 Later.flac' }],
  };
  const familyFirst = {
    key: 'юрий-шевчук::сольный первый::2008',
    name: 'Сольный первый',
    album_artist: 'Юрий Шевчук',
    year: 2008,
    tracks: [{ path: 'D:\\Music\\Юрий Шевчук\\Сольный первый\\01 First.flac' }],
  };
  const familySecond = {
    key: 'юрий-шевчук::сольный второй::2010',
    name: 'Сольный второй',
    album_artist: 'Юрий Шевчук',
    year: 2010,
    tracks: [{ path: 'D:\\Music\\Юрий Шевчук\\Сольный второй\\01 Second.flac' }],
  };
  const primaryGroup = {
    artist: 'ДДТ',
    artist_display: 'ДДТ',
    albums: [earlyAlbum, publicationAlbum, originalAlbum, laterAlbum],
  };
  const unrelatedFamilyGroup = {
    artist: 'Юрий Шевчук',
    artist_display: 'Юрий Шевчук',
    albums: [familyFirst, familySecond],
  };
  context.state.view.selected_artist = 'ДДТ';
  context.state.view.selected_artist_family_display_mode = 'grouped';
  context.state.view.related_artists = ['Юрий Шевчук'];
  context.state.view.primary_artist_groups = [primaryGroup];
  context.state.view.family_artist_groups = [unrelatedFamilyGroup];
  context.state.view.artist_groups = [primaryGroup, unrelatedFamilyGroup];

  const finalizedSource = {
    ...originalAlbum,
    tracks: [originalAlbum.tracks[1]],
  };
  const finalizedSuffix = {
    key: 'ддт::студийные записи2::1988',
    name: 'Студийные записи2',
    album_artist: 'Юрий Шевчук',
    year: 1988,
    tracks: [{
      ...originalAlbum.tracks[0],
      album: 'Студийные записи2',
    }],
  };

  context.applyUpdatedAlbumsToCurrentView(
    [finalizedSource, finalizedSuffix],
    { originalAlbum, skipRender: true },
  );

  const groups = JSON.parse(JSON.stringify(context.lastMergedPayload.artist_groups));
  assert.deepEqual(
    groups.map((group) => group.artist),
    ['ДДТ', 'Юрий Шевчук'],
    'raw and composite card credits must not synthesize new gallery artist groups',
  );
  assert.deepEqual(
    groups[0].albums.map((album) => album.key),
    [
      earlyAlbum.key,
      publicationAlbum.key,
      finalizedSource.key,
      finalizedSuffix.key,
      laterAlbum.key,
    ],
    'the split cards must replace the source in chronological order inside its mounted group',
  );
  assert.deepEqual(
    groups[1].albums.map((album) => album.key),
    [familyFirst.key, familySecond.key],
    'an unrelated family group must retain its membership and order',
  );
  assert.equal(context.lastMergedPayload.primary_artist_groups.length, 1);
  assert.equal(context.lastMergedPayload.primary_artist_groups[0].artist, 'ДДТ');
  assert.equal(context.lastMergedPayload.primary_artist_groups[0].albums.length, 5);
  assert.deepEqual(
    context.lastMergedPayload.family_artist_groups.map((group) => group.artist),
    ['Юрий Шевчук'],
  );
});

test('applyUpdatedAlbumsToCurrentView normalizes an explicitly blank album artist destination', () => {
  const context = loadHelpers();
  const movedPath = 'D:\\Music\\Artist\\Source\\01 Moved.flac';
  const sourcePath = 'D:\\Music\\Artist\\Source\\02 Source.flac';
  const originalAlbum = {
    key: 'artist::source::2000',
    name: 'Source',
    album_artist: 'Artist',
    year: 2000,
    tracks: [
      { path: movedPath, album: 'Source', album_artist: 'Artist' },
      { path: sourcePath, album: 'Source', album_artist: 'Artist' },
    ],
  };
  const sourceGroup = { artist: 'Artist', albums: [originalAlbum] };
  context.state.view.selected_artist = 'Artist';
  context.state.view.selected_artist_family_display_mode = 'grouped';
  context.state.view.primary_artist_groups = [sourceGroup];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = [sourceGroup];

  context.applyUpdatedAlbumsToCurrentView([
    { ...originalAlbum, tracks: [originalAlbum.tracks[1]] },
    {
      key: 'unknown::destination::2000',
      name: 'Destination',
      album_artist: '',
      year: 2000,
      tracks: [{ ...originalAlbum.tracks[0], album: 'Destination', album_artist: '' }],
    },
  ], {
    originalAlbum,
    skipRender: true,
    tagEdits: { [movedPath]: { album: 'Destination', album_artist: '' } },
  });

  assert.equal(
    context.state.view.family_artist_groups[0]?.artist,
    'Unknown Artist',
  );
});

test('applyUpdatedAlbumsToCurrentView keeps every candidate when no semantic groups are mounted', () => {
  const context = loadHelpers();
  const movedPath = 'D:\\Music\\Artist\\Source\\01 Moved.flac';
  const sourcePath = 'D:\\Music\\Artist\\Source\\02 Source.flac';
  const originalAlbum = {
    key: 'artist::source::2000',
    name: 'Source',
    album_artist: 'Artist',
    year: 2000,
    tracks: [
      { path: movedPath, album: 'Source', album_artist: 'Artist' },
      { path: sourcePath, album: 'Source', album_artist: 'Artist' },
    ],
  };
  context.state.view.selected_artist = '';
  context.state.view.artist_groups = [];

  context.applyUpdatedAlbumsToCurrentView([
    { ...originalAlbum, tracks: [originalAlbum.tracks[1]] },
    {
      key: 'target::destination::2000',
      name: 'Destination',
      album_artist: 'Target',
      year: 2000,
      tracks: [{ ...originalAlbum.tracks[0], album: 'Destination', album_artist: 'Target' }],
    },
  ], {
    originalAlbum,
    skipRender: true,
    tagEdits: { [movedPath]: { album: 'Destination', album_artist: 'Target' } },
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.state.view.artist_groups
        .flatMap((group) => group.albums.map((album) => album.name))
        .sort(),
    )),
    ['Destination', 'Source'],
  );
});

test('applyUpdatedAlbumsToCurrentView replaces a trackless preview by its stable album alias', () => {
  const context = loadHelpers();
  const previewAlbum = {
    key: 'preview-sparse-album',
    album_ref: 'stable-sparse-album',
    name: 'Sparse Album',
    album_artist: 'Rarity Artist',
    year: 2000,
  };
  const hydratedOriginalAlbum = {
    ...previewAlbum,
    tracks: [{ path: 'D:\\Synthetic Music\\Rarity Artist\\Sparse Album\\01 Track.mp3' }],
  };
  const hydratedAlbum = {
    key: 'hydrated-sparse-album',
    album_ref: 'stable-sparse-album',
    name: 'Sparse Album',
    album_artist: 'Rarity Artist',
    year: 2000,
    tracks: [{ path: 'D:\\Synthetic Music\\Rarity Artist\\Sparse Album\\01 Track.mp3' }],
  };
  context.state.view.selected_artist = '';
  context.state.view.primary_artist_groups = [];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = [{
    artist: 'Rarity Artist',
    albums: [previewAlbum],
  }];
  context.getAlbumRequestKey = (album) => String(album?.album_ref || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');

  context.applyUpdatedAlbumsToCurrentView(
    [hydratedAlbum],
    { originalAlbum: hydratedOriginalAlbum, skipRender: true },
  );

  assert.equal(context.lastMergedPayload.album_count, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.lastMergedPayload.artist_groups[0].albums)),
    [hydratedAlbum],
  );
});

test('applyUpdatedAlbumsToCurrentView replaces a trackless source preview during destination-to-source merge', () => {
  const context = loadHelpers();
  const sourcePreview = {
    key: 'source',
    name: 'Same Name',
    album_artist: 'Rarity Artist',
    year: 2000,
    preview_only: true,
  };
  const destinationPreview = {
    key: 'dest',
    name: 'Changed Name',
    album_artist: 'Rarity Artist',
    year: 2000,
    preview_only: true,
  };
  const originalDestinationAlbum = {
    ...destinationPreview,
    tracks: [{
      path: 'D:\\Synthetic Music\\Rarity Artist\\Same Name\\02 Moved Track.mp3',
      title: 'Moved Track',
    }],
  };
  const hydratedSource = {
    ...sourcePreview,
    preview_only: false,
    tracks: [{
      path: 'D:\\Synthetic Music\\Rarity Artist\\Same Name\\01 Source Track.mp3',
      title: 'Source Track',
    }, {
      path: 'D:\\Synthetic Music\\Rarity Artist\\Same Name\\02 Moved Track.mp3',
      title: 'Moved Track',
    }],
  };
  context.state.view.selected_artist = '';
  context.state.view.primary_artist_groups = [];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = [{
    artist: 'Rarity Artist',
    albums: [sourcePreview, destinationPreview],
  }];
  context.getAlbumRequestKey = (album) => String(album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');

  context.applyUpdatedAlbumsToCurrentView(
    [hydratedSource],
    { originalAlbum: originalDestinationAlbum, skipRender: true },
  );

  assert.equal(context.lastMergedPayload.album_count, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.lastMergedPayload.artist_groups[0].albums)),
    [hydratedSource],
  );
});

test('albumsShareTrackPath matches an explicit track_paths-only album', () => {
  const context = loadHelpers();
  const sharedPath = 'D:\\Synthetic Music\\Rarity Artist\\Same Name\\01 Source Track.mp3';

  assert.equal(context.albumsShareTrackPath(
    { track_paths: [sharedPath] },
    new Set([sharedPath]),
  ), true);
});

test('findVisibleAlbumByTrackPaths prefers a duplicate projection with album preference data', () => {
  const context = loadHelpers();
  const sharedPath = 'D:\\Synthetic Music\\Rarity Artist\\Duplicate\\01 Source Track.mp3';
  const preferenceEmptyProjection = {
    key: 'duplicate-empty',
    track_paths: [sharedPath],
    album_preference: { rating: null, can_edit: true },
  };
  const legacyRatedProjection = {
    key: 'duplicate-legacy-rated',
    track_paths: [sharedPath],
    album_preference: null,
    album_rating: 7,
  };
  const preferenceOwningProjection = {
    key: 'duplicate-rated',
    track_paths: [sharedPath],
    album_preference: { rating: 8, loved: true },
  };
  context.flattenVisibleAlbums = () => [
    preferenceEmptyProjection,
    legacyRatedProjection,
    preferenceOwningProjection,
  ];

  assert.strictEqual(
    context.findVisibleAlbumByTrackPaths(new Set([sharedPath])),
    preferenceOwningProjection,
  );

  context.flattenVisibleAlbums = () => [
    preferenceEmptyProjection,
    legacyRatedProjection,
  ];
  assert.strictEqual(
    context.findVisibleAlbumByTrackPaths(new Set([sharedPath])),
    legacyRatedProjection,
    'a valid legacy rating must beat generic preference metadata when no display preference rating exists',
  );

  const secondPreferenceEmptyProjection = {
    key: 'duplicate-empty-second',
    track_paths: [sharedPath],
    album_preference: null,
  };
  context.flattenVisibleAlbums = () => [
    preferenceEmptyProjection,
    secondPreferenceEmptyProjection,
  ];
  assert.strictEqual(
    context.findVisibleAlbumByTrackPaths(new Set([sharedPath])),
    preferenceEmptyProjection,
    'the lookup must retain first-match behavior when duplicate projections have no preference data',
  );
});

test('applyUpdatedAlbumsToCurrentView merges a second moved track into the stable visible destination', () => {
  const context = loadHelpers();
  const firstMovedTrack = {
    path: 'D:\\Synthetic Music\\Rarity Artist\\Split\\01 First Moved.mp3',
    title: 'First Moved',
  };
  const secondMovedTrack = {
    path: 'D:\\Synthetic Music\\Rarity Artist\\Split\\02 Second Moved.mp3',
    title: 'Second Moved',
  };
  const sourceSiblings = [{
    path: 'D:\\Synthetic Music\\Rarity Artist\\Split\\03 Source Sibling.mp3',
    title: 'Source Sibling',
  }, {
    path: 'D:\\Synthetic Music\\Rarity Artist\\Split\\04 Final Sibling.mp3',
    title: 'Final Sibling',
  }];
  const visibleSource = {
    key: 'rarity artist::selected track split fixture',
    album_ref: 'stable-source-ref',
    name: 'Selected Track Split Fixture',
    album_artist: 'Rarity Artist',
    year: 2026,
    tracks: [secondMovedTrack, ...sourceSiblings],
  };
  const visibleDestination = {
    key: 'stable-destination-key',
    album_ref: 'stable-destination-ref',
    name: 'Selected Track Split Result',
    album_artist: 'Rarity Artist',
    year: 2026,
    edition: 'Stable Destination Edition',
    release_date: '2026-07-22',
    genres: ['Progressive Rock'],
    label: 'Fixture Records',
    cover_path: 'D:\\Synthetic Music\\Rarity Artist\\Split\\folder.jpg',
    remote_cover_url: 'https://covers.example/stable-destination.jpg',
    remote_cover_thumbnail_url: 'https://covers.example/stable-destination-thumb.jpg',
    tracks: [firstMovedTrack],
  };
  const optimisticSource = {
    ...visibleSource,
    key: 'rarity artist::selected track split fixture::::2026',
    tracks: sourceSiblings,
  };
  const optimisticDestination = {
    key: 'logical:rarity-artist:selected-track-split-result:2026',
    name: visibleDestination.name,
    album_artist: visibleDestination.album_artist,
    year: visibleDestination.year,
    tracks: [secondMovedTrack],
  };
  context.state.view.selected_artist = '';
  context.state.view.primary_artist_groups = [];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = [{
    artist: 'Rarity Artist',
    albums: [visibleSource, visibleDestination],
  }];
  context.getAlbumRequestKey = (album) => String(album?.album_ref || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');

  context.applyUpdatedAlbumsToCurrentView(
    [optimisticSource, optimisticDestination],
    { originalAlbum: visibleSource, skipRender: true },
  );

  const mergedAlbums = JSON.parse(JSON.stringify(
    context.lastMergedPayload.artist_groups[0].albums,
  ));
  const mergedSources = mergedAlbums.filter((album) => (
    album.name === visibleSource.name && album.year === visibleSource.year
  ));
  const mergedDestinations = mergedAlbums.filter((album) => (
    album.name === visibleDestination.name && album.year === visibleDestination.year
  ));
  assert.equal(context.lastMergedPayload.album_count, 2);
  assert.deepEqual(mergedSources, [{
    ...optimisticSource,
    key: visibleSource.key,
  }]);
  assert.equal(mergedDestinations.length, 1);
  assert.deepEqual(mergedDestinations[0], {
    ...visibleDestination,
    tracks: [firstMovedTrack, secondMovedTrack],
  });
});

test('applyUpdatedAlbumsToCurrentView merges disjoint tracks for the same visible runtime album identity', () => {
  const context = loadHelpers();
  const firstTrack = {
    path: 'D:\\Synthetic Music\\Rarity Artist\\Merged\\01 Existing.mp3',
    title: 'Existing',
    duration_seconds: 61,
  };
  const incomingTrack = {
    path: 'D:\\Synthetic Music\\Rarity Artist\\Merged\\02 Incoming.mp3',
    title: 'Incoming',
    duration_seconds: 79,
  };
  const visibleDestination = {
    key: 'stable-destination-key',
    album_ref: 'stable-destination-ref',
    name: 'Merged Destination',
    album_artist: 'Rarity Artist',
    year: 2026,
    track_count_preview: 1,
    total_duration_seconds: 61,
    total_duration_display: '1:01',
    tracks: [firstTrack],
  };
  const optimisticDestination = {
    ...visibleDestination,
    track_count_preview: 1,
    total_duration_seconds: 79,
    total_duration_display: '1:19',
    tracks: [incomingTrack],
  };
  context.state.view.selected_artist = '';
  context.state.view.primary_artist_groups = [];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = [{
    artist: 'Rarity Artist',
    albums: [visibleDestination],
  }];
  context.getAlbumRequestKey = (album) => String(album?.album_ref || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.formatAlbumDuration = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  context.applyUpdatedAlbumsToCurrentView(
    [optimisticDestination],
    { originalAlbum: visibleDestination, skipRender: true },
  );

  const [publishedAlbum] = JSON.parse(JSON.stringify(
    context.lastMergedPayload.artist_groups[0].albums,
  ));
  assert.equal(context.lastMergedPayload.album_count, 1);
  assert.deepEqual(publishedAlbum.tracks, [firstTrack, incomingTrack]);
  assert.equal(publishedAlbum.track_count_preview, 2);
  assert.equal(publishedAlbum.total_duration_seconds, 140);
  assert.equal(publishedAlbum.total_duration_display, '2m 20s');
});

test('applyUpdatedAlbumsToCurrentView replaces a compact source projection with full canonical membership', () => {
  const context = loadHelpers();
  const compactPaths = Array.from({ length: 15 }, (_value, index) => (
    `D:\\Synthetic Music\\DDT\\Stale Preview\\${String(index + 1).padStart(2, '0')}.mp3`
  ));
  const canonicalTracks = Array.from({ length: 14 }, (_value, index) => ({
    path: `D:\\Synthetic Music\\DDT\\Studio Records\\${String(index + 1).padStart(2, '0')}.mp3`,
    title: `Canonical Track ${index + 1}`,
  }));
  const visibleCompactSource = {
    key: 'stable-studio-source-key',
    album_ref: 'stable-studio-source-ref',
    name: 'Studio Records',
    album_artist: 'DDT',
    year: 1999,
    preview_only: true,
    track_count_preview: 15,
    track_paths: compactPaths,
    tracks: [],
  };
  const incomingCanonicalSource = {
    ...visibleCompactSource,
    preview_only: false,
    track_count_preview: 14,
    track_paths: canonicalTracks.map((track) => track.path),
    tracks: canonicalTracks,
  };
  context.state.view.selected_artist = '';
  context.state.view.primary_artist_groups = [];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = [{
    artist: 'DDT',
    albums: [visibleCompactSource],
  }];
  context.getAlbumRequestKey = (album) => String(album?.album_ref || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');

  context.applyUpdatedAlbumsToCurrentView(
    [incomingCanonicalSource],
    { originalAlbum: visibleCompactSource, skipRender: true },
  );

  const [publishedAlbum] = JSON.parse(JSON.stringify(
    context.lastMergedPayload.artist_groups[0].albums,
  ));
  assert.equal(publishedAlbum.key, visibleCompactSource.key);
  assert.equal(publishedAlbum.album_ref, visibleCompactSource.album_ref);
  assert.equal(publishedAlbum.preview_only, false);
  assert.equal(publishedAlbum.track_count_preview, 14);
  assert.deepEqual(publishedAlbum.track_paths, incomingCanonicalSource.track_paths);
  assert.deepEqual(publishedAlbum.tracks, canonicalTracks);
});

test('applyUpdatedAlbumsToCurrentView preserves compact destination membership during a one-track structural restore', () => {
  const context = loadHelpers();
  const restoredPath = 'D:\\Synthetic Music\\DDT\\Studio Records\\14 Studio Track.mp3';
  const canonicalPreviewDestination = {
    key: 'canonical-studio-records',
    album_ref: 'canonical-studio-records',
    name: 'Studio Records',
    album_artist: 'DDT',
    year: 2026,
    preview_only: true,
    tracks: [],
    track_paths: [],
    track_count_preview: 13,
  };
  const oneTrackStructuralDestination = {
    ...canonicalPreviewDestination,
    preview_only: false,
    tracks: [{ path: restoredPath, title: 'Studio Track 14' }],
    track_paths: [restoredPath],
    track_count_preview: 1,
  };
  context.state.view.selected_artist = '';
  context.state.view.primary_artist_groups = [];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = [{
    artist: 'DDT',
    albums: [canonicalPreviewDestination],
  }];
  context.getAlbumRequestKey = (album) => String(album?.album_ref || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');

  context.applyUpdatedAlbumsToCurrentView(
    [oneTrackStructuralDestination],
    { skipRender: true },
  );

  const [publishedAlbum] = JSON.parse(JSON.stringify(
    context.lastMergedPayload.artist_groups[0].albums,
  ));
  assert.equal(publishedAlbum.preview_only, true);
  assert.equal(publishedAlbum.track_count_preview, 14);
  assert.deepEqual(publishedAlbum.track_paths, [restoredPath]);
  assert.deepEqual(publishedAlbum.tracks, [oneTrackStructuralDestination.tracks[0]]);
  assert.ok(
    publishedAlbum.tracks.length < publishedAlbum.track_count_preview,
    'partial representative tracks must not claim that the compact release is fully hydrated',
  );
});

test('canonical optimistic album duration formatting matches server card payloads', () => {
  const context = loadHelpers();

  assert.equal(context.formatCanonicalAlbumDuration(140), '2m 20s');
  assert.equal(context.formatCanonicalAlbumDuration(3661), '1h 1m');
});

test('finalized compact albums preserve canonical gallery preview track counts', () => {
  const context = loadHelpers();
  const canonicalAlbum = {
    key: 'compact-preview-album',
    album_ref: 'compact-preview-album-ref',
    name: 'Compact Preview Album',
    album_artist: 'Preview Artist',
    year: 2000,
    preview_only: true,
    tracks: [],
    track_count_preview: 10,
  };
  const finalizedAlbum = {
    key: canonicalAlbum.key,
    album_ref: canonicalAlbum.album_ref,
    name: canonicalAlbum.name,
    album_artist: canonicalAlbum.album_artist,
    year: canonicalAlbum.year,
    preview_only: true,
    tracks: [],
  };

  const [enrichedAlbum] = context.enrichFinalizedAlbumsWithCanonicalVisibleProjections(
    [finalizedAlbum],
    [canonicalAlbum],
  );

  assert.equal(enrichedAlbum.track_count_preview, 10);
});

test('compact canonical enrichment preserves finalized modal membership while adopting canonical identity', () => {
  const context = loadHelpers();
  const finalizedTracks = Array.from({ length: 13 }, (_, index) => ({
    path: `D:\\Synthetic Music\\DDT\\Studio Records\\${String(index + 1).padStart(2, '0')}.mp3`,
    title: `Studio Track ${index + 1}`,
  }));
  const finalizedAlbum = {
    key: 'canonical-studio-source',
    album_ref: 'canonical-studio-source',
    request_key: 'save-task-studio-source',
    identity_key: 'save-task-studio-source',
    name: 'Studio Records',
    album_artist: 'DDT',
    year: 1999,
    preview_only: false,
    track_count_preview: 13,
    tracks: finalizedTracks,
  };
  const canonicalCompactAlbum = {
    key: 'canonical-studio-source',
    album_ref: 'canonical-studio-source',
    request_key: 'postgres-studio-source',
    identity_key: 'postgres-studio-source',
    name: 'Studio Records',
    album_artist: 'DDT',
    year: 1999,
    edition: 'Original',
    cover_path: 'D:\\Synthetic Music\\DDT\\Studio Records\\cover.jpg',
    preview_only: true,
    track_count_preview: 13,
    tracks: [],
  };

  const [enrichedAlbum] = context.enrichFinalizedAlbumsWithCanonicalVisibleProjections(
    [finalizedAlbum],
    [canonicalCompactAlbum],
  );

  assert.equal(enrichedAlbum.key, 'canonical-studio-source');
  assert.equal(enrichedAlbum.request_key, 'postgres-studio-source');
  assert.equal(enrichedAlbum.identity_key, 'postgres-studio-source');
  assert.equal(enrichedAlbum.edition, 'Original');
  assert.equal(enrichedAlbum.cover_path, canonicalCompactAlbum.cover_path);
  assert.equal(enrichedAlbum.preview_only, false);
  assert.equal(enrichedAlbum.track_count_preview, 13);
  assert.deepEqual(
    Array.from(enrichedAlbum.tracks, (track) => track.path),
    finalizedTracks.map((track) => track.path),
  );
});

test('compact finalized album restores hydrated modal tracks from its optimistic membership', () => {
  const context = loadHelpers();
  const siblingTrack = {
    path: 'D:\\Synthetic Music\\Rarity Artist\\Album\\02 Sibling.mp3',
    title: 'Sibling',
    duration_seconds: 4,
  };
  const finalizedAlbum = {
    key: 'canonical-rarity-album',
    request_key: 'canonical-rarity-request',
    identity_key: 'canonical-rarity-identity',
    name: 'Album',
    album_artist: 'Rarity Artist',
    year: 2026,
    preview_only: true,
    track_paths: [siblingTrack.path],
    track_count_preview: 1,
    total_duration_seconds: 4,
    tracks: [],
  };
  const optimisticAlbum = {
    name: finalizedAlbum.name,
    album_artist: finalizedAlbum.album_artist,
    year: finalizedAlbum.year,
    tracks: [siblingTrack],
  };

  const [modalAlbum] = context.enrichFinalizedAlbumsWithOptimisticModalTracks(
    [finalizedAlbum],
    [optimisticAlbum],
  );

  assert.equal(modalAlbum.request_key, finalizedAlbum.request_key);
  assert.equal(modalAlbum.identity_key, finalizedAlbum.identity_key);
  assert.equal(modalAlbum.preview_only, false);
  assert.deepEqual(Array.from(modalAlbum.tracks), [siblingTrack]);
});

test('applyUpdatedAlbumsToCurrentView preserves a distinct same-name/year trackless preview', () => {
  const context = loadHelpers();
  const targetedPreview = {
    key: 'preview-target',
    album_ref: 'stable-preview-target',
    name: 'Same Name',
    album_artist: 'Rarity Artist',
    year: 2000,
  };
  const distinctPreview = {
    key: 'preview-distinct',
    album_ref: 'stable-preview-distinct',
    name: 'Same Name',
    album_artist: 'Rarity Artist',
    year: 2000,
  };
  const hydratedOriginalAlbum = {
    ...targetedPreview,
    tracks: [{ path: 'D:\\Synthetic Music\\Rarity Artist\\Same Name\\01 Track.mp3' }],
  };
  const hydratedTarget = {
    key: 'hydrated-target',
    album_ref: 'stable-preview-target',
    name: 'Same Name',
    album_artist: 'Rarity Artist',
    year: 2000,
    tracks: [{ path: 'D:\\Synthetic Music\\Rarity Artist\\Same Name\\01 Track.mp3' }],
  };
  context.state.view.selected_artist = '';
  context.state.view.primary_artist_groups = [];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = [{
    artist: 'Rarity Artist',
    albums: [targetedPreview, distinctPreview],
  }];
  context.getAlbumRequestKey = (album) => String(album?.album_ref || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');

  context.applyUpdatedAlbumsToCurrentView(
    [hydratedTarget],
    { originalAlbum: hydratedOriginalAlbum, skipRender: true },
  );

  assert.equal(context.lastMergedPayload.album_count, 2);
  assert.deepEqual(
    new Set(context.lastMergedPayload.artist_groups[0].albums.map((album) => album.key)),
    new Set(['preview-distinct', 'hydrated-target']),
  );
});

test('updateOpenTrackModalAfterTagEdit reconciles stale modal aliases to the remaining track', () => {
  const context = loadHelpers();
  const removedPath = 'D:\\Synthetic Music\\Rarity Artist\\Two Tracks\\01 Apply Rarity.mp3';
  const siblingPath = 'D:\\Synthetic Music\\Rarity Artist\\Two Tracks\\02 Remain Editable.mp3';
  const originalAlbum = {
    key: 'rarity-album-before-save',
    request_key: 'request-before-save',
    identity_key: 'identity-before-save',
    name: 'Two Tracks',
    album_artist: 'Rarity Artist',
    tracks: [
      { path: removedPath, title: 'Apply Rarity' },
      { path: siblingPath, title: 'Remain Editable' },
    ],
  };
  const currentAlbum = {
    ...originalAlbum,
    key: 'rarity-album-current-modal',
    request_key: 'request-current-modal',
    identity_key: 'identity-current-modal',
  };
  const canonicalAlbum = {
    ...originalAlbum,
    key: 'rarity-album-after-save',
    request_key: 'request-after-save',
    identity_key: 'identity-after-save',
    tracks: [{ path: siblingPath, title: 'Remain Editable' }],
  };
  const cacheCalls = [];
  context.state.view.selected_artist = 'Rarity Artist';
  context.state.view.related_artists = [];
  context.state.view.artist_groups = [{ artist: 'Rarity Artist', albums: [originalAlbum] }];
  context.state.view.primary_artist_groups = [{ artist: 'Rarity Artist', albums: [originalAlbum] }];
  context.state.view.family_artist_groups = [];
  context.state.modalReleases = [currentAlbum];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: false } : null
  );
  context.getAlbumRequestKey = (album) => String(album?.request_key || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.identity_key || album?.key || '');
  context.cacheHydratedTrackModalAlbum = (albumKey, album, options = {}) => {
    cacheCalls.push({ albumKey, album, aliases: Array.from(options.aliases || []) });
  };
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = () => {};

  context.updateOpenTrackModalAfterTagEdit(originalAlbum, [canonicalAlbum]);

  assert.equal(cacheCalls.length, 1);
  assert.equal(cacheCalls[0].albumKey, 'request-after-save');
  assert.strictEqual(cacheCalls[0].album, canonicalAlbum);
  assert.deepEqual(
    new Set(cacheCalls[0].aliases),
    new Set([
      'request-before-save',
      'identity-before-save',
      'request-current-modal',
      'identity-current-modal',
    ]),
  );
  assert.strictEqual(context.state.modalReleases[0], canonicalAlbum);
  assert.deepEqual(
    Array.from(context.state.modalReleases[0].tracks, (track) => track.title),
    ['Remain Editable'],
  );
});

test('updateOpenTrackModalAfterTagEdit preserves the newly hydrated post-edit source over an empty canonical preview', () => {
  const context = loadHelpers();
  const originalTracks = Array.from({ length: 13 }, (_value, index) => ({
    path: `D:\\Synthetic Music\\DDT\\Studio Records\\${String(index + 1).padStart(2, '0')}.mp3`,
    title: `Studio Track ${index + 1}`,
  }));
  const originalAlbum = {
    key: 'studio-source-before-save',
    request_key: 'studio-source-before-request',
    identity_key: 'studio-source-before-identity',
    name: 'Studio Records',
    album_artist: 'DDT',
    year: 1999,
    preview_only: false,
    track_count_preview: 13,
    tracks: originalTracks,
  };
  const currentHydratedAlbum = {
    ...originalAlbum,
    key: 'studio-source-current',
    request_key: 'studio-source-current-request',
    identity_key: 'studio-source-current-identity',
    track_count_preview: 12,
    tracks: originalTracks.slice(1),
  };
  const canonicalCompactAlbum = {
    ...originalAlbum,
    key: 'studio-source-canonical',
    request_key: 'studio-source-canonical-request',
    identity_key: 'studio-source-canonical-identity',
    edition: 'Canonical edition',
    preview_only: true,
    track_count_preview: 12,
    tracks: [],
  };
  const cacheCalls = [];
  const renderedAlbums = [];
  context.state.modalReleases = [currentHydratedAlbum];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (id === 'track-modal' ? { hidden: false } : null);
  context.getAlbumRequestKey = (album) => String(album?.request_key || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.identity_key || album?.key || '');
  context.cacheHydratedTrackModalAlbum = (albumKey, album, options = {}) => {
    cacheCalls.push({ albumKey, album, aliases: Array.from(options.aliases || []) });
  };
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = (album) => renderedAlbums.push(album);

  context.updateOpenTrackModalAfterTagEdit(
    originalAlbum,
    [canonicalCompactAlbum],
    {
      patchVisibleState: false,
      preserveHydratedModalAfterCanonicalSave: true,
    },
  );

  const [modalAlbum] = context.state.modalReleases;
  assert.equal(modalAlbum.key, canonicalCompactAlbum.key);
  assert.equal(modalAlbum.edition, canonicalCompactAlbum.edition);
  assert.equal(modalAlbum.preview_only, false);
  assert.equal(modalAlbum.track_count_preview, 12);
  assert.deepEqual(
    Array.from(modalAlbum.tracks, (track) => track.path),
    currentHydratedAlbum.tracks.map((track) => track.path),
    'terminal canonical refresh must retain the post-edit 12-track modal, not the 13-track pre-edit source',
  );
  assert.deepEqual(renderedAlbums, [modalAlbum]);
  assert.ok(cacheCalls.some((call) => call.album === modalAlbum));
});

test('updateOpenTrackModalAfterTagEdit retains the hydrated modal when an empty preview declares conflicting membership', () => {
  const context = loadHelpers();
  const originalTracks = Array.from({ length: 13 }, (_value, index) => ({
    path: `D:\\Synthetic Music\\DDT\\Studio Records\\${String(index + 1).padStart(2, '0')}.mp3`,
    title: `Studio Track ${index + 1}`,
  }));
  const originalAlbum = {
    key: 'studio-source-before-save',
    name: 'Studio Records',
    album_artist: 'DDT',
    year: 1999,
    preview_only: false,
    track_count_preview: 13,
    tracks: originalTracks,
  };
  const currentHydratedAlbum = {
    ...originalAlbum,
    key: 'studio-source-current',
    track_count_preview: 12,
    tracks: originalTracks.slice(1),
  };
  const conflictingCompactAlbum = {
    ...originalAlbum,
    key: 'studio-source-transient-canonical',
    request_key: 'studio-source-transient-request',
    identity_key: 'studio-source-transient-identity',
    preview_only: true,
    track_count_preview: 25,
    tracks: [],
  };
  const renderedAlbums = [];
  context.state.modalReleases = [currentHydratedAlbum];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (id === 'track-modal' ? { hidden: false } : null);
  context.getAlbumRequestKey = (album) => String(album?.request_key || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.identity_key || album?.key || '');
  context.cacheHydratedTrackModalAlbum = () => {};
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = (album) => renderedAlbums.push(album);

  context.updateOpenTrackModalAfterTagEdit(
    originalAlbum,
    [conflictingCompactAlbum],
    {
      patchVisibleState: false,
      preserveHydratedModalAfterCanonicalSave: true,
    },
  );

  assert.strictEqual(context.state.modalReleases[0], currentHydratedAlbum);
  assert.deepEqual(renderedAlbums, [currentHydratedAlbum]);
  assert.equal(currentHydratedAlbum.preview_only, false);
  assert.deepEqual(
    currentHydratedAlbum.tracks.map((track) => track.path),
    originalTracks.slice(1).map((track) => track.path),
  );
});

test('updateOpenTrackModalAfterTagEdit refreshes same-count membership aliases while modal is closed', () => {
  const context = loadHelpers();
  const retainedPath = 'D:\\Synthetic Music\\Rarity Artist\\Two Tracks\\01 Retained.mp3';
  const removedPath = 'D:\\Synthetic Music\\Rarity Artist\\Two Tracks\\02 Removed.mp3';
  const replacementPath = 'D:\\Synthetic Music\\Rarity Artist\\Two Tracks\\03 Replacement.mp3';
  const originalAlbum = {
    key: 'rarity-album-before-save',
    request_key: 'request-before-save',
    identity_key: 'identity-before-save',
    name: 'Two Tracks',
    album_artist: 'Rarity Artist',
    tracks: [
      { path: retainedPath, title: 'Retained' },
      { path: removedPath, title: 'Removed' },
    ],
  };
  const canonicalAlbum = {
    ...originalAlbum,
    key: 'rarity-album-after-save',
    request_key: 'request-after-save',
    identity_key: 'identity-after-save',
    tracks: [
      { path: retainedPath, title: 'Retained' },
      { path: replacementPath, title: 'Replacement' },
    ],
  };
  const cacheCalls = [];
  context.document.getElementById = (id) => (id === 'track-modal' ? { hidden: true } : null);
  context.getAlbumRequestKey = (album) => String(album?.request_key || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.identity_key || album?.key || '');
  context.cacheHydratedTrackModalAlbum = (albumKey, album, options = {}) => {
    cacheCalls.push({ albumKey, album, aliases: Array.from(options.aliases || []) });
  };

  context.updateOpenTrackModalAfterTagEdit(originalAlbum, [canonicalAlbum]);

  assert.equal(cacheCalls.length, 1);
  assert.equal(cacheCalls[0].albumKey, 'request-after-save');
  assert.strictEqual(cacheCalls[0].album, canonicalAlbum);
  assert.deepEqual(
    new Set(cacheCalls[0].aliases),
    new Set(['request-before-save', 'identity-before-save']),
    'closed-modal saves must replace stale same-count membership under historical aliases',
  );
});

test('updateOpenTrackModalAfterTagEdit keeps a year-split source alias independent of candidate order', () => {
  const retainedPaths = Array.from({ length: 17 }, (_value, index) => (
    `D:\\Synthetic Music\\Rarity Artist\\Sparse Year\\${String(index + 2).padStart(2, '0')}.mp3`
  ));
  const movedPath = 'D:\\Synthetic Music\\Rarity Artist\\Sparse Year\\01.mp3';
  const originalAlbum = {
    key: 'persistent-album-before-year-split',
    request_key: 'request-before-year-split',
    identity_key: 'identity-before-year-split',
    name: 'Sparse Year',
    album_artist: 'Rarity Artist',
    year: 2004,
    tracks: [
      { path: movedPath, title: 'Move' },
      ...retainedPaths.map((path) => ({ path, title: path })),
    ],
  };
  const remainingSource = {
    ...originalAlbum,
    key: 'persistent-album-remaining-source',
    request_key: 'request-remaining-source',
    identity_key: 'identity-remaining-source',
    tracks: retainedPaths.map((path) => ({ path, title: path })),
  };
  const movedDestination = {
    ...originalAlbum,
    year: 2014,
    tracks: [{ path: movedPath, title: 'Move' }],
  };

  for (const candidates of [
    [remainingSource, movedDestination],
    [movedDestination, remainingSource],
  ]) {
    const context = loadHelpers();
    const cachedByAlias = new Map();
    context.document.getElementById = (id) => (id === 'track-modal' ? { hidden: true } : null);
    context.getAlbumRequestKey = (album) => String(album?.request_key || album?.key || '');
    context.getAlbumIdentity = (album) => String(album?.identity_key || album?.key || '');
    context.cacheHydratedTrackModalAlbum = (albumKey, album, options = {}) => {
      [
        albumKey,
        context.getAlbumRequestKey(album),
        context.getAlbumIdentity(album),
        ...Array.from(options.aliases || []),
      ].map((alias) => String(alias || '').trim()).filter(Boolean).forEach((alias) => {
        cachedByAlias.set(alias, album);
      });
    };

    context.updateOpenTrackModalAfterTagEdit(originalAlbum, candidates);

    assert.strictEqual(
      cachedByAlias.get(originalAlbum.request_key),
      remainingSource,
      'the historical source request key must resolve to the retained 2004 membership',
    );
    assert.strictEqual(
      cachedByAlias.get(originalAlbum.identity_key),
      remainingSource,
      'the historical source identity must resolve to the retained 2004 membership',
    );
  }
});

test('updateOpenTrackModalAfterTagEdit does not let an older save replace a newly opened sibling modal', () => {
  const context = loadHelpers();
  const suffix5Track = {
    path: 'D:\\Synthetic Music\\DDT\\Studio Records\\04.mp3',
    title: 'Studio Track 4',
  };
  const suffix4Track = {
    path: 'D:\\Synthetic Music\\DDT\\Studio Records\\03.mp3',
    title: 'Studio Track 3',
  };
  const originalSuffix5 = {
    key: 'studio-suffix-5',
    request_key: 'request-suffix-5',
    identity_key: 'identity-suffix-5',
    name: 'Studio Records5',
    album_artist: 'DDT',
    tracks: [suffix5Track],
  };
  const newlyOpenedSuffix4 = {
    key: 'studio-suffix-4',
    request_key: 'request-suffix-4',
    identity_key: 'identity-suffix-4',
    name: 'Studio Records4',
    album_artist: 'DDT',
    tracks: [suffix4Track],
  };
  const restoredSource = {
    key: 'studio-source',
    request_key: 'request-source',
    identity_key: 'identity-source',
    name: 'Studio Records',
    album_artist: 'DDT',
    tracks: Array.from({ length: 13 }, (_value, index) => ({
      path: `D:\\Synthetic Music\\DDT\\Studio Records\\${String(index + 4).padStart(2, '0')}.mp3`,
      title: `Studio Track ${index + 4}`,
    })),
  };
  const cacheCalls = [];
  const renderedAlbums = [];
  context.state.modalReleases = [newlyOpenedSuffix4];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (id === 'track-modal' ? { hidden: false } : null);
  context.getAlbumRequestKey = (album) => String(album?.request_key || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.identity_key || album?.key || '');
  context.cacheHydratedTrackModalAlbum = (albumKey, album, options = {}) => {
    cacheCalls.push({ albumKey, album, aliases: Array.from(options.aliases || []) });
  };
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = (album) => renderedAlbums.push(album);

  context.updateOpenTrackModalAfterTagEdit(originalSuffix5, [restoredSource]);

  assert.strictEqual(
    context.state.modalReleases[0],
    newlyOpenedSuffix4,
    'the newer sibling modal must remain active while the older restore finishes',
  );
  assert.deepEqual(renderedAlbums, []);
  assert.equal(cacheCalls.length, 1);
  assert.strictEqual(cacheCalls[0].album, restoredSource);
  assert.deepEqual(
    new Set(cacheCalls[0].aliases),
    new Set(['request-suffix-5', 'identity-suffix-5']),
    'the older restore must not assign its source membership to the newer suffix aliases',
  );
});

test('updateOpenTrackModalAfterTagEdit keeps source aliases on the remaining album when destination is first', () => {
  const context = loadHelpers();
  const movedTrackPath = 'D:\\Synthetic Music\\Rarity Artist\\Source\\01 Move.mp3';
  const siblingTrackPath = 'D:\\Synthetic Music\\Rarity Artist\\Source\\02 Stay.mp3';
  const originalAlbum = {
    key: 'source-before-save',
    request_key: 'request-before-save',
    identity_key: 'identity-before-save',
    name: 'Source',
    album_artist: 'Rarity Artist',
    tracks: [
      { path: movedTrackPath, title: 'Move' },
      { path: siblingTrackPath, title: 'Stay' },
    ],
  };
  const currentModalAlbum = {
    ...originalAlbum,
    key: 'source-current-modal',
    request_key: 'request-current-modal',
    identity_key: 'identity-current-modal',
  };
  const movedDestinationAlbum = {
    key: 'destination-after-save',
    request_key: 'request-destination-after-save',
    identity_key: 'identity-destination-after-save',
    name: 'Destination',
    album_artist: 'Rarity Artist',
    tracks: [{ path: movedTrackPath, title: 'Move' }],
  };
  const remainingSourceAlbum = {
    key: 'source-after-save',
    request_key: 'request-source-after-save',
    identity_key: 'identity-source-after-save',
    name: 'Source',
    album_artist: 'Rarity Artist',
    tracks: [{ path: siblingTrackPath, title: 'Stay' }],
  };
  const cacheCalls = [];
  const renderedAlbums = [];
  context.state.view.selected_artist = 'Rarity Artist';
  context.state.view.related_artists = [];
  context.state.view.artist_groups = [{ artist: 'Rarity Artist', albums: [originalAlbum] }];
  context.state.view.primary_artist_groups = [{ artist: 'Rarity Artist', albums: [originalAlbum] }];
  context.state.view.family_artist_groups = [];
  context.state.modalReleases = [currentModalAlbum];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (id === 'track-modal' ? { hidden: false } : null);
  context.getAlbumRequestKey = (album) => String(album?.request_key || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.identity_key || album?.key || '');
  context.cacheHydratedTrackModalAlbum = (albumKey, album, options = {}) => {
    cacheCalls.push({ albumKey, album, aliases: Array.from(options.aliases || []) });
  };
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = (album) => renderedAlbums.push(album);

  context.updateOpenTrackModalAfterTagEdit(
    originalAlbum,
    [movedDestinationAlbum, remainingSourceAlbum],
  );

  assert.strictEqual(
    context.state.modalReleases[0],
    remainingSourceAlbum,
    'a partial split must keep the already-open Album Details modal on the remaining source',
  );
  assert.deepEqual(renderedAlbums, [remainingSourceAlbum]);
  const remainingSourceCache = cacheCalls.find((call) => call.album === remainingSourceAlbum);
  assert.ok(remainingSourceCache, 'the remaining source must receive its own hydrated cache entry');
  assert.equal(remainingSourceCache.albumKey, 'request-source-after-save');
  assert.deepEqual(
    new Set(remainingSourceCache.aliases),
    new Set([
      'request-before-save',
      'identity-before-save',
      'request-current-modal',
      'identity-current-modal',
    ]),
    'historical source aliases must remain owned by the remaining source album',
  );
  const movedDestinationCache = cacheCalls.find((call) => call.album === movedDestinationAlbum);
  assert.ok(movedDestinationCache, 'the moved destination must retain its own hydrated cache entry');
  assert.equal(movedDestinationCache.albumKey, 'request-destination-after-save');
  assert.deepEqual(
    movedDestinationCache.aliases,
    [],
    'the destination cache entry must not inherit historical source aliases',
  );
});

test('applyUpdatedAlbumsToCurrentView merges a restored track into hydrated source membership', () => {
  const context = loadHelpers();
  const sourceTracks = Array.from({ length: 12 }, (_, index) => ({
    path: `D:\\Synthetic Music\\ДДТ\\Студийные записи\\${String(index + 5).padStart(2, '0')}.mp3`,
    title: `Source Track ${index + 5}`,
  }));
  const restoredTrack = {
    path: 'D:\\Synthetic Music\\ДДТ\\Студийные записи\\04.mp3',
    title: 'Restored Track 4',
  };
  const compactSourcePreview = {
    key: 'ddt::studio-records',
    album_ref: 'ddt::studio-records',
    name: 'Студийные записи',
    album_artist: 'ДДТ',
    year: 1999,
    preview_only: true,
    track_count_preview: 12,
  };
  const suffixAlbum = {
    key: 'ddt::studio-records5',
    album_ref: 'ddt::studio-records5',
    name: 'Студийные записи5',
    album_artist: 'ДДТ',
    year: 1999,
    tracks: [restoredTrack],
  };
  const hydratedSource = {
    ...compactSourcePreview,
    preview_only: false,
    tracks: sourceTracks,
  };
  const optimisticRestoredSource = {
    ...compactSourcePreview,
    preview_only: false,
    tracks: [restoredTrack],
  };
  context.state.view.selected_artist = 'ДДТ';
  context.state.view.related_artists = [];
  context.state.view.primary_artist_groups = [{
    artist: 'ДДТ',
    albums: [compactSourcePreview, suffixAlbum],
  }];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = context.state.view.primary_artist_groups;
  context.state.modalReleases = [suffixAlbum];
  context.state.modalReleaseIndex = 0;
  context.state.gallery = {
    albumIndex: new Map([
      [compactSourcePreview.key, hydratedSource],
      [compactSourcePreview.album_ref, hydratedSource],
    ]),
  };
  context.getAlbumRequestKey = (album) => String(album?.album_ref || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');

  context.applyUpdatedAlbumsToCurrentView(
    [optimisticRestoredSource],
    { originalAlbum: suffixAlbum, skipRender: true },
  );

  const source = context.lastMergedPayload.artist_groups[0].albums.find(
    (album) => album.name === 'Студийные записи',
  );
  assert.equal(source.tracks.length, 13);
  assert.deepEqual(
    Array.from(source.tracks, (track) => track.path),
    [restoredTrack.path, ...sourceTracks.map((track) => track.path)],
  );
  assert.equal(source.track_count_preview, 13);
});

test('applyUpdatedAlbumsToCurrentView restores compact source membership from the hydrated modal cache', () => {
  const context = loadHelpers();
  const sourceAlias = 'ддт::студийные записи::fixture edition';
  const sourceTracks = Array.from({ length: 12 }, (_, index) => ({
    path: `D:\\Synthetic Music\\ДДТ\\Студийные записи\\${String(index + 5).padStart(2, '0')}.mp3`,
    title: `Source Track ${index + 5}`,
    track_number: index + 5,
  }));
  const restoredTrack = {
    path: 'D:\\Synthetic Music\\ДДТ\\Студийные записи\\04.mp3',
    title: 'Restored Track 4',
    track_number: 4,
  };
  const compactSourcePreview = {
    key: sourceAlias,
    album_ref: sourceAlias,
    request_key: sourceAlias,
    identity_key: sourceAlias,
    name: 'Студийные записи',
    album_artist: 'ДДТ',
    edition: 'Fixture Edition',
    year: 1999,
    preview_only: true,
    track_count_preview: 12,
    tracks: [],
  };
  const hydratedSource = {
    ...compactSourcePreview,
    preview_only: false,
    tracks: sourceTracks,
  };
  const suffixAlbum = {
    key: 'ддт::студийные записи4::fixture edition',
    album_ref: 'ддт::студийные записи4::fixture edition',
    name: 'Студийные записи4',
    album_artist: 'ДДТ',
    edition: 'Fixture Edition',
    year: 1999,
    preview_only: false,
    track_count_preview: 1,
    tracks: [restoredTrack],
  };
  const optimisticRestoredSource = {
    ...compactSourcePreview,
    preview_only: false,
    track_count_preview: 1,
    tracks: [restoredTrack],
  };
  context.state.view.selected_artist = 'ДДТ';
  context.state.view.related_artists = [];
  context.state.view.primary_artist_groups = [{
    artist: 'ДДТ',
    albums: [compactSourcePreview, suffixAlbum],
  }];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = context.state.view.primary_artist_groups;
  context.state.gallery = {
    albumIndex: new Map([[sourceAlias, compactSourcePreview]]),
  };
  context.getAlbumRequestKey = (album) => String(album?.request_key || album?.album_ref || '');
  context.getAlbumIdentity = (album) => String(album?.identity_key || album?.key || '');
  const hydratedCacheLookups = [];
  context.getCachedHydratedTrackModalAlbum = (alias) => {
    hydratedCacheLookups.push(alias);
    return alias === sourceAlias ? hydratedSource : null;
  };

  context.applyUpdatedAlbumsToCurrentView(
    [optimisticRestoredSource],
    { originalAlbum: suffixAlbum, skipRender: true },
  );

  const source = context.lastMergedPayload.artist_groups[0].albums.find(
    (album) => album.name === 'Студийные записи',
  );
  assert.equal(
    context.lastMergedPayload.artist_groups[0].albums.some(
      (album) => album.name === suffixAlbum.name,
    ),
    false,
    'the immediate optimistic restore must remove the emptied suffix album',
  );
  assert.equal(
    source.tracks.length,
    13,
    'the immediate optimistic restore must retain all 12 hydrated source tracks',
  );
  assert.deepEqual(
    Array.from(source.tracks, (track) => track.path),
    [restoredTrack.path, ...sourceTracks.map((track) => track.path)],
  );
  assert.equal(source.track_count_preview, 13);
  assert.deepEqual(
    Array.from(new Set(hydratedCacheLookups)),
    [sourceAlias],
    'the compact gallery index must fall back to the hydrated modal cache by the same alias',
  );
});

test('applyUpdatedAlbumsToCurrentView reconciles duplicate selected-artist source projections during restore', () => {
  const context = loadHelpers();
  const sourcePaths = Array.from({ length: 13 }, (_value, index) => (
    `D:\\Synthetic Music\\DDT\\Studio Records\\${String(index + 4).padStart(2, '0')}.mp3`
  ));
  const restoredTrack = {
    path: 'D:\\Synthetic Music\\DDT\\Studio Records\\03.mp3',
    title: 'Restored Track 3',
  };
  const qualifiedSourceKey = 'ddt::studio-records::fixture-edition';
  const simpleSourceKey = 'ddt::studio-records';
  const compactPrimarySource = {
    key: qualifiedSourceKey,
    album_ref: qualifiedSourceKey,
    name: 'Studio Records',
    album_artist: 'DDT',
    edition: 'Fixture Edition',
    year: 1999,
    preview_only: true,
    track_count_preview: 13,
    track_paths: [],
    tracks: [],
  };
  const duplicateLogicalSource = {
    ...compactPrimarySource,
    key: simpleSourceKey,
    album_ref: simpleSourceKey,
    edition: null,
    track_paths: sourcePaths,
  };
  const suffixAlbum = {
    key: 'ddt::studio-records4::fixture-edition',
    album_ref: 'ddt::studio-records4::fixture-edition',
    name: 'Studio Records4',
    album_artist: 'DDT',
    edition: 'Fixture Edition',
    year: 1999,
    preview_only: false,
    track_count_preview: 1,
    track_paths: [restoredTrack.path],
    tracks: [restoredTrack],
  };
  const optimisticRestoredSource = {
    ...compactPrimarySource,
    key: simpleSourceKey,
    album_ref: simpleSourceKey,
    edition: null,
    preview_only: false,
    track_count_preview: 1,
    track_paths: [restoredTrack.path],
    tracks: [restoredTrack],
  };
  context.state.view.selected_artist = 'DDT';
  context.state.view.related_artists = [];
  context.state.view.primary_artist_groups = [{
    artist: 'DDT',
    albums: [compactPrimarySource, suffixAlbum],
  }];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = [{
    artist: 'DDT',
    albums: [duplicateLogicalSource, suffixAlbum],
  }];
  context.getAlbumRequestKey = (album) => String(album?.album_ref || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');

  context.applyUpdatedAlbumsToCurrentView(
    [optimisticRestoredSource],
    { originalAlbum: suffixAlbum, skipRender: true },
  );

  for (const groups of [
    context.lastMergedPayload.primary_artist_groups,
    context.lastMergedPayload.artist_groups,
  ]) {
    const albums = groups.flatMap((group) => group.albums || []);
    const sources = albums.filter((album) => album.name === 'Studio Records');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].key, simpleSourceKey);
    assert.equal(sources[0].album_ref, simpleSourceKey);
    assert.equal(sources[0].track_count_preview, 14);
    assert.deepEqual(
      new Set(sources[0].track_paths),
      new Set([restoredTrack.path, ...sourcePaths]),
    );
    assert.equal(albums.some((album) => album.name === suffixAlbum.name), false);
  }
});

test('updateOpenTrackModalAfterTagEdit keeps source aliases on the remaining album when source is first', () => {
  const context = loadHelpers();
  const movedTrackPath = 'D:\\Synthetic Music\\Rarity Artist\\Source\\01 Move.mp3';
  const siblingTrackPath = 'D:\\Synthetic Music\\Rarity Artist\\Source\\02 Stay.mp3';
  const originalAlbum = {
    key: 'rarity artist::source',
    name: 'Source',
    album_artist: 'Rarity Artist',
    year: 2026,
    tracks: [
      { path: movedTrackPath, title: 'Move' },
      { path: siblingTrackPath, title: 'Stay' },
    ],
  };
  const remainingSourceAlbum = {
    ...originalAlbum,
    tracks: [{ path: siblingTrackPath, title: 'Stay' }],
  };
  const movedDestinationAlbum = {
    key: 'rarity artist::destination',
    name: 'Destination',
    album_artist: 'Rarity Artist',
    year: 2026,
    tracks: [{ path: movedTrackPath, title: 'Move' }],
  };
  const cacheCalls = [];
  context.state.modalReleases = [originalAlbum];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (id === 'track-modal' ? { hidden: false } : null);
  context.getAlbumRequestKey = (album) => String(album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.cacheHydratedTrackModalAlbum = (albumKey, album, options = {}) => {
    cacheCalls.push({ albumKey, album, aliases: Array.from(options.aliases || []) });
  };
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = () => {};

  context.updateOpenTrackModalAfterTagEdit(
    originalAlbum,
    [remainingSourceAlbum, movedDestinationAlbum],
  );

  const sourceCache = cacheCalls.find((call) => call.album === remainingSourceAlbum);
  assert.ok(sourceCache);
  assert.deepEqual(new Set(sourceCache.aliases), new Set([originalAlbum.key]));
  const destinationCache = cacheCalls.find((call) => call.album === movedDestinationAlbum);
  assert.ok(destinationCache);
  assert.deepEqual(destinationCache.aliases, []);
});

test('watchSaveTask reconciles an open destination modal locally after a structural merge', async () => {
  const context = loadHelpers();
  const destinationTrackPath = 'D:\\Synthetic Music\\Merge Artist\\Destination\\01 Existing.mp3';
  const movedTrackPath = 'D:\\Synthetic Music\\Merge Artist\\Source\\02 Move Me.mp3';
  const sourceSiblingPath = 'D:\\Synthetic Music\\Merge Artist\\Source\\01 Stay Put.mp3';
  const originalAlbum = {
    key: 'source-before-merge',
    name: 'Source',
    album_artist: 'Merge Artist',
    tracks: [
      { path: sourceSiblingPath, title: 'Stay Put' },
      { path: movedTrackPath, title: 'Move Me' },
    ],
  };
  const staleDestinationAlbum = {
    key: 'destination',
    name: 'Destination',
    album_artist: 'Merge Artist',
    tracks: [{ path: destinationTrackPath, title: 'Existing' }],
  };
  const refreshedSourceAlbum = {
    ...originalAlbum,
    tracks: [{ path: sourceSiblingPath, title: 'Stay Put' }],
  };
  const refreshedDestinationAlbum = {
    ...staleDestinationAlbum,
    tracks: [
      { path: destinationTrackPath, title: 'Existing' },
      { path: movedTrackPath, title: 'Move Me' },
    ],
  };
  const renderedAlbums = [];
  let refreshCount = 0;
  const completedAlbums = [refreshedSourceAlbum, refreshedDestinationAlbum];
  context.state.view.artist_groups = [{
    artist: 'Merge Artist',
    albums: [originalAlbum, staleDestinationAlbum],
  }];
  context.state.modalReleases = [staleDestinationAlbum];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (id === 'track-modal' ? { hidden: false } : null);
  context.buildApiUrl = () => '/api/library';
  context.fetchAndRender = async () => {
    refreshCount += 1;
    throw new Error('A nonempty finalized structural merge must reconcile without fetching.');
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: completedAlbums,
      };
    },
  });
  context.getAlbumRequestKey = (album) => String(album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.cacheHydratedTrackModalAlbum = () => {};
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = (album) => renderedAlbums.push(album);
  context.showRepairAlert = () => {};

  await context.watchSaveTask('structural-merge-task', { originalAlbum });

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.modalReleases[0])),
    refreshedDestinationAlbum,
  );
  assert.deepEqual(
    Array.from(context.state.modalReleases[0].tracks, (track) => track.title),
    ['Existing', 'Move Me'],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(renderedAlbums)),
    [refreshedDestinationAlbum],
  );
  assert.equal(refreshCount, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.view.artist_groups[0].albums)),
    [refreshedDestinationAlbum, refreshedSourceAlbum],
  );
});

test('watchSaveTask reconciles nonempty finalized state locally without a canonical refresh', async () => {
  const context = loadHelpers();
  const trackPath = 'D:\\Synthetic Music\\Refresh Artist\\Album\\01 Track.flac';
  const finalizedTrack = {
    path: trackPath,
    title: 'Track after save',
    duration_seconds: 125,
    embedded_art: { mime_type: 'image/jpeg', byte_count: 4200 },
  };
  const originalAlbum = {
    key: 'refresh-album',
    name: 'Album',
    album_artist: 'Refresh Artist',
    tracks: [{ path: trackPath, title: 'Track' }],
  };
  const sparseFinalizedAlbum = {
    ...originalAlbum,
    album_preference: null,
    tracks: [finalizedTrack],
  };
  const renderedAlbums = [];
  const cachedAlbums = [];
  let refreshCount = 0;
  context.state.view.artist_groups = [{
    artist: 'Refresh Artist',
    albums: [originalAlbum],
  }];
  context.state.modalReleases = [originalAlbum];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: false } : null
  );
  context.buildApiUrl = () => '/api/library';
  context.fetchAndRender = async () => {
    refreshCount += 1;
    throw new Error('A nonempty finalized album must reconcile without fetching.');
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [sparseFinalizedAlbum],
      };
    },
  });
  context.getAlbumRequestKey = (album) => String(album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.cacheHydratedTrackModalAlbum = (albumKey, album, options = {}) => {
    cachedAlbums.push({ albumKey, album, aliases: Array.from(options.aliases || []) });
  };
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = (album) => renderedAlbums.push(album);
  context.showRepairAlert = () => {};

  await context.watchSaveTask('canonical-refresh-task', { originalAlbum });

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.view.artist_groups[0].albums[0])),
    sparseFinalizedAlbum,
  );
  const enrichedModalAlbum = context.state.modalReleases[0];
  assert.deepEqual(
    JSON.parse(JSON.stringify(enrichedModalAlbum.album_preference)),
    sparseFinalizedAlbum.album_preference,
  );
  assert.equal(enrichedModalAlbum.tracks.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(enrichedModalAlbum.tracks[0])),
    finalizedTrack,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(renderedAlbums)),
    [sparseFinalizedAlbum],
  );
  assert.equal(cachedAlbums.length, 1);
  assert.strictEqual(cachedAlbums[0].album, enrichedModalAlbum);
  assert.equal(refreshCount, 0);
});

test('watchSaveTask adopts canonical structural membership transfers without a second refresh', async () => {
  const context = loadHelpers();
  const existingTracks = Array.from({ length: 12 }, (_, index) => ({
    path: `D:\\Synthetic Music\\DDT\\Studio Records\\${String(index + 5).padStart(2, '0')}.mp3`,
    title: `Studio Track ${index + 5}`,
  }));
  const restoredTrack = {
    path: 'D:\\Synthetic Music\\DDT\\Studio Records\\04.mp3',
    title: 'Studio Track 4',
  };
  const hydratedSource = {
    key: 'legacy-studio-source',
    album_ref: 'legacy-studio-source',
    name: 'Studio Records',
    album_artist: 'DDT',
    year: 1999,
    preview_only: false,
    track_count_preview: 12,
    tracks: existingTracks,
  };
  const suffixAlbum = {
    key: 'studio-suffix-5',
    album_ref: 'studio-suffix-5',
    name: 'Studio Records5',
    album_artist: 'DDT',
    year: 1999,
    preview_only: false,
    track_count_preview: 1,
    tracks: [restoredTrack],
  };
  const finalizedSource = {
    ...hydratedSource,
    key: 'canonical-studio-source',
    album_ref: 'postgres-studio-ref',
    request_key: 'postgres-studio-source',
    identity_key: 'postgres-studio-source',
    edition: 'Original',
    cover_path: 'D:\\Synthetic Music\\DDT\\Studio Records\\cover.jpg',
    track_count_preview: 13,
    tracks: [restoredTrack, ...existingTracks],
  };
  const selectedArtistGroups = [{
    artist: 'DDT',
    albums: [hydratedSource, suffixAlbum],
  }];
  context.state.view.selected_artist = 'DDT';
  context.state.view.primary_artist_groups = selectedArtistGroups;
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = selectedArtistGroups;
  context.state.gallery = {
    albumIndex: new Map([
      [hydratedSource.key, hydratedSource],
      [suffixAlbum.key, suffixAlbum],
    ]),
  };
  const refreshCalls = [];
  const renderOptions = [];
  const localRenderSnapshots = [];
  context.buildApiUrl = () => '/view-data?surface=albums&artist=DDT';
  context.fetchAndRender = async (...args) => {
    refreshCalls.push(args);
    throw new Error('A canonical terminal payload must not start a second gallery refresh.');
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [finalizedSource],
      };
    },
  });
  context.getAlbumRequestKey = (album) => String(album?.key || album?.album_ref || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: true } : null
  );
  context.renderView = (options) => {
    renderOptions.push(options);
    localRenderSnapshots.push(JSON.parse(JSON.stringify(
      context.state.view.artist_groups[0].albums,
    )));
  };
  context.showRepairAlert = () => {};

  await context.watchSaveTask('canonical-compact-membership-task', {
    originalAlbum: suffixAlbum,
    tagEdits: {
      [restoredTrack.path]: { album: 'Studio Records' },
    },
  });

  assert.deepEqual(
    refreshCalls,
    [],
    'the canonical terminal payload must be the only gallery adoption',
  );
  assert.equal(renderOptions.length, 1);
  assert.equal(renderOptions[0].preserveMountedGalleryChildren, true);
  assert.equal(localRenderSnapshots[0].length, 1);
  assert.equal(localRenderSnapshots[0][0].key, finalizedSource.key);
  assert.equal(localRenderSnapshots[0][0].album_ref, finalizedSource.album_ref);
  assert.equal(localRenderSnapshots[0][0].track_count_preview, 13);
  assert.deepEqual(
    Array.from(localRenderSnapshots[0][0].tracks, (track) => track.path),
    [restoredTrack.path, ...existingTracks.map((track) => track.path)],
  );
  const canonicalHydratedSource = context.state.view.artist_groups[0].albums[0];
  assert.strictEqual(
    context.state.view.primary_artist_groups[0].albums[0],
    canonicalHydratedSource,
  );
  assert.equal(canonicalHydratedSource.key, finalizedSource.key);
  assert.equal(canonicalHydratedSource.album_ref, finalizedSource.album_ref);
  assert.equal(canonicalHydratedSource.request_key, finalizedSource.request_key);
  assert.equal(canonicalHydratedSource.identity_key, finalizedSource.identity_key);
  assert.equal(canonicalHydratedSource.edition, finalizedSource.edition);
  assert.equal(canonicalHydratedSource.cover_path, finalizedSource.cover_path);
  assert.equal(canonicalHydratedSource.track_count_preview, 13);
  assert.deepEqual(
    Array.from(canonicalHydratedSource.tracks, (track) => track.path),
    [restoredTrack.path, ...existingTracks.map((track) => track.path)],
    'canonical terminal adoption must retain finalized membership for an immediate restore',
  );
  assert.equal(canonicalHydratedSource.preview_only, false);
  [
    finalizedSource.key,
    finalizedSource.album_ref,
    finalizedSource.request_key,
    finalizedSource.identity_key,
  ].forEach((alias) => {
    const indexedCanonicalSource = context.state.gallery.albumIndex.get(alias);
    assert.strictEqual(
      indexedCanonicalSource,
      canonicalHydratedSource,
      `the next card/modal lookup for ${alias} must use the hydrated canonical album`,
    );
    assert.equal(indexedCanonicalSource.key, finalizedSource.key);
    assert.equal(indexedCanonicalSource.request_key, finalizedSource.request_key);
    assert.equal(indexedCanonicalSource.identity_key, finalizedSource.identity_key);
    assert.equal(indexedCanonicalSource.tracks.length, 13);
  });
});

test('watchSaveTask refreshes a partial year split so the untouched source release remains visible', async () => {
  const context = loadHelpers();
  const selectedPath = 'D:\\Synthetic Music\\Rarity Artist\\Sparse Year Edit Fixture\\01 Selected.flac';
  const siblingPath = 'D:\\Synthetic Music\\Rarity Artist\\Sparse Year Edit Fixture\\02 Sibling.flac';
  const originalAlbum = {
    key: 'rarity-artist::sparse-year-edit-fixture::year::2004',
    request_key: 'rarity-artist::sparse-year-edit-fixture::year::2004',
    identity_key: 'rarity-artist::sparse-year-edit-fixture::year::2004',
    name: 'Sparse Year Edit Fixture',
    album_artist: 'Rarity Artist',
    year: 2004,
    track_paths: [selectedPath],
    tracks: [
      { path: selectedPath, title: 'Selected', year: 2004 },
      { path: siblingPath, title: 'Sibling', year: 2004 },
    ],
  };
  const finalizedDestination = {
    key: 'rarity-artist::sparse-year-edit-fixture::year::2014',
    request_key: 'rarity-artist::sparse-year-edit-fixture::year::2014',
    identity_key: 'rarity-artist::sparse-year-edit-fixture::year::2014',
    name: 'Sparse Year Edit Fixture',
    album_artist: 'Rarity Artist',
    year: 2014,
    tracks: [{ path: selectedPath, title: 'Selected', year: 2014 }],
  };
  const canonicalSource = {
    ...originalAlbum,
    track_paths: [],
    tracks: [{ path: siblingPath, title: 'Sibling', year: 2004 }],
  };
  const canonicalGroups = [{
    artist: 'Rarity Artist',
    albums: [canonicalSource, finalizedDestination],
  }];
  const selectedArtistGroups = [{
    artist: 'Rarity Artist',
    albums: [originalAlbum],
  }];
  context.state.view.selected_artist = 'Rarity Artist';
  context.state.view.primary_artist_groups = selectedArtistGroups;
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = selectedArtistGroups;
  const refreshCalls = [];
  context.buildApiUrl = () => '/view-data?surface=albums&artist=Rarity%20Artist';
  context.fetchAndRender = async (...args) => {
    refreshCalls.push(args);
    context.state.view.primary_artist_groups = canonicalGroups;
    context.state.view.artist_groups = canonicalGroups;
    return true;
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [finalizedDestination],
      };
    },
  });
  context.getAlbumRequestKey = (album) => String(album?.request_key || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.identity_key || album?.key || '');
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: true } : null
  );
  context.renderView = () => {};
  context.showRepairAlert = () => {};

  await context.watchSaveTask('partial-year-split-task', {
    originalAlbum,
    optimisticAlbums: [canonicalSource, finalizedDestination],
    tagEdits: {
      [selectedPath]: { year: '2014' },
    },
  });

  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0][2].preserveGalleryOptionsMenu, true);
  assert.deepEqual(
    Array.from(context.state.view.artist_groups[0].albums, (album) => album.year),
    [2004, 2014],
  );
});

test('watchSaveTask locally reconciles a nonempty requires_view_refresh payload without fetching', async () => {
  const context = loadHelpers();
  const trackPath = 'D:\\Synthetic Music\\Local Reconcile\\Album\\01 Track.flac';
  const originalAlbum = {
    key: 'local-reconcile-album',
    name: 'Album',
    album_artist: 'Local Reconcile',
    tracks: [{ path: trackPath, title: 'Before' }],
  };
  const finalizedAlbum = {
    ...originalAlbum,
    tracks: [{ path: trackPath, title: 'After' }],
  };
  let refreshCount = 0;
  const renderOptions = [];
  const selectedArtistGroups = [{
    artist: 'Local Reconcile',
    albums: [originalAlbum],
  }];
  context.state.view.selected_artist = 'Local Reconcile';
  context.state.view.primary_artist_groups = selectedArtistGroups;
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = selectedArtistGroups;
  context.fetchAndRender = async () => {
    refreshCount += 1;
    throw new Error('The finalized payload must reconcile locally.');
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [finalizedAlbum],
      };
    },
  });
  context.getAlbumRequestKey = (album) => String(album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: true } : null
  );
  context.renderView = (options) => renderOptions.push(options);
  context.showRepairAlert = () => {};

  await context.watchSaveTask('local-reconcile-task', {
    originalAlbum,
    tagEdits: {
      [trackPath]: { track_number: '2' },
    },
  });

  assert.equal(refreshCount, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.view.artist_groups[0].albums)),
    [finalizedAlbum],
  );
  assert.equal(renderOptions.length, 1);
  assert.equal(renderOptions[0].preserveMountedGalleryChildren, true);
});

test('watchSaveTask refreshes already-loaded Problematic Files after structural completion', async () => {
  const context = loadHelpers();
  const problematicLoads = [];
  const viewRefreshes = [];
  context.state.ui = { viewStateRevision: 81 };
  context.state.utility = {
    loaded: true,
    problematicFiles: [{
      key: 'studio-records-4',
      name: 'Studio Records4',
    }],
  };
  context.buildApiUrl = () => '/view-data?surface=albums&artist=DDT';
  context.fetchAndRender = async (...args) => {
    viewRefreshes.push(args);
    return true;
  };
  context.loadProblematicFiles = async (force) => {
    problematicLoads.push(force);
    context.state.utility.problematicFiles = [
      ...context.state.utility.problematicFiles,
      {
        key: 'studio-records-5',
        name: 'Studio Records5',
      },
    ];
    return context.state.utility.problematicFiles;
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      context.state.ui.viewStateRevision = 82;
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [],
        updated_problematic_album: null,
      };
    },
  });
  context.showRepairAlert = () => {};
  context.settleTagEditViewMutation = () => {};

  await context.watchSaveTask('studio-records-split-5', {
    originatingViewStateRevision: 81,
  });

  assert.equal(viewRefreshes.length, 1);
  assert.deepEqual(
    problematicLoads,
    [true],
    'terminal structural completion must refresh a Problematic Files summary that loaded while the save was pending',
  );
  assert.deepEqual(
    Array.from(context.state.utility.problematicFiles, (album) => album.name),
    ['Studio Records4', 'Studio Records5'],
  );
});

test('terminal Problematic Files refresh does not render its prior selection during owned track navigation', async () => {
  const context = loadHelpers();
  const trackPath = 'C:\\Music\\DDT\\Studio Records\\04 Track.flac';
  const previousAlbum = {
    key: 'studio-records-4',
    name: 'Studio Records4',
    detail_loaded: true,
    track_paths: ['C:\\Music\\DDT\\Studio Records\\03 Track.flac'],
  };
  const targetAlbum = {
    key: 'studio-records-5',
    name: 'Studio Records5',
    detail_loaded: true,
    problematic_track_paths: [trackPath],
    track_paths: [trackPath],
  };
  const renderedTitles = [];
  let releaseCanonicalRefresh;
  let markCanonicalRefreshStarted;
  const canonicalRefreshStarted = new Promise((resolve) => {
    markCanonicalRefreshStarted = resolve;
  });
  const canonicalRefreshRelease = new Promise((resolve) => {
    releaseCanonicalRefresh = resolve;
  });

  context.state.ui = { viewStateRevision: 81 };
  context.state.utility = {
    activeTab: 'problematic-files',
    loaded: true,
    loading: false,
    problematicFiles: [previousAlbum],
    selectedProblematicKey: previousAlbum.key,
    pendingProblematicSaveTasks: {},
  };
  context.buildApiUrl = () => '/view-data?surface=albums&artist=DDT';
  context.fetchAndRender = async () => true;
  context.renderUtilityModalContent = () => {
    const selected = context.state.utility.problematicFiles.find((album) => (
      album.key === context.state.utility.selectedProblematicKey
    ));
    if (selected?.name) renderedTitles.push(selected.name);
  };
  context.openUtilityModal = () => context.renderUtilityModalContent();
  context.loadProblematicAlbumDetail = async () => targetAlbum;
  context.loadProblematicFiles = async (force, options = {}) => {
    assert.equal(force, true);
    const titleAtRefreshStart = previousAlbum.name;
    context.state.utility.problematicSummaryRequestToken = Number(
      context.state.utility.problematicSummaryRequestToken || 0,
    ) + 1;
    markCanonicalRefreshStarted();
    await canonicalRefreshRelease;
    context.state.utility.problematicFiles = [targetAlbum];
    if (options.render !== false) renderedTitles.push(titleAtRefreshStart);
    return context.state.utility.problematicFiles;
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [],
      };
    },
  });
  context.showRepairAlert = () => {};
  context.settleTagEditViewMutation = () => {};

  const terminalRefresh = context.watchSaveTask('studio-records-split-5', {
    originatingViewStateRevision: 81,
    problematicMutationOriginKey: '',
  });
  context.state.utility.pendingProblematicSaveTasks.optimistic = {
    promise: terminalRefresh,
    acceptedPromise: Promise.resolve(),
    trackPaths: [trackPath],
    optimisticAlbums: [targetAlbum],
  };
  await canonicalRefreshStarted;
  const navigation = context.openUtilityModalForTrack(trackPath);
  releaseCanonicalRefresh();
  await Promise.all([terminalRefresh, navigation]);

  assert.ok(renderedTitles.length > 0);
  assert.equal(
    renderedTitles.every((title) => title === targetAlbum.name),
    true,
    `owned navigation must not render the prior title: ${JSON.stringify(renderedTitles)}`,
  );
  assert.equal(context.state.utility.selectedProblematicKey, targetAlbum.key);
  assert.equal(context.state.utility.problematicNavigationActiveToken, 0);
});

test('terminal Problematic Files refresh does not repaint stale detail while Settings is hidden', async () => {
  const context = loadHelpers();
  let renders = 0;
  let loads = 0;
  context.state.utility = {
    loaded: true,
    loading: false,
    problematicFiles: [{ key: 'old', name: 'Old selection' }],
    selectedProblematicKey: 'old',
  };
  context.getUtilityModalElements = () => ({ overlay: { hidden: true } });
  context.loadProblematicFiles = async (force, options) => {
    assert.equal(force, true);
    assert.equal(options.render, false);
    loads += 1;
    context.state.utility.problematicFiles = [{ key: 'new', name: 'Canonical selection' }];
  };
  context.renderUtilityModalContent = () => { renders += 1; };

  assert.equal(await context.refreshLoadedProblematicFilesAfterSaveCompletion(), true);
  assert.equal(loads, 1);
  assert.equal(renders, 0, 'hidden Settings DOM must not repaint a stale selected detail');
});

test('watchSaveTask does not claim a Problematic Files view opened after a tag edit started', async () => {
  const context = loadHelpers();
  const trackPath = 'C:\\Music\\DDT\\Studio Records\\05 Track.flac';
  const staleAlbum = {
    key: 'studio-records',
    name: 'Studio Records',
    tracks: [{ path: trackPath }],
  };
  const mutationStates = [];
  context.state.utility = {
    activeTab: 'problematic-files',
    loaded: true,
    loading: false,
    problematicFiles: [staleAlbum],
    selectedProblematicKey: staleAlbum.key,
  };
  context.loadProblematicFiles = async () => context.state.utility.problematicFiles;
  context.fetch = async () => {
    mutationStates.push(context.state.utility.problematicMutation || null);
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          task_id: 'album-details-edit',
          status: 'completed',
          requires_view_refresh: false,
          updated_albums: [],
        };
      },
    };
  };
  context.showRepairAlert = () => {};
  context.settleTagEditViewMutation = () => {};

  await context.watchSaveTask('album-details-edit', {
    originalAlbum: staleAlbum,
    problematicMutationOriginKey: '',
  });

  assert.deepEqual(
    mutationStates,
    [null],
    'opening Problematic Files after submission must not acquire the edit-origin mutation scrim',
  );
  assert.equal(context.state.utility.problematicMutation, undefined);
});

test('watchSaveTask owns Problematic Files mutation state until its matching terminal task reconciles selection and scroll', async () => {
  const scenarios = [
    {
      name: 'removed middle album selects the nearest previous survivor',
      beforeKeys: ['album-first', 'album-removed', 'album-last'],
      selectedKey: 'album-removed',
      afterKeys: ['album-first', 'album-last'],
      expectedSelectedKey: 'album-first',
    },
    {
      name: 'removed first album falls forward to the first survivor',
      beforeKeys: ['album-removed', 'album-last'],
      selectedKey: 'album-removed',
      afterKeys: ['album-last'],
      expectedSelectedKey: 'album-last',
    },
    {
      name: 'surviving album retains selection',
      beforeKeys: ['album-first', 'album-selected', 'album-last'],
      selectedKey: 'album-selected',
      afterKeys: ['album-first', 'album-selected', 'album-last'],
      expectedSelectedKey: 'album-selected',
    },
  ];

  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const context = loadHelpers();
    const taskId = `problematic-mutation-${scenarioIndex}`;
    const priorScrollTop = 237 + scenarioIndex;
    const listElement = { scrollTop: priorScrollTop };
    const albumsByKey = new Map(scenario.beforeKeys.map((key) => [key, {
      key,
      name: key,
      tracks: [{ path: `C:/Music/${key}/01 Track.flac` }],
    }]));
    const mutationAtPolls = [];
    const loadedTaskIds = [];
    let pollIndex = 0;

    context.state.utility = {
      activeTab: 'problematic-files',
      loaded: true,
      loading: false,
      problematicFiles: scenario.beforeKeys.map((key) => albumsByKey.get(key)),
      selectedProblematicKey: scenario.selectedKey,
    };
    context.getUtilityModalElements = () => ({ list: listElement });
    context.loadProblematicFiles = async (force) => {
      assert.equal(force, true);
      loadedTaskIds.push(taskId);
      listElement.scrollTop = 0;
      context.state.utility.problematicFiles = scenario.afterKeys.map((key) => albumsByKey.get(key));
      return context.state.utility.problematicFiles;
    };
    context.fetch = async () => {
      const mutation = context.state.utility.problematicMutation;
      mutationAtPolls.push(mutation ? {
        taskId: mutation.taskId,
        albumKey: mutation.albumKey,
        priorKeys: Array.from(mutation.priorKeys || []),
        priorScrollTop: mutation.priorScrollTop,
      } : null);
      const responseTaskId = pollIndex === 0 ? 'unrelated-save-task' : taskId;
      pollIndex += 1;
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            task_id: responseTaskId,
            status: 'completed',
            requires_view_refresh: false,
            updated_albums: [],
          };
        },
      };
    };
    context.waitForBrowserTimeout = async () => {};
    context.showRepairAlert = () => {};
    context.settleTagEditViewMutation = () => {};

    await context.watchSaveTask(taskId, {
      originalAlbum: albumsByKey.get(scenario.selectedKey),
    });

    assert.deepEqual(
      mutationAtPolls,
      [0, 1].map(() => ({
        taskId,
        albumKey: scenario.selectedKey,
        priorKeys: scenario.beforeKeys,
        priorScrollTop,
      })),
      `${scenario.name}: mutation ownership must exist before polling and survive an unrelated terminal payload`,
    );
    assert.equal(pollIndex, 2, `${scenario.name}: the unrelated task must not settle this mutation`);
    assert.deepEqual(loadedTaskIds, [taskId], `${scenario.name}: only the matching terminal task may refresh`);
    assert.equal(context.state.utility.selectedProblematicKey, scenario.expectedSelectedKey, scenario.name);
    assert.equal(listElement.scrollTop, priorScrollTop, `${scenario.name}: list scroll must be restored after refresh`);
    assert.equal(context.state.utility.problematicMutation, null, `${scenario.name}: settled mutation state must be cleared`);
  }
});

test('pending Problematic Files mutation preserves explicit sidebar navigation and its newer scroll position', async () => {
  const context = loadHelpers();
  const removedAlbum = {
    key: 'album-removed',
    name: 'Album Removed',
    tracks: [{ path: 'C:/Music/Removed/01 Track.flac' }],
  };
  const explicitAlbum = {
    key: 'album-explicit',
    name: 'Album Explicit',
    detail_loaded: true,
    tracks: [{ path: 'C:/Music/Explicit/01 Track.flac' }],
  };
  const listElement = { scrollTop: 237 };
  context.state.utility = {
    activeTab: 'problematic-files',
    loaded: true,
    loading: false,
    problematicFiles: [removedAlbum, explicitAlbum],
    selectedProblematicKey: removedAlbum.key,
  };
  context.getUtilityModalElements = () => ({ list: listElement });
  context.renderUtilityModalContent = () => {};
  context.loadProblematicFiles = async () => {
    context.state.utility.problematicFiles = [explicitAlbum];
    return context.state.utility.problematicFiles;
  };
  context.fetch = async () => {
    context.state.utility.selectedProblematicKey = explicitAlbum.key;
    listElement.scrollTop = 411;
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          task_id: 'explicit-navigation-task',
          status: 'completed',
          requires_view_refresh: false,
          updated_albums: [],
        };
      },
    };
  };
  context.showRepairAlert = () => {};
  context.settleTagEditViewMutation = () => {};

  await context.watchSaveTask('explicit-navigation-task', { originalAlbum: removedAlbum });

  assert.equal(
    context.state.utility.selectedProblematicKey,
    explicitAlbum.key,
    'terminal reconciliation must not replace a selection the user made while the mutation was pending',
  );
  assert.equal(
    listElement.scrollTop,
    411,
    'terminal reconciliation must preserve the newer user-controlled sidebar scroll position',
  );
});

test('final-row mutation retains enough list geometry to restore scrollTop 659 after max scroll shrinks to 572', async () => {
  const context = loadHelpers();
  const removedAlbum = {
    key: 'album-removed',
    name: 'Album Removed',
    tracks: [{ path: 'C:/Music/Removed/01 Track.flac' }],
  };
  const survivingAlbum = {
    key: 'album-previous',
    name: 'Album Previous',
    detail_loaded: true,
    tracks: [{ path: 'C:/Music/Previous/01 Track.flac' }],
  };
  let contentHeight = 859;
  let storedScrollTop = 659;
  let retainedContentHeight = 0;
  const retainedNodes = [];
  const listElement = {
    get clientHeight() {
      return Math.max(200, Number.parseFloat(this.style.minHeight) || 0);
    },
    style: { minHeight: '' },
    ownerDocument: {
      createElement() {
        return {
          style: {},
          setAttribute() {},
          remove() {
            retainedContentHeight = 0;
          },
        };
      },
    },
    appendChild(node) {
      retainedNodes.push(node);
      retainedContentHeight = Number.parseFloat(node.style.height || node.style.flexBasis) || 0;
      return node;
    },
    get scrollHeight() {
      return Math.max(contentHeight + retainedContentHeight, this.clientHeight);
    },
    get scrollTop() {
      return storedScrollTop;
    },
    set scrollTop(value) {
      storedScrollTop = Math.min(Number(value) || 0, Math.max(0, this.scrollHeight - this.clientHeight));
    },
  };
  context.state.utility = {
    activeTab: 'problematic-files',
    loaded: true,
    problematicFiles: [survivingAlbum, removedAlbum],
    selectedProblematicKey: removedAlbum.key,
  };
  context.getUtilityModalElements = () => ({ list: listElement });
  context.renderUtilityModalContent = () => {
    if (!context.state.utility.problematicMutation) contentHeight = 772;
  };

  const mutation = context.claimProblematicSaveTaskMutation('remove-final-row', removedAlbum);
  assert.equal(mutation.priorScrollTop, 659);
  context.state.utility.problematicFiles = [survivingAlbum];
  await context.settleProblematicSaveTaskMutation('remove-final-row', { reconcileSelection: true });

  assert.equal(contentHeight - 200, 572, 'the final row removal must reduce the natural max scroll');
  assert.equal(listElement.scrollTop, 659, 'temporary retained geometry must allow exact scroll restoration');
  assert.equal(retainedNodes.length, 1, 'retained geometry must be scrollable content, not container min-height');
  assert.equal(context.state.utility.selectedProblematicKey, survivingAlbum.key);
});

test('watchSaveTask reloads Problematic Files after an in-flight stale load settles', async () => {
  const context = loadHelpers();
  const loadEvents = [];
  let resolveStaleLoad;
  const staleLoadPromise = new Promise((resolve) => {
    resolveStaleLoad = () => {
      loadEvents.push({ phase: 'stale-settled' });
      context.state.utility.loading = false;
      context.state.utility.problematicFiles = [{
        key: 'studio-records-4',
        name: 'Studio Records4',
      }];
      resolve(context.state.utility.problematicFiles);
    };
  });
  context.state.ui = { viewStateRevision: 91 };
  context.state.utility = {
    loaded: false,
    loading: true,
    loadPromise: staleLoadPromise,
    problematicFiles: [],
  };
  context.buildApiUrl = () => '/view-data?surface=albums&artist=DDT';
  context.fetchAndRender = async () => true;
  context.loadProblematicFiles = async (force) => {
    if (context.state.utility.loading) {
      loadEvents.push({ force, phase: 'reused-stale' });
      return context.state.utility.loadPromise;
    }
    loadEvents.push({ force, phase: 'authoritative' });
    context.state.utility.loaded = true;
    context.state.utility.problematicFiles = [
      {
        key: 'studio-records-4',
        name: 'Studio Records4',
      },
      {
        key: 'studio-records-5',
        name: 'Studio Records5',
      },
    ];
    return context.state.utility.problematicFiles;
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      context.state.ui.viewStateRevision = 92;
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [],
        updated_problematic_album: null,
      };
    },
  });
  context.showRepairAlert = () => {};
  context.settleTagEditViewMutation = () => {};

  const watchPromise = context.watchSaveTask('studio-records-split-5-racing-load', {
    originatingViewStateRevision: 91,
  });
  await new Promise((resolve) => setImmediate(resolve));
  resolveStaleLoad();
  await watchPromise;

  const staleSettledIndex = loadEvents.findIndex((event) => event.phase === 'stale-settled');
  const authoritativeIndex = loadEvents.findIndex((event) => event.phase === 'authoritative');
  assert.notEqual(staleSettledIndex, -1);
  assert.ok(
    authoritativeIndex > staleSettledIndex,
    'save completion must force a new authoritative load after the stale in-flight promise settles',
  );
  assert.deepEqual(
    loadEvents
      .filter((event) => event.phase === 'authoritative')
      .map((event) => event.force),
    [true],
  );
  assert.deepEqual(
    Array.from(context.state.utility.problematicFiles, (album) => album.name),
    ['Studio Records4', 'Studio Records5'],
  );
});

test('watchSaveTask replaces mounted cards from one canonical identity-change payload', async () => {
  const context = loadHelpers();
  const trackPath = 'D:\\Synthetic Music\\Local Reconcile\\Album\\01 Track.flac';
  const originalAlbum = {
    key: 'local-reconcile-album',
    name: 'Album',
    album_artist: 'Local Reconcile',
    tracks: [{ path: trackPath, title: 'Before' }],
  };
  const finalizedAlbum = {
    ...originalAlbum,
    key: 'local-reconcile-renamed',
    album_ref: 'local-reconcile-renamed-ref',
    request_key: 'postgres-local-reconcile-renamed',
    identity_key: 'postgres-local-reconcile-renamed',
    name: 'Renamed Album',
    tracks: [
      { path: trackPath, title: 'After' },
      {
        path: 'D:\\Synthetic Music\\Local Reconcile\\Destination\\02 Existing.flac',
        title: 'Existing destination track',
      },
    ],
  };
  const renderOptions = [];
  const refreshCalls = [];
  const selectedArtistGroups = [{
    artist: 'Local Reconcile',
    albums: [originalAlbum],
  }];
  context.state.view.selected_artist = 'Local Reconcile';
  context.state.view.primary_artist_groups = selectedArtistGroups;
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = selectedArtistGroups;
  context.buildApiUrl = () => '/view-data?surface=albums&artist=Local%20Reconcile';
  context.fetchAndRender = async (...args) => {
    refreshCalls.push(args);
    throw new Error('A canonical identity-change payload must not start a second refresh.');
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [finalizedAlbum],
      };
    },
  });
  context.getAlbumRequestKey = (album) => String(album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: true } : null
  );
  context.renderView = (options) => renderOptions.push(options);
  context.showRepairAlert = () => {};

  await context.watchSaveTask('local-identity-reconcile-task', {
    originalAlbum,
    tagEdits: {
      [trackPath]: { album: 'Renamed Album' },
    },
  });

  assert.equal(
    renderOptions.length,
    1,
    'the canonical terminal payload must render exactly once',
  );
  assert.deepEqual(refreshCalls, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.view.primary_artist_groups[0].albums)),
    [finalizedAlbum],
    'the selected-artist renderer input must preserve canonical destination membership',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.view.artist_groups[0].albums)),
    [finalizedAlbum],
    'the chronological/fallback renderer input must preserve canonical destination membership',
  );
});

test('watchSaveTask adopts one canonical terminal payload without a second view refresh', async () => {
  const context = loadHelpers();
  const trackPath = 'D:\\Synthetic Music\\Queued Rename\\01 Track.mp3';
  const staleAlbum = {
    key: 'queued-rename::old::2025',
    album_ref: 'queued-rename::old::2025',
    name: 'Old Album',
    album_artist: 'Queued Rename',
    year: 2025,
    preview_only: false,
    tracks: [{ path: trackPath, title: 'Hydrated Track' }],
  };
  const canonicalAlbum = {
    key: 'queued-rename::new::2026',
    album_ref: 'queued-rename::new::2026',
    request_key: 'postgres::queued-rename::new::2026',
    identity_key: 'postgres::queued-rename::new::2026',
    name: 'New Album',
    album_artist: 'Queued Rename',
    year: 2026,
    preview_only: true,
    tracks: [{ path: trackPath }],
  };
  const renderSnapshots = [];
  const modalRenders = [];
  const alerts = [];
  const problematicLoads = [];
  let viewRefreshCount = 0;
  const groups = [{ artist: 'Queued Rename', albums: [staleAlbum] }];
  context.state.ui = { viewStateRevision: 12 };
  context.state.view.selected_artist = 'Queued Rename';
  context.state.view.primary_artist_groups = groups;
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = groups;
  context.state.modalReleases = [staleAlbum];
  context.state.modalReleaseIndex = 0;
  context.state.utility = {
    loaded: true,
    loading: false,
    problematicFiles: [{ key: staleAlbum.key, name: staleAlbum.name }],
  };
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: false } : null
  );
  context.getAlbumRequestKey = (album) => String(album?.request_key || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.identity_key || album?.key || '');
  context.buildApiUrl = () => '/view-data?surface=albums&artist=Queued%20Rename';
  context.fetchAndRender = async () => {
    viewRefreshCount += 1;
    throw new Error('Canonical terminal albums already own reconciliation.');
  };
  context.loadProblematicFiles = async (force) => {
    problematicLoads.push(force);
    return context.state.utility.problematicFiles;
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [canonicalAlbum],
      };
    },
  });
  context.renderView = (options) => {
    renderSnapshots.push({
      albums: context.state.view.artist_groups[0].albums.map((album) => album.key),
      options,
    });
  };
  context.cacheHydratedTrackModalAlbum = () => {};
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = (album) => modalRenders.push(album);
  context.showRepairAlert = (...args) => alerts.push(args);
  context.settleTagEditViewMutation = () => {};

  context.showRepairAlert('Tag changes queued. Finalizing library view...', 'info', null);

  await context.watchSaveTask('queued-rename-terminal', {
    originalAlbum: staleAlbum,
    originatingViewStateRevision: 12,
    tagEdits: {
      [trackPath]: { album: 'New Album', year: '2026' },
    },
  });

  assert.equal(viewRefreshCount, 0, 'canonical terminal adoption must not start a second gallery refresh');
  assert.deepEqual(problematicLoads, [true]);
  assert.equal(renderSnapshots.length, 1, 'the terminal payload must render exactly once');
  assert.deepEqual(
    JSON.parse(JSON.stringify(renderSnapshots[0].albums)),
    [canonicalAlbum.key],
  );
  assert.equal(context.state.view.artist_groups[0].albums[0].key, canonicalAlbum.key);
  assert.equal(context.state.view.artist_groups[0].albums.some((album) => album.key === staleAlbum.key), false);
  assert.equal(modalRenders.length, 1);
  assert.equal(modalRenders[0].key, canonicalAlbum.key);
  assert.deepEqual(
    Array.from(modalRenders[0].tracks, (track) => track.title),
    ['Hydrated Track'],
    'canonical identity adoption must retain hydrated modal membership',
  );
  assert.deepEqual(alerts, [
    ['Tag changes queued. Finalizing library view...', 'info', null],
    ['Library view updated from saved files.', 'success', 1000],
  ]);
});

test('watchSaveTask reconciles a provided terminal payload without polling or emitting async success', async () => {
  const context = loadHelpers();
  const trackPath = 'D:\\Synthetic Music\\Terminal Artist\\Old Album\\01 Track.mp3';
  const originalAlbum = {
    key: 'terminal-artist::old-album::2025',
    name: 'Old Album',
    album_artist: 'Terminal Artist',
    year: 2025,
    tracks: [{ path: trackPath, title: 'Track' }],
  };
  const canonicalAlbum = {
    key: 'terminal-artist::new-album::2026',
    name: 'New Album',
    album_artist: 'Terminal Artist',
    year: 2026,
    tracks: [{ path: trackPath, title: 'Track' }],
  };
  const mutationClaim = {};
  const alerts = [];
  const settledClaims = [];
  const invalidatedAlbums = [];
  let canonicalRefreshCount = 0;
  let saveTaskFetchCount = 0;
  context.state.ui = { viewStateRevision: 7 };
  context.state.view.artist_groups = [{ artist: 'Terminal Artist', albums: [originalAlbum] }];
  context.state.view.primary_artist_groups = [];
  context.state.view.family_artist_groups = [];
  context.fetch = async () => {
    saveTaskFetchCount += 1;
    throw new Error('A provided terminal payload must not be fetched again.');
  };
  context.waitForBrowserTimeout = async () => {};
  context.buildApiUrl = () => '/view-data?surface=albums&artist=Terminal%20Artist';
  context.fetchAndRender = async () => {
    canonicalRefreshCount += 1;
    context.state.view.artist_groups = [{ artist: 'Terminal Artist', albums: [canonicalAlbum] }];
    return true;
  };
  context.showRepairAlert = (...args) => alerts.push(args);
  context.invalidateHydratedTrackModalAlbumDetails = (albums) => {
    invalidatedAlbums.push(...albums);
  };
  context.tagEditViewMutationStillOwnsResources = (claim) => claim === mutationClaim;
  context.settleTagEditViewMutation = (claim) => settledClaims.push(claim);

  await context.watchSaveTask('completed-refresh-task', {
    originalAlbum,
    originatingViewStateRevision: 7,
    tagEditMutationClaim: mutationClaim,
    tagEdits: { [trackPath]: { album: 'New Album', year: '2026' } },
    problematicMutationOriginKey: '',
    terminalPayload: {
      ok: true,
      task_id: 'completed-refresh-task',
      status: 'completed',
      requires_view_refresh: true,
      updated_albums: [],
    },
  });

  assert.equal(saveTaskFetchCount, 0);
  assert.equal(canonicalRefreshCount, 1);
  assert.equal(context.state.view.artist_groups[0].albums[0].key, canonicalAlbum.key);
  assert.equal(invalidatedAlbums.includes(originalAlbum), true);
  assert.equal(invalidatedAlbums.includes(canonicalAlbum), true);
  assert.deepEqual(alerts, []);
  assert.deepEqual(settledClaims, [mutationClaim]);
});

test('watchSaveTask keeps full restored source membership when canonical refresh finishes with its modal open', async () => {
  const context = loadHelpers();
  const existingPath = 'D:\\Synthetic Music\\DDT\\Studio Records\\05 Existing.mp3';
  const restoredPath = 'D:\\Synthetic Music\\DDT\\Studio Records\\04 Restored.mp3';
  const suffixAlbum = {
    key: 'ddt::studio-records4',
    name: 'Studio Records4',
    album_artist: 'DDT',
    year: 1999,
    preview_only: false,
    tracks: [{ path: restoredPath, title: 'Restored' }],
  };
  const restoredSource = {
    key: 'ddt::studio-records',
    name: 'Studio Records',
    album_artist: 'DDT',
    year: 1999,
    preview_only: false,
    tracks: [
      { path: restoredPath, title: 'Restored' },
      { path: existingPath, title: 'Existing' },
    ],
  };
  const oneTrackOptimisticSource = {
    ...restoredSource,
    tracks: [{ path: restoredPath, title: 'Restored' }],
  };
  const compactCanonicalSource = {
    ...restoredSource,
    preview_only: true,
    track_count_preview: 2,
    track_paths: [restoredPath, existingPath],
    tracks: [],
  };
  const renderedAlbums = [];
  const cachedAlbums = [];
  context.state.view.selected_artist = 'DDT';
  context.state.view.related_artists = [];
  context.state.view.primary_artist_groups = [{ artist: 'DDT', albums: [restoredSource] }];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = context.state.view.primary_artist_groups;
  context.state.modalReleases = [suffixAlbum];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (id === 'track-modal' ? { hidden: false } : null);
  context.buildApiUrl = () => '/view-data?surface=albums&artist=DDT';
  context.fetch = async () => {
    throw new Error('A provided terminal payload must not poll save-task status.');
  };
  context.fetchAndRender = async () => {
    context.state.view.primary_artist_groups = [{ artist: 'DDT', albums: [compactCanonicalSource] }];
    context.state.view.artist_groups = context.state.view.primary_artist_groups;
    return true;
  };
  context.getAlbumRequestKey = (album) => String(album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.cacheHydratedTrackModalAlbum = (albumKey, album) => {
    cachedAlbums.push({ albumKey, album });
  };
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = (album) => renderedAlbums.push(album);
  context.showRepairAlert = () => {};

  await context.watchSaveTask('restore-terminal-task', {
    originalAlbum: suffixAlbum,
    optimisticAlbums: [oneTrackOptimisticSource],
    tagEdits: { [restoredPath]: { album: 'Studio Records' } },
    terminalPayload: {
      ok: true,
      task_id: 'restore-terminal-task',
      status: 'completed',
      requires_view_refresh: true,
      updated_albums: [],
    },
  });

  assert.equal(renderedAlbums.length, 1);
  assert.deepEqual(
    Array.from(renderedAlbums[0].tracks, (track) => track.path),
    [restoredPath, existingPath],
    'the canonical preview must retain the pre-refresh hydrated source membership while the modal stays open',
  );
  const sourceCache = cachedAlbums.find(({ albumKey }) => albumKey === compactCanonicalSource.key);
  assert.ok(sourceCache);
  assert.deepEqual(
    Array.from(sourceCache.album.tracks, (track) => track.path),
    [restoredPath, existingPath],
  );
});

test('watchSaveTask does not replace a newly hydrated post-edit modal with an empty canonical preview', async () => {
  const context = loadHelpers();
  const originalTracks = Array.from({ length: 13 }, (_value, index) => ({
    path: `D:\\Synthetic Music\\DDT\\Studio Records\\${String(index + 1).padStart(2, '0')}.mp3`,
    title: `Studio Track ${index + 1}`,
  }));
  const originalAlbum = {
    key: 'ddt::studio-records-before-split',
    name: 'Studio Records',
    album_artist: 'DDT',
    year: 1999,
    preview_only: false,
    track_count_preview: 13,
    tracks: originalTracks,
  };
  const currentHydratedSource = {
    ...originalAlbum,
    key: 'ddt::studio-records-current-modal',
    track_count_preview: 12,
    tracks: originalTracks.slice(1),
  };
  const compactCanonicalSource = {
    ...originalAlbum,
    key: 'ddt::studio-records-canonical',
    request_key: 'ddt::studio-records-canonical-request',
    identity_key: 'ddt::studio-records-canonical-identity',
    preview_only: true,
    track_count_preview: 12,
    track_paths: currentHydratedSource.tracks.map((track) => track.path),
    tracks: [],
  };
  const renderedAlbums = [];
  context.state.view.selected_artist = 'DDT';
  context.state.view.related_artists = [];
  context.state.view.primary_artist_groups = [{ artist: 'DDT', albums: [compactCanonicalSource] }];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = context.state.view.primary_artist_groups;
  context.state.modalReleases = [currentHydratedSource];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (id === 'track-modal' ? { hidden: false } : null);
  context.buildApiUrl = () => '/view-data?surface=albums&artist=DDT';
  context.fetch = async () => {
    throw new Error('A provided terminal payload must not poll save-task status.');
  };
  context.fetchAndRender = async () => {
    context.state.view.primary_artist_groups = [{ artist: 'DDT', albums: [compactCanonicalSource] }];
    context.state.view.artist_groups = context.state.view.primary_artist_groups;
    return true;
  };
  context.getAlbumRequestKey = (album) => String(album?.request_key || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.identity_key || album?.key || '');
  context.cacheHydratedTrackModalAlbum = () => {};
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = (album) => renderedAlbums.push(album);
  context.showRepairAlert = () => {};

  await context.watchSaveTask('split-terminal-task', {
    originalAlbum,
    optimisticAlbums: [currentHydratedSource],
    tagEdits: { [originalTracks[0].path]: { album: 'Studio Records5' } },
    terminalPayload: {
      ok: true,
      task_id: 'split-terminal-task',
      status: 'completed',
      requires_view_refresh: true,
      updated_albums: [],
    },
  });

  assert.equal(renderedAlbums.length, 1);
  assert.equal(renderedAlbums[0].preview_only, false);
  assert.deepEqual(
    Array.from(renderedAlbums[0].tracks, (track) => track.path),
    currentHydratedSource.tracks.map((track) => track.path),
    'the terminal refresh must preserve the source details loaded after the edit response arrived',
  );
});

test('watchSaveTask keeps optimistic state without an error when polling exhausts on running status', async () => {
  const context = loadHelpers();
  const alerts = [];
  const settledClaims = [];
  const releasedClaims = [];
  let fetchCount = 0;
  context.fetch = async () => {
    fetchCount += 1;
    return {
      ok: true,
      async json() {
        return { ok: true, status: 'running' };
      },
    };
  };
  context.waitForBrowserTimeout = async () => {};
  context.showRepairAlert = (...args) => alerts.push(args);
  context.settleTagEditViewMutation = (claim) => settledClaims.push(claim);
  context.releaseFailedTagEditViewMutation = (claim) => releasedClaims.push(claim);

  context.showRepairAlert('Tag changes queued. Finalizing library view...', 'info', null);

  await context.watchSaveTask('never-terminal');

  assert.equal(fetchCount, 40);
  assert.deepEqual(alerts, [
    ['Tag changes queued. Finalizing library view...', 'info', null],
  ]);
  assert.equal(settledClaims.length, 1, 'poll exhaustion must retain the optimistic result');
  assert.deepEqual(releasedClaims, [], 'running status must not use failed-task cleanup');
  assert.equal(
    alerts.some(([, kind]) => kind === 'error'),
    false,
    'running status without a server error must not emit an error alert',
  );
});

test('watchSaveTask preserves finalized raw credits for album-only splits', async () => {
  const context = loadHelpers();
  const movedPath = 'D:\\Music\\ДДТ\\Студийные записи\\01 Moved.flac';
  const siblingPath = 'D:\\Music\\ДДТ\\Студийные записи\\02 Sibling.flac';
  const originalAlbum = {
    key: 'ддт::студийные записи::1988',
    name: 'Студийные записи',
    album_artist: 'Юрий Шевчук / ДДТ',
    year: 1988,
    tracks: [
      { path: movedPath, title: 'Moved', album_artist: 'Юрий Шевчук / ДДТ' },
      { path: siblingPath, title: 'Sibling', album_artist: 'Юрий Шевчук / ДДТ' },
    ],
  };
  const finalizedSource = {
    key: 'raw-credit::студийные записи::1988',
    name: 'Студийные записи',
    album_artist: 'Юрий Шевчук / ДДТ',
    year: 1988,
    tracks: [{
      path: siblingPath,
      title: 'Sibling',
      album_artist: 'Юрий Шевчук / ДДТ',
    }],
  };
  const finalizedSuffix = {
    key: 'raw-credit::студийные записи2::1988',
    name: 'Студийные записи2',
    album_artist: 'Юрий Шевчук / ДДТ',
    year: 1988,
    tracks: [{
      path: movedPath,
      title: 'Moved',
      album_artist: 'Юрий Шевчук / ДДТ',
    }],
  };
  const tagEdits = {
    [movedPath]: { album: finalizedSuffix.name },
  };
  const canonicalCompactSource = {
    ...finalizedSource,
    request_key: 'postgres-raw-credit-source',
    identity_key: 'postgres-raw-credit-source',
    edition: 'Original',
    cover_path: 'D:\\Music\\DDT\\Studio Records\\source-cover.jpg',
    preview_only: true,
    track_count_preview: 1,
    tracks: [],
  };
  const canonicalCompactSuffix = {
    ...finalizedSuffix,
    request_key: 'postgres-raw-credit-suffix',
    identity_key: 'postgres-raw-credit-suffix',
    edition: 'Original',
    cover_path: 'D:\\Music\\DDT\\Studio Records\\suffix-cover.jpg',
    preview_only: true,
    track_count_preview: 1,
    tracks: [],
  };
  Object.assign(finalizedSource, {
    request_key: canonicalCompactSource.request_key,
    identity_key: canonicalCompactSource.identity_key,
    edition: canonicalCompactSource.edition,
    cover_path: canonicalCompactSource.cover_path,
    preview_only: false,
    track_count_preview: 1,
  });
  Object.assign(finalizedSuffix, {
    request_key: canonicalCompactSuffix.request_key,
    identity_key: canonicalCompactSuffix.identity_key,
    edition: canonicalCompactSuffix.edition,
    cover_path: canonicalCompactSuffix.cover_path,
    preview_only: false,
    track_count_preview: 1,
  });
  const tagEditMutationClaim = context.claimTagEditViewMutation(
    originalAlbum,
    [movedPath],
    tagEdits,
  );
  const refreshCalls = [];
  const localRenderSnapshots = [];
  const sourceGroup = {
    artist: 'ДДТ',
    albums: [{
      ...originalAlbum,
      album_artist: 'Юрий Шевчук / ДДТ',
    }],
  };
  context.state.view.selected_artist = 'ДДТ';
  context.state.view.selected_artist_family_display_mode = 'grouped';
  context.state.view.related_artists = [];
  context.state.view.primary_artist_groups = [sourceGroup];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = [sourceGroup];
  context.state.ui = { viewStateRevision: 71 };
  context.state.modalReleases = [originalAlbum];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: false } : null
  );
  context.buildApiUrl = () => '/view-data?surface=albums&artist=DDT';
  context.fetchAndRender = async (...args) => {
    refreshCalls.push(args);
    throw new Error('Canonical terminal raw-credit albums must not start a second refresh.');
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [finalizedSource, finalizedSuffix],
      };
    },
  });
  context.getAlbumRequestKey = (album) => String(album?.request_key || album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.identity_key || album?.key || '');
  context.cacheHydratedTrackModalAlbum = () => {};
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = () => {};
  context.renderView = () => {
    localRenderSnapshots.push(JSON.parse(JSON.stringify(
      context.state.view.artist_groups.flatMap((group) => group.albums),
    )));
  };
  context.showRepairAlert = () => {};

  await context.watchSaveTask('raw-credit-album-only-task', {
    originalAlbum,
    originatingViewStateRevision: 71,
    tagEditMutationClaim,
    projectedAlbumArtist: 'Юрий Шевчук / ДДТ',
    tagEdits: {
      [movedPath]: { album: 'Студийные записи2' },
    },
  });

  assert.deepEqual(refreshCalls, []);
  assert.equal(localRenderSnapshots.length, 1);
  const reconciledAlbums = localRenderSnapshots[0];
  assert.deepEqual(
    JSON.parse(JSON.stringify(reconciledAlbums.map((album) => ({
      albumArtist: album.album_artist,
      name: album.name,
      trackAlbumArtists: album.tracks.map((track) => track.album_artist),
    })).sort((left, right) => left.name.localeCompare(right.name)))),
    [
      {
        albumArtist: 'Юрий Шевчук / ДДТ',
        name: 'Студийные записи',
        trackAlbumArtists: ['Юрий Шевчук / ДДТ'],
      },
      {
        albumArtist: 'Юрий Шевчук / ДДТ',
        name: 'Студийные записи2',
        trackAlbumArtists: ['Юрий Шевчук / ДДТ'],
      },
    ],
  );
  const canonicalHydratedAlbums = context.state.view.artist_groups[0].albums;
  assert.equal(canonicalHydratedAlbums.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(canonicalHydratedAlbums.map((album) => ({
      requestKey: album.request_key,
      identityKey: album.identity_key,
      edition: album.edition,
      coverPath: album.cover_path,
      previewOnly: album.preview_only,
      trackCount: album.track_count_preview,
      trackPaths: album.tracks.map((track) => track.path),
    })))),
    [{
      requestKey: canonicalCompactSource.request_key,
      identityKey: canonicalCompactSource.identity_key,
      edition: canonicalCompactSource.edition,
      coverPath: canonicalCompactSource.cover_path,
      previewOnly: false,
      trackCount: 1,
      trackPaths: [siblingPath],
    }, {
      requestKey: canonicalCompactSuffix.request_key,
      identityKey: canonicalCompactSuffix.identity_key,
      edition: canonicalCompactSuffix.edition,
      coverPath: canonicalCompactSuffix.cover_path,
      previewOnly: false,
      trackCount: 1,
      trackPaths: [movedPath],
    }],
  );
  assert.equal(context.state.modalReleases[0].name, 'Студийные записи');
  assert.equal(context.state.modalReleases[0].request_key, 'postgres-raw-credit-source');
  assert.equal(context.state.modalReleases[0].identity_key, 'postgres-raw-credit-source');
  assert.equal(context.state.modalReleases[0].edition, 'Original');
  assert.equal(context.state.modalReleases[0].cover_path, canonicalCompactSource.cover_path);
  assert.equal(context.state.modalReleases[0].track_count_preview, 1);
  assert.equal(context.state.modalReleases[0].preview_only, false);
  assert.equal(
    context.state.modalReleases[0].tracks[0].album_artist,
    finalizedSource.tracks[0].album_artist,
  );
  assert.deepEqual(
    Array.from(context.state.modalReleases[0].tracks, (track) => track.path),
    [siblingPath],
  );
});

test('watchSaveTask honors an explicit album_artist edit in finalized raw-credit payloads', async () => {
  const context = loadHelpers();
  const movedPath = 'D:\\Music\\ДДТ\\Студийные записи\\01 Moved.flac';
  const siblingPath = 'D:\\Music\\ДДТ\\Студийные записи\\02 Sibling.flac';
  const originalAlbum = {
    key: 'ддт::студийные записи::1988',
    name: 'Студийные записи',
    album_artist: 'Юрий Шевчук / ДДТ',
    year: 1988,
    tracks: [
      { path: movedPath, title: 'Moved', album_artist: 'Юрий Шевчук / ДДТ' },
      { path: siblingPath, title: 'Sibling', album_artist: 'Юрий Шевчук / ДДТ' },
    ],
  };
  const finalizedSource = {
    ...originalAlbum,
    tracks: [originalAlbum.tracks[1]],
  };
  const finalizedSuffix = {
    key: 'raw-credit::студийные записи2::1988',
    name: 'Студийные записи2',
    album_artist: 'Юрий Шевчук / ДДТ',
    year: 1988,
    tracks: [{
      path: movedPath,
      title: 'Moved',
      album_artist: 'Юрий Шевчук / ДДТ',
    }],
  };
  const unaffectedDdtAlbum = {
    key: 'ддт::публикация::1987',
    name: 'Публикация',
    album_artist: 'Юрий Шевчук / ДДТ',
    year: 1987,
    tracks: [{
      path: 'D:\\Music\\ДДТ\\Публикация\\01 Publication.flac',
      title: 'Publication',
      album_artist: 'Юрий Шевчук / ДДТ',
    }],
  };
  const unaffectedFamilyAlbum = {
    key: 'юрий-шевчук::сольный::2008',
    name: 'Сольный',
    album_artist: 'Юрий Шевчук',
    year: 2008,
    tracks: [{
      path: 'D:\\Music\\Юрий Шевчук\\Сольный\\01 Solo.flac',
      title: 'Solo',
      album_artist: 'Юрий Шевчук',
    }],
  };
  const sourceGroup = {
    artist: 'ДДТ',
    artist_display: 'ДДТ',
    albums: [
      unaffectedDdtAlbum,
      {
        ...originalAlbum,
        album_artist: 'Юрий Шевчук / ДДТ',
      },
    ],
  };
  const familyGroup = {
    artist: 'Юрий Шевчук',
    artist_display: 'Юрий Шевчук',
    albums: [unaffectedFamilyAlbum],
  };
  context.state.view.selected_artist = 'ДДТ';
  context.state.view.selected_artist_family_display_mode = 'grouped';
  context.state.view.related_artists = ['Юрий Шевчук'];
  context.state.view.primary_artist_groups = [sourceGroup];
  context.state.view.family_artist_groups = [familyGroup];
  context.state.view.artist_groups = [sourceGroup, familyGroup];
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: true } : null
  );
  context.fetchAndRender = async () => {
    throw new Error('A finalized split must reconcile locally.');
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: false,
        updated_albums: [finalizedSource, finalizedSuffix],
      };
    },
  });
  context.getAlbumRequestKey = (album) => String(album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.showRepairAlert = () => {};

  await context.watchSaveTask('raw-credit-explicit-artist-task', {
    originalAlbum,
    projectedAlbumArtist: 'Юрий Шевчук / ДДТ',
    tagEdits: {
      [movedPath]: {
        album: 'Студийные записи2',
        album_artist: 'Юрий Шевчук',
      },
    },
  });

  const suffix = context.state.view.artist_groups
    .flatMap((group) => group.albums)
    .find((album) => album.name === 'Студийные записи2');
  assert.equal(suffix?.album_artist, 'Юрий Шевчук');
  assert.equal(suffix?.tracks[0]?.album_artist, 'Юрий Шевчук');
  const suffixGroup = context.state.view.artist_groups.find(
    (group) => group.albums.some((album) => album.name === 'Студийные записи2'),
  );
  assert.equal(suffixGroup?.artist, 'Юрий Шевчук');
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.state.view.primary_artist_groups.map((group) => ({
        artist: group.artist,
        albums: group.albums.map((album) => album.name),
      })),
    )),
    [{
      artist: 'ДДТ',
      albums: ['Публикация', 'Студийные записи'],
    }],
    'explicit album-artist edits must not regroup unaffected DDT releases by raw credit',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.state.view.family_artist_groups.map((group) => ({
        artist: group.artist,
        albums: group.albums.map((album) => album.name),
      })),
    )),
    [{
      artist: 'Юрий Шевчук',
      albums: ['Студийные записи2', 'Сольный'],
    }],
    'only the explicitly edited destination release migrates to the target family group',
  );
});

test('watchSaveTask patches finalized albums into visible state when canonical refresh fails', async () => {
  const context = loadHelpers();
  const trackPath = 'D:\\Synthetic Music\\Refresh Artist\\Fallback\\01 Track.flac';
  const originalAlbum = {
    key: 'refresh-fallback-album',
    name: 'Fallback',
    album_artist: 'Refresh Artist',
    album_preference: { rating: 8 },
    tracks: [{ path: trackPath, title: 'Track' }],
  };
  const sparseFinalizedAlbum = {
    ...originalAlbum,
    name: 'Fallback Updated',
    album_preference: null,
  };
  const cachedAlbums = [];
  const renderedAlbums = [];
  const refreshCalls = [];
  const renderOptions = [];
  context.state.view.artist_groups = [{
    artist: 'Refresh Artist',
    albums: [originalAlbum],
  }];
  context.state.modalReleases = [originalAlbum];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: false } : null
  );
  context.buildApiUrl = () => '/api/library';
  context.fetchAndRender = async (...args) => {
    refreshCalls.push(args);
    return false;
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [sparseFinalizedAlbum],
      };
    },
  });
  context.getAlbumRequestKey = (album) => String(album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.cacheHydratedTrackModalAlbum = (albumKey, album) => {
    cachedAlbums.push({ albumKey, album });
  };
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = (album) => renderedAlbums.push(album);
  context.renderView = (options) => renderOptions.push(options);
  context.showRepairAlert = () => {};

  await context.watchSaveTask('failed-refresh-task', {
    originalAlbum,
    tagEdits: {
      [trackPath]: { album: 'Fallback Updated' },
    },
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(refreshCalls)),
    [[
      '/api/library',
      false,
      {
        preserveScroll: true,
        preserveGalleryOptionsMenu: true,
        preserveMountedGalleryChildren: true,
        restartIfSameUrl: true,
      },
    ]],
  );
  assert.strictEqual(
    context.state.view.artist_groups[0].albums[0],
    sparseFinalizedAlbum,
  );
  assert.equal(renderOptions.length, 1);
  assert.equal(renderOptions[0].preserveMountedGalleryChildren, true);
  assert.strictEqual(context.state.modalReleases[0], sparseFinalizedAlbum);
  assert.deepEqual(renderedAlbums, [sparseFinalizedAlbum]);
  assert.equal(cachedAlbums.length, 1);
  assert.strictEqual(cachedAlbums[0].album, sparseFinalizedAlbum);
});

test('watchSaveTask ignores an older stale save-task completion after a newer edit completes', async () => {
  const context = loadHelpers();
  const existingDestinationTrack = {
    path: 'D:\\Synthetic Music\\Ordering Artist\\Destination\\00 Existing.flac',
    title: 'Existing',
  };
  const firstMovedTrack = {
    path: 'D:\\Synthetic Music\\Ordering Artist\\Source\\01 First.flac',
    title: 'First',
  };
  const secondMovedTrack = {
    path: 'D:\\Synthetic Music\\Ordering Artist\\Source\\02 Second.flac',
    title: 'Second',
  };
  const remainingTrack = {
    path: 'D:\\Synthetic Music\\Ordering Artist\\Source\\03 Remaining.flac',
    title: 'Remaining',
  };
  const originalSource = {
    key: 'ordering-source',
    name: 'Source',
    album_artist: 'Ordering Artist',
    tracks: [firstMovedTrack, secondMovedTrack, remainingTrack],
  };
  const originalDestination = {
    key: 'ordering-destination',
    name: 'Destination',
    album_artist: 'Ordering Artist',
    tracks: [existingDestinationTrack],
  };
  const afterEditA = [{
    ...originalSource,
    tracks: [secondMovedTrack, remainingTrack],
  }, {
    ...originalDestination,
    tracks: [existingDestinationTrack, firstMovedTrack],
  }];
  const afterEditB = [{
    ...originalSource,
    tracks: [remainingTrack],
  }, {
    ...originalDestination,
    tracks: [existingDestinationTrack, firstMovedTrack, secondMovedTrack],
  }];
  const pendingResponses = new Map();
  context.state.ui = { viewStateRevision: 31 };
  context.state.view.selected_artist = '';
  context.state.view.primary_artist_groups = [];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = [{
    artist: 'Ordering Artist',
    albums: [originalSource, originalDestination],
  }];
  context.state.modalReleases = [originalDestination];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: false } : null
  );
  context.fetch = (url) => new Promise((resolve) => {
    pendingResponses.set(String(url).split('/').pop(), resolve);
  });
  context.getAlbumRequestKey = (album) => String(album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.cacheHydratedTrackModalAlbum = () => {};
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = () => {};
  context.showRepairAlert = () => {};

  const olderCompletion = context.watchSaveTask('edit-a', {
    originalAlbum: originalSource,
    originatingViewStateRevision: 31,
  });
  const newerCompletion = context.watchSaveTask('edit-b', {
    originalAlbum: afterEditA[0],
    originatingViewStateRevision: 31,
  });
  const completedResponse = (updatedAlbums) => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: false,
        updated_albums: updatedAlbums,
      };
    },
  });

  pendingResponses.get('edit-b')(completedResponse(afterEditB));
  await newerCompletion;
  pendingResponses.get('edit-a')(completedResponse(afterEditA));
  await olderCompletion;

  const finalAlbums = JSON.parse(JSON.stringify(
    context.state.view.artist_groups[0].albums,
  ));
  assert.equal(context.state.view.album_count, 2);
  assert.deepEqual(
    finalAlbums.map((album) => album.key),
    ['ordering-destination', 'ordering-source'],
  );
  assert.deepEqual(
    finalAlbums.find((album) => album.key === 'ordering-source').tracks,
    [remainingTrack],
  );
  assert.deepEqual(
    finalAlbums.find((album) => album.key === 'ordering-destination').tracks,
    [existingDestinationTrack, firstMovedTrack, secondMovedTrack],
  );
  assert.equal(context.state.modalReleases[0].key, 'ordering-destination');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.modalReleases[0].tracks)),
    [existingDestinationTrack, firstMovedTrack, secondMovedTrack],
  );
});

test('watchSaveTask prevents a delayed canonical terminal payload from overwriting a newer overlapping edit', async () => {
  const context = loadHelpers();
  const movedTrack = {
    path: 'D:\\Synthetic Music\\Ordering Artist\\Source\\01 Move.flac',
    title: 'Move',
  };
  const siblingTrack = {
    path: 'D:\\Synthetic Music\\Ordering Artist\\Source\\02 Stay.flac',
    title: 'Stay',
  };
  const originalSource = {
    key: 'ordering-source',
    name: 'Source',
    album_artist: 'Ordering Artist',
    year: 2026,
    tracks: [movedTrack, siblingTrack],
  };
  const finalizedSource = {
    ...originalSource,
    tracks: [siblingTrack],
  };
  const finalizedDestination = {
    key: 'ordering-destination-a',
    name: 'Destination A',
    album_artist: 'Ordering Artist',
    year: 2026,
    tracks: [movedTrack],
  };
  const staleCanonicalAlbums = [{
    ...finalizedSource,
    preview_only: true,
    track_count_preview: 1,
    tracks: [],
  }, {
    ...finalizedDestination,
    preview_only: true,
    track_count_preview: 1,
    tracks: [],
  }];
  const newerSource = {
    ...originalSource,
    tracks: [siblingTrack],
  };
  const newerDestination = {
    key: 'ordering-destination-b',
    name: 'Destination B',
    album_artist: 'Ordering Artist',
    year: 2026,
    tracks: [movedTrack],
  };
  const olderTagEdits = {
    [movedTrack.path]: { album: finalizedDestination.name },
  };
  const newerTagEdits = {
    [movedTrack.path]: { album: newerDestination.name },
  };
  const olderClaim = context.claimTagEditViewMutation(
    originalSource,
    [movedTrack.path],
    olderTagEdits,
  );
  context.state.ui = { viewStateRevision: 61 };
  const initialGroups = [{
    artist: 'Ordering Artist',
    albums: [originalSource],
  }];
  context.state.view.selected_artist = 'Ordering Artist';
  context.state.view.primary_artist_groups = initialGroups;
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = initialGroups;
  context.state.modalReleases = [originalSource];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: false } : null
  );
  context.buildApiUrl = () => '/view-data?surface=albums&artist=Ordering%20Artist';
  let releaseTerminalPayload;
  let markTerminalPayloadStarted;
  const terminalPayloadStarted = new Promise((resolve) => {
    markTerminalPayloadStarted = resolve;
  });
  const terminalPayloadRelease = new Promise((resolve) => {
    releaseTerminalPayload = resolve;
  });
  context.fetch = async () => ({
    ok: true,
    async json() {
      markTerminalPayloadStarted();
      await terminalPayloadRelease;
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [finalizedSource, finalizedDestination],
      };
    },
  });
  context.fetchAndRender = async () => {
    throw new Error('A superseded canonical terminal payload must not refresh the gallery.');
  };
  context.getAlbumRequestKey = (album) => String(album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.cacheHydratedTrackModalAlbum = () => {};
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = () => {};
  context.renderView = () => {};
  context.showRepairAlert = () => {};

  const olderCompletion = context.watchSaveTask('in-flight-canonical-a', {
    originalAlbum: originalSource,
    originatingViewStateRevision: 61,
    tagEditMutationClaim: olderClaim,
    tagEdits: olderTagEdits,
  });
  await terminalPayloadStarted;

  context.claimTagEditViewMutation(
    originalSource,
    [movedTrack.path],
    newerTagEdits,
  );
  const newerGroups = [{
    artist: 'Ordering Artist',
    albums: [newerSource, newerDestination],
  }];
  context.state.view.primary_artist_groups = newerGroups;
  context.state.view.artist_groups = newerGroups;
  context.state.modalReleases = [newerDestination];
  context.state.modalReleaseIndex = 0;

  releaseTerminalPayload();
  await olderCompletion;

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.view.primary_artist_groups[0].albums)),
    [newerSource, newerDestination],
    'the stale canonical payload must not replace the newer overlapping gallery state',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.view.artist_groups[0].albums)),
    [newerSource, newerDestination],
    'the stale canonical payload must not replace the newer fallback gallery state',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.modalReleases)),
    [newerDestination],
    'the older completion must not replace the newer overlapping modal state',
  );
});

test('watchSaveTask reconciles an older disjoint save-task completion after a newer edit completes', async () => {
  const context = loadHelpers();
  const albumA = {
    key: 'disjoint-a',
    name: 'Disjoint A',
    album_artist: 'Ordering Artist',
    tracks: [{
      path: 'D:\\Synthetic Music\\Ordering Artist\\Disjoint A\\01 A.flac',
      title: 'A',
    }],
  };
  const albumB = {
    key: 'disjoint-b',
    name: 'Disjoint B',
    album_artist: 'Ordering Artist',
    tracks: [{
      path: 'D:\\Synthetic Music\\Ordering Artist\\Disjoint B\\01 B.flac',
      title: 'B',
    }],
  };
  const finalizedA = {
    ...albumA,
    key: 'disjoint-a-final',
    name: 'Disjoint A Final',
  };
  const finalizedB = {
    ...albumB,
    key: 'disjoint-b-final',
    name: 'Disjoint B Final',
  };
  const pendingResponses = new Map();
  context.state.ui = { viewStateRevision: 41 };
  context.state.view.selected_artist = '';
  context.state.view.primary_artist_groups = [];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = [{
    artist: 'Ordering Artist',
    albums: [albumA, albumB],
  }];
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: true } : null
  );
  context.fetch = (url) => new Promise((resolve) => {
    pendingResponses.set(String(url).split('/').pop(), resolve);
  });
  context.getAlbumRequestKey = (album) => String(album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.showRepairAlert = () => {};
  const completedResponse = (updatedAlbum) => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: false,
        updated_albums: [updatedAlbum],
      };
    },
  });

  const olderCompletion = context.watchSaveTask('disjoint-a-task', {
    originalAlbum: albumA,
    originatingViewStateRevision: 41,
  });
  const newerCompletion = context.watchSaveTask('disjoint-b-task', {
    originalAlbum: albumB,
    originatingViewStateRevision: 41,
  });

  pendingResponses.get('disjoint-b-task')(completedResponse(finalizedB));
  await newerCompletion;
  pendingResponses.get('disjoint-a-task')(completedResponse(finalizedA));
  await olderCompletion;

  const finalAlbums = JSON.parse(JSON.stringify(
    context.state.view.artist_groups[0].albums,
  ));
  assert.equal(context.state.view.album_count, 2);
  assert.deepEqual(
    new Set(finalAlbums.map((album) => album.key)),
    new Set(['disjoint-a-final', 'disjoint-b-final']),
  );
});

test('watchSaveTask rejects an older completion when disjoint sources target the same release', async () => {
  const context = loadHelpers();
  const sourceATrack = {
    path: 'D:\\Synthetic Music\\Ordering Artist\\Source A\\01 A.flac',
    title: 'A',
  };
  const sourceBTrack = {
    path: 'D:\\Synthetic Music\\Ordering Artist\\Source B\\01 B.flac',
    title: 'B',
  };
  const existingDestinationTrack = {
    path: 'D:\\Synthetic Music\\Ordering Artist\\Shared Destination\\00 Existing.flac',
    title: 'Existing',
  };
  const sourceA = {
    key: 'target-overlap-source-a',
    name: 'Source A',
    album_artist: 'Ordering Artist',
    year: 2026,
    tracks: [sourceATrack],
  };
  const sourceB = {
    key: 'target-overlap-source-b',
    name: 'Source B',
    album_artist: 'Ordering Artist',
    year: 2026,
    tracks: [sourceBTrack],
  };
  const destination = {
    key: 'target-overlap-destination',
    name: 'Shared Destination',
    album_artist: 'Ordering Artist',
    year: 2026,
    tracks: [existingDestinationTrack],
  };
  const afterEditA = [{
    ...sourceA,
    tracks: [],
  }, {
    ...destination,
    tracks: [existingDestinationTrack, sourceATrack],
  }];
  const afterEditB = [{
    ...sourceB,
    tracks: [],
  }, {
    ...destination,
    tracks: [existingDestinationTrack, sourceBTrack],
  }];
  const destinationUpdates = (trackPath) => ({
    [trackPath]: {
      album: 'Shared Destination',
      album_artist: 'Ordering Artist',
      year: 2026,
    },
  });
  const claimA = context.claimTagEditViewMutation(
    sourceA,
    [sourceATrack.path],
    destinationUpdates(sourceATrack.path),
  );
  const claimB = context.claimTagEditViewMutation(
    sourceB,
    [sourceBTrack.path],
    destinationUpdates(sourceBTrack.path),
  );
  const pendingResponses = new Map();
  context.state.ui = { viewStateRevision: 51 };
  context.state.view.selected_artist = '';
  context.state.view.primary_artist_groups = [];
  context.state.view.family_artist_groups = [];
  context.state.view.artist_groups = [{
    artist: 'Ordering Artist',
    albums: [sourceA, sourceB, destination],
  }];
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: true } : null
  );
  context.fetch = (url) => new Promise((resolve) => {
    pendingResponses.set(String(url).split('/').pop(), resolve);
  });
  context.getAlbumRequestKey = (album) => String(album?.key || '');
  context.getAlbumIdentity = (album) => String(album?.key || '');
  context.showRepairAlert = () => {};
  const completedResponse = (updatedAlbums) => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: false,
        updated_albums: updatedAlbums,
      };
    },
  });

  const olderCompletion = context.watchSaveTask('target-overlap-a', {
    originalAlbum: sourceA,
    originatingViewStateRevision: 51,
    tagEditMutationClaim: claimA,
  });
  const newerCompletion = context.watchSaveTask('target-overlap-b', {
    originalAlbum: sourceB,
    originatingViewStateRevision: 51,
    tagEditMutationClaim: claimB,
  });

  pendingResponses.get('target-overlap-b')(completedResponse(afterEditB));
  await newerCompletion;
  pendingResponses.get('target-overlap-a')(completedResponse(afterEditA));
  await olderCompletion;

  const destinationAlbum = JSON.parse(JSON.stringify(
    context.state.view.artist_groups[0].albums.find(
      (album) => album.key === destination.key,
    ),
  ));
  assert.deepEqual(
    destinationAlbum.tracks,
    [existingDestinationTrack, sourceBTrack],
  );
});

test('watchSaveTask preserves absolute scroll intent through a required view refresh', async () => {
  const context = loadHelpers();
  const refreshCalls = [];
  context.buildApiUrl = () => '/api/library';
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [],
      };
    },
  });
  context.fetchAndRender = async (...args) => {
    refreshCalls.push(args);
    return true;
  };
  context.showRepairAlert = () => {};

  await context.watchSaveTask('absolute-refresh-task', {
    preserveAbsoluteScroll: true,
  });

  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0][0], '/api/library');
  assert.equal(refreshCalls[0][1], false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(refreshCalls[0][2])),
    {
      preserveScroll: true,
      preserveAbsoluteScroll: true,
      preserveGalleryOptionsMenu: true,
      preserveMountedGalleryChildren: true,
      retainMountedGalleryIfEquivalent: true,
      restartIfSameUrl: true,
    },
  );
});

test('watchSaveTask preserves absolute scroll intent while rendering finalized albums', async () => {
  const context = loadHelpers();
  const finalizedAlbum = {
    key: 'finalized-absolute-album',
    name: 'Finalized Absolute Album',
    album_artist: 'Rarity Artist',
    tracks: [{ path: 'D:\\Synthetic Music\\Rarity Artist\\Finalized\\01 Track.mp3' }],
  };
  const renderCalls = [];
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: false,
        updated_albums: [finalizedAlbum],
      };
    },
  });
  context.renderView = (options) => renderCalls.push(options);
  context.showRepairAlert = () => {};

  await context.watchSaveTask('absolute-finalized-task', {
    preserveAbsoluteScroll: true,
  });

  assert.equal(renderCalls.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(renderCalls[0])),
    { preserveScroll: true, preserveAbsoluteScroll: true },
  );
});

test('watchSaveTask keeps default callers on ordinary anchor preservation', async () => {
  const context = loadHelpers();
  const renderCalls = [];
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: false,
        updated_albums: [],
      };
    },
  });
  context.renderView = (options) => renderCalls.push(options);
  context.showRepairAlert = () => {};

  await context.watchSaveTask('ordinary-finalized-task');

  assert.equal(renderCalls.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(renderCalls[0])),
    { preserveScroll: true },
  );
});

test('watchSaveTask persists a failed tag edit and exposes Log History', async () => {
  const context = loadHelpers();
  const logEntry = {
    id: 'failed-tag-edit-1',
    action: 'Tag edit failed',
    error: 'Full structural persistence failure for D:\\Music\\Artist\\Album\\01 Track.flac',
  };
  const persistedEntries = [];
  const alerts = [];
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'failed',
        error: logEntry.error,
        log_entry: logEntry,
      };
    },
  });
  context.prependUtilityLogHistoryEntry = async (entry) => persistedEntries.push(entry);
  context.showRepairAlert = (...args) => alerts.push(args);

  await context.watchSaveTask('failed-tag-task');

  assert.deepEqual(persistedEntries, [logEntry]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0][0], logEntry.error);
  assert.equal(alerts[0][1], 'error');
  assert.equal(alerts[0][2], null);
  assert.equal(alerts[0][3].logHistoryLink, true);
});

test('watchSaveTask refreshes the compensated authoritative view before surfacing a failed tag edit', async () => {
  const context = loadHelpers();
  const events = [];
  context.buildApiUrl = () => '/api/library';
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'failed',
        error: 'Structural persistence failed after media compensation.',
      };
    },
  });
  context.fetchAndRender = async (...args) => {
    events.push(['refresh', ...args]);
    return true;
  };
  context.showRepairAlert = (...args) => events.push(['alert', ...args]);

  await context.watchSaveTask('failed-compensated-tag-task', {
    preserveAbsoluteScroll: true,
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(events)),
    [
      [
        'refresh',
        '/api/library',
        false,
        {
          preserveScroll: true,
          preserveAbsoluteScroll: true,
          preserveGalleryOptionsMenu: true,
        },
      ],
      [
        'alert',
        'Structural persistence failed after media compensation.',
        'error',
        null,
        { logHistoryLink: true },
      ],
    ],
  );
});

test('watchSaveTask preserves the hydrated open modal when a failed save refresh returns a partial projection', async () => {
  const context = loadHelpers();
  const firstTrackPath = 'D:\\Synthetic Music\\Failure Artist\\Source Album\\01 First.flac';
  const secondTrackPath = 'D:\\Synthetic Music\\Failure Artist\\Source Album\\02 Second.flac';
  const hydratedAlbum = {
    key: 'failure-source-album',
    request_key: 'failure-source-request',
    identity_key: 'failure-source-identity',
    name: 'Source Album',
    album_artist: 'Failure Artist',
    track_count_preview: 2,
    preview_only: false,
    tracks: [
      { path: firstTrackPath, title: 'First' },
      { path: secondTrackPath, title: 'Second' },
    ],
  };
  const optimisticAlbum = {
    ...hydratedAlbum,
    track_count_preview: 1,
    preview_only: false,
    tracks: [
      { path: secondTrackPath, title: 'Second' },
    ],
  };
  const partialAlbum = {
    ...optimisticAlbum,
    track_count_preview: 2,
    preview_only: true,
  };
  const renderedAlbums = [];
  context.state.view.artist_groups = [{
    artist: 'Failure Artist',
    albums: [hydratedAlbum],
  }];
  context.state.modalReleases = [optimisticAlbum];
  context.state.modalReleaseIndex = 0;
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: false } : null
  );
  context.buildApiUrl = () => '/api/library';
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'failed',
        error: 'permission denied for table ignored_versions',
      };
    },
  });
  context.fetchAndRender = async () => {
    context.state.view.artist_groups = [{
      artist: 'Failure Artist',
      albums: [partialAlbum],
    }];
    return true;
  };
  context.getAlbumRequestKey = (album) => String(album?.request_key || '');
  context.getAlbumIdentity = (album) => String(album?.identity_key || '');
  context.cacheHydratedTrackModalAlbum = () => {};
  context.getAlbumReleaseSet = (album) => ({ releases: [album], selectedIndex: 0 });
  context.renderTrackModalRelease = (album) => renderedAlbums.push(album);
  context.showRepairAlert = () => {};

  await context.watchSaveTask('failed-partial-refresh-task', {
    originalAlbum: hydratedAlbum,
  });

  const renderedModal = renderedAlbums.at(-1);
  assert.ok(renderedModal);
  assert.equal(renderedModal.request_key, hydratedAlbum.request_key);
  assert.equal(renderedModal.identity_key, hydratedAlbum.identity_key);
  assert.deepEqual(
    Array.from(renderedModal.tracks, (track) => track.path),
    [firstTrackPath, secondTrackPath],
  );
  assert.equal(renderedModal.preview_only, false);
});

test('watchSaveTask restores the pre-edit album before surfacing an error when compensated refresh fails', async () => {
  const context = loadHelpers();
  const originalAlbum = {
    key: 'pre-edit-source',
    name: 'Source Album',
    album_artist: 'Compensation Artist',
    tracks: [
      { path: 'D:\\Music\\Compensation Artist\\Source Album\\01 First.flac' },
      { path: 'D:\\Music\\Compensation Artist\\Source Album\\02 Second.flac' },
    ],
  };
  const events = [];
  context.console = { warn() {} };
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: true } : null
  );
  context.buildApiUrl = () => '/api/library';
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'failed',
        error: 'Structural persistence failed after media compensation.',
      };
    },
  });
  context.fetchAndRender = async () => {
    throw new Error('authoritative refresh unavailable');
  };
  context.applyUpdatedAlbumsToCurrentView = (albums, options) => {
    events.push(['restore', albums, options]);
  };
  context.renderView = (options) => events.push(['render', options]);
  context.showRepairAlert = (...args) => events.push(['alert', ...args]);

  await context.watchSaveTask('failed-compensated-refresh-task', {
    originalAlbum,
    preserveAbsoluteScroll: true,
  });

  assert.equal(events[0][0], 'restore');
  assert.strictEqual(events[0][1][0], originalAlbum);
  assert.deepEqual(
    JSON.parse(JSON.stringify(events[0][2])),
    {
      skipRender: true,
      originalAlbum,
      preserveScroll: true,
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(events.slice(1))),
    [
      ['render', { preserveScroll: true, preserveAbsoluteScroll: true }],
      [
        'alert',
        'Structural persistence failed after media compensation.',
        'error',
        null,
        { logHistoryLink: true },
      ],
    ],
  );
});

test('watchSaveTask does not restore origin-bound album state after navigation before a failed task', async () => {
  const context = loadHelpers();
  const originalAlbum = {
    key: 'pre-edit-source',
    name: 'Source Album',
    album_artist: 'Compensation Artist',
    tracks: [{ path: 'D:\\Music\\Compensation Artist\\Source Album\\01 First.flac' }],
  };
  const localMutations = [];
  const alerts = [];
  context.state.ui = { viewStateRevision: 7 };
  context.console = { warn() {} };
  context.document.getElementById = (id) => (
    id === 'track-modal' ? { hidden: false } : null
  );
  context.buildApiUrl = () => '/api/library';
  context.fetch = async () => ({
    ok: true,
    async json() {
      context.state.ui.viewStateRevision = 8;
      return {
        ok: true,
        status: 'failed',
        error: 'Structural persistence failed after media compensation.',
      };
    },
  });
  context.fetchAndRender = async () => {
    throw new Error('current-view refresh unavailable');
  };
  context.applyUpdatedAlbumsToCurrentView = (...args) => localMutations.push(['apply', ...args]);
  context.renderView = (...args) => localMutations.push(['render', ...args]);
  context.updateOpenTrackModalAfterTagEdit = (...args) => localMutations.push(['modal', ...args]);
  context.showRepairAlert = (...args) => alerts.push(args);

  await context.watchSaveTask('navigated-failed-tag-task', {
    originalAlbum,
    originatingViewStateRevision: 7,
  });

  assert.deepEqual(localMutations, []);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0][0], 'Structural persistence failed after media compensation.');
});

test('watchSaveTask does not apply finalized origin albums after navigation before completion', async () => {
  const context = loadHelpers();
  const originalAlbum = {
    key: 'pre-edit-source',
    name: 'Source Album',
    tracks: [{ path: 'D:\\Music\\Artist\\Source Album\\01 First.flac' }],
  };
  const finalizedAlbum = {
    key: 'renamed-destination',
    name: 'Renamed Destination',
    tracks: originalAlbum.tracks,
  };
  const localMutations = [];
  const requestedViews = [];
  const authoritativeRefreshes = [];
  const alerts = [];
  context.state.ui = { viewStateRevision: 11 };
  context.buildApiUrl = (view) => {
    requestedViews.push(view);
    return '/api/current-library-view';
  };
  context.fetchAndRender = async (...args) => {
    authoritativeRefreshes.push(args);
    return true;
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      context.state.ui.viewStateRevision = 12;
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: false,
        updated_albums: [finalizedAlbum],
      };
    },
  });
  context.applyUpdatedAlbumsToCurrentView = (...args) => localMutations.push(['apply', ...args]);
  context.renderView = (...args) => localMutations.push(['render', ...args]);
  context.updateOpenTrackModalAfterTagEdit = (...args) => localMutations.push(['modal', ...args]);
  context.showRepairAlert = (...args) => alerts.push(args);

  await context.watchSaveTask('navigated-completed-tag-task', {
    originalAlbum,
    originatingViewStateRevision: 11,
    preserveAbsoluteScroll: true,
    absoluteScrollPosition: {
      scrollLeft: 19,
      scrollTop: 777,
    },
  });

  assert.deepEqual(localMutations, []);
  assert.deepEqual(requestedViews, [context.state.view]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(authoritativeRefreshes)),
    [[
      '/api/current-library-view',
      false,
      { preserveScroll: true, preserveGalleryOptionsMenu: true },
    ]],
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0][0], 'Library view updated from saved files.');
});

test('watchSaveTask drops origin absolute scroll after navigation before a required refresh', async () => {
  const context = loadHelpers();
  const requestedViews = [];
  const authoritativeRefreshes = [];
  context.state.ui = { viewStateRevision: 21 };
  context.buildApiUrl = (view) => {
    requestedViews.push(view);
    return '/api/current-library-view';
  };
  context.fetchAndRender = async (...args) => {
    authoritativeRefreshes.push(args);
    return true;
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      context.state.ui.viewStateRevision = 22;
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [],
      };
    },
  });
  context.showRepairAlert = () => {};

  await context.watchSaveTask('navigated-required-refresh-task', {
    originatingViewStateRevision: 21,
    preserveAbsoluteScroll: true,
    absoluteScrollPosition: {
      scrollLeft: 23,
      scrollTop: 888,
    },
  });

  assert.deepEqual(requestedViews, [context.state.view]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(authoritativeRefreshes)),
    [[
      '/api/current-library-view',
      false,
      {
        preserveScroll: true,
        preserveGalleryOptionsMenu: true,
        preserveMountedGalleryChildren: true,
        retainMountedGalleryIfEquivalent: true,
        restartIfSameUrl: true,
      },
    ]],
  );
});

test('watchSaveTask retains origin absolute scroll after an overlay-only revision change', async () => {
  const context = loadHelpers();
  const authoritativeRefreshes = [];
  context.state.ui = { viewStateRevision: 21 };
  context.buildApiUrl = () => '/api/library?selected_artist=DDT';
  context.fetchAndRender = async (...args) => {
    authoritativeRefreshes.push(args);
    return true;
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      context.state.ui.viewStateRevision = 22;
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: true,
        updated_albums: [],
      };
    },
  });
  context.showRepairAlert = () => {};

  await context.watchSaveTask('overlay-required-refresh-task', {
    originatingViewStateRevision: 21,
    originatingViewRequestUrl: '/api/library?selected_artist=DDT',
    preserveAbsoluteScroll: true,
    absoluteScrollPosition: {
      scrollLeft: 31,
      scrollTop: 1147,
    },
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(authoritativeRefreshes)),
    [[
      '/api/library?selected_artist=DDT',
      false,
      {
        preserveScroll: true,
        preserveAbsoluteScroll: true,
        absoluteScrollPosition: {
          scrollLeft: 31,
          scrollTop: 1147,
        },
        preserveGalleryOptionsMenu: true,
        preserveMountedGalleryChildren: true,
        retainMountedGalleryIfEquivalent: true,
        restartIfSameUrl: true,
      },
    ]],
  );
});

test('watchSaveTask completes an owned terminal reconciliation at the captured gallery scroll', async () => {
  const context = loadHelpers();
  const galleryScroll = { scrollLeft: 0, scrollTop: 1129 };
  const ownedRestores = [];
  const originalAlbum = {
    key: 'ddt::studio-records5',
    name: 'Studio Records5',
    album_artist: 'DDT',
    tracks: [{ path: 'D:\\Synthetic Music\\DDT\\Studio Records5\\05 Track.flac' }],
  };
  context.state.ui = { viewStateRevision: 21 };
  context.state.view.artist_groups = [{ artist: 'DDT', albums: [originalAlbum] }];
  context.buildApiUrl = () => '/api/library?selected_artist=DDT';
  context.document.getElementById = (id) => {
    if (id === 'albums-scroll') return galleryScroll;
    if (id === 'track-modal') return { hidden: true };
    return null;
  };
  context.virtualGrid = {
    restoreOwnedAbsoluteScrollPosition(position) {
      ownedRestores.push({ ...position });
      galleryScroll.scrollLeft = position.scrollLeft;
      galleryScroll.scrollTop = position.scrollTop;
      return true;
    },
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        status: 'completed',
        requires_view_refresh: false,
        updated_albums: [originalAlbum],
        log_entry: { id: 'ddt-split-5-complete' },
      };
    },
  });
  context.applyUpdatedAlbumsToCurrentView = (albums) => albums;
  context.renderView = () => {
    galleryScroll.scrollTop = 1147;
  };
  context.updateOpenTrackModalAfterTagEdit = () => {};
  context.prependUtilityLogHistoryEntry = async () => {
    galleryScroll.scrollTop = 1129;
  };
  context.showRepairAlert = () => {};

  await context.watchSaveTask('ddt-split-5-terminal', {
    originalAlbum,
    originatingViewStateRevision: 21,
    originatingViewRequestUrl: '/api/library?selected_artist=DDT',
    preserveAbsoluteScroll: true,
    absoluteScrollPosition: { scrollLeft: 0, scrollTop: 1147 },
  });

  assert.equal(
    galleryScroll.scrollTop,
    1147,
    'the terminal owner must reassert its captured position after overlapping UI work settles',
  );
  assert.deepEqual(ownedRestores, [{ scrollLeft: 0, scrollTop: 1147 }]);
});

test('watchSaveTask drops origin absolute scroll after navigation before a failed-task refresh', async () => {
  const context = loadHelpers();
  const requestedViews = [];
  const authoritativeRefreshes = [];
  const alerts = [];
  context.state.ui = { viewStateRevision: 31 };
  context.buildApiUrl = (view) => {
    requestedViews.push(view);
    return '/api/current-library-view';
  };
  context.fetchAndRender = async (...args) => {
    authoritativeRefreshes.push(args);
    return true;
  };
  context.fetch = async () => ({
    ok: true,
    async json() {
      context.state.ui.viewStateRevision = 32;
      return {
        ok: true,
        status: 'failed',
        error: 'Structural persistence failed after media compensation.',
      };
    },
  });
  context.showRepairAlert = (...args) => alerts.push(args);

  await context.watchSaveTask('navigated-failed-refresh-task', {
    originatingViewStateRevision: 31,
    preserveAbsoluteScroll: true,
    absoluteScrollPosition: {
      scrollLeft: 29,
      scrollTop: 999,
    },
  });

  assert.deepEqual(requestedViews, [context.state.view]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(authoritativeRefreshes)),
    [[
      '/api/current-library-view',
      false,
      { preserveScroll: true, preserveGalleryOptionsMenu: true },
    ]],
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0][0], 'Structural persistence failed after media compensation.');
});

test('track problem navigation keeps the full album list unfiltered while focusing the exact track', async () => {
  const { context, trackPath } = loadProblematicTrackNavigationHelpers();

  await context.openUtilityModalForTrack(trackPath);

  assert.equal(context.state.utility.selectedProblematicKey, 'album-alpha');
  assert.equal(context.state.utility.searchQuery, '');
  assert.equal(context.state.utility.focusedTrackPath, trackPath);
  assert.deepEqual(
    Array.from(context.getFilteredProblematicAlbums(), (item) => item.key),
    ['album-alpha', 'album-beta'],
  );
});

test('track-origin Problematic Files navigation clears loop Space ownership on both open paths', async () => {
  for (const optimistic of [false, true]) {
    const { context, trackPath } = loadProblematicTrackNavigationHelpers();
    let transitionCalls = 0;
    context.state.utility.activeTab = 'loops';
    context.state.utility.loopSpaceOwnerId = 'loop-1';
    context.setUtilityActiveTab = (nextTab) => {
      transitionCalls += 1;
      if (context.state.utility.activeTab === 'loops' && nextTab !== 'loops') {
        context.state.utility.loopSpaceOwnerId = '';
      }
      context.state.utility.activeTab = nextTab;
      return nextTab;
    };
    if (optimistic) {
      context.state.utility.pendingProblematicSaveTasks = {
        optimistic: {
          promise: Promise.resolve(),
          trackPaths: [trackPath],
          optimisticAlbums: [context.state.utility.problematicFiles[0]],
        },
      };
    }

    await context.openUtilityModalForTrack(trackPath);
    assert.ok(transitionCalls >= 1, `expected transition policy for optimistic=${optimistic}`);
    assert.equal(context.state.utility.activeTab, 'problematic-files');
    assert.equal(context.state.utility.loopSpaceOwnerId, '');

    context.setUtilityActiveTab('loops');
    assert.equal(context.state.utility.loopSpaceOwnerId, '');
  }
});

test('track problem navigation opens an optimistic structural album before its owning save settles', async () => {
  const { context, trackPath } = loadProblematicTrackNavigationHelpers();
  let releaseSaveTask;
  const saveTask = new Promise((resolve) => {
    releaseSaveTask = resolve;
  });
  let releaseAcceptedEdit;
  const acceptedEdit = new Promise((resolve) => {
    releaseAcceptedEdit = resolve;
  });
  const refreshedAlbum = {
    ...context.state.utility.problematicFiles[0],
    key: 'album-alpha-split',
    name: 'Album Alpha Split',
    detail_loaded: false,
  };
  const summaryLoads = [];
  const detailLoads = [];
  let markDetailStarted;
  const detailStarted = new Promise((resolve) => {
    markDetailStarted = resolve;
  });
  const opens = [];
  context.state.utility.pendingProblematicSaveTasks = {
    'split-task': {
      promise: saveTask,
      acceptedPromise: acceptedEdit,
      trackPaths: [trackPath],
      optimisticAlbums: [refreshedAlbum],
    },
  };
  context.loadProblematicFiles = async (force) => {
    summaryLoads.push(force);
    context.state.utility.problematicFiles = [
      refreshedAlbum,
      context.state.utility.problematicFiles[1],
    ];
    return context.state.utility.problematicFiles;
  };
  context.openUtilityModal = () => {
    opens.push(context.state.utility.selectedProblematicKey);
  };
  context.loadProblematicAlbumDetail = async (albumKey, force, options) => {
    detailLoads.push([albumKey, force, options]);
    markDetailStarted();
    return { ...refreshedAlbum, detail_loaded: true };
  };

  const navigation = context.openUtilityModalForTrack(trackPath);
  assert.deepEqual(
    opens,
    [refreshedAlbum.key],
    'the optimistic Problematic Files shell must open synchronously instead of waiting for persistence',
  );
  assert.equal(context.state.utility.selectedProblematicKey, refreshedAlbum.key);
  assert.equal(context.state.utility.focusedTrackPath, trackPath);
  assert.equal(
    context.state.utility.problematicFiles.some((album) => album.key === refreshedAlbum.key),
    true,
    'the optimistic structural album must already exist in the sidebar tree',
  );
  assert.deepEqual(detailLoads, []);
  releaseAcceptedEdit();
  await detailStarted;
  assert.equal(
    detailLoads[0]?.[0],
    refreshedAlbum.key,
    'the targeted Postgres detail request must start before the broader save task settles',
  );
  releaseSaveTask();
  await navigation;

  assert.deepEqual(summaryLoads, [true]);
  assert.equal(context.state.utility.selectedProblematicKey, refreshedAlbum.key);
  assert.equal(context.state.utility.focusedTrackPath, trackPath);
});

test('optimistic Problematic Files rows do not claim a false zero-issue count', () => {
  const context = loadHelpers();

  assert.equal(
    context.getProblematicAlbumIssueLabel({ detail_loading_deferred: true }),
    'Loading issues…',
  );
  assert.equal(
    context.getProblematicAlbumIssueLabel({ problem_reasons: ['Missing year'] }),
    '1 issue',
  );
});

test('track-origin Problematic Files navigation renders only after the canonical album owns selection', async () => {
  const { context, trackPath } = loadProblematicTrackNavigationHelpers();
  const renderedStates = [];
  context.renderUtilityModalContent = () => {
    renderedStates.push({
      key: context.state.utility.selectedProblematicKey,
      trackPath: context.state.utility.focusedTrackPath,
    });
  };
  context.openUtilityModal = (options = {}) => {
    if (options.resetSearch) context.state.utility.searchQuery = '';
    if (options.resetSelection) context.state.utility.selectedProblematicKey = '';
    context.renderUtilityModalContent();
  };

  await context.openUtilityModalForTrack(trackPath);

  assert.deepEqual(renderedStates, [{ key: 'album-alpha', trackPath }]);
});

test('overlapping track-origin navigation lets only the newest request open and render in either completion order', async (t) => {
  for (const completionOrder of [['older', 'newer'], ['newer', 'older']]) {
    await t.test(completionOrder.join(' then '), async () => {
      const { context, album: olderAlbum, trackPath: olderTrackPath } = loadProblematicTrackNavigationHelpers();
    const newerTrackPath = 'C:\\Music\\Artist Beta\\Album Beta\\02 Newer Problem.flac';
    const newerAlbum = {
      key: 'album-beta',
      name: 'Album Beta',
      album_artist: 'Artist Beta',
      detail_loaded: false,
      problematic_track_paths: [newerTrackPath],
      track_paths: [newerTrackPath],
      tracks: [{ path: newerTrackPath, title: 'Newer Problem' }],
      track_problem_rows: [],
      repair_preview_rows: [],
    };
    olderAlbum.detail_loaded = false;
    context.state.utility.problematicFiles = [olderAlbum, newerAlbum];
    const completions = new Map();
    context.loadProblematicAlbumDetail = (albumKey) => new Promise((resolve) => {
      completions.set(albumKey, () => {
        const target = context.state.utility.problematicFiles.find((item) => item.key === albumKey);
        if (target) target.detail_loaded = true;
        resolve(target);
      });
    });
    const opens = [];
    context.openUtilityModal = () => {
      opens.push({
        key: context.state.utility.selectedProblematicKey,
        trackPath: context.state.utility.focusedTrackPath,
      });
    };

    const olderNavigation = context.openUtilityModalForTrack(olderTrackPath);
    const newerNavigation = context.openUtilityModalForTrack(newerTrackPath);
    await Promise.resolve();
    const completionByName = {
      older: completions.get(olderAlbum.key),
      newer: completions.get(newerAlbum.key),
    };
    assert.equal(typeof completionByName.older, 'function');
    assert.equal(typeof completionByName.newer, 'function');
    completionByName[completionOrder[0]]();
    await Promise.resolve();
    completionByName[completionOrder[1]]();
    await Promise.all([olderNavigation, newerNavigation]);

      assert.deepEqual(opens, [{ key: newerAlbum.key, trackPath: newerTrackPath }]);
    });
  }
});

test('track-origin navigation clears active ownership when an unexpected detail dependency rejects', async () => {
  const { context, album, trackPath } = loadProblematicTrackNavigationHelpers();
  album.detail_loaded = false;
  context.loadProblematicAlbumDetail = async () => {
    throw new Error('unexpected detail dependency failure');
  };

  await assert.rejects(
    context.openUtilityModalForTrack(trackPath),
    /unexpected detail dependency failure/,
  );

  assert.equal(context.state.utility.problematicNavigationActiveToken, 0);
});

test('hydrated incomplete-order detail remains visible under the summary problem filter', () => {
  const { context } = loadProblematicTrackNavigationHelpers();
  context.state.utility.problematicFiles = [{
    key: 'incomplete-order-album',
    name: 'Incomplete Order Album',
    album_artist: 'Artist Alpha',
    detail_loaded: true,
    problem_reasons: ['Incomplete track order: Disc 1 missing 2, 4'],
  }];
  context.state.utility.selectedProblemFilters = ['Incomplete track order'];
  context.state.utility.searchQuery = '';

  assert.deepEqual(
    Array.from(context.getProblemReasonTypes()),
    ['Incomplete track order'],
  );
  assert.deepEqual(
    Array.from(context.getFilteredProblematicAlbums(), (item) => item.key),
    ['incomplete-order-album'],
  );
});

test('problematic search always includes structured summary fields beside compact track-title text', () => {
  const { context } = loadProblematicTrackNavigationHelpers();
  context.state.utility.problematicFiles = [{
    key: 'structured-search-album',
    name: 'Structured Match Album',
    album_artist: 'Structured Match Artist',
    year: '2026',
    raw_name: 'Structured Raw Album',
    raw_album_artist: 'Structured Raw Artist',
    problem_reasons: ['Incomplete track order'],
    search_text: 'Only Track Title',
  }];
  context.state.utility.selectedProblemFilters = [];

  for (const query of ['structured match album', 'structured raw artist', '2026', 'incomplete track order']) {
    context.state.utility.searchQuery = query;
    assert.deepEqual(
      Array.from(context.getFilteredProblematicAlbums(), (item) => item.key),
      ['structured-search-album'],
    );
  }
});

test('track problem navigation refreshes one stale loaded summary before selecting the exact track', async () => {
  const { context, trackPath } = loadProblematicTrackNavigationHelpers();
  const refreshedAlbum = {
    key: 'album-alpha-refreshed',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    detail_loaded: false,
    problematic_track_paths: [trackPath],
    track_paths: [trackPath],
  };
  const summaryLoads = [];
  const detailLoads = [];
  context.state.utility.problematicFiles = context.state.utility.problematicFiles.slice(1);
  context.loadProblematicFiles = async (force) => {
    summaryLoads.push(force);
    context.state.utility.problematicFiles = [
      refreshedAlbum,
      ...context.state.utility.problematicFiles,
    ];
  };
  context.loadProblematicAlbumDetail = async (albumKey, force) => {
    detailLoads.push([albumKey, force]);
    refreshedAlbum.detail_loaded = true;
  };

  await context.openUtilityModalForTrack(trackPath);

  assert.deepEqual(summaryLoads, [true]);
  assert.deepEqual(detailLoads, [['album-alpha-refreshed', undefined]]);
  assert.equal(context.state.utility.selectedProblematicKey, 'album-alpha-refreshed');
  assert.equal(context.state.utility.focusedTrackPath, trackPath);
});

test('failed stale-summary refresh does not add a second missing-track error', async () => {
  const { context, trackPath } = loadProblematicTrackNavigationHelpers();
  const toasts = [];
  context.state.utility.problematicFiles = context.state.utility.problematicFiles.slice(1);
  context.loadProblematicFiles = async () => {
    context.showToast('Unable to load problematic files.', 'error', 3200);
    return null;
  };
  context.showToast = (...args) => toasts.push(args);

  await context.openUtilityModalForTrack(trackPath);

  assert.deepEqual(toasts, [['Unable to load problematic files.', 'error', 3200]]);
});

test('structural reconciliation removes every obsolete problematic identity after restore', () => {
  const { context, trackPath } = loadProblematicTrackNavigationHelpers();
  const restoredPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\01 Restored.flac';
  const obsoleteDestination = {
    key: 'album-alpha-split',
    name: 'Album Alpha Split',
    track_paths: [trackPath, restoredPath],
  };
  const obsoleteDestinationAlias = {
    key: 'album-alpha-split-stale-alias',
    name: 'Album Alpha Split',
    track_paths: [restoredPath],
  };
  const unrelatedAlbum = context.state.utility.problematicFiles[1];
  context.state.utility.problematicFiles = [
    obsoleteDestination,
    obsoleteDestinationAlias,
    unrelatedAlbum,
  ];
  context.state.utility.selectedProblematicKey = obsoleteDestination.key;

  context.applyRepairResultToProblematicFiles(obsoleteDestination, null);

  assert.deepEqual(
    Array.from(context.state.utility.problematicFiles, (album) => album.key),
    [unrelatedAlbum.key],
  );
  assert.equal(context.state.utility.selectedProblematicKey, '');
});

test('removing the selected problematic row silently selects the nearest previous survivor', () => {
  const { context } = loadProblematicTrackNavigationHelpers();
  const first = { key: 'album-first', track_paths: ['C:\\Music\\First\\01.flac'] };
  const removed = { key: 'album-removed', track_paths: ['C:\\Music\\Removed\\01.flac'] };
  const last = { key: 'album-last', track_paths: ['C:\\Music\\Last\\01.flac'] };
  context.state.utility.problematicFiles = [first, removed, last];
  context.state.utility.selectedProblematicKey = removed.key;
  context.state.utility.problematicMutation = {
    taskId: 'task-17',
    albumKey: removed.key,
    priorKeys: [first.key, removed.key, last.key],
    priorScrollTop: 237,
  };

  context.applyRepairResultToProblematicFiles(removed, null);

  assert.deepEqual(
    Array.from(context.state.utility.problematicFiles, (album) => album.key),
    [first.key, last.key],
  );
  assert.equal(context.state.utility.selectedProblematicKey, first.key);
  assert.equal(context.state.utility.problematicMutation?.priorScrollTop, 237);
});

test('detected problem rows expose their track path as stable DOM identity', () => {
  const { album, context, trackPath } = loadProblematicTrackNavigationHelpers();

  const html = context.buildDetectedProblemsHtml(album);

  assert.ok(
    html.includes(`data-problematic-track-path="${trackPath}"`),
    'the detected problem row should expose the exact server-owned track path',
  );
});

test('detected problem rows preserve each server-owned disc missing-number label', () => {
  const { context } = loadProblematicTrackNavigationHelpers();
  const discOnePath = 'C:\\Music\\Artist Alpha\\Album Alpha\\Disc 1\\03 Third.flac';
  const discTwoPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\Disc 2\\04 Fourth.flac';
  const album = {
    problem_reasons: ['Incomplete track order'],
    track_problem_rows: [
      {
        path: discOnePath,
        reasons: ['Incomplete track order: Disc 1 missing 1, 2'],
        ignorable_reasons: [],
      },
      {
        path: discTwoPath,
        reasons: ['Incomplete track order: Disc 2 missing 1, 3'],
        ignorable_reasons: [],
      },
    ],
  };

  const html = context.buildDetectedProblemsHtml(album);
  const discOneStart = html.indexOf(`data-problematic-track-path="${discOnePath}"`);
  const discTwoStart = html.indexOf(`data-problematic-track-path="${discTwoPath}"`);
  const discOneRow = html.slice(discOneStart, discTwoStart);
  const discTwoRow = html.slice(discTwoStart);

  assert.ok(discOneStart >= 0);
  assert.ok(discTwoStart > discOneStart);
  assert.match(discOneRow, /Incomplete track order: Disc 1 missing 1, 2/);
  assert.doesNotMatch(discOneRow, /Disc 2 missing/);
  assert.match(discTwoRow, /Incomplete track order: Disc 2 missing 1, 3/);
  assert.doesNotMatch(discTwoRow, /Disc 1 missing/);
  assert.deepEqual(album.problem_reasons, ['Incomplete track order']);
});

test('detected problems do not promote track reasons into an empty album-level section', () => {
  const { context } = loadProblematicTrackNavigationHelpers();
  const html = context.buildDetectedProblemsHtml({
    problem_reasons: ['Undecoded characters'],
    album_problem_rows: [],
    track_problem_rows: [{
      path: 'C:\\Music\\Neal Morse\\Questions\\01 The Temple of the Living God.flac',
      filename: '01 The Temple of the Living God.flac',
      reasons: ['Undecoded characters'],
      ignorable_reasons: [{
        row_key: 'opaque-file-problem',
        reason: 'Undecoded characters',
      }],
    }],
  });

  const albumSection = html.slice(
    html.indexOf('utility-album-problem-content'),
    html.indexOf('utility-track-problem-table'),
  );
  assert.doesNotMatch(albumSection, /Undecoded characters/);
  assert.match(html, /01 The Temple of the Living God\.flac/);
  assert.match(html, /Undecoded characters/);
});

test('album-only detected problems explain the tag context and omit the empty track section', () => {
  const { context } = loadProblematicTrackNavigationHelpers();
  const html = context.buildDetectedProblemsHtml({
    problem_reasons: ['Undecoded characters'],
    album_problem_rows: [{
      row_key: 'neal morse::?::problem-album::undecoded-characters',
      reason: 'Undecoded characters',
      display_reason: 'Undecoded characters ("?" in Album)',
    }],
    track_problem_rows: [],
  });

  assert.match(html, /Undecoded characters \("\?" in Album\)/);
  assert.doesNotMatch(html, /TRACK-LEVEL PROBLEMS|problematic-track-problems/);
  assert.equal((html.match(/>Exclude the problem</g) || []).length, 1);
  assert.ok(
    html.indexOf('utility-detected-actions') > html.indexOf('utility-album-problem-list'),
    'the shared exclusion action must follow the album-level problem section',
  );
});

test('problem exclusion selection stays independent from Suggested Edits Apply or ignore state', () => {
  const { context } = loadProblematicTrackNavigationHelpers();
  const problemRowKey = 'album-alpha::problem::missing-year';
  const suggestionRowKey = 'track-alpha::suggestion::decoded-title';
  context.state.utility.repairSelections = { [suggestionRowKey]: 'repair' };
  context.state.utility.problemExclusionSelections = {};

  context.selectProblemExclusion(problemRowKey);

  assert.equal(context.state.utility.repairSelections[suggestionRowKey], 'repair');
  assert.equal(context.getIgnoredRepairRowKeys().includes(suggestionRowKey), false);

  context.applyRepairChoice({
    getAttribute(name) {
      return name === 'data-repair-row-key' ? suggestionRowKey : '';
    },
  }, 'ignore');

  assert.equal(context.state.utility.repairSelections[suggestionRowKey], 'ignore');
  assert.deepEqual(
    Object.keys(context.state.utility.problemExclusionSelections),
    [problemRowKey],
  );
});

test('Problematic Files detail renders the approved album-first compact table contract', () => {
  const { context } = loadProblematicTrackNavigationHelpers();
  context.getProblematicAlbumDisplayValue = (album, field) => (
    field === 'album' ? album.name : album.album_artist
  );
  context.getProblematicAlbumFileTypes = () => [];
  context.getSelectedRepairFileCount = () => 0;
  context.buildAlbumDisplayCoverUrl = () => '';
  context.getAvailableAlbumMoveActions = () => [];
  context.buildCompactDataTable = (config) => {
    context.lastCompactTableConfig = config;
    const headers = config.columnsConfig.map((column) => `<span role="columnheader">${column.label}</span>`).join('');
    const rows = config.rows.map((row) => (
      `<span role="row" data-cdt-row-key="${row.key}">`
      + config.columnsConfig.map((column) => `<span role="cell" data-cdt-column="${column.key}">${row.cells[column.key] || ''}</span>`).join('')
      + '</span>'
    )).join('');
    return `<div role="table" data-cdt-frame="${config.frame}" data-cdt-mobile="${config.mobile}">${headers}${rows}</div>`;
  };
  const album = {
    key: 'album-alpha',
    name: 'Album Alpha',
    album_artist: 'Artist Alpha',
    issue_count: 3,
    detail_loaded: true,
    problem_reasons: ['Missing cover art', 'Missing year', 'Missing track number'],
    album_problem_rows: [
      { row_key: 'opaque-album-cover', reason: 'Missing cover art' },
      { row_key: 'opaque-album-year', reason: 'Missing year' },
      { row_key: 'opaque-album-number', reason: 'Missing track number' },
    ],
    tracks: [{ path: 'C:\\Music\\Artist Alpha\\Album Alpha\\01 First.flac' }],
    track_problem_rows: [{
      path: 'C:\\Music\\Artist Alpha\\Album Alpha\\01 First.flac',
      filename: '01 First.flac',
      reasons: ['Missing year', 'Missing track number'],
      ignorable_reasons: [
        { row_key: 'opaque-file-year', reason: 'Missing year' },
        { row_key: 'opaque-file-number', reason: 'Missing track number' },
      ],
    }],
    repair_preview_rows: [],
  };

  const html = context.buildProblematicAlbumDetail(album);

  assert.equal(
    (html.match(/>\s*Detected Problems\s*</gi) || []).length,
    1,
    'the expanded detail must expose exactly one visible Detected Problems heading',
  );
  assert.ok(html.indexOf('ALBUM-LEVEL PROBLEMS') < html.indexOf('TRACK-LEVEL PROBLEMS'));
  assert.match(
    html,
    /TRACK-LEVEL PROBLEMS[^]*>1</,
    'the track-level badge must count visible track rows rather than aggregate problem reasons',
  );
  assert.deepEqual(
    album.album_problem_rows.map((row) => row.reason),
    ['Missing cover art', 'Missing year', 'Missing track number'],
  );
  assert.equal(context.lastCompactTableConfig.frame, 'inset');
  assert.equal(context.lastCompactTableConfig.mobile, 'preserve');
  assert.equal(context.lastCompactTableConfig.overflow, 'local');
  assert.equal(context.lastCompactTableConfig.columns, 'minmax(220px,.42fr) minmax(300px,.58fr)');
  assert.deepEqual(
    Array.from(context.lastCompactTableConfig.columnsConfig, (column) => column.label),
    ['Filename', 'Reason'],
  );
  assert.deepEqual(
    Array.from(context.lastCompactTableConfig.rows, (row) => row.key),
    ['C:\\Music\\Artist Alpha\\Album Alpha\\01 First.flac'],
  );
  assert.ok(html.indexOf('Missing year') < html.indexOf('Missing track number'));
  assert.equal((html.match(/>Exclude the problem</g) || []).length, 1);
  assert.doesNotMatch(html, /utility-file-type-chip|>FLAC<|>Problems<|overflow menu|Not a problem|data-open-repair-confirm/);
});

test('Problem exclusions use separate album and file compact tables without collapsing Rules layout', () => {
  const { context } = loadProblematicTrackNavigationHelpers();
  context.groupProblemIgnoreItems = () => [];
  const tableConfigs = [];
  context.buildCompactDataTable = (config) => {
    tableConfigs.push(config);
    return `<div role="table" data-action-track="${config.actionTrackWidth}">${config.rows.map((row) => (
      `${row.cells.target}${row.cells.reason}${row.cells.action}`
    )).join('')}</div>`;
  };
  const html = context.buildUtilityRuleDetail({
    key: 'problem-ignores',
    title: 'Problem exclusions',
    description: 'Album or file problems excluded from Problematic Files.',
    count: 2,
    album_items: [{
      row_key: 'opaque-album-cover',
      artist: 'Neal Morse',
      album: '?',
      year: '2005',
      problem_reason: 'Undecoded characters',
    }],
    file_items: [{
      row_key: 'opaque-file-year',
      filename: '01 First.flac',
      album: 'Album Alpha',
      problem_reason: 'Missing year',
    }],
  });

  assert.match(html, /Problem exclusions/);
  assert.match(html, /Album or file problems excluded from Problematic Files\./);
  assert.match(html, /ALBUM EXCLUSIONS/);
  assert.match(html, /FILE EXCLUSIONS/);
  assert.equal(tableConfigs.length, 2);
  assert.deepEqual(
    Array.from(tableConfigs[0].columnsConfig, (column) => column.label),
    ['Artist / Album', 'Reason', 'Actions'],
  );
  assert.deepEqual(
    Array.from(tableConfigs[1].columnsConfig, (column) => column.label),
    ['Filename', 'Reason', 'Actions'],
  );
  assert.ok(tableConfigs.every((config) => config.actionTrackWidth === '88px'));
  assert.ok(tableConfigs.every((config) => config.mobile === 'stack'));
  assert.equal((html.match(/>Revert rule</g) || []).length, 2);
  assert.equal((html.match(/Neal Morse - \? - 2005/g) || []).length, 1);
  assert.match(html, /01 First\.flac/);
  assert.match(html, /Album Alpha/);
});

test('pending Problem exclusions expose busy state and disable Revert until acknowledgement', () => {
  const { context } = loadProblematicTrackNavigationHelpers();
  let albumRows = [];
  context.buildCompactDataTable = (config) => {
    if (config.id === 'problem-exclusions-album') albumRows = config.rows;
    return config.rows.map((row) => row.cells.action).join('');
  };

  const html = context.buildUtilityRuleDetail({
    key: 'problem-ignores',
    count: 1,
    album_items: [{
      row_key: 'album::neal-morse-question-2005::undecoded-characters',
      artist: 'Neal Morse',
      album: '?',
      year: '2005',
      problem_reason: 'Undecoded characters',
      pending: true,
    }],
    file_items: [],
  });

  assert.equal(albumRows.length, 1);
  assert.match(albumRows[0].cells.action, /aria-busy="true"/);
  assert.match(albumRows[0].cells.action, /\bdisabled\b/);
  assert.match(albumRows[0].cells.action, />Revert rule</);
  assert.match(html, /aria-busy="true"/);
});

test('utility compact-table rendering fails loudly when the shared component is not registered', () => {
  const { context } = loadProblematicTrackNavigationHelpers();
  delete context.buildCompactDataTable;

  assert.throws(
    () => context.buildUtilityCompactTable({
      ariaLabel: 'Problem exclusions',
      columnsConfig: [{ key: 'target', label: 'Album' }],
      rows: [{ key: 'album-a', cells: { target: 'Album A' } }],
    }),
    /CompactDataTable|buildCompactDataTable|not (?:registered|available|loaded)/i,
    'a missing shared renderer must stop the owning surface instead of silently emitting degraded markup',
  );
});

test('saved loop entry uses the compact shared scissors control and inline range surface', () => {
  const context = loadLoopBuilderHelpers();
  context.buildLoopEditActionControl = ({ ownerId }) => (
    `<span data-loop-action-owner="${ownerId}"><button data-loop-action="enter" aria-label="Create another loop"></button></span>`
  );

  const html = context.buildUtilityLoopEntry({
    id: 'loop-1',
    name: 'Opening phrase',
    duration_seconds: 12,
  });

  assert.match(html, /data-loop-action-owner="saved-loop-loop-1"/);
  assert.match(html, /data-loop-action="enter"[^>]*aria-label="Create another loop"/);
  assert.match(
    html,
    /class="loop-play-control-cluster utility-loop-play-cluster"[^]*class="loop-play-control-button utility-loop-play"[^]*class="loop-play-control-actions utility-loop-actions"[^]*data-loop-action-owner="saved-loop-loop-1"/s,
    'saved loops must render the same Play/edit-control component hierarchy as the persistent player',
  );
  assert.match(html, /data-saved-loop-main-surface="loop-1"/);
  assert.match(html, /data-loop-range-surface/);
  assert.match(html, /data-loop-range-handle="start"/);
  assert.match(html, /data-loop-range-handle="end"/);
  assert.match(html, /data-loop-pitch-controls="loop-1"/);
  assert.doesNotMatch(html, /data-create-loop-from-saved=|data-saved-loop-editor=|>\s*Create another loop\s*</);
  assert.doesNotMatch(html, /\bBPM\b|metronome|pre-count/i);
});

test('saved loop player renders compact pitch copy and one top-right time slot', () => {
  const context = loadLoopBuilderHelpers();
  context.buildLoopEditActionControl = ({ ownerId }) => (
    `<span data-loop-action-owner="${ownerId}"></span>`
  );
  const html = context.buildUtilityLoopEntry({
    id: 'loop-1',
    name: 'Opening phrase',
    duration_seconds: 12,
  });

  assert.match(
    html,
    /data-loop-pitch-step="-1"[^>]*>\s*-\s*<\/button>\s*<span data-loop-pitch-value>0 pst<\/span>\s*<button[^>]*data-loop-pitch-step="1"[^>]*>\s*\+\s*<\/button>/,
  );
  assert.equal((html.match(/data-loop-time=/g) || []).length, 1);
  assert.doesNotMatch(html, /data-loop-range-times|data-loop-range-time=/);
  assert.match(html, /data-loop-player-top-row[^]*data-loop-pitch-control[^]*data-loop-time[^]*utility-loop-timeline-wrap/);
});

test('saved loop layout keeps edit timestamps in a dedicated row above the mono waveform', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const mainRule = css.match(/\.utility-loop-main\s*\{([^}]*)\}/s)?.[1] || '';
  const playRule = css.match(/\.loop-play-control-button\s*\{([^}]*)\}/s)?.[1] || '';
  const topRowRule = css.match(/\.utility-loop-player-top-row\s*\{([^}]*)\}/s)?.[1] || '';
  const timelineWrapRule = css.match(/\.utility-loop-timeline-wrap\s*\{([^}]*)\}/s)?.[1] || '';
  const globalRangeSurfaceRule = css.match(/\.loop-range-surface\s*\{([^}]*)\}/s)?.[1] || '';
  const savedRangeSurfaceRule = css.match(
    /\.utility-loop-timeline-wrap\s*>\s*\.loop-range-surface\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const genericHandleRule = css.match(/\.loop-range-handle\s*\{([^}]*)\}/s)?.[1] || '';
  const savedPodRule = css.match(/\.loop-play-control-actions\s*\{([^}]*)\}/s)?.[1] || '';
  const savedActionRule = css.match(
    /\.utility-loop-play-cluster\s+\.loop-edit-action\s*\{([^}]*)\}/s,
  )?.[1] || '';
  assert.match(css, /\.utility-loop-shell\s*\{[^}]*align-items:\s*center/s);
  assert.match(mainRule, /display:\s*grid/);
  assert.match(
    mainRule,
    /grid-template-rows:\s*22px\s+32px/,
    'the saved player must reserve the same timestamp-row height when edit mode hides pitch',
  );
  assert.doesNotMatch(mainRule, /grid-template-rows:\s*auto/);
  assert.match(mainRule, /height:\s*58px/);
  assert.match(mainRule, /(?:row-)?gap:\s*4px/);
  assert.match(
    mainRule,
    /position:\s*relative/,
    'the saved player owns the timestamp and waveform row coordinate system',
  );
  assert.match(topRowRule, /position:\s*relative/);
  assert.doesNotMatch(topRowRule, /position:\s*absolute/);
  assert.match(timelineWrapRule, /position:\s*relative/);
  assert.match(
    timelineWrapRule,
    /grid-row:\s*2/,
    'the waveform occupies its own row below timestamps',
  );
  assert.doesNotMatch(
    timelineWrapRule,
    /transform\s*:/,
    'a transformed timeline wrapper traps the saved z4 range handles below the overlaid z3 Play pod',
  );
  assert.match(timelineWrapRule, /min-height:\s*32px/);
  assert.match(timelineWrapRule, /height:\s*32px/);
  assert.match(globalRangeSurfaceRule, /z-index:\s*2/);
  assert.match(savedPodRule, /position:\s*absolute/);
  assert.match(savedPodRule, /z-index:\s*4/);
  assert.match(genericHandleRule, /z-index:\s*4/);
  assert.match(
    savedRangeSurfaceRule,
    /z-index:\s*auto/,
    'the saved range surface must not trap its z4 handles below the overlaid z3 Play pod',
  );
  assert.doesNotMatch(
    savedRangeSurfaceRule,
    /pointer-events:\s*none/,
    'the saved range remains a real pointer-driven editing surface',
  );
  assert.doesNotMatch(
    `${savedPodRule}\n${savedActionRule}`,
    /pointer-events:\s*none/,
    'the overlaid pod and its buttons must retain their normal pointer hit behavior',
  );
  assert.doesNotMatch(playRule, /(?:top|inset-block-start):\s*-\d/);
  assert.match(playRule, /top:\s*0/);
  assert.match(playRule, /width:\s*var\(--loop-play-control-size\)/);
  assert.match(css, /\.utility-loop-main\.is-loop-editing\s+\.utility-loop-pitch-control\s*\{[^}]*display:\s*none/s);
  assert.doesNotMatch(css, /\.utility-loop-main\.is-loop-editing\s+\.utility-loop-time\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.utility-loop-pitch-control\s*\{[^}]*border:\s*0/s);
  assert.match(css, /\.utility-loop-pitch-control\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /\.utility-loop-pitch-control\s*\{[^}]*box-shadow:\s*none/s);
  assert.match(css, /\.utility-loop-entry:first-child\s*\{[^}]*padding-top:\s*0/s);
  assert.match(css, /\.utility-loop-group-main\s*\{[^}]*padding-top:\s*0/s);
  assert.match(css, /\.utility-loop-entry:first-child\s+\.utility-loop-shell\s*\{[^}]*padding-top:\s*0/s);
  assert.match(css, /\.utility-loop-entry\s*\{[^}]*padding:\s*11px\s+0/s);
});

function loadLogHistoryBuilderHelpers() {
  const persistedEntries = [];
  const context = {
    state: {
      utility: {
        activeTab: 'log-history',
        logHistory: [],
        logHistoryLoaded: false,
        selectedLogHistoryId: '',
      },
    },
    escapeHtml(value) {
      return String(value ?? '');
    },
    formatLogHistoryTimestamp(value) {
      return String(value || '');
    },
    async persistBrowserLogHistoryEntries(entries) {
      persistedEntries.push(...entries);
      return {
        items: entries.map((entry) => ({
          ...entry,
          source: 'this_browser',
          source_label: 'This browser',
        })),
        status: {
          persistent: true,
          storage: 'indexeddb',
          message: 'Stored in this browser.',
        },
      };
    },
    renderUtilityModalContent() {},
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, persistedEntries };
}

test('log history detail identifies the browser source and exposes explicit export', () => {
  const { context } = loadLogHistoryBuilderHelpers();
  const html = context.buildUtilityLogHistoryDetail({
    id: 'entry-1',
    action: 'Tag edit completed',
    timestamp: '2026-07-24T18:19:20.000Z',
    source: 'this_browser',
    source_label: 'This browser',
    files: [],
  });
  assert.match(html, /This browser/);
  assert.match(html, /data-export-log-history="1"/);
  assert.match(html, />Export Logs</);
});

test('immediate operation events are persisted before updating the visible log history', async () => {
  const { context, persistedEntries } = loadLogHistoryBuilderHelpers();
  const entry = {
    id: 'operation-entry-1',
    action: 'Cover update completed',
    timestamp: '2026-07-24T18:19:20.000Z',
  };
  await context.prependUtilityLogHistoryEntry(entry);
  assert.deepEqual(persistedEntries, [entry]);
  assert.equal(context.state.utility.logHistory.length, 1);
  assert.equal(context.state.utility.logHistory[0].source, 'this_browser');
  assert.equal(context.state.utility.logHistoryStorageStatus.persistent, true);
});
