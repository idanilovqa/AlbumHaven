const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helperPaths = [
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'view-state-helpers.js'),
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'browser-navigation-helpers.js'),
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'view-value-helpers.js'),
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'markup-format-helpers.js'),
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'loader-status-helpers.js'),
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'status-ui-helpers.js'),
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'notification-ui-helpers.js'),
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'render-markup-helpers.js'),
];
const helperSources = helperPaths.map((helperPath) => ({
  path: helperPath,
  source: fs.readFileSync(helperPath, 'utf8'),
}));

function loadHelpers(origin = 'http://localhost:5000') {
  const context = {
    URL,
    URLSearchParams,
    state: {
      view: {},
    },
    window: {
      CSS: null,
      location: {
        origin,
      },
    },
  };
  vm.createContext(context);
  helperSources.forEach(({ path: helperPath, source }) => {
    vm.runInContext(source, context, { filename: helperPath });
  });
  return context;
}

{
  const { escapeHtml } = loadHelpers();
  assert.equal(
    escapeHtml(`A&B "quote" <tag> 'single'`),
    'A&amp;B &quot;quote&quot; &lt;tag&gt; &#39;single&#39;',
  );
}

{
  const { cssEscape } = loadHelpers();
  assert.equal(cssEscape('"album"\\track'), '\\"album\\"\\\\track');
}

