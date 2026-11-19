function appendSearchFilterParams(params, searchFilters) {
  const filters = searchFilters && typeof searchFilters === 'object' ? searchFilters : {};
  const appendRepeated = (key, values) => {
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .forEach((value) => params.append(key, value));
  };
  appendRepeated('genre', filters.genre);
  appendRepeated('mood', filters.mood);
  appendRepeated('style', filters.style);
  const duration = filters.duration && typeof filters.duration === 'object' ? filters.duration : {};
  const hasMinSeconds = duration.min_seconds !== null && duration.min_seconds !== undefined && duration.min_seconds !== '';
  const hasMaxSeconds = duration.max_seconds !== null && duration.max_seconds !== undefined && duration.max_seconds !== '';
  const minSeconds = hasMinSeconds ? Number(duration.min_seconds) : Number.NaN;
  const maxSeconds = hasMaxSeconds ? Number(duration.max_seconds) : Number.NaN;
  if (Number.isInteger(minSeconds) && minSeconds >= 0) {
    params.set('duration_min', String(minSeconds));
  }
  if (Number.isInteger(maxSeconds) && maxSeconds >= 0) {
    params.set('duration_max', String(maxSeconds));
  }
}

function parseSearchFiltersFromUrlState(searchParams) {
  const parseOptionalInt = (key) => {
    const rawValue = String(searchParams.get(key) || '').trim();
    if (!rawValue) return null;
    const normalized = Number(rawValue);
    return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
  };
  return {
    genre: searchParams.getAll('genre'),
    mood: searchParams.getAll('mood'),
    style: searchParams.getAll('style'),
    duration: {
      min_seconds: parseOptionalInt('duration_min'),
      max_seconds: parseOptionalInt('duration_max'),
    },
  };
}

function normalizeGalleryDisplayMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'covers' || normalized === 'list' ? normalized : 'cards';
}

function normalizeSelectedArtistFamilyDisplayMode(value) {
  return String(value || '').trim().toLowerCase() === 'chronological' ? 'chronological' : 'grouped';
}

function resolveSelectedArtistFamilyDisplayMode(view = {}) {
  return normalizeSelectedArtistFamilyDisplayMode(
    view.selected_artist_family_display_mode ?? view.artist_page?.family_display_mode,
  );
}

function normalizeGalleryScalePercent(value) {
  if (value === null || value === undefined || value === '') {
    return 100;
  }
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : 100;
}

function resolveViewSurface(view = {}) {
  const normalizedSurface = String(
    view?.surface?.active
      ?? view?.surface_request
      ?? '',
  ).trim().toLowerCase();
  const selectedArtist = String(view.selected_artist || '').trim();
  const query = String(view.query || '').trim();
  const allArtistsActive = Boolean(view.all_artists_active);
  if (normalizedSurface === 'playlists') {
    return 'playlists';
  }
  if (normalizedSurface === 'home') {
    if (!selectedArtist && !query && !allArtistsActive) {
      return 'home';
    }
    return 'albums';
  }
  if (normalizedSurface === 'albums') {
    return normalizedSurface;
  }
  if (selectedArtist || query || allArtistsActive) {
    return 'albums';
  }
  return 'home';
}

function resolvePlaylistId(view = {}) {
  const playlistId = String(
    view?.playlist_detail?.playlist_id
      ?? view?.playlist_sidebar?.active_playlist_id
      ?? view?.playlist_id
      ?? '',
  ).trim();
  return playlistId;
}

function appendPlaylistStateParams(params, view, resolvedSurface) {
  if (resolvedSurface !== 'playlists') return;
  const playlistId = resolvePlaylistId(view);
  if (playlistId) {
    params.set('playlist_id', playlistId);
  }
}

