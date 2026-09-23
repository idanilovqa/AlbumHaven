function invalidatePendingTrackModalLoad() {
  state.ui.pendingTrackModalLoadAlbumKey = '';
  state.ui.pendingTrackModalLoadToken = Number(state.ui.pendingTrackModalLoadToken || 0) + 1;
  return state.ui.pendingTrackModalLoadToken;
}

const trackModalAlbumDetailsLoads = new Map();
const trackModalSpeculativeAlbumDetailsLoadControllers = new Map();
const trackModalHydratedAlbumDetails = new Map();
const trackModalHydratedAlbumDetailsLru = new Map();
const TRACK_MODAL_HYDRATED_ALBUM_DETAILS_LIMIT = 10;
const TRACK_MODAL_SPECULATIVE_PREWARM_LIMIT = 2;
let trackModalActiveSpeculativePrewarms = 0;
const trackModalSpeculativePrewarmControllers = new Set();
const trackModalCoverLoadSuspensionTokens = new Set();

function albumRequiresHydration(album) {
  if (!album || typeof album !== 'object') return false;
  if (album.preview_only === true) return true;
  const tracks = Array.isArray(album.tracks) ? album.tracks : [];
  const declaredTrackCounts = [album.track_count_preview, album.track_count]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return declaredTrackCounts.length > 0 && !declaredTrackCounts.includes(tracks.length);
}

function renderTrackModalLoadingState(album) {
  const els = getTrackModalElements();
  if (!els.overlay || !album) return;
  const headerParts = [album.album_artist || '', album.name || 'Album', album.year || ''].filter(Boolean);
  els.title.textContent = headerParts.join(' - ');
  els.subtitle.textContent = 'Loading album details...';
  if (els.folder) {
    els.folder.dataset.album = '';
    els.folder.dataset.albumKey = String(getAlbumRequestKey(album) || getAlbumIdentity(album) || album?.key || '');
  }
  if (els.editTags) {
    els.editTags.dataset.album = '';
    els.editTags.dataset.albumKey = String(getAlbumRequestKey(album) || getAlbumIdentity(album) || album?.key || '');
  }
  els.cover.innerHTML = `
    <div class="track-modal-cover-shell">
      <div class="cover-placeholder">Loading cover art...</div>
    </div>
  `;
  if (els.missingWarning) {
    els.missingWarning.hidden = true;
    els.missingWarning.innerHTML = '';
  }
  if (els.duplicateWarning) {
    els.duplicateWarning.hidden = true;
    els.duplicateWarning.innerHTML = '';
  }
  if (els.duplicateTabs) {
    els.duplicateTabs.hidden = true;
    els.duplicateTabs.innerHTML = '';
  }
  if (els.tabs) {
    els.tabs.hidden = true;
    els.tabs.innerHTML = '';
  }
  els.list.innerHTML = '<li class="track-modal-loading-row">Loading album details...</li>';
  if (els.footer) {
    els.footer.hidden = true;
    els.footer.textContent = '';
  }
}

function clearTrackModalRenderedState() {
  const els = getTrackModalElements();
  if (!els.overlay) return;
  if (els.title) {
    els.title.textContent = '';
  }
  if (els.subtitle) {
    els.subtitle.textContent = '';
  }
  if (els.cover) {
    els.cover.innerHTML = '';
  }
  if (els.missingWarning) {
    els.missingWarning.hidden = true;
    els.missingWarning.innerHTML = '';
  }
  if (els.duplicateWarning) {
    els.duplicateWarning.hidden = true;
    els.duplicateWarning.innerHTML = '';
  }
  if (els.duplicateTabs) {
    els.duplicateTabs.hidden = true;
    els.duplicateTabs.innerHTML = '';
  }
  if (els.list) {
    els.list.innerHTML = '';
  }
  if (els.footer) {
    els.footer.hidden = true;
    els.footer.textContent = '';
  }
  if (els.tabs) {
    els.tabs.hidden = true;
    els.tabs.innerHTML = '';
  }
  if (els.folder?.dataset) {
    els.folder.dataset.album = '';
    els.folder.dataset.albumKey = '';
  }
  if (els.editTags?.dataset) {
    els.editTags.dataset.album = '';
    els.editTags.dataset.albumKey = '';
  }
}

function openTrackModalShell(album) {
  const els = getTrackModalElements();
  if (!els.overlay || !album) return;
  state.modalReleases = [album];
  state.modalReleaseIndex = 0;
  hideVersionContextMenu();
  renderTrackModalLoadingState(album);
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
}

function suspendGalleryCoverLoadsForTrackModal() {
  if (
    typeof virtualGrid !== 'undefined'
    && virtualGrid
    && typeof virtualGrid.suspendSelectedArtistCoverLoadsForUserAction === 'function'
  ) {
    const token = virtualGrid.suspendSelectedArtistCoverLoadsForUserAction();
    if (token) trackModalCoverLoadSuspensionTokens.add(token);
    return token;
  }
  return 0;
}

