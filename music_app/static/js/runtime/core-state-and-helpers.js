const state = {
  view: appBootstrap.getInitialView(),
  busy: false,
  wasPollingBusy: false,
  wasCoverPollingBusy: false,
  toastTimer: null,
  repairAlertTimer: null,
  repairAlertHideTimer: null,
  awaitingInitialDataRefresh: false,
  status: {},
  coverRefreshTokens: {},
  coverFailures: {
    localDisplayPaths: {},
  },
  relatedExpanded: false,
  lightbox: {
    zoom: 1,
    panX: 0,
    panY: 0,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragOriginX: 0,
    dragOriginY: 0,
    zoomBasisRect: null,
    zoomOriginX: 50,
    zoomOriginY: 50,
    items: [],
    currentIndex: -1,
    sourceAlbumKey: '',
    activeSources: [],
    activeSourceIndex: -1,
    activeFullSource: '',
    activePreloader: null,
    loadToken: 0,
  },
  ui: {
    activeViewRequestController: null,
    activeViewRequestId: 0,
    activeViewRequestUrl: '',
    activeViewRequestPush: false,
    activeViewRequestStartupRefresh: false,
    activeViewRequestStartupHydrationTier: '',
    viewStateRevision: 0,
    pendingViewRequest: null,
    deferredUtilityViewRequest: null,
    utilityViewPreemptionSequence: 0,
    utilityViewPreemptions: [],
    pendingScanCompletionViewRefreshEligibleRequestId: 0,
    successfulStatusObservationSequence: 0,
    lastSuccessfulCanonicalFullViewApply: null,
    pendingCoverCompletionViewRefresh: false,
    pendingCoverCompletionViewRefreshRetryCount: 0,
    pendingCoverCompletionViewRefreshRetryExhausted: false,
    pendingCoverCompletionViewRefreshRetryScheduled: false,
    pendingCoverCompletionViewRefreshRetryTimerId: 0,
    pendingCoverCompletionViewRefreshRetryToken: 0,
    pendingStartupHydrationFollowup: null,
    pendingViewTransition: false,
    pendingViewTransitionRequestId: 0,
    activeViewPayloadReady: false,
    pendingSearchCommitTimer: 0,
    recentSearchQueries: [],
    recentSearchesLoaded: false,
    recentSearchPopoverOpen: false,
    recentSearchActiveIndex: -1,
    pendingSelectedArtistReconcileTimer: 0,
    pendingTrackModalLoadAlbumKey: '',
    pendingTrackModalLoadToken: 0,
    trackModalCoverLightboxGallery: true,
    ignoreOverlayCloseUntil: 0,
    pendingSidebarRevealArtist: '',
    pendingSidebarSelectedArtist: '',
    pendingSidebarAllArtistsActive: false,
    artistsDrawerOpen: false,
    pendingAppRefocusSuppression: false,
    suppressNextViewportClick: false,
    suppressClickSequenceUntil: 0,
    refocusHoverIntentCount: 0,
    refocusLastHoverIntentKey: '',
    preSearchView: null,
    preSearchViewOrigin: '',
    pageEntryBrowseContextPending: (() => {
      try {
        const pageEntryUrl = new URL(window.location.href, window.location.origin);
        return Boolean(
          String(pageEntryUrl.searchParams.get('q') || '').trim()
          || String(pageEntryUrl.searchParams.get('artist') || '').trim()
          || pageEntryUrl.searchParams.getAll('category').some((category) => String(category || '').trim())
        );
      } catch (_error) {
        return false;
      }
    })(),
    searchDraftQuery: String(appBootstrap.getInitialView()?.query || ''),
    browseScannedResultsLoading: false,
    scanCancellationPending: false,
    forceScanPageVisible: false,
    scanPageReturnContext: null,
    scanPageCoverLoadSuspensionToken: 0,
    shellLayoutPreferences: {
      contextualPaneWidthPx: 320,
      infoDrawerWidthPx: 360,
    },
  },
  gallery: {
    showNonAlbumTracks: false,
    menuOpen: false,
    combineSimilarArtistsByArtist: {},
    displayPreferences: {
      defaultGalleryDisplayMode: 'cards',
      defaultGalleryScalePercent: 100,
    },
    playbackPreferences: {
      albumTopsEndBehavior: 'continue',
      artistPagesEndBehavior: 'stop',
    },
    albumOpenMode: 'modal',
    sidebarArtistsOverride: null,
    sidebarShowAllArtistsOverride: null,
    reusableRootBrowseView: null,
    reusableRootBrowseViewSignature: '',
    reusableSelectedArtistBrowseViews: {},
    reusableSelectedArtistBrowseViewOrder: [],
    albumIndex: new Map(),
    focusedAlbumGlowCard: null,
    pendingAlbumGlowCard: null,
    focusGlowRaf: 0,
    focusGlowKey: '',
    focusGlowVisible: false,
    relatedFilterBaseArtist: '',
    relatedFilterBaseQuery: '',
    relatedFilterBasePrimaryFilterActive: false,
    relatedFilterBasePrimaryGroups: [],
    relatedFilterBaseFamilyGroups: [],
    relatedFilterDefaultPrimaryGroups: [],
    relatedFilterDefaultFamilyGroups: [],
    mainGalleryVisibleCategories: ['main_library', 'hoard', 'new_arrivals'],
  },
  utility: {
    activeTab: 'problematic-files',
    problematicFiles: [],
    selectedProblematicKey: '',
    pendingRepairKey: '',
    pendingRepairAction: '',
    showRepairedDisplay: true,
    repairSelections: {},
    problemExclusionSelections: {},
    problemExclusionMutations: {
      nextOperationId: 1,
      latestByRowKey: {},
      pendingByOperationId: {},
    },
    repairDragActive: false,
    repairDragChoice: 'ignore',
    repairDragClearOnClick: false,
    repairSuppressClick: false,
    deferProblematicAutoSelection: false,
    separateReleaseSelections: {},
    searchQuery: '',
    selectedProblemFilters: [],
    problemDropdownOpen: false,
    focusedTrackPath: '',
    collapsedSections: {
      detected: false,
      suggested: false,
      details: false,
    },
    loaded: false,
    loading: false,
    loadPromise: null,
    detailLoadPromises: {},
    problematicDiagnostics: {
      summaryLoad: null,
      detailLoads: {},
      lastDetailLoad: null,
    },
    pendingOpenLoadTimer: 0,
    rules: [],
    selectedRuleKey: 'version-exceptions',
    rulesLoaded: false,
    rulesLoading: false,
    rulesLoadPromise: null,
      loops: [],
      selectedLoopGroupKey: '',
      selectedLoopDetailMode: 'group',
      collapsedLoopGroups: {},
      selectedLoopId: '',
      loopSpaceOwnerId: '',
      loopRepeatEnabled: false,
      loopEditors: {},
      savedLoopEditorBusy: {},
      savedLoopEditorPointerBinding: false,
      savedLoopEditorDrag: null,
      loopDragType: '',
      loopDragId: '',
      loopDragGroupKey: '',
      loopDropType: '',
      loopDropTargetId: '',
      loopDropGroupKey: '',
      loopDropPosition: '',
      loopSuppressClick: false,
      lastLoopGroupClickKey: '',
      lastLoopGroupClickAt: 0,
      loopsLoaded: false,
      loopsLoading: false,
      loopsLoadPromise: null,
    logHistory: [],
    selectedLogHistoryId: '',
    logHistoryLoaded: false,
    logHistoryLoading: false,
    logHistoryLoadPromise: null,
    logHistoryRevision: '',
    logHistoryTargetRevision: '',
    logHistorySyncPromise: null,
    logHistoryStorageStatus: {
      persistent: true,
      storage: 'indexeddb',
      message: 'Stored in this browser.',
    },
    integrations: [],
    selectedIntegrationKey: 'lastfm',
    integrationsLoaded: false,
    integrationsLoading: false,
    integrationsLoadPromise: null,
    localPlaylistImport: {
      selectedFile: null,
      selectedFileName: '',
      analyzeBusy: false,
      error: '',
      lastAnalysis: null,
    },
    integrationDrafts: {
      lastfm: {
        username: '',
        password: '',
        timezone: '',
      },
    },
    integrationDraftProvenance: {},
    librarySettings: {
      settings: null,
      draft: null,
      loaded: false,
      loading: false,
      loadPromise: null,
      saveBusy: false,
      error: '',
    },
    appearanceKey: 'seekbar',
  },
  player: {
    streaming: {
      mode: 'stopped',
      generation: 0,
      context: null,
      node: null,
      socket: null,
      preparePromise: null,
      stopPromise: null,
      lifecycleEpoch: 0,
      expectedSocketClose: null,
      deferredCreditFrames: { current: 0, continuity: 0 },
      roles: { current: null, continuity: null },
      limits: { currentSeconds: 12, continuitySeconds: 5 },
      snapshot: {
        currentTime: 0,
        duration: 0,
        paused: true,
        ended: false,
        src: '',
        readyState: 0,
      },
      diagnostics: {
        firstFrameAtMs: 0,
        bufferedFrames: { current: 0, continuity: 0 },
        inFlightFrames: { current: 0, continuity: 0 },
        underruns: 0,
        staleMessages: 0,
        activeRoles: [],
        boundaryCapture: null,
      },
    },
    current: null,
    playbackQueue: null,
    lastKnownWasPlaying: false,
    appearance: {
      seekbarMode: 'default',
      waveformFillColor: '#5b8f8e',
      waveformEdgeColor: '#c8ddd5',
    },
    waveform: {
      renderToken: 0,
      compactPeaks: null,
    },
    restoredFromStorage: false,
    lastPersistedSnapshot: '',
    coverLoadId: 0,
    loopActive: false,
    loopStart: 0,
    loopEnd: 30,
    loopReturnTime: 0,
    loopWasPlaying: false,
    timelineDragging: false,
    saveBusy: false,
    listenSession: null,
    ownership: {
      tabId: '',
      lockStatus: 'unlocked',
      blockedReason: '',
      mirroredTrack: null,
      activeClaim: null,
      channel: null,
      heartbeatTimer: 0,
      initialized: false,
    },
  },
  tagEditor: {
    album: null,
    tracks: [],
    selectedPaths: [],
    anchorPath: '',
    dragSelecting: false,
    dragAnchorPath: '',
    values: {},
  },
  coverLookup: {
    drawerOpen: false,
    tasks: [],
    pollingTimer: 0,
    selectionTimer: 0,
    taskOpenSelectionGesture: null,
    suppressOpenTaskId: '',
    optimisticAlbumCovers: {},
    tasksSnapshot: '',
    appliedTaskUpdateSignatures: {},
    modal: {
      album: null,
      taskId: '',
      remoteCover: null,
      localCovers: [],
      pastedImages: [],
      otherArt: [],
      pendingLocalPath: '',
      pendingPastedImageId: '',
      selectedRemoteId: '',
      possibleMatches: [],
      candidateSnapshot: null,
      candidateGeneration: '',
      activeLocalSelectionPath: '',
      remoteSelectionOverrideGeneration: '',
      seenCandidateImprovementToken: '',
      statusText: '',
      statusTone: 'neutral',
      loading: false,
      pendingDeletePath: '',
      manualUrlText: '',
      manualBusy: false,
    },
  },
  modalReleases: [],
  modalReleaseIndex: 0,
  modalDuplicateSourceIndices: {},
  modalVersionContextMenu: {
    albumKey: '',
    x: 0,
    y: 0,
    visible: false,
  },
  versionPicker: {
    album: null,
    selectedTargetKey: '',
    saving: false,
  },
};

