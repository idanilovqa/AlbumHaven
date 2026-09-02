restorePlayerAppearance();
attachModalEvents();
document.querySelectorAll('[data-account-menu-component]').forEach(attachAccountMenu);
attachCoverLookupModalEvents();
attachCoverLookupDeleteConfirmEvents();
attachUtilityModalEvents();
attachRepairConfirmEvents();
attachPlayerEvents();
if (typeof initPlaybackOwnershipCoordinator === 'function') {
  initPlaybackOwnershipCoordinator();
}
if (typeof prepareStreamingPlaybackEngine === 'function') {
  void prepareStreamingPlaybackEngine().catch((error) => {
    console.error('[AlbumHaven][Playback] Failed to prepare streaming playback.', error);
  });
}
const bootstrapSearchParams = new URL(window.location.href).searchParams;
const galleryDisplayPreferenceResolutionOptions = {
  hasExplicitGalleryDisplayOverride: bootstrapSearchParams.has('gallery_display'),
  hasExplicitGalleryScaleOverride: bootstrapSearchParams.has('gallery_scale_percent'),
};
const bootstrapState = normalizeBootstrapRuntimeStatePayload({
  initial_view: state.view,
  bootstrap: appBootstrap.getBootstrap(),
});
const resolvedBootstrapView = resolveGalleryDisplayPreferenceViewState(
  bootstrapState.view,
  galleryDisplayPreferenceResolutionOptions,
);
applyViewPayload(resolvedBootstrapView, { trackSidebarReveal: false });
if (typeof appBootstrap?.releasePayloadViewState === 'function') {
  appBootstrap.releasePayloadViewState();
}
function resolveInitialHydrationEndpoint(startupHydration, options = {}) {
  const preferFollowupEndpoint = Boolean(options.preferFollowupEndpoint);
  const serverEndpoint = String(
    preferFollowupEndpoint
      ? startupHydration?.followupEndpoint || ''
      : startupHydration?.endpoint || '',
  ).trim();
  if (typeof buildApiUrl === 'function') {
    const resolvedEndpoint = String(buildApiUrl(state.view) || '').trim();
    if (resolvedEndpoint && !serverEndpoint) {
      return resolvedEndpoint;
    }
    if (resolvedEndpoint && serverEndpoint) {
      const serverUrl = new URL(serverEndpoint, window.location.href);
      const resolvedUrl = new URL(resolvedEndpoint, window.location.href);
      ['gallery_display', 'gallery_scale_percent'].forEach((param) => {
        if (resolvedUrl.searchParams.has(param)) {
          serverUrl.searchParams.set(param, resolvedUrl.searchParams.get(param));
        } else {
          serverUrl.searchParams.delete(param);
        }
      });
      return `${serverUrl.pathname}${serverUrl.search}`;
    }
  }
  return serverEndpoint;
}
document.addEventListener('pointerdown', (event) => {
  suppressRefocusViewportInteraction(event);
}, true);
document.addEventListener('click', (event) => {
  suppressRefocusViewportClick(event);
}, true);
document.addEventListener('mouseover', (event) => {
  noteViewportRefocusHoverIntent(event);
}, true);
document.addEventListener('wheel', (event) => {
  noteViewportRefocusWheelIntent(event);
}, { capture: true, passive: true });
state.ui.pendingSidebarRevealArtist = String(state.view.selected_artist || '').trim();
const bootstrap = bootstrapState.bootstrap;
const startupHydration = bootstrap.startupHydration || {};
const startupHydrationRequired = Boolean(startupHydration.required);
const startupHydrationEndpoint = String(startupHydration.endpoint || '').trim();
const startupHydrationFollowupEndpoint = String(startupHydration.followupEndpoint || '').trim();
const startupHydrationTier = String(startupHydration.tier || 'full');
const shellMainContentKind = String(
  state.view?.shell_layout?.slots?.main_content?.content_kind || '',
).trim();
const shouldStartImmediateHydration = shellMainContentKind === 'discovery_center_page'
  ? false
  : shouldRunImmediateStartupHydration(state.view, bootstrap);
let embeddedStartupViewPatch = startupHydration?.embeddedViewPatch && typeof startupHydration.embeddedViewPatch === 'object'
  ? startupHydration.embeddedViewPatch
  : null;
