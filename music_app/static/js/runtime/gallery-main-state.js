const GALLERY_RELEASE_TYPES = ['studio', 'live', 'demo', 'compilation', 'ep', 'single'];
const GALLERY_INTERACTIVE_RELEASE_TYPES = ['studio', 'compilation'];
const GALLERY_TRIAL_ARTIST_IMAGES = Object.freeze({
  'Neal Morse': 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Neal_Morse2.jpg?width=480',
  'Devin Townsend': 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Devin_Townsend_(cropped).jpg?width=480',
  'Ария': 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Aria_2013.jpg?width=640',
  'The Flower Kings': 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Flowerkings2004.jpg?width=640',
});

function createGalleryMainState(overrides = {}) {
  const galleryState = {
    sources: { main_library: true, new_arrivals: true, hoard: true, ...(overrides.sources || {}) },
    albumTypes: Array.isArray(overrides.albumTypes) ? overrides.albumTypes.slice() : ['studio', 'ep'],
    view: ['cards', 'covers'].includes(overrides.view) ? overrides.view : 'cards',
    familyArtists: Array.isArray(overrides.familyArtists) ? overrides.familyArtists.slice() : [],
  };
  if (overrides.familySelectionExplicit === true) galleryState.familySelectionExplicit = true;
  if (Array.isArray(overrides.familyArtistOrder)) galleryState.familyArtistOrder = overrides.familyArtistOrder.slice();
  return galleryState;
}

function resetGalleryMainStateForPrimaryArtist(current = {}) {
  return createGalleryMainState({ view: current.view });
}

function normalizeGalleryView(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'no info' || normalized === 'covers') return 'covers';
  return 'cards';
}

function reduceGalleryMainState(current, action = {}) {
  const next = createGalleryMainState(current || {});
  if (action.type === 'toggle-source' && Object.hasOwn(next.sources, action.source)) {
    next.sources[action.source] = !next.sources[action.source];
  } else if (action.type === 'toggle-album-type' && GALLERY_INTERACTIVE_RELEASE_TYPES.includes(action.albumType)) {
    next.albumTypes = next.albumTypes.includes(action.albumType)
      ? next.albumTypes.filter((item) => item !== action.albumType)
      : [...next.albumTypes, action.albumType];
  } else if (action.type === 'set-view') {
    next.view = normalizeGalleryView(action.view);
  } else if (action.type === 'toggle-family-artist') {
    const artist = String(action.artist || '').trim();
    const availableArtists = Array.isArray(action.availableArtists)
      ? action.availableArtists.map((item) => String(item || '').trim()).filter((item, index, items) => item && items.indexOf(item) === index)
      : [];
    if (artist && availableArtists.length && next.familySelectionExplicit !== true && !next.familyArtists.length) {
      next.familyArtists = availableArtists.filter((item) => item !== artist);
      next.familySelectionExplicit = true;
    } else if (artist) {
      next.familyArtists = next.familyArtists.includes(artist)
        ? next.familyArtists.filter((item) => item !== artist)
        : [...next.familyArtists, artist];
      if (availableArtists.length) {
        next.familySelectionExplicit = true;
        if (availableArtists.every((item) => next.familyArtists.includes(item))) {
          next.familyArtists = [];
          delete next.familySelectionExplicit;
        }
      }
    }
  } else if (action.type === 'reorder-family-artist') {
    next.familyArtistOrder = reorderGalleryFamilyArtists(
      action.availableArtists || next.familyArtistOrder || [],
      action.artist,
      action.beforeArtist,
    );
  }
  return next;
}

function reorderGalleryFamilyArtists(artists = [], artist = '', beforeArtist = '') {
  const unique = artists.map((item) => String(item || '').trim())
    .filter((item, index, items) => item && items.indexOf(item) === index);
  const dragged = String(artist || '').trim();
  const target = String(beforeArtist || '').trim();
  if (!dragged || !target || dragged === target || !unique.includes(dragged) || !unique.includes(target)) return unique;
  const reordered = unique.filter((item) => item !== dragged);
  reordered.splice(reordered.indexOf(target), 0, dragged);
  return reordered;
}

function hasGalleryNonAlbumTracks(view = {}) {
  return Array.isArray(view.non_album_tracks) && view.non_album_tracks.length > 0;
}

function classifyGalleryReleaseType(album = {}) {
  const explicit = String(album.release_type || album.releaseType || '').trim().toLowerCase();
  const normalized = explicit === 'compilations' ? 'compilation' : explicit;
  if (album.is_compilation === true) return 'compilation';
  if (normalized === 'compilation') return 'compilation';
  return 'studio';
}

function resolveGalleryAlbumSources(album = {}) {
  const allowed = new Set(['main_library', 'new_arrivals', 'hoard']);
  const provenance = Array.isArray(album.root_provenance?.categories)
    ? album.root_provenance.categories
    : [];
  const candidates = provenance.length
    ? provenance
    : [album.library_root_category || album.source || 'main_library'];
  const sources = candidates
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value, index, values) => allowed.has(value) && values.indexOf(value) === index);
  return sources.length ? sources : ['main_library'];
}