const ALBUM_MENU_LOG_PREFIX = '[AlbumHaven][AlbumContextMenu]';
const PLAYER_STATE_STORAGE_KEY = 'albumhaven.playerState.v1';


function getDetectedBrowserTimeZone() {
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().timeZone || '').trim();
  } catch (_error) {
    return '';
  }
}

function getSupportedBrowserTimeZones() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      const zones = Intl.supportedValuesOf('timeZone');
      if (Array.isArray(zones) && zones.length) {
        return zones.map((value) => String(value || '').trim()).filter(Boolean);
      }
    }
  } catch (_error) {
    // Fall back to a small durable set when the runtime does not expose the full list.
  }
  return [
    'UTC',
    'America/Los_Angeles',
    'America/Denver',
    'America/Chicago',
    'America/New_York',
    'America/Phoenix',
    'Europe/London',
    'Europe/Berlin',
    'Asia/Tokyo',
    'Australia/Sydney',
  ];
}

function getPreferredUserTimeZone() {
  const draftTimeZone = String(state?.utility?.integrationDrafts?.lastfm?.timezone || '').trim();
  if (draftTimeZone) return draftTimeZone;
  const integrations = Array.isArray(state?.utility?.integrations) ? state.utility.integrations : [];
  const lastfm = integrations.find((item) => String(item?.key || '') === 'lastfm');
  const savedTimeZone = String(lastfm?.user_timezone || '').trim();
  if (savedTimeZone) return savedTimeZone;
  return getDetectedBrowserTimeZone();
}


