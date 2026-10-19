function handleGalleryBootstrapClick(event) {
  const privateSidebarNode = event.target.closest('[data-sidebar-artist], [data-sidebar-all-artists="1"]');
  if (privateSidebarNode && (privateSidebarNode.albumHavenPrivateSearchView || state.view?.private_search === true)) {
    return handlePrivateSearchSidebarNavigation(event, privateSidebarNode);
  }
  if (typeof handleGalleryMainClick === 'function' && handleGalleryMainClick(event)) return;
  const removeMissingAlbumButton = event.target.closest('[data-remove-missing-album="1"]');
  if (removeMissingAlbumButton) {
    event.preventDefault();
    const album = resolveTrackModalActionAlbum(removeMissingAlbumButton);
    const runtimeOptions = typeof album?.constructor === 'function' ? new album.constructor() : {};
    runtimeOptions.source = 'album-details';
    void confirmMissingAlbumRemoval(album, runtimeOptions);
    return;
  }
  const ignoreVersionButton = event.target.closest('[data-ignore-version-context="1"]');
  if (ignoreVersionButton) {
    event.preventDefault();
    const menu = document.getElementById('track-modal-version-context-menu');
    ignoreAlbumVersion(menu?.dataset.albumKey || '');
    return;
  }

  if (!event.target.closest('#track-modal-version-context-menu')) {
    hideVersionContextMenu();
  }
  const toggleCombineSimilarArtistsButton = event.target.closest('[data-toggle-combine-similar-artists="1"]');
  if (toggleCombineSimilarArtistsButton && !toggleCombineSimilarArtistsButton.disabled) {
    event.preventDefault();
    const artist = getCurrentGalleryPreferenceArtist();
    if (artist) {
      setCombineSimilarArtistsPreference(artist, !getCombineSimilarArtistsPreference(artist));
      renderGalleryOptionsMenu();
      renderArtistGroups({ preserveScroll: true });
    }
    return;
  }
  const openNonAlbumModalButton = event.target.closest('[data-open-non-album-modal="1"]');
  if (openNonAlbumModalButton) {
    event.preventDefault();
    openNonAlbumModal();
    return;
  }

  const closeNonAlbumModalButton = event.target.closest('[data-close-non-album-modal="1"]');
  if (closeNonAlbumModalButton || overlayClickStartedOnOverlay(document.getElementById('non-album-modal'), event)) {
    event.preventDefault();
    closeNonAlbumModal();
    return;
  }

  const openNonAlbumTagEditorButton = event.target.closest('[data-open-non-album-tag-editor="1"]');
  if (openNonAlbumTagEditorButton) {
    event.preventDefault();
    openNonAlbumTagEditor();
    return;
  }

  const openTracklistButton = event.target.closest('[data-open-tracklist="1"]');
  if (openTracklistButton) {
    event.preventDefault();
    openTrackModalForButton(openTracklistButton);
    return;
  }

  const albumRow = event.target.closest('.album-card[data-gallery-display="list"]');
  if (albumRow && !event.target.closest('button, a, input, select, textarea, [role="button"]')) {
    const trigger = albumRow.querySelector('[data-open-tracklist="1"]');
    if (trigger) { event.preventDefault(); openTrackModalForButton(trigger); }
    return;
  }

  const relatedToggle = event.target.closest('#related-toggle');
  if (relatedToggle) {
    event.preventDefault();
    state.relatedExpanded = !state.relatedExpanded;
    renderRelated();
    return;
  }

  const trackModalFolderButton = event.target.closest('[data-open-track-modal-folder="1"]');
  if (trackModalFolderButton) {
    event.preventDefault();
    openAlbumInExplorer(resolveTrackModalActionAlbum(trackModalFolderButton));
    return;
  }

  const trackModalDuplicateFolderButton = event.target.closest('[data-open-track-modal-duplicate-folder="1"]');
  if (trackModalDuplicateFolderButton) {
    event.preventDefault();
    openAlbumInExplorer(resolveTrackModalDuplicateSourceAlbum(trackModalDuplicateFolderButton));
    return;
  }

  const trackModalEditTagsButton = event.target.closest('[data-open-track-modal-editor="1"]');
  if (trackModalEditTagsButton) {
    event.preventDefault();
    openTagEditor(resolveTrackModalActionAlbum(trackModalEditTagsButton), { tracksMode: 'all' });
    return;
  }

  const versionPickerOption = event.target.closest('[data-version-picker-target]');
  if (versionPickerOption) {
    event.preventDefault();
    state.versionPicker.selectedTargetKey = versionPickerOption.getAttribute('data-version-picker-target') || '';
    renderVersionPickerModal();
    return;
  }

  const closeVersionPickerButton = event.target.closest('[data-close-version-picker="1"]');
  if (closeVersionPickerButton || overlayClickStartedOnOverlay(document.getElementById('version-picker-modal'), event)) {
    event.preventDefault();
    closeVersionPickerModal();
    return;
  }

  const saveVersionPickerButton = event.target.closest('[data-save-version-picker="1"]');
  if (saveVersionPickerButton) {
    event.preventDefault();
    const sourceAlbum = state.versionPicker.album;
    const targetKey = String(state.versionPicker.selectedTargetKey || '');
    if (!sourceAlbum || !targetKey || state.versionPicker.saving) return;
    state.versionPicker.saving = true;
    renderVersionPickerModal();
    markAlbumVersion(sourceAlbum.key || '', targetKey)
      .then(() => {
        closeVersionPickerModal();
      })
      .catch(() => {
        state.versionPicker.saving = false;
        renderVersionPickerModal();
      });
    return;
  }

  const lightboxTrigger = event.target.closest('[data-open-lightbox="1"]');
  if (lightboxTrigger) {
    event.preventDefault();
    if (typeof getTrackModalContentRoot === 'function' && getTrackModalContentRoot()?.contains(lightboxTrigger)
      && typeof canViewTrackModalArtwork === 'function' && !canViewTrackModalArtwork()) return;
    const items = lightboxTrigger.getAttribute('data-lightbox-gallery') === 'visible'
      ? getLightboxGalleryItems()
      : [];
    openImageLightbox(
      lightboxTrigger.getAttribute('data-cover-src'),
      lightboxTrigger.getAttribute('data-cover-alt'),
      {
        items,
        sourceAlbumKey: getTrackModalLightboxSourceAlbumKey(lightboxTrigger),
        previewSrc: lightboxTrigger.getAttribute('data-cover-preview-src'),
      },
    );
    return;
  }

  const lightboxOverlay = event.target.closest('#image-lightbox');
  if (lightboxOverlay) {
    const closeButton = event.target.closest('#image-lightbox-close');
    const prevButton = event.target.closest('#image-lightbox-prev');
    const nextButton = event.target.closest('#image-lightbox-next');
    const image = event.target.closest('#image-lightbox-image');
    if (prevButton) {
      event.preventDefault();
      stepLightbox(-1);
      return;
    }
    if (nextButton) {
      event.preventDefault();
      stepLightbox(1);
      return;
    }
    if (closeButton || (!image && overlayClickStartedOnOverlay(lightboxOverlay, event))) {
      event.preventDefault();
      closeImageLightbox();
      return;
    }
  }

  const tabButton = event.target.closest('[data-track-tab-index]');
  if (tabButton) {
    event.preventDefault();
    const index = Number(tabButton.getAttribute('data-track-tab-index'));
    if (Number.isInteger(index) && state.modalReleases[index]) {
      state.modalReleaseIndex = index;
      hideVersionContextMenu();
      openTrackModal(state.modalReleases[index], {
        coverLightboxGallery: state.ui.trackModalCoverLightboxGallery !== false,
        releaseSet: { releases: state.modalReleases.slice(), selectedIndex: index },
      });
    }
    return;
  }

  const fullRescanAction = event.target.closest('[data-status-action="full-rescan"]');
  if (fullRescanAction) {
    event.preventDefault();
    hideStatusContextMenu();
    triggerLibraryRefresh(true);
    return;
  }

  const goToScanPageAction = event.target.closest('[data-status-action="go-to-scan-page"]');
  if (goToScanPageAction) {
    event.preventDefault();
    hideStatusContextMenu();
    openScanPage();
    return;
  }

  const fetchCoversAction = event.target.closest('[data-status-action="fetch-covers"]');
  if (fetchCoversAction) {
    event.preventDefault();
    hideStatusContextMenu();
    fetchUnsuccessfulAlbumCovers();
    return;
  }

  const cancelCoverScanAction = event.target.closest('[data-status-action="cancel-cover-scan"]');
  if (cancelCoverScanAction) {
    event.preventDefault();
    hideStatusContextMenu();
    cancelAlbumCoverScan();
    return;
  }

  const indicator = event.target.closest('#scan-indicator');
  if (indicator) {
    event.preventDefault();
    hideStatusContextMenu();
    if (
      indicator.classList.contains('is-busy')
      || state.status?.scan_in_progress
      || state.status?.relations_in_progress
      || state.status?.covers_in_progress
    ) {
      return;
    }
    triggerLibraryRefresh();
    return;
  }

  const allArtistsLink = event.target.closest('[data-sidebar-all-artists="1"]');
  if (allArtistsLink) {
    event.preventDefault();
    invalidateAdvancedSearchIntent('sidebar-navigation');
    if (typeof deferAppFormPageReplacement === 'function'
      && deferAppFormPageReplacement(() => handleGalleryBootstrapClick(event))) return;
    const activeSearchQuery = String(state.view?.query || '').trim();
    clearPendingGallerySearchCommit();
    invalidateAdvancedSearchIntent('sidebar-query');
    updateGallerySearchDraftQuery(activeSearchQuery);
    state.ui.pendingSearchClearOnBlur = false;
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = activeSearchQuery;
    closeRecentSearchPopover();
    releasePendingGallerySearchSuspensions();
    let coverLoadSuspensionToken = 0;
    if (
      typeof virtualGrid !== 'undefined'
      && virtualGrid
      && typeof virtualGrid.suspendSelectedArtistCoverLoadsForUserAction === 'function'
    ) {
      coverLoadSuspensionToken = virtualGrid.suspendSelectedArtistCoverLoadsForUserAction();
    }
    const resumeCoverLoads = (requestResult = true, force = false) => {
      if (
        !force
        && requestResult === false
        && (Boolean(state.ui?.activeViewRequestController) || Boolean(state.ui?.pendingViewRequest))
      ) {
        scheduleBrowserTimeout(() => resumeCoverLoads(false), 16);
        return;
      }
      if (
        typeof virtualGrid !== 'undefined'
        && virtualGrid
        && typeof virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction === 'function'
      ) {
        virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(coverLoadSuspensionToken);
      }
    };
    closeArtistsDrawer({ restoreFocus: false });
    const nextView = {
      ...state.view,
      query: state.view.query || '',
      selected_artist: '',
      all_artists_active: true,
      related_filter_artists: [],
      primary_filter_active: false,
    };
    state.gallery.sidebarArtistsOverride = null;
    state.gallery.sidebarShowAllArtistsOverride = null;
    state.ui.pendingSidebarSelectedArtist = '';
    state.ui.pendingSidebarAllArtistsActive = true;
    const reusableRootBrowseView = typeof getReusableRootBrowseView === 'function'
      ? getReusableRootBrowseView(nextView)
      : null;
    if (reusableRootBrowseView) {
      applyViewPayload(reusableRootBrowseView, { trackSidebarReveal: false });
      pushBrowserViewState(nextView);
      renderSidebar();
      renderRelated();
      renderLibraryLoader(state.status);
      scheduleBrowserAnimationFrame(() => {
        renderArtistGroups({ preserveScroll: true });
      });
      Promise.resolve(fetchAndRender(buildApiUrl(nextView, {
        omitSidebar: true,
      }), false, {
        preserveScroll: true,
      })).then(resumeCoverLoads, () => resumeCoverLoads(true, true));
      return;
    }
    renderSidebar();
    Promise.resolve(fetchAndRender(buildApiUrl(nextView, {
      omitSidebar: true,
    }), true)).then(resumeCoverLoads, () => resumeCoverLoads(true, true));
    return;
  }

  const duplicateSourceTabButton = event.target.closest('[data-track-duplicate-source-index]');
  if (duplicateSourceTabButton) {
    event.preventDefault();
    const index = Number(duplicateSourceTabButton.getAttribute('data-track-duplicate-source-index'));
    const album = state.modalReleases[state.modalReleaseIndex] || null;
    const duplicateSources = Array.isArray(album?.duplicate_sources) ? album.duplicate_sources : [];
    if (album && Number.isInteger(index) && index >= 0 && index < duplicateSources.length) {
      setTrackModalDuplicateSourceIndex(album.key || '', index);
      renderTrackModalRelease(album);
    }
    return;
  }

  const relatedChip = event.target.closest('[data-related-artist]');
  if (relatedChip) {
    event.preventDefault();
    const artist = relatedChip.getAttribute('data-related-artist') || '';
    const activeArtists = new Set(Array.isArray(state.view.related_filter_artists) ? state.view.related_filter_artists : []);
    if (activeArtists.has(artist)) activeArtists.delete(artist);
    else activeArtists.add(artist);
    const nextView = {
      ...state.view,
      related_filter_artists: [...activeArtists],
      primary_filter_active: false,
    };
    const localFilterOptions = activeArtists.size
      ? { primary_filter_active: false }
      : {};
    if (applyLocalRelatedArtistFilter(
      nextView.related_filter_artists,
      localFilterOptions,
    )) return;
    fetchAndRender(buildUrl(nextView), true);
    return;
  }

  const relatedPrimaryChip = event.target.closest('[data-related-primary="1"]');
  if (relatedPrimaryChip) {
    event.preventDefault();
    const nextPrimaryFilterActive = !Boolean(state.view.primary_filter_active);
    const nextView = {
      ...state.view,
      primary_filter_active: nextPrimaryFilterActive,
    };
    if (applyLocalRelatedArtistFilter(nextView.related_filter_artists, {
      primary_filter_active: nextPrimaryFilterActive,
    })) {
      return;
    }
    fetchAndRender(buildUrl(nextView), true);
    return;
  }

  const link = event.target.closest('a[data-nav="1"]');
  if (link) {
    event.preventDefault();
    fetchAndRender(link.href, true);
  }
  return false;
}

