const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'response-state-helpers.js');
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelpers() {
  const context = {
    appBootstrap: {
      getInitialView() {
        return {
          artist_groups: [],
          primary_artist_groups: [],
          family_artist_groups: [],
          artists_sidebar: [],
          related_artists: [],
          album_count: 0,
          artist_count: 0,
          query: '',
          search_filters: {
            genre: [],
            mood: [],
            style: [],
            duration: {
              min_seconds: null,
              max_seconds: null,
            },
          },
          search_filter_contract: null,
          search_query_contract: null,
          search_context: null,
          selected_artist: '',
          all_artists_active: false,
        show_all_artists_sidebar_link: true,
        related_filter_artists: [],
        primary_filter_active: false,
        gallery_scope: 'all',
        gallery_display_mode: 'cards',
        gallery_scale_percent: 100,
        visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
        music_dir: '',
        app_name: 'Album Haven',
          app_version: '0.0.0-test',
          ignored_version_keys: [],
          manual_version_links: {},
          non_album_tracks: [],
          non_album_exception_values: [],
          initial_view_partial: false,
        };
      },
      getBootstrap() {
        return {
          refreshed: false,
          lastScanDisplay: '',
          scanInProgress: false,
          relationsInProgress: false,
          coversInProgress: false,
          partialView: false,
          startupPreview: {
            mode: 'empty_shell',
            isPartial: false,
            savedAtEpochMs: 0,
            renderStrategy: 'server_markup',
            renderedGalleryMarkup: false,
          },
          startupTiming: {
            serverRequestStartedAtEpochMs: 0,
            bootstrapPayloadReadyAtEpochMs: 0,
            payloadBuildMs: 0,
          },
          startupPayloadTiers: {
            firstPaint: {
              kind: 'shell_plus_preview',
              targetFirstPaintMs: 500,
              previewMode: 'empty_shell',
              includesGalleryMarkup: false,
            },
            hydration: {
              required: false,
              trigger: 'none',
              endpoint: '/view-data',
              followupEndpoint: '',
              embeddedViewPatch: null,
              tier: 'full',
              reason: 'preview_is_sufficient_for_boot',
            },
          },
          startupHydration: {
            required: false,
            trigger: 'none',
            endpoint: '/view-data',
            followupEndpoint: '',
            embeddedViewPatch: null,
            tier: 'full',
            reason: 'preview_is_sufficient_for_boot',
          },
        };
      },
    },
    state: {
      view: {},
      relatedExpanded: false,
      status: {},
      ui: {
        artistsDrawerOpen: false,
        pendingSidebarRevealArtist: '',
        preSearchView: null,
        searchDraftQuery: '',
      },
      gallery: {
        relatedFilterBaseArtist: '',
        relatedFilterBaseQuery: '',
        relatedFilterBasePrimaryGroups: [],
        relatedFilterBaseFamilyGroups: [],
        mainGalleryVisibleCategories: ['main_library', 'hoard', 'new_arrivals'],
        reusableRootBrowseView: null,
        reusableRootBrowseViewSignature: '',
        reusableSelectedArtistBrowseViews: {},
        reusableSelectedArtistBrowseViewOrder: [],
      },
    },
    rebuildAlbumIndex(groupsList) {
      context.lastRebuiltAlbumGroups = groupsList;
    },
    closeArtistsDrawerCalls: [],
    closeArtistsDrawer(options) {
      context.closeArtistsDrawerCalls.push(options || {});
      context.state.ui.artistsDrawerOpen = false;
    },
    syncArtistsDrawerVisibilityCalls: 0,
    syncArtistsDrawerVisibility() {
      context.syncArtistsDrawerVisibilityCalls += 1;
    },
    isArtistsDrawerMobileViewport() {
      return false;
    },
    lastRebuiltAlbumGroups: null,
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

{
  const { normalizeViewPayload } = loadHelpers();
  const normalized = normalizeViewPayload(
    { query: '', search_context: null },
    {
      query: 'Neal Morse',
      search_context: {
        selected_artist: 'Neal Morse',
        selected_artist_source: 'auto_top_match',
      },
    },
  );
  assert.equal(normalized.search_context, null);
}

{
  const { normalizeViewPayload } = loadHelpers();
  const normalized = JSON.parse(JSON.stringify(normalizeViewPayload({
    artist_groups: [{ artist: 'Broadcast' }],
    query: 123,
    search_filters: {
      genre: ['Post Rock'],
      mood: ['Atmospheric'],
      style: [],
      duration: {
        min_seconds: 180,
        max_seconds: 'bad-value',
      },
    },
    search_filter_contract: {
      shared_surfaces: ['global_search', 'playlist_detail', '', 'album_tops', 'favorite_songs'],
      fields: {
        genre: {
          param: ' genre ',
          value_type: 'string',
          multi_value: 'or',
          supported_result_kinds: ['artists', 'albums', '', 'tracks', 'playlist_rows', 'album_top_items', 'favorite_song_rows'],
        },
        duration: {
          min_param: ' duration_min ',
          max_param: ' duration_max ',
          value_type: 'seconds',
          supported_result_kinds: ['albums', 'tracks', '', 'playlist_rows', 'album_top_items', 'favorite_song_rows'],
          duration_scope_by_result_kind: {
            albums: 'album',
            tracks: 'track',
            playlist_rows: 'track',
            album_top_items: 'album',
            favorite_song_rows: 'track',
          },
        },
      },
    },
    search_query_contract: {
      shared_surfaces: ['global_search', 'playlist_detail', 'album_tops', 'favorite_songs'],
      draft_commit_model: {
        draft_state_owner: 'client',
        committed_state_owner: 'server',
        commit_triggers: ['debounce', '', 'enter'],
        debounce_ms: '150',
        draft_sync_policy: ' preserve_local_draft_until_committed_view_catches_up ',
        empty_query_behavior: ' restore_root_browse ',
        in_flight_request_policy: ' interrupt_previous_search_commit ',
      },
      grammar: {
        supports_cross_field_and: 1,
        supports_same_field_or: 1,
        supports_negation: 1,
        supports_quoted_values: 1,
        supports_comparison_operators: 1,
        supports_fuzzy_commit_matching: 1,
        shortcut_tokens: [
          {
            token: ' :loved ',
            expands_to: {
              field: ' love ',
              value: ' loved ',
            },
            availability: ' authorized_private_track_search ',
          },
        ],
        field_terms: {
          genre: {
            value_type: ' string ',
            supports_quotes: 1,
            supports_fuzzy_commit: 1,
            supports_structured_suggestions: 1,
            availability: ' shared ',
          },
          persons: {
            value_type: ' csv_string ',
            match_mode: ' all_of ',
            supports_fuzzy_commit: 1,
            availability: ' local_library_only ',
          },
        },
      },
      structured_suggestions: {
        value_fields: ['genre', '', 'mood', 'style'],
        fuzzy_commit_without_exact_suggestion: 1,
      },
      committed_matching: {
        priority_order: ['exact', '', 'alias', 'phrase', 'prefix', 'distributed', 'fuzzy'],
        numeric_terms_are_near_exact: 1,
      },
    },
    search_context: {
      transport: 'view_data',
      response_kind: 'legacy_artist_gallery',
      committed_query: '123',
      result_surface: {
        kind: ' grouped_artist_results ',
        group_order: ['direct_matches', '', 'related_matches', 'direct_matches'],
        default_selection_behavior: ' explicit_result_selection ',
      },
      result_groups: {
        direct_matches: ['Broadcast', '', 'Broadcast'],
        related_matches: ['Stereolab', ''],
      },
      search_filters: {
        genre: ['Post Rock'],
        mood: ['Atmospheric'],
        style: [],
        duration: {
          min_seconds: 180,
          max_seconds: null,
        },
      },
      selected_artist: 'Broadcast',
      selected_artist_source: 'auto_top_match',
      direct_match_artists: ['Broadcast'],
      related_match_artists: [],
    },
    selected_artist: 'Broadcast',
    album_count: '4',
    related_filter_artists: ['Trish Keenan', null],
    playback_context: {
      kind: ' artist_page ',
      end_behavior: ' stop ',
      ordered_album_refs: [' broadcast-tender-buttons ', '', 'broadcast-lol'],
      albums: [
        { album_ref: ' broadcast-tender-buttons ', can_play: 1 },
        { album_ref: 'broadcast-lol', can_play: 0 },
        null,
      ],
    },
    gallery_display_mode: 'covers',
    gallery_scale_percent: 135,
    manual_version_links: null,
    initial_view_partial: 1,
  })));
  assert.deepEqual(normalized, {
    artist_groups: [{ artist: 'Broadcast' }],
    primary_artist_groups: [],
    family_artist_groups: [],
    artists_sidebar: [],
    related_artists: [],
    album_count: 4,
    artist_count: 0,
    query: '123',
    playback_context: {
      kind: 'artist_page',
      end_behavior: 'stop',
      ordered_album_refs: ['broadcast-tender-buttons', 'broadcast-lol'],
      albums: [
        { album_ref: 'broadcast-tender-buttons', can_play: true },
        { album_ref: 'broadcast-lol', can_play: false },
      ],
    },
    search_filters: {
      genre: ['Post Rock'],
      mood: ['Atmospheric'],
      style: [],
      duration: {
        min_seconds: 180,
        max_seconds: null,
      },
    },
    search_filter_contract: {
      shared_surfaces: ['global_search', 'playlist_detail', 'album_tops', 'favorite_songs'],
      fields: {
        genre: {
          param: 'genre',
          value_type: 'string',
          multi_value: 'or',
          supported_result_kinds: ['artists', 'albums', 'tracks', 'playlist_rows', 'album_top_items', 'favorite_song_rows'],
        },
        duration: {
          min_param: 'duration_min',
          max_param: 'duration_max',
          value_type: 'seconds',
          supported_result_kinds: ['albums', 'tracks', 'playlist_rows', 'album_top_items', 'favorite_song_rows'],
          duration_scope_by_result_kind: {
            albums: 'album',
            tracks: 'track',
            playlist_rows: 'track',
            album_top_items: 'album',
            favorite_song_rows: 'track',
          },
        },
      },
    },
    search_query_contract: {
      shared_surfaces: ['global_search', 'playlist_detail', 'album_tops', 'favorite_songs'],
      draft_commit_model: {
        draft_state_owner: 'client',
        committed_state_owner: 'server',
        commit_triggers: ['debounce', 'enter'],
        debounce_ms: 150,
        draft_sync_policy: 'preserve_local_draft_until_committed_view_catches_up',
        empty_query_behavior: 'restore_root_browse',
        in_flight_request_policy: 'interrupt_previous_search_commit',
      },
      grammar: {
        supports_cross_field_and: true,
        supports_same_field_or: true,
        supports_negation: true,
        supports_quoted_values: true,
        supports_comparison_operators: true,
        supports_fuzzy_commit_matching: true,
        shortcut_tokens: [
          {
            token: ':loved',
            expands_to: {
              field: 'love',
              value: 'loved',
            },
            availability: 'authorized_private_track_search',
          },
        ],
        field_terms: {
          genre: {
            value_type: 'string',
            supports_quotes: true,
            supports_fuzzy_commit: true,
            supports_structured_suggestions: true,
            availability: 'shared',
          },
          persons: {
            value_type: 'csv_string',
            match_mode: 'all_of',
            supports_fuzzy_commit: true,
            availability: 'local_library_only',
          },
        },
      },
      structured_suggestions: {
        value_fields: ['genre', 'mood', 'style'],
        fuzzy_commit_without_exact_suggestion: true,
      },
      committed_matching: {
        priority_order: ['exact', 'alias', 'phrase', 'prefix', 'distributed', 'fuzzy'],
        numeric_terms_are_near_exact: true,
      },
    },
    search_context: {
      transport: 'view_data',
      response_kind: 'legacy_artist_gallery',
      committed_query: '123',
      result_surface: {
        kind: 'grouped_artist_results',
        group_order: ['direct_matches', 'related_matches'],
        default_selection_behavior: 'explicit_result_selection',
      },
      result_groups: {
        direct_matches: ['Broadcast'],
        related_matches: ['Stereolab'],
      },
      search_filters: {
        genre: ['Post Rock'],
        mood: ['Atmospheric'],
        style: [],
        duration: {
          min_seconds: 180,
          max_seconds: null,
        },
      },
      selected_artist: 'Broadcast',
      selected_artist_source: 'auto_top_match',
      direct_match_artists: ['Broadcast'],
      related_match_artists: [],
    },
    selected_artist: 'Broadcast',
    all_artists_active: false,
    show_all_artists_sidebar_link: true,
    related_filter_artists: ['Trish Keenan', ''],
    primary_filter_active: false,
    gallery_scope: 'all',
    gallery_display_mode: 'covers',
    gallery_scale_percent: 135,
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    music_dir: '',
    app_name: 'Album Haven',
    app_version: '0.0.0-test',
    ignored_version_keys: [],
    manual_version_links: {},
    non_album_tracks: [],
    non_album_exception_values: [],
    initial_view_partial: true,
  });
}

{
  const { applyViewPayload, state } = loadHelpers();
  applyViewPayload({
    selected_artist: 'Broadcast',
    gallery_display_mode: 'list',
    gallery_scale_percent: 80,
  });
  assert.equal(state.view.selected_artist, 'Broadcast');
  assert.equal(state.view.gallery_display_mode, 'list');
  assert.equal(state.view.gallery_scale_percent, 80);
}

{
  const { applyViewPayload, state } = loadHelpers();
  state.view = {
    ...state.view,
    payload_tier: 'sidebar',
    initial_view_partial: true,
  };

  applyViewPayload({
    payload_tier: 'full',
    selected_artist: 'Control Signal Lead',
    related_artists: [
      'Control Signal Lead / Control Signal Partner',
      'Control Signal Partner',
    ],
    primary_artist_groups: [{
      artist: 'Control Signal Lead',
      albums: [{ key: 'control-lead-solo' }],
    }],
    family_artist_groups: [{
      artist: 'Control Signal Partner',
      albums: [{ key: 'control-partner-solo', preview_only: true }],
    }, {
      artist: 'Control Signal Lead / Control Signal Partner',
      albums: [{ key: 'control-cross-credit', preview_only: true }],
    }],
  });

  assert.equal(
    state.view.initial_view_partial,
    false,
    'a full hydration response must clear partial startup authority even when it omits the legacy flag',
  );
}

{
  const { normalizeStatusPayload } = loadHelpers();
  const normalized = JSON.parse(JSON.stringify(normalizeStatusPayload({
    scan_in_progress: 1,
    scan_processed: '7',
    scan_elapsed_seconds: '18.5',
    scan_estimated_remaining_seconds: '42',
    scan_album_folders_processed: '3',
    scan_album_folders_total: '8',
    scan_mode: 'manual_full_rescan',
    relations_phase: null,
    covers_current_folder: 42,
    album_total: '9',
  })));
  assert.deepEqual(normalized, {
    scan_in_progress: true,
    scan_processed: 7,
    scan_total: 0,
    scan_percent: 0,
    scan_current_path: '',
    scan_elapsed_seconds: 18.5,
    scan_estimated_remaining_seconds: 42,
    scan_files_per_second: 0,
    scan_album_folders_processed: 3,
    scan_album_folders_total: 8,
    scan_phase: 'idle',
    scan_mode: 'manual_full_rescan',
    relations_in_progress: false,
    relations_processed: 0,
    relations_total: 0,
    relations_percent: 0,
    relations_phase: 'Idle',
    relations_source: 'local',
    covers_in_progress: false,
    covers_processed: 0,
    covers_total: 0,
    covers_downloaded: 0,
    covers_current_folder: '42',
    pending_cover_refresh_after_scan: false,
    last_scan_display: '',
    last_error: '',
    album_total: 9,
  });
}

{
  const { normalizeBootstrapRuntimeStatePayload } = loadHelpers();
  const normalized = JSON.parse(JSON.stringify(normalizeBootstrapRuntimeStatePayload({
    initial_view: {
      selected_artist: 'Stereolab',
      album_count: 12,
    },
    bootstrap: {
      refreshed: 'yes',
      lastScanDisplay: 'May 14, 2026',
      scanInProgress: 1,
      scanMode: 'manual_full_rescan',
      startupPreview: {
        mode: 'fresh_preview',
        isPartial: 1,
        savedAtEpochMs: '44',
        renderedGalleryMarkup: 1,
      },
      startupTiming: {
        serverRequestStartedAtEpochMs: '10',
        bootstrapPayloadReadyAtEpochMs: '22',
        payloadBuildMs: '3.5',
      },
      startupPayloadTiers: {
        firstPaint: {
          kind: 'shell_plus_preview',
          targetFirstPaintMs: '500',
          previewMode: 'fresh_preview',
          includesGalleryMarkup: 1,
        },
        hydration: {
          required: 1,
          trigger: 'after_runtime_boot',
          endpoint: '/view-data?payload_tier=sidebar',
          followupEndpoint: '/view-data',
          embeddedViewPatch: {
            artists_sidebar: [{ artist: 'Stereolab', count: 12 }],
            payload_tier: 'sidebar',
          },
          tier: 'sidebar',
          reason: 'preview_requires_sidebar_then_full_view_fetch',
        },
      },
    },
  })));
  assert.deepEqual(normalized, {
    view: {
      artist_groups: [],
      primary_artist_groups: [],
      family_artist_groups: [],
      artists_sidebar: [],
      related_artists: [],
      album_count: 12,
      artist_count: 0,
      query: '',
      search_filters: {
        genre: [],
        mood: [],
        style: [],
        duration: {
          min_seconds: null,
          max_seconds: null,
        },
      },
      search_filter_contract: null,
      search_query_contract: null,
      search_context: null,
      selected_artist: 'Stereolab',
      all_artists_active: false,
      show_all_artists_sidebar_link: true,
      related_filter_artists: [],
      primary_filter_active: false,
      gallery_scope: 'all',
      gallery_display_mode: 'cards',
      gallery_scale_percent: 100,
      visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
      music_dir: '',
      app_name: 'Album Haven',
      app_version: '0.0.0-test',
      ignored_version_keys: [],
      manual_version_links: {},
      non_album_tracks: [],
      non_album_exception_values: [],
      initial_view_partial: false,
    },
    bootstrap: {
      refreshed: true,
      lastScanDisplay: 'May 14, 2026',
      scanInProgress: true,
      scanMode: 'manual_full_rescan',
      relationsInProgress: false,
      coversInProgress: false,
      partialView: false,
      startupPreview: {
        mode: 'fresh_preview',
        isPartial: true,
        savedAtEpochMs: 44,
        renderStrategy: 'server_markup',
        renderedGalleryMarkup: true,
      },
      startupTiming: {
        serverRequestStartedAtEpochMs: 10,
        bootstrapPayloadReadyAtEpochMs: 22,
        payloadBuildMs: 3.5,
      },
      startupPayloadTiers: {
        firstPaint: {
          kind: 'shell_plus_preview',
          targetFirstPaintMs: 500,
          previewMode: 'fresh_preview',
          includesGalleryMarkup: true,
        },
        hydration: {
          required: true,
          trigger: 'after_runtime_boot',
          endpoint: '/view-data?payload_tier=sidebar',
          followupEndpoint: '/view-data',
          embeddedViewPatch: {
            artists_sidebar: [{ artist: 'Stereolab', count: 12 }],
            payload_tier: 'sidebar',
          },
          tier: 'sidebar',
          reason: 'preview_requires_sidebar_then_full_view_fetch',
        },
      },
      startupHydration: {
        required: true,
        trigger: 'after_runtime_boot',
        endpoint: '/view-data?payload_tier=sidebar',
        followupEndpoint: '/view-data',
        embeddedViewPatch: {
          artists_sidebar: [{ artist: 'Stereolab', count: 12 }],
          payload_tier: 'sidebar',
        },
        tier: 'sidebar',
        reason: 'preview_requires_sidebar_then_full_view_fetch',
      },
    },
  });
}

{
  const { normalizeBootstrapRuntimeStatePayload } = loadHelpers();
  const normalized = JSON.parse(JSON.stringify(normalizeBootstrapRuntimeStatePayload({
    initial_view: null,
    bootstrap: {
      coversInProgress: 1,
    },
  })));
  assert.equal(normalized.view.app_name, 'Album Haven');
  assert.equal(normalized.view.app_version, '0.0.0-test');
  assert.deepEqual(normalized.view.artist_groups, []);
  assert.equal(normalized.bootstrap.refreshed, false);
  assert.equal(normalized.bootstrap.coversInProgress, true);
}

{
  const context = loadHelpers();
  const sourceTracks = [
    { path: 'C:\\Music\\Artist\\Album\\Disc 1\\01 - Intro.flac', title: 'Intro' },
    { path: 'C:\\Music\\Artist\\Album\\Disc 1\\02 - Song.flac', title: 'Song' },
  ];
  const nextView = context.applyViewPayload({
    selected_artist: '',
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{
        key: 'broadcast-tender-buttons',
        name: 'Tender Buttons',
        album_artist: 'Broadcast',
        tracks: sourceTracks,
        move_availability: {
          available_actions: [],
          actions: {},
        },
        duplicate_sources: [{ path: 'C:\\Music\\Artist\\Album Duplicate\\01 - Intro.flac' }],
      }],
    }],
  }, { trackSidebarReveal: false });
  const compactAlbum = nextView.artist_groups[0].albums[0];
  assert.equal(compactAlbum.preview_only, true);
  assert.equal(compactAlbum.track_count_preview, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(compactAlbum.tracks)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(compactAlbum.duplicate_sources)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(compactAlbum.open_directory_paths)), ['C:\\Music\\Artist\\Album\\Disc 1']);
  assert.equal(compactAlbum.move_availability, undefined);
  assert.equal(sourceTracks.length, 2);
}