function buildUrl(view) {
  const params = new URLSearchParams();
  const resolvedSurface = resolveViewSurface(view);
  if (resolvedSurface === 'home') {
    return '/';
  }
  if (resolvedSurface === 'playlists' || resolvedSurface === 'albums') {
    params.set('surface', resolvedSurface);
  }
  appendPlaylistStateParams(params, view, resolvedSurface);
  if (view.query) params.set('q', view.query);
  if (view.selected_artist) params.set('artist', view.selected_artist);
  if (view.all_artists_active) params.set('all_artists', '1');
  if (view.gallery_scope) params.set('gallery_scope', view.gallery_scope);
  const galleryDisplayMode = normalizeGalleryDisplayMode(view.gallery_display_mode);
  if (galleryDisplayMode !== 'cards') params.set('gallery_display', galleryDisplayMode);
  const selectedArtistFamilyDisplayMode = resolveSelectedArtistFamilyDisplayMode(view);
  if (view.selected_artist && selectedArtistFamilyDisplayMode !== 'grouped') {
    params.set('family_display', selectedArtistFamilyDisplayMode);
  }
  const galleryScalePercent = normalizeGalleryScalePercent(view.gallery_scale_percent);
  if (galleryScalePercent !== 100) params.set('gallery_scale_percent', String(galleryScalePercent));
  (view.visible_library_categories || []).forEach((category) => {
    if (category) params.append('category', category);
  });
  (view.related_filter_artists || []).forEach((artist) => {
    if (artist) params.append('related_artist', artist);
  });
  if (view.primary_filter_active) params.set('primary_filter', '1');
  appendSearchFilterParams(params, view.search_filters);
  const qs = params.toString();
  return `/${qs ? `?${qs}` : ''}`;
}

function buildApiUrl(view, options = {}) {
  const resolvedSurface = resolveViewSurface(view);
  if (resolvedSurface === 'home') {
    return options.omitSidebar ? '/home-data?omit_sidebar=1' : '/home-data';
  }
  const params = new URLSearchParams();
  params.set('surface', resolvedSurface);
  appendPlaylistStateParams(params, view, resolvedSurface);
  if (view.query) params.set('q', view.query);
  if (view.selected_artist) params.set('artist', view.selected_artist);
  if (view.all_artists_active) params.set('all_artists', '1');
  if (view.gallery_scope) params.set('gallery_scope', view.gallery_scope);
  const galleryDisplayMode = normalizeGalleryDisplayMode(view.gallery_display_mode);
  if (galleryDisplayMode !== 'cards') params.set('gallery_display', galleryDisplayMode);
  const selectedArtistFamilyDisplayMode = resolveSelectedArtistFamilyDisplayMode(view);
  if (view.selected_artist && selectedArtistFamilyDisplayMode !== 'grouped') {
    params.set('family_display', selectedArtistFamilyDisplayMode);
  }
  const galleryScalePercent = normalizeGalleryScalePercent(view.gallery_scale_percent);
  if (galleryScalePercent !== 100) params.set('gallery_scale_percent', String(galleryScalePercent));
  (view.visible_library_categories || []).forEach((category) => {
    if (category) params.append('category', category);
  });
  (view.related_filter_artists || []).forEach((artist) => {
    if (artist) params.append('related_artist', artist);
  });
  if (view.primary_filter_active) params.set('primary_filter', '1');
  appendSearchFilterParams(params, view.search_filters);
  if (resolvedSurface === 'albums' && !view.query && !view.selected_artist
    && !options.payloadTier && !options.rootSidebar
    && !['genre', 'mood', 'style', 'duration_min', 'duration_max', 'related_artist', 'primary_filter']
      .some(key => params.has(key))) {
    params.set('gallery_page_size', '50');
  }
  const galleryAnchorArtist = String(options.galleryAnchorArtist || '').trim();
  if (galleryAnchorArtist) params.set('gallery_anchor_artist', galleryAnchorArtist);
  if (options.omitSidebar) params.set('omit_sidebar', '1');
  if (options.rootSidebar) params.set('root_sidebar', '1');
  if (String(options.payloadTier || '').trim()) {
    params.set('payload_tier', String(options.payloadTier).trim());
  } else if (resolvedSurface === 'albums' && view.selected_artist && !view.query && !options.rootSidebar) {
    params.set('payload_tier', 'gallery_summary');
  } else if (
    options.rootFullPayload
    && resolvedSurface === 'albums'
    && !view.query
    && !view.selected_artist
  ) {
    params.set('payload_tier', 'full');
  }
  const qs = params.toString();
  return `/view-data${qs ? `?${qs}` : ''}`;
}