function renderSidebar() {
  const el = document.getElementById('sidebar-list');
  const v = state.view;
  if (!el) return;
  const sidebarOverride = Array.isArray(state.gallery.sidebarArtistsOverride) ? state.gallery.sidebarArtistsOverride : null;
  const sidebarShowAllArtistsOverride = Object.prototype.hasOwnProperty.call(state.gallery, 'sidebarShowAllArtistsOverride')
    ? state.gallery.sidebarShowAllArtistsOverride
    : null;
  const sidebarArtists = resolveSidebarArtists(v, sidebarOverride);
  const pendingSidebarSelectedArtist = String(state.ui.pendingSidebarSelectedArtist || '').trim();
  const usePendingSidebarSelection = (
    pendingSidebarSelectedArtist
    || Boolean(state.ui.pendingSidebarAllArtistsActive)
  );
  const effectiveView = state.ui.scanPageReturnContext
    ? {
      ...v,
      selected_artist: '',
      all_artists_active: false,
    }
    : usePendingSidebarSelection
    ? {
      ...v,
      selected_artist: pendingSidebarSelectedArtist,
      all_artists_active: Boolean(state.ui.pendingSidebarAllArtistsActive),
    }
    : v;
  const effectiveSurface = typeof resolveViewSurface === 'function'
    ? resolveViewSurface(effectiveView)
    : String(effectiveView?.surface?.active || '').trim().toLowerCase();
  const effectiveAllArtistsActive = Boolean(
    !state.ui.scanPageReturnContext
    && effectiveSurface === 'albums'
    && (
      effectiveView.all_artists_active
      || (!String(effectiveView.query || '').trim() && !String(effectiveView.selected_artist || '').trim())
    )
  );
  const sidebarRenderOptions = {
    view: effectiveView,
    usingSidebarOverride: Boolean(sidebarOverride && sidebarOverride.length),
    showAllArtistsOverride: sidebarOverride ? sidebarShowAllArtistsOverride : null,
    selectedArtistOverride: effectiveView.selected_artist,
    allArtistsActiveOverride: effectiveAllArtistsActive,
  };
  const structureSignature = buildSidebarStructureSignature(sidebarArtists, sidebarRenderOptions);
  if (el.dataset.sidebarStructureSignature === structureSignature) {
    applySidebarSelectionMarkup(el, sidebarRenderOptions);
  } else {
    el.innerHTML = buildSidebarHtml(v, sidebarArtists, sidebarRenderOptions);
    el.dataset.sidebarStructureSignature = structureSignature;
  }
  el.albumHavenSidebarArtistsSource = sidebarArtists;
  el.albumHavenSidebarShowAllArtists = sidebarRenderOptions.showAllArtistsOverride !== null
    ? Boolean(sidebarRenderOptions.showAllArtistsOverride)
    : v.show_all_artists_sidebar_link !== false;
  el.albumHavenActiveSidebarLink = el.querySelector('.artist-link.active');
  scheduleBrowserAnimationFrame(() => {
    const activeLink = el.querySelector('.artist-link.active');
    if (activeLink instanceof HTMLElement) {
      const scrollContainer = el.closest('.sidebar');
      if (!(scrollContainer instanceof HTMLElement)) return;
      const pendingRevealArtist = String(state.ui.pendingSidebarRevealArtist || '');
      if (pendingRevealArtist && pendingRevealArtist === String(v.selected_artist || '')) {
        const activeRect = activeLink.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();
        const player = document.querySelector('.global-player');
        const playerRect = player instanceof HTMLElement ? player.getBoundingClientRect() : null;
        const safeTop = containerRect.top + 8;
        const safeBottom = Math.min(
          containerRect.bottom - 8,
          playerRect ? playerRect.top - 8 : containerRect.bottom - 8,
        );
        const visibleHeight = Math.max(
          activeRect.height,
          safeBottom - safeTop,
        );
        const desiredActiveTop = safeTop
          + Math.max(0, (visibleHeight - activeRect.height) / 2);
        const centeredTop = scrollContainer.scrollTop
          + (activeRect.top - desiredActiveTop);
        const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        scrollContainer.scrollTop = Math.max(0, Math.min(centeredTop, maxScrollTop));
        state.ui.pendingSidebarRevealArtist = '';
        return;
      }
      const activeRect = activeLink.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      const player = document.querySelector('.global-player');
      const playerRect = player instanceof HTMLElement ? player.getBoundingClientRect() : null;
      const bottomOverlap = playerRect ? Math.max(0, containerRect.bottom - playerRect.top) : 0;
      if (bottomOverlap <= 0) return;
      const safeBottom = containerRect.bottom - bottomOverlap - 8;
      if (activeRect.bottom <= safeBottom) return;
      const overflow = activeRect.bottom - safeBottom;
      const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      scrollContainer.scrollTop = Math.max(0, Math.min(scrollContainer.scrollTop + overflow, maxScrollTop));
    }
  });
}