function getStableLightboxZoomOrigin(lightboxImage, clientX, clientY) {
  let basisRect = state.lightbox.zoomBasisRect;
  if (
    !basisRect
    || !(basisRect.width > 0)
    || !(basisRect.height > 0)
    || state.lightbox.zoom <= 1
  ) {
    const rect = lightboxImage.getBoundingClientRect();
    basisRect = {
      left: Number(rect.left || 0),
      top: Number(rect.top || 0),
      width: Number(rect.width || 0),
      height: Number(rect.height || 0),
    };
    state.lightbox.zoomBasisRect = basisRect;
  }
  const zoom = Math.max(1, Number(state.lightbox.zoom || 1));
  const panX = Number(state.lightbox.panX || 0);
  const panY = Number(state.lightbox.panY || 0);
  const priorOriginX = Number(state.lightbox.zoomOriginX ?? 50);
  const priorOriginY = Number(state.lightbox.zoomOriginY ?? 50);
  const targetLeft = basisRect.left
    + panX
    + ((basisRect.width * priorOriginX) / 100) * (1 - zoom);
  const targetTop = basisRect.top
    + panY
    + ((basisRect.height * priorOriginY) / 100) * (1 - zoom);
  const targetWidth = basisRect.width * zoom;
  const targetHeight = basisRect.height * zoom;
  const originX = targetWidth > 0
    ? ((Number(clientX || 0) - targetLeft) / targetWidth) * 100
    : 50;
  const originY = targetHeight > 0
    ? ((Number(clientY || 0) - targetTop) / targetHeight) * 100
    : 50;
  return {
    originX: Math.round(Math.min(100, Math.max(0, originX)) * 1000000) / 1000000,
    originY: Math.round(Math.min(100, Math.max(0, originY)) * 1000000) / 1000000,
  };
}

function handlePrivateSearchSidebarNavigation(event, node) {
  event.preventDefault();
  const runtime = window.AlbumHavenSearchRuntime;
  if (runtime?.sidebarNodeIsCurrent(node) !== true) return true;
  invalidateAdvancedSearchIntent('sidebar-navigation');
  if (typeof deferAppFormPageReplacement === 'function'
    && deferAppFormPageReplacement(() => handlePrivateSearchSidebarNavigation(event, node))) return true;
  if (runtime.sidebarNodeIsCurrent(node) !== true) return true;
  const allArtists = node.getAttribute('data-sidebar-all-artists') === '1';
  const nextView = {...state.view, selected_artist: allArtists ? '' : node.getAttribute('data-sidebar-artist'),
    all_artists_active: allArtists, related_filter_artists: [], primary_filter_active: false};
  const url = new URL(buildApiUrl(nextView), window.location.href);
  url.searchParams.set('search_presentation', state.view.search_presentation);
  closeArtistsDrawer({restoreFocus: false});
  if (runtime.sidebarNodeIsCurrent(node) !== true) return true;
  // Both native handlers use this same current-node path. The native foreground
  // owner obtains a fresh selected/all page; no prior cursor or source is reused.
  fetchAndRender(`${url.pathname}${url.search}`, true);
  return true;
}

function handleSidebarArtistSelectionClick(event) {
  const sidebarArtistLink = event.target.closest('[data-sidebar-artist]');
  if (!sidebarArtistLink) return false;
  if (sidebarArtistLink.albumHavenPrivateSearchView || state.view?.private_search === true) {
    return handlePrivateSearchSidebarNavigation(event, sidebarArtistLink);
  }

  event.preventDefault();
  invalidateAdvancedSearchIntent('sidebar-navigation');
  if (typeof deferAppFormPageReplacement === 'function'
    && deferAppFormPageReplacement(() => handleSidebarArtistSelectionClick(event))) return true;
  if (
    state.ui.scanPageReturnContext
    || state.ui.forceScanPageVisible
  ) {
    abandonScanPageForNavigation();
  }
  hideVersionContextMenu();
  if (state.gallery.menuOpen) {
    hideGalleryOptionsMenu();
  }
  document.querySelectorAll('.utility-loop-speed-menu').forEach((menu) => {
    menu.hidden = true;
  });
  if (state.utility?.problemDropdownOpen) {
    state.utility.problemDropdownOpen = false;
    renderUtilityModalContent();
  }
  if (state.coverLookup?.drawerOpen) {
    state.coverLookup.drawerOpen = false;
    renderCoverLookupDrawer();
    stopCoverLookupPollingIfIdle();
  }
  closeArtistsDrawer({ restoreFocus: false });
  const artist = sidebarArtistLink.getAttribute('data-sidebar-artist') || '';
  const usingSidebarOverride = Array.isArray(state.gallery.sidebarArtistsOverride)
    && state.gallery.sidebarArtistsOverride.length > 0;
  if (!usingSidebarOverride) {
    state.gallery.sidebarArtistsOverride = Array.isArray(state.view.artists_sidebar)
      ? state.view.artists_sidebar
      : [];
    state.gallery.sidebarShowAllArtistsOverride = state.view.show_all_artists_sidebar_link !== false;
  }
  state.ui.pendingSidebarSelectedArtist = artist;
  state.ui.pendingSidebarAllArtistsActive = false;
  const currentSelectedArtist = String(state.view?.selected_artist || '').trim();
  const primaryArtistChanged = String(artist || '').trim() !== currentSelectedArtist;
  const activeSearchQuery = String(state.view?.query || '').trim();
  const previousGalleryMainState = state.gallery.mainState;
  const previousAlbumTypes = new Set(previousGalleryMainState?.albumTypes || ['studio', 'ep']);
  const galleryFiltersWereCustomized = Boolean(previousGalleryMainState && (
    Object.values(previousGalleryMainState.sources || {}).some((enabled) => enabled === false)
    || previousAlbumTypes.size !== 2
    || !previousAlbumTypes.has('studio')
    || !previousAlbumTypes.has('ep')
    || previousGalleryMainState.familySelectionExplicit === true
    || (previousGalleryMainState.familyArtists || []).length
  ));
  if (primaryArtistChanged) {
    clearPendingSelectedArtistReconcile();
    clearPendingGallerySearchCommit();
    updateGallerySearchDraftQuery(activeSearchQuery);
    state.ui.pendingSearchClearOnBlur = false;
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = activeSearchQuery;
    closeRecentSearchPopover();
    releasePendingGallerySearchSuspensions();
    state.gallery.mainState = resetGalleryMainStateForPrimaryArtist(
      state.gallery.mainState || {},
    );
  }
  const nextView = {
    ...state.view,
    query: state.view.query,
    selected_artist: artist,
    all_artists_active: false,
    visible_library_categories: primaryArtistChanged && !(typeof isMobileClient === 'function' && isMobileClient())
      ? ['main_library', 'new_arrivals', 'hoard']
      : state.view.visible_library_categories,
    related_filter_artists: [],
    primary_filter_active: false,
    search_context: state.view.search_context,
    ...(activeSearchQuery ? {
      search_context: {
        ...(state.view?.search_context && typeof state.view.search_context === 'object'
          ? state.view.search_context
          : {}),
        selected_artist: artist,
        selected_artist_source: 'requested_artist',
      },
    } : {}),
  };
  const sidebarSelectionUpdated = applyImmediateSidebarArtistSelection(sidebarArtistLink, artist);
  const currentRelatedArtists = Array.isArray(state.view?.related_artists)
    ? state.view.related_artists
    : [];
  const currentFamilyGroups = Array.isArray(state.view?.family_artist_groups)
    ? state.view.family_artist_groups
    : [];
  const hasCurrentFamilyContext = Boolean(
    currentSelectedArtist
    && (currentRelatedArtists.length || currentFamilyGroups.length)
  );
  const currentFamilyArtistNames = new Set([
    currentSelectedArtist,
    ...currentRelatedArtists,
    ...(Array.isArray(state.view?.primary_artist_groups) ? state.view.primary_artist_groups : [])
      .map((group) => String(group?.artist || group?.artist_display || '').trim()),
    ...currentFamilyGroups
      .map((group) => String(group?.artist || group?.artist_display || '').trim()),
  ].filter(Boolean));
  const isUnrelatedFamilyTransition = Boolean(
    hasCurrentFamilyContext
    && !currentFamilyArtistNames.has(String(artist || '').trim())
  );
  if (!isUnrelatedFamilyTransition && tryRenderOptimisticSidebarArtistSelection(nextView, {
    forceFetch: primaryArtistChanged && galleryFiltersWereCustomized,
  })) {
    resumeScanPageGalleryCoverLoads();
    return true;
  }
  if (isUnrelatedFamilyTransition) {
    applyViewPayload({
      ...nextView,
      related_artists: [],
      primary_artist_groups: [],
      family_artist_groups: [],
      artist_groups: [],
      artist_count: 0,
      album_count: 0,
    }, {
      trackSidebarReveal: false,
    });
    renderView({
      preserveScroll: true,
      resetScrollForUserArtistSelection: true,
    });
  }
  fetchAndRender(buildApiUrl(nextView, {
    omitSidebar: true,
  }), true);
  if (!sidebarSelectionUpdated) {
    renderSidebar();
  }
  return true;
}

function applyImmediateSidebarArtistSelection(sidebarArtistLink, artist) {
  const sidebarList = typeof sidebarArtistLink?.closest === 'function'
    ? sidebarArtistLink.closest('#sidebar-list')
    : null;
  if (!sidebarList) return false;
  const sidebarOverride = Array.isArray(state.gallery.sidebarArtistsOverride)
    ? state.gallery.sidebarArtistsOverride
    : null;
  const sidebarArtists = resolveSidebarArtists(state.view, sidebarOverride);
  const showAllArtistsLink = sidebarOverride
    ? state.gallery.sidebarShowAllArtistsOverride !== false
    : state.view.show_all_artists_sidebar_link !== false;
  if (
    sidebarList.albumHavenSidebarArtistsSource !== sidebarArtists
    || sidebarList.albumHavenSidebarShowAllArtists !== showAllArtistsLink
  ) {
    return false;
  }

  const previousActiveLink = sidebarList.albumHavenActiveSidebarLink;
  if (previousActiveLink && previousActiveLink !== sidebarArtistLink) {
    previousActiveLink.classList?.remove('active');
    previousActiveLink.removeAttribute?.('aria-current');
  }
  sidebarArtistLink.classList?.add('active');
  sidebarArtistLink.setAttribute?.('aria-current', 'true');
  sidebarList.albumHavenActiveSidebarLink = sidebarArtistLink;
  state.ui.pendingSidebarSelectedArtist = artist;
  state.ui.pendingSidebarAllArtistsActive = false;
  return true;
}

function handleGalleryBootstrapWheel(event) {
  const lightboxImage = event.target.closest('#image-lightbox-image');
  if (!lightboxImage) return;
  const overlay = document.getElementById('image-lightbox');
  if (!overlay || overlay.hidden) return;

  event.preventDefault();
  const { originX, originY } = getStableLightboxZoomOrigin(
    lightboxImage,
    event.clientX,
    event.clientY,
  );
  const direction = event.deltaY < 0 ? 1 : -1;
  const step = state.lightbox.zoom < 2 ? 0.2 : 0.35;
  setLightboxZoom(state.lightbox.zoom + (direction * step), { originX, originY });
}

function handleGalleryBootstrapPointerDown(event) {
  const lightboxImage = event.target.closest('#image-lightbox-image');
  if (!lightboxImage || state.lightbox.zoom <= 1) return;
  event.preventDefault();
  startLightboxDrag(event);
  return true;
}

function handleGalleryBootstrapPointerMove(event) {
  updateLightboxDrag(event);
  if (String(event?.pointerType || '').toLowerCase() !== 'mouse') return;
  const albumCard = event.target?.closest?.('.album-card');
  if (!albumCard) return;
  const detailsButton = albumCard.querySelector(
    '.album-title-button[data-open-tracklist="1"][data-album-key]',
  );
  const albumKey = String(detailsButton?.getAttribute('data-album-key') || '').trim();
  if (albumKey && typeof queueTrackModalAlbumDetailsPrewarm === 'function') {
    queueTrackModalAlbumDetailsPrewarm(albumKey);
  }
}

function handleGalleryBootstrapPointerUp() {
  stopLightboxDrag();
}

function handleGalleryBootstrapPointerCancel() {
  stopLightboxDrag();
}

const SEARCH_COMMIT_DEBOUNCE_MS = 150;
const RECENT_SEARCH_STORAGE_KEY = 'albumhaven.recentSearches.v1';
const RECENT_SEARCH_LIMIT = 8;
const CACHED_SELECTED_ARTIST_RECONCILE_DELAY_MS = 1200;

function ensureRecentSearchState() {
  if (!state.ui || typeof state.ui !== 'object') return null;
  if (!Array.isArray(state.ui.recentSearchQueries)) state.ui.recentSearchQueries = [];
  if (typeof state.ui.recentSearchesLoaded !== 'boolean') state.ui.recentSearchesLoaded = false;
  if (typeof state.ui.recentSearchPopoverOpen !== 'boolean') state.ui.recentSearchPopoverOpen = false;
  if (!Number.isInteger(state.ui.recentSearchActiveIndex)) state.ui.recentSearchActiveIndex = -1;
  return state.ui;
}

let recentSearchTransport = null;
let unsubscribeRecentSearchTransport = null;
let recentSearchShell = null;
let recentSearchObserver = null;

// Shell identity and transport stamps provide continuity, not authorization.
function getRecentSearchScope() {
  const shell = document.getElementById('app-shell');
  const account = shell?.dataset?.nativeAccountId;
  const library = shell?.dataset?.nativeLibraryId;
  if (!account || !library || !recentSearchTransport) return null;
  try {
    const context = recentSearchTransport.context();
    const identity = JSON.stringify([account, library, context]);
    return {storageKey: `${RECENT_SEARCH_STORAGE_KEY}:${identity}`,
      continuity: JSON.stringify([identity, recentSearchTransport.generation()])};
  } catch (_error) {
    return null;
  }
}