{
  const context = loadHelpers();
  const nextView = context.applyViewPayload({
    selected_artist: '',
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{
        key: 'broadcast-tender-buttons',
        name: 'Tender Buttons',
        album_artist: 'Broadcast',
        tracks: [{ path: 'C:\\Music\\Artist\\Album\\01 - I Found the F.flac', title: 'I Found the F' }],
        album_display_metadata: {
          display_country: { value: 'UK', source: 'tag' },
        },
        remote_cover_source_label: 'Discogs',
        move_availability: {
          available_actions: ['move_to_hoard', 'move_to_library'],
          actions: {
            move_to_hoard: {
              available: true,
              target_category: 'hoard',
              destination_folder_name: 'Tender Buttons',
              destination_path: 'X:\\SyntheticMusic\\Hoard\\Broadcast\\Tender Buttons',
              blocked_reasons: ['unused'],
            },
            move_to_library: {
              available: false,
              target_category: 'main_library',
              destination_folder_name: 'Tender Buttons',
              destination_path: 'X:\\SyntheticMusic\\Library\\Broadcast\\Tender Buttons',
              blocked_reasons: ['already there'],
            },
          },
        },
      }],
    }],
  }, { trackSidebarReveal: false });
  const compactAlbum = nextView.artist_groups[0].albums[0];
  assert.equal(compactAlbum.album_display_metadata, undefined);
  assert.equal(compactAlbum.remote_cover_source_label, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(compactAlbum.move_availability)), {
    available_actions: ['move_to_hoard', 'move_to_library'],
    actions: {
      move_to_hoard: {
        available: true,
        target_category: 'hoard',
        destination_folder_name: 'Tender Buttons',
      },
      move_to_library: {
        available: false,
        target_category: 'main_library',
        destination_folder_name: 'Tender Buttons',
      },
    },
  });
}

