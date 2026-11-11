const MOBILE_ARTISTS_DRAWER_MEDIA_QUERY = '(max-width: 900px)';
const ARTIST_TREE_SETTLED_EVENT = 'album-haven:artist-tree-settled';
const ARTIST_TREE_TOGGLE_STARTING_EVENT = 'album-haven:artist-tree-toggle-starting';
const MOBILE_LIBRARY_MODE_RAIL_HIDE_DELAY_MS = 3500;
let cancelPendingArtistTreeResize = null;
let mobileLibraryModeRailHideTimer = null;

function setMobileLibraryModeRailVisible(visible) {
  const rail = document.getElementById('shell-navigation-rail');
  const anchor = document.getElementById('mobile-tree-edge-anchor');
  const show = !isArtistsDrawerMobileViewport() || visible;
  state.ui.mobileLibraryModeRailVisible = show;
  rail?.classList?.toggle('is-mobile-mode-rail-hidden', !show);
  if (anchor) anchor.hidden = show || !isArtistsDrawerMobileViewport();
  if (mobileLibraryModeRailHideTimer !== null) clearTimeout(mobileLibraryModeRailHideTimer);
  mobileLibraryModeRailHideTimer = null;
  if (show && isArtistsDrawerMobileViewport() && state.ui.artistsDrawerOpen) {
    mobileLibraryModeRailHideTimer = setTimeout(() => {
      const modeRail = document.querySelector?.('.library-navigation-mode-rail');
      setMobileLibraryModeRailVisible(Boolean(modeRail?.contains?.(document.activeElement)));
    }, MOBILE_LIBRARY_MODE_RAIL_HIDE_DELAY_MS);
  }
  return show;
}

function installMobileLibraryModeRailGestures() {
  const rail = document.getElementById('shell-navigation-rail');
  if (!rail || rail.dataset.mobileModeRailGestures === 'true') return;
  rail.dataset.mobileModeRailGestures = 'true';
  let gesture = null;
  rail.addEventListener('pointerdown', (event) => {
    if (
      event.pointerType !== 'touch'
      || state.ui.mobileLibraryModeRailVisible !== false
      || Number(event.clientX || 0) > 28
    ) return;
    gesture = { pointerId: event.pointerId, x: Number(event.clientX || 0), y: Number(event.clientY || 0) };
  });
  rail.addEventListener('pointermove', (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = Number(event.clientX || 0) - gesture.x;
    const deltaY = Math.abs(Number(event.clientY || 0) - gesture.y);
    if (deltaY > 32) {
      gesture = null;
      return;
    }
    if (deltaX < 36) return;
    gesture = null;
    event.preventDefault?.();
    setMobileLibraryModeRailVisible(true);
  });
  const clearGesture = () => { gesture = null; };
  rail.addEventListener('pointerup', clearGesture);
  rail.addEventListener('pointercancel', clearGesture);
}

function syncLibraryNavigationModePresentation(mode) {
  const normalized = mode === 'custom-collections' ? mode : 'artists';
  const heading = document.getElementById('library-navigation-heading');
  if (heading) heading.textContent = normalized === 'custom-collections' ? 'Custom Collections' : 'Artists';
  document.querySelectorAll?.('[data-library-navigation-mode]').forEach((button) => {
    const selected = button.getAttribute('data-library-navigation-mode') === normalized;
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    button.classList?.toggle?.('is-active', selected);
  });
}

function renderCustomCollectionNavigation(collections) {
  const list = document.getElementById('sidebar-list');
  if (!list) return;
  list.dataset.navigationTree = 'custom-collections';
  list.dataset.sidebarVirtualized = 'false';
  delete list.dataset.sidebarStructureSignature;
  list.innerHTML = collections.length
    ? collections.map(({ name, count }) => window.NavigationTree.renderItem({
      action: true,
      label: name,
      count,
      attributes: { 'data-open-custom-collection': name },
    })).join('')
    : '<p class="utility-empty-state compact">No Custom Collections yet.</p>';
}