function syncRecentSearchScope(records = []) {
  const ui = ensureRecentSearchState();
  if (!ui) return null;
  // Install only when the existing history owner is used: the shared transport
  // is declared later in the production bundle.
  const transport = window.AlbumHavenPrivateUITransport || null;
  const shell = document.getElementById('app-shell');
  let retired = transport !== recentSearchTransport || shell !== recentSearchShell;
  if (transport !== recentSearchTransport) {
    unsubscribeRecentSearchTransport?.();
    recentSearchTransport = transport;
    unsubscribeRecentSearchTransport = transport?.subscribe(syncRecentSearchScope) || null;
  }
  if (shell !== recentSearchShell) {
    recentSearchObserver?.disconnect();
    recentSearchShell = shell;
    recentSearchObserver = shell && typeof MutationObserver === 'function'
      ? new MutationObserver(syncRecentSearchScope) : null;
    recentSearchObserver?.observe(shell, {attributes: true, attributeOldValue: true,
      attributeFilter: ['data-native-account-id', 'data-native-library-id', 'data-private-ui-context']});
  }
  // Drain already-observed transitions before admitting another intent. A batched
  // A-to-B-to-A transition must retire A even when its final stamp is unchanged.
  const mutations = [...records, ...(recentSearchObserver?.takeRecords?.() || [])];
  retired ||= mutations.some(record => record.oldValue !== record.target.getAttribute(record.attributeName));
  const scope = getRecentSearchScope();
  const continuity = scope?.continuity || null;
  if (retired || !Object.prototype.hasOwnProperty.call(ui, 'recentSearchScope')
      || (ui.recentSearchScope?.continuity || null) !== continuity) {
    const previous = ui.recentSearchScope;
    ui.recentSearchScope = scope;
    ui.recentSearchQueries = [];
    ui.searchSuggestionItems = [];
    ui.searchSuggestionSnapshot = null;
    ui.searchComposing = false;
    invalidateAdvancedSearchIntent('scope-loss');
    ui.recentSearchesLoaded = false;
    ui.recentSearchPopoverOpen = false;
    ui.recentSearchActiveIndex = -1;
    const {input, popover} = getRecentSearchElements();
    if (popover) {popover.innerHTML = ''; popover.hidden = true;}
    input?.setAttribute('aria-expanded', 'false');
    input?.removeAttribute('aria-activedescendant');
    if (typeof galleryMainSurfaceController !== 'undefined'
        && galleryMainSurfaceController?.isOpen?.('search-suggestions')) {
      closeGalleryMainSurface(false);
    }
    if (previous && ui.pendingRecentSearchCommitScope === previous) {
      clearPendingGallerySearchCommit();
      releasePendingGallerySearchSuspensions();
    }
  }
  return ui.recentSearchScope;
}

function normalizeRecentSearchQueries(queries) {
  const normalized = [];
  const seen = new Set();
  for (const query of Array.isArray(queries) ? queries : []) {
    const value = String(query || '').trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
    if (normalized.length >= RECENT_SEARCH_LIMIT) break;
  }
  return normalized;
}

function readRecentSearchQueries() {
  const ui = ensureRecentSearchState();
  const scope = syncRecentSearchScope();
  if (!ui || !scope) return [];
  if (!ui.recentSearchesLoaded) {
    const storedValue = getSessionStorageItem(scope.storageKey, '');
    if (storedValue) {
      try {
        ui.recentSearchQueries = normalizeRecentSearchQueries(JSON.parse(storedValue));
      } catch (_error) {
        ui.recentSearchQueries = [];
        if (typeof removeSessionStorageItem === 'function') {
          removeSessionStorageItem(scope.storageKey);
        }
      }
    }
    ui.recentSearchesLoaded = true;
  }
  return [...ui.recentSearchQueries];
}

function recordRecentSearchQuery(query) {
  const value = String(query || '').trim();
  if (!value) return false;
  const ui = ensureRecentSearchState();
  const scope = syncRecentSearchScope();
  if (!ui || !scope) return false;
  const key = value.toLocaleLowerCase();
  ui.recentSearchQueries = [
    value,
    ...readRecentSearchQueries().filter((item) => item.toLocaleLowerCase() !== key),
  ].slice(0, RECENT_SEARCH_LIMIT);
  setSessionStorageItem(scope.storageKey, JSON.stringify(ui.recentSearchQueries));
  return true;
}

function getRecentSearchElements() {
  return {
    input: document.getElementById('search-input'),
    popover: document.getElementById('recent-search-popover'),
  };
}