function resumeGalleryCoverLoadsAfterTrackModalAction(token = 0) {
  const normalizedToken = Number(token);
  if (!normalizedToken || !trackModalCoverLoadSuspensionTokens.delete(normalizedToken)) return false;
  if (
    typeof virtualGrid !== 'undefined'
    && virtualGrid
    && typeof virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction === 'function'
  ) {
    return virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(normalizedToken);
  }
  return false;
}

function resumeAllGalleryCoverLoadsAfterTrackModalActions() {
  Array.from(trackModalCoverLoadSuspensionTokens).forEach((token) => {
    resumeGalleryCoverLoadsAfterTrackModalAction(token);
  });
}

function getTrackModalAlbumVersionKey(album) {
  if (!album) return '';
  const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase();
  return JSON.stringify([
    normalize(getAlbumRequestKey(album) || getAlbumIdentity(album)),
    normalize(album.album_artist || album.artist),
    normalize(album.name || album.album),
    normalize(album.year),
    normalize(album.edition),
  ]);
}

function cacheHydratedTrackModalAlbum(albumKey, album, options = {}) {
  if (!album) return;
  const requestedKey = String(albumKey || '').trim();
  const resolvedAlbum = attachGalleryPlaybackContextToAlbum(album);
  const liveAliases = getTrackModalAlbumKeyAliases(requestedKey, resolvedAlbum);
  const aliases = Array.from(new Set([
    ...liveAliases,
    ...Array.from(options.aliases || [], (alias) => String(alias || '').trim()),
  ].filter(Boolean)));
  const trustedAliases = new Set(
    Array.from(options.aliases || [], (alias) => String(alias || '').trim()).filter(Boolean),
  );
  const replacedAlbums = new Set(
    aliases.map((alias) => trackModalHydratedAlbumDetails.get(alias)).filter(Boolean),
  );
  const previewAlbumsByAlias = new Map();
  aliases.forEach((alias) => {
    const indexedAlbum = state?.gallery?.albumIndex instanceof Map
      ? state.gallery.albumIndex.get(alias)
      : null;
    if (albumRequiresHydration(indexedAlbum)) previewAlbumsByAlias.set(alias, indexedAlbum);
  });
  replacedAlbums.forEach((replacedAlbum) => {
    const replacedEntry = trackModalHydratedAlbumDetailsLru.get(replacedAlbum);
    replacedEntry?.previewAlbumsByAlias?.forEach((previewAlbum, alias) => {
      if (!previewAlbumsByAlias.has(alias)) previewAlbumsByAlias.set(alias, previewAlbum);
    });
  });
  aliases.forEach((alias) => {
    trackModalHydratedAlbumDetails.set(alias, resolvedAlbum);
  });
  liveAliases.forEach((alias) => {
    if (state?.gallery?.albumIndex instanceof Map) {
      state.gallery.albumIndex.set(alias, resolvedAlbum);
    }
  });
  replacedAlbums.forEach((replacedAlbum) => {
    if (replacedAlbum === resolvedAlbum) return;
    const remainsCached = Array.from(trackModalHydratedAlbumDetails.values())
      .some((cachedAlbum) => cachedAlbum === replacedAlbum);
    if (!remainsCached) trackModalHydratedAlbumDetailsLru.delete(replacedAlbum);
  });
  trackModalHydratedAlbumDetailsLru.delete(resolvedAlbum);
  trackModalHydratedAlbumDetailsLru.set(
    resolvedAlbum,
    {
      aliases,
      previewAlbumsByAlias,
      trustedAliases,
      inventoryMutationRevision: Number(state?.status?.inventory_mutation_revision || 0),
      tagEditMutationClaim: options.tagEditMutationClaim || null,
    },
  );
  while (trackModalHydratedAlbumDetailsLru.size > TRACK_MODAL_HYDRATED_ALBUM_DETAILS_LIMIT) {
    const oldestAlbum = trackModalHydratedAlbumDetailsLru.keys().next().value;
    const oldestEntry = trackModalHydratedAlbumDetailsLru.get(oldestAlbum);
    trackModalHydratedAlbumDetailsLru.delete(oldestAlbum);
    trackModalHydratedAlbumDetails.forEach((cachedAlbum, alias) => {
      if (cachedAlbum === oldestAlbum) trackModalHydratedAlbumDetails.delete(alias);
    });
    if (state?.gallery?.albumIndex instanceof Map) {
      (oldestEntry?.aliases || []).forEach((alias) => {
        if (state.gallery.albumIndex.get(alias) !== oldestAlbum) return;
        const previewAlbum = oldestEntry.previewAlbumsByAlias.get(alias);
        if (previewAlbum) {
          state.gallery.albumIndex.set(alias, previewAlbum);
        } else {
          state.gallery.albumIndex.delete(alias);
        }
      });
    }
  }
}

