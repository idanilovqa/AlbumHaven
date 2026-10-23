function resolveSidebarArtists(view = {}, sidebarArtistsOverride = null) {
  const override = Array.isArray(sidebarArtistsOverride) ? sidebarArtistsOverride : null;
  if (override && override.length) {
    return override;
  }
  if (Array.isArray(view.artists_sidebar) && view.artists_sidebar.length) {
    return view.artists_sidebar;
  }
  const groupedArtists = Array.isArray(view.artist_groups) && view.artist_groups.length
    ? view.artist_groups
    : (Array.isArray(view.primary_artist_groups) ? view.primary_artist_groups : []);
  return groupedArtists.map((group) => ({
    artist: group.artist,
    artist_display: group.artist_display || group.artist,
    count: group.albums.length,
  }));
}

function resolveSidebarSelectedArtist(view = {}, options = {}) {
  const hasSelectedArtistOverride = Object.prototype.hasOwnProperty.call(options, 'selectedArtistOverride');
  const selectedArtistOverride = hasSelectedArtistOverride
    ? String(options.selectedArtistOverride || '').trim()
    : '';
  if (hasSelectedArtistOverride) {
    return selectedArtistOverride;
  }
  const selectedArtist = String(view.selected_artist || '').trim();
  if (selectedArtist) {
    return selectedArtist;
  }
  const query = String(view.query || '').trim();
  if (!query) {
    return '';
  }
  const primaryGroups = Array.isArray(view.primary_artist_groups) ? view.primary_artist_groups : [];
  if (primaryGroups.length === 1) {
    return String(primaryGroups[0]?.artist || primaryGroups[0]?.artist_display || '').trim();
  }
  return '';
}

function resolveSidebarSurface(view = {}) {
  if (typeof resolveViewSurface === 'function') {
    return resolveViewSurface(view);
  }
  const normalizedSurface = String(view?.surface?.active ?? '').trim().toLowerCase();
  if (normalizedSurface === 'home' || normalizedSurface === 'albums' || normalizedSurface === 'playlists') {
    return normalizedSurface;
  }
  return 'home';
}

function resolveSidebarArtistCount(view = {}, sidebarArtists = []) {
  const explicitArtistCount = Number(view?.artist_count);
  if (Number.isFinite(explicitArtistCount) && explicitArtistCount >= 0) {
    return explicitArtistCount;
  }
  return sidebarArtists.length;
}

const SIDEBAR_VIRTUALIZATION_THRESHOLD = 200;
const SIDEBAR_VIRTUAL_WINDOW_SIZE = 160;
const SIDEBAR_VIRTUAL_OVERSCAN = 40;
const SIDEBAR_VIRTUAL_ROW_EXTENT = 47;

function getSidebarVirtualSpacerHeight(rowCount) {
  return Math.max(0, rowCount * SIDEBAR_VIRTUAL_ROW_EXTENT - 6);
}