function setDomPropertyIfChanged(element, property, value) {
  if (element && element[property] !== value) {
    element[property] = value;
  }
}

function renderLibraryLoader(data = {}, options = {}) {
  const loader = document.getElementById('library-loader');
  const spinner = loader?.querySelector('.library-loader-spinner');
  const title = document.getElementById('library-loader-title');
  const status = document.getElementById('library-loader-status');
  const progress = document.getElementById('library-loader-progress');
  const actions = document.getElementById('library-loader-actions');
  const browseButton = document.getElementById('library-loader-browse-button');
  const cancelButton = document.getElementById('library-loader-cancel-button');
  const backButton = document.getElementById('library-loader-back-button');
  const phaseGuide = document.getElementById('library-loader-phase-guide');
  const scroll = document.getElementById('albums-scroll');
  if (!loader || !title || !status || !progress || !scroll || !spinner || !browseButton) return;

  const scanBusy = Boolean(data.scan_in_progress)
    && String(data.scan_phase || '').trim().toLowerCase() !== 'finalizing';
  const relBusy = Boolean(data.relations_in_progress);
  const coverBusy = Boolean(data.covers_in_progress);
  const scanPageVisible = Boolean(options.scanPageVisible || state.ui.scanPageReturnContext);
  const forcedScanPageVisible = Boolean(state.ui.forceScanPageVisible) && (scanBusy || relBusy || state.awaitingInitialDataRefresh);
  const hasSearch = Boolean((state.view?.query || '').trim() || (state.view?.selected_artist || '').trim());
  const pendingViewTransition = Boolean(state.ui.pendingViewTransition);
  const isLoadingState = scanBusy || relBusy || state.awaitingInitialDataRefresh || pendingViewTransition;
  const shouldShow = shouldShowLibraryLoader(state.view, data, {
    scanPageVisible,
    forceScanPageVisible: forcedScanPageVisible,
    awaitingInitialDataRefresh: state.awaitingInitialDataRefresh,
    pendingViewTransition,
  });
  const finalizingActiveScan = scanPageVisible
    && Boolean(data.scan_in_progress)
    && String(data.scan_phase || '').trim().toLowerCase() === 'finalizing';
  const canBrowseScanned = shouldShow
    && !pendingViewTransition
    && (
      finalizingActiveScan
      || shouldOfferBrowseScannedLibraryAction(state.view, data, state.awaitingInitialDataRefresh)
    );
  const canCancelScan = shouldShow && scanPageVisible && Boolean(data.scan_in_progress);
  setDomPropertyIfChanged(loader, 'hidden', !shouldShow);
  loader.classList?.toggle('is-scan-page', scanPageVisible);
  setDomPropertyIfChanged(scroll, 'hidden', shouldShow);
  setDomPropertyIfChanged(backButton, 'hidden', !scanPageVisible);
  setDomPropertyIfChanged(phaseGuide, 'hidden', !scanPageVisible);
  setDomPropertyIfChanged(browseButton, 'hidden', !canBrowseScanned);
  setDomPropertyIfChanged(
    browseButton,
    'disabled',
    Boolean(canBrowseScanned && (state.busy || state.ui.browseScannedResultsLoading)),
  );
  setDomPropertyIfChanged(browseButton, 'textContent', 'Browse Library');
  if (cancelButton) {
    setDomPropertyIfChanged(cancelButton, 'hidden', !canCancelScan);
    setDomPropertyIfChanged(
      cancelButton,
      'disabled',
      Boolean(canCancelScan && state.ui.scanCancellationPending),
    );
    setDomPropertyIfChanged(
      cancelButton,
      'textContent',
      canCancelScan && String(data.scan_mode || '') === 'manual_full_rescan'
        ? 'Cancel Full Rescan'
        : 'Cancel Scan',
    );
  }
  setDomPropertyIfChanged(
    actions,
    'hidden',
    Boolean(browseButton.hidden && (!cancelButton || cancelButton.hidden)),
  );
  if (!shouldShow) return;

  if (hasSearch && !isLoadingState && !forcedScanPageVisible && !scanPageVisible) {
    spinner.hidden = true;
    title.textContent = 'Nothing found';
    status.textContent = 'No artists, albums, or tracks matched your search.';
    progress.innerHTML = '';
    browseButton.hidden = true;
    if (actions) actions.hidden = Boolean(!cancelButton || cancelButton.hidden);
    return;
  }

  spinner.hidden = Boolean(scanPageVisible && !(scanBusy || relBusy || coverBusy));
  const lines = buildLoaderStatusLines(data, {
    scanPageVisible,
    pendingViewTransition: pendingViewTransition && !scanPageVisible,
  });
  title.textContent = lines[0]?.title || 'Loading library';
  status.textContent = lines[0]?.detail || 'Preparing scan...';
  progress.innerHTML = lines.slice(1).map((line) => `
    <div class="library-loader-progress-line">
      <span class="library-loader-progress-title">${escapeHtml(line.title)}</span>
      <span class="library-loader-progress-detail">${escapeHtml(line.detail)}</span>
    </div>
  `).join('');
}