{
  const context = loadHelpers();
  const nextView = context.applyViewPayload({
    selected_artist: 'Broadcast',
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{
        key: 'broadcast-tender-buttons',
        name: 'Tender Buttons',
        album_artist: 'Broadcast',
        tracks: [{ path: 'C:\\Music\\Artist\\Album\\01 - I Found the F.flac', title: 'I Found the F' }],
      }],
    }],
  }, { trackSidebarReveal: false });
  assert.equal(nextView.artist_groups[0].albums[0].preview_only, undefined);
  assert.equal(nextView.artist_groups[0].albums[0].tracks.length, 1);
}

{
  const context = loadHelpers();
  context.state.view = {
    selected_artist: 'Broadcast',
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{
        key: 'broadcast-tender-buttons',
        name: 'Tender Buttons',
        album_artist: 'Broadcast',
        tracks: [{ path: 'C:\\Music\\Artist\\Album\\01 - I Found the F.flac', title: 'I Found the F' }],
      }],
    }],
    primary_artist_groups: [],
    family_artist_groups: [],
  };
  const compacted = context.compactCurrentViewForIdle();
  assert.equal(compacted.artist_groups[0].albums[0].preview_only, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(compacted.artist_groups[0].albums[0].tracks)), [{
    path: 'C:\\Music\\Artist\\Album\\01 - I Found the F.flac',
    title: 'I Found the F',
  }]);
  assert.ok(Array.isArray(context.lastRebuiltAlbumGroups));
}

{
  const context = loadHelpers();
  context.state.view = {
    selected_artist: 'Broadcast',
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{
        key: 'broadcast-tender-buttons',
        name: 'Tender Buttons',
        album_artist: 'Broadcast',
        tracks: [{ path: 'C:\\Music\\Artist\\Album\\01 - I Found the F.flac', title: 'I Found the F' }],
      }],
    }, {
      artist: 'Trish Keenan',
      albums: [{
        key: 'trish-keenan-example',
        name: 'Example',
        album_artist: 'Trish Keenan',
        tracks: [{ path: 'C:\\Music\\Artist\\Example\\01 - Example.flac', title: 'Example' }],
      }],
    }],
    primary_artist_groups: [{
      artist: 'Broadcast',
      albums: [{
        key: 'broadcast-tender-buttons',
        name: 'Tender Buttons',
        album_artist: 'Broadcast',
        tracks: [{ path: 'C:\\Music\\Artist\\Album\\01 - I Found the F.flac', title: 'I Found the F' }],
      }],
    }],
    family_artist_groups: [{
      artist: 'Trish Keenan',
      albums: [{
        key: 'trish-keenan-example',
        name: 'Example',
        album_artist: 'Trish Keenan',
        tracks: [{ path: 'C:\\Music\\Artist\\Example\\01 - Example.flac', title: 'Example' }],
      }],
    }],
  };

  const compacted = context.compactCurrentViewForIdle();

  assert.equal(compacted.primary_artist_groups[0].albums[0].preview_only, undefined);
  assert.equal(compacted.family_artist_groups[0].albums[0].preview_only, undefined);
  assert.equal(context.lastRebuiltAlbumGroups[0].albums[0].tracks.length, 1);
  assert.equal(context.lastRebuiltAlbumGroups[1].albums[0].tracks.length, 1);
}

{
  const context = loadHelpers();
  context.state.view = {
    query: 'dream pop',
    selected_artist: 'Beach House',
  };
  const nextView = JSON.parse(JSON.stringify(context.applyViewPayload({
    query: '',
    selected_artist: 'Beach House',
    album_count: 8,
  })));
  assert.equal(context.state.ui.pendingSidebarRevealArtist, 'Beach House');
  assert.equal(context.state.ui.preSearchView, null);
  assert.equal(nextView.query, '');
  assert.equal(nextView.selected_artist, 'Beach House');
  assert.equal(nextView.album_count, 8);
}

{
  const context = loadHelpers();
  context.state.view = {
    query: 'Broadcast',
    selected_artist: 'Broadcast',
  };
  context.state.ui.searchDraftQuery = 'Broad';

  context.applyViewPayload({
    query: 'Broadcast',
    selected_artist: 'Broadcast',
    album_count: 2,
  }, { trackSidebarReveal: false });

  assert.equal(context.state.ui.searchDraftQuery, 'Broad');
}