{
  const { renderStars } = loadHelpers();
  const html = renderStars(3);
  assert.equal((html.match(/class="star(?: filled)?"/g) || []).length, 10);
  assert.equal((html.match(/class="star filled"/g) || []).length, 3);
  assert.equal((html.match(/class="star"/g) || []).length, 7);
  assert.equal((html.match(/&#9733;/g) || []).length, 3);
  assert.equal((html.match(/&#9734;/g) || []).length, 7);
}

{
  const context = loadHelpers();
  context.state.view = {
    album_count: 2,
    artist_count: 1,
    music_dir: 'C:/Music/<Library>',
    selected_artist: 'Broadcast',
  };
  assert.equal(
    context.formatScanSummary('May 13, 2026'),
    'Found 2 albums by 1 artist in C:/Music/&lt;Library&gt; (family context)<br>Last scan: May 13, 2026',
  );
}

{
  const { buildUrl } = loadHelpers();
  const url = buildUrl({
    query: 'dream pop',
    selected_artist: 'Beach House',
    all_artists_active: true,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'new_arrivals'],
    related_filter_artists: ['Victoria Legrand', '', 'Alex Scally'],
    primary_filter_active: true,
    search_filters: {
      genre: ['Dream Pop', 'Shoegaze'],
      mood: ['Nocturnal'],
      style: ['Lush'],
      duration: {
        min_seconds: 180,
        max_seconds: 420,
      },
    },
  });
  assert.equal(
    url,
    '/?surface=albums&q=dream+pop&artist=Beach+House&all_artists=1&gallery_scope=all&category=main_library&category=new_arrivals&related_artist=Victoria+Legrand&related_artist=Alex+Scally&primary_filter=1&genre=Dream+Pop&genre=Shoegaze&mood=Nocturnal&style=Lush&duration_min=180&duration_max=420',
  );
}

{
  const { buildUrl } = loadHelpers();
  const url = buildUrl({
    query: 'dream pop',
    selected_artist: 'Beach House',
    gallery_scope: 'all',
    visible_library_categories: ['main_library'],
    related_filter_artists: [],
    primary_filter_active: false,
    gallery_display_mode: 'covers',
    gallery_scale_percent: 135,
  });
  assert.equal(
    url,
    '/?surface=albums&q=dream+pop&artist=Beach+House&gallery_scope=all&gallery_display=covers&gallery_scale_percent=135&category=main_library',
  );
}

{
  const { buildApiUrl } = loadHelpers();
  const url = buildApiUrl({
    query: 'shoegaze',
    selected_artist: 'Slowdive',
    all_artists_active: true,
    gallery_scope: 'new_arrivals',
    visible_library_categories: ['new_arrivals'],
    related_filter_artists: ['Rachel Goswell'],
    primary_filter_active: false,
    search_filters: {
      genre: ['Shoegaze'],
      mood: [],
      style: ['Ethereal'],
      duration: {
        min_seconds: 240,
        max_seconds: null,
      },
    },
  });
  assert.equal(
    url,
    '/view-data?surface=albums&q=shoegaze&artist=Slowdive&all_artists=1&gallery_scope=new_arrivals&category=new_arrivals&related_artist=Rachel+Goswell&genre=Shoegaze&style=Ethereal&duration_min=240',
  );
}

{
  const { buildApiUrl } = loadHelpers();
  const url = buildApiUrl({
    selected_artist: 'A.C.T',
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
    gallery_display_mode: 'list',
    gallery_scale_percent: 80,
  });
  assert.equal(
    url,
    '/view-data?surface=albums&artist=A.C.T&gallery_scope=all&gallery_display=list&gallery_scale_percent=80&category=main_library&category=hoard&category=new_arrivals',
  );
}

{
  const { buildApiUrl } = loadHelpers();
  const url = buildApiUrl({
    selected_artist: 'A.C.T',
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
  }, {
    omitSidebar: true,
  });
  assert.equal(
    url,
    '/view-data?surface=albums&artist=A.C.T&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals&omit_sidebar=1',
  );
}

{
  const { buildApiUrl } = loadHelpers();
  const view = {
    selected_artist: 'A.C.T',
    gallery_scope: 'all',
    visible_library_categories: ['main_library'],
    related_filter_artists: [],
    primary_filter_active: false,
  };
  const normalUrl = buildApiUrl(view);
  const rootSidebarUrl = buildApiUrl(view, { rootSidebar: true });
  const sidebarTierUrl = buildApiUrl(
    { ...view, surface: { active: 'albums' }, selected_artist: '' },
    { payloadTier: 'sidebar' },
  );

  assert.equal(new URL(normalUrl, 'http://localhost').searchParams.has('root_sidebar'), false);
  assert.equal(new URL(rootSidebarUrl, 'http://localhost').searchParams.get('root_sidebar'), '1');
  assert.equal(new URL(sidebarTierUrl, 'http://localhost').searchParams.get('payload_tier'), 'sidebar');
  assert.equal(new URL(sidebarTierUrl, 'http://localhost').searchParams.has('artist'), false);
}

{
  const { buildApiUrl } = loadHelpers();
  const url = buildApiUrl({
    selected_artist: 'Mono',
    selected_artist_family_display_mode: 'chronological',
    gallery_scope: 'all',
    visible_library_categories: ['main_library'],
    related_filter_artists: [],
    primary_filter_active: false,
    gallery_display_mode: 'covers',
  });
  assert.equal(
    url,
    '/view-data?surface=albums&artist=Mono&gallery_scope=all&gallery_display=covers&family_display=chronological&category=main_library',
  );
}

{
  const { buildApiUrl } = loadHelpers();
  const url = buildApiUrl({
    surface: { active: 'home' },
    query: '',
    selected_artist: '',
    all_artists_active: false,
  });
  assert.equal(url, '/home-data');
}

{
  const { buildUrl } = loadHelpers();
  const url = buildUrl({
    surface: { active: 'playlists' },
    query: 'road',
    playlist_detail: {
      playlist_id: 'playlist-1',
    },
    search_filters: {
      genre: ['Progressive Rock'],
      mood: [],
      style: [],
      duration: {
        min_seconds: 180,
        max_seconds: null,
      },
    },
  });
  assert.equal(
    url,
    '/?surface=playlists&playlist_id=playlist-1&q=road&genre=Progressive+Rock&duration_min=180',
  );
}

{
  const { buildApiUrl } = loadHelpers();
  const url = buildApiUrl({
    surface: { active: 'playlists' },
    playlist_sidebar: {
      active_playlist_id: 'playlist-2',
    },
    query: 'wind',
  });
  assert.equal(url, '/view-data?surface=playlists&playlist_id=playlist-2&q=wind');
}

{
  const { buildApiUrl } = loadHelpers();
  const url = buildApiUrl({
    surface: { active: 'home' },
    query: 'Ария',
    selected_artist: '',
    all_artists_active: false,
  });
  assert.equal(url, '/view-data?surface=albums&q=%D0%90%D1%80%D0%B8%D1%8F');
}

{
  const { parseUrlStateFromUrl } = loadHelpers('https://albumhaven.test');
  const parsed = JSON.parse(JSON.stringify(
    parseUrlStateFromUrl('/?q=ambient&artist=Eno&all_artists=YeS&related_artist=Harold+Budd&related_artist=Cluster&primary_filter=on', 'https://albumhaven.test'),
  ));
  assert.deepEqual(parsed, {
    surface_request: '',
    playlist_id: '',
    query: 'ambient',
    selected_artist: 'Eno',
    all_artists_active: true,
    gallery_scope: 'all',
    visible_library_categories: [],
    related_filter_artists: ['Harold Budd', 'Cluster'],
    primary_filter_active: true,
    gallery_display_mode: 'cards',
    gallery_scale_percent: 100,
    search_filters: {
      genre: [],
      mood: [],
      style: [],
      duration: {
        min_seconds: null,
        max_seconds: null,
      },
    },
  });
}

{
  const { parseUrlStateFromUrl } = loadHelpers('https://albumhaven.test');
  const parsed = JSON.parse(JSON.stringify(
    parseUrlStateFromUrl(
      '/?artist=Mono&gallery_display=covers&family_display=chronological',
      'https://albumhaven.test',
    ),
  ));
  assert.deepEqual(parsed, {
    surface_request: '',
    playlist_id: '',
    query: '',
    selected_artist: 'Mono',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: [],
    related_filter_artists: [],
    primary_filter_active: false,
    gallery_display_mode: 'covers',
    gallery_scale_percent: 100,
    selected_artist_family_display_mode: 'chronological',
    search_filters: {
      genre: [],
      mood: [],
      style: [],
      duration: {
        min_seconds: null,
        max_seconds: null,
      },
    },
  });
}

{
  const { parseUrlStateFromUrl } = loadHelpers('https://albumhaven.test');
  const parsed = JSON.parse(JSON.stringify(
    parseUrlStateFromUrl(
      '/?q=ambient&genre=Ambient&genre=Post-Rock&mood=Nocturnal&style=Minimal&duration_min=120&duration_max=540',
      'https://albumhaven.test',
    ),
  ));
  assert.deepEqual(parsed, {
    surface_request: '',
    playlist_id: '',
    query: 'ambient',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: [],
    related_filter_artists: [],
    primary_filter_active: false,
    gallery_display_mode: 'cards',
    gallery_scale_percent: 100,
    search_filters: {
      genre: ['Ambient', 'Post-Rock'],
      mood: ['Nocturnal'],
      style: ['Minimal'],
      duration: {
        min_seconds: 120,
        max_seconds: 540,
      },
    },
  });
}

{
  const { parseUrlState } = loadHelpers('https://albumhaven.test');
  const parsed = JSON.parse(JSON.stringify(
    parseUrlState('/?q=ambient&artist=Eno&all_artists=YeS&related_artist=Harold+Budd&related_artist=Cluster&primary_filter=on&gallery_display=covers&gallery_scale_percent=140'),
  ));
  assert.deepEqual(parsed, {
    surface_request: '',
    playlist_id: '',
    query: 'ambient',
    selected_artist: 'Eno',
    all_artists_active: true,
    gallery_scope: 'all',
    visible_library_categories: [],
    related_filter_artists: ['Harold Budd', 'Cluster'],
    primary_filter_active: true,
    gallery_display_mode: 'covers',
    gallery_scale_percent: 140,
    search_filters: {
      genre: [],
      mood: [],
      style: [],
      duration: {
        min_seconds: null,
        max_seconds: null,
      },
    },
  });
}

{
  const { parseBrowserUrlState } = loadHelpers('https://albumhaven.test');
  const parsed = JSON.parse(JSON.stringify(
    parseBrowserUrlState('/?q=dub&artist=Basic+Channel'),
  ));
  assert.deepEqual(parsed, {
    surface_request: '',
    playlist_id: '',
    query: 'dub',
    selected_artist: 'Basic Channel',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: [],
    related_filter_artists: [],
    primary_filter_active: false,
    gallery_display_mode: 'cards',
    gallery_scale_percent: 100,
    search_filters: {
      genre: [],
      mood: [],
      style: [],
      duration: {
        min_seconds: null,
        max_seconds: null,
      },
    },
  });
}

{
  const { parseUrlState } = loadHelpers('https://albumhaven.test');
  assert.equal(
    parseUrlState('/?gallery_scale_percent=0').gallery_scale_percent,
    100,
  );
  assert.equal(
    parseUrlState('/?gallery_scale_percent=-25').gallery_scale_percent,
    100,
  );
}

{
  const { parseUrlState } = loadHelpers();
  const parsed = JSON.parse(JSON.stringify(parseUrlState('/view-data')));
  assert.deepEqual(parsed, {
    surface_request: '',
    playlist_id: '',
    query: '',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: [],
    related_filter_artists: [],
    primary_filter_active: false,
    gallery_display_mode: 'cards',
    gallery_scale_percent: 100,
    search_filters: {
      genre: [],
      mood: [],
      style: [],
      duration: {
        min_seconds: null,
        max_seconds: null,
      },
    },
  });
}

{
  const { isEffectivelyEmptyView } = loadHelpers();
  assert.equal(isEffectivelyEmptyView({
    album_count: 0,
    artists_sidebar: [],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
  }), true);
  assert.equal(isEffectivelyEmptyView({
    album_count: 0,
    artists_sidebar: [{ artist: 'Broadcast' }],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
  }), false);
  assert.equal(isEffectivelyEmptyView({
    album_count: 1,
    artists_sidebar: [{ artist: 'Neal Morse' }],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{}],
    }],
  }), true, 'A heading plus an album shell without a renderable identity is not a usable gallery.');
  assert.equal(isEffectivelyEmptyView({
    album_count: 1,
    artists_sidebar: [{ artist: 'Neal Morse' }],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [],
    }],
  }), true, 'A heading with no album cards is not a usable gallery.');
}