function renderRelated() {
  const box = document.getElementById('related-box');
  const toggle = document.getElementById('related-toggle');
  const wrap = document.getElementById('related-list-wrap');
  const list = document.getElementById('related-list');
  const related = state.view.related_artists || [];
  if (!box || !toggle || !wrap || !list) return;
  const contextualPane = state.view?.shell_layout?.slots?.contextual_pane || {};
  if (Object.prototype.hasOwnProperty.call(contextualPane, 'is_visible')) {
    box.dataset.shellIsVisible = contextualPane.is_visible ? 'true' : 'false';
  }
  if (Object.prototype.hasOwnProperty.call(contextualPane, 'active_pane')) {
    box.dataset.shellActivePane = String(contextualPane.active_pane || '');
  }
  if (Array.isArray(contextualPane.supported_panes)) {
    box.dataset.shellSupportedPanes = contextualPane.supported_panes.join(',');
  }
  const localTree = contextualPane.local_tree || {};
  if (Object.prototype.hasOwnProperty.call(localTree, 'active_submode')) {
    box.dataset.shellLocalTreeSubmode = String(localTree.active_submode || '');
  }
  if (
    state.ui.scanPageReturnContext
    || (state.busy && !state.ui.activeViewPayloadReady)
    || !state.view.selected_artist
    || !related.length
  ) {
    box.style.display = 'none';
    wrap.hidden = true;
    list.innerHTML = '';
    return;
  }
  box.style.display = 'block';
  box.classList.toggle('is-collapsed', !state.relatedExpanded);
  toggle.setAttribute('aria-expanded', state.relatedExpanded ? 'true' : 'false');
  wrap.hidden = !state.relatedExpanded;
  list.innerHTML = buildRelatedMarkup(state.view);
}

function applyLocalRelatedArtistFilter(nextRelatedArtists, options = {}) {
  const nextView = applyLocalRelatedFilterState(nextRelatedArtists, options);
  if (!nextView) return false;
  renderView();
  pushBrowserViewState(nextView);
  return true;
}