{
  const context = loadHelpers();
  context.state.view = {
    query: 'Broadcast',
    selected_artist: 'Broadcast',
  };
  context.state.ui.searchDraftQuery = 'Neal Morse';

  context.applyViewPayload({
    query: 'Neal Morse',
    selected_artist: '',
    album_count: 4,
  }, { trackSidebarReveal: false });

  assert.equal(context.state.ui.searchDraftQuery, 'Neal Morse');
}

{
  const context = loadHelpers();
  const rootView = JSON.parse(JSON.stringify(context.applyViewPayload({
    surface: { active: 'albums' },
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{
        key: 'broadcast-tender-buttons',
        name: 'Tender Buttons',
        album_artist: 'Broadcast',
        tracks: [{ path: 'C:\\Music\\Broadcast\\Tender Buttons\\01 - I Found the F.flac' }],
      }],
    }],
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    album_count: 1,
    artist_count: 1,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'new_arrivals'],
    all_artists_active: false,
  })));
  assert.equal(context.state.gallery.reusableRootBrowseView, null);
  const currentRootView = JSON.parse(JSON.stringify(context.getReusableRootBrowseView({
    surface: { active: 'albums' },
    query: '',
    selected_artist: '',
    all_artists_active: true,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'new_arrivals'],
  })));
  assert.deepEqual(currentRootView, rootView);

  context.applyViewPayload({
    selected_artist: 'Broadcast',
    artist_groups: [{ artist: 'Broadcast' }],
    primary_artist_groups: [{ artist: 'Broadcast' }],
  }, { trackSidebarReveal: false });

  const cachedRootView = JSON.parse(JSON.stringify(context.state.gallery.reusableRootBrowseView));
  assert.deepEqual(cachedRootView, rootView);

  const restored = JSON.parse(JSON.stringify(context.getReusableRootBrowseView({
    surface: { active: 'albums' },
    query: '',
    selected_artist: '',
    all_artists_active: true,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'new_arrivals'],
  })));
  assert.deepEqual(restored, cachedRootView);

  const restoredAfterArtistSelection = JSON.parse(JSON.stringify(context.getReusableRootBrowseView({
    surface: { active: 'albums' },
    query: '',
    selected_artist: '',
    all_artists_active: true,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'new_arrivals'],
  })));
  assert.deepEqual(restoredAfterArtistSelection, cachedRootView);
}

{
  const context = loadHelpers();
  const retainedScanPageRootView = {
    surface: { active: 'albums' },
    query: '',
    selected_artist: '',
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{
        key: 'broadcast-tender-buttons',
        name: 'Tender Buttons',
        album_artist: 'Broadcast',
      }],
    }],
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    album_count: 1,
    artist_count: 1,
    gallery_scope: 'all',
  };
  context.state.view = {
    surface: { active: 'albums' },
    query: '',
    selected_artist: '',
    artist_groups: [],
    artists_sidebar: [],
    album_count: 0,
    artist_count: 0,
    gallery_scope: 'all',
  };
  context.state.gallery.reusableRootBrowseView = null;
  context.state.gallery.reusableRootBrowseViewSignature = '';

  const restored = context.getReusableRootBrowseView({
    surface: { active: 'albums' },
    query: '',
    selected_artist: '',
    gallery_scope: 'all',
  }, [retainedScanPageRootView]);

  assert.equal(
    restored?.artist_groups?.[0]?.albums?.[0]?.key,
    'broadcast-tender-buttons',
    'Scan Page Browse should reuse its retained root gallery when current and cached root views are empty',
  );
}

{
  const context = loadHelpers();
  context.applyViewPayload({
    surface: { active: 'albums' },
    artist_groups: [{
      artist: 'Mono',
      albums: [{
        key: 'mono-1',
        name: 'Hymn to the Immortal Wind',
        album_artist: 'Mono',
        preview_only: true,
        album_preference: {
          rating: null,
          favorite_override: null,
          is_favorite: false,
          favorite_source: null,
          can_edit: false,
          to_listen: false,
          is_relisten: false,
          can_toggle_to_listen: false,
        },
        tag_album_rating: 9,
        tag_album_rating_source: 'file_tag',
        tracks: [{ path: 'C:\\Music\\Mono\\Hymn\\01 - Ashes in the Snow.flac' }],
      }],
    }],
    artists_sidebar: [{ artist: 'Mono', count: 1 }],
    album_count: 1,
    artist_count: 1,
    gallery_scope: 'all',
    visible_library_categories: ['main_library'],
    all_artists_active: false,
  }, { trackSidebarReveal: false });

  context.applyViewPayload({
    selected_artist: 'Mono',
    artist_groups: [{ artist: 'Mono' }],
    primary_artist_groups: [{ artist: 'Mono' }],
  }, { trackSidebarReveal: false });

  const cachedAlbum = context.state.gallery.reusableRootBrowseView.artist_groups[0].albums[0];
  assert.deepEqual(JSON.parse(JSON.stringify(cachedAlbum.album_preference)), { rating: null });
  assert.equal(cachedAlbum.tag_album_rating, 9);
  assert.equal(cachedAlbum.tag_album_rating_source, 'file_tag');
  assert.equal(Object.prototype.hasOwnProperty.call(cachedAlbum, 'gallery_list_block'), false);

  const restored = context.getReusableRootBrowseView({
    surface: { active: 'albums' },
    query: '',
    selected_artist: '',
    all_artists_active: true,
    gallery_scope: 'all',
    visible_library_categories: ['main_library'],
  });
  const restoredAlbum = restored.artist_groups[0].albums[0];
  assert.deepEqual(JSON.parse(JSON.stringify(restoredAlbum.album_preference)), { rating: null });
  assert.equal(restoredAlbum.tag_album_rating, 9);
  assert.equal(restoredAlbum.tag_album_rating_source, 'file_tag');
  assert.equal(Object.prototype.hasOwnProperty.call(restoredAlbum, 'gallery_list_block'), false);
}

{
  const context = loadHelpers();
  context.state.gallery.reusableRootBrowseView = {
    surface: { active: 'albums' },
    query: '',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    artist_groups: [{ artist: 'Broadcast' }],
  };
  context.state.gallery.reusableRootBrowseViewSignature = JSON.stringify({
    query: '',
    selected_artist: '',
    all_artists_active: true,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    related_filter_artists: [],
    primary_filter_active: false,
  });

  context.applyViewPayload({
    surface: { active: 'albums' },
    query: '',
    selected_artist: '',
    all_artists_active: true,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    artist_groups: [{ artist: 'Broadcast' }],
  }, { trackSidebarReveal: false });

  assert.equal(context.state.gallery.reusableRootBrowseView, null);
  assert.equal(context.state.gallery.reusableRootBrowseViewSignature, '');
}

{
  const context = loadHelpers();
  context.applyViewPayload({
    surface: { active: 'home' },
    query: '',
    selected_artist: '',
    all_artists_active: false,
    artist_groups: [],
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    album_count: 1,
    artist_count: 1,
  }, { trackSidebarReveal: false });

  context.applyViewPayload({
    surface: { active: 'albums' },
    selected_artist: 'Broadcast',
    artist_groups: [{ artist: 'Broadcast' }],
    primary_artist_groups: [{ artist: 'Broadcast' }],
  }, { trackSidebarReveal: false });

  assert.equal(context.state.gallery.reusableRootBrowseView, null);
  assert.equal(context.getReusableRootBrowseView({
    surface: { active: 'home' },
    query: '',
    selected_artist: '',
    all_artists_active: false,
  }), null);
}

{
  const context = loadHelpers();
  const selectedArtistView = JSON.parse(JSON.stringify(context.applyViewPayload({
    surface: { active: 'albums' },
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard'],
    related_filter_artists: [],
    primary_filter_active: false,
    primary_artist_groups: [{
      artist: 'Neal Morse',
      albums: [{
        key: 'neal-morse-one',
        name: 'One',
        album_artist: 'Neal Morse',
        tracks: [{ path: 'C:\\Music\\Neal Morse\\One\\01 - The Creation.flac' }],
      }],
    }],
    family_artist_groups: [{
      artist: 'Cosmic Cathedral',
      albums: [{
        key: 'cosmic-cathedral-deep-water',
        name: 'Deep Water',
        album_artist: 'Cosmic Cathedral',
        tracks: [{ path: 'C:\\Music\\Cosmic Cathedral\\Deep Water\\01 - Deep Water Suite.flac' }],
      }],
    }],
    artist_groups: [{
      artist: 'Neal Morse',
      albums: [{
        key: 'neal-morse-one',
        name: 'One',
        album_artist: 'Neal Morse',
        tracks: [{ path: 'C:\\Music\\Neal Morse\\One\\01 - The Creation.flac' }],
      }],
    }, {
      artist: 'Cosmic Cathedral',
      albums: [{
        key: 'cosmic-cathedral-deep-water',
        name: 'Deep Water',
        album_artist: 'Cosmic Cathedral',
        tracks: [{ path: 'C:\\Music\\Cosmic Cathedral\\Deep Water\\01 - Deep Water Suite.flac' }],
      }],
    }],
  }, { trackSidebarReveal: false })));

  const cacheKeys = Object.keys(context.state.gallery.reusableSelectedArtistBrowseViews);
  assert.equal(cacheKeys.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.gallery.reusableSelectedArtistBrowseViewOrder)), cacheKeys);

  const restored = JSON.parse(JSON.stringify(context.getReusableSelectedArtistBrowseView({
    surface: { active: 'albums' },
    query: 'Neal Morse',
    selected_artist: 'Neal Morse',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard'],
    related_filter_artists: [],
    primary_filter_active: false,
  })));
  assert.deepEqual(restored, selectedArtistView);
  assert.equal(restored.primary_artist_groups[0].albums[0].preview_only, undefined);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.getReusableSelectedArtistBrowseView({
      surface: { active: 'albums' },
      query: 'Cosmic Cathedral',
      selected_artist: 'Neal Morse',
      all_artists_active: false,
      gallery_scope: 'all',
      visible_library_categories: ['main_library', 'hoard'],
      related_filter_artists: [],
      primary_filter_active: false,
    }))),
    null,
  );
}

