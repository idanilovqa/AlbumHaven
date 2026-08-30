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
  let html = showAllArtistsLink ? `<a class="artist-link ${allArtistsActive ? 'active' : ''}" href="/?surface=albums" data-nav="1" data-sidebar-all-artists="1">
      <span class="artist-name-label">All artists</span>
      <span class="artist-count">${artistCount}</span>
    </a>` : '';
  const displayedSidebarArtists = [...sidebarArtists].sort((left, right) => {
    const leftLabel = String(left?.artist_display || left?.artist || '');
    const rightLabel = String(right?.artist_display || right?.artist || '');
    return leftLabel.localeCompare(rightLabel, 'en', { numeric: true, sensitivity: 'base' });
  });
  html += displayedSidebarArtists.map((item) => `
    <a class="artist-link ${item.artist === selectedArtist ? 'active' : ''}" href="${buildUrl({
      ...view,
      selected_artist: item.artist,
      all_artists_active: Boolean(view.query) ? Boolean(view.all_artists_active) : false,
    })}" data-nav="1" data-sidebar-artist="${escapeHtml(item.artist)}">
      <span class="artist-name-label">${escapeHtml(item.artist_display || item.artist)}</span>
      <span class="artist-count">${item.count}</span>
    </a>
  `).join('');
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
  return `${showAllArtistsLink}\u001d${artistSignature}`;
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
    link.classList.toggle('active', isActive);
    if (isActive) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  });
  const allArtistsLink = container.querySelector('.artist-link[data-sidebar-all-artists="1"]');
  if (allArtistsLink instanceof HTMLElement) {
    allArtistsLink.classList.toggle('active', allArtistsActive);
    if (allArtistsActive) allArtistsLink.setAttribute('aria-current', 'true');
    else allArtistsLink.removeAttribute('aria-current');
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