{
  const { shouldOfferBrowseScannedLibraryAction } = loadHelpers();
  assert.equal(shouldOfferBrowseScannedLibraryAction({
    album_count: 0,
    artists_sidebar: [],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
  }, {
    scan_in_progress: true,
    album_total: 101,
  }, false), true);
  assert.equal(shouldOfferBrowseScannedLibraryAction({
    album_count: 1,
    artists_sidebar: [],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
  }, {
    scan_in_progress: true,
    album_total: 101,
  }, false), false);
  assert.equal(shouldOfferBrowseScannedLibraryAction({
    album_count: 0,
    artists_sidebar: [],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
  }, {
    album_total: 100,
  }, true), false);
  assert.equal(shouldOfferBrowseScannedLibraryAction({
    album_count: 0,
    artists_sidebar: [],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
  }, {
    album_total: 101,
  }, true), true);
}

{
  const { shouldRunImmediateStartupHydration } = loadHelpers();
  assert.equal(shouldRunImmediateStartupHydration({
    album_count: 1,
    artists_sidebar: [{ artist: 'Broadcast' }],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
  }, {
    partialView: true,
    scanInProgress: true,
    relationsInProgress: false,
    startupPreview: { mode: 'fresh_preview' },
    startupHydration: { required: true },
  }), true);
  assert.equal(shouldRunImmediateStartupHydration({
    album_count: 1,
    artists_sidebar: [{ artist: 'Broadcast' }],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
  }, {
    partialView: true,
    scanInProgress: false,
    relationsInProgress: true,
    startupPreview: { mode: 'fresh_preview' },
    startupHydration: { required: true },
  }), true);
  assert.equal(shouldRunImmediateStartupHydration({
    album_count: 0,
    artists_sidebar: [],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
  }, {
    partialView: true,
    scanInProgress: true,
    relationsInProgress: false,
    startupPreview: { mode: 'empty_shell' },
    startupHydration: { required: true },
  }), false);
  assert.equal(shouldRunImmediateStartupHydration({
    album_count: 1,
    artists_sidebar: [{ artist: 'Broadcast' }],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
  }, {
    partialView: true,
    scanInProgress: false,
    relationsInProgress: false,
    startupPreview: { mode: 'fresh_preview' },
    startupHydration: { required: true },
  }), true);
}