async function setLibraryNavigationMode(mode) {
  if (mode === 'loose-tracks') {
    openNonAlbumModal({ libraryWide: true });
    if (isArtistsDrawerMobileViewport()) closeArtistsDrawer({ restoreFocus: false });
    return 'loose-tracks';
  }
  const normalized = mode === 'custom-collections' ? mode : 'artists';
  state.ui.libraryNavigationMode = normalized;
  syncLibraryNavigationModePresentation(normalized);
  if (normalized === 'artists') {
    const list = document.getElementById('sidebar-list');
    if (list) list.dataset.navigationTree = 'artists';
    renderSidebar();
    return normalized;
  }
  const list = document.getElementById('sidebar-list');
  if (list) list.innerHTML = '<p class="utility-empty-state compact">Loading Custom Collections…</p>';
  try {
    await hydrateDeferredNonAlbumTracks({ libraryWide: true });
    if (state.ui.libraryNavigationMode !== normalized) return normalized;
    renderCustomCollectionNavigation(buildCustomCollectionIndex(
      state.view?.library_non_album_tracks || state.view?.non_album_tracks || [],
    ));
  } catch (error) {
    if (state.ui.libraryNavigationMode === normalized && list) {
      list.innerHTML = `<p class="utility-empty-state compact">${escapeHtml(error?.message || 'Unable to load Custom Collections.')}</p>`;
    }
  }
  return normalized;
}

function handleLibraryNavigationClick(event) {
  const modeButton = event.target.closest?.('[data-library-navigation-mode]');
  if (modeButton) {
    event.preventDefault();
    if (isArtistsDrawerMobileViewport()) setMobileLibraryModeRailVisible(true);
    void setLibraryNavigationMode(modeButton.getAttribute('data-library-navigation-mode'));
    return true;
  }
  const collectionButton = event.target.closest?.('[data-open-custom-collection]');
  if (!collectionButton) return false;
  event.preventDefault();
  const collectionName = String(collectionButton.getAttribute('data-open-custom-collection') || '').trim();
  if (!collectionName) return true;
  openNonAlbumModal({ libraryWide: true, collectionName });
  if (isArtistsDrawerMobileViewport()) closeArtistsDrawer({ restoreFocus: false });
  return true;
}

function isArtistsDrawerElement(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.classList
    && typeof value.setAttribute === 'function'
  );
}

function getArtistsDrawerElements() {
  return {
    button: document.getElementById('artists-drawer-button'),
    rail: document.getElementById('shell-navigation-rail'),
    backdrop: document.getElementById('shell-navigation-rail-backdrop'),
  };
}

function getArtistTreeFoldElements() {
  return {
    shell: document.getElementById('app-shell'),
    button: document.getElementById('artist-tree-fold-button'),
    navigationButton: document.getElementById('artist-tree-navigation-button'),
    expandedTree: document.getElementById('artist-tree-expanded'),
    compactNavigation: document.getElementById('shell-navigation-compact'),
    rail: document.getElementById('shell-navigation-rail'),
    list: document.getElementById('sidebar-list'),
  };
}

function getArtistsDrawerNavigationContentKind(view = state.view || {}) {
  return String(view?.shell_layout?.slots?.navigation_rail?.content_kind || 'artists_sidebar')
    .trim()
    .toLowerCase();
}

function canUseArtistsDrawerForCurrentView() {
  return getArtistsDrawerNavigationContentKind() === 'artists_sidebar';
}

function isArtistsDrawerMobileViewport() {
  if (typeof window?.matchMedia === 'function') {
    return Boolean(window.matchMedia(MOBILE_ARTISTS_DRAWER_MEDIA_QUERY).matches);
  }
  return Number(window?.innerWidth || 0) <= 900;
}

function syncArtistsDrawerVisibility() {
  const { button, rail, backdrop } = getArtistsDrawerElements();
  const isMobile = isArtistsDrawerMobileViewport();
  const supportsArtistsDrawer = canUseArtistsDrawerForCurrentView();
  const isDrawerVisible = Boolean(isMobile && supportsArtistsDrawer);
  if (!isDrawerVisible) {
    state.ui.artistsDrawerOpen = false;
  }
  const isOpen = Boolean(isDrawerVisible && state.ui.artistsDrawerOpen);

  if (isArtistsDrawerElement(button)) {
    button.hidden = !isDrawerVisible;
    button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }

  if (isArtistsDrawerElement(rail)) {
    rail.classList.toggle('is-mobile-drawer', isDrawerVisible);
    rail.classList.toggle('is-mobile-drawer-open', isOpen);
    rail.setAttribute('aria-hidden', isDrawerVisible && !isOpen ? 'true' : 'false');
    rail.inert = isDrawerVisible && !isOpen;
    const mobileLibraryButton = document.getElementById('mobile-library-button');
    mobileLibraryButton?.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) {
      mobileLibraryButton?.removeAttribute('data-search-results');
      mobileLibraryButton?.removeAttribute('aria-description');
    }
  }

  if (isArtistsDrawerElement(backdrop)) {
    backdrop.hidden = !isOpen;
  }

  document.body?.classList?.toggle('artists-drawer-open', isOpen);
  installMobileLibraryModeRailGestures();
  if (!isOpen && mobileLibraryModeRailHideTimer !== null) {
    clearTimeout(mobileLibraryModeRailHideTimer);
    mobileLibraryModeRailHideTimer = null;
  }
  syncArtistTreeFoldVisibility();
}