function filterGalleryModel({ groups = [], filterState = createGalleryMainState() } = {}) {
  const selectedArtists = new Set(filterState.familyArtists || []);
  const familySelectionExplicit = filterState.familySelectionExplicit === true || selectedArtists.size > 0;
  const selectedTypes = new Set(filterState.albumTypes || []);
  const filteredGroups = groups.flatMap((group) => {
    const artist = String(group.artist_display || group.artist || '').trim();
    if (familySelectionExplicit && !selectedArtists.has(artist)) return [];
    const albums = (Array.isArray(group.albums) ? group.albums : []).filter((album) => (
      resolveGalleryAlbumSources(album).some((source) => filterState.sources?.[source] !== false)
      && selectedTypes.has(classifyGalleryReleaseType(album))
    ));
    return albums.length ? [{ ...group, albums }] : [];
  });
  return {
    groups: filteredGroups,
    totals: {
      artistCount: filteredGroups.length,
      albumCount: filteredGroups.reduce((total, group) => total + group.albums.length, 0),
    },
  };
}

function applyGalleryClientTransition({ state: current, action } = {}) {
  return reduceGalleryMainState(current, action);
}

function resolveGallerySourceHydrationRequest({ currentCategories = [], nextState, action } = {}) {
  if (action?.type !== 'toggle-source' || !nextState?.sources?.[action.source]) return null;
  const available = new Set(Array.isArray(currentCategories) ? currentCategories : []);
  if (available.has(action.source)) return null;
  return ['main_library', 'new_arrivals', 'hoard'].filter((source) => nextState.sources[source] !== false);
}

function buildGallerySourceHydrationView({ currentView = {}, hydrationCategories = [] } = {}) {
  return {
    ...currentView,
    gallery_scope: 'all',
    visible_library_categories: Array.isArray(hydrationCategories) ? [...hydrationCategories] : [],
  };
}

// Preview biography paraphrased from https://en.wikipedia.org/wiki/Neal_Morse (2026-09-08).
const GALLERY_TRIAL_ARTIST_BIOGRAPHIES = Object.freeze({
  'Neal Morse': "Neal Morse is an American singer, songwriter and multi-instrumentalist whose work spans progressive rock and Christian music. Raised in California, he began learning piano as a child and later took up guitar. He formed Spock's Beard with his brother Alan in 1992; their debut album, The Light, appeared in 1995.\n\nIn 1999, Morse joined Mike Portnoy, Roine Stolt and Pete Trewavas to form Transatlantic. After leaving Spock's Beard in 2002, he developed a solo career centred on ambitious concept albums, including Testimony, which explored his religious conversion.\n\nHis collaborations also include Flying Colors and the Neal Morse Band. Alongside lengthy progressive compositions, his recordings range from singer-songwriter material to cover albums and musical retellings of biblical stories. His Morsefest concerts bring musicians and listeners together for performances of complete albums and other substantial works.",
});

function resolveGalleryArtistInfo(group = {}, artist = '') {
  const artistName = String(artist || '').trim() || 'This artist';
  const albumCount = Array.isArray(group.albums) ? group.albums.length : 0;
  const providedSummary = typeof group.artist_summary === 'string'
    ? group.artist_summary.trim()
    : (typeof group.summary === 'string' ? group.summary.trim() : '') || GALLERY_TRIAL_ARTIST_BIOGRAPHIES[artistName] || '';
  const rawImageUrl = String(group.artist_image_url || group.image_url || GALLERY_TRIAL_ARTIST_IMAGES[artistName] || '').trim();
  const rawWikipediaUrl = String(group.wikipedia_url || '').trim();
  const imageUrl = (/^\/(?!\/)/.test(rawImageUrl) || /^https:\/\//i.test(rawImageUrl)) ? rawImageUrl : '';
  const wikipediaUrl = /^https:\/\/(?:[a-z0-9-]+\.)*wikipedia\.org(?:\/|$)/i.test(rawWikipediaUrl)
    ? rawWikipediaUrl
    : '';
  return {
    summary: providedSummary || `${artistName} has ${albumCount} album${albumCount === 1 ? '' : 's'} in this Gallery view.`,
    imageUrl,
    wikipediaUrl,
    canReadMore: providedSummary.length > 280,
  };
}

function reconcileGalleryMain(config = {}) {
  (config.changedGroupKeys || []).forEach((key) => config.replaceGroup?.(key));
  config.updateCounts?.(config.totals || { artistCount: 0, albumCount: 0 });
  return { galleryRoot: config.galleryRoot, activeSurface: config.activeSurface };
}

function resolveGalleryBarContext(config = {}) {
  const summaryContext = config.primaryArtist
    ? { kind: 'family', primaryArtist: config.primaryArtist, artistCount: config.artistCount, albumCount: config.albumCount }
    : { kind: 'gallery', artistCount: config.artistCount, albumCount: config.albumCount };
  if (Number(config.scrollTop || 0) <= 12) {
    return summaryContext;
  }
  const threshold = Number(config.scrollTop || 0) + Number(config.galleryBarBottom || 0);
  const current = (config.groups || []).filter((group) => Number(group.top || 0) <= threshold).at(-1);
  return current
    ? { kind: 'artist', artist: current.artist, albumCount: current.albumCount }
    : summaryContext;
}

function resolveGallerySummaryTotals(view, mountedTotals) {
  if (!view.initial_view_partial || view.selected_artist || view.query) return mountedTotals;
  return {
    artistCount: Number.isFinite(Number(view.artist_count)) ? Number(view.artist_count) : mountedTotals.artistCount,
    albumCount: Number.isFinite(Number(view.album_count)) ? Number(view.album_count) : mountedTotals.albumCount,
  };
}