const shouldApplyEmbeddedSidebarHydration = Boolean(
  shouldStartImmediateHydration
  && startupHydrationTier === 'sidebar'
  && Array.isArray(embeddedStartupViewPatch?.artists_sidebar)
  && embeddedStartupViewPatch.artists_sidebar.length
);
const shouldTreatStartupPreviewAsVisibleReady = Boolean(
  shouldApplyEmbeddedSidebarHydration
  && startupHydrationFollowupEndpoint
);
if (shouldStartImmediateHydration) {
  startupMetrics.beginInitialRefresh();
}
if (shouldApplyEmbeddedSidebarHydration) {
  applyViewPayload(embeddedStartupViewPatch, { trackSidebarReveal: false });
}
embeddedStartupViewPatch = null;
if (startupHydration && typeof startupHydration === 'object') {
  startupHydration.embeddedViewPatch = null;
}
if (bootstrap.startupPayloadTiers?.hydration && typeof bootstrap.startupPayloadTiers.hydration === 'object') {
  bootstrap.startupPayloadTiers.hydration.embeddedViewPatch = null;
}
renderView();
startupMetrics.markInitialRender(state.view);
const hasAuthoritativeServerRenderedInitialView = Boolean(
  !bootstrap.partialView
  && !startupHydrationRequired
  && !state.view?.initial_view_partial
);
if (
  !shouldStartImmediateHydration
  && hasAuthoritativeServerRenderedInitialView
  && !isEffectivelyEmptyView(state.view)
  && typeof startupMetrics?.completeInitialRefresh === 'function'
) {
  const completeServerRenderedInitialRefresh = () => {
    startupMetrics.completeInitialRefresh(state.view);
  };
  if (typeof scheduleBrowserAnimationFrame === 'function') {
    scheduleBrowserAnimationFrame(() => {
      scheduleBrowserAnimationFrame(completeServerRenderedInitialRefresh);
    });
  } else if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(completeServerRenderedInitialRefresh);
    });
  } else {
    completeServerRenderedInitialRefresh();
  }
}
if (
  shouldTreatStartupPreviewAsVisibleReady
  && typeof startupMetrics?.completeVisibleInitialRefresh === 'function'
) {
  startupMetrics.completeVisibleInitialRefresh(state.view, {
    hydrationTier: 'sidebar',
    source: 'startup_preview',
  });
}
updateStatusIndicator({
  scan_in_progress: Boolean(bootstrap.scanInProgress),
  scan_phase: String(bootstrap.scanPhase || 'idle'),
  scan_mode: String(bootstrap.scanMode || 'idle'),
  scan_processed: 0,
  scan_total: 0,
  relations_in_progress: Boolean(bootstrap.relationsInProgress),
  relations_processed: 0,
  relations_total: 0,
  relations_phase: 'Building family artists',
  relations_source: 'local',
  covers_in_progress: Boolean(bootstrap.coversInProgress),
  covers_processed: 0,
  covers_total: 0,
  covers_downloaded: 0,
  last_scan_display: bootstrap.lastScanDisplay || ''
});
state.wasPollingBusy = Boolean(bootstrap.scanInProgress || bootstrap.relationsInProgress);
state.wasCoverPollingBusy = Boolean(bootstrap.coversInProgress);
const shouldAwaitInitialDataRefresh = Boolean(
  shouldStartImmediateHydration
  && (
    isEffectivelyEmptyView(state.view)
    || Boolean(bootstrap.partialView)
    || startupHydrationRequired
  )
);
state.awaitingInitialDataRefresh = shouldAwaitInitialDataRefresh;
if (bootstrap.refreshed) {
  showToast('Library scan started.', 'success', 2200);
}
renderLibraryLoader({
  scan_in_progress: Boolean(bootstrap.scanInProgress),
  scan_phase: String(bootstrap.scanPhase || 'idle'),
  relations_in_progress: Boolean(bootstrap.relationsInProgress),
  relations_phase: 'Building artist families',
  relations_source: 'local',
  covers_in_progress: Boolean(bootstrap.coversInProgress),
});
scheduleBrowserTimeout(pollStatus, 500);
if (shouldStartImmediateHydration) {
  const resolvedStartupHydrationFollowupEndpoint = resolveInitialHydrationEndpoint({
    followupEndpoint: startupHydrationFollowupEndpoint,
  }, {
    ...galleryDisplayPreferenceResolutionOptions,
    preferFollowupEndpoint: true,
  });
  const immediateHydrationEndpoint = resolveInitialHydrationEndpoint(
    { endpoint: startupHydrationEndpoint },
    galleryDisplayPreferenceResolutionOptions,
  );
  if (immediateHydrationEndpoint) {
    const runHydration = () => {
      fetchAndRender(immediateHydrationEndpoint, false, {
        startupRefresh: true,
        preserveScroll: true,
        startupHydrationTier,
        startupHydrationFollowupEndpoint: resolvedStartupHydrationFollowupEndpoint,
      });
    };
    if (
      shouldTreatStartupPreviewAsVisibleReady
      && typeof scheduleBrowserAnimationFrame === 'function'
    ) {
      scheduleBrowserAnimationFrame(() => {
        scheduleBrowserAnimationFrame(runHydration);
      });
    } else {
      runHydration();
    }
  }
}


