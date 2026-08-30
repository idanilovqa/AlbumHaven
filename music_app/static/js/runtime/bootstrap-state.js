const appBootstrap = (() => {
  const releaseVersion = document.querySelector('meta[name="album-haven-version"]')?.content?.trim() || '0.0.0';
  const defaultInitialView = {
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
    app_version: releaseVersion,
    ignored_version_keys: [],
    manual_version_links: {},
    non_album_tracks: [],
    non_album_exception_values: [],
    initial_view_partial: false,
  };

  const defaultBootstrap = {
    refreshed: false,
    lastScanDisplay: '',
    scanInProgress: false,
    scanPhase: 'idle',
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

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  const cloneInitialView = (value) => ({
    ...defaultInitialView,
    ...(isObject(value) ? value : {}),
  });

  const cloneBootstrap = (value) => ({
    ...defaultBootstrap,
    ...(isObject(value) ? value : {}),
  });

  const readPayloadInitialView = (payload) => {
    if (isObject(payload?.startup_payload?.first_paint_view)) {
      return payload.startup_payload.first_paint_view;
    }
    return payload?.initial_view;
  };

  const readWindowPayload = () => window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__;

  const releaseEmbeddedViewPatch = (bootstrap) => {
    if (!isObject(bootstrap)) return;
    if (isObject(bootstrap.startupHydration)) {
      bootstrap.startupHydration.embeddedViewPatch = null;
    }
    if (isObject(bootstrap.startupPayloadTiers?.hydration)) {
      bootstrap.startupPayloadTiers.hydration.embeddedViewPatch = null;
    }
  };

  const sourcePayload = readWindowPayload();
  const normalizedPayload = {
    initial_view: cloneInitialView(readPayloadInitialView(sourcePayload)),
    bootstrap: cloneBootstrap(sourcePayload?.bootstrap),
  };

  return {
    getInitialView() {
      return cloneInitialView(normalizedPayload.initial_view);
    },
    getBootstrap() {
      return cloneBootstrap(normalizedPayload.bootstrap);
    },
    releasePayloadViewState() {
      normalizedPayload.initial_view = cloneInitialView({});
      releaseEmbeddedViewPatch(normalizedPayload.bootstrap);
      const windowPayload = readWindowPayload();
      if (!isObject(windowPayload)) return;
      if (isObject(windowPayload.startup_payload)) {
        windowPayload.startup_payload.first_paint_view = null;
      }
      windowPayload.initial_view = null;
      releaseEmbeddedViewPatch(windowPayload.bootstrap);
    },
  };
})();