function invalidateHydratedTrackModalAlbumDetails(albums) {
  const candidates = Array.isArray(albums) ? albums.filter(Boolean) : [];
  if (!candidates.length) return 0;
  const targetAliases = new Set();
  candidates.forEach((album) => {
    getTrackModalAlbumKeyAliases(getAlbumRequestKey(album), album).forEach((alias) => {
      targetAliases.add(alias);
    });
  });
  const invalidatedAlbums = new Set(
    Array.from(targetAliases, (alias) => trackModalHydratedAlbumDetails.get(alias))
      .filter(Boolean),
  );
  invalidatedAlbums.forEach((cachedAlbum) => {
    const cachedEntry = trackModalHydratedAlbumDetailsLru.get(cachedAlbum);
    trackModalHydratedAlbumDetails.forEach((mappedAlbum, alias) => {
      if (mappedAlbum === cachedAlbum) trackModalHydratedAlbumDetails.delete(alias);
    });
    if (state?.gallery?.albumIndex instanceof Map) {
      (cachedEntry?.aliases || []).forEach((alias) => {
        if (state.gallery.albumIndex.get(alias) !== cachedAlbum) return;
        const previewAlbum = cachedEntry.previewAlbumsByAlias.get(alias);
        if (previewAlbum) state.gallery.albumIndex.set(alias, previewAlbum);
        else state.gallery.albumIndex.delete(alias);
      });
    }
    trackModalHydratedAlbumDetailsLru.delete(cachedAlbum);
  });
  return invalidatedAlbums.size;
}

function invalidateAllHydratedTrackModalAlbumDetails() {
  const cachedAlbums = Array.from(trackModalHydratedAlbumDetailsLru.keys()).filter((album) => {
    const claim = trackModalHydratedAlbumDetailsLru.get(album)?.tagEditMutationClaim;
    return !(claim
      && typeof tagEditViewMutationStillOwnsResources === 'function'
      && tagEditViewMutationStillOwnsResources(claim));
  });
  if (!cachedAlbums.length) return 0;
  return invalidateHydratedTrackModalAlbumDetails(cachedAlbums);
}

function getTrackModalAlbumKeyAliases(albumKey, album = null) {
  const normalizedAlbumKey = String(albumKey || '').trim();
  const indexedAlbum = album || getIndexedAlbum(normalizedAlbumKey);
  return Array.from(new Set([
    normalizedAlbumKey,
    String(getAlbumRequestKey(indexedAlbum) || '').trim(),
    String(getAlbumIdentity(indexedAlbum) || '').trim(),
    getTrackModalAlbumVersionKey(indexedAlbum),
  ].filter(Boolean)));
}

function trackModalAlbumsShareLogicalRelease(leftAlbum, rightAlbum) {
  if (!leftAlbum || !rightAlbum) return false;
  const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase();
  return normalize(leftAlbum.album_artist || leftAlbum.artist)
      === normalize(rightAlbum.album_artist || rightAlbum.artist)
    && normalize(leftAlbum.name || leftAlbum.album)
      === normalize(rightAlbum.name || rightAlbum.album)
    && normalize(leftAlbum.year) === normalize(rightAlbum.year)
    && normalize(leftAlbum.edition) === normalize(rightAlbum.edition);
}

function trackModalAlbumsHaveCompatibleMembership(indexedAlbum, cachedAlbum) {
  if (!indexedAlbum || !cachedAlbum) return true;
  const cachedTracks = Array.isArray(cachedAlbum.tracks) ? cachedAlbum.tracks : [];
  if (albumRequiresHydration(indexedAlbum)) {
    const declaredTrackCounts = [indexedAlbum.track_count_preview, indexedAlbum.track_count]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0);
    return !declaredTrackCounts.length || declaredTrackCounts.includes(cachedTracks.length);
  }
  if (!Array.isArray(indexedAlbum.tracks)) return true;
  const trackPaths = (tracks) => new Set(
    tracks.map((track) => String(track?.path || '').trim()).filter(Boolean),
  );
  const indexedPaths = trackPaths(indexedAlbum.tracks);
  const cachedPaths = trackPaths(cachedTracks);
  return indexedPaths.size === cachedPaths.size
    && Array.from(indexedPaths).every((path) => cachedPaths.has(path));
}

function getCachedHydratedTrackModalAlbum(albumKey) {
  const normalizedAlbumKey = String(albumKey || '').trim();
  if (!normalizedAlbumKey) return null;
  const cachedAlbum = trackModalHydratedAlbumDetails.get(normalizedAlbumKey);
  if (cachedAlbum && !albumRequiresHydration(cachedAlbum)) {
    const indexedAlbum = getIndexedAlbum(normalizedAlbumKey);
    const cachedEntry = trackModalHydratedAlbumDetailsLru.get(cachedAlbum);
    const cachedInventoryRevision = Number(cachedEntry?.inventoryMutationRevision || 0);
    const currentInventoryRevision = Number(state?.status?.inventory_mutation_revision || 0);
    const pendingMutationOwnsCachedMembership = Boolean(
      cachedEntry?.tagEditMutationClaim
      && typeof tagEditViewMutationStillOwnsResources === 'function'
      && tagEditViewMutationStillOwnsResources(cachedEntry.tagEditMutationClaim)
    );
    if (
      cachedInventoryRevision !== currentInventoryRevision
      && !pendingMutationOwnsCachedMembership
    ) {
      invalidateHydratedTrackModalAlbumDetails([cachedAlbum]);
      return null;
    }
    const trustedAlias = cachedEntry?.trustedAliases?.has(normalizedAlbumKey);
    if (
      indexedAlbum
      && (
        !trackModalAlbumsShareLogicalRelease(indexedAlbum, cachedAlbum)
        || (!trustedAlias && !trackModalAlbumsHaveCompatibleMembership(indexedAlbum, cachedAlbum))
      )
    ) {
      return null;
    }
    trackModalHydratedAlbumDetailsLru.delete(cachedAlbum);
    trackModalHydratedAlbumDetailsLru.set(cachedAlbum, cachedEntry);
    return cachedAlbum;
  }
  return null;
}

