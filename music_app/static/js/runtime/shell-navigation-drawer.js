const MOBILE_ARTISTS_DRAWER_MEDIA_QUERY = '(max-width: 900px)';
const ARTIST_TREE_SETTLED_EVENT = 'album-haven:artist-tree-settled';
let cancelPendingArtistTreeResize = null;

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
    document.getElementById('mobile-library-button')?.setAttribute('aria-expanded', String(isOpen));
  }

  if (isArtistsDrawerElement(backdrop)) {
    backdrop.hidden = !isOpen;
  }

  document.body?.classList?.toggle('artists-drawer-open', isOpen);
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
  state.ui.artistTreeFolded = !wasFolded;
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
  state.ui.artistsDrawerOpen = true;
  syncArtistsDrawerVisibility();
  document.querySelector?.('#artist-tree-expanded [data-close-artists-drawer]')?.focus?.();
  return true;
}

function closeArtistsDrawer(options = {}) {
  const wasOpen = Boolean(state.ui.artistsDrawerOpen);
  state.ui.artistsDrawerOpen = false;
  syncArtistsDrawerVisibility();
  if (wasOpen && options.restoreFocus !== false) {
    (document.getElementById('mobile-library-button') || document.getElementById('artists-drawer-button'))?.focus?.();
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
  const foldButton = event.target.closest('[data-toggle-artist-tree-fold="1"]');
  if (foldButton) {
    event.preventDefault();
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
    closeArtistsDrawer();
    return true;
  }

  if (!state.ui.artistsDrawerOpen || !isArtistsDrawerMobileViewport()) {
    return false;
  }

  const { button, rail } = getArtistsDrawerElements();
  if (rail?.contains?.(event.target) || button?.contains?.(event.target)) {
    return false;
  }

  closeArtistsDrawer({ restoreFocus: false });
  return false;
}

function handleArtistsDrawerKeydown(event) {
  if (event.key !== 'Escape' || !state.ui.artistsDrawerOpen || !isArtistsDrawerMobileViewport()) {
    return false;
  }
  event.preventDefault();
  closeArtistsDrawer();
  return true;
}