{
  const { deepCloneJson } = loadHelpers();
  const source = {
    artist: 'Stereolab',
    albums: [{ title: 'Dots and Loops' }],
  };
  const clone = JSON.parse(JSON.stringify(deepCloneJson(source)));
  assert.deepEqual(clone, source);
  assert.notEqual(clone, source);
  clone.albums[0].title = 'Emperor Tomato Ketchup';
  assert.equal(source.albums[0].title, 'Dots and Loops');
  assert.equal(deepCloneJson(undefined), null);
}

{
  const { buildLoaderStatusLines } = loadHelpers();
  const lines = JSON.parse(JSON.stringify(buildLoaderStatusLines({
    scan_in_progress: true,
    scan_total: 57,
    scan_current_path: 'C:/Music/Stereolab/Track 01.flac',
    scan_phase: 'discovering',
  })));
  assert.deepEqual(lines, [
    {
      title: 'Discovering music files',
      detail: '57 files found so far - Track 01.flac',
    },
  ]);
}

{
  const { buildLoaderStatusLines } = loadHelpers();
  const lines = JSON.parse(JSON.stringify(buildLoaderStatusLines({
    scan_in_progress: true,
    scan_processed: 0,
    scan_total: 0,
    relations_in_progress: true,
    relations_phase: 'Preparing Artist Family build',
    relations_processed: 0,
    relations_total: 5328,
    relations_source: 'local',
  })));
  assert.deepEqual(lines, [
    {
      title: 'Preparing library scan',
      detail: 'Discovering music files before progress is available...',
    },
    {
      title: 'Preparing Artist Family build',
      detail: '0 of 5328 artists (local)',
    },
  ]);
}

{
  const { buildLoaderStatusLines } = loadHelpers();
  const lines = JSON.parse(JSON.stringify(buildLoaderStatusLines({
    scan_in_progress: true,
    scan_processed: 4,
    scan_total: 12,
    scan_current_path: 'C:/Music/Stereolab/Track 01.flac',
    scan_elapsed_seconds: 16,
    scan_estimated_remaining_seconds: 32,
    scan_album_folders_processed: 2,
    scan_album_folders_total: 5,
    relations_in_progress: true,
    relations_phase: 'Linking artist families',
    relations_processed: 2,
    relations_total: 5,
    relations_source: 'cache',
    covers_in_progress: true,
    covers_processed: 1,
    covers_total: 3,
    covers_current_folder: 'C:/Music/Stereolab/Dots and Loops',
  })));
  assert.deepEqual(lines, [
    {
      title: 'Scanning music files',
      detail: '4 of 12 files processed - Track 01.flac',
    },
    {
      title: 'Scan timing',
      detail: 'ETA 32s | elapsed 16s | 2 of 5 album folders',
    },
    {
      title: 'Linking artist families',
      detail: '2 of 5 artists (cache)',
    },
    {
      title: 'Updating cover art',
      detail: '1 of 3 folders checked - Dots and Loops',
    },
  ]);
}

{
  const { buildLoaderStatusLines } = loadHelpers();
  const lines = JSON.parse(JSON.stringify(buildLoaderStatusLines({})));
  assert.deepEqual(lines, [
    {
      title: 'Loading library',
      detail: 'Waiting for the first albums to become available...',
    },
  ]);
}