function resolveGalleryPlaybackContext(playbackContext) {
  if (!playbackContext || typeof playbackContext !== 'object') return null;
  return playbackContext;
}

function resolveAlbumPlaybackContextFromView(album) {
  const playbackContext = state?.view?.playback_context;
  if (!playbackContext || typeof playbackContext !== 'object') return null;
  const albumRef = String(getAlbumIdentity(album) || album?.key || '').trim();
  if (!albumRef) return null;
  const orderedAlbumRefs = Array.isArray(playbackContext.ordered_album_refs)
    ? playbackContext.ordered_album_refs.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (!orderedAlbumRefs.includes(albumRef)) return null;
  return resolveGalleryPlaybackContext(playbackContext);
}

function attachGalleryPlaybackContextToAlbum(album) {
  if (!album || typeof album !== 'object') return album;
  const playbackContext = resolveGalleryPlaybackContext(album.playback_context)
    || resolveAlbumPlaybackContextFromView(album);
  if (!playbackContext) return album;
  return {
    ...album,
    playback_context: playbackContext,
  };
}

async function fetchTrackModalAlbumDetails(albumKey, options = {}) {
  const normalizedAlbumKey = String(albumKey || '').trim();
  if (!normalizedAlbumKey) return null;
  const response = await fetch(`/album-details?album_key=${encodeURIComponent(normalizedAlbumKey)}`, {
    headers: { Accept: 'application/json' },
    priority: options.speculative === true ? 'low' : 'high',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }
  if (!response.ok || !payload?.ok || !payload?.album) {
    throw new Error(payload?.error || `Album detail request failed: ${response.status}`);
  }
  return payload.album;
}

function loadTrackModalAlbumDetails(albumKey, options = {}) {
  const normalizedAlbumKey = String(albumKey || '').trim();
  if (!normalizedAlbumKey) return Promise.resolve(null);
  const cachedAlbum = getCachedHydratedTrackModalAlbum(normalizedAlbumKey);
  if (cachedAlbum) return Promise.resolve(cachedAlbum);
  const requestAliases = getTrackModalAlbumKeyAliases(normalizedAlbumKey);
  const existingLoad = requestAliases
    .map((alias) => trackModalAlbumDetailsLoads.get(alias))
    .find(Boolean);
  if (existingLoad) {
    const speculativeController = trackModalSpeculativeAlbumDetailsLoadControllers.get(existingLoad);
    if (options.speculative === true || !speculativeController) return existingLoad;
    trackModalSpeculativeAlbumDetailsLoadControllers.delete(existingLoad);
    trackModalSpeculativePrewarmControllers.delete(speculativeController);
    return existingLoad;
  }
  const requestInventoryRevision = Number(state?.status?.inventory_mutation_revision || 0);
  let load = null;
  load = fetchTrackModalAlbumDetails(normalizedAlbumKey, options)
    .then((album) => {
      const currentAlbum = getCachedHydratedTrackModalAlbum(normalizedAlbumKey);
      const currentClaim = trackModalHydratedAlbumDetailsLru.get(currentAlbum)?.tagEditMutationClaim;
      if (currentClaim && typeof tagEditViewMutationStillOwnsResources === 'function'
          && tagEditViewMutationStillOwnsResources(currentClaim)) {
        // A response started before an edit cannot replace its pending membership,
        // even before that edit advances the inventory revision.
        return currentAlbum;
      }
      if (requestInventoryRevision !== Number(state?.status?.inventory_mutation_revision || 0)) {
        // Release only this request's aliases before joining or starting a load
        // under the current revision. Foreground callers never receive stale data.
        trackModalAlbumDetailsLoads.forEach((mappedLoad, alias) => {
          if (mappedLoad === load) trackModalAlbumDetailsLoads.delete(alias);
        });
        const promotedToForeground = options.speculative === true
          && options.controller
          && !trackModalSpeculativeAlbumDetailsLoadControllers.has(load);
        return loadTrackModalAlbumDetails(normalizedAlbumKey,
          promotedToForeground ? { ...options, speculative: false } : options);
      }
      cacheHydratedTrackModalAlbum(normalizedAlbumKey, album);
      getTrackModalAlbumKeyAliases(normalizedAlbumKey, album).forEach((alias) => {
        trackModalAlbumDetailsLoads.set(alias, load);
      });
      return album;
    })
    .finally(() => {
      trackModalSpeculativeAlbumDetailsLoadControllers.delete(load);
      trackModalAlbumDetailsLoads.forEach((mappedLoad, alias) => {
        if (mappedLoad === load) trackModalAlbumDetailsLoads.delete(alias);
      });
    });
  if (options.speculative === true && options.controller) {
    trackModalSpeculativeAlbumDetailsLoadControllers.set(load, options.controller);
  }
  requestAliases.forEach((alias) => trackModalAlbumDetailsLoads.set(alias, load));
  return load;
}

function queueTrackModalAlbumDetailsPrewarm(albumKey) {
  const normalizedAlbumKey = String(albumKey || '').trim();
  if (!normalizedAlbumKey) return;
  const committedQuery = String(state?.view?.query || '');
  const draftQuery = String(state?.ui?.searchDraftQuery ?? committedQuery);
  if (
    state?.busy
    || state?.ui?.albumDetailPrewarmSearchSuspended
    || draftQuery !== committedQuery
  ) return;
  if (getCachedHydratedTrackModalAlbum(normalizedAlbumKey)) return;
  const indexedAlbum = getIndexedAlbum(normalizedAlbumKey);
  if (!albumRequiresHydration(indexedAlbum)) return;
  const existingLoad = getTrackModalAlbumKeyAliases(normalizedAlbumKey)
    .map((alias) => trackModalAlbumDetailsLoads.get(alias))
    .find(Boolean);
  if (existingLoad) {
    existingLoad.catch(() => {});
    return;
  }
  if (trackModalActiveSpeculativePrewarms >= TRACK_MODAL_SPECULATIVE_PREWARM_LIMIT) return;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (controller) trackModalSpeculativePrewarmControllers.add(controller);
  trackModalActiveSpeculativePrewarms += 1;
  loadTrackModalAlbumDetails(normalizedAlbumKey, {
    controller,
    signal: controller?.signal,
    speculative: true,
  }).catch(() => {
    // User-facing errors are shown only when the user actually opens the modal.
  }).finally(() => {
    if (controller) trackModalSpeculativePrewarmControllers.delete(controller);
    trackModalActiveSpeculativePrewarms = Math.max(0, trackModalActiveSpeculativePrewarms - 1);
  });
}

function cancelTrackModalAlbumDetailsPrewarms() {
  trackModalSpeculativePrewarmControllers.forEach((controller) => controller.abort());
  trackModalSpeculativePrewarmControllers.clear();
}

function queueVisibleTrackModalAlbumDetailsPrewarm(containerEl, scrollEl, limit = 2) {
  if (!(containerEl instanceof HTMLElement) || !(scrollEl instanceof HTMLElement)) return;
  const scrollRect = scrollEl.getBoundingClientRect();
  const visibleButtons = [];
  containerEl.querySelectorAll('.album-title-button[data-open-tracklist="1"][data-album-key]').forEach((button) => {
    if (!(button instanceof HTMLElement)) return;
    const rect = button.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    if (rect.bottom <= scrollRect.top || rect.top >= scrollRect.bottom) return;
    visibleButtons.push(button);
  });
  if (!visibleButtons.length || visibleButtons.length > limit) return;
  visibleButtons.forEach((button) => {
    const albumKey = String(button.getAttribute('data-album-key') || '').trim();
    if (!albumKey) return;
    queueTrackModalAlbumDetailsPrewarm(albumKey);
  });
}

function openTrackModal(album, options = {}) {
  const els = getTrackModalElements();
  if (!els.overlay || !album) return;
  if (options.foreground && document.getElementById('utility-modal')?.hidden === false) {
    els.overlay.classList.add('is-above-settings');
  }
  state.ui.trackModalCoverLightboxGallery = options.coverLightboxGallery !== false;
  if (typeof clearPendingSelectedArtistReconcile === 'function') {
    clearPendingSelectedArtistReconcile();
  }
  const albumWithPlaybackContext = attachGalleryPlaybackContextToAlbum(album);
  if (albumRequiresHydration(albumWithPlaybackContext)) {
    const albumKey = getAlbumRequestKey(albumWithPlaybackContext);
    const loadToken = invalidatePendingTrackModalLoad();
    state.ui.pendingTrackModalLoadAlbumKey = albumKey;
    openTrackModalShell(albumWithPlaybackContext);
    const coverLoadSuspensionToken = suspendGalleryCoverLoadsForTrackModal();
    const detailsPromise = loadTrackModalAlbumDetails(albumKey);
    detailsPromise.then((hydratedAlbum) => {
      if (loadToken !== state.ui.pendingTrackModalLoadToken) return;
      const refreshedAlbum = getIndexedAlbum(albumKey);
      const resolvedAlbum = (!refreshedAlbum || albumRequiresHydration(refreshedAlbum))
        ? hydratedAlbum
        : refreshedAlbum;
      if (loadToken !== state.ui.pendingTrackModalLoadToken) return;
      if (!resolvedAlbum || albumRequiresHydration(resolvedAlbum) || els.overlay.hidden) return;
      invalidatePendingTrackModalLoad();
      openTrackModal(resolvedAlbum, { ...options, foreground: false });
    }).catch((error) => {
      if (loadToken !== state.ui.pendingTrackModalLoadToken) return;
      console.error('[AlbumHaven][AlbumDetails] Failed to load full album details.', error);
      showToast('Unable to load album details.', 'error', 3200);
    }).finally(() => {
      resumeGalleryCoverLoadsAfterTrackModalAction(coverLoadSuspensionToken);
    });
    return;
  }
  invalidatePendingTrackModalLoad();
  // Edition hydration must not rebuild the tabs around a different base name.
  const preserved = options.releaseSet;
  const preservedAlbum = preserved?.releases?.[preserved.selectedIndex];
  const releaseSet = preservedAlbum
    && getAlbumRequestKey(preservedAlbum) === getAlbumRequestKey(albumWithPlaybackContext)
    ? {
      releases: preserved.releases.map((release, index) => index === preserved.selectedIndex
        ? { ...albumWithPlaybackContext, tabLabel: release.tabLabel } : release),
      selectedIndex: preserved.selectedIndex,
    }
    : getAlbumReleaseSet(albumWithPlaybackContext);
  state.modalReleases = releaseSet.releases;
  state.modalReleaseIndex = releaseSet.selectedIndex;
  hideVersionContextMenu();
  renderTrackModalRelease(state.modalReleases[state.modalReleaseIndex]);
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
  attachSharedPlayer();
}

function getCurrentTrackModalAlbum() {
  return state.modalReleases[state.modalReleaseIndex] || null;
}

function getTrackModalButtonAlbumKey(button) {
  if (!(button instanceof HTMLElement)) return '';
  return (typeof button.getAttribute === 'function' ? button.getAttribute('data-album-key') : '')
    || button.dataset.albumKey
    || '';
}

function getTrackModalButtonAlbumVersionKey(button) {
  if (!(button instanceof HTMLElement)) return '';
  return (typeof button.getAttribute === 'function' ? button.getAttribute('data-album-version-key') : '')
    || button.dataset.albumVersionKey
    || '';
}

function parseTrackModalButtonAlbumFallback(button) {
  if (!(button instanceof HTMLElement)) return null;
  try {
    const parsedAlbum = JSON.parse(button.getAttribute('data-album') || 'null');
    return parsedAlbum && typeof parsedAlbum === 'object' ? parsedAlbum : null;
  } catch (_error) {
    return null;
  }
}

function findIndexedTrackModalLogicalRelease(album) {
  if (!album || !(state?.gallery?.albumIndex instanceof Map)) return null;
  const matches = Array.from(new Set(state.gallery.albumIndex.values())).filter(
    (candidate) => trackModalAlbumsShareLogicalRelease(candidate, album),
  );
  return matches.length === 1 ? matches[0] : null;
}

function resolveTrackModalActionAlbum(button) {
  const albumKey = String(getTrackModalButtonAlbumKey(button) || '').trim();
  const albumVersionKey = String(getTrackModalButtonAlbumVersionKey(button) || '').trim();
  const currentAlbum = getCurrentTrackModalAlbum();
  const fallbackAlbum = parseTrackModalButtonAlbumFallback(button);
  if (albumVersionKey) {
    const currentAlbumVersionKey = getTrackModalAlbumVersionKey(currentAlbum);
    if (currentAlbum && !albumRequiresHydration(currentAlbum) && currentAlbumVersionKey === albumVersionKey) {
      return currentAlbum;
    }
    const cachedVersionAlbum = getCachedHydratedTrackModalAlbum(albumVersionKey);
    if (cachedVersionAlbum) return cachedVersionAlbum;
    const indexedVersionAlbum = getIndexedAlbum(albumVersionKey);
    if (indexedVersionAlbum) return indexedVersionAlbum;
  }
  if (albumKey) {
    const currentAlbumKey = String(getAlbumRequestKey(currentAlbum) || getAlbumIdentity(currentAlbum) || currentAlbum?.key || '');
    if (currentAlbum && !albumRequiresHydration(currentAlbum) && currentAlbumKey === albumKey) {
      return currentAlbum;
    }
    const cachedAlbum = getCachedHydratedTrackModalAlbum(albumKey);
    if (currentAlbum && cachedAlbum === currentAlbum) {
      return currentAlbum;
    }
    const indexedAlbum = getIndexedAlbum(albumKey);
    if (indexedAlbum) return indexedAlbum;
    if (currentAlbumKey === albumKey) {
      return currentAlbum;
    }
  }
  if (currentAlbum) return currentAlbum;
  return findIndexedTrackModalLogicalRelease(fallbackAlbum) || fallbackAlbum;
}

function resolveTrackModalDuplicateSourceAlbum(button) {
  const album = resolveTrackModalActionAlbum(button);
  if (!album || !(button instanceof HTMLElement)) return album;
  const duplicateSources = Array.isArray(album?.duplicate_sources) ? album.duplicate_sources : [];
  const sourceIndex = Number(button.getAttribute('data-duplicate-source-index'));
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= duplicateSources.length) {
    return album;
  }
  return {
    ...album,
    tracks: Array.isArray(duplicateSources[sourceIndex]?.tracks) ? duplicateSources[sourceIndex].tracks : [],
  };
}

