function createAnchoredSurfaceController() {
  let active = null;
  const close = (returnFocus = true) => {
    if (!active) return false;
    const previous = active;
    active = null;
    if (returnFocus) previous.anchor?.focus?.();
    return true;
  };
  return {
    activate(next) {
      if (active?.key === next.key) { close(true); return 'closed'; }
      close(false);
      active = next;
      return 'opened';
    },
    close,
    current: () => active,
    isOpen: (key) => active?.key === key,
    handlePointerDown(event = {}) {
      if (!active || active.surface?.contains?.(event.target)) return false;
      return close(true);
    },
    handleKeyDown(event = {}) {
      if (!active || event.key !== 'Escape') return false;
      event.preventDefault?.();
      return close(true);
    },
  };
}

function observeArtistFamilyPanelBounds({ panel, player } = {}) {
  if (!panel || !player) return { disconnect() {} };
  const update = () => {
    const playerBounds = player.getBoundingClientRect?.();
    let panelBounds = panel.getBoundingClientRect?.();
    // Reserve the visible player's space using the drawer's settled box, not
    // its off-screen animation frame, so the first swipe cannot hit the player.
    const panelStyle = typeof getComputedStyle === 'function' ? getComputedStyle(panel) : null;
    if (panelBounds && panelStyle?.transform && panelStyle.transform !== 'none'
        && typeof DOMMatrixReadOnly === 'function') {
      const transform = new DOMMatrixReadOnly(panelStyle.transform);
      panelBounds = { left: panelBounds.left - transform.m41, right: panelBounds.right - transform.m41 };
    }
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(player) : null;
    const opacity = Number.parseFloat(style?.opacity);
    const visible = !player.hidden
      && style?.display !== 'none'
      && style?.visibility !== 'hidden'
      && style?.visibility !== 'collapse'
      && (!Number.isFinite(opacity) || opacity > 0)
      && Number(playerBounds?.width || 0) > 0
      && Number(playerBounds?.height || 0) > 0;
    const overlapsPanel = visible
      && Number(playerBounds.right) > Number(panelBounds?.left || 0)
      && Number(playerBounds.left) < Number(panelBounds?.right || 0);
    const viewportHeight = Number(
      (typeof window !== 'undefined' && window.innerHeight)
      || (typeof document !== 'undefined' && document.documentElement?.clientHeight)
      || playerBounds?.bottom
      || 0,
    );
    const bottom = overlapsPanel ? Math.max(0, viewportHeight - Number(playerBounds.top || 0)) : 0;
    panel.style.bottom = `${Math.round(bottom)}px`;
  };
  update();
  if (typeof ResizeObserver !== 'function') return { disconnect() {}, refresh: update };
  const observer = new ResizeObserver(update);
  observer.observe(player);
  return { disconnect: () => observer.disconnect(), refresh: update };
}

function positionGalleryAnchoredSurface(surface, anchor, align = 'right') {
  if (!surface || !anchor?.getBoundingClientRect) return;
  if (surface.matches?.('.artist-info-overlay') && typeof usesMobilePageLayout === 'function' && usesMobilePageLayout()) {
    ['top', 'left', 'right', 'max-width'].forEach(name => surface.style.removeProperty(name));
    return;
  }
  const rect = anchor.getBoundingClientRect();
  surface.dataset.anchorEnvelope = align;
  surface.style.setProperty?.('--gallery-anchor-width', `${Math.round(rect.width)}px`);
  surface.style.setProperty?.('--gallery-anchor-height', `${Math.round(rect.height)}px`);
  surface.style.top = `${Math.round(rect.bottom - 1)}px`;
  if (align === 'left') {
    const galleryLeft = document.querySelector('[data-gallery-bar]')?.getBoundingClientRect().left ?? rect.left;
    const left = Math.max(12, Math.round(galleryLeft));
    surface.style.maxWidth = `${Math.max(0, window.innerWidth - left - Math.min(left, 24))}px`;
    surface.style.left = `${left}px`;
    surface.style.right = 'auto';
  } else {
    surface.style.right = `${Math.max(12, Math.round(window.innerWidth - rect.right))}px`;
    surface.style.left = 'auto';
  }
  if (typeof syncTriggerAnchor === 'function') syncTriggerAnchor(surface, anchor);
}

function resolveCurrentGalleryAnchor(anchor) {
  if (!anchor || anchor.isConnected !== false) return anchor;
  const sectionKey = anchor.closest?.('[data-virtual-section-key]')?.dataset.virtualSectionKey;
  if (!sectionKey) return anchor;
  const section = Array.from(document.querySelectorAll?.('[data-virtual-section-key]') || [])
    .find(candidate => candidate.dataset.virtualSectionKey === sectionKey);
  return section?.querySelector?.('[data-artist-info-trigger]') || anchor;
}

function revealGalleryArtistInfoSurface(surface, anchor) {
  if (!surface?.matches?.('.artist-info-overlay')
      || (typeof usesMobilePageLayout === 'function' && usesMobilePageLayout())) return 0;
  const scroll = document.getElementById('albums-scroll');
  if (!scroll) return 0;
  const player = document.querySelector('[data-shell-slot="bottom_player"]');
  const playerBounds = player?.getBoundingClientRect?.();
  const viewportBottom = player && !player.hidden && Number(playerBounds?.height || 0) > 0
    ? Math.min(window.innerHeight, Number(playerBounds.top))
    : window.innerHeight;
  const offset = Math.max(0, Math.ceil(Number(surface.getBoundingClientRect?.().bottom || 0) - viewportBottom));
  if (!offset) return 0;
  scroll.scrollTop += offset;
  positionGalleryAnchoredSurface(surface, anchor, 'left');
  requestAnimationFrame(() => {
    const currentAnchor = resolveCurrentGalleryAnchor(anchor);
    const active = galleryMainSurfaceController?.current?.();
    if (active?.surface === surface) active.anchor = currentAnchor;
    positionGalleryAnchoredSurface(surface, currentAnchor, 'left');
  });
  return offset;
}

function positionArtistFamilyPanelEnvelope(panel, anchor) {
  if (!panel || !anchor?.getBoundingClientRect) return;
  const rect = anchor.getBoundingClientRect();
  const bar = anchor.closest?.('.gallery-bar');
  const mobile = typeof usesMobilePageLayout === 'function' && usesMobilePageLayout();
  const panelTop = mobile ? rect.bottom - 1 : bar?.getBoundingClientRect?.().bottom;
  if (Number.isFinite(panelTop)) panel.style.top = `${Math.round(panelTop)}px`;
  const top = Number.isFinite(panelTop) ? panelTop : panel.getBoundingClientRect?.().top;
  panel.style.setProperty?.('--gallery-anchor-gap', `${Math.max(0, Math.round((top || rect.bottom) - rect.bottom))}px`);
  panel.dataset.anchorEnvelope = 'right';
  panel.style.setProperty?.('--gallery-anchor-width', `${Math.round(rect.width)}px`);
  panel.style.setProperty?.('--gallery-anchor-height', `${Math.round(rect.height)}px`);
  panel.style.setProperty?.('--gallery-anchor-right', `${Math.max(0, Math.round(window.innerWidth - rect.right))}px`);
  if (typeof syncTriggerAnchor === 'function') syncTriggerAnchor(panel, anchor);
  galleryFamilyPanelObserver?.refresh?.();
}

function positionSearchSuggestionsSurface(surface) {
  if (!surface?.style) return;
  const input = document.getElementById('search-input');
  if (!input?.getBoundingClientRect) return;
  const control = input.closest?.('.search-field-control') || input;
  const rect = control.getBoundingClientRect();
  if (typeof getComputedStyle === 'function') {
    const style = getComputedStyle(control);
    surface.style.setProperty('--search-joined-focus', style.getPropertyValue('--search-field-focus').trim() || style.borderColor);
    surface.style.setProperty('--search-joined-background', style.backgroundColor);
  }
  if (surface.parentElement !== document.body) document.body.appendChild(surface);
  surface.style.position = 'fixed';
  surface.style.top = `${Math.round(rect.bottom - 1)}px`;
  surface.style.left = `${Math.round(rect.left)}px`;
  surface.style.right = 'auto';
  surface.style.width = `${Math.round(rect.width)}px`;
}