function resolveSidebarVirtualWindow(sidebarArtists = [], options = {}) {
  const total = sidebarArtists.length;
  if (total <= SIDEBAR_VIRTUALIZATION_THRESHOLD) {
    return { virtualized: false, start: 0, end: total, before: 0, after: 0 };
  }
  const maxStart = Math.max(0, total - SIDEBAR_VIRTUAL_WINDOW_SIZE);
  const scrollTop = Math.max(0, Number(options.scrollTop) || 0);
  const visibleStart = Math.floor(scrollTop / SIDEBAR_VIRTUAL_ROW_EXTENT);
  const visibleCount = Math.max(
    1,
    Math.ceil((Number(options.viewportHeight) || SIDEBAR_VIRTUAL_ROW_EXTENT) / SIDEBAR_VIRTUAL_ROW_EXTENT),
  );
  const previousWindow = options.previousWindow;
  const retainedMargin = Math.floor(SIDEBAR_VIRTUAL_OVERSCAN / 2);
  if (
    !options.forceSelected
    && previousWindow?.virtualized
    && (previousWindow.start === 0 || visibleStart >= previousWindow.start + retainedMargin)
    && (
      previousWindow.end === total
      || visibleStart + visibleCount <= previousWindow.end - retainedMargin
    )
  ) {
    return {
      virtualized: true,
      start: previousWindow.start,
      end: previousWindow.end,
      before: getSidebarVirtualSpacerHeight(previousWindow.start),
      after: getSidebarVirtualSpacerHeight(total - previousWindow.end),
    };
  }
  let start = Math.max(
    0,
    visibleStart - SIDEBAR_VIRTUAL_OVERSCAN,
  );
  const selectedArtist = String(options.selectedArtist || '').trim();
  if (options.forceSelected && selectedArtist) {
    const selectedIndex = sidebarArtists.findIndex(item => String(item?.artist || '') === selectedArtist);
    if (selectedIndex >= 0) {
      start = selectedIndex - Math.floor(SIDEBAR_VIRTUAL_WINDOW_SIZE / 2);
    }
  }
  start = Math.min(maxStart, Math.max(0, start));
  const end = Math.min(total, start + SIDEBAR_VIRTUAL_WINDOW_SIZE);
  return {
    virtualized: true,
    start,
    end,
    before: getSidebarVirtualSpacerHeight(start),
    after: getSidebarVirtualSpacerHeight(total - end),
  };
}

function buildSidebarHtml(view = {}, sidebarArtists = [], options = {}) {
  const activeSurface = resolveSidebarSurface(view);
  const showAllArtistsLink = Object.prototype.hasOwnProperty.call(options, 'showAllArtistsOverride')
    && options.showAllArtistsOverride !== null
    ? Boolean(options.showAllArtistsOverride)
    : view.show_all_artists_sidebar_link !== false;
  const selectedArtist = resolveSidebarSelectedArtist(view, options);
  const artistCount = resolveSidebarArtistCount(view, sidebarArtists);
  const allArtistsActive = Object.prototype.hasOwnProperty.call(options, 'allArtistsActiveOverride')
    ? Boolean(options.allArtistsActiveOverride)
    : Boolean(activeSurface === 'albums' && (view.all_artists_active || (!view.query && !selectedArtist)));
  const renderItem = window.NavigationTree.renderItem;
  const virtualWindow = options.virtualWindow?.virtualized
    ? options.virtualWindow
    : { virtualized: false, start: 0, end: sidebarArtists.length, before: 0, after: 0 };
  const visibleArtists = sidebarArtists.slice(virtualWindow.start, virtualWindow.end);
  let html = showAllArtistsLink ? renderItem({
    label: 'All artists', href: '/?surface=albums', key: 'all-artists', count: artistCount,
    selected: allArtistsActive, attributes: { 'data-nav': '1', 'data-sidebar-all-artists': '1' },
  }) : '';
  if (virtualWindow.virtualized && virtualWindow.before > 0) {
    html += `<div class="sidebar-virtual-spacer" data-sidebar-virtual-spacer="before" aria-hidden="true" style="height:${virtualWindow.before}px"></div>`;
  }
  html += visibleArtists.map((item, offset) => renderItem({
    label: item.artist_display || item.artist, key: 'artist:' + item.artist,
    count: item.count, selected: item.artist === selectedArtist,
    href: buildUrl({
      ...view,
      selected_artist: item.artist,
      all_artists_active: Boolean(view.query) ? Boolean(view.all_artists_active) : false,
    }),
    attributes: {
      'data-nav': '1',
      'data-sidebar-artist': item.artist,
      ...(virtualWindow.virtualized
        ? { 'data-sidebar-virtual-index': virtualWindow.start + offset }
        : {}),
    },
  })).join('');
  if (virtualWindow.virtualized && virtualWindow.after > 0) {
    html += `<div class="sidebar-virtual-spacer" data-sidebar-virtual-spacer="after" aria-hidden="true" style="height:${virtualWindow.after}px"></div>`;
  }
  return html;
}