function getTrackModalLightboxSourceAlbumKey(button) {
  const album = resolveTrackModalActionAlbum(button);
  if (!album || typeof album !== 'object') return '';
  if (typeof getAlbumPathSignature === 'function') {
    const signature = getAlbumPathSignature(album);
    if (signature) return signature;
  }
  return String(getAlbumIdentity(album) || album?.key || `${album?.name || ''}::${album?.album_artist || ''}`);
}

let imageLightboxReturnFocus = null;

function openImageLightbox(src, alt, options = {}) {
  const els = getLightboxElements();
  if (!els.overlay || !els.image || !src) return;
  if (els.overlay.hidden) imageLightboxReturnFocus = document.activeElement;
  bindOverlayPointerOrigin(els.overlay);
  state.lightbox.sourceAlbumKey = String(options.sourceAlbumKey || '');
  state.lightbox.items = Array.isArray(options.items) ? options.items.filter(Boolean) : [];
  state.lightbox.currentIndex = -1;
  const itemIndex = state.lightbox.items.findIndex((item) => (
    item?.src === src || (state.lightbox.sourceAlbumKey && item?.key === state.lightbox.sourceAlbumKey)
  ));
  if (itemIndex >= 0) {
    showLightboxItem(itemIndex);
  } else {
    const standaloneItem = {
      src,
      previewSrc: String(options.previewSrc || ''),
      remoteSrc: String(options.remoteSrc || ''),
      alt: alt || 'Full-size album cover',
    };
    if (typeof showStandaloneLightboxItem === 'function') {
      showStandaloneLightboxItem(standaloneItem);
    } else {
      els.image.src = src;
      els.image.alt = standaloneItem.alt;
    }
    state.lightbox.panX = 0;
    state.lightbox.panY = 0;
    state.lightbox.dragging = false;
    setLightboxZoom(1);
    updateLightboxNavState();
  }
  els.overlay.hidden = false;
  els.overlay.setAttribute?.('role', 'dialog');
  els.overlay.setAttribute?.('aria-modal', 'true');
  els.overlay.setAttribute?.('aria-label', 'Full-size album cover');
  document.body.classList.add('modal-open');
  els.close?.focus?.();
}

