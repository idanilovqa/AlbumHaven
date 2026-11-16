const MOBILE_ARTISTS_DRAWER_MEDIA_QUERY = '(max-width: 900px)';
const ARTIST_TREE_SETTLED_EVENT = 'album-haven:artist-tree-settled';
const ARTIST_TREE_TOGGLE_STARTING_EVENT = 'album-haven:artist-tree-toggle-starting';
const DESKTOP_LIBRARY_MODE_RAIL_HIDE_DELAY_MS = 30000;
let cancelPendingArtistTreeResize = null;
let desktopLibraryModeRailHideTimer = null;

function setDesktopLibraryModeRailVisible(visible) {
  const rail = document.getElementById('shell-navigation-rail');
  const anchor = document.getElementById('mobile-tree-edge-anchor');
  const canHide = !isArtistsDrawerMobileViewport() && !state.ui.artistTreeFolded;
  const show = !canHide || visible;
  rail?.classList?.toggle('is-library-mode-rail-hidden', !show);
  if (anchor && !isArtistsDrawerMobileViewport()) anchor.hidden = show;
  if (!isArtistsDrawerMobileViewport()) {
    const width = state.ui.artistTreeFolded ? '64px' : show ? '320px' : '261px';
    document.documentElement?.style?.setProperty('--compact-rail-width', width);
  }
  if (desktopLibraryModeRailHideTimer !== null) clearTimeout(desktopLibraryModeRailHideTimer);
  desktopLibraryModeRailHideTimer = null;
  if (show && canHide) {
    desktopLibraryModeRailHideTimer = setTimeout(() => {
      const focused = rail?.contains?.(document.activeElement);
      setDesktopLibraryModeRailVisible(Boolean(focused));
    }, DESKTOP_LIBRARY_MODE_RAIL_HIDE_DELAY_MS);
  }
  return show;
}

function setMobileLibraryModeRailVisible() {
  const rail = document.getElementById('shell-navigation-rail');
  const anchor = document.getElementById('mobile-tree-edge-anchor');
  state.ui.mobileLibraryModeRailVisible = true;
  rail?.classList?.remove('is-mobile-mode-rail-hidden');
  if (anchor && isArtistsDrawerMobileViewport()) anchor.hidden = true;
  return true;
}