{
  const context = loadHelpers();
  context.state.view = {
    artist_groups: [],
    query: '',
  };
  context.mergeViewPayload({
    query: 'shoegaze',
    related_filter_artists: ['Rachel Goswell'],
  }, { trackSidebarReveal: false });
  assert.equal(context.state.view.query, 'shoegaze');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.related_filter_artists)), ['Rachel Goswell']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.ui.preSearchView)), {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  });
}

{
  const context = loadHelpers();
  context.state.relatedExpanded = false;
  context.isArtistsDrawerMobileViewport = () => false;
  context.state.view = {
    selected_artist: '',
    all_artists_active: false,
    shell_layout: {
      slots: {
        navigation_rail: {
          content_kind: 'artists_sidebar',
        },
      },
    },
  };

  context.applyViewPayload({
    selected_artist: 'Broadcast',
    all_artists_active: false,
    related_artists: ['Trish Keenan'],
    shell_layout: {
      slots: {
        navigation_rail: {
          content_kind: 'artists_sidebar',
        },
      },
    },
  }, { trackSidebarReveal: false });

  assert.equal(context.state.relatedExpanded, true);
}

{
  const context = loadHelpers();
  const primaryGroups = [{ artist: 'Signal', albums: [{ key: 'signal-signal' }] }];
  const familyGroups = [{
    artist: 'Signal Family',
    albums: [{ key: 'signal-family-album' }],
  }];
  const artistGroups = [...primaryGroups, ...familyGroups];
  const relatedArtists = ['Signal Family'];
  context.state.view = {
    query: 'Signal',
    selected_artist: 'Signal',
    primary_artist_groups: primaryGroups,
    family_artist_groups: familyGroups,
    artist_groups: artistGroups,
    related_artists: relatedArtists,
  };

  context.applyViewPayload({
    query: '',
    selected_artist: 'Signal',
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
    related_artists: [],
  }, {
    preserveMountedGalleryChildren: true,
    trackSidebarReveal: false,
  });

  assert.equal(context.state.view.primary_artist_groups, primaryGroups);
  assert.equal(context.state.view.family_artist_groups, familyGroups);
  assert.equal(context.state.view.artist_groups, artistGroups);
  assert.equal(context.state.view.related_artists, relatedArtists);
}

{
  const context = loadHelpers();
  context.state.relatedExpanded = false;
  context.isArtistsDrawerMobileViewport = () => false;
  context.state.view = {
    selected_artist: 'Cosmic Cathedral',
    related_artists: [],
    all_artists_active: false,
    shell_layout: {
      slots: {
        navigation_rail: {
          content_kind: 'artists_sidebar',
        },
      },
    },
  };

  context.applyViewPayload({
    selected_artist: 'Cosmic Cathedral',
    related_artists: ['Neal Morse', 'The Neal Morse Band'],
    all_artists_active: false,
    shell_layout: {
      slots: {
        navigation_rail: {
          content_kind: 'artists_sidebar',
        },
      },
    },
  }, { trackSidebarReveal: false });

  assert.equal(context.state.relatedExpanded, true);
}

{
  const context = loadHelpers();
  context.state.relatedExpanded = true;
  context.state.ui.artistsDrawerOpen = true;
  context.isArtistsDrawerMobileViewport = () => true;
  context.state.view = {
    selected_artist: '',
    all_artists_active: false,
    shell_layout: {
      slots: {
        navigation_rail: {
          content_kind: 'artists_sidebar',
        },
      },
    },
  };

  context.applyViewPayload({
    selected_artist: 'Broadcast',
    all_artists_active: false,
    related_artists: ['Trish Keenan'],
    shell_layout: {
      slots: {
        navigation_rail: {
          content_kind: 'artists_sidebar',
        },
      },
    },
  }, { trackSidebarReveal: false });

  assert.deepEqual(JSON.parse(JSON.stringify(context.closeArtistsDrawerCalls)), [{
    restoreFocus: false,
  }]);
  assert.equal(context.syncArtistsDrawerVisibilityCalls, 0);
  assert.equal(context.state.relatedExpanded, false);
}

{
  const context = loadHelpers();
  context.state.ui.artistsDrawerOpen = true;
  context.state.view = {
    selected_artist: '',
    all_artists_active: false,
    shell_layout: {
      slots: {
        navigation_rail: {
          content_kind: 'artists_sidebar',
        },
      },
    },
  };

  context.applyViewPayload({
    selected_artist: '',
    all_artists_active: false,
    shell_layout: {
      slots: {
        navigation_rail: {
          content_kind: 'playlist_sidebar',
        },
      },
    },
  }, { trackSidebarReveal: false });

  assert.deepEqual(JSON.parse(JSON.stringify(context.closeArtistsDrawerCalls)), [{
    restoreFocus: false,
  }]);
}

{
  const context = loadHelpers();
  context.state.ui.artistsDrawerOpen = true;
  context.state.view = {
    selected_artist: '',
    all_artists_active: false,
  };

  context.applyViewPayload({
    selected_artist: '',
    all_artists_active: false,
  }, { trackSidebarReveal: false });

  assert.deepEqual(JSON.parse(JSON.stringify(context.closeArtistsDrawerCalls)), []);
  assert.equal(context.syncArtistsDrawerVisibilityCalls, 1);
}

{
  const { normalizeViewPayload } = loadHelpers();
  const normalized = JSON.parse(JSON.stringify(normalizeViewPayload({
    surface: {
      active: 'playlists',
    },
    playlist_sidebar: {
      active_playlist_id: 'playlist-1',
      items: [
        {
          playlist_id: 'playlist-1',
          title: 'Road Trip',
          item_count: 2,
          is_active: true,
          allowed_actions: {
            can_open: true,
          },
        },
      ],
    },
    playlist_detail: {
      playlist_id: 'playlist-1',
      allowed_actions: {
        can_play: true,
        can_edit: true,
        can_rename: true,
        can_delete: false,
        can_reorder: true,
      },
    },
  }, {
    surface: {
      active: 'albums',
    },
    artists_sidebar: [{ artist: 'Broadcast', count: 3 }],
    artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'broadcast-tender-buttons' }] }],
    primary_artist_groups: [{ artist: 'Broadcast', albums: [{ key: 'broadcast-tender-buttons' }] }],
    family_artist_groups: [{ artist: 'Stereolab', albums: [{ key: 'stereolab-dots' }] }],
    related_artists: ['Stereolab'],
    artist_family_filters: [{ artist: 'Stereolab' }],
    artist_page: {
      artist: 'Broadcast',
    },
    playback_context: {
      kind: 'artist_page',
      end_behavior: 'stop',
      ordered_album_refs: ['broadcast-tender-buttons'],
      albums: [{ album_ref: 'broadcast-tender-buttons', can_play: true }],
    },
    show_all_artists_sidebar_link: true,
    selected_artist: 'Broadcast',
    all_artists_active: true,
    related_filter_artists: ['Stereolab'],
    primary_filter_active: true,
  })));

  assert.equal(normalized.surface.active, 'playlists');
  assert.deepEqual(normalized.playlist_sidebar, {
    active_playlist_id: 'playlist-1',
    items: [
      {
        playlist_id: 'playlist-1',
        title: 'Road Trip',
        item_count: 2,
        is_active: true,
        allowed_actions: {
          can_open: true,
        },
      },
    ],
  });
  assert.deepEqual(normalized.playlist_detail.allowed_actions, {
    can_play: true,
    can_edit: true,
    can_rename: true,
    can_delete: false,
    can_reorder: true,
  });
  assert.deepEqual(normalized.artists_sidebar, []);
  assert.deepEqual(normalized.artist_groups, []);
  assert.deepEqual(normalized.primary_artist_groups, []);
  assert.deepEqual(normalized.family_artist_groups, []);
  assert.deepEqual(normalized.related_artists, []);
  assert.deepEqual(normalized.related_filter_artists, []);
  assert.equal(normalized.show_all_artists_sidebar_link, false);
  assert.equal(normalized.selected_artist, '');
  assert.equal(normalized.all_artists_active, false);
  assert.equal(normalized.primary_filter_active, false);
  assert.equal('artist_family_filters' in normalized, false);
  assert.equal('artist_page' in normalized, false);
  assert.equal('playback_context' in normalized, false);
}

{
  const { normalizeViewPayload } = loadHelpers();
  const normalized = JSON.parse(JSON.stringify(normalizeViewPayload({
    surface: {
      active: 'playlists',
    },
    playlist_sidebar: {
      active_playlist_id: '',
      items: [],
    },
    playlist_index: {
      query: '',
      playlists: [],
    },
  }, {
    surface: {
      active: 'playlists',
    },
    playlist_sidebar: {
      active_playlist_id: 'playlist-1',
      items: [],
    },
    playlist_detail: {
      playlist_id: 'playlist-1',
      track_rows: [{ playlist_item_id: 'stale-row' }],
    },
  })));

  assert.equal('playlist_detail' in normalized, false);
  assert.deepEqual(normalized.playlist_index, {
    query: '',
    playlists: [],
  });
}