document.addEventListener('contextmenu', (event) => {
  const versionTab = event.target.closest('[data-version-context-key]');
  if (versionTab) {
    event.preventDefault();
    showVersionContextMenu(versionTab.getAttribute('data-version-context-key') || '', event.clientX, event.clientY);
    return;
  }

  const indicator = event.target.closest('#scan-indicator');
  if (!indicator) return;
  event.preventDefault();
  showStatusContextMenu(event.clientX, event.clientY);
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('#status-context-menu')) {
    hideStatusContextMenu();
  }
});

document.addEventListener('keydown', (event) => {
  if (typeof handleArtistsDrawerKeydown === 'function') {
    handleArtistsDrawerKeydown(event);
  }
  if (event.key === 'Escape') {
    hideVersionContextMenu();
    hideStatusContextMenu();
  }
});

window.addEventListener('blur', hideStatusContextMenu);
window.addEventListener('blur', hideVersionContextMenu);
window.addEventListener('resize', () => {
  hideStatusContextMenu();
  hideVersionContextMenu();
});
window.addEventListener('scroll', () => {
  hideStatusContextMenu();
  hideVersionContextMenu();
}, true);


document.addEventListener('contextmenu', (event) => {
  const albumCard = event.target.closest('.album-card');
  if (!albumCard) return;
  event.preventDefault();
  const trigger = albumCard.querySelector('[data-album-key]');
  const album = trigger ? getIndexedAlbum(trigger.getAttribute('data-album-key') || '') : null;
  showAlbumCardContextMenu(event.clientX, event.clientY, album);
}, true);

document.addEventListener('click', (event) => {
  const insideAlbumMenu = event.target.closest('#album-card-context-menu');
  const insideAlbumCard = event.target.closest('.album-card');
  if (!insideAlbumMenu && !insideAlbumCard) {
    hideAlbumCardContextMenu();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideAlbumCardContextMenu();
  }
});

window.addEventListener('blur', () => {
  hideAlbumCardContextMenu();
  state.ui.pendingAppRefocusSuppression = true;
});

function reconcileLoopEditSessionExpiry(event) {
  if (event?.target?.closest?.('[data-loop-range-handle]')) return;
  if (typeof loopEditSessionExpiryController !== 'undefined') {
    loopEditSessionExpiryController.reconcile();
  }
}

window.addEventListener('focus', () => {
  reconcileLoopEditSessionExpiry();
  if (state.ui.pendingAppRefocusSuppression) {
    armViewportRefocusSuppression();
  }
  state.ui.pendingAppRefocusSuppression = false;
  state.ui.ignoreOverlayCloseUntil = Date.now() + 450;
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    reconcileLoopEditSessionExpiry();
    handleViewportRefocusVisibilityChange();
    return;
  }
  if (document.visibilityState !== 'hidden') return;
  handleViewportRefocusVisibilityChange();
  persistPlayerState(true, { preservePlayingState: true });
});
document.addEventListener('pointerdown', reconcileLoopEditSessionExpiry, true);
document.addEventListener('keydown', reconcileLoopEditSessionExpiry, true);
let unloadStreamingCleanupPromise = null;
function cleanupStreamingPlaybackForUnload() {
  if (unloadStreamingCleanupPromise) return unloadStreamingCleanupPromise;
  if (typeof stopStreamingPlayback !== 'function') {
    unloadStreamingCleanupPromise = Promise.resolve();
    return unloadStreamingCleanupPromise;
  }
  try {
    unloadStreamingCleanupPromise = Promise.resolve(stopStreamingPlayback('unload')).catch((error) => {
      console.warn('[AlbumHaven][Playback] Failed to stop streaming during unload.', error);
    });
  } catch (error) {
    console.warn('[AlbumHaven][Playback] Failed to stop streaming during unload.', error);
    unloadStreamingCleanupPromise = Promise.resolve();
  }
  return unloadStreamingCleanupPromise;
}
window.addEventListener('pagehide', () => {
  persistPlayerStateForUnload('pagehide');
  void cleanupStreamingPlaybackForUnload();
});
window.addEventListener('pageshow', (event) => {
  if (event?.persisted) {
    resetPlayerUnloadPersistence();
    unloadStreamingCleanupPromise = null;
  }
  if (!state.player.loopActive) return;
  setLoopActive(false);
});
window.addEventListener('beforeunload', () => {
  persistPlayerStateForUnload('beforeunload');
  void cleanupStreamingPlaybackForUnload();
});
window.addEventListener('resize', () => {
  hideAlbumCardContextMenu();
});
window.addEventListener('scroll', () => {
  hideAlbumCardContextMenu();
}, true);

if (typeof syncArtistsDrawerVisibility === 'function') {
  syncArtistsDrawerVisibility();
}
