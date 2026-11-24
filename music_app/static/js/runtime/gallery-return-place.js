// The gallery's side of returning to a place after Back or Forward: what is taken as the place, and
// the way back to it through the gallery's own paging and scroll anchors. What is kept, and for whom,
// is return-place.js's.

const RETURN_SETTLE_LIMIT_MS = 10000;
// The pages read beside an anchored window to reach an album of the artist it is around.
const RETURN_PAGE_LIMIT = 7;
const RETURN_ALIGN_FRAMES = 90;
const RETURN_STABLE_FRAMES = 6;
const RETURN_INTERRUPTING_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'];

let returnAttempt = null;
// The place before the action that may push a history entry: by then the next view has rendered.
let placeBeforeNavigation = null;

function getReturnPlaceOwner() {
  return window.AlbumHavenReturnPlace || null;
}

let returnPlaceKey = getReturnPlaceOwner()?.currentKey?.() || '';

function returnAlbumId(album) {
  const id = Number(album?.album_id || album?.id || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function returnAlbumRef(album) {
  return album ? { id: returnAlbumId(album), key: String(album.album_ref || album.key || '') } : null;
}

// The album [ref] names among those loaded, and its group.
function findReturnAlbum(ref, preferredArtist = '') {
  if (!ref) return null;
  let found = null;
  for (const groups of [state.view?.artist_groups, state.view?.primary_artist_groups, state.view?.family_artist_groups]) {
    for (const group of groups || []) {
      for (const album of group.albums || []) {
        const matches = ref.id ? returnAlbumId(album) === ref.id : Boolean(ref.key) && getAlbumRequestKey(album) === ref.key;
        if (!matches) continue;
        // An album can stand under more than one artist: the one it was left under first.
        if (!preferredArtist || group.artist === preferredArtist) return { album, group };
        found = found || { album, group };
      }
    }
  }
  return found;
}

function captureOpenAlbumPlace() {
  const els = getTrackModalElements();
  if (!els.overlay || els.overlay.hidden) return null;
  const pendingKey = String(state.ui.pendingTrackModalLoadAlbumKey || '');
  const album = getCurrentTrackModalAlbum() || (pendingKey ? getIndexedAlbum(pendingKey) : null);
  if (!album) return null;
  const outlet = document.getElementById('mobile-page-outlet');
  const scroller = outlet && !outlet.hidden ? outlet : els.overlay;
  return { ...returnAlbumRef(album), top: Number(els.list?.scrollTop || 0), page: Number(scroller.scrollTop || 0) };
}

function captureGalleryPlace() {
  const scroll = document.getElementById('albums-scroll');
  if (!scroll) return null;
  const place = { top: Number(scroll.scrollTop || 0) };
  if (place.top > 0 && typeof virtualGrid !== 'undefined' && virtualGrid) {
    const anchor = virtualGrid.captureScrollAnchor?.();
    if (anchor?.albumKey) {
      const album = getIndexedAlbum(anchor.albumKey);
      const section = virtualGrid.sectionByRenderedKey?.get(anchor.sectionOccurrenceKey);
      place.offset = Math.round(Number(anchor.offsetTop || 0));
      place.artist = String(section?.group?.artist || album?.artist || album?.album_artist || '');
      place.album = returnAlbumRef(album);
    }
  }
  const open = captureOpenAlbumPlace();
  if (open) place.open = open;
  return place;
}

function saveCurrentPlace(key = returnPlaceKey) {
  const owner = getReturnPlaceOwner();
  // Until the page is back at the place, that place is still the entry's.
  if (!owner || returnAttempt || owner.returning?.()) return;
  const place = captureGalleryPlace();
  if (place) owner.save(key, place);
}

function notePlaceBeforeNavigation() {
  if (getReturnPlaceOwner() && !returnAttempt) placeBeforeNavigation = captureGalleryPlace();
}

function handleReturnEntryChange(event) {
  const owner = getReturnPlaceOwner();
  if (!owner) return;
  const from = event.from?.key || '';
  if (event.navigationType === 'push' && placeBeforeNavigation) {
    owner.save(from, placeBeforeNavigation);
  } else if (event.navigationType === 'traverse') {
    // popstate follows: the view left is still the one on screen.
    saveCurrentPlace(from);
  } else if (event.navigationType !== 'push') {
    return; // the same entry: the action under way may still push one
  }
  placeBeforeNavigation = null;
  returnPlaceKey = owner.currentKey();
}

function waitForReturnFrame() {
  return new Promise(resolve => scheduleBrowserAnimationFrame(resolve));
}

async function waitWhileReturning(attempt, unsettled) {
  const until = Date.now() + RETURN_SETTLE_LIMIT_MS;
  while (attempt.active && unsettled() && Date.now() < until) await waitForReturnFrame();
  return attempt.active;
}

const isReturnViewLoading = () => Boolean(state.busy || state.awaitingInitialDataRefresh);

// The grid's own section holding the album: loaded albums can wait a moment to be laid out.
function findReturnSection(found) {
  const key = getAlbumRequestKey(found.album);
  const holding = (virtualGrid.sections || []).filter(section => (
    section.kind === 'artist' && section.group?.albums?.some(album => getAlbumRequestKey(album) === key)
  ));
  return holding.find(section => section.group.artist === found.group.artist) || holding[0] || null;
}

async function alignReturnAlbum(attempt, place, found) {
  if (typeof virtualGrid === 'undefined' || !virtualGrid) return;
  const scroll = document.getElementById('albums-scroll');
  // The artist tree's own jump first: it cancels the reset to the top a render leaves for the next
  // frame, which would start loading the pages above, one after another. Then the album's anchor.
  virtualGrid.scrollToArtist?.(found.group.artist);
  let section = findReturnSection(found);
  if (!section) {
    // An anchor the grid has not laid out would land on whatever is at that offset instead.
    await waitWhileReturning(attempt, () => !(section = findReturnSection(found)));
    if (!section || !attempt.active) return;
    virtualGrid.scrollToArtist?.(section.group.artist);
  }
  const anchor = {
    scrollLeft: 0,
    scrollTop: Math.max(1, Number(place.top || 0)),
    albumKey: getAlbumRequestKey(found.album),
    albumName: String(found.album.name || ''),
    albumYear: String(found.album.year ?? ''),
    anchorBox: 'card',
    sectionOccurrenceKey: virtualGrid.getRenderedSectionKey(section),
    offsetTop: Number(place.offset || 0),
  };
  // The first step lands by the grid's model; the row it mounts then corrects it.
  let previousTop = null;
  let stable = 0;
  for (let frame = 0; frame < RETURN_ALIGN_FRAMES && stable < RETURN_STABLE_FRAMES; frame += 1) {
    if (!attempt.active) return;
    virtualGrid.restoreOwnedScrollAnchor(anchor);
    virtualGrid.render();
    stable = previousTop === scroll.scrollTop ? stable + 1 : 0;
    previousTop = scroll.scrollTop;
    await waitForReturnFrame();
  }
}

// All artists; offline, also when the copy standing in for this address has none of its albums: the
// window around the artist may still be kept.
function canLoadReturnArtist(artist) {
  const unreachableRoot = Boolean(state.ui.galleryUnreachable)
    && !state.view?.selected_artist && !state.view?.query;
  if (!artist || !(unreachableRoot || isPagedRootGallery())) return false;
  const sidebar = state.view?.artists_sidebar;
  return !sidebar?.length || sidebar.some(item => item.artist === artist);
}

async function returnToGalleryPlace(attempt, place) {
  if (!(place.top > 0)) return;
  let found = findReturnAlbum(place.album, place.artist);
  if (!found) {
    if (!await waitWhileReturning(attempt, isReturnViewLoading)) return;
    found = findReturnAlbum(place.album, place.artist);
  }
  if (!found && place.album && canLoadReturnArtist(place.artist)) {
    // One window around its artist, as the artist tree's own jump asks for.
    await fetchAndRender(
      buildApiUrl(state.view, { galleryAnchorArtist: place.artist, omitSidebar: true }),
      false,
      { preserveScroll: false },
    );
    if (!await waitWhileReturning(attempt, isReturnViewLoading)) return;
    found = findReturnAlbum(place.album, place.artist);
    if (!found && typeof virtualGrid !== 'undefined') virtualGrid?.scrollToArtist?.(place.artist);
    const scroll = document.getElementById('albums-scroll');
    for (let page = 0; !found && page < RETURN_PAGE_LIMIT; page += 1) {
      if (!await waitWhileReturning(attempt, isRootGalleryPageRequestLoading)) return;
      found = findReturnAlbum(place.album, place.artist);
      if (found) break;
      // Only while that artist may go on past the window: kept pages (offline) can start inside it.
      const groups = state.view?.artist_groups || [];
      const gallery = state.view?.gallery_page;
      const before = Boolean(gallery?.has_previous) && groups[0]?.artist === place.artist;
      const after = Boolean(gallery?.has_more) && groups[groups.length - 1]?.artist === place.artist;
      if (!before && !after) break;
      // Either loads only near that end of what is loaded.
      scroll.scrollTop = before ? 0 : scroll.scrollHeight;
      const loaded = await (before ? loadPreviousRootGalleryPage() : loadNextRootGalleryPage());
      if (!loaded && !isRootGalleryPageRequestLoading()) break;
      found = findReturnAlbum(place.album, place.artist);
    }
    if (!found && attempt.active && typeof virtualGrid !== 'undefined') virtualGrid?.scrollToArtist?.(place.artist);
  } else if (!found) {
    const scroll = document.getElementById('albums-scroll');
    if (scroll && attempt.active) scroll.scrollTop = place.top;
  }
  if (!found || !attempt.active) return;
  await alignReturnAlbum(attempt, place, found);
  if (attempt.active && isReturnViewLoading()) {
    if (!await waitWhileReturning(attempt, isReturnViewLoading)) return;
    found = findReturnAlbum(place.album, place.artist);
    if (found) await alignReturnAlbum(attempt, place, found);
  }
  // The anchor's own scrolling is not the user's, so it starts no paging by itself.
  if (attempt.active && isPagedRootGallery()) void loadNextRootGalleryPage();
}

function reopenReturnAlbum(open) {
  const els = getTrackModalElements();
  if (!els.overlay || !els.overlay.hidden) return;
  const album = findReturnAlbum(open)?.album
    || (open.key ? { key: open.key, album_id: open.id, name: 'Album' } : null);
  if (album) openTrackModal({ ...album, preview_only: true });
}

async function returnToAlbumScroll(attempt, open) {
  const els = getTrackModalElements();
  if (!els.overlay || els.overlay.hidden || !(open.top > 0 || open.page > 0)) return;
  const loading = () => !els.overlay.hidden && Boolean(els.list?.querySelector?.('.track-modal-loading-row'));
  if (!await waitWhileReturning(attempt, loading)) return;
  await waitForReturnFrame();
  if (!attempt.active || els.overlay.hidden) return;
  if (els.list) els.list.scrollTop = Number(open.top || 0);
  const outlet = document.getElementById('mobile-page-outlet');
  (outlet && !outlet.hidden ? outlet : els.overlay).scrollTop = Number(open.page || 0);
}

async function returnToPlace(place, { afterPopState = false } = {}) {
  if (returnAttempt) returnAttempt.active = false;
  const attempt = { active: true };
  returnAttempt = attempt;
  const takeOver = () => {
    attempt.active = false;
    getReturnPlaceOwner()?.done();
  };
  for (const type of RETURN_INTERRUPTING_EVENTS) window.addEventListener(type, takeOver, { capture: true, passive: true });
  try {
    // After popstate the albums on screen are still the view that was left.
    if (afterPopState) {
      if (!await waitWhileReturning(attempt, isReturnViewLoading)) return;
      // Within the frame that rendered it, so its top is never painted.
      if (place.top > 0) getReturnPlaceOwner()?.hide?.();
    }
    if (place.open) reopenReturnAlbum(place.open);
    await returnToGalleryPlace(attempt, place);
    if (place.open && attempt.active) {
      reopenReturnAlbum(place.open);
      getReturnPlaceOwner()?.done();
      await returnToAlbumScroll(attempt, place.open);
    }
  } finally {
    for (const type of RETURN_INTERRUPTING_EVENTS) window.removeEventListener(type, takeOver, { capture: true });
    if (returnAttempt === attempt) {
      returnAttempt = null;
      getReturnPlaceOwner()?.done();
    }
  }
}

function initReturnPlace() {
  const place = getReturnPlaceOwner()?.returning?.();
  return place ? returnToPlace(place) : Promise.resolve();
}

// Back or Forward within the page: the gallery's place only. Albums and their editors close and open by
// their own history entries; reopening one here could reopen what was just closed.
function restoreTraversedPlace() {
  const owner = getReturnPlaceOwner();
  if (!owner) return;
  const place = owner.placeFor(owner.currentKey());
  if (place && place.top > 0) void returnToPlace({ ...place, open: null }, { afterPopState: true });
  else if (returnAttempt) returnAttempt.active = false;
}

window.addEventListener?.('pagehide', () => saveCurrentPlace());
document.addEventListener?.('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveCurrentPlace();
});
// What can push an entry starts with one of these.
document.addEventListener?.('click', notePlaceBeforeNavigation, true);
document.addEventListener?.('submit', notePlaceBeforeNavigation, true);
// Search pushes as it is typed. Any other focus can follow the render of the view being pushed.
document.addEventListener?.('focusin', (event) => {
  if (event.target?.id === 'search-input') notePlaceBeforeNavigation();
}, true);
window.navigation?.addEventListener?.('currententrychange', handleReturnEntryChange);