function buildSidebarStructureSignature(sidebarArtists = [], options = {}) {
  const showAllArtistsLink = Object.prototype.hasOwnProperty.call(options, 'showAllArtistsOverride')
    && options.showAllArtistsOverride !== null
    ? (options.showAllArtistsOverride ? '1' : '0')
    : String(options.view?.show_all_artists_sidebar_link !== false ? '1' : '0');
  const artistSignature = sidebarArtists.map((item) => [
    String(item?.artist || ''),
    String(item?.artist_display || item?.artist || ''),
    String(item?.count ?? ''),
  ].join('\u001f')).join('\u001e');
  const virtualWindow = options.virtualWindow?.virtualized
    ? `${options.virtualWindow.start}:${options.virtualWindow.end}`
    : 'all';
  return `${showAllArtistsLink}\u001d${artistSignature}\u001c${virtualWindow}`;
}

function applySidebarSelectionMarkup(container, options = {}) {
  if (!container || typeof container.querySelectorAll !== 'function' || typeof container.querySelector !== 'function') return;
  const selectedArtist = resolveSidebarSelectedArtist(options.view || {}, options);
  const allArtistsActive = Boolean(
    Object.prototype.hasOwnProperty.call(options, 'allArtistsActiveOverride')
      ? options.allArtistsActiveOverride
      : false
  );
  container.querySelectorAll('.artist-link[data-sidebar-artist]').forEach((link) => {
    if (!(link instanceof HTMLElement)) return;
    const isActive = String(link.getAttribute('data-sidebar-artist') || '') === selectedArtist;
    window.NavigationTree.setItemSelected(link, isActive);
  });
  const allArtistsLink = container.querySelector('.artist-link[data-sidebar-all-artists="1"]');
  if (allArtistsLink instanceof HTMLElement) {
    window.NavigationTree.setItemSelected(allArtistsLink, allArtistsActive);
  }
}

function buildRelatedMarkup(view = {}) {
  const related = Array.isArray(view.related_artists) ? view.related_artists : [];
  const activeRelatedArtists = new Set(Array.isArray(view.related_filter_artists) ? view.related_filter_artists : []);
  const familyFilters = Array.isArray(view.artist_family_filters) ? view.artist_family_filters : [];
  const familyGroups = Array.isArray(view.family_artist_groups) ? view.family_artist_groups : [];
  const primaryArtist = String(view.selected_artist || '').trim();
  const primaryChip = primaryArtist
    ? `<a class="related-chip is-primary${view.primary_filter_active ? ' active' : ''}" href="#" data-nav="1" data-related-primary="1" aria-current="${view.primary_filter_active ? 'true' : 'false'}">${escapeHtml(primaryArtist)}</a>`
    : '';
  return `${primaryChip}${related.map((artist) => {
    const isActive = activeRelatedArtists.has(artist);
    const familyFilter = familyFilters.find((filter) => (
      String(filter?.display_name || '').trim() === artist
      || (Array.isArray(filter?.variation_names)
        && filter.variation_names.some((variation) => String(variation || '').trim() === artist))
    ));
    const familyTagRef = String(familyFilter?.family_tag_ref || '').trim();
    const tagMatchedGroup = familyTagRef
      ? familyGroups.find((group) => String(group?.family_tag_ref || '').trim() === familyTagRef)
      : null;
    const membershipMatchedGroups = tagMatchedGroup ? [] : familyGroups.filter((group) => (
      (Array.isArray(group?.albums) ? group.albums : []).some((album) => (
        Array.isArray(album?.artists)
        && album.artists.some((albumArtist) => String(albumArtist || '').trim() === artist)
      ))
    ));
    const creditedGroup = tagMatchedGroup
      || (membershipMatchedGroups.length === 1 ? membershipMatchedGroups[0] : null);
    const displayArtist = String(
      creditedGroup?.artist_display || creditedGroup?.artist || artist
    ).trim() || artist;
    return `<a class="related-chip${isActive ? ' active' : ''}" href="#" data-nav="1" data-related-artist="${escapeHtml(artist)}">${escapeHtml(displayArtist)}</a>`;
  }).join('')}`;
}