function closeImageLightbox() {
  const els = getLightboxElements();
  if (!els.overlay || !els.image) return;
  els.overlay.hidden = true;
  stopLightboxDrag();
  state.lightbox.panX = 0;
  state.lightbox.panY = 0;
  state.lightbox.items = [];
  state.lightbox.currentIndex = -1;
  state.lightbox.sourceAlbumKey = '';
  state.lightbox.activeSources = [];
  state.lightbox.activeSourceIndex = -1;
  state.lightbox.activeFullSource = '';
  state.lightbox.activeAlt = '';
  state.lightbox.loadToken = Number(state.lightbox.loadToken || 0) + 1;
  if (state.lightbox.activePreloader) {
    state.lightbox.activePreloader.onload = null;
    state.lightbox.activePreloader.onerror = null;
    state.lightbox.activePreloader = null;
  }
  setLightboxZoom(1);
  els.image.onload = null;
  els.image.onerror = null;
  if (els.loading) els.loading.hidden = true;
  els.image.hidden = true;
  if (els.image.classList?.remove) els.image.classList.remove('is-unavailable');
  els.image.removeAttribute('src');
  els.image.alt = '';
  if (typeof els.image.setAttribute === 'function') els.image.setAttribute('aria-hidden', 'true');
  updateLightboxNavState();
  const trackModalOpen = !document.getElementById('track-modal')?.hidden;
  const utilityModalOpen = !document.getElementById('utility-modal')?.hidden;
  if (!trackModalOpen && !utilityModalOpen) {
    document.body.classList.remove('modal-open');
  }
  const returnFocus = imageLightboxReturnFocus;
  imageLightboxReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus?.();
}