{
  const { normalizeStatusPayload } = loadHelpers();
  const normalized = JSON.parse(JSON.stringify(normalizeStatusPayload({
    scan_in_progress: 1,
    scan_total: '57',
    scan_current_path: 'C:/Music/Artist/Album/Track 01.flac',
    scan_phase: 'discovering',
  })));
  assert.equal(normalized.scan_phase, 'discovering');
  assert.equal(normalized.scan_total, 57);
  assert.equal(normalized.scan_current_path, 'C:/Music/Artist/Album/Track 01.flac');
}

{
  const context = loadHelpers();
  context.applyViewPayload({
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'new_arrivals', 'new_arrivals', 'unknown'],
  }, { trackSidebarReveal: false });
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.gallery.mainGalleryVisibleCategories)),
    ['main_library', 'new_arrivals'],
  );

  context.applyViewPayload({
    gallery_scope: 'new_arrivals',
    visible_library_categories: ['new_arrivals'],
  }, { trackSidebarReveal: false });
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.gallery.mainGalleryVisibleCategories)),
    ['main_library', 'new_arrivals'],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.resolveMainGalleryCategorySelection())),
    ['main_library', 'new_arrivals'],
  );
}

{
  const context = loadHelpers();
  context.state.view = {
    query: 'folk',
    selected_artist: 'Linda Perhacs',
    ignored_version_keys: ['old-key'],
    manual_version_links: { child: 'parent' },
    primary_filter_active: false,
  };
  context.mergeViewPayload({
    ignored_version_keys: ['new-key'],
    manual_version_links: {},
    primary_filter_active: 1,
  }, { trackSidebarReveal: false });
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.ignored_version_keys)), ['new-key']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.view.manual_version_links)), {});
  assert.equal(context.state.view.primary_filter_active, true);
  assert.equal(context.state.ui.pendingSidebarRevealArtist, '');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.ui.preSearchView)), {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  });
}

{
  const context = loadHelpers();
  context.state.view = {
    query: '',
    selected_artist: 'Broadcast',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  context.state.ui.preSearchView = {
    selected_artist: 'before',
    related_filter_artists: ['before'],
    primary_filter_active: true,
  };
  context.applyViewPayload({
    query: 'tender buttons',
    selected_artist: '',
  }, { trackSidebarReveal: false });
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.ui.preSearchView)), {
    selected_artist: 'before',
    related_filter_artists: ['before'],
    primary_filter_active: true,
  });
}

{
  const context = loadHelpers();
  context.state.view = {
    surface: { active: 'albums' },
    query: '',
    selected_artist: 'Broadcast',
    all_artists_active: false,
    primary_artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'tender-buttons' }],
    }],
    family_artist_groups: [{
      artist: 'Focus Group',
      albums: [{ key: 'sketches' }],
    }],
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'tender-buttons' }],
    }, {
      artist: 'Stereolab',
      albums: [{ key: 'dots-and-loops' }],
    }],
  };

  const nextView = JSON.parse(JSON.stringify(context.applyViewPayload({
    surface: { active: 'albums' },
    query: '',
    selected_artist: '',
    all_artists_active: true,
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'tender-buttons' }],
    }, {
      artist: 'Stereolab',
      albums: [{ key: 'dots-and-loops' }],
    }],
    artists_sidebar: [
      { artist: 'Broadcast', count: 1 },
      { artist: 'Stereolab', count: 1 },
    ],
    album_count: 2,
    artist_count: 2,
  }, { trackSidebarReveal: false })));

  assert.equal(nextView.selected_artist, '');
  assert.equal(nextView.all_artists_active, true);
  assert.deepEqual(nextView.primary_artist_groups, []);
  assert.deepEqual(nextView.family_artist_groups, []);
  assert.deepEqual(nextView.artist_groups, [
    {
      artist: 'Broadcast',
      albums: [{
        key: 'tender-buttons',
        tracks: [],
        duplicate_sources: [],
        has_duplicate_files: false,
        track_count_preview: 0,
        open_directory_paths: [],
        preview_only: true,
      }],
    },
    {
      artist: 'Stereolab',
      albums: [{
        key: 'dots-and-loops',
        tracks: [],
        duplicate_sources: [],
        has_duplicate_files: false,
        track_count_preview: 0,
        open_directory_paths: [],
        preview_only: true,
      }],
    },
  ]);
}

{
  const context = loadHelpers();
  context.applyViewPayload({
    query: 'stereolab',
    selected_artist: 'Stereolab',
    primary_artist_groups: [{ artist: 'Stereolab', albums: [{ key: 'dots' }] }],
    family_artist_groups: [
      { artist: 'Laetitia Sadier', albums: [{ key: 'solo-1' }] },
      { artist: 'Tim Gane', albums: [{ key: 'mc' }, { key: 'cm' }] },
    ],
    artist_groups: [
      { artist: 'Stereolab', albums: [{ key: 'dots' }] },
      { artist: 'Laetitia Sadier', albums: [{ key: 'solo-1' }] },
      { artist: 'Tim Gane', albums: [{ key: 'mc' }, { key: 'cm' }] },
    ],
    album_count: 4,
    artist_count: 3,
  });
  assert.equal(context.state.gallery.relatedFilterBaseArtist, 'Stereolab');
  assert.equal(context.state.gallery.relatedFilterBaseQuery, 'stereolab');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.gallery.relatedFilterBasePrimaryGroups)), [
    {
      artist: 'Stereolab',
      albums: [{
        key: 'dots',
        tracks: [],
        duplicate_sources: [],
        has_duplicate_files: false,
        track_count_preview: 0,
        open_directory_paths: [],
        preview_only: true,
      }],
    },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.gallery.relatedFilterBaseFamilyGroups)), [
    {
      artist: 'Laetitia Sadier',
      albums: [{
        key: 'solo-1',
        tracks: [],
        duplicate_sources: [],
        has_duplicate_files: false,
        track_count_preview: 0,
        open_directory_paths: [],
        preview_only: true,
      }],
    },
    {
      artist: 'Tim Gane',
      albums: [
        { key: 'mc', tracks: [], duplicate_sources: [], has_duplicate_files: false, track_count_preview: 0, open_directory_paths: [], preview_only: true },
        { key: 'cm', tracks: [], duplicate_sources: [], has_duplicate_files: false, track_count_preview: 0, open_directory_paths: [], preview_only: true },
      ],
    },
  ]);
}