// A rendered row is bound to the exact draft, caret and privacy scope.
function getSearchSuggestionSnapshot() {
  const {input} = getRecentSearchElements();
  const scope = syncRecentSearchScope();
  if (!input || !scope || state.ui.searchComposing) return null;
  return {value: input.value, start: input.selectionStart, end: input.selectionEnd, scope};
}
function getSearchSuggestionItems() {
  const snapshot = getSearchSuggestionSnapshot();
  if (!snapshot) return [];
  const shorthand = SearchShorthandModel.suggestions(snapshot.value, snapshot.start, snapshot.end)
    .map(entry => ({kind: 'shorthand', id: entry.id, label: entry.example, description: entry.description}));
  const recent = readRecentSearchQueries().map(query => ({kind: 'recent', query, label: query, description: 'Recent search'}));
  return [...shorthand, ...recent].slice(0, RECENT_SEARCH_LIMIT + 8);
}
function renderRecentSearchPopover() {
  const ui = ensureRecentSearchState();
  const {input, popover} = getRecentSearchElements();
  if (!ui || !input || !popover) return;
  const items = getSearchSuggestionItems();
  const mobileReady = typeof mobilePageState === 'undefined' || typeof usesMobilePageLayout !== 'function' || !usesMobilePageLayout()
    || (mobilePageState.searchOpen && mobilePageState.searchSuggestionsReady && String(input.value || '').trim());
  const open = Boolean(ui.recentSearchPopoverOpen && items.length && mobileReady && !ui.searchComposing);
  if (ui.recentSearchActiveIndex >= items.length) ui.recentSearchActiveIndex = -1;
  ui.searchSuggestionSnapshot = getSearchSuggestionSnapshot();
  ui.searchSuggestionItems = items;
  popover.innerHTML = items.map((item, index) => {
    const selected = open && index === ui.recentSearchActiveIndex;
    return `<button class="recent-search-option search-discovery-option" id="recent-search-option-${index}" type="button" role="option" tabindex="-1" data-search-suggestion-index="${index}" aria-selected="${selected ? 'true' : 'false'}"><span>${escapeHtml(item.label)}</span></button>`;
  }).join('');
  popover.hidden = !open;
  input.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open && ui.recentSearchActiveIndex >= 0) {
    input.setAttribute('aria-activedescendant', `recent-search-option-${ui.recentSearchActiveIndex}`);
    popover.querySelector?.(`#recent-search-option-${ui.recentSearchActiveIndex}`)?.scrollIntoView?.({block: 'nearest'});
  } else input.removeAttribute('aria-activedescendant');
}
function selectSearchSuggestion(index) {
  const ui = ensureRecentSearchState(), prior = ui?.searchSuggestionSnapshot;
  const item = ui?.searchSuggestionItems?.[index], current = getSearchSuggestionSnapshot();
  if (!prior || !current || !item || prior.scope !== current.scope || prior.value !== current.value
      || prior.start !== current.start || prior.end !== current.end) {closeRecentSearchPopover(); return false;}
  if (item.kind === 'recent') return selectRecentSearchQuery(item.query);
  const planned = SearchShorthandModel.plan(current.value, current.start, current.end, item.id);
  if (planned.error) return false;
  applySearchShorthandDraft(planned);
  return true;
}
function applySearchShorthandDraft(planned) {
  const {input} = getRecentSearchElements();
  if (!input || planned.error || state.ui.searchComposing) return false;
  invalidateAdvancedSearchIntent('shorthand-edit');
  input.value = planned.value;
  // Use the existing input owner, including clear action/mobile badge and
  // cancellation of pending submissions. This does not submit a Search.
  input.dispatchEvent(new Event('input', {bubbles: true}));
  input.focus();
  input.setSelectionRange(planned.start, planned.end);
  closeRecentSearchPopover();
  return true;
}
function handleSearchShorthandCaret() {
  const ui = ensureRecentSearchState();
  if (!ui || ui.searchComposing) return;
  ui.recentSearchActiveIndex = -1;
  if (ui.recentSearchPopoverOpen) renderRecentSearchPopover();
}
function handleSearchCompositionStart() {
  state.ui.searchComposing = true;
  clearPendingGallerySearchCommit();
  closeRecentSearchPopover();
}
function handleSearchCompositionEnd() {
  state.ui.searchComposing = false;
  handleGalleryBootstrapSearchInput(getRecentSearchElements().input?.value || '');
}
const advancedSearchState = {session:null,pending:null,textRevision:0,intentRevision:0,viewRevision:0,sequence:0,visibility:0};
const advancedSearchSubmissions = new WeakMap();
const advancedSearchEventProofs = new WeakMap();
function advancedSearchBaseCurrent(session) {
  return Boolean(session && session.scope === syncRecentSearchScope()
    && session.shell === document.getElementById('app-shell') && session.transport === recentSearchTransport && session.input === getRecentSearchElements().input && session.form === session.input?.form
    && session.textRevision === advancedSearchState.textRevision && session.intentRevision === advancedSearchState.intentRevision
    && session.viewRevision === advancedSearchState.viewRevision
    && session.baseInput === getRecentSearchElements().input?.value && session.baseDraft === state.ui.searchDraftQuery);
}
function invalidateAdvancedSearchIntent(reason = 'navigation', {searchOperation, preserveRetained = false} = {}) {
  if (preserveRetained && !advancedSearchState.pending) return;
  if (searchOperation && searchOperation === advancedSearchState.pending && searchOperation.isCurrent()) return;
  advancedSearchState.intentRevision++;
  const pending = advancedSearchState.pending;
  pending?.settle({status:'superseded',reason});
  const session = advancedSearchState.session;
  advancedSearchState.session = null;
  if(session) closeSearchAdvancedFilters({reason});
}
function syncAdvancedSearchAppliedView({changed = false} = {}) {
  if(changed) {advancedSearchState.viewRevision++;invalidateAdvancedSearchIntent('applied-view');}
  else if(advancedSearchState.session && !advancedSearchState.pending && !advancedSearchBaseCurrent(advancedSearchState.session))invalidateAdvancedSearchIntent('base-changed');
  const anchor=document.getElementById('search-advanced-toggle');
  const summary=SearchShorthandModel.advancedSummary(SearchShorthandModel.parseAdvanced(String(state.view?.query??'')));
  if(anchor){anchor.setAttribute('data-filters-active',String(Boolean(summary)));anchor.setAttribute('aria-label',summary?`Advanced filters: ${summary}`:'Advanced filters');}
}
function admitsAdvancedEvent(event) {
  const session=advancedSearchState.session;
  if(!session?.visible || session.scope!==syncRecentSearchScope())return false;
  if(document.getElementById('search-advanced-panel')?.contains(event.target))return true;
  const proof=advancedSearchEventProofs.get(event);
  return Boolean(proof&&proof.session===session&&proof.visibility===session.visibility&&proof.scope===session.scope);
}
function dismissAdvancedSearchSession(session,{reason='closed',searchOperation}={}) {
  const retires=['navigation','mobile-teardown','scope-loss','shell-replaced','applied-view'].includes(reason)
    && !(searchOperation&&searchOperation===advancedSearchState.pending&&searchOperation.isCurrent());
  if(session&&retires&&advancedSearchState.session===session){advancedSearchState.intentRevision++;advancedSearchState.session=null;advancedSearchState.pending?.settle({status:'superseded',reason});}
  if(!session?.visible)return;
  session.visible=false; const visibility=session.visibility;
  session.viewportCleanup?.();session.viewportCleanup=null;
  const child=session.child;session.child=null;child?.close({restoreFocus:false,reason});
  if(advancedSearchState.session&&advancedSearchState.session!==session||session.visible||session.visibility!==visibility)return;
  const panel=document.getElementById('search-advanced-panel');if(panel){panel.hidden=true;panel.replaceChildren();}
  document.getElementById('search-advanced-toggle')?.setAttribute('aria-expanded','false');
}
function closeSearchAdvancedFilters({reason='closed',searchOperation}={}) {
  const session=advancedSearchState.session;
  const descriptor=typeof galleryMainSurfaceController!=='undefined' ? galleryMainSurfaceController?.current?.() : null;
  // Capture ownership before callbacks. A dismissal may reopen this same retained
  // session with a new visibility epoch, so it must never receive a second hook.
  if(descriptor?.key==='search-filters' && (!session || descriptor.onDismiss===session.dismissHook)) {
    closeGalleryMainSurface(false,{reason,searchOperation});
    return;
  }
  // Only an opening never acquired by the controller needs local cleanup.
  dismissAdvancedSearchSession(session,{reason,searchOperation});
}
function advancedSearchFeedback(message) {
  const node=document.getElementById('search-advanced-feedback');if(node)node.textContent=message||'';
}
function editAdvancedSearchControls(edit) {
  const session=advancedSearchState.session;
  if(!session?.visible||advancedSearchState.pending||!advancedSearchBaseCurrent(session))return false;
  const result=SearchShorthandModel.editAdvanced(session.draft,edit);
  if(!result.ok){advancedSearchFeedback(result.diagnostics[0]?.message);return false;}
  if(result.draft===session.draft)return true;
  session.draft=result.draft;session.dirty=true;renderAdvancedSearchControls(session);return true;
}
function renderAdvancedSearchControls(session) {
  if(advancedSearchState.session!==session||!session.visible)return;
  const panel=document.getElementById('search-advanced-panel');if(!panel)return;
  const focused=document.activeElement,field=focused?.getAttribute?.('data-advanced-field');
  const selection=typeof focused?.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
  const f=session.draft.fields,serialized=SearchShorthandModel.serializeAdvanced(session.draft),locked=Boolean(advancedSearchState.pending);
  const button=(label,attributes={},disabled=false)=>window.ButtonComponent.renderButton({label,disabled,className:'gallery-menu-action',attributes:{type:'button',...attributes}});
  const choice=(label,field,value)=>`<div class="search-advanced-field"><span id="advanced-label-${field}">${label}</span>${button(value||'None',{'data-advanced-choice':field,'aria-labelledby':`advanced-label-${field}`},locked||session.draft.status!=='editable')}</div>`;
  const input=(label,field,value,extra='')=>`<label class="search-advanced-field">${label}<span class="ui-input-action"><input data-advanced-field="${field}" value="${escapeHtml(value)}" ${locked||session.draft.status!=='editable'?'disabled':''} ${extra}></span></label>`;
  panel.innerHTML='<h2 id="search-advanced-title">Advanced filters</h2>'+choice('Family','family',({ordinary:'Ordinary',love:'Your Love',listener:'Listener',popularity:'Popularity'})[f.family])
    +(session.draft.status!=='editable'?'<p>This query needs ordinary Search. Edit or clear it in the search box.</p>':'')
    +(f.family==='ordinary'?'<p>Plain text remains ordinary Search. Clear nonempty text in the search box before choosing a filter family.</p>':'')
    +(['love','listener'].includes(f.family)?choice('Include Love','include',f.include.join(' + ')||'None')+choice('Exclude Love','exclude',f.exclude.join(' + ')||'None')+'<p>Loved includes Obsessed. Include and Exclude are independent.</p>':'')
    +(f.family==='listener'?input('Listener username','username',f.username,'autocomplete="off" spellcheck="false"')+'<p>All-time listening history and this listener’s Love, where you have access. Tracks only.</p>':'')
    +(f.family==='popularity'?'<p>Last.fm global scrobbles, highest first. Tracks only.</p>'+f.facets.map(r=>`<div data-advanced-row="${r.rowId}">${choice('Field',r.rowId+':kind',r.kind)}${choice('Match',r.rowId+':polarity',r.polarity)}${input('Value',r.rowId+':text',r.text)}${button('Remove',{'data-advanced-remove':r.rowId},locked)}</div>`).join('')+button('Add artist or genre',{'data-advanced-add':'true'},locked)+`<label><input type="checkbox" data-advanced-cap ${f.cap.present?'checked':''} ${locked||session.draft.status!=='editable'?'disabled':''}>Limit songs per artist</label>`+(f.cap.present?input('Songs per artist (1–5000)','cap',f.cap.text,'inputmode="numeric"'):''):'')
    +'<p data-advanced-dirty></p><pre class="search-advanced-preview" aria-label="Query preview"></pre><p id="search-advanced-feedback" role="status" aria-live="polite"></p>'
    +button('Apply',{'data-advanced-apply':'true'},locked||session.composing||!serialized.ok)+button('Reset filters',{'data-advanced-reset':'true'},locked||session.draft.status!=='editable'||f.family==='ordinary'&&f.ordinary!=='')+button('Cancel',{'data-search-help-close':'true'})
    +'<details><summary>Supported examples</summary><p>:loved · -:obsessed · @listener :tracks listened:all · :popular artist:"Artist Name" -genre:rock per_artist:3</p><p>Filters from different families cannot be combined. Reset removes supported filters from this draft only.</p></details>';
  panel.querySelector('.search-advanced-preview').textContent=serialized.ok?serialized.value:session.draft.rawBase;
  panel.querySelector('[data-advanced-dirty]').textContent=session.dirty?'Unapplied changes':'';
  advancedSearchFeedback(serialized.ok?'':serialized.diagnostics[0]?.message);
  panel.oninput=event=>{const target=event.target,key=target.getAttribute('data-advanced-field');if(!key||session.composing)return;editAdvancedSearchControls(key==='username'?{type:'setUsername',text:target.value}:key==='cap'?{type:'setCap',present:true,text:target.value}:{type:'updateFacet',rowId:key.split(':')[0],patch:{text:target.value}});};
  panel.onchange=event=>{if(event.target.hasAttribute('data-advanced-cap'))editAdvancedSearchControls({type:'setCap',present:event.target.checked,text:f.cap.text});};
  panel.oncompositionstart=()=>{session.composing=true;};
  panel.oncompositionend=event=>{session.composing=false;panel.oninput(event);};
  panel.onkeydown=event=>{if(event.key!=='Enter'||event.isComposing||event.keyCode===229||session.composing||event.repeat||event.defaultPrevented||session.child?.ownsEvent(event))return;if(event.target.matches('input:not([type="checkbox"])')){event.preventDefault();applyAdvancedSearchControls();}};
  if(field){const replacement=Array.from(panel.querySelectorAll('[data-advanced-field]')).find(n=>n.getAttribute('data-advanced-field')===field);replacement?.focus({preventScroll:true});if(selection&&replacement&&session===advancedSearchState.session&&session.visible)replacement.setSelectionRange(...selection);}
}
function openAdvancedSearchChoice(trigger,key) {
  const session=advancedSearchState.session;if(!session?.visible||advancedSearchState.pending||!advancedSearchBaseCurrent(session)||!document.getElementById('search-advanced-panel')?.contains(trigger))return false;
  const f=session.draft.fields,facet=key.includes(':')?f.facets.find(r=>r.rowId===key.split(':')[0]):null;
  const options=key==='family'?[['ordinary','Ordinary'],['love','Your Love'],['listener','Listener'],['popularity','Popularity']]:['include','exclude'].includes(key)?[['','None'],['loved','Loved'],['obsessed','Obsessed'],['loved,obsessed','Both']]:key.endsWith(':kind')?[['artist','Artist'],['genre','Genre']]:[['include','Include'],['exclude','Exclude']];
  const selected=key==='family'?f.family:['include','exclude'].includes(key)?f[key].join(','):facet?.[key.split(':')[1]];
  const visibility=session.visibility;
  const owner=openUtilityChoiceDropdown(trigger,{formats:options.map(([value,label])=>({value,label})),selected,label:trigger.getAttribute('aria-labelledby')||'Filter',density:'compact',updateTriggerLabel:false,
    onOwnedEvent(event,child){if(session===advancedSearchState.session&&session.visible&&session.visibility===visibility&&session.child===child)advancedSearchEventProofs.set(event,{session,visibility,scope:session.scope});},
    onClose({owner}){if(session.child===owner)session.child=null;},
    onSelect(value){const child=session.child;session.child=null;child?.close({restoreFocus:false,reason:'selected'});if(session!==advancedSearchState.session||!session.visible||session.visibility!==visibility)return false;
      editAdvancedSearchControls(key==='family'?{type:'setFamily',family:value}:['include','exclude'].includes(key)?{type:'setLove',side:key,orderedSet:value?value.split(','):[]}:{type:'updateFacet',rowId:facet.rowId,patch:{[key.split(':')[1]]:value}});
      if(session===advancedSearchState.session&&session.visible&&session.visibility===visibility)Array.from(document.querySelectorAll('[data-advanced-choice]')).find(n=>n.getAttribute('data-advanced-choice')===key)?.focus({preventScroll:true});return true;}});
  if(owner?.isOpen&&session===advancedSearchState.session&&session.visible&&session.visibility===visibility)session.child=owner;
  else owner?.close({restoreFocus:false,reason:'stale-parent'});return true;
}
function toggleSearchAdvancedFilters() {
  const panel=document.getElementById('search-advanced-panel'),anchor=document.getElementById('search-advanced-toggle'),scope=syncRecentSearchScope(),input=getRecentSearchElements().input;
  if(!panel||!anchor||!scope||!input)return false;
  if(advancedSearchState.session?.visible){const captured=advancedSearchState.session,visibility=captured.visibility;closeSearchAdvancedFilters({reason:'repeat-anchor'});if(captured===advancedSearchState.session&&!captured.visible&&captured.visibility===visibility)anchor.focus();return true;}
  closeRecentSearchPopover();let session=advancedSearchState.session;
  if(!session||!advancedSearchBaseCurrent(session)){
    if(advancedSearchState.pending)return false;
    session={id:++advancedSearchState.sequence,scope,input,form:input.form,shell:document.getElementById('app-shell'),transport:recentSearchTransport,baseInput:input.value,baseDraft:state.ui.searchDraftQuery,textRevision:advancedSearchState.textRevision,intentRevision:advancedSearchState.intentRevision,viewRevision:advancedSearchState.viewRevision,draft:SearchShorthandModel.parseAdvanced(input.value),dirty:false,child:null};advancedSearchState.session=session;
  }
  session.visible=true;session.visibility=++advancedSearchState.visibility;renderAdvancedSearchControls(session);
  session.dismissHook=options=>dismissAdvancedSearchSession(session,options);
  const opened=openGalleryMainSurface('search-filters',anchor,panel,'right',{onDismiss:session.dismissHook});
  if(!opened||session!==advancedSearchState.session||!session.visible){dismissAdvancedSearchSession(session,{reason:'surface-replaced'});return false;}
  const position=()=>{if(session===advancedSearchState.session&&session.visible)positionGalleryAnchoredSurface(panel,anchor,'right');};
  window.visualViewport?.addEventListener('resize',position);window.visualViewport?.addEventListener('scroll',position);
  session.viewportCleanup=()=>{window.visualViewport?.removeEventListener('resize',position);window.visualViewport?.removeEventListener('scroll',position);};return true;
}
function applyAdvancedSearchControls() {
  const session=advancedSearchState.session,input=getRecentSearchElements().input,form=input?.form;
  if(!session?.visible||advancedSearchState.pending||session.composing||state.ui.searchComposing||!advancedSearchBaseCurrent(session))return false;
  const serialized=SearchShorthandModel.serializeAdvanced(session.draft);if(!serialized.ok){advancedSearchFeedback(serialized.diagnostics[0]?.message);return false;}
  if(!form||!input||typeof form.requestSubmit!=='function'){advancedSearchFeedback('Search is unavailable.');return false;}
  const op={id:++advancedSearchState.sequence,sessionId:session.id,nonce:{},scope:session.scope,submittedText:serialized.value,baseInput:input.value,baseDraft:state.ui.searchDraftQuery,baseViewRevision:advancedSearchState.viewRevision,settled:false};
  advancedSearchState.textRevision++;advancedSearchState.intentRevision++;
  op.textRevision=advancedSearchState.textRevision;op.intentRevision=advancedSearchState.intentRevision;
  op.isCurrent=()=>!op.settled&&advancedSearchState.pending===op&&op.scope===syncRecentSearchScope()&&session.shell===document.getElementById('app-shell')&&session.transport===recentSearchTransport&&getRecentSearchElements().input===input&&input.form===form&&op.textRevision===advancedSearchState.textRevision&&op.intentRevision===advancedSearchState.intentRevision&&input.value===op.submittedText&&state.ui.searchDraftQuery===op.submittedText;
  op.settle=result=>{
    if(op.settled)return;const owns=advancedSearchState.pending===op,current=owns&&op.isCurrent();
    let outcome=result;
    if(!current)outcome={status:'superseded',reason:result.reason||'stale-intent'};
    const applied=outcome.status==='accepted'||outcome.status==='unchanged'&&outcome.reason==='actual-committed';
    if(current&&!applied&&outcome.status!=='superseded'){
      input.value=op.baseInput;state.ui.searchDraftQuery=op.baseDraft;advancedSearchState.textRevision++;
      Object.assign(session,{baseInput:op.baseInput,baseDraft:op.baseDraft,textRevision:advancedSearchState.textRevision,intentRevision:advancedSearchState.intentRevision,viewRevision:advancedSearchState.viewRevision});
    }
    op.settled=true;op.result=outcome;if(owns)advancedSearchState.pending=null;
    if(current&&applied){session.dirty=false;closeSearchAdvancedFilters({reason:'submit-hide'});if(advancedSearchState.session===session)advancedSearchState.session=null;}
    else if(current){if(session.visible)renderAdvancedSearchControls(session);advancedSearchFeedback(outcome.reason);}
    if(current){if(typeof updateSearchClearAction==='function')updateSearchClearAction(input);if(typeof syncGalleryBarSearchVisibility==='function')syncGalleryBarSearchVisibility();if(typeof syncMobileSearchQueryIndicator==='function')syncMobileSearchQueryIndicator();}
  };
  advancedSearchState.pending=op;
  try {
    input.value=op.submittedText;updateGallerySearchDraftQuery(op.submittedText,{searchOperation:op});
    if(typeof updateSearchClearAction==='function')updateSearchClearAction(input);if(typeof syncGalleryBarSearchVisibility==='function')syncGalleryBarSearchVisibility();if(typeof syncMobileSearchQueryIndicator==='function')syncMobileSearchQueryIndicator();
    if(!op.isCurrent()){op.settle({status:'superseded',reason:'stale-dispatch'});return false;}
    advancedSearchSubmissions.set(form,op);form.requestSubmit();if(advancedSearchSubmissions.get(form)===op)op.settle({status:'failed',reason:'submit-not-consumed'});}
  catch(_error){op.settle({status:'failed',reason:'submit-error'});}
  finally{if(advancedSearchSubmissions.get(form)===op)advancedSearchSubmissions.delete(form);}return true;
}
function applySearchHelpExample() { return false; }

function openRecentSearchPopover() {
  const ui = ensureRecentSearchState();
  if (!ui || !getSearchSuggestionItems().length || ui.searchComposing) return false;
  if (typeof usesMobilePageLayout === 'function' && usesMobilePageLayout()
      && (!mobilePageState.searchOpen || !mobilePageState.searchSuggestionsReady || !String(getRecentSearchElements().input?.value || '').trim())) return false;
  ui.recentSearchPopoverOpen = true;
  ui.recentSearchActiveIndex = -1;
  renderRecentSearchPopover();
  const { input, popover } = getRecentSearchElements();
  if (typeof openGalleryMainSurface === 'function' && input && popover) {
    positionSearchSuggestionsSurface(popover);
    if (typeof galleryMainSurfaceController === 'undefined' || !galleryMainSurfaceController?.isOpen?.('search-suggestions')) {
      openGalleryMainSurface('search-suggestions', input, popover, 'left');
    }
  }
  return true;
}

function closeRecentSearchPopover() {
  const ui = ensureRecentSearchState();
  if (!ui) return;
  ui.recentSearchPopoverOpen = false;
  ui.recentSearchActiveIndex = -1;
  renderRecentSearchPopover();
  if (typeof galleryMainSurfaceController !== 'undefined' && galleryMainSurfaceController?.isOpen?.('search-suggestions')) {
    closeGalleryMainSurface(false);
  }
}

function selectRecentSearchQuery(query) {
  const { input } = getRecentSearchElements();
  const value = String(query || '').trim();
  if (!input || !value || !readRecentSearchQueries().includes(value)) return false;
  invalidateAdvancedSearchIntent('recent-selection');
  input.value = value;
  closeRecentSearchPopover();
  beginAlbumDetailPrewarmSearchSuspension();
  beginSearchCoverLoadSuspension();
  beginSearchWaveformPeakLoadSuspension();
  scheduleGallerySearchCommit(value, {
    immediate: true,
    recordRecentSearch: true,
  });
  input.blur?.();
  return true;
}

function handleGalleryBootstrapSearchFocus() {
  clearPendingSelectedArtistReconcile();
  openRecentSearchPopover();
}