{
  const { buildLoaderStatusLines } = loadHelpers();
  const lines = JSON.parse(JSON.stringify(buildLoaderStatusLines({
    transition_in_progress: true,
    transition_detail: 'Updating the current artist view...',
  })));
  assert.deepEqual(lines, [
    {
      title: 'Loading selection',
      detail: 'Updating the current artist view...',
    },
  ]);
}

{
  const { buildStatusIndicatorTitleParts } = loadHelpers();
  const parts = JSON.parse(JSON.stringify(buildStatusIndicatorTitleParts({
    scan_in_progress: true,
    scan_total: 57,
    scan_current_path: 'C:/Music/Stereolab/Track 01.flac',
    scan_phase: 'discovering',
  })));
  assert.deepEqual(parts, [
    'Discovering music files',
    'Found so far: 57',
    'Current file: C:/Music/Stereolab/Track 01.flac',
  ]);
}

{
  const { buildStatusIndicatorTitleParts } = loadHelpers();
  const parts = JSON.parse(JSON.stringify(buildStatusIndicatorTitleParts({
    scan_in_progress: true,
    scan_processed: 0,
    scan_total: 0,
    relations_in_progress: true,
    relations_phase: 'Preparing Artist Family build',
    relations_processed: 0,
    relations_total: 5328,
    relations_source: 'local',
  })));
  assert.deepEqual(parts, [
    'Preparing library scan',
    'Discovering music files before progress is available',
    'Preparing Artist Family build: 0 / 5328 (local)',
  ]);
}

{
  const { buildStatusIndicatorTitleParts } = loadHelpers();
  const parts = JSON.parse(JSON.stringify(buildStatusIndicatorTitleParts({
    scan_in_progress: true,
    scan_processed: 4,
    scan_total: 12,
    scan_current_path: 'C:/Music/Stereolab/Track 01.flac',
    scan_elapsed_seconds: 16,
    scan_estimated_remaining_seconds: 32,
    scan_album_folders_processed: 2,
    scan_album_folders_total: 5,
    relations_in_progress: true,
    relations_phase: 'Linking artist families',
    relations_processed: 2,
    relations_total: 5,
    relations_source: 'cache',
    covers_in_progress: true,
    covers_processed: 1,
    covers_total: 3,
    covers_downloaded: 1,
    covers_current_folder: 'C:/Music/Stereolab/Dots and Loops',
    album_total: 42,
    last_scan_display: 'May 13, 2026',
  })));
  assert.deepEqual(parts, [
    'Library scan: 4 / 12',
    'Estimated time left: 32s',
    'Elapsed: 16s',
    'Album folders: 2 / 5',
    'Current file: C:/Music/Stereolab/Track 01.flac',
    'Linking artist families: 2 / 5 (cache)',
    'Updating cover art: 1 / 3 covers updated',
    'Downloaded covers: 1',
    'Current album folder: C:/Music/Stereolab/Dots and Loops',
    'Total albums: 42',
    'Last scan: May 13, 2026',
  ]);
}

{
  const { buildStatusIndicatorTitleParts } = loadHelpers();
  const parts = JSON.parse(JSON.stringify(buildStatusIndicatorTitleParts({})));
  assert.deepEqual(parts, ['Library ready']);
}

{
  const { resolvePrimaryStatusContextAction } = loadHelpers();
  assert.deepEqual(JSON.parse(JSON.stringify(resolvePrimaryStatusContextAction({
    scan_in_progress: true,
    scan_mode: 'manual_full_rescan',
  }))), {
    action: 'go-to-scan-page',
    label: 'Go to Scan Page',
    disabled: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(resolvePrimaryStatusContextAction({
    scan_in_progress: true,
    scan_mode: 'background',
  }, {
    scanPageVisible: true,
  }))), {
    action: 'go-to-scan-page',
    label: 'Go to Scan Page',
    disabled: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(resolvePrimaryStatusContextAction({
    scan_in_progress: true,
    scan_mode: 'background',
  }))), {
    action: 'go-to-scan-page',
    label: 'Go to Scan Page',
    disabled: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(resolvePrimaryStatusContextAction({
    covers_in_progress: true,
  }))), {
    action: 'go-to-scan-page',
    label: 'Go to Scan Page',
    disabled: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(resolvePrimaryStatusContextAction({}))), {
    action: 'full-rescan',
    label: 'Full Rescan',
    disabled: false,
  });
}

