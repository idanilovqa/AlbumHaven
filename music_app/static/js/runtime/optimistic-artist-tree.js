// Owner (2026-11-22): a save changes the Artist Tree at the Save click, as it changes the cards. The
// view refresh after the save (or after its failure) replaces these counts with the library's own.

function optimisticTreeArtist(album) {
  return String(album?.album_artist || album?.artist || '').trim();
}

function optimisticTreeKey(artist) {
  return artist.toLocaleLowerCase();
}

function optimisticAlbumKey(album) {
  return String(album?.key || '').trim().toLocaleLowerCase();
}

// ``kept``: the edited album keeps its card, so its artist keeps its count.
function moveSidebarArtistCounts(sidebar, original, updatedAlbums, kept) {
  const from = optimisticTreeArtist(original);
  const originalKey = optimisticAlbumKey(original);
  const destinations = (updatedAlbums || [])
    .filter((album) => !originalKey || optimisticAlbumKey(album) !== originalKey)
    .map(optimisticTreeArtist)
    .filter(Boolean);
  if (!from || !destinations.length) return sidebar;
  const deltas = new Map();
  const change = (artist, delta) => {
    const key = optimisticTreeKey(artist);
    const entry = deltas.get(key) || { artist, delta: 0 };
    entry.delta += delta;
    deltas.set(key, entry);
  };
  // Each new album the save leaves counts once; the album it edited, only if it lost its card.
  destinations.forEach((artist) => change(artist, 1));
  if (!kept) change(from, -1);
  const next = sidebar.map((entry) => ({ ...entry }));
  deltas.forEach(({ artist, delta }, key) => {
    if (!delta) return;
    const index = next.findIndex((entry) => optimisticTreeKey(String(entry?.artist || '').trim()) === key);
    if (index >= 0) {
      next[index].count = Math.max(0, Number(next[index].count || 0) + delta);
      if (!next[index].count) next.splice(index, 1);
    } else if (delta > 0) {
      const at = next.findIndex((entry) => String(entry?.artist_display || entry?.artist || '')
        .localeCompare(artist, undefined, { sensitivity: 'base', numeric: true }) > 0);
      next.splice(at < 0 ? next.length : at, 0, { artist, artist_display: artist, count: delta });
    }
  });
  return next;
}

// Before the optimistic apply: the edited album keeps its card when its visible card holds a file the
// save doesn't edit (an edit of one copy, or of some of its tracks).
function artistTreeKeepsEditedAlbum(album, updates) {
  const paths = getAlbumTrackPaths(album);
  const card = typeof findVisibleAlbumByTrackPaths === 'function' ? findVisibleAlbumByTrackPaths(paths) : null;
  return Array.from(getAlbumTrackPaths(card || album)).some((path) => !updates?.[path]);
}

function applyTagEditToArtistTree(original, updatedAlbums, kept) {
  const view = state.view || {};
  if (Array.isArray(view.artists_sidebar)) {
    view.artists_sidebar = moveSidebarArtistCounts(view.artists_sidebar, original, updatedAlbums, kept);
  }
  if (Array.isArray(state.gallery?.sidebarArtistsOverride) && state.gallery.sidebarArtistsOverride.length) {
    state.gallery.sidebarArtistsOverride = moveSidebarArtistCounts(
      state.gallery.sidebarArtistsOverride, original, updatedAlbums, kept,
    );
  }
}
