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

function shouldDismissArtistInfoOverlay(config = {}) {
  if (config.reason === 'scroll') return !config.scrollInsideOverlay;
  return ['outside-pointer', 'escape', 'repeat-anchor'].includes(config.reason);
}

function observeArtistFamilyPanelBounds({ panel, player } = {}) {
  if (!panel || !player || typeof ResizeObserver !== 'function') return { disconnect() {} };
  const initialHeight = Number(player.getBoundingClientRect?.().height || 0);
  if (initialHeight > 0) panel.style.bottom = `${initialHeight}px`;
  const observer = new ResizeObserver((entries) => {
    const entry = entries.find((item) => item.target === player) || entries[0];
    panel.style.bottom = `${Math.max(0, Number(entry?.contentRect?.height || 0))}px`;
  });
  observer.observe(player);
  return observer;
}

function positionGalleryAnchoredSurface(surface, anchor, align = 'right') {
  if (!surface || !anchor?.getBoundingClientRect) return;
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

function positionArtistFamilyPanelEnvelope(panel, anchor) {
  if (!panel || !anchor?.getBoundingClientRect) return;
  const rect = anchor.getBoundingClientRect();
  const bar = anchor.closest?.('.gallery-bar');
  const panelTop = bar?.getBoundingClientRect?.().bottom;
  if (Number.isFinite(panelTop)) panel.style.top = `${Math.round(panelTop)}px`;
  const top = Number.isFinite(panelTop) ? panelTop : panel.getBoundingClientRect?.().top;
  panel.style.setProperty?.('--gallery-anchor-gap', `${Math.max(0, Math.round((top || rect.bottom) - rect.bottom))}px`);
  panel.dataset.anchorEnvelope = 'right';
  panel.style.setProperty?.('--gallery-anchor-width', `${Math.round(rect.width)}px`);
  panel.style.setProperty?.('--gallery-anchor-height', `${Math.round(rect.height)}px`);
  panel.style.setProperty?.('--gallery-anchor-right', `${Math.max(0, Math.round(window.innerWidth - rect.right))}px`);
  if (typeof syncTriggerAnchor === 'function') syncTriggerAnchor(panel, anchor);
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
  const groupsByArtist = new Map();
  candidates.forEach((group) => {
    const artist = galleryMainGroupArtist(group);
    if (!artist) return;
    const existing = groupsByArtist.get(artist);
    if (!existing || (group.albums?.length || 0) > (existing.albums?.length || 0)) {
      groupsByArtist.set(artist, group);
    }
  });
  const fallbackArtists = getGalleryMainGroups().map((group) => galleryMainGroupArtist(group)).filter(Boolean);
  const familyArtists = relatedArtists.length ? relatedArtists : fallbackArtists;
  const names = [primaryArtist, ...familyArtists.filter((artist) => artist !== primaryArtist)];
  return names.map((artist) => groupsByArtist.get(artist) || { artist, artist_display: artist, albums: [] });
}

function getGalleryMainContextSections() {
  const sections = typeof virtualGrid !== 'undefined' && Array.isArray(virtualGrid?.sections)
    ? virtualGrid.sections
    : [];
  return sections.filter((section) => section?.kind === 'artist' || section?.group).map((section) => ({
    artist: galleryMainGroupArtist(section.group),
    albumCount: Array.isArray(section.group?.albums) ? section.group.albums.length : 0,
    top: Number(section.top || 0),
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

function syncGalleryMainStateFromView(previousView = {}, nextView = {}) {
  const mainState = ensureGalleryMainState();
  const selectionChanged = String(previousView.selected_artist || '') !== String(nextView.selected_artist || '');
  if (selectionChanged) {
    syncGalleryFamilySelection(mainState, nextView);
  }
  state.gallery.mainState = mainState;
}

function syncGalleryMainStateFromLocation() {
  const url = new URL(window.location.href);
  const categories = url.searchParams.getAll('category');
  const visible = new Set(categories.length ? categories : ['main_library', 'new_arrivals', 'hoard']);
  const mainState = ensureGalleryMainState();
  mainState.sources = { main_library: visible.has('main_library'), new_arrivals: visible.has('new_arrivals'), hoard: visible.has('hoard') };
  mainState.view = normalizeGalleryView(url.searchParams.get('gallery_display') || 'cards');
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

function closeGalleryMainSurface(returnFocus = true) {
  const active = galleryMainSurfaceController?.current?.();
  if (!active) return false;
  const slidingPanel = active.surface.matches?.('.artist-family-panel') === true;
  active.surface.classList?.remove?.('is-open');
  active.surface.setAttribute?.('aria-hidden', 'true');
  active.anchor?.setAttribute?.('aria-expanded', 'false');
  if (typeof clearTriggerAnchor === 'function') clearTriggerAnchor(active.surface);
  const closed = galleryMainSurfaceController.close(returnFocus);
  if (!slidingPanel || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    active.surface.hidden = true;
  } else {
    const finish = () => {
      if (!active.surface.classList?.contains?.('is-open')) active.surface.hidden = true;
    };
    active.surface.addEventListener?.('transitionend', finish, { once: true });
    window.setTimeout?.(finish, 260);
  }
  return closed;
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
  if (previous) closeGalleryMainSurface(false);
  if (typeof activateTriggerSurface === 'function') activateTriggerSurface(surface, () => {
    if (galleryMainSurfaceController.current()?.surface === surface) closeGalleryMainSurface(false);
  });
  galleryMainSurfaceController.activate({ key, anchor, surface });
  anchor.setAttribute('aria-expanded', 'true');
  surface.hidden = false;
  if (surface.matches?.('.artist-family-panel')) {
    surface.classList?.remove?.('is-open');
    void surface.offsetWidth;
  }
  surface.classList?.add?.('is-open');
  surface.setAttribute?.('aria-hidden', 'false');
  if (surface.matches?.('.gallery-anchored-menu, .artist-info-overlay')) positionGalleryAnchoredSurface(surface, anchor, align);
  if (surface.matches?.('.artist-family-panel')) positionArtistFamilyPanelEnvelope(surface, anchor);
  if (shouldFocusGalleryMainSurface(key)) focusGalleryMainSurface(surface);
  return true;
}

function updateGalleryMainControls() {
  const mainState = ensureGalleryMainState();
  document.querySelectorAll('[data-gallery-source]').forEach((button) => {
    button.setAttribute('aria-checked', mainState.sources[button.dataset.gallerySource] === false ? 'false' : 'true');
  });
  document.querySelectorAll('[data-gallery-album-type]').forEach((button) => {
    button.setAttribute('aria-pressed', mainState.albumTypes.includes(button.dataset.galleryAlbumType) ? 'true' : 'false');
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
    button.setAttribute('aria-checked', checked ? 'true' : 'false');
    button.disabled = !preferenceArtist;
  });
  document.querySelectorAll('[data-open-non-album-tracks]').forEach((button) => {
    const enabled = hasGalleryNonAlbumTracks(state.view);
    button.disabled = !enabled;
    button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  });
  const viewCluster = document.querySelector('[data-gallery-view-cluster]');
  if (viewCluster) {
    viewCluster.querySelectorAll('[data-gallery-view-choice]').forEach(button => {
      button.dataset.actionValue = button.dataset.galleryViewChoice;
      button.removeAttribute('data-gallery-bar-action');
      button.removeAttribute('data-gallery-bar-action');
    });
    UnfoldingActionButton.mount(viewCluster, {
      label: 'Gallery view',
      onSelect: view => transitionGalleryMain({ type: 'set-view', view }),
    }).select(mainState.view);
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
    const divider = index === 1 ? '<div class="artist-family-panel__primary-divider" aria-hidden="true"></div>' : '';
    return `${divider}<button class="artist-family-panel__artist${active ? ' is-active' : ''}${primary ? ' is-primary' : ''}" type="button" data-gallery-family-artist="${escapeHtml(artist)}" draggable="false" aria-pressed="${active ? 'true' : 'false'}"><span>${escapeHtml(artist)}</span><span>${count}</span></button>`;
  }).join('');
}

function renderGalleryFamilyPanelBody(panelBody, html) {
  const focused = document.activeElement;
  const focusedArtist = panelBody.contains(focused) ? focused?.dataset?.galleryFamilyArtist : null;
  const scrollTop = panelBody.scrollTop;
  panelBody.innerHTML = html;
  panelBody.scrollTop = scrollTop;
  if (focusedArtist) {
    const replacement = Array.from(panelBody.querySelectorAll('[data-gallery-family-artist]'))
      .find(button => button.dataset.galleryFamilyArtist === focusedArtist);
    replacement?.focus({ preventScroll: true });
  }
}

function updateGalleryMainChrome() {
  const bar = document.querySelector('[data-gallery-bar]');
  const scroll = document.getElementById('albums-scroll');
  if (!bar || !scroll) return;
  updateGalleryMainControls();
  const model = getFilteredGalleryMainModel();
  const primaryArtist = String(state.view.selected_artist || '').trim();
  const sections = getGalleryMainContextSections();
  const context = resolveGalleryBarContext({
    scrollTop: scroll.scrollTop,
    galleryBarBottom: bar.offsetHeight + 12,
    primaryArtist,
    artistCount: model.totals.artistCount,
    albumCount: model.totals.albumCount,
    groups: sections,
  });
  const name = bar.querySelector('[data-gallery-context-name]');
  const summary = bar.querySelector('[data-gallery-context-summary]');
  const oldInfo = bar.querySelector('[data-artist-info-trigger]');
  if (context.kind === 'gallery' || context.kind === 'family') {
    name.textContent = context.kind === 'gallery' ? 'Gallery' : `${context.primaryArtist} family`;
    summary.textContent = `${galleryMainPlural(context.artistCount, 'artist')} · ${galleryMainPlural(context.albumCount, 'album')}`;
    oldInfo?.remove();
  } else {
    name.textContent = context.artist;
    summary.textContent = galleryMainPlural(context.albumCount, 'album');
    if (!oldInfo) name.insertAdjacentHTML('afterend', `<button class="gallery-info-button" type="button" data-artist-info-trigger="1" data-artist="${escapeHtml(context.artist)}" aria-label="Information about ${escapeHtml(context.artist)}" aria-expanded="false">${buildGalleryInfoGlyphHtml()}</button>`);
    else {
      oldInfo.dataset.artist = context.artist;
      oldInfo.setAttribute('aria-label', `Information about ${context.artist}`);
    }
  }
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
  const panelTotal = document.querySelector('[data-gallery-family-panel-total]');
  if (panelTotal) panelTotal.textContent = galleryMainPlural(getGalleryFamilyPanelModel().totals.albumCount, 'album');
  const panel = document.querySelector('[data-artist-family-panel]');
  if (panel) {
    panel.style.top = `${Math.round(bar.getBoundingClientRect().bottom)}px`;
    const active = galleryMainSurfaceController?.current?.();
    if (active?.surface === panel) positionArtistFamilyPanelEnvelope(panel, active.anchor);
  }
}

function transitionGalleryMain(action) {
  const previousView = ensureGalleryMainState().view;
  const nextState = applyGalleryClientTransition({ state: state.gallery.mainState, action, location: window.location, history: window.history });
  const hydrationCategories = resolveGallerySourceHydrationRequest({
    currentCategories: state.view.loaded_library_categories ?? state.view.visible_library_categories,
    nextState,
    action,
  });
  state.gallery.mainState = nextState;
  if (previousView !== state.gallery.mainState.view && virtualGrid) virtualGrid.lastKey = '';
  renderArtistGroups({ preserveScroll: true, preserveAbsoluteScroll: true });
  if (hydrationCategories && typeof buildApiUrl === 'function' && typeof fetchAndRender === 'function') {
    const hydrationUrl = buildApiUrl(buildGallerySourceHydrationView({
      currentView: state.view,
      hydrationCategories,
    }), { omitSidebar: true });
    void fetchAndRender(hydrationUrl, false, {
      preserveScroll: true,
      preserveAbsoluteScroll: true,
      preserveGalleryOptionsMenu: true,
      preserveSidebarState: true,
      preserveGalleryBrowseLocationState: true,
      skipPendingViewTransition: true,
    });
  }
}

function openGalleryArtistInfo(anchor) {
  const artist = String(anchor.dataset.artist || '').trim();
  const group = getGalleryMainGroups().find((candidate) => String(candidate.artist_display || candidate.artist || '') === artist) || {};
  const overlay = document.querySelector('[data-artist-info-overlay]');
  if (!overlay) return;
  const { summary, imageUrl, wikipediaUrl, canReadMore } = resolveGalleryArtistInfo(group, artist);
  overlay.classList.remove('is-expanded');
  overlay.setAttribute('aria-label', `Information about ${artist}`);
  overlay.innerHTML = `<header>${imageUrl ? `<img class="artist-info-overlay__image" src="${escapeHtml(imageUrl)}" alt="" width="176" height="176" decoding="async" fetchpriority="high">` : '<div class="artist-info-overlay__image artist-info-overlay__image--empty" aria-hidden="true">♪</div>'}<div><span>Artist</span><h2>${escapeHtml(artist)}</h2></div></header><div class="artist-info-overlay__body gallery-scrollbar"><p data-artist-info-summary>${escapeHtml(summary)}</p><div class="artist-info-overlay__links">${canReadMore ? '<button type="button" data-artist-info-read-more aria-expanded="false">Read more</button>' : ''}<button type="button" data-artist-info-full-page aria-disabled="true" disabled title="Artist pages are not available yet">Full page</button></div>${artist === 'Neal Morse' ? '<p class="artist-info-overlay__source">Biography adapted from Wikipedia.</p>' : ''}</div>`;
  openGalleryMainSurface(`artist:${artist}`, anchor, overlay, 'left');
}

function handleGalleryMainClick(event) {
  const readMore = event.target.closest?.('[data-artist-info-read-more]');
  if (readMore) {
    event.preventDefault();
    const expanded = readMore.getAttribute('aria-expanded') === 'true';
    readMore.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    readMore.textContent = expanded ? 'Read more' : 'Read less';
    const panel = readMore.closest('.artist-info-overlay');
    panel?.classList.toggle('is-expanded', !expanded);
    const active = galleryMainSurfaceController?.current?.();
    if (active?.surface === panel) positionGalleryAnchoredSurface(panel, active.anchor, 'left');
    readMore.closest('.artist-info-overlay')?.querySelector('[data-artist-info-summary]')?.classList.toggle('is-expanded', !expanded);
    return true;
  }
  const source = event.target.closest?.('[data-gallery-source]');
  if (source) { event.preventDefault(); transitionGalleryMain({ type: 'toggle-source', source: source.dataset.gallerySource }); return true; }
  const type = event.target.closest?.('[data-gallery-album-type]');
  if (type) { event.preventDefault(); transitionGalleryMain({ type: 'toggle-album-type', albumType: type.dataset.galleryAlbumType }); return true; }
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
  if (typeAnchor) { event.preventDefault(); openGalleryMainSurface('album-types', typeAnchor, document.getElementById('gallery-album-types-menu')); return true; }
  const nonAlbum = event.target.closest?.('[data-open-non-album-tracks]');
  if (nonAlbum) {
    event.preventDefault();
    if (!nonAlbum.disabled && nonAlbum.getAttribute('aria-disabled') !== 'true') openNonAlbumModal();
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
  galleryMainSurfaceController = createAnchoredSurfaceController();
  const panel = document.querySelector('[data-artist-family-panel]');
  const player = document.querySelector('[data-shell-slot="bottom_player"]');
  galleryFamilyPanelObserver?.disconnect?.();
  galleryFamilyPanelObserver = observeArtistFamilyPanelBounds({ panel, player });
  const scroll = document.getElementById('albums-scroll');
  scroll?.addEventListener('scroll', () => {
    const active = galleryMainSurfaceController?.current?.();
    if (active?.key?.startsWith?.('artist:')) closeGalleryMainSurface(false);
    if (galleryMainScrollFrame) return;
    galleryMainScrollFrame = requestAnimationFrame(() => { galleryMainScrollFrame = 0; updateGalleryMainChrome(); });
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