function focusGalleryMainSurface(surface) {
  if (!surface) return null;
  const target = surface.querySelector?.('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') || surface;
  if (target === surface) surface.tabIndex = -1;
  target.focus?.({ preventScroll: true });
  return target;
}

function shouldFocusGalleryMainSurface(key) {
  return key !== 'search-suggestions';
}

let galleryMainSurfaceController = null;
let galleryMainScrollFrame = 0;
let galleryFamilyPanelObserver = null;
let galleryFamilyDragHandlersBound = false;

function getGalleryMainGroups() {
  const primary = Array.isArray(state.view.primary_artist_groups) ? state.view.primary_artist_groups : [];
  const family = Array.isArray(state.view.family_artist_groups) ? state.view.family_artist_groups : [];
  const fallback = Array.isArray(state.view.artist_groups) ? state.view.artist_groups : [];
  return primary.length || family.length ? [...primary, ...family] : fallback;
}

function galleryMainGroupArtist(group = {}) {
  return String(group.artist_display || group.artist || '').trim();
}

function getGalleryFamilyPanelGroups() {
  const primaryArtist = String(state.view.selected_artist || '').trim();
  if (!primaryArtist) return [];
  const relatedArtists = Array.isArray(state.view.related_artists)
    ? state.view.related_artists.map((artist) => String(artist || '').trim()).filter(Boolean)
    : [];
  const cacheState = typeof getRelatedFilterCacheState === 'function'
    ? getRelatedFilterCacheState()
    : state.gallery;
  const cacheMatchesView = cacheState
    && String(cacheState.relatedFilterBaseArtist || '') === primaryArtist
    && String(cacheState.relatedFilterBaseQuery || '') === String(state.view.query || '');
  const cachedGroups = cacheMatchesView
    ? [
      ...(Array.isArray(cacheState.relatedFilterBasePrimaryGroups) ? cacheState.relatedFilterBasePrimaryGroups : []),
      ...(Array.isArray(cacheState.relatedFilterBaseFamilyGroups) ? cacheState.relatedFilterBaseFamilyGroups : []),
      ...(Array.isArray(cacheState.relatedFilterDefaultPrimaryGroups) ? cacheState.relatedFilterDefaultPrimaryGroups : []),
      ...(Array.isArray(cacheState.relatedFilterDefaultFamilyGroups) ? cacheState.relatedFilterDefaultFamilyGroups : []),
    ]
    : [];
  const baseGroups = [
    ...(state.view.related_filter_base_primary_groups || []),
    ...(state.view.related_filter_base_family_groups || []),
  ];
  const candidates = baseGroups.length ? [...baseGroups, ...getGalleryMainGroups()] : [...cachedGroups, ...getGalleryMainGroups()];
  const fallbackArtists = getGalleryMainGroups().map((group) => galleryMainGroupArtist(group)).filter(Boolean);
  const familyArtists = relatedArtists.length ? relatedArtists : fallbackArtists;
  const names = [primaryArtist, ...familyArtists.filter((artist) => artist !== primaryArtist)];
  const resolvedGroups = names.map((artist) => {
    const exactGroup = candidates.reduce((best, group) => {
      if (galleryMainGroupArtist(group) !== artist || !(group.albums?.length > 0)) return best;
      return !best || group.albums.length > (best.albums?.length || 0) ? group : best;
    }, null);
    if (exactGroup) return exactGroup;
    const matchingArtist = new Set([artist]);
    const aliasGroup = candidates.reduce((best, group) => {
      const matches = galleryMainGroupArtist(group) === artist || (
        typeof groupMatchesRelatedArtists === 'function'
        && groupMatchesRelatedArtists(group, matchingArtist)
      );
      if (!matches) return best;
      return !best || (group.albums?.length || 0) > (best.albums?.length || 0) ? group : best;
    }, null);
    return aliasGroup || { artist, artist_display: artist, albums: [] };
  });
  return resolvedGroups.filter((group, index) => (
    resolvedGroups.findIndex((candidate) => galleryMainGroupArtist(candidate) === galleryMainGroupArtist(group)) === index
  ));
}

function hasGalleryArtistFamily() {
  const primaryArtist = String(state.view.selected_artist || '').trim();
  return Boolean(primaryArtist && getGalleryFamilyPanelGroups().length > 1);
}

function getGalleryMainContextSections() {
  const sections = typeof virtualGrid !== 'undefined' && Array.isArray(virtualGrid?.sections)
    ? virtualGrid.sections
    : [];
  const scroll = document.getElementById('albums-scroll');
  const labelBottoms = new Map();
  if (scroll) {
    const viewportTop = scroll.getBoundingClientRect().top;
    document.querySelectorAll('[data-scroll-artist]').forEach(section => {
      const label = section.querySelector('.artist-name');
      if (label) labelBottoms.set(String(section.dataset.scrollArtist || '').trim(),
        label.getBoundingClientRect().bottom - viewportTop + scroll.scrollTop);
    });
  }
  return sections.filter((section) => section?.kind === 'artist' || section?.group).map((section) => ({
    artist: galleryMainGroupArtist(section.group),
    albumCount: Array.isArray(section.group?.albums) ? section.group.albums.length : 0,
    artist_musicbrainz: section.group?.artist_musicbrainz || null,
    top: Number(section.top || 0),
    labelBottom: labelBottoms.get(galleryMainGroupArtist(section.group))
      ?? Number(section.top || 0) + Number(virtualGrid?.sectionHeaderHeight || 0),
  })).filter((section) => section.artist);
}

function syncGalleryFamilySelection(mainState, view = {}) {
  const related = (view.related_filter_artists || []).map(artist => String(artist).trim()).filter(Boolean);
  const primary = String(view.selected_artist || '').trim();
  mainState.familyArtists = [...new Set([
    ...(view.primary_filter_active && primary ? [primary] : []), ...related,
  ])];
  if (mainState.familyArtists.length) mainState.familySelectionExplicit = true;
  else delete mainState.familySelectionExplicit;
}

function ensureGalleryMainState() {
  if (state.gallery.mainState) return state.gallery.mainState;
  const visible = new Set(state.view.visible_library_categories || ['main_library', 'new_arrivals', 'hoard']);
  state.gallery.mainState = createGalleryMainState({
    sources: { main_library: visible.has('main_library'), new_arrivals: visible.has('new_arrivals'), hoard: visible.has('hoard') },
    view: state.view.gallery_display_mode,
  });
  syncGalleryFamilySelection(state.gallery.mainState, state.view);
  return state.gallery.mainState;
}

function cacheGallerySourceTotals(categories, payload) {
  if (typeof state === 'undefined' || !state?.gallery) return false;
  const artistCount = Number(payload?.artist_count ?? payload?.artistCount);
  const albumCount = Number(payload?.album_count ?? payload?.albumCount);
  if (!Number.isFinite(artistCount) || !Number.isFinite(albumCount)) return false;
  state.gallery.sourceTotalsByScope ||= {};
  state.gallery.sourceTotalsByScope[gallerySourceScopeKey(categories)] = { artistCount, albumCount };
  return true;
}

function cacheCurrentGallerySourceTotals() {
  if (typeof state === 'undefined' || !state?.view) return false;
  const categories = state.view.loaded_library_categories || state.view.visible_library_categories;
  if (!Array.isArray(categories)) return false;
  return cacheGallerySourceTotals(categories, state.view);
}