function syncArtistTreeFoldVisibility(options = {}) {
  const {
    shell, button, navigationButton, expandedTree, compactNavigation, rail, list,
  } = getArtistTreeFoldElements();
  const canFold = !isArtistsDrawerMobileViewport() && canUseArtistsDrawerForCurrentView();
  if (state.ui.artistTreeFolded === null || state.ui.artistTreeFolded === undefined) {
    const savedFolded = state.ui.shellLayoutPreferences?.artistTreeFolded;
    state.ui.artistTreeFolded = typeof savedFolded === 'boolean'
      ? savedFolded
      : rail?.dataset?.shellDefaultCollapsed === 'true';
  }
  const isFolded = Boolean(canFold && state.ui.artistTreeFolded);
  const isTransitioning = Boolean(canFold && options.transitioning);
  const isExpanding = Boolean(isTransitioning && !isFolded);
  shell?.classList?.toggle('is-artist-tree-folded', isFolded);
  rail?.classList?.toggle('is-folded', isFolded);
  rail?.classList?.toggle('is-transitioning', isTransitioning);
  rail?.classList?.toggle('is-expanding', isExpanding);
  if (button) {
    button.hidden = !canFold || isFolded;
    button.setAttribute('aria-expanded', isFolded ? 'false' : 'true');
    button.setAttribute('aria-label', 'Collapse Artist Tree');
    button.setAttribute('title', 'Collapse Artist Tree');
  }
  if (navigationButton) {
    navigationButton.hidden = !(isFolded || isExpanding);
    navigationButton.setAttribute('aria-expanded', isFolded ? 'false' : 'true');
  }
  if (expandedTree) expandedTree.hidden = isFolded;
  if (compactNavigation) compactNavigation.hidden = !(isFolded || isExpanding);
  if (list) list.hidden = isFolded;
  document.documentElement?.style?.setProperty('--compact-rail-width', isFolded ? '64px' : '240px');
  if (typeof syncDockedCompactPresentation === 'function') syncDockedCompactPresentation();
  return isFolded;
}

function parseCssTimeMs(value) {
  const text = String(value || '').trim();
  const amount = Number.parseFloat(text);
  if (!Number.isFinite(amount)) return 0;
  return text.endsWith('ms') ? amount : text.endsWith('s') ? amount * 1000 : 0;
}

function scheduleArtistTreeResizeAfterTransition(onSettled = null) {
  cancelPendingArtistTreeResize?.();

  const root = document.documentElement;
  let fallbackTimer = null;
  let settled = false;
  const cleanup = () => {
    root?.removeEventListener?.('transitionend', handleTransitionEnd);
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    fallbackTimer = null;
    if (cancelPendingArtistTreeResize === cleanup) cancelPendingArtistTreeResize = null;
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
    onSettled?.();
    window.dispatchEvent(new CustomEvent(ARTIST_TREE_SETTLED_EVENT, {
      detail: { folded: Boolean(state.ui.artistTreeFolded) },
    }));
  };
  const handleTransitionEnd = (event) => {
    if (event.target === root && event.propertyName === '--compact-rail-width') finish();
  };

  root?.addEventListener?.('transitionend', handleTransitionEnd);
  const styles = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(root) : null;
  const duration = parseCssTimeMs(styles?.getPropertyValue?.('--compact-motion-duration'));
  fallbackTimer = setTimeout(finish, duration + 50);
  cancelPendingArtistTreeResize = cleanup;
}