{
  const context = loadHelpers();
  context.state.status = {
    scan_in_progress: true,
    scan_mode: 'background',
    album_total: 12,
    covers_in_progress: true,
    pending_cover_refresh_after_scan: false,
  };
  const menu = {
    querySelector(selector) {
      if (selector === '[data-status-role="scan-action"]') return this.primaryButton;
      if (selector === '[data-status-role="cover-action"]') return this.coverButton;
      return null;
    },
    primaryButton: {
      attrs: {},
      textContent: '',
      disabled: false,
      mutationCount: 0,
      getAttribute(name) { return this.attrs[name] || null; },
      setAttribute(name, value) { this.attrs[name] = value; this.mutationCount += 1; },
    },
    coverButton: {
      attrs: {},
      textContent: '',
      disabled: true,
      mutationCount: 0,
      getAttribute(name) { return this.attrs[name] || null; },
      setAttribute(name, value) { this.attrs[name] = value; this.mutationCount += 1; },
    },
  };
  context.ensureStatusContextMenu = () => menu;
  context.syncStatusContextMenu();
  assert.equal(menu.primaryButton.textContent, 'Go to Scan Page');
  assert.equal(menu.primaryButton.disabled, false);
  assert.equal(menu.primaryButton.attrs['data-status-action'], 'go-to-scan-page');
  assert.equal(menu.coverButton.textContent, 'Cancel Album Cover Scan');
  assert.equal(menu.coverButton.disabled, false);
  assert.equal(menu.coverButton.attrs['data-status-action'], 'cancel-cover-scan');

  const primaryMutationCount = menu.primaryButton.mutationCount;
  const coverMutationCount = menu.coverButton.mutationCount;
  context.syncStatusContextMenu();
  assert.equal(menu.primaryButton.mutationCount, primaryMutationCount);
  assert.equal(menu.coverButton.mutationCount, coverMutationCount);
}

{
  const context = loadHelpers();
  context.state.status = {
    scan_in_progress: true,
    album_total: 0,
    covers_in_progress: false,
    pending_cover_refresh_after_scan: false,
  };
    const menu = {
      querySelector(selector) {
        if (selector === '[data-status-role="scan-action"]') return this.primaryButton;
        if (selector === '[data-status-role="cover-action"]') return this.coverButton;
        return null;
      },
    primaryButton: {
      attrs: {},
      textContent: '',
      getAttribute(name) { return this.attrs[name] || null; },
      setAttribute(name, value) { this.attrs[name] = value; },
    },
    coverButton: {
      attrs: {},
      textContent: '',
      disabled: false,
      getAttribute(name) { return this.attrs[name] || null; },
      setAttribute(name, value) { this.attrs[name] = value; },
    },
  };
  context.ensureStatusContextMenu = () => menu;
  context.syncStatusContextMenu();
  assert.equal(menu.coverButton.textContent, 'Fetch Album Covers');
  assert.equal(menu.coverButton.disabled, true);
  assert.equal(menu.coverButton.attrs['data-status-action'], 'fetch-covers');
}

{
  const context = loadHelpers();
  context.state.status = {
    scan_in_progress: true,
    album_total: 12,
    covers_in_progress: false,
    pending_cover_refresh_after_scan: true,
  };
    const menu = {
      querySelector(selector) {
        if (selector === '[data-status-role="scan-action"]') return this.primaryButton;
        if (selector === '[data-status-role="cover-action"]') return this.coverButton;
        return null;
      },
    primaryButton: {
      attrs: {},
      textContent: '',
      getAttribute(name) { return this.attrs[name] || null; },
      setAttribute(name, value) { this.attrs[name] = value; },
    },
    coverButton: {
      attrs: {},
      textContent: '',
      disabled: false,
      getAttribute(name) { return this.attrs[name] || null; },
      setAttribute(name, value) { this.attrs[name] = value; },
    },
  };
  context.ensureStatusContextMenu = () => menu;
  context.syncStatusContextMenu();
  assert.equal(menu.coverButton.textContent, 'Fetching Covers Is Queued');
  assert.equal(menu.coverButton.disabled, true);
  assert.equal(menu.coverButton.attrs['data-status-action'], 'fetch-covers-queued');
}

{
  const { buildStatusIndicatorTitleText, freezeStatusIndicatorTitleSnapshot, releaseStatusIndicatorTitleSnapshot, resolveStatusIndicatorTitleText } = loadHelpers();
  const indicator = {
    title: '',
    dataset: {},
    getAttribute(name) {
      if (name === 'title') return this.title;
      return '';
    },
  };
  const firstTitle = buildStatusIndicatorTitleText({
    scan_in_progress: true,
    scan_processed: 4,
    scan_total: 12,
  });
  indicator.title = firstTitle;

  freezeStatusIndicatorTitleSnapshot(indicator);

  const whileHoveredTitle = resolveStatusIndicatorTitleText(indicator, {
    scan_in_progress: true,
    scan_processed: 8,
    scan_total: 12,
    scan_estimated_remaining_seconds: 10,
  });
  assert.equal(whileHoveredTitle, firstTitle);
  assert.equal(indicator.dataset.pendingTitle, 'Library scan: 8 / 12\nEstimated time left: 10s');

  releaseStatusIndicatorTitleSnapshot(indicator);
  assert.equal(indicator.title, 'Library scan: 8 / 12\nEstimated time left: 10s');
}

{
  const { isNotificationErrorVariant } = loadHelpers();
  assert.equal(isNotificationErrorVariant('error'), true);
  assert.equal(isNotificationErrorVariant('success'), false);
}

