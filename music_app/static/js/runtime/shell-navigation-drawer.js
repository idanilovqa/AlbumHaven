const MOBILE_ARTISTS_DRAWER_MEDIA_QUERY = '(max-width: 900px)';

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
  }

  if (isArtistsDrawerElement(backdrop)) {
    backdrop.hidden = !isOpen;
  }

  document.body?.classList?.toggle('artists-drawer-open', isOpen);
}

function openArtistsDrawer() {
  if (!isArtistsDrawerMobileViewport() || !canUseArtistsDrawerForCurrentView()) {
    syncArtistsDrawerVisibility();
    return false;
  }
  state.ui.artistsDrawerOpen = true;
  syncArtistsDrawerVisibility();
  return true;
}

function closeArtistsDrawer(options = {}) {
  const wasOpen = Boolean(state.ui.artistsDrawerOpen);
  state.ui.artistsDrawerOpen = false;
  syncArtistsDrawerVisibility();
  if (wasOpen && options.restoreFocus !== false) {
    document.getElementById('artists-drawer-button')?.focus?.();
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