function closeTrackModal() {
  const els = getTrackModalElements();
  if (!els.overlay) return;
  els.overlay.hidden = true;
  els.overlay.classList.remove('is-above-settings');
  invalidatePendingTrackModalLoad();
  resumeAllGalleryCoverLoadsAfterTrackModalActions();
  state.modalReleases = [];
  state.modalReleaseIndex = 0;
  hideVersionContextMenu();
  clearTrackModalRenderedState();
  if (typeof compactCurrentViewForIdle === 'function') {
    compactCurrentViewForIdle();
  }
  const lightboxOpen = !document.getElementById('image-lightbox')?.hidden;
  const utilityModalOpen = !document.getElementById('utility-modal')?.hidden;
  if (!lightboxOpen && !utilityModalOpen) {
    document.body.classList.remove('modal-open');
  }
}

function openTrackModalForButton(button) {
  if (!(button instanceof HTMLElement)) return false;
  const albumKey = (typeof button.getAttribute === 'function' ? button.getAttribute('data-album-key') : '')
    || button.dataset.albumKey
    || '';
  if (!albumKey) return false;
  openTrackModal(resolveTrackModalActionAlbum(button));
  return true;
}

function attachTrackButtons() {
  document.querySelectorAll('[data-open-tracklist="1"]').forEach((button) => {
    if (button.dataset.bound === '1') return;
    button.dataset.bound = '1';
    button.addEventListener('click', () => {
      openTrackModalForButton(button);
    });
  });
}