{
  const { shouldAutoHideNotification } = loadHelpers();
  assert.equal(shouldAutoHideNotification(2000), true);
  assert.equal(shouldAutoHideNotification(0), false);
  assert.equal(shouldAutoHideNotification(Number.NaN), false);
}

{
  const { resolveSidebarArtists } = loadHelpers();
  const artists = JSON.parse(JSON.stringify(resolveSidebarArtists({
    artists_sidebar: [],
    artist_groups: [
      {
        artist: 'Broadcast',
        artist_display: 'Broadcast',
        albums: [{ title: 'Haha Sound' }, { title: 'Tender Buttons' }],
      },
    ],
  }, null)));
  assert.deepEqual(artists, [
    {
      artist: 'Broadcast',
      artist_display: 'Broadcast',
      count: 2,
    },
  ]);
}

{
  const { resolveSidebarArtists } = loadHelpers();
  const artists = JSON.parse(JSON.stringify(resolveSidebarArtists({
    artists_sidebar: [],
    artist_groups: [],
    primary_artist_groups: [
      {
        artist: 'Broadcast',
        artist_display: 'Broadcast',
        albums: [{ title: 'Haha Sound' }, { title: 'Tender Buttons' }],
      },
    ],
  }, null)));
  assert.deepEqual(artists, [
    {
      artist: 'Broadcast',
      artist_display: 'Broadcast',
      count: 2,
    },
  ]);
}

{
  const { buildSidebarStructureSignature } = loadHelpers();
  const sidebarArtists = [
    {
      artist: 'A.C.T',
      artist_display: 'A.C.T',
      count: 7,
    },
    {
      artist: 'Broadcast',
      artist_display: 'Broadcast',
      count: 2,
    },
  ];
  const signatureWithOverride = buildSidebarStructureSignature(sidebarArtists, {
    view: {
      show_all_artists_sidebar_link: true,
    },
    showAllArtistsOverride: true,
  });
  const signatureFromView = buildSidebarStructureSignature(sidebarArtists, {
    view: {
      show_all_artists_sidebar_link: true,
    },
  });
  assert.equal(signatureWithOverride, signatureFromView);
}

{
  const { buildSidebarHtml } = loadHelpers();
  const html = buildSidebarHtml({
    query: 'dream pop',
    selected_artist: 'Beach House',
    show_all_artists_sidebar_link: true,
    all_artists_active: false,
  }, [
    {
      artist: 'Beach House',
      artist_display: 'Beach House',
      count: 8,
    },
  ]);
  assert.match(html, /data-sidebar-all-artists="1"/);
  assert.match(html, /data-sidebar-artist="Beach House"/);
  assert.match(html, /artist-link active/);
  assert.match(html, /\?surface=albums&q=dream\+pop&artist=Beach\+House/);
}

{
  const { buildSidebarHtml } = loadHelpers();
  const html = buildSidebarHtml({
    query: 'dream pop',
    selected_artist: 'Cocteau Twins',
    show_all_artists_sidebar_link: true,
    all_artists_active: false,
  }, [
    {
      artist: 'Beach House',
      artist_display: 'Beach House',
      count: 8,
    },
    {
      artist: 'Cocteau Twins',
      artist_display: 'Cocteau Twins',
      count: 7,
    },
  ], {
    selectedArtistOverride: 'Beach House',
    allArtistsActiveOverride: false,
  });
  assert.match(html, /class="artist-link active" href="\/\?surface=albums&q=dream\+pop&artist=Beach\+House" data-nav="1" data-sidebar-artist="Beach House"/);
  assert.doesNotMatch(html, /class="artist-link active" href="\/\?surface=albums&q=dream\+pop&artist=Cocteau\+Twins" data-nav="1" data-sidebar-artist="Cocteau Twins"/);
}

{
  const { buildSidebarHtml } = loadHelpers();
  const html = buildSidebarHtml({
    query: 'dream pop',
    selected_artist: 'Beach House',
    show_all_artists_sidebar_link: true,
    all_artists_active: false,
  }, [
    {
      artist: 'Beach House',
      artist_display: 'Beach House',
      count: 8,
    },
  ], {
    allArtistsActiveOverride: true,
    selectedArtistOverride: '',
  });
  assert.match(html, /class="artist-link active" href="\/\?surface=albums" data-nav="1" data-sidebar-all-artists="1"/);
}

{
  const { buildSidebarHtml } = loadHelpers();
  const html = buildSidebarHtml({
    query: 'Neal Morse',
    selected_artist: '',
    primary_artist_groups: [{
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      albums: [{ title: 'Testimony' }],
    }],
    show_all_artists_sidebar_link: true,
    all_artists_active: false,
  }, [
    {
      artist: 'Cosmic Cathedral',
      artist_display: 'Cosmic Cathedral',
      count: 1,
    },
    {
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      count: 32,
    },
    {
      artist: 'Neal Morse & The Resonance',
      artist_display: 'Neal Morse & The Resonance',
      count: 1,
    },
  ]);
  assert.match(html, /class="artist-link active" href="\/\?surface=albums&q=Neal\+Morse&artist=Neal\+Morse" data-nav="1" data-sidebar-artist="Neal Morse"/);
  assert.match(html, /data-sidebar-all-artists="1"/);
}