function parseUrlStateFromUrl(url, baseOrigin) {
  const u = new URL(url, baseOrigin);
  return {
    surface_request: u.searchParams.get('surface') || '',
    playlist_id: u.searchParams.get('playlist_id') || '',
    query: u.searchParams.get('q') || '',
    selected_artist: u.searchParams.get('artist') || '',
    all_artists_active: ['1', 'true', 'yes', 'on'].includes((u.searchParams.get('all_artists') || '').toLowerCase()),
    gallery_scope: u.searchParams.get('gallery_scope') || 'all',
    gallery_display_mode: normalizeGalleryDisplayMode(u.searchParams.get('gallery_display')),
    gallery_scale_percent: normalizeGalleryScalePercent(u.searchParams.get('gallery_scale_percent')),
    visible_library_categories: u.searchParams.getAll('category'),
    related_filter_artists: u.searchParams.getAll('related_artist'),
    primary_filter_active: ['1', 'true', 'yes', 'on'].includes((u.searchParams.get('primary_filter') || '').toLowerCase()),
    search_filters: parseSearchFiltersFromUrlState(u.searchParams),
    ...(u.searchParams.has('family_display')
      ? {
        selected_artist_family_display_mode: normalizeSelectedArtistFamilyDisplayMode(
          u.searchParams.get('family_display'),
        ),
      }
      : {}),
  };
}

function parseUrlState(url) {
  return parseUrlStateFromUrl(url, window.location.origin);
}

// The highlight ranges the server reported, by search and display text. Search responses (view-data, Loose
// Tracks, the Custom Collections catalog) carry them; /search/highlights answers for texts shown elsewhere. A
// text the server was asked about and did not match is known, with no ranges. The latest few searches are kept:
// a new search's catalog can arrive while the previous search's view is still shown.
function searchHighlightState() {
  state.searchHighlights ||= { byQuery: new Map(), viewSource: null };
  return state.searchHighlights;
}

function searchHighlightTexts(query, create = false) {
  const { byQuery } = searchHighlightState();
  if (!byQuery.has(query) && create) {
    byQuery.set(query, new Map());
    while (byQuery.size > 3) byQuery.delete(byQuery.keys().next().value);
  }
  return byQuery.get(query) || null;
}

function activeSearchHighlightQuery() {
  return String(state?.view?.query || '').trim();
}

function rememberSearchHighlights(highlights, askedTexts = []) {
  const query = String(highlights?.query || '').trim();
  const texts = highlights?.texts;
  if (!query || !texts || typeof texts !== 'object') return;
  const known = searchHighlightTexts(query, true);
  for (const text of askedTexts) known.set(String(text), []);
  for (const [text, ranges] of Object.entries(texts)) {
    if (Array.isArray(ranges)) known.set(text, ranges);
  }
}

function searchHighlightRanges(value) {
  const query = activeSearchHighlightQuery();
  if (!query) return null;
  const viewHighlights = state.view?.search_highlights;
  if (viewHighlights && viewHighlights !== searchHighlightState().viewSource) {
    searchHighlightState().viewSource = viewHighlights;
    rememberSearchHighlights(viewHighlights);
  }
  const ranges = searchHighlightTexts(query)?.get(String(value ?? ''));
  return ranges?.length ? ranges : null;
}

async function requestSearchHighlights(values) {
  const query = activeSearchHighlightQuery();
  const known = searchHighlightTexts(query);
  const texts = [...new Set((values || []).map((value) => String(value ?? '')).filter(Boolean))]
    .filter((text) => !known?.has(text))
    .slice(0, 1000);
  if (!query || !texts.length) return false;
  const response = await fetch('/search/highlights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ q: query, texts }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok || payload.search_highlights?.query !== query) return false;
  rememberSearchHighlights(payload.search_highlights, texts);
  return true;
}

// Markup for a label the active search matched, or '' when nothing in it matched.
function searchHighlightedLabelHtml(value) {
  const ranges = searchHighlightRanges(value);
  return ranges ? buildHighlightedTextHtml(value, ranges) : '';
}
