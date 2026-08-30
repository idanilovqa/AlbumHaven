function isEffectivelyEmptyView(view) {
  const v = view || {};
  const sidebarCount = Array.isArray(v.artists_sidebar) ? v.artists_sidebar.length : 0;
  const groupCollections = [
    v.primary_artist_groups,
    v.family_artist_groups,
    v.artist_groups,
  ].map((groups) => (Array.isArray(groups) ? groups : []));
  const [primaryGroups, familyGroups, artistGroups] = groupCollections;
  const primaryCount = primaryGroups.length;
  const familyCount = familyGroups.length;
  const groupCount = artistGroups.length;
  const albumCount = Number(v.album_count) || 0;
  const albumShells = groupCollections
    .flatMap((groups) => groups)
    .flatMap((group) => (Array.isArray(group?.albums) ? group.albums : []));
  const hasGalleryGroups = primaryCount > 0 || familyCount > 0 || groupCount > 0;
  const hasMeaningfulAlbumCard = albumShells.some((album) => {
    if (!album || typeof album !== 'object') return false;
    if (String(album.key || album.album_ref || album.request_key || album.identity_key || '').trim()) {
      return true;
    }
    if (
      Array.isArray(album.track_paths)
      && album.track_paths.some((trackPath) => String(trackPath || '').trim())
    ) {
      return true;
    }
    return Array.isArray(album.tracks)
      && album.tracks.some((track) => String(track?.path || '').trim());
  });
  if (hasGalleryGroups && !hasMeaningfulAlbumCard) {
    return true;
  }
  return !albumCount && !sidebarCount && !primaryCount && !familyCount && !groupCount;
}

function shouldShowLibraryLoader(view, status = {}, options = {}) {
  if (options.scanPageVisible) {
    return true;
  }
  const emptyView = isEffectivelyEmptyView(view);
  const primaryCount = Array.isArray(view?.primary_artist_groups) ? view.primary_artist_groups.length : 0;
  const familyCount = Array.isArray(view?.family_artist_groups) ? view.family_artist_groups.length : 0;
  const groupCount = Array.isArray(view?.artist_groups) ? view.artist_groups.length : 0;
  const sidebarOnlyRootPreview = Boolean(
    !String(view?.query || '').trim()
    && !String(view?.selected_artist || '').trim()
    && Array.isArray(view?.artists_sidebar)
    && view.artists_sidebar.length > 0
    && !primaryCount
    && !familyCount
    && !groupCount
    && !(Number(view?.album_count) || 0)
  );
  const hasSearch = Boolean(String(view?.query || '').trim() || String(view?.selected_artist || '').trim());
  const scanBusy = Boolean(status?.scan_in_progress)
    && String(status?.scan_phase || '').trim().toLowerCase() !== 'finalizing';
  const relBusy = Boolean(status?.relations_in_progress);
  const awaitingInitialDataRefresh = Boolean(options.awaitingInitialDataRefresh);
  const pendingViewTransition = Boolean(options.pendingViewTransition);
  const isLoadingState = scanBusy || relBusy || awaitingInitialDataRefresh || pendingViewTransition;
  const forcedScanPageVisible = Boolean(options.forceScanPageVisible) && (
    isLoadingState
    || !Boolean(status?.scan_in_progress || status?.relations_in_progress || status?.covers_in_progress)
  );
  if (forcedScanPageVisible) {
    return true;
  }
  if (pendingViewTransition) {
    return true;
  }
  if (hasSearch && emptyView) {
    return true;
  }
  if (sidebarOnlyRootPreview && awaitingInitialDataRefresh) {
    return true;
  }
  return emptyView && isLoadingState;
}

function shouldOfferBrowseScannedLibraryAction(view, status = {}, awaitingInitialDataRefresh = false) {
  if (!isEffectivelyEmptyView(view)) {
    return false;
  }
  const browseableAlbumCount = Number(status?.album_total || 0);
  if (browseableAlbumCount <= 100) {
    return false;
  }
  return Boolean(
    status?.scan_in_progress
    || status?.relations_in_progress
    || awaitingInitialDataRefresh
  );
}

function shouldRunImmediateStartupHydration(view, bootstrap = {}) {
  const startupHydration = bootstrap?.startupHydration || {};
  const hydrationNeeded = Boolean(
    bootstrap?.partialView
    || isEffectivelyEmptyView(view)
    || startupHydration.required
  );
  if (!hydrationNeeded) {
    return false;
  }
  const startupWorkActive = Boolean(
    bootstrap?.scanInProgress
    || bootstrap?.relationsInProgress
  );
  return !startupWorkActive || !isEffectivelyEmptyView(view);
}

function deepCloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}