function installMobileLibraryModeRailGestures() {
  const rail = document.getElementById('shell-navigation-rail');
  if (!rail || rail.dataset.mobileModeRailGestures === 'true') return;
  rail.dataset.mobileModeRailGestures = 'true';
  const list = document.getElementById('sidebar-list');
  const deferIdleHide = () => {
    if (
      state.ui.mobileLibraryModeRailVisible !== false
      && state.ui.artistsDrawerOpen
      && isArtistsDrawerMobileViewport()
    ) {
      setMobileLibraryModeRailVisible(true);
    } else if (
      !isArtistsDrawerMobileViewport()
      && !state.ui.artistTreeFolded
      && !rail.classList?.contains?.('is-library-mode-rail-hidden')
    ) {
      setDesktopLibraryModeRailVisible(true);
    }
  };
  list?.addEventListener('pointerdown', deferIdleHide, { passive: true });
  list?.addEventListener('scroll', deferIdleHide, { passive: true });
  rail.addEventListener('pointerenter', deferIdleHide, { passive: true });
  rail.addEventListener('pointermove', deferIdleHide, { passive: true });
  rail.addEventListener('focusin', deferIdleHide);
  rail.addEventListener('focusout', deferIdleHide);
  document.addEventListener('pointermove', (event) => {
    if (
      !Number.isFinite(event.clientX)
      || event.clientX > 1
      // A modal over the gallery owns the pointer: the edge never expands the panel behind it (owner 2026-11-16).
      || document.body?.classList?.contains?.('modal-open')
      || isArtistsDrawerMobileViewport()
      || state.ui.artistTreeFolded
      || !rail.classList?.contains?.('is-library-mode-rail-hidden')
    ) return;
    setDesktopLibraryModeRailVisible(true);
  }, { passive: true });
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

// The tree lists collection names and counts from their own bounded request. It never
// waits for the library-wide Loose Tracks payload and never depends on the Artist tree.
let customCollectionCatalog = { key: null, collections: null, request: null };

function customCollectionCatalogUrl(view = state.view || {}) {
  const url = new URL('/library/custom-collections', 'http://localhost');
  (view.visible_library_categories || []).forEach((category) => url.searchParams.append('category', category));
  if (view.gallery_scope) url.searchParams.set('gallery_scope', view.gallery_scope);
  return url;
}

function loadCustomCollectionCatalog() {
  const url = customCollectionCatalogUrl();
  const key = url.search;
  if (customCollectionCatalog.request?.key === key) return customCollectionCatalog.request.promise;
  const promise = (async () => {
    const response = await fetch(`${url.pathname}${url.search}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `Custom Collections request failed: ${response.status}`);
    }
    const collections = (Array.isArray(payload.custom_collections) ? payload.custom_collections : [])
      .map(({ name, count }) => ({ name: String(name || '').trim(), count: Number(count) || 0 }))
      .filter(({ name }) => name)
      .sort((left, right) => left.name.localeCompare(right.name));
    // null while the server's Loose Tracks snapshot is not current: show no number rather than a wrong one.
    const looseTracksCount = Number.isInteger(payload.loose_tracks_count) ? payload.loose_tracks_count : null;
    state.ui.libraryLooseTracksCount = looseTracksCount;
    customCollectionCatalog = { key, collections, request: null };
    return collections;
  })();
  customCollectionCatalog.request = { key, promise };
  promise.catch(() => {
    if (customCollectionCatalog.request?.promise === promise) customCollectionCatalog.request = null;
  });
  return promise;
}

// Only the tree whose page is on screen shows a selection (owner 2026-11-15): while
// library-wide Loose Tracks or a collection is open, the Artists tree selects nothing.
function libraryLooseTracksPageOpen() {
  return Boolean(document.querySelector?.('#non-album-modal:not([hidden])'))
    && state.ui?.nonAlbumLibraryWide === true;
}

// Redraws the Custom Collections selection after its page opens or closes.
function syncCustomCollectionNavigationSelection() {
  if (state.ui?.libraryNavigationMode !== 'custom-collections') return;
  if (customCollectionCatalog.key !== customCollectionCatalogUrl().search) return;
  renderCustomCollectionNavigation(customCollectionCatalog.collections);
}

// collections === null renders placeholders where the named rows will appear.
function renderCustomCollectionNavigation(collections, { failure = '' } = {}) {
  const list = document.getElementById('sidebar-list');
  if (!list) return;
  const pageOpen = libraryLooseTracksPageOpen();
  const activeCollectionName = pageOpen ? String(state.ui?.nonAlbumCollectionName || '').trim() : '';
  const allLooseTracksSelected = pageOpen && !activeCollectionName;
  list.dataset.navigationTree = 'custom-collections';
  list.dataset.sidebarVirtualized = 'false';
  delete list.dataset.sidebarStructureSignature;
  const allLooseTracks = window.NavigationTree.renderItem({
    action: true,
    variant: 'panel',
    key: 'all-loose-tracks',
    label: 'All Loose Tracks',
    count: Number.isInteger(state.ui?.libraryLooseTracksCount) ? state.ui.libraryLooseTracksCount : undefined,
    selected: allLooseTracksSelected,
    attributes: { 'data-open-loose-tracks': '1' },
  });
  const collectionRows = failure
    ? `<p class="utility-empty-state compact">${escapeHtml(failure)}</p>`
    : collections === null
      ? window.NavigationTree.renderSkeleton({ count: 3 })
      : collections.map(({ name, count }) => window.NavigationTree.renderItem({
        action: true,
        variant: 'panel',
        key: name,
        label: name,
        count,
        selected: name === activeCollectionName,
        attributes: { 'data-open-custom-collection': name },
      })).join('');
  list.innerHTML = `${allLooseTracks}${window.NavigationTree.renderSeparator({ label: 'Custom Collections' })}${collectionRows}`;
}

async function setLibraryNavigationMode(mode) {
  const normalized = mode === 'custom-collections' ? mode : 'artists';
  state.ui.suppressSidebarSelection = normalized === 'artists' && libraryLooseTracksPageOpen();
  state.ui.libraryNavigationMode = normalized;
  syncLibraryNavigationModePresentation(normalized);
  if (normalized === 'artists') {
    const list = document.getElementById('sidebar-list');
    if (list) list.dataset.navigationTree = 'artists';
    renderSidebar();
    return normalized;
  }
  const cached = customCollectionCatalog.key === customCollectionCatalogUrl().search
    ? customCollectionCatalog.collections
    : null;
  renderCustomCollectionNavigation(cached);
  setDesktopLibraryModeRailVisible(true);
  try {
    const collections = await loadCustomCollectionCatalog();
    if (state.ui.libraryNavigationMode === normalized) renderCustomCollectionNavigation(collections);
  } catch (error) {
    if (state.ui.libraryNavigationMode === normalized && cached === null) {
      renderCustomCollectionNavigation(null, { failure: error?.message || 'Unable to load Custom Collections.' });
    }
  }
  return normalized;
}

function handleLibraryNavigationClick(event) {
  const modeButton = event.target.closest?.('[data-library-navigation-mode]');
  if (modeButton) {
    event.preventDefault();
    if (isArtistsDrawerMobileViewport()) {
      setMobileLibraryModeRailVisible(true);
      if (Number(event.detail || 0) > 0) modeButton.blur?.();
    }
    void setLibraryNavigationMode(modeButton.getAttribute('data-library-navigation-mode'));
    return true;
  }
  const collectionButton = event.target.closest?.('[data-open-custom-collection]');
  const allLooseTracksButton = event.target.closest?.('[data-open-loose-tracks]');
  if (!collectionButton && !allLooseTracksButton) return false;
  event.preventDefault();
  const collectionName = String(collectionButton?.getAttribute('data-open-custom-collection') || '').trim();
  const selectionKey = collectionName || 'all-loose-tracks';
  window.NavigationTree?.setSelection?.(
    document.getElementById('sidebar-list'),
    selectionKey,
  );
  openLooseTracksPage({ collectionName });
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
  if (!isMobile) setMobileLibraryModeRailVisible(true);
  const supportsArtistsDrawer = canUseArtistsDrawerForCurrentView();
  const isDrawerVisible = Boolean(isMobile && supportsArtistsDrawer);
  if (!isDrawerVisible) {
    state.ui.artistsDrawerOpen = false;
  }
  const isOpen = Boolean(isDrawerVisible && state.ui.artistsDrawerOpen);
  if (isOpen) {
    syncLibraryNavigationModePresentation(
      document.getElementById('sidebar-list')?.dataset?.navigationTree || state.ui.libraryNavigationMode,
    );
  }

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
  syncArtistTreeFoldVisibility();
  setDesktopLibraryModeRailVisible(true);
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
  document.documentElement?.style?.setProperty('--compact-rail-width', isFolded ? '64px' : '320px');
  if (!isArtistsDrawerMobileViewport()) setDesktopLibraryModeRailVisible(true);
  if (typeof syncDockedCompactPresentation === 'function') syncDockedCompactPresentation();
  return isFolded;
}

function parseCssTimeMs(value) {
  const text = String(value || '').trim();
  const amount = Number.parseFloat(text);
  if (!Number.isFinite(amount)) return 0;
  return text.endsWith('ms') ? amount : text.endsWith('s') ? amount * 1000 : 0;
}

function announceArtistTreeSettled() {
  window.dispatchEvent(new CustomEvent(ARTIST_TREE_SETTLED_EVENT, {
    detail: { folded: Boolean(state.ui.artistTreeFolded) },
  }));
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
    announceArtistTreeSettled();
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

// `instant` skips the rail animation: a search that opens the tree must not render its
// first results at the folded width and then shift them while the rail grows.
function toggleArtistTreeFold({ instant = false } = {}) {
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
  const root = document.documentElement;
  if (instant) root?.setAttribute?.('data-shell-motion', 'instant');
  const isFolded = syncArtistTreeFoldVisibility({ transitioning: !instant });
  if (moveFocusWithinRail && isFolded) {
    navigationButton?.focus?.();
  }
  const settleArtistTree = () => {
    if (Boolean(state.ui.artistTreeFolded) !== isFolded) return;
    syncArtistTreeFoldVisibility();
    if (!isFolded && state.ui.pendingSidebarRevealArtist) renderSidebar();
    if (moveFocusWithinRail && !isFolded) button?.focus?.();
  };
  if (instant) {
    cancelPendingArtistTreeResize?.();
    window.getComputedStyle?.(root)?.getPropertyValue?.('--compact-rail-width');
    settleArtistTree();
    announceArtistTreeSettled();
    scheduleBrowserAnimationFrame(() => root?.removeAttribute?.('data-shell-motion'));
    return isFolded;
  }
  scheduleArtistTreeResizeAfterTransition(settleArtistTree);
  return isFolded;
}

function openArtistsDrawer() {
  if (!isArtistsDrawerMobileViewport() || !canUseArtistsDrawerForCurrentView()) {
    syncArtistsDrawerVisibility();
    return false;
  }
  const rail = document.getElementById('shell-navigation-rail');
  if (typeof activateTriggerSurface === 'function') activateTriggerSurface(rail, () => closeArtistsDrawer({ restoreFocus: false }), { anchor: document.querySelector?.('[data-toggle-artists-drawer="1"]:not([hidden])') || document.getElementById('artists-drawer-button') });
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
    (document.querySelector?.('[data-toggle-artists-drawer="1"]:not([hidden])') || document.getElementById('artists-drawer-button'))?.focus?.({ preventScroll: true });
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
    if (isArtistsDrawerMobileViewport()) setMobileLibraryModeRailVisible(true);
    else setDesktopLibraryModeRailVisible(true);
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
    const mode = document.getElementById('sidebar-list')?.dataset?.navigationTree
      || toggleButton.getAttribute?.('data-library-navigation-mode');
    if (mode) void setLibraryNavigationMode(mode);
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
