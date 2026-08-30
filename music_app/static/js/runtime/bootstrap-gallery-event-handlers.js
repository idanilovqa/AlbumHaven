function handleGalleryBootstrapClick(event) {
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
  if (!event.target.closest('#gallery-options-menu, [data-open-gallery-options="1"]') && state.gallery.menuOpen) {
    hideGalleryOptionsMenu();
  }
  const galleryOptionsButton = event.target.closest('[data-open-gallery-options="1"]');
  if (galleryOptionsButton) {
    event.preventDefault();
    if (state.gallery.menuOpen) hideGalleryOptionsMenu();
    else showGalleryOptionsMenu(galleryOptionsButton);
    return;
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

  const galleryCategoryToggle = event.target.closest('[data-gallery-category-toggle]');
  if (galleryCategoryToggle && !galleryCategoryToggle.disabled) {
    event.preventDefault();
    const category = String(galleryCategoryToggle.getAttribute('data-gallery-category-toggle') || '').trim();
    const currentCategories = typeof resolveMainGalleryCategorySelection === 'function'
      ? resolveMainGalleryCategorySelection(state.view?.visible_library_categories)
      : ['main_library', 'hoard', 'new_arrivals'];
    const nextCategories = currentCategories.includes(category)
      ? currentCategories.filter((item) => item !== category)
      : [...currentCategories, category];
    fetchAndRender(buildUrl({
      ...state.view,
      gallery_scope: 'all',
      visible_library_categories: nextCategories,
      related_filter_artists: [],
      primary_filter_active: false,
    }), true);
    return;
  }

  const openNewArrivalsButton = event.target.closest('[data-open-new-arrivals="1"]');
  if (openNewArrivalsButton) {
    event.preventDefault();
    fetchAndRender(buildUrl({
      ...state.view,
      gallery_scope: 'new_arrivals',
      visible_library_categories: ['new_arrivals'],
      related_filter_artists: [],
      primary_filter_active: false,
    }), true);
    return;
  }

  const openMainGalleryButton = event.target.closest('[data-open-main-gallery="1"]');
  if (openMainGalleryButton) {
    event.preventDefault();
    const restoredCategories = typeof resolveMainGalleryCategorySelection === 'function'
      ? resolveMainGalleryCategorySelection(state.view?.visible_library_categories)
      : ['main_library', 'hoard', 'new_arrivals'];
    fetchAndRender(buildUrl({
      ...state.view,
      gallery_scope: 'all',
      visible_library_categories: restoredCategories,
      related_filter_artists: [],
      primary_filter_active: false,
    }), true);
    return;
  }

  const openNonAlbumModalButton = event.target.closest('[data-open-non-album-modal="1"]');
  if (openNonAlbumModalButton) {
    event.preventDefault();
    hideGalleryOptionsMenu();
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

  const albumAction = event.target.closest('[data-album-card-action]');
  if (albumAction) {
    event.preventDefault();
    const action = albumAction.getAttribute('data-album-card-action') || '';
    const menu = document.getElementById('album-card-context-menu');
    const album = getIndexedAlbum(menu?.dataset.albumKey || '');

    hideAlbumCardContextMenu();

    if (action === 'open-explorer') {
      openAlbumInExplorer(album);
      return;
    }

    if (action === 'move_to_hoard' || action === 'move_to_library') {
      performAlbumMove(album, action);
      return;
    }

    if (action === 'mark-version') {
      openVersionPickerModal(album);
      return;
    }

    if (action === 'unmark-version') {
      unmarkAlbumVersion(album?.key || '');
      return;
    }

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
      renderTrackModalRelease(state.modalReleases[index]);
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

function handleSidebarArtistSelectionClick(event) {
  const sidebarArtistLink = event.target.closest('[data-sidebar-artist]');
  if (!sidebarArtistLink) return false;

  event.preventDefault();
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
  const activeSearchQuery = String(state.view?.query || '').trim();
  const nextView = {
    ...state.view,
    selected_artist: artist,
    all_artists_active: false,
    related_filter_artists: [],
    primary_filter_active: false,
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
  const currentSelectedArtist = String(state.view?.selected_artist || '').trim();
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
  if (!isUnrelatedFamilyTransition && tryRenderOptimisticSidebarArtistSelection(nextView)) {
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
  if (!ui) return [];
  if (!ui.recentSearchesLoaded) {
    const storedValue = getSessionStorageItem(RECENT_SEARCH_STORAGE_KEY, '');
    if (storedValue) {
      try {
        ui.recentSearchQueries = normalizeRecentSearchQueries(JSON.parse(storedValue));
      } catch (_error) {
        ui.recentSearchQueries = [];
        if (typeof removeSessionStorageItem === 'function') {
          removeSessionStorageItem(RECENT_SEARCH_STORAGE_KEY);
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
  if (!ui) return false;
  const key = value.toLocaleLowerCase();
  ui.recentSearchQueries = [
    value,
    ...readRecentSearchQueries().filter((item) => item.toLocaleLowerCase() !== key),
  ].slice(0, RECENT_SEARCH_LIMIT);
  setSessionStorageItem(RECENT_SEARCH_STORAGE_KEY, JSON.stringify(ui.recentSearchQueries));
  return true;
}

function getRecentSearchElements() {
  return {
    input: document.getElementById('search-input'),
    popover: document.getElementById('recent-search-popover'),
  };
}

function renderRecentSearchPopover() {
  const ui = ensureRecentSearchState();
  const { input, popover } = getRecentSearchElements();
  if (!ui || !input || !popover) return;
  const queries = readRecentSearchQueries();
  const open = Boolean(ui.recentSearchPopoverOpen && queries.length);
  if (ui.recentSearchActiveIndex >= queries.length) ui.recentSearchActiveIndex = -1;
  popover.innerHTML = queries.map((query, index) => {
    const selected = open && index === ui.recentSearchActiveIndex;
    return `<button class="recent-search-option" id="recent-search-option-${index}" type="button" role="option" tabindex="-1" data-recent-search-index="${index}" aria-selected="${selected ? 'true' : 'false'}">${escapeHtml(query)}</button>`;
  }).join('');
  popover.hidden = !open;
  input.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open && ui.recentSearchActiveIndex >= 0) {
    input.setAttribute('aria-activedescendant', `recent-search-option-${ui.recentSearchActiveIndex}`);
    popover.querySelector?.(`#recent-search-option-${ui.recentSearchActiveIndex}`)?.scrollIntoView?.({
      block: 'nearest',
    });
  } else {
    input.removeAttribute('aria-activedescendant');
  }
}

function openRecentSearchPopover() {
  const ui = ensureRecentSearchState();
  if (!ui || !readRecentSearchQueries().length) return false;
  ui.recentSearchPopoverOpen = true;
  ui.recentSearchActiveIndex = -1;
  renderRecentSearchPopover();
  return true;
}

function closeRecentSearchPopover() {
  const ui = ensureRecentSearchState();
  if (!ui) return;
  ui.recentSearchPopoverOpen = false;
  ui.recentSearchActiveIndex = -1;
  renderRecentSearchPopover();
}

function selectRecentSearchQuery(query) {
  const { input } = getRecentSearchElements();
  const value = String(query || '').trim();
  if (!input || !value) return false;
  input.value = value;
  closeRecentSearchPopover();
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
  const option = event.target.closest('[data-recent-search-index]');
  if (option) {
    event.preventDefault();
    const queries = readRecentSearchQueries();
    return selectRecentSearchQuery(queries[Number(option.getAttribute('data-recent-search-index'))]);
  }
  if (event.target.closest('#search-input')) {
    openRecentSearchPopover();
    return false;
  }
  closeRecentSearchPopover();
  return false;
}

function handleGalleryBootstrapSearchMouseDown(event) {
  if (!event.target.closest('[data-recent-search-index]')) return false;
  event.preventDefault();
  return true;
}

function handleGalleryBootstrapSearchKeyDown(event) {
  const ui = ensureRecentSearchState();
  if (!ui) return false;
  const queries = readRecentSearchQueries();
  const open = Boolean(ui.recentSearchPopoverOpen && queries.length);
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
    return selectRecentSearchQuery(queries[ui.recentSearchActiveIndex]);
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
  if (!queries.length) return false;
  event.preventDefault();
  if (!open) {
    ui.recentSearchPopoverOpen = true;
    ui.recentSearchActiveIndex = -1;
  }
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

function updateGallerySearchDraftQuery(nextQuery) {
  const normalizedQuery = String(nextQuery || '');
  if (state.ui && typeof state.ui === 'object') {
    state.ui.searchDraftQuery = normalizedQuery;
  }
  return normalizedQuery;
}

function clearPendingGallerySearchCommit() {
  if (!state.ui || typeof state.ui !== 'object') return;
  clearBrowserTimeout(state.ui.pendingSearchCommitTimer);
  state.ui.pendingSearchCommitTimer = 0;
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

function scheduleGallerySearchCommit(nextQuery, options = {}) {
  const normalizedQuery = updateGallerySearchDraftQuery(nextQuery);
  const committedQuery = String(state.view?.query || '');
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
  if (normalizedQuery === committedQuery && !shouldReselectCommittedQuery) {
    clearPendingGallerySearchCommit();
    if (options.recordRecentSearch === true) recordRecentSearchQuery(normalizedQuery);
    return false;
  }
  clearPendingGallerySearchCommit();
  const commitSearch = () => {
    state.ui.pendingSearchCommitTimer = 0;
    commitGallerySearchQuery(normalizedQuery, {
      recordRecentSearch: options.recordRecentSearch === true,
      scanPageAbandonHandled: options.scanPageAbandonHandled === true,
    });
  };
  if (options.immediate) {
    commitSearch();
    return true;
  }
  state.ui.pendingSearchCommitTimer = scheduleBrowserTimeout(
    commitSearch,
    SEARCH_COMMIT_DEBOUNCE_MS,
  );
  return true;
}

function handleGalleryBootstrapSearchSubmit(event) {
  event.preventDefault();
  const input = document.getElementById('search-input');
  const nextQuery = input?.value || '';
  closeRecentSearchPopover();
  const scanPageIsVisible = Boolean(
    state.ui.scanPageReturnContext
    || state.ui.forceScanPageVisible
  );
  const queryChanged = nextQuery !== String(state.view?.query || '');
  const scanPageWasAbandoned = scanPageIsVisible
    ? abandonScanPageForNavigation(queryChanged ? { clearSelection: true } : {})
    : false;
  const searchWasScheduled = scheduleGallerySearchCommit(nextQuery, {
    immediate: true,
    recordRecentSearch: true,
    scanPageAbandonHandled: true,
  });
  if (scanPageWasAbandoned && !searchWasScheduled) {
    renderView();
  }
  input?.blur?.();
}

function handleGalleryBootstrapSearchInput(nextQuery) {
  clearPendingSelectedArtistReconcile();
  const prewarmSearchGeneration = beginAlbumDetailPrewarmSearchSuspension();
  beginSearchWaveformPeakLoadSuspension();
  if (typeof cancelTrackModalAlbumDetailsPrewarms === 'function') {
    cancelTrackModalAlbumDetailsPrewarms();
  }
  const normalizedQuery = updateGallerySearchDraftQuery(nextQuery);
  const ui = ensureRecentSearchState();
  if (ui && !String(normalizedQuery || '').trim()) {
    closeRecentSearchPopover();
  }
  if (ui && ui.recentSearchActiveIndex >= 0) {
    ui.recentSearchActiveIndex = -1;
    renderRecentSearchPopover();
  }
  if (normalizedQuery === String(state.view?.query || '')) {
    clearPendingGallerySearchCommit();
    releaseAlbumDetailPrewarmSearchSuspension(prewarmSearchGeneration);
    releasePendingSearchWaveformPeakLoadSuspension();
    return;
  }
  scheduleGallerySearchCommit(normalizedQuery);
}

function commitGallerySearchQuery(nextQuery, options = {}) {
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
  updateGallerySearchDraftQuery(normalizedQuery);
  if (options.recordRecentSearch === true) {
    recordRecentSearchQuery(normalizedQuery);
  }
  if (!String(normalizedQuery || '').trim()) {
    const effectiveSelectedArtist = resolveEffectiveSearchSelectedArtist(state.view);
    if (
      !String(state.view.query || '').trim()
      && effectiveSelectedArtist === String(state.view.selected_artist || '').trim()
    ) {
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
    const next = buildClearedSearchView();
    const reusableRootBrowseView = readReusableRootBrowseViewForClearedSearch(next);
    const retainsSelectedArtist = Boolean(String(next?.selected_artist || '').trim());
    const mountedSelectedGalleryComplete = Boolean(
      retainsSelectedArtist
      && isMountedSelectedGalleryComplete(next.selected_artist, reusableRootBrowseView)
    );
    const canRestoreCachedClear = Boolean(
      !retainsSelectedArtist
      || mountedSelectedGalleryComplete
    );
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
  const next = {
    ...state.view,
    query: normalizedQuery,
    selected_artist: '',
    all_artists_active: false,
    related_filter_artists: [],
    primary_filter_active: false,
  };
  state.gallery.sidebarArtistsOverride = null;
  state.gallery.sidebarShowAllArtistsOverride = null;
  state.ui.pendingSearchClearOnBlur = false;
  let coverLoadSuspensionToken = 0;
  if (
    typeof virtualGrid !== 'undefined'
    && virtualGrid
    && typeof virtualGrid.suspendSelectedArtistCoverLoadsForUserAction === 'function'
  ) {
    coverLoadSuspensionToken = virtualGrid.suspendSelectedArtistCoverLoadsForUserAction();
  }
  applyViewPayload({
    ...next,
    related_artists: [],
    primary_artist_groups: [],
    family_artist_groups: [],
  }, {
    trackSidebarReveal: false,
  });
  renderRelated();
  const resumeCoverLoads = () => {
    if (
      typeof virtualGrid !== 'undefined'
      && virtualGrid
      && typeof virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction === 'function'
    ) {
      virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(coverLoadSuspensionToken);
    }
  };
  Promise.resolve(fetchAndRender(buildApiUrl(next), true)).then(
    resumeCoverLoads,
    resumeCoverLoads,
  );
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
  const canReuseCurrentSelectedArtistFamilyContext = query
    ? Boolean(
      currentSelectedArtist
      && (
        currentFamilyGroups.length
        || currentRelatedArtists.length
      )
    )
    : hasAuthoritativeMountedFamilyContext;
  const matchedSelectedArtistGroupIndex = currentSelectedArtistGroups.findIndex(matchesArtist);
  if (matchedSelectedArtistGroupIndex >= 0) {
    const matchedSelectedArtistGroup = deepCloneJson(currentSelectedArtistGroups[matchedSelectedArtistGroupIndex]);
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
      primaryGroups: [matchedSelectedArtistGroup],
      familyGroups,
      relatedArtists,
      skipFetch: canReuseCurrentSelectedArtistFamilyContext,
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

function tryRenderOptimisticSidebarArtistSelection(nextView) {
  const query = String(state.view?.query || '').trim();
  const reusableSelectedArtistBrowseView = query
    && typeof getReusableSelectedArtistBrowseView === 'function'
    ? getReusableSelectedArtistBrowseView(nextView)
    : null;
  if (reusableSelectedArtistBrowseView) {
    state.ui.viewStateRevision = Number(state.ui.viewStateRevision || 0) + 1;
    applyViewPayload({
      ...reusableSelectedArtistBrowseView,
      search_context: nextView.search_context,
    }, {
      trackSidebarReveal: false,
    });
    renderView({
      preserveScroll: true,
      resetScrollForUserArtistSelection: true,
    });
    pushBrowserViewState(nextView);
    if (!isCompleteReusableSelectedArtistBrowseView(
      reusableSelectedArtistBrowseView,
      nextView.selected_artist,
    )) {
      scheduleCachedSelectedArtistReconcile(nextView);
    }
    return true;
  }
  const optimisticGroups = buildOptimisticSidebarArtistSelectionGroups(nextView.selected_artist);
  if (!optimisticGroups) return false;
  if (!query && !optimisticGroups.skipFetch) return false;
  state.ui.viewStateRevision = Number(state.ui.viewStateRevision || 0) + 1;
  const optimisticPrimaryGroups = optimisticGroups.primaryGroups;
  const optimisticFamilyGroups = optimisticGroups.familyGroups;
  const optimisticRelatedArtists = Array.isArray(optimisticGroups.relatedArtists)
    ? optimisticGroups.relatedArtists
    : [];
  const shouldSkipFetch = Boolean(optimisticGroups.skipFetch);
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
    skipPendingViewTransition: true,
  });
  return true;
}

function readReusableRootBrowseViewForClearedSearch(nextView) {
  return typeof getReusableRootBrowseView === 'function'
    ? getReusableRootBrowseView({
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
  const expectedAlbumCount = [
    completionDenominator,
    canonicalRootAlbumCount,
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
    state.ui.pendingViewTransition = false;
    state.ui.pendingViewTransitionRequestId = 0;
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
  if (!state.ui.pendingSearchClearOnBlur) return;
  if (String(input.value || '').trim()) {
    state.ui.pendingSearchClearOnBlur = false;
    return;
  }
  if (!String(state.view.query || '').trim()) {
    state.ui.pendingSearchClearOnBlur = false;
    return;
  }
  scheduleGallerySearchCommit('', { immediate: true });
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
  const cleared = !normalizedQuery.trim();
  state.ui.pendingSearchClearOnBlur = Boolean(cleared && String(state.view.query || '').trim());
  if (cleared) {
    scheduleGallerySearchCommit('', { immediate: false });
  }
}

function handleGalleryBootstrapPopState() {
  fetchAndRender(getBrowserLocationHref(), false);
}