// Escape belongs to the visible foreground overlay, even when focus is behind it.
function getTopmostOpenModal() {
  const overlays = '.track-modal, .utility-modal, .confirm-modal, .tag-editor-modal, .cover-lookup-modal, .non-album-modal, .image-lightbox, .repair-progress-overlay';
  const candidates = [...new Set(Array.from(document.querySelectorAll(
    `${overlays}, [aria-modal="true"], #app-form-modal`,
  )).map(node => node.closest(overlays) || node))];
  const stack = node => {
    const contexts = [];
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.zIndex !== 'auto' && style.zIndex !== ''
          || ['fixed', 'sticky'].includes(style.position)
          || Number(style.opacity) < 1
          || style.transform && style.transform !== 'none'
          || style.filter && style.filter !== 'none'
          || style.isolation === 'isolate'
          || /paint|layout|strict|content/.test(style.contain || '')) {
        contexts.unshift({ node: current, z: Number(style.zIndex) || 0 });
      }
    }
    return contexts;
  };
  const visible = candidates.filter(node => {
    if (node.closest('[hidden], [inert]') || !node.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }).map(node => ({ node, stack: stack(node) }));
  visible.sort((a, b) => {
    let index = 0;
    while (a.stack[index] && b.stack[index] && a.stack[index].node === b.stack[index].node) index += 1;
    const left = a.stack[index];
    const right = b.stack[index];
    const order = (left?.z || 0) - (right?.z || 0);
    if (order) return order;
    return (left?.node || a.node).compareDocumentPosition(right?.node || b.node) & 4 ? -1 : 1;
  });
  return visible.at(-1)?.node || null;
}

function handleModalEscapeKeydown(event) {
  if (event.key !== 'Escape') return;
  const modal = getTopmostOpenModal();
  if (!modal) return;
  // Capture and stop immediately: closing one dialog must not expose another
  // to this same keypress, including handlers attached directly to its controls.
  event.stopImmediatePropagation?.();
  if (event.defaultPrevented) return;
  event.preventDefault?.();
  if (event.repeat || event.isComposing) return;
  if (modal.id === 'tag-editor-modal') {
    if (state.tagEditor.reorder) {
      clearTagEditorReorderCue();
    } else if (getSelectedTagEditorPaths(state.tagEditor.tracks || []).length > 1) {
      setTagEditorSelectedPaths([]);
      state.tagEditor.anchorPath = '';
      renderTagEditor({ preserveTrackList: true });
    } else {
      closeTagEditor();
    }
    return;
  }
  if (modal.id === 'utility-modal') {
    if (state.utility.activeTab === 'problematic-files' && state.utility.problemDropdownOpen) {
      const els = getUtilityModalElements();
      state.utility.problemDropdownOpen = false;
      els.problemFilterMenu.hidden = true;
      els.problemFilterButton.setAttribute('aria-expanded', 'false');
      if (typeof clearTriggerAnchor === 'function') clearTriggerAnchor(els.problemFilterMenu);
      els.problemFilterButton.focus();
      return;
    }
    if (typeof cancelActiveSavedLoopCreation === 'function' && cancelActiveSavedLoopCreation()) return;
    const editor = typeof getBackgroundAppearanceEditor === 'function' ? getBackgroundAppearanceEditor() : null;
    if (editor?.allowLeave(() => true) === false) return;
    closeUtilityModal(true);
    return;
  }
  const close = {
    'track-modal': () => closeTrackModal(),
    'image-lightbox': () => closeImageLightbox(),
    'repair-confirm-modal': () => closeRepairConfirmModal(),
    'tag-edit-confirm-modal': () => closeTagEditConfirmModal(),
    'cover-lookup-modal': () => closeCoverLookupModal(),
    'cover-lookup-delete-confirm-modal': () => closeCoverLookupDeleteConfirm(),
    'non-album-modal': () => closeNonAlbumModal(),
    'version-picker-modal': () => closeVersionPickerModal(),
  }[modal.id];
  if (close) close();
  else {
    // Promise-backed dialogs must settle through their own cancel actions.
    modal.querySelector('#app-confirm-cancel, #app-form-cancel, #loop-name-cancel, #loop-delete-confirm-cancel')?.click();
  }
}

function attachModalEvents() {
  const els = getTrackModalElements();
  if (!els.overlay || els.overlay.dataset.bound === '1') return;
  els.overlay.dataset.bound = '1';
  bindOverlayPointerOrigin(els.overlay);
  els.close?.addEventListener('click', closeTrackModal);
  els.overlay.addEventListener('click', (event) => {
    if (overlayClickStartedOnOverlay(els.overlay, event) || event.target.closest('[data-close-track-modal="1"]')) {
      closeTrackModal();
    }
  });
  document.addEventListener('keydown', handleModalEscapeKeydown, true);
  document.addEventListener('keydown', (event) => {
    const lightboxEls = getLightboxElements();
    if (!lightboxEls.overlay || lightboxEls.overlay.hidden) return;
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const controls = Array.from(lightboxEls.overlay.querySelectorAll?.('button, [href], input, select, textarea, [tabindex]') || [])
        .filter(control => !control.hidden && !control.disabled && control.tabIndex >= 0
          && !control.closest?.('[hidden], [inert]') && control.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) return;
      const outside = !lightboxEls.overlay.contains(document.activeElement);
      if (outside || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      stepLightbox(-1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      stepLightbox(1);
    }
  });
}
