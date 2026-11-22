// Owner (2026-11-22): a save changes the Artist Tree at the Save click, as it changes the cards, and every
// tree drawn while it is written shows it. A failed save takes it back out.

function optimisticTreeArtist(album) {
  return String(album?.album_artist || album?.artist || '').trim();
}

function optimisticTreeKey(artist) {
  return artist.toLocaleLowerCase();
}

function optimisticAlbumKey(album) {
  return String(album?.key || '').trim().toLocaleLowerCase();
}

// Each new album the save leaves counts once; the album it edited, only if it lost its card (``kept``).
function artistTreeDeltas(original, updatedAlbums, kept) {
  const from = optimisticTreeArtist(original);
  const originalKey = optimisticAlbumKey(original);
  const destinations = (updatedAlbums || [])
    .filter((album) => !originalKey || optimisticAlbumKey(album) !== originalKey)
    .map(optimisticTreeArtist)
    .filter(Boolean);
  const deltas = new Map();
  if (!from || !destinations.length) return [];
  const change = (artist, delta) => {
    const key = optimisticTreeKey(artist);
    const entry = deltas.get(key) || { artist, delta: 0 };
    entry.delta += delta;
    deltas.set(key, entry);
  };
  destinations.forEach((artist) => change(artist, 1));
  if (!kept) change(from, -1);
  return Array.from(deltas.entries()).filter(([, { delta }]) => delta);
}

// ``sign`` -1 takes a save's changes back out.
function applyArtistTreeDeltas(sidebar, changes, sign = 1) {
  // No artist gains or loses an album: the tree keeps its list, so nothing redraws.
  if (!Array.isArray(sidebar) || !changes.length) return sidebar;
  const next = sidebar.map((entry) => ({ ...entry }));
  changes.forEach(([key, { artist, delta: change }]) => {
    const delta = change * sign;
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
// save doesn't edit (some of its tracks), or has duplicate copies (a card lists one copy, and the save
// edits only the files it lists).
function artistTreeKeepsEditedAlbum(album, updates) {
  const paths = getAlbumTrackPaths(album);
  const card = (typeof findVisibleAlbumByTrackPaths === 'function' ? findVisibleAlbumByTrackPaths(paths) : null)
    || album;
  return Boolean(card?.has_duplicate_files)
    || Array.from(getAlbumTrackPaths(card)).some((path) => !updates?.[path]);
}

// The saves this page is writing: a tree the server sends meanwhile doesn't hold them yet.
const pendingArtistTreeEdits = new Map();
let nextArtistTreeEditId = 0;

function changeArtistTreeLists(changes, sign) {
  const view = state.view || {};
  view.artists_sidebar = applyArtistTreeDeltas(view.artists_sidebar, changes, sign);
  if (Array.isArray(state.gallery?.sidebarArtistsOverride) && state.gallery.sidebarArtistsOverride.length) {
    state.gallery.sidebarArtistsOverride = applyArtistTreeDeltas(state.gallery.sidebarArtistsOverride, changes, sign);
  }
}

// At the Save click; the id ends it with settleArtistTreeEdit.
function applyTagEditToArtistTree(original, updatedAlbums, kept) {
  const changes = artistTreeDeltas(original, updatedAlbums, kept);
  if (!changes.length) return 0;
  const id = ++nextArtistTreeEditId;
  pendingArtistTreeEdits.set(id, changes);
  changeArtistTreeLists(changes, 1);
  return id;
}

// A tree the server sends while saves are written shows them, as the cards do.
function withPendingArtistTreeEdits(sidebar) {
  let next = sidebar;
  pendingArtistTreeEdits.forEach((changes) => { next = applyArtistTreeDeltas(next, changes, 1); });
  return next;
}

// When the save ends. A failed save takes its changes back out; a saved one stays until the library's
// own tree replaces it.
function settleArtistTreeEdit(id, { failed = false } = {}) {
  const changes = pendingArtistTreeEdits.get(id);
  if (!changes) return;
  pendingArtistTreeEdits.delete(id);
  if (failed) changeArtistTreeLists(changes, -1);
}