function handleGalleryBootstrapSearchClick(event) {
  const insideAdvanced=document.getElementById('search-advanced-panel')?.contains(event.target);
  const advancedChoice=insideAdvanced&&event.target.closest('[data-advanced-choice]');
  if(advancedChoice){event.preventDefault();return openAdvancedSearchChoice(advancedChoice,advancedChoice.getAttribute('data-advanced-choice'));}
  if(insideAdvanced&&event.target.closest('[data-advanced-apply]')){event.preventDefault();return applyAdvancedSearchControls();}
  if(insideAdvanced&&event.target.closest('[data-advanced-reset]')){event.preventDefault();return editAdvancedSearchControls({type:'reset'});}
  if(insideAdvanced&&event.target.closest('[data-advanced-add]')){event.preventDefault();return editAdvancedSearchControls({type:'addFacet',kind:'artist',polarity:'include',text:''});}
  const remove=insideAdvanced&&event.target.closest('[data-advanced-remove]');
  if(remove){event.preventDefault();const rowId=remove.getAttribute('data-advanced-remove'),rows=advancedSearchState.session?.draft.fields.facets||[],index=rows.findIndex(r=>r.rowId===rowId),next=rows[index+1]||rows[index-1];const result=editAdvancedSearchControls({type:'removeFacet',rowId});const panel=document.getElementById('search-advanced-panel');(next?panel?.querySelector(`[data-advanced-row="${next.rowId}"] input`):panel?.querySelector('[data-advanced-add]'))?.focus();return result;}
  if(admitsAdvancedEvent(event)&&!document.getElementById('search-advanced-panel')?.contains(event.target))return false;
  if (event.target.closest('#search-advanced-toggle')) {event.preventDefault(); return toggleSearchAdvancedFilters();}
  const example = event.target.closest('[data-search-example]');
  if (example && document.getElementById('search-advanced-panel')?.contains(example)) {
    event.preventDefault(); return applySearchHelpExample(example.getAttribute('data-search-example'));
  }
  if (event.target.closest('[data-search-help-close]')) {
    event.preventDefault(); const session=advancedSearchState.session,visibility=session?.visibility;closeSearchAdvancedFilters({reason:'cancel'});if(event.detail===0&&session===advancedSearchState.session&&!session?.visible&&session?.visibility===visibility)document.getElementById('search-advanced-toggle')?.focus();return true;
  }
  if (document.getElementById('search-advanced-panel')?.contains(event.target)) return false;
  const option = event.target.closest('[data-search-suggestion-index]');
  if (option) {
    event.preventDefault();
    if (!getRecentSearchElements().popover?.contains(option)) return false;
    return selectSearchSuggestion(Number(option.getAttribute('data-search-suggestion-index')));
  }
  if (event.target.closest('#search-input')) {
    handleSearchShorthandCaret(); openRecentSearchPopover(); return false;
  }
  closeRecentSearchPopover();
  closeSearchAdvancedFilters({reason:'outside-pointer'});
  return false;
}

function handleGalleryBootstrapSearchMouseDown(event) {
  if (!event.target.closest('[data-search-suggestion-index]')) return false;
  event.preventDefault();
  return true;
}