{
  const context = loadHelpers();
  context.state.view = {
    selected_artist: 'Stereolab',
    query: 'stereolab',
    selected_artist_family_display_mode: 'chronological',
    primary_filter_active: false,
    related_filter_artists: [],
    primary_artist_groups: [{
      artist: 'Stereolab',
      albums: [{ key: 'dots', name: 'Dots and Loops', year: 1997, release_date: '1997-09-22' }],
    }],
    family_artist_groups: [
      {
        artist: 'Laetitia Sadier',
        albums: [{ key: 'solo-1', name: 'The Trip', year: 2007, release_date: '2007-09-24' }],
      },
      {
        artist: 'Tim Gane',
        albums: [
          { key: 'mc', name: 'Margerine Eclipse', year: 2004, release_date: '2004-01-27' },
          { key: 'cm', name: 'Chemical Chords', year: 2008, release_date: '2008-08-19' },
        ],
      },
    ],
    artist_groups: [
      {
        artist: 'Chronological',
        albums: [
          { key: 'dots', name: 'Dots and Loops', year: 1997, release_date: '1997-09-22' },
          { key: 'mc', name: 'Margerine Eclipse', year: 2004, release_date: '2004-01-27' },
          { key: 'solo-1', name: 'The Trip', year: 2007, release_date: '2007-09-24' },
          { key: 'cm', name: 'Chemical Chords', year: 2008, release_date: '2008-08-19' },
        ],
      },
    ],
    album_count: 4,
    artist_count: 3,
  };
  context.state.gallery.relatedFilterBaseArtist = 'Stereolab';
  context.state.gallery.relatedFilterBaseQuery = 'stereolab';
  context.state.gallery.relatedFilterBasePrimaryGroups = [{
    artist: 'Stereolab',
    albums: [{ key: 'dots', name: 'Dots and Loops', year: 1997, release_date: '1997-09-22' }],
  }];
  context.state.gallery.relatedFilterBaseFamilyGroups = [
    {
      artist: 'Laetitia Sadier',
      albums: [{ key: 'solo-1', name: 'The Trip', year: 2007, release_date: '2007-09-24' }],
    },
    {
      artist: 'Tim Gane',
      albums: [
        { key: 'mc', name: 'Margerine Eclipse', year: 2004, release_date: '2004-01-27' },
        { key: 'cm', name: 'Chemical Chords', year: 2008, release_date: '2008-08-19' },
      ],
    },
  ];

  const nextView = JSON.parse(JSON.stringify(context.applyLocalRelatedFilterState([])));
  assert.deepEqual(nextView.related_filter_artists, []);
  assert.deepEqual(nextView.primary_artist_groups, [
    {
      artist: 'Stereolab',
      albums: [{
        key: 'dots',
        name: 'Dots and Loops',
        year: 1997,
        release_date: '1997-09-22',
        tracks: [],
        duplicate_sources: [],
        has_duplicate_files: false,
        track_count_preview: 0,
        open_directory_paths: [],
        preview_only: true,
      }],
    },
  ]);
  assert.deepEqual(nextView.family_artist_groups, [
    {
      artist: 'Laetitia Sadier',
      albums: [{
        key: 'solo-1',
        name: 'The Trip',
        year: 2007,
        release_date: '2007-09-24',
        tracks: [],
        duplicate_sources: [],
        has_duplicate_files: false,
        track_count_preview: 0,
        open_directory_paths: [],
        preview_only: true,
      }],
    },
    {
      artist: 'Tim Gane',
      albums: [
        {
          key: 'mc',
          name: 'Margerine Eclipse',
          year: 2004,
          release_date: '2004-01-27',
          tracks: [],
          duplicate_sources: [],
          has_duplicate_files: false,
          track_count_preview: 0,
          open_directory_paths: [],
          preview_only: true,
        },
        {
          key: 'cm',
          name: 'Chemical Chords',
          year: 2008,
          release_date: '2008-08-19',
          tracks: [],
          duplicate_sources: [],
          has_duplicate_files: false,
          track_count_preview: 0,
          open_directory_paths: [],
          preview_only: true,
        },
      ],
    },
  ]);
  assert.deepEqual(nextView.artist_groups, [
    {
      artist: 'Chronological',
      artist_display: 'Chronological',
      albums: [
        {
          key: 'dots',
          name: 'Dots and Loops',
          year: 1997,
          release_date: '1997-09-22',
          tracks: [],
          duplicate_sources: [],
          has_duplicate_files: false,
          track_count_preview: 0,
          open_directory_paths: [],
          preview_only: true,
        },
        {
          key: 'mc',
          name: 'Margerine Eclipse',
          year: 2004,
          release_date: '2004-01-27',
          tracks: [],
          duplicate_sources: [],
          has_duplicate_files: false,
          track_count_preview: 0,
          open_directory_paths: [],
          preview_only: true,
        },
        {
          key: 'solo-1',
          name: 'The Trip',
          year: 2007,
          release_date: '2007-09-24',
          tracks: [],
          duplicate_sources: [],
          has_duplicate_files: false,
          track_count_preview: 0,
          open_directory_paths: [],
          preview_only: true,
        },
        {
          key: 'cm',
          name: 'Chemical Chords',
          year: 2008,
          release_date: '2008-08-19',
          tracks: [],
          duplicate_sources: [],
          has_duplicate_files: false,
          track_count_preview: 0,
          open_directory_paths: [],
          preview_only: true,
        },
      ],
    },
  ]);
  assert.equal(nextView.artist_count, 3);
  assert.equal(nextView.album_count, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.gallery.relatedFilterBaseFamilyGroups)), [
    {
      artist: 'Laetitia Sadier',
      albums: [{
        key: 'solo-1',
        name: 'The Trip',
        year: 2007,
        release_date: '2007-09-24',
        tracks: [],
        duplicate_sources: [],
        has_duplicate_files: false,
        track_count_preview: 0,
        open_directory_paths: [],
        preview_only: true,
      }],
    },
    {
      artist: 'Tim Gane',
      albums: [
        {
          key: 'mc',
          name: 'Margerine Eclipse',
          year: 2004,
          release_date: '2004-01-27',
          tracks: [],
          duplicate_sources: [],
          has_duplicate_files: false,
          track_count_preview: 0,
          open_directory_paths: [],
          preview_only: true,
        },
        {
          key: 'cm',
          name: 'Chemical Chords',
          year: 2008,
          release_date: '2008-08-19',
          tracks: [],
          duplicate_sources: [],
          has_duplicate_files: false,
          track_count_preview: 0,
          open_directory_paths: [],
          preview_only: true,
        },
      ],
    },
  ]);
}

{
  const context = loadHelpers();
  context.state.view = {
    selected_artist: 'Mono',
    selected_artist_family_display_mode: 'chronological',
    query: '',
    primary_filter_active: false,
    related_filter_artists: [],
    primary_artist_groups: [{
      artist: 'Mono',
      albums: [{ key: 'unknown-year', name: 'Unknown Year', year: null, release_date: '' }],
    }],
    family_artist_groups: [{
      artist: 'World\'s End Girlfriend',
      albums: [{ key: 'dated', name: 'Dated Album', year: 2006, release_date: '' }],
    }],
    artist_groups: [],
    album_count: 2,
    artist_count: 2,
  };
  context.state.gallery.relatedFilterBaseArtist = 'Mono';
  context.state.gallery.relatedFilterBaseQuery = '';
  context.state.gallery.relatedFilterBasePrimaryGroups = context.state.view.primary_artist_groups;
  context.state.gallery.relatedFilterBaseFamilyGroups = context.state.view.family_artist_groups;

  const nextView = JSON.parse(JSON.stringify(context.applyLocalRelatedFilterState([])));

  assert.deepEqual(
    nextView.artist_groups[0].albums.map((album) => album.key),
    ['dated', 'unknown-year'],
  );
}

{
  const context = loadHelpers();
  context.state.view = {
    selected_artist: 'Devin Townsend',
    query: 'devin',
    primary_filter_active: false,
    related_filter_artists: [],
    primary_artist_groups: [{ artist: 'Devin Townsend', albums: [{ key: 'ocean-machine' }] }],
    family_artist_groups: [
      {
        artist: 'IR8 / Sexoturica',
        albums: [{ key: 'split-1', artists: ['IR8', 'Sexoturica'] }],
      },
    ],
    artist_groups: [
      { artist: 'Devin Townsend', albums: [{ key: 'ocean-machine' }] },
      {
        artist: 'IR8 / Sexoturica',
        albums: [{ key: 'split-1', artists: ['IR8', 'Sexoturica'] }],
      },
    ],
    album_count: 2,
    artist_count: 2,
  };
  context.state.gallery.relatedFilterBaseArtist = 'Devin Townsend';
  context.state.gallery.relatedFilterBaseQuery = 'devin';
  context.state.gallery.relatedFilterBasePrimaryGroups = [{ artist: 'Devin Townsend', albums: [{ key: 'ocean-machine' }] }];
  context.state.gallery.relatedFilterBaseFamilyGroups = [
    {
      artist: 'IR8 / Sexoturica',
      albums: [{ key: 'split-1', artists: ['IR8', 'Sexoturica'] }],
    },
  ];

  assert.equal(context.state.ui.viewStateRevision, undefined);
  const nextView = JSON.parse(JSON.stringify(context.applyLocalRelatedFilterState(['IR8'])));
  assert.equal(context.state.ui.viewStateRevision, 1);
  assert.deepEqual(nextView.related_filter_artists, ['IR8']);
  assert.deepEqual(nextView.primary_artist_groups, []);
  assert.deepEqual(nextView.family_artist_groups, [
    {
      artist: 'IR8 / Sexoturica',
      albums: [{
        key: 'split-1',
        artists: ['IR8', 'Sexoturica'],
        tracks: [],
        duplicate_sources: [],
        has_duplicate_files: false,
        track_count_preview: 0,
        open_directory_paths: [],
        preview_only: true,
      }],
    },
  ]);
  assert.deepEqual(nextView.artist_groups, [
    {
      artist: 'IR8 / Sexoturica',
      albums: [{
        key: 'split-1',
        artists: ['IR8', 'Sexoturica'],
        tracks: [],
        duplicate_sources: [],
        has_duplicate_files: false,
        track_count_preview: 0,
        open_directory_paths: [],
        preview_only: true,
      }],
    },
  ]);
  assert.equal(nextView.artist_count, 1);
  assert.equal(nextView.album_count, 1);
}

{
  const context = loadHelpers();
  context.state.view = {
    selected_artist: '3',
    query: '',
    primary_filter_active: false,
    related_filter_artists: [],
    primary_artist_groups: [{ artist: '3', albums: [{ key: 'to-the-power-of-three' }] }],
    family_artist_groups: [
      {
        artist: 'Emerson Lake & Palmer',
        artist_display: 'Emerson Lake & Palmer / Emerson, Lake & Palmer',
        variation_names: ['Emerson Lake & Palmer', 'Emerson, Lake & Palmer'],
        albums: [{
          key: 'tarkus',
          album_artist: 'Emerson Lake & Palmer',
          artists: ['Emerson Lake & Palmer'],
          artist_family_variation_names_by_tag_ref: {
            'artist-family:emersonlakepalmer': ['Emerson Lake & Palmer', 'Emerson, Lake & Palmer'],
          },
        }],
      },
      {
        artist: 'Emerson, Lake & Powell',
        albums: [{ key: 'elpowell', album_artist: 'Emerson, Lake & Powell' }],
      },
    ],
    artist_groups: [],
    album_count: 3,
    artist_count: 3,
  };
  context.state.gallery.relatedFilterBaseArtist = '3';
  context.state.gallery.relatedFilterBaseQuery = '';
  context.state.gallery.relatedFilterBasePrimaryGroups = context.state.view.primary_artist_groups;
  context.state.gallery.relatedFilterBaseFamilyGroups = context.state.view.family_artist_groups;

  const nextView = JSON.parse(JSON.stringify(context.applyLocalRelatedFilterState(['Emerson, Lake & Palmer'])));
  assert.deepEqual(nextView.related_filter_artists, ['Emerson, Lake & Palmer']);
  assert.deepEqual(nextView.primary_artist_groups, []);
  assert.deepEqual(nextView.family_artist_groups.map((group) => group.artist), ['Emerson Lake & Palmer']);
  assert.deepEqual(nextView.artist_groups.map((group) => group.artist), ['Emerson Lake & Palmer']);
  assert.equal(nextView.artist_count, 1);
  assert.equal(nextView.album_count, 1);
}