function toggleArtistTreeFold() {
  if (isArtistsDrawerMobileViewport() || !canUseArtistsDrawerForCurrentView()) return false;
  const activeGallerySurface = typeof galleryMainSurfaceController !== 'undefined'
    ? galleryMainSurfaceController?.current?.()
    : null;
  if (activeGallerySurface?.key?.startsWith?.('artist:')
    && typeof closeGalleryMainSurface === 'function') {
    closeGalleryMainSurface(false);
  }
  const { button, navigationButton, rail } = getArtistTreeFoldElements();
  const moveFocusWithinRail = Boolean(rail?.contains?.(document.activeElement));
  const wasFolded = Boolean(state.ui.artistTreeFolded);
  const nextFolded = !wasFolded;
  window.dispatchEvent(new CustomEvent(ARTIST_TREE_TOGGLE_STARTING_EVENT, {
    detail: { folded: nextFolded },
  }));
  state.ui.artistTreeFolded = nextFolded;
  state.ui.shellLayoutPreferences = {
    ...(state.ui.shellLayoutPreferences || {}),
    artistTreeFolded: state.ui.artistTreeFolded,
  };
  if (typeof persistShellLayoutPreferences === 'function') persistShellLayoutPreferences();
  const isFolded = syncArtistTreeFoldVisibility({ transitioning: true });
  if (moveFocusWithinRail && isFolded) {
    navigationButton?.focus?.();
  }
  const settleArtistTree = () => {
    if (Boolean(state.ui.artistTreeFolded) !== isFolded) return;
    syncArtistTreeFoldVisibility();
    if (!isFolded && state.ui.pendingSidebarRevealArtist) renderSidebar();
    if (moveFocusWithinRail && !isFolded) button?.focus?.();
  };
  scheduleArtistTreeResizeAfterTransition(settleArtistTree);
  return isFolded;
}

function openArtistsDrawer() {
  if (!isArtistsDrawerMobileViewport() || !canUseArtistsDrawerForCurrentView()) {
    syncArtistsDrawerVisibility();
    return false;
  }
  const rail = document.getElementById('shell-navigation-rail');
  if (typeof activateTriggerSurface === 'function') activateTriggerSurface(rail, () => closeArtistsDrawer({ restoreFocus: false }), { anchor: document.getElementById('mobile-library-button') || document.getElementById('artists-drawer-button') });
  state.ui.artistsDrawerOpen = true;
  syncArtistsDrawerVisibility();
  setMobileLibraryModeRailVisible(true);
  document.querySelector?.('#artist-tree-expanded [data-close-artists-drawer]')?.focus?.({ preventScroll: true });
  return true;
}

function closeArtistsDrawer(options = {}) {
  const wasOpen = Boolean(state.ui.artistsDrawerOpen);
  state.ui.artistsDrawerOpen = false;
  if (typeof clearTriggerAnchor === 'function') clearTriggerAnchor(document.getElementById('shell-navigation-rail'));
  syncArtistsDrawerVisibility();
  if (wasOpen && options.restoreFocus !== false) {
    (document.getElementById('mobile-library-button') || document.getElementById('artists-drawer-button'))?.focus?.({ preventScroll: true });
  }
  return wasOpen;
}

function toggleArtistsDrawer() {
  if (state.ui.artistsDrawerOpen) {
    return closeArtistsDrawer();
  }
  return openArtistsDrawer();
}

function handleArtistsDrawerClick(event) {
  const modeRailAnchor = event.target.closest('[data-reveal-library-mode-rail="1"]');
  if (modeRailAnchor) {
    event.preventDefault();
    setMobileLibraryModeRailVisible(true);
    document.querySelector?.('.library-navigation-mode-action.is-active')?.focus?.({ preventScroll: true });
    return true;
  }
  const foldButton = event.target.closest('[data-toggle-artist-tree-fold="1"]');
  if (foldButton) {
    event.preventDefault();
    const mode = foldButton.getAttribute?.('data-library-navigation-mode');
    if (mode && typeof setLibraryNavigationMode === 'function') void setLibraryNavigationMode(mode);
    toggleArtistTreeFold();
    return true;
  }

  const toggleButton = event.target.closest('[data-toggle-artists-drawer="1"]');
  if (toggleButton) {
    event.preventDefault();
    toggleArtistsDrawer();
    return true;
  }

  const closeTarget = event.target.closest('[data-close-artists-drawer="1"], #shell-navigation-rail-backdrop');
  if (closeTarget) {
    event.preventDefault();
    event.stopImmediatePropagation?.();
    closeArtistsDrawer();
    return true;
  }

  if (event.target.closest('#artist-tree-context-menu')) return false;

  if (!state.ui.artistsDrawerOpen || !isArtistsDrawerMobileViewport()) {
    return false;
  }

  const { button, rail } = getArtistsDrawerElements();
  if (rail?.contains?.(event.target) || button?.contains?.(event.target)) {
    return false;
  }

  event.preventDefault();
  event.stopImmediatePropagation?.();
  closeArtistsDrawer();
  return true;
}

function handleArtistsDrawerKeydown(event) {
  if (event.key !== 'Escape' || !state.ui.artistsDrawerOpen || !isArtistsDrawerMobileViewport()) {
    return false;
  }
  event.preventDefault();
  closeArtistsDrawer();
  return true;
}