function handleGalleryBootstrapSearchKeyDown(event) {
  if (event.isComposing || event.keyCode === 229 || state.ui?.searchComposing) return false;
  const ui = ensureRecentSearchState();
  if (!ui) return false;
  const queries = getSearchSuggestionItems();
  const mobileReady = typeof mobilePageState === 'undefined' || typeof usesMobilePageLayout !== 'function' || !usesMobilePageLayout()
    || (mobilePageState.searchOpen && mobilePageState.searchSuggestionsReady && String(getRecentSearchElements().input?.value || '').trim());
  const open = Boolean(ui.recentSearchPopoverOpen && queries.length && mobileReady);
  if (event.key === 'Tab') {
    closeRecentSearchPopover();
    return false;
  }
  if (event.key === 'Escape') {
    if (!open) return false;
    event.preventDefault();
    closeRecentSearchPopover();
    return true;
  }
  if (event.key === 'Enter') {
    if (!open || ui.recentSearchActiveIndex < 0) {
      closeRecentSearchPopover();
      const form = event.currentTarget?.form || document.getElementById('search-form');
      if (!form || typeof form.requestSubmit !== 'function') return false;
      event.preventDefault();
      event.stopPropagation();
      form.requestSubmit();
      return true;
    }
    event.preventDefault();
    return selectSearchSuggestion(ui.recentSearchActiveIndex);
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
  if (['Home', 'End'].includes(event.key) && (!open || ui.recentSearchActiveIndex < 0)) return false;
  if (!queries.length) return false;
  event.preventDefault();
  if (!open) openRecentSearchPopover();
  if (event.key === 'Home') ui.recentSearchActiveIndex = 0;
  else if (event.key === 'End') ui.recentSearchActiveIndex = queries.length - 1;
  else if (event.key === 'ArrowDown') {
    ui.recentSearchActiveIndex = ui.recentSearchActiveIndex >= queries.length - 1
      ? 0
      : ui.recentSearchActiveIndex + 1;
  } else {
    ui.recentSearchActiveIndex = ui.recentSearchActiveIndex <= 0
      ? queries.length - 1
      : ui.recentSearchActiveIndex - 1;
  }
  renderRecentSearchPopover();
  return true;
}

function clearPendingSelectedArtistReconcile() {
  if (!state.ui || typeof state.ui !== 'object') return;
  clearBrowserTimeout(state.ui.pendingSelectedArtistReconcileTimer);
  state.ui.pendingSelectedArtistReconcileTimer = 0;
}

function updateGallerySearchDraftQuery(nextQuery, {searchOperation} = {}) {
  const normalizedQuery = String(nextQuery || '');
  if (state.ui && typeof state.ui === 'object') {
    if (state.ui.searchDraftQuery !== normalizedQuery && searchOperation !== advancedSearchState.pending) {
      advancedSearchState.textRevision++; invalidateAdvancedSearchIntent('draft-change');
    }
    state.ui.searchDraftQuery = normalizedQuery;
  }
  if (typeof syncGalleryBarSearchVisibility === 'function') {
    syncGalleryBarSearchVisibility();
  }
  return normalizedQuery;
}

function clearPendingGallerySearchCommit() {
  if (!state.ui || typeof state.ui !== 'object') return;
  clearBrowserTimeout(state.ui.pendingSearchCommitTimer);
  state.ui.pendingSearchCommitTimer = 0;
  state.ui.pendingRecentSearchCommitScope = null;
}

function beginAlbumDetailPrewarmSearchSuspension() {
  if (!state.ui || typeof state.ui !== 'object') return 0;
  const generation = Number(state.ui.albumDetailPrewarmSearchGeneration || 0) + 1;
  state.ui.albumDetailPrewarmSearchGeneration = generation;
  state.ui.albumDetailPrewarmSearchSuspended = true;
  return generation;
}

function releaseAlbumDetailPrewarmSearchSuspension(generation) {
  if (!state.ui || typeof state.ui !== 'object') return;
  if (
    Number(generation || 0) > 0
    && Number(state.ui.albumDetailPrewarmSearchGeneration || 0) !== Number(generation)
  ) {
    return;
  }
  state.ui.albumDetailPrewarmSearchSuspended = false;
}

function beginSearchCoverLoadSuspension() {
  if (!state.ui || typeof state.ui !== 'object') return null;
  const pendingToken = state.ui.pendingSearchCoverLoadSuspensionToken;
  if (pendingToken !== null && pendingToken !== undefined) return pendingToken;
  if (
    typeof virtualGrid === 'undefined'
    || !virtualGrid
    || typeof virtualGrid.suspendSelectedArtistCoverLoadsForUserAction !== 'function'
  ) {
    return null;
  }
  const token = virtualGrid.suspendSelectedArtistCoverLoadsForUserAction();
  state.ui.pendingSearchCoverLoadSuspensionToken = token;
  return token;
}

function takePendingSearchCoverLoadSuspension() {
  if (!state.ui || typeof state.ui !== 'object') return null;
  const token = state.ui.pendingSearchCoverLoadSuspensionToken;
  state.ui.pendingSearchCoverLoadSuspensionToken = null;
  return token === undefined ? null : token;
}

function releasePendingSearchCoverLoadSuspension() {
  const token = takePendingSearchCoverLoadSuspension();
  if (
    token === null
    || typeof virtualGrid === 'undefined'
    || !virtualGrid
    || typeof virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction !== 'function'
  ) {
    return;
  }
  virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(token);
}

function beginSearchWaveformPeakLoadSuspension() {
  if (!state.ui || typeof state.ui !== 'object') return null;
  if (state.ui.pendingSearchWaveformPeakLoadSuspension) {
    return state.ui.pendingSearchWaveformPeakLoadSuspension;
  }
  if (typeof suspendPlayerWaveformPeakLoadsForForegroundView !== 'function') return null;
  const suspension = suspendPlayerWaveformPeakLoadsForForegroundView();
  state.ui.pendingSearchWaveformPeakLoadSuspension = suspension || null;
  return state.ui.pendingSearchWaveformPeakLoadSuspension;
}

function releasePendingSearchWaveformPeakLoadSuspension() {
  if (!state.ui || typeof state.ui !== 'object') return;
  const suspension = state.ui.pendingSearchWaveformPeakLoadSuspension || null;
  state.ui.pendingSearchWaveformPeakLoadSuspension = null;
  if (
    !suspension
    || typeof resumePlayerWaveformPeakLoadsAfterForegroundView !== 'function'
  ) return;
  void Promise.resolve(
    resumePlayerWaveformPeakLoadsAfterForegroundView(suspension),
  ).catch(() => {});
}

function releasePendingGallerySearchSuspensions() {
  releaseAlbumDetailPrewarmSearchSuspension(
    Number(state.ui?.albumDetailPrewarmSearchGeneration || 0),
  );
  releasePendingSearchCoverLoadSuspension();
  releasePendingSearchWaveformPeakLoadSuspension();
}

function scheduleGallerySearchCommit(nextQuery, options = {}) {
  const recentSearchScope = options.recordRecentSearch === true
    ? syncRecentSearchScope() : undefined;
  const normalizedQuery = updateGallerySearchDraftQuery(nextQuery, options);
  const searchOperation = options.searchOperation;
  if (searchOperation && !searchOperation.isCurrent()) {searchOperation.settle({status:'superseded',reason:'stale-schedule'});return false;}
  let committedQuery = String(state.view?.query || '');
  const pendingQuery = state.busy
    && String(state.ui.activeViewRequestUrl || '').startsWith('/view-data?')
    && String(state.ui.activeViewRequestUrl).match(/(?:[?&])q=([^&]*)/);
  if (pendingQuery) {
    try {
      committedQuery = decodeURIComponent(pendingQuery[1].replace(/\+/g, ' '));
    } catch (_error) {
      // Invalid request encoding cannot supersede the applied query.
    }
  }
  const privateSearchSnapshot = options.immediate && state.view?.private_search === true
    ? window.AlbumHavenSearchRuntime?.snapshot?.() : null;
  // A retired response has no result authority even if its last applied query
  // remains in the view. Only an explicit submit may request fresh authority.
  const retriesRetiredPrivateSearch = Boolean(options.immediate && !state.busy
    && privateSearchSnapshot?.status === 'idle' && privateSearchSnapshot.visible === false
    && privateSearchSnapshot.result === null);
  const retriesFailedSearch = Boolean(
    options.immediate
    && state.ui?.failedGallerySearch?.query === normalizedQuery
  );
  const selectedArtistSource = String(
    state.view?.search_context?.selected_artist_source || ''
  ).trim().toLowerCase();
  const shouldReselectCommittedQuery = Boolean(
    options.immediate
    && selectedArtistSource === 'requested_artist'
    && String(resolveEffectiveSearchSelectedArtist(state.view) || '').trim()
  );
  if (String(normalizedQuery || '').trim()) {
    state.ui.pendingSearchClearOnBlur = false;
  }
  if (normalizedQuery === committedQuery && !shouldReselectCommittedQuery
    && !retriesFailedSearch && !retriesRetiredPrivateSearch
    && !(typeof hasActiveMobilePage === 'function' && hasActiveMobilePage())) {
    clearPendingGallerySearchCommit();
    if (searchOperation) searchOperation.settle({status:'unchanged',reason:normalizedQuery === String(state.view?.query || '') ? 'actual-committed' : 'already-pending'});
    else if (options.recordRecentSearch === true) recordRecentSearchQuery(normalizedQuery);
    releasePendingGallerySearchSuspensions();
    return false;
  }
  clearPendingGallerySearchCommit();
  const commitSearch = () => {
    if (options.recordRecentSearch === true
        && recentSearchScope !== (syncRecentSearchScope())) {searchOperation?.settle({status:'superseded',reason:'scope-loss'});return;}
    state.ui.pendingSearchCommitTimer = 0;
    state.ui.pendingRecentSearchCommitScope = null;
    try {commitGallerySearchQuery(normalizedQuery, {
      recentSearchScope,
      recordRecentSearch: options.recordRecentSearch === true,
      scanPageAbandonHandled: options.scanPageAbandonHandled === true,
      searchOperation,
    });} catch(error){if(searchOperation)searchOperation.settle({status:'failed',reason:'commit-error'});else throw error;}
  };
  if (options.immediate) {
    commitSearch();
    return true;
  }
  state.ui.pendingRecentSearchCommitScope = recentSearchScope;
  state.ui.pendingSearchCommitTimer = scheduleBrowserTimeout(
    commitSearch,
    SEARCH_COMMIT_DEBOUNCE_MS,
  );
  return true;
}

function revealArtistTreeForSearch() {
  if (typeof usesMobilePageLayout === 'function' && usesMobilePageLayout()) {
    const button = document.getElementById('mobile-library-button');
    button?.setAttribute('data-search-results', 'true');
    button?.setAttribute('aria-description', 'Search results available in Artists');
    return;
  }
  const shell = document.getElementById('app-shell');
  if (shell?.classList?.contains('is-artist-tree-folded') && typeof toggleArtistTreeFold === 'function') {
    toggleArtistTreeFold();
  }
}

function handleGalleryBootstrapSearchSubmit(event) {
  const form = event?.currentTarget?.matches?.('form') ? event.currentTarget : event?.target;
  const searchOperation = form && advancedSearchSubmissions.get(form);
  if (searchOperation) advancedSearchSubmissions.delete(form);
  try {
  if (!searchOperation) invalidateAdvancedSearchIntent('submit');
  if (state.ui?.searchComposing || event?.isComposing) {event?.preventDefault();searchOperation?.settle({status:'cancelled',reason:'composition'});return;}
  if (searchOperation && !searchOperation.isCurrent()) {event?.preventDefault();searchOperation.settle({status:'superseded',reason:'stale-submit'});return;}
  closeSearchAdvancedFilters({reason:'submit-hide'});
  event.preventDefault();
  if (typeof handleMobileSearchSubmit === 'function' && handleMobileSearchSubmit(searchOperation)) {searchOperation?.settle({status:'unchanged',reason:'opened-search'});return;}
  if (state.ui.artistsDrawerOpen
    && typeof usesMobilePageLayout === 'function' && usesMobilePageLayout()
    && typeof closeArtistsDrawer === 'function') {
    closeArtistsDrawer({ restoreFocus: false });
  }
  const input = document.getElementById('search-input');
  const nextQuery = input?.value || '';
  const mobileArtistsButton = document?.getElementById?.('mobile-library-button');
  if (String(nextQuery).trim()) revealArtistTreeForSearch();
  else {
    mobileArtistsButton?.removeAttribute('data-search-results');
    mobileArtistsButton?.removeAttribute('aria-description');
  }
  closeRecentSearchPopover();
  beginAlbumDetailPrewarmSearchSuspension();
  beginSearchCoverLoadSuspension();
  beginSearchWaveformPeakLoadSuspension();
  const scanPageIsVisible = Boolean(
    state.ui.scanPageReturnContext
    || state.ui.forceScanPageVisible
  );
  const queryChanged = nextQuery !== String(state.view?.query || '');
  const scanPageWasAbandoned = scanPageIsVisible && !searchOperation
    ? abandonScanPageForNavigation(queryChanged ? { clearSelection: true } : {})
    : false;
  const searchWasScheduled = scheduleGallerySearchCommit(nextQuery, {
    immediate: true,
    recordRecentSearch: true,
    scanPageAbandonHandled: !searchOperation,
    searchOperation,
  });
  if (scanPageWasAbandoned && !searchWasScheduled) {
    renderView();
    resumeScanPageGalleryCoverLoads();
  }
  input?.blur?.();
  } catch (error) {if(searchOperation)searchOperation.settle({status:'failed',reason:'submit-error'});else throw error;}
}

function handleGalleryBootstrapSearchInput(nextQuery) {
  invalidateAdvancedSearchIntent('input');
  closeSearchAdvancedFilters();
  if (typeof mobilePageState !== 'undefined') mobilePageState.searchSuggestionsReady = Boolean(String(nextQuery || '').trim());
  clearPendingSelectedArtistReconcile();
  clearPendingGallerySearchCommit();
  const prewarmSearchGeneration = beginAlbumDetailPrewarmSearchSuspension();
  beginSearchWaveformPeakLoadSuspension();
  if (typeof cancelTrackModalAlbumDetailsPrewarms === 'function') {
    cancelTrackModalAlbumDetailsPrewarms();
  }
  const normalizedQuery = updateGallerySearchDraftQuery(nextQuery);
  if (
    String(normalizedQuery || '').trim()
    && normalizedQuery !== String(state.view?.query || '')
  ) {
    beginSearchCoverLoadSuspension();
  } else {
    releasePendingSearchCoverLoadSuspension();
  }
  const ui = ensureRecentSearchState();
  if (ui && !String(normalizedQuery || '').trim()) {
    closeRecentSearchPopover();
  } else if (ui && !ui.recentSearchPopoverOpen) {
    openRecentSearchPopover();
  }
  if (ui) {
    ui.recentSearchActiveIndex = -1;
    renderRecentSearchPopover();
  }
  if (normalizedQuery === String(state.view?.query || '')) {
    releaseAlbumDetailPrewarmSearchSuspension(prewarmSearchGeneration);
    releasePendingSearchWaveformPeakLoadSuspension();
  }
}

function commitGallerySearchQuery(nextQuery, options = {}) {
  const searchOperation = options.searchOperation;
  if (searchOperation && !searchOperation.isCurrent()) {searchOperation.settle({status:'superseded',reason:'stale-commit'});return;}
  const leaveContext = searchOperation ? {operation:searchOperation,isCurrent:searchOperation.isCurrent,onOutcome:result=>searchOperation.settle(result)} : null;
  const currentRecentSearchScope = options.recordRecentSearch === true
    ? syncRecentSearchScope() : undefined;
  const recentSearchScope = Object.prototype.hasOwnProperty.call(options, 'recentSearchScope')
    ? options.recentSearchScope : currentRecentSearchScope;
  if (options.recordRecentSearch === true && recentSearchScope !== currentRecentSearchScope) {searchOperation?.settle({status:'superseded',reason:'scope-loss'});return;}
  const mobileLeaveConfirmed = options.mobileLeaveConfirmed === true;
  if (mobileLeaveConfirmed) {
    beginAlbumDetailPrewarmSearchSuspension();
    beginSearchCoverLoadSuspension();
    beginSearchWaveformPeakLoadSuspension();
  }
  if (typeof prepareMobileGallerySearch === 'function'
    && !prepareMobileGallerySearch(() => commitGallerySearchQuery(nextQuery, { ...options, recentSearchScope, mobileLeaveConfirmed: true }), mobileLeaveConfirmed, leaveContext)) {
    releasePendingGallerySearchSuspensions();
    return;
  }
  if (searchOperation) {
    if (!searchOperation.isCurrent()) {searchOperation.settle({status:'superseded',reason:'stale-admission'});return;}
    searchOperation.settle({status:'accepted',reason:'commit-admitted'});
  }
  clearPendingSelectedArtistReconcile();
  clearPendingGallerySearchCommit();
  if (
    options.scanPageAbandonHandled !== true
    && (
      state.ui.scanPageReturnContext
      || state.ui.forceScanPageVisible
    )
  ) {
    abandonScanPageForNavigation({ clearSelection: true });
  }
  const normalizedQuery = String(nextQuery || '');
  const searchGeneration = Number(state.ui.gallerySearchGeneration || 0) + 1;
  state.ui.gallerySearchGeneration = searchGeneration;
  state.ui.failedGallerySearch = null;
  updateGallerySearchDraftQuery(normalizedQuery, {searchOperation});
  if (options.recordRecentSearch === true) {
    recordRecentSearchQuery(normalizedQuery);
  }
  if (!String(normalizedQuery || '').trim()) {
    releasePendingSearchCoverLoadSuspension();
    const effectiveSelectedArtist = resolveEffectiveSearchSelectedArtist(state.view);
    if (
      !String(state.view.query || '').trim()
      && effectiveSelectedArtist === String(state.view.selected_artist || '').trim()
    ) {
      if (state.busy && /(?:[?&])q=[^&]+/.test(String(state.ui.activeViewRequestUrl || ''))) {
        state.ui.activeViewRequestController?.abort();
      }
      state.ui.pendingSearchClearOnBlur = false;
      releaseAlbumDetailPrewarmSearchSuspension(
        Number(state.ui.albumDetailPrewarmSearchGeneration || 0),
      );
      releasePendingSearchWaveformPeakLoadSuspension();
      return;
    }
  }
  if (!String(state.view.query || '').trim() && String(normalizedQuery || '').trim()) {
    const preSearchSidebar = Array.isArray(state.view?.artists_sidebar)
      ? deepCloneJson(state.view.artists_sidebar)
      : null;
    state.ui.preSearchView = {
      ...(Array.isArray(state.view.sidebar_library_categories)
        ? { sidebar_library_categories: [...state.view.sidebar_library_categories] }
        : {}),
      selected_artist: String(state.view.selected_artist || ''),
      related_filter_artists: [...(Array.isArray(state.view.related_filter_artists) ? state.view.related_filter_artists : [])],
      primary_filter_active: Boolean(state.view.primary_filter_active),
      ...(preSearchSidebar && preSearchSidebar.length
        ? { artists_sidebar: preSearchSidebar }
        : {}),
      ...(Number.isFinite(Number(state.view?.artist_count))
        ? { artist_count: Number(state.view.artist_count) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(state.view || {}, 'show_all_artists_sidebar_link')
        ? { show_all_artists_sidebar_link: state.view.show_all_artists_sidebar_link !== false }
        : {}),
    };
    state.ui.preSearchViewOrigin = (
      String(window.location?.pathname || '') === '/'
      && !String(window.location?.search || '')
    ) ? 'canonical_root' : 'interactive';
  }
  if (!String(normalizedQuery || '').trim() && String(state.view.query || '').trim()) {
    const next = withActiveGallerySources(buildClearedSearchView(), state.gallery.mainState);
    const reusableRootBrowseView = readReusableRootBrowseViewForClearedSearch(next);
    const retainsSelectedArtist = Boolean(String(next?.selected_artist || '').trim());
    const mountedSelectedGalleryComplete = Boolean(
      retainsSelectedArtist
      && isMountedSelectedGalleryComplete(next.selected_artist, reusableRootBrowseView)
    );
    const clearSourceView = reusableRootBrowseView || state.view;
    const clearScopeMatches = !state.gallery.mainState || gallerySourceScopesEqual(
      activeGallerySourceCategories(state.gallery.mainState),
      clearSourceView.non_album_library_categories || clearSourceView.loaded_library_categories
        || clearSourceView.visible_library_categories || ['main_library', 'new_arrivals', 'hoard'],
    );
    const canRestoreCachedClear = Boolean(clearScopeMatches && (
      !retainsSelectedArtist || mountedSelectedGalleryComplete
    ));
    if (
      canRestoreCachedClear
      && tryRestoreClearedSearchView(next, { reusableRootBrowseView })
    ) {
      state.ui.pendingSearchClearOnBlur = false;
      releaseAlbumDetailPrewarmSearchSuspension(
        Number(state.ui.albumDetailPrewarmSearchGeneration || 0),
      );
      releasePendingSearchWaveformPeakLoadSuspension();
      return;
    }
    state.gallery.sidebarArtistsOverride = null;
    state.gallery.sidebarShowAllArtistsOverride = null;
    state.ui.pendingSearchClearOnBlur = false;
    const completesPageEntryHomeBrowseContext = Boolean(
      String(next?.surface?.active || '').trim().toLowerCase() === 'home'
      && !String(next?.selected_artist || '').trim()
    );
    if (completesPageEntryHomeBrowseContext) {
      applyViewPayload(next, { trackSidebarReveal: false });
      fetchAndRender(buildApiUrl({
        ...next,
        surface: {
          ...(next.surface || {}),
          active: 'albums',
        },
        surface_request: 'albums',
      }), true, { completePageEntryBrowseContext: true });
    } else {
      const retainMountedSelectedArtist = Boolean(
        retainsSelectedArtist
        && mountedSelectedGalleryComplete
        && clearScopeMatches
      );
      if (retainMountedSelectedArtist) {
        fetchAndRender(buildApiUrl({
          ...next,
          selected_artist: '',
        }, {
          payloadTier: 'sidebar',
        }), true, {
          preserveScroll: true,
          retainMountedGalleryIfEquivalent: true,
          retainMountedSelectedViewState: next,
          skipPendingViewTransition: true,
        });
      } else {
        fetchAndRender(buildApiUrl(next), true);
      }
    }
    return;
  }
  const previousView = state.view;
  const next = {
    ...withActiveGallerySources(state.view, state.gallery.mainState),
    // Popularity Search captures explicit Gallery scope independently of the
    // client-side source-toggle projection used by ordinary Gallery Search.
    ...(isPopularitySearchExpression(normalizedQuery) ? {gallery_scope: state.view.gallery_scope} : {}),
    query: normalizedQuery,
    selected_artist: '',
    all_artists_active: false,
    related_filter_artists: [],
    primary_filter_active: false,
  };
  state.gallery.sidebarArtistsOverride = null;
  state.gallery.sidebarShowAllArtistsOverride = null;
  state.ui.pendingSearchClearOnBlur = false;
  let coverLoadSuspensionToken = takePendingSearchCoverLoadSuspension();
  if (coverLoadSuspensionToken === null) {
    beginSearchCoverLoadSuspension();
    coverLoadSuspensionToken = takePendingSearchCoverLoadSuspension();
  }
  const resumeCoverLoads = () => {
    if (
      coverLoadSuspensionToken !== null
      &&
      typeof virtualGrid !== 'undefined'
      && virtualGrid
      && typeof virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction === 'function'
    ) {
      virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(coverLoadSuspensionToken);
    }
  };
  const hydrationUrl = buildApiUrl(next);
  const handleSearchFailure = (error) => {
    if (state.ui.gallerySearchGeneration !== searchGeneration) return;
    syncAdvancedSearchAppliedView();
    const activeSearchStage = 'hydration';
    state.ui.failedGallerySearch = {
      query: normalizedQuery,
      stage: activeSearchStage,
    };
    if (String(state.view?.query || '') === normalizedQuery) {
      applyViewPayload(previousView, { trackSidebarReveal: false });
      renderRelated();
    }
    if (typeof showToast === 'function') {
      showToast(
        'Full search results failed to load. Retry the search.',
        'error',
        4800,
        { errorKey: `gallery-search-${activeSearchStage}-failed` },
      );
    }
  };
  const request = fetchAndRender(hydrationUrl, true, {
    preserveScroll: String(previousView.query || '') === normalizedQuery,
    restartIfSameUrl: true,
    skipPendingViewTransition: true,
    showSearchProgress: true,
    shouldApplyResponse: () => state.ui.gallerySearchGeneration === searchGeneration,
  });
  void Promise.resolve(request).then(
    resumeCoverLoads,
    (error) => {
      resumeCoverLoads();
      throw error;
    },
  ).catch(handleSearchFailure);
}

function resolveEffectiveSearchSelectedArtist(view) {
  if (state.ui?.pendingSidebarAllArtistsActive) {
    return '';
  }
  const pendingSidebarSelectedArtist = String(
    state.ui?.pendingSidebarSelectedArtist || ''
  ).trim();
  if (pendingSidebarSelectedArtist) {
    return pendingSidebarSelectedArtist;
  }
  const selectedArtist = String(view?.selected_artist || '').trim();
  if (selectedArtist) {
    return selectedArtist;
  }
  return '';
}

function buildClearedSearchView() {
  const hasPreviousSearchView = Boolean(
    state.ui.preSearchView
    && typeof state.ui.preSearchView === 'object'
  );
  const previous = hasPreviousSearchView ? state.ui.preSearchView : {};
  const pendingAllArtistsSelection = Boolean(state.ui?.pendingSidebarAllArtistsActive);
  const restoredSelectedArtist = resolveEffectiveSearchSelectedArtist(state.view);
  const currentSurface = String(state.view?.surface?.active || '').trim().toLowerCase();
  const restoreCanonicalRoot = (
    !pendingAllArtistsSelection
    && (
      !restoredSelectedArtist
      || state.ui.preSearchViewOrigin === 'canonical_root'
      || (!hasPreviousSearchView && currentSurface === 'albums')
    )
  );
  if (restoreCanonicalRoot) {
    return {
      ...state.view,
      surface: {
        ...(state.view?.surface && typeof state.view.surface === 'object' ? state.view.surface : {}),
        active: restoredSelectedArtist ? 'albums' : 'home',
      },
      surface_request: restoredSelectedArtist ? 'albums' : 'home',
      query: '',
      private_search: false,
      search_presentation: undefined,
      selected_artist: restoredSelectedArtist,
      all_artists_active: false,
      gallery_scope: restoredSelectedArtist ? state.view.gallery_scope : '',
      visible_library_categories: restoredSelectedArtist
        ? [...(Array.isArray(state.view.visible_library_categories) ? state.view.visible_library_categories : [])]
        : [],
      related_filter_artists: restoredSelectedArtist
        ? state.view.related_filter_artists
        : [],
      primary_filter_active: restoredSelectedArtist
        ? Boolean(state.view.primary_filter_active)
        : false,
      search_context: null,
      search_filters: {
        genre: [],
        mood: [],
        style: [],
        duration: {
          min_seconds: null,
          max_seconds: null,
        },
      },
    };
  }
  return {
    ...state.view,
    query: '',
    private_search: false,
    search_presentation: undefined,
    selected_artist: restoredSelectedArtist,
    all_artists_active: false,
    related_filter_artists: restoredSelectedArtist || pendingAllArtistsSelection
      ? (
        restoredSelectedArtist
          ? state.view.related_filter_artists
          : []
      )
      : [...(Array.isArray(previous.related_filter_artists) ? previous.related_filter_artists : [])],
    primary_filter_active: restoredSelectedArtist || pendingAllArtistsSelection
      ? (
        restoredSelectedArtist
          ? Boolean(state.view.primary_filter_active)
          : false
      )
      : Boolean(previous.primary_filter_active),
    search_context: null,
  };
}

function buildRestoredSearchSidebar(cachedSidebar, selectedArtist) {
  const restoredSidebar = Array.isArray(cachedSidebar)
    ? deepCloneJson(cachedSidebar)
    : [];
  const normalizedSelectedArtist = String(selectedArtist || '').trim();
  if (!normalizedSelectedArtist) {
    return restoredSidebar;
  }
  if (restoredSidebar.some((item) => String(item?.artist || '').trim() === normalizedSelectedArtist)) {
    return restoredSidebar;
  }
  const currentSidebarArtists = Array.isArray(state.view?.artists_sidebar)
    ? state.view.artists_sidebar
    : [];
  const currentSidebarMatch = currentSidebarArtists.find(
    (item) => String(item?.artist || '').trim() === normalizedSelectedArtist,
  );
  restoredSidebar.unshift(currentSidebarMatch || {
    artist: normalizedSelectedArtist,
    artist_display: normalizedSelectedArtist,
    count: 0,
  });
  return restoredSidebar;
}

function buildOptimisticSidebarArtistSelectionGroups(artist) {
  const normalizedArtist = String(artist || '').trim();
  if (!normalizedArtist) return null;
  const resolveGroupArtist = (group) => String(group?.artist || group?.artist_display || '').trim();
  const matchesArtist = (group) => {
    const groupArtist = resolveGroupArtist(group);
    return groupArtist === normalizedArtist;
  };
  const currentPrimaryGroups = Array.isArray(state.view?.primary_artist_groups)
    ? state.view.primary_artist_groups
    : [];
  const currentFamilyGroups = Array.isArray(state.view?.family_artist_groups)
    ? state.view.family_artist_groups
    : [];
  const currentSelectedArtist = String(state.view?.selected_artist || '').trim();
  const currentRelatedArtists = Array.isArray(state.view?.related_artists)
    ? state.view.related_artists
    : [];
  const currentSelectedArtistGroups = [...currentPrimaryGroups, ...currentFamilyGroups];
  const query = String(state.view?.query || '').trim();
  const currentSelectedArtistGroupNames = currentSelectedArtistGroups
    .map(resolveGroupArtist)
    .filter(Boolean);
  const expectedFamilyArtistNames = [
    currentSelectedArtist,
    ...currentRelatedArtists.map((relatedArtist) => String(relatedArtist || '').trim()),
  ].filter(Boolean);
  const sameArtistSet = (left, right) => {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    return leftSet.size === rightSet.size
      && [...leftSet].every((value) => rightSet.has(value));
  };
  const hasAuthoritativeMountedFamilyContext = Boolean(
    !query
    && currentSelectedArtist
    && currentSelectedArtistGroups.length > 1
    && currentRelatedArtists.length > 0
    && !Boolean(state.view?.initial_view_partial)
    && String(state.view?.payload_tier || '').trim().toLowerCase() !== 'sidebar'
    && !Boolean(state.view?.primary_filter_active)
    && !(Array.isArray(state.view?.related_filter_artists)
      && state.view.related_filter_artists.length)
    && sameArtistSet(currentSelectedArtistGroupNames, expectedFamilyArtistNames)
  );
  const searchContext = state.view?.search_context;
  const artistNameMatchArtists = Array.isArray(searchContext?.artist_name_match_artists)
    ? searchContext.artist_name_match_artists
    : null;
  const classifiedSearchMatchArtists = [
    ...(Array.isArray(searchContext?.direct_match_artists)
      ? searchContext.direct_match_artists
      : []),
    ...(Array.isArray(searchContext?.related_match_artists)
      ? searchContext.related_match_artists
      : []),
  ];
  const hasClassifiedSearchMatchArtists = (
    Array.isArray(searchContext?.direct_match_artists)
    && Array.isArray(searchContext?.related_match_artists)
  );
  const matchesSearchArtist = (candidate) => (
    String(candidate || '').trim() === normalizedArtist
  );
  const isArtistNameMatch = Boolean(artistNameMatchArtists?.some(matchesSearchArtist));
  const isClassifiedSearchMatch = classifiedSearchMatchArtists.some(matchesSearchArtist);
  const matchedSelectedArtistGroupIndex = currentSelectedArtistGroups.findIndex(matchesArtist);
  const matchedSelectedArtistGroup = matchedSelectedArtistGroupIndex >= 0
    ? currentSelectedArtistGroups[matchedSelectedArtistGroupIndex]
    : null;
  const normalizedQuery = query.toLocaleLowerCase();
  const hasVisibleAlbumTitleMatch = Boolean(
    normalizedQuery
    && (Array.isArray(matchedSelectedArtistGroup?.albums)
      ? matchedSelectedArtistGroup.albums
      : []
    ).some((album) => String(album?.name || '').toLocaleLowerCase().includes(normalizedQuery))
  );
  const canReuseCurrentSelectedArtistFamilyContext = query
    ? Boolean(
      currentSelectedArtist
      && (
        currentFamilyGroups.length
        || currentRelatedArtists.length
      )
      && (
        artistNameMatchArtists === null
        || isArtistNameMatch
        || (
          hasClassifiedSearchMatchArtists
          && !isClassifiedSearchMatch
          && !hasVisibleAlbumTitleMatch
        )
      )
    )
    : hasAuthoritativeMountedFamilyContext;
  if (matchedSelectedArtistGroupIndex >= 0) {
    const optimisticMatchedSelectedArtistGroup = deepCloneJson(matchedSelectedArtistGroup);
    const selectedAlbumKeys = new Set(
      (matchedSelectedArtistGroup.albums || []).map((album) => album.key),
    );
    const hasUnresolvedAlbumMembership = currentSelectedArtistGroups.some((group) => (
      (group.albums || []).some((album) => (
        !selectedAlbumKeys.has(album.key)
        && Array.isArray(album.artists)
        && album.artists.includes(normalizedArtist)
      ))
    ));
    const familyGroups = currentSelectedArtistGroups
      .filter((_, index) => index !== matchedSelectedArtistGroupIndex)
      .map((group) => deepCloneJson(group));
    const relatedArtists = [];
    const seenRelatedArtists = new Set();
    familyGroups.forEach((group) => {
      const groupArtist = resolveGroupArtist(group);
      if (!groupArtist || seenRelatedArtists.has(groupArtist)) return;
      seenRelatedArtists.add(groupArtist);
      relatedArtists.push(groupArtist);
    });
    return {
      primaryGroups: [optimisticMatchedSelectedArtistGroup],
      familyGroups,
      relatedArtists,
      skipFetch: canReuseCurrentSelectedArtistFamilyContext && !hasUnresolvedAlbumMembership && (
        Boolean(query) || (
          optimisticMatchedSelectedArtistGroup.albums?.length
          === readSidebarAlbumCount(state.view?.artists_sidebar, normalizedArtist)
        )
      ),
    };
  }
  const currentArtistGroups = Array.isArray(state.view?.artist_groups)
    ? state.view.artist_groups
    : [];
  const matchedGroup = currentArtistGroups.find(matchesArtist);
  if (!matchedGroup) return null;
  return {
    primaryGroups: [deepCloneJson(matchedGroup)],
    familyGroups: [],
    relatedArtists: [],
  };
}

function scheduleCachedSelectedArtistReconcile(nextView) {
  clearPendingSelectedArtistReconcile();
  const reconcile = () => {
    state.ui.pendingSelectedArtistReconcileTimer = 0;
    const activeQuery = String(state.view?.query || '').trim();
    const activeSearchDraft = String(state.ui?.searchDraftQuery ?? activeQuery).trim();
    const activeSelectedArtist = String(state.view?.selected_artist || '').trim();
    if (state.ui?.pendingSearchCommitTimer && activeSearchDraft !== activeQuery) return;
    if (activeQuery !== String(nextView.query || '').trim()) return;
    if (activeSelectedArtist !== String(nextView.selected_artist || '').trim()) return;
    const activeRelatedArtists = Array.isArray(state.view?.related_filter_artists) ? state.view.related_filter_artists : [];
    if (activeRelatedArtists.length || Boolean(state.view?.primary_filter_active)) return;
    const trackModalOpen = !document.getElementById('track-modal')?.hidden;
    if (trackModalOpen) {
      state.ui.pendingSelectedArtistReconcileTimer = scheduleBrowserTimeout(reconcile, 500);
      return;
    }
    fetchAndRender(buildApiUrl(nextView, {
      omitSidebar: true,
    }), false, {
      preserveScroll: true,
      skipPendingViewTransition: true,
    });
  };
  state.ui.pendingSelectedArtistReconcileTimer = scheduleBrowserTimeout(
    reconcile,
    CACHED_SELECTED_ARTIST_RECONCILE_DELAY_MS,
  );
}

function isCompleteReusableSelectedArtistBrowseView(view, selectedArtist) {
  const normalizedSelectedArtist = String(selectedArtist || '').trim();
  if (!normalizedSelectedArtist) return false;
  const primaryGroup = (Array.isArray(view?.primary_artist_groups)
    ? view.primary_artist_groups
    : []
  ).find((group) => (
    String(group?.artist || group?.artist_display || '').trim() === normalizedSelectedArtist
  ));
  const albums = Array.isArray(primaryGroup?.albums) ? primaryGroup.albums : [];
  const expectedAlbumCount = [
    readSidebarAlbumCount(view?.artists_sidebar, normalizedSelectedArtist),
    readSidebarAlbumCount(state.view?.artists_sidebar, normalizedSelectedArtist),
  ].reduce(
    (largestCount, count) => (
      count === null || (largestCount !== null && largestCount >= count)
        ? largestCount
        : count
    ),
    null,
  );
  return expectedAlbumCount !== null
    && albums.length === expectedAlbumCount
    && albums.every((album) => !Boolean(album?.preview_only));
}

function tryRenderOptimisticSidebarArtistSelection(nextView, options = {}) {
  const query = String(state.view?.query || '').trim();
  const optimisticGroups = buildOptimisticSidebarArtistSelectionGroups(nextView.selected_artist);
  const reusableSelectedArtistBrowseView = query
    && (!optimisticGroups || optimisticGroups.skipFetch)
    && typeof getReusableSelectedArtistBrowseView === 'function'
    ? getReusableSelectedArtistBrowseView(nextView)
    : null;
  if (reusableSelectedArtistBrowseView) {
    state.ui.viewStateRevision = Number(state.ui.viewStateRevision || 0) + 1;
    applyViewPayload({
      ...reusableSelectedArtistBrowseView,
      query: nextView.query,
      selected_artist: nextView.selected_artist,
      all_artists_active: nextView.all_artists_active,
      visible_library_categories: nextView.visible_library_categories,
      related_filter_artists: nextView.related_filter_artists,
      primary_filter_active: nextView.primary_filter_active,
      search_context: nextView.search_context,
    }, {
      trackSidebarReveal: false,
    });
    renderView({
      preserveScroll: true,
      resetScrollForUserArtistSelection: true,
    });
    pushBrowserViewState(nextView);
    if (options.forceFetch || !isCompleteReusableSelectedArtistBrowseView(
      reusableSelectedArtistBrowseView,
      nextView.selected_artist,
    )) {
      scheduleCachedSelectedArtistReconcile(nextView);
    }
    return true;
  }
  if (!optimisticGroups) return false;
  if (!query && !optimisticGroups.skipFetch) return false;
  state.ui.viewStateRevision = Number(state.ui.viewStateRevision || 0) + 1;
  const optimisticPrimaryGroups = optimisticGroups.primaryGroups;
  const optimisticFamilyGroups = optimisticGroups.familyGroups;
  const optimisticRelatedArtists = Array.isArray(optimisticGroups.relatedArtists)
    ? optimisticGroups.relatedArtists
    : [];
  const shouldSkipFetch = Boolean(optimisticGroups.skipFetch) && options.forceFetch !== true;
  const optimisticArtistGroups = typeof buildSelectedArtistRuntimeArtistGroups === 'function'
    ? buildSelectedArtistRuntimeArtistGroups(nextView, optimisticPrimaryGroups, optimisticFamilyGroups)
    : [...optimisticPrimaryGroups, ...optimisticFamilyGroups];
  applyViewPayload({
    ...state.view,
    ...nextView,
    related_artists: optimisticRelatedArtists,
    primary_artist_groups: optimisticPrimaryGroups,
    family_artist_groups: optimisticFamilyGroups,
    ...(optimisticFamilyGroups.length ? {
      related_filter_base_primary_groups: optimisticPrimaryGroups,
      related_filter_base_family_groups: optimisticFamilyGroups,
    } : {}),
    artist_groups: optimisticArtistGroups,
    artist_count: optimisticPrimaryGroups.length + optimisticFamilyGroups.length,
    album_count: optimisticArtistGroups.reduce((sum, group) => sum + ((group?.albums || []).length), 0),
  }, {
    trackSidebarReveal: false,
  });
  renderView({
    preserveScroll: true,
    resetScrollForUserArtistSelection: true,
    ...(!query && shouldSkipFetch
      ? { preserveMountedGalleryChildren: true }
      : {}),
  });
  pushBrowserViewState(nextView);
  if (shouldSkipFetch) {
    return true;
  }
  fetchAndRender(buildApiUrl(nextView, {
    omitSidebar: true,
  }), false, {
    preserveScroll: true,
    restartIfSameUrl: true,
    skipPendingViewTransition: true,
  });
  return true;
}

function readReusableRootBrowseViewForClearedSearch(nextView) {
  return typeof getReusableRootBrowseView === 'function'
    ? getReusableRootBrowseView({
      ...(nextView.gallery_display_mode ? { gallery_display_mode: nextView.gallery_display_mode } : {}),
      ...(nextView.gallery_scale_percent != null ? { gallery_scale_percent: nextView.gallery_scale_percent } : {}),
      query: '',
      selected_artist: '',
      all_artists_active: true,
      gallery_scope: nextView.gallery_scope,
      visible_library_categories: nextView.visible_library_categories,
      related_filter_artists: [],
      primary_filter_active: false,
    })
    : null;
}

function readSidebarAlbumCount(sidebar, selectedArtist) {
  if (!Array.isArray(sidebar)) return null;
  const normalizedSelectedArtist = String(selectedArtist || '').trim();
  if (!normalizedSelectedArtist) return null;
  const match = sidebar.find(
    (item) => String(item?.artist || '').trim() === normalizedSelectedArtist
  );
  const count = Number(match?.count);
  return Number.isFinite(count) && count > 0 ? count : null;
}

function readMountedSelectedPrimaryAlbumCount(selectedArtist) {
  const normalizedSelectedArtist = String(selectedArtist || '').trim();
  if (!normalizedSelectedArtist) return null;
  const selectedGroup = (Array.isArray(state.view?.primary_artist_groups)
    ? state.view.primary_artist_groups
    : []
  ).find((group) => (
    String(group?.artist || group?.artist_display || '').trim() === normalizedSelectedArtist
  ));
  return Array.isArray(selectedGroup?.albums) ? selectedGroup.albums.length : null;
}

function readSelectedArtistCompletionDenominator(selectedArtist) {
  const normalizedSelectedArtist = String(selectedArtist || '').trim();
  const artistScope = state.view?.listen_through_scope_candidates?.artist;
  if (
    !normalizedSelectedArtist
    || String(artistScope?.artist_ref || '').trim() !== normalizedSelectedArtist
  ) {
    return null;
  }
  const count = Number(artistScope?.local_completion_denominator?.album_count);
  return Number.isFinite(count) && count > 0 ? count : null;
}

function isMountedSelectedGalleryComplete(selectedArtist, reusableRootBrowseView) {
  const normalizedSelectedArtist = String(selectedArtist || '').trim();
  const hasActiveFamilyFilter = Boolean(
    state.view?.primary_filter_active
    || (Array.isArray(state.view?.related_filter_artists) && state.view.related_filter_artists.length)
  );
  if (hasActiveFamilyFilter) {
    return Array.isArray(state.view?.artist_groups) && state.view.artist_groups.length > 0;
  }
  const canonicalRootAlbumCount = readSidebarAlbumCount(
    reusableRootBrowseView?.artists_sidebar,
    normalizedSelectedArtist,
  );
  const capturedPreSearchView = (
    state.ui.preSearchView
    && typeof state.ui.preSearchView === 'object'
  )
    ? state.ui.preSearchView
    : null;
  const capturedSelectedArtist = String(
    capturedPreSearchView?.selected_artist || '',
  ).trim();
  const currentSidebarCanCertifyCompleteness = Boolean(
    !capturedPreSearchView
    || capturedSelectedArtist === normalizedSelectedArtist
  );
  const completionDenominator = readSelectedArtistCompletionDenominator(
    normalizedSelectedArtist,
  );
  const currentSidebarAlbumCount = currentSidebarCanCertifyCompleteness
    ? readSidebarAlbumCount(state.view?.artists_sidebar, normalizedSelectedArtist)
    : null;
  const capturedSidebarMatchesSources = Array.isArray(
    capturedPreSearchView?.sidebar_library_categories,
  ) && gallerySourceScopesEqual(
    capturedPreSearchView.sidebar_library_categories,
    state.gallery.mainState
      ? activeGallerySourceCategories(state.gallery.mainState)
      : state.view.visible_library_categories || [],
  );
  const capturedSidebarAlbumCount = capturedSidebarMatchesSources
    ? readSidebarAlbumCount(capturedPreSearchView.artists_sidebar, normalizedSelectedArtist)
    : null;
  const expectedAlbumCount = [
    completionDenominator,
    canonicalRootAlbumCount,
    capturedSidebarAlbumCount,
    currentSidebarAlbumCount,
  ].reduce(
    (largestCount, count) => (
      count === null || (largestCount !== null && largestCount >= count)
        ? largestCount
        : count
    ),
    null,
  );
  const mountedAlbumCount = readMountedSelectedPrimaryAlbumCount(selectedArtist);
  return expectedAlbumCount !== null
    && mountedAlbumCount !== null
    && mountedAlbumCount === expectedAlbumCount;
}

function tryRestoreClearedSearchView(nextView, options = {}) {
  const preserveHomeBrowseContext = Boolean(
    String(nextView?.surface?.active || '').trim().toLowerCase() === 'home'
    && !String(nextView?.selected_artist || '').trim()
  );
  const reusableRootBrowseView = Object.prototype.hasOwnProperty.call(
    options,
    'reusableRootBrowseView',
  )
    ? options.reusableRootBrowseView
    : readReusableRootBrowseViewForClearedSearch(nextView);
  const capturedPreSearchView = (
    state.ui?.preSearchView
    && typeof state.ui.preSearchView === 'object'
  )
    ? state.ui.preSearchView
    : null;
  const sidebarRestoreSource = (
    Array.isArray(capturedPreSearchView?.artists_sidebar)
    && capturedPreSearchView.artists_sidebar.length
  )
    ? capturedPreSearchView
    : reusableRootBrowseView;
  const cachedSidebar = Array.isArray(sidebarRestoreSource?.artists_sidebar)
    ? buildRestoredSearchSidebar(
      sidebarRestoreSource.artists_sidebar,
      nextView.selected_artist,
    )
    : null;
  if (!cachedSidebar || !cachedSidebar.length) {
    return false;
  }
  const cachedRootIsPreviewOnly = Boolean(
    reusableRootBrowseView?.initial_view_partial
    || String(reusableRootBrowseView?.payload_tier || '').trim().toLowerCase() === 'sidebar'
  );
  const preserveRetainedSelectedArtistSidebar = Boolean(
    String(nextView?.selected_artist || '').trim()
  );
  const retainedMountedGalleryGroups = (
    preserveRetainedSelectedArtistSidebar
    && Array.isArray(state.view?.artist_groups)
    && state.view.artist_groups.length
  )
    ? state.view.artist_groups
    : null;
  const retainedMountedPrimaryGroups = retainedMountedGalleryGroups
    && Array.isArray(state.view?.primary_artist_groups)
    ? state.view.primary_artist_groups
    : null;
  const retainedMountedFamilyGroups = retainedMountedGalleryGroups
    && Array.isArray(state.view?.family_artist_groups)
    ? state.view.family_artist_groups
    : null;
  const cachedRootGalleryGroups = (
    !preserveRetainedSelectedArtistSidebar
    && Array.isArray(reusableRootBrowseView?.artist_groups)
    && reusableRootBrowseView.artist_groups.length
  )
    ? deepCloneJson(reusableRootBrowseView.artist_groups)
    : null;
  const cachedRootPrimaryGroups = cachedRootGalleryGroups
    ? (
      Array.isArray(reusableRootBrowseView?.primary_artist_groups)
      && reusableRootBrowseView.primary_artist_groups.length
        ? deepCloneJson(reusableRootBrowseView.primary_artist_groups)
        : cachedRootGalleryGroups
    )
    : null;
  const cachedRootFamilyGroups = cachedRootGalleryGroups
    ? (
      Array.isArray(reusableRootBrowseView?.family_artist_groups)
        ? deepCloneJson(reusableRootBrowseView.family_artist_groups)
        : []
    )
    : null;
  state.gallery.sidebarArtistsOverride = null;
  state.gallery.sidebarShowAllArtistsOverride = null;
  const restoredView = {
    ...state.view,
    ...nextView,
    artists_sidebar: cachedSidebar,
    ...(cachedRootGalleryGroups
      ? {
        artist_groups: cachedRootGalleryGroups,
        primary_artist_groups: cachedRootPrimaryGroups,
        family_artist_groups: cachedRootFamilyGroups,
        album_count: cachedRootGalleryGroups.reduce(
          (sum, group) => sum + (Array.isArray(group?.albums) ? group.albums.length : 0),
          0,
        ),
      }
      : {}),
    ...(
      Object.prototype.hasOwnProperty.call(sidebarRestoreSource || {}, 'artist_count')
      && Number.isFinite(Number(sidebarRestoreSource.artist_count))
        ? { artist_count: Number(sidebarRestoreSource.artist_count) }
        : {}
    ),
    show_all_artists_sidebar_link: sidebarRestoreSource.show_all_artists_sidebar_link !== false,
  };
  if (retainedMountedGalleryGroups) {
    applyViewPayload(restoredView, { preserveMountedGalleryChildren: true });
  } else {
    applyViewPayload(restoredView);
  }
  if (retainedMountedGalleryGroups) {
    state.view.artist_groups = retainedMountedGalleryGroups;
    if (retainedMountedPrimaryGroups) {
      state.view.primary_artist_groups = retainedMountedPrimaryGroups;
    }
    if (retainedMountedFamilyGroups) {
      state.view.family_artist_groups = retainedMountedFamilyGroups;
    }
    clearPendingSelectedArtistReconcile();
    state.ui.viewStateRevision = Number(state.ui.viewStateRevision || 0) + 1;
    state.ui.pendingViewRequest = null;
    const hadPendingTransition = state.ui.pendingViewTransition;
    state.ui.pendingViewTransition = false;
    state.ui.pendingGallerySearch = false;
    state.ui.pendingViewTransitionRequestId = 0;
    if (hadPendingTransition) renderLibraryLoader(state.status);
    renderSidebar();
    pushBrowserViewState(nextView);
    return true;
  }
  renderView();
  pushBrowserViewState(nextView);
  fetchAndRender(buildApiUrl(
    preserveHomeBrowseContext
      ? {
        ...nextView,
        surface: {
          ...(nextView.surface || {}),
          active: 'albums',
        },
        surface_request: 'albums',
      }
      : nextView,
    {
      omitSidebar: (
        preserveHomeBrowseContext
        || preserveRetainedSelectedArtistSidebar
        || !cachedRootIsPreviewOnly
      ),
    },
  ), false, {
    preserveScroll: true,
    restartIfSameUrl: true,
    ...(
      preserveHomeBrowseContext || preserveRetainedSelectedArtistSidebar
        ? { preserveSidebarState: true }
        : {}
    ),
    ...(preserveHomeBrowseContext ? { completePageEntryBrowseContext: true } : {}),
  });
  return true;
}

function handleGalleryBootstrapMouseOver(event) {
  const albumCard = event.target.closest('.album-card');
  if (albumCard) {
    scheduleGalleryFocusGlow(albumCard);
    return;
  }
  if (event.target.closest('#artist-groups')) {
    hideGalleryFocusGlow();
  }
  return false;
}

function handleGalleryBootstrapMouseOut(event) {
  if (!event.target.closest('.album-card')) return;
  const related = event.relatedTarget;
  if (related instanceof Node && related.closest && related.closest('.album-card')) return;
  hideGalleryFocusGlow();
}

function handleGalleryBootstrapFocusIn(event) {
  const albumCard = event.target.closest('.album-card');
  if (albumCard) {
    scheduleGalleryFocusGlow(albumCard);
  }
  return true;
}

function handleGalleryBootstrapFocusOut(event) {
  if (!event.target.closest('.album-card')) return;
  const next = event.relatedTarget;
  if (next instanceof Node && next.closest && next.closest('.album-card')) return;
  hideGalleryFocusGlow();
}

function handleGalleryBootstrapSearchBlur() {
  const input = document.getElementById('search-input');
  if (!input) return;
  closeRecentSearchPopover();
  state.ui.pendingSearchClearOnBlur = false;
  if (String(state.ui.searchDraftQuery || '') !== String(state.view?.query || '')) {
    releasePendingGallerySearchSuspensions();
  }
}

function handleGalleryBootstrapAlbumsScroll() {
  // The glow is positioned in the same scrollable viewport coordinate space as album cards,
  // so normal vertical scrolling moves them together without needing a forced recompute.
}

function handleGalleryBootstrapResize() {
  if (state.gallery.focusedAlbumGlowCard instanceof HTMLElement) {
    scheduleGalleryFocusGlow(state.gallery.focusedAlbumGlowCard, { force: true });
  }
  syncArtistsDrawerVisibility();
}

function syncSearchClear() {
  const input = document.getElementById('search-input');
  if (!input) return;
  const normalizedQuery = updateGallerySearchDraftQuery(input.value || '');
  state.ui.pendingSearchClearOnBlur = false;
  clearPendingGallerySearchCommit();
  releasePendingGallerySearchSuspensions();
  if (!normalizedQuery.trim()) closeRecentSearchPopover();
}

function handleGalleryBootstrapPopState(options = {}) {
  invalidateAdvancedSearchIntent('history');
  if (window.AlbumHavenPlaylistRuntime?.restoreDraftFromHistory?.()) return;
  if (typeof syncGalleryMainStateFromLocation === 'function') syncGalleryMainStateFromLocation(options.parentViewUrl);
  return fetchAndRender(options.parentViewUrl || getBrowserLocationHref(), false, options);
}