async function prefetchGallerySourceTotalsForAllScopes() {
  if (typeof state === 'undefined' || !state?.gallery || !state?.view
    || typeof fetch !== 'function') return false;
  const currentRevision = Number(
    state.status?.inventory_mutation_revision ?? state.view?.inventory_mutation_revision ?? 0,
  );
  if (Number.isSafeInteger(state.gallery.sourceTotalsRevision)
    && state.gallery.sourceTotalsRevision !== currentRevision) {
    state.gallery.sourceTotalsByScope = {};
  }
  cacheCurrentGallerySourceTotals();
  const expectedKeys = [
    '', 'hoard', 'hoard|main_library', 'hoard|main_library|new_arrivals',
    'hoard|new_arrivals', 'main_library', 'main_library|new_arrivals', 'new_arrivals',
  ];
  if (state.gallery.sourceTotalsRevision === currentRevision
    && expectedKeys.every(key => state.gallery.sourceTotalsByScope?.[key])) return true;
  if (state.gallery.pendingSourceTotalsRequest) return state.gallery.pendingSourceTotalsRequest;
  const request = (async () => {
    try {
      const response = await fetch('/home-data?source_totals=1', {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return false;
      const payload = await response.json();
      const received = payload?.source_totals_by_scope;
      const responseRevision = Number(payload?.inventory_mutation_revision);
      const latestRevision = Number(
        state.status?.inventory_mutation_revision ?? state.view?.inventory_mutation_revision ?? 0,
      );
      if (!Number.isSafeInteger(responseRevision) || responseRevision !== latestRevision
        || !received || !expectedKeys.every((key) => {
        const total = received[key];
        return Number.isFinite(Number(total?.artist_count))
          && Number.isFinite(Number(total?.album_count));
      })) return false;
      state.gallery.sourceTotalsByScope = Object.fromEntries(expectedKeys.map((key) => [key, {
        artistCount: Number(received[key].artist_count),
        albumCount: Number(received[key].album_count),
      }]));
      state.gallery.sourceTotalsRevision = responseRevision;
      updateGalleryMainChrome();
      return true;
    } catch {
      return false;
    } finally {
      if (state.gallery.pendingSourceTotalsRequest === request) {
        state.gallery.pendingSourceTotalsRequest = null;
      }
    }
  })();
  state.gallery.pendingSourceTotalsRequest = request;
  return request;
}

function syncGalleryMainStateFromView(previousView = {}, nextView = {}) {
  const mainState = ensureGalleryMainState();
  const selectionChanged = String(previousView.selected_artist || '') !== String(nextView.selected_artist || '');
  if (selectionChanged) {
    syncGalleryFamilySelection(mainState, nextView);
  }
  state.gallery.mainState = mainState;
}

function syncGalleryMainStateFromLocation(viewUrl) {
  const url = new URL(viewUrl || window.location.href, window.location.href);
  const categories = url.searchParams.getAll('category');
  const visible = new Set(categories.length ? categories : ['main_library', 'new_arrivals', 'hoard']);
  const mainState = ensureGalleryMainState();
  mainState.sources = { main_library: visible.has('main_library'), new_arrivals: visible.has('new_arrivals'), hoard: visible.has('hoard') };
  mainState.view = normalizeGalleryView(url.searchParams.get('gallery_display')
    || (viewUrl ? 'cards' : state.gallery.displayPreferences?.defaultGalleryDisplayMode) || 'cards');
  const savedSources = window.AlbumHavenDevicePreferences?.read('gallerySources', null);
  if (!categories.length && savedSources) mainState.sources = { ...mainState.sources, ...savedSources };
  syncGalleryFamilySelection(mainState, {
    selected_artist: url.searchParams.get('artist'),
    related_filter_artists: url.searchParams.getAll('related_artist'),
    primary_filter_active: url.searchParams.get('primary_filter') === '1',
  });
  state.gallery.mainState = mainState;
}

function getFilteredGalleryMainModel() {
  const filterState = ensureGalleryMainState();
  const filter = groups => filterGalleryModel({ groups: groups || [], filterState }).groups;
  // Selection refers to original artist identities, never synthesized display names.
  const selectedArtist = String(state.view.selected_artist || '').trim();
  const panelSelection = selectedArtist && (filterState.familySelectionExplicit === true
    || filterState.familyArtists?.length > 0 || state.view.related_filter_artists?.length > 0
    || state.view.primary_filter_active);
  // A primary-only server view may omit family albums already available to the panel.
  const panelGroups = panelSelection ? getGalleryFamilyPanelGroups() : null;
  const primary = filter(panelGroups
    ? panelGroups.filter(group => galleryMainGroupArtist(group) === selectedArtist)
    : state.view.primary_artist_groups);
  const family = filter(panelGroups
    ? panelGroups.filter(group => galleryMainGroupArtist(group) !== selectedArtist)
    : state.view.family_artist_groups);
  const display = typeof buildSelectedArtistDisplayGroups === 'function'
    ? buildSelectedArtistDisplayGroups(primary, family, state.view.selected_artist)
    : { primaryGroups: primary, familyGroups: family };
  const fallbackGroups = filter(panelGroups || state.view.artist_groups);
  const chronological = String(state.view.selected_artist_family_display_mode
    ?? state.view.artist_page?.family_display_mode ?? 'grouped') === 'chronological';
  const primaryGroups = chronological ? [] : display.primaryGroups;
  const familyGroups = chronological ? [] : display.familyGroups;
  const sourceGroups = primaryGroups.length || familyGroups.length
    ? [...primaryGroups, ...familyGroups] : fallbackGroups;
  const groups = typeof buildDisplayGroups === 'function' ? buildDisplayGroups(sourceGroups) : sourceGroups;
  return {
    primaryGroups, familyGroups, fallbackGroups, groups,
    totals: {
      artistCount: groups.length,
      albumCount: groups.reduce((total, group) => total + group.albums.length, 0),
    },
  };
}

function getGalleryFamilyPanelModel() {
  const mainState = ensureGalleryMainState();
  return filterGalleryModel({
    groups: getGalleryFamilyPanelGroups(),
    filterState: {
      ...mainState,
      albumTypes: GALLERY_RELEASE_TYPES,
      familyArtists: [],
      familySelectionExplicit: false,
    },
  });
}

const galleryMainSurfaceCloseCallbacks = new WeakMap();

function closeGalleryMainSurface(returnFocus = true, { immediate = false } = {}) {
  const active = galleryMainSurfaceController?.current?.();
  if (!active) return false;
  if (!immediate && active.surface.classList?.contains?.('is-mobile-artist-dialog') && typeof runBottomSheetExit === 'function'
      && runBottomSheetExit(active.surface, () => {
        if (galleryMainSurfaceController.current?.() === active) closeGalleryMainSurface(returnFocus, { immediate: true });
      }, { backdrop: document.querySelector?.('.mobile-artist-info-backdrop') })) return true;
  const slidingPanel = active.surface.matches?.('.artist-family-panel, .mobile-settings-drawer') === true;
  if (active.surface.matches?.('.artist-info-overlay') && typeof syncMobileArtistInfoDialog === 'function') syncMobileArtistInfoDialog(active.surface, false);
  if (active.key === 'search-suggestions' && state.ui) {
    state.ui.recentSearchPopoverOpen = false;
    state.ui.recentSearchActiveIndex = -1;
    active.anchor?.removeAttribute?.('aria-activedescendant');
  }
  active.surface.classList?.remove?.('is-open');
  active.surface.setAttribute?.('aria-hidden', 'true');
  active.anchor?.setAttribute?.('aria-expanded', 'false');
  if (typeof clearTriggerAnchor === 'function') clearTriggerAnchor(active.surface);
  const closed = galleryMainSurfaceController.close(active.key === 'search-suggestions' ? false : returnFocus);
  if (immediate || !slidingPanel || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    active.surface.hidden = true;
  } else {
    let finished = false;
    let timeout;
    const cancel = () => {
      finished = true;
      active.surface.removeEventListener?.('transitionend', finish);
      window.clearTimeout?.(timeout);
      galleryMainSurfaceCloseCallbacks.delete(active.surface);
    };
    const finish = () => {
      if (finished) return;
      cancel();
      if (!active.surface.classList?.contains?.('is-open')) active.surface.hidden = true;
    };
    galleryMainSurfaceCloseCallbacks.set(active.surface, cancel);
    active.surface.addEventListener?.('transitionend', finish, { once: true });
    timeout = window.setTimeout?.(finish, 260);
  }
  return closed;
}

function getGalleryFamilyContextKey(view = state.view) {
  return JSON.stringify([
    String(view.selected_artist || '').trim(), String(view.query || '').trim(),
    String(view.gallery_scope || 'all'), String(view.surface?.active || 'albums'),
  ]);
}

function openGalleryMainSurface(key, anchor, surface, align = 'right') {
  if (!anchor || !surface) return false;
  if (surface.matches?.('.gallery-anchored-menu') && surface.parentElement !== document.body) {
    document.body.appendChild(surface);
  }
  if (!galleryMainSurfaceController) galleryMainSurfaceController = createAnchoredSurfaceController();
  const previous = galleryMainSurfaceController.current();
  if (previous?.key === key) {
    closeGalleryMainSurface(true);
    return false;
  }
  if (key === 'sources') hydrateDeferredNonAlbumTracksForAlbumTypes();
  if (previous) closeGalleryMainSurface(false, { immediate: true });
  galleryMainSurfaceCloseCallbacks.get(surface)?.();
  if (typeof activateTriggerSurface === 'function') activateTriggerSurface(surface, () => {
    if (galleryMainSurfaceController.current()?.surface === surface) closeGalleryMainSurface(false);
  }, { anchor });
  galleryMainSurfaceController.activate({ key, anchor, surface,
    familyContextKey: key === 'artist-family' ? getGalleryFamilyContextKey() : null,
    openingQuery: String((typeof state === 'undefined' ? '' : state.view?.query) || '').trim() });
  anchor.setAttribute('aria-expanded', 'true');
  surface.hidden = false;
  if (surface.matches?.('.artist-family-panel, .mobile-settings-drawer')) {
    surface.classList?.remove?.('is-open');
    void surface.offsetWidth;
  }
  surface.classList?.add?.('is-open');
  surface.setAttribute?.('aria-hidden', 'false');
  if (surface.matches?.('.mobile-settings-drawer')) {
    surface.style.top = `${Math.max(0, Math.round(document.querySelector('#app-shell .app-bar').getBoundingClientRect().bottom))}px`;
  } else if (surface.matches?.('.gallery-anchored-menu, .artist-info-overlay')) {
    positionGalleryAnchoredSurface(surface, anchor, align);
    if (surface.matches?.('.artist-info-overlay')) revealGalleryArtistInfoSurface(surface, anchor);
  }
  if (surface.matches?.('.artist-family-panel')) positionArtistFamilyPanelEnvelope(surface, anchor);
  if (surface.matches?.('.artist-info-overlay') && typeof syncMobileArtistInfoDialog === 'function') syncMobileArtistInfoDialog(surface, true);
  if (shouldFocusGalleryMainSurface(key)) focusGalleryMainSurface(surface);
  return true;
}

function updateGalleryMainControls() {
  const mainState = ensureGalleryMainState();
  mainState.view = normalizeGalleryView(mainState.view);
  state.view.gallery_display_mode = normalizeGalleryView(state.view.gallery_display_mode);
  const rowChoice = document.querySelector('[data-gallery-view-choice="list"]');
  if (rowChoice) rowChoice.hidden = Number(window.innerWidth) > 900;
  const hasSelectedArtist = Boolean(String(state.view.selected_artist || '').trim());
  const familyTrigger = document.querySelector('[data-gallery-bar-action="artist-family"]');
  if (familyTrigger) familyTrigger.hidden = !hasSelectedArtist;
  if (!hasSelectedArtist && galleryMainSurfaceController?.current?.()?.key === 'artist-family') {
    closeGalleryMainSurface(false);
  }
  // The compact family count is independent of the deferred track payload.
  if (hasSelectedArtist || String(state.view.query || '').trim() || galleryMainSurfaceController?.current?.()?.key === 'album-types'
      || document.getElementById?.('gallery-album-types-menu')?.hidden === false) {
    hydrateDeferredNonAlbumTracksForAlbumTypes();
  }
  document.querySelectorAll('[data-gallery-source]').forEach((button) => {
    button.setAttribute('aria-checked', mainState.sources[button.dataset.gallerySource] === false ? 'false' : 'true');
  });
  document.querySelectorAll('[data-gallery-album-type]').forEach((button) => {
    button.setAttribute('aria-pressed', mainState.albumTypes.includes(button.dataset.galleryAlbumType) ? 'true' : 'false');
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
  });
  document.querySelectorAll('[data-gallery-featured-on]').forEach((button) => {
    button.setAttribute('aria-pressed', mainState.showFeaturedOn === false ? 'false' : 'true');
    button.disabled = false;
  });
  const splitMode = mainState.splitAlbums;
  // Shown only when the discography in view has a split album, or a non-default position needs undoing.
  const hasSplitAlbums = splitMode !== 'show' || [state.view.primary_artist_groups, state.view.family_artist_groups, state.view.artist_groups]
    .some((groups) => (Array.isArray(groups) ? groups : []).some((group) => (group?.albums || []).some((album) => isGallerySplitAlbum(album))));
  document.querySelectorAll('[data-gallery-split-albums]').forEach((control) => {
    const position = GALLERY_SPLIT_ALBUM_MODES.indexOf(splitMode);
    control.hidden = !hasSplitAlbums;
    control.dataset.switchPosition = String(position);
    control.setAttribute('aria-valuenow', String(position));
    control.setAttribute('aria-valuetext', GALLERY_SPLIT_ALBUM_LABELS[splitMode]);
    const label = control.querySelector?.('[data-gallery-split-albums-label]');
    if (label) label.textContent = GALLERY_SPLIT_ALBUM_LABELS[splitMode];
  });
  document.querySelectorAll('[data-gallery-view-choice]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.galleryViewChoice === mainState.view);
  });
  const preferenceArtist = typeof getCurrentGalleryPreferenceArtist === 'function'
    ? getCurrentGalleryPreferenceArtist()
    : String(state.view.selected_artist || '').trim();
  document.querySelectorAll('[data-toggle-combine-similar-artists="1"]').forEach((button) => {
    const checked = Boolean(preferenceArtist)
      && typeof getCombineSimilarArtistsPreference === 'function'
      && getCombineSimilarArtistsPreference(preferenceArtist);
    const ariaChecked = checked ? 'true' : 'false';
    if (button.getAttribute('aria-checked') !== ariaChecked) button.setAttribute('aria-checked', ariaChecked);
    button.disabled = !preferenceArtist;
  });
  document.querySelectorAll('[data-open-non-album-tracks]').forEach((button) => {
    // Library-wide Loose Tracks is a navigation destination: always pressable (an empty library shows its empty state).
    const libraryWide = button.dataset.libraryWide === '1';
    const selectedArtist = Boolean(String(state.view?.selected_artist || '').trim());
    const artistFamily = !libraryWide && selectedArtist && !String(state.view?.query || '').trim();
    const familyCountReady = artistFamily
      && typeof hasHydratedArtistNonAlbumAvailability === 'function'
      && hasHydratedArtistNonAlbumAvailability();
    const scopePending = libraryWide
      ? !hasHydratedLibraryNonAlbumTracks()
      : Boolean(state.view?.non_album_tracks_deferred);
    const enabled = libraryWide || (artistFamily
      ? familyCountReady && Number(state.view.non_album_track_count) > 0
      : scopePending || getVisibleNonAlbumTracks({ libraryWide }).length > 0);
    button.disabled = !enabled;
    button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    const matches = typeof hasNonAlbumSearchMatches === 'function'
      && hasNonAlbumSearchMatches({ libraryWide: button.dataset.libraryWide === '1' });
    button.dataset.searchMatch = String(Boolean(matches));
    button.setAttribute('aria-description', matches ? 'Contains tracks matching your search' : '');
  });
  // On a phone, Loose Tracks is a tab of the Artists panel; it carries the same search dot.
  const mobileLooseTracks = document.querySelector('.mobile-artists-mode-button[data-navigation-mode="collections"]');
  if (mobileLooseTracks) {
    const matches = typeof hasNonAlbumSearchMatches === 'function' && hasNonAlbumSearchMatches({ libraryWide: true });
    mobileLooseTracks.dataset.searchMatch = String(Boolean(matches));
    mobileLooseTracks.setAttribute('aria-description', matches ? 'Contains tracks matching your search' : '');
  }
  const viewCluster = document.querySelector('[data-gallery-view-cluster]');
  if (viewCluster) {
    viewCluster.querySelectorAll('[data-gallery-view-choice]').forEach(button => {
      button.dataset.actionValue = button.dataset.galleryViewChoice;
      button.removeAttribute('data-gallery-bar-action');
      button.removeAttribute('data-gallery-bar-action');
    });
    const direction = typeof usesMobilePageLayout === 'function' && usesMobilePageLayout() ? 'down' : 'left';
    if (viewCluster.dataset.unfoldDirection && viewCluster.dataset.unfoldDirection !== direction) {
      UnfoldingActionButton.mount(viewCluster).close();
    }
    UnfoldingActionButton.mount(viewCluster, {
      label: 'Gallery view',
      direction,
      onOpen: () => { if (typeof usesMobilePageLayout === 'function' && usesMobilePageLayout()
        && typeof activateTriggerSurface === 'function') activateTriggerSurface(viewCluster, () => UnfoldingActionButton.mount(viewCluster).close()); },
      onClose: () => { if (typeof clearTriggerAnchor === 'function') clearTriggerAnchor(viewCluster); },
      onSelect: view => transitionGalleryMain({ type: 'set-view', view }),
    }).select(mainState.view);
  }
}

function hydrateDeferredNonAlbumTracksForAlbumTypes() {
  const searching = Boolean(String(state.view?.query || '').trim());
  const artistSelected = Boolean(String(state.view.selected_artist || '').trim());
  const warn = error => console.warn('[AlbumHaven][Gallery] Failed to load non-album tracks.', error);
  if (artistSelected && !searching) {
    if (typeof hydrateArtistNonAlbumAvailability === 'function') {
      void hydrateArtistNonAlbumAvailability().catch(warn);
    }
    return;
  }
  if ((!state.view?.non_album_tracks_deferred && !searching) || typeof hydrateDeferredNonAlbumTracks !== 'function') return;
  void hydrateDeferredNonAlbumTracks({ libraryWide: searching || !artistSelected }).catch(warn);
  // A search probes library-wide loose tracks for its match indicator; the open menu's artist
  // button still needs that artist's own loose tracks to know whether it has any.
  const menuOpen = galleryMainSurfaceController?.current?.()?.key === 'album-types'
    || document.getElementById?.('gallery-album-types-menu')?.hidden === false;
  if (searching && artistSelected && menuOpen && state.view.non_album_tracks_deferred) {
    void hydrateDeferredNonAlbumTracks({ libraryWide: false }).catch(warn);
  }
}

function buildGalleryFamilyPanelBody() {
  const mainState = ensureGalleryMainState();
  const panelModel = getGalleryFamilyPanelModel();
  const albumCounts = new Map(panelModel.groups.map((group) => [
    String(group.artist_display || group.artist || '').trim(),
    Array.isArray(group.albums) ? group.albums.length : 0,
  ]));
  const primaryArtist = String(state.view.selected_artist || '').trim();
  const allPanelGroups = getGalleryFamilyPanelGroups();
  const primaryGroup = allPanelGroups.find((group) => galleryMainGroupArtist(group) === primaryArtist);
  const relatedGroups = allPanelGroups.filter((group) => galleryMainGroupArtist(group) !== primaryArtist);
  const relatedNames = relatedGroups.map((group) => galleryMainGroupArtist(group));
  const rememberedOrder = Array.isArray(mainState.familyArtistOrder) ? mainState.familyArtistOrder : [];
  const orderedNames = [
    ...rememberedOrder.filter((artist) => relatedNames.includes(artist)),
    ...relatedNames.filter((artist) => !rememberedOrder.includes(artist)),
  ];
  const groupsByArtist = new Map(relatedGroups.map((group) => [galleryMainGroupArtist(group), group]));
  const panelGroups = [...(primaryGroup ? [primaryGroup] : []), ...orderedNames.map((artist) => groupsByArtist.get(artist)).filter(Boolean)];
  return panelGroups.map((group, index) => {
    const artist = String(group.artist_display || group.artist || 'Artist');
    const count = albumCounts.get(artist) || 0;
    const active = mainState.familySelectionExplicit !== true || mainState.familyArtists.includes(artist);
    const primary = artist === primaryArtist;
    const albums = Array.isArray(group.albums) ? group.albums : [];
    const album = albums.find(albumHasDisplayCover) || albums[0];
    const artwork = album
      ? buildUtilityAlbumArtbox(album, { label: `${artist} album artwork`, deferPreview: true })
      : buildAlbumArtboxHtml({ state: 'empty', label: `${artist} album artwork` });
    const divider = primaryGroup && relatedGroups.length > 0 && index === 1
      ? '<div class="artist-family-panel__primary-divider gallery-divider__line" role="separator" aria-label="Related artists"></div>'
      : '';
    return `${divider}${buildFilterPillHtml({
      label: artist,
      count,
      selected: active,
      className: 'artist-family-panel__artist',
      modifierClassName: primary ? 'is-primary' : '',
      partClasses: {
        marker: 'artist-family-panel__marker',
        artwork: 'artist-family-panel__artwork',
        label: 'artist-family-panel__name',
        count: 'artist-family-panel__count',
      },
      artworkHtml: artwork,
      draggable: false,
      dataAttributes: { 'gallery-family-artist': artist },
    })}`;
  }).join('');
}

function renderGalleryFamilyPanelBody(panelBody, html) {
  const focused = document.activeElement;
  const focusedArtist = panelBody.contains(focused) ? focused?.dataset?.galleryFamilyArtist : null;
  const scrollTop = panelBody.scrollTop;
  panelBody.innerHTML = html;
  if (typeof virtualGrid !== 'undefined') virtualGrid.activateGalleryCoverImages(panelBody);
  panelBody.scrollTop = scrollTop;
  if (focusedArtist) {
    const replacement = Array.from(panelBody.querySelectorAll('[data-gallery-family-artist]'))
      .find(button => button.dataset.galleryFamilyArtist === focusedArtist);
    replacement?.focus({ preventScroll: true });
  }
}

function syncGalleryBarSearchVisibility() {
  const bar = document.querySelector?.('[data-gallery-bar-instance="gallery"]');
  if (!bar) return;
  bar.hidden = false;
}

function updateGalleryMainChrome() {
  // A new search replaces the artist an open info panel describes; the panel stays open within its own search.
  const activeSurface = galleryMainSurfaceController?.current?.();
  if (activeSurface?.surface?.matches?.('.artist-info-overlay')
      && (activeSurface.openingQuery ?? '') !== String(state.view.query || '').trim()) {
    closeGalleryMainSurface(false);
  }
  const bar = document.querySelector('[data-gallery-bar-instance="gallery"]');
  const scroll = document.getElementById('albums-scroll');
  if (!bar || !scroll) return;
  syncGalleryBarSearchVisibility();
  updateGalleryMainControls();
  const model = getFilteredGalleryMainModel();
  const primaryArtist = String(state.view.selected_artist || '').trim();
  const sections = getGalleryMainContextSections();
  const hasFamily = hasGalleryArtistFamily();
  cacheCurrentGallerySourceTotals();
  const summaryTotals = resolveGallerySummaryTotals(
    state.view,
    model.totals,
    state.gallery.mainState,
    model.groups,
    state.gallery.sourceTotalsByScope,
  );
  const context = resolveGalleryBarContext({
    scrollTop: scroll.scrollTop,
    primaryArtist,
    artistCount: summaryTotals.artistCount,
    albumCount: summaryTotals.albumCount,
    groups: sections,
    hasFamily,
    artist_musicbrainz: model.groups.find((group) => galleryMainGroupArtist(group) === primaryArtist)?.artist_musicbrainz || null,
  });
  const name = bar.querySelector('[data-gallery-context-name]');
  const summary = bar.querySelector('[data-gallery-context-summary]');
  const metadata = bar.querySelector('[data-gallery-context-metadata]');
  const oldInfo = bar.querySelector('[data-artist-info-trigger]');
  const inlineDivider = bar.querySelector('[data-gallery-context-artist-divider]');
  const inlineTotal = bar.querySelector('[data-gallery-context-inline-total]');
  const mobileHome = typeof shouldShowMobileHome === 'function' && shouldShowMobileHome();
  if (bar.dataset) bar.dataset.galleryContextKind = mobileHome ? 'home' : context.kind;
  summary.hidden = false;
  if (metadata) {
    metadata.hidden = true;
    metadata.innerHTML = '';
  }
  if (inlineDivider) inlineDivider.hidden = true;
  if (inlineTotal) {
    inlineTotal.hidden = true;
    inlineTotal.textContent = '';
  }
  if (mobileHome) {
    name.textContent = document.getElementById('mobile-home')?.dataset.accountName || 'My music';
    summary.textContent = '';
    oldInfo?.remove();
  } else if (context.kind === 'gallery' || context.kind === 'family') {
    name.textContent = context.kind === 'gallery' ? 'Gallery' : `${context.primaryArtist} family`;
    summary.textContent = context.artistCount == null || context.albumCount == null
      ? ''
      : `${galleryMainPlural(context.artistCount, 'artist')} · ${galleryMainPlural(context.albumCount, 'album')}`;
    oldInfo?.remove();
  } else {
    name.textContent = galleryArtistDisplayName(context.artist, context.artist_musicbrainz);
    summary.innerHTML = buildGalleryArtistSummaryHtml(context.albumCount, context.artist_musicbrainz);
    if (metadata) {
      metadata.hidden = false;
      metadata.innerHTML = buildGalleryArtistMetadataHtml(context.artist_musicbrainz);
    }
    if (!oldInfo) name.insertAdjacentHTML('afterend', `<button class="gallery-info-button" type="button" data-artist-info-trigger="1" data-artist="${escapeHtml(context.artist)}" aria-label="Information about ${escapeHtml(context.artist)}" aria-expanded="false">${buildGalleryInfoGlyphHtml()}</button>`);
    else {
      oldInfo.dataset.artist = context.artist;
      oldInfo.setAttribute('aria-label', `Information about ${context.artist}`);
    }
  }
  syncGalleryBarNameFit(bar, name);
  const panelBody = document.querySelector('[data-gallery-family-panel-body]');
  if (panelBody) {
    const panelSignature = JSON.stringify({
      filters: ensureGalleryMainState(),
      groups: getGalleryFamilyPanelGroups().map((group) => [group.artist_display || group.artist, group.albums?.length || 0]),
    });
    if (panelBody.dataset.galleryRenderSignature !== panelSignature) {
      renderGalleryFamilyPanelBody(panelBody, buildGalleryFamilyPanelBody());
      panelBody.dataset.galleryRenderSignature = panelSignature;
    }
  }
  const panelTitle = document.querySelector('[data-gallery-family-panel-title]');
  if (panelTitle) {
    const title = primaryArtist ? `${primaryArtist} Family` : 'Artist Family';
    if (panelTitle.textContent !== title) panelTitle.textContent = title;
    if (panelTitle.title !== title) panelTitle.title = title;
  }
  const panelTotal = document.querySelector('[data-gallery-family-panel-total]');
  if (panelTotal) {
    const total = galleryMainPlural(getGalleryFamilyPanelModel().totals.albumCount, 'album');
    if (panelTotal.textContent !== total) panelTotal.textContent = total;
  }
  const panel = document.querySelector('[data-artist-family-panel]');
  if (panel) {
    panel.style.top = `${Math.round(bar.getBoundingClientRect().bottom)}px`;
    const active = galleryMainSurfaceController?.current?.();
    if (active?.surface === panel) positionArtistFamilyPanelEnvelope(panel, active.anchor);
  }
}

function transitionGalleryMain(action, options = {}) {
  cacheCurrentGallerySourceTotals();
  const previousView = ensureGalleryMainState().view;
  const nextState = applyGalleryClientTransition({ state: state.gallery.mainState, action, location: window.location, history: window.history });
  // Loose-track payloads have no per-track source provenance. Refresh their
  // authoritative scope on both hide and show; scope mismatch blocks stale edits.
  const hydrationCategories = action.type === 'toggle-source'
    ? activeGallerySourceCategories(nextState) : null;
  if (hydrationCategories) {
    state.gallery.pendingSourceHydrationCategories = hydrationCategories;
  }
  const sourceTotalsCurrent = state.gallery.sourceTotalsRevision === Number(
    state.status?.inventory_mutation_revision ?? state.view?.inventory_mutation_revision ?? 0,
  );
  if (action.type === 'toggle-source' && options.sourceTotalsResolved !== true
    && (!sourceTotalsCurrent
      || !state.gallery.sourceTotalsByScope?.[gallerySourceScopeKey(hydrationCategories)])) {
    return Promise.resolve(prefetchGallerySourceTotalsForAllScopes())
      .then((resolved) => {
        if (resolved) return transitionGalleryMain(action, { sourceTotalsResolved: true });
        if (gallerySourceScopesEqual(
          state.gallery.pendingSourceHydrationCategories,
          hydrationCategories,
        )) state.gallery.pendingSourceHydrationCategories = null;
        return false;
      });
  }
  state.gallery.mainState = nextState;
  if (hydrationCategories && gallerySourceScopesEqual(
    state.gallery.pendingSourceHydrationCategories,
    hydrationCategories,
  )) state.gallery.pendingSourceHydrationCategories = null;
  if (action.type === 'toggle-source') prefetchGallerySourceTotalsForAllScopes();
  if (action.type === 'set-view') {
    state.view.gallery_display_mode = nextState.view;
    persistCurrentGalleryDisplayPreferences(state.view);
  }
  if (action.type === 'toggle-source') window.AlbumHavenDevicePreferences?.write('gallerySources', nextState.sources);
  if (previousView !== state.gallery.mainState.view && virtualGrid) virtualGrid.lastKey = '';
  renderArtistGroups({ preserveScroll: true, preserveAbsoluteScroll: previousView === nextState.view });
  if (typeof syncMobileHome === 'function') syncMobileHome();
  if (typeof syncMobileGalleryControls === 'function') syncMobileGalleryControls();
  if (hydrationCategories?.length && typeof buildApiUrl === 'function' && typeof fetchAndRender === 'function') {
    const hydrationUrl = buildApiUrl(buildGallerySourceHydrationView({
      currentView: state.view,
      hydrationCategories,
    }), { omitSidebar: false });
    void fetchAndRender(hydrationUrl, false, {
      preserveScroll: true,
      preserveAbsoluteScroll: true,
      preserveGalleryOptionsMenu: true,
      preserveSidebarState: false,
      fallbackToAllArtistsWhenSelectionMissing: true,
      preserveGalleryBrowseLocationState: true,
      // Loaded albums may not cover the new sources; load instead of flashing an empty Library.
      showViewTransition: getFilteredGalleryMainModel().totals.albumCount === 0,
      transitionDetail: 'Loading the selected sources...',
    });
  }
}

// Only an accepted MusicBrainz match carries a projection, so unresolved artists show no links.
const GALLERY_ARTIST_FULL_PAGE_LABEL = 'Open full page';

function buildGalleryArtistExternalLinksHtml(artistMusicBrainz, artist) {
  if (!artistMusicBrainz || typeof artistMusicBrainz !== 'object') return '';
  const links = ['musicbrainz', 'discogs'].map((service) => ButtonComponent.renderExternalServiceLink({
    service,
    href: service === 'musicbrainz' ? artistMusicBrainz.musicbrainz_url : artistMusicBrainz.discogs_url,
    subject: artist,
  })).join('');
  return links ? `<div class="ui-external-link-list">${links}</div>` : '';
}

// A local name whose albums belong to several MusicBrainz artists (Amarok) lists each
// with its albums and its own MusicBrainz link.
function buildGalleryArtistIdentitiesHtml(artistMusicBrainz) {
  const identities = Array.isArray(artistMusicBrainz?.identities) ? artistMusicBrainz.identities : [];
  if (!identities.length) return '';
  const items = identities.map((identity) => {
    const name = [identity.canonical_name, identity.disambiguation ? `(${identity.disambiguation})` : '']
      .filter(Boolean).join(' ');
    const link = ButtonComponent.renderExternalServiceLink({
      service: 'musicbrainz', href: identity.musicbrainz_url, subject: name,
    });
    return `<li class="artist-info-overlay__identity"><span>${escapeHtml(name)} · ${escapeHtml(galleryMainPlural(identity.album_count, 'album'))}</span>${link}</li>`;
  }).join('');
  return `<div class="artist-info-overlay__identities" data-artist-info-identities><p class="artist-info-overlay__source">Your albums belong to ${escapeHtml(galleryMainPlural(identities.length, 'MusicBrainz artist'))}:</p><ul>${items}</ul></div>`;
}

function openGalleryArtistInfo(anchor) {
  // Owner (11-08): the header shows the "i" during a search, so it opens there too.
  if (!anchor) return;
  const artist = String(anchor.dataset.artist || '').trim();
  const group = getGalleryMainGroups().find((candidate) => String(candidate.artist_display || candidate.artist || '') === artist) || {};
  const overlay = document.querySelector('[data-artist-info-overlay]');
  if (!overlay) return;
  const { summary, imageUrl, wikipediaUrl, isLongBiography } = resolveGalleryArtistInfo(group, artist);
  overlay.setAttribute('aria-label', `Information about ${artist}`);
  // The text always ends with the full-page control; it stays disabled until artist pages exist.
  const fullPage = `<button type="button" class="artist-info-overlay__full-page" aria-disabled="true" disabled title="Artist pages are not available yet">${GALLERY_ARTIST_FULL_PAGE_LABEL}</button>`;
  const links = buildGalleryArtistExternalLinksHtml(group.artist_musicbrainz, artist);
  // Matched under another name ("3 Crows" on Chris Buck): the MusicBrainz name is the
  // title, and the tag is named beside the links (display only).
  const displayName = galleryArtistDisplayName(artist, group.artist_musicbrainz);
  const credit = displayName !== artist
    ? `<p class="artist-info-overlay__source" data-artist-info-credit>Tagged as ${escapeHtml(artist)} in your files.</p>`
    : '';
  const identities = buildGalleryArtistIdentitiesHtml(group.artist_musicbrainz);
  const closeAction = ButtonComponent.renderActionButton({ icon: 'close', ariaLabel: 'Close artist information', presentation: 'bare', className: 'mobile-artist-info-close', attributes: { 'data-close-mobile-artist-info': '' } });
  overlay.innerHTML = `${closeAction}<header>${imageUrl ? `<img class="artist-info-overlay__image" src="${escapeHtml(imageUrl)}" alt="" width="176" height="176" decoding="async" fetchpriority="high">` : '<div class="artist-info-overlay__image artist-info-overlay__image--empty" aria-hidden="true">♪</div>'}<div><span>Artist</span><h2>${escapeHtml(displayName)}</h2></div></header><div class="artist-info-overlay__body gallery-scrollbar"><p data-artist-info-summary${isLongBiography ? ' data-artist-info-long' : ''}>${escapeHtml(summary)} ${fullPage}</p>${links ? `<div class="artist-info-overlay__links">${links}</div>` : ''}${identities}${credit}${artist === 'Neal Morse' ? '<p class="artist-info-overlay__source">Biography adapted from Wikipedia.</p>' : ''}</div>`;
  openGalleryMainSurface(`artist:${artist}`, anchor, overlay, 'left');
  // A long biography that still fits in five lines needs no clamp or fade.
  const summaryElement = overlay.querySelector('[data-artist-info-long]');
  if (summaryElement && summaryElement.scrollHeight <= summaryElement.clientHeight + 1) summaryElement.removeAttribute('data-artist-info-long');
}

// A click or drag release on the track picks the nearest position; elsewhere on the row it steps right, wrapping.
// Owner (11-08): every click, on the knob, the track or the label, moves to the next position in the cycle
// Show -> Separate -> Hide -> Show, so three clicks visit every position once.
function resolveSplitAlbumsSwitchMode() {
  const current = Math.max(0, GALLERY_SPLIT_ALBUM_MODES.indexOf(ensureGalleryMainState().splitAlbums));
  return GALLERY_SPLIT_ALBUM_MODES[(current + GALLERY_SPLIT_ALBUM_MODES.length - 1) % GALLERY_SPLIT_ALBUM_MODES.length];
}

function handleSplitAlbumsSwitchKeydown(event) {
  if (!event.target?.closest?.('[data-gallery-split-albums]')) return false;
  const current = GALLERY_SPLIT_ALBUM_MODES.indexOf(ensureGalleryMainState().splitAlbums);
  const next = { ArrowLeft: current - 1, ArrowDown: current - 1, ArrowRight: current + 1, ArrowUp: current + 1, Home: 0, End: 2 }[event.key];
  if (next === undefined) return false;
  event.preventDefault();
  const mode = GALLERY_SPLIT_ALBUM_MODES[Math.min(2, Math.max(0, next))];
  if (mode !== GALLERY_SPLIT_ALBUM_MODES[current]) transitionGalleryMain({ type: 'set-split-albums', mode });
  return true;
}

function handleGalleryMainClick(event) {
  if (event.target.closest?.('[data-close-mobile-artist-info]')) { event.preventDefault(); closeGalleryMainSurface(true); return true; }
  const source = event.target.closest?.('[data-gallery-source]');
  if (source) { event.preventDefault(); transitionGalleryMain({ type: 'toggle-source', source: source.dataset.gallerySource }); return true; }
  const featuredOn = event.target.closest?.('[data-gallery-featured-on]');
  if (featuredOn) { event.preventDefault(); transitionGalleryMain({ type: 'toggle-featured-on' }); return true; }
  const splitAlbums = event.target.closest?.('[data-gallery-split-albums]');
  if (splitAlbums) {
    event.preventDefault();
    transitionGalleryMain({ type: 'set-split-albums', mode: resolveSplitAlbumsSwitchMode() });
    return true;
  }
  const type = event.target.closest?.('[data-gallery-album-type]');
  if (type) { event.preventDefault(); return true; }
  const familyArtist = event.target.closest?.('[data-gallery-family-artist]');
  if (familyArtist) {
    event.preventDefault();
    transitionGalleryMain({
      type: 'toggle-family-artist',
      artist: familyArtist.dataset.galleryFamilyArtist,
      availableArtists: getGalleryFamilyPanelGroups().map((group) => galleryMainGroupArtist(group)).filter(Boolean),
    });
    return true;
  }
  const info = event.target.closest?.('[data-artist-info-trigger]');
  if (info) { event.preventDefault(); openGalleryArtistInfo(info); return true; }
  const sourcesAnchor = event.target.closest?.('[data-gallery-sources-anchor]');
  if (sourcesAnchor) { event.preventDefault(); openGalleryMainSurface('sources', sourcesAnchor, document.getElementById('gallery-sources-menu')); return true; }
  const familyAnchor = event.target.closest?.('[data-gallery-bar-action="artist-family"]');
  if (familyAnchor) { event.preventDefault(); openGalleryMainSurface('artist-family', familyAnchor, document.getElementById('artist-family-panel')); return true; }
  const typeAnchor = event.target.closest?.('[data-gallery-bar-action="album-types"]');
  if (typeAnchor) {
    event.preventDefault();
    openGalleryMainSurface('album-types', typeAnchor, document.getElementById('gallery-album-types-menu'));
    hydrateDeferredNonAlbumTracksForAlbumTypes();
    return true;
  }
  const navigationMode = event.target.closest?.('[data-navigation-mode]');
  if (navigationMode) {
    event.preventDefault();
    const pageOpen = document.getElementById('non-album-modal')?.hidden === false;
    if (navigationMode.dataset.navigationMode === 'collections') {
      if (!pageOpen || !state.ui.nonAlbumLibraryWide) openNonAlbumModal({ libraryWide: true });
      if (typeof closeArtistsDrawer === 'function' && typeof usesMobilePageLayout === 'function' && usesMobilePageLayout()) closeArtistsDrawer();
    } else if (pageOpen) {
      closeNonAlbumModal();
    }
    return true;
  }
  const nonAlbum = event.target.closest?.('[data-open-non-album-tracks]');
  if (nonAlbum) {
    event.preventDefault();
    if (!nonAlbum.disabled && nonAlbum.getAttribute('aria-disabled') !== 'true') {
      openNonAlbumModal({
        libraryWide: nonAlbum.dataset.libraryWide === '1' || !String(state.view?.selected_artist || '').trim(),
      });
    }
    return true;
  }
  if (event.target.closest?.('[data-gallery-customize-preview]')) { event.preventDefault(); return true; }
  const active = galleryMainSurfaceController?.current?.();
  if (active && !active.surface.contains(event.target) && !active.anchor.contains(event.target)) closeGalleryMainSurface(true);
  return false;
}

function initGalleryMain() {
  if (typeof installPanelSelectionBoundary === 'function') installPanelSelectionBoundary();
  ensureGalleryMainState();
  prefetchGallerySourceTotalsForAllScopes();
  galleryMainSurfaceController = createAnchoredSurfaceController();
  const panel = document.querySelector('[data-artist-family-panel]');
  const player = document.querySelector('[data-shell-slot="bottom_player"]');
  galleryFamilyPanelObserver?.disconnect?.();
  galleryFamilyPanelObserver = observeArtistFamilyPanelBounds({ panel, player });
  const scroll = document.getElementById('albums-scroll');
  scroll?.addEventListener('scroll', () => {
    const active = galleryMainSurfaceController?.current?.();
    if (active?.key?.startsWith?.('artist:') && active.surface.getAttribute?.('aria-modal') !== 'true') {
      active.anchor = resolveCurrentGalleryAnchor(active.anchor);
      positionGalleryAnchoredSurface(active.surface, active.anchor, 'left');
    }
    if (galleryMainScrollFrame) return;
    galleryMainScrollFrame = requestAnimationFrame(() => {
      galleryMainScrollFrame = 0;
      updateGalleryMainChrome();
      const settled = galleryMainSurfaceController?.current?.();
      if (settled?.key?.startsWith?.('artist:') && settled.surface.getAttribute?.('aria-modal') !== 'true') {
        settled.anchor = resolveCurrentGalleryAnchor(settled.anchor);
        positionGalleryAnchoredSurface(settled.surface, settled.anchor, 'left');
      }
    });
  }, { passive: true });
  window.addEventListener('resize', () => {
    updateGalleryMainChrome();
    const active = galleryMainSurfaceController?.current?.();
    if (active?.surface?.matches?.('.gallery-anchored-menu, .artist-info-overlay')) positionGalleryAnchoredSurface(active.surface, active.anchor, active.key.startsWith('artist:') ? 'left' : 'right');
    if (active?.surface?.matches?.('.artist-family-panel')) positionArtistFamilyPanelEnvelope(active.surface, active.anchor);
    if (active?.key === 'search-suggestions') positionSearchSuggestionsSurface(active.surface);
  });
  if (!galleryFamilyDragHandlersBound) {
    galleryFamilyDragHandlersBound = true;
    const prefetchedPortraits = new Set();
    const prefetchPortrait = event => {
      const anchor = event.target.closest?.('[data-artist-info-trigger]');
      if (!anchor) return;
      const artist = anchor.dataset.artist;
      const group = getGalleryMainGroups().find(candidate => String(candidate.artist_display || candidate.artist || '') === artist) || {};
      const { imageUrl } = resolveGalleryArtistInfo(group, artist);
      if (!imageUrl || prefetchedPortraits.has(imageUrl)) return;
      prefetchedPortraits.add(imageUrl);
      const image = new Image();
      image.decoding = 'async';
      image.src = imageUrl;
    };
    document.addEventListener('pointerover', prefetchPortrait);
    document.addEventListener('focusin', prefetchPortrait);

    const paint = createGalleryFamilyPaintController((artist) => {
      transitionGalleryMain({
        type: 'toggle-family-artist', artist,
        availableArtists: getGalleryFamilyPanelGroups().map(galleryMainGroupArtist).filter(Boolean),
      });
    });
    let pointerId = null;
    let suppressClick = false;
    const pillAt = event => document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-gallery-family-artist]');
    const visit = pill => {
      if (pill) paint.visit(pill.dataset.galleryFamilyArtist, pill.getAttribute('aria-pressed') === 'true');
    };
    document.addEventListener('pointerdown', event => {
      suppressClick = false;
      if (event.button !== 0 || event.pointerType !== 'mouse') return;
      const pill = event.target.closest?.('[data-gallery-family-artist]');
      if (!pill) return;
      event.preventDefault();
      pointerId = event.pointerId;
      suppressClick = true;
      pill.focus({ preventScroll: true });
      paint.begin(pill.dataset.galleryFamilyArtist, pill.getAttribute('aria-pressed') === 'true');
    });
    document.addEventListener('pointermove', event => {
      if (pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) { pointerId = null; paint.end(); return; }
      visit(pillAt(event));
    });
    const finish = event => {
      if (pointerId !== event.pointerId) return;
      if (event.type === 'pointerup') visit(pillAt(event));
      pointerId = null;
      paint.end();
    };
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    window.addEventListener('blur', () => { pointerId = null; paint.end(); });
    document.addEventListener('click', event => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }
  document.addEventListener('keydown', (event) => {
    if (handleSplitAlbumsSwitchKeydown(event)) return;
    if (event.key === 'Escape' && galleryMainSurfaceController?.current?.()) {
      event.preventDefault();
      closeGalleryMainSurface(true);
    }
  });
  const recentSearch = document.getElementById('recent-search-popover');
  if (recentSearch) recentSearch.dataset.anchoredSurface = 'search-suggestions';
  updateGalleryMainChrome();
}

function createGalleryFamilyPaintController(toggle) {
  let selected = null;
  const visited = new Set();
  function visit(artist, currentSelected) {
    if (selected === null || !artist || visited.has(artist)) return;
    visited.add(artist);
    if (currentSelected !== selected) toggle(artist);
  }
  return {
    begin(artist, currentSelected) {
      visited.clear(); selected = !currentSelected; visit(artist, currentSelected);
    },
    visit,
    end() { selected = null; visited.clear(); },
  };
}

// Non-artist mobile contexts may wrap long names. Artist headers stay two lines and ellipsize instead.
// Measure only when the name, context, info button, or window width changes, never on every scroll frame.
function syncGalleryBarNameFit(bar, name) {
  if (!bar?.classList || !name) return;
  const contextKind = String(bar.dataset.galleryContextKind || '');
  const key = `${name.textContent}|${window.innerWidth}|${bar.querySelector?.('[data-artist-info-trigger]') ? 1 : 0}|${contextKind}`;
  if (bar.dataset.galleryNameFitKey === key) return;
  bar.dataset.galleryNameFitKey = key;
  bar.classList.remove('is-name-wrapping');
  if (Number(window.innerWidth) > 900 || contextKind === 'artist' || contextKind === 'single-artist') return;
  if (name.scrollWidth > name.clientWidth + 1) bar.classList.add('is-name-wrapping');
}