{
  const context = loadHelpers();
  context.state.view = {
    selected_artist: 'Stereolab',
    query: 'stereolab',
    primary_filter_active: true,
    related_filter_artists: [],
    primary_artist_groups: [{ artist: 'Stereolab', albums: [{ key: 'dots' }] }],
    family_artist_groups: [],
    artist_groups: [
      { artist: 'Stereolab', albums: [{ key: 'dots' }] },
    ],
    album_count: 1,
    artist_count: 1,
  };
  context.state.gallery.relatedFilterBaseArtist = 'Stereolab';
  context.state.gallery.relatedFilterBaseQuery = 'stereolab';
  context.state.gallery.relatedFilterBasePrimaryGroups = [{ artist: 'Stereolab', albums: [{ key: 'dots' }] }];
  context.state.gallery.relatedFilterBaseFamilyGroups = [
    { artist: 'Laetitia Sadier', albums: [{ key: 'solo-1' }] },
    { artist: 'Tim Gane', albums: [{ key: 'mc' }, { key: 'cm' }] },
  ];

  const nextView = JSON.parse(JSON.stringify(context.applyLocalRelatedFilterState([], {
    primary_filter_active: false,
  })));
  assert.equal(nextView.primary_filter_active, false);
  assert.deepEqual(nextView.related_filter_artists, []);
  assert.deepEqual(nextView.primary_artist_groups, [
    {
      artist: 'Stereolab',
      albums: [{ key: 'dots', tracks: [], duplicate_sources: [], has_duplicate_files: false, track_count_preview: 0, open_directory_paths: [], preview_only: true }],
    },
  ]);
  assert.deepEqual(nextView.family_artist_groups, [
    {
      artist: 'Laetitia Sadier',
      albums: [{ key: 'solo-1', tracks: [], duplicate_sources: [], has_duplicate_files: false, track_count_preview: 0, open_directory_paths: [], preview_only: true }],
    },
    {
      artist: 'Tim Gane',
      albums: [
        { key: 'mc', tracks: [], duplicate_sources: [], has_duplicate_files: false, track_count_preview: 0, open_directory_paths: [], preview_only: true },
        { key: 'cm', tracks: [], duplicate_sources: [], has_duplicate_files: false, track_count_preview: 0, open_directory_paths: [], preview_only: true },
      ],
    },
  ]);
  assert.deepEqual(nextView.artist_groups, [
    {
      artist: 'Stereolab',
      albums: [{ key: 'dots', tracks: [], duplicate_sources: [], has_duplicate_files: false, track_count_preview: 0, open_directory_paths: [], preview_only: true }],
    },
    {
      artist: 'Laetitia Sadier',
      albums: [{ key: 'solo-1', tracks: [], duplicate_sources: [], has_duplicate_files: false, track_count_preview: 0, open_directory_paths: [], preview_only: true }],
    },
    {
      artist: 'Tim Gane',
      albums: [
        { key: 'mc', tracks: [], duplicate_sources: [], has_duplicate_files: false, track_count_preview: 0, open_directory_paths: [], preview_only: true },
        { key: 'cm', tracks: [], duplicate_sources: [], has_duplicate_files: false, track_count_preview: 0, open_directory_paths: [], preview_only: true },
      ],
    },
  ]);
  assert.equal(nextView.artist_count, 3);
  assert.equal(nextView.album_count, 4);
}

{
  const context = loadHelpers();
  context.applyViewPayload({
    selected_artist: 'Ария',
    query: 'Ария',
    primary_filter_active: false,
    related_filter_artists: [],
    related_artists: ['Ария', 'Кипелов', 'Виталий Дубинин', 'Дубинин & Холстинин'],
    primary_artist_groups: [{ artist: 'Ария', albums: [{ key: 'aria-hero' }] }],
    family_artist_groups: [],
    related_filter_base_primary_groups: [{ artist: 'Ария', albums: [{ key: 'aria-hero' }] }],
    related_filter_base_family_groups: [
      { artist: 'Кипелов', albums: [{ key: 'kipelov-rivers' }] },
      { artist: 'Виталий Дубинин', albums: [{ key: 'dubinin-masquerade' }] },
      { artist: 'Дубинин & Холстинин', albums: [{ key: 'duet-avaria' }] },
    ],
    artist_groups: [{ artist: 'Ария', albums: [{ key: 'aria-hero' }] }],
    album_count: 1,
    artist_count: 1,
  });
  context.applyLocalRelatedFilterState(['Виталий Дубинин'], {
    primary_filter_active: false,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.view.artist_groups.map((group) => group.artist))),
    ['Виталий Дубинин'],
  );

  context.applyViewPayload({
    ...context.state.view,
    query: '',
  }, {
    preserveMountedGalleryChildren: true,
  });

  assert.equal(context.state.gallery.relatedFilterBaseQuery, '');
  const restoredView = context.applyLocalRelatedFilterState([]);
  assert.ok(restoredView);
  assert.deepEqual(
    JSON.parse(JSON.stringify(restoredView.primary_artist_groups.map((group) => group.artist))),
    ['Ария'],
  );
  assert.equal(restoredView.primary_filter_active, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(restoredView.family_artist_groups.map((group) => group.artist))),
    [],
  );
}

{
  const context = loadHelpers();
  const nextView = context.applyViewPayload({
    artist_groups: [
      {
        artist: 'Mono',
        albums: [
          {
            key: 'mono-1',
            preview_only: true,
            album_preference: {
              rating: null,
              favorite_override: null,
              is_favorite: false,
              favorite_source: null,
              can_edit: false,
              to_listen: false,
              is_relisten: false,
              can_toggle_to_listen: false,
            },
            tag_album_rating: 9,
            tag_album_rating_source: 'file_tag',
            tracks: [],
            open_directory_paths: [],
          },
          {
            key: 'mono-2',
            preview_only: true,
            album_preference: {
              rating: null,
              favorite_override: null,
              is_favorite: false,
              favorite_source: null,
              can_edit: false,
              to_listen: false,
              is_relisten: false,
              can_toggle_to_listen: false,
            },
            tracks: [],
            open_directory_paths: [],
          },
        ],
      },
    ],
  });

  const [firstAlbum, secondAlbum] = nextView.artist_groups[0].albums;
  assert.deepEqual(JSON.parse(JSON.stringify(firstAlbum.album_preference)), { rating: null });
  assert.deepEqual(JSON.parse(JSON.stringify(secondAlbum.album_preference)), { rating: null });
  assert.equal(firstAlbum.tag_album_rating, 9);
  assert.equal(firstAlbum.tag_album_rating_source, 'file_tag');
  assert.equal(Object.prototype.hasOwnProperty.call(firstAlbum, 'gallery_list_block'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(secondAlbum, 'gallery_list_block'), false);
}

{
  const context = loadHelpers();
  context.state.view = {
    surface: { active: 'home' },
    surface_request: 'home',
    query: '',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: '',
    visible_library_categories: [],
    artist_groups: [],
    primary_artist_groups: [],
    family_artist_groups: [],
    artists_sidebar: [{ artist: 'A.C.T', count: 1 }],
  };
  context.state.ui.pageEntryBrowseContextPending = true;

  const nextView = context.applyViewPayload({
    surface: { active: 'albums' },
    payload_tier: 'full',
    query: '',
    selected_artist: '',
    all_artists_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    artist_groups: [{
      artist: 'A.C.T',
      albums: [{ key: 'last-epic', name: 'Last Epic' }],
    }],
    primary_artist_groups: [{
      artist: 'A.C.T',
      albums: [{ key: 'last-epic', name: 'Last Epic' }],
    }],
    family_artist_groups: [],
    album_count: 1,
  }, {
    completePageEntryBrowseContext: true,
  });

  assert.equal(nextView.surface.active, 'home');
  assert.equal(nextView.surface_request, 'home');
  assert.equal(nextView.artist_groups.length, 1);
  assert.equal(nextView.artist_groups[0].albums[0].key, 'last-epic');
  assert.equal(nextView.album_count, 1);
  assert.equal(context.state.ui.pageEntryBrowseContextPending, false);
}

{
  const context = loadHelpers();
  const compacted = context.compactRuntimeAlbumPayload({
    key: 'app-rated-album',
    album_preference: {
      rating: 8,
      favorite_override: true,
      is_favorite: true,
    },
    tag_album_rating: 3,
    tag_album_rating_source: 'file_tag_scan',
    tracks: [{ path: 'C:\\Music\\Artist\\Album\\01 - Track.flac' }],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(compacted.album_preference ?? null)), { rating: 8 });
  assert.equal(compacted.tag_album_rating, 3);
  assert.equal(compacted.tag_album_rating_source, 'file_tag_scan');
}

{
  const context = loadHelpers();
  const compacted = context.compactRuntimeAlbumPayload({
    key: 'explicitly-cleared-album',
    preview_only: true,
    album_preference: {
      rating: null,
      favorite_override: null,
      is_favorite: false,
    },
    tag_album_rating: 9,
    tag_album_rating_source: 'file_tag_scan',
    tracks: [],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(compacted.album_preference ?? null)), { rating: null });
  assert.equal(compacted.tag_album_rating, 9);
  assert.equal(compacted.tag_album_rating_source, 'file_tag_scan');
}