{
  const { buildSidebarHtml } = loadHelpers();
  const html = buildSidebarHtml({
    query: 'Neal Morse',
    selected_artist: 'Neal Morse & The Resonance',
    show_all_artists_sidebar_link: false,
    all_artists_active: false,
  }, [
    {
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      count: 32,
    },
    {
      artist: 'Neal Morse & The Resonance',
      artist_display: 'Neal Morse & The Resonance',
      count: 1,
    },
  ]);
  assert.doesNotMatch(html, /data-sidebar-all-artists="1"/);
  assert.match(html, /data-sidebar-artist="Neal Morse"/);
  assert.match(html, /data-sidebar-artist="Neal Morse &amp; The Resonance"/);
}

{
  const { buildSidebarHtml } = loadHelpers();
  const html = buildSidebarHtml({
    query: 'Morse',
    selected_artist: 'Neal Morse & The Resonance',
    show_all_artists_sidebar_link: true,
    all_artists_active: false,
  }, [
    {
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      count: 32,
    },
    {
      artist: 'Neal Morse & The Resonance',
      artist_display: 'Neal Morse & The Resonance',
      count: 1,
    },
  ], {
    usingSidebarOverride: true,
    showAllArtistsOverride: true,
  });
  assert.match(html, /data-sidebar-all-artists="1"/);
  assert.match(html, /data-sidebar-artist="Neal Morse &amp; The Resonance"/);
  assert.match(html, /data-sidebar-artist="Neal Morse"/);
}

{
  const { buildSidebarHtml } = loadHelpers();
  const html = buildSidebarHtml({
    query: 'devin townsend',
    selected_artist: 'Devin Townsend Project',
    show_all_artists_sidebar_link: false,
    all_artists_active: false,
  }, [
    {
      artist: 'Devin Townsend',
      artist_display: 'Devin Townsend',
      count: 18,
    },
    {
      artist: 'Devin Townsend Project',
      artist_display: 'Devin Townsend Project',
      count: 12,
    },
  ], {
    usingSidebarOverride: true,
    showAllArtistsOverride: true,
    selectedArtistOverride: 'Devin Townsend Project',
  });
  assert.match(html, /data-sidebar-all-artists="1"/);
  assert.match(html, /class="artist-link active" href="\/\?surface=albums&q=devin\+townsend&artist=Devin\+Townsend\+Project" data-nav="1" data-sidebar-artist="Devin Townsend Project"/);
  assert.match(html, /data-sidebar-artist="Devin Townsend"/);
}

{
  const { buildRelatedMarkup } = loadHelpers();
  const html = buildRelatedMarkup({
    selected_artist: 'Stereolab',
    primary_filter_active: true,
    related_filter_artists: ['Laetitia Sadier'],
    related_artists: ['Laetitia Sadier', 'Tim Gane'],
  });
  assert.match(html, /data-related-primary="1"/);
  assert.match(html, /related-chip is-primary active/);
  assert.match(html, /data-related-artist="Laetitia Sadier"/);
  assert.match(html, /related-chip active/);
  assert.match(html, /Tim Gane/);
}

{
  const { buildRelatedMarkup } = loadHelpers();
  const html = buildRelatedMarkup({
    selected_artist: 'Devin Townsend',
    related_artists: ['IR8'],
    related_filter_artists: [],
    artist_family_filters: [{
      family_tag_ref: 'artist-family:ir8',
      display_name: 'IR8',
      variation_names: ['IR8', 'IR8 / Sexoturica'],
      is_selected_artist: false,
    }],
    family_artist_groups: [{
      artist: 'IR8 / Sexoturica',
      artist_display: 'IR8 / Sexoturica',
      family_tag_ref: 'artist-family:ir8sexoturica',
      albums: [{
        name: 'IR8 vs Sexoturica',
        artists: ['IR8', 'Sexoturica', 'IR8 / Sexoturica'],
      }],
    }],
  });
  assert.match(html, /data-related-artist="IR8">IR8 \/ Sexoturica<\/a>/);
  assert.doesNotMatch(html, /data-related-artist="IR8">IR8<\/a>/);
}

{
  const { buildSidebarHtml } = loadHelpers();
  const html = buildSidebarHtml({
    query: 'Scan Artist 00',
    selected_artist: '',
    primary_artist_groups: [{
      artist: 'Scan Artist 001',
      artist_display: 'Scan Artist 001',
      albums: [{ title: 'Album 001' }],
    }],
    show_all_artists_sidebar_link: true,
    all_artists_active: false,
  }, [{
    artist: 'Scan Artist 001',
    artist_display: 'Scan Artist 001',
    count: 10,
  }], {
    allArtistsActiveOverride: false,
    selectedArtistOverride: '',
  });
  assert.equal(html.includes('artist-link active'), false);
}